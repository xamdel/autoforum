import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../src/config.ts";

test("configuration has local development defaults", () => {
  assert.deepEqual(loadConfig({}), {
    nodeEnv: "development",
    host: "127.0.0.1",
    port: 3_000,
    databaseUrl: "postgres://localhost:5432/autoforum",
  });
});

test("configuration rejects invalid values", () => {
  assert.throws(() => loadConfig({ PORT: "70000" }));
  assert.throws(() => loadConfig({ NODE_ENV: "staging" }));
  assert.throws(() => loadConfig({ DATABASE_URL: "https://example.com" }));
});
