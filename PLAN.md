# Browser API agent — working plan

Status: first implementation and local validation in progress. Public pilot contracts are pinned. A live E2B infrastructure smoke passes; authenticated Powder/Reducto workflows and production deployment acceptance remain pending.

Working directory: `/Users/kanishkp/workspace/browser-api-agent`. This `PLAN.md` is the maintained working plan; PDF exports are dated snapshots.

## Implementation checkpoint — 2026-09-08

The initial TypeScript service is implemented with the OpenAI Agents SDK, explicit `gpt-6-astra` / maximum reasoning, bounded parallel contract and UI reviewers, and a Playwright browser baseline. This is the application implementation of the requested Ultra pattern; it does not claim equivalence to the Codex desktop harness. Camofox remains an agreed comparison before final backend selection.

Implemented: call-triggered discovery, persisted operation/event records, stable caller request IDs, schema intake/validation, scoped observed recipes with guarded input bindings, deterministic replay, MCP stdio and Streamable HTTP, CLI/NDJSON event following, local profiles, an E2B provider, complete artifact storage outside browser workers, and exclusive human handoffs. A target-shaped HTTP compatibility facade remains future work.

The service uses one durable SQLite/files volume outside E2B. A job retains its account's browser page while waiting; the worker may serve another independent account, but cannot replace the first job's page. Recipes learned from a job replay preparation/submission, then inspect live job state. This conservative first implementation supersedes the proposed same-page job interleaving below until durable job correlation or per-operation tabs are implemented.

Correctness boundaries: checkpoint interactive actions before dispatch; treat arbitrary button clicks as submission boundaries; reconcile interrupted actions instead of retrying them; persist human submission outcomes before releasing control; require exclusive claim tokens; and label schema-valid workflows `observed`. Pilot API parity needs stronger semantic evidence than a matching JSON schema.

A live E2B `desktop` smoke passed on 2026-09-08: UI fill/upload/result/download, authenticated noVNC streaming, keyboard input through the stream, return to the same automated browser, protected CDP ingress, and complete sandbox cleanup. `npm run smoke:e2b` reproduces this infrastructure check with synthetic data. It does not establish live Astra-to-pilot parity.

Validation also includes a real local Chromium UI, uploaded file bytes, a complete captured response, a different input after service restart, real MCP SDK clients, and a CLI subprocess. Opt-in live tests exercise the actual Astra model. Detailed validation results and runtime instructions live in [README.md](README.md); pilot source hashes and contract gaps live in [docs/PILOT-COVERAGE.md](docs/PILOT-COVERAGE.md).

Remaining acceptance work: legitimate pilot login and test fixtures, exact response/postcondition evidence, Reducto's published schema ambiguity and input dependency, production E2B template pinning and expiry/replacement recovery validation, Camofox comparison, and a real calling-agent integration. New E2B sandboxes currently require fresh human login; protected authentication export/restore remains unimplemented. General per-field response aggregation, multiple business submissions in one workflow, retention policy, and multi-service deployment also remain outside this first slice.

## Goal and agreed decisions

Build a reusable engine that accepts an API specification, learns a website through a legitimate user's browser session, and executes supported endpoint requests through that site's UI. Powder is the first test site; Reducto Parse is the second.

- Browser operations may use page content, DOM/accessibility, forms, uploads, and downloads.
- Business operations must go through the UI. Replaying authenticated network requests is outside the agreed scope.
- Support both deployment modes: a dedicated local browser profile for testing and an E2B-hosted browser session for server environments. E2B credentials are supplied through server configuration. Both modes are required; implementation can begin locally.
- Evaluate Camofox Browser alongside direct Playwright behind a replaceable browser adapter. Playwright is the implemented baseline; the Camofox comparison remains pending before final backend selection.
- Use OpenAI GPT-6 Astra (`gpt-6-astra`) in Astra Ultra mode for discovery, workflow learning, unfamiliar-page reasoning, and recovery. The user has confirmed maximum reasoning with proactive delegation of useful independent work to subagents.
- Target exact behavior for a declared supported endpoint subset, with explicit coverage gaps.
- Provide both an MCP server and a CLI so other agents can discover capabilities, invoke supported endpoints, retrieve results, and coordinate human help. Both use the same execution service and browser queue.
- A dedicated test account will be available to exercise writes and jobs on test data during the implementation and validation phase.
- Human participation establishes or renews login. Proposed implementation: the user signs in directly in the controlled browser; credentials never enter prompts or learned site memory.
- Trigger discovery within endpoint calls when the required workflow is unknown or stale, and persist learned structure and verified workflows for later calls. Separate discovery/onboarding is optional rather than a prerequisite to execution. On the first call, briefly map the main navigation and then learn the requested workflow. Expand the broader mental map as subsequent calls require more knowledge.
- During discovery, perform only the requested business action unless a separate account-scoped allowance explicitly permits additional test writes, jobs, or cleanup.
- The calling agent maintains an active connection and consumes detailed structured updates throughout discovery, login/help, execution, job monitoring, recovery, and completion. Persist status so reconnecting callers can recover updates after a disconnect or worker replacement. On disconnect, continue already-authorized work within its limits, persist updates for replay, and pause when human input is needed. Exact transport remains an implementation choice to validate.
- Use a configurable 10-minute active-discovery budget. At the limit, preserve learning and ask the caller for help or an extension; exclude human-login/help waits and target-site job-processing waits.
- When the agent is confused, give browser control back to the user and ask for specific help. The handoff should identify the unresolved step and what demonstration or clarification is needed.
- Start with one account and queued browser interactions. Numerical latency targets remain open; measure normal execution and recovery separately, and exclude remote job processing time from adapter overhead.
- Identify compatibility gaps clearly, with evidence and their effect on the supported endpoint contract.
- Implementation is authorized. Target-account execution remains pending legitimate human login and an explicit test request; no authenticated pilot operation has been performed.

## Initial operating assumptions

- Assume both pilot sites allow headless browser automation without blocking it.
- Assume there are no CAPTCHA challenges in the target workflows.
- Treat these as prototype assumptions, not verified claims about either site. CAPTCHA handling and mitigation of headless-browser blocking are outside the initial scope.
- Human login, session renewal, and browser takeover for specific help remain required. The browser-control design must support a user-visible handoff even when routine execution runs headlessly.
- If either assumption proves false, report the observed mismatch and revisit scope before continuing the affected workflow.

## Required deployment modes: local and E2B

The browser host is configurable independently of the browser-control backend. Implement both a local session provider and an E2B session provider behind a shared lifecycle interface: create/connect, inspect health, provide human access, stage inputs, collect outputs, checkpoint/restore supported state, and close. Camofox versus direct Playwright remains a browser-backend evaluation; E2B is the selected host for server browser sessions.

