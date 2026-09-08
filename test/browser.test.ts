import { createServer, type Server } from "node:http";
import { promises as fs, existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createBrowserProvider } from "../src/browser.js";
import type { AppConfig, Site } from "../src/types.js";

function config(
  dataDir: string,
  overrides: Partial<AppConfig> = {},
): AppConfig {
  return {
    dataDir,
    host: "127.0.0.1",
    port: 0,
    controlBaseUrl: "http://127.0.0.1",
    serviceToken: "test-service-token",
    browserHost: "local",
    headless: true,
    discoveryBudgetMs: 10_000,
    actionTimeoutMs: 5_000,
    heartbeatMs: 1_000,
    maxArtifactBytes: 1024 * 1024,
    allowLocalSites: true,
    ...overrides,
  };
}

function site(baseUrl: string): Site {
  return {
    site_id: "fake-site",
    account_id: "fake-account",
    base_url: baseUrl,
    spec: {},
    contract_hash: "contract-hash",
    created_at: "2026-09-08T00:00:00.000Z",
  };
}

let server: Server | undefined;
let baseUrl: string;

const browserExecutable = [
  chromium.executablePath(),
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find((candidate) => existsSync(candidate));
const browserAvailable = browserExecutable !== undefined;

describe.skipIf(!browserAvailable)("local Playwright browser provider", () => {
  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === "/redirect-outside") {
        const { port } = server?.address() as AddressInfo;
        response.writeHead(302, { location: `http://localhost:${port}/` });
        response.end();
        return;
      }
      if (request.url === "/download") {
        response.writeHead(200, {
          "content-type": "application/json",
          "content-disposition": 'attachment; filename="result.json"',
        });
        response.end('{"downloaded":true}');
        return;
      }
      if (request.url === "/result") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(
          "<!doctype html><title>Result</title><main><h1>Result page</h1></main>",
        );
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      const { port } = server?.address() as AddressInfo;
      response.end(`<!doctype html>
        <title>Browser API Test</title>
        <main>
          <h1>Browser API Test</h1>
          <pre id="payload">{"ok":true,"count":2}</pre>
          <button>Duplicate</button><button>Duplicate</button>
          <button id="ordinary">Ordinary button</button>
          <button id="generate">Generate report</button>
          <label>Document <input id="document" type="file"></label>
          <p id="uploaded">No file</p>
          <a href="/download" download>Download output</a>
          <a href="http://localhost:${port}/download" download>Outside download</a>
          <a id="blob-download" download="blob-result.txt">Blob output</a>
          <a href="/result">Results</a>
          <script>
            document.querySelector('#blob-download').href = URL.createObjectURL(
              new Blob(['blob download'], { type: 'text/plain' })
            );
            document.querySelector('#document').addEventListener('change', (event) => {
            const file = event.target.files[0];
            document.querySelector('#uploaded').textContent = file.name + '|' + file.type;
            });
          </script>
        </main>`);
    });
    await new Promise<void>((resolve) =>
      server?.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}/`;
  });

  afterAll(async () => {
    if (!server) return;
    await new Promise<void>((resolve, reject) =>
      server?.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("uses strict UI actions, complete artifacts, origin limits, and explicit headless handoff behavior", async () => {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "browser-api-provider-"),
    );
    const artifactDir = path.join(dataDir, "artifacts");
    await fs.mkdir(artifactDir, { recursive: true });
    const uploadPath = path.join(artifactDir, "art_1a2b3c");
    await fs.writeFile(uploadPath, '{"fixture":true}');
    const provider = createBrowserProvider(
      config(dataDir, { executablePath: browserExecutable }),
    );

    try {
      const session = await provider.connect(site(baseUrl));
      expect(await session.isAlive?.()).toBe(true);
      const observation = await session.observe();
      expect(observation.title).toBe("Browser API Test");
      expect(observation.content).toContain("Browser API Test");

      await expect(
        session.act({
          kind: "click",
          target: { by: "text", value: "Duplicate" },
        }),
      ).rejects.toMatchObject({ code: "browser_locator_ambiguous" });

      const json = await session.act({
        kind: "read",
        target: { by: "css", value: "#payload" },
        format: "json",
      });
      expect(json.value).toEqual({ ok: true, count: 2 });

      await session.act(
        {
          kind: "upload",
          target: { by: "label", value: "Document" },
          artifact_id: "ignored-by-browser-layer",
        },
        uploadPath,
        { name: "fixture.json", media_type: "application/json" },
      );
      const uploaded = await session.act({
        kind: "read",
        target: { by: "css", value: "#uploaded" },
        format: "text",
      });
      expect(uploaded.value).toBe("fixture.json|application/json");

      await expect(
        session.act(
          {
            kind: "upload",
            target: { by: "label", value: "Document" },
            artifact_id: "outside-scope",
          },
          "/etc/hosts",
          { name: "hosts.txt", media_type: "text/plain" },
        ),
      ).rejects.toMatchObject({ code: "invalid_upload_path" });

      await expect(
        session.act({
          kind: "download",
          target: { by: "role", value: "button", name: "Generate report" },
        }),
      ).rejects.toMatchObject({ code: "unsafe_download_target" });

      await expect(
        session.act({
          kind: "download",
          target: { by: "role", value: "link", name: "Outside download" },
        }),
      ).rejects.toMatchObject({ code: "browser_origin_not_allowed" });

      const downloaded = await session.act({
        kind: "download",
        target: { by: "role", value: "link", name: "Download output" },
      });
      expect(downloaded.download?.name).toBe("result.json");
      expect(
        Buffer.from(downloaded.download?.data ?? []).toString("utf8"),
      ).toBe('{"downloaded":true}');

      const blobDownloaded = await session.act({
        kind: "download",
        target: { by: "role", value: "link", name: "Blob output" },
      });
      expect(blobDownloaded.download?.name).toBe("blob-result.txt");
      expect(
        Buffer.from(blobDownloaded.download?.data ?? []).toString("utf8"),
      ).toBe("blob download");

      await expect(
        session.act({
          kind: "follow",
          target: { by: "role", value: "button", name: "Ordinary button" },
        }),
      ).rejects.toMatchObject({ code: "unsafe_follow_target" });

      await session.act({
        kind: "follow",
        target: { by: "role", value: "link", name: "Results" },
      });
      expect((await session.observe()).url).toBe(`${baseUrl}result`);

      await expect(
        session.act({
          kind: "navigate",
          url: baseUrl.replace("127.0.0.1", "localhost"),
        }),
      ).rejects.toMatchObject({ code: "browser_origin_not_allowed" });

      await expect(
        session.act({ kind: "navigate", url: `${baseUrl}redirect-outside` }),
      ).rejects.toMatchObject({ code: "browser_origin_not_allowed" });
      await session.releaseHumanControl?.();
      await expect(session.humanAccess()).rejects.toMatchObject({
        code: "human_handoff_unavailable",
      });

      expect(await session.isAlive?.()).toBe(true);
      await session.close();
      expect(await session.isAlive?.()).toBe(false);

      const replacement = await provider.connect(site(baseUrl));
      expect(replacement.id).not.toBe(session.id);
      expect(await replacement.isAlive?.()).toBe(true);
      expect((await replacement.observe()).title).toBe("Browser API Test");
      await provider.close();
      expect(await replacement.isAlive?.()).toBe(false);

      const profiles = await fs.readdir(path.join(dataDir, "browser-profiles"));
      expect(profiles).toHaveLength(1);
      expect(profiles[0]).toMatch(/^[a-f0-9]{32}$/);
    } finally {
      await provider.close();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("E2B browser provider configuration", () => {
  it("fails clearly before provisioning when credentials are absent", async () => {
    const provider = createBrowserProvider(
      config("/tmp/browser-api-e2b-test", {
        browserHost: "e2b",
        e2bTemplate: "pinned-template",
        e2bApiKey: undefined,
      }),
    );
    await expect(
      provider.connect(site("https://example.com/")),
    ).rejects.toMatchObject({ code: "e2b_credentials_missing" });
  });
});
