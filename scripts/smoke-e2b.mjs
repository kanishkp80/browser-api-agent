import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { parseEnv } from "node:util";
import { resolve } from "node:path";
import process from "node:process";
import { setTimeout as pause } from "node:timers/promises";

import { Sandbox } from "@e2b/desktop";
import { chromium } from "playwright";

import { createBrowserProvider } from "../src/browser.ts";

import { loadConfig } from "../src/config.ts";

const started = performance.now();
const runId = `browser-api-smoke-${Date.now()}-${process.pid}`;
const fixtureDirectory = resolve(".tmp", runId);
const outputDirectory = resolve(
  process.env.BROWSER_API_SMOKE_OUTPUT || "test-results/e2b-smoke",
);
const metadata = { browser_api_smoke: runId };
const secrets = new Set();
const cleanupFailures = [];

let apiKey;
let provider;
let session;
let viewer;
let ownedSandbox;
let originalSandboxCreate;
let humanControlActive = false;

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function optionalFileEnvironment() {
  const requestedPath = process.env.BROWSER_API_ENV_FILE;
  const path = resolve(requestedPath || ".env");
  if (!existsSync(path)) {
    if (requestedPath) {
      throw codedError(
        "environment_file_missing",
        `Configured environment file does not exist: ${path}`,
      );
    }
    return {};
  }
  return parseEnv(readFileSync(path, "utf8"));
}

function durationFromEnvironment(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw codedError(
      "invalid_environment",
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function addSecret(value) {
  if (typeof value === "string" && value.length > 0) secrets.add(value);
}

function redactText(value) {
  let result = String(value);
  const orderedSecrets = [...secrets].sort((a, b) => b.length - a.length);
  for (const secret of orderedSecrets) {
    result = result.split(secret).join("[redacted]");
  }
  result = result.replace(/(?:https?|wss):\/\/[^\s"'<>]+/giu, "[url]");
  return result.length > 1_200 ? `${result.slice(0, 1_200)}…` : result;
}

function sanitize(value) {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, sanitize(entry)]),
    );
  }
  return value;
}

function describeError(error) {
  if (error instanceof Error) {
    return {
      code: typeof error.code === "string" ? error.code : error.name,
      message: error.message,
    };
  }
  return { code: "unknown_error", message: String(error) };
}

function record(event, fields = {}) {
  process.stdout.write(
    `${JSON.stringify(sanitize({ event, elapsed_ms: Math.round(performance.now() - started), ...fields }))}\n`,
  );
}

function abortGate(signal) {
  let listener;
  const promise = new Promise((_, reject) => {
    listener = () => {
      reject(
        signal.reason ||
          codedError("smoke_aborted", "The smoke run was aborted"),
      );
    };
    if (signal.aborted) listener();
    else signal.addEventListener("abort", listener, { once: true });
  });
  return {
    promise,
    dispose() {
      if (listener) signal.removeEventListener("abort", listener);
    },
  };
}

function throwIfAborted(signal) {
  if (signal.aborted) {
    throw (
      signal.reason || codedError("smoke_aborted", "The smoke run was aborted")
    );
  }
}

async function waitForObservedUrl(browserSession, expectedUrl, signal) {
  let observedUrl;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    throwIfAborted(signal);
    observedUrl = (await browserSession.observe()).url;
    if (observedUrl === expectedUrl) return observedUrl;
    await pause(100, undefined, { signal });
  }
  assert.equal(
    observedUrl,
    expectedUrl,
    "noVNC keyboard navigation did not reach the shared browser session",
  );
}

