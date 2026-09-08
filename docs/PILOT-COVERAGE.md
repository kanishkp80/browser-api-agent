# Pilot contract coverage

Status: public contract intake only, retrieved 2026-09-08. No authenticated browser workflow, target API request, upload, or job was executed. Every endpoint remains **browser-unexamined** and therefore unsupported until its UI recipe and complete response mapping are verified.

## Pinned public sources

| Pilot   | Local snapshot                                                                                                    | Public source                                                                                                                                                                                                     | Snapshot SHA-256                                                   | Canonical contract hash                                            | Compiler result                                                                                                                |
| ------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Powder  | [`examples/pilots/powder-pilot-openapi-2026-09-08.json`](../examples/pilots/powder-pilot-openapi-2026-09-08.json) | [Upload](https://docs.powderfi.com/reference/file_uploads-1), [Check Status](https://docs.powderfi.com/reference/file_uploads_status), and [Retrieve Data](https://docs.powderfi.com/reference/file_uploads_data) | `984b496d054aad7a44a845eed4b3568c6c6f4e762dbfdd167326329a1d690ed4` | `8da0177cc1c7d85ad2a4c2997003b6f75a760a0552b4f9dd12a6539e89bb9f99` | Three endpoints extracted; all extracted input and response schemas compile.                                                   |
| Reducto | [`examples/pilots/reducto-openapi-2026-09-08.json`](../examples/pilots/reducto-openapi-2026-09-08.json)           | [Published OpenAPI document](https://docs.reducto.ai/openapi.json), indexed by [Reducto's documentation index](https://docs.reducto.ai/llms.txt)                                                                  | `71bc688eeb13a036cbb83555763d61529cbb346d7136b8026b68d0f64b3b113b` | `3c33e5f6f4bae9ea11e46d02e31ed338d3c5d6b49f3d878b6da3be082d4bdb13` | Nineteen endpoints extracted; all extracted schemas compile. Strict validation exposes the `/parse` ambiguity described below. |

The snapshot SHA-256 hashes the checked-in bytes. The canonical contract hash is the application pin produced by `contractHash`, which is insensitive to object-key order and formatting.

Reducto publishes one complete OpenAPI 3.1 document. Its pinned snapshot is byte-for-byte identical to the downloaded document and reports API version `v1.12.12-114-g9808b824f237`.

Powder's public index does not list one aggregate OpenAPI file. Each selected reference page contains a standalone OpenAPI 3.0 definition. The Powder snapshot combines only the three published `paths` objects. Their `openapi`, `info`, `servers`, `components`, and `security` values were identical. No request or response schema was edited, and endpoints absent from those three sources were not invented.

## Coverage state vocabulary

| State                | Meaning                                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `contract-extracted` | The public operation was parsed into an `Endpoint`; this says nothing about website support.                          |
| `browser-unexamined` | The authenticated UI and its effective account configuration have not been observed.                                  |
| `candidate-scope`    | A proposed narrow input range for discovery and validation, not callable support.                                     |
| `verified`           | A UI recipe produced a complete contract-valid response for the declared range and passed replay and recovery checks. |
| `unsupported`        | Evidence proves a required input, outcome, or response field cannot be produced through the UI.                       |

No pilot endpoint is `verified` yet.

## Powder

The published routes are more specific than the overview's abbreviated paths:

| Operation key         | Published operation                           | Important contract details                                                                                                                                                                                                                                                                                                                                    | Current state                              |
| --------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `file_uploads`        | `POST /api/v1.0/public/file_uploads/`         | Multipart body fields: required `file` and `statement_type`; optional `portfolio_id` and `source_firm_id`. Published statement types are `brokerage`, `tax_forms`, `insurance_forms`, `will_forms`, `trust`, and `balance_sheet`. Responses: `201`, `400`, `403`, `422`, and `500`. The compiler represents binary `file` as a registered artifact reference. | `contract-extracted`, `browser-unexamined` |
| `file_uploads_status` | `GET /api/v1.0/public/file_uploads/{id}`      | Required integer path `id`. The `200` schema lists `uploaded`, `processing`, `in_review`, `done`, `failed`, `error`, and `closed`; a closed result may contain an error object. Also declares a bodyless `400`.                                                                                                                                               | `contract-extracted`, `browser-unexamined` |
| `file_uploads_data`   | `GET /api/v1.0/public/file_uploads/{id}/data` | Required integer path `id`; optional string query `include_bbox` with enum `true`, `1`, `false`, or `0` and documented default `false`. The `200` `data` field is a generic object whose actual shape varies by statement type. Also declares a bodyless `400`.                                                                                               | `contract-extracted`, `browser-unexamined` |

### Powder contract limitations found during compilation

1. The overview describes `portfolio_id` as a query parameter, while the endpoint OpenAPI definition places it in the multipart body. The endpoint definition is preserved in the snapshot; browser discovery must not guess which representation the website supports.
2. The upload schema requires `file` and `statement_type` inside the body, but the surrounding OpenAPI `requestBody` omits `required: true`. A standards-faithful validator therefore accepts an entirely missing body. We must narrow verified coverage to requests containing the body rather than treating this looseness as supported behavior.
3. The status and data `200` response object schemas declare no required fields. Consequently, even `{}` validates. Exact simulation needs observed response fixtures and stronger verified postconditions; schema validation by itself is insufficient.
4. The data schema intentionally leaves the statement-specific `data` payload open. The public examples describe several shapes, but the contract cannot prove complete brokerage, tax, trust, or balance-sheet parity.
5. Defaults remain annotations. The compiler does not insert `include_bbox: "false"`, and a recipe must distinguish an omitted setting from a value explicitly selected in the UI.

### Proposed first Powder candidate scope

Use this only to bound authenticated discovery:

- Upload one registered PDF artifact with `statement_type: "brokerage"` and omit `portfolio_id` and `source_firm_id`.
- Track only the ID returned by that successful upload through the status endpoint.
- Retrieve brokerage data with `include_bbox` omitted.
- Require the exact `201` and `200` bodies observed for the test account. Do not infer missing fields from examples.

Before promotion to `verified`, confirm the post-login route, upload ID, status transitions and terminal errors, result pagination or export behavior, and every response field available in the UI. Validation errors and other statement types remain separate coverage rows.

## Reducto Parse

The full public OpenAPI document extracts `POST /parse` as operation key `parse_parse_post`, with required JSON body and responses `200` and `422`. The [Parse overview](https://docs.reducto.ai/parse/overview) describes `/parse` as synchronous and `/parse_async` as a separate asynchronous endpoint. It documents input through an uploaded `reducto://` file ID, a public or presigned URL, or a previous `jobid://` result.

The intended pilot endpoint is only `POST /parse`. The other eighteen extracted Reducto operations are not part of this initial coverage claim.

### Blocking published-schema ambiguity

The published `/parse` request body is:

```text
oneOf:
  - SyncParseConfig
  - AsyncParseConfig
```

Both referenced schemas require only `input`; neither sets `additionalProperties: false`. `AsyncParseConfig` adds optional async and queue fields, so a documented minimal request such as `{ "input": "reducto://…" }` matches both branches. JSON Schema `oneOf` requires exactly one branch and the strict validator correctly rejects that request with both branch indexes in `passingSchemas`.

This prevents using the unmodified public `/parse` request schema as a reliable validation gate. It must be resolved explicitly before onboarding. The recommended resolution is a reviewed pilot profile that selects the published `SyncParseConfig` component for the synchronous `/parse` route and the published `ParseResponse` component for its success response. That profile would be a documented compatibility decision derived from the sources, not a claim that the pinned vendor document said something different. The raw snapshot remains the immutable provenance record.

### Reducto upload dependency

The API's local-file flow calls `/upload` first and passes its returned file ID to `/parse`. The Studio workflow supplied for browser exploration may accept a local file directly, but that does not by itself establish the target API's two-operation behavior.

The public `/upload` operation also advertises both `application/json` and `multipart/form-data` for one body schema. The current compiler deterministically selects JSON when both are present and records this exact gap:

```json
{
  "area": "request_content",
  "unsupported_media_types": ["multipart/form-data"]
}
```

Because artifact-reference transformation is tied to multipart selection, the compiled Reducto upload endpoint does not yet accept a browser-api artifact reference. This does not affect extraction of `/parse`, but it blocks an exact local-file `/upload` → `/parse` API flow until media selection is explicit.

### Proposed first Reducto candidate scope

After resolving the synchronous schema profile, begin with:

- `POST /parse` using one string `input` and no optional configuration fields.
- A pre-existing test-account `reducto://` file ID or a controlled public URL, so `/upload` is not silently simulated inside `/parse`.
- Only the full inline `ParseResponse` variant at first. The published response can also be a URL result for large output; that is a separate required coverage row before larger files are supported.
- Exact preservation of `job_id`, `duration`, `usage`, `result`, and any returned optional fields. If Studio cannot expose one of these fields, the response range is unsupported rather than synthesized.

A browser-api artifact cannot be accepted as the target `/parse` `input` without declaring an adapter extension or adding verified `/upload` coverage. Page ranges, chunking, formatting, agentic settings, arrays of inputs, prior-job input, async behavior, and linked results remain outside this first candidate scope.

## Reproducible compiler checks

The checked-in snapshots were loaded as JSON and passed directly to `compileContract` after `npm run build`:

| Check                                     | Result                                                                                                     |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Powder endpoint extraction                | 3 endpoints; no compiler-declared media gaps                                                               |
| Reducto endpoint extraction               | 19 endpoints; one compiler-declared gap on `/upload` multipart request content                             |
| JSON Schema compilation                   | Every extracted input and response schema in both snapshots compiles in the configured Ajv dialect         |
| Powder valid upload input                 | Registered artifact reference plus `statement_type: "brokerage"` validates                                 |
| Powder missing upload body                | Validates because the published `requestBody` is optional; recorded above as a contract limitation         |
| Powder empty status/data `200` object     | Validates because those published schemas have no required fields; recorded above as a contract limitation |
| Reducto documented minimal `/parse` input | Fails strict `oneOf` because both sync and async branches match; recorded above as blocking                |

These are contract tests, not authenticated product tests. Promotion requires a legitimate test-account login, UI-only execution, exact output extraction, deterministic replay, and recovery checks in both local and E2B modes.

## Decisions required before authenticated discovery

1. Approve the narrow Powder brokerage/PDF candidate or choose different statement types and optional fields.
2. Choose whether to create the explicit Reducto synchronous validation profile or wait for a corrected published schema.
3. Decide whether the first Reducto run uses an existing file ID/public URL, adds `/upload` to the pilot, or declares a browser-api artifact adapter extension.
4. Select small, sanitized fixtures and expected response evidence for both sites.
5. Confirm which dynamic response fields must be observable in each UI. Required but inaccessible fields make that response range unsupported.
