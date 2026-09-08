# Validation record — 2026-09-08

This implementation has protocol, browser, and recovery tests. It has not established Powder or Reducto API parity, production E2B operation, or compatibility with every website.

## Local automated checks

Final local run: `npm run check` passed TypeScript validation, **79 tests**, and the production build. Two live-model tests were explicitly skipped in the normal suite. All installed-Chromium tests ran.

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

## Remaining acceptance gates

- Human login to the dedicated Powder and Reducto test accounts, verification of the actual account/workspace and allowed navigation origins, and scoped test requests.
- Resolution of the public contract gaps in [pilot coverage](PILOT-COVERAGE.md), followed by semantic output and recovery evidence.
- An E2B key and pinned compatible Desktop template, tested with the same live browser for CDP automation and human streaming, including expiry/replacement.
- Camofox comparison and a real calling-agent host consuming progress and forwarding human handoffs.

External state lives on the service's persistent volume. A new E2B sandbox currently needs fresh human login; encrypted browser-authentication export/restore is not implemented.
