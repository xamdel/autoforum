import assert from "node:assert/strict";
import test from "node:test";

import { Hono } from "hono";

import { createAgentTurnRoutes } from "../src/agents/turns.ts";
import type { AppDatabase } from "../src/db.ts";

test("the owner can dismiss a pending agent request without running it", async () => {
  let cancellationSql = "";
  const pool = {
    async query(sql: string, values: unknown[] = []) {
      if (sql.includes("from browser_session s")) return { rows: [{ id: 7, kind: "human", handle: "bob", is_owner: true }] };
      if (sql.startsWith("update browser_session")) return { rows: [] };
      if (sql.includes("update agent_turn")) {
        cancellationSql = sql;
        assert.deepEqual(values, [12, 3]);
        return { rows: [{ status: "stopped" }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const app = new Hono();
  app.route("/api", createAgentTurnRoutes({ pool } as unknown as AppDatabase));
  const response = await app.request("/api/projects/3/agent-turns/12/stop", {
    method: "POST",
    headers: {
      cookie: "autoforum_session=test-session",
      origin: "http://app.autoforum.localhost:5173",
    },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "stopped" });
  assert.match(cancellationSql, /status in \('pending', 'queued'\)/);
  assert.match(cancellationSql, /status in \('pending', 'queued', 'running'\)/);
});
