import { randomUUID } from "node:crypto";
import path from "node:path";

import type { Sandbox as DesktopSandbox } from "@e2b/desktop";
import type {
  Browser,
  CDPSession,
  Locator as PlaywrightLocator,
  Page,
} from "playwright";

import { AppError } from "./errors.js";
import type { BrowserResult } from "./types.js";

const DOWNLOAD_ROOT = "/tmp/browser-api-downloads";
const SETUP_TIMEOUT_MS = 30_000;
const SAFE_GUID = /^[A-Za-z0-9_-]{8,128}$/;

interface DownloadWillBegin {
  frameId: string;
  guid: string;
  url: string;
  suggestedFilename: string;
}

interface DownloadProgress {
  guid: string;
  totalBytes: number;
  receivedBytes: number;
  state: "inProgress" | "completed" | "canceled";
  filePath?: string;
}

export type E2BDownloadFunction = (
  page: Page,
  locator: PlaywrightLocator,
  timeoutMs: number,
  maxBytes: number,
) => Promise<BrowserResult>;

export interface E2BDownloadHandler {
  download: E2BDownloadFunction;
  close(): Promise<void>;
}

function mediaTypeFor(name: string): string {
  switch (path.extname(name).toLowerCase()) {
    case ".json":
      return "application/json";
    case ".pdf":
      return "application/pdf";
    case ".csv":
      return "text/csv";
    case ".txt":
      return "text/plain";
    case ".zip":
      return "application/zip";
    default:
      return "application/octet-stream";
  }
}

function safeFilename(suggested: string, guid: string): string {
  if (
    suggested.length > 0 &&
    suggested.length <= 255 &&
    !/[\\/\u0000-\u001f\u007f]/.test(suggested) &&
    suggested !== "." &&
    suggested !== ".."
  ) {
    return suggested;
  }
  return `download-${guid}`;
}

function validateLimits(timeoutMs: number, maxBytes: number): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new AppError(
      "invalid_browser_timeout",
      "Browser download timeout must be a positive integer",
    );
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new AppError(
      "invalid_browser_size_limit",
      "Browser download size limit must be a positive integer",
    );
  }
}

function isBrowser(value: Browser | CDPSession): value is Browser {
  return "newBrowserCDPSession" in value;
}

async function consumeRemoteFile(
  sandbox: DesktopSandbox,
  remotePath: string,
  deadline: number,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const remaining = () => Math.max(1, Math.ceil(deadline - performance.now()));
  const info = await sandbox.files.getInfo(remotePath, {
    requestTimeoutMs: remaining(),
    signal,
  });
  if (info.type !== "file") {
    throw new AppError(
      "browser_download_failed",
      "The completed remote download is not a regular file",
      502,
    );
  }
  if (info.size > maxBytes) {
    throw new AppError(
      "browser_result_too_large",
      `Download exceeds the configured ${maxBytes}-byte limit`,
      413,
    );
  }

  const stream = await sandbox.files.read(remotePath, {
    format: "stream",
    requestTimeoutMs: remaining(),
    streamIdleTimeoutMs: remaining(),
    signal,
  });
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new AppError(
          "browser_result_too_large",
          `Download exceeds the configured ${maxBytes}-byte limit`,
          413,
        );
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  if (total !== info.size) {
    throw new AppError(
      "browser_download_failed",
      "The remote download changed while it was being read",
      502,
    );
  }
  return Buffer.concat(chunks, total);
}