async function bounded(operation, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              codedError(
                "cleanup_timeout",
                "Resource cleanup exceeded its deadline",
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function cleanupStep(step, action, { allowAbsent = false } = {}) {
  try {
    await bounded(action(), 20_000);
  } catch (error) {
    if (allowAbsent && isAlreadyAbsent(error)) return;
    const failure = { step, ...describeError(error) };
    cleanupFailures.push(failure);
    record("cleanup_failed", failure);
  }
}

function isAlreadyAbsent(error) {
  const description = `${error?.status ?? ""} ${error?.message ?? error}`;
  return /\b404\b|not[ -]?found|does not exist/iu.test(description);
}

async function taggedSandboxes() {
  const paginator = Sandbox.list({
    apiKey,
    query: { metadata },
    limit: 100,
    requestTimeoutMs: 15_000,
  });
  return paginator.nextItems();
}

async function cleanup() {
  if (humanControlActive && session) {
    await cleanupStep("release_human_control", async () => {
      await session.releaseHumanControl();
      humanControlActive = false;
    });
  }
  if (viewer) {
    await cleanupStep("close_stream_viewer", async () => {
      await viewer.close();
      viewer = undefined;
    });
  }
  if (provider) {
    await cleanupStep("close_browser_provider", async () => {
      await provider.close();
      provider = undefined;
    });
  }

  if (apiKey) {
    if (ownedSandbox?.sandboxId) {
      await cleanupStep(
        "kill_owned_sandbox",
        () =>
          Sandbox.kill(ownedSandbox.sandboxId, {
            apiKey,
            requestTimeoutMs: 15_000,
          }),
        { allowAbsent: true },
      );
    }

    let remaining = [];
    await cleanupStep("list_tagged_sandboxes", async () => {
      remaining = await taggedSandboxes();
    });
    for (const sandbox of remaining) {
      await cleanupStep(
        `kill_tagged_sandbox:${sandbox.sandboxId}`,
        () =>
          Sandbox.kill(sandbox.sandboxId, {
            apiKey,
            requestTimeoutMs: 15_000,
          }),
        { allowAbsent: true },
      );
    }
    await cleanupStep("verify_tagged_sandboxes_removed", async () => {
      const survivors = await taggedSandboxes();
      record("cleanup_complete", { remaining_sandboxes: survivors.length });
      assert.equal(
        survivors.length,
        0,
        `${survivors.length} tagged sandbox(es) survived cleanup`,
      );
    });
  }

  await cleanupStep("remove_local_fixture", () =>
    rm(fixtureDirectory, { recursive: true, force: true }),
  );
}

const fixtureHtml = `<!doctype html>
<html>
  <head><title>Browser API smoke</title></head>
  <body>
    <main>
      <label>Message <input id="message" aria-label="Message" /></label>
      <label>Document <input id="document" aria-label="Document" type="file" /></label>
      <button id="process">Process fixture</button>
      <pre id="result"></pre>
      <a id="download" download="result.json" hidden>Download result</a>
    </main>
    <script>
      document.querySelector('#process').addEventListener('click', async () => {
        const message = document.querySelector('#message').value;
        const file = document.querySelector('#document').files[0];
        const body = JSON.stringify({ message, file: file.name, content: await file.text() });
        document.querySelector('#result').textContent = body;
        const download = document.querySelector('#download');
        download.href = URL.createObjectURL(
          new Blob([body], { type: 'application/json' }),
        );
        download.hidden = false;
      });
    </script>
  </body>
</html>`;

async function runSmoke(signal, watchdogMs) {
  throwIfAborted(signal);
  const fileEnvironment = optionalFileEnvironment();
  apiKey = process.env.E2B_API_KEY || fileEnvironment.E2B_API_KEY;
  addSecret(apiKey);
  assert(
    apiKey,
    "E2B_API_KEY must be set in the environment or optional env file",
  );

  const template =
    process.env.BROWSER_API_E2B_TEMPLATE ||
    fileEnvironment.BROWSER_API_E2B_TEMPLATE ||
    "desktop";
  const actionTimeoutMs = durationFromEnvironment(
    "BROWSER_API_SMOKE_ACTION_TIMEOUT_MS",
    30_000,
    1_000,
    60_000,
  );

  await mkdir(fixtureDirectory, { recursive: true, mode: 0o700 });
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });

  originalSandboxCreate = Sandbox.create;
  Sandbox.create = async function taggedCreate(selectedTemplate, options = {}) {
    const sandbox = await originalSandboxCreate.call(this, selectedTemplate, {
      ...options,
      timeoutMs: 180_000,
      requestTimeoutMs: 30_000,
      metadata: { ...(options.metadata || {}), ...metadata },
    });
    ownedSandbox = sandbox;
    record("sandbox_created", { sandbox_id: sandbox.sandboxId });
    addSecret(sandbox.trafficAccessToken);
    if (signal.aborted) {
      await Sandbox.kill(sandbox.sandboxId, {
        apiKey,
        requestTimeoutMs: 15_000,
      }).catch(() => {});
      throwIfAborted(signal);
    }

    await sandbox.files.makeDir("/tmp/browser-api-smoke");
    await sandbox.files.write("/tmp/browser-api-smoke/index.html", fixtureHtml);
    const server = await sandbox.commands.run(
      "python3 -m http.server 8787 --bind 127.0.0.1",
      {
        cwd: "/tmp/browser-api-smoke",
        background: true,
        timeoutMs: 0,
      },
    );
    await server.disconnect();
    throwIfAborted(signal);
    return sandbox;
  };

  record("smoke_started", { run_id: runId, watchdog_ms: watchdogMs });
  provider = createBrowserProvider(
    loadConfig({
      E2B_API_KEY: apiKey,
      BROWSER_API_BROWSER_HOST: "e2b",
      BROWSER_API_E2B_TEMPLATE: template,
      BROWSER_API_DATA_DIR: fixtureDirectory,
      BROWSER_API_ALLOW_LOCAL_SITES: "true",
      BROWSER_API_ACTION_TIMEOUT_MS: String(actionTimeoutMs),
      BROWSER_API_SERVICE_TOKEN: randomUUID() + randomUUID(),
    }),
  );
  session = await provider.connect({
    site_id: "smoke",
    account_id: runId,
    base_url: "http://127.0.0.1:8787/",
    allowed_origins: ["http://127.0.0.1:8787"],
    spec: {},
    contract_hash: "smoke",
    created_at: new Date().toISOString(),
  });
  throwIfAborted(signal);
  assert(await session.isAlive());
  assert.equal((await session.observe()).title, "Browser API smoke");
  record("browser_connected", { observation_verified: true });
  const input = resolve(fixtureDirectory, "fixture.txt");
  await writeFile(input, "Synthetic document for E2B upload validation.");
  await session.act({
    kind: "fill",
    target: { by: "label", value: "Message" },
    value: "e2b-live-smoke",
  });
  await session.act(
    {
      kind: "upload",
      target: { by: "label", value: "Document" },
      artifact_id: "smoke",
    },
    input,
    { name: "fixture.txt", media_type: "text/plain" },
  );
  await session.act({
    kind: "click",
    target: { by: "role", value: "button", name: "Process fixture" },
  });
  await session.act({
    kind: "wait",
    target: { by: "role", value: "link", name: "Download result" },
    state: "visible",
  });
  const extracted = await session.act({
    kind: "read",
    target: { by: "css", value: "#result" },
    format: "json",
  });
  const expected = {
    message: "e2b-live-smoke",
    file: "fixture.txt",
    content: "Synthetic document for E2B upload validation.",
  };
  assert.deepEqual(extracted.value, expected);
  record("ui_workflow_passed", {
    fill: true,
    upload: true,
    submit: true,
    json_result: true,
  });
  const downloaded = await session.act({
    kind: "download",
    target: { by: "role", value: "link", name: "Download result" },
  });
  assert(downloaded.download);
  assert.deepEqual(
    JSON.parse(Buffer.from(downloaded.download.data).toString()),
    expected,
  );
  record("download_passed", {
    filename: downloaded.download.name,
    bytes: downloaded.download.data.length,
  });
  throwIfAborted(signal);

  const access = await session.humanAccess();
  humanControlActive = true;
  addSecret(access.url);
  const streamUrl = new URL(access.url);
  addSecret(streamUrl.searchParams.get("password"));
  assert.equal(access.presentation, "streamed_browser");
  assert(streamUrl.searchParams.get("password"), "stream URL has no password");

  const streamResponse = await fetch(streamUrl, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(actionTimeoutMs)]),
  });
  assert.equal(streamResponse.status, 200);
  const streamHtml = await streamResponse.text();
  assert.match(streamHtml, /noVNC|vnc_lite/iu);

  throwIfAborted(signal);
  viewer = await chromium.launch({ headless: true });
  const viewerPage = await viewer.newPage({
    viewport: { width: 1280, height: 900 },
  });
  await viewerPage.goto(access.url, {
    waitUntil: "domcontentloaded",
    timeout: actionTimeoutMs,
  });
  await viewerPage.waitForSelector("html.noVNC_connected", {
    timeout: actionTimeoutMs,
  });
  const canvas = viewerPage.locator("canvas").first();
  await canvas.waitFor({ state: "visible", timeout: actionTimeoutMs });
  const bounds = await canvas.boundingBox();
  assert(
    bounds && bounds.width > 0 && bounds.height > 0,
    "noVNC canvas is empty",
  );

  // A connected noVNC canvas can precede the first video frame. The fixture
  // has a white page body; wait until those pixels actually arrive.
  await viewerPage.waitForFunction(
    () => {
      const surface = document.querySelector("canvas");
      const context = surface?.getContext("2d");
      if (!surface || !context || !surface.width || !surface.height)
        return false;
      const pixel = context.getImageData(
        Math.floor(surface.width / 2),
        Math.floor(surface.height / 2),
        1,
        1,
      ).data;
      return pixel[0] > 200 && pixel[1] > 200 && pixel[2] > 200;
    },
    undefined,
    { timeout: actionTimeoutMs },
  );
  const screenshotPath = resolve(outputDirectory, `${runId}-stream.png`);
  await viewerPage.screenshot({ path: screenshotPath });
  record("stream_view_passed", { screenshot: screenshotPath });

  const rawCdp = await fetch(
    `https://${ownedSandbox.getHost(9222)}/json/version`,
    { redirect: "manual", signal },
  );
  assert.equal(
    rawCdp.ok,
    false,
    "raw CDP port unexpectedly accepted public ingress",
  );
  const unauthenticatedRelay = await fetch(
    `https://${ownedSandbox.getHost(9223)}/json/version`,
    { redirect: "manual", signal },
  );
  assert.equal(
    unauthenticatedRelay.status,
    401,
    "CDP relay accepted an unauthenticated request",
  );
  await rawCdp.body?.cancel();
  await unauthenticatedRelay.body?.cancel();
  record("cdp_ingress_protection_passed");

  // The address-bar shortcut is independent of the remote desktop layout. Focusing
  // the canvas ensures the keyboard events go through noVNC to the owned browser.
  const expectedUrl = "http://127.0.0.1:8787/#typed-through-human-stream";
  await canvas.click({
    position: {
      x: Math.min(500, bounds.width - 20),
      y: Math.min(500, bounds.height - 20),
    },
  });
  await canvas.focus();
  await viewerPage.keyboard.press("Escape");
  await viewerPage.keyboard.press("Control+KeyL");
  // The remote window manager must finish moving focus before the first key.
  await pause(500, undefined, { signal });
  await viewerPage.keyboard.type(expectedUrl, { delay: 40 });
  await pause(250, undefined, { signal });
  await viewerPage.keyboard.press("Enter");

  await waitForObservedUrl(session, expectedUrl, signal);
  await session.releaseHumanControl();
  humanControlActive = false;
  const returnedState = await session.observe();
  assert.equal(returnedState.url, expectedUrl);
  assert.equal(returnedState.title, "Browser API smoke");
  assert.equal(
    await session.isAlive(),
    true,
    "browser session died during human handoff",
  );
  record("stream_keyboard_round_trip_passed", {
    same_session: true,
    hash_verified: true,
  });

  throwIfAborted(signal);
}

