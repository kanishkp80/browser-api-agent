export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export type OperationState =
  | "queued"
  | "running"
  | "waiting_for_human"
  | "needs_attention"
  | "reconciling"
  | "succeeded"
  | "failed"
  | "cancelled";
export type Phase =
  | "queued"
  | "discovering"
  | "preparing"
  | "executing"
  | "monitoring"
  | "verifying"
  | "persisting"
  | "complete";
export const terminalStates = new Set<OperationState>([
  "succeeded",
  "failed",
  "cancelled",
]);

export interface AppConfig {
  dataDir: string;
  host: string;
  port: number;
  controlBaseUrl: string;
  serviceToken: string;
  browserHost: "local" | "e2b";
  headless: boolean;
  executablePath?: string;
  e2bApiKey?: string;
  e2bTemplate?: string;
  openaiApiKey?: string;
  discoveryBudgetMs: number;
  actionTimeoutMs: number;
  heartbeatMs: number;
  maxArtifactBytes: number;
  allowLocalSites: boolean;
}

export interface SiteRegistration {
  site_id: string;
  account_id: string;
  base_url: string;
  allowed_origins?: string[];
  spec: JsonObject;
}
export interface Site extends SiteRegistration {
  contract_hash: string;
  created_at: string;
}
export interface Endpoint {
  key: string;
  method: string;
  path: string;
  summary: string;
  input_schema: JsonObject;
  responses: Record<
    string,
    {
      schema: JsonObject | boolean;
      media_type: string;
      required_headers: string[];
    }
  >;
  runtime_coverage?: {
    status: "unexamined" | "observed";
    api_parity: "unverified";
    scopes: Array<{
      recipe_id: string;
      input_schema: JsonObject;
      artifact_constraints: Record<string, string>;
      continuation?: "observe";
    }>;
  };
}
export interface ApiResponse {
  status: number;
  headers: Record<string, string>;
  body: Json;
}
export interface ExecuteRequest {
  request_id: string;
  site_id: string;
  endpoint: string;
  input: JsonObject;
  site?: SiteRegistration;
}
export interface OperationError {
  code: string;
  message: string;
  details?: Json;
}
export interface HumanAction {
  handoff_id: string;
  reason: string;
  instructions: string;
  control_url: string;
  presentation: "local_window" | "streamed_browser";
  claimed: boolean;
  returning?: boolean;
}
export type HumanReturnOutcome = "no_submission" | "submitted" | "unknown";
export interface HandoffClaim {
  operation: Operation;
  /** Per-handoff bearer capability returned only to the successful claimant. */
  claim_token: string;
}
export interface Operation {
  operation_id: string;
  request_id: string;
  site_id: string;
  account_id: string;
  endpoint: string;
  input: JsonObject;
  input_hash: string;
  contract_hash: string;
  state: OperationState;
  phase: Phase;
  revision: number;
  created_at: string;
  updated_at: string;
  active_discovery_ms: number;
  discovery_budget_ms: number;
  submission: "none" | "intent" | "observed";
  /** An interrupted interactive action is ambiguous even when labeled preparation. */
  pending_ui_action?: string;
  /** Retains this account's page across job waits and unresolved operations. */
  browser_lease?: boolean;
  browser_session_id?: string;
  browser_provider?: "local" | "e2b";
  recipe_id?: string;
  step_index: number;
  outputs: Record<string, Json>;
  candidate_steps: RecipeStep[];
  api_response?: ApiResponse;
  error?: OperationError;
  human_action?: HumanAction;
  artifacts: string[];
  notes: string[];
}
export interface ProgressEvent {
  operation_id: string;
  sequence: number;
  timestamp: string;
  state: OperationState;
  phase: Phase;
  event_type: string;
  message: string;
  details?: Json;
}
export interface OperationUpdate {
  operation: Operation;
  events: ProgressEvent[];
  cursor: number;
  has_more: boolean;
}
export interface Artifact {
  artifact_id: string;
  name: string;
  media_type: string;
  bytes: number;
  sha256: string;
}

export type Locator =
  | { by: "role"; value: string; name: string }
  | { by: "label" | "text" | "placeholder" | "testid" | "css"; value: string };
export type Binding =
  | { source: "literal"; value: Json }
  | { source: "input" | "output"; path: string };
