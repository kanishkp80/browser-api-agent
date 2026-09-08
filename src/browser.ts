import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";

import { Sandbox as DesktopSandbox } from "@e2b/desktop";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Locator as PlaywrightLocator,
  type Page,
} from "playwright";

import { AppError } from "./errors.js";
import type {
  AppConfig,
  BrowserAction,
  BrowserProvider,
  BrowserResult,
  BrowserSession,
  Json,
  Locator,
  Observation,
  Site,
} from "./types.js";

const OBSERVATION_LIMIT = 256 * 1024;
const E2B_CDP_PORT = 9222;

type SessionCleanup = () => Promise<void>;
type PlaywrightRole = Parameters<Page["getByRole"]>[0];

function scopedProfileKey(site: Site): string {
  return createHash("sha256")
    .update(site.site_id)
    .update("\0")
    .update(site.account_id)
    .digest("hex")
    .slice(0, 32);
}

function normalizeAllowedOrigins(site: Site): Set<string> {
  const origins = new Set<string>();
  for (const candidate of [site.base_url, ...(site.allowed_origins ?? [])]) {
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      throw new AppError(
        "invalid_site_origin",
        `Invalid site URL or allowed origin: ${candidate}`,
      );
    }
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username ||
      parsed.password
    ) {
      throw new AppError(
        "invalid_site_origin",
        `Only credential-free HTTP(S) origins are supported: ${candidate}`,
      );
    }
    origins.add(parsed.origin);
  }
  return origins;
}

function isPrivateAddress(address: string): boolean {
  if (address === "::" || address === "::1") return true;
  const normalized = address.toLowerCase();
  if (
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  ) {
    return true;
  }
  const ipv4 = normalized.startsWith("::ffff:")
    ? normalized.slice(7)
    : normalized;
  if (isIP(ipv4) !== 4) return false;
  const octets = ipv4.split(".").map(Number);
  const [a = 0, b = 0] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

async function assertPublicHost(hostname: string): Promise<void> {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    isPrivateAddress(normalized)
  ) {
    throw new AppError(
      "local_site_not_allowed",
      `Local or private browser origin is disabled: ${hostname}`,
    );
  }

  if (isIP(normalized) !== 0) return;
  const { lookup } = await import("node:dns/promises");
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(normalized, { all: true, verbatim: true });
  } catch {
    throw new AppError(
      "browser_origin_unresolved",
      `Could not resolve allowed browser origin: ${hostname}`,
      502,
    );
  }
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => isPrivateAddress(address))
  ) {
    throw new AppError(
      "local_site_not_allowed",
      `Browser origin resolves to a local or private address: ${hostname}`,
    );
  }
}

async function assertAllowedUrl(
  url: string,
  origins: Set<string>,
  allowLocalSites: boolean,
): Promise<void> {
  if (url === "about:blank") return;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AppError(
      "browser_origin_not_allowed",
      `Browser navigation has an invalid URL: ${url}`,
    );
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    !origins.has(parsed.origin)
  ) {
    throw new AppError(
      "browser_origin_not_allowed",
      `Browser navigation left the registered origins: ${parsed.origin}`,
    );
  }
  if (!allowLocalSites) await assertPublicHost(parsed.hostname);
}

function rawLocator(page: Page, target: Locator): PlaywrightLocator {
  switch (target.by) {
    case "role":
      return page.getByRole(target.value as PlaywrightRole, {
        name: target.name,
        exact: true,
      });
    case "label":
      return page.getByLabel(target.value, { exact: true });
    case "text":
      return page.getByText(target.value, { exact: true });
    case "placeholder":
      return page.getByPlaceholder(target.value, { exact: true });
    case "testid":
      return page.getByTestId(target.value);
    case "css":
      return page.locator(target.value);
  }
}

async function strictLocator(
  page: Page,
  target: Locator,
  timeout: number,
): Promise<PlaywrightLocator> {
  const locator = rawLocator(page, target);
  await locator.first().waitFor({ state: "attached", timeout });
  const count = await locator.count();
  if (count !== 1) {
    throw new AppError(
      "browser_locator_ambiguous",
      `Semantic locator must resolve to exactly one element; it resolved to ${count}`,
      409,
    );
  }
  return locator;
}

