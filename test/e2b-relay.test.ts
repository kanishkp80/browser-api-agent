import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer, type Server } from "node:http";
import {
  connect,
  createServer as createNetServer,
  type Socket,
} from "node:net";
import os from "node:os";
import path from "node:path";
import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  E2B_CDP_RELAY_SOURCE,
  e2bCdpRelayAuthorization,
  generateE2BCdpRelaySecret,
} from "../src/e2b-relay.js";

const pythonAvailable =
  spawnSync("python3", ["--version"], {
    stdio: "ignore",
  }).status === 0;

async function unusedPort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

function websocketAccept(key: string): string {
  return createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
}

function maskedTextFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  if (payload.length >= 126) throw new Error("Test frame is too large");
  const mask = randomBytes(4);
  const frame = Buffer.alloc(6 + payload.length);
  frame[0] = 0x81;
  frame[1] = 0x80 | payload.length;
  mask.copy(frame, 2);
  for (let index = 0; index < payload.length; index += 1) {
    frame[6 + index] = payload[index]! ^ mask[index % 4]!;
  }
  return frame;
}

function unmaskedTextFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}

function installEchoUpgrade(server: Server, expectedPath: string): () => void {
  const sockets = new Set<Socket>();
  server.on("upgrade", (request, socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    if (request.url !== expectedPath) {
      socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.destroy();
      return;
    }
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Connection: Upgrade\r\n" +
        "Upgrade: websocket\r\n" +
        `Sec-WebSocket-Accept: ${websocketAccept(key)}\r\n\r\n`,
    );

    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length < 6) return;
      const length = buffered[1]! & 0x7f;
      if ((buffered[1]! & 0x80) === 0 || length >= 126) {
        socket.destroy();
        return;
      }
      if (buffered.length < 6 + length) return;
      const mask = buffered.subarray(2, 6);
      const payload = Buffer.alloc(length);
      for (let index = 0; index < length; index += 1) {
        payload[index] = buffered[6 + index]! ^ mask[index % 4]!;
      }
      if (payload.toString("utf8") === "ping") {
        socket.write(unmaskedTextFrame("pong"));
      }
      buffered = buffered.subarray(6 + length);
    });
  });
  return () => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
  };
}

async function websocketRoundTrip(
  port: number,
  pathName: string,
  authorization: string,
): Promise<string> {
  const socket = await new Promise<Socket>((resolve, reject) => {
    const candidate = connect(port, "127.0.0.1");
    candidate.once("connect", () => resolve(candidate));
    candidate.once("error", reject);
  });
  const key = randomBytes(16).toString("base64");
  socket.write(
    `GET ${pathName} HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${port}\r\n` +
      "Connection: Upgrade\r\n" +
      "Upgrade: websocket\r\n" +
      "Sec-WebSocket-Version: 13\r\n" +
      `Sec-WebSocket-Key: ${key}\r\n` +
      `Authorization: ${authorization}\r\n\r\n`,
  );

  let buffered = Buffer.alloc(0);
  await new Promise<void>((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf("\r\n\r\n");
      if (end < 0) return;
      socket.off("data", onData);
      const headers = buffered.subarray(0, end).toString("ascii");
      buffered = buffered.subarray(end + 4);
      if (!headers.startsWith("HTTP/1.1 101 ")) {
        reject(new Error(`Relay rejected WebSocket: ${headers}`));
        return;
      }
      resolve();
    };
    socket.on("data", onData);
    socket.once("error", reject);
    setTimeout(
      () => reject(new Error("WebSocket handshake timed out")),
      3_000,
    ).unref();
  });

  socket.write(maskedTextFrame("ping"));
  try {
    return await new Promise<string>((resolve, reject) => {
      const inspect = () => {
        if (buffered.length < 2) return;
        const length = buffered[1]! & 0x7f;
        if (buffered.length < 2 + length) return;
        resolve(buffered.subarray(2, 2 + length).toString("utf8"));
      };
      inspect();
      socket.on("data", (chunk: Buffer) => {
        buffered = Buffer.concat([buffered, chunk]);
        inspect();
      });
      socket.once("error", reject);
      setTimeout(
        () => reject(new Error("WebSocket response timed out")),
        3_000,
      ).unref();
    });
  } finally {
    socket.destroy();
  }
}

