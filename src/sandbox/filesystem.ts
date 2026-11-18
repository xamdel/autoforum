import path from "node:path";

import { z } from "zod";

import { runSandboxCommand } from "./execution.ts";
import type { ProjectSandboxIdentity } from "./lifecycle.ts";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const base64Schema = z.string().refine((value) => {
  try { return Buffer.from(value, "base64").toString("base64") === value; } catch { return false; }
});
const entrySchema = z.object({
  path: z.string(),
  name: z.string(),
  kind: z.enum(["regular", "directory", "symlink", "special"]),
  size: z.number().int().nonnegative().nullable(),
  mtimeMs: z.number().nonnegative(),
}).strict();
const fileSchema = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
  sha256: sha256Schema,
  content: base64Schema,
}).strict();

export interface WorkspaceEntry extends z.infer<typeof entrySchema> {}
export interface WorkspaceFile {
  path: string;
  size: number;
  sha256: string;
  bytes: Buffer;
}

export function normalizeWorkspacePath(value: string, allowRoot = false): string {
  if (typeof value !== "string" || value.includes("\\") || value.includes("\0")) throw new Error("invalid_path");
  if (allowRoot && value === "") return "";
  if (!value || path.posix.isAbsolute(value) || /^[A-Za-z]:\//.test(value)) throw new Error("invalid_path");
  const normalized = path.posix.normalize(value);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized !== value) throw new Error("invalid_path");
  return normalized;
}

async function invoke(project: ProjectSandboxIdentity, request: Record<string, unknown>): Promise<unknown> {
  const encodedRequest = Buffer.from(JSON.stringify(request)).toString("base64url");
  if (encodedRequest.length > 1024 * 1024) throw new Error("filesystem_request_too_large");
  const result = await runSandboxCommand(project, {
    argv: ["node", "/usr/local/bin/autoforum-filesystem.mjs", encodedRequest],
    timeoutMs: 30_000,
    maxOutputBytes: 96 * 1024 * 1024,
  });
  let envelope: unknown;
  try {
    envelope = JSON.parse(result.stdout.toString("utf8"));
  } catch {
    throw new Error("invalid_filesystem_response");
  }
  const parsed = z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), result: z.unknown() }).strict(),
    z.object({ ok: z.literal(false), error: z.string().min(1).max(500) }).strict(),
  ]).safeParse(envelope);
  if (!parsed.success) throw new Error("invalid_filesystem_response");
  if (!parsed.data.ok) throw new Error(parsed.data.error);
  if (result.exitCode !== 0) throw new Error("filesystem_command_failed");
  return parsed.data.result;
}

export async function listWorkspaceDirectory(project: ProjectSandboxIdentity, value = ""): Promise<WorkspaceEntry[]> {
  const directory = normalizeWorkspacePath(value, true);
  const parsed = z.object({ entries: z.array(entrySchema).max(2_000) }).strict().parse(
    await invoke(project, { operation: "list", path: directory }),
  );
  for (const entry of parsed.entries) {
    const expectedParent = path.posix.dirname(entry.path);
    if (entry.name.includes("/") || entry.name.includes("\\") || entry.name === "." || entry.name === "..") throw new Error("invalid_filesystem_response");
    if ((directory || ".") !== expectedParent) throw new Error("invalid_filesystem_response");
    normalizeWorkspacePath(entry.path);
  }
  return parsed.entries;
}

export async function listWorkspaceTree(
  project: ProjectSandboxIdentity,
  value = "",
  maxEntries = 5_000,
): Promise<WorkspaceEntry[]> {
  const directory = normalizeWorkspacePath(value, true);
  const parsed = z.object({ entries: z.array(entrySchema).max(maxEntries) }).strict().parse(
    await invoke(project, { operation: "tree", path: directory, maxEntries }),
  );
  const seen = new Set<string>();
  for (const entry of parsed.entries) {
    normalizeWorkspacePath(entry.path);
    if (seen.has(entry.path)) throw new Error("invalid_filesystem_response");
    seen.add(entry.path);
    if (directory && entry.path !== directory && !entry.path.startsWith(`${directory}/`)) throw new Error("invalid_filesystem_response");
  }
  return parsed.entries;
}

export async function readWorkspaceFile(
  project: ProjectSandboxIdentity,
  value: string,
  maxBytes = 2 * 1024 * 1024,
): Promise<WorkspaceFile> {
  const logical = normalizeWorkspacePath(value);
  const parsed = fileSchema.parse(await invoke(project, { operation: "read", path: logical, maxBytes }));
  if (parsed.path !== logical) throw new Error("invalid_filesystem_response");
  const bytes = Buffer.from(parsed.content, "base64");
  if (bytes.length !== parsed.size) throw new Error("invalid_filesystem_response");
  return { path: parsed.path, size: parsed.size, sha256: parsed.sha256, bytes };
}

export async function writeWorkspaceFile(
  project: ProjectSandboxIdentity,
  value: string,
  bytes: Uint8Array,
  expectedSha256?: string,
) {
  const logical = normalizeWorkspacePath(value);
  if (bytes.byteLength > 512 * 1024) throw new Error("file_too_large");
  if (expectedSha256 && !sha256Schema.safeParse(expectedSha256).success) throw new Error("invalid_hash");
  return z.object({ path: z.literal(logical), size: z.number().int().nonnegative(), sha256: sha256Schema }).strict().parse(
    await invoke(project, {
      operation: "write",
      path: logical,
      content: Buffer.from(bytes).toString("base64"),
      ...(expectedSha256 ? { expectedSha256 } : {}),
    }),
  );
}

export async function collectWorkspaceFiles(
  project: ProjectSandboxIdentity,
  values: string[],
  limits: { maxFileBytes?: number; maxTotalBytes?: number } = {},
): Promise<{ files: WorkspaceFile[]; totalBytes: number }> {
  const paths = values.map((value) => normalizeWorkspacePath(value));
  const parsed = z.object({ files: z.array(fileSchema).max(1_000), totalBytes: z.number().int().nonnegative() }).strict().parse(
    await invoke(project, { operation: "collect", paths, ...limits }),
  );
  const expected = new Set(paths);
  const files = parsed.files.map((file) => {
    if (!expected.delete(file.path)) throw new Error("invalid_filesystem_response");
    const bytes = Buffer.from(file.content, "base64");
    if (bytes.length !== file.size) throw new Error("invalid_filesystem_response");
    return { path: file.path, size: file.size, sha256: file.sha256, bytes };
  });
  if (expected.size) throw new Error("invalid_filesystem_response");
  if (files.reduce((total, file) => total + file.size, 0) !== parsed.totalBytes) throw new Error("invalid_filesystem_response");
  return { files, totalBytes: parsed.totalBytes };
}

export async function workspaceUsage(project: ProjectSandboxIdentity) {
  return z.object({ files: z.number().int().nonnegative(), bytes: z.number().int().nonnegative() }).strict().parse(
    await invoke(project, { operation: "usage" }),
  );
}
