import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  projectResourcesForRestore,
  readAndVerifyBackup,
  restoreWorkspaceVolumes,
} from "../src/backup.ts";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "autoforum-backup-test-"));
  const publicId = "123e4567-e89b-42d3-a456-426614174000";
  const database = Buffer.from("database dump");
  const workspace = Buffer.from("workspace tar");
  await mkdir(path.join(root, "workspaces"));
  await writeFile(path.join(root, "database.dump"), database);
  await writeFile(path.join(root, "workspaces", `${publicId}.tar`), workspace);
  const record = (filePath: string, bytes: Buffer) => ({
    path: filePath,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  await writeFile(path.join(root, "manifest.json"), JSON.stringify({
    format: "autoforum-backup",
    version: 1,
    createdAt: "2026-11-16T12:00:00.000Z",
    database: record("database.dump", database),
    projects: [{
      publicId,
      workspace: record(`workspaces/${publicId}.tar`, workspace),
    }],
  }));
  return { root, publicId };
}

test("a complete checksummed backup verifies", async () => {
  const value = await fixture();
  try {
    const verified = await readAndVerifyBackup(value.root);
    assert.equal(verified.manifest.projects[0]?.publicId, value.publicId);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("verification rejects changed backup contents", async () => {
  const value = await fixture();
  try {
    await writeFile(path.join(value.root, "database.dump"), "changed");
    await assert.rejects(readAndVerifyBackup(value.root), /backup_size_mismatch:database\.dump/);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("verification does not accept manifest-selected paths", async () => {
  const value = await fixture();
  try {
    const manifestPath = path.join(value.root, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.database.path = "../database.dump";
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(readAndVerifyBackup(value.root), /backup_database_path_invalid/);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("the restore conflict set includes every project resource even without a backed-up workspace", async () => {
  const value = await fixture();
  try {
    const { manifest } = await readAndVerifyBackup(value.root);
    manifest.projects[0]!.workspace = null;
    const resources = projectResourcesForRestore(manifest);
    assert.deepEqual(resources.map((resource) => resource.kind), [
      "container", "container", "volume", "volume", "volume", "network", "network",
    ]);
    assert.ok(resources.some((resource) => resource.name.endsWith("-workspace")));
    assert.ok(resources.some((resource) => resource.name.endsWith("-home")));
    assert.ok(resources.some((resource) => resource.name.endsWith("-cache")));
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("failed workspace import removes all volumes created by that restore", async () => {
  const value = await fixture();
  try {
    const { manifest } = await readAndVerifyBackup(value.root);
    const secondId = "223e4567-e89b-42d3-a456-426614174001";
    manifest.projects.push({
      publicId: secondId,
      workspace: {
        path: `workspaces/${secondId}.tar`,
        bytes: 1,
        sha256: "0".repeat(64),
      },
    });
    const calls: string[][] = [];
    await assert.rejects(
      restoreWorkspaceVolumes(value.root, manifest, async (_command, args) => {
        calls.push(args);
        if (args[0] === "volume" && args[1] === "import" && args[2]?.includes(secondId)) {
          throw new Error("simulated_import_failure");
        }
        return { stdout: "", stderr: "" };
      }),
      /simulated_import_failure/,
    );
    const removed = calls
      .filter((args) => args[0] === "volume" && args[1] === "rm")
      .map((args) => args.at(-1));
    assert.deepEqual(removed, [
      `autoforum-${secondId}-workspace`,
      `autoforum-${value.publicId}-workspace`,
    ]);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
