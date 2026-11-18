import assert from "node:assert/strict";
import test from "node:test";

import { Hono } from "hono";

import type { AppDatabase } from "../src/db.ts";
import { createSubforumRoutes } from "../src/forum/subforums.ts";

function fixture() {
  let owner = true;
  const created: Array<{ projectId: number; name: string; description: string }> = [];
  const pool = {
    async query(sql: string, values: unknown[] = []) {
      if (sql.includes("from browser_session s")) {
        return { rows: [{ id: 7, kind: "human", handle: "bob", is_owner: owner }] };
      }
      if (sql.startsWith("update browser_session")) return { rows: [] };
      if (sql === "select 1 from project_member where project_id = $1 and user_id = $2") {
        return { rows: values[0] === 3 && values[1] === 7 ? [{ exists: 1 }] : [] };
      }
      if (sql.includes("from subforum s")) {
        return { rows: [{ id: 11, name: "General", description: "", createdAt: new Date(1), threadCount: 2 }] };
      }
      if (sql.includes("insert into subforum")) {
        created.push({ projectId: values[0] as number, name: values[1] as string, description: values[2] as string });
        return { rows: [{ id: 12, name: values[1], description: values[2], createdAt: new Date(2) }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const app = new Hono();
  app.route("/api", createSubforumRoutes({ pool } as unknown as AppDatabase));
  return { app, created, setOwner(value: boolean) { owner = value; } };
}

const headers = {
  cookie: "autoforum_session=test-session",
  origin: "http://app.autoforum.localhost:5173",
  "content-type": "application/json",
};

test("project members list subforums and the owner creates one", async () => {
  const testApp = fixture();
  const listed = await testApp.app.request("/api/projects/3/subforums", { headers });
  assert.equal(listed.status, 200);
  assert.deepEqual((await listed.json() as { subforums: unknown[] }).subforums, [{
    id: 11,
    name: "General",
    description: "",
    createdAt: "1970-01-01T00:00:00.001Z",
    threadCount: 2,
  }]);

  const created = await testApp.app.request("/api/projects/3/subforums", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Research", description: "Working investigations" }),
  });
  assert.equal(created.status, 201);
  assert.deepEqual(testApp.created, [{ projectId: 3, name: "Research", description: "Working investigations" }]);
});

test("ordinary project members cannot create subforums", async () => {
  const testApp = fixture();
  testApp.setOwner(false);
  const response = await testApp.app.request("/api/projects/3/subforums", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Private plans", description: "" }),
  });
  assert.equal(response.status, 403);
  assert.deepEqual(testApp.created, []);
});
