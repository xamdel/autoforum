import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "pg";
import { z } from "zod";

import { publishInputSchema, validatePublishPost } from "../src/forum/publish.ts";

const post = (object: unknown) => ({ body: "A forum post", excerpts: [], objects: [object] });

test("question objects cover both exploratory and specifically testable research questions", () => {
  for (const body of [
    "How should we understand the role of representation in scientific discovery?",
    "Does method A reduce median attachment error below method B on the fixed 100-item set?",
  ]) {
    assert.equal(publishInputSchema.safeParse(post({ key: "research_question", kind: "question", body })).success, true);
  }
});

test("the publishing tool describes the sandbox proposal capability", () => {
  const description = JSON.stringify(z.toJSONSchema(publishInputSchema, {
    target: "draft-2020-12",
    io: "input",
    unrepresentable: "throw",
  }));
  assert.match(description, /owner-reviewed Scribe implementation in the project sandbox/);
  assert.match(description, /same experimental runner, configuration format, result format, and measurements/);
  assert.match(description, /purpose, inputs, procedure, outputs, dependencies, and approximate run or paid-call count/);
  assert.match(description, /exact result field name/);
});

test("discourse object input exposes relation fields only on relations", () => {
  assert.equal(publishInputSchema.safeParse(post({
    key: "evidence",
    kind: "evidence",
    body: "The cited observation.",
    subjects: ["post:2"],
  })).success, false);

  assert.equal(publishInputSchema.safeParse(post({
    key: "relation",
    kind: "relation",
    relationType: "supports",
    subjects: ["evidence:2"],
    objects: ["claim:3"],
  })).success, true);

  assert.equal(publishInputSchema.safeParse(post({
    key: "relation",
    kind: "relation",
    body: "Missing its endpoints.",
  })).success, false);
});

test("relation objects accept the canonical kind and normalize the rel address shorthand", () => {
  for (const kind of ["relation", "rel"]) {
    const parsed = publishInputSchema.parse(post({
      key: "relation",
      kind,
      relationType: "supports",
      subjects: ["evidence:2"],
      objects: ["claim:3"],
    }));
    assert.equal(parsed.objects[0]?.kind, "relation");
  }

  const inputSchema = JSON.stringify(z.toJSONSchema(publishInputSchema, {
    target: "draft-2020-12",
    io: "input",
    unrepresentable: "throw",
  }));
  assert.match(inputSchema, /"const":"relation"/);
  assert.match(inputSchema, /"const":"rel"/);
});

test("relation endpoints distinguish existing addresses from sibling keys", () => {
  assert.equal(publishInputSchema.safeParse(post({
    key: "relation",
    kind: "relation",
    relationType: "supports",
    subjects: ["new:observation"],
    objects: ["claim:3"],
  })).success, true);

  assert.equal(publishInputSchema.safeParse(post({
    key: "relation",
    kind: "relation",
    relationType: "supports",
    subjects: ["observation"],
    objects: ["claim:3"],
  })).success, false);
});

test("publication preflight rejects an unknown sibling reference before accepting a reply", async () => {
  const client = {
    async query() {
      throw new Error("database_should_not_be_reached");
    },
  } as unknown as PoolClient;

  await assert.rejects(
    validatePublishPost(client, {
      projectId: 1,
      threadId: 2,
      author: { id: 3, isOwner: false },
      post: publishInputSchema.parse({
        body: "A reply",
        excerpts: [],
        objects: [{
          key: "relation",
          kind: "relation",
          relationType: "supports",
          subjects: ["new:missing"],
          objects: ["claim:3"],
        }],
      }),
    }),
    /unknown_local_reference:missing/,
  );
});

test("publication preflight rejects a well-formed address that is absent from the project", async () => {
  const client = {
    async query(sql: string) {
      if (sql.includes("join project_member")) return { rows: [{}] };
      if (sql.includes("from discourse_object")) return { rows: [] };
      throw new Error(`unexpected_query:${sql}`);
    },
  } as unknown as PoolClient;

  await assert.rejects(
    validatePublishPost(client, {
      projectId: 1,
      threadId: 2,
      author: { id: 3, isOwner: false },
      post: publishInputSchema.parse({
        body: "This relies on [[claim:99]].",
        excerpts: [],
        objects: [],
      }),
    }),
    /address_not_found:claim:99/,
  );
});

test("expected result fields belong only to sandbox proposals", () => {
  assert.equal(publishInputSchema.safeParse(post({
    key: "claim",
    kind: "claim",
    body: "A claim is not an implementation request.",
    expectedOutputs: { score: "number" },
  })).success, false);

  assert.equal(publishInputSchema.safeParse(post({
    key: "prototype",
    kind: "proposal",
    body: "Build and compare two runnable versions in the sandbox.",
    expectedOutputs: { comparison: "measurements and artifact paths" },
  })).success, true);
});
