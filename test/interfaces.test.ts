import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import { AppError } from "../src/errors.js";
import { createHttpServer } from "../src/http.js";
import { createMcpBridge } from "../src/mcp.js";
import type {
  ApiResponse,
  Application,
  AppConfig,
  Artifact,
  Endpoint,
  ExecuteRequest,
  Operation,
  OperationUpdate,
  ProgressEvent,
  Site,
  SiteRegistration,
} from "../src/types.js";

const now = "2026-09-08T12:00:00.000Z";
const execFileAsync = promisify(execFile);

function operation(overrides: Partial<Operation> = {}): Operation {
  return {
    operation_id: "op_1",
    request_id: "req_1",
    site_id: "reducto",
    account_id: "acct_1",
    endpoint: "parse",
    input: { page_range: "1-3" },
    input_hash: "input-hash",
    contract_hash: "contract-hash",
    state: "running",
    phase: "discovering",
    revision: 2,
    created_at: now,
    updated_at: now,
    active_discovery_ms: 100,
    discovery_budget_ms: 60_000,
    submission: "none",
    step_index: 0,
    outputs: {},
    candidate_steps: [],
    artifacts: [],
    notes: [],
    ...overrides,
  };
}

function event(sequence: number, message: string): ProgressEvent {
  return {
    operation_id: "op_1",
    sequence,
    timestamp: now,
    state: "running",
    phase: "discovering",
    event_type: "observation",
    message,
  };
}

class MockApplication implements Application {
  readonly config: AppConfig = {
    dataDir: "/tmp/browser-api-tests",
    host: "127.0.0.1",
    port: 8765,
    controlBaseUrl: "http://127.0.0.1:8765",
    serviceToken: "test-token",
    browserHost: "local",
    headless: false,
    discoveryBudgetMs: 60_000,
    actionTimeoutMs: 5_000,
    heartbeatMs: 1_000,
    maxArtifactBytes: 1_024,
    allowLocalSites: false,
  };

  sites: Site[] = [];
  operations = new Map<string, Operation>([["op_1", operation()]]);
  events: ProgressEvent[] = [
    event(1, "Opened workspace"),
    event(2, "Found upload control"),
  ];
  artifacts = new Map<string, { metadata: Artifact; data: Uint8Array }>();
  returnCall?: {
    id: string;
    claimToken: string;
    note: string;
    outcome?: "no_submission" | "submitted" | "unknown";
  };

  registerSite(registration: SiteRegistration): Site {
    const site = {
      ...registration,
      contract_hash: "contract-hash",
      created_at: now,
    };
    this.sites = this.sites
      .filter((candidate) => candidate.site_id !== site.site_id)
      .concat(site);
    return site;
  }

  listSites(): Site[] {
    return this.sites;
  }

  listEndpoints(siteId: string): Endpoint[] {
    if (!this.sites.some((site) => site.site_id === siteId))
      throw new AppError("site_not_found", "Unknown site", 404);
    return [
      {
        key: "parse",
        method: "POST",
        path: "/parse",
        summary: "Parse document",
        input_schema: {},
        responses: {
          "200": {
            schema: {},
            media_type: "application/json",
            required_headers: [],
          },
        },
      },
    ];
  }

  async execute(request: ExecuteRequest): Promise<Operation> {
    const value = operation({
      operation_id: `op_${this.operations.size + 1}`,
      request_id: request.request_id,
      site_id: request.site_id,
      endpoint: request.endpoint,
      input: request.input,
      revision: 0,
    });
    this.operations.set(value.operation_id, value);
    return value;
  }

  getOperation(id: string): Operation {
    const value = this.operations.get(id);
    if (value === undefined)
      throw new AppError("operation_not_found", "Unknown operation", 404);
    return value;
  }

