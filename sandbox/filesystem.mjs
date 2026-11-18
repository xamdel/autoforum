import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, readFile, realpath, rename, rm } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";

const ROOT = "/workspace";
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_LIST_ENTRIES = 2_000;
const HIDDEN_TREE_DIRECTORIES = new Set([".git", "node_modules", ".venv", "venv", "__pycache__"]);

function logicalPath(value, allowRoot = false) {
  if (typeof value !== "string" || value.includes("\\") || value.includes("\0")) throw new Error("invalid_path");
  if (allowRoot && value === "") return "";
  if (!value || path.posix.isAbsolute(value) || /^[A-Za-z]:\//.test(value)) throw new Error("invalid_path");
  const normalized = path.posix.normalize(value);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized !== value) throw new Error("invalid_path");
  return normalized;
}

function insideRoot(value) {
  return value === ROOT || value.startsWith(`${ROOT}/`);
}

async function checkedExisting(value, allowRoot = false) {
  const logical = logicalPath(value, allowRoot);
  const target = logical ? path.join(ROOT, ...logical.split("/")) : ROOT;
  const resolved = await realpath(target);
  if (!insideRoot(resolved)) throw new Error("path_escaped_workspace");
  return { logical, target, resolved };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function list(request) {
  const checked = await checkedExisting(request.path ?? "", true);
  const parent = await lstat(checked.resolved);
  if (!parent.isDirectory()) throw new Error("not_a_directory");
  const entries = [];
  const directory = await opendir(checked.resolved);
  for await (const entry of directory) {
    if (entries.length >= MAX_LIST_ENTRIES) throw new Error("directory_too_large");
    const childLogical = checked.logical ? `${checked.logical}/${entry.name}` : entry.name;
    const stat = await lstat(path.join(checked.resolved, entry.name));
    const kind = stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : stat.isFile() ? "regular" : "special";
    entries.push({ path: childLogical, name: entry.name, kind, size: stat.isFile() ? stat.size : null, mtimeMs: stat.mtimeMs });
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  return { entries };
}

async function tree(request) {
  const checked = await checkedExisting(request.path ?? "", true);
  const rootStat = await lstat(checked.resolved);
  if (!rootStat.isDirectory()) throw new Error("not_a_directory");
  const maxEntries = Number(request.maxEntries ?? 5_000);
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 20_000) throw new Error("invalid_entry_limit");
  const entries = [];
  const pending = [{ logical: checked.logical, resolved: checked.resolved }];
  while (pending.length) {
    const current = pending.pop();
    const directory = await opendir(current.resolved);
    for await (const entry of directory) {
      if (entries.length >= maxEntries) throw new Error("tree_too_large");
      const childLogical = current.logical ? `${current.logical}/${entry.name}` : entry.name;
      const childResolved = path.join(current.resolved, entry.name);
      const stat = await lstat(childResolved);
      const kind = stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : stat.isFile() ? "regular" : "special";
      if (kind === "directory" && HIDDEN_TREE_DIRECTORIES.has(entry.name)) continue;
      entries.push({ path: childLogical, name: entry.name, kind, size: stat.isFile() ? stat.size : null, mtimeMs: stat.mtimeMs });
      if (kind === "directory") pending.push({ logical: childLogical, resolved: childResolved });
    }
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return { entries };
}

async function readRegular(value, maxBytes) {
  const checked = await checkedExisting(value);
  const handle = await open(checked.resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("not_a_regular_file");
    if (stat.size > maxBytes) throw new Error("file_too_large");
    const bytes = await handle.readFile();
    return { path: checked.logical, size: bytes.length, sha256: sha256(bytes), content: bytes.toString("base64") };
  } finally {
    await handle.close();
  }
}

async function read(request) {
  const maxBytes = Number(request.maxBytes ?? 2 * 1024 * 1024);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024) throw new Error("invalid_byte_limit");
  return await readRegular(request.path, maxBytes);
}

async function safeParent(logical) {
  const parts = logical.split("/").slice(0, -1);
  let current = ROOT;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe_parent");
    } catch (error) {
      if (!(error && typeof error === "object" && error.code === "ENOENT")) throw error;
      await mkdir(current);
    }
  }
  const resolved = await realpath(current);
  if (!insideRoot(resolved)) throw new Error("path_escaped_workspace");
  return resolved;
}

async function write(request) {
  const logical = logicalPath(request.path);
  if (typeof request.content !== "string") throw new Error("invalid_content");
  const bytes = Buffer.from(request.content, "base64");
  if (bytes.length > 512 * 1024) throw new Error("file_too_large");
  const parent = await safeParent(logical);
  const target = path.join(parent, path.posix.basename(logical));
  try {
    const existing = await lstat(target);
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error("not_a_regular_file");
    if (request.expectedSha256) {
      const current = await readRegular(logical, 512 * 1024);
      if (current.sha256 !== request.expectedSha256) throw new Error("write_conflict");
    }
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "ENOENT")) throw error;
    if (request.expectedSha256) throw new Error("write_conflict");
  }
  const temporary = path.join(parent, `.${path.basename(target)}.${randomBytes(8).toString("hex")}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return { path: logical, size: bytes.length, sha256: sha256(bytes) };
}

async function collect(request) {
  if (!Array.isArray(request.paths) || request.paths.length > 1_000) throw new Error("invalid_collection");
  const maxFileBytes = Number(request.maxFileBytes ?? 16 * 1024 * 1024);
  const maxTotalBytes = Number(request.maxTotalBytes ?? 64 * 1024 * 1024);
  const files = [];
  let totalBytes = 0;
  for (const value of request.paths) {
    const file = await readRegular(value, maxFileBytes);
    totalBytes += file.size;
    if (totalBytes > maxTotalBytes) throw new Error("collection_too_large");
    files.push(file);
  }
  return { files, totalBytes };
}

async function usage() {
  let files = 0;
  let bytes = 0;
  const pending = [ROOT];
  while (pending.length) {
    const current = pending.pop();
    const directory = await opendir(current);
    for await (const entry of directory) {
      const target = path.join(current, entry.name);
      const stat = await lstat(target);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) pending.push(target);
      else if (stat.isFile()) { files += 1; bytes += stat.size; }
      if (files > 100_000) throw new Error("workspace_too_many_files");
    }
  }
  return { files, bytes };
}

async function main() {
  const encoded = process.argv[2];
  if (!encoded || encoded.length > MAX_REQUEST_BYTES) throw new Error("request_too_large");
  const decoded = Buffer.from(encoded, "base64url");
  if (decoded.length > MAX_REQUEST_BYTES) throw new Error("request_too_large");
  const request = JSON.parse(decoded.toString("utf8"));
  const operations = { list, tree, read, write, collect, usage };
  const operation = operations[request.operation];
  if (!operation) throw new Error("unknown_operation");
  return await operation(request);
}

try {
  process.stdout.write(`${JSON.stringify({ ok: true, result: await main() })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
}
