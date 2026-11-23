import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createOrStartManagedPostgres, managedPostgresContainerFromEnvironment } from "../src/managed-postgres.ts";
import { ensurePodmanMachineRunning } from "../src/podman.ts";
import { createContainerEngine } from "../src/sandbox/lifecycle.ts";
import { startApplication } from "../src/main.ts";

function publicHttpsOrigin(name: string, value: string | undefined): URL {
  if (!value) throw new Error(`${name.toLowerCase()}_required`);
  const origin = new URL(value);
  if (origin.protocol !== "https:"
    || origin.origin !== value.replace(/\/$/, "")
    || origin.username
    || origin.password) {
    throw new Error(`${name.toLowerCase()}_must_be_https_origin`);
  }
  return origin;
}

/** Validate the public hosts before starting a process that accepts browser mutations. */
export function validateProductionOrigins(environment: NodeJS.ProcessEnv = process.env): {
  app: URL;
  previewBase: URL;
} {
  const app = publicHttpsOrigin("APP_ORIGIN", environment.APP_ORIGIN);
  const previewBase = publicHttpsOrigin("PREVIEW_BASE_ORIGIN", environment.PREVIEW_BASE_ORIGIN);
  if (app.hostname.endsWith(`.${previewBase.hostname}`)) {
    throw new Error("app_origin_must_not_be_preview_subdomain");
  }
  return { app, previewBase };
}

async function main(): Promise<void> {
  process.env.NODE_ENV = "production";
  process.env.HOST ||= "127.0.0.1";
  process.env.PORT ||= "3000";
  const { app } = validateProductionOrigins();

  await access(path.resolve("dist", "web", "index.html"), constants.R_OK).catch(() => {
    throw new Error("production_build_missing: run `npm run build` first");
  });

  await ensurePodmanMachineRunning();
  await createContainerEngine().ping();

  const managed = managedPostgresContainerFromEnvironment();
  if (managed) {
    const postgres = await createOrStartManagedPostgres(managed, process.env.DATABASE_URL);
    process.env.DATABASE_URL = postgres.databaseUrl;
    console.log(`Managed PostgreSQL is ready (${managed}).`);
  }

  const application = await startApplication();
  console.log(`Autoforum is ready behind its HTTPS ingress at ${app.origin}`);
  console.log(`Local health check: ${application.origin}/health`);

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void application.stop()
      .then(() => { process.exitCode = 0; })
      .catch((error: unknown) => {
        console.error(error);
        process.exitCode = 1;
      });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
