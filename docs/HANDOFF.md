# Human browser handoff contract

A handoff pauses the shared browser queue and exposes `operation.human_action.control_url`. Open that URL in a browser on the service's configured origin. The page asks for the service bearer token and keeps it in that tab's `sessionStorage`; neither the service token nor the handoff capability is placed in a URL.

## Claim and access

`POST /v1/handoffs/{operation_id}/claim` requires the service bearer token and the configured same-origin `Origin` header. Exactly one request can claim a pending handoff. Its response contains:

```json
{
  "operation": { "human_action": { "claimed": true } },
  "claim_token": "per-handoff bearer capability"
}
```

The service stores only a SHA-256 verifier for `claim_token`. Polling the operation or event log never returns the token or verifier. Preserve the returned token until control is successfully returned. Send it in `X-Browser-Handoff-Token` for:

- `GET /v1/handoffs/{operation_id}/access`
- `POST /v1/handoffs/{operation_id}/return`

Competing claims receive `handoff_already_claimed`. Missing or incorrect capabilities receive `invalid_handoff_claim`.

## Returning control

The return body requires a note and one explicit outcome:

- `no_submission`: the human did not submit the requested job or change.
- `submitted`: the human submitted it.
- `unknown`: the human is unsure whether submission occurred.

The service durably records the outcome before it attempts to stop interactive browser access. While release is in progress, the operation remains `waiting_for_human` with `human_action.returning: true`; automated work stays blocked. `submitted` and `unknown` immediately establish submission evidence, so later execution is limited to read-only reconciliation.

Only one return attempt can release the browser at a time. If release fails, the operation reports `handoff_release_failed` and retains the claim. Retry with the same claim token and outcome; the original note remains the audit record. A different outcome receives `handoff_return_conflict`. A process restart invalidates the old claim and conservatively treats any interrupted claimed handoff as a possible submission.

## MCP and CLI

MCP exposes `claim_handoff`, `get_handoff_access`, and `return_handoff`. The claim token is a secret tool result and must be supplied to the latter two calls.

The CLI exposes `handoffs claim`, `handoffs access`, and `handoffs return`. Put the returned capability in `BROWSER_API_HANDOFF_TOKEN`, or name a different environment variable with `--claim-token-env`. Do not pass the capability as a command-line argument.
