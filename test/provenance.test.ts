import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { AppError } from "../src/errors.js";
import { BrowserApiService } from "../src/service.js";
import { Store } from "../src/store.js";
import type {
  AgentDecision,
  AppConfig,
  BrowserAction,
  BrowserProvider,
  BrowserSession,
  DiscoveryAgent,
  Json,
  JsonObject,
  Operation,
  Recipe,
  RecipeStep,
  ResponseMapping,
  SiteRegistration,
} from "../src/types.js";

const directories: string[] = [];
const services: BrowserApiService[] = [];

afterEach(async () => {
  for (const service of services.splice(0).reverse()) await service.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const spec = {
  openapi: "3.1.0",
  info: { title: "Provenance fixture", version: "1" },
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
} as JsonObject;

const site: SiteRegistration = {
  site_id: "provenance-fixture",
  account_id: "test-account",
  base_url: "http://127.0.0.1:9999/",
  spec,
};

const responseMapping: ResponseMapping = {
  status: 200,
  headers: {
    "content-type": { source: "literal", value: "application/json" },
  },
  body: { source: "output", path: "/result" },
};

const readResult: RecipeStep = {
  action: {
    kind: "read",
    target: { by: "testid", value: "result" },
    format: "json",
  },
  effect: "none",
  save_as: "result",
  description: "Read the complete result",
};

const clickSubmit: RecipeStep = {
  action: {
    kind: "click",
    target: { by: "role", value: "button", name: "Parse" },
  },
  effect: "submission",
  description: "Submit parse",
};

const fillInput: RecipeStep = {
  action: {
    kind: "fill",
    target: { by: "label", value: "Text" },
    value: "",
  },
  bindings: { value: { source: "input", path: "/body/text" } },
  effect: "none",
  description: "Fill source text",
};

class FixtureBrowser implements BrowserProvider, BrowserSession {
  readonly id = "provenance-browser";
  readonly presentation = "local_window" as const;
  readonly actions: BrowserAction[] = [];
  value = "existing result";
  submissions = 0;
  invalidResult = false;
  humanAccesses = 0;

  async connect(): Promise<BrowserSession> {
    return this;
  }

  async observe() {
    return {
      url: site.base_url,
      title: "Fixture",
      content: '- textbox "Text"\n- button "Parse"\n- code "Result"',
      truncated: false,
    };
  }

  async act(action: BrowserAction) {
    this.actions.push(action);
    if (action.kind === "fill") this.value = action.value;
    if (action.kind === "click") this.submissions++;
    if (action.kind === "read") {
      return {
        value: this.invalidResult
          ? ({ text: 123 } as unknown as Json)
          : { text: this.value },
      };
    }
    return {};
  }

  async humanAccess() {
    this.humanAccesses++;
    return { presentation: this.presentation };
  }

  async close() {}
}

class PublishingStore extends Store {
  onUpdate?: (eventType: string, operation: Operation) => void;

  override update(
    id: string,
    change: (operation: Operation) => void,
    eventType: string,
    message: string,
    details?: Json,
  ): Operation {
    const operation = super.update(id, change, eventType, message, details);
    this.onUpdate?.(eventType, operation);
    return operation;
  }
}

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  const directory = mkdtempSync(join(tmpdir(), "browser-api-provenance-"));
  directories.push(directory);
  return {
    ...loadConfig({
      BROWSER_API_DATA_DIR: directory,
      BROWSER_API_ALLOW_LOCAL_SITES: "true",
      BROWSER_API_SERVICE_TOKEN: "test-token-".repeat(5),
      BROWSER_API_HEARTBEAT_MS: "100000",
    }),
    ...overrides,
  };
}

function setup(
  agent: DiscoveryAgent,
  options: {
    browser?: FixtureBrowser;
    config?: AppConfig;
    store?: Store;
  } = {},
) {
  const browser = options.browser ?? new FixtureBrowser();
  const cfg = options.config ?? config();
  const app = new BrowserApiService(cfg, {
    browser,
    agent,
    ...(options.store ? { store: options.store } : {}),
  });
  services.push(app);
  app.registerSite(site);
  return { app, browser };
}

async function until(
  app: BrowserApiService,
  id: string,
  predicate: (operation: Operation) => boolean,
): Promise<Operation> {
  for (let count = 0; count < 100; count++) {
    const operation = app.getOperation(id);
    if (predicate(operation)) return operation;
    await app.waitOperation(id, operation.revision, 50);
  }
  throw new Error(
    `Operation did not settle: ${JSON.stringify(app.getOperation(id))}`,
  );
}

function execute(app: BrowserApiService, requestId: string) {
  return app.execute({
    request_id: requestId,
    site_id: site.site_id,
    endpoint: "parse",
    input: { body: { text: "hello" } },
  });
}

function finishDecision(): AgentDecision {
  return {
    kind: "finish",
    response: responseMapping,
    coverage_schema: {},
    message: "Return the captured result",
  };
}

function seedRecipe(
  app: BrowserApiService,
  recipeId: string,
  steps: RecipeStep[],
  continuation?: "observe",
): Recipe {
  const registered = app.listSites()[0]!;
  const recipe: Recipe = {
    recipe_id: recipeId,
    site_id: registered.site_id,
    account_id: registered.account_id,
    contract_hash: registered.contract_hash,
    endpoint: "parse",
    version: 1,
    status: "observed",
    input_schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      const: { body: { text: "hello" } },
    },
    steps,
    response: responseMapping,
    ...(continuation ? { continuation } : {}),
    evidence_operation_id: "seed-operation",
    created_at: "2026-01-01T00:00:00.000Z",
  };
  app.store.putRecipe(recipe);
  return recipe;
}

