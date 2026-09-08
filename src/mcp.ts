import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { AppError } from "./errors.js";
import {
  BrowserApiHttpClient,
  ServiceClientError,
  decodeBase64,
} from "./http.js";
import type {
  Application,
  Artifact,
  Endpoint,
  Json,
  JsonObject,
  Operation,
  OperationUpdate,
  Site,
  SiteRegistration,
} from "./types.js";

const DEFAULT_SERVICE_URL = "http://127.0.0.1:8765";
const DEFAULT_MAX_MCP_ARTIFACT_BYTES = 4 * 1024 * 1024;
const MAX_WAIT_MS = 30_000;

export interface McpBridgeOptions {
  serviceUrl: string;
  serviceToken: string;
  maxArtifactBytes?: number;
}

interface StableToolError {
  code: string;
  message: string;
  details?: Json;
}

type McpServiceClient = Pick<
  BrowserApiHttpClient,
  | "listSites"
  | "registerSite"
  | "listEndpoints"
  | "getSpec"
  | "execute"
  | "getOperation"
  | "waitOperation"
  | "getResult"
  | "cancel"
  | "resume"
  | "claimHandoff"
  | "humanAccess"
  | "returnHandoff"
  | "putArtifactBase64"
  | "getArtifactMetadata"
  | "getArtifactBytes"
>;