async function main() {
  const lifecycle = new AbortController();
  const gate = abortGate(lifecycle.signal);
  const signalHandlers = new Map();
  let failure;
  let watchdog;
  let smoke;

  try {
    const watchdogMs = durationFromEnvironment(
      "BROWSER_API_SMOKE_TIMEOUT_MS",
      180_000,
      30_000,
      600_000,
    );
    watchdog = setTimeout(() => {
      lifecycle.abort(
        codedError(
          "smoke_deadline_exceeded",
          `Smoke run exceeded its ${watchdogMs}ms overall deadline`,
        ),
      );
    }, watchdogMs);

    for (const signalName of ["SIGINT", "SIGTERM"]) {
      const handler = () => {
        lifecycle.abort(
          codedError(
            "smoke_interrupted",
            `Smoke run received ${signalName}; cleaning up owned resources`,
          ),
        );
      };
      signalHandlers.set(signalName, handler);
      process.once(signalName, handler);
    }

    smoke = runSmoke(lifecycle.signal, watchdogMs);
    await Promise.race([smoke, gate.promise]);
  } catch (error) {
    failure = error;
    record("smoke_execution_failed", describeError(error));
    const page = viewer?.contexts()[0]?.pages()[0];
    if (page) {
      await page
        .screenshot({
          path: resolve(outputDirectory, `${runId}-failure.png`),
          timeout: 5_000,
        })
        .catch(() => undefined);
    }
  } finally {
    if (lifecycle.signal.aborted && apiKey) {
      // Kill remote work before waiting for UI teardown or a stuck CDP call.
      await cleanupStep("abort_owned_sandboxes", async () => {
        for (const sandbox of await taggedSandboxes()) {
          await Sandbox.kill(sandbox.sandboxId, {
            apiKey,
            requestTimeoutMs: 15_000,
          });
        }
      });
      await bounded(
        smoke?.catch(() => undefined) ?? Promise.resolve(),
        10_000,
      ).catch(() => undefined);
    }
    await cleanup();
    if (originalSandboxCreate) Sandbox.create = originalSandboxCreate;
    if (watchdog) clearTimeout(watchdog);
    gate.dispose();
    for (const [signalName, handler] of signalHandlers) {
      process.removeListener(signalName, handler);
    }
  }

  if (!failure && lifecycle.signal.aborted) {
    failure =
      lifecycle.signal.reason ||
      codedError("smoke_aborted", "The smoke run was aborted");
    record("smoke_execution_failed", describeError(failure));
  }

  const failed = Boolean(failure) || cleanupFailures.length > 0;
  record(failed ? "smoke_failed" : "smoke_passed", {
    cleanup_failures: cleanupFailures.length,
  });
  process.exitCode = failed ? 1 : 0;
}

await main();
