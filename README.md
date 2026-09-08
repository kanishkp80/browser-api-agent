# Browser API agent

A TypeScript service that learns browser workflows during endpoint calls, keeps callers informed, and reuses observed workflows across later calls and service restarts. Browser operations use the UI; the model has no target-API, shell, or arbitrary JavaScript tool.

This is an initial implementation. Real Chromium, durable recovery, and MCP/CLI integration are tested against local fixtures. The live E2B infrastructure smoke also passes. Powder/Reducto API parity remains unverified.

## Run locally

Requires Node.js 22.16 or newer. Node 22 currently prints an experimental warning for its built-in SQLite module on stderr.

```sh
npm ci
npx playwright install chromium
npm run build
```

Supply `OPENAI_API_KEY` in the service environment, then run:

```sh
npm start
```

The service defaults to `http://127.0.0.1:8765`, a visible local Chromium browser, and a private `.browser-api` data directory. The browser opens only when an endpoint is invoked. Configuration is documented in [.env.example](.env.example); `.env` files are not loaded automatically. You can use Node's `--env-file` option or your process manager.

If `BROWSER_API_SERVICE_TOKEN` is unset, the local service creates `.browser-api/service-token`. Give the CLI/MCP client that token through its environment. Keep OpenAI and E2B credentials only in the service process.

```sh
export BROWSER_API_SERVICE_TOKEN="$(cat .browser-api/service-token)"
node dist/cli.js --help
```

## Call from another agent

Run one service. Use either MCP transport:

- **Stdio:** `node /absolute/path/to/browser-api-agent/dist/mcp.js`, with `BROWSER_API_SERVICE_URL` and `BROWSER_API_SERVICE_TOKEN` in the bridge environment. The bridge forwards to the running service.
- **Streamable HTTP:** connect to `http://127.0.0.1:8765/mcp` with `Authorization: Bearer <service-token>`. Use the server's HTTPS URL for remote deployments.

Tools include site registration/discovery, endpoint execution, operation inspection/waits, results, artifacts, cancellation, and resumption. Tool names and schemas are discoverable from the MCP server. The same process owns operations regardless of which transport a caller uses.

The caller loop is:

1. Register the site with its OpenAPI document, browser URL, account ID, and allowed login/navigation origins. HTTP/MCP execution also supports inline registration on the first request.
2. Inspect the endpoint schema and upload any input artifacts.
3. Execute with a stable caller-generated `request_id`. Save the returned operation ID.
4. Maintain `wait_operation` calls, passing the returned cursor. Consume detailed events and relay any `human_action.control_url` to the human.
5. Retrieve the completed result/artifacts. On a disconnect, reconnect to the same operation; do not submit a new request.

The CLI provides the same flow:

```sh
node dist/cli.js sites register --input site-registration.json
node dist/cli.js endpoints list --site my-site
node dist/cli.js artifacts upload document.pdf --media-type application/pdf
node dist/cli.js execute --site my-site --endpoint parseDocument --request-id parse-001 --input endpoint-input.json
node dist/cli.js events op_RETURNED_ID --watch
node dist/cli.js result op_RETURNED_ID
```

`endpoint-input.json` uses the endpoint's `path`, `query`, `headers`, and `body` wrapper as declared by schema discovery. Multipart binary fields use `{ "artifact_id": "art_<sha256>" }`. The caller's local path is never assumed to exist on the server. See [specimen inputs](examples/specimen-execute.json) and [specimen contract](examples/specimen-openapi.json).

CLI stdout is JSON; event watching emits NDJSON. Errors go to stderr with nonzero exit codes. `events --watch` returns control when human help or other attention is required, so the calling agent can act on it, and can be restarted from its last cursor.

## Human login and help

The handoff URL opens the service's control page. Enter the service access token there, claim the handoff, and use the existing browser. Passwords stay in the target site's browser UI. Afterward, select the submission outcome and return control. The claimant receives a private claim token required for access and return; competing claims are rejected. The service records the reported submission outcome before releasing browser control, then inspects the current page. See [handoff semantics](docs/HANDOFF.md). A new target-site tab opened outside this controlled session does not authenticate the worker.

Local mode requires the human to be on the browser's machine. A headless local worker reports that human handoff is unavailable. E2B mode supplies an authenticated stream of its live browser. Stream credentials are separate from the infrastructure API key.

