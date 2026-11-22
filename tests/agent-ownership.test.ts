import assert from "node:assert/strict";
import test from "node:test";

import { Hono } from "hono";

import { createAgentProfileRoutes } from "../src/agents/profiles.ts";
import { createMcpCredentialRoutes } from "../src/auth/mcp-credentials.ts";
import type { AppDatabase } from "../src/db.ts";
import { createUserRoutes } from "../src/users.ts";

const headers = {
  cookie: "autoforum_session=member",
  origin: "http://app.autoforum.localhost:5173",
  "content-type": "application/json",
};

const memberSession = (sql: string) => {
  if (sql.includes("from browser_session s")) {
    return { rows: [{ id: 9, kind: "human", handle: "alice", is_owner: false }] };
  }
  if (sql.startsWith("update browser_session")) return { rows: [] };
  return null;
};

test("a member can create an agent, but not another human account", async () => {
  const inserts: unknown[][] = [];
  const database = {
    pool: {
      async query(sql: string, values: unknown[] = []) {
        const session = memberSession(sql);
        if (session) return session;
        if (sql.includes("insert into forum_user")) {
          inserts.push(values);
          return { rows: [{ id: 21, kind: values[0], handle: values[1], isOwner: false }] };
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
    },
  } as unknown as AppDatabase;
  const app = new Hono().route("/api/users", createUserRoutes(database));

  const agent = await app.request("/api/users", {
    method: "POST", headers, body: JSON.stringify({ kind: "agent", handle: "alice_agent" }),
  });
  assert.equal(agent.status, 201);
  assert.deepEqual(inserts, [["agent", "alice_agent", 9]]);

  const human = await app.request("/api/users", {
    method: "POST", headers, body: JSON.stringify({ kind: "human", handle: "charlie" }),
  });
  assert.equal(human.status, 403);
  assert.equal((await human.json() as { error: string }).error, "owner_required");
});

test("members see installed agents but only receive and update profiles they own", async () => {
  const profile = { provider: "openrouter", model: "model-1", thinkingLevel: "low", systemPrompt: "Be useful." };
  const database = {
    pool: {
      async query(sql: string, values: unknown[] = []) {
        const session = memberSession(sql);
        if (session) return session;
        if (sql === "select 1 from project_member where project_id = $1 and user_id = $2") {
          return { rows: values[0] === 7 && values[1] === 9 ? [{ ok: 1 }] : [] };
        }
        if (sql.includes("select agent.row_id")) {
          return { rows: [
            { userId: 11, handle: "mine", profile, disabledAt: null, ownerUserId: 9, ownerHandle: "alice", inProject: false },
            { userId: 12, handle: "shared", profile, disabledAt: null, ownerUserId: 1, ownerHandle: "bob", inProject: true },
          ] };
        }
        if (sql.includes("update forum_user") && sql.includes("set agent_config")) {
          return { rows: values[1] === 11 ? [{ userId: 11, handle: "mine", profile: values[0] }] : [] };
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
    },
  } as unknown as AppDatabase;
  const app = new Hono().route("/api", createAgentProfileRoutes(database));

  const listed = await app.request("/api/agents?projectId=7", { headers });
  assert.equal(listed.status, 200);
  const agents = (await listed.json() as { agents: Array<Record<string, unknown>> }).agents;
  assert.equal(agents[0]?.canManage, true);
  assert.deepEqual(agents[0]?.profile, profile);
  assert.equal(agents[1]?.canManage, false);
  assert.equal(agents[1]?.profile, null);
  assert.equal(agents[1]?.provider, "openrouter");
  assert.equal(agents[1]?.model, "model-1");

  const updateMine = await app.request("/api/agents/11/profile", {
    method: "PUT", headers, body: JSON.stringify(profile),
  });
  assert.equal(updateMine.status, 200);
  const updateOther = await app.request("/api/agents/12/profile", {
    method: "PUT", headers, body: JSON.stringify(profile),
  });
  assert.equal(updateOther.status, 404);
});

test("a member can list credentials only for an agent they own", async () => {
  const database = {
    pool: {
      async query(sql: string, values: unknown[] = []) {
        const session = memberSession(sql);
        if (session) return session;
        if (sql.startsWith("select 1 from forum_user")) return { rows: values[0] === 11 ? [{ ok: 1 }] : [] };
        if (sql.includes("from mcp_credential")) return { rows: [] };
        throw new Error(`Unexpected query: ${sql}`);
      },
    },
  } as unknown as AppDatabase;
  const app = new Hono().route("/api", createMcpCredentialRoutes(database));

  assert.equal((await app.request("/api/users/11/mcp-credentials", { headers })).status, 200);
  assert.equal((await app.request("/api/users/12/mcp-credentials", { headers })).status, 404);
});
