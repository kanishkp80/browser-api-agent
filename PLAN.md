# Browser API agent — working plan

Status: interactive planning; no implementation or authenticated site exploration yet.

Working directory: `/Users/kanishkp/workspace/browser-api-agent`. This `PLAN.md` is the maintained working plan; PDF exports are dated snapshots.

## Goal and agreed decisions

Build a reusable engine that accepts an API specification, learns a website through a legitimate user's browser session, and executes supported endpoint requests through that site's UI. Powder is the first test site; Reducto Parse is the second.

- Browser operations may use page content, DOM/accessibility, forms, uploads, and downloads.
- Business operations must go through the UI. Replaying authenticated network requests is outside the agreed scope.
- The first prototype runs locally with a dedicated browser profile.
- Use OpenAI GPT-6 Astra (`gpt-6-astra`) in Astra Ultra mode for discovery, workflow learning, unfamiliar-page reasoning, and recovery. The user has confirmed maximum reasoning with proactive delegation of useful independent work to subagents.
- Target exact behavior for a declared supported endpoint subset, with explicit coverage gaps.
- A dedicated test account will be available to exercise writes and jobs on test data during the implementation and validation phase.
- Human participation establishes or renews login. Proposed implementation: the user signs in directly in the controlled browser; credentials never enter prompts or learned site memory.
- Start with broad site discovery to understand the application's main navigation, entities, and workflow families, then investigate endpoint workflows in detail.
- When the agent is confused, give browser control back to the user and ask for specific help. The handoff should identify the unresolved step and what demonstration or clarification is needed.
- Start with one account and queued browser interactions. Numerical latency targets remain open; measure normal execution and recovery separately, and exclude remote job processing time from adapter overhead.
- Identify compatibility gaps clearly, with evidence and their effect on the supported endpoint contract.
- This stage is planning, not building or operating the target account.

## Selected pilot entry points

