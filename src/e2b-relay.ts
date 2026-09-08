import { randomBytes } from "node:crypto";

export const E2B_CDP_RELAY_PORT = 9223;
export const E2B_CDP_RELAY_SCRIPT_PATH = "/tmp/browser-api-cdp-relay.py";
export const E2B_CDP_RELAY_SECRET_PATH = "/tmp/browser-api-cdp-relay.secret";

export interface E2BCdpRelayConfig {
  listenPort: number;
  upstreamPort: number;
  scriptPath: string;
  secretPath: string;
}

export const E2B_CDP_RELAY_CONFIG: Readonly<E2BCdpRelayConfig> = Object.freeze({
  listenPort: E2B_CDP_RELAY_PORT,
  upstreamPort: 9222,
  scriptPath: E2B_CDP_RELAY_SCRIPT_PATH,
  secretPath: E2B_CDP_RELAY_SECRET_PATH,
});

/** Generate an ephemeral credential for one relay in one sandbox. */
export function generateE2BCdpRelaySecret(): string {
  return randomBytes(32).toString("base64url");
}

/** Build the exact header value accepted by the relay. */
export function e2bCdpRelayAuthorization(secret: string): string {
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(secret)) {
    throw new TypeError("Invalid E2B CDP relay secret");
  }
  return `Bearer ${secret}`;
}

/**
 * A dependency-free HTTP/WebSocket proxy intended to run inside one E2B
 * desktop sandbox. Chrome remains bound to loopback; only this authenticated,
 * path-restricted relay listens on the sandbox interface.
 */
