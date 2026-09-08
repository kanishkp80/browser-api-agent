#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Command, Option } from "commander";

import { BrowserApiHttpClient, ServiceClientError } from "./http.js";
import {
  terminalStates,
  type JsonObject,
  type SiteRegistration,
} from "./types.js";

const DEFAULT_SERVICE_URL = "http://127.0.0.1:8765";
const DEFAULT_TOKEN_ENV = "BROWSER_API_SERVICE_TOKEN";
const DEFAULT_HANDOFF_TOKEN_ENV = "BROWSER_API_HANDOFF_TOKEN";
const ATTENTION_EXIT_CODE = 10;

interface GlobalOptions {
  serviceUrl: string;
  tokenEnv: string;
  json?: boolean;
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function diagnostic(value: unknown): void {
  process.stderr.write(`${JSON.stringify(value)}\n`);
}

async function readStdin(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let result = "";
  for await (const chunk of process.stdin) result += chunk;
  return result;
}

async function readJson(path: string): Promise<unknown> {
  const text =
    path === "-" ? await readStdin() : await readFile(resolve(path), "utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new CliError(
      "invalid_json",
      `Unable to parse JSON from ${path === "-" ? "stdin" : path}`,
      2,
    );
  }
}

function object(value: unknown, description: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CliError(
      "invalid_input",
      `${description} must contain a JSON object`,
      2,
    );
  }
  return value as JsonObject;
}

function numberOption(
  value: string,
  label: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) {
    throw new CliError(
      "invalid_option",
      `${label} must be an integer from 0 to ${maximum}`,
      2,
    );
  }
  return parsed;
}

class CliError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly exitCode: number,
  ) {
    super(message);
    this.name = "CliError";
  }
}

function clientFor(command: Command): BrowserApiHttpClient {
  const options = command.optsWithGlobals<GlobalOptions>();
  const token = process.env[options.tokenEnv];
  if (token === undefined || token === "") {
    throw new CliError(
      "missing_service_token",
      `Set the ${options.tokenEnv} environment variable`,
      2,
    );
  }
  return new BrowserApiHttpClient(options.serviceUrl, token);
}

function handoffTokenFor(environmentName: string): string {
  const token = process.env[environmentName];
  if (token === undefined || token === "") {
    throw new CliError(
      "missing_handoff_token",
      `Set the ${environmentName} environment variable to the claim_token returned by handoffs claim`,
      2,
    );
  }
  return token;
}

function attachSitesCommands(program: Command): void {
  const sites = program
    .command("sites")
    .description("Register and inspect API sites");
  sites.command("list").action(async (_options, command: Command) => {
    output(await clientFor(command).listSites());
  });
  sites
    .command("register")
    .requiredOption(
      "--file <path>",
      "Site registration JSON file, or - for stdin",
    )
    .action(async (options: { file: string }, command: Command) => {
      const registration = object(
        await readJson(options.file),
        "Site registration",
      ) as unknown as SiteRegistration;
      output(await clientFor(command).registerSite(registration));
    });
  sites
    .command("spec")
    .requiredOption("--site <site-id>", "Registered site ID")
    .action(async (options: { site: string }, command: Command) => {
      output(await clientFor(command).getSpec(options.site));
    });
}

function attachEndpointCommands(program: Command): void {
  const endpoints = program
    .command("endpoints")
    .description("Inspect parsed endpoint contracts");
  endpoints
    .command("list")
    .requiredOption("--site <site-id>", "Registered site ID")
    .action(async (options: { site: string }, command: Command) => {
      output(await clientFor(command).listEndpoints(options.site));
    });
}

