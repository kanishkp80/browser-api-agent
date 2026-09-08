# Validation record — 2026-09-08

This implementation has protocol, browser, and recovery tests. It has not established Powder or Reducto API parity, production E2B operation, or compatibility with every website.

## Local automated checks

Final local run: `npm run check` passed TypeScript validation, **87 tests**, and the production build. Two live-model tests were explicitly skipped in the normal suite. All installed-Chromium tests ran.

Run `npm run check` after installing Node 22 and Playwright Chromium. The tests exercise:

- OpenAPI intake, local references, strict request/response validation, and the pinned public pilot documents.
- Guarded input bindings and artifact MIME constraints, with observed workflow coverage distinct from API parity.
- Durable request deduplication, ordered progress replay, discovery budgets, uncertain submissions, and human control.
- Browser-page ownership through job waits, fresh extraction provenance, response-gap invalidation, and cancellation races.
- A real Chromium upload/result/download UI and replay on a different document after service replacement, using an injected deterministic planner.
- Official MCP clients over a real stdio subprocess, in-memory transport, and real Streamable HTTP, plus a CLI subprocess producing NDJSON events.
- Two real service-owner processes, lock contention, SIGKILL recovery, artifact metadata identity, and digest corruption detection.

Tests that require Chromium explicitly skip when its executable is absent. CI installs Chromium before running checks. Live model tests are opt-in and are not silently substituted for the deterministic regression suite.

## Live Astra evidence and limitation

The selected model is `gpt-6-astra`, with maximum reasoning for the planner and its two bounded, parallel, read-only reviewers. No fallback model was used.

A synthetic cold-decision smoke test completed through the Agents SDK, including both reviewers and the planner. A subsequent complete agent-to-Chromium workflow test did not complete: an initial reviewer response was incomplete at the original small token allowance. After increasing the allowances, the provider returned HTTP 402 because the request would exceed available credits with current in-flight requests. No business submission occurred in those failed runs.

The implementation now allows 16,384 tokens per reviewer and 32,768 for the planner, while constraining the final structured output. These allowances include the model's reasoning. A failed reviewer aborts and settles its sibling before the operation reports attention. The full autonomous cold-to-warm browser test remains **unverified** until one uninterrupted run can complete with sufficient provider capacity.

Opt-in commands use the existing server-side OpenAI key:

```sh
RUN_LIVE_ASTRA=1 npm test -- test/discovery.test.ts
RUN_LIVE_WORKFLOW=1 npm test -- test/live-workflow.test.ts
```

The full workflow test keeps its success, complete-output, new-input, and no-planner-replay assertions. It was not weakened to accommodate the provider failure.

## Live E2B evidence

`npm run smoke:e2b` passed on 2026-09-08 using the E2B `desktop` template and the configured server-side key. The complete run took **22.4 seconds** and confirmed:

- A real Chrome browser in E2B, observed and controlled through the production provider.
- UI form entry, file upload with original filename and contents, submission, and exact JSON extraction.
- A complete 107-byte JSON download retrieved from the sandbox and matched against the expected body.
- Authenticated noVNC streaming with a visible desktop framebuffer. Keyboard input through the viewer changed the URL of the same browser, and automation resumed after the stream stopped.
- Raw Chrome CDP was not publicly reachable; the relay returned HTTP 401 without its ephemeral bearer credential.
- Zero remaining sandboxes tagged for the run and no cleanup failures.

The smoke exposed and fixed Chrome readiness/process lifetime issues, public CDP routing, and Playwright's use of local filesystem paths for remote downloads. Regression tests cover the relay's HTTP/WebSocket authentication, startup deadlines, remote download collection/size limits, and cleanup. The smoke uses only a synthetic fixture; it does not call Astra or perform Powder/Reducto account operations. The tested `desktop` alias is not a pinned production template.

The script accepts `.env` or process environment credentials, an optional `BROWSER_API_ENV_FILE`, and an optional `BROWSER_API_E2B_TEMPLATE`. It emits NDJSON progress, captures a desktop screenshot under `test-results/e2b-smoke/`, enforces an overall deadline, and cleans up its tagged sandboxes.

## Remaining acceptance gates

- Human login to the dedicated Powder and Reducto test accounts, verification of the actual account/workspace and allowed navigation origins, and scoped test requests.
- Resolution of the public contract gaps in [pilot coverage](PILOT-COVERAGE.md), followed by semantic output and recovery evidence.
- A pinned production E2B Desktop template and live expiry/replacement recovery; the synthetic same-browser automation/streaming smoke now passes.
- Camofox comparison and a real calling-agent host consuming progress and forwarding human handoffs.

External state lives on the service's persistent volume. A new E2B sandbox currently needs fresh human login; encrypted browser-authentication export/restore is not implemented.
