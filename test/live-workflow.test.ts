import { expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright";
import { createDemoSite } from "../examples/demo-site.js";
import { BrowserApiService } from "../src/service.js";
import { loadConfig } from "../src/config.js";
import type { JsonObject } from "../src/types.js";

const enabled =
  process.env.RUN_LIVE_WORKFLOW === "1" &&
  !!process.env.OPENAI_API_KEY &&
  existsSync(chromium.executablePath());
it.skipIf(!enabled)(
  "Astra Ultra autonomously learns a real UI workflow and then reuses it for new input",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "browser-api-live-"));
    const fixture = createDemoSite();
    await new Promise<void>((resolve, reject) => {
      fixture.once("error", reject);
      fixture.listen(0, "127.0.0.1", resolve);
    });
    const baseUrl = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}/`;
    const config = loadConfig({
      ...process.env,
      BROWSER_API_DATA_DIR: directory,
      BROWSER_API_ALLOW_LOCAL_SITES: "true",
      BROWSER_API_HEADLESS: "true",
      BROWSER_API_SERVICE_TOKEN: "synthetic-live-token-".repeat(3),
      BROWSER_API_DISCOVERY_BUDGET_MS: "240000",
    });
    let service = new BrowserApiService(config);
    try {
      const spec = JSON.parse(
        readFileSync(
          new URL("../examples/specimen-openapi.json", import.meta.url),
          "utf8",
        ),
      ) as JsonObject;
      service.registerSite({
        site_id: "synthetic",
        account_id: "test",
        base_url: baseUrl,
        spec,
      });
      const document = service.putArtifact(
        Buffer.from("Astra reads these synthetic document bytes."),
        "synthetic.txt",
        "text/plain",
      );
      const request = {
        request_id: "cold",
        site_id: "synthetic",
        endpoint: "parseDocument",
        input: { body: { document: { artifact_id: document.artifact_id } } },
      };
      const accepted = await service.execute(request);
      const settle = async (id: string) => {
        let cursor = 0;
        const deadline = Date.now() + 260000;
        while (Date.now() < deadline) {
          const update = await service.waitOperation(id, cursor, 5000);
          cursor = update.cursor;
          const op = update.operation;
          if (
            [
              "succeeded",
              "failed",
              "needs_attention",
              "waiting_for_human",
            ].includes(op.state) ||
            (op.state === "reconciling" && op.error)
          )
            return op;
        }
        throw new Error("Live workflow deadline exceeded");
      };
      const result = await settle(accepted.operation_id);
      expect({
        state: result.state,
        error: result.error,
        human: result.human_action,
        steps: result.candidate_steps,
        notes: result.notes,
      }).toMatchObject({ state: "succeeded" });
      expect(result.api_response?.body).toMatchObject({
        chunks: [{ text: "Astra reads these synthetic document bytes." }],
      });
      expect(result.notes).toContain("initial_review_completed");
      expect(result.recipe_id).toBeDefined();
      await service.close();
      service = new BrowserApiService(config, {
        agent: {
          async next() {
            throw new Error(
              "A synchronous learned workflow should replay without the planner",
            );
          },
        },
      });
      const next = service.putArtifact(
        Buffer.from("New input proves that the result is not cached."),
        "next.txt",
        "text/plain",
      );
      const warm = await service.execute({
        ...request,
        request_id: "warm",
        input: { body: { document: { artifact_id: next.artifact_id } } },
      });
      const replay = await settle(warm.operation_id);
      expect({ state: replay.state, error: replay.error }).toMatchObject({
        state: "succeeded",
      });
      expect(replay.api_response?.body).toMatchObject({
        chunks: [{ text: "New input proves that the result is not cached." }],
      });
    } finally {
      await service.close();
      await new Promise<void>((resolve) => fixture.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  },
  300000,
);
