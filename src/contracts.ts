import { createHash } from "node:crypto";

import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { Ajv2020 } from "ajv/dist/2020.js";

import { AppError } from "./errors.js";
import type { ApiResponse, Endpoint, Json, JsonObject } from "./types.js";

const DRAFT_07 = "http://json-schema.org/draft-07/schema#";
const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";
const HTTP_METHODS = [
  "delete",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
  "trace",
] as const;
const HTTP_METHOD_SET = new Set<string>(HTTP_METHODS);

type UnknownRecord = Record<string, unknown>;

interface ContractContext {
  readonly spec: JsonObject;
  readonly version: string;
  readonly is31: boolean;
  readonly resolver: LocalResolver;
}

interface ContentSelection {
  readonly mediaType: string;
  readonly schema: Json | undefined;
  readonly skipped: string[];
}

function isRecord(value: unknown): value is UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function jsonForError(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}

function contractError(message: string, details?: Json): AppError {
  return new AppError("invalid_contract", message, 400, details);
}

function unsupportedContract(message: string, details?: Json): AppError {
  return new AppError("unsupported_contract", message, 422, details);
}

function assertJson(value: unknown, path = "$"): asserts value is Json {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw contractError(`Contract contains a non-finite number at ${path}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJson(item, `${path}/${index}`));
    return;
  }
  if (!isRecord(value))
    throw contractError(`Contract contains a non-JSON value at ${path}`);
  for (const [key, child] of Object.entries(value))
    assertJson(child, `${path}/${escapePointerSegment(key)}`);
}

function canonical(value: Json): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw contractError("Contract contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value))
    return `[${value.map((item) => canonical(item)).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`)
    .join(",")}}`;
}

function escapePointerSegment(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

function decodePointerSegment(segment: string, ref: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    throw contractError(`Invalid percent escape in local reference ${ref}`);
  }
  if (/~(?:[^01]|$)/u.test(decoded))
    throw contractError(
      `Invalid JSON Pointer escape in local reference ${ref}`,
    );
  return decoded.replaceAll("~1", "/").replaceAll("~0", "~");
}

function scanReferences(value: Json, path = "$"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanReferences(item, `${path}/${index}`));
    return;
  }
  if (!isRecord(value)) return;
  const ref = value.$ref;
  if (ref !== undefined) {
    if (typeof ref !== "string")
      throw contractError(`$ref at ${path} must be a string`);
    if (ref !== "#" && !ref.startsWith("#/")) {
      throw unsupportedContract(
        "Remote and non-pointer references are not supported",
        {
          path,
          ref,
        },
      );
    }
  }
  for (const [key, child] of Object.entries(value))
    scanReferences(child as Json, `${path}/${escapePointerSegment(key)}`);
}

class LocalResolver {
  constructor(private readonly root: JsonObject) {}

  resolve(value: Json, referenceStack: readonly string[] = []): Json {
    if (Array.isArray(value))
      return value.map((item) => this.resolve(item, referenceStack));
    if (!isRecord(value)) return value;

    const ref = value.$ref;
    if (ref !== undefined) {
      if (typeof ref !== "string") throw contractError("$ref must be a string");
      if (ref !== "#" && !ref.startsWith("#/")) {
        throw unsupportedContract(
          "Remote and non-pointer references are not supported",
          { ref },
        );
      }
      if (referenceStack.includes(ref)) {
        throw unsupportedContract(
          "Circular local references are not supported in compiled endpoint schemas",
          {
            refs: [...referenceStack, ref],
          },
        );
      }
      const target = this.lookup(ref);
      const resolvedTarget = this.resolve(target, [...referenceStack, ref]);
      const siblings = Object.entries(value).filter(([key]) => key !== "$ref");
      if (siblings.length === 0) return resolvedTarget;
      if (!isRecord(resolvedTarget)) {
        throw contractError(
          `Reference ${ref} has siblings but does not resolve to an object`,
        );
      }
      const merged = Object.fromEntries([
        ...Object.entries(resolvedTarget),
        ...siblings,
      ]) as JsonObject;
      return this.resolve(merged, referenceStack);
    }

    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        this.resolve(child as Json, referenceStack),
      ]),
    ) as JsonObject;
  }

  private lookup(ref: string): Json {
    if (ref === "#") return this.root;
    const rawSegments = ref.slice(2).split("/");
    let current: Json = this.root;
    for (const rawSegment of rawSegments) {
      const segment = decodePointerSegment(rawSegment, ref);
      if (!isRecord(current) && !Array.isArray(current)) {
        throw contractError(
          `Local reference ${ref} traverses a non-container value`,
        );
      }
      if (!hasOwn(current, segment))
        throw contractError(`Local reference ${ref} does not exist`);
      current = (current as Record<string, Json>)[segment]!;
    }
    return current;
  }
}