async function waitForRelay(url: string, authorization: string): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    try {
      const response = await fetch(url, {
        headers: { Authorization: authorization },
      });
      if (response.ok) return;
    } catch {
      // The relay process may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Relay did not start");
}

async function stopProcess(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

describe("E2B CDP relay helpers", () => {
  it("generates a header-safe high-entropy secret", () => {
    const first = generateE2BCdpRelaySecret();
    const second = generateE2BCdpRelaySecret();
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).not.toBe(first);
    expect(e2bCdpRelayAuthorization(first)).toBe(`Bearer ${first}`);
    expect(() => e2bCdpRelayAuthorization("unsafe secret")).toThrow(TypeError);
  });
});

describe.skipIf(!pythonAvailable)("E2B CDP relay protocol", () => {
  it("authenticates discovery and tunnels only an allowed browser WebSocket", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "e2b-cdp-relay-"),
    );
    const scriptPath = path.join(directory, "relay.py");
    const secretPath = path.join(directory, "relay.secret");
    const secret = generateE2BCdpRelaySecret();
    const authorization = e2bCdpRelayAuthorization(secret);
    const browserPath =
      "/devtools/browser/01234567-89ab-cdef-0123-456789abcdef";
    let child: ChildProcessWithoutNullStreams | undefined;
    const upstream = createServer((request, response) => {
      if (request.url !== "/json/version") {
        response.writeHead(404).end();
        return;
      }
      const address = upstream.address();
      if (!address || typeof address === "string")
        throw new Error("Missing port");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          Browser: "Synthetic Chromium",
          webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}${browserPath}`,
        }),
      );
    });
    const closeUpgrades = installEchoUpgrade(upstream, browserPath);

    try {
      const upstreamPort = await listen(upstream);
      const relayPort = await unusedPort();
      await fs.writeFile(scriptPath, E2B_CDP_RELAY_SOURCE, { mode: 0o700 });
      await fs.writeFile(secretPath, secret, { mode: 0o600 });
      child = spawn(
        "python3",
        [
          scriptPath,
          "--listen",
          "127.0.0.1",
          "--port",
          String(relayPort),
          "--upstream-port",
          String(upstreamPort),
          "--secret-file",
          secretPath,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      const endpoint = `http://127.0.0.1:${relayPort}`;
      await waitForRelay(`${endpoint}/json/version`, authorization);

      expect((await fetch(`${endpoint}/json/version`)).status).toBe(401);
      expect(
        (
          await fetch(`${endpoint}/json/version`, {
            headers: { Authorization: `${authorization}x` },
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await fetch(`${endpoint}/json/list`, {
            headers: { Authorization: authorization },
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await fetch(`${endpoint}${browserPath}?unexpected=true`, {
            headers: { Authorization: authorization },
          })
        ).status,
      ).toBe(404);

      const discovery = await fetch(`${endpoint}/json/version`, {
        headers: { Authorization: authorization },
      });
      expect(discovery.status).toBe(200);
      const document = (await discovery.json()) as {
        Browser: string;
        webSocketDebuggerUrl: string;
      };
      expect(document.Browser).toBe("Synthetic Chromium");
      expect(new URL(document.webSocketDebuggerUrl).pathname).toBe(browserPath);
      expect(
        await websocketRoundTrip(relayPort, browserPath, authorization),
      ).toBe("pong");
    } finally {
      if (child) await stopProcess(child);
      closeUpgrades();
      await closeServer(upstream);
      await fs.rm(directory, { recursive: true, force: true });
    }
  }, 15_000);
});
