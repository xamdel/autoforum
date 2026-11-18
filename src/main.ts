import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";

import { serve, type ServerType } from "@hono/node-server";

import { createApp } from "./app.ts";
import { startAgentRunner } from "./agents/runner.ts";
import { reconcileScribeConversations } from "./chat.ts";
import { loadConfig, type AppConfig } from "./config.ts";
import { createDatabase } from "./db.ts";
import { startAgentLog, type AgentLog } from "./logging/agents.ts";
import { startSystemLog } from "./logging/system.ts";
import { startServiceRelay, type RunningServiceRelay } from "./service-access/relay.ts";
import { ServiceAccess } from "./service-access/services.ts";
import { resolveModelApiKey, sandboxModelService } from "./model-adapters/pi.ts";
import { startQueue } from "./queue.ts";
import { startResultImporter } from "./forum/results.ts";
import { reconcileSandboxes } from "./sandbox/lifecycle.ts";

export interface RunningApplication {
  origin: string;
  stop(): Promise<void>;
}

async function closeServer(server: ServerType): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function listen(config: AppConfig, fetch: HonoFetch) {
  let address: AddressInfo | undefined;
  const server = serve({ fetch, hostname: config.host, port: config.port }, (value) => {
    address = value;
  });
  server.on("upgrade", (_request, socket) => {
    socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });

  if (!address) {
    await once(server, "listening");
    const value = server.address();
    if (!value || typeof value === "string") throw new Error("HTTP server has no TCP address");
    address = value;
  }

  return { server, address };
}

type HonoFetch = (request: Request) => Response | Promise<Response>;

export async function startApplication(config: AppConfig = loadConfig()): Promise<RunningApplication> {
  const systemLog = await startSystemLog();
  systemLog.info("application.starting", {
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
  });
  const database = createDatabase(config.databaseUrl, (error) => systemLog.error("database.idle_client_error", error));
  let queue: Awaited<ReturnType<typeof startQueue>> | undefined;
  let agentLog: AgentLog | undefined;
  let resultImporter: ReturnType<typeof startResultImporter> | undefined;
  let serviceRelay: RunningServiceRelay | undefined;
  let server: ServerType | undefined;

  try {
    await database.migrate();
    await reconcileScribeConversations(database);
    agentLog = await startAgentLog();
    const serviceAccess = await ServiceAccess.open({
      modelCredentials: { service: sandboxModelService, resolve: resolveModelApiKey },
    });
    serviceRelay = await startServiceRelay(serviceAccess, {
      onError: (error) => systemLog.error("service_access.relay_error", error),
    });
    const serviceAccessSidecar = (project: Parameters<typeof serviceAccess.sidecarConfiguration>[0]) => ({
      ...serviceAccess.sidecarConfiguration(project, serviceRelay!.brokerToken),
      connectBroker: serviceRelay!.connectBroker,
    });
    void reconcileSandboxes(serviceAccessSidecar)
      .then((duplicates) => {
        if (duplicates.length) systemLog.warn("sandbox.duplicates_found", { duplicates });
      })
      .catch((error) => systemLog.error("sandbox.reconciliation_failed", error));
    queue = await startQueue(config.databaseUrl, (error) => systemLog.error("queue.error", error));
    await startAgentRunner(database, queue, agentLog);
    resultImporter = startResultImporter(database, systemLog);
    const app = createApp({
      checkDatabase: database.check,
      isQueueRunning: queue.isRunning,
      database,
      agentLog,
      agentRunner: queue,
      serviceAccess,
      serviceAccessSidecar,
      systemLog,
      port: config.port,
      enqueueAgentTurns: queue.enqueueAgentTurns,
      webRoot: config.nodeEnv === "production"
        ? fileURLToPath(new URL("../dist/web", import.meta.url))
        : undefined,
    });
    const listening = await listen(config, app.fetch);
    server = listening.server;
    const origin = `http://${config.host}:${listening.address.port}`;
    systemLog.info("application.ready", { origin });

    let stopping: Promise<void> | undefined;
    return {
      origin,
      stop() {
        stopping ??= (async () => {
          systemLog.info("application.stopping");
          try {
            await closeServer(listening.server);
            await serviceRelay?.stop();
            await resultImporter?.stop();
            await queue?.stop();
            await agentLog?.close();
            await database.close();
            systemLog.info("application.stopped");
          } catch (error) {
            systemLog.error("application.stop_failed", error);
            throw error;
          } finally {
            await systemLog.close();
          }
        })();
        return stopping;
      },
    };
  } catch (error) {
    systemLog.error("application.start_failed", error);
    if (server) await closeServer(server).catch(() => undefined);
    if (serviceRelay) await serviceRelay.stop().catch(() => undefined);
    if (resultImporter) await resultImporter.stop().catch(() => undefined);
    if (queue) await queue.stop().catch(() => undefined);
    if (agentLog) await agentLog.close().catch(() => undefined);
    await database.close().catch(() => undefined);
    await systemLog.close();
    throw error;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  startApplication()
    .then((application) => {
      console.log(`Autoforum listening at ${application.origin}`);
      const shutdown = () => void application.stop()
        .then(() => process.exit(0))
        .catch((error: unknown) => {
          console.error(error);
          process.exit(1);
        });
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}
