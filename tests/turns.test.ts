import assert from "node:assert/strict";
import test from "node:test";

import { Hono } from "hono";
import type { PoolClient } from "pg";

import { approvePendingTurns, createAgentTurnRoutes, createMentionTurns, setProjectTurnLimit, setThreadTurnLimit } from "../src/agents/turns.ts";
import type { AppDatabase } from "../src/db.ts";
import { findMentionedUserIds } from "../src/forum/queries.ts";

const profile = {
  provider: "openrouter",
  model: "vendor/model",
  thinkingLevel: "low",
  systemPrompt: "Useful",
};

test("mentioned user ids follow their first appearance in the post", async () => {
  const client = {
    async query(_sql: string, values: unknown[]) {
      assert.deepEqual(values, [7, ["mosaic-9", "turing"]]);
      return { rows: [
        { id: 4, handle: "turing" },
        { id: 9, handle: "mosaic-9" },
      ] };
    },
  } as unknown as PoolClient;
  const ids = await findMentionedUserIds(client, 7, "@mosaic-9, then @turing, then @mosaic-9 again");
  assert.deepEqual(ids, [9, 4]);
});

test("the owner can pause and resume the global forum-agent runner", async () => {
  let paused = false;
  const database = {
    pool: {
      async query(sql: string) {
        if (sql.includes("from browser_session s")) {
          return { rows: [{ id: 7, kind: "human", handle: "bob", is_owner: true }] };
        }
        if (sql.startsWith("update browser_session")) return { rows: [] };
        throw new Error(`Unexpected query: ${sql}`);
      },
    },
  } as unknown as AppDatabase;
  const app = new Hono();
  app.route("/api", createAgentTurnRoutes(database, undefined, {
    areAgentTurnsPaused: () => paused,
    async setAgentTurnsPaused(value) { paused = value; },
  }));
  const headers = {
    cookie: "autoforum_session=test-session",
    origin: "http://app.autoforum.localhost:5173",
    "content-type": "application/json",
  };

  const pause = await app.request("/api/agent-runner", {
    method: "PUT",
    headers,
    body: JSON.stringify({ paused: true }),
  });
  assert.equal(pause.status, 200);
  assert.deepEqual(await pause.json(), { paused: true });

  const status = await app.request("/api/agent-runner", { headers });
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { paused: true });

  const resume = await app.request("/api/agent-runner", {
    method: "PUT",
    headers,
    body: JSON.stringify({ paused: false }),
  });
  assert.equal(resume.status, 200);
  assert.deepEqual(await resume.json(), { paused: false });
});