  async waitOperation(id: string, after = 0): Promise<OperationUpdate> {
    const current = this.getOperation(id);
    const events =
      id === "op_1" ? this.events.filter((item) => item.sequence > after) : [];
    return {
      operation: current,
      events,
      cursor: events.at(-1)?.sequence ?? Math.max(after, current.revision),
      has_more: false,
    };
  }

  getResult(id: string): {
    operation_id: string;
    state: Operation["state"];
    api_response?: ApiResponse;
    artifacts: string[];
  } {
    const current = this.getOperation(id);
    return {
      operation_id: id,
      state: current.state,
      ...(current.api_response === undefined
        ? {}
        : { api_response: current.api_response }),
      artifacts: current.artifacts,
    };
  }

  async cancelOperation(id: string): Promise<Operation> {
    const value = {
      ...this.getOperation(id),
      state: "cancelled" as const,
      phase: "complete" as const,
    };
    this.operations.set(id, value);
    return value;
  }

  async resumeOperation(id: string): Promise<Operation> {
    const value = { ...this.getOperation(id), state: "running" as const };
    this.operations.set(id, value);
    return value;
  }

  async claimHandoff(id: string) {
    if (this.getOperation(id).human_action?.claimed) {
      throw new AppError(
        "handoff_already_claimed",
        "Another human already owns this browser handoff",
        409,
      );
    }
    const value = {
      ...this.getOperation(id),
      state: "waiting_for_human" as const,
      human_action: {
        handoff_id: "handoff_1",
        reason: "login_required",
        instructions: "Sign in, then return control.",
        control_url: "http://127.0.0.1:8765/handoffs/op_1",
        presentation: "streamed_browser" as const,
        claimed: true,
      },
    };
    this.operations.set(id, value);
    return { operation: value, claim_token: "claim-token-1" };
  }

  async returnHandoff(
    id: string,
    claimToken: string,
    note: string,
    outcome?: "no_submission" | "submitted" | "unknown",
  ): Promise<Operation> {
    if (claimToken !== "claim-token-1")
      throw new AppError("invalid_handoff_claim", "Invalid claim", 403);
    this.returnCall = {
      id,
      claimToken,
      note,
      ...(outcome === undefined ? {} : { outcome }),
    };
    const value = {
      ...this.getOperation(id),
      state: "reconciling" as const,
      submission:
        outcome === "no_submission" ? ("none" as const) : ("intent" as const),
    };
    this.operations.set(id, value);
    return value;
  }

  async humanAccess(
    id: string,
    claimToken: string,
  ): Promise<{ presentation: "streamed_browser"; url: string }> {
    if (claimToken !== "claim-token-1")
      throw new AppError("invalid_handoff_claim", "Invalid claim", 403);
    this.getOperation(id);
    return {
      presentation: "streamed_browser",
      url: "https://stream.example.test/live/session-1",
    };
  }

  putArtifact(data: Uint8Array, name: string, mediaType: string): Artifact {
    const metadata: Artifact = {
      artifact_id: `artifact_${this.artifacts.size + 1}`,
      name,
      media_type: mediaType,
      bytes: data.byteLength,
      sha256: createHash("sha256").update(data).digest("hex"),
    };
    this.artifacts.set(metadata.artifact_id, {
      metadata,
      data: Uint8Array.from(data),
    });
    return metadata;
  }

  getArtifact(id: string): { metadata: Artifact; data: Uint8Array } {
    const value = this.artifacts.get(id);
    if (value === undefined)
      throw new AppError("artifact_not_found", "Unknown artifact", 404);
    return value;
  }

  async close(): Promise<void> {}
}

const servers: Array<{ close(): Promise<unknown> }> = [];
afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.close()));
});

function auth() {
  return { authorization: "Bearer test-token" };
}

