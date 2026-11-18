import { randomBytes } from "node:crypto";
import path from "node:path";

import { PodmanCommandError, runPodman as podman } from "./podman.ts";

export const DEFAULT_MANAGED_POSTGRES_CONTAINER = "autoforum-postgres";
export const DEFAULT_MANAGED_POSTGRES_IMAGE = "docker.io/library/postgres:18-bookworm";

const DATABASE_PORT = "5432/tcp";
const MANAGED_LABEL = "org.autoforum.managed";
const ROLE_LABEL = "org.autoforum.role";

async function objectExists(kind: "container" | "volume", name: string): Promise<boolean> {
  try {
    await podman(`${kind}_exists`, [kind, "exists", name]);
    return true;
  } catch (error) {
    if (error instanceof PodmanCommandError && error.exitCode === 1) return false;
    throw error;
  }
}

interface ContainerInspection {
  Config?: {
    Env?: string[];
    Labels?: Record<string, string>;
  };
}

interface VolumeInspection {
  Labels?: Record<string, string>;
}

async function inspectContainer(name: string): Promise<ContainerInspection> {
  const output = await podman("inspect_database", ["container", "inspect", name]);
  const inspection = JSON.parse(output) as ContainerInspection[];
  const container = inspection[0];
  if (!container) throw new Error("managed_postgres_inspection_missing");
  if (container.Config?.Labels?.[MANAGED_LABEL] !== "true"
    || container.Config?.Labels?.[ROLE_LABEL] !== "database") {
    throw new Error(`managed_postgres_name_conflict:${name}`);
  }
  return container;
}

async function assertManagedVolume(name: string): Promise<void> {
  const output = await podman("inspect_database_volume", ["volume", "inspect", name]);
  const inspection = JSON.parse(output) as VolumeInspection[];
  const volume = inspection[0];
  if (volume?.Labels?.[MANAGED_LABEL] !== "true" || volume.Labels?.[ROLE_LABEL] !== "database") {
    throw new Error(`managed_postgres_volume_name_conflict:${name}`);
  }
}

function environmentValue(inspection: ContainerInspection, name: string): string | null {
  const prefix = `${name}=`;
  const entry = inspection.Config?.Env?.find((value) => value.startsWith(prefix));
  return entry?.slice(prefix.length) || null;
}

export function managedPostgresContainerFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  const name = environment.AUTOFORUM_MANAGED_POSTGRES_CONTAINER?.trim();
  if (!name) return null;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name)) {
    throw new Error("AUTOFORUM_MANAGED_POSTGRES_CONTAINER is invalid");
  }
  return name;
}

export function parseManagedPostgresPort(output: string): number {
  for (const line of output.trim().split(/\r?\n/)) {
    const match = line.trim().match(/:(\d+)$/);
    const port = Number(match?.[1]);
    if (Number.isSafeInteger(port) && port > 0 && port <= 65_535) return port;
  }
  throw new Error("managed_postgres_port_unavailable");
}

function databaseUrl(inspection: ContainerInspection, port: number): string {
  const user = environmentValue(inspection, "POSTGRES_USER");
  const password = environmentValue(inspection, "POSTGRES_PASSWORD");
  const database = environmentValue(inspection, "POSTGRES_DB");
  if (!user || !password || !database) throw new Error("managed_postgres_credentials_missing");
  const url = new URL("postgres://127.0.0.1");
  url.username = user;
  url.password = password;
  url.port = String(port);
  url.pathname = `/${database}`;
  return url.toString();
}

async function waitUntilReady(name: string, inspection: ContainerInspection): Promise<void> {
  const user = environmentValue(inspection, "POSTGRES_USER");
  const database = environmentValue(inspection, "POSTGRES_DB");
  if (!user || !database) throw new Error("managed_postgres_credentials_missing");
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      await podman("database_readiness", [
        "exec", name, "pg_isready", "--quiet", "--username", user, "--dbname", database,
      ]);
      return;
    } catch (error) {
      if (!(error instanceof PodmanCommandError)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error("managed_postgres_start_timeout");
}

export interface ManagedPostgres {
  container: string;
  volume: string;
  databaseUrl: string;
  created: boolean;
}

function credentialsFromDatabaseUrl(databaseUrl: string): {
  user: string;
  password: string;
  database: string;
} {
  const url = new URL(databaseUrl);
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!user || !password || !database) throw new Error("managed_postgres_credentials_missing");
  return { user, password, database };
}