async function assertSafeLinkDestination(
  href: string,
  currentUrl: string,
  origins: Set<string>,
  allowLocalSites: boolean,
  purpose: "follow" | "download",
  allowBlob = false,
): Promise<void> {
  let targetUrl: URL;
  try {
    targetUrl = new URL(href, currentUrl);
  } catch {
    throw new AppError(
      purpose === "download"
        ? "unsafe_download_target"
        : "unsafe_follow_target",
      `The selected ${purpose} link has an invalid destination`,
      409,
    );
  }
  if (allowBlob && targetUrl.protocol === "blob:") {
    if (!origins.has(targetUrl.origin)) {
      throw new AppError(
        "browser_origin_not_allowed",
        "The selected blob download was not created by a registered origin",
        409,
      );
    }
    return;
  }
  await assertAllowedUrl(targetUrl.href, origins, allowLocalSites);
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

async function readDownload(
  page: Page,
  locator: PlaywrightLocator,
  timeout: number,
  maxBytes: number,
): Promise<BrowserResult> {
  const downloadPromise = page.waitForEvent("download", { timeout });
  await locator.click({ timeout });
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  if (!stream) {
    const failure = await download.failure();
    throw new AppError(
      "browser_download_failed",
      failure ?? "The browser download did not expose a readable stream",
      502,
    );
  }

  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const value of stream) {
      const chunk = Buffer.isBuffer(value)
        ? value
        : Buffer.from(value as Uint8Array);
      total += chunk.byteLength;
      if (total > maxBytes) {
        stream.destroy();
        throw new AppError(
          "browser_result_too_large",
          `Download exceeds the configured ${maxBytes}-byte limit`,
          413,
        );
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      "browser_download_failed",
      "The browser download stream ended with an error",
      502,
    );
  }

  const name = download.suggestedFilename();
  return {
    download: {
      name,
      media_type: mediaTypeFor(name),
      data: Buffer.concat(chunks, total),
    },
  };
}

async function verifiedUploadPath(
  dataDir: string,
  candidate: string,
  maxBytes: number,
): Promise<string> {
  if (!path.isAbsolute(candidate)) {
    throw new AppError(
      "invalid_upload_path",
      "Upload paths must be absolute service artifact paths",
    );
  }
  let root: string;
  let actual: string;
  try {
    [root, actual] = await Promise.all([
      fs.realpath(dataDir),
      fs.realpath(candidate),
    ]);
  } catch {
    throw new AppError(
      "invalid_upload_path",
      "Upload artifact path does not exist",
    );
  }
  if (actual !== root && !actual.startsWith(`${root}${path.sep}`)) {
    throw new AppError(
      "invalid_upload_path",
      "Upload artifact path is outside the configured service data directory",
    );
  }
  const stat = await fs.stat(actual);
  if (!stat.isFile())
    throw new AppError(
      "invalid_upload_path",
      "Upload artifact path is not a regular file",
    );
  if (stat.size > maxBytes) {
    throw new AppError(
      "artifact_too_large",
      `Upload exceeds the configured ${maxBytes}-byte limit`,
      413,
    );
  }
  return actual;
}

class PlaywrightBrowserSession implements BrowserSession {
  readonly id: string;
  readonly presentation: "local_window" | "streamed_browser";
  private closed = false;
  private transportClosed = false;
  private originViolation?: AppError;

  constructor(
    id: string,
    private readonly config: AppConfig,
    private readonly context: BrowserContext,
    private readonly page: Page,
    private readonly origins: Set<string>,
    presentation: "local_window" | "streamed_browser",
    private readonly access: () => Promise<{
      presentation: "local_window" | "streamed_browser";
      url?: string;
    }>,
    private readonly releaseAccess: () => Promise<void>,
    private readonly cleanup: SessionCleanup,
    private readonly probe?: () => Promise<boolean>,
  ) {
    this.id = id;
    this.presentation = presentation;
  }

