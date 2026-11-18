import assert from "node:assert/strict";
import test from "node:test";

import type { PoolClient } from "pg";

import { publishThread } from "../src/forum/threads.ts";

test("an agent-created thread stores a one-turn allowance and a structured opening post", async () => {
  let reservation = 40;
  let savedLimit: unknown;
  let savedTags: unknown;
  const client = {
    async query(sql: string, values: unknown[] = []) {
      if (sql.includes("from project_member m join project")) return { rows: [{ defaultAgentTurnLimit: 10 }] };
      if (sql.startsWith("select 1 from subforum")) return { rows: [{ exists: 1 }] };
      if (sql.startsWith("update project")) return { rows: [{ first_id: reservation++ }] };
      if (sql.includes("insert into thread")) {
        savedTags = values[4];
        savedLimit = values[6];
        return { rows: [{ id: 9 }] };
      }
      if (sql.includes("from thread t join project_member")) return { rows: [{ exists: 1 }] };
      if (sql.includes("insert into post")) {
        assert.equal(values[1], 41);
        assert.equal(values[2], 9);
        assert.equal(values[4], null);
        assert.equal(values[5], "Opening argument");
        return { rows: [{ id: 10 }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  } as unknown as PoolClient;

  const published = await publishThread(client, {
    projectId: 1,
    author: { id: 7, isOwner: false },
    agentTurnLimit: 1,
    thread: {
      subforumId: 2,
      title: "A separate question",
      body: "Opening argument",
      tags: ["methods", "methods"],
      excerpts: [],
      objects: [],
    },
  });

  assert.equal(savedLimit, 1);
  assert.deepEqual(savedTags, ["methods"]);
  assert.deepEqual(published, {
    threadId: 9,
    thread: "thread:40",
    postId: 10,
    post: "post:41",
    created: {},
    turnIds: [],
  });
});
