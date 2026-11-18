import assert from "node:assert/strict";
import test from "node:test";

import { Hono } from "hono";

import type { AppDatabase } from "../src/db.ts";
import { createForumQueryRoutes } from "../src/forum/queries.ts";

/** One project: thread row 9 holds post:5 (row 50), which introduced claim:6 and excerpt:7; result:8 targets the thread. */
function fixture() {
  const pool = {
    async query(sql: string, values: unknown[] = []) {
      if (sql.includes("from browser_session")) return { rows: [{ id: 2, kind: "human", handle: "bob", is_owner: false }] };
      if (sql.includes("update browser_session")) return { rows: [] };
      if (sql.startsWith("select 1 from project_member")) return { rows: values[0] === 1 ? [{ exists: 1 }] : [] };
      if (sql.startsWith("select * from thread")) return { rows: values[1] === 3 ? [{ row_id: 9, local_id: 3, title: "Thread" }] : [] };
      if (sql.startsWith("select * from post")) return { rows: values[1] === 5 ? [{ row_id: 50, local_id: 5, thread_id: 9, body: "Post" }] : [] };
      if (sql.startsWith("select * from discourse_object")) {
        return { rows: values[1] === 6 && values[2] === "claim" ? [{ row_id: 60, local_id: 6, kind: "claim", born_in_post_id: 50 }] : [] };
      }
      if (sql.startsWith("select * from excerpt")) return { rows: values[1] === 7 ? [{ row_id: 70, local_id: 7, source_id: 4, born_in_post_id: 50 }] : [] };
      if (sql.startsWith("select * from source")) return { rows: values[1] === 4 ? [{ row_id: 40, local_id: 4, title: "Source" }] : [] };
      if (sql.startsWith("select * from result")) return { rows: values[1] === 8 ? [{ row_id: 80, local_id: 8, thread_id: 9, outputs: { loss: 1 } }] : [] };
      if (sql.includes("outputs -> $3 as value")) {
        assert.match(sql, /thread_id/);
        return { rows: values[1] === 8 && values[2] === "loss" ? [{ local_id: 8, submission_id: "a", thread_id: 9, value: 1 }] : [] };
      }
      if (sql.includes(`select thread_id as "threadId", local_id as "localId" from post`)) {
        return { rows: values[0] === 1 && values[1] === 50 ? [{ threadId: 9, localId: 5 }] : [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    async connect() {
      return { query: pool.query.bind(pool), release() {} };
    },
  };
  const app = new Hono();
  app.route("/api", createForumQueryRoutes({ pool } as unknown as AppDatabase));
  return async (address: string, project = 1) => {
    const response = await app.request(`/api/projects/${project}/address/${encodeURIComponent(address)}`, {
      headers: { cookie: "autoforum_session=forum-secret" },
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
}

test("a resolved address says which thread shows it and which post introduced it", async () => {
  const resolve = fixture();
  const place = async (address: string) => {
    const { status, body } = await resolve(address);
    assert.equal(status, 200, address);
    assert.equal(body.address, address);
    assert.ok(body.record, address);
    return { threadId: body.threadId, postId: body.postId, postAddress: body.postAddress };
  };
  const introduced = { threadId: 9, postId: 50, postAddress: "post:5" };

  assert.deepEqual(await place("thread:3"), { threadId: 9, postId: null, postAddress: null });
  assert.deepEqual(await place("post:5"), introduced);
  assert.deepEqual(await place("claim:6"), introduced);
  assert.deepEqual(await place("excerpt:7"), introduced);
  assert.deepEqual(await place("result:8"), { threadId: 9, postId: null, postAddress: null });
  assert.deepEqual(await place("result:8#loss"), { threadId: 9, postId: null, postAddress: null });
  assert.deepEqual(await place("source:4"), { threadId: null, postId: null, postAddress: null });
});

test("an address that does not resolve, or a project the reader is not in, is not found", async () => {
  const resolve = fixture();
  assert.equal((await resolve("claim:99")).status, 404);
  assert.equal((await resolve("question:6")).status, 404);
  assert.equal((await resolve("not-an-address")).status, 404);
  assert.equal((await resolve("claim:6", 2)).status, 404);
});