  async initialize(): Promise<void> {
    const markTransportClosed = (): void => {
      this.transportClosed = true;
    };
    this.page.once("close", markTransportClosed);
    this.context.once("close", markTransportClosed);
    this.context.browser()?.once("disconnected", markTransportClosed);
    this.context.setDefaultTimeout(this.config.actionTimeoutMs);
    this.context.setDefaultNavigationTimeout(this.config.actionTimeoutMs);
    await this.context.route("**/*", async (route) => {
      const request = route.request();
      if (!request.isNavigationRequest()) {
        await route.continue();
        return;
      }
      try {
        await assertAllowedUrl(
          request.url(),
          this.origins,
          this.config.allowLocalSites,
        );
        await route.continue();
      } catch (error) {
        this.originViolation =
          error instanceof AppError
            ? error
            : new AppError(
                "browser_origin_not_allowed",
                "Browser navigation was blocked",
              );
        await route.abort("blockedbyclient");
      }
    });
  }

  private ensureOpen(): void {
    const browser = this.context.browser();
    if (this.page.isClosed() || (browser !== null && !browser.isConnected())) {
      this.transportClosed = true;
    }
    if (this.closed || this.transportClosed)
      throw new AppError(
        "browser_session_closed",
        "Browser session is closed",
        410,
      );
  }

  async isAlive(): Promise<boolean> {
    if (this.closed || this.transportClosed || this.page.isClosed())
      return false;
    const browser = this.context.browser();
    if (browser !== null && !browser.isConnected()) return false;
    if (this.probe) {
      try {
        if (!(await this.probe())) return false;
      } catch {
        return false;
      }
    }
    return (
      !this.closed &&
      !this.transportClosed &&
      !this.page.isClosed() &&
      (browser === null || browser.isConnected())
    );
  }

  private async ensureSafe(): Promise<void> {
    this.ensureOpen();
    if (this.originViolation) throw this.originViolation;
    await assertAllowedUrl(
      this.page.url(),
      this.origins,
      this.config.allowLocalSites,
    );
  }

  async observe(): Promise<Observation> {
    await this.ensureSafe();
    let content: string;
    try {
      content = await this.page
        .locator("body")
        .ariaSnapshot({ timeout: this.config.actionTimeoutMs });
    } catch {
      content = await this.page
        .locator("body")
        .innerText({ timeout: this.config.actionTimeoutMs });
    }
    const limit = Math.max(
      1,
      Math.min(OBSERVATION_LIMIT, this.config.maxArtifactBytes),
    );
    const truncated = Buffer.byteLength(content, "utf8") > limit;
    if (truncated)
      content = Buffer.from(content, "utf8")
        .subarray(0, limit)
        .toString("utf8");
    return {
      url: this.page.url(),
      title: await this.page.title(),
      content,
      truncated,
    };
  }