function stableResult(data: unknown) {
  const payload = { ok: true, data };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function stableError(error: unknown) {
  let value: StableToolError;
  if (error instanceof ServiceClientError) {
    value = {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  } else if (error instanceof AppError) {
    value = error.toJSON();
  } else {
    value = {
      code: "bridge_error",
      message: "The browser-agent service request failed",
    };
  }
  const payload = { ok: false, error: value };
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function guarded<T extends Record<string, unknown>>(
  handler: (args: T) => Promise<unknown>,
): (
  args: T,
) => Promise<ReturnType<typeof stableResult> | ReturnType<typeof stableError>> {
  return async (args) => {
    try {
      return stableResult(await handler(args));
    } catch (error) {
      return stableError(error);
    }
  };
}

const JsonObjectSchema = z.record(z.string(), z.unknown());
const SiteRegistrationSchema = z.object({
  site_id: z.string().min(1).max(256),
  account_id: z.string().min(1).max(256),
  base_url: z.url(),
  allowed_origins: z.array(z.string()).optional(),
  spec: JsonObjectSchema,
});

function createMcpServer(
  client: McpServiceClient,
  configuredMaximum?: number,
): McpServer {
  const maxArtifactBytes = configuredMaximum ?? DEFAULT_MAX_MCP_ARTIFACT_BYTES;
  if (!Number.isSafeInteger(maxArtifactBytes) || maxArtifactBytes <= 0) {
    throw new Error("maxArtifactBytes must be a positive safe integer");
  }

  const server = new McpServer(
    { name: "browser-api-agent-bridge", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "list_sites",
    {
      description:
        "List registered browser-backed API sites. This does not start browser work.",
      inputSchema: z.object({}),
    },
    guarded(async () => (await client.listSites()).sites),
  );

  server.registerTool(
    "register_site",
    {
      description:
        "Register a pinned site, account, origin set, and API contract. Repeating the identical registration is idempotent; changes require a new site_id.",
      inputSchema: SiteRegistrationSchema,
    },
    guarded(async (args) => client.registerSite(args as SiteRegistration)),
  );

  server.registerTool(
    "list_endpoints",
    {
      description:
        "List endpoint schemas with observed browser-workflow scopes. api_parity remains unverified until an external vendor oracle establishes it.",
      inputSchema: z.object({ site_id: z.string().min(1).max(256) }),
    },
    guarded(
      async ({ site_id }) =>
        (await client.listEndpoints(site_id as string)).endpoints,
    ),
  );

  server.registerTool(
    "get_spec",
    {
      description:
        "Get the pinned API specification and contract hash for a registered site.",
      inputSchema: z.object({ site_id: z.string().min(1).max(256) }),
    },
    guarded(async ({ site_id }) => client.getSpec(site_id as string)),
  );

  server.registerTool(
    "execute_endpoint",
    {
      description:
        "Start one durable endpoint simulation. The first call may discover the UI before executing. Reuse request_id for retries.",
      inputSchema: z.object({
        request_id: z.string().min(1).max(256),
        site_id: z.string().min(1).max(256),
        endpoint: z.string().min(1).max(2_048),
        input: JsonObjectSchema,
        site: SiteRegistrationSchema.optional(),
      }),
    },
    guarded(async (args) =>
      client.execute({
        request_id: args.request_id as string,
        site_id: args.site_id as string,
        endpoint: args.endpoint as string,
        input: args.input as never,
        ...(args.site === undefined
          ? {}
          : { site: args.site as SiteRegistration }),
      }),
    ),
  );

  server.registerTool(
    "get_operation",
    {
      description:
        "Read current durable adapter status. Adapter state is separate from the eventual target API response.",
      inputSchema: z.object({ operation_id: z.string().min(1).max(256) }),
    },
    guarded(async ({ operation_id }) =>
      client.getOperation(operation_id as string),
    ),
  );

  server.registerTool(
    "wait_operation",
    {
      description:
        "Wait a bounded time for durable operation events after a revision. Returns current status even on timeout; reconnect with cursor.",
      inputSchema: z.object({
        operation_id: z.string().min(1).max(256),
        after: z.number().int().nonnegative().default(0),
        timeout_ms: z.number().int().min(0).max(MAX_WAIT_MS).default(30_000),
      }),
    },
    guarded(async ({ operation_id, after, timeout_ms }) =>
      client.waitOperation(
        operation_id as string,
        after as number,
        timeout_ms as number,
      ),
    ),
  );

  server.registerTool(
    "get_result",
    {
      description:
        "Retrieve the target API response or adapter failure for a durable operation.",
      inputSchema: z.object({ operation_id: z.string().min(1).max(256) }),
    },
    guarded(async ({ operation_id }) =>
      client.getResult(operation_id as string),
    ),
  );

  server.registerTool(
    "cancel_operation",
    {
      description:
        "Request cancellation. This does not claim that a submitted target-site job was undone.",
      inputSchema: z.object({ operation_id: z.string().min(1).max(256) }),
    },
    guarded(async ({ operation_id }) => client.cancel(operation_id as string)),
  );

  server.registerTool(
    "resume_operation",
    {
      description:
        "Resume an operation that needs attention. Active human ownership cannot be overridden.",
      inputSchema: z.object({
        operation_id: z.string().min(1).max(256),
        extend_ms: z.number().int().min(0).max(86_400_000).optional(),
        note: z.string().max(4_000).optional(),
      }),
    },
    guarded(async ({ operation_id, extend_ms, note }) =>
      client.resume(operation_id as string, {
        ...(extend_ms === undefined ? {} : { extend_ms: extend_ms as number }),
        ...(note === undefined ? {} : { note: note as string }),
      }),
    ),
  );

  server.registerTool(
    "claim_handoff",
    {
      description:
        "Claim a waiting human browser handoff. The returned claim_token is a secret capability and is required for access and return; only one claimant can succeed.",
      inputSchema: z.object({ operation_id: z.string().min(1).max(256) }),
    },
    guarded(async ({ operation_id }) =>
      client.claimHandoff(operation_id as string),
    ),
  );

  server.registerTool(
    "get_handoff_access",
    {
      description:
        "Get the live local or streamed browser presentation for the human who holds the handoff claim.",
      inputSchema: z.object({
        operation_id: z.string().min(1).max(256),
        claim_token: z.string().min(1).max(256),
      }),
    },
    guarded(async ({ operation_id, claim_token }) =>
      client.humanAccess(operation_id as string, claim_token as string),
    ),
  );

  server.registerTool(
    "return_handoff",
    {
      description:
        "Return an exclusively claimed browser. The submission outcome is saved before interactive access is released; retry a release failure with the same token and outcome.",
      inputSchema: z.object({
        operation_id: z.string().min(1).max(256),
        claim_token: z.string().min(1).max(256),
        note: z.string().min(1).max(4_000),
        outcome: z.enum(["no_submission", "submitted", "unknown"]),
      }),
    },
    guarded(async ({ operation_id, claim_token, note, outcome }) =>
      client.returnHandoff(
        operation_id as string,
        claim_token as string,
        note as string,
        outcome as "no_submission" | "submitted" | "unknown",
      ),
    ),
  );

  server.registerTool(
    "upload_artifact",
    {
      description: `Upload one base64 artifact to the existing service (maximum ${maxArtifactBytes} decoded bytes).`,
      inputSchema: z.object({
        name: z.string().min(1).max(1_024),
        media_type: z.string().min(1).max(256),
        data_base64: z.string(),
      }),
    },
    guarded(async ({ name, media_type, data_base64 }) => {
      decodeBase64(data_base64 as string, maxArtifactBytes);
      return client.putArtifactBase64(
        data_base64 as string,
        name as string,
        media_type as string,
      );
    }),
  );

  server.registerTool(
    "read_artifact",
    {
      description: `Read a bounded artifact chunk as base64 (maximum ${maxArtifactBytes} bytes per call).`,
      inputSchema: z.object({
        artifact_id: z.string().min(1).max(256),
        offset: z.number().int().nonnegative().default(0),
        max_bytes: z
          .number()
          .int()
          .positive()
          .max(maxArtifactBytes)
          .default(Math.min(maxArtifactBytes, 256 * 1024)),
      }),
    },
    guarded(async ({ artifact_id, offset, max_bytes }) => {
      const metadata = await client.getArtifactMetadata(artifact_id as string);
      const start = offset as number;
      const length = max_bytes as number;
      if (start > metadata.bytes) {
        throw new AppError(
          "invalid_range",
          "offset is beyond the end of the artifact",
          416,
        );
      }
      if (start === metadata.bytes) {
        return {
          metadata,
          offset: start,
          data_base64: "",
          next_offset: start,
          eof: true,
        };
      }
      const end = Math.min(metadata.bytes - 1, start + length - 1);
      const chunk = await client.getArtifactBytes(artifact_id as string, {
        start,
        end,
      });
      const nextOffset = start + chunk.data.byteLength;
      return {
        metadata,
        offset: start,
        data_base64: Buffer.from(chunk.data).toString("base64"),
        next_offset: nextOffset,
        eof: nextOffset >= metadata.bytes,
      };
    }),
  );

  return server;
}

export function createMcpBridge(options: McpBridgeOptions): McpServer {
  return createMcpServer(
    new BrowserApiHttpClient(options.serviceUrl, options.serviceToken),
    options.maxArtifactBytes,
  );
}

function applicationClient(app: Application): McpServiceClient {
  return {
    listSites: async (): Promise<{ sites: Site[] }> => ({
      sites: app.listSites(),
    }),
    registerSite: async (registration: SiteRegistration): Promise<Site> =>
      app.registerSite(registration),
    listEndpoints: async (
      siteId: string,
    ): Promise<{ endpoints: Endpoint[] }> => ({
      endpoints: app.listEndpoints(siteId),
    }),
    getSpec: async (
      siteId: string,
    ): Promise<{
      site_id: string;
      contract_hash: string;
      spec: JsonObject;
    }> => {
      const site = app
        .listSites()
        .find((candidate) => candidate.site_id === siteId);
      if (site === undefined)
        throw new AppError("site_not_found", `Unknown site: ${siteId}`, 404);
      return {
        site_id: site.site_id,
        contract_hash: site.contract_hash,
        spec: site.spec,
      };
    },
    execute: async (request): Promise<Operation> => app.execute(request),
    getOperation: async (id: string): Promise<Operation> =>
      app.getOperation(id),
    waitOperation: async (
      id: string,
      after?: number,
      timeoutMs?: number,
      signal?: AbortSignal,
    ): Promise<OperationUpdate> =>
      app.waitOperation(id, after, timeoutMs, signal),
    getResult: async (id: string) => app.getResult(id),
    cancel: async (id: string): Promise<Operation> => app.cancelOperation(id),
    resume: async (
      id: string,
      options?: { extend_ms?: number; note?: string },
    ): Promise<Operation> => app.resumeOperation(id, options),
    claimHandoff: async (id: string) => app.claimHandoff(id),
    humanAccess: async (id: string, claimToken: string) =>
      app.humanAccess(id, claimToken),
    returnHandoff: async (
      id: string,
      claimToken: string,
      note: string,
      outcome: "no_submission" | "submitted" | "unknown",
    ): Promise<Operation> => app.returnHandoff(id, claimToken, note, outcome),
    putArtifactBase64: async (
      dataBase64: string,
      name: string,
      mediaType: string,
    ): Promise<Artifact> => {
      const bytes = decodeBase64(dataBase64, app.config.maxArtifactBytes);
      return app.putArtifact(bytes, name, mediaType);
    },
    getArtifactMetadata: async (id: string): Promise<Artifact> =>
      app.getArtifact(id).metadata,
    getArtifactBytes: async (
      id: string,
      range?: { start: number; end: number },
    ): Promise<{ data: Uint8Array; contentRange?: string }> => {
      const artifact = app.getArtifact(id);
      if (range === undefined) return { data: artifact.data };
      if (
        range.start < 0 ||
        range.end < range.start ||
        range.start >= artifact.data.byteLength
      ) {
        throw new AppError(
          "invalid_range",
          "Requested artifact byte range is not satisfiable",
          416,
        );
      }
      const end = Math.min(range.end, artifact.data.byteLength - 1);
      return {
        data: artifact.data.subarray(range.start, end + 1),
        contentRange: `bytes ${range.start}-${end}/${artifact.data.byteLength}`,
      };
    },
  };
}

export function createApplicationMcpServer(app: Application): McpServer {
  return createMcpServer(
    applicationClient(app),
    Math.min(app.config.maxArtifactBytes, DEFAULT_MAX_MCP_ARTIFACT_BYTES),
  );
}

/** Handle one authenticated stateless Streamable HTTP MCP request against the shared Application. */
export async function handleMcpHttpRequest(
  app: Application,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const server = createApplicationMcpServer(app);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  reply.hijack();

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    void transport.close().finally(() => server.close());
  };
  reply.raw.once("finish", close);
  reply.raw.once("close", close);
  try {
    await transport.handleRequest(request.raw, reply.raw, request.body);
  } catch {
    if (!reply.raw.headersSent) {
      reply.raw.writeHead(500, {
        "content-type": "application/json; charset=utf-8",
      });
      reply.raw.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32603, message: "Internal MCP bridge error" },
        }),
      );
    } else if (!reply.raw.destroyed) {
      reply.raw.destroy();
    }
    close();
  }
}

