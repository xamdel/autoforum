import { pathToFileURL } from "node:url";

import { createDatabase } from "../src/db.ts";
import {
  managedPostgresContainerFromEnvironment,
  startManagedPostgres,
} from "../src/managed-postgres.ts";
import { configurePodmanDockerHost, verifyPodmanCli } from "../src/podman.ts";
import { createContainerEngine, SANDBOX_IMAGE } from "../src/sandbox/lifecycle.ts";

async function check(label: string, action: () => Promise<void>): Promise<boolean> {
  try {
    await action();
    console.log(`ok  ${label}`);
    return true;
  } catch (error) {
    console.error(`FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

async function main(): Promise<void> {
  let healthy = true;
  healthy = await check("Podman CLI and machine", async () => {
    await verifyPodmanCli();
    await configurePodmanDockerHost();
  }) && healthy;

  const engine = createContainerEngine();
  healthy = await check("Podman Docker-compatible socket", async () => { await engine.ping(); }) && healthy;
  healthy = await check(`sandbox image (${SANDBOX_IMAGE})`, async () => { await engine.getImage(SANDBOX_IMAGE).inspect(); }) && healthy;

  const managed = managedPostgresContainerFromEnvironment();
  let databaseUrl = process.env.DATABASE_URL ?? "postgres://localhost:5432/autoforum";
  if (managed) {
    healthy = await check(`managed PostgreSQL (${managed})`, async () => {
      databaseUrl = (await startManagedPostgres(managed)).databaseUrl;
    }) && healthy;
  }

  healthy = await check("PostgreSQL connection", async () => {
    const database = createDatabase(databaseUrl);
    try { await database.check(); } finally { await database.close(); }
  }) && healthy;

  if (!healthy) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
