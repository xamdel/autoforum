import assert from "node:assert/strict";
import test from "node:test";

import { Hono } from "hono";

import type { AppDatabase } from "../src/db.ts";
import { createProjectRoutes } from "../src/projects.ts";

const headers = {
  cookie: "autoforum_session=member-test",
  origin: "http://app.autoforum.localhost:5173",
  "content-type": "application/json",
};

function fixture(owner: boolean) {
  const updates: unknown[][] = [];
  const database = {
    pool: {
      async query(sql: string, values: unknown[] = []) {
        if (sql.includes("from browser_session s")) {
          return { rows: [{ id: owner ? 1 : 9, kind: "human", handle: owner ? "bob" : "alice", is_owner: owner }] };
        }
        if (sql.startsWith("update browser_session")) return { rows: [] };
        if (sql.includes("update project_member membership")) {
          updates.push(values);
          return { rows: [{ user_id: values[1] }] };
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
    },
  } as unknown as AppDatabase;
  return { app: new Hono().route("/api/projects", createProjectRoutes(database)), updates };
}

test("the installation owner can grant a human member shared workspace editing", async () => {
  const { app, updates } = fixture(true);
  const response = await app.request("/api/projects/7/members/9", {
    method: "PATCH",
    headers,
    body: JSON.stringify({ canEditWorkspace: true }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(updates, [[7, 9, true]]);
});

test("ordinary members cannot grant workspace editing", async () => {
  const { app, updates } = fixture(false);
  const response = await app.request("/api/projects/7/members/9", {
    method: "PATCH",
    headers,
    body: JSON.stringify({ canEditWorkspace: true }),
  });
  assert.equal(response.status, 403);
  assert.deepEqual(updates, []);
});
