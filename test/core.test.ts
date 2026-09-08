import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserApiService } from "../src/service.js";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import type {
  AgentDecision,
  AppConfig,
  BrowserAction,
  BrowserProvider,
  BrowserSession,
  DiscoveryAgent,
  JsonObject,
  Operation,
  SiteRegistration,
} from "../src/types.js";

const directories: string[] = [];
const services: BrowserApiService[] = [];
afterEach(async () => {
  for (const app of services.splice(0)) await app.close();
  for (const dir of directories.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function config(extra: Partial<AppConfig> = {}): AppConfig {
  const dir = mkdtempSync(join(tmpdir(), "browser-api-core-"));
  directories.push(dir);
  return {
    ...loadConfig({
      BROWSER_API_DATA_DIR: dir,
      BROWSER_API_ALLOW_LOCAL_SITES: "true",
      BROWSER_API_SERVICE_TOKEN: "test-token-".repeat(5),
      BROWSER_API_HEARTBEAT_MS: "100000",
    }),
    ...extra,
  };
}
const spec: JsonObject = {
  openapi: "3.1.0",
  info: { title: "Fixture", version: "1" },
  paths: {
    "/parse": {
      post: {
        operationId: "parse",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["text"],
                additionalProperties: false,
                properties: { text: { type: "string" } },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Parsed",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["text"],
                  additionalProperties: false,
                  properties: { text: { type: "string" } },
                },
              },
            },
          },
        },
      },
    },
  },
};
const site: SiteRegistration = {
  site_id: "fixture",
  account_id: "test",
  base_url: "http://127.0.0.1:9999/",
  spec,
};
class FakeBrowser implements BrowserProvider, BrowserSession {
  id = "fixture";
  presentation = "local_window" as const;
  actions: BrowserAction[] = [];
  value = "";
  submissions = 0;
  failSubmission = false;
  async connect() {
    return this;
  }
  async observe() {
    return {
      url: site.base_url,
      title: "Test page",
      content: "Textbox Text; button Parse; result JSON",
      truncated: false,
    };
  }
  async act(action: BrowserAction) {
    this.actions.push(action);
    if (action.kind === "fill") this.value = action.value;
    if (action.kind === "click") {
      this.submissions++;
      if (this.failSubmission)
        throw new Error("Connection disappeared after clicking");
    }
    if (action.kind === "read") return { value: { text: this.value } };
    return {};
  }
  async humanAccess() {
    return { presentation: this.presentation };
  }
  async close() {}
}
function happyAgent(onNext?: () => void): DiscoveryAgent {
  return {
    async next({ operation }) {
      onNext?.();
      const completed = operation.candidate_steps.filter(
        (s) => s.action.kind !== "navigate",
      ).length;
      if (completed === 0)
        return {
          kind: "action",
          message: "Fill requested text",
          step: {
            action: {
              kind: "fill",
              target: { by: "label", value: "Text" },
              value: "",
            },
            bindings: { value: { source: "input", path: "/body/text" } },
            effect: "none",
            description: "Fill Text",
          },
        };
      if (completed === 1)
        return {
          kind: "action",
          message: "Submit once",
          step: {
            action: {
              kind: "click",
              target: { by: "role", value: "button", name: "Parse" },
            },
            effect: "submission",
            description: "Submit Parse",
          },
        };
      if (completed === 2)
        return {
          kind: "action",
          message: "Read complete JSON",
          step: {
            action: {
              kind: "read",
              target: { by: "testid", value: "result" },
              format: "json",
            },
            effect: "none",
            save_as: "result",
            description: "Read JSON",
          },
        };
      return {
        kind: "finish",
        response: {
          status: 200,
          headers: {
            "content-type": { source: "literal", value: "application/json" },
          },
          body: { source: "output", path: "/result" },
        },
        coverage_schema: { type: "object" },
        message: "Verified",
      };
    },
  };
}
function setup(
  opts: {
    config?: AppConfig;
    browser?: FakeBrowser;
    agent?: DiscoveryAgent;
  } = {},
) {
  const browser = opts.browser ?? new FakeBrowser();
  const app = new BrowserApiService(opts.config ?? config(), {
    browser,
    agent: opts.agent ?? happyAgent(),
  });
  services.push(app);
  app.registerSite(site);
  return { app, browser };
}
async function until(
  app: BrowserApiService,
  id: string,
  predicate: (op: Operation) => boolean,
): Promise<Operation> {
  for (let count = 0; count < 100; count++) {
    const op = app.getOperation(id);
    if (predicate(op)) return op;
    await app.waitOperation(id, op.revision, 50);
  }
  throw new Error(
    `Operation did not settle: ${JSON.stringify(app.getOperation(id))}`,
  );
}
function execute(
  app: BrowserApiService,
  requestId = "request-1",
  text = "hello",
) {
  return app.execute({
    request_id: requestId,
    site_id: site.site_id,
    endpoint: "parse",
    input: { body: { text } },
  });
}

