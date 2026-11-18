import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

import { createOrStartManagedPostgres, managedPostgresContainerFromEnvironment } from "../src/managed-postgres.ts";
import { ensurePodmanMachineRunning, restartIdlePodmanMachine } from "../src/podman.ts";
import { createContainerEngine } from "../src/sandbox/lifecycle.ts";

const children: ChildProcess[] = [];
let stopping = false;
const DEFAULT_WEB_PORT = 5_173;

async function portIsAvailable(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE" || error.code === "EACCES") resolve(false);
      else reject(error);
    });
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close((error) => error ? reject(error) : resolve(true));
    });
  });
}

async function selectWebPort(preferred = DEFAULT_WEB_PORT): Promise<number> {
  for (let port = preferred; port <= 65_535; port += 1) {
    if (await portIsAvailable(port)) return port;
  }
  throw new Error(`no_available_web_port_at_or_above:${preferred}`);
}

function preferredLocalWebPort(): number {
  const configured = process.env.APP_ORIGIN?.trim();
  if (!configured) return DEFAULT_WEB_PORT;
  const origin = new URL(configured);
  if (origin.protocol !== "http:" || origin.hostname !== "app.autoforum.localhost") {
    throw new Error("dev_all_requires_local_app_origin");
  }
  const port = Number(origin.port || 80);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("invalid_app_origin_port");
  return port;
}

function launch(args: string[]): ChildProcess {
  const child = spawn(process.execPath, args, { env: process.env, stdio: "inherit", windowsHide: true });
  children.push(child);
  return child;
}

function stop(exitCode: number): void {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  process.exitCode = exitCode;
}

async function prepareContainerBackend(): Promise<void> {
  const explicitlyConfigured = Boolean(process.env.DOCKER_HOST?.trim());
  const started = await ensurePodmanMachineRunning();
  if (started) console.log("Started the Podman machine.");

  const engine = createContainerEngine();
  const waitForApi = async (): Promise<unknown | null> => {
    let failure: unknown;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        await engine.ping();
        return null;
      } catch (error) {
        failure = error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    return failure;
  };

  let failure = await waitForApi();
  if (failure && !explicitlyConfigured && (process.platform === "win32" || process.platform === "darwin")) {
    await restartIdlePodmanMachine();
    console.log("Restarted the idle Podman machine to restore its API forwarder.");
    failure = await waitForApi();
  }
  if (!failure) {
    console.log("Podman container API is ready.");
    return;
  }
  const detail = failure instanceof Error ? failure.message : String(failure);
  throw new Error(`podman_docker_compatibility_unavailable:${detail}`);
}

let webPort: number;
try {
  const preferredPort = preferredLocalWebPort();
  webPort = await selectWebPort(preferredPort);
  process.env.APP_ORIGIN = `http://app.autoforum.localhost:${webPort}`;
  if (webPort !== preferredPort) console.log(`Web port ${preferredPort} is in use; using ${webPort}.`);
  await prepareContainerBackend();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Autoforum startup failed: ${message}`);
  if (message.startsWith("podman_docker_compatibility_unavailable:")) {
    console.error("Run 'npm run doctor' or finish Podman machine and Docker-compatibility setup, then try again.");
  }
  process.exit(1);
}

const managed = managedPostgresContainerFromEnvironment();
if (managed) {
  const postgres = await createOrStartManagedPostgres(managed, process.env.DATABASE_URL);
  process.env.DATABASE_URL = postgres.databaseUrl;
  console.log(`Managed PostgreSQL is ready (${managed}).`);
}

// Do not run the API under Node's dependency watcher. Model providers are loaded lazily, and
// watch mode can treat those runtime imports as dependency-graph changes and kill an expensive
// in-flight turn. Restart Autoforum explicitly after changing backend source.
const backend = launch(["--experimental-strip-types", "--env-file-if-exists=.env", "src/main.ts"]);
const vite = fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url));
const frontend = launch([vite, "--port", String(webPort), "--strictPort"]);
console.log(`Autoforum web frontend: ${process.env.APP_ORIGIN}`);

for (const child of [backend, frontend]) {
  child.once("exit", (code, signal) => {
    if (!stopping) {
      console.error(`${child === backend ? "Backend" : "Web frontend"} stopped${signal ? ` (${signal})` : ""}.`);
      stop(code ?? 1);
    }
  });
}
process.once("SIGINT", () => stop(0));
process.once("SIGTERM", () => stop(0));