describe("HTTP service interface", () => {
  it("authenticates service routes and registers a pinned site/spec", async () => {
    const application = new MockApplication();
    const server = await createHttpServer(application);
    servers.push(server);

    const denied = await server.inject({ method: "GET", url: "/v1/sites" });
    expect(denied.statusCode).toBe(401);
    expect(denied.json()).toEqual({
      error: {
        code: "unauthorized",
        message: "A valid service bearer token is required",
      },
    });

    const registration = {
      site_id: "reducto",
      account_id: "acct_1",
      base_url: "https://studio.reducto.ai",
      spec: { openapi: "3.1.0" },
    };
    const created = await server.inject({
      method: "POST",
      url: "/v1/sites",
      headers: { ...auth(), "content-type": "application/json" },
      payload: registration,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      site_id: "reducto",
      contract_hash: "contract-hash",
    });

    const spec = await server.inject({
      method: "GET",
      url: "/v1/sites/reducto/spec",
      headers: auth(),
    });
    expect(spec.json()).toEqual({
      site_id: "reducto",
      contract_hash: "contract-hash",
      spec: { openapi: "3.1.0" },
    });
  });

  it("returns durable operations and cursor-bounded event history", async () => {
    const application = new MockApplication();
    const server = await createHttpServer(application);
    servers.push(server);

    const executed = await server.inject({
      method: "POST",
      url: "/v1/operations",
      headers: { ...auth(), "content-type": "application/json" },
      payload: {
        request_id: "req_2",
        site_id: "reducto",
        endpoint: "parse",
        input: { page_range: "1-3" },
      },
    });
    expect(executed.statusCode).toBe(202);
    expect(executed.json()).toMatchObject({
      operation_id: "op_2",
      request_id: "req_2",
      phase: "discovering",
    });

    const waited = await server.inject({
      method: "GET",
      url: "/v1/operations/op_1/wait?after=1&timeout_ms=25",
      headers: auth(),
    });
    expect(waited.json()).toMatchObject({
      cursor: 2,
      events: [{ sequence: 2, message: "Found upload control" }],
    });

    const streamed = await server.inject({
      method: "GET",
      url: "/v1/operations/op_1/events?after=1&watch=0",
      headers: auth(),
    });
    expect(streamed.statusCode).toBe(200);
    expect(streamed.body).toContain("id: 2");
    expect(streamed.body).toContain("Found upload control");
    expect(streamed.body).not.toContain("Opened workspace");
  });

  it("serves a token-entry handoff page and requires same-origin mutation with an explicit human outcome", async () => {
    const application = new MockApplication();
    application.operations.set(
      "op_1",
      operation({ state: "waiting_for_human" }),
    );
    const server = await createHttpServer(application);
    servers.push(server);

    const page = await server.inject({
      method: "GET",
      url: "/handoffs/%3Cscript%3Ealert(1)%3C%2Fscript%3E",
    });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("sessionStorage.setItem");
    expect(page.body).toContain('value="no_submission"');
    expect(page.body).toContain('value="submitted"');
    expect(page.body).not.toContain("<script>alert(1)</script>");
    expect(page.headers["content-security-policy"]).toContain(
      "frame-ancestors 'none'",
    );

    const noOrigin = await server.inject({
      method: "POST",
      url: "/v1/handoffs/op_1/claim",
      headers: { ...auth(), "content-type": "application/json" },
      payload: {},
    });
    expect(noOrigin.statusCode).toBe(403);

    const wrongOrigin = await server.inject({
      method: "POST",
      url: "/v1/handoffs/op_1/claim",
      headers: {
        ...auth(),
        origin: "https://attacker.example",
        "content-type": "application/json",
      },
      payload: {},
    });
    expect(wrongOrigin.statusCode).toBe(403);

    const claimed = await server.inject({
      method: "POST",
      url: "/v1/handoffs/op_1/claim",
      headers: {
        ...auth(),
        origin: "http://127.0.0.1:8765",
        "content-type": "application/json",
      },
      payload: {},
    });
    expect(claimed.statusCode).toBe(200);
    expect(claimed.headers["cache-control"]).toBe("no-store");
    expect(claimed.json().operation.human_action.claimed).toBe(true);
    expect(claimed.json().claim_token).toBe("claim-token-1");

    const competingClaim = await server.inject({
      method: "POST",
      url: "/v1/handoffs/op_1/claim",
      headers: {
        ...auth(),
        origin: "http://127.0.0.1:8765",
        "content-type": "application/json",
      },
      payload: {},
    });
    expect(competingClaim.statusCode).toBe(409);

    const accessWithoutClaim = await server.inject({
      method: "GET",
      url: "/v1/handoffs/op_1/access",
      headers: auth(),
    });
    expect(accessWithoutClaim.statusCode).toBe(403);

    const access = await server.inject({
      method: "GET",
      url: "/v1/handoffs/op_1/access",
      headers: { ...auth(), "x-browser-handoff-token": "claim-token-1" },
    });
    expect(access.headers["cache-control"]).toBe("no-store");
    expect(access.json()).toEqual({
      presentation: "streamed_browser",
      url: "https://stream.example.test/live/session-1",
    });

    const returned = await server.inject({
      method: "POST",
      url: "/v1/handoffs/op_1/return",
      headers: {
        ...auth(),
        origin: "http://127.0.0.1:8765",
        "content-type": "application/json",
        "x-browser-handoff-token": "claim-token-1",
      },
      payload: {
        note: "Signed in and submitted the job.",
        outcome: "submitted",
      },
    });
    expect(returned.statusCode).toBe(200);
    expect(application.returnCall).toEqual({
      id: "op_1",
      claimToken: "claim-token-1",
      note: "Signed in and submitted the job.",
      outcome: "submitted",
    });
    expect(returned.json()).toMatchObject({
      state: "reconciling",
      submission: "intent",
    });
  });

  it("uploads bounded artifacts and supports authenticated byte ranges", async () => {
    const application = new MockApplication();
    const server = await createHttpServer(application);
    servers.push(server);

    const uploaded = await server.inject({
      method: "POST",
      url: "/v1/artifacts",
      headers: { ...auth(), "content-type": "application/json" },
      payload: {
        name: "result.json",
        media_type: "application/json",
        data_base64: Buffer.from("abcdef").toString("base64"),
      },
    });
    expect(uploaded.statusCode).toBe(201);
    expect(uploaded.json()).toMatchObject({
      artifact_id: "artifact_1",
      bytes: 6,
    });

    const range = await server.inject({
      method: "GET",
      url: "/v1/artifacts/artifact_1",
      headers: { ...auth(), range: "bytes=2-4" },
    });
    expect(range.statusCode).toBe(206);
    expect(range.rawPayload.toString("utf8")).toBe("cde");
    expect(range.headers["content-range"]).toBe("bytes 2-4/6");
    expect(range.headers["x-artifact-sha256"]).toBe(
      createHash("sha256").update("abcdef").digest("hex"),
    );
  });
});