  async act(
    action: BrowserAction,
    uploadPath?: string,
    uploadMetadata?: { name: string; media_type: string },
  ): Promise<BrowserResult> {
    this.ensureOpen();
    if (action.kind === "navigate") {
      await assertAllowedUrl(
        action.url,
        this.origins,
        this.config.allowLocalSites,
      );
      this.originViolation = undefined;
      try {
        await this.page.goto(action.url, {
          waitUntil: "domcontentloaded",
          timeout: this.config.actionTimeoutMs,
        });
      } catch (error) {
        if (this.originViolation) throw this.originViolation;
        throw error;
      }
      await this.ensureSafe();
      return {};
    }

    await this.ensureSafe();
    try {
      if (action.kind === "wait") {
        const locator = rawLocator(this.page, action.target);
        const count = await locator.count();
        if (count > 1) {
          throw new AppError(
            "browser_locator_ambiguous",
            `Semantic locator resolved to ${count} elements`,
            409,
          );
        }
        if (action.state === "visible") {
          const strict = await strictLocator(
            this.page,
            action.target,
            this.config.actionTimeoutMs,
          );
          await strict.waitFor({
            state: "visible",
            timeout: this.config.actionTimeoutMs,
          });
        } else if (count === 1) {
          await locator.waitFor({
            state: "hidden",
            timeout: this.config.actionTimeoutMs,
          });
        }
        await this.ensureSafe();
        return {};
      }

      const locator = await strictLocator(
        this.page,
        action.target,
        this.config.actionTimeoutMs,
      );
      switch (action.kind) {
        case "follow": {
          const safeTarget = locator.and(
            this.page.locator('a[href], [role="tab"]'),
          );
          if ((await safeTarget.count()) !== 1) {
            throw new AppError(
              "unsafe_follow_target",
              "Read-only follow actions are restricted to a unique link or element with role=tab",
              409,
            );
          }
          const href = await locator.getAttribute("href");
          if (href !== null) {
            await assertSafeLinkDestination(
              href,
              this.page.url(),
              this.origins,
              this.config.allowLocalSites,
              "follow",
            );
          }
          await locator.click({ timeout: this.config.actionTimeoutMs });
          break;
        }
        case "click":
          await locator.click({ timeout: this.config.actionTimeoutMs });
          break;
        case "fill":
          await locator.fill(action.value, {
            timeout: this.config.actionTimeoutMs,
          });
          break;
        case "select":
          await locator.selectOption(action.value, {
            timeout: this.config.actionTimeoutMs,
          });
          break;
        case "check":
          if (action.checked)
            await locator.check({ timeout: this.config.actionTimeoutMs });
          else await locator.uncheck({ timeout: this.config.actionTimeoutMs });
          break;
        case "upload": {
          if (!uploadPath)
            throw new AppError(
              "upload_path_required",
              "The service must provide a verified upload artifact path",
            );
          if (!uploadMetadata)
            throw new AppError(
              "upload_metadata_required",
              "The service must provide the original upload filename and media type",
            );
          if (
            !uploadMetadata.name ||
            path.basename(uploadMetadata.name) !== uploadMetadata.name
          ) {
            throw new AppError(
              "invalid_upload_metadata",
              "Upload filename must be a non-empty basename",
            );
          }
          if (
            !/^[\w!#$&^_.+\-]+\/[\w!#$&^_.+\-]+$/i.test(
              uploadMetadata.media_type,
            )
          ) {
            throw new AppError(
              "invalid_upload_metadata",
              "Upload media type is invalid",
            );
          }
          const actual = await verifiedUploadPath(
            this.config.dataDir,
            uploadPath,
            this.config.maxArtifactBytes,
          );
          const buffer = await fs.readFile(actual);
          await locator.setInputFiles(
            {
              name: uploadMetadata.name,
              mimeType: uploadMetadata.media_type,
              buffer,
            },
            { timeout: this.config.actionTimeoutMs },
          );
          break;
        }
        case "read": {
          const text = await locator.innerText({
            timeout: this.config.actionTimeoutMs,
          });
          if (Buffer.byteLength(text, "utf8") > this.config.maxArtifactBytes) {
            throw new AppError(
              "browser_result_too_large",
              `Extracted text exceeds the configured ${this.config.maxArtifactBytes}-byte limit`,
              413,
            );
          }
          let value: Json = text;
          if (action.format === "json") {
            try {
              value = JSON.parse(text) as Json;
            } catch {
              throw new AppError(
                "invalid_browser_json",
                "The selected UI content is not valid JSON",
                422,
              );
            }
          }
          await this.ensureSafe();
          return { value };
        }
        case "download": {
          const safeTarget = locator.and(this.page.locator("a[href]"));
          if ((await safeTarget.count()) !== 1) {
            throw new AppError(
              "unsafe_download_target",
              "Download actions are restricted to a unique pre-existing link with an href",
              409,
            );
          }
          const href = await locator.getAttribute("href");
          if (href === null) {
            throw new AppError(
              "unsafe_download_target",
              "The selected download link does not expose a destination",
              409,
            );
          }
          await assertSafeLinkDestination(
            href,
            this.page.url(),
            this.origins,
            this.config.allowLocalSites,
            "download",
            true,
          );
          const result = await readDownload(
            this.page,
            locator,
            this.config.actionTimeoutMs,
            this.config.maxArtifactBytes,
          );
          await this.ensureSafe();
          return result;
        }
      }
      await this.ensureSafe();
      return {};
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (this.originViolation) throw this.originViolation;
      throw new AppError(
        "browser_action_failed",
        error instanceof Error ? error.message : "Browser action failed",
        502,
      );
    }
  }

