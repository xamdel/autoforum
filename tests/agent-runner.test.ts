import assert from "node:assert/strict";
import test from "node:test";

import { salvageRejectedPublishReply } from "../src/agents/runner.ts";

test("a rejected structured reply salvages its prose instead of a later status message", () => {
  const salvaged = salvageRejectedPublishReply([
    {
      role: "assistant",
      content: [{
        type: "toolCall",
        name: "publish_reply",
        arguments: {
          body: "Long result with [[claim:7]] and [[new:finding]].",
          excerpts: [{ key: "passage" }],
          objects: [{ key: "finding", kind: "invalid" }],
        },
      }],
    },
    { role: "toolResult", toolName: "publish_reply", isError: true },
    { role: "assistant", content: [{ type: "text", text: "I have published my reply." }] },
  ]);

  assert.ok(salvaged);
  assert.match(salvaged.body, /^Long result with \[\[claim:7\]\]/);
  assert.match(salvaged.body, /\[attachment unavailable: finding\]/);
  assert.match(salvaged.body, /Autoforum attachment warning/);
  assert.match(salvaged.body, /1 excerpt, 1 discourse object/);
  assert.doesNotMatch(salvaged.body, /I have published my reply/);
  assert.deepEqual(salvaged.excerpts, []);
  assert.deepEqual(salvaged.objects, []);
});

test("ordinary assistant text cannot be mistaken for an accepted forum reply", () => {
  assert.equal(salvageRejectedPublishReply([
    { role: "assistant", content: [{ type: "text", text: "I have published my reply." }] },
  ]), null);
});