export type BrowserAction =
  | { kind: "navigate"; url: string }
  | { kind: "follow"; target: Locator }
  | { kind: "click"; target: Locator }
  | { kind: "fill" | "select"; target: Locator; value: string }
  | { kind: "check"; target: Locator; checked: boolean }
  | { kind: "upload"; target: Locator; artifact_id: string }
  | { kind: "read"; target: Locator; format: "text" | "json" }
  | { kind: "download"; target: Locator }
  | { kind: "wait"; target: Locator; state: "visible" | "hidden" };
export interface Observation {
  url: string;
  title: string;
  content: string;
  truncated: boolean;
}
export interface BrowserResult {
  value?: Json;
  download?: { name: string; media_type: string; data: Uint8Array };
}
export interface BrowserSession {
  id: string;
  presentation: "local_window" | "streamed_browser";
  /**
   * Resolves false when this session can no longer accept browser commands.
   * Implementations must treat probe errors as not alive rather than throwing.
   */
  isAlive?(): Promise<boolean>;
  observe(): Promise<Observation>;
  act(
    action: BrowserAction,
    uploadPath?: string,
    uploadMetadata?: { name: string; media_type: string },
  ): Promise<BrowserResult>;
  humanAccess(): Promise<{
    presentation: "local_window" | "streamed_browser";
    url?: string;
  }>;
  releaseHumanControl?(): Promise<void>;
  close(): Promise<void>;
}
export interface BrowserProvider {
  connect(site: Site): Promise<BrowserSession>;
  close(): Promise<void>;
}
export interface RecipeStep {
  action: BrowserAction;
  bindings?: Record<string, Binding>;
  effect: "none" | "submission";
  save_as?: string;
  description: string;
}
export interface ResponseMapping {
  status: number;
  headers: Record<string, Binding>;
  body: Binding;
}
export interface Recipe {
  recipe_id: string;
  site_id: string;
  account_id: string;
  contract_hash: string;
  endpoint: string;
  version: number;
  status: "candidate" | "observed" | "stale";
  input_schema: JsonObject;
  steps: RecipeStep[];
  artifact_constraints?: Record<string, string>;
  response: ResponseMapping;
  /** Jobs replay only the preparation/submission prefix, then inspect live state. */
  continuation?: "observe";
  evidence_operation_id: string;
  created_at: string;
}
export type AgentDecision = (
  | { kind: "action"; step: RecipeStep; message: string }
  | { kind: "human"; reason: string; instructions: string }
  | { kind: "wait_job"; message: string; delay_ms: number }
  | {
      kind: "finish";
      response: ResponseMapping;
      coverage_schema: JsonObject;
      message: string;
    }
  | { kind: "unsupported"; reason: string }
) & { learning?: { notes: string[] } };
export interface DiscoveryContext {
  site: Site;
  endpoint: Endpoint;
  operation: Operation;
  observation: Observation;
  knowledge: Json[];
  signal: AbortSignal;
  report?: (message: string) => void;
}
export interface DiscoveryAgent {
  next(context: DiscoveryContext): Promise<AgentDecision>;
}

/** Shared application interface; every caller uses the same durable executor. */
export interface Application {
  config: AppConfig;
  registerSite(registration: SiteRegistration): Site;
  listSites(): Site[];
  listEndpoints(siteId: string): Endpoint[];
  execute(request: ExecuteRequest): Promise<Operation>;
  getOperation(id: string): Operation;
  waitOperation(
    id: string,
    after?: number,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<OperationUpdate>;
  getResult(id: string): {
    operation_id: string;
    state: OperationState;
    api_response?: ApiResponse;
    error?: OperationError;
    artifacts: string[];
  };
  cancelOperation(id: string): Promise<Operation>;
  resumeOperation(
    id: string,
    options?: { extend_ms?: number; note?: string },
  ): Promise<Operation>;
  claimHandoff(id: string): Promise<HandoffClaim>;
  returnHandoff(
    id: string,
    claimToken: string,
    note: string,
    outcome?: HumanReturnOutcome,
  ): Promise<Operation>;
  humanAccess(
    id: string,
    claimToken: string,
  ): Promise<{
    presentation: "local_window" | "streamed_browser";
    url?: string;
  }>;
  putArtifact(data: Uint8Array, name: string, mediaType: string): Artifact;
  getArtifact(id: string): { metadata: Artifact; data: Uint8Array };
  close(): Promise<void>;
}
