import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  compileContract,
  validateInput,
  validateResponse,
} from "../src/contracts.js";
import type { JsonObject } from "../src/types.js";

function snapshot(name: string, sha256: string): JsonObject {
  const data = readFileSync(
    new URL(`../examples/pilots/${name}`, import.meta.url),
  );
  expect(createHash("sha256").update(data).digest("hex")).toBe(sha256);
  return JSON.parse(data.toString("utf8")) as JsonObject;
}

describe("public pilot contracts retain their declared semantics and gaps", () => {
  it("accepts the published Powder file input without strengthening its loose response schema", () => {
    const endpoints = compileContract(
      snapshot(
        "powder-pilot-openapi-2026-09-08.json",
        "984b496d054aad7a44a845eed4b3568c6c6f4e762dbfdd167326329a1d690ed4",
      ),
    );
    expect(endpoints).toHaveLength(3);
    const upload = endpoints.find(
      (endpoint) => endpoint.key === "file_uploads",
    )!;
    expect(() =>
      validateInput(upload, {
        body: {
          file: { artifact_id: `art_${"a".repeat(64)}` },
          statement_type: "brokerage",
        },
      }),
    ).not.toThrow();
    // These loose vendor schemas are documented gaps, not an API-parity signal.
    expect(() => validateInput(upload, {})).not.toThrow();
    for (const key of ["file_uploads_status", "file_uploads_data"]) {
      const endpoint = endpoints.find((item) => item.key === key)!;
      expect(() =>
        validateResponse(endpoint, {
          status: 200,
          headers: { "content-type": "application/json" },
          body: {},
        }),
      ).not.toThrow();
    }
  });

  it("surfaces Reducto oneOf ambiguity instead of silently accepting a minimal parse request", () => {
    const endpoints = compileContract(
      snapshot(
        "reducto-openapi-2026-09-08.json",
        "71bc688eeb13a036cbb83555763d61529cbb346d7136b8026b68d0f64b3b113b",
      ),
    );
    expect(endpoints).toHaveLength(19);
    const parse = endpoints.find(
      (endpoint) => endpoint.key === "parse_parse_post",
    )!;
    expect(parse).toBeDefined();
    let failure: unknown;
    try {
      validateInput(parse, {
        body: { input: "reducto://synthetic-existing-file" },
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "invalid_input" });
    expect(JSON.stringify(failure)).toContain("oneOf");
  });
});
