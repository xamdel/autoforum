import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { startSystemLog } from "../src/logging/system.ts";

test("system logs are retained for seven days and redact common secrets", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "autoforum-system-log-"));
  const oldFile = path.join(directory, "system-2000-01-01.jsonl");
  await writeFile(oldFile, "old\n");
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000);
  await utimes(oldFile, old, old);

  const log = await startSystemLog(directory, { mirror: false });
  log.error("test.failure", new Error("authorization=very-secret"), {
    projectId: 7,
    apiKey: "also-secret",
    database: "postgres://owner:database-password@127.0.0.1/autoforum",
    nested: { sessionToken: "third-secret", useful: "kept" },
  });
  await log.close();

  await assert.rejects(stat(oldFile));
  const today = `system-${new Date().toISOString().slice(0, 10)}.jsonl`;
  const text = (await readFile(path.join(directory, today), "utf8")).trim();
  assert.doesNotMatch(text, /very-secret|also-secret|third-secret|database-password/);
  const entry = JSON.parse(text);
  assert.equal(entry.event, "test.failure");
  assert.equal(entry.projectId, 7);
  assert.equal(entry.apiKey, "[REDACTED]");
  assert.equal(entry.nested.useful, "kept");
});