  async humanAccess(): Promise<{
    presentation: "local_window" | "streamed_browser";
    url?: string;
  }> {
    this.ensureOpen();
    return this.access();
  }

  async releaseHumanControl(): Promise<void> {
    this.ensureOpen();
    await this.releaseAccess();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.cleanup();
  }
}

abstract class ManagedProvider implements BrowserProvider {
  protected readonly sessions = new Set<BrowserSession>();

  abstract connect(site: Site): Promise<BrowserSession>;

  protected track(session: BrowserSession): BrowserSession {
    this.sessions.add(session);
    return session;
  }

  protected async pruneDeadSessions(): Promise<void> {
    const sessions = [...this.sessions];
    const health = await Promise.allSettled(
      sessions.map((session) => session.isAlive?.() ?? Promise.resolve(true)),
    );
    const dead = sessions.filter(
      (_session, index) =>
        health[index]?.status === "rejected" ||
        (health[index]?.status === "fulfilled" && !health[index].value),
    );
    await Promise.allSettled(dead.map((session) => session.close()));
    for (const session of dead) this.sessions.delete(session);
  }

  async close(): Promise<void> {
    const sessions = [...this.sessions];
    this.sessions.clear();
    await Promise.allSettled(sessions.map((session) => session.close()));
  }
}

class LocalBrowserProvider extends ManagedProvider {
  constructor(private readonly config: AppConfig) {
    super();
  }

  async connect(site: Site): Promise<BrowserSession> {
    await this.pruneDeadSessions();
    const origins = normalizeAllowedOrigins(site);
    await assertAllowedUrl(site.base_url, origins, this.config.allowLocalSites);
    const profileDir = path.join(
      this.config.dataDir,
      "browser-profiles",
      scopedProfileKey(site),
    );
    await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
    await fs.chmod(profileDir, 0o700);

    let context: BrowserContext;
    try {
      context = await chromium.launchPersistentContext(profileDir, {
        headless: this.config.headless,
        executablePath: this.config.executablePath,
        acceptDownloads: true,
      });
    } catch (error) {
      throw new AppError(
        "browser_launch_failed",
        error instanceof Error
          ? error.message
          : "Could not launch the local browser",
        502,
      );
    }

    const page = context.pages().at(-1) ?? (await context.newPage());
    let session!: PlaywrightBrowserSession;
    session = new PlaywrightBrowserSession(
      `local-${scopedProfileKey(site)}-${randomUUID()}`,
      this.config,
      context,
      page,
      origins,
      "local_window",
      async () => {
        if (this.config.headless) {
          throw new AppError(
            "human_handoff_unavailable",
            "A headless local browser cannot be handed to a human; restart this host with a visible browser",
            409,
          );
        }
        await page.bringToFront();
        return { presentation: "local_window" };
      },
      async () => undefined,
      async () => {
        this.sessions.delete(session);
        await context.close();
      },
    );
    await session.initialize();
    try {
      await session.act({ kind: "navigate", url: site.base_url });
    } catch (error) {
      await session.close();
      throw error;
    }
    return this.track(session);
  }
}

class E2BBrowserProvider extends ManagedProvider {
  constructor(private readonly config: AppConfig) {
    super();
  }

