import assert from "node:assert/strict";
import test from "node:test";

import { createApp } from "../src/app.ts";

test("health reports a ready database and worker", async () => {
  const app = createApp({
    checkDatabase: async () => undefined,
    isQueueRunning: () => true,
  });

  const response = await app.request("/health");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "ok",
    database: "ok",
    worker: "ok",
  });
});

test("health reports unavailable infrastructure", async () => {
  const noWorker = createApp({
    checkDatabase: async () => undefined,
    isQueueRunning: () => false,
  });
  assert.equal((await noWorker.request("/health")).status, 503);

  const noDatabase = createApp({
    checkDatabase: async () => { throw new Error("unavailable"); },
    isQueueRunning: () => true,
  });
  assert.equal((await noDatabase.request("/health")).status, 503);
});

test("unknown routes return a plain 404", async () => {
  const app = createApp({
    checkDatabase: async () => undefined,
    isQueueRunning: () => true,
  });
  const response = await app.request("/api/not-implemented");
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "not_found" });
});
