import assert from "node:assert/strict";
import test from "node:test";

import { previewAddress } from "../src/forum/addresses.ts";

test("excerpt previews retain a structured link to their parent source", async () => {
  const client = {
    async query(sql: string, parameters: unknown[]) {
      assert.match(sql, /from excerpt e join source s/);
      assert.deepEqual(parameters, [3, 19]);
      return { rows: [{
        title: "A useful paper",
        sourceLocalId: 7,
        locator: "p. 12",
        content: "The measured effect was substantial.",
      }] };
    },
  };

  assert.deepEqual(await previewAddress(client as never, 3, "excerpt:19"), {
    address: "excerpt:19",
    kind: "excerpt",
    heading: "Excerpt from [[source:7]] A useful paper (p. 12)",
    source: {
      address: "source:7",
      title: "A useful paper",
      locator: "p. 12",
    },
    content: "The measured effect was substantial.",
    truncated: false,
  });
});
