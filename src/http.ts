import { randomBytes, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";

import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";

import { AppError } from "./errors.js";
import {
  terminalStates,
  type Application,
  type Artifact,
  type ExecuteRequest,
  type HandoffClaim,
  type HumanReturnOutcome,
  type Json,
  type JsonObject,
  type Operation,
  type OperationUpdate,
  type ProgressEvent,
  type Site,
  type SiteRegistration,
} from "./types.js";

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const MAX_WAIT_MS = 30_000;
const MAX_NOTE_LENGTH = 4_000;
const HANDOFF_CLAIM_HEADER = "x-browser-handoff-token";
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

type JsonRecord = Record<string, unknown>;

export interface ServiceErrorBody {
  error: {
    code: string;
    message: string;
    details?: Json;
  };
}

export class ServiceClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: Json,
  ) {
    super(message);
    this.name = "ServiceClientError";
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(
  value: unknown,
  field: string,
  maxLength = 2_048,
): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.length > maxLength
  ) {
    throw new AppError(
      "invalid_request",
      `${field} must be a non-empty string`,
      400,
    );
  }
  return value;
}

function optionalString(
  value: unknown,
  field: string,
  maxLength = 2_048,
): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, field, maxLength);
}

function jsonObject(value: unknown, field: string): JsonObject {
  if (!isRecord(value))
    throw new AppError("invalid_request", `${field} must be an object`, 400);
  return value as JsonObject;
}

function parseNonNegativeInteger(
  value: unknown,
  field: string,
  fallback: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (value === undefined || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) {
    throw new AppError(
      "invalid_request",
      `${field} must be an integer from 0 to ${maximum}`,
      400,
    );
  }
  return parsed;
}

function param(request: FastifyRequest, name: string): string {
  const params = request.params as Record<string, unknown>;
  return requiredString(params[name], name, 1_024);
}

function handoffClaimToken(request: FastifyRequest): string {
  const value = request.headers[HANDOFF_CLAIM_HEADER];
  const token = Array.isArray(value) ? value[0] : value;
  if (typeof token !== "string" || token.length === 0 || token.length > 256) {
    throw new AppError(
      "invalid_handoff_claim",
      "A valid handoff claim token is required",
      403,
    );
  }
  return token;
}

function parseRegistration(value: unknown): SiteRegistration {
  if (!isRecord(value))
    throw new AppError(
      "invalid_request",
      "Request body must be an object",
      400,
    );
  let allowedOrigins: string[] | undefined;
  if (value.allowed_origins !== undefined) {
    if (
      !Array.isArray(value.allowed_origins) ||
      value.allowed_origins.some((item) => typeof item !== "string")
    ) {
      throw new AppError(
        "invalid_request",
        "allowed_origins must be an array of strings",
        400,
      );
    }
    allowedOrigins = value.allowed_origins as string[];
  }
  return {
    site_id: requiredString(value.site_id, "site_id", 256),
    account_id: requiredString(value.account_id, "account_id", 256),
    base_url: requiredString(value.base_url, "base_url", 4_096),
    ...(allowedOrigins === undefined
      ? {}
      : { allowed_origins: allowedOrigins }),
    spec: jsonObject(value.spec, "spec"),
  };
}

function parseExecuteRequest(value: unknown): ExecuteRequest {
  if (!isRecord(value))
    throw new AppError(
      "invalid_request",
      "Request body must be an object",
      400,
    );
  return {
    request_id: requiredString(value.request_id, "request_id", 256),
    site_id: requiredString(value.site_id, "site_id", 256),
    endpoint: requiredString(value.endpoint, "endpoint", 2_048),
    input: jsonObject(value.input, "input"),
    ...(value.site === undefined
      ? {}
      : { site: parseRegistration(value.site) }),
  };
}

function parseBearer(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer[ \t]+(.+)$/i.exec(header);
  return match?.[1];
}