describe("response provenance", () => {
  it("does not finish a write endpoint without a submission boundary", async () => {
    const agent: DiscoveryAgent = {
      async next({ operation }) {
        return operation.outputs.result === undefined
          ? {
              kind: "action",
              step: readResult,
              message: "Read the currently displayed result",
            }
          : finishDecision();
      },
    };
    const { app, browser } = setup(agent);
    const accepted = await execute(app, "no-submission");
    const failed = await until(
      app,
      accepted.operation_id,
      (operation) => operation.state === "failed",
    );

    expect(failed).toMatchObject({
      state: "failed",
      submission: "none",
      error: { code: "ungrounded_response" },
    });
    expect(failed.api_response).toBeUndefined();
    expect(browser.submissions).toBe(0);
    expect(app.store.recipes(site.site_id, "parse")).toHaveLength(0);
  });

  it("does not use a pre-submission extraction as the final body", async () => {
    const agent: DiscoveryAgent = {
      async next({ operation }) {
        if (operation.outputs.result === undefined) {
          return {
            kind: "action",
            step: readResult,
            message: "Read the old result",
          };
        }
        if (operation.submission === "none") {
          return {
            kind: "action",
            step: clickSubmit,
            message: "Submit a new result",
          };
        }
        return finishDecision();
      },
    };
    const { app, browser } = setup(agent);
    const accepted = await execute(app, "stale-extraction");
    const failed = await until(
      app,
      accepted.operation_id,
      (operation) => operation.state === "failed",
    );

    expect(failed).toMatchObject({
      state: "failed",
      submission: "observed",
      error: { code: "ungrounded_response" },
    });
    expect(failed.api_response).toBeUndefined();
    expect(browser.submissions).toBe(1);
    expect(app.store.recipes(site.site_id, "parse")).toHaveLength(0);
  });
});