async function withinDeadline<T>(
  operation: Promise<T>,
  deadline: number,
): Promise<T> {
  const remaining = Math.max(0, deadline - performance.now());
  if (remaining === 0) {
    throw new AppError(
      "browser_download_timeout",
      "Browser download exceeded its deadline",
      504,
    );
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new AppError(
                "browser_download_timeout",
                "Browser download exceeded its deadline",
                504,
              ),
            ),
          remaining,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Read E2B-hosted Chromium downloads without asking Playwright's local
 * artifact implementation to open a path that exists only in the sandbox.
 */
export async function createE2BDownloadHandler(
  browserOrSession: Browser | CDPSession,
  sandbox: DesktopSandbox,
): Promise<E2BDownloadHandler> {
  const ownsSession = isBrowser(browserOrSession);
  const session = ownsSession
    ? await browserOrSession.newBrowserCDPSession()
    : browserOrSession;
  const remoteDirectory = `${DOWNLOAD_ROOT}/${randomUUID()}`;
  let closed = false;
  let active: Promise<BrowserResult> | undefined;

  try {
    const setupSignal = AbortSignal.timeout(SETUP_TIMEOUT_MS);
    await sandbox.files.makeDir(remoteDirectory, {
      requestTimeoutMs: SETUP_TIMEOUT_MS,
      signal: setupSignal,
    });
    await withinDeadline(
      session.send("Browser.setDownloadBehavior", {
        behavior: "allowAndName",
        downloadPath: remoteDirectory,
        eventsEnabled: true,
      }),
      performance.now() + SETUP_TIMEOUT_MS,
    );
  } catch (error) {
    const cleanupSignal = AbortSignal.timeout(1_000);
    if (ownsSession)
      await withinDeadline(session.detach(), performance.now() + 1_000).catch(
        () => undefined,
      );
    await sandbox.files
      .remove(remoteDirectory, {
        requestTimeoutMs: 1_000,
        signal: cleanupSignal,
      })
      .catch(() => undefined);
    if (error instanceof AppError) throw error;
    throw new AppError(
      "e2b_download_setup_failed",
      "Could not configure the remote browser download directory",
      503,
    );
  }

  const runDownload: E2BDownloadFunction = async (
    page,
    locator,
    timeoutMs,
    maxBytes,
  ) => {
    validateLimits(timeoutMs, maxBytes);
    if (closed) {
      throw new AppError(
        "browser_download_unavailable",
        "The remote browser download reader is closed",
        409,
      );
    }
    if (active) {
      throw new AppError(
        "browser_download_busy",
        "Another remote browser download is already active",
        409,
      );
    }

    const execute = async (): Promise<BrowserResult> => {
      const deadline = performance.now() + timeoutMs;
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), timeoutMs);
      let started: DownloadWillBegin | undefined;
      let remotePath: string | undefined;
      let resolveBegin!: (event: DownloadWillBegin) => void;
      let rejectBegin!: (error: Error) => void;
      let resolveProgress!: (event: DownloadProgress) => void;
      let rejectProgress!: (error: Error) => void;
      const begin = new Promise<DownloadWillBegin>((resolve, reject) => {
        resolveBegin = resolve;
        rejectBegin = reject;
      });
      const progress = new Promise<DownloadProgress>((resolve, reject) => {
        resolveProgress = resolve;
        rejectProgress = reject;
      });
      // Event promises can settle while the click is still pending. Mark them
      // handled immediately while retaining the originals for awaited errors.
      void begin.catch(() => undefined);
      void progress.catch(() => undefined);

      const onBegin = (event: DownloadWillBegin) => {
        if (started) return;
        if (!SAFE_GUID.test(event.guid)) {
          rejectBegin(
            new AppError(
              "browser_download_failed",
              "Chromium returned an invalid remote download identifier",
              502,
            ),
          );
          return;
        }
        started = event;
        remotePath = `${remoteDirectory}/${event.guid}`;
        resolveBegin(event);
      };
      const onProgress = (event: DownloadProgress) => {
        if (!started || event.guid !== started.guid) return;
        if (event.receivedBytes > maxBytes || event.totalBytes > maxBytes) {
          rejectProgress(
            new AppError(
              "browser_result_too_large",
              `Download exceeds the configured ${maxBytes}-byte limit`,
              413,
            ),
          );
          return;
        }
        if (event.state === "completed") resolveProgress(event);
        if (event.state === "canceled") {
          rejectProgress(
            new AppError(
              "browser_download_failed",
              "The remote browser canceled the download",
              502,
            ),
          );
        }
      };

      session.on("Browser.downloadWillBegin", onBegin);
      session.on("Browser.downloadProgress", onProgress);
      try {
        const pageDownloadPromise = page.waitForEvent("download", {
          timeout: timeoutMs,
        });
        void pageDownloadPromise.catch(() => undefined);
        await withinDeadline(locator.click({ timeout: timeoutMs }), deadline);
        const [cdpDownload, pageDownload] = await withinDeadline(
          Promise.all([begin, pageDownloadPromise]),
          deadline,
        );
        if (
          pageDownload.url() !== cdpDownload.url ||
          pageDownload.suggestedFilename() !== cdpDownload.suggestedFilename
        ) {
          throw new AppError(
            "browser_download_mismatch",
            "The remote browser reported an unrelated concurrent download",
            409,
          );
        }
        await withinDeadline(progress, deadline);
        if (!remotePath) {
          throw new AppError(
            "browser_download_failed",
            "The remote browser did not report a download file",
            502,
          );
        }
        const data = await withinDeadline(
          consumeRemoteFile(
            sandbox,
            remotePath,
            deadline,
            maxBytes,
            abort.signal,
          ),
          deadline,
        );
        const name = safeFilename(
          cdpDownload.suggestedFilename,
          cdpDownload.guid,
        );
        return {
          download: { name, media_type: mediaTypeFor(name), data },
        };
      } catch (error) {
        if (started) {
          await withinDeadline(
            session.send("Browser.cancelDownload", { guid: started.guid }),
            Math.max(deadline, performance.now() + 1_000),
          ).catch(() => undefined);
        }
        if (error instanceof AppError) throw error;
        if (abort.signal.aborted) {
          throw new AppError(
            "browser_download_timeout",
            "Browser download exceeded its deadline",
            504,
          );
        }
        throw new AppError(
          "browser_download_failed",
          "The remote browser download could not be retrieved",
          502,
        );
      } finally {
        clearTimeout(timer);
        abort.abort();
        session.off("Browser.downloadWillBegin", onBegin);
        session.off("Browser.downloadProgress", onProgress);
        if (remotePath) {
          const cleanupTimeoutMs = Math.max(
            1,
            Math.min(1_000, Math.ceil(deadline - performance.now())),
          );
          const cleanupSignal = AbortSignal.timeout(cleanupTimeoutMs);
          await Promise.allSettled([
            sandbox.files.remove(remotePath, {
              requestTimeoutMs: cleanupTimeoutMs,
              signal: cleanupSignal,
            }),
            sandbox.files.remove(`${remotePath}.crdownload`, {
              requestTimeoutMs: cleanupTimeoutMs,
              signal: cleanupSignal,
            }),
          ]);
        }
      }
    };

    active = execute();
    try {
      return await active;
    } finally {
      active = undefined;
    }
  };

  return {
    download: runDownload,
    async close() {
      if (closed) return;
      closed = true;
      await active?.catch(() => undefined);
      await withinDeadline(
        session.send("Browser.setDownloadBehavior", {
          behavior: "deny",
          eventsEnabled: false,
        }),
        performance.now() + 1_000,
      ).catch(() => undefined);
      const cleanupSignal = AbortSignal.timeout(1_000);
      await sandbox.files
        .remove(remoteDirectory, {
          requestTimeoutMs: 1_000,
          signal: cleanupSignal,
        })
        .catch(() => undefined);
      if (ownsSession)
        await withinDeadline(session.detach(), performance.now() + 1_000).catch(
          () => undefined,
        );
    },
  };
}
