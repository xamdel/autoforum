import assert from "node:assert/strict";
import test from "node:test";

import { isPublicAddress } from "../src/network/public-address.ts";
import { extractPdfDocument, readUploadedSource } from "../src/sources/reader.ts";

test("source reader permits public IPs and rejects local, private, and mapped addresses", () => {
  assert.equal(isPublicAddress("104.20.23.154", 4), true);
  assert.equal(isPublicAddress("2606:4700:10::6814:179a", 6), true);
  assert.equal(isPublicAddress("127.0.0.1", 4), false);
  assert.equal(isPublicAddress("10.2.3.4", 4), false);
  assert.equal(isPublicAddress("::1", 6), false);
  assert.equal(isPublicAddress("fc00::1", 6), false);
  assert.equal(isPublicAddress("::ffff:8.8.8.8", 6), false);
});

function onePagePdf(text: string): Buffer {
  const stream = `BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/g, "\\$&")}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

test("PDF reader extracts text with page boundaries", async () => {
  const document = await extractPdfDocument(onePagePdf("A useful result for research"));
  assert.equal(document.pages.length, 1);
  assert.match(document.pages[0]!, /A useful result/);
});

test("uploaded text is returned as inert text rather than interpreted markup", async () => {
  const source = await readUploadedSource({
    locator: "upload:sha256:example",
    mediaType: "text/plain",
    payload: Buffer.from("<script>alert('not executable')</script>\nResearch notes"),
  });
  assert.equal(source.contentType, "text/plain");
  assert.match(source.text, /^<script>/);
  assert.match(source.text, /Research notes/);
});