function requireRecord(value: unknown, description: string): UnknownRecord {
  if (!isRecord(value)) throw contractError(`${description} must be an object`);
  return value;
}

function optionalArray(value: unknown, description: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw contractError(`${description} must be an array`);
  return value;
}

function requireString(value: unknown, description: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw contractError(`${description} must be a non-empty string`);
  return value;
}

function normalizeSchema(raw: Json, is31: boolean): Json {
  if (typeof raw === "boolean") {
    if (!is31) throw contractError("Boolean schemas require OpenAPI 3.1");
    return raw;
  }
  if (!isRecord(raw))
    throw contractError(
      "Schema must be an object or, for OpenAPI 3.1, a boolean",
    );

  const result = Object.fromEntries(Object.entries(raw)) as JsonObject;
  const schemaKeys = [
    "additionalProperties",
    "contains",
    "contentSchema",
    "else",
    "if",
    "items",
    "not",
    "propertyNames",
    "then",
    "unevaluatedItems",
    "unevaluatedProperties",
  ];
  for (const key of schemaKeys) {
    const child = result[key];
    if (child !== undefined && (isRecord(child) || typeof child === "boolean"))
      result[key] = normalizeSchema(child, is31);
  }
  for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
    const children = result[key];
    if (Array.isArray(children))
      result[key] = children.map((child) => normalizeSchema(child, is31));
  }
  for (const key of [
    "$defs",
    "definitions",
    "dependentSchemas",
    "patternProperties",
    "properties",
  ]) {
    const children = result[key];
    if (isRecord(children)) {
      result[key] = Object.fromEntries(
        Object.entries(children).map(([name, child]) => [
          name,
          normalizeSchema(child as Json, is31),
        ]),
      );
    }
  }

  if (!is31) {
    if (typeof result.exclusiveMinimum === "boolean") {
      if (result.exclusiveMinimum && typeof result.minimum === "number")
        result.exclusiveMinimum = result.minimum;
      else delete result.exclusiveMinimum;
      if (result.exclusiveMinimum !== undefined) delete result.minimum;
    }
    if (typeof result.exclusiveMaximum === "boolean") {
      if (result.exclusiveMaximum && typeof result.maximum === "number")
        result.exclusiveMaximum = result.maximum;
      else delete result.exclusiveMaximum;
      if (result.exclusiveMaximum !== undefined) delete result.maximum;
    }
  }

  if (result.nullable === true) {
    delete result.nullable;
    const schemaType = result.type;
    if (typeof schemaType === "string")
      result.type = schemaType === "null" ? "null" : [schemaType, "null"];
    else if (Array.isArray(schemaType) && !schemaType.includes("null"))
      result.type = [...schemaType, "null"];
    else if (schemaType === undefined)
      return { anyOf: [result, { type: "null" }] };
    if (Array.isArray(result.enum) && !result.enum.includes(null))
      result.enum = [...result.enum, null];
  }
  return result;
}

function resolvedSchema(raw: unknown, context: ContractContext): Json {
  if (!isRecord(raw) && typeof raw !== "boolean")
    throw contractError("Schema must be an object or boolean");
  const resolved = context.resolver.resolve(raw as Json);
  return normalizeSchema(resolved, context.is31);
}