test("an agent mention waits when the thread has no remaining turn allowance", async () => {
  let inserted = 0;
  const client = {
    async query(sql: string) {
      if (sql.includes("from forum_user")) return { rows: [{ userId: 4, profile }] };
      if (sql.includes("from project where")) return { rows: [{ id: 1, limit: 100 }] };
      if (sql.includes("from thread t join post")) return { rows: [{ id: 9, limit: 0 }] };
      if (sql.includes("count(*)::int")) return { rows: [{ count: 0 }] };
      if (sql.includes("insert into agent_turn")) {
        inserted += 1;
        return { rows: [{ id: 17 }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  } as unknown as PoolClient;
  const turns = await createMentionTurns(client, {
    projectId: 1,
    triggerPostId: 2,
    requestedByUserId: 3,
    mentionedUserIds: [4],
    requesterIsOwner: false,
  });
  assert.deepEqual(turns, []);
  assert.equal(inserted, 1);
});

test("an agent-created thread with a one-turn allowance admits only its first opening-post mention", async () => {
  const client = {
    async query(sql: string, values: unknown[]) {
      if (sql.includes("from forum_user")) return { rows: [
        { userId: 5, profile },
        { userId: 4, profile },
      ] };
      if (sql.includes("from project where")) return { rows: [{ id: 1, limit: 100 }] };
      if (sql.includes("from thread t join post")) return { rows: [{ id: 9, limit: 1 }] };
      if (sql.includes("count(*)::int")) return { rows: [{ count: 0 }] };
      if (sql.includes("insert into agent_turn")) return { rows: [{ id: 13 + (values[1] as number) }] };
      if (sql.includes("order by a.created_at")) {
        assert.equal(values[1], 1);
        return { rows: [{ id: 17 }] };
      }
      if (sql.startsWith("update agent_turn set status = 'queued' where")) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  } as unknown as PoolClient;
  const turns = await createMentionTurns(client, {
    projectId: 1,
    triggerPostId: 2,
    requestedByUserId: 3,
    mentionedUserIds: [4, 5],
    requesterIsOwner: false,
  });
  assert.deepEqual(turns, [17]);
});

test("an owner mention extends the thread limit and queues every mentioned project agent with a profile", async () => {
  const insertedUsers: number[] = [];
  let savedLimit = 0;
  const client = {
    async query(sql: string, values: unknown[]) {
      if (sql.includes("from forum_user")) return { rows: [
        { userId: 5, profile },
        { userId: 4, profile },
      ] };
      if (sql.includes("from project where")) return { rows: [{ id: 1, limit: 0 }] };
      if (sql.includes("from thread t join post")) return { rows: [{ id: 9, limit: 0 }] };
      if (sql.includes("count(*)::int")) return { rows: [{ count: 0 }] };
      if (sql.includes("insert into agent_turn")) {
        insertedUsers.push(values[1] as number);
        return { rows: [{ id: 13 + (values[1] as number) }] };
      }
      if (sql.startsWith("update thread set agent_turn_limit")) {
        savedLimit = values[1] as number;
        return { rows: [] };
      }
      if (sql.startsWith("update project set agent_turn_limit")) return { rows: [] };
      if (sql.includes("update agent_turn set status = 'queued'")) return { rows: [{ id: 18 }, { id: 17 }] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  } as unknown as PoolClient;
  const turns = await createMentionTurns(client, {
    projectId: 1,
    triggerPostId: 2,
    requestedByUserId: 3,
    mentionedUserIds: [4, 5],
    requesterIsOwner: true,
  });
  assert.deepEqual(turns, [17, 18]);
  assert.deepEqual(insertedUsers, [4, 5]);
  assert.equal(savedLimit, 2);
});

test("raising a thread limit releases only the newly available oldest turns", async () => {
  const client = {
    async query(sql: string, values: unknown[]) {
      if (sql.includes("from project where")) return { rows: [{ id: 1, limit: 100 }] };
      if (sql.includes("from thread where")) return { rows: [{ id: 9, limit: 2 }] };
      if (sql.trimStart().startsWith("select count(*)::int") && sql.includes("a.status = 'pending'")) return { rows: [{ count: 4 }] };
      if (sql.includes("count(*)::int")) return { rows: [{ count: 2 }] };
      if (sql.startsWith("update thread set agent_turn_limit")) return { rows: [] };
      if (sql.includes("order by a.created_at")) {
        assert.equal(values[1], 3);
        return { rows: [{ id: 21 }, { id: 22 }, { id: 23 }] };
      }
      if (sql.startsWith("update agent_turn set status = 'queued' where")) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  } as unknown as PoolClient;
  const state = await setThreadTurnLimit(client, 1, 9, 5);
  assert.deepEqual(state, { limit: 5, admitted: 5, pending: 4, queuedIds: [21, 22, 23] });
});

test("approving selected waiting turns extends the limit by the selected batch", async () => {
  let savedLimit = 0;
  const client = {
    async query(sql: string, values: unknown[]) {
      if (sql.includes("from project where")) return { rows: [{ id: 1, limit: 2 }] };
      if (sql.includes("from thread where")) return { rows: [{ id: 9, limit: 2 }] };
      if (sql.includes("a.row_id = any") && sql.includes("for update of a")) return { rows: [{ id: 31 }, { id: 33 }] };
      if (sql.trimStart().startsWith("select count(*)::int") && sql.includes("a.status = 'pending'")) return { rows: [{ count: 1 }] };
      if (sql.includes("count(*)::int")) return { rows: [{ count: 2 }] };
      if (sql.startsWith("update thread set agent_turn_limit")) {
        savedLimit = values[2] as number;
        return { rows: [] };
      }
      if (sql.startsWith("update project set agent_turn_limit")) return { rows: [] };
      if (sql.includes("update agent_turn set status = 'queued'")) return { rows: [{ id: 33 }, { id: 31 }] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  } as unknown as PoolClient;
  const state = await approvePendingTurns(client, 1, 9, [31, 33]);
  assert.equal(savedLimit, 4);
  assert.deepEqual(state, { limit: 4, admitted: 4, pending: 1, queuedIds: [31, 33] });
});

test("the project allowance stops an otherwise eligible member mention", async () => {
  const client = {
    async query(sql: string) {
      if (sql.includes("from forum_user")) return { rows: [{ userId: 4, profile }] };
      if (sql.includes("from project where")) return { rows: [{ id: 1, limit: 3 }] };
      if (sql.includes("from thread t join post")) return { rows: [{ id: 9, limit: 10 }] };
      if (sql.includes("count(*)::int")) return { rows: [{ count: 3 }] };
      if (sql.includes("insert into agent_turn")) return { rows: [{ id: 41 }] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  } as unknown as PoolClient;
  const turns = await createMentionTurns(client, {
    projectId: 1,
    triggerPostId: 2,
    requestedByUserId: 3,
    mentionedUserIds: [4],
    requesterIsOwner: false,
  });
  assert.deepEqual(turns, []);
});

test("raising the project allowance admits oldest pending turns only where their threads have room", async () => {
  const client = {
    async query(sql: string, values: unknown[]) {
      if (sql.includes("from project where")) return { rows: [{ id: 1, limit: 3 }] };
      if (sql.trimStart().startsWith("select count(*)::int") && sql.includes("where a.project_id")) return { rows: [{ count: 3 }] };
      if (sql.startsWith("update project set agent_turn_limit")) return { rows: [] };
      if (sql.includes("from agent_turn a") && sql.includes("threadAdmitted")) return { rows: [
        { id: 51, threadId: 8, threadLimit: 2, threadAdmitted: 2 },
        { id: 52, threadId: 9, threadLimit: 4, threadAdmitted: 1 },
        { id: 53, threadId: 9, threadLimit: 4, threadAdmitted: 1 },
      ] };
      if (sql.startsWith("update agent_turn set status = 'queued'")) {
        assert.deepEqual(values[0], [52, 53]);
        return { rows: [{ id: 53 }, { id: 52 }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  } as unknown as PoolClient;
  const state = await setProjectTurnLimit(client, 1, 5);
  assert.deepEqual(state, { limit: 5, admitted: 5, queuedIds: [52, 53] });
});
