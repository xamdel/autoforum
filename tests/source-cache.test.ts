import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { readSourceCache, writeSourceCache } from "../src/sources/cache.ts";

test("source cache stores extracted text by URL and ignores corrupt entries", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "autoforum-source-cache-"));
  const url = "https://example.com/paper.pdf";
  try {
    await writeSourceCache({
      version: 2,
      url,
      finalUrl: url,
      contentType: "application/pdf",
      title: "A paper",
      metadata: {
        title: "A paper", authors: [], publishedYear: null, containerTitle: null,
        publisher: null, sourceType: "article", identifier: null,
      },
      bytes: 1234,
      pages: ["first page", "second page"],
    }, directory);
    assert.deepEqual(await readSourceCache(url, directory), {
      version: 2,
      url,
      finalUrl: url,
      contentType: "application/pdf",
      title: "A paper",
      metadata: {
        title: "A paper", authors: [], publishedYear: null, containerTitle: null,
        publisher: null, sourceType: "article", identifier: null,
      },
      bytes: 1234,
      pages: ["first page", "second page"],
    });

    const files = await readdir(directory);
    assert.equal(files.length, 1);
    await writeFile(path.join(directory, files[0]!), "not json");
    assert.equal(await readSourceCache(url, directory), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
