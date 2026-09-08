import { AppError } from "./errors.js";
import { resolveBinding } from "./recipes.js";
import type {
  Artifact,
  Binding,
  Json,
  JsonObject,
  RecipeStep,
} from "./types.js";

const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";
const ARTIFACT_ID = /^art_[a-f0-9]{64}$/u;
const FORBIDDEN_PATH_SEGMENTS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

type UnknownRecord = Record<string, unknown>;
type ArtifactResult = Artifact | { metadata: Artifact } | undefined;
type InputPathBinding = { source: "input"; path: string };

export type ArtifactLookup = (artifactId: string) => ArtifactResult;

export interface DerivedCoverage {
  input_schema: JsonObject;
  artifact_constraints: Record<string, string>;
}

interface Candidate {
  readonly kind: "fill" | "upload";
  readonly path: string;
  readonly canonicalPath: string;
  readonly segments: string[];
  readonly value: string;
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

function escapePointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function parseBindingPath(path: string): string[] {
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

function canonicalPath(segments: readonly string[]): string {
  return segments.length === 0
    ? ""
    : `/${segments.map(escapePointerSegment).join("/")}`;
}

function cloneJson<T extends Json>(value: T): T {
  return structuredClone(value);
}

function assertJson(value: unknown, path = "$"): asserts value is Json {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new AppError(
        "invalid_coverage_input",
        `Input at ${path} is not finite`,
        422,
      );
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertJson(child, `${path}/${index}`));
    return;
  }
  if (!isRecord(value))
    throw new AppError(
      "invalid_coverage_input",
      `Input at ${path} is not JSON`,
      422,
    );
  for (const [key, child] of Object.entries(value))
    assertJson(child, `${path}/${escapePointerSegment(key)}`);
}

function inputBinding(
  binding: Binding | undefined,
): binding is InputPathBinding {
  return binding?.source === "input" && typeof binding.path === "string";
}

function bakedBindingString(binding: Binding | undefined): string[] {
  if (binding?.source !== "literal") return [];
  return typeof binding.value === "string"
    ? [binding.value]
    : stringsWithin(binding.value);
}

function locatorStrings(step: RecipeStep): string[] {
  if (step.action.kind === "navigate") return [];
  const strings = [step.action.target.value];
  if (step.action.target.by === "role") strings.push(step.action.target.name);
  return strings;
}

function stringsWithin(value: Json): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsWithin);
  if (!isRecord(value)) return [];
  return Object.values(value).flatMap((child) => stringsWithin(child as Json));
}

/** Strings that remain fixed in the replayed action after bindings are applied. */
function bakedStrings(step: RecipeStep): string[] {
  const strings = locatorStrings(step);
  const bindings = step.bindings ?? {};
  switch (step.action.kind) {
    case "navigate":
      strings.push(
        ...(hasOwn(bindings, "url")
          ? bakedBindingString(bindings.url)
          : [step.action.url]),
      );
      break;
    case "fill":
    case "select":
      strings.push(
        ...(hasOwn(bindings, "value")
          ? bakedBindingString(bindings.value)
          : [step.action.value]),
      );
      break;
    case "upload":
      strings.push(
        ...(hasOwn(bindings, "artifact_id")
          ? bakedBindingString(bindings.artifact_id)
          : [step.action.artifact_id]),
      );
      break;
    case "read":
      strings.push(step.action.format);
      break;
    case "wait":
      strings.push(step.action.state);
      break;
    case "check":
    case "click":
    case "download":
    case "follow":
      break;
  }
  return strings;
}

function allInputBindings(
  steps: readonly RecipeStep[],
): Array<{ step: RecipeStep; field: string; binding: InputPathBinding }> {
  const found: Array<{
    step: RecipeStep;
    field: string;
    binding: InputPathBinding;
  }> = [];
  for (const step of steps) {
    for (const [field, binding] of Object.entries(step.bindings ?? {})) {
      if (inputBinding(binding)) found.push({ step, field, binding });
    }
  }
  return found;
}

function safeBindingKind(
  step: RecipeStep,
  field: string,
): "fill" | "upload" | undefined {
  if (step.action.kind === "fill" && field === "value") return "fill";
  if (step.action.kind === "upload" && field === "artifact_id") return "upload";
  return undefined;
}

function artifactMetadata(result: ArtifactResult): Artifact | undefined {
  if (result === undefined) return undefined;
  if ("metadata" in result) return result.metadata;
  return result;
}

function findArtifact(
  id: string,
  path: string,
  lookup: ArtifactLookup,
): Artifact {
  if (!ARTIFACT_ID.test(id)) {
    throw new AppError(
      "invalid_artifact_constraint",
      `Upload binding ${path} did not resolve to a valid artifact ID`,
      422,
      {
        path,
        artifact_id: id,
      },
    );
  }
  let artifact: Artifact | undefined;
  try {
    artifact = artifactMetadata(lookup(id));
  } catch {
    artifact = undefined;
  }
  if (
    artifact === undefined ||
    artifact.artifact_id !== id ||
    artifact.media_type.trim().length === 0
  ) {
    throw new AppError(
      "invalid_artifact_constraint",
      `Upload binding ${path} does not identify a registered artifact`,
      422,
      {
        path,
        artifact_id: id,
      },
    );
  }
  return artifact;
}

