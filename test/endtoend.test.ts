import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright";
import { createDemoSite } from "../examples/demo-site.js";
import { createHttpServer, BrowserApiHttpClient } from "../src/http.js";
import { BrowserApiService } from "../src/service.js";
import { loadConfig } from "../src/config.js";
import type { DiscoveryAgent, JsonObject, Operation } from "../src/types.js";

describe.skipIf(!existsSync(chromium.executablePath()))(
  "service → real browser → durable result",
  () => {
    it("uploads original file bytes through the UI, learns a workflow, then reuses it after restart", async () => {
      const dir = mkdtempSync(join(tmpdir(), "browser-api-e2e-"));
      const fixture = createDemoSite();
      await new Promise<void>((resolve, reject) => {
        fixture.once("error", reject);
        fixture.listen(0, "127.0.0.1", resolve);
      });
      const baseUrl = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}/`;
      const cfg = {
        ...loadConfig({
          BROWSER_API_DATA_DIR: dir,
          BROWSER_API_ALLOW_LOCAL_SITES: "true",
          BROWSER_API_SERVICE_TOKEN: "integration-test-token-".repeat(3),
        }),
        headless: true,
      };
      let calls = 0;
      const planner: DiscoveryAgent = {
        async next({ operation }) {
          calls++;
          const steps = operation.candidate_steps.filter(
            (step) => step.action.kind !== "navigate",
          ).length;
          if (steps === 0)
            return {
              kind: "action",
              message: "Choose the caller document",
              step: {
                action: {
                  kind: "upload",
                  target: { by: "label", value: "Document" },
                  artifact_id: "bound",
                },
                bindings: {
                  artifact_id: {
                    source: "input",
                    path: "/body/document/artifact_id",
                  },
                },
                effect: "none",
                description: "Select document",
              },
            };
          if (steps === 1)
            return {
              kind: "action",
              message: "Start requested parse",
              step: {
                action: {
                  kind: "click",
                  target: {
                    by: "role",
                    value: "button",
                    name: "Parse document",
                  },
                },
                effect: "submission",
                description: "Start parse",
              },
            };
          if (steps === 2)
            return {
              kind: "action",
              message: "Wait for completion",
              step: {
                action: {
                  kind: "wait",
                  target: { by: "text", value: "Complete" },
                  state: "visible",
                },
                effect: "none",
                description: "Wait for site result",
              },
            };
          if (steps === 3)
            return {
              kind: "action",
              message: "Read full result JSON",
              step: {
                action: {
                  kind: "read",
                  target: { by: "testid", value: "parse-result" },
                  format: "json",
                },
                effect: "none",
                save_as: "parsed",
                description: "Capture result JSON",
              },
            };
          return {
            kind: "finish",
            message: "Validate result",
            coverage_schema: {},
            response: {
              status: 200,
              headers: {
                "content-type": {
                  source: "output",
                  path: "/_evidence/parsed/media_type",
                },
              },
              body: { source: "output", path: "/parsed" },
            },
          };
        },
      };
      let service = new BrowserApiService(cfg, { agent: planner });
      let http = await createHttpServer(service);
      try {
        await http.listen({ host: "127.0.0.1", port: 0 });
        const address = http.server.address() as AddressInfo;
        const client = new BrowserApiHttpClient(
          `http://127.0.0.1:${address.port}`,
          cfg.serviceToken,
        );
        const spec = JSON.parse(
          readFileSync(
            new URL("../examples/specimen-openapi.json", import.meta.url),
            "utf8",
          ),
        ) as JsonObject;
        service.registerSite({
          site_id: "demo",
          account_id: "test",
          base_url: baseUrl,
          spec,
        });
        const artifact = service.putArtifact(
          Buffer.from("Evidence comes from this uploaded file."),
          "specimen.txt",
          "text/plain",
        );
        const request = {
          request_id: "first-run",
          site_id: "demo",
          endpoint: "parseDocument",
          input: { body: { document: { artifact_id: artifact.artifact_id } } },
        };
        const accepted = await client.execute(request);
        const wait = async (
          app: BrowserApiService,
          id: string,
        ): Promise<Operation> => {
          for (let i = 0; i < 60; i++) {
            const op = app.getOperation(id);
            if (
              [
                "succeeded",
                "failed",
                "needs_attention",
                "waiting_for_human",
              ].includes(op.state)
            )
              return op;
            await app.waitOperation(id, op.revision, 1000);
          }
          throw new Error("Browser workflow did not finish");
        };
        const first = await wait(service, accepted.operation_id);
        expect(first.error).toBeUndefined();
        expect(first.state).toBe("succeeded");
        expect(first.api_response?.body).toMatchObject({
          chunks: [{ text: "Evidence comes from this uploaded file." }],
        });
        expect(first.recipe_id).toBeDefined();
        const usedCalls = calls;
        await http.close();
        await service.close();
        service = new BrowserApiService(cfg, {
          agent: {
            async next() {
              throw new Error("Restart should reuse verified recipe");
            },
          },
        });
        const nextArtifact = service.putArtifact(
          Buffer.from("A different document after restart."),
          "second.txt",
          "text/plain",
        );
        const second = await service.execute({
          ...request,
          request_id: "after-restart",
          input: {
            body: { document: { artifact_id: nextArtifact.artifact_id } },
          },
        });
        const recovered = await wait(service, second.operation_id);
        expect(recovered.error).toBeUndefined();
        expect(recovered.state).toBe("succeeded");
        expect(recovered.api_response?.body).toMatchObject({
          chunks: [{ text: "A different document after restart." }],
        });
        expect(calls).toBe(usedCalls);
        const originalId = (first.api_response?.body as JsonObject).document_id;
        expect(
          (recovered.api_response?.body as JsonObject).document_id,
        ).not.toBe(originalId);
      } finally {
        await http.close();
        await service.close();
        await new Promise<void>((resolve, reject) =>
          fixture.close((error) => (error ? reject(error) : resolve())),
        );
        rmSync(dir, { recursive: true, force: true });
      }
    }, 60_000);
  },
);