## E2B server mode

Configure the service with:

```text
BROWSER_API_BROWSER_HOST=e2b
E2B_API_KEY=<server-side credential>
BROWSER_API_E2B_TEMPLATE=<pinned Desktop template>
BROWSER_API_DATA_DIR=<persistent volume outside E2B>
BROWSER_API_CONTROL_BASE_URL=https://your-control-service.example
BROWSER_API_SERVICE_TOKEN=<at least 32 non-whitespace characters>
```

The template must provide a compatible Linux desktop, `google-chrome`, Python 3, and `curl`, with Playwright CDP access to the same browser shown by the desktop stream. Chrome binds to loopback; an ephemeral bearer-authenticated relay carries browser control over TLS. Human desktop streaming uses separate session authentication. The provider renews the sandbox lifetime and tears it down when closed. Uploads transfer bytes with original filenames/MIME types. Knowledge, operations, and complete artifacts remain on the service volume.

Run the live E2B infrastructure smoke with a server-side key in `.env` or the process environment:

```sh
npm run smoke:e2b
```

Use `BROWSER_API_ENV_FILE` for a different environment file and `BROWSER_API_E2B_TEMPLATE` to select a template; the smoke defaults to `desktop`. It provisions a temporary sandbox, exercises a synthetic UI with upload/download, checks authenticated desktop streaming and return of control, and deletes its sandbox. It emits NDJSON progress and saves a desktop screenshot under `test-results/e2b-smoke/`. This test consumes E2B runtime and requires local Playwright Chromium for the stream viewer. It does not call Astra or a business website.

There is no silent local fallback. A live smoke against the E2B `desktop` template passed on 2026-09-08, including streamed keyboard input and return to the same automated browser. Production template pinning, expiry/replacement recovery, and pilot acceptance remain pending. A new E2B sandbox currently requires fresh human login; browser authentication export/restore is not implemented. E2B replacement does not discard committed knowledge or operation evidence.

## Verification

The final local check passed TypeScript validation, 87 tests, and the build. See [validation evidence and live-test limits](docs/VALIDATION.md).

```sh
npm run check
```

The suite exercises schema/ref handling, guarded parameter bindings, exactly-one service ownership, request deduplication, event replay, ambiguous submissions, discovery limits, human handoff, output grounding, artifact integrity, real Chromium uploads/downloads, cold-to-warm workflow execution after restart, real MCP SDK clients, and a CLI subprocess. Browser tests run when Chromium is installed; otherwise they are explicitly skipped. The live Astra smoke test is opt-in and uses a synthetic observation, with no vendor account actions.

The model is explicitly `gpt-6-astra` with maximum reasoning. There is no silent model fallback. Read-only reviewers and the planner use the same model. Model settings follow the [official Astra documentation](https://developers.openai.com/api/docs/models/gpt-6-astra); the application uses the [OpenAI Agents SDK](https://developers.openai.com/api/docs/guides/agents).

## Current scope

- OpenAPI 3.0/3.1 JSON objects, local document references, explicit input/output validation, and supported JSON/multipart mappings. Remote references, unsupported media/contract constructs, and unavailable UI fields produce explicit gaps.
- One service process and a serialized browser queue. Unfinished work retains its account page across job waits and attention pauses. Asynchronous recipes replay their preparation/submission prefix, then inspect live job state. Do not run multiple service replicas against the same data directory.
- A conservative submission guard supports one business-submission boundary per operation. Generic button clicks always consume that boundary; ambiguous preparation actions also stop for reconciliation. Multi-step writes, arbitrary menu buttons, and autosaves need further workflow modeling. UI-only automation cannot infer every website side effect from a locator.
- Complete response bodies come from captured UI JSON/downloads. General per-field aggregation into arbitrary API response shapes is not implemented.
- Browser authentication and target account/tenant identity must be validated in pilot testing. Camofox remains a planned comparison.
- No target-shaped HTTP facade, webhook emulation, multi-tenant isolation, or automatic artifact-retention policy yet.

Public Powder and Reducto contract snapshots, provenance, and identified compatibility blockers are documented in [pilot coverage](docs/PILOT-COVERAGE.md). No pilot endpoint is advertised as verified.

See [architecture and recovery](docs/ARCHITECTURE.md) and the [working plan](PLAN.md) for the requirements and remaining acceptance gates.
