import assert from "node:assert/strict";
import test from "node:test";

import type { AppDatabase } from "../src/db.ts";
import { buildAgentContext, selectContextPosts } from "../src/agents/context.ts";

function post(id: number, body: string, replyToPostId: number | null = null) {
  return {
    id,
    localId: id,
    author: `user${id}`,
    replyToPostId,
    body,
    refs: [],
    createdAt: new Date(id * 1_000),
  };
}

test("context always includes the opening, trigger, and direct parent posts", () => {
  const posts = [
    post(1, "opening"),
    post(2, "x".repeat(1_000)),
    post(3, "parent"),
    post(4, "trigger", 3),
  ];
  assert.deepEqual(selectContextPosts(posts, 4, 1).map((item) => item.id), [1, 3, 4]);
});

test("remaining context budget is filled newest-first and rendered chronologically", () => {
  const posts = [
    post(1, "opening"),
    post(2, "a".repeat(500)),
    post(3, "b".repeat(500)),
    post(4, "trigger"),
    post(5, "newest"),
  ];
  assert.deepEqual(selectContextPosts(posts, 4, 700).map((item) => item.id), [1, 4, 5]);
});

test("context attaches introduced records and expands a repeated address only once", async () => {
  let previewReads = 0;
  const client = {
    async query(sql: string) {
      if (sql.includes('select p.thread_id as "threadId"')) {
        return { rows: [{ threadId: 9, title: "Context test", subforum: "Research", tags: [] }] };
      }
      if (sql.includes('p.reply_to_post_id as "replyToPostId"')) {
        return { rows: [
          { id: 1, localId: 2, author: "bob", replyToPostId: null, body: "Opening [[claim:8]]", refs: ["claim:8"], createdAt: new Date(1) },
          { id: 2, localId: 5, author: "bob", replyToPostId: 1, body: "Trigger [[claim:8]]", refs: ["claim:8"], createdAt: new Date(2) },
        ] };
      }
      if (sql.includes("from forum_user u join project_member")) return { rows: [{ handle: "al" }, { handle: "critic" }] };
      if (sql.includes("from discourse_object where")) {
        return { rows: [{
          id: 20, localId: 6, bornInPostId: 1, kind: "evidence", label: "Introduced evidence",
          body: "Evidence body", relationType: null, subjects: null, objects: null, refs: ["claim:8"],
        }] };
      }
      if (sql.includes("from excerpt e join source")) {
        return { rows: [{
          id: 30, localId: 7, bornInPostId: 1, content: "Quoted text", locator: "p. 2",
          sourceLocalId: 4, sourceTitle: "A source",
        }] };
      }
      if (sql.includes("from discourse_object") && sql.includes("kind = $3")) {
        previewReads += 1;
        return { rows: [{ label: "Referenced claim", body: "Claim detail", relationType: null, subjects: null, objects: null }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };
  const database = { pool: { async connect() { return client; } } } as unknown as AppDatabase;

  const rendered = await buildAgentContext(database, 3, 2);
  assert.match(rendered, /Subforum: Research/);
  assert.match(rendered, /Available agents: @al, @critic/);
  assert.match(rendered, /evidence \[\[evidence:6\]\] — Introduced evidence/);
  assert.match(rendered, /excerpt \[\[excerpt:7\]\] from \[\[source:4\]\]/);
  assert.match(rendered, /### \[\[claim:8\]\] Referenced claim/);
  assert.equal(previewReads, 1);
});