export async function runStdioMcpBridge(
  options?: Partial<McpBridgeOptions>,
): Promise<void> {
  const serviceUrl =
    options?.serviceUrl ??
    process.env.BROWSER_API_SERVICE_URL ??
    DEFAULT_SERVICE_URL;
  const serviceToken =
    options?.serviceToken ?? process.env.BROWSER_API_SERVICE_TOKEN;
  if (serviceToken === undefined || serviceToken === "") {
    throw new Error("BROWSER_API_SERVICE_TOKEN is required for the MCP bridge");
  }
  const configuredLimit = process.env.BROWSER_API_MCP_MAX_ARTIFACT_BYTES;
  const parsedLimit =
    configuredLimit === undefined ? undefined : Number(configuredLimit);
  if (
    parsedLimit !== undefined &&
    (!Number.isSafeInteger(parsedLimit) || parsedLimit <= 0)
  ) {
    throw new Error(
      "BROWSER_API_MCP_MAX_ARTIFACT_BYTES must be a positive integer",
    );
  }
  const server = createMcpBridge({
    serviceUrl,
    serviceToken,
    ...(options?.maxArtifactBytes !== undefined
      ? { maxArtifactBytes: options.maxArtifactBytes }
      : parsedLimit === undefined
        ? {}
        : { maxArtifactBytes: parsedLimit }),
  });
  await server.connect(new StdioServerTransport());
}

const invokedPath =
  process.argv[1] === undefined
    ? undefined
    : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  runStdioMcpBridge().catch(() => {
    process.stderr.write(
      "Unable to start browser-api MCP bridge. Check service URL and token configuration.\n",
    );
    process.exitCode = 1;
  });
}
