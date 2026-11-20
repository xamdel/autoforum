import { randomUUID } from "node:crypto";
import { lstat, rm } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = "/workspace";
const DEFAULT_EXCLUDES = "/usr/local/share/autoforum/workspace-gitignore";
const MAX_CHANGED_FILE_BYTES = 16 * 1024 * 1024;
const MAX_CHANGED_TOTAL_BYTES = 64 * 1024 * 1024;

function git(args, options = {}) {
  const result = spawnSync("git", ["-c", `core.excludesFile=${DEFAULT_EXCLUDES}`, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: options.env ?? process.env,
    input: options.input,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && options.allowFailure) return null;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "git_failed").trim().slice(0, 1_000);
    throw new Error(detail || "git_failed");
  }
  return result.stdout;
}

function nulPaths(value) {
  return value.split("\0").filter(Boolean);
}

async function enforceSnapshotLimits() {
  const changed = new Set([
    ...nulPaths(git(["diff", "HEAD", "--name-only", "-z", "--"])),
    ...nulPaths(git(["ls-files", "--others", "--exclude-standard", "-z"])),
  ]);
  let total = 0;
  for (const logical of changed) {
    if (path.posix.isAbsolute(logical) || logical === ".." || logical.startsWith("../")) {
      throw new Error("invalid_workspace_snapshot_path");
    }
    const target = path.resolve(ROOT, logical);
    if (target !== ROOT && !target.startsWith(`${ROOT}/`)) throw new Error("invalid_workspace_snapshot_path");
    let stat;
    try {
      stat = await lstat(target);
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") continue;
      throw error;
    }
    if (!stat.isFile() && !stat.isSymbolicLink()) continue;
    if (stat.size > MAX_CHANGED_FILE_BYTES) throw new Error(`workspace_snapshot_file_too_large:${logical}`);
    total += stat.size;
    if (total > MAX_CHANGED_TOTAL_BYTES) throw new Error("workspace_snapshot_changes_too_large");
  }
}

async function capture() {
  const base = git(["rev-parse", "HEAD"]).trim();
  const baseTree = git(["rev-parse", `${base}^{tree}`]).trim();
  await enforceSnapshotLimits();

  const temporaryIndex = `/tmp/autoforum-index-${randomUUID()}`;
  const env = {
    ...process.env,
    GIT_INDEX_FILE: temporaryIndex,
    GIT_AUTHOR_NAME: "Autoforum",
    GIT_AUTHOR_EMAIL: "autoforum@invalid",
    GIT_COMMITTER_NAME: "Autoforum",
    GIT_COMMITTER_EMAIL: "autoforum@invalid",
  };
  try {
    git(["read-tree", base], { env });
    git(["add", "-A", "--", "."], { env });
    const tree = git(["write-tree"], { env }).trim();
    if (tree === baseTree) return { revision: base, snapshot: false };

    const snapshotRef = `refs/autoforum/snapshots/${tree}`;
    const existing = git(["rev-parse", "--verify", "--quiet", snapshotRef], { env, allowFailure: true })?.trim();
    if (existing) return { revision: existing, snapshot: true };

    const revision = git(["commit-tree", tree, "-p", base], {
      env,
      input: "Autoforum result workspace snapshot\n",
    }).trim();
    git(["update-ref", snapshotRef, revision], { env });
    return { revision, snapshot: true };
  } finally {
    await rm(temporaryIndex, { force: true }).catch(() => undefined);
  }
}

try {
  process.stdout.write(`${JSON.stringify(await capture())}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