function attachOperationCommands(program: Command): void {
  program
    .command("execute")
    .requiredOption("--site <site-id>", "Registered site ID")
    .requiredOption(
      "--endpoint <key>",
      "Endpoint operation ID or normalized method/path key",
    )
    .requiredOption(
      "--input <path>",
      "Endpoint input JSON object file, or - for stdin",
    )
    .requiredOption("--request-id <id>", "Stable caller-generated retry key")
    .option("--wait-timeout <ms>", "Bounded initial wait after acceptance", "0")
    .action(
      async (
        options: {
          site: string;
          endpoint: string;
          input: string;
          requestId: string;
          waitTimeout: string;
        },
        command: Command,
      ) => {
        const client = clientFor(command);
        const operation = await client.execute({
          request_id: options.requestId,
          site_id: options.site,
          endpoint: options.endpoint,
          input: object(await readJson(options.input), "Endpoint input"),
        });
        const timeoutMs = numberOption(
          options.waitTimeout,
          "--wait-timeout",
          30_000,
        );
        if (
          timeoutMs === 0 ||
          terminalStates.has(operation.state) ||
          operation.state === "waiting_for_human" ||
          operation.state === "needs_attention"
        ) {
          output(operation);
          if (
            operation.state === "waiting_for_human" ||
            operation.state === "needs_attention"
          )
            process.exitCode = ATTENTION_EXIT_CODE;
          return;
        }
        const update = await client.waitOperation(
          operation.operation_id,
          operation.revision,
          timeoutMs,
        );
        output(update);
        if (
          update.operation.state === "waiting_for_human" ||
          update.operation.state === "needs_attention"
        ) {
          process.exitCode = ATTENTION_EXIT_CODE;
        }
      },
    );

  program
    .command("get")
    .argument("<operation-id>")
    .action(async (operationId: string, _options, command: Command) => {
      output(await clientFor(command).getOperation(operationId));
    });

  program
    .command("result")
    .argument("<operation-id>")
    .action(async (operationId: string, _options, command: Command) => {
      output(await clientFor(command).getResult(operationId));
    });

  program
    .command("cancel")
    .argument("<operation-id>")
    .action(async (operationId: string, _options, command: Command) => {
      output(await clientFor(command).cancel(operationId));
    });

  program
    .command("resume")
    .argument("<operation-id>")
    .option("--extend-ms <ms>", "Additional active discovery budget")
    .option("--note <text>", "Operator note")
    .action(
      async (
        operationId: string,
        options: { extendMs?: string; note?: string },
        command: Command,
      ) => {
        output(
          await clientFor(command).resume(operationId, {
            ...(options.extendMs === undefined
              ? {}
              : {
                  extend_ms: numberOption(
                    options.extendMs,
                    "--extend-ms",
                    86_400_000,
                  ),
                }),
            ...(options.note === undefined ? {} : { note: options.note }),
          }),
        );
      },
    );

  program
    .command("events")
    .argument("<operation-id>")
    .option(
      "--after <revision>",
      "Resume after this durable event revision",
      "0",
    )
    .option("--watch", "Reconnect and follow until terminal or human attention")
    .action(
      async (
        operationId: string,
        options: { after: string; watch?: boolean },
        command: Command,
      ) => {
        const client = clientFor(command);
        let cursor = numberOption(options.after, "--after");
        if (!options.watch) {
          const update = await client.waitOperation(operationId, cursor, 0);
          if (update.events.length === 0)
            output({
              type: "operation_snapshot",
              operation: update.operation,
              cursor: update.cursor,
            });
          for (const event of update.events) output(event);
          return;
        }

        const controller = new AbortController();
        const stop = () => controller.abort();
        process.once("SIGINT", stop);
        let retryMs = 250;
        try {
          while (!controller.signal.aborted) {
            try {
              for await (const event of client.events(
                operationId,
                cursor,
                true,
                controller.signal,
              )) {
                output(event);
                cursor = Math.max(cursor, event.sequence);
                retryMs = 250;
                if (
                  event.state === "waiting_for_human" ||
                  event.state === "needs_attention"
                ) {
                  process.exitCode = ATTENTION_EXIT_CODE;
                  return;
                }
              }
              const operation = await client.getOperation(operationId);
              if (terminalStates.has(operation.state)) return;
            } catch (error) {
              if (controller.signal.aborted) return;
              if (error instanceof ServiceClientError) throw error;
              diagnostic({
                type: "event_stream_reconnect",
                operation_id: operationId,
                after: cursor,
                retry_ms: retryMs,
              });
            }
            await new Promise<void>((done) => {
              const timer = setTimeout(done, retryMs);
              controller.signal.addEventListener(
                "abort",
                () => {
                  clearTimeout(timer);
                  done();
                },
                { once: true },
              );
            });
            retryMs = Math.min(retryMs * 2, 5_000);
          }
        } finally {
          process.removeListener("SIGINT", stop);
        }
      },
    );
}

