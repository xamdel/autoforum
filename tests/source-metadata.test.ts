import assert from "node:assert/strict";
import test from "node:test";

import { canonicalSourceLocator, metadataFromHtml } from "../src/sources/metadata.ts";

test("citation metadata is extracted from ordinary scholarly HTML", () => {
  const metadata = metadataFromHtml(`
    <html><head>
      <meta name="citation_title" content="A &amp; B">
      <meta name="citation_author" content="Ada Lovelace">
      <meta name="citation_author" content="Grace Hopper">
      <meta name="citation_publication_date" content="2025/04/03">
      <meta name="citation_journal_title" content="Journal of Useful Tests">
      <meta name="citation_publisher" content="Example Press">
      <meta name="citation_doi" content="10.1234/example">
    </head></html>
  `);

  assert.deepEqual(metadata, {
    title: "A & B",
    authors: ["Ada Lovelace", "Grace Hopper"],
    publishedYear: 2025,
    containerTitle: "Journal of Useful Tests",
    publisher: "Example Press",
    sourceType: "article",
    identifier: "10.1234/example",
  });
});

test("JSON-LD provides a metadata fallback for ordinary source pages", () => {
  const metadata = metadataFromHtml(`
    <script type="application/ld+json">
      {"@type":"Dataset","name":"Measured things","author":{"name":"Research Group"},"datePublished":"2024-01-02","publisher":{"name":"Data Host"}}
    </script>
  `);

  assert.equal(metadata.title, "Measured things");
  assert.deepEqual(metadata.authors, ["Research Group"]);
  assert.equal(metadata.publishedYear, 2024);
  assert.equal(metadata.publisher, "Data Host");
  assert.equal(metadata.sourceType, "dataset");
});

test("known item locators become durable reader-facing URLs", () => {
  assert.equal(
    canonicalSourceLocator("https://arxiv.org/pdf/2501.01234.pdf?download=1"),
    "https://arxiv.org/abs/2501.01234",
  );
  assert.equal(
    canonicalSourceLocator("https://arxiv.org/pdf/hep-th/9901001.pdf"),
    "https://arxiv.org/abs/hep-th/9901001",
  );
  assert.equal(
    canonicalSourceLocator("https://api.crossref.org/works/10.1234%2Fexample"),
    "https://doi.org/10.1234/example",
  );
  assert.equal(
    canonicalSourceLocator("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=12345"),
    "https://pubmed.ncbi.nlm.nih.gov/12345/",
  );
  assert.equal(
    canonicalSourceLocator("https://example.test/articles/one?view=full"),
    "https://example.test/articles/one?view=full",
  );
});

test("known search and aggregate endpoints are not accepted as sources", () => {
  assert.throws(
    () => canonicalSourceLocator("https://arxiv.org/search/?query=example"),
    /source_must_identify_one_work/,
  );
  assert.throws(
    () => canonicalSourceLocator("https://api.crossref.org/works?query=example"),
    /source_must_identify_one_work/,
  );
  assert.throws(
    () => canonicalSourceLocator("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=example"),
    /source_must_identify_one_work/,
  );
  assert.throws(
    () => canonicalSourceLocator("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=1,2"),
    /source_must_identify_one_work/,
  );
});