| Concern          | Local testing                                           | Server environment                                                                                     |
| ---------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Browser worker   | Dedicated browser on the test machine                   | Browser inside an E2B Desktop sandbox                                                                  |
| Session creation | Local provider; no E2B credentials required             | E2B provider using the configured server-side API key and compatible template                          |
| Human takeover   | Existing visible browser window plus local control page | Authenticated interactive stream of the same sandbox browser, reached through the service control page |
| Calling agents   | Local MCP stdio bridge or CLI                           | Authenticated remote MCP/CLI service connection; a local stdio bridge may forward to it                |
| Durable state    | Application data directory outside the browser profile  | Persistent service storage outside the E2B sandbox                                                     |

Implemented application configuration names:

| Setting                                   | Purpose                                                                                                                                                                                  |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BROWSER_API_BROWSER_HOST=local` or `e2b` | Explicitly select the browser host. No silent fallback between providers.                                                                                                                |
| `E2B_API_KEY`                             | Required for E2B mode; injected into the service through an environment variable or server secret manager. Local mode does not require it.                                               |
| `BROWSER_API_E2B_TEMPLATE`                | Select a pinned E2B Desktop template compatible with the chosen browser backend.                                                                                                         |
| `BROWSER_API_CONTROL_BASE_URL`            | Human-accessible base URL: loopback for local testing, authenticated HTTPS control service for server use.                                                                               |
| `BROWSER_API_DATA_DIR`                    | Persistent application storage location for the initial SQLite/files design; use a durable volume in server deployments, outside E2B and preserved across service/container replacement. |

E2B documents `E2B_API_KEY` for its SDK and interactive desktop/window streaming with stream-specific authentication. Use those capabilities behind our provider and control-page interfaces. Source: [E2B Desktop setup and streaming](https://github.com/e2b-dev/desktop). The other configuration names above are application settings implemented by this service.

Read the E2B API key only in the service's provider integration; do not pass it to models, MCP tool arguments/results, CLI command-line arguments, browser pages, or site memory. Keep it out of logs and checked-in configuration. E2B credentials provision the environment; target-site login remains a separate human interaction in that environment's browser. Missing or invalid credentials, an unavailable template, or quota/capacity failures produce explicit provider errors. Do not substitute a local browser when E2B mode fails.

The application service, queue, contract handling, recipes, operation/handoff records, and durable artifacts remain outside the browser sandbox. Initially this can be one service process with persistent storage. The E2B worker contains the browser, active site session, temporary input/output files, and browser-control tooling. Keep the provider's E2B control-plane calls separate from target-site business operations, which still go through the browser UI.

Reuse the active worker for successive requests in the same account/site session. Bind each operation to its account, provider, sandbox/worker, and browser session; persist these identifiers and retain exclusive ownership across MCP/CLI clients, and manage timeout/keepalive explicitly during jobs and human handoffs. Restore or reconnect where supported; distinguish a resumed sandbox from a newly created one. After sandbox loss, recover from durable operation evidence and reauthenticate if needed. The pause/restore behavior of the pinned E2B SDK, browser backend, and login must be tested together. Do not assume a saved login restores an unsaved form or that a remote job stopped when a worker disappeared.

For server requests, transfer caller files to the service's artifact store, then materialize them inside the selected worker for UI upload. Copy completed downloads/results back to durable storage before worker cleanup. Keep artifact IDs stable across providers; raw caller paths and sandbox paths are not interchangeable. Protect persisted session secrets separately from reusable recipes, and do not embed a logged-in user's profile in a shared sandbox template.

Build local execution first, then validate E2B using the same supported pilot workflows and shared recipes. Required deployment acceptance checks include: local operation without an E2B key; E2B startup with configured credentials; clear failure with missing/invalid credentials; complete uploads/downloads; remote human login and takeover; repeated endpoint calls in one warm session; service/worker restart and expiry recovery; and concurrent callers sharing browser ownership without duplicate submission. A local-only implementation does not satisfy this deployment requirement. Pin and test the Camofox/E2B combination if Camofox is chosen.

Both providers are implemented, but only local fixtures have been exercised. No E2B credential was available and no live E2B sandbox has been provisioned or validated.

## Selected pilot entry points

| Pilot         | API contract source                                                                                                     | Browser entry point supplied by the user                                                                                                           |
| ------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Powder        | [Powder API overview](https://docs.powderfi.com/docs/getting-started)                                                   | [powderfi.com](https://powderfi.com)                                                                                                               |
| Reducto Parse | [Parse overview](https://docs.reducto.ai/parse/overview), [OpenAPI specification](https://docs.reducto.ai/openapi.json) | [Reducto Studio pipeline](https://studio.reducto.ai/pipeline/k9770z5snrtw8frtdjq64xw86n8e0vc2?new=true&processor=kh7cdy5k1vztms38mp3erw7d7d8e1fef) |

Use these as starting locations for authenticated discovery. The supplied Reducto pipeline/processor and Powder's post-login application route have not been inspected. API documents define the target contract; business operations use the browser UI. Snapshot and pin each available specification before validating compatibility. Reducto's OpenAPI URL is listed in its [documentation index](https://docs.reducto.ai/llms.txt); the complete schema has now been pinned and compiler-checked; the published `/parse` ambiguity is recorded in [pilot coverage](docs/PILOT-COVERAGE.md).

## Proposed architecture

### 1. Contract intake and coverage

Parse routes, methods, inputs, response schemas, status codes, identifiers, pagination, and job semantics from the supplied specification. Track each endpoint as unexamined, mapped, verified, constrained, or unsupported. A valid response shape alone is insufficient to establish compatibility.

### 2. Discovery and durable knowledge

An endpoint call can enter discovery when there is no applicable verified recipe, a requested parameter combination is unverified, or the current UI invalidates stored knowledge. Learn within that same durable operation, then execute the request if its contract can be satisfied. Build the site map incrementally from observed navigation, entities, relationships, and workflow families, and record unexplored areas explicitly. The first call briefly maps the main navigation, then focuses on its requested workflow. Later requests incrementally expand the site map. Do not require an exhaustive crawl or a separate onboarding call.

Persist separately:

- A site map: page states, navigation paths, entity relationships, forms, controls, and relevant permissions.
- Endpoint recipes: input bindings, semantic locators, prerequisites, steps, waits, extraction rules, postconditions, and retry policy.
- Account-scoped state: entity identifiers and UI locations, operation receipts, job tracking, and session references.

Version recipes and record their verification evidence and applicable site/account configuration. Remember how to retrieve live data; do not silently serve stale remembered business values. Keep credentials and session secrets separate from reusable knowledge.

#### Knowledge persistence across runs and sandbox replacement

The execution service owns durable knowledge; an E2B worker is replaceable execution capacity. Learned knowledge must survive the destruction of the original sandbox, a new sandbox ID, a new model conversation, and a service restart. It does not depend on keeping an agent process or conversation alive.

| State                                                                            | Durable representation outside the sandbox                                                                               | How a new run uses it                                                                                                   |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Site knowledge and endpoint workflows                                            | Versioned site map, semantic targets, input/output bindings, validated recipes, coverage gaps, and verification evidence | Retrieve the relevant verified recipe and nearby site context for the requested endpoint.                               |
| Account and operation progress                                                   | Account-scoped identifiers, request keys, submission intent/receipts, job IDs, checkpoints, and handoff records          | Recover the right entities and reconcile unfinished work before any repeat submission.                                  |
| Authentication state                                                             | Separately protected browser storage/profile exports where supported, scoped to the account and compatible backend       | Attempt restoration, verify login, and request human login if the saved state expired or is incompatible.               |
| Inputs, outputs, and evidence                                                    | Complete files in durable artifact storage, addressed by stable IDs and digests                                          | Stage inputs into the new worker and return previously committed results without depending on old sandbox paths.        |
| Live tabs, temporary element references, unsaved forms, and current observations | Ephemeral worker state; excluded from durable recipe identity                                                            | Reopen the relevant page and obtain fresh observations. Preserved runtime state may accelerate this only when verified. |

Commit validated learning incrementally as each workflow is established or repaired. Persist candidate changes separately from verified versions and promote a new recipe only after validation, using version checks to prevent stale updates. Save observation/evidence checkpoints as work progresses; a shutdown hook is not the persistence mechanism. An abrupt failure can lose the latest uncommitted observation, but must not erase committed knowledge.

Retrieve knowledge by site identity, pinned contract version, endpoint, applicable account configuration, and verification status. Supply only the relevant context to Astra when reasoning is needed; established recipes can run directly in the deterministic runner. The model does not have to remember a previous conversation. Knowledge about navigation is reusable, while live business data and page state still require current checks. Relearn the affected portion if those checks show drift.

Fresh-worker startup and execution:

1. Load the requested contract, applicable recipe if available, account bindings, and any unfinished operation from persistent service storage. A missing recipe enters call-triggered discovery; it is not by itself an unsupported endpoint. Keep operation identity independent of sandbox identity.
2. Acquire exclusive browser ownership and create or reconnect the configured worker. Bind it to the operation; reject stale worker checkpoint updates and stop old-worker automation before replacement work proceeds. Treat any remaining uncertain in-flight action as unresolved.
3. Attempt compatible authentication restoration, or open a human login handoff. Stage required input artifacts into the worker and navigate using the saved recipe.
4. Check the current account, page, controls, and operation evidence. Reconcile any previous submission; otherwise execute a verified workflow or discover the missing workflow within the same operation. Invoke reasoning for a coverage gap or changed state and publish the current phase to the caller.
5. Persist submission intent before a mutation/job, then the observed receipt/checkpoint afterward. Copy complete results and evidence to durable storage and verify their references before reporting success. A record pointing only to a sandbox file is not a durable result.

For local testing, the proposed store is SQLite plus versioned files in the application data directory. For a single server service, use persistent service storage outside E2B that survives container/process replacement; an ephemeral server filesystem is insufficient. A durable volume can support the initial SQLite/files design, or the same storage interfaces can use an external database and object store. The exact server storage provider remains an implementation choice, but durability across both worker and service restart is required.

E2B documents pause/resume that can preserve filesystem and memory, whereas killing a sandbox is terminal. Use pause/resume as an optional continuity optimization, with renewed browser/control connections and current-state validation. Application knowledge must remain usable after complete sandbox deletion and fresh creation. Source: [E2B sandbox persistence](https://docs.e2b.dev/sandbox/persistence).

Required proof: learn and verify a pilot workflow, commit its knowledge and artifacts, delete its E2B sandbox, restart the service, and create a fresh sandbox with a different ID. Execute a new request using the saved recipe without repeating broad site discovery, allowing human reauthentication when needed. Separately test failure immediately after submission, expired login, changed UI, interrupted knowledge writes, and stale worker updates; require explicit recovery and no blind duplicate submission.

### 3. Recipe verification

Verify complete outcomes using authorized test data and settings. Check submitted settings, entity identity, resulting state, response values, and contract conformance. Learning where a submit button is does not establish that a workflow is safe to replay or that its result matches the endpoint.

Use the dedicated test account for this phase. Select concrete test documents and mutation boundaries before beginning authenticated validation; the current session remains planning only.

### 4. Fast execution

Validate request → create or recover a durable operation → resolve account and identifiers → load relevant knowledge → reuse an applicable recipe or discover the missing workflow → execute UI steps under exclusive browser ownership → verify outcome → persist learning and complete results → return the API response. Publish progress throughout. A first call pays the learning cost; later calls reuse verified knowledge with current-state checks.

Use deterministic browser actions for established recipes. Invoke the reasoning agent for uncovered operations, unexpected states, or bounded recovery. Prefer semantic locators, observed deep links, event-based waits, warm sessions, and complete table/download extraction where available. Measure speed; do not promise API-like latency before benchmarking the site.

### 5. Recovery and durable operations

Keep a durable operation record before submitting a mutation or job. On timeout, inspect whether submission succeeded before retrying. An uncertain outcome must not trigger blind replay. Reconcile using stable identifiers and available UI evidence; otherwise request human assistance through a separate control channel.

Checkpoint jobs so monitoring can resume after a worker restart. Match the target API's submission and polling contract; do not introduce a different asynchronous response format without explicitly declaring the compatibility change. Reauthentication pauses browser work and returns browser control to the user.

On ambiguity, pause automation and transfer exclusive browser control to the user. Ask a specific question or request a demonstration at the relevant page, including what the agent has already observed. After the user hands control back, inspect the resulting state, reconcile any actions the user performed, and verify an updated recipe before reusing it. Do not repeat a mutation merely because the human performed it outside the agent's execution trace.

## Interfaces for other agents: MCP and CLI

MCP and CLI support are confirmed requirements. Expose the browser agent as a reusable service that other agents can call with structured requests. The proposed HTTP compatibility facade, MCP server, and CLI share contract validation, learned recipes, account state, operation records, artifacts, and one browser-ownership queue. A new caller connection must not create an independent browser executor for the same account.

### Shared capabilities

The following names are proposed. Endpoint keys are stable identifiers from the pinned contract, using its operation ID when available or a normalized method/path key. Endpoint discovery reports input/output schemas, supported input ranges, coverage gaps, and verification status. Reject invalid inputs, unauthorized scope, and known applicable incompatibilities before business actions. An unexamined endpoint or parameter combination can trigger discovery inside execute_endpoint; absence of a recipe is not evidence of incompatibility. Registration still establishes the specification, site/account identity, and action scope. Optional onboarding can prelearn workflows, but is not required before a call.

| Capability                                                                    | Proposed MCP tools                                      | Proposed CLI commands                                                                         |
| ----------------------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Register a site/specification and optionally prelearn within a declared scope | `onboard_site`                                          | `browser-api sites onboard`                                                                   |
| Discover sites, endpoints, coverage, and schemas                              | `list_sites`, `list_endpoints`, `describe_endpoint`     | `browser-api sites list`, `browser-api endpoints list`, `browser-api endpoints describe`      |
| Invoke an endpoint, learning an unknown workflow within the call when needed  | `execute_endpoint`                                      | `browser-api execute`                                                                         |
| Inspect or wait for durable work                                              | `get_operation`, `wait_operation`                       | `browser-api operations get`, `browser-api operations wait`                                   |
| Retrieve the endpoint response                                                | `get_result`                                            | `browser-api results get`                                                                     |
| Resume after human assistance                                                 | `resume_operation`                                      | `browser-api operations resume`                                                               |
| Request cancellation with an explicit outcome                                 | `cancel_operation`                                      | `browser-api operations cancel`                                                               |
| Register or upload inputs and retrieve complete artifacts                     | `register_artifact`, `upload_artifact`, `read_artifact` | `browser-api artifacts register`, `browser-api artifacts upload`, `browser-api artifacts get` |

Use one generic endpoint invocation surface initially. Validate its path/query/body inputs against the endpoint schema returned by discovery. Site-specific tool wrappers may later be generated from verified contracts; they must use the same execution path and must not become handwritten site adapters.

### Result, job, and human-help semantics

MCP and CLI return a documented control envelope with `operation_id`, `state`, and, when applicable, `api_response`, `error`, `human_action`, and `artifacts`. Suggested states are `queued`, `running`, `reconciling`, `waiting_for_human`, `succeeded`, `failed`, and `cancelled`; an uncertain submission stays unresolved and requires reconciliation before any repeat action. `api_response` carries the contract-compatible status, applicable verifiable headers, and unchanged target response body. Adapter failures and compatibility gaps are separate from target API errors. Control metadata never gets inserted into the simulated endpoint's body. The HTTP compatibility facade retains the declared endpoint contract and separately identifies adapter-level failures.

Keep transport request IDs, durable adapter operation IDs, and target-site job/entity IDs distinct. Creating an adapter operation to manage a long synchronous Parse request does not add async support to the target API. Callers can use bounded waits and retrieve the same operation later. Transport timeout, CLI exit, or a disconnected MCP client does not imply target-job cancellation or authorize resubmission. Cancellation reports whether work stopped before submission, a site cancellation was verified, or only local waiting stopped; it must not claim that an already-submitted job was undone without evidence.

For repeatable caller retries through MCP/CLI, require a caller-generated `request_id` on mutation/job submissions and onboarding writes. Atomically persist the key, account/site/endpoint scope, and normalized input digest, including registered file content digests, before browser work begins. Reusing the key with the same inputs retrieves the existing operation across MCP, CLI, and the HTTP control interface; reusing it with different inputs fails explicitly. The HTTP compatibility facade may accept an optional adapter request key, but must not add a new required input to the target contract. The key is adapter control metadata, not an invented target API field or guarantee of exactly-once effects after an uncertain submission.

When human help is needed, return the handoff descriptor below through MCP/CLI. The calling agent relays its control link and specific instructions to the human; the execution service retains the live browser session and coordinates ownership. Credentials and browser storage are not sent to the caller.

Register input paths only within the service's configured file scope. For remote callers, accept explicit uploads through the shared artifact interface, including chunked transfer where needed. Return artifact IDs that callers bind to the documented upload/input fields; stage those files in the local or E2B worker before UI actions. A caller path is not assumed to exist on the server or in a sandbox. Store completed results outside the worker and expose retrievable artifact references with media type, byte length, and digest, supporting complete or chunked reads. Clearly distinguish summaries/previews from full results and preserve complete payloads without silent truncation.

### Call-triggered discovery and caller progress

Confirmed direction: a caller can request an endpoint before its UI workflow has been learned. The operation discovers what is missing, performs the requested action when feasible, and persists useful knowledge for later calls. The caller is another agent and maintains an active connection to consume detailed updates during the work. These requirements supersede the earlier mandatory separate-onboarding model; they do not establish compatibility before evidence exists.

Confirmed through the first two clarification rounds:

- Briefly orient to the main navigation, then discover the workflow needed for the current request. Extend knowledge on later calls.
- Perform the requested business effect only. Extra exploratory writes, paid test jobs, or cleanup require a separately configured allowance. A request to parse one document does not itself authorize additional trial parses.
- Deliver detailed progress to the calling agent while it stays connected. Updates describe actions, discoveries, observed outcomes, current waits, blockers, and required help. They are not limited to a generic running flag.
- Treat the caller as an active consumer of updates. The precise streaming/wait protocol remains an implementation choice to validate; this does not by itself select an indefinitely open tool call.
- If the caller unexpectedly disconnects, continue already-authorized work within its limits and persist updates for replay. Pause whenever human input is required. Resume delivery under the same operation identity after reconnection; disconnection is not cancellation.
- Default to a configurable 10-minute active-discovery budget. At the limit, preserve learning and ask the caller for help or an extension. Exclude time waiting for login/human help and time waiting for a target-site job.
- Validate one real calling-agent client first while retaining generic MCP and CLI interfaces. Working assumption: use the current Codex desktop environment because it is the client already in use here. The user accepted the real-client-first recommendation but did not name a specific client; Codex is a provisional selection, and event delivery has not been tested.

Proposed execution rules to refine during the clarification session:

- Reuse verified recipes within their evidenced input/settings coverage. Learn unknown settings and repair stale navigation within the original operation. Persist partial observations as candidates; promote only the verified scope. One successful request does not verify every endpoint parameter combination.
- Save useful observations and recipe evidence incrementally outside the browser worker. Commit results and submission receipts independently of recipe promotion so a learning-store failure cannot cause a completed business action to be repeated.
- Enforce the confirmed requested-action boundary. Extra exploratory writes, billable test jobs, or cleanup are disabled unless the configured learning allowance covers them. Persist intent before any submission and reconcile uncertain outcomes rather than replaying discovery from its start.
- Publish a structured status snapshot and ordered durable events for accepted work. Proposed event fields: operation_id, event_id/sequence, timestamp, state, phase, event_type, step, message, observed_outcome, next_action, and optional evidence, human_action, or result references. Snapshots additionally expose last_progress_at and last_heartbeat_at. Suggested phases include discovering, preparing, executing, monitoring, verifying, and persisting. These are proposed contract fields, not an implemented protocol.
- Emit useful detail when the agent discovers navigation/settings, resolves requested parameter bindings, begins or completes a meaningful UI action, observes submission/job status, encounters a problem, saves learning, or verifies a result. Include effective settings and concise evidence references where appropriate. Keep credentials out of events and preserve complete business outputs in result artifacts. A next-action statement describes intended work, not proof that it happened.
- Report phase changes, blockers, required human actions, recovery, and terminal outcomes. Emit bounded liveness updates during long quiet periods, distinguishing service liveness from observed task progress. Never imply the target job is progressing merely because the worker is alive; avoid invented percentage-complete estimates.
- The caller maintains a live consumption loop through a supported stream/subscription or successive bounded wait_operation calls. Get/wait results expose detailed events plus a resumable cursor, not only a state snapshot. Deliver notifications on compatible MCP hosts and provide structured wait results where notifications do not reach the calling model. A proposed CLI watch mode keeps its process connected and streams explicit NDJSON events; ordinary --json retains one parseable result. Specific transports, cadence, and per-wait limits remain open. A disconnect follows the confirmed continue-within-limits policy, independently of whether the original request or stream survives.
- Persist cumulative active-discovery time with the operation so reconnection, worker replacement, or service restart does not reset its allowance. Stop starting new exploratory actions when the allowance is consumed; settle any in-flight action and save the checkpoint/receipt before requesting help or an extension. Already-submitted target jobs may continue. Record any explicit extension without widening the permitted business-action scope.
- Reconnect using operation_id and the last consumed event cursor. Replay retained events in sequence, tolerate duplicate deliveries by event ID, and never create a fresh business operation merely to reconnect. Report an expired event cursor and the available recovery snapshot explicitly instead of implying a complete history. The caller harness must feed actionable events to its agent loop.
- Progress and handoff metadata belong to the operation control envelope. Preserve the simulated target response separately in api_response; a durable adapter operation does not change a synchronous target endpoint into an asynchronous one.

MCP progress is optional and tied to an active request; ordinary progress notifications stop when that request finishes. The Tasks extension also leaves exposure of status messages to the end user or model to the host. Therefore live notifications alone cannot guarantee that a waiting agent model sees updates. The proposed portable caller keeps a live consumption loop and receives structured execute/get/wait results, including detailed events, the next action, and the human-help descriptor when applicable; negotiated notifications or Tasks support can improve responsiveness. Verify that the selected caller harness feeds these updates into the agent loop and that it can act on a help request while the operation remains pending. Sources: [MCP progress](https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/progress), [MCP Tasks draft status visibility](https://tasks.extensions.modelcontextprotocol.io/specification/draft/tasks).

Proposed proof: an unknown endpoint is learned on its first invocation; status and human-help events are visible while it runs; a disconnected caller can recover status by operation ID without resubmission; partial learning survives interruption without being mislabelled verified; and a later call reuses committed knowledge after service/E2B replacement. A known incompatible field/settings range yields an explicit gap rather than endless rediscovery. Test notification-unaware callers using a connected wait loop as well as streaming clients. Verify event replay after disconnect, detailed updates reaching the calling agent, human-help handling before operation completion, and resumed consumption without repeated business actions.

### Human browser handoff through MCP/CLI

Build an application control page addressed to a durable handoff record and the worker's existing browser session/tab. MCP and CLI carry the handoff descriptor; the control page and browser backend provide the human interaction. No client-specific browser-transfer API is required for the baseline: the calling agent needs to display a link and instructions to its user, then query operation status.

Illustrative local handoff result; the port, identifiers, and path are examples, not a running service:

```json
{
  "operation_id": "op_123",
  "state": "waiting_for_human",
  "human_action": {
    "handoff_id": "handoff_456",
    "reason": "login_required",
    "instructions": "Sign in to Reducto in the controlled browser, then select Return control on this page.",
    "control_url": "http://127.0.0.1:8765/handoffs/handoff_456",
    "presentation": "local_window",
    "requires_browser_host": true
  }
}
```

Delivery modes:

| Mode                                          | What the human opens and controls                                                                                                                                                                              | Deployment requirement                                                                                                                                                                        |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `local_window` — initial Mac prototype        | The control page shows the task, reason, and controls to focus the existing visible worker browser and return ownership. The human interacts in that browser window; the dashboard does not claim to embed it. | Human and controlled browser are on the same machine. Implement and verify window/tab focusing for the selected backend.                                                                      |
| `streamed_browser` — required E2B server mode | The control page embeds an authenticated interactive view of the same sandbox browser, forwarding mouse/keyboard input while the human owns control.                                                           | E2B Desktop streaming and a reachable authenticated control service. Validate compatibility with the selected browser backend; Camofox's Mac desktop mode alone does not provide this stream. |

Camofox documents visible desktop mode for same-machine use and a separate noVNC path attached to its running Linux virtual display. These are backend capabilities to validate; our control page, routing, and ownership transitions still need implementation. Sources: [Camofox desktop mode](https://github.com/jo-inc/camofox-browser#interactive-desktop-browser), [Camofox VNC plugin](https://github.com/jo-inc/camofox-browser/blob/master/plugins/vnc/README.md).

Handoff lifecycle:

1. Stop scheduling browser actions and settle any in-flight action or record its uncertain outcome before making the browser available. Persist the handoff and operation state. A previously submitted remote job may continue while the browser is paused.
2. Return the same descriptor in the MCP tool result or CLI JSON output. The caller displays the control link and requested action to its human. Where the host supports URL elicitation, it may present an open-link interaction; ordinary results and status polling remain the portable baseline. Handle protocol-version differences inside the MCP adapter. Source: [MCP URL elicitation](https://ts.sdk.modelcontextprotocol.io/v2/servers/elicitation.html).
3. The human opens the control page and claims exclusive control. Keep the relevant live browser/session available during the configured handoff window, including preventing normal idle cleanup from closing it. Other agents remain queued and the caller receives status rather than credentials.
4. The human signs in or demonstrates the requested step, then selects **Return control** on the control page. This authenticated, idempotent transition releases human ownership. Opening the page or closing a window does not count as completion. Disable streamed input when ownership returns.
5. Reinspect the actual page, account, settings, and submission evidence; reconcile human actions before resuming the operation. A caller's `resume_operation` request cannot override active human ownership. The human's return-control action can schedule continuation without requiring the calling agent to stay connected; callers retrieve progress and results by the same operation ID.

A local URL works only when opened on the browser host. A remote calling agent can relay that URL to a human on the host, but cannot use it as remote desktop access. For E2B server mode, provide a reachable authenticated control service, including the browser stream's connection routes, and advertise its human-accessible base URL. The control page must connect to the existing sandbox browser rather than opening a new target-site session. Remote human handoff is required for server-mode acceptance. A reachable dashboard without a reachable live stream is insufficient for remote interaction.

Persist handoff IDs independently of control-link lifetimes. Use authenticated access scoped to the intended browser worker and renewable short-lived grants where needed; the URL must not contain target-site credentials. Expired links, a disconnected viewer, or an MCP/CLI timeout leave work paused until ownership is explicitly resolved. If the browser restarts or the sandbox is replaced, report lost live-page continuity and enter recovery; a durable handoff record does not restore unsaved form state. For an E2B pause/resume, inspect whether the original live browser survived before treating the handoff as continuous.

### MCP delivery

Use the official TypeScript MCP SDK as the proposed server implementation. Provide a local stdio bridge and authenticated Streamable HTTP access for server deployments, both connecting callers to the same execution service. A stdio bridge may also forward to a configured remote service; it must not create a separate browser owner. Keep diagnostics off the protocol's stdout. Pin the SDK and supported protocol revisions during implementation, and test actual host compatibility rather than assuming every client supports the newest revision. Sources: [MCP TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/v2/), [protocol-version support](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28).

Publish explicit input and output schemas for tools. Use structured results for the control envelope and distinguish tool execution failures from protocol errors. Endpoint descriptions expose required parameters and coverage gaps so a calling agent can construct valid requests. Human assistance must remain accessible through ordinary operation status and the deployment-appropriate control interface even when the MCP host lacks interactive elicitation support. Source for the tool schema/result model: [MCP tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools). Version-specific protocol behavior belongs in the MCP adapter; durable browser operations belong in the service.

### CLI delivery

Provide a versioned `browser-api` command with `--help`, JSON input from a file or stdin, explicit site/account/endpoint selection, and a noninteractive `--json` mode. In machine mode, stdout contains one structured result and diagnostics go to stderr. Specify stable exit codes for success, invalid/unsupported requests, human attention, execution failure, and an unfinished bounded wait. Include an operation ID whenever durable work has been accepted; provide `--no-wait` and a bounded `--wait-timeout`. Support an explicit service URL and service-access credentials from client configuration so the CLI can call either a local service or an E2B-backed server service. The server owns the E2B API key; the CLI caller needs service authorization, not that infrastructure key. Human login happens in the control browser, never through a hidden terminal prompt that stalls another agent.

Deliver copyable MCP host configuration, CLI invocation examples, and a caller guide showing schema inspection → invocation → in-call discovery when needed → progress/wait/human help → complete result retrieval. These examples use the same schemas and request IDs as the service.

### Interface acceptance checks

1. An external agent can discover each pilot's supported endpoint, construct a request from its schema, invoke it through MCP and CLI, and retrieve a contract-valid result. Compare equivalent test cases with the HTTP facade; do not replay a mutation merely to compare transports.
2. Concurrent MCP/CLI/HTTP callers share browser ownership correctly, including while a human owns the browser. A keyed retry through a different interface returns the same operation and does not submit twice.
3. Client disconnect, bounded-wait expiry, and service restart preserve operation tracking and results. Test ambiguous submission and cancellation after submission without falsely reporting success or rollback.
4. Human login/help requests reach the caller with specific next steps and a usable control link. Test same-machine handoff, a remote caller relaying to a local human, expired-link renewal, viewer/client disconnect, repeated Return control, browser restart, and a human-submitted job. Verify page continuity when available, explicit recovery when lost, and resumption without duplicate actions. Require the corresponding remote-human streaming test in E2B server mode.
5. Unsupported settings, invalid input, target API errors, and adapter failures remain distinguishable. Large JSON and file results are complete and retrievable, and CLI stdout remains parseable during diagnostics.

This section adds interface requirements and proposed contracts to the plan. No MCP server, CLI, or execution service has been implemented.

## Proposed first milestone

Powder's overview documents:

| Endpoint                      | Documented purpose                                        | UI mapping to investigate                                             |
| ----------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------- |
| `POST /file_uploads`          | Upload a document, optionally associated with a portfolio | Upload form, settings, portfolio selection, resulting upload identity |
| `GET /file_uploads/{id}`      | Retrieve processing status                                | Upload detail/status view and its state transitions                   |
| `GET /file_uploads/{id}/data` | Retrieve processed structured data                        | Result views, pagination, and available exports                       |

Source: [Powder API overview](https://docs.powderfi.com/docs/getting-started).

The overview also mentions `/configure_webhook`. UI feasibility is unverified. General CRUD support is not established by this page. The full endpoint schemas still need to be obtained and the authenticated UI has not been inspected. No exact field mappings or full API compatibility are established yet.

Proposed proof: complete upload → status → results for a known test document, then repeat with varied inputs and relevant failures. Test expired login, changed page structure, and interrupted submission. Measure correctness, warm-request latency, recovery frequency, and duplicate submissions; measure site processing time separately from adapter overhead.

## Reducto Parse pilot and adaptation test

Reducto Parse is the selected second application. The core target is `POST /parse`, executed through Reducto Studio. Investigate the upload dependency and propose asynchronous parsing/job retrieval as a subsequent coverage extension. Reducto documents synchronous `/parse` and asynchronous `/parse_async` operations, configurable parsing, and structured results. See the [Parse overview](https://docs.reducto.ai/parse/overview).

Proposed first Reducto proof: prepare a known document, configure the requested Parse settings in Studio, run once, retrieve the complete JSON output through the UI, and validate it against the selected endpoint schema. Repeat with unseen documents and different supported settings. Studio documents a JSON results view and download; actual export completeness must be verified in the supplied account. Source: [Studio Parse](https://docs.reducto.ai/studio-parse).

Reducto-specific parity checks:

- Confirm that the supplied processor is a Parse step and identify its effective configuration. A multi-step pipeline result must not be assumed to match a direct Parse response. Inspect current and saved settings before each run. Source: [Studio deployment and API export](https://docs.reducto.ai/studio-deploy-pipeline).
- Verify requested model/version, page range, chunking, table formatting, and applicable defaults. Record unsupported options and setting interactions. Source: [Parse overview](https://docs.reducto.ai/parse/overview).
- Inspect the full response envelope and all chunks/blocks, including identifiers, usage, duration, coordinates, and result links where the selected schema requires them. Preserve nulls and optional-field semantics; do not fabricate missing metadata. Verify inline and linked result variants separately. Source: [Parse response format](https://docs.reducto.ai/parse/response-format).
- For local test documents, establish how browser upload corresponds to the API's upload reference. Preserve the Parse contract's accepted input formats. Verify URL inputs, uploaded references, and previous-job reprocessing independently before claiming support. Source: [Parse overview](https://docs.reducto.ai/parse/overview).
- Preserve synchronous completion behavior for `/parse`. Treat async submission, polling, webhook delivery, and priority behavior as separate compatibility checks if that coverage is added. Source: [Async processing](https://docs.reducto.ai/workflows/async-overview).
- Verify evidence of a Studio run directly in the UI. Studio runs are documented as separate from API execution logs, so those logs cannot be presumed to contain the browser submission. Source: [Studio deployment](https://docs.reducto.ai/studio-deploy-pipeline).

Establish a useful supported flow alongside deliberately unsupported cases. A pilot that can only report unsupported endpoints is insufficient to demonstrate successful adaptation. Validate the declared supported pilot subset in both local and E2B modes before claiming deployment parity.

Proposed adaptation acceptance test:

1. Freeze a baseline of the shared engine after the first Powder workflow works. Register the second site using its specification, URL, account binding, and test-action scope, then invoke an endpoint with no learned recipe. Require that call to drive discovery and any needed human login, report progress, execute when feasible, and persist its learning.
2. Require the agent to produce its own site map, locators, input/output mappings, and verified recipes. Record human demonstrations and clarifications as onboarding effort. Handwritten site-specific execution code does not count as autonomous adaptation.
3. Exercise new documents and parameter combinations that were not used in learning. Withhold one configuration family or subsequent endpoint workflow from initial calls, then invoke it and require the same call-triggered discovery process. Verify subsequent calls reuse committed knowledge, including after E2B replacement and service restart.
4. Test an unexpected page state or changed navigation condition. Verify either a validated repair or a browser handoff with a precise request for help, including reconciliation of any action the human performs.
5. Report contract coverage and evidence per endpoint. Identify inaccessible fields, mismatched identifiers, unsupported settings, and behavioral differences. Required gaps prevent an exact-compatibility claim for the affected endpoint or input range.
6. Measure onboarding time, human interventions, manual code changes, execution correctness, latency, and recovery. Any shared-engine changes are recorded and followed by regression checks on both sites.

The objective is a reusable onboarding and execution mechanism with explicit supported coverage. Powder and Reducto test adaptation across two vendors' document-processing interfaces, settings, and response structures. Both are document-processing products; this pair does not establish general record CRUD capability or compatibility with every API or website. Broader claims require further workflow types and an unseen-site evaluation. Operations must remain performable and verifiable through the authenticated UI.

## Browser backend evaluation: Camofox and direct Playwright

Evaluate Camofox Browser as a candidate browser execution service alongside direct Playwright. Camofox wraps the Firefox-based Camoufox browser with an agent-facing REST API. Its documented capabilities include accessibility snapshots, element references, UI actions, screenshots, file uploads, and download retrieval. This REST interface controls browser UI operations; it does not authorize calls to the target site's private business APIs. Sources: [Camofox Browser](https://github.com/jo-inc/camofox-browser), [Camoufox Playwright compatibility](https://camoufox.com/python/usage/).

The proposed layering is Astra Ultra and the Agents SDK → application memory and workflow runner → replaceable browser adapter → Camofox or direct Playwright. Browser selection does not replace the application harness, site learning, durable recipes, operation reconciliation, or API response validation. The initial implementation uses the Agents SDK. Discovery and deterministic execution share the adapter interface for observations, actions, uploads/downloads, session lifecycle, and exclusive human or agent ownership.

Design constraints from the documentation and source review:

- Save semantic targets and observed selector strategies in recipes, then resolve them against the current page. Camofox's numbered element references are temporary and rebuilt as observations refresh. They must not become durable recipe identifiers. Its reference construction also excludes comboboxes and date/calendar controls; verify selector or keyboard fallbacks on real settings forms. Source: [reference construction and resolution](https://github.com/jo-inc/camofox-browser/blob/master/server.js#L2177).
- Start the local comparison with a visible browser to support human login and takeover in the same live session. Camofox's desktop mode is selected at startup; seamless conversion of an already-headless Mac session into a visible window has not been established. Its VNC plugin provides access to the running browser through Linux/Xvfb, a separate deployment option. Sources: [desktop mode](https://github.com/jo-inc/camofox-browser#interactive-desktop-browser), [VNC implementation](https://github.com/jo-inc/camofox-browser/blob/master/plugins/vnc/index.js).
- Check the dedicated-profile requirement explicitly. Camofox's persistence plugin saves authentication-related storage, including cookies and localStorage, with IndexedDB opt-in; this does not establish a full persistent browser profile or preserve live forms and tabs. Verify login survival after restart and retain application-level workflow checkpoints. Source: [persistence implementation](https://github.com/jo-inc/camofox-browser/blob/master/plugins/persistence/index.js).
- Keep upload and download handling within the UI boundary. Verify file selection, completed download capture, artifact retrieval, and complete result extraction on both pilots. Sources: [upload implementation](https://github.com/jo-inc/camofox-browser/blob/master/server.js#L3519), [download implementation](https://github.com/jo-inc/camofox-browser/blob/master/lib/downloads.js).

Proposed comparison during implementation, using pinned backend versions and equivalent documents, settings, and account conditions on Powder and Reducto. Begin locally, then validate the selected backend in a pinned E2B template:

1. Human login establishes an isolated session. Pause automation, transfer exclusive browser control, then resume after inspecting the resulting page.
2. Upload a known document, apply supported settings, submit once, verify completion, and retrieve complete output. Validate the response against the same pinned endpoint contract for each backend; record unavailable fields and behavior.
3. Hand control to the human midway through a settings form. Confirm the live page remains available, reconcile human changes, and resume without duplicate submission.
4. Restart the browser service and test authentication restoration and recovery from an application checkpoint. Distinguish restored login from restored in-progress page state.
5. Refresh snapshots and navigate between pages to verify that saved recipes re-resolve their targets. Exercise controls that require selector or keyboard fallback.
6. Compare correctness, adapter overhead, browser action count, human interventions, and recovery reliability. Measure site processing time separately. Select a backend from observed results and document remaining gaps.

Headless blocking and CAPTCHA are excluded by the agreed prototype assumptions. Stealth features are therefore not a selection requirement. Starting with a visible local window or an E2B virtual desktop with interactive streaming is compatible with those assumptions. Validate automated execution and human takeover in both required modes; strictly headless operation is not required for server mode.

This evaluation currently consists of a documentation and source review. No Camofox installation, benchmark, or authenticated pilot run has been performed.

## Open decisions

1. Confirm the initial endpoint subsets, obtain full contract snapshots, and identify the authenticated application routes from the supplied entry points.
2. Select concrete test data and any optional account-scoped allowance for extra exploratory writes/jobs. The default boundary is settled: perform only the requested business effect; extra test actions require a separately configured allowance.
3. Define remaining operation/job/handoff lifetimes, numerical latency targets, and detailed-event/heartbeat cadence. The 10-minute active-discovery default and continue-within-limits disconnect policy are settled. Validate detailed event delivery with one real caller, provisionally the current Codex desktop environment; exact client capabilities and transport are unverified. One account with queued browser interactions is the initial operating model.
4. Complete the agreed Camofox/direct Playwright comparison. The initial implementation uses the Agents SDK and Playwright; this no longer blocks coding.
5. Confirm Reducto's initial input modes/settings and whether the supplied Studio workspace is the dedicated test environment.
6. Select correctness references, such as known test fixtures and representative API responses.
7. Finalize MCP tool/CLI command names, supported MCP host versions, and control-envelope details. Validate local-window and E2B streamed-browser handoffs; choose their idle/expiry policy, pinned E2B template, and server control URL/authentication configuration. MCP, CLI, local testing, and E2B server support are confirmed requirements.
8. Select durable server storage and define retention, deletion, and invalidation separately for verified knowledge, account/operation data, artifacts, and authentication state. Knowledge survival after sandbox deletion and service restart is required.

## Application agent harness

The initial application uses the OpenAI Agents SDK in TypeScript as its agent runtime. Application code owns the durable execution loop, browser actions, response validation, and human takeover. Read-only reviewers and the planner use the requested Astra model with maximum reasoning.

The Codex desktop harness runs the development and planning session. The browser-agent application runs its own service using the Agents SDK. The SDK manages the agent loop, tool calls, sessions, tracing, and resumable approval flows; application code owns tools, persistence, and browser control. Source: [OpenAI Agents SDK](https://developers.openai.com/api/docs/guides/agents).

| Responsibility                                                            | Proposed component                                                                                                              |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Broad discovery, interpreting unfamiliar pages, and recovery              | Agents SDK with GPT-6 Astra (`gpt-6-astra`), maximum reasoning, and proactive subagent delegation                               |
| Page observations, navigation, form actions, uploads, and downloads       | Replaceable browser adapter; evaluate direct Playwright and Camofox, restricted to the agreed UI operations                     |
| Browser host and session lifecycle                                        | Required local testing and E2B server providers, selected through configuration                                                 |
| Fast execution of verified endpoint workflows                             | Deterministic recipe runner with input validation, state checks, and result verification                                        |
| Site knowledge, recipe versions, account mappings, and operation receipts | Persistent application storage outside browser workers, initially SQLite and versioned recipe files on a durable service volume |
| Human login, specific help requests, browser takeover, and resumption     | Application control interface with exclusive browser ownership                                                                  |
| API response mapping and contract checks                                  | Application code driven by the pinned API specification                                                                         |
| Access by other agents                                                    | MCP server and CLI over the same execution service; HTTP compatibility facade remains proposed                                  |

The SDK's approval features do not implement browser takeover by themselves. Build the pause, transfer of browser control, state reconciliation, and resume behavior explicitly. Run established recipes without a model decision for every browser action; invoke the agent when discovery or recovery is needed. The LLM is GPT-6 Astra (`gpt-6-astra`), explicitly selected by the user. Configure that model identifier explicitly for all agent reasoning roles; require an explicit change of model choice before substituting another model. Verify API access during implementation. The requested operating mode is Astra Ultra; the proposed SDK implementation is detailed below. Source: [GPT-6 Astra model documentation](https://developers.openai.com/api/docs/models/gpt-6-astra).

### Astra Ultra operating mode

The user's requested mode is Astra Ultra. OpenAI describes Ultra as maximum reasoning with automatic delegation of suitable independent work to subagents. Source: [OpenAI model modes](https://learn.chatgpt.com/docs/models).

The Agents SDK runtime implements this pattern with `model: "gpt-6-astra"`, Responses API `reasoning.effort: "max"`, and proactive subagent orchestration. The public Astra API documents efforts through `max`; `ultra` is a Codex/ChatGPT mode and must not be sent as an unsupported API effort value. This is an application implementation of the documented Ultra pattern; identical behavior to the Codex runtime has not been established. Source: [Astra API model documentation](https://developers.openai.com/api/docs/models/gpt-6-astra).

Use Astra with maximum reasoning for the coordinator and its reasoning subagents. Delegate bounded, independent tasks when they improve speed or quality, such as contract analysis or checking captured observations. Keep browser interactions under exclusive ownership and queue them for the single account; subagents do not gain simultaneous control of the browser. Established recipes retain their deterministic fast path.

## Proposed implementation starting point

- Shared TypeScript execution service with the confirmed MCP and CLI interfaces above, plus a proposed HTTP compatibility facade derived from the supplied API contract. Support local execution and E2B browser workers from the same service code.
- OpenAI Agents SDK as the implemented discovery and recovery harness, connected to the browser tools and application state described above.
- A replaceable browser adapter, comparing direct Playwright with Camofox before backend selection. Keep semantic target resolution and state assertions in the shared workflow contract. For the Playwright baseline, use [locators](https://playwright.dev/docs/locators) and [auto-waiting](https://playwright.dev/docs/actionability).
- A constrained workflow format interpreted by the browser runner, so recipes can be inspected, versioned, validated, and repaired.
- Required local and E2B session providers with explicit deployment configuration, server-side E2B credentials, compatible browser templates, and live human handoff in both modes.
- SQLite and versioned recipe files as an initial single-service storage choice on persistent local or server storage outside the E2B sandbox. Preserve the site map, workflow metadata, account-scoped identifiers, operation/handoff state, and complete artifacts across worker replacement.
- Astra Ultra as specified above: GPT-6 Astra (`gpt-6-astra`), maximum API reasoning, and proactive subagent orchestration for LLM-powered discovery, workflow learning, and recovery. The implemented harness remains distinct from the confirmed model and operating-mode choice.
- A control interface for human login, coverage review, and operations requiring attention: local browser-window handoff for testing, authenticated E2B browser streaming for server deployments. Preserve the supplied endpoint's response contract on the API interface.
- Serialize browser interactions and retain each unfinished operation's account page. The worker can serve independent accounts during job waits. Same-account interleaving requires future job correlation or per-operation tabs.

GPT-6 Astra, the requested Ultra operating mode, the initial one-account operating model, MCP/CLI access for other agents, and both local testing and E2B server deployment support are agreed. The initial technology choices are implemented; broader deployment and pilot acceptance remain pending, and numerical performance targets remain open.

Next acceptance work: run the implemented caller loop against a legitimate test-account workflow, verify its output and recovery behavior, then exercise the same flow in a pinned E2B environment. Disconnect continuation, detailed durable progress, and the configurable 10-minute discovery budget are implemented; broader pilot support is not yet certified.