function makeObjectSchema(
  properties: Array<[string, Json]>,
  required: string[],
): JsonObject {
  return {
    type: "object",
    properties: Object.fromEntries(properties) as JsonObject,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

function operationParameters(
  pathItem: UnknownRecord,
  operation: UnknownRecord,
  context: ContractContext,
  endpoint: string,
): UnknownRecord[] {
  const merged = new Map<string, UnknownRecord>();
  for (const raw of [
    ...optionalArray(
      pathItem.parameters,
      `Path-level parameters for ${endpoint}`,
    ),
    ...optionalArray(
      operation.parameters,
      `Operation parameters for ${endpoint}`,
    ),
  ]) {
    if (!isRecord(raw))
      throw contractError(`A parameter for ${endpoint} is not an object`);
    const resolved = context.resolver.resolve(raw as Json);
    const parameter = requireRecord(resolved, `A parameter for ${endpoint}`);
    const name = requireString(
      parameter.name,
      `Parameter name for ${endpoint}`,
    );
    const location = requireString(
      parameter.in,
      `Location for parameter ${name}`,
    );
    merged.set(`${location}\u0000${name}`, parameter);
  }
  return [...merged.values()];
}

function chooseRequestContent(
  content: UnknownRecord,
  endpoint: string,
): ContentSelection {
  const names = Object.keys(content).sort();
  const json = names.find((name) => isJsonMediaType(name));
  const multipart = names.find(
    (name) => name.toLowerCase() === "multipart/form-data",
  );
  const selected = json ?? multipart;
  if (selected === undefined) {
    throw unsupportedContract(
      `Request body for ${endpoint} has no supported media type`,
      {
        endpoint,
        content_types: names,
        supported: [
          "application/json",
          "application/*+json",
          "multipart/form-data",
        ],
      },
    );
  }
  const media = requireRecord(
    content[selected],
    `Media type ${selected} for ${endpoint}`,
  );
  return {
    mediaType: selected,
    schema: media.schema as Json | undefined,
    skipped: names.filter((name) => name !== selected),
  };
}

function chooseResponseContent(
  content: UnknownRecord,
  endpoint: string,
  status: string,
): ContentSelection {
  const names = Object.keys(content).sort();
  const selected = names.find((name) => isJsonMediaType(name));
  if (selected === undefined) {
    throw unsupportedContract(
      `Response ${status} for ${endpoint} has no supported JSON media type`,
      {
        endpoint,
        status,
        content_types: names,
        supported: ["application/json", "application/*+json"],
      },
    );
  }
  const media = requireRecord(
    content[selected],
    `Response media type ${selected} for ${endpoint}`,
  );
  return {
    mediaType: selected,
    schema: media.schema as Json | undefined,
    skipped: names.filter((name) => name !== selected),
  };
}

function isJsonMediaType(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized === "application/json" ||
    /^application\/[a-z0-9!#$&^_.+-]+\+json$/u.test(normalized)
  );
}

function artifactReferenceSchema(description?: Json): JsonObject {
  return {
    type: "object",
    description:
      typeof description === "string"
        ? `${description} Supply a registered browser-api artifact reference.`
        : "Supply a registered browser-api artifact reference; raw client and sandbox paths are not accepted.",
    properties: {
      artifact_id: {
        type: "string",
        minLength: 1,
        description:
          "Stable artifact identifier returned by the browser-api artifact interface.",
      },
    },
    required: ["artifact_id"],
    additionalProperties: false,
    "x-browser-api-artifact-reference": true,
  };
}

function transformMultipartArtifacts(schema: Json): Json {
  if (typeof schema === "boolean") return schema;
  if (!isRecord(schema)) return schema;
  if (schema.type === "string" && schema.format === "binary")
    return artifactReferenceSchema(schema.description as Json | undefined);

  const result = Object.fromEntries(Object.entries(schema)) as JsonObject;
  if (isRecord(result.properties)) {
    result.properties = Object.fromEntries(
      Object.entries(result.properties).map(([name, child]) => [
        name,
        transformMultipartArtifacts(child as Json),
      ]),
    );
  }
  if (
    result.items !== undefined &&
    (isRecord(result.items) || typeof result.items === "boolean")
  ) {
    result.items = transformMultipartArtifacts(result.items);
  }
  for (const key of ["allOf", "anyOf", "oneOf"]) {
    const children = result[key];
    if (Array.isArray(children))
      result[key] = children.map((child) => transformMultipartArtifacts(child));
  }
  return result;
}

function compileOperation(
  path: string,
  method: string,
  pathItem: UnknownRecord,
  operation: UnknownRecord,
  context: ContractContext,
): Endpoint {
  const fallbackKey = `${method.toUpperCase()} ${path}`;
  const key =
    typeof operation.operationId === "string" &&
    operation.operationId.length > 0
      ? operation.operationId
      : fallbackKey;
  const summary =
    typeof operation.summary === "string"
      ? operation.summary
      : typeof operation.description === "string"
        ? operation.description
        : fallbackKey;
  const gaps: Json[] = [];

  const pathProperties: Array<[string, Json]> = [];
  const queryProperties: Array<[string, Json]> = [];
  const requiredPath: string[] = [];
  const requiredQuery: string[] = [];

  for (const parameter of operationParameters(
    pathItem,
    operation,
    context,
    key,
  )) {
    const name = requireString(parameter.name, `Parameter name for ${key}`);
    const location = requireString(
      parameter.in,
      `Location for parameter ${name} in ${key}`,
    );
    if (location !== "path" && location !== "query") {
      throw unsupportedContract(
        `Parameter ${name} in ${key} uses unsupported location ${location}`,
        {
          endpoint: key,
          parameter: name,
          location,
          supported: ["path", "query"],
        },
      );
    }
    if (parameter.content !== undefined) {
      throw unsupportedContract(
        `Content-based parameter ${name} in ${key} is not supported`,
        {
          endpoint: key,
          parameter: name,
        },
      );
    }
    if (parameter.schema === undefined)
      throw contractError(`Parameter ${name} in ${key} has no schema`);
    const schema = resolvedSchema(parameter.schema, context);
    if (location === "path") {
      if (parameter.required !== true)
        throw contractError(
          `Path parameter ${name} in ${key} must be required`,
        );
      pathProperties.push([name, schema]);
      requiredPath.push(name);
    } else {
      queryProperties.push([name, schema]);
      if (parameter.required === true) requiredQuery.push(name);
    }
  }

  const templateParameters = [...path.matchAll(/\{([^{}]+)\}/gu)].map(
    (match) => match[1]!,
  );
  const declaredPathParameters = pathProperties.map(([name]) => name);
  const missingPathParameters = templateParameters.filter(
    (name) => !declaredPathParameters.includes(name),
  );
  const extraPathParameters = declaredPathParameters.filter(
    (name) => !templateParameters.includes(name),
  );
  if (missingPathParameters.length > 0 || extraPathParameters.length > 0) {
    throw contractError(
      `Path template and path parameters do not match for ${key}`,
      {
        endpoint: key,
        missing_path_parameters: missingPathParameters,
        extra_path_parameters: extraPathParameters,
      },
    );
  }

  const inputProperties: Array<[string, Json]> = [
    ["path", makeObjectSchema(pathProperties, requiredPath)],
    ["query", makeObjectSchema(queryProperties, requiredQuery)],
  ];
  const requiredInput: string[] = [];
  if (requiredPath.length > 0) requiredInput.push("path");
  if (requiredQuery.length > 0) requiredInput.push("query");

  if (operation.requestBody !== undefined) {
    if (!isRecord(operation.requestBody))
      throw contractError(`Request body for ${key} must be an object`);
    const requestBody = requireRecord(
      context.resolver.resolve(operation.requestBody as Json),
      `Request body for ${key}`,
    );
    const content = requireRecord(
      requestBody.content,
      `Request body content for ${key}`,
    );
    const selection = chooseRequestContent(content, key);
    let bodySchema =
      selection.schema === undefined
        ? true
        : resolvedSchema(selection.schema, context);
    if (selection.mediaType.toLowerCase() === "multipart/form-data")
      bodySchema = transformMultipartArtifacts(bodySchema);
    inputProperties.push(["body", bodySchema]);
    if (requestBody.required === true) requiredInput.push("body");
    if (selection.skipped.length > 0) {
      gaps.push({
        area: "request_content",
        unsupported_media_types: selection.skipped,
      });
    }
  }

  const inputSchema: JsonObject = {
    $schema: context.is31 ? DRAFT_2020_12 : DRAFT_07,
    type: "object",
    properties: Object.fromEntries(inputProperties) as JsonObject,
    ...(requiredInput.length > 0 ? { required: requiredInput } : {}),
    additionalProperties: false,
    "x-browser-api-openapi-version": context.version,
  };

  const responsesRaw = requireRecord(
    operation.responses,
    `Responses for ${key}`,
  );
  if (Object.keys(responsesRaw).length === 0)
    throw contractError(`Operation ${key} has no responses`);
  const responses: Endpoint["responses"] = Object.create(
    null,
  ) as Endpoint["responses"];

  for (const originalStatus of Object.keys(responsesRaw).sort()) {
    const normalizedStatus =
      originalStatus.toLowerCase() === "default"
        ? "default"
        : originalStatus.toUpperCase();
    if (
      normalizedStatus !== "default" &&
      !/^[1-5](?:\d{2}|XX)$/u.test(normalizedStatus)
    ) {
      throw contractError(
        `Response status ${originalStatus} for ${key} is invalid`,
      );
    }
    const rawResponse = responsesRaw[originalStatus];
    if (!isRecord(rawResponse))
      throw contractError(
        `Response ${originalStatus} for ${key} must be an object`,
      );
    const response = requireRecord(
      context.resolver.resolve(rawResponse as Json),
      `Response ${originalStatus} for ${key}`,
    );
    const requiredHeaders: string[] = [];
    if (response.headers !== undefined) {
      const headers = requireRecord(
        response.headers,
        `Response headers ${originalStatus} for ${key}`,
      );
      for (const headerName of Object.keys(headers).sort()) {
        const rawHeader = headers[headerName];
        if (!isRecord(rawHeader))
          throw contractError(
            `Response header ${headerName} for ${key} must be an object`,
          );
        const header = requireRecord(
          context.resolver.resolve(rawHeader as Json),
          `Response header ${headerName} for ${key}`,
        );
        if (header.required === true) requiredHeaders.push(headerName);
      }
    }

    if (response.content === undefined) {
      responses[normalizedStatus] = {
        schema: { type: "null" },
        media_type: "",
        required_headers: requiredHeaders,
      };
      continue;
    }
    const content = requireRecord(
      response.content,
      `Response content ${originalStatus} for ${key}`,
    );
    if (Object.keys(content).length === 0) {
      responses[normalizedStatus] = {
        schema: { type: "null" },
        media_type: "",
        required_headers: requiredHeaders,
      };
      continue;
    }
    const selection = chooseResponseContent(content, key, originalStatus);
    let responseSchema =
      selection.schema === undefined
        ? true
        : resolvedSchema(selection.schema, context);
    if (isRecord(responseSchema) && responseSchema.$schema === undefined) {
      responseSchema = {
        $schema: context.is31 ? DRAFT_2020_12 : DRAFT_07,
        ...responseSchema,
      };
    }
    responses[normalizedStatus] = {
      schema: responseSchema as JsonObject | boolean,
      media_type: selection.mediaType,
      required_headers: requiredHeaders,
    };
    if (selection.skipped.length > 0) {
      gaps.push({
        area: "response_content",
        status: normalizedStatus,
        unsupported_media_types: selection.skipped,
      });
    }
  }

  if (gaps.length > 0) inputSchema["x-browser-api-coverage-gaps"] = gaps;
  return {
    key,
    method: method.toUpperCase(),
    path,
    summary,
    input_schema: inputSchema,
    responses,
  };
}

function createValidator(schema: JsonObject | boolean): ValidateFunction {
  const dialect =
    isRecord(schema) && typeof schema.$schema === "string"
      ? schema.$schema
      : DRAFT_07;
  const options = {
    allErrors: true,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
    strict: false,
    validateFormats: true,
    verbose: true,
    logger: false as const,
  };
  const ajv = dialect.includes("2020-12")
    ? new Ajv2020(options)
    : new Ajv(options);
  (addFormats as unknown as (instance: typeof ajv) => void)(ajv);
  try {
    return ajv.compile(schema);
  } catch (error) {
    throw contractError("Compiled endpoint contains an invalid JSON Schema", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function validationErrors(errors: ErrorObject[] | null | undefined): Json {
  return jsonForError(errors ?? []);
}

function responseDefinition(
  endpoint: Endpoint,
  status: number,
): Endpoint["responses"][string] | undefined {
  const exact = endpoint.responses[String(status)];
  if (exact !== undefined) return exact;
  const range = endpoint.responses[`${Math.floor(status / 100)}XX`];
  if (range !== undefined) return range;
  return endpoint.responses.default;
}

function findHeader(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const normalized = name.toLowerCase();
  for (const [candidate, value] of Object.entries(headers)) {
    if (candidate.toLowerCase() === normalized) return value;
  }
  return undefined;
}

/** Return a deterministic SHA-256 pin for the complete local contract document. */
export function contractHash(spec: JsonObject): string {
  assertJson(spec);
  return createHash("sha256").update(canonical(spec)).digest("hex");
}

/** Compile supported OpenAPI 3.0/3.1 operations into stable endpoint descriptions. */
export function compileContract(spec: JsonObject): Endpoint[] {
  assertJson(spec);
  scanReferences(spec);
  const version = requireString(spec.openapi, "openapi");
  if (!/^3\.(?:0|1)\./u.test(version)) {
    throw unsupportedContract(`OpenAPI version ${version} is not supported`, {
      supported: ["3.0.x", "3.1.x"],
    });
  }
  const context: ContractContext = {
    spec,
    version,
    is31: version.startsWith("3.1."),
    resolver: new LocalResolver(spec),
  };
  const paths = requireRecord(spec.paths, "paths");
  const endpoints: Endpoint[] = [];
  const keys = new Set<string>();

  for (const path of Object.keys(paths).sort()) {
    if (!path.startsWith("/"))
      throw contractError(`OpenAPI path ${path} must begin with /`);
    const rawPathItem = paths[path];
    if (!isRecord(rawPathItem))
      throw contractError(`Path item ${path} must be an object`);
    const pathItem = requireRecord(
      context.resolver.resolve(rawPathItem as Json),
      `Path item ${path}`,
    );
    for (const method of Object.keys(pathItem).sort()) {
      if (!HTTP_METHOD_SET.has(method.toLowerCase())) continue;
      const rawOperation = pathItem[method];
      if (!isRecord(rawOperation))
        throw contractError(
          `Operation ${method.toUpperCase()} ${path} must be an object`,
        );
      const endpoint = compileOperation(
        path,
        method.toLowerCase(),
        pathItem,
        rawOperation,
        context,
      );
      if (keys.has(endpoint.key))
        throw contractError(`Duplicate endpoint key ${endpoint.key}`);
      keys.add(endpoint.key);
      endpoints.push(endpoint);
    }
  }
  return endpoints;
}

/** Validate caller input without coercing values, applying defaults, or removing fields. */
export function validateInput(endpoint: Endpoint, input: JsonObject): void {
  const validator = createValidator(endpoint.input_schema);
  if (validator(input)) return;
  throw new AppError(
    "invalid_input",
    `Input does not match endpoint ${endpoint.key}`,
    400,
    {
      endpoint: endpoint.key,
      errors: validationErrors(validator.errors),
    },
  );
}

/** Validate an extracted response against the declared status, media type, headers, and body schema. */
export function validateResponse(
  endpoint: Endpoint,
  response: ApiResponse,
): void {
  if (
    !Number.isInteger(response.status) ||
    response.status < 100 ||
    response.status > 599
  ) {
    throw new AppError(
      "invalid_response",
      "Response status must be an integer from 100 through 599",
      502,
      {
        endpoint: endpoint.key,
        status: response.status,
      },
    );
  }
  const expected = responseDefinition(endpoint, response.status);
  if (expected === undefined) {
    throw new AppError(
      "invalid_response",
      `Status ${response.status} is not declared for endpoint ${endpoint.key}`,
      502,
      {
        endpoint: endpoint.key,
        status: response.status,
        declared_statuses: Object.keys(endpoint.responses),
      },
    );
  }

  const missingHeaders = expected.required_headers.filter(
    (name) => findHeader(response.headers, name) === undefined,
  );
  if (missingHeaders.length > 0) {
    throw new AppError(
      "invalid_response",
      `Response for ${endpoint.key} is missing required headers`,
      502,
      {
        endpoint: endpoint.key,
        status: response.status,
        missing_headers: missingHeaders,
      },
    );
  }
  if (expected.media_type.length > 0) {
    const actualContentType = findHeader(response.headers, "content-type");
    const actualMediaType = actualContentType
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (actualMediaType !== expected.media_type.toLowerCase()) {
      throw new AppError(
        "invalid_response",
        `Response for ${endpoint.key} has the wrong media type`,
        502,
        {
          endpoint: endpoint.key,
          status: response.status,
          expected_media_type: expected.media_type,
          actual_media_type: actualMediaType ?? null,
        },
      );
    }
  }

  const validator = createValidator(expected.schema);
  if (validator(response.body)) return;
  throw new AppError(
    "invalid_response",
    `Response body does not match endpoint ${endpoint.key}`,
    502,
    {
      endpoint: endpoint.key,
      status: response.status,
      errors: validationErrors(validator.errors),
    },
  );
}
