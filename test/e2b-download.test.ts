import { EventEmitter } from "node:events";

import type { Sandbox as DesktopSandbox } from "@e2b/desktop";
import type { Browser, CDPSession, Download, Locator, Page } from "playwright";
import { describe, expect, it, vi } from "vitest";

import { createE2BDownloadHandler } from "../src/e2b-download.js";

class FakeCdpSession extends EventEmitter {
  readonly commands: Array<{ method: string; params?: unknown }> = [];
  detached = false;

  async send(method: string, params?: unknown): Promise<Record<string, never>> {
    this.commands.push({ method, params });
    return {};
  }

  async detach(): Promise<void> {
    this.detached = true;
  }
}

function remoteStream(...chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(Buffer.from(chunk));
      controller.close();
    },
  });
}

function fakeSandbox(fileBytes: number, ...chunks: string[]) {
  const files = {
    makeDir: vi.fn(async () => true),
    getInfo: vi.fn(async (remotePath: string) => ({
      name: remotePath.split("/").at(-1) ?? "download",
      path: remotePath,
      type: "file",
      size: fileBytes,
      mode: 0o600,
      permissions: "rw-------",
      owner: "user",
      group: "user",
    })),
    read: vi.fn(async () => remoteStream(...chunks)),
    remove: vi.fn(async () => undefined),
  };
  return { sandbox: { files } as unknown as DesktopSandbox, files };
}

function downloadAction(
  session: FakeCdpSession,
  options: {
    guid?: string;
    url?: string;
    suggestedFilename?: string;
    progress?: {
      totalBytes: number;
      receivedBytes: number;
      state: "inProgress" | "completed" | "canceled";
    };
  } = {},
): { page: Page; locator: Locator } {
  const guid = options.guid ?? "01234567-89ab-cdef-0123-456789abcdef";
  const url = options.url ?? "https://example.test/result";
  const suggestedFilename = options.suggestedFilename ?? "result.pdf";
  let resolvePageDownload!: (download: Download) => void;
  const pageDownload = new Promise<Download>((resolve) => {
    resolvePageDownload = resolve;
  });
  const download = {
    url: () => url,
    suggestedFilename: () => suggestedFilename,
  } as Download;
  const page = {
    waitForEvent: vi.fn(() => pageDownload),
  } as unknown as Page;
  const locator = {
    click: vi.fn(async () => {
      session.emit("Browser.downloadWillBegin", {
        frameId: "frame-1",
        guid,
        url,
        suggestedFilename,
      });
      resolvePageDownload(download);
      session.emit("Browser.downloadProgress", {
        guid,
        totalBytes: options.progress?.totalBytes ?? 7,
        receivedBytes: options.progress?.receivedBytes ?? 7,
        state: options.progress?.state ?? "completed",
      });
    }),
  } as unknown as Locator;
  return { page, locator };
}

describe("E2B remote download handler", () => {
  it("configures a remote GUID directory and retrieves the completed bytes", async () => {
    const session = new FakeCdpSession();
    const { sandbox, files } = fakeSandbox(7, "pay", "load");
    const handler = await createE2BDownloadHandler(
      session as unknown as CDPSession,
      sandbox,
    );
    const setup = session.commands.at(0);
    expect(setup?.method).toBe("Browser.setDownloadBehavior");
    expect(setup?.params).toMatchObject({
      behavior: "allowAndName",
      eventsEnabled: true,
    });
    const remoteDirectory = (setup?.params as { downloadPath: string })
      .downloadPath;
    expect(remoteDirectory).toMatch(
      /^\/tmp\/browser-api-downloads\/[0-9a-f-]{36}$/,
    );

    const { page, locator } = downloadAction(session);
    const result = await handler.download(page, locator, 2_000, 1_024);
    expect(result.download).toEqual({
      name: "result.pdf",
      media_type: "application/pdf",
      data: Buffer.from("payload"),
    });
    expect(files.getInfo).toHaveBeenCalledWith(
      `${remoteDirectory}/01234567-89ab-cdef-0123-456789abcdef`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(files.read).toHaveBeenCalledWith(
      `${remoteDirectory}/01234567-89ab-cdef-0123-456789abcdef`,
      expect.objectContaining({ format: "stream" }),
    );

    await handler.close();
    expect(session.commands.at(-1)).toMatchObject({
      method: "Browser.setDownloadBehavior",
      params: { behavior: "deny", eventsEnabled: false },
    });
    expect(session.detached).toBe(false);
    expect(files.remove).toHaveBeenCalledWith(
      remoteDirectory,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("cancels a download as soon as CDP reports it over the byte limit", async () => {
    const session = new FakeCdpSession();
    const { sandbox, files } = fakeSandbox(0);
    const handler = await createE2BDownloadHandler(
      session as unknown as CDPSession,
      sandbox,
    );
    const { page, locator } = downloadAction(session, {
      progress: {
        totalBytes: 2_048,
        receivedBytes: 1_500,
        state: "inProgress",
      },
    });

    await expect(
      handler.download(page, locator, 2_000, 1_024),
    ).rejects.toMatchObject({ code: "browser_result_too_large", status: 413 });
    expect(session.commands).toContainEqual({
      method: "Browser.cancelDownload",
      params: { guid: "01234567-89ab-cdef-0123-456789abcdef" },
    });
    expect(files.read).not.toHaveBeenCalled();
    await handler.close();
  });

  it("detaches a CDP session created from a Browser when closed", async () => {
    const session = new FakeCdpSession();
    const browser = {
      newBrowserCDPSession: vi.fn(async () => session as unknown as CDPSession),
    } as unknown as Browser;
    const { sandbox } = fakeSandbox(0);
    const handler = await createE2BDownloadHandler(browser, sandbox);

    await handler.close();
    expect(browser.newBrowserCDPSession).toHaveBeenCalledOnce();
    expect(session.detached).toBe(true);
  });
});
