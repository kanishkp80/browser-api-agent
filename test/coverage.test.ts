import { describe, expect, it } from "vitest";

import {
  deriveCoverage,
  matchesArtifactConstraints,
  type ArtifactLookup,
} from "../src/coverage.js";
import { AppError } from "../src/errors.js";
import { matchesCoverage } from "../src/recipes.js";
import type { Artifact, JsonObject, RecipeStep } from "../src/types.js";

function artifact(hex: string, mediaType: string): Artifact {
  return {
    artifact_id: `art_${hex.repeat(64)}`,
    name: "fixture.bin",
    media_type: mediaType,
    bytes: 100,
    sha256: hex.repeat(64),
  };
}

describe("deriveCoverage", () => {
  it("generalizes verified fill bindings while freezing select, check, shape, and unbound settings", () => {
    const input = {
      query: { workspace: "test" },
      body: {
        text: "Quarterly report",
        mode: "accurate",
        enabled: true,
        tags: ["financial"],
      },
    } as JsonObject;
    const steps: RecipeStep[] = [
      {
        action: {
          kind: "fill",
          target: { by: "label", value: "Text" },
          value: "",
        },
        bindings: { value: { source: "input", path: "/body/text" } },
        effect: "none",
        description: "Fill text",
      },
      {
        action: {
          kind: "select",
          target: { by: "label", value: "Mode" },
          value: "",
        },
        bindings: { value: { source: "input", path: "/body/mode" } },
        effect: "none",
        description: "Choose mode",
      },
      {
        action: {
          kind: "check",
          target: { by: "label", value: "Enabled" },
          checked: false,
        },
        bindings: { checked: { source: "input", path: "/body/enabled" } },
        effect: "none",
        description: "Set enabled",
      },
      {
        action: {
          kind: "click",
          target: { by: "role", value: "button", name: "Run" },
        },
        effect: "submission",
        description: "Run once",
      },
    ];
    const coverage = deriveCoverage(input, steps, () => undefined);

    expect(
      matchesCoverage(coverage.input_schema, {
        query: { workspace: "test" },
        body: {
          text: "A different document",
          mode: "accurate",
          enabled: true,
          tags: ["financial"],
        },
      }),
    ).toBe(true);
    expect(
      matchesCoverage(coverage.input_schema, {
        query: { workspace: "test" },
        body: {
          text: "A different document",
          mode: "fast",
          enabled: true,
          tags: ["financial"],
        },
      }),
    ).toBe(false);
    expect(
      matchesCoverage(coverage.input_schema, {
        query: { workspace: "test" },
        body: {
          text: "A different document",
          mode: "accurate",
          enabled: false,
          tags: ["financial"],
        },
      }),
    ).toBe(false);
    expect(
      matchesCoverage(coverage.input_schema, {
        query: { workspace: "test" },
        body: {
          text: "A different document",
          mode: "accurate",
          enabled: true,
          tags: ["financial", "extra"],
        },
      }),
    ).toBe(false);
    expect(
      matchesCoverage(coverage.input_schema, {
        query: { workspace: "test" },
        body: { text: "A different document", mode: "accurate", enabled: true },
      }),
    ).toBe(false);
    expect(coverage.artifact_constraints).toEqual({});
  });

  it("freezes a bound value when it is baked into a locator", () => {
    const input = { body: { record: "record-123" } } as JsonObject;
    const steps: RecipeStep[] = [
      {
        action: {
          kind: "fill",
          target: { by: "label", value: "Record" },
          value: "",
        },
        bindings: { value: { source: "input", path: "/body/record" } },
        effect: "none",
        description: "Enter record",
      },
      {
        action: {
          kind: "click",
          target: { by: "text", value: "Open record-123" },
        },
        effect: "none",
        description: "Open captured record",
      },
    ];
    const coverage = deriveCoverage(input, steps, () => undefined);
    expect(matchesCoverage(coverage.input_schema, input)).toBe(true);
    expect(
      matchesCoverage(coverage.input_schema, {
        body: { record: "record-456" },
      }),
    ).toBe(false);
  });

  it("freezes a bound value baked into literal navigation or another non-bound action field", () => {
    const input = { body: { record: "record-123" } } as JsonObject;
    const steps: RecipeStep[] = [
      {
        action: {
          kind: "fill",
          target: { by: "label", value: "Record" },
          value: "",
        },
        bindings: { value: { source: "input", path: "body.record" } },
        effect: "none",
        description: "Enter record",
      },
      {
        action: { kind: "navigate", url: "https://example.test/placeholder" },
        bindings: {
          url: {
            source: "literal",
            value: "https://example.test/records/record-123",
          },
        },
        effect: "none",
        description: "Open captured record URL",
      },
    ];
    const coverage = deriveCoverage(input, steps, () => undefined);
    expect(
      matchesCoverage(coverage.input_schema, {
        body: { record: "record-456" },
      }),
    ).toBe(false);
  });

  it("generalizes an empty bound text value because empty substrings cannot prove baking", () => {
    const input = { body: { text: "" } } as JsonObject;
    const steps: RecipeStep[] = [
      {
        action: {
          kind: "fill",
          target: { by: "label", value: "Text" },
          value: "",
        },
        bindings: { value: { source: "input", path: "/body/text" } },
        effect: "none",
        description: "Fill text",
      },
    ];
    const coverage = deriveCoverage(input, steps, () => undefined);
    expect(
      matchesCoverage(coverage.input_schema, { body: { text: "new text" } }),
    ).toBe(true);
  });
});

