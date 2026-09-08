import { EventEmitter } from "node:events";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { performance } from "node:perf_hooks";
import { Store, digest } from "./store.js";
import { AppError, asError } from "./errors.js";
import {
  compileContract,
  contractHash,
  validateInput,
  validateResponse,
} from "./contracts.js";
import { bindStep, mapResponse, matchesCoverage } from "./recipes.js";
import { deriveCoverage, matchesArtifactConstraints } from "./coverage.js";
import { createBrowserProvider } from "./browser.js";
import { createDiscoveryAgent } from "./discovery.js";
import { terminalStates } from "./types.js";
import type {
  Application,
  AppConfig,
  Artifact,
  BrowserProvider,
  BrowserSession,
  DiscoveryAgent,
  Endpoint,
  ExecuteRequest,
  HandoffClaim,
  HumanReturnOutcome,
  Json,
  JsonObject,
  Operation,
  OperationUpdate,
  Recipe,
  RecipeStep,
  ResponseMapping,
  Site,
  SiteRegistration,
} from "./types.js";

export interface Dependencies {
  browser?: BrowserProvider;
  agent?: DiscoveryAgent;
  store?: Store;
}
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const HANDOFF_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const WRITING_ACTIONS = new Set(["click", "fill", "select", "check", "upload"]);

function handoffTokenHash(token: string): string {
  if (!HANDOFF_TOKEN.test(token))
    throw new AppError(
      "invalid_handoff_claim",
      "A valid handoff claim token is required",
      403,
    );
  return createHash("sha256").update(token).digest("hex");
}

export class BrowserApiService implements Application {
  readonly store: Store;
  private readonly browser: BrowserProvider;
  private readonly agent: DiscoveryAgent;
  private readonly notifications = new EventEmitter();
  private readonly queue: string[] = [];
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly cancelRequested = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly endpointCache = new Map<string, Endpoint[]>();
  private active?: string;
  private closing = false;
  private readonly heartbeat: ReturnType<typeof setInterval>;