describe("durable browser operations", () => {
  it("discovers in the call, captures a real output, then reuses the verified workflow without model calls", async () => {
    let modelCalls = 0;
    const { app, browser } = setup({ agent: happyAgent(() => modelCalls++) });
    const first = await execute(app);
    const done = await until(
      app,
      first.operation_id,
      (op) => op.state === "succeeded",
    );
    expect(done.api_response?.body).toEqual({ text: "hello" });
    expect(done.recipe_id).toBeDefined();
    expect(browser.submissions).toBe(1);
    const previousCalls = modelCalls;
    const second = await execute(app, "request-2", "a new document");
    const repeated = await until(
      app,
      second.operation_id,
      (op) => op.state === "succeeded",
    );
    expect(repeated.api_response?.body).toEqual({ text: "a new document" });
    expect(modelCalls).toBe(previousCalls);
    expect(browser.submissions).toBe(2);
    const events = await app.waitOperation(second.operation_id, 0, 0);
    expect(events.events.some((e) => e.event_type === "recipe_selected")).toBe(
      true,
    );
  });
  it("deduplicates simultaneous requests and rejects changed inputs for the same key", async () => {
    const { app, browser } = setup();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => execute(app)),
    );
    expect(new Set(results.map((r) => r.operation_id)).size).toBe(1);
    await until(
      app,
      results[0]!.operation_id,
      (op) => op.state === "succeeded",
    );
    expect(browser.submissions).toBe(1);
    await expect(execute(app, "request-1", "different")).rejects.toMatchObject({
      code: "request_id_conflict",
    });
  });
  it("preserves results, request keys, artifacts and recipes across service replacement", async () => {
    const cfg = config();
    const { app } = setup({ config: cfg });
    const accepted = await execute(app);
    const completed = await until(
      app,
      accepted.operation_id,
      (op) => op.state === "succeeded",
    );
    await app.close();
    const second = setup({
      config: cfg,
      agent: {
        async next() {
          throw new Error("A verified workflow should not need rediscovery");
        },
      },
    });
    expect((await execute(second.app)).operation_id).toBe(
      accepted.operation_id,
    );
    expect(
      second.app.getArtifact(completed.artifacts[0]!).metadata.bytes,
    ).toBeGreaterThan(0);
    const fresh = await execute(second.app, "after-restart");
    expect(
      (
        await until(
          second.app,
          fresh.operation_id,
          (op) => op.state === "succeeded",
        )
      ).api_response?.body,
    ).toEqual({ text: "hello" });
  });
  it("never retries a submission after an ambiguous browser failure", async () => {
    const browser = new FakeBrowser();
    browser.failSubmission = true;
    const { app } = setup({ browser });
    const accepted = await execute(app);
    const uncertain = await until(
      app,
      accepted.operation_id,
      (op) => op.state === "reconciling" && !!op.error,
    );
    expect(uncertain.submission).toBe("intent");
    expect(browser.submissions).toBe(1);
    await app.resumeOperation(accepted.operation_id);
    await until(
      app,
      accepted.operation_id,
      (op) => op.state === "reconciling" && !!op.error,
    );
    expect(browser.submissions).toBe(1);
  });
  it("replays ordered events after a disconnected observer and validates cursor bounds", async () => {
    const { app } = setup();
    const op = await execute(app);
    const first = await app.waitOperation(op.operation_id, 0, 0);
    await until(app, op.operation_id, (value) => value.state === "succeeded");
    const replay = await app.waitOperation(op.operation_id, first.cursor, 0);
    expect(replay.events.every((e) => e.sequence > first.cursor)).toBe(true);
    expect(replay.events.map((e) => e.sequence)).toEqual(
      [...replay.events.map((e) => e.sequence)].sort((a, b) => a - b),
    );
    await expect(
      app.waitOperation(op.operation_id, 1e9, 0),
    ).rejects.toMatchObject({ code: "invalid_cursor" });
  });
  it("bounds discovery time and preserves the consumed allowance after restart", async () => {
    const cfg = config({ discoveryBudgetMs: 10 });
    const agent: DiscoveryAgent = {
      async next() {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          kind: "unsupported",
          reason: "Should hit budget before this response is applied",
        };
      },
    };
    const { app } = setup({ config: cfg, agent });
    const op = await execute(app);
    const paused = await until(
      app,
      op.operation_id,
      (value) => value.state === "needs_attention",
    );
    expect(paused.error?.code).toBe("discovery_budget_exhausted");
    expect(paused.active_discovery_ms).toBeGreaterThanOrEqual(10);
    await app.close();
    const { app: recovered } = setup({ config: cfg, agent });
    expect(recovered.getOperation(op.operation_id).active_discovery_ms).toBe(
      paused.active_discovery_ms,
    );
    await expect(
      recovered.resumeOperation(op.operation_id),
    ).rejects.toMatchObject({ code: "extension_required" });
  });
  it("keeps human ownership exclusive and reconciles a human submission without clicking again", async () => {
    let prompted = false;
    const agent: DiscoveryAgent = {
      async next(ctx) {
        if (!prompted) {
          prompted = true;
          return { kind: "human", reason: "login", instructions: "Sign in" };
        }
        if (
          ctx.operation.submission !== "none" &&
          !("result" in ctx.operation.outputs)
        )
          return {
            kind: "action",
            message: "Read existing result",
            step: {
              action: {
                kind: "read",
                target: { by: "testid", value: "result" },
                format: "json",
              },
              effect: "none",
              save_as: "result",
              description: "Read existing JSON",
            },
          };
        return {
          kind: "finish",
          message: "Complete",
          coverage_schema: {},
          response: {
            status: 200,
            headers: {
              "content-type": { source: "literal", value: "application/json" },
            },
            body: { source: "output", path: "/result" },
          },
        };
      },
    };
    const { app, browser } = setup({ agent });
    const first = await execute(app);
    await until(
      app,
      first.operation_id,
      (op) => op.state === "waiting_for_human",
    );
    const claim = await app.claimHandoff(first.operation_id);
    const second = await execute(app, "queued-behind-human");
    await expect(app.resumeOperation(first.operation_id)).rejects.toMatchObject(
      { code: "human_owns_browser" },
    );
    expect(app.getOperation(second.operation_id).state).toBe("queued");
    browser.value = "human result";
    await app.returnHandoff(
      first.operation_id,
      claim.claim_token,
      "Submitted once manually",
      "submitted",
    );
    const done = await until(
      app,
      first.operation_id,
      (op) => op.state === "succeeded",
    );
    expect(done.api_response?.body).toEqual({ text: "human result" });
    expect(browser.submissions).toBe(0);
    expect(done.recipe_id).toBeUndefined();
  });
  it("rejects fabricated final bodies and captures schema mismatches as failures", async () => {
    const decision: AgentDecision = {
      kind: "finish",
      message: "Pretend result",
      coverage_schema: {},
      response: {
        status: 200,
        headers: {},
        body: { source: "literal", value: { text: "invented" } },
      },
    };
    const { app } = setup({
      agent: {
        async next() {
          return decision;
        },
      },
    });
    const op = await execute(app);
    const blocked = await until(
      app,
      op.operation_id,
      (value) => value.state === "failed",
    );
    expect(blocked.api_response).toBeUndefined();
    expect(app.store.recipes("fixture", "parse")).toHaveLength(0);
  });
  it("rejects invalid inputs before the browser runs", async () => {
    const { app, browser } = setup();
    await expect(
      app.execute({
        request_id: "invalid",
        site_id: "fixture",
        endpoint: "parse",
        input: { body: {} },
      }),
    ).rejects.toThrow();
    expect(browser.actions).toHaveLength(0);
  });
});

