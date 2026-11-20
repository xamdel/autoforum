import assert from "node:assert/strict";
import test from "node:test";

import type { AppDatabase } from "../src/db.ts";
import { addressExists, formatAddress, previewAddress } from "../src/forum/addresses.ts";
import { parseResultEnvelope, resultEnvelopeSchema, storeResultEnvelope } from "../src/forum/results.ts";

test("result envelopes have one target and bounded addressable output keys", () => {
  assert.deepEqual(resultEnvelopeSchema.parse({
    target: "proposal:12",
    outputs: { temperature_over_time: [18.2, 18.7], nitrogen_uptake: 4.3 },
  }), {
    target: "proposal:12",
    outputs: { temperature_over_time: [18.2, 18.7], nitrogen_uptake: 4.3 },
  });
  assert.equal(resultEnvelopeSchema.safeParse({ target: "post:12", outputs: { value: 1 } }).success, false);
  assert.equal(resultEnvelopeSchema.safeParse({ target: "thread:2", outputs: {} }).success, false);
  assert.equal(resultEnvelopeSchema.safeParse({ target: "thread:2", outputs: { "Not addressable": 1 } }).success, false);
  assert.equal(resultEnvelopeSchema.safeParse({ target: "thread:2", outputs: { value: 1 }, extra: true }).success, false);
  assert.throws(
    () => parseResultEnvelope({ target: "thread:2", outputs: [{ path: "output.csv" }] }),
    /outputs must be a JSON object with named, addressable keys/,
  );
});

test("storing an envelope resolves its target and allocates an immutable result address", async () => {
  const queries: Array<{ sql: string; parameters?: unknown[] }> = [];
  const client = {
    async query(sql: string, parameters?: unknown[]) {
      queries.push({ sql, parameters });
      if (sql.includes("from result where project_id") && sql.includes("submission_id")) return { rows: [] };
      if (sql.includes('from thread where project_id')) return { rows: [{ threadId: 31 }] };
      if (sql.includes("update project")) return { rows: [{ first_id: 44 }] };
      return { rows: [] };
    },
    release() {},
  };
  const database = { pool: { async connect() { return client; } } } as unknown as AppDatabase;
  const envelope = resultEnvelopeSchema.parse({ target: "thread:7", outputs: { score: 0.91 } });
  const revision = "a".repeat(40);

  assert.equal(await storeResultEnvelope(database, 3, "trial_17", envelope, revision), "result:44");
  const inserted = queries.find((query) => query.sql.includes("insert into result"));
  assert.deepEqual(inserted?.parameters, [3, 44, "trial_17", 31, null, { score: 0.91 }, revision]);
  assert.match(inserted?.sql ?? "", /workspace_revision/);
  assert.equal(queries.at(-1)?.sql, "commit");
});

test("result outputs resolve as address fragments", async () => {
  const client = {
    async query(sql: string) {
      if (sql.includes("outputs ? $3")) return { rows: [{ ok: 1 }] };
      if (sql.includes('d.local_id as "proposalLocalId"')) {
        return { rows: [{ outputs: { score: 0.91 }, proposalLocalId: 12, threadLocalId: 4 }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  assert.equal(await addressExists(client as never, 3, "result:44#score"), true);
  assert.deepEqual(await previewAddress(client as never, 3, "result:44#score"), {
    address: "result:44#score",
    kind: "result",
    heading: "score from result:44",
    content: "0.91",
    truncated: false,
  });
  assert.throws(() => formatAddress("result", 44, "Not valid"), /invalid_fragment/);
});

test("proposal previews expose the output names that result code must publish", async () => {
  const client = {
    async query(sql: string) {
      assert.match(sql, /expected_outputs as "expectedOutputs"/);
      return { rows: [{
        label: "A small test",
        body: "Run the comparison.",
        expectedOutputs: { score: "number", interactive_demo: "HTML page" },
        relationType: null,
        subjects: null,
        objects: null,
      }] };
    },
  };
  const preview = await previewAddress(client as never, 3, "proposal:12");
  assert.equal(preview?.heading, "A small test");
  assert.match(preview?.content ?? "", /Expected result outputs/);
  assert.match(preview?.content ?? "", /"score": "number"/);
  assert.match(preview?.content ?? "", /"interactive_demo": "HTML page"/);
});