| Pilot | API contract source | Browser entry point supplied by the user |
| --- | --- | --- |
| Powder | [Powder API overview](https://docs.powderfi.com/docs/getting-started) | [powderfi.com](https://powderfi.com) |
| Reducto Parse | [Parse overview](https://docs.reducto.ai/parse/overview), [OpenAPI specification](https://docs.reducto.ai/openapi.json) | [Reducto Studio pipeline](https://studio.reducto.ai/pipeline/k9770z5snrtw8frtdjq64xw86n8e0vc2?new=true&processor=kh7cdy5k1vztms38mp3erw7d7d8e1fef) |

Use these as starting locations for authenticated discovery. The supplied Reducto pipeline/processor and Powder's post-login application route have not been inspected. API documents define the target contract; business operations use the browser UI. Snapshot and pin each available specification before validating compatibility. Reducto's OpenAPI URL is listed in its [documentation index](https://docs.reducto.ai/llms.txt); the complete schema has not yet been downloaded or validated.

## Proposed architecture

### 1. Contract intake and coverage

Parse routes, methods, inputs, response schemas, status codes, identifiers, pagination, and job semantics from the supplied specification. Track each endpoint as unexamined, mapped, verified, constrained, or unsupported. A valid response shape alone is insufficient to establish compatibility.

### 2. Discovery and durable knowledge

Explore the main navigation broadly to learn the application's entities, relationships, and workflow families, then investigate the workflows needed by the target endpoints. Record unexplored or ambiguous areas explicitly. Do not require an exhaustive crawl of every record before supporting the first endpoint.

Persist separately:

- A site map: page states, navigation paths, entity relationships, forms, controls, and relevant permissions.
- Endpoint recipes: input bindings, semantic locators, prerequisites, steps, waits, extraction rules, postconditions, and retry policy.
- Account-scoped state: entity identifiers and UI locations, operation receipts, job tracking, and session references.

Version recipes and record their verification evidence and applicable site/account configuration. Remember how to retrieve live data; do not silently serve stale remembered business values. Keep credentials and session secrets separate from reusable knowledge.

### 3. Recipe verification

Verify complete outcomes using authorized test data and settings. Check submitted settings, entity identity, resulting state, response values, and contract conformance. Learning where a submit button is does not establish that a workflow is safe to replay or that its result matches the endpoint.

Use the dedicated test account for this phase. Select concrete test documents and mutation boundaries before beginning authenticated validation; the current session remains planning only.

### 4. Fast execution

Validate request → resolve account and identifiers → select a verified recipe → acquire browser ownership → execute UI steps with lightweight assertions → verify outcome → extract and validate the API response.

Use deterministic browser actions for established recipes. Invoke the reasoning agent for uncovered operations, unexpected states, or bounded recovery. Prefer semantic locators, observed deep links, event-based waits, warm sessions, and complete table/download extraction where available. Measure speed; do not promise API-like latency before benchmarking the site.

### 5. Recovery and durable operations

Keep a durable operation record before submitting a mutation or job. On timeout, inspect whether submission succeeded before retrying. An uncertain outcome must not trigger blind replay. Reconcile using stable identifiers and available UI evidence; otherwise request human assistance through a separate control channel.

Checkpoint jobs so monitoring can resume after a worker restart. Match the target API's submission and polling contract; do not introduce a different asynchronous response format without explicitly declaring the compatibility change. Reauthentication pauses browser work and returns browser control to the user.

On ambiguity, pause automation and transfer exclusive browser control to the user. Ask a specific question or request a demonstration at the relevant page, including what the agent has already observed. After the user hands control back, inspect the resulting state, reconcile any actions the user performed, and verify an updated recipe before reusing it. Do not repeat a mutation merely because the human performed it outside the agent's execution trace.

## Proposed first milestone

Powder's overview documents:

| Endpoint | Documented purpose | UI mapping to investigate |
| --- | --- | --- |
| `POST /file_uploads` | Upload a document, optionally associated with a portfolio | Upload form, settings, portfolio selection, resulting upload identity |
| `GET /file_uploads/{id}` | Retrieve processing status | Upload detail/status view and its state transitions |
| `GET /file_uploads/{id}/data` | Retrieve processed structured data | Result views, pagination, and available exports |

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

Establish a useful supported flow alongside deliberately unsupported cases. A pilot that can only report unsupported endpoints is insufficient to demonstrate successful adaptation.

Proposed adaptation acceptance test:

1. Freeze a baseline of the shared engine after the first Powder workflow works. Onboard the second site using its specification, URL, human login, and test-action scope.
2. Require the agent to produce its own site map, locators, input/output mappings, and verified recipes. Record human demonstrations and clarifications as onboarding effort. Handwritten site-specific execution code does not count as autonomous adaptation.
3. Exercise new documents and parameter combinations that were not used in learning. Withhold one configuration family or subsequent endpoint workflow from initial onboarding, then ask the agent to learn it using the same discovery process.
4. Test an unexpected page state or changed navigation condition. Verify either a validated repair or a browser handoff with a precise request for help, including reconciliation of any action the human performs.
5. Report contract coverage and evidence per endpoint. Identify inaccessible fields, mismatched identifiers, unsupported settings, and behavioral differences. Required gaps prevent an exact-compatibility claim for the affected endpoint or input range.
6. Measure onboarding time, human interventions, manual code changes, execution correctness, latency, and recovery. Any shared-engine changes are recorded and followed by regression checks on both sites.

The objective is a reusable onboarding and execution mechanism with explicit supported coverage. Powder and Reducto test adaptation across two vendors' document-processing interfaces, settings, and response structures. Both are document-processing products; this pair does not establish general record CRUD capability or compatibility with every API or website. Broader claims require further workflow types and an unseen-site evaluation. Operations must remain performable and verifiable through the authenticated UI.

## Open decisions

1. Confirm the initial endpoint subsets, obtain full contract snapshots, and identify the authenticated application routes from the supplied entry points.
2. Select concrete test data and limits for discovery writes and jobs.
3. Define numerical latency targets; one account with queued browser interactions is the initial operating model.
4. Confirm the proposed Agents SDK harness and other implementation choices below.
5. Confirm Reducto's initial input modes/settings and whether the supplied Studio workspace is the dedicated test environment.
6. Select correctness references, such as known test fixtures and representative API responses.
7. Confirm the caller interface and how it receives requests for login or human attention.
8. Define retention and invalidation for site knowledge, account data, output artifacts, and session state.

## Proposed agent harness

Recommendation: use the OpenAI Agents SDK in TypeScript as the application's agent runtime. This is a proposal; no application harness has been implemented or selected as a final design decision.

The Codex desktop harness runs the development and planning session. The browser-agent application would run its own service using the Agents SDK. The SDK manages the agent loop, tool calls, sessions, tracing, and resumable approval flows; application code owns tools, persistence, and browser control. Source: [OpenAI Agents SDK](https://developers.openai.com/api/docs/guides/agents).

| Responsibility | Proposed component |
| --- | --- |
| Broad discovery, interpreting unfamiliar pages, and recovery | Agents SDK with GPT-6 Astra (`gpt-6-astra`), maximum reasoning, and proactive subagent delegation |
| Page observations, navigation, form actions, uploads, and downloads | Playwright tools restricted to the agreed UI operations |
| Fast execution of verified endpoint workflows | Deterministic recipe runner with input validation, state checks, and result verification |
| Site knowledge, recipe versions, account mappings, and operation receipts | Persistent application storage, initially SQLite and versioned recipe files |
| Human login, specific help requests, browser takeover, and resumption | Application control interface with exclusive browser ownership |
| API response mapping and contract checks | Application code driven by the pinned API specification |

The SDK's approval features do not implement browser takeover by themselves. Build the pause, transfer of browser control, state reconciliation, and resume behavior explicitly. Run established recipes without a model decision for every browser action; invoke the agent when discovery or recovery is needed. The LLM is GPT-6 Astra (`gpt-6-astra`), explicitly selected by the user. Configure that model identifier explicitly for all agent reasoning roles; require an explicit change of model choice before substituting another model. Verify API access during implementation. The requested operating mode is Astra Ultra; the proposed SDK implementation is detailed below. Source: [GPT-6 Astra model documentation](https://developers.openai.com/api/docs/models/gpt-6-astra).

### Astra Ultra operating mode

The user's requested mode is Astra Ultra. OpenAI describes Ultra as maximum reasoning with automatic delegation of suitable independent work to subagents. Source: [OpenAI model modes](https://learn.chatgpt.com/docs/models).

For the proposed Agents SDK runtime, implement this pattern with `model: "gpt-6-astra"`, Responses API `reasoning.effort: "max"`, and proactive subagent orchestration. The public Astra API documents efforts through `max`; `ultra` is a Codex/ChatGPT mode and must not be sent as an unsupported API effort value. This is an application implementation of the documented Ultra pattern; identical behavior to the Codex runtime has not been established. Source: [Astra API model documentation](https://developers.openai.com/api/docs/models/gpt-6-astra).

Use Astra with maximum reasoning for the coordinator and its reasoning subagents. Delegate bounded, independent tasks when they improve speed or quality, such as contract analysis or checking captured observations. Keep browser interactions under exclusive ownership and queue them for the single account; subagents do not gain simultaneous control of the browser. Established recipes retain their deterministic fast path.

## Proposed implementation starting point

- TypeScript service with a local HTTP interface derived from the supplied API contract.
- OpenAI Agents SDK as the proposed discovery and recovery harness, connected to the browser tools and application state described above.
- Playwright for browser control, with semantic locators and built-in actionability waits. See [locators](https://playwright.dev/docs/locators) and [auto-waiting](https://playwright.dev/docs/actionability).
- A constrained workflow format interpreted by the browser runner, so recipes can be inspected, versioned, validated, and repaired.
- SQLite for the local site map, workflow metadata, account-scoped identifiers, and durable operation state; versioned recipe files for review.
- Astra Ultra as specified above: GPT-6 Astra (`gpt-6-astra`), maximum API reasoning, and proactive subagent orchestration for LLM-powered discovery, workflow learning, and recovery. The harness recommendation remains distinct from this confirmed model and operating-mode choice.
- A separate local control interface for human login, coverage review, and operations requiring attention. Preserve the supplied endpoint's response contract on the API interface.
- Initially serialize browser interactions for one test account. Interleave short job-status checks with other work rather than holding browser ownership while a remote job processes.

GPT-6 Astra, the requested Ultra operating mode, and the initial one-account operating model are agreed. Other technology choices, including the Agents SDK harness, remain proposals; numerical performance targets remain open.

Next planning discussion: confirm the harness and caller interface, then settle the first milestone's contract, test data, and measurable acceptance criteria before implementation.
