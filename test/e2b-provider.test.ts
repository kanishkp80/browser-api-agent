import { performance } from "node:perf_hooks";

import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createSandbox: vi.fn(),
  connectOverCDP: vi.fn(),
  launchPersistentContext: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("@e2b/desktop", () => ({
  Sandbox: { create: mocks.createSandbox },
}));

vi.mock("playwright", () => ({
  chromium: {
    connectOverCDP: mocks.connectOverCDP,
    launchPersistentContext: mocks.launchPersistentContext,
    executablePath: () => "/mock/chromium",
  },
}));

import { createBrowserProvider } from "../src/browser.js";
import type { AppConfig, Site } from "../src/types.js";

interface FakeCommandResult {
  exitCode?: number;
  disconnect?: ReturnType<typeof vi.fn>;
}

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    dataDir: "/tmp/browser-api-e2b-provider-test",
    host: "127.0.0.1",
    port: 0,
    controlBaseUrl: "http://127.0.0.1",
    serviceToken: "test-service-token",
    browserHost: "e2b",
    headless: true,
    e2bApiKey: "e2b_test_key",
    e2bTemplate: "desktop-test-template",
    discoveryBudgetMs: 10_000,
    actionTimeoutMs: 1_000,
    heartbeatMs: 60_000,
    maxArtifactBytes: 1024 * 1024,
    allowLocalSites: true,
    ...overrides,
  };
}

const site: Site = {
  site_id: "e2b-fixture",
  account_id: "test-account",
  base_url: "https://target.example/",
  allowed_origins: ["https://target.example"],
  spec: {},
  contract_hash: "fixture-contract",
  created_at: "2026-01-01T00:00:00.000Z",
};

function fakeSandbox(
  run: (
    command: string,
    options?: Record<string, unknown>,
  ) => Promise<FakeCommandResult>,
) {
  return {
    sandboxId: "sandbox-fixture",
    display: ":0",
    commands: { run: vi.fn(run) },
    files: { write: vi.fn(async () => undefined) },
    stream: {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      getAuthKey: vi.fn(() => "stream-key"),
      getUrl: vi.fn(() => "https://stream.example/"),
    },
    getHost: vi.fn((port: number) => `public-${port}.example`),
    setTimeout: vi.fn(async () => undefined),
    isRunning: vi.fn(async () => true),
    kill: vi.fn(async () => undefined),
  };
}

