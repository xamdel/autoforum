import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { Client } from "pg";
import { z } from "zod";

import {
  dumpManagedPostgres,
  managedPostgresContainerFromEnvironment,
  restoreManagedPostgres,
  startManagedPostgres,
} from "./managed-postgres.ts";
import { projectSandboxResourceNames } from "./sandbox/lifecycle.ts";

const BACKUP_FORMAT = "autoforum-backup";
const BACKUP_VERSION = 1;
const MANIFEST_FILE = "manifest.json";
const DATABASE_FILE = "database.dump";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const backupFileSchema = z.object({
  path: z.string().min(1),
  bytes: z.number().int().nonnegative().safe(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

const backupManifestSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  version: z.literal(BACKUP_VERSION),
  createdAt: z.iso.datetime(),
  database: backupFileSchema,
  projects: z.array(z.object({
    publicId: z.string().regex(UUID),
    workspace: backupFileSchema.nullable(),
  }).strict()),
}).strict();

export type BackupManifest = z.infer<typeof backupManifestSchema>;

type PodmanObjectKind = "container" | "volume" | "network";

export interface BackupProjectResource {
  kind: PodmanObjectKind;
  name: string;
}

/** Every same-named project resource must be absent before a restore, including disposable state. */
export function projectResourcesForRestore(manifest: BackupManifest): BackupProjectResource[] {
  return manifest.projects.flatMap((project) => {
    const names = projectSandboxResourceNames(project.publicId);
    return [
      { kind: "container", name: names.sandbox },
      { kind: "container", name: names.sidecar },
      { kind: "volume", name: names.workspaceVolume },
      { kind: "volume", name: names.homeVolume },
      { kind: "volume", name: names.cacheVolume },
      { kind: "network", name: names.internalNetwork },
      { kind: "network", name: names.egressNetwork },
    ];
  });
}

class CommandError extends Error {
  readonly command: string;
  readonly exitCode: number;
  readonly stderr: string;

  constructor(
    command: string,
    exitCode: number,
    stderr: string,
  ) {
    super(`${command} exited with code ${exitCode}${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
    this.command = command;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

interface CommandOptions {
  env?: NodeJS.ProcessEnv;
}

function postgresTool(name: "pg_dump" | "pg_restore"): string {
  const directory = process.env.AUTOFORUM_POSTGRES_BIN?.trim();
  if (!directory) return name;
  return path.join(directory, process.platform === "win32" ? `${name}.exe` : name);
}

function postgresEnvironment(databaseUrl: string): NodeJS.ProcessEnv {
  const url = new URL(databaseUrl);
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    PGHOST: url.hostname.replace(/^\[(.*)\]$/, "$1"),
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
  };
  const sslMode = url.searchParams.get("sslmode");
  if (sslMode) environment.PGSSLMODE = sslMode;
  return environment;
}

async function runCommand(command: string, args: string[], options: CommandOptions = {}) {
  return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      const output = Buffer.concat(stdout).toString("utf8");
      const errors = Buffer.concat(stderr).toString("utf8");
      if (code !== 0) reject(new CommandError([command, ...args].join(" "), code ?? -1, errors || output));
      else resolve({ stdout: output, stderr: errors });
    });
  });
}

async function podmanObjectExists(kind: PodmanObjectKind, name: string): Promise<boolean> {
  try {
    await runCommand("podman", [kind, "exists", name]);
    return true;
  } catch (error) {
    if (error instanceof CommandError && error.exitCode === 1) return false;
    throw error;
  }
}

async function fileRecord(root: string, relativePath: string) {
  const absolutePath = path.join(root, relativePath);
  const metadata = await lstat(absolutePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`backup_file_not_regular:${relativePath}`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(absolutePath)) hash.update(chunk as Buffer);
  return {
    path: relativePath.replaceAll(path.sep, "/"),
    bytes: metadata.size,
    sha256: hash.digest("hex"),
  };
}

async function assertAutoforumStopped(client: Client): Promise<void> {
  const active = await client.query<{ application_name: string }>(
    `select distinct application_name
       from pg_stat_activity
      where datname = current_database()
        and pid <> pg_backend_pid()
        and application_name in ('autoforum-api', 'autoforum-worker')`,
  );
  if (active.rows.length) throw new Error("autoforum_is_running");
}

async function listProjects(client: Client): Promise<Array<{ projectId: number; publicId: string }>> {
  const result = await client.query<{ projectId: number; publicId: string }>(
    `select row_id as "projectId", public_id::text as "publicId"
       from project
      order by public_id`,
  );
  return result.rows;
}

async function stopProjectContainers(publicId: string): Promise<void> {
  const names = projectSandboxResourceNames(publicId);
  for (const name of [names.sandbox, names.sidecar]) {
    if (await podmanObjectExists("container", name)) await runCommand("podman", ["stop", "--time", "10", name]);
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function checkedManagedPostgres(databaseUrl: string): Promise<string | null> {
  const name = managedPostgresContainerFromEnvironment();
  if (!name) return null;
  const managed = await startManagedPostgres(name);
  const configured = new URL(databaseUrl);
  const actual = new URL(managed.databaseUrl);
  const configuredHost = configured.hostname === "localhost" ? "127.0.0.1" : configured.hostname;
  if (configuredHost !== actual.hostname
    || (configured.port || "5432") !== (actual.port || "5432")
    || configured.username !== actual.username
    || configured.password !== actual.password
    || configured.pathname !== actual.pathname) {
    throw new Error("managed_postgres_database_url_mismatch");
  }
  return name;
}

export async function createBackup(databaseUrl: string, requestedTarget: string) {
  const target = path.resolve(requestedTarget);
  if (await pathExists(target)) throw new Error(`backup_target_exists:${target}`);
  const managedPostgres = await checkedManagedPostgres(databaseUrl);
  await mkdir(path.dirname(target), { recursive: true });
  const partial = `${target}.partial-${randomUUID()}`;
  await mkdir(path.join(partial, "workspaces"), { recursive: true });

  const client = new Client({ connectionString: databaseUrl, application_name: "autoforum-backup" });
  try {
    await client.connect();
    await assertAutoforumStopped(client);
    const projects = await listProjects(client);
    for (const project of projects) await stopProjectContainers(project.publicId);

    if (managedPostgres) {
      await dumpManagedPostgres(managedPostgres, path.join(partial, DATABASE_FILE));
    } else {
      await runCommand(postgresTool("pg_dump"), [
        "--format=custom",
        "--no-owner",
        "--no-privileges",
        "--file",
        path.join(partial, DATABASE_FILE),
      ], { env: postgresEnvironment(databaseUrl) });
    }

    const manifestProjects: BackupManifest["projects"] = [];
    for (const project of projects) {
      const volume = projectSandboxResourceNames(project.publicId).workspaceVolume;
      if (!await podmanObjectExists("volume", volume)) {
        manifestProjects.push({ publicId: project.publicId, workspace: null });
        continue;
      }
      const relativeArchive = `workspaces/${project.publicId}.tar`;
      await runCommand("podman", [
        "volume",
        "export",
        "--output",
        path.join(partial, ...relativeArchive.split("/")),
        volume,
      ]);
      manifestProjects.push({
        publicId: project.publicId,
        workspace: await fileRecord(partial, relativeArchive),
      });
    }

    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      createdAt: new Date().toISOString(),
      database: await fileRecord(partial, DATABASE_FILE),
      projects: manifestProjects,
    };
    await writeFile(path.join(partial, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    await rename(partial, target);
    return { path: target, manifest };
  } catch (error) {
    await rm(partial, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
}

function validateManifestPaths(manifest: BackupManifest): void {
  if (manifest.database.path !== DATABASE_FILE) throw new Error("backup_database_path_invalid");
  const seen = new Set<string>();
  for (const project of manifest.projects) {
    if (seen.has(project.publicId)) throw new Error(`backup_project_duplicated:${project.publicId}`);
    seen.add(project.publicId);
    const expected = `workspaces/${project.publicId}.tar`;
    if (project.workspace && project.workspace.path !== expected) {
      throw new Error(`backup_workspace_path_invalid:${project.publicId}`);
    }
  }
}

async function verifyFile(root: string, expected: BackupManifest["database"]): Promise<void> {
  const actual = await fileRecord(root, expected.path);
  if (actual.bytes !== expected.bytes) throw new Error(`backup_size_mismatch:${expected.path}`);
  if (actual.sha256 !== expected.sha256) throw new Error(`backup_checksum_mismatch:${expected.path}`);
}

export async function readAndVerifyBackup(requestedSource: string): Promise<{ path: string; manifest: BackupManifest }> {
  const source = path.resolve(requestedSource);
  const raw = await readFile(path.join(source, MANIFEST_FILE), "utf8");
  const manifest = backupManifestSchema.parse(JSON.parse(raw));
  validateManifestPaths(manifest);
  await verifyFile(source, manifest.database);
  for (const project of manifest.projects) {
    if (project.workspace) await verifyFile(source, project.workspace);
  }
  return { path: source, manifest };
}

async function assertEmptyDatabase(client: Client): Promise<void> {
  const result = await client.query<{ populated: boolean }>(
    `select exists (
       select 1
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname !~ '^pg_'
          and n.nspname <> 'information_schema'
          and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
     ) as populated`,
  );
  if (result.rows[0]?.populated) throw new Error("restore_database_not_empty");
}

async function assertProjectResourcesAbsent(manifest: BackupManifest): Promise<void> {
  for (const resource of projectResourcesForRestore(manifest)) {
    if (await podmanObjectExists(resource.kind, resource.name)) {
      throw new Error(`restore_resource_exists:${resource.kind}:${resource.name}`);
    }
  }
}

type CommandRunner = typeof runCommand;

async function removeWorkspaceVolumes(volumes: string[], command: CommandRunner): Promise<unknown[]> {
  const failures: unknown[] = [];
  for (const volume of volumes.toReversed()) {
    await command("podman", ["volume", "rm", "--force", volume]).catch((error) => failures.push(error));
  }
  return failures;
}

async function throwAfterWorkspaceCleanup(
  error: unknown,
  volumes: string[],
  command: CommandRunner,
): Promise<never> {
  const cleanupFailures = await removeWorkspaceVolumes(volumes, command);
  if (cleanupFailures.length) {
    throw new AggregateError(
      [error, ...cleanupFailures],
      `restore_failed_and_workspace_cleanup_failed:${volumes.join(",")}`,
      { cause: error },
    );
  }
  throw error;
}

/** @internal Restores verified workspace archives and removes every created volume if an import fails. */
export async function restoreWorkspaceVolumes(
  source: string,
  manifest: BackupManifest,
  command: CommandRunner = runCommand,
): Promise<string[]> {
  validateManifestPaths(manifest);
  const created: string[] = [];
  try {
    for (const project of manifest.projects) {
      if (!project.workspace) continue;
      const volume = projectSandboxResourceNames(project.publicId).workspaceVolume;
      await command("podman", [
        "volume",
        "create",
        "--label", "org.autoforum.managed=true",
        "--label", `org.autoforum.project=${project.publicId}`,
        "--label", "org.autoforum.role=workspace",
        volume,
      ]);
      created.push(volume);
      await command("podman", [
        "volume",
        "import",
        volume,
        path.join(source, ...project.workspace.path.split("/")),
      ]);
    }
    return created;
  } catch (error) {
    return await throwAfterWorkspaceCleanup(error, created, command);
  }
}

async function assertRestoredProjects(client: Client, manifest: BackupManifest): Promise<void> {
  const restored = (await listProjects(client)).map((project) => project.publicId).sort();
  const expected = manifest.projects.map((project) => project.publicId).sort();
  if (JSON.stringify(restored) !== JSON.stringify(expected)) throw new Error("restore_project_set_mismatch");
}

export async function restoreBackup(databaseUrl: string, requestedSource: string) {
  const verified = await readAndVerifyBackup(requestedSource);
  const managedPostgres = await checkedManagedPostgres(databaseUrl);
  const client = new Client({ connectionString: databaseUrl, application_name: "autoforum-backup" });
  let createdWorkspaceVolumes: string[] = [];
  try {
    await client.connect();
    await assertAutoforumStopped(client);
    await assertEmptyDatabase(client);
    await assertProjectResourcesAbsent(verified.manifest);
    createdWorkspaceVolumes = await restoreWorkspaceVolumes(verified.path, verified.manifest);
    if (managedPostgres) {
      await restoreManagedPostgres(managedPostgres, path.join(verified.path, DATABASE_FILE));
    } else {
      await runCommand(postgresTool("pg_restore"), [
        "--single-transaction",
        "--no-owner",
        "--no-privileges",
        path.join(verified.path, DATABASE_FILE),
      ], { env: postgresEnvironment(databaseUrl) });
    }
    await assertRestoredProjects(client, verified.manifest);
    return verified;
  } catch (error) {
    return await throwAfterWorkspaceCleanup(error, createdWorkspaceVolumes, runCommand);
  } finally {
    await client.end().catch(() => undefined);
  }
}
