import { describe, expect, it } from "vitest";

import {
  compileContract,
  contractHash,
  validateInput,
  validateResponse,
} from "../src/contracts.js";
import { AppError } from "../src/errors.js";
import type { JsonObject } from "../src/types.js";

function asObject(value: unknown): JsonObject {
  return value as JsonObject;
}

const referencedContract = {
  openapi: "3.1.0",
  info: { title: "Specimen", version: "1.0.0" },
  $defs: {
    Identifier: { type: "string", pattern: "^doc_[a-z0-9]+$" },
    IdentifierParameter: {
      name: "document_id",
      in: "path",
      required: true,
      schema: { $ref: "#/$defs/Identifier" },
    },
    ParseBody: {
      type: "object",
      properties: {
        page_range: { type: "string" },
        accurate: { type: "boolean", default: false },
      },
      required: ["page_range"],
      additionalProperties: false,
    },
    ParseResult: {
      type: "object",
      properties: {
        id: { $ref: "#/$defs/Identifier" },
        chunks: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
      },
      required: ["id", "chunks"],
      additionalProperties: false,
    },
  },
  paths: {
    "/documents/{document_id}/parse": {
      parameters: [{ $ref: "#/$defs/IdentifierParameter" }],
      post: {
        operationId: "parseDocument",
        summary: "Parse one document",
        parameters: [
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", minimum: 1, default: 25 },
          },
          {
            name: "trace",
            in: "query",
            required: true,
            schema: { type: "boolean" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: { $ref: "#/$defs/ParseBody" } },
          },
        },
        responses: {
          "200": {
            description: "Parsed",
            headers: {
              "X-Request-Id": { required: true, schema: { type: "string" } },
            },
            content: {
              "application/json": { schema: { $ref: "#/$defs/ParseResult" } },
            },
          },
        },
      },
    },
  },
} as JsonObject;

describe("contractHash", () => {
  it("is deterministic across object key insertion order", () => {
    const first = {
      openapi: "3.1.0",
      info: { title: "A", version: "1" },
      paths: {},
    } as JsonObject;
    const second = {
      paths: {},
      info: { version: "1", title: "A" },
      openapi: "3.1.0",
    } as JsonObject;
    expect(contractHash(first)).toMatch(/^[a-f0-9]{64}$/u);
    expect(contractHash(first)).toBe(contractHash(second));
  });
});

