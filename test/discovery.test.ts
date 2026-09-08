import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  agentOutputSchema,
  createDiscoveryAgent,
  parseAgentDecision,
  shouldRunInitialReview,
} from "../src/discovery.js";
import type {
  AppConfig,
  DiscoveryContext,
  Endpoint,
  Operation,
  Site,
} from "../src/types.js";

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    dataDir: "/tmp/browser-api-discovery-test",
    host: "127.0.0.1",
    port: 0,
    controlBaseUrl: "http://127.0.0.1",
    serviceToken: "test-service-token",
    browserHost: "local",
    headless: true,
    discoveryBudgetMs: 10_000,
    actionTimeoutMs: 5_000,
    heartbeatMs: 1_000,
    maxArtifactBytes: 1024 * 1024,
    allowLocalSites: true,
    ...overrides,
  };
}

function context(): DiscoveryContext {
  const site: Site = {
    site_id: "site",
    account_id: "account",
    base_url: "https://example.com/",
    spec: {},
    contract_hash: "hash",
    created_at: "2026-09-08T00:00:00.000Z",
  };
  const endpoint: Endpoint = {
    key: "POST /parse",
    method: "POST",
    path: "/parse",
    summary: "Parse a document",
    input_schema: {},
    responses: {
      "200": {
        schema: {},
        media_type: "application/json",
        required_headers: [],
      },
    },
  };
  const operation: Operation = {
    operation_id: "op_1",
    request_id: "req_1",
    site_id: site.site_id,
    account_id: site.account_id,
    endpoint: endpoint.key,
    input: {},
    input_hash: "input-hash",
    contract_hash: site.contract_hash,
    state: "running",
    phase: "discovering",
    revision: 1,
    created_at: "2026-09-08T00:00:00.000Z",
    updated_at: "2026-09-08T00:00:00.000Z",
    active_discovery_ms: 0,
    discovery_budget_ms: 10_000,
    submission: "none",
    step_index: 0,
    outputs: {},
    candidate_steps: [],
    artifacts: [],
    notes: [],
  };
  return {
    site,
    endpoint,
    operation,
    observation: {
      url: site.base_url,
      title: "Studio",
      content: "Upload a document",
      truncated: false,
    },
    knowledge: [],
    signal: new AbortController().signal,
  };
}