describe("storage and configuration boundaries", () => {
  it("allows one service owner and checks artifact integrity", () => {
    const cfg = config();
    const store = new Store(cfg.dataDir, 3);
    try {
      expect(() => new Store(cfg.dataDir)).toThrow("Another service");
      const artifact = store.putArtifact(
        Buffer.from("abc"),
        "../test.txt",
        "text/plain",
      );
      expect(store.artifact(artifact.artifact_id).data).toEqual(
        Buffer.from("abc"),
      );
      expect(() =>
        store.putArtifact(Buffer.from("abcd"), "big", "text/plain"),
      ).toThrow("byte limit");
      expect(() => store.artifactPath("../../escape")).toThrow("identifier");
    } finally {
      store.close();
    }
  });
  it("does not silently fall back to local when E2B credentials are absent", () => {
    expect(() => loadConfig({ BROWSER_API_BROWSER_HOST: "e2b" })).toThrow(
      "E2B_API_KEY",
    );
  });
  it("requires explicit authentication and HTTPS control URL for remote listeners", () => {
    expect(() => loadConfig({ BROWSER_API_HOST: "0.0.0.0" })).toThrow(
      "Remote listeners",
    );
  });
});

describe("reviewed recovery boundaries", () => {
  it("treats a mislabeled click as a submission and never replays it after failure", async () => {
    const browser = new FakeBrowser();
    browser.failSubmission = true;
    const usual = happyAgent();
    const { app } = setup({
      browser,
      agent: {
        async next(ctx) {
          const decision = await usual.next(ctx);
          if (
            decision.kind === "action" &&
            decision.step.action.kind === "click"
          )
            decision.step.effect = "none";
          return decision;
        },
      },
    });
    const op = await execute(app);
    const paused = await until(
      app,
      op.operation_id,
      (value) => value.state === "reconciling" && !!value.error,
    );
    expect(paused.submission).toBe("intent");
    await app.resumeOperation(op.operation_id);
    await until(
      app,
      op.operation_id,
      (value) => value.state === "reconciling" && !!value.error,
    );
    expect(browser.submissions).toBe(1);
  });

  it("reconciles a failed preparation action because forms may autosave", async () => {
    const browser = new FakeBrowser();
    const act = browser.act.bind(browser);
    browser.act = async (action) => {
      const result = await act(action);
      if (action.kind === "fill")
        throw new Error("Disconnected after the input event");
      return result;
    };
    const { app } = setup({ browser });
    const op = await execute(app);
    await until(
      app,
      op.operation_id,
      (value) => value.state === "reconciling" && !!value.error,
    );
    await app.resumeOperation(op.operation_id);
    await until(
      app,
      op.operation_id,
      (value) => value.state === "reconciling" && !!value.error,
    );
    expect(
      browser.actions.filter((action) => action.kind === "fill"),
    ).toHaveLength(1);
    expect(browser.submissions).toBe(0);
  });

  it("preserves an in-flight UI action as uncertain after service replacement", async () => {
    const cfg = config();
    const { app } = setup({ config: cfg });
    const op = await execute(app);
    await until(app, op.operation_id, (value) => value.state === "succeeded");
    app.store.update(
      op.operation_id,
      (value) => {
        value.state = "running";
        value.submission = "none";
        value.pending_ui_action = "fill";
        value.api_response = undefined;
      },
      "fault_checkpoint",
      "Simulated persisted checkpoint before process death",
    );
    await app.close();
    const { app: recovered } = setup({ config: cfg });
    expect(recovered.getOperation(op.operation_id)).toMatchObject({
      state: "reconciling",
      submission: "intent",
      pending_ui_action: "fill",
    });
  });

  it("retains a job page across waits and replays only its submission prefix on later calls", async () => {
    let calls = 0;
    const usual = happyAgent();
    const { app, browser } = setup({
      agent: {
        async next(ctx) {
          calls++;
          if (
            ctx.operation.submission === "observed" &&
            !ctx.operation.notes.includes("fixture_waited")
          ) {
            return {
              kind: "wait_job",
              delay_ms: 1000,
              message: "Fixture job is processing",
              learning: { notes: ["fixture_waited"] },
            };
          }
          return usual.next(ctx);
        },
      },
    });
    const first = await execute(app, "job-first", "first job");
    await until(
      app,
      first.operation_id,
      (value) => value.state === "queued" && value.phase === "monitoring",
    );
    const second = await execute(app, "job-second", "second job");
    expect(app.getOperation(second.operation_id).state).toBe("queued");
    expect(browser.submissions).toBe(1);
    expect(browser.value).toBe("first job");
    const firstDone = await until(
      app,
      first.operation_id,
      (value) => value.state === "succeeded",
    );
    expect(firstDone.api_response?.body).toEqual({ text: "first job" });
    const recipe = app.store.recipes("fixture", "parse")[0]!;
    expect(recipe.continuation).toBe("observe");
    expect(recipe.steps.at(-1)?.effect).toBe("submission");
    const callsBeforeMonitor = calls;
    const secondDone = await until(
      app,
      second.operation_id,
      (value) => value.state === "succeeded",
    );
    expect(secondDone.api_response?.body).toEqual({ text: "second job" });
    expect(calls).toBeGreaterThan(callsBeforeMonitor);
    expect(browser.submissions).toBe(2);
  });

  it("keeps business values and signed URLs out of structural site memory", async () => {
    const browser = new FakeBrowser();
    browser.observe = async () => ({
      url: `${site.base_url}invoice/private-account?token=secret-value#secret`,
      title: "Customer private@example.test",
      content:
        '- heading "Customer private@example.test"\n- link "invoice-secret.pdf"\n- button "Parse"',
      truncated: false,
    });
    const { app } = setup({ browser });
    const op = await execute(app);
    await until(app, op.operation_id, (value) => value.state === "succeeded");
    const memory = JSON.stringify(app.store.knowledge(app.listSites()[0]!));
    expect(memory).not.toMatch(/secret|private|invoice/);
    expect(memory).toContain('"button":1');
  });

  it("commits schema mismatches as explicit response gaps without promoting a recipe", async () => {
    const browser = new FakeBrowser();
    const act = browser.act.bind(browser);
    browser.act = async (action) =>
      action.kind === "read"
        ? { value: { text: 123 } as unknown as { text: string } }
        : act(action);
    const { app } = setup({ browser });
    const op = await execute(app);
    const failed = await until(
      app,
      op.operation_id,
      (value) => value.state === "failed",
    );
    expect(failed.error?.code).toBe("invalid_response");
    expect(failed.submission).toBe("observed");
    expect(failed.api_response).toBeUndefined();
    expect(app.store.recipes("fixture", "parse")).toHaveLength(0);
    expect(browser.submissions).toBe(1);
  });
});
