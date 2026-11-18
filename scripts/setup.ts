import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { issueSignInLink } from "../src/auth/browser.ts";
import { ensureDefaultAgentUsers } from "../src/agents/profiles.ts";
import { createDatabase } from "../src/db.ts";
import {
  createOrStartManagedPostgres,
  DEFAULT_MANAGED_POSTGRES_CONTAINER,
} from "../src/managed-postgres.ts";
import { ensurePodmanMachineRunning, restartIdlePodmanMachine } from "../src/podman.ts";
import { buildSandboxImage, createContainerEngine, SANDBOX_IMAGE } from "../src/sandbox/lifecycle.ts";
import { ensureInstallationOwner } from "../src/users.ts";

export function updateEnvironmentText(source: string, values: Record<string, string>): string {
  const remaining = new Map(Object.entries(values));
  const output: string[] = [];
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=/);
    const key = match?.[1];
    if (!key || !remaining.has(key)) {
      output.push(line);
      continue;
    }
    output.push(`${key}=${remaining.get(key)}`);
    remaining.delete(key);
  }
  if (output.at(-1) === "") output.pop();
  if (output.length && remaining.size) output.push("");
  for (const [key, value] of remaining) output.push(`${key}=${value}`);
  return `${output.join("\n")}\n`;
}

async function readEnvironmentFile(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

async function writeEnvironmentFile(values: Record<string, string>): Promise<void> {
  const target = path.resolve(".env");
  const temporary = `${target}.setup-${randomUUID()}`;
  await writeFile(temporary, updateEnvironmentText(await readEnvironmentFile(target), values), { mode: 0o600 });
  await rename(temporary, target);
}

function setupArguments(): { ownerHandle: string; forceManaged: boolean } {
  const args = process.argv.slice(2).filter((argument) => argument !== "--");
  const forceManaged = args.includes("--managed");
  const positional = args.filter((argument) => argument !== "--managed");
  if (positional.length > 1) throw new Error("Usage: npm run setup -- [--managed] [owner-handle]");
  return { ownerHandle: positional[0] ?? "owner", forceManaged };
}

async function main(): Promise<void> {
  const { ownerHandle: handle, forceManaged } = setupArguments();
  const configuredDockerHost = process.env.DOCKER_HOST?.trim();
  console.log("Checking Podman...");
  if (await ensurePodmanMachineRunning()) console.log("Started the Podman machine.");
  try {
    await createContainerEngine().ping();
  } catch (error) {
    if (!configuredDockerHost && (process.platform === "win32" || process.platform === "darwin")) {
      await restartIdlePodmanMachine();
      console.log("Restarted the idle Podman machine to restore its API forwarder.");
      await createContainerEngine().ping();
    } else {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`podman_docker_compatibility_unavailable:${detail}`);
    }
  }

  let databaseUrl = process.env.DATABASE_URL;
  let managedContainer = process.env.AUTOFORUM_MANAGED_POSTGRES_CONTAINER?.trim();
  const hadManagedConfiguration = Boolean(managedContainer);
  if (forceManaged || !databaseUrl || managedContainer) {
    managedContainer ||= DEFAULT_MANAGED_POSTGRES_CONTAINER;
    console.log(`Starting managed PostgreSQL container ${managedContainer}...`);
    const postgres = await createOrStartManagedPostgres(
      managedContainer,
      hadManagedConfiguration ? databaseUrl : undefined,
    );
    databaseUrl = postgres.databaseUrl;
    await writeEnvironmentFile({
      DATABASE_URL: databaseUrl,
      AUTOFORUM_MANAGED_POSTGRES_CONTAINER: managedContainer,
      HOST: process.env.HOST || "127.0.0.1",
      PORT: process.env.PORT || "3000",
      ...(configuredDockerHost
        ? { DOCKER_HOST: configuredDockerHost }
        : {}),
    });
    process.env.DATABASE_URL = databaseUrl;
    process.env.AUTOFORUM_MANAGED_POSTGRES_CONTAINER = managedContainer;
    console.log(postgres.created ? "Created managed PostgreSQL." : "Managed PostgreSQL is ready.");
  } else {
    console.log("Using the existing external DATABASE_URL.");
  }

  if (!databaseUrl) throw new Error("database_url_unavailable");
  const database = createDatabase(databaseUrl);
  let link: { token: string; expiresAt: Date };
  try {
    console.log("Applying database migrations...");
    await database.migrate();
    const owner = await ensureInstallationOwner(database, handle);
    const agents = await ensureDefaultAgentUsers(database, owner.id);
    console.log(`Default agents: ${agents.created} created, ${agents.existing} already present.`);
    if (agents.unavailable.length) {
      console.log(`Skipped unavailable default handles: ${agents.unavailable.join(", ")}.`);
    }
    link = await issueSignInLink(database, owner, owner.id);
  } finally {
    await database.close();
  }

  console.log(`Building ${SANDBOX_IMAGE}...`);
  await buildSandboxImage((line) => console.log(line));

  const origin = process.env.APP_ORIGIN ?? "http://app.autoforum.localhost:5173";
  console.log("\nAutoforum is ready.");
  console.log(`Start it with: npm start`);
  console.log(`Sign in once at: ${origin.replace(/\/$/, "")}/#sign-in=${encodeURIComponent(link.token)}`);
  console.log(`The link expires at ${link.expiresAt.toISOString()}.`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("podman_docker_compatibility_unavailable:")) {
      console.error("Podman is running, but its Docker-compatible API endpoint is unavailable.");
      if (process.platform === "linux") {
        console.error(
          "Start the rootless Podman socket with 'systemctl --user enable --now podman.socket', then run setup again.",
        );
      } else {
        console.error(
          "Run 'podman machine inspect' and check whether an explicit DOCKER_HOST is overriding the machine endpoint.",
        );
      }
    } else if (message === "podman_not_installed") {
      console.error("Podman is not installed. Install and start Podman, then run setup again.");
    } else {
      console.error(message);
    }
    process.exitCode = 1;
  });
}
