import { Ajv, type ErrorObject } from "ajv";
import addFormats from "ajv-formats";
import { Ajv2020 } from "ajv/dist/2020.js";

import { AppError } from "./errors.js";
import type {
  ApiResponse,
  Binding,
  BrowserAction,
  Json,
  JsonObject,
  Locator,
  RecipeStep,
  ResponseMapping,
} from "./types.js";

const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";
const FORBIDDEN_PATH_SEGMENTS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function cloneJson<T extends Json>(value: T): T {
  return structuredClone(value);
}

function asJson(value: unknown, description: string): Json {
  assertJson(value, description);
  return value;
}

function assertJson(value: unknown, path: string): asserts value is Json {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new AppError(
        "invalid_recipe",
        `${path} contains a non-finite number`,
        422,
      );
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertJson(child, `${path}/${index}`));
    return;
  }
  if (!isRecord(value))
    throw new AppError("invalid_recipe", `${path} is not JSON`, 422);
  for (const [key, child] of Object.entries(value))
    assertJson(child, `${path}/${key}`);
}

function exactKeys(
  value: UnknownRecord,
  allowed: readonly string[],
  description: string,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new AppError(
      "invalid_recipe",
      `${description} contains unsupported fields`,
      422,
      {
        fields: unknown,
        allowed: [...allowed],
      },
    );
  }
}

function requiredString(
  value: unknown,
  description: string,
  allowEmpty = false,
): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new AppError(
      "invalid_recipe",
      `${description} must be ${allowEmpty ? "a string" : "a non-empty string"}`,
      422,
    );
  }
  return value;
}

function parsePath(path: string): string[] {
  if (path === "") return [];
  let segments: string[];
  if (path.startsWith("/")) {
    segments = path
      .slice(1)
      .split("/")
      .map((segment) => {
        if (/~(?:[^01]|$)/u.test(segment)) {
          throw new AppError(
            "invalid_binding_path",
            `Binding path ${path} has an invalid JSON Pointer escape`,
            422,
          );
        }
        return segment.replaceAll("~1", "/").replaceAll("~0", "~");
      });
  } else {
    if (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/u.test(path)) {
      throw new AppError(
        "invalid_binding_path",
        `Binding path ${path} must be a JSON Pointer or simple dotted path`,
        422,
      );
    }
    segments = path.split(".");
  }
  for (const segment of segments) {
    if (FORBIDDEN_PATH_SEGMENTS.has(segment)) {
      throw new AppError(
        "invalid_binding_path",
        `Binding path ${path} contains a forbidden segment`,
        422,
        { segment },
      );
    }
  }
  return segments;
}

function readPath(root: Json, path: string, source: "input" | "output"): Json {
  const segments = parsePath(path);
  let current: Json = root;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(segment)) {
        throw new AppError(
          "binding_path_not_found",
          `Binding ${source} path ${path} does not address a valid array index`,
          422,
          {
            source,
            path,
            segment,
          },
        );
      }
      const index = Number(segment);
      if (index >= current.length) {
        throw new AppError(
          "binding_path_not_found",
          `Binding ${source} path ${path} does not exist`,
          422,
          { source, path },
        );
      }
      current = current[index]!;
      continue;
    }
    if (!isRecord(current) || !hasOwn(current, segment)) {
      throw new AppError(
        "binding_path_not_found",
        `Binding ${source} path ${path} does not exist`,
        422,
        { source, path },
      );
    }
    current = (current as Record<string, Json>)[segment]!;
  }
  return cloneJson(current);
}

function assertBinding(binding: unknown): asserts binding is Binding {
  if (!isRecord(binding))
    throw new AppError("invalid_recipe", "Binding must be an object", 422);
  if (binding.source === "literal") {
    exactKeys(binding, ["source", "value"], "Literal binding");
    if (!hasOwn(binding, "value"))
      throw new AppError(
        "invalid_recipe",
        "Literal binding must contain value",
        422,
      );
    assertJson(binding.value, "Literal binding value");
    return;
  }
  if (binding.source === "input" || binding.source === "output") {
    exactKeys(binding, ["source", "path"], `${binding.source} binding`);
    requiredString(binding.path, `${binding.source} binding path`, true);
    return;
  }
  throw new AppError(
    "invalid_recipe",
    "Binding source must be literal, input, or output",
    422,
  );
}

function assertLocator(locator: unknown): asserts locator is Locator {
  if (!isRecord(locator))
    throw new AppError(
      "invalid_recipe",
      "Action target must be a locator object",
      422,
    );
  const by = requiredString(locator.by, "Locator by");
  if (by === "role") {
    exactKeys(locator, ["by", "value", "name"], "Role locator");
    requiredString(locator.value, "Role locator value");
    requiredString(locator.name, "Role locator name", true);
    return;
  }
  if (!["css", "label", "placeholder", "testid", "text"].includes(by)) {
    throw new AppError(
      "invalid_recipe",
      `Unsupported locator strategy ${by}`,
      422,
    );
  }
  exactKeys(locator, ["by", "value"], `${by} locator`);
  requiredString(locator.value, `${by} locator value`);
}