async function allowAsyncSetup(predicate: () => boolean): Promise<void> {
  for (let count = 0; count < 50; count++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(
    "E2B provider did not reach the expected asynchronous boundary",
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  mocks.createSandbox.mockReset();
  mocks.connectOverCDP.mockReset();
  mocks.launchPersistentContext.mockReset();
  mocks.fetch.mockReset();
});

describe("E2B browser startup boundaries", () => {
  it("retries relay ingress readiness and rewrites Chrome's loopback WebSocket to authenticated TLS", async () => {
    const disconnect = vi.fn(async () => undefined);
    const sandbox = fakeSandbox(async () => ({ exitCode: 0, disconnect }));
    mocks.createSandbox.mockResolvedValue(sandbox);
    const transient = {
      ok: false,
      status: 502,
      body: { cancel: vi.fn(async () => undefined) },
    };
    mocks.fetch
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce(transient)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          webSocketDebuggerUrl:
            "ws://127.0.0.1:9222/devtools/browser/ab12cd34-ef56",
        }),
      });
    vi.stubGlobal("fetch", mocks.fetch);
    // Stop at the transport boundary; this test makes no network connections.
    mocks.connectOverCDP.mockRejectedValue(new Error("Mock transport stop"));
    const provider = createBrowserProvider(config());
    await expect(provider.connect(site)).rejects.toMatchObject({
      code: "e2b_browser_capability_unavailable",
    });
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
    expect(transient.body.cancel).toHaveBeenCalledOnce();
    expect(mocks.connectOverCDP).toHaveBeenCalledWith(
      "wss://public-9223.example/devtools/browser/ab12cd34-ef56",
      expect.objectContaining({
        headers: {
          Authorization: expect.stringMatching(/^Bearer [A-Za-z0-9_-]{43}$/),
        },
      }),
    );
    expect(disconnect).toHaveBeenCalledTimes(2);
    expect(sandbox.kill).toHaveBeenCalledOnce();
    await provider.close();
  });

  it("bounds repeated failing readiness commands by one millisecond deadline and disposes the sandbox", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let monotonicMs = 0;
    vi.spyOn(performance, "now").mockImplementation(() => monotonicMs);
    const chromeDisconnect = vi.fn(async () => undefined);
    const sandbox = fakeSandbox(async (command) => {
      if (command.startsWith("google-chrome ")) {
        return { disconnect: chromeDisconnect };
      }
      if (command.startsWith("curl ")) {
        monotonicMs += 400;
        throw Object.assign(new Error("Command exited with status 7"), {
          name: "CommandExitError",
        });
      }
      return { exitCode: 0 };
    });
    mocks.createSandbox.mockResolvedValue(sandbox);
    mocks.fetch.mockRejectedValue(
      new Error("Public ingress must not be queried before local readiness"),
    );
    vi.stubGlobal("fetch", mocks.fetch);

    const provider = createBrowserProvider(config());
    const connection = provider.connect(site);
    const rejection = expect(connection).rejects.toMatchObject({
      code: "e2b_browser_capability_unavailable",
      status: 503,
    });
    await allowAsyncSetup(() =>
      sandbox.commands.run.mock.calls.some(([command]) =>
        String(command).startsWith("curl "),
      ),
    );
    await vi.runAllTimersAsync();
    await rejection;

    const chromeCall = sandbox.commands.run.mock.calls.find(([command]) =>
      String(command).startsWith("google-chrome "),
    );
    expect(chromeCall?.[0]).toContain("--remote-debugging-address=127.0.0.1");
    expect(chromeCall?.[1]).toMatchObject({
      background: true,
      timeoutMs: 0,
      envs: { DISPLAY: ":0" },
    });
    expect(chromeDisconnect).toHaveBeenCalledOnce();

    const probes = sandbox.commands.run.mock.calls.filter(([command]) =>
      String(command).startsWith("curl "),
    );
    expect(probes).toHaveLength(3);
    expect(
      probes.map(([, options]) => ({
        timeoutMs: options?.timeoutMs,
        requestTimeoutMs: options?.requestTimeoutMs,
      })),
    ).toEqual([
      { timeoutMs: 1_000, requestTimeoutMs: 1_000 },
      { timeoutMs: 600, requestTimeoutMs: 600 },
      { timeoutMs: 200, requestTimeoutMs: 200 },
    ]);
    expect(monotonicMs).toBe(1_200);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(sandbox.kill).toHaveBeenCalledOnce();
    expect(mocks.connectOverCDP).not.toHaveBeenCalled();
    await provider.close();
  });

  it("rejects an unauthenticated public Chrome endpoint before installing the relay", async () => {
    const chromeDisconnect = vi.fn(async () => undefined);
    const sandbox = fakeSandbox(async (command) => {
      if (command.startsWith("google-chrome ")) {
        return { disconnect: chromeDisconnect };
      }
      return { exitCode: 0 };
    });
    mocks.createSandbox.mockResolvedValue(sandbox);
    const exposedResponse = {
      ok: true,
      status: 200,
      body: { cancel: vi.fn(async () => undefined) },
    };
    mocks.fetch.mockResolvedValue(exposedResponse);
    vi.stubGlobal("fetch", mocks.fetch);

    const provider = createBrowserProvider(config());
    await expect(provider.connect(site)).rejects.toMatchObject({
      code: "e2b_cdp_exposed",
      status: 502,
    });

    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(mocks.fetch.mock.calls[0]?.[0]).toBe(
      "https://public-9222.example/json/version",
    );
    expect(mocks.fetch.mock.calls[0]?.[1]).toMatchObject({
      redirect: "manual",
    });
    expect(chromeDisconnect).toHaveBeenCalledOnce();
    expect(sandbox.files.write).not.toHaveBeenCalled();
    expect(mocks.connectOverCDP).not.toHaveBeenCalled();
    expect(sandbox.kill).toHaveBeenCalledOnce();
    await provider.close();
  });
});