describe("observed recipe safety", () => {
  it("marks a warm recipe stale when its current response is invalid", async () => {
    let modelCalls = 0;
    const browser = new FixtureBrowser();
    browser.invalidResult = true;
    const { app } = setup(
      {
        async next() {
          modelCalls++;
          return {
            kind: "unsupported",
            reason: "Warm replay should finish or fail without discovery",
          };
        },
      },
      { browser },
    );
    const seeded = seedRecipe(app, "recipe-invalid-response", [
      fillInput,
      clickSubmit,
      readResult,
    ]);

    const accepted = await execute(app, "invalid-warm-response");
    const failed = await until(
      app,
      accepted.operation_id,
      (operation) => operation.state === "failed",
    );

    expect(failed).toMatchObject({
      state: "failed",
      submission: "observed",
      error: { code: "invalid_response" },
    });
    expect(browser.submissions).toBe(1);
    expect(modelCalls).toBe(0);
    expect(
      app.store
        .recipes(site.site_id, "parse")
        .find((recipe) => recipe.recipe_id === seeded.recipe_id)?.status,
    ).toBe("stale");
  });

  it("keeps an async warm recipe prefix-only when the result is immediately ready", async () => {
    let modelCalls = 0;
    const agent: DiscoveryAgent = {
      async next({ operation }) {
        modelCalls++;
        return operation.outputs.result === undefined
          ? {
              kind: "action",
              step: readResult,
              message: "The job result is already ready",
            }
          : finishDecision();
      },
    };
    const { app, browser } = setup(agent);
    const seeded = seedRecipe(
      app,
      "recipe-async-prefix",
      [fillInput, clickSubmit],
      "observe",
    );

    const accepted = await execute(app, "ready-async-warm");
    const completed = await until(
      app,
      accepted.operation_id,
      (operation) => operation.state === "succeeded",
    );
    const learned = app.store
      .recipes(site.site_id, "parse")
      .find((recipe) => recipe.recipe_id !== seeded.recipe_id);

    expect(completed.api_response?.body).toEqual({ text: "hello" });
    expect(browser.submissions).toBe(1);
    expect(modelCalls).toBe(2);
    expect(learned).toMatchObject({
      status: "observed",
      continuation: "observe",
      version: 2,
    });
    expect(learned?.steps.map((step) => step.action.kind)).toEqual([
      "fill",
      "click",
    ]);
    expect(learned?.steps.at(-1)?.effect).toBe("submission");
  });
});

describe("published-state cancellation", () => {
  it("drains cancellation published with a human handoff before run cleanup", async () => {
    const cfg = config();
    const store = new PublishingStore(cfg.dataDir, cfg.maxArtifactBytes);
    const browser = new FixtureBrowser();
    const { app } = setup(
      {
        async next() {
          return {
            kind: "human",
            reason: "login",
            instructions: "Sign in through the controlled browser",
          };
        },
      },
      { browser, config: cfg, store },
    );
    let cancellation: Promise<Operation> | undefined;
    store.onUpdate = (eventType, operation) => {
      if (eventType === "human_required" && cancellation === undefined) {
        cancellation = app.cancelOperation(operation.operation_id);
      }
    };

    const accepted = await execute(app, "cancel-at-handoff");
    const cancelled = await until(
      app,
      accepted.operation_id,
      (operation) => operation.state === "cancelled",
    );

    expect(cancellation).toBeDefined();
    await cancellation;
    expect(cancelled.human_action).toBeUndefined();
    expect(browser.humanAccesses).toBe(1);
    expect(
      app.store
        .events(accepted.operation_id, 0)
        .map((event) => event.event_type),
    ).toContain("cancelled_locally");
  });

  it("drains cancellation published with attention before run cleanup", async () => {
    const cfg = config();
    const store = new PublishingStore(cfg.dataDir, cfg.maxArtifactBytes);
    const { app } = setup(
      {
        async next() {
          throw new AppError(
            "discovery_reasoning_failed",
            "Deterministic adapter attention fixture",
            502,
          );
        },
      },
      { config: cfg, store },
    );
    let cancellation: Promise<Operation> | undefined;
    store.onUpdate = (eventType, operation) => {
      if (eventType === "adapter_attention" && cancellation === undefined) {
        cancellation = app.cancelOperation(operation.operation_id);
      }
    };

    const accepted = await execute(app, "cancel-at-attention");
    const cancelled = await until(
      app,
      accepted.operation_id,
      (operation) => operation.state === "cancelled",
    );

    expect(cancellation).toBeDefined();
    await cancellation;
    expect(cancelled.error?.code).toBe("discovery_reasoning_failed");
    expect(
      app.store
        .events(accepted.operation_id, 0)
        .map((event) => event.event_type),
    ).toEqual(
      expect.arrayContaining(["adapter_attention", "cancelled_locally"]),
    );
  });
});