function assertAction(action: unknown): asserts action is BrowserAction {
  if (!isRecord(action))
    throw new AppError(
      "invalid_recipe",
      "Recipe action must be an object",
      422,
    );
  const kind = requiredString(action.kind, "Action kind");
  switch (kind) {
    case "navigate":
      exactKeys(action, ["kind", "url"], "Navigate action");
      requiredString(action.url, "Navigate URL");
      return;
    case "click":
    case "follow":
    case "download":
      exactKeys(action, ["kind", "target"], `${kind} action`);
      assertLocator(action.target);
      return;
    case "fill":
    case "select":
      exactKeys(action, ["kind", "target", "value"], `${kind} action`);
      assertLocator(action.target);
      requiredString(action.value, `${kind} value`, true);
      return;
    case "check":
      exactKeys(action, ["kind", "target", "checked"], "Check action");
      assertLocator(action.target);
      if (typeof action.checked !== "boolean")
        throw new AppError(
          "invalid_recipe",
          "Check value must be boolean",
          422,
        );
      return;
    case "upload":
      exactKeys(action, ["kind", "target", "artifact_id"], "Upload action");
      assertLocator(action.target);
      requiredString(action.artifact_id, "Upload artifact ID");
      return;
    case "read":
      exactKeys(action, ["kind", "target", "format"], "Read action");
      assertLocator(action.target);
      if (action.format !== "text" && action.format !== "json") {
        throw new AppError(
          "invalid_recipe",
          "Read format must be text or json",
          422,
        );
      }
      return;
    case "wait":
      exactKeys(action, ["kind", "target", "state"], "Wait action");
      assertLocator(action.target);
      if (action.state !== "visible" && action.state !== "hidden") {
        throw new AppError(
          "invalid_recipe",
          "Wait state must be visible or hidden",
          422,
        );
      }
      return;
    default:
      throw new AppError(
        "invalid_recipe",
        `Unsupported browser action ${kind}`,
        422,
      );
  }
}

function cloneLocator(locator: Locator): Locator {
  return locator.by === "role"
    ? { by: "role", value: locator.value, name: locator.name }
    : { by: locator.by, value: locator.value };
}

function bindingFieldsForAction(
  kind: BrowserAction["kind"],
): readonly string[] {
  switch (kind) {
    case "navigate":
      return ["url"];
    case "fill":
    case "select":
      return ["value"];
    case "check":
      return ["checked"];
    case "upload":
      return ["artifact_id"];
    default:
      return [];
  }
}

function boundValue(
  bindings: UnknownRecord,
  key: string,
  fallback: Json,
  input: JsonObject,
  outputs: Record<string, Json>,
): Json {
  if (!hasOwn(bindings, key)) return cloneJson(fallback);
  const binding = bindings[key];
  assertBinding(binding);
  return resolveBinding(binding, input, outputs);
}

function assertStringBound(value: Json, field: string): string {
  if (typeof value !== "string") {
    throw new AppError(
      "invalid_recipe",
      `Binding for ${field} must resolve to a string`,
      422,
      {
        field,
        actual_type:
          value === null
            ? "null"
            : Array.isArray(value)
              ? "array"
              : typeof value,
      },
    );
  }
  return value;
}

function assertSafeNavigationUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new AppError(
      "invalid_recipe",
      "Navigation URL must be an absolute HTTP(S) URL",
      422,
      { url: value },
    );
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new AppError(
      "invalid_recipe",
      "Navigation URL must use HTTP or HTTPS",
      422,
      { protocol: parsed.protocol },
    );
  }
  return value;
}

function validationErrors(errors: ErrorObject[] | null | undefined): Json {
  return JSON.parse(JSON.stringify(errors ?? [])) as Json;
}

