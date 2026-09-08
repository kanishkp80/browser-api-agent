import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
import { AppError } from "./errors.js";
import type { AppConfig } from "./types.js";

function integer(
  value: string | undefined,
  fallback: number,
  name: string,
  min = 1,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max)
    throw new AppError(
      "invalid_config",
      `${name} must be an integer between ${min} and ${max}`,
    );
  return parsed;
}
function flag(
  value: string | undefined,
  fallback: boolean,
  name: string,
): boolean {
  if (value === undefined) return fallback;
  if (value !== "true" && value !== "false")
    throw new AppError("invalid_config", `${name} must be true or false`);
  return value === "true";
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const dataDir = resolve(env.BROWSER_API_DATA_DIR ?? ".browser-api");
  const host = env.BROWSER_API_HOST ?? "127.0.0.1";
  const port = integer(
    env.BROWSER_API_PORT,
    8765,
    "BROWSER_API_PORT",
    1,
    65535,
  );
  const local = ["127.0.0.1", "::1", "localhost"].includes(host);
  const browserHost = env.BROWSER_API_BROWSER_HOST ?? "local";
  if (browserHost !== "local" && browserHost !== "e2b")
    throw new AppError(
      "invalid_config",
      "BROWSER_API_BROWSER_HOST must be local or e2b",
    );
  if (browserHost === "e2b" && !env.E2B_API_KEY)
    throw new AppError(
      "missing_e2b_key",
      "E2B_API_KEY is required for e2b mode; local fallback is disabled",
    );
  const controlBaseUrl = (
    env.BROWSER_API_CONTROL_BASE_URL ??
    `http://${host === "::1" ? "[::1]" : host}:${port}`
  ).replace(/\/$/, "");
  let control: URL;
  try {
    control = new URL(controlBaseUrl);
  } catch {
    throw new AppError(
      "invalid_config",
      "BROWSER_API_CONTROL_BASE_URL must be an absolute URL",
    );
  }
  if (
    !["http:", "https:"].includes(control.protocol) ||
    control.username ||
    control.password ||
    control.search ||
    control.hash
  )
    throw new AppError(
      "invalid_config",
      "Control URL must be HTTP(S) without credentials, query, or fragment",
    );
  if (
    !local &&
    (!env.BROWSER_API_SERVICE_TOKEN || control.protocol !== "https:")
  )
    throw new AppError(
      "invalid_config",
      "Remote listeners require BROWSER_API_SERVICE_TOKEN and an HTTPS control URL",
    );
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  const tokenPath = resolve(dataDir, "service-token");
  let serviceToken = env.BROWSER_API_SERVICE_TOKEN;
  if (!serviceToken) {
    try {
      serviceToken = readFileSync(tokenPath, "utf8").trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      serviceToken = randomBytes(32).toString("base64url");
      try {
        writeFileSync(tokenPath, serviceToken, { mode: 0o600, flag: "wx" });
      } catch (writeError) {
        if ((writeError as NodeJS.ErrnoException).code !== "EEXIST")
          throw writeError;
        serviceToken = readFileSync(tokenPath, "utf8").trim();
      }
    }
  }
  if (serviceToken.length < 32 || /\s/.test(serviceToken))
    throw new AppError(
      "invalid_config",
      "Service token must contain at least 32 non-whitespace characters",
    );
  return {
    dataDir,
    host,
    port,
    controlBaseUrl,
    serviceToken,
    browserHost,
    headless: flag(env.BROWSER_API_HEADLESS, false, "BROWSER_API_HEADLESS"),
    executablePath: env.BROWSER_API_EXECUTABLE_PATH,
    e2bApiKey: env.E2B_API_KEY,
    e2bTemplate: env.BROWSER_API_E2B_TEMPLATE,
    openaiApiKey: env.OPENAI_API_KEY,
    discoveryBudgetMs: integer(
      env.BROWSER_API_DISCOVERY_BUDGET_MS,
      600_000,
      "BROWSER_API_DISCOVERY_BUDGET_MS",
      100,
    ),
    actionTimeoutMs: integer(
      env.BROWSER_API_ACTION_TIMEOUT_MS,
      30_000,
      "BROWSER_API_ACTION_TIMEOUT_MS",
      100,
    ),
    heartbeatMs: integer(
      env.BROWSER_API_HEARTBEAT_MS,
      15_000,
      "BROWSER_API_HEARTBEAT_MS",
      100,
    ),
    maxArtifactBytes: integer(
      env.BROWSER_API_MAX_ARTIFACT_BYTES,
      50 * 1024 * 1024,
      "BROWSER_API_MAX_ARTIFACT_BYTES",
      1,
      500 * 1024 * 1024,
    ),
    allowLocalSites: flag(
      env.BROWSER_API_ALLOW_LOCAL_SITES,
      false,
      "BROWSER_API_ALLOW_LOCAL_SITES",
    ),
  };
}