describe("artifact coverage constraints", () => {
  const pdfA = artifact("a", "application/pdf");
  const pdfB = artifact("b", "Application/PDF");
  const png = artifact("c", "image/png");
  const artifacts = new Map(
    [pdfA, pdfB, png].map((item) => [item.artifact_id, item]),
  );
  const lookup: ArtifactLookup = (id) => artifacts.get(id);

  const steps: RecipeStep[] = [
    {
      action: {
        kind: "upload",
        target: { by: "label", value: "Document" },
        artifact_id: "placeholder",
      },
      bindings: {
        artifact_id: { source: "input", path: "/body/document/artifact_id" },
      },
      effect: "none",
      description: "Upload document",
    },
  ];

  it("allows another registered artifact only when its MIME type matches", () => {
    const captured = {
      body: { document: { artifact_id: pdfA.artifact_id }, mode: "accurate" },
    } as JsonObject;
    const coverage = deriveCoverage(captured, steps, lookup);
    expect(coverage.artifact_constraints).toEqual({
      "/body/document/artifact_id": "application/pdf",
    });

    const sameMedia = {
      body: { document: { artifact_id: pdfB.artifact_id }, mode: "accurate" },
    } as JsonObject;
    const differentMedia = {
      body: { document: { artifact_id: png.artifact_id }, mode: "accurate" },
    } as JsonObject;
    expect(matchesCoverage(coverage.input_schema, sameMedia)).toBe(true);
    expect(
      matchesArtifactConstraints(
        coverage.artifact_constraints,
        sameMedia,
        lookup,
      ),
    ).toBe(true);
    expect(matchesCoverage(coverage.input_schema, differentMedia)).toBe(true);
    expect(
      matchesArtifactConstraints(
        coverage.artifact_constraints,
        differentMedia,
        lookup,
      ),
    ).toBe(false);
    expect(
      matchesArtifactConstraints(
        coverage.artifact_constraints,
        {
          body: {
            document: { artifact_id: `art_${"d".repeat(64)}` },
            mode: "accurate",
          },
        },
        lookup,
      ),
    ).toBe(false);
  });

  it("rejects an unregistered or malformed artifact in the successful-operation input", () => {
    expect(() =>
      deriveCoverage(
        { body: { document: { artifact_id: "artifact_not_registered" } } },
        steps,
        lookup,
      ),
    ).toThrowError(AppError);
    expect(() =>
      deriveCoverage(
        { body: { document: { artifact_id: `art_${"d".repeat(64)}` } } },
        steps,
        lookup,
      ),
    ).toThrowError(/registered artifact/u);
  });
});
