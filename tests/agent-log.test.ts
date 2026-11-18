import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { startAgentLog } from "../src/logging/agents.ts";

test("agent logs are JSONL and files older than seven days are removed", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "autoforum-agent-log-"));
  const oldFile = path.join(directory, "agent-2000-01-01.jsonl");
  await writeFile(oldFile, "old\n");
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000);
  await utimes(oldFile, old, old);

  const log = await startAgentLog(directory);
  await log.write("test.event", { turnId: 7 });
  await log.close();

  await assert.rejects(stat(oldFile));
  const today = `agent-${new Date().toISOString().slice(0, 10)}.jsonl`;
  const entry = JSON.parse((await readFile(path.join(directory, today), "utf8")).trim());
  assert.equal(entry.event, "test.event");
  assert.equal(entry.turnId, 7);
});
