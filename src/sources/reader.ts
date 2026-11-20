import { lookup } from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";

import { Hono } from "hono";

import { hasExactBrowserOrigin, readBrowserUser } from "../auth/browser.ts";
import type { AppDatabase } from "../db.ts";
import { parseAddress } from "../forum/addresses.ts";
import { isPublicAddress } from "../network/public-address.ts";
import { isProjectMember } from "../projects.ts";
import { readSourceCache, writeSourceCache, type CachedSourceDocument } from "./cache.ts";
import { emptySourceMetadata, metadataFromHtml } from "./metadata.ts";

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_PDF_PAGES = 300;
const MAX_EXTRACTED_CHARACTERS = 2_000_000;
const MAX_REDIRECTS = 4;
function positiveId(value: string): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function publicAddresses(hostname: string) {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length) throw new Error("source_host_not_found");
  for (const address of addresses) {
    const family = address.family === 4 ? 4 : 6;
    if (!isPublicAddress(address.address, family)) throw new Error("source_private_address");
  }
  return addresses;
}

function htmlToText(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function htmlTitle(value: string): string | null {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(value);
  if (!match?.[1]) return null;
  const title = htmlToText(match[1]).trim();
  return title ? title.slice(0, 500) : null;
}

export async function extractPdfDocument(bytes: Buffer): Promise<{ title: string | null; authors: string[]; pages: string[] }> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: true,
    useWasm: false,
    verbosity: 0,
  });
  try {
    const document = await task.promise;
    if (document.numPages > MAX_PDF_PAGES) throw new Error("source_pdf_page_limit");
    const metadata = await document.getMetadata().catch(() => null);
    const rawTitle = metadata?.info && "Title" in metadata.info ? metadata.info.Title : null;
    const title = typeof rawTitle === "string" && rawTitle.trim() ? rawTitle.trim().slice(0, 500) : null;
    const rawAuthor = metadata?.info && "Author" in metadata.info ? metadata.info.Author : null;
    const authors = typeof rawAuthor === "string" && rawAuthor.trim() ? [rawAuthor.trim().slice(0, 500)] : [];
    const pages: string[] = [];
    let characters = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      let text = "";
      for (const item of content.items) {
        if (!("str" in item)) continue;
        text += item.str;
        text += item.hasEOL ? "\n" : " ";
      }
      text = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
      characters += text.length;
      if (characters > MAX_EXTRACTED_CHARACTERS) throw new Error("source_extracted_text_too_large");
      pages.push(text);
    }
    if (pages.reduce((sum, page) => sum + page.length, 0) < 5) throw new Error("source_pdf_text_unavailable");
    return { title, authors, pages };
  } finally {
    await task.destroy().catch(() => undefined);
  }
}