describe("discovery decision validation", () => {
  it("generates an object-rooted structured-output JSON schema", () => {
    const schema = z.toJSONSchema(agentOutputSchema, { target: "draft-7" });
    expect(schema.type).toBe("object");
    expect(schema.required).toContain("decision");
    expect(schema.additionalProperties).toBe(false);
  });

  it("accepts an evidence-producing read action", () => {
    expect(
      parseAgentDecision({
        kind: "action",
        step: {
          action: {
            kind: "read",
            target: { by: "testid", value: "result-json" },
            format: "json",
          },
          bindings: null,
          effect: "none",
          save_as: "parse_result",
          description: "Read the complete JSON result shown by the site.",
        },
        message: "The result view is visible; capture its JSON.",
      }),
    ).toMatchObject({ kind: "action", step: { save_as: "parse_result" } });
  });

  it("normalizes evidence-backed response mappings without fabricated bodies", () => {
    expect(
      parseAgentDecision({
        kind: "finish",
        response: {
          status: 200,
          headers: [
            {
              name: "Content-Type",
              binding: { source: "literal", value: "application/json" },
            },
            {
              name: "X-Job-Id",
              binding: { source: "output", path: "/job_id" },
            },
          ],
          body: { source: "output", path: "/parse_result" },
        },
        coverage_schema_json: '{"type":"object"}',
        message: "The complete response has been extracted and mapped.",
      }),
    ).toEqual({
      kind: "finish",
      response: {
        status: 200,
        headers: {
          "Content-Type": { source: "literal", value: "application/json" },
          "X-Job-Id": { source: "output", path: "/job_id" },
        },
        body: { source: "output", path: "/parse_result" },
      },
      coverage_schema: { type: "object" },
      message: "The complete response has been extracted and mapped.",
    });
  });

  it("rejects extraction without save_as and mutating follow actions", () => {
    expect(() =>
      parseAgentDecision({
        kind: "action",
        step: {
          action: {
            kind: "read",
            target: { by: "css", value: "pre" },
            format: "json",
          },
          bindings: null,
          effect: "none",
          save_as: null,
          description: "Read output.",
        },
        message: "Read output.",
      }),
    ).toThrow(/must name the extracted output/);

    expect(() =>
      parseAgentDecision({
        kind: "action",
        step: {
          action: {
            kind: "follow",
            target: { by: "role", value: "link", name: "Results" },
          },
          bindings: null,
          effect: "submission",
          save_as: null,
          description: "Open results.",
        },
        message: "Open results.",
      }),
    ).toThrow(/effect=none/);
  });

  it("rejects arbitrary actions and literal response fabrication", () => {
    expect(() =>
      parseAgentDecision({
        kind: "action",
        step: {
          action: { kind: "evaluate", script: 'fetch("/private-api")' },
          bindings: null,
          effect: "none",
          save_as: null,
          description: "Run a script.",
        },
        message: "Run a script.",
      }),
    ).toThrow(/required schema/);

    expect(() =>
      parseAgentDecision({
        kind: "finish",
        response: {
          status: 200,
          headers: [],
          body: { source: "literal", value: { fabricated: true } },
        },
        coverage_schema_json: "{}",
        message: "Done.",
      }),
    ).toThrow(/required schema/);
  });

  it("does not attempt a model call without a configured server-side key", async () => {
    const discovery = createDiscoveryAgent(config());
    await expect(discovery.next(context())).rejects.toMatchObject({
      code: "openai_credentials_missing",
    });
  });

  it("runs initial reviewers only for cold operations without reusable observed knowledge", () => {
    const cold = context();
    expect(shouldRunInitialReview(cold)).toBe(true);

    const reviewed = context();
    reviewed.operation.notes.push("initial_review_completed");
    expect(shouldRunInitialReview(reviewed)).toBe(false);

    const known = context();
    known.knowledge.push({
      recipe: {
        status: "observed",
        schema_valid: true,
        recipe_id: "recipe_1",
      },
    });
    expect(shouldRunInitialReview(known)).toBe(false);

    const schemaValid = context();
    schemaValid.knowledge.push({ schema_valid: true });
    expect(shouldRunInitialReview(schemaValid)).toBe(false);
  });
});

const liveApiKey = process.env.OPENAI_API_KEY;
it.runIf(process.env.RUN_LIVE_ASTRA === "1" && Boolean(liveApiKey))(
  "returns one structured Astra decision for synthetic discovery input",
  async () => {
    const synthetic = context();
    synthetic.endpoint = {
      ...synthetic.endpoint,
      key: "GET /results",
      method: "GET",
      path: "/results",
      summary: "Return the existing result JSON",
    };
    synthetic.operation.endpoint = synthetic.endpoint.key;
    synthetic.observation = {
      url: "https://example.com/runs/one",
      title: "Run complete",
      content: '- link "Results"\n- text "Run complete"',
      truncated: false,
    };
    const progress: string[] = [];
    synthetic.report = (message) => progress.push(message);
    const discovery = createDiscoveryAgent(
      config({ openaiApiKey: liveApiKey }),
    );
    let decision;
    try {
      decision = await discovery.next(synthetic);
    } catch (error) {
      const details =
        typeof error === "object" && error !== null && "details" in error
          ? JSON.stringify(error.details)
          : "";
      throw new Error(
        `${error instanceof Error ? error.message : "Live discovery failed"}${details ? `: ${details}` : ""}`,
      );
    }
    expect(["action", "human", "wait_job", "finish", "unsupported"]).toContain(
      decision.kind,
    );
    expect(decision.learning?.notes.length).toBeGreaterThan(0);
    expect(progress).toHaveLength(2);
    if (decision.kind === "action")
      expect(decision.step.action.kind).toBeTruthy();
  },
  120_000,
);
