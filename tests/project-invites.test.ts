import assert from "node:assert/strict";
import test from "node:test";

import { Hono } from "hono";

import { createProjectInviteRoutes } from "../src/auth/project-invites.ts";
import type { AppDatabase } from "../src/db.ts";

const origin = "http://app.autoforum.localhost:5173";

test("the owner can issue a one-use project invitation", async () => {
  let savedProject = 0;
  const database = {
    pool: {
      async query(sql: string, values: unknown[] = []) {
        if (sql.includes("from browser_session s")) return { rows: [{ id: 1, kind: "human", handle: "bob", is_owner: true }] };
        if (sql.startsWith("update browser_session")) return { rows: [] };
        if (sql.includes("insert into project_invite")) {
          savedProject = values[0] as number;
          return { rows: [{ row_id: 8 }] };
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
    },
  } as unknown as AppDatabase;
  const app = new Hono().route("/api", createProjectInviteRoutes(database));
  const response = await app.request("/api/projects/7/invites", {
    method: "POST",
    headers: { origin, cookie: "autoforum_session=owner" },
  });
  assert.equal(response.status, 201);
  assert.equal(savedProject, 7);
  const body = await response.json() as { token: string };
  assert.ok(body.token.length >= 32);
});

test("redeeming an invitation creates one private account session and cannot be repeated", async () => {
  let consumed = false;
  let membership: unknown[] | null = null;
  const client = {
    async query(sql: string, values: unknown[] = []) {
      if (sql === "begin" || sql === "commit" || sql === "rollback") return { rows: [] };
      if (sql.includes("from project_invite i") && sql.includes("for update")) {
        return { rows: consumed ? [] : [{ id: 9, projectId: 7, projectName: "Research", expiresAt: new Date(), createdByUserId: 1 }] };
      }
      if (sql.includes("insert into forum_user")) return { rows: [{ id: 12, kind: "human", handle: values[0], is_owner: false }] };
      if (sql.includes("insert into browser_session")) return { rows: [] };
      if (sql.includes("insert into project_member")) {
        membership = values;
        return { rows: [] };
      }
      if (sql.startsWith("update project_invite")) {
        consumed = true;
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };
  const database = {
    pool: {
      async connect() { return client; },
    },
  } as unknown as AppDatabase;
  const app = new Hono().route("/api", createProjectInviteRoutes(database));
  const headers = { origin, "content-type": "application/json" };
  const first = await app.request(`/api/project-invites/${"x".repeat(40)}/redeem`, {
    method: "POST",
    headers,
    body: JSON.stringify({ handle: "alice" }),
  });
  assert.equal(first.status, 201);
  assert.deepEqual(membership, [7, 12]);
  assert.match(first.headers.get("set-cookie") ?? "", /autoforum_session=/);

  const second = await app.request(`/api/project-invites/${"x".repeat(40)}/redeem`, {
    method: "POST",
    headers,
    body: JSON.stringify({ handle: "charlie" }),
  });
  assert.equal(second.status, 404);
});