describe("compileContract and validation", () => {
  it("resolves local refs and $defs while preserving required fields and unapplied defaults", () => {
    const [endpoint] = compileContract(referencedContract);
    expect(endpoint).toMatchObject({
      key: "parseDocument",
      method: "POST",
      path: "/documents/{document_id}/parse",
      summary: "Parse one document",
    });

    const properties = asObject(endpoint!.input_schema.properties);
    const query = asObject(properties.query);
    const queryProperties = asObject(query.properties);
    expect(asObject(queryProperties.limit).default).toBe(25);

    const input = {
      path: { document_id: "doc_abc" },
      query: { trace: false },
      body: { page_range: "1-3" },
    } as JsonObject;
    validateInput(endpoint!, input);
    expect(input).toEqual({
      path: { document_id: "doc_abc" },
      query: { trace: false },
      body: { page_range: "1-3" },
    });

    expect(() =>
      validateInput(endpoint!, {
        path: { document_id: "bad" },
        query: { trace: "false" },
        body: {},
      } as JsonObject),
    ).toThrowError(AppError);
  });

  it("returns full JSON Schema errors for invalid inputs", () => {
    const [endpoint] = compileContract(referencedContract);
    try {
      validateInput(endpoint!, { path: {}, query: {}, body: {} });
      expect.unreachable("validation should fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.code).toBe("invalid_input");
      const details = asObject(appError.details);
      expect(Array.isArray(details.errors)).toBe(true);
      expect((details.errors as unknown[]).length).toBeGreaterThanOrEqual(3);
      expect(JSON.stringify(details.errors)).toContain("instancePath");
      expect(JSON.stringify(details.errors)).toContain("schemaPath");
    }
  });

  it("validates response status, media type, required headers, and complete bodies", () => {
    const [endpoint] = compileContract(referencedContract);
    const valid = {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-request-id": "req_1",
      },
      body: { id: "doc_abc", chunks: [{ text: "complete JSON" }] },
    };
    expect(() => validateResponse(endpoint!, valid)).not.toThrow();

    expect(() =>
      validateResponse(endpoint!, {
        ...valid,
        headers: { "content-type": "application/json" },
      }),
    ).toThrowError(/missing required headers/u);
    expect(() =>
      validateResponse(endpoint!, {
        ...valid,
        headers: { ...valid.headers, "content-type": "text/plain" },
      }),
    ).toThrowError(/wrong media type/u);
    expect(() =>
      validateResponse(endpoint!, { ...valid, body: { id: "doc_abc" } }),
    ).toThrowError(/does not match/u);
    expect(() =>
      validateResponse(endpoint!, { ...valid, status: 201 }),
    ).toThrowError(/not declared/u);
  });

  it("supports OpenAPI 3.0 schemas, fallback keys, nullable, exclusives, and empty responses", () => {
    const spec = {
      openapi: "3.0.3",
      info: { title: "Classic", version: "1" },
      paths: {
        "/items": {
          post: {
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      score: {
                        type: "number",
                        minimum: 0,
                        exclusiveMinimum: true,
                      },
                      nickname: { type: "string", nullable: true },
                    },
                    required: ["score", "nickname"],
                  },
                },
              },
            },
            responses: { "204": { description: "Done" } },
          },
        },
      },
    } as JsonObject;
    const [endpoint] = compileContract(spec);
    expect(endpoint!.key).toBe("POST /items");
    validateInput(endpoint!, { body: { score: 0.1, nickname: null } });
    expect(() =>
      validateInput(endpoint!, { body: { score: 0, nickname: null } }),
    ).toThrowError(AppError);
    expect(() =>
      validateResponse(endpoint!, { status: 204, headers: {}, body: null }),
    ).not.toThrow();
    expect(() =>
      validateResponse(endpoint!, { status: 204, headers: {}, body: {} }),
    ).toThrowError(AppError);
  });

  it("represents multipart binary fields as explicit artifact references", () => {
    const spec = {
      openapi: "3.1.0",
      info: { title: "Upload", version: "1" },
      paths: {
        "/uploads": {
          post: {
            operationId: "uploadDocument",
            requestBody: {
              required: true,
              content: {
                "multipart/form-data": {
                  schema: {
                    type: "object",
                    properties: {
                      document: {
                        type: "string",
                        format: "binary",
                        description: "Document file.",
                      },
                      label: { type: "string" },
                    },
                    required: ["document"],
                    additionalProperties: false,
                  },
                },
              },
            },
            responses: {
              "201": {
                description: "Created",
                content: { "application/json": { schema: { type: "object" } } },
              },
            },
          },
        },
      },
    } as JsonObject;
    const [endpoint] = compileContract(spec);
    const body = asObject(asObject(endpoint!.input_schema.properties).body);
    const document = asObject(asObject(body.properties).document);
    expect(document["x-browser-api-artifact-reference"]).toBe(true);
    validateInput(endpoint!, {
      body: { document: { artifact_id: "artifact_sha256" }, label: "test" },
    });
    expect(() =>
      validateInput(endpoint!, { body: { document: "/tmp/private.pdf" } }),
    ).toThrowError(AppError);
  });

  it("records unselected content variants instead of silently claiming them", () => {
    const spec = structuredClone(referencedContract);
    const operation = asObject(
      asObject(asObject(spec.paths)["/documents/{document_id}/parse"]).post,
    );
    const requestBody = asObject(operation.requestBody);
    const content = asObject(requestBody.content);
    content["application/xml"] = { schema: { type: "string" } };
    const [endpoint] = compileContract(spec);
    expect(
      JSON.stringify(endpoint!.input_schema["x-browser-api-coverage-gaps"]),
    ).toContain("application/xml");
  });
});

describe("unsupported contract features", () => {
  it("rejects remote references even when they occur outside a selected operation", () => {
    const spec = structuredClone(referencedContract);
    spec.components = {
      schemas: { External: { $ref: "https://example.com/schema.json" } },
    };
    expect(() => compileContract(spec)).toThrowError(
      /Remote and non-pointer references/u,
    );
  });

  it("rejects unsupported parameter locations", () => {
    const spec = structuredClone(referencedContract);
    const operation = asObject(
      asObject(asObject(spec.paths)["/documents/{document_id}/parse"]).post,
    );
    operation.parameters = [
      {
        name: "X-Secret",
        in: "header",
        required: true,
        schema: { type: "string" },
      },
    ];
    expect(() => compileContract(spec)).toThrowError(
      /unsupported location header/u,
    );
  });

  it("rejects path templates whose declared parameters do not match", () => {
    const spec = structuredClone(referencedContract);
    const pathItem = asObject(
      asObject(spec.paths)["/documents/{document_id}/parse"],
    );
    pathItem.parameters = [];
    expect(() => compileContract(spec)).toThrowError(
      /Path template and path parameters do not match/u,
    );
  });

  it("rejects unsupported request and response media types", () => {
    const xmlRequest = structuredClone(referencedContract);
    const requestOperation = asObject(
      asObject(asObject(xmlRequest.paths)["/documents/{document_id}/parse"])
        .post,
    );
    asObject(requestOperation.requestBody).content = {
      "application/xml": { schema: { type: "string" } },
    };
    expect(() => compileContract(xmlRequest)).toThrowError(
      /no supported media type/u,
    );

    const xmlResponse = structuredClone(referencedContract);
    const responseOperation = asObject(
      asObject(asObject(xmlResponse.paths)["/documents/{document_id}/parse"])
        .post,
    );
    asObject(asObject(responseOperation.responses)["200"]).content = {
      "application/xml": { schema: { type: "string" } },
    };
    expect(() => compileContract(xmlResponse)).toThrowError(
      /no supported JSON media type/u,
    );
  });
});