async function fetchOnce(url: URL): Promise<{ status: number; location?: string; contentType: string; bytes: Buffer }> {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("source_protocol_not_allowed");
  if (url.username || url.password) throw new Error("source_credentials_not_allowed");
  const addresses = await publicAddresses(url.hostname);
  const address = addresses[0];
  if (!address) throw new Error("source_host_not_found");
  const transport = url.protocol === "https:" ? https : http;

  return await new Promise((resolve, reject) => {
    const request = transport.request({
      protocol: url.protocol,
      hostname: address.address,
      family: address.family,
      port: url.port || undefined,
      method: "GET",
      path: `${url.pathname}${url.search}`,
      servername: url.hostname,
      headers: {
        host: url.host,
        accept: "text/plain, text/html, application/pdf, application/json, application/xml;q=0.8",
        "accept-encoding": "identity",
        "user-agent": "Autoforum/1 source reader",
      },
    }, (response) => {
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      const contentType = String(response.headers["content-type"] ?? "application/octet-stream").split(";", 1)[0].trim().toLowerCase();
      const encoding = response.headers["content-encoding"];
      const declaredLength = Number(response.headers["content-length"] ?? 0);
      if (encoding && encoding !== "identity") {
        response.resume();
        reject(new Error("source_encoding_not_allowed"));
        return;
      }
      const maxBytes = contentType === "application/pdf" ? MAX_PDF_BYTES : MAX_TEXT_BYTES;
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        response.resume();
        reject(new Error("source_too_large"));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          request.destroy(new Error("source_too_large"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({ status, ...(location ? { location } : {}), contentType, bytes: Buffer.concat(chunks) }));
      response.on("error", reject);
    });
    request.setTimeout(20_000, () => request.destroy(new Error("source_timeout")));
    request.on("error", reject);
    request.end();
  });
}

export interface SourceReadOptions {
  page?: number;
}

interface StoredSource {
  locator: string;
  payload: Buffer | null;
  mediaType: string | null;
}

function readableDocument(document: CachedSourceDocument, options: SourceReadOptions, cached: boolean) {
  if (document.pages) {
    if (options.page !== undefined && (!Number.isSafeInteger(options.page) || options.page < 1 || options.page > document.pages.length)) {
      throw new Error("source_page_not_found");
    }
    const selected = options.page === undefined
      ? document.pages.map((page, index) => `--- Page ${index + 1} ---\n${page}`).join("\n\n")
      : `--- Page ${options.page} ---\n${document.pages[options.page - 1]}`;
    return { ...document, pages: undefined, text: selected, pageCount: document.pages.length, cached };
  }
  if (options.page !== undefined) throw new Error("source_has_no_pages");
  return { ...document, text: document.text ?? "", pageCount: null, cached };
}

export async function readRemoteSource(initial: string, options: SourceReadOptions = {}) {
  let url: URL;
  try {
    url = new URL(initial);
  } catch {
    throw new Error("source_locator_is_not_a_url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("source_protocol_not_allowed");
  if (url.username || url.password) throw new Error("source_credentials_not_allowed");
  const cached = await readSourceCache(url.href);
  if (cached) return readableDocument(cached, options, true);

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await fetchOnce(url);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (!response.location || redirects === MAX_REDIRECTS) throw new Error("source_redirect_limit");
      url = new URL(response.location, url);
      continue;
    }
    if (response.status < 200 || response.status >= 300) throw new Error(`source_http_${response.status}`);
    const allowed = response.contentType === "application/pdf"
      || response.contentType.startsWith("text/")
      || response.contentType === "application/json"
      || response.contentType === "application/xml"
      || response.contentType === "application/xhtml+xml";
    if (!allowed) throw new Error("source_content_type_not_supported");
    const raw = response.contentType === "application/pdf" ? null : response.bytes.toString("utf8");
    const pdf = response.contentType === "application/pdf" ? await extractPdfDocument(response.bytes) : null;
    const metadata = raw && response.contentType.includes("html")
      ? metadataFromHtml(raw)
      : { ...emptySourceMetadata(), title: pdf?.title ?? null, authors: pdf?.authors ?? [], sourceType: pdf ? "document" : null };
    const document: CachedSourceDocument = {
      version: 2,
      url: new URL(initial).href,
      finalUrl: url.href,
      contentType: response.contentType,
      title: metadata.title ?? (raw && response.contentType.includes("html") ? htmlTitle(raw) : null),
      metadata,
      bytes: response.bytes.length,
      ...(pdf ? { pages: pdf.pages } : { text: response.contentType.includes("html") ? htmlToText(raw ?? "") : raw ?? "" }),
    };
    await writeSourceCache(document).catch((error) => console.warn("Could not cache source", error));
    return readableDocument(document, options, false);
  }
  throw new Error("source_redirect_limit");
}

/** Reads an owner-uploaded source as inert text. Uploaded bytes are never served or interpreted by a browser. */
export async function readUploadedSource(source: StoredSource, options: SourceReadOptions = {}) {
  if (!source.payload || !source.mediaType) throw new Error("source_upload_unavailable");
  let document: CachedSourceDocument;
  if (source.mediaType === "application/pdf") {
    const pdf = await extractPdfDocument(source.payload);
    document = {
      version: 2,
      url: source.locator,
      finalUrl: source.locator,
      contentType: source.mediaType,
      title: pdf.title,
      metadata: { ...emptySourceMetadata(), title: pdf.title, authors: pdf.authors, sourceType: "document" },
      bytes: source.payload.length,
      pages: pdf.pages,
    };
  } else if (source.mediaType === "text/plain") {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(source.payload);
    } catch {
      throw new Error("source_upload_not_utf8");
    }
    document = {
      version: 2,
      url: source.locator,
      finalUrl: source.locator,
      contentType: source.mediaType,
      title: null,
      metadata: { ...emptySourceMetadata(), sourceType: "document" },
      bytes: source.payload.length,
      text,
    };
  } else {
    throw new Error("source_content_type_not_supported");
  }
  return readableDocument(document, options, false);
}

async function readStoredSource(source: StoredSource, options: SourceReadOptions = {}) {
  return source.payload ? await readUploadedSource(source, options) : await readRemoteSource(source.locator, options);
}

export async function readSourceAddress(database: AppDatabase, projectId: number, address: string) {
  const parsed = parseAddress(address);
  if (!parsed || parsed.prefix !== "source" || parsed.fragment) throw new Error("invalid_source_address");
  const result = await database.pool.query<StoredSource>(
    `select locator, payload, media_type as "mediaType"
       from source where project_id = $1 and local_id = $2`,
    [projectId, parsed.localId],
  );
  const source = result.rows[0];
  if (!source) throw new Error("source_not_found");
  return await readStoredSource(source);
}

export function createSourceReaderRoutes(database: AppDatabase) {
  const routes = new Hono();

  routes.post("/projects/:projectId/sources/:sourceId/read", async (context) => {
    if (!hasExactBrowserOrigin(context)) return context.json({ error: "invalid_origin" }, 403);
    const actor = await readBrowserUser(context, database);
    if (!actor) return context.json({ error: "unauthenticated" }, 401);
    const projectId = positiveId(context.req.param("projectId"));
    const sourceId = positiveId(context.req.param("sourceId"));
    if (!projectId || !sourceId || !await isProjectMember(database, actor.id, projectId)) {
      return context.json({ error: "source_not_found" }, 404);
    }
    const result = await database.pool.query<StoredSource>(
      `select locator, payload, media_type as "mediaType"
         from source where project_id = $1 and row_id = $2`,
      [projectId, sourceId],
    );
    const source = result.rows[0];
    if (!source) return context.json({ error: "source_not_found" }, 404);
    try {
      return context.json(await readStoredSource(source));
    } catch (error) {
      const message = error instanceof Error ? error.message : "source_read_failed";
      return context.json({ error: message }, 422);
    }
  });

  return routes;
}
