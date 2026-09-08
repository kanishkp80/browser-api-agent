import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/config.js";
import { BrowserApiService } from "../src/service.js";
import type {
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
  for (const service of services.splice(0)) await service.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function configuration(): AppConfig {
  const dataDir = mkdtempSync(join(tmpdir(), "browser-api-handoff-"));
  directories.push(dataDir);
  return loadConfig({
    BROWSER_API_DATA_DIR: dataDir,
    BROWSER_API_ALLOW_LOCAL_SITES: "true",
    BROWSER_API_SERVICE_TOKEN: "handoff-test-token-".repeat(3),
    BROWSER_API_HEARTBEAT_MS: "100000",
  });
}

const spec: JsonObject = {
  openapi: "3.1.0",
  info: { title: "Handoff fixture", version: "1" },
  paths: {
    "/jobs": {
      post: {
        operationId: "createJob",
        requestBody: {
          content: { "application/json": { schema: { type: "object" } } },
        },
        responses: {
          "200": {
            description: "Done",
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    },
  },
};

const site: SiteRegistration = {
  site_id: "handoff-fixture",
  account_id: "test-account",
  base_url: "http://127.0.0.1:9999/",
  spec,
};

class HandoffBrowser implements BrowserProvider, BrowserSession {
  readonly id = "handoff-browser";
  readonly presentation = "local_window" as const;
  actions: BrowserAction[] = [];
  releaseCalls = 0;
  failNextRelease = false;
  releaseGate?: Promise<void>;

  async connect(): Promise<BrowserSession> {
    return this;
  }
  async observe() {
    return {
      url: site.base_url,
      title: "Jobs",
      content: '- button "Create job"',
      truncated: false,
    };
  }
  async act(action: BrowserAction) {
    this.actions.push(action);
    return {};
  }
  async humanAccess() {
    return { presentation: this.presentation };
  }
  async releaseHumanControl(): Promise<void> {
    this.releaseCalls++;
    if (this.releaseGate) await this.releaseGate;
    if (this.failNextRelease) {
      this.failNextRelease = false;
      throw new Error("stream stop failed");
    }
  }
  async close() {}
}

const askHuman: DiscoveryAgent = {
  async next() {
    return {
      kind: "human",
      reason: "login",
      instructions: "Sign in to the test account.",
    };
  },
};

function setup(
  config = configuration(),
  browser = new HandoffBrowser(),
  agent: DiscoveryAgent = askHuman,
) {
  const service = new BrowserApiService(config, { browser, agent });
  services.push(service);
  service.registerSite(site);
  return { service, browser, config };
}

async function until(
  service: BrowserApiService,
  id: string,
  predicate: (operation: Operation) => boolean,
): Promise<Operation> {
  for (let count = 0; count < 100; count++) {
    const operation = service.getOperation(id);
    if (predicate(operation)) return operation;
    await service.waitOperation(id, operation.revision, 50);
  }
  throw new Error(
    `Operation did not settle: ${JSON.stringify(service.getOperation(id))}`,
  );
}

async function waitingHandoff(service: BrowserApiService): Promise<Operation> {
  const accepted = await service.execute({
    request_id: "handoff-request",
    site_id: site.site_id,
    endpoint: "createJob",
    input: { body: {} },
  });
  return until(
    service,
    accepted.operation_id,
    (operation) => operation.state === "waiting_for_human",
  );
}

describe("durable exclusive browser handoffs", () => {
  it("issues a private capability to one claimant and rejects competitors", async () => {
    const { service } = setup();
    const waiting = await waitingHandoff(service);
    const claim = await service.claimHandoff(waiting.operation_id);

    expect(claim.claim_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(claim.operation)).not.toContain(claim.claim_token);
    expect(JSON.stringify(claim.operation)).not.toContain("token_hash");
    await expect(
      service.claimHandoff(waiting.operation_id),
    ).rejects.toMatchObject({ code: "handoff_already_claimed" });
    await expect(
      service.humanAccess(waiting.operation_id, "A".repeat(43)),
    ).rejects.toMatchObject({ code: "invalid_handoff_claim" });
    await expect(
      service.humanAccess(waiting.operation_id, claim.claim_token),
    ).resolves.toEqual({ presentation: "local_window" });
  });

  it("checkpoints the human outcome before release and admits only one in-flight return", async () => {
    const { service, browser } = setup();
    const waiting = await waitingHandoff(service);
    const claim = await service.claimHandoff(waiting.operation_id);
    let release!: () => void;
    browser.releaseGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = service.returnHandoff(
      waiting.operation_id,
      claim.claim_token,
      "Submitted the job once.",
      "submitted",
    );
    const checkpoint = await until(
      service,
      waiting.operation_id,
      (operation) => operation.human_action?.returning === true,
    );
    expect(checkpoint).toMatchObject({
      state: "waiting_for_human",
      submission: "observed",
      human_action: { claimed: true, returning: true },
    });
    await expect(
      service.returnHandoff(
        waiting.operation_id,
        claim.claim_token,
        "Submitted the job once.",
        "submitted",
      ),
    ).rejects.toMatchObject({ code: "handoff_return_pending" });
    expect(browser.releaseCalls).toBe(1);

    release();
    await expect(first).resolves.toMatchObject({
      state: "reconciling",
      submission: "observed",
      human_action: undefined,
    });
  });

  it("keeps a failed release safely retryable only with the recorded outcome", async () => {
    const { service, browser } = setup();
    const waiting = await waitingHandoff(service);
    const claim = await service.claimHandoff(waiting.operation_id);
    browser.failNextRelease = true;

    await expect(
      service.returnHandoff(
        waiting.operation_id,
        claim.claim_token,
        "I may have submitted.",
        "unknown",
      ),
    ).rejects.toMatchObject({ code: "handoff_release_failed" });
    expect(service.getOperation(waiting.operation_id)).toMatchObject({
      state: "waiting_for_human",
      submission: "intent",
      error: { code: "handoff_release_failed" },
      human_action: { claimed: true, returning: true },
    });
    await expect(
      service.returnHandoff(
        waiting.operation_id,
        claim.claim_token,
        "I may have submitted.",
        "no_submission",
      ),
    ).rejects.toMatchObject({ code: "handoff_return_conflict" });
    await expect(
      service.returnHandoff(
        waiting.operation_id,
        claim.claim_token,
        "Retry browser release.",
        "unknown",
      ),
    ).resolves.toMatchObject({ state: "reconciling", submission: "intent" });
    expect(browser.releaseCalls).toBe(2);
  });

  it("invalidates a claim after restart and treats unreported human activity as a possible submission", async () => {
    const firstBrowser = new HandoffBrowser();
    const { service, config } = setup(configuration(), firstBrowser);
    const waiting = await waitingHandoff(service);
    const claim = await service.claimHandoff(waiting.operation_id);
    await service.close();
    services.splice(services.indexOf(service), 1);

    const recoveredBrowser = new HandoffBrowser();
    const mutatingAgent: DiscoveryAgent = {
      async next() {
        return {
          kind: "action",
          message: "Try to submit",
          step: {
            action: {
              kind: "click",
              target: { by: "role", value: "button", name: "Create job" },
            },
            effect: "submission",
            description: "Create job",
          },
        };
      },
    };
    const recovered = setup(config, recoveredBrowser, mutatingAgent).service;
    const operation = recovered.getOperation(waiting.operation_id);
    expect(operation).toMatchObject({
      state: "reconciling",
      submission: "intent",
    });
    expect(operation.human_action).toBeUndefined();
    expect(recovered.store.handoffClaim(waiting.operation_id)).toBeUndefined();
    await expect(
      recovered.humanAccess(waiting.operation_id, claim.claim_token),
    ).rejects.toMatchObject({ code: "invalid_handoff_claim" });

    await recovered.resumeOperation(waiting.operation_id);
    await until(
      recovered,
      waiting.operation_id,
      (value) =>
        value.state === "reconciling" &&
        value.error?.code === "submission_uncertain",
    );
    expect(
      recoveredBrowser.actions.some((action) => action.kind === "click"),
    ).toBe(false);
  });
});
