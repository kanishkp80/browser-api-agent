import { loadConfig } from "./config.js";
import { createApplication } from "./service.js";
import { createHttpServer } from "./http.js";

const config = loadConfig();
const application = createApplication(config);
let server;
try {
  server = await createHttpServer(application);
  await server.listen({ host: config.host, port: config.port });
  process.stderr.write(
    `Browser API service listening at ${config.controlBaseUrl}\n`,
  );
  process.stderr.write(
    `Browser host: ${config.browserHost}. Durable state: ${config.dataDir}\n`,
  );
  if (!process.env.BROWSER_API_SERVICE_TOKEN)
    process.stderr.write(
      `Local client token is stored in ${config.dataDir}/service-token (not printed).\n`,
    );
} catch (error) {
  await application.close();
  throw error;
}
const activeServer = server;
let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await activeServer.close();
    await application.close();
  } catch (error) {
    process.stderr.write(
      `Shutdown failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
    );
    process.exitCode = 1;
  }
}
process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});