  constructor(
    readonly config: AppConfig,
    dependencies: Dependencies = {},
  ) {
    this.browser = dependencies.browser ?? createBrowserProvider(config);
    this.agent = dependencies.agent ?? createDiscoveryAgent(config);
    this.store =
      dependencies.store ?? new Store(config.dataDir, config.maxArtifactBytes);
    this.notifications.setMaxListeners(0);
    // A new worker never inherits permission to replay an in-flight submission.
    for (const operation of this.store.operations()) {
      if (terminalStates.has(operation.state)) continue;
      if (operation.human_action?.claimed)
        this.change(
          operation.operation_id,
          (op) => {
            op.submission =
              op.submission === "observed" ? "observed" : "intent";
            if (!op.notes.includes("human_may_have_submitted"))
              op.notes.push("human_may_have_submitted");
          },
          "human_control_interrupted",
          "Human control ended without confirmed browser continuity; inspect for a possible submission",
        );
      if (operation.human_action?.claimed)
        this.store.clearHandoffClaim(operation.operation_id);
      if (operation.pending_ui_action)
        this.change(
          operation.operation_id,
          (op) => {
            op.submission = "intent";
          },
          "action_interrupted",
          "An interactive UI action was interrupted; its effects require reconciliation",
        );
      if (
        operation.state === "queued" &&
        operation.submission === "none" &&
        !operation.pending_ui_action
      )
        this.queue.push(operation.operation_id);
      else
        this.change(
          operation.operation_id,
          (op) => {
            op.state =
              op.submission === "none" ? "needs_attention" : "reconciling";
            op.human_action = undefined;
            op.recipe_id = undefined;
            op.error = {
              code: "service_restarted",
              message:
                "Live browser continuity was lost. Resume to inspect current state before continuing.",
            };
          },
          "recovery_required",
          "Service restarted; saved knowledge and receipts retained, live page must be inspected",
        );
    }
    this.heartbeat = setInterval(() => {
      if (this.closing) return;
      for (const op of this.store.operations())
        if (!terminalStates.has(op.state) && op.state !== "needs_attention") {
          this.change(
            op.operation_id,
            () => {},
            "heartbeat",
            "Service is connected; this heartbeat does not indicate target-job progress",
          );
        }
    }, config.heartbeatMs);
    this.heartbeat.unref();
    queueMicrotask(() => this.pump());
  }
  private change(
    id: string,
    fn: (operation: Operation) => void,
    type: string,
    message: string,
    details?: Json,
  ): Operation {
    const redact = (text: string): string => {
      for (const value of [
        this.config.serviceToken,
        this.config.openaiApiKey,
        this.config.e2bApiKey,
      ])
        if (value) text = text.split(value).join("[redacted]");
      return text;
    };
    const safeDetails =
      details === undefined
        ? undefined
        : (JSON.parse(redact(JSON.stringify(details))) as Json);
    const updated = this.store.update(
      id,
      fn,
      type,
      redact(message),
      safeDetails,
    );
    this.notifications.emit(id);
    return updated;
  }
  registerSite(registration: SiteRegistration): Site {
    if (!ID.test(registration.site_id) || !ID.test(registration.account_id))
      throw new AppError(
        "invalid_site",
        "Site and account identifiers must contain 1–128 letters, digits, dots, dashes, or underscores",
      );
    let url: URL;
    try {
      url = new URL(registration.base_url);
    } catch {
      throw new AppError(
        "invalid_site_url",
        "Site URL must be absolute HTTP(S)",
      );
    }
    this.validateSiteUrl(url);
    const origins = new Set([url.origin]);
    for (const origin of registration.allowed_origins ?? []) {
      let parsed: URL;
      try {
        parsed = new URL(origin);
      } catch {
        throw new AppError(
          "invalid_site_url",
          "Allowed origins must be absolute URLs",
        );
      }
      this.validateSiteUrl(parsed);
      if (parsed.origin !== origin)
        throw new AppError(
          "invalid_origin",
          "Allowed origins must contain only scheme, hostname, and optional port",
        );
      origins.add(origin);
    }
    const endpoints = compileContract(registration.spec);
    if (!endpoints.length)
      throw new AppError(
        "empty_contract",
        "The specification has no supported endpoint definitions",
      );
    const contract_hash = contractHash(registration.spec);
    const existing = this.store
      .sites()
      .find((s) => s.site_id === registration.site_id);
    if (existing) {
      if (
        existing.account_id !== registration.account_id ||
        existing.base_url !== url.href ||
        existing.contract_hash !== contract_hash ||
        digest(existing.allowed_origins) !== digest([...origins])
      ) {
        throw new AppError(
          "site_conflict",
          "Site registration is immutable; register a new version/site ID for changed account, URL, origins, or contract",
          409,
        );
      }
      return existing;
    }
    const site: Site = {
      ...registration,
      base_url: url.href,
      allowed_origins: [...origins],
      contract_hash,
      created_at: new Date().toISOString(),
    };
    this.store.putSite(site);
    this.endpointCache.set(site.site_id, endpoints);
    return site;
  }
  private validateSiteUrl(url: URL): void {
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new AppError(
        "invalid_site_url",
        "Site URLs must use HTTP(S) and must not embed credentials",
      );
    if (
      !this.config.allowLocalSites &&
      (url.protocol !== "https:" ||
        url.hostname === "localhost" ||
        url.hostname.endsWith(".localhost") ||
        isIP(url.hostname.replace(/^\[|\]$/g, "")))
    ) {
      throw new AppError(
        "local_site_disabled",
        "Public HTTPS hostnames are required; enable BROWSER_API_ALLOW_LOCAL_SITES only for trusted local tests",
      );
    }
  }
  listSites(): Site[] {
    return this.store.sites();
  }
  listEndpoints(siteId: string): Endpoint[] {
    let endpoints = this.endpointCache.get(siteId);
    if (!endpoints) {
      endpoints = compileContract(this.store.site(siteId).spec);
      this.endpointCache.set(siteId, endpoints);
    }
    const site = this.store.site(siteId);
    return endpoints.map((endpoint) => {
      const recipes = this.store
        .recipes(siteId, endpoint.key)
        .filter(
          (recipe) =>
            recipe.status === "observed" &&
            recipe.account_id === site.account_id &&
            recipe.contract_hash === site.contract_hash,
        );
      return {
        ...endpoint,
        runtime_coverage: {
          status: recipes.length
            ? ("observed" as const)
            : ("unexamined" as const),
          api_parity: "unverified" as const,
          scopes: recipes.map((recipe) => ({
            recipe_id: recipe.recipe_id,
            input_schema: recipe.input_schema,
            artifact_constraints: recipe.artifact_constraints ?? {},
            ...(recipe.continuation
              ? { continuation: recipe.continuation }
              : {}),
          })),
        },
      };
    });
  }
  private endpoint(siteId: string, key: string): Endpoint {
    const endpoint = this.listEndpoints(siteId).find((e) => e.key === key);
    if (!endpoint)
      throw new AppError(
        "endpoint_not_found",
        "Endpoint is not present in the registered specification",
        404,
      );
    return endpoint;
  }
  async execute(request: ExecuteRequest): Promise<Operation> {
    if (this.closing)
      throw new AppError("service_closing", "Service is shutting down", 503);
    if (!ID.test(request.request_id))
      throw new AppError(
        "invalid_request_id",
        "A stable request_id of 1–128 letters, digits, dots, dashes, or underscores is required",
      );
    if (request.site) {
      if (request.site.site_id !== request.site_id)
        throw new AppError(
          "site_mismatch",
          "Inline registration must match site_id",
        );
      this.registerSite(request.site);
    }
    const site = this.store.site(request.site_id);
    const endpoint = this.endpoint(site.site_id, request.endpoint);
    validateInput(endpoint, request.input);
    const inputHash = digest({
      endpoint: endpoint.key,
      contract: site.contract_hash,
      input: request.input,
    });
    const prior = this.store.findRequest(
      site.site_id,
      site.account_id,
      request.request_id,
    );
    if (prior) {
      if (prior.input_hash !== inputHash)
        throw new AppError(
          "request_id_conflict",
          "This request_id already belongs to different inputs or endpoint",
          409,
        );
      return prior;
    }
    const now = new Date().toISOString();
    const operation = this.store.createOperation({
      operation_id: `op_${randomUUID()}`,
      request_id: request.request_id,
      site_id: site.site_id,
      account_id: site.account_id,
      endpoint: endpoint.key,
      input: structuredClone(request.input),
      input_hash: inputHash,
      contract_hash: site.contract_hash,
      state: "queued",
      phase: "queued",
      revision: 0,
      created_at: now,
      updated_at: now,
      active_discovery_ms: 0,
      discovery_budget_ms: this.config.discoveryBudgetMs,
      submission: "none",
      step_index: 0,
      outputs: {},
      candidate_steps: [],
      artifacts: [],
      notes: [],
    });
    this.enqueue(operation.operation_id);
    return operation;
  }
  getOperation(id: string): Operation {
    return this.store.operation(id);
  }
  getResult(id: string): ReturnType<Application["getResult"]> {
    const op = this.getOperation(id);
    return {
      operation_id: id,
      state: op.state,
      api_response: op.api_response,
      error: op.error,
      artifacts: op.artifacts,
    };
  }
  async waitOperation(
    id: string,
    after = 0,
    timeoutMs = 25_000,
    signal?: AbortSignal,
  ): Promise<OperationUpdate> {
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isFinite(timeoutMs) ||
      timeoutMs < 0 ||
      timeoutMs > 30_000
    )
      throw new AppError(
        "invalid_wait",
        "Cursor must be nonnegative and wait timeout between 0 and 30000 ms",
      );
    const snapshot = (): OperationUpdate => {
      const operation = this.getOperation(id);
      if (after > operation.revision)
        throw new AppError(
          "invalid_cursor",
          "Cursor is ahead of the operation event log",
          409,
        );
      const events = this.store.events(id, after);
      const cursor = events.at(-1)?.sequence ?? after;
      return {
        operation,
        events,
        cursor,
        has_more: cursor < operation.revision,
      };
    };
    let current = snapshot();
    if (
      current.events.length ||
      timeoutMs === 0 ||
      terminalStates.has(current.operation.state) ||
      signal?.aborted
    )
      return current;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.notifications.removeListener(id, finish);
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      this.notifications.once(id, finish);
      signal?.addEventListener("abort", finish, { once: true });
      if (signal?.aborted || this.getOperation(id).revision > after) finish();
    });
    current = snapshot();
    return current;
  }
  private enqueue(id: string, priority = false): void {
    if (priority) {
      const index = this.queue.indexOf(id);
      if (index >= 0) this.queue.splice(index, 1);
      this.queue.unshift(id);
    } else if (!this.queue.includes(id)) this.queue.push(id);
    queueMicrotask(() => this.pump());
  }
  private pump(): void {
    if (this.active || this.closing) return;
    // A human handoff retains the live page; no other caller can navigate it away.
    if (this.store.operations().some((op) => op.state === "waiting_for_human"))
      return;
    // A job wait yields the worker, but never its account's page. A second
    // operation cannot replace the result while its owner is still unresolved.
    const owners = this.store
      .operations()
      .filter((op) => op.browser_lease && !terminalStates.has(op.state));
    const index = this.queue.findIndex((id) => {
      const candidate = this.getOperation(id);
      return !owners.some(
        (owner) =>
          owner.operation_id !== id &&
          owner.site_id === candidate.site_id &&
          owner.account_id === candidate.account_id,
      );
    });
    if (index < 0) return;
    const id = this.queue.splice(index, 1)[0]!;
    const operation = this.getOperation(id);
    if (
      terminalStates.has(operation.state) ||
      operation.state === "needs_attention"
    ) {
      queueMicrotask(() => this.pump());
      return;
    }
    this.active = id;
    void this.run(id)
      .catch((error) => {
        if (!this.closing) this.fail(id, error);
      })
      .finally(async () => {
        try {
          if (this.cancelRequested.has(id)) {
            if (terminalStates.has(this.getOperation(id).state))
              this.cancelRequested.delete(id);
            else await this.stopIfCancelled(id);
          }
        } finally {
          this.active = undefined;
          this.controllers.delete(id);
          queueMicrotask(() => this.pump());
        }
      });
  }
  private async session(site: Site): Promise<BrowserSession> {
    const key = `${site.site_id}:${site.account_id}`;
    let session = this.sessions.get(key);
    if (
      session &&
      session.isAlive &&
      !(await session.isAlive().catch(() => false))
    ) {
      this.sessions.delete(key);
      await session.close().catch(() => undefined);
      session = undefined;
    }
    if (!session) {
      session = await this.browser.connect(site);
      if (this.closing) {
        await session.close();
        throw new AppError(
          "service_closing",
          "Service stopped while a browser was connecting",
          503,
        );
      }
      this.sessions.set(key, session);
    }
    return session;
  }
  private reconcilePendingAction(id: string): void {
    if (this.getOperation(id).pending_ui_action)
      this.change(
        id,
        (op) => {
          op.submission = "intent";
        },
        "action_uncertain",
        "An interrupted UI action must be reconciled before further writes",
      );
  }
  private fail(id: string, error: unknown): void {
    this.reconcilePendingAction(id);
    const current = this.getOperation(id);
    if (terminalStates.has(current.state)) return;
    const parsed = asError(error);
    this.change(
      id,
      (op) => {
        op.state = op.submission !== "none" ? "reconciling" : "failed";
        op.error = parsed;
      },
      "error",
      parsed.message,
      { code: parsed.code, submission: current.submission },
    );
  }
  private async run(id: string): Promise<void> {
    let op = this.getOperation(id);
    const site = this.store.site(op.site_id);
    const endpoint = this.endpoint(site.site_id, op.endpoint);
    const session = await this.session(site);
    if (this.closing) return;
    const controller = new AbortController();
    this.controllers.set(id, controller);
    this.change(
      id,
      (draft) => {
        draft.state = draft.submission === "none" ? "running" : "reconciling";
        draft.browser_lease = true;
        draft.browser_session_id = session.id;
        draft.browser_provider = this.config.browserHost;
        draft.error = undefined;
      },
      "browser_acquired",
      "Exclusive browser ownership acquired",
      { session_id: session.id, provider: this.config.browserHost },
    );
    let recipe =
      op.submission === "none" && !op.candidate_steps.length
        ? this.store
            .recipes(site.site_id, endpoint.key)
            .find(
              (r) =>
                r.status === "observed" &&
                r.account_id === site.account_id &&
                r.contract_hash === site.contract_hash &&
                matchesCoverage(r.input_schema, op.input) &&
                matchesArtifactConstraints(
                  r.artifact_constraints ?? {},
                  op.input,
                  (id) => this.store.artifact(id).metadata,
                ),
            )
        : undefined;
    if (recipe) {
      const selectedRecipe = recipe;
      this.change(
        id,
        (draft) => {
          draft.recipe_id = selectedRecipe.recipe_id;
          draft.phase = "executing";
        },
        "recipe_selected",
        "Using an observed, schema-valid workflow for this input scope; API parity is not yet certified",
        { recipe_id: recipe.recipe_id, version: recipe.version },
      );
      for (const step of recipe.steps) {
        if (await this.stopIfCancelled(id)) return;
        try {
          await this.action(id, endpoint, session, step);
        } catch (error) {
          this.reconcilePendingAction(id);
          this.store.putRecipe({ ...recipe, status: "stale" });
          if (this.getOperation(id).submission !== "none") throw error;
          this.change(
            id,
            (draft) => {
              draft.recipe_id = undefined;
              draft.phase = "discovering";
              draft.notes.push(
                "Stored workflow failed a live assertion; inspect the current page and repair only the missing portion.",
              );
            },
            "recipe_stale",
            "Stored workflow no longer matches the UI; inspecting current state",
          );
          recipe = undefined;
          break;
        }
      }
      if (recipe && recipe.continuation !== "observe") {
        try {
          await this.finish(id, endpoint, recipe.response, false);
        } catch (error) {
          this.store.putRecipe({ ...recipe, status: "stale" });
          this.change(
            id,
            (draft) => {
              draft.state = "failed";
              draft.error = asError(error);
            },
            "response_gap",
            "Stored workflow did not yield a valid current response; the recipe is stale and its submission will not be repeated",
          );
        }
        return;
      }
      if (recipe) {
        this.change(
          id,
          (draft) => {
            draft.phase = "monitoring";
            if (!draft.notes.includes("site_job_wait"))
              draft.notes.push("site_job_wait");
          },
          "monitoring_resumed",
          "Prepared and submitted with stored steps; checking live job state before reading its result",
        );
        recipe = undefined;
      }
    }
    op = this.getOperation(id);
    if (!op.candidate_steps.length && op.submission === "none" && !recipe) {
      await this.action(id, endpoint, session, {
        action: { kind: "navigate", url: site.base_url },
        effect: "none",
        description: "Open the registered site entry point",
      });
    }
    while (!this.closing) {
      if (await this.stopIfCancelled(id)) return;
      op = this.getOperation(id);
      const remaining = op.discovery_budget_ms - op.active_discovery_ms;
      if (remaining <= 0) {
        this.budgetExhausted(id);
        return;
      }
      const started = performance.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let charged = false;
      const charge = (): void => {
        if (!charged) {
          charged = true;
          this.chargeTime(id, started);
        }
      };
      try {
        this.change(
          id,
          (draft) => {
            draft.phase = "discovering";
          },
          "discovery_observation",
          "Inspecting the current page and relevant saved knowledge",
        );
        const observation = await session.observe();
        // Keep structural facts only. Accessible names, titles, paths, and query
        // strings can contain business records or signed links and are not a map.
        const roles: Record<string, number> = {};
        for (const line of observation.content.split("\n")) {
          const role =
            /^\s*-\s+(button|link|textbox|combobox|checkbox|tab|heading|navigation|form|menuitem)\b/.exec(
              line,
            )?.[1];
          if (role) roles[role] = (roles[role] ?? 0) + 1;
        }
        const origin = new URL(observation.url).origin;
        this.store.remember(site, `${origin}/surface/${digest(roles)}`, {
          origin,
          roles,
          last_seen: new Date().toISOString(),
          usage:
            "Historical control counts only; use scoped recipes and fresh UI observations for navigation.",
        });
        const turn = new AbortController();
        const abort = (): void => turn.abort();
        controller.signal.addEventListener("abort", abort, { once: true });
        timer = setTimeout(
          () => turn.abort(new Error("Discovery allowance elapsed")),
          Math.max(1, remaining - (performance.now() - started)),
        );
        let decision;
        try {
          decision = await this.agent.next({
            site,
            endpoint,
            operation: this.getOperation(id),
            observation,
            knowledge: [
              ...this.store.knowledge(site),
              ...this.store
                .siteRecipes(site.site_id)
                .filter(
                  (r) =>
                    r.account_id === site.account_id &&
                    r.contract_hash === site.contract_hash,
                )
                .slice(0, 5)
                .map((r) => ({ recipe: r }) as unknown as Json),
            ],
            signal: turn.signal,
            report: (message) => {
              if (!this.closing)
                this.change(id, () => {}, "discovery_review", message);
            },
          });
        } finally {
          controller.signal.removeEventListener("abort", abort);
        }
        clearTimeout(timer);
        if (controller.signal.aborted || this.closing) {
          if (!this.closing) await this.stopIfCancelled(id);
          return;
        }
        if (performance.now() - started >= remaining) {
          charge();
          this.budgetExhausted(id);
          return;
        }
        if (decision.learning?.notes.length)
          this.change(
            id,
            (draft) => {
              draft.notes.push(
                ...decision
                  .learning!.notes.slice(0, 16)
                  .map((note) => note.slice(0, 1000)),
              );
              if (!draft.notes.includes("initial_review_completed"))
                draft.notes.push("initial_review_completed");
            },
            "review_saved",
            "Initial contract and UI review findings saved",
          );
        switch (decision.kind) {
          case "human":
            charge();
            await this.handoff(
              id,
              session,
              decision.reason,
              decision.instructions,
            );
            return;
          case "wait_job": {
            if (this.getOperation(id).submission === "none")
              throw new AppError(
                "invalid_job_wait",
                "A job wait requires evidence of a submitted or existing job",
              );
            charge();
            this.change(
              id,
              (draft) => {
                draft.state = "queued";
                draft.phase = "monitoring";
                if (!draft.notes.includes("site_job_wait"))
                  draft.notes.push("site_job_wait");
              },
              "job_wait",
              decision.message,
            );
            const delay = Math.min(30_000, Math.max(1000, decision.delay_ms));
            const wait = setTimeout(() => {
              this.timers.delete(wait);
              if (
                !this.closing &&
                !terminalStates.has(this.getOperation(id).state)
              )
                this.enqueue(id);
            }, delay);
            this.timers.add(wait);
            return;
          }
          case "unsupported":
            charge();
            this.change(
              id,
              (draft) => {
                draft.state = "failed";
                draft.error = { code: "unsupported", message: decision.reason };
              },
              "coverage_gap",
              decision.reason,
            );
            return;
          case "finish":
            charge();
            await this.finish(id, endpoint, decision.response, true);
            return;
          case "action":
            this.change(id, () => {}, "action_planned", decision.message);
            await this.action(id, endpoint, session, decision.step);
            charge();
            break;
        }
      } catch (error) {
        if (timer) clearTimeout(timer);
        charge();
        this.reconcilePendingAction(id);
        if (this.closing) return;
        if (await this.stopIfCancelled(id)) return;
        if (
          this.getOperation(id).active_discovery_ms >=
          this.getOperation(id).discovery_budget_ms
        ) {
          this.budgetExhausted(id);
          return;
        }
        if (session.isAlive && !(await session.isAlive().catch(() => false))) {
          this.change(
            id,
            (draft) => {
              draft.state =
                draft.submission === "none" ? "needs_attention" : "reconciling";
              draft.error = {
                code: "browser_session_lost",
                message:
                  "The browser session ended. Resume to reconnect and inspect evidence; uncertain submissions remain protected.",
              };
            },
            "browser_session_lost",
            "Browser continuity was lost; a replacement session requires live reconciliation",
          );
          return;
        }
        if (
          ["invalid_response", "ungrounded_response"].includes(
            asError(error).code,
          )
        ) {
          this.change(
            id,
            (draft) => {
              draft.state = "failed";
              draft.error = asError(error);
            },
            "response_gap",
            "The captured site result does not match the declared API response; no repeat submission will occur",
            asError(error).details,
          );
          return;
        }
        if (
          [
            "openai_credentials_missing",
            "discovery_reasoning_failed",
            "invalid_agent_decision",
            "human_handoff_unavailable",
          ].includes(asError(error).code)
        ) {
          this.change(
            id,
            (draft) => {
              draft.state = "needs_attention";
              draft.error = asError(error);
            },
            "adapter_attention",
            asError(error).message,
          );
          return;
        }
        if (this.getOperation(id).submission !== "none") {
          this.change(
            id,
            (draft) => {
              draft.state = "reconciling";
              draft.error = {
                code: "submission_uncertain",
                message:
                  "An action may have reached the site. Resume read-only reconciliation; do not resubmit.",
              };
            },
            "submission_uncertain",
            "Submission outcome needs reconciliation; further write actions are disabled",
          );
          return;
        }
        // Action failure before submission is recoverable, but bound repeated confusion.
        const failures = this.getOperation(id).notes.filter((note) =>
          note.startsWith("Action failed:"),
        ).length;
        this.change(
          id,
          (draft) => {
            draft.notes.push(`Action failed: ${asError(error).message}`);
          },
          "action_failed",
          asError(error).message,
        );
        if (failures >= 2) {
          await this.handoff(
            id,
            session,
            "workflow_unclear",
            "The workflow failed repeatedly. Demonstrate the next step, then report whether you submitted anything.",
          );
          return;
        }
      }
    }
  }
  private chargeTime(id: string, started: number): void {
    this.change(
      id,
      (op) => {
        op.active_discovery_ms += Math.ceil(performance.now() - started);
      },
      "discovery_checkpoint",
      "Discovery checkpoint saved",
    );
  }
  private budgetExhausted(id: string): void {
    this.change(
      id,
      (op) => {
        op.state = "needs_attention";
        op.error = {
          code: "discovery_budget_exhausted",
          message:
            "Active discovery allowance reached. Learning is saved; resume with an explicit extension or provide help.",
        };
      },
      "budget_exhausted",
      "Discovery allowance reached; saved learning and waiting for help or an extension",
    );
  }
  private async action(
    id: string,
    endpoint: Endpoint,
    session: BrowserSession,
    step: RecipeStep,
  ): Promise<void> {
    const op = this.getOperation(id);
    const action = bindStep(step, op.input, op.outputs);
    // An arbitrary button click is a submission boundary regardless of a model's
    // proposed effect. Navigation uses the separately constrained follow action.
    const submission = step.effect === "submission" || action.kind === "click";
    const interactive = WRITING_ACTIONS.has(action.kind);
    const recordedStep: RecipeStep = {
      ...step,
      effect: submission ? "submission" : step.effect,
    };
    if (op.submission !== "none" && (submission || interactive))
      throw new AppError(
        "submission_guard",
        "A submission may already exist. Only read-only reconciliation is permitted",
        409,
      );
    if (
      submission &&
      ["get", "head", "options"].includes(endpoint.method.toLowerCase())
    )
      throw new AppError(
        "read_only_endpoint",
        "A read-only endpoint cannot authorize a business mutation",
      );
    if (
      step.save_as &&
      (!ID.test(step.save_as) ||
        ["_evidence", "__proto__", "constructor", "prototype"].includes(
          step.save_as,
        ))
    )
      throw new AppError("invalid_binding", "Invalid extraction variable");
    let uploadPath: string | undefined;
    let uploadMetadata: { name: string; media_type: string } | undefined;
    if (action.kind === "upload") {
      uploadMetadata = this.store.artifact(action.artifact_id).metadata;
      uploadPath = this.store.artifactPath(action.artifact_id);
    }
    this.change(
      id,
      (draft) => {
        draft.phase = "executing";
        if (interactive) draft.pending_ui_action = action.kind;
        if (submission) draft.submission = "intent";
      },
      submission ? "submission_intent" : "action_started",
      step.description,
      { kind: action.kind, effect: recordedStep.effect },
    );
    let result;
    try {
      result = await session.act(action, uploadPath, uploadMetadata);
    } catch (error) {
      if (interactive)
        this.change(
          id,
          (draft) => {
            draft.submission = "intent";
          },
          "interactive_action_uncertain",
          "An interactive UI action may have reached the site; replay is disabled",
        );
      throw error;
    }
    let value = result.value;
    let artifact: Artifact | undefined;
    if (result.download) {
      artifact = this.store.putArtifact(
        result.download.data,
        result.download.name,
        result.download.media_type,
      );
      try {
        value = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            result.download.data,
          ),
        ) as Json;
      } catch {
        value = {
          artifact_id: artifact.artifact_id,
          media_type: artifact.media_type,
          bytes: artifact.bytes,
          sha256: artifact.sha256,
        };
      }
    }
    this.change(
      id,
      (draft) => {
        if (submission) draft.submission = "observed";
        if (interactive) draft.pending_ui_action = undefined;
        if (step.save_as && value !== undefined) {
          draft.outputs[step.save_as] = value;
          const evidence = (draft.outputs._evidence ?? {}) as JsonObject;
          evidence[step.save_as] = {
            operation_id: id,
            capture_step: draft.step_index,
            captured_after_submission: draft.submission !== "none",
            ...(action.kind === "read" ? { format: action.format } : {}),
            media_type:
              artifact?.media_type ??
              (action.kind === "read" && action.format === "json"
                ? "application/json"
                : "text/plain"),
            kind: action.kind,
            ...(artifact ? { artifact_id: artifact.artifact_id } : {}),
          };
          draft.outputs._evidence = evidence;
        }
        if (artifact && !draft.artifacts.includes(artifact.artifact_id))
          draft.artifacts.push(artifact.artifact_id);
        draft.candidate_steps.push(structuredClone(recordedStep));
        draft.step_index++;
      },
      "action_completed",
      step.description,
      {
        kind: action.kind,
        ...(artifact ? { artifact_id: artifact.artifact_id } : {}),
      },
    );
  }
  private async finish(
    id: string,
    endpoint: Endpoint,
    mapping: ResponseMapping,
    learned: boolean,
  ): Promise<void> {
    const op = this.getOperation(id);
    // Success must be grounded in a UI read/download, never an invented JSON body.
    if (mapping.body.source !== "output")
      throw new AppError(
        "ungrounded_response",
        "Response body must reference a captured UI result",
      );
    this.change(
      id,
      (draft) => {
        draft.phase = "verifying";
      },
      "verifying",
      "Validating the complete captured response against the pinned endpoint contract",
    );
    const response = mapResponse(mapping, op.input, op.outputs);
    const root = mapping.body.path.startsWith("/")
      ? mapping.body.path
          .slice(1)
          .split("/")[0]!
          .replaceAll("~1", "/")
          .replaceAll("~0", "~")
      : mapping.body.path.split(".")[0]!;
    const evidence = (op.outputs._evidence as JsonObject | undefined)?.[
      root
    ] as JsonObject | undefined;
    if (
      !evidence ||
      evidence.operation_id !== id ||
      !["read", "download"].includes(String(evidence.kind))
    )
      throw new AppError(
        "ungrounded_response",
        "The mapped body must come from a read or download captured by this operation",
      );
    if (
      !["get", "head", "options"].includes(endpoint.method.toLowerCase()) &&
      (op.submission === "none" || evidence.captured_after_submission !== true)
    )
      throw new AppError(
        "ungrounded_response",
        "A mutating endpoint requires a submission boundary and a result captured after that boundary",
      );
    for (const [name, binding] of Object.entries(mapping.headers)) {
      if (
        binding.source === "literal" &&
        name.toLowerCase() === "content-type" &&
        binding.value === "application/json" &&
        evidence.media_type !== "application/json"
      )
        throw new AppError(
          "ungrounded_response",
          "A literal JSON content type requires captured JSON evidence",
        );
    }
    validateResponse(endpoint, response);
    const artifact = this.store.putArtifact(
      Buffer.from(JSON.stringify(response)),
      "api-response.json",
      "application/json",
    );
    // Result acceptance is independent from recipe promotion. A recipe error cannot repeat the business action.
    this.change(
      id,
      (draft) => {
        draft.api_response = response;
        draft.state = "succeeded";
        draft.phase = "complete";
        draft.error = undefined;
        if (!draft.artifacts.includes(artifact.artifact_id))
          draft.artifacts.push(artifact.artifact_id);
      },
      "completed",
      "Captured result is complete, schema-valid, and durably stored",
      { artifact_id: artifact.artifact_id, status: response.status },
    );
    if (
      learned &&
      op.candidate_steps.length &&
      !op.notes.includes("human_may_have_submitted")
    ) {
      try {
        const existing = this.store.recipes(op.site_id, op.endpoint);
        const coverage = deriveCoverage(
          op.input,
          op.candidate_steps,
          (artifactId) => this.store.artifact(artifactId).metadata,
        );
        const submissionIndex = op.candidate_steps.findIndex(
          (step) => step.effect === "submission",
        );
        const asynchronous = op.notes.includes("site_job_wait");
        if (asynchronous && submissionIndex < 0)
          throw new AppError(
            "missing_submission_evidence",
            "Cannot learn a job prefix without a submission boundary",
          );
        const recipe: Recipe = {
          recipe_id: `recipe_${randomUUID()}`,
          site_id: op.site_id,
          account_id: op.account_id,
          endpoint: op.endpoint,
          contract_hash: op.contract_hash,
          version: Math.max(0, ...existing.map((r) => r.version)) + 1,
          status: "observed",
          // Only proven parameter bindings generalize; settings and baked values stay fixed.
          input_schema: coverage.input_schema,
          artifact_constraints: coverage.artifact_constraints,
          steps: asynchronous
            ? op.candidate_steps.slice(0, submissionIndex + 1)
            : op.candidate_steps,
          response: mapping,
          ...(asynchronous ? { continuation: "observe" as const } : {}),
          evidence_operation_id: id,
          created_at: new Date().toISOString(),
        };
        this.store.putRecipe(recipe);
        this.change(
          id,
          (draft) => {
            draft.recipe_id = recipe.recipe_id;
          },
          "knowledge_saved",
          "Observed workflow saved for its schema-valid input scope; pilot API parity remains unproven",
          { recipe_id: recipe.recipe_id },
        );
      } catch (error) {
        this.change(
          id,
          (draft) => {
            draft.notes.push(
              `Recipe persistence failed: ${asError(error).code}`,
            );
          },
          "knowledge_save_failed",
          "Result remains committed; workflow promotion failed and must be retried independently",
        );
      }
    }
  }
  private async handoff(
    id: string,
    session: BrowserSession,
    reason: string,
    instructions: string,
  ): Promise<void> {
    await session.humanAccess();
    this.store.clearHandoffClaim(id);
    this.change(
      id,
      (op) => {
        op.state = "waiting_for_human";
        op.error = undefined;
        op.human_action = {
          handoff_id: `handoff_${randomUUID()}`,
          reason,
          instructions,
          control_url: `${this.config.controlBaseUrl}/handoffs/${id}`,
          presentation: session.presentation,
          claimed: false,
        };
      },
      "human_required",
      instructions,
      { reason },
    );
  }
  async claimHandoff(id: string): Promise<HandoffClaim> {
    if (this.cancelRequested.has(id))
      throw new AppError(
        "operation_cancelling",
        "The operation is stopping; browser control cannot be claimed",
        409,
      );
    const claimToken = randomBytes(32).toString("base64url");
    const operation = this.store.createHandoffClaim(
      id,
      handoffTokenHash(claimToken),
    );
    this.notifications.emit(id);
    return { operation, claim_token: claimToken };
  }
  async humanAccess(
    id: string,
    claimToken: string,
  ): Promise<{
    presentation: "local_window" | "streamed_browser";
    url?: string;
  }> {
    const claim = this.store.verifyHandoffClaim(
      id,
      handoffTokenHash(claimToken),
    );
    const op = this.getOperation(id);
    if (op.state !== "waiting_for_human" || !op.human_action?.claimed)
      throw new AppError(
        "handoff_not_claimed",
        "Claim the handoff before interacting with the browser",
        409,
      );
    if (claim.status === "returning" || op.human_action.returning)
      throw new AppError(
        "handoff_return_pending",
        "Browser control is being returned and cannot be reopened",
        409,
      );
    return (await this.session(this.store.site(op.site_id))).humanAccess();
  }
  async returnHandoff(
    id: string,
    claimToken: string,
    note: string,
    outcome: HumanReturnOutcome = "unknown",
  ): Promise<Operation> {
    if (!["no_submission", "submitted", "unknown"].includes(outcome))
      throw new AppError("invalid_outcome", "Invalid human submission outcome");
    if (typeof note !== "string" || !note.trim() || note.length > 4000)
      throw new AppError(
        "invalid_note",
        "A return note of 1–4000 characters is required",
      );
    const tokenHash = handoffTokenHash(claimToken);
    const checkpoint = this.store.beginHandoffReturn(
      id,
      tokenHash,
      note,
      outcome,
    );
    this.notifications.emit(id);
    try {
      await (
        await this.session(this.store.site(checkpoint.operation.site_id))
      ).releaseHumanControl?.();
    } catch {
      this.store.failHandoffReturn(id, tokenHash);
      this.notifications.emit(id);
      throw new AppError(
        "handoff_release_failed",
        "The human outcome is saved, but interactive browser release failed. Retry return control with the same claim token and outcome.",
        503,
      );
    }
    const updated = this.store.completeHandoffReturn(id, tokenHash);
    this.notifications.emit(id);
    this.enqueue(id, true);
    return updated;
  }
  async resumeOperation(
    id: string,
    options: { extend_ms?: number; note?: string } = {},
  ): Promise<Operation> {
    const op = this.getOperation(id);
    if (op.state === "waiting_for_human")
      throw new AppError(
        "human_owns_browser",
        "Use the human return-control action; caller resume cannot override the handoff",
        409,
      );
    if (terminalStates.has(op.state)) return op;
    if (
      !["needs_attention", "reconciling"].includes(op.state) ||
      (this.active === id && !op.error)
    )
      throw new AppError(
        "operation_active",
        "Operation is already scheduled or executing",
        409,
      );
    if (
      options.extend_ms !== undefined &&
      (!Number.isSafeInteger(options.extend_ms) ||
        options.extend_ms <= 0 ||
        options.extend_ms > 3_600_000)
    )
      throw new AppError(
        "invalid_extension",
        "An extension must be between 1 and 3600000 ms",
      );
    if (op.active_discovery_ms >= op.discovery_budget_ms && !options.extend_ms)
      throw new AppError(
        "extension_required",
        "Provide extend_ms to extend the consumed discovery allowance",
        409,
      );
    const updated = this.change(
      id,
      (draft) => {
        draft.state = draft.submission === "none" ? "queued" : "reconciling";
        draft.recipe_id = undefined;
        draft.error = undefined;
        if (options.extend_ms) draft.discovery_budget_ms += options.extend_ms;
        if (options.note) draft.notes.push(options.note.slice(0, 4000));
      },
      "resumed",
      "Resuming the existing operation from current UI evidence",
    );
    this.enqueue(id);
    return updated;
  }
  async cancelOperation(id: string): Promise<Operation> {
    const op = this.getOperation(id);
    if (terminalStates.has(op.state)) return op;
    if (op.human_action?.claimed)
      throw new AppError(
        "human_owns_browser",
        "Human must return control before cancellation can be reconciled",
        409,
      );
    this.cancelRequested.add(id);
    this.controllers.get(id)?.abort();
    if (this.active !== id) await this.stopIfCancelled(id);
    return this.getOperation(id);
  }
  private async stopIfCancelled(id: string): Promise<boolean> {
    if (!this.cancelRequested.has(id)) return false;
    this.cancelRequested.delete(id);
    this.reconcilePendingAction(id);
    this.change(
      id,
      (op) => {
        op.human_action = undefined;
        op.state = op.submission === "none" ? "cancelled" : "needs_attention";
        if (op.submission !== "none")
          op.error = {
            code: "monitoring_stopped",
            message:
              "Local execution stopped. The site job may still run; no target cancellation was verified.",
          };
      },
      "cancelled_locally",
      "Stopped local work; any previously submitted target action is not undone",
    );
    queueMicrotask(() => this.pump());
    return true;
  }
  putArtifact(data: Uint8Array, name: string, mediaType: string): Artifact {
    return this.store.putArtifact(data, name, mediaType);
  }
  getArtifact(id: string): { metadata: Artifact; data: Uint8Array } {
    return this.store.artifact(id);
  }
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    clearInterval(this.heartbeat);
    for (const timer of this.timers) clearTimeout(timer);
    for (const controller of this.controllers.values()) controller.abort();
    await this.browser.close();
    // Closing a browser interrupts in-flight UI actions; let their intent checkpoints settle.
    while (this.active) await new Promise((resolve) => setTimeout(resolve, 10));
    this.store.close();
  }
}
export function createApplication(
  config: AppConfig,
  dependencies?: Dependencies,
): Application {
  return new BrowserApiService(config, dependencies);
}