export async function createOrStartManagedPostgres(
  name = DEFAULT_MANAGED_POSTGRES_CONTAINER,
  existingDatabaseUrl?: string,
): Promise<ManagedPostgres> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name)) throw new Error("managed_postgres_name_invalid");
  const volume = `${name}-data`;
  let created = false;

  if (!await objectExists("container", name)) {
    const existingVolume = await objectExists("volume", volume);
    let credentials: { user: string; password: string; database: string };
    if (existingVolume) {
      await assertManagedVolume(volume);
      if (!existingDatabaseUrl) throw new Error(`managed_postgres_container_missing:${name}`);
      credentials = credentialsFromDatabaseUrl(existingDatabaseUrl);
    } else {
      await podman("create_database_volume", [
        "volume", "create",
        "--label", `${MANAGED_LABEL}=true`,
        "--label", `${ROLE_LABEL}=database`,
        volume,
      ]);
      credentials = {
        user: "autoforum",
        password: randomBytes(32).toString("base64url"),
        database: "autoforum",
      };
    }

    await podman("create_database", [
      "create",
      "--name", name,
      "--label", `${MANAGED_LABEL}=true`,
      "--label", `${ROLE_LABEL}=database`,
      "--publish", `127.0.0.1::${DATABASE_PORT}`,
      "--restart", "unless-stopped",
      "--env", "POSTGRES_USER",
      "--env", "POSTGRES_PASSWORD",
      "--env", "POSTGRES_DB",
      "--volume", `${volume}:/var/lib/postgresql`,
      process.env.AUTOFORUM_POSTGRES_IMAGE ?? DEFAULT_MANAGED_POSTGRES_IMAGE,
    ], {
      ...process.env,
      POSTGRES_USER: credentials.user,
      POSTGRES_PASSWORD: credentials.password,
      POSTGRES_DB: credentials.database,
    });
    created = true;
  }

  const inspection = await inspectContainer(name);
  await podman("start_database", ["start", name]);
  await waitUntilReady(name, inspection);
  const port = parseManagedPostgresPort(await podman("database_port", ["port", name, DATABASE_PORT]));
  return { container: name, volume, databaseUrl: databaseUrl(inspection, port), created };
}

export async function startManagedPostgres(name: string): Promise<ManagedPostgres> {
  if (!await objectExists("container", name)) throw new Error(`managed_postgres_not_found:${name}`);
  return await createOrStartManagedPostgres(name);
}

const CONTAINER_DUMP = "/tmp/autoforum-backup.dump";

export async function dumpManagedPostgres(name: string, target: string): Promise<void> {
  await inspectContainer(name);
  await podman("remove_old_database_dump", ["exec", name, "rm", "-f", CONTAINER_DUMP]);
  try {
    await podman("dump_database", [
      "exec", name, "sh", "-lc",
      `export PGPASSWORD="$POSTGRES_PASSWORD"; exec pg_dump --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --format=custom --no-owner --no-privileges --file=${CONTAINER_DUMP}`,
    ]);
    await podman("copy_database_dump", ["cp", `${name}:${CONTAINER_DUMP}`, path.resolve(target)]);
  } finally {
    await podman("remove_database_dump", ["exec", name, "rm", "-f", CONTAINER_DUMP]).catch(() => undefined);
  }
}

export async function restoreManagedPostgres(name: string, source: string): Promise<void> {
  await inspectContainer(name);
  await podman("remove_old_database_dump", ["exec", name, "rm", "-f", CONTAINER_DUMP]);
  try {
    await podman("copy_database_dump", ["cp", path.resolve(source), `${name}:${CONTAINER_DUMP}`]);
    await podman("restore_database", [
      "exec", name, "sh", "-lc",
      `export PGPASSWORD="$POSTGRES_PASSWORD"; exec pg_restore --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --single-transaction --no-owner --no-privileges ${CONTAINER_DUMP}`,
    ]);
  } finally {
    await podman("remove_database_dump", ["exec", name, "rm", "-f", CONTAINER_DUMP]).catch(() => undefined);
  }
}