function secretEquals(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

function configuredOrigin(app: Application): string {
  try {
    return new URL(app.config.controlBaseUrl).origin;
  } catch {
    throw new Error("controlBaseUrl must be an absolute URL");
  }
}

function requireServiceAuthentication(
  app: Application,
  request: FastifyRequest,
): void {
  const header = Array.isArray(request.headers.authorization)
    ? request.headers.authorization[0]
    : request.headers.authorization;
  if (!secretEquals(parseBearer(header), app.config.serviceToken)) {
    throw new AppError(
      "unauthorized",
      "A valid service bearer token is required",
      401,
    );
  }
}

function requireAllowedOrigin(
  app: Application,
  request: FastifyRequest,
  requireHeader: boolean,
): void {
  const header = request.headers.origin;
  const origin = Array.isArray(header) ? header[0] : header;
  if (origin === undefined && !requireHeader) return;
  if (origin === undefined || origin !== configuredOrigin(app)) {
    throw new AppError(
      "origin_not_allowed",
      "The request origin is not allowed",
      403,
    );
  }
}

function toHttpError(error: unknown): {
  status: number;
  body: ServiceErrorBody;
} {
  if (error instanceof AppError) {
    return { status: error.status, body: { error: error.toJSON() } };
  }
  if (
    isRecord(error) &&
    typeof error.statusCode === "number" &&
    error.statusCode >= 400 &&
    error.statusCode < 500
  ) {
    const status = error.statusCode;
    return {
      status,
      body: {
        error: {
          code: status === 413 ? "payload_too_large" : "invalid_request",
          message:
            status === 413
              ? "Request payload exceeds the configured limit"
              : "Request could not be parsed",
        },
      },
    };
  }
  return {
    status: 500,
    body: {
      error: { code: "internal_error", message: "Internal service error" },
    },
  };
}

export function decodeBase64(value: string, maximumBytes: number): Uint8Array {
  if (value.length === 0) return new Uint8Array();
  if (
    value.length > Math.ceil(maximumBytes / 3) * 4 + 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    throw new AppError(
      "invalid_artifact",
      "data_base64 is not valid bounded base64",
      400,
    );
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength > maximumBytes) {
    throw new AppError(
      "artifact_too_large",
      `Artifact exceeds the ${maximumBytes}-byte limit`,
      413,
    );
  }
  return decoded;
}

function safeHeaderFilename(value: string): string {
  const sanitized = value
    .replace(/[\r\n"]/g, "_")
    .replace(/[^\x20-\x7E]/g, "_");
  return sanitized || "artifact.bin";
}

function parseRange(
  header: string | undefined,
  total: number,
): { start: number; end: number } | undefined {
  if (header === undefined) return undefined;
  const match = /^bytes=(\d+)-(\d*)$/.exec(header.trim());
  if (match === null)
    throw new AppError(
      "invalid_range",
      "Only one explicit byte range is supported",
      416,
    );
  const start = Number(match[1]);
  const end = match[2] === "" ? total - 1 : Number(match[2]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= total ||
    end < start
  ) {
    throw new AppError(
      "invalid_range",
      "Requested artifact byte range is not satisfiable",
      416,
    );
  }
  return { start, end: Math.min(end, total - 1) };
}

function writeSseEvent(reply: FastifyReply, event: ProgressEvent): void {
  reply.raw.write(`id: ${event.sequence}\n`);
  reply.raw.write("event: progress\n");
  reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
}

function controlPageHtml(nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Browser handoff</title>
  <style nonce="${nonce}">
    body { font: 16px system-ui, sans-serif; max-width: 760px; margin: 2rem auto; padding: 0 1rem; color: #16202a; }
    fieldset, section { margin: 1rem 0; padding: 1rem; border: 1px solid #ccd4dc; border-radius: .5rem; }
    label { display: block; margin: .6rem 0; }
    input[type=password], textarea { box-sizing: border-box; width: 100%; padding: .6rem; }
    button { margin: .4rem .4rem .4rem 0; padding: .65rem 1rem; }
    iframe { width: 100%; height: 560px; border: 1px solid #7b8794; }
    .hidden { display: none; }
    #status { white-space: pre-wrap; }
  </style>
</head>
<body>
  <h1>Browser handoff</h1>
  <p id="status">Enter the browser-agent service token to continue.</p>
  <form id="login">
    <label>Service token <input id="token" type="password" required autocomplete="off"></label>
    <button type="submit">Unlock handoff</button>
  </form>
  <section id="controls" class="hidden">
    <p id="instructions"></p>
    <button id="claim" type="button">Take browser control</button>
    <a id="open-browser" class="hidden" target="_blank" rel="noreferrer">Open browser</a>
    <iframe id="browser" class="hidden" title="Controlled browser" sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock allow-popups" allow="clipboard-read; clipboard-write"></iframe>
    <form id="return-form" class="hidden">
      <fieldset>
        <legend>Did you submit the requested job or change while you had control?</legend>
        <label><input type="radio" name="outcome" value="no_submission" required> No, I did not submit it</label>
        <label><input type="radio" name="outcome" value="submitted"> Yes, I submitted it</label>
        <label><input type="radio" name="outcome" value="unknown"> I am not sure</label>
      </fieldset>
      <label>What did you do? <textarea id="note" maxlength="${MAX_NOTE_LENGTH}" required></textarea></label>
      <button type="submit">Return control</button>
    </form>
    <button id="lock" type="button">Lock service access on this tab</button>
  </section>
  <script nonce="${nonce}">
    (() => {
      'use strict';
      const operationId = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '');
      const tokenKey = 'browser-api-service-token';
      const claimTokenKey = 'browser-api-handoff-claim:' + operationId;
      const login = document.getElementById('login');
      const tokenInput = document.getElementById('token');
      const controls = document.getElementById('controls');
      const status = document.getElementById('status');
      const instructions = document.getElementById('instructions');
      const claim = document.getElementById('claim');
      const returnForm = document.getElementById('return-form');
      const browser = document.getElementById('browser');
      const openBrowser = document.getElementById('open-browser');

      function setStatus(message) { status.textContent = message; }
      function token() { return sessionStorage.getItem(tokenKey) || ''; }
      function claimToken() { return sessionStorage.getItem(claimTokenKey) || ''; }
      async function api(suffix, options = {}) {
        const handoffToken = claimToken();
        const response = await fetch('/v1/handoffs/' + encodeURIComponent(operationId) + suffix, {
          ...options,
          headers: {
            'authorization': 'Bearer ' + token(),
            'content-type': 'application/json',
            ...(handoffToken ? { 'x-browser-handoff-token': handoffToken } : {}),
            ...(options.headers || {})
          },
          credentials: 'same-origin'
        });
        const value = await response.json().catch(() => ({ error: { message: 'Unexpected service response' } }));
        if (!response.ok) throw new Error(value.error?.message || 'Handoff request failed');
        return value;
      }
      function unlocked() {
        login.classList.add('hidden');
        controls.classList.remove('hidden');
        if (claimToken()) {
          claim.textContent = 'Resume browser control';
          setStatus('This tab holds the browser handoff claim.');
        } else {
          claim.textContent = 'Take browser control';
          setStatus('Ready to claim the paused browser.');
        }
      }
      login.addEventListener('submit', (event) => {
        event.preventDefault();
        sessionStorage.setItem(tokenKey, tokenInput.value);
        tokenInput.value = '';
        unlocked();
      });
      claim.addEventListener('click', async () => {
        claim.disabled = true;
        try {
          let operation;
          if (!claimToken()) {
            const claimed = await api('/claim', { method: 'POST', body: '{}' });
            sessionStorage.setItem(claimTokenKey, claimed.claim_token);
            operation = claimed.operation;
          }
          instructions.textContent = operation?.human_action?.instructions || 'Complete the requested browser step.';
          const access = await api('/access');
          if (access.presentation === 'streamed_browser' && access.url) {
            const target = new URL(access.url);
            if (target.protocol !== 'https:' && target.protocol !== 'http:') throw new Error('Unsupported browser stream URL');
            browser.src = target.href;
            browser.classList.remove('hidden');
          } else if (access.url) {
            const target = new URL(access.url);
            if (target.protocol !== 'https:' && target.protocol !== 'http:') throw new Error('Unsupported browser URL');
            openBrowser.href = target.href;
            openBrowser.classList.remove('hidden');
          }
          returnForm.classList.remove('hidden');
          setStatus('You have exclusive browser control. Return it when finished.');
        } catch (error) {
          claim.disabled = false;
          setStatus(error instanceof Error ? error.message : 'Unable to claim browser');
        }
      });
      returnForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const selected = new FormData(returnForm).get('outcome');
        const note = document.getElementById('note').value;
        try {
          await api('/return', { method: 'POST', body: JSON.stringify({ note, outcome: selected }) });
          sessionStorage.removeItem(claimTokenKey);
          browser.src = 'about:blank';
          browser.classList.add('hidden');
          openBrowser.classList.add('hidden');
          returnForm.classList.add('hidden');
          setStatus('Control returned. The agent is reconciling the browser state.');
        } catch (error) {
          setStatus(error instanceof Error ? error.message : 'Unable to return browser control');
        }
      });
      document.getElementById('lock').addEventListener('click', () => {
        sessionStorage.removeItem(tokenKey);
        location.reload();
      });
      if (token()) unlocked();
    })();
  </script>
</body>
</html>`;
}

export async function createHttpServer(
  app: Application,
): Promise<FastifyInstance> {
  if (app.config.serviceToken === "")
    throw new Error("serviceToken must not be empty");
  configuredOrigin(app);

  const bodyLimit = Math.max(
    1_048_576,
    Math.ceil((app.config.maxArtifactBytes * 4) / 3) + 16_384,
  );
  const server = Fastify({ logger: false, bodyLimit });
  const activeEventStreams = new Set<AbortController>();

  server.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer" },
    (_request, body, done) => {
      done(null, body);
    },
  );

  server.addHook("onRequest", async (request) => {
    if (!request.url.startsWith("/v1/")) return;
    requireServiceAuthentication(app, request);
    if (MUTATING_METHODS.has(request.method)) {
      requireAllowedOrigin(
        app,
        request,
        request.url.startsWith("/v1/handoffs/"),
      );
    }
  });

  server.setErrorHandler((error, _request, reply) => {
    const mapped = toHttpError(error);
    void reply.code(mapped.status).type(JSON_CONTENT_TYPE).send(mapped.body);
  });
  server.setNotFoundHandler((_request, reply) => {
    void reply
      .code(404)
      .type(JSON_CONTENT_TYPE)
      .send({
        error: { code: "route_not_found", message: "Unknown service route" },
      });
  });
  server.addHook("preClose", async () => {
    for (const controller of activeEventStreams) controller.abort();
    activeEventStreams.clear();
  });

  server.get("/health", async () => ({ ok: true }));

  server.route({
    method: ["GET", "POST", "DELETE"],
    url: "/mcp",
    handler: async (request, reply) => {
      requireServiceAuthentication(app, request);
      if (MUTATING_METHODS.has(request.method))
        requireAllowedOrigin(app, request, false);
      const { handleMcpHttpRequest } = await import("./mcp.js");
      await handleMcpHttpRequest(app, request, reply);
    },
  });

  server.get("/handoffs/:id", async (_request, reply) => {
    const nonce = randomBytes(18).toString("base64");
    return reply
      .header("Cache-Control", "no-store")
      .header(
        "Content-Security-Policy",
        `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-src https: http:; frame-ancestors 'none'; form-action 'self'; base-uri 'none'`,
      )
      .header("Referrer-Policy", "no-referrer")
      .header("X-Content-Type-Options", "nosniff")
      .header("X-Frame-Options", "DENY")
      .type("text/html; charset=utf-8")
      .send(controlPageHtml(nonce));
  });

  server.get("/v1/sites", async () => ({ sites: app.listSites() }));

  server.post("/v1/sites", async (request, reply) => {
    const site = app.registerSite(parseRegistration(request.body));
    return reply.code(201).send(site);
  });

  server.get("/v1/sites/:siteId", async (request) => {
    const siteId = param(request, "siteId");
    const site = app
      .listSites()
      .find((candidate) => candidate.site_id === siteId);
    if (site === undefined)
      throw new AppError("site_not_found", `Unknown site: ${siteId}`, 404);
    return site;
  });

  server.get("/v1/sites/:siteId/spec", async (request) => {
    const siteId = param(request, "siteId");
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
  });

  server.get("/v1/sites/:siteId/endpoints", async (request) => ({
    endpoints: app.listEndpoints(param(request, "siteId")),
  }));

  server.post("/v1/operations", async (request, reply) => {
    const operation = await app.execute(parseExecuteRequest(request.body));
    return reply.code(202).send(operation);
  });

  server.get("/v1/operations/:id", async (request) =>
    app.getOperation(param(request, "id")),
  );

  server.get("/v1/operations/:id/result", async (request) =>
    app.getResult(param(request, "id")),
  );

  server.get("/v1/operations/:id/wait", async (request, reply) => {
    const query = request.query as JsonRecord;
    const after = parseNonNegativeInteger(query.after, "after", 0);
    const timeoutMs = parseNonNegativeInteger(
      query.timeout_ms,
      "timeout_ms",
      0,
      MAX_WAIT_MS,
    );
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.raw.once("aborted", abort);
    reply.raw.once("close", abort);
    try {
      return await app.waitOperation(
        param(request, "id"),
        after,
        timeoutMs,
        controller.signal,
      );
    } finally {
      request.raw.removeListener("aborted", abort);
      reply.raw.removeListener("close", abort);
    }
  });

  server.get("/v1/operations/:id/events", async (request, reply) => {
    const operationId = param(request, "id");
    app.getOperation(operationId);
    const query = request.query as JsonRecord;
    const headerCursor = Array.isArray(request.headers["last-event-id"])
      ? request.headers["last-event-id"][0]
      : request.headers["last-event-id"];
    let cursor = parseNonNegativeInteger(
      query.after ?? headerCursor,
      "after",
      0,
    );
    const watch = query.watch === "1" || query.watch === "true";
    const controller = new AbortController();
    activeEventStreams.add(controller);
    const abort = () => controller.abort();
    request.raw.once("aborted", abort);
    reply.raw.once("close", abort);

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write("retry: 1000\n\n");

    try {
      while (!controller.signal.aborted) {
        const update = await app.waitOperation(
          operationId,
          cursor,
          watch ? Math.min(Math.max(app.config.heartbeatMs, 1_000), 30_000) : 0,
          controller.signal,
        );
        for (const event of update.events) writeSseEvent(reply, event);
        cursor = Math.max(cursor, update.cursor);
        if (terminalStates.has(update.operation.state) && !update.has_more)
          break;
        if (!watch) break;
        if (update.events.length === 0) reply.raw.write(": heartbeat\n\n");
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const mapped = toHttpError(error);
        reply.raw.write("event: service_error\n");
        reply.raw.write(`data: ${JSON.stringify(mapped.body)}\n\n`);
      }
    } finally {
      activeEventStreams.delete(controller);
      request.raw.removeListener("aborted", abort);
      reply.raw.removeListener("close", abort);
      if (!reply.raw.destroyed) reply.raw.end();
    }
  });

  server.post("/v1/operations/:id/cancel", async (request) =>
    app.cancelOperation(param(request, "id")),
  );

  server.post("/v1/operations/:id/resume", async (request) => {
    const body = request.body === undefined ? {} : request.body;
    if (!isRecord(body))
      throw new AppError(
        "invalid_request",
        "Request body must be an object",
        400,
      );
    const extendMs =
      body.extend_ms === undefined
        ? undefined
        : parseNonNegativeInteger(body.extend_ms, "extend_ms", 0, 86_400_000);
    const note = optionalString(body.note, "note", MAX_NOTE_LENGTH);
    return app.resumeOperation(param(request, "id"), {
      ...(extendMs === undefined ? {} : { extend_ms: extendMs }),
      ...(note === undefined ? {} : { note }),
    });
  });

  server.post("/v1/handoffs/:id/claim", async (request, reply) => {
    const claim = await app.claimHandoff(param(request, "id"));
    return reply.header("Cache-Control", "no-store").send(claim);
  });

  server.get("/v1/handoffs/:id/access", async (request, reply) => {
    const access = await app.humanAccess(
      param(request, "id"),
      handoffClaimToken(request),
    );
    if (access.url !== undefined) {
      let parsed: URL;
      try {
        parsed = new URL(access.url);
      } catch {
        throw new AppError(
          "invalid_human_access",
          "Browser access URL is invalid",
          500,
        );
      }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new AppError(
          "invalid_human_access",
          "Browser access URL uses an unsupported protocol",
          500,
        );
      }
    }
    return reply.header("Cache-Control", "no-store").send(access);
  });

  server.post("/v1/handoffs/:id/return", async (request) => {
    if (!isRecord(request.body))
      throw new AppError(
        "invalid_request",
        "Request body must be an object",
        400,
      );
    const note = requiredString(request.body.note, "note", MAX_NOTE_LENGTH);
    const outcome = request.body.outcome;
    if (
      outcome !== "no_submission" &&
      outcome !== "submitted" &&
      outcome !== "unknown"
    ) {
      throw new AppError(
        "invalid_request",
        "outcome must be no_submission, submitted, or unknown",
        400,
      );
    }
    return app.returnHandoff(
      param(request, "id"),
      handoffClaimToken(request),
      note,
      outcome,
    );
  });

  server.post("/v1/artifacts", async (request, reply) => {
    let data: Uint8Array;
    let name: string;
    let mediaType: string;
    if (Buffer.isBuffer(request.body)) {
      data = request.body;
      const encodedName = Array.isArray(request.headers["x-artifact-name"])
        ? request.headers["x-artifact-name"][0]
        : request.headers["x-artifact-name"];
      if (encodedName === undefined)
        throw new AppError(
          "invalid_request",
          "x-artifact-name is required",
          400,
        );
      try {
        name = requiredString(
          decodeURIComponent(encodedName),
          "x-artifact-name",
          1_024,
        );
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError(
          "invalid_request",
          "x-artifact-name is invalid",
          400,
        );
      }
      mediaType =
        requiredString(
          request.headers["content-type"],
          "content-type",
          256,
        ).split(";", 1)[0] ?? "application/octet-stream";
    } else {
      if (!isRecord(request.body))
        throw new AppError(
          "invalid_request",
          "Request body must be an object",
          400,
        );
      name = requiredString(request.body.name, "name", 1_024);
      mediaType = requiredString(request.body.media_type, "media_type", 256);
      data = decodeBase64(
        requiredString(request.body.data_base64, "data_base64", bodyLimit),
        app.config.maxArtifactBytes,
      );
    }
    if (data.byteLength > app.config.maxArtifactBytes) {
      throw new AppError(
        "artifact_too_large",
        `Artifact exceeds the ${app.config.maxArtifactBytes}-byte limit`,
        413,
      );
    }
    return reply.code(201).send(app.putArtifact(data, name, mediaType));
  });

  server.get(
    "/v1/artifacts/:id/metadata",
    async (request) => app.getArtifact(param(request, "id")).metadata,
  );

  server.get("/v1/artifacts/:id", async (request, reply) => {
    const artifact = app.getArtifact(param(request, "id"));
    const rangeHeader = Array.isArray(request.headers.range)
      ? request.headers.range[0]
      : request.headers.range;
    const range = parseRange(rangeHeader, artifact.data.byteLength);
    const data =
      range === undefined
        ? artifact.data
        : artifact.data.subarray(range.start, range.end + 1);
    if (range !== undefined) {
      reply
        .code(206)
        .header(
          "Content-Range",
          `bytes ${range.start}-${range.end}/${artifact.data.byteLength}`,
        );
    }
    return reply
      .header("Accept-Ranges", "bytes")
      .header("Content-Length", String(data.byteLength))
      .header("Content-Type", artifact.metadata.media_type)
      .header(
        "Content-Disposition",
        `attachment; filename="${safeHeaderFilename(artifact.metadata.name)}"`,
      )
      .header("X-Artifact-Id", artifact.metadata.artifact_id)
      .header("X-Artifact-Name", encodeURIComponent(artifact.metadata.name))
      .header("X-Artifact-Sha256", artifact.metadata.sha256)
      .send(Buffer.from(data));
  });

  return server;
}

async function readResponseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === "") return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ServiceClientError(
      "invalid_service_response",
      "Service returned invalid JSON",
      response.status,
    );
  }
}

function serviceError(response: Response, value: unknown): ServiceClientError {
  if (isRecord(value) && isRecord(value.error)) {
    const code =
      typeof value.error.code === "string" ? value.error.code : "service_error";
    const message =
      typeof value.error.message === "string"
        ? value.error.message
        : `Service request failed (${response.status})`;
    return new ServiceClientError(
      code,
      message,
      response.status,
      value.error.details as Json | undefined,
    );
  }
  return new ServiceClientError(
    "service_error",
    `Service request failed (${response.status})`,
    response.status,
  );
}

export class BrowserApiHttpClient {
  readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly serviceToken: string,
  ) {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Service URL must use http or https");
    }
    this.baseUrl = parsed.href.replace(/\/$/, "");
    if (serviceToken === "") throw new Error("Service token must not be empty");
  }

  private headers(extra?: HeadersInit): Headers {
    const headers = new Headers(extra);
    headers.set("authorization", `Bearer ${this.serviceToken}`);
    return headers;
  }

  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: this.headers(init.headers),
    });
    const value = await readResponseJson(response);
    if (!response.ok) throw serviceError(response, value);
    return value as T;
  }

  listSites(): Promise<{ sites: Site[] }> {
    return this.json("/v1/sites");
  }

  registerSite(registration: SiteRegistration): Promise<Site> {
    return this.json("/v1/sites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(registration),
    });
  }

  listEndpoints(siteId: string): Promise<{ endpoints: unknown[] }> {
    return this.json(`/v1/sites/${encodeURIComponent(siteId)}/endpoints`);
  }

  getSpec(
    siteId: string,
  ): Promise<{ site_id: string; contract_hash: string; spec: JsonObject }> {
    return this.json(`/v1/sites/${encodeURIComponent(siteId)}/spec`);
  }

  execute(request: ExecuteRequest): Promise<Operation> {
    return this.json("/v1/operations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
  }

  getOperation(id: string): Promise<Operation> {
    return this.json(`/v1/operations/${encodeURIComponent(id)}`);
  }

  waitOperation(
    id: string,
    after = 0,
    timeoutMs = 0,
    signal?: AbortSignal,
  ): Promise<OperationUpdate> {
    const query = new URLSearchParams({
      after: String(after),
      timeout_ms: String(timeoutMs),
    });
    return this.json(
      `/v1/operations/${encodeURIComponent(id)}/wait?${query.toString()}`,
      { signal },
    );
  }

  getResult(id: string): Promise<ReturnType<Application["getResult"]>> {
    return this.json(`/v1/operations/${encodeURIComponent(id)}/result`);
  }

  cancel(id: string): Promise<Operation> {
    return this.json(`/v1/operations/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  }

  resume(
    id: string,
    options: { extend_ms?: number; note?: string } = {},
  ): Promise<Operation> {
    return this.json(`/v1/operations/${encodeURIComponent(id)}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(options),
    });
  }

  claimHandoff(id: string): Promise<HandoffClaim> {
    return this.json(`/v1/handoffs/${encodeURIComponent(id)}/claim`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: new URL(this.baseUrl).origin,
      },
      body: "{}",
    });
  }

  humanAccess(
    id: string,
    claimToken: string,
  ): Promise<{
    presentation: "local_window" | "streamed_browser";
    url?: string;
  }> {
    return this.json(`/v1/handoffs/${encodeURIComponent(id)}/access`, {
      headers: { [HANDOFF_CLAIM_HEADER]: claimToken },
    });
  }

  returnHandoff(
    id: string,
    claimToken: string,
    note: string,
    outcome: HumanReturnOutcome,
  ): Promise<Operation> {
    return this.json(`/v1/handoffs/${encodeURIComponent(id)}/return`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [HANDOFF_CLAIM_HEADER]: claimToken,
        origin: new URL(this.baseUrl).origin,
      },
      body: JSON.stringify({ note, outcome }),
    });
  }

  putArtifactBase64(
    dataBase64: string,
    name: string,
    mediaType: string,
  ): Promise<Artifact> {
    return this.json("/v1/artifacts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        data_base64: dataBase64,
        name,
        media_type: mediaType,
      }),
    });
  }

  async putArtifactBytes(
    data: Uint8Array,
    name: string,
    mediaType: string,
  ): Promise<Artifact> {
    const response = await fetch(`${this.baseUrl}/v1/artifacts`, {
      method: "POST",
      headers: this.headers({
        "content-type": mediaType,
        "x-artifact-name": encodeURIComponent(name),
      }),
      body: Buffer.from(data),
    });
    const value = await readResponseJson(response);
    if (!response.ok) throw serviceError(response, value);
    return value as Artifact;
  }

  getArtifactMetadata(id: string): Promise<Artifact> {
    return this.json(`/v1/artifacts/${encodeURIComponent(id)}/metadata`);
  }

  async getArtifactBytes(
    id: string,
    range?: { start: number; end: number },
  ): Promise<{ data: Uint8Array; contentRange?: string }> {
    const response = await fetch(
      `${this.baseUrl}/v1/artifacts/${encodeURIComponent(id)}`,
      {
        headers: this.headers(
          range === undefined
            ? undefined
            : { range: `bytes=${range.start}-${range.end}` },
        ),
      },
    );
    if (!response.ok) {
      const value = await readResponseJson(response);
      throw serviceError(response, value);
    }
    const contentRange = response.headers.get("content-range") ?? undefined;
    return {
      data: new Uint8Array(await response.arrayBuffer()),
      ...(contentRange === undefined ? {} : { contentRange }),
    };
  }

  async *events(
    id: string,
    after = 0,
    watch = true,
    signal?: AbortSignal,
  ): AsyncGenerator<ProgressEvent> {
    const query = new URLSearchParams({
      after: String(after),
      watch: watch ? "1" : "0",
    });
    const response = await fetch(
      `${this.baseUrl}/v1/operations/${encodeURIComponent(id)}/events?${query.toString()}`,
      {
        headers: this.headers({ accept: "text/event-stream" }),
        signal,
      },
    );
    if (!response.ok) {
      const value = await readResponseJson(response);
      throw serviceError(response, value);
    }
    if (response.body === null)
      throw new ServiceClientError(
        "invalid_service_response",
        "Event stream has no body",
        502,
      );
    const reader = Readable.fromWeb(response.body as never);
    let buffer = "";
    for await (const chunk of reader) {
      buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
        const lines = frame.split("\n");
        const eventName = lines
          .find((line) => line.startsWith("event:"))
          ?.slice(6)
          .trim();
        const data = lines
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (eventName === "service_error" && data !== "") {
          const parsed = JSON.parse(data) as unknown;
          throw serviceError(new Response(null, { status: 500 }), parsed);
        }
        if (eventName === "progress" && data !== "")
          yield JSON.parse(data) as ProgressEvent;
      }
    }
  }
}