export const E2B_CDP_RELAY_SOURCE = String.raw`#!/usr/bin/env python3
import argparse
import base64
import hmac
import http.client
import http.server
import json
import os
import re
import select
import signal
import socket
import stat
import threading
from urllib.parse import urlsplit

MAX_DISCOVERY_BYTES = 128 * 1024
MAX_HANDSHAKE_BYTES = 32 * 1024
BUFFER_BYTES = 64 * 1024
SAFE_BROWSER_PATH = re.compile(r"^/devtools/browser/[0-9A-Fa-f-]{8,128}$")
SAFE_SECRET = re.compile(rb"^[A-Za-z0-9_-]{43,128}$")


def read_secret(path):
    metadata = os.lstat(path)
    if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        raise RuntimeError("Relay secret must be a regular file")
    if metadata.st_uid != os.geteuid():
        raise RuntimeError("Relay secret must be owned by the relay user")
    if stat.S_IMODE(metadata.st_mode) != 0o600:
        raise RuntimeError("Relay secret must have mode 0600")
    with open(path, "rb", buffering=0) as handle:
        value = handle.read(129)
    if not SAFE_SECRET.fullmatch(value):
        raise RuntimeError("Relay secret has an invalid format")
    return value


def header_value_is_safe(value):
    return value is not None and "\r" not in value and "\n" not in value


def websocket_key_is_valid(value):
    if not header_value_is_safe(value):
        return False
    try:
        return len(base64.b64decode(value, validate=True)) == 16
    except Exception:
        return False


def has_token(value, wanted):
    if not header_value_is_safe(value):
        return False
    try:
        supplied = value.encode("ascii")
    except UnicodeEncodeError:
        return False
    return hmac.compare_digest(supplied, wanted)


def has_upgrade_token(value):
    if not header_value_is_safe(value):
        return False
    return any(token.strip().lower() == "upgrade" for token in value.split(","))


def receive_headers(sock):
    data = bytearray()
    while b"\r\n\r\n" not in data:
        chunk = sock.recv(min(BUFFER_BYTES, MAX_HANDSHAKE_BYTES + 1 - len(data)))
        if not chunk:
            raise ConnectionError("Upstream closed during WebSocket handshake")
        data.extend(chunk)
        if len(data) > MAX_HANDSHAKE_BYTES:
            raise ValueError("Upstream WebSocket handshake was too large")
    return bytes(data)


def valid_upgrade_response(data):
    header = data.split(b"\r\n\r\n", 1)[0]
    lines = header.split(b"\r\n")
    if not lines or not lines[0].startswith(b"HTTP/1.1 101 "):
        return False
    fields = {}
    for line in lines[1:]:
        if b":" not in line:
            return False
        name, value = line.split(b":", 1)
        fields.setdefault(name.strip().lower(), []).append(value.strip().lower())
    upgrades = b",".join(fields.get(b"upgrade", []))
    connections = b",".join(fields.get(b"connection", []))
    return upgrades == b"websocket" and b"upgrade" in [
        token.strip() for token in connections.split(b",")
    ]


class RelayHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "BrowserApiCdpRelay"
    sys_version = ""
    rbufsize = 0
    wbufsize = 0

    def log_message(self, _format, *_args):
        return

    def send_json(self, status, payload, extra_headers=None):
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if extra_headers:
            for name, value in extra_headers.items():
                self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def authenticated(self):
        values = self.headers.get_all("Authorization") or []
        return len(values) == 1 and has_token(values[0], self.server.authorization)

    def do_GET(self):
        if not self.authenticated():
            self.send_json(
                401,
                {"error": "authentication_required"},
                {"WWW-Authenticate": "Bearer"},
            )
            return

        parsed = urlsplit(self.path)
        if parsed.query or parsed.fragment:
            self.send_json(404, {"error": "not_found"})
            return

        if parsed.path == "/json/version":
            self.proxy_version()
            return

        if SAFE_BROWSER_PATH.fullmatch(parsed.path):
            self.proxy_websocket(parsed.path)
            return

        self.send_json(404, {"error": "not_found"})

    def do_HEAD(self):
        self.send_json(405, {"error": "method_not_allowed"})

    do_POST = do_HEAD
    do_PUT = do_HEAD
    do_PATCH = do_HEAD
    do_DELETE = do_HEAD
    do_OPTIONS = do_HEAD

    def proxy_version(self):
        connection = http.client.HTTPConnection(
            "127.0.0.1", self.server.upstream_port, timeout=5
        )
        try:
            connection.request(
                "GET",
                "/json/version",
                headers={"Host": "127.0.0.1", "Connection": "close"},
            )
            response = connection.getresponse()
            body = response.read(MAX_DISCOVERY_BYTES + 1)
            if response.status != 200 or len(body) > MAX_DISCOVERY_BYTES:
                raise ValueError("Invalid Chrome discovery response")
            document = json.loads(body)
            if not isinstance(document, dict):
                raise ValueError("Invalid Chrome discovery document")
            endpoint = document.get("webSocketDebuggerUrl")
            if not isinstance(endpoint, str):
                raise ValueError("Missing Chrome debugger endpoint")
            parsed = urlsplit(endpoint)
            if (
                parsed.scheme not in ("ws", "wss")
                or parsed.hostname not in ("127.0.0.1", "localhost", "::1")
                or parsed.query
                or parsed.fragment
                or not SAFE_BROWSER_PATH.fullmatch(parsed.path)
            ):
                raise ValueError("Unsafe Chrome debugger endpoint")
            document["webSocketDebuggerUrl"] = (
                "ws://127.0.0.1:" + str(self.server.server_port) + parsed.path
            )
            self.send_json(200, document)
        except Exception:
            self.send_json(502, {"error": "upstream_unavailable"})
        finally:
            connection.close()

    def proxy_websocket(self, path):
        if (
            self.headers.get("Upgrade", "").lower() != "websocket"
            or not has_upgrade_token(self.headers.get("Connection"))
            or self.headers.get("Sec-WebSocket-Version") != "13"
            or not websocket_key_is_valid(self.headers.get("Sec-WebSocket-Key"))
        ):
            self.send_json(400, {"error": "invalid_websocket_upgrade"})
            return

        forwarded = [
            "GET " + path + " HTTP/1.1",
            "Host: 127.0.0.1:" + str(self.server.upstream_port),
            "Connection: Upgrade",
            "Upgrade: websocket",
            "Sec-WebSocket-Version: 13",
            "Sec-WebSocket-Key: " + self.headers["Sec-WebSocket-Key"],
        ]
        for header in ("Sec-WebSocket-Extensions", "Sec-WebSocket-Protocol", "Origin"):
            value = self.headers.get(header)
            if value is not None:
                if not header_value_is_safe(value) or len(value) > 4096:
                    self.send_json(400, {"error": "invalid_websocket_upgrade"})
                    return
                forwarded.append(header + ": " + value)
        request = ("\r\n".join(forwarded) + "\r\n\r\n").encode("ascii")

        upstream = None
        try:
            upstream = socket.create_connection(
                ("127.0.0.1", self.server.upstream_port), timeout=5
            )
            upstream.sendall(request)
            response = receive_headers(upstream)
            if not valid_upgrade_response(response):
                raise ConnectionError("Chrome rejected WebSocket upgrade")
            self.connection.sendall(response)
            self.close_connection = True
            upstream.settimeout(None)
            self.connection.settimeout(None)
            peers = [self.connection, upstream]
            while True:
                readable, _, exceptional = select.select(peers, [], peers, 60)
                if exceptional:
                    return
                if not readable:
                    continue
                for source in readable:
                    data = source.recv(BUFFER_BYTES)
                    if not data:
                        return
                    target = upstream if source is self.connection else self.connection
                    target.sendall(data)
        except Exception:
            if not self.close_connection:
                self.send_json(502, {"error": "upstream_unavailable"})
        finally:
            if upstream is not None:
                try:
                    upstream.close()
                except Exception:
                    pass


class RelayServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, authorization, upstream_port):
        super().__init__(address, RelayHandler)
        self.authorization = authorization
        self.upstream_port = upstream_port


def bounded_port(value):
    port = int(value)
    if port < 1 or port > 65535:
        raise argparse.ArgumentTypeError("Port must be between 1 and 65535")
    return port


def main():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--listen", default="0.0.0.0")
    parser.add_argument("--port", required=True, type=bounded_port)
    parser.add_argument("--upstream-port", required=True, type=bounded_port)
    parser.add_argument("--secret-file", required=True)
    args = parser.parse_args()
    if args.listen not in ("0.0.0.0", "127.0.0.1"):
        raise RuntimeError("Relay listen address is not allowed")

    secret = read_secret(args.secret_file)
    server = RelayServer(
        (args.listen, args.port), b"Bearer " + secret, args.upstream_port
    )

    def stop(_signum, _frame):
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        server.serve_forever(poll_interval=0.25)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
`;
