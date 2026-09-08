import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { AppError } from "../src/errors.js";
import { Store } from "../src/store.js";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const directories: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
const stores: Store[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "browser-api-store-"));
  directories.push(directory);
  return directory;
}

function trackedStore(directory: string, maxArtifactBytes?: number): Store {
  const store = new Store(directory, maxArtifactBytes);
  stores.push(store);
  return store;
}

function spawnWorker(
  source: string,
  ...args: string[]
): ChildProcessWithoutNullStreams {
  const child = spawn(
    process.execPath,
    [
      "--no-warnings",
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      source,
      ...args,
    ],
    { cwd: projectRoot, stdio: ["pipe", "pipe", "pipe"] },
  );
  children.push(child);
  return child;
}

function waitForLine(
  child: ChildProcessWithoutNullStreams,
  accepts: (line: string) => boolean,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";

    const cleanup = () => {
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const complete = (line: string) => {
      cleanup();
      resolve(line);
    };
    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      for (;;) {
        const newline = stdout.indexOf("\n");
        if (newline < 0) return;
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        if (accepts(line)) {
          complete(line);
          return;
        }
      }
    };
    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          `Worker exited before its synchronization line (code=${String(code)}, signal=${String(signal)}): ${stderr}`,
        ),
      );
    };

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function waitForExit(
  child: ChildProcessWithoutNullStreams,
): Promise<[number | null, NodeJS.Signals | null]> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return [child.exitCode, child.signalCode];
  }
  return (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
}

afterEach(async () => {
  for (const store of stores.splice(0).reverse()) store.close();
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("store process ownership", () => {
  it("rejects a second process and recovers committed state after its owner is killed", async () => {
    const directory = temporaryDirectory();
    const owner = spawnWorker(
      `
        import { Store } from "./src/store.ts";
        const store = new Store(process.argv[1]);
        store.putSite({
          site_id: "persisted-site",
          account_id: "test-account",
          base_url: "https://example.test/",
          spec: { openapi: "3.1.0", info: { title: "Fixture", version: "1" }, paths: {} },
          contract_hash: "fixture-contract",
          created_at: "2026-01-01T00:00:00.000Z"
        });
        const artifact = store.putArtifact(Buffer.from("committed bytes"), "result.txt", "text/plain");
        process.stdout.write(JSON.stringify({ kind: "READY", artifactId: artifact.artifact_id }) + "\\n");
        process.stdin.resume();
      `,
      directory,
    );
    const ready = JSON.parse(
      await waitForLine(owner, (line) => line.includes('"kind":"READY"')),
    ) as { artifactId: string };

    const contender = spawnWorker(
      `
        import { Store } from "./src/store.ts";
        try {
          const store = new Store(process.argv[1]);
          store.close();
          process.stdout.write(JSON.stringify({ kind: "UNEXPECTED_OWNER" }) + "\\n");
          process.exitCode = 2;
        } catch (error) {
          process.stdout.write(JSON.stringify({
            kind: "LOCK_RESULT",
            code: error?.code,
            status: error?.status,
            message: error?.message
          }) + "\\n");
        }
      `,
      directory,
    );
    const lockResult = JSON.parse(
      await waitForLine(contender, (line) =>
        line.includes('"kind":"LOCK_RESULT"'),
      ),
    ) as { code: string; status: number; message: string };
    expect(lockResult).toMatchObject({ code: "store_locked", status: 409 });
    expect(lockResult.message).toContain("Another service owns");
    await waitForExit(contender);

    const ownerExited = waitForExit(owner);
    expect(owner.kill("SIGKILL")).toBe(true);
    const [, signal] = (await ownerExited) as [
      number | null,
      NodeJS.Signals | null,
    ];
    expect(signal).toBe("SIGKILL");

    const recovery = spawnWorker(
      `
        import { Store } from "./src/store.ts";
        const store = new Store(process.argv[1]);
        const site = store.site("persisted-site");
        const artifact = store.artifact(process.argv[2]);
        store.close();
        process.stdout.write(JSON.stringify({
          kind: "RECOVERED",
          siteId: site.site_id,
          artifactName: artifact.metadata.name,
          contents: Buffer.from(artifact.data).toString("utf8")
        }) + "\\n");
      `,
      directory,
      ready.artifactId,
    );
    const recovered = JSON.parse(
      await waitForLine(recovery, (line) =>
        line.includes('"kind":"RECOVERED"'),
      ),
    ) as { siteId: string; artifactName: string; contents: string };
    expect(recovered).toEqual({
      kind: "RECOVERED",
      siteId: "persisted-site",
      artifactName: "result.txt",
      contents: "committed bytes",
    });
    await waitForExit(recovery);
  });
});

describe("artifact representation storage", () => {
  it("deduplicates an exact representation but keeps name and media-type variants distinct", () => {
    const store = trackedStore(temporaryDirectory());
    const bytes = Buffer.from("identical content");

    const original = store.putArtifact(bytes, "report.pdf", "application/pdf");
    const duplicate = store.putArtifact(bytes, "report.pdf", "application/pdf");
    const renamed = store.putArtifact(bytes, "renamed.pdf", "application/pdf");
    const retagged = store.putArtifact(
      bytes,
      "report.pdf",
      "application/octet-stream",
    );

    expect(duplicate).toEqual(original);
    expect(
      new Set([
        original.artifact_id,
        renamed.artifact_id,
        retagged.artifact_id,
      ]),
    ).toHaveLength(3);
    expect(renamed.sha256).toBe(original.sha256);
    expect(retagged.sha256).toBe(original.sha256);
    expect(Buffer.from(store.artifact(original.artifact_id).data)).toEqual(
      bytes,
    );
    expect(Buffer.from(store.artifact(renamed.artifact_id).data)).toEqual(
      bytes,
    );
    expect(Buffer.from(store.artifact(retagged.artifact_id).data)).toEqual(
      bytes,
    );
  });

  it("detects same-length artifact corruption before returning bytes", () => {
    const store = trackedStore(temporaryDirectory());
    const artifact = store.putArtifact(
      Buffer.from("abcdef"),
      "result.txt",
      "text/plain",
    );
    writeFileSync(
      store.artifactPath(artifact.artifact_id),
      Buffer.from("ghijkl"),
    );

    try {
      store.artifact(artifact.artifact_id);
      expect.unreachable("corrupt artifact should not be returned");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ code: "artifact_corrupt", status: 500 });
    }
  });
});