function createCoverageValidator(schema: JsonObject) {
  const dialect =
    typeof schema.$schema === "string" ? schema.$schema : DRAFT_2020_12;
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
    throw new AppError(
      "invalid_coverage_schema",
      "Coverage is not a valid JSON Schema",
      422,
      {
        message: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

/** Resolve one literal, input, or prior-output binding without interpolation or evaluation. */
export function resolveBinding(
  binding: Binding,
  input: JsonObject,
  outputs: Record<string, Json>,
): Json {
  assertBinding(binding);
  if (binding.source === "literal") return cloneJson(binding.value);
  return readPath(
    binding.source === "input" ? input : outputs,
    binding.path,
    binding.source,
  );
}

/** Bind the only action fields that recipes may source dynamically. */
export function bindStep(
  step: RecipeStep,
  input: JsonObject,
  outputs: Record<string, Json>,
): BrowserAction {
  assertAction(step.action);
  const bindings: UnknownRecord = step.bindings ?? {};
  if (!isRecord(bindings))
    throw new AppError(
      "invalid_recipe",
      "Step bindings must be an object",
      422,
    );
  const allowed = bindingFieldsForAction(step.action.kind);
  exactKeys(bindings, allowed, `Bindings for ${step.action.kind}`);

  switch (step.action.kind) {
    case "navigate": {
      const url = assertStringBound(
        boundValue(bindings, "url", step.action.url, input, outputs),
        "url",
      );
      if (url.length === 0)
        throw new AppError(
          "invalid_recipe",
          "Bound navigation URL cannot be empty",
          422,
        );
      return { kind: "navigate", url: assertSafeNavigationUrl(url) };
    }
    case "click":
      return { kind: "click", target: cloneLocator(step.action.target) };
    case "follow":
      return { kind: "follow", target: cloneLocator(step.action.target) };
    case "fill":
    case "select": {
      const value = assertStringBound(
        boundValue(bindings, "value", step.action.value, input, outputs),
        "value",
      );
      return {
        kind: step.action.kind,
        target: cloneLocator(step.action.target),
        value,
      };
    }
    case "check": {
      const checked = boundValue(
        bindings,
        "checked",
        step.action.checked,
        input,
        outputs,
      );
      if (typeof checked !== "boolean")
        throw new AppError(
          "invalid_recipe",
          "Binding for checked must resolve to a boolean",
          422,
        );
      return {
        kind: "check",
        target: cloneLocator(step.action.target),
        checked,
      };
    }
    case "upload": {
      const artifactId = assertStringBound(
        boundValue(
          bindings,
          "artifact_id",
          step.action.artifact_id,
          input,
          outputs,
        ),
        "artifact_id",
      );
      if (artifactId.length === 0)
        throw new AppError(
          "invalid_recipe",
          "Bound artifact ID cannot be empty",
          422,
        );
      return {
        kind: "upload",
        target: cloneLocator(step.action.target),
        artifact_id: artifactId,
      };
    }
    case "read":
      return {
        kind: "read",
        target: cloneLocator(step.action.target),
        format: step.action.format,
      };
    case "download":
      return { kind: "download", target: cloneLocator(step.action.target) };
    case "wait":
      return {
        kind: "wait",
        target: cloneLocator(step.action.target),
        state: step.action.state,
      };
  }
}

/** Map explicit bindings into an API response while preserving the complete JSON body. */
export function mapResponse(
  mapping: ResponseMapping,
  input: JsonObject,
  outputs: Record<string, Json>,
): ApiResponse {
  if (!isRecord(mapping))
    throw new AppError(
      "invalid_recipe",
      "Response mapping must be an object",
      422,
    );
  exactKeys(mapping, ["status", "headers", "body"], "Response mapping");
  if (
    !Number.isInteger(mapping.status) ||
    mapping.status < 100 ||
    mapping.status > 599
  ) {
    throw new AppError(
      "invalid_recipe",
      "Mapped response status must be an integer from 100 through 599",
      422,
    );
  }
  if (!isRecord(mapping.headers))
    throw new AppError(
      "invalid_recipe",
      "Mapped response headers must be an object",
      422,
    );
  assertBinding(mapping.body);

  const headerEntries: Array<[string, string]> = [];
  for (const [name, rawBinding] of Object.entries(mapping.headers)) {
    if (!HEADER_NAME.test(name) || FORBIDDEN_PATH_SEGMENTS.has(name)) {
      throw new AppError(
        "invalid_recipe",
        `Mapped response header name ${name} is invalid`,
        422,
      );
    }
    assertBinding(rawBinding);
    const value = resolveBinding(rawBinding, input, outputs);
    if (typeof value !== "string") {
      throw new AppError(
        "invalid_recipe",
        `Mapped response header ${name} must resolve to a string`,
        422,
      );
    }
    headerEntries.push([name, value]);
  }
  return {
    status: mapping.status,
    headers: Object.fromEntries(headerEntries),
    body: resolveBinding(mapping.body, input, outputs),
  };
}

/** Return whether an input matches a verified coverage schema, without coercion or defaults. */
export function matchesCoverage(
  schema: JsonObject,
  input: JsonObject,
): boolean {
  const validator = createCoverageValidator(schema);
  return Boolean(validator(input));
}

/** Narrow a proposed first recipe to the exact verified input. Artifact widening is a later reviewed promotion. */
export function narrowCoverage(
  input: JsonObject,
  proposed: JsonObject,
): JsonObject {
  const validator = createCoverageValidator(proposed);
  if (!validator(input)) {
    throw new AppError(
      "coverage_mismatch",
      "Proposed coverage does not include the verified input",
      422,
      {
        errors: validationErrors(validator.errors),
      },
    );
  }
  asJson(input, "Verified input");
  return {
    $schema: DRAFT_2020_12,
    title: "Exact verified recipe input",
    description:
      "Conservative initial coverage. Artifact identifiers remain exact until recipe bindings are inspected and widening is separately verified.",
    const: cloneJson(input),
  };
}