function attachHandoffCommands(program: Command): void {
  const handoffs = program
    .command("handoffs")
    .description("Claim, open, and return exclusive human browser control");

  handoffs
    .command("claim")
    .argument("<operation-id>")
    .action(async (operationId: string, _options, command: Command) => {
      output(await clientFor(command).claimHandoff(operationId));
    });

  handoffs
    .command("access")
    .argument("<operation-id>")
    .option(
      "--claim-token-env <name>",
      "Environment variable containing the handoff claim token",
      DEFAULT_HANDOFF_TOKEN_ENV,
    )
    .action(
      async (
        operationId: string,
        options: { claimTokenEnv: string },
        command: Command,
      ) => {
        output(
          await clientFor(command).humanAccess(
            operationId,
            handoffTokenFor(options.claimTokenEnv),
          ),
        );
      },
    );

  handoffs
    .command("return")
    .argument("<operation-id>")
    .requiredOption(
      "--outcome <outcome>",
      "no_submission, submitted, or unknown",
    )
    .requiredOption("--note <text>", "What the human did in the browser")
    .option(
      "--claim-token-env <name>",
      "Environment variable containing the handoff claim token",
      DEFAULT_HANDOFF_TOKEN_ENV,
    )
    .action(
      async (
        operationId: string,
        options: {
          claimTokenEnv: string;
          note: string;
          outcome: string;
        },
        command: Command,
      ) => {
        if (
          options.outcome !== "no_submission" &&
          options.outcome !== "submitted" &&
          options.outcome !== "unknown"
        ) {
          throw new CliError(
            "invalid_option",
            "--outcome must be no_submission, submitted, or unknown",
            2,
          );
        }
        output(
          await clientFor(command).returnHandoff(
            operationId,
            handoffTokenFor(options.claimTokenEnv),
            options.note,
            options.outcome,
          ),
        );
      },
    );
}

function attachArtifactCommands(program: Command): void {
  const artifacts = program
    .command("artifacts")
    .description("Upload and download durable artifacts");
  artifacts
    .command("upload")
    .argument("<path>")
    .option("--name <name>", "Artifact display name")
    .option(
      "--media-type <type>",
      "Artifact media type",
      "application/octet-stream",
    )
    .action(
      async (
        path: string,
        options: { name?: string; mediaType: string },
        command: Command,
      ) => {
        const absolute = resolve(path);
        const data = await readFile(absolute);
        output(
          await clientFor(command).putArtifactBytes(
            data,
            options.name ?? basename(absolute),
            options.mediaType,
          ),
        );
      },
    );

  artifacts
    .command("get")
    .argument("<artifact-id>")
    .action(async (artifactId: string, _options, command: Command) => {
      output(await clientFor(command).getArtifactMetadata(artifactId));
    });

  artifacts
    .command("download")
    .argument("<artifact-id>")
    .requiredOption("--output <path>", "Destination file")
    .option("--force", "Replace an existing destination file")
    .action(
      async (
        artifactId: string,
        options: { output: string; force?: boolean },
        command: Command,
      ) => {
        const client = clientFor(command);
        const metadata = await client.getArtifactMetadata(artifactId);
        const { data } = await client.getArtifactBytes(artifactId);
        const destination = resolve(options.output);
        await writeFile(destination, data, {
          flag: options.force ? "w" : "wx",
        });
        output({ artifact: metadata, output: destination });
      },
    );
}

export function createCli(): Command {
  const program = new Command()
    .name("browser-api")
    .description("Call an existing browser API agent service")
    .version("0.1.0")
    .option(
      "--service-url <url>",
      "Browser API service URL",
      process.env.BROWSER_API_SERVICE_URL ?? DEFAULT_SERVICE_URL,
    )
    .option(
      "--json",
      "Emit machine-readable JSON or NDJSON (the default output format)",
    )
    .addOption(
      new Option(
        "--token-env <name>",
        "Environment variable containing the service token",
      ).default(DEFAULT_TOKEN_ENV),
    );

  attachSitesCommands(program);
  attachEndpointCommands(program);
  attachOperationCommands(program);
  attachHandoffCommands(program);
  attachArtifactCommands(program);
  return program;
}

export async function runCli(argv = process.argv): Promise<void> {
  await createCli().parseAsync(argv);
}

function exitCode(error: unknown): number {
  if (error instanceof CliError) return error.exitCode;
  if (error instanceof ServiceClientError) {
    if (error.status === 401 || error.status === 403) return 4;
    if (error.status === 404) return 3;
    if (error.status >= 400 && error.status < 500) return 2;
  }
  return 1;
}

const invokedPath =
  process.argv[1] === undefined
    ? undefined
    : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  runCli().catch((error: unknown) => {
    const stable =
      error instanceof ServiceClientError
        ? {
            code: error.code,
            message: error.message,
            ...(error.details === undefined ? {} : { details: error.details }),
          }
        : error instanceof CliError
          ? { code: error.code, message: error.message }
          : { code: "cli_failed", message: "Browser API command failed" };
    diagnostic({ ok: false, error: stable });
    process.exitCode = exitCode(error);
  });
}