  async connect(site: Site): Promise<BrowserSession> {
    await this.pruneDeadSessions();
    if (!this.config.e2bApiKey) {
      throw new AppError(
        "e2b_credentials_missing",
        "E2B mode requires a server-side E2B_API_KEY",
        503,
      );
    }
    if (!this.config.e2bTemplate) {
      throw new AppError(
        "e2b_template_missing",
        "E2B mode requires a pinned Desktop template",
        503,
      );
    }
    const origins = normalizeAllowedOrigins(site);
    await assertAllowedUrl(site.base_url, origins, this.config.allowLocalSites);

    let sandbox: DesktopSandbox | undefined;
    let browser: Browser | undefined;
    let keepalive: NodeJS.Timeout | undefined;
    try {
      sandbox = await DesktopSandbox.create(this.config.e2bTemplate, {
        apiKey: this.config.e2bApiKey,
        secure: true,
        timeoutMs: 3_600_000,
      });
      const keepaliveMs = Math.max(
        30_000,
        Math.min(this.config.heartbeatMs, 300_000),
      );
      const keptAliveSandbox = sandbox;
      keepalive = setInterval(() => {
        void keptAliveSandbox.setTimeout(3_600_000).catch(() => undefined);
      }, keepaliveMs);
      keepalive.unref();

      const profile = `/home/user/.browser-api/profiles/${scopedProfileKey(site)}`;
      await sandbox.commands.run(`mkdir -p ${profile}`);
      await sandbox.commands.run(
        `google-chrome --no-first-run --no-default-browser-check --disable-dev-shm-usage --remote-debugging-address=0.0.0.0 --remote-debugging-port=${E2B_CDP_PORT} --user-data-dir=${profile} about:blank`,
        { background: true, envs: { DISPLAY: sandbox.display } },
      );
      const ready = await sandbox.waitAndVerify(
        `curl --fail --silent http://127.0.0.1:${E2B_CDP_PORT}/json/version`,
        (result) => result.exitCode === 0,
        this.config.actionTimeoutMs,
        250,
      );
      if (!ready) {
        throw new AppError(
          "e2b_browser_capability_unavailable",
          "The configured E2B template did not expose the required Chromium CDP endpoint",
          503,
        );
      }

      const headers = sandbox.trafficAccessToken
        ? { "X-Access-Token": sandbox.trafficAccessToken }
        : undefined;
      browser = await chromium.connectOverCDP(
        `https://${sandbox.getHost(E2B_CDP_PORT)}`,
        {
          headers,
          timeout: this.config.actionTimeoutMs,
        },
      );
      const context = browser.contexts()[0];
      if (!context) {
        throw new AppError(
          "e2b_browser_capability_unavailable",
          "The configured E2B CDP browser did not expose its live desktop context",
          503,
        );
      }
      const page = context.pages().at(-1) ?? (await context.newPage());
      let streamStarted = false;
      let session!: PlaywrightBrowserSession;
      const ownedSandbox = sandbox;
      const ownedBrowser = browser;
      session = new PlaywrightBrowserSession(
        `e2b-${sandbox.sandboxId}`,
        this.config,
        context,
        page,
        origins,
        "streamed_browser",
        async () => {
          await page.bringToFront();
          if (!streamStarted) {
            await ownedSandbox.stream.start({ requireAuth: true });
            streamStarted = true;
          }
          const authKey = ownedSandbox.stream.getAuthKey();
          return {
            presentation: "streamed_browser",
            url: ownedSandbox.stream.getUrl({
              authKey,
              autoConnect: true,
              viewOnly: false,
              resize: "scale",
            }),
          };
        },
        async () => {
          if (!streamStarted) return;
          await ownedSandbox.stream.stop();
          streamStarted = false;
        },
        async () => {
          this.sessions.delete(session);
          if (keepalive) clearInterval(keepalive);
          if (streamStarted)
            await ownedSandbox.stream.stop().catch(() => undefined);
          await ownedBrowser.close().catch(() => undefined);
          await ownedSandbox.kill().catch(() => undefined);
        },
        async () => {
          if (!ownedBrowser.isConnected()) return false;
          return ownedSandbox.isRunning({
            requestTimeoutMs: Math.max(
              1_000,
              Math.min(this.config.actionTimeoutMs, 5_000),
            ),
          });
        },
      );
      await session.initialize();
      await session.act({ kind: "navigate", url: site.base_url });
      return this.track(session);
    } catch (error) {
      if (keepalive) clearInterval(keepalive);
      await browser?.close().catch(() => undefined);
      await sandbox?.kill().catch(() => undefined);
      if (error instanceof AppError) throw error;
      throw new AppError(
        "e2b_browser_capability_unavailable",
        "The configured E2B template could not provide one browser shared by Playwright and the interactive desktop stream",
        503,
      );
    }
  }
}

export function createBrowserProvider(config: AppConfig): BrowserProvider {
  return config.browserHost === "e2b"
    ? new E2BBrowserProvider(config)
    : new LocalBrowserProvider(config);
}