function mediaType(value: string): string {
  return value.trim().toLowerCase();
}

function buildSchema(
  value: Json,
  path: readonly string[],
  generalized: ReadonlyMap<string, Candidate>,
): JsonObject {
  const currentPath = canonicalPath(path);
  const candidate = generalized.get(currentPath);
  if (candidate?.kind === "fill") {
    return {
      type: "string",
      description:
        "Value supplied to a verified text-entry binding. Endpoint validation and runtime checks still apply.",
    };
  }
  if (candidate?.kind === "upload") {
    return {
      type: "string",
      pattern: "^art_[a-f0-9]{64}$",
      description:
        "Registered artifact ID with the verified media type. Runtime artifact lookup still applies.",
      "x-browser-api-artifact-reference": true,
    };
  }
  if (Array.isArray(value)) {
    return {
      type: "array",
      prefixItems: value.map((child, index) =>
        buildSchema(child, [...path, String(index)], generalized),
      ),
      minItems: value.length,
      maxItems: value.length,
      items: false,
    };
  }
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return {
      type: "object",
      properties: Object.fromEntries(
        keys.map((key) => [
          key,
          buildSchema(value[key] as Json, [...path, key], generalized),
        ]),
      ) as JsonObject,
      required: keys,
      additionalProperties: false,
    };
  }
  return { const: cloneJson(value) };
}

/**
 * Derive replay coverage from a successful concrete input and its executed steps.
 * Only guarded text-entry and artifact bindings are widened; this is not evidence
 * that the target site accepts every widened value, so endpoint and runtime checks remain mandatory.
 */
export function deriveCoverage(
  input: JsonObject,
  steps: readonly RecipeStep[],
  artifactLookup: ArtifactLookup,
): DerivedCoverage {
  assertJson(input);
  const bindings = allInputBindings(steps);
  const candidates = new Map<string, Candidate>();
  const blockedPaths = new Set<string>();

  for (const { step, field, binding } of bindings) {
    const segments = parseBindingPath(binding.path);
    const normalized = canonicalPath(segments);
    const kind = safeBindingKind(step, field);
    if (kind === undefined) {
      blockedPaths.add(normalized);
      continue;
    }
    const resolved = resolveBinding(binding, input, {});
    if (typeof resolved !== "string") {
      blockedPaths.add(normalized);
      continue;
    }
    const existing = candidates.get(normalized);
    if (existing !== undefined && existing.kind !== kind)
      blockedPaths.add(normalized);
    else
      candidates.set(normalized, {
        kind,
        path: binding.path,
        canonicalPath: normalized,
        segments,
        value: resolved,
      });
  }

  const baked = steps.flatMap(bakedStrings);
  const generalized = new Map<string, Candidate>();
  const constraints: Array<[string, string]> = [];
  for (const [path, candidate] of [...candidates.entries()].sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    if (blockedPaths.has(path)) continue;
    if (
      candidate.value.length > 0 &&
      baked.some((fixed) => fixed.includes(candidate.value))
    )
      continue;
    if (candidate.kind === "upload") {
      const artifact = findArtifact(
        candidate.value,
        candidate.path,
        artifactLookup,
      );
      constraints.push([
        candidate.canonicalPath,
        mediaType(artifact.media_type),
      ]);
    }
    generalized.set(path, candidate);
  }

  const shape = buildSchema(input, [], generalized);
  const inputSchema: JsonObject = {
    $schema: DRAFT_2020_12,
    title: "Derived verified recipe coverage",
    description:
      "Shape and settings are frozen to the successful operation. Only explicitly bound text and same-media artifact values are reusable; endpoint validation and runtime verification remain required.",
    ...shape,
  };
  return {
    input_schema: inputSchema,
    artifact_constraints: Object.fromEntries(constraints),
  };
}

/** Check the live artifact registry in addition to the derived JSON Schema. */
export function matchesArtifactConstraints(
  constraints: Record<string, string>,
  input: JsonObject,
  artifactLookup: ArtifactLookup,
): boolean {
  for (const [path, expectedMediaType] of Object.entries(constraints)) {
    let value: Json;
    try {
      value = resolveBinding({ source: "input", path }, input, {});
    } catch {
      return false;
    }
    if (typeof value !== "string" || !ARTIFACT_ID.test(value)) return false;
    let artifact: Artifact | undefined;
    try {
      artifact = artifactMetadata(artifactLookup(value));
    } catch {
      return false;
    }
    if (
      artifact === undefined ||
      artifact.artifact_id !== value ||
      mediaType(artifact.media_type) !== mediaType(expectedMediaType)
    ) {
      return false;
    }
  }
  return true;
}
