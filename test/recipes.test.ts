import { describe, expect, it } from "vitest";

import {
  bindStep,
  mapResponse,
  matchesCoverage,
  narrowCoverage,
  resolveBinding,
} from "../src/recipes.js";
import { AppError } from "../src/errors.js";
import type {
  Binding,
  JsonObject,
  RecipeStep,
  ResponseMapping,
} from "../src/types.js";

describe("resolveBinding", () => {
  const input = {
    path: { id: "doc_1" },
    body: {
      settings: { accurate: true },
      artifact: { artifact_id: "artifact_1" },
    },
  } as JsonObject;
  const outputs = {
    result: {
      chunks: [{ text: "first" }, { text: "second" }],
      metadata: { duration: 12 },
    },
  };

  it("resolves literals, RFC 6901 pointers, simple dotted paths, arrays, and whole roots", () => {
    expect(
      resolveBinding(
        { source: "literal", value: "${input.path.id}" },
        input,
        outputs,
      ),
    ).toBe("${input.path.id}");
    expect(
      resolveBinding(
        { source: "input", path: "/body/settings/accurate" },
        input,
        outputs,
      ),
    ).toBe(true);
    expect(
      resolveBinding({ source: "input", path: "path.id" }, input, outputs),
    ).toBe("doc_1");
    expect(
      resolveBinding(
        { source: "output", path: "/result/chunks/1/text" },
        input,
        outputs,
      ),
    ).toBe("second");
    expect(
      resolveBinding({ source: "output", path: "" }, input, outputs),
    ).toEqual(outputs);
  });

  it("does not evaluate expressions and rejects missing or pollution paths", () => {
    expect(() =>
      resolveBinding({ source: "input", path: "body.missing" }, input, outputs),
    ).toThrowError(/does not exist/u);
    expect(() =>
      resolveBinding(
        { source: "input", path: "/body/__proto__/polluted" },
        input,
        outputs,
      ),
    ).toThrowError(/forbidden segment/u);
    expect(() =>
      resolveBinding(
        { source: "input", path: "body.settings;process.exit" },
        input,
        outputs,
      ),
    ).toThrowError(/JSON Pointer or simple dotted path/u);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("rejects malformed runtime binding objects", () => {
    const malformed = {
      source: "input",
      path: "/path/id",
      evaluate: true,
    } as unknown as Binding;
    expect(() => resolveBinding(malformed, input, outputs)).toThrowError(
      /unsupported fields/u,
    );
  });
});

describe("bindStep", () => {
  const input = {
    path: { id: "doc_1" },
    body: {
      label: "Quarterly",
      enabled: false,
      document: { artifact_id: "artifact_1" },
    },
  } as JsonObject;
  const outputs = { next_url: "https://studio.example.test/results/doc_1" };

  it("binds only the documented scalar action fields", () => {
    const navigate: RecipeStep = {
      action: { kind: "navigate", url: "https://example.test" },
      bindings: { url: { source: "output", path: "/next_url" } },
      effect: "none",
      description: "Open the result",
    };
    expect(bindStep(navigate, input, outputs)).toEqual({
      kind: "navigate",
      url: "https://studio.example.test/results/doc_1",
    });

    const fill: RecipeStep = {
      action: {
        kind: "fill",
        target: { by: "label", value: "Label" },
        value: "",
      },
      bindings: { value: { source: "input", path: "/body/label" } },
      effect: "none",
      description: "Fill the label",
    };
    expect(bindStep(fill, input, outputs)).toEqual({
      kind: "fill",
      target: { by: "label", value: "Label" },
      value: "Quarterly",
    });

    const check: RecipeStep = {
      action: {
        kind: "check",
        target: { by: "label", value: "Enabled" },
        checked: true,
      },
      bindings: { checked: { source: "input", path: "/body/enabled" } },
      effect: "none",
      description: "Set enabled",
    };
    expect(bindStep(check, input, outputs)).toMatchObject({ checked: false });

    const upload: RecipeStep = {
      action: {
        kind: "upload",
        target: { by: "label", value: "Document" },
        artifact_id: "placeholder",
      },
      bindings: {
        artifact_id: { source: "input", path: "/body/document/artifact_id" },
      },
      effect: "none",
      description: "Upload the document",
    };
    expect(bindStep(upload, input, outputs)).toMatchObject({
      artifact_id: "artifact_1",
    });
  });

  it("rejects nested target binding, wrong binding types, and unknown action fields", () => {
    const targetBinding = {
      action: { kind: "click", target: { by: "text", value: "Run" } },
      bindings: { target: { source: "input", path: "/path/id" } },
      effect: "submission",
      description: "Run",
    } as unknown as RecipeStep;
    expect(() => bindStep(targetBinding, input, outputs)).toThrowError(
      /unsupported fields/u,
    );

    const wrongType: RecipeStep = {
      action: {
        kind: "fill",
        target: { by: "label", value: "Label" },
        value: "",
      },
      bindings: { value: { source: "input", path: "/body/enabled" } },
      effect: "none",
      description: "Fill",
    };
    expect(() => bindStep(wrongType, input, outputs)).toThrowError(
      /must resolve to a string/u,
    );

    const injected = {
      action: {
        kind: "navigate",
        url: "https://example.test",
        evaluate: "process.exit()",
      },
      effect: "none",
      description: "Injected",
    } as unknown as RecipeStep;
    expect(() => bindStep(injected, input, outputs)).toThrowError(
      /unsupported fields/u,
    );

    const javascriptNavigation: RecipeStep = {
      action: { kind: "navigate", url: "https://example.test" },
      bindings: {
        url: {
          source: "literal",
          value: "javascript:globalThis.polluted=true",
        },
      },
      effect: "none",
      description: "Unsafe navigation",
    };
    expect(() => bindStep(javascriptNavigation, input, outputs)).toThrowError(
      /HTTP or HTTPS/u,
    );
    expect((globalThis as { polluted?: boolean }).polluted).toBeUndefined();
  });
});

describe("mapResponse", () => {
  it("maps explicit headers and preserves a full nested DOM-derived JSON result", () => {
    const input = { path: { id: "doc_1" } } as JsonObject;
    const result = {
      id: "doc_1",
      chunks: [
        { type: "text", content: "one", coordinates: [0, 1, 2, 3] },
        { type: "table", cells: [[{ text: "A1" }]] },
      ],
      usage: { pages: 2 },
      nullable: null,
    } as JsonObject;
    const mapping: ResponseMapping = {
      status: 200,
      headers: {
        "content-type": { source: "literal", value: "application/json" },
        "x-document-id": { source: "input", path: "/path/id" },
      },
      body: { source: "output", path: "/dom_json" },
    };
    expect(mapResponse(mapping, input, { dom_json: result })).toEqual({
      status: 200,
      headers: { "content-type": "application/json", "x-document-id": "doc_1" },
      body: result,
    });
  });

  it("rejects implicit header coercion and unsafe mapping fields", () => {
    const numericHeader: ResponseMapping = {
      status: 200,
      headers: { "x-pages": { source: "output", path: "/pages" } },
      body: { source: "literal", value: null },
    };
    expect(() => mapResponse(numericHeader, {}, { pages: 2 })).toThrowError(
      /must resolve to a string/u,
    );

    const unsafe = {
      status: 200,
      headers: {},
      body: { source: "literal", value: null },
      transform: "return process.env",
    } as unknown as ResponseMapping;
    expect(() => mapResponse(unsafe, {}, {})).toThrowError(
      /unsupported fields/u,
    );
  });
});

describe("coverage", () => {
  it("matches without applying defaults or coercing types", () => {
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { count: { type: "integer", default: 2 } },
      additionalProperties: false,
    } as JsonObject;
    const empty = {} as JsonObject;
    expect(matchesCoverage(schema, empty)).toBe(true);
    expect(empty).toEqual({});
    expect(matchesCoverage(schema, { count: 2 })).toBe(true);
    expect(matchesCoverage(schema, { count: "2" })).toBe(false);
  });

  it("narrows first-recipe coverage to the exact verified input", () => {
    const input = {
      body: {
        document: { artifact_id: "artifact_digest_1" },
        page_range: "1-3",
      },
    } as JsonObject;
    const proposed = { type: "object", required: ["body"] } as JsonObject;
    const narrowed = narrowCoverage(input, proposed);
    expect(matchesCoverage(narrowed, input)).toBe(true);
    expect(
      matchesCoverage(narrowed, {
        body: {
          document: { artifact_id: "artifact_digest_2" },
          page_range: "1-3",
        },
      }),
    ).toBe(false);
    expect(() =>
      narrowCoverage(input, { type: "object", required: ["missing"] }),
    ).toThrowError(AppError);
  });

  it("reports invalid coverage schemas rather than treating them as non-matches", () => {
    expect(() =>
      matchesCoverage({ type: "not-a-json-schema-type" }, {}),
    ).toThrowError(/valid JSON Schema/u);
  });
});