describe("MCP bridge", () => {
  it("runs the real stdio entrypoint with clean JSON-RPC framing", async () => {
    const application = new MockApplication();
    application.registerSite({
      site_id: "reducto",
      account_id: "acct_1",
      base_url: "https://studio.reducto.ai",
      spec: { openapi: "3.1.0" },
    });
    const http = await createHttpServer(application);
    servers.push(http);
    const address = await http.listen({ port: 0, host: "127.0.0.1" });
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", resolve("src/mcp.ts")],
      cwd: resolve("."),
      env: {
        ...environment,
        BROWSER_API_SERVICE_URL: address,
        BROWSER_API_SERVICE_TOKEN: "test-token",
      },
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.setEncoding("utf8");
    transport.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const client = new Client({
      name: "stdio-interface-test",
      version: "1.0.0",
    });
    servers.push({ close: async () => client.close() });
    await client.connect(transport);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("list_sites");
    const listed = await client.callTool({ name: "list_sites", arguments: {} });
    expect(listed.structuredContent).toMatchObject({
      ok: true,
      data: [{ site_id: "reducto" }],
    });

    await client.close();
    expect(stderr).toBe("");
  }, 10_000);

  it("forwards to the existing service and returns stable structured results and errors", async () => {
    const application = new MockApplication();
    application.registerSite({
      site_id: "reducto",
      account_id: "acct_1",
      base_url: "https://studio.reducto.ai",
      spec: { openapi: "3.1.0" },
    });
    const http = await createHttpServer(application);
    servers.push(http);
    const address = await http.listen({ port: 0, host: "127.0.0.1" });
    application.config.controlBaseUrl = new URL(address).origin;

    const bridge = createMcpBridge({
      serviceUrl: address,
      serviceToken: "test-token",
      maxArtifactBytes: 16,
    });
    const client = new Client({ name: "interface-test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    servers.push(
      { close: async () => client.close() },
      { close: async () => bridge.close() },
    );
    await bridge.connect(serverTransport);
    await client.connect(clientTransport);

    const listed = await client.callTool({ name: "list_sites", arguments: {} });
    expect(listed.isError).not.toBe(true);
    expect(listed.structuredContent).toMatchObject({
      ok: true,
      data: [{ site_id: "reducto" }],
    });

    application.operations.set(
      "op_1",
      operation({ state: "waiting_for_human" }),
    );
    const claimed = await client.callTool({
      name: "claim_handoff",
      arguments: { operation_id: "op_1" },
    });
    expect(claimed.structuredContent).toMatchObject({
      ok: true,
      data: {
        claim_token: "claim-token-1",
        operation: { human_action: { claimed: true } },
      },
    });
    const competing = await client.callTool({
      name: "claim_handoff",
      arguments: { operation_id: "op_1" },
    });
    expect(competing.structuredContent).toMatchObject({
      ok: false,
      error: { code: "handoff_already_claimed" },
    });
    const access = await client.callTool({
      name: "get_handoff_access",
      arguments: { operation_id: "op_1", claim_token: "claim-token-1" },
    });
    expect(access.structuredContent).toMatchObject({
      ok: true,
      data: { presentation: "streamed_browser" },
    });
    const returned = await client.callTool({
      name: "return_handoff",
      arguments: {
        operation_id: "op_1",
        claim_token: "claim-token-1",
        note: "Submitted once.",
        outcome: "submitted",
      },
    });
    expect(returned.structuredContent).toMatchObject({
      ok: true,
      data: { state: "reconciling", submission: "intent" },
    });

    const missing = await client.callTool({
      name: "get_operation",
      arguments: { operation_id: "missing" },
    });
    expect(missing.isError).toBe(true);
    expect(missing.structuredContent).toEqual({
      ok: false,
      error: { code: "operation_not_found", message: "Unknown operation" },
    });

    const uploaded = await client.callTool({
      name: "upload_artifact",
      arguments: {
        name: "tiny.txt",
        media_type: "text/plain",
        data_base64: Buffer.from("abcdef").toString("base64"),
      },
    });
    expect(uploaded.structuredContent).toMatchObject({
      ok: true,
      data: { artifact_id: "artifact_1" },
    });

    const read = await client.callTool({
      name: "read_artifact",
      arguments: { artifact_id: "artifact_1", offset: 2, max_bytes: 3 },
    });
    expect(read.structuredContent).toMatchObject({
      ok: true,
      data: {
        offset: 2,
        data_base64: Buffer.from("cde").toString("base64"),
        next_offset: 5,
        eof: false,
      },
    });
  });

  it("serves authenticated Streamable HTTP MCP without creating another executor", async () => {
    const application = new MockApplication();
    application.registerSite({
      site_id: "reducto",
      account_id: "acct_1",
      base_url: "https://studio.reducto.ai",
      spec: { openapi: "3.1.0" },
    });
    const http = await createHttpServer(application);
    servers.push(http);
    const address = await http.listen({ port: 0, host: "127.0.0.1" });

    const transport = new StreamableHTTPClientTransport(
      new URL(`${address}/mcp`),
      {
        requestInit: { headers: { authorization: "Bearer test-token" } },
      },
    );
    const client = new Client({
      name: "remote-interface-test",
      version: "1.0.0",
    });
    servers.push({ close: async () => client.close() });
    await client.connect(transport);

    const listed = await client.callTool({ name: "list_sites", arguments: {} });
    expect(listed.structuredContent).toMatchObject({
      ok: true,
      data: [{ site_id: "reducto" }],
    });
    expect(application.operations.size).toBe(1);
  });
});

describe("CLI bridge", () => {
  it("emits replayable operation events as NDJSON for agent callers", async () => {
    const application = new MockApplication();
    application.operations.set(
      "op_1",
      operation({ state: "succeeded", phase: "complete" }),
    );
    const http = await createHttpServer(application);
    servers.push(http);
    const address = await http.listen({ port: 0, host: "127.0.0.1" });

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [
        resolve("node_modules/tsx/dist/cli.mjs"),
        resolve("src/cli.ts"),
        "--service-url",
        address,
        "--json",
        "events",
        "op_1",
        "--watch",
        "--after",
        "0",
      ],
      {
        cwd: resolve("."),
        env: { ...process.env, BROWSER_API_SERVICE_TOKEN: "test-token" },
        timeout: 5_000,
      },
    );
    expect(stderr).toBe("");
    const lines = stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as ProgressEvent);
    expect(lines.map((item) => item.sequence)).toEqual([1, 2]);
    expect(lines[1]).toMatchObject({
      message: "Found upload control",
      phase: "discovering",
    });
  });

  it("passes an exclusive handoff capability through an environment variable", async () => {
    const application = new MockApplication();
    application.operations.set(
      "op_1",
      operation({ state: "waiting_for_human" }),
    );
    const http = await createHttpServer(application);
    servers.push(http);
    const address = await http.listen({ port: 0, host: "127.0.0.1" });
    application.config.controlBaseUrl = new URL(address).origin;
    const baseArguments = [
      resolve("node_modules/tsx/dist/cli.mjs"),
      resolve("src/cli.ts"),
      "--service-url",
      address,
      "--json",
    ];
    const environment = {
      ...process.env,
      BROWSER_API_SERVICE_TOKEN: "test-token",
    };

    const claimed = await execFileAsync(
      process.execPath,
      [...baseArguments, "handoffs", "claim", "op_1"],
      { cwd: resolve("."), env: environment, timeout: 5_000 },
    );
    const claim = JSON.parse(claimed.stdout) as {
      claim_token: string;
      operation: Operation;
    };
    expect(claim).toMatchObject({
      claim_token: "claim-token-1",
      operation: { human_action: { claimed: true } },
    });

    const accessed = await execFileAsync(
      process.execPath,
      [...baseArguments, "handoffs", "access", "op_1"],
      {
        cwd: resolve("."),
        env: { ...environment, BROWSER_API_HANDOFF_TOKEN: claim.claim_token },
        timeout: 5_000,
      },
    );
    expect(JSON.parse(accessed.stdout)).toMatchObject({
      presentation: "streamed_browser",
    });

    const returned = await execFileAsync(
      process.execPath,
      [
        ...baseArguments,
        "handoffs",
        "return",
        "op_1",
        "--outcome",
        "submitted",
        "--note",
        "Submitted once.",
      ],
      {
        cwd: resolve("."),
        env: { ...environment, BROWSER_API_HANDOFF_TOKEN: claim.claim_token },
        timeout: 5_000,
      },
    );
    expect(JSON.parse(returned.stdout)).toMatchObject({
      state: "reconciling",
      submission: "intent",
    });
  });
});
