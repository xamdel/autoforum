export interface SourceMetadata {
  title: string | null;
  authors: string[];
  publishedYear: number | null;
  containerTitle: string | null;
  publisher: string | null;
  sourceType: string | null;
  identifier: string | null;
}

export const emptySourceMetadata = (): SourceMetadata => ({
  title: null,
  authors: [],
  publishedYear: null,
  containerTitle: null,
  publisher: null,
  sourceType: null,
  identifier: null,
});

function clean(value: unknown, limit = 500): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, limit) : null;
}

function decodeHtml(value: string): string {
  const decodeCodePoint = (match: string, digits: string, radix: number) => {
    const point = Number.parseInt(digits, radix);
    return Number.isInteger(point) && point >= 0 && point <= 0x10ffff
      ? String.fromCodePoint(point)
      : match;
  };
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (match, digits: string) => decodeCodePoint(match, digits, 10))
    .replace(/&#x([0-9a-f]+);/gi, (match, digits: string) => decodeCodePoint(match, digits, 16));
}

function yearOf(value: unknown): number | null {
  const text = typeof value === "number" ? String(value) : clean(value, 100);
  const match = text?.match(/(?:^|\D)((?:1[5-9]|20|21)\d{2})(?:\D|$)/);
  return match ? Number(match[1]) : null;
}

function namesOf(value: unknown): string[] {
  const values = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  const names: string[] = [];
  for (const item of values) {
    const name = clean(typeof item === "object" && item !== null ? (item as Record<string, unknown>).name : item);
    if (name && !names.includes(name)) names.push(name);
  }
  return names.slice(0, 100);
}

function attributes(tag: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of tag.matchAll(/([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    const value = decodeHtml(match[2] ?? match[3] ?? match[4] ?? "");
    found.set(match[1]!.toLowerCase(), value);
  }
  return found;
}

function first(values: Map<string, string[]>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = clean(values.get(key)?.[0]);
    if (value) return value;
  }
  return null;
}

function jsonLdRecords(raw: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  for (const match of raw.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed: unknown = JSON.parse(decodeHtml(match[1]!.trim()));
      const visit = (value: unknown) => {
        if (Array.isArray(value)) return value.forEach(visit);
        if (!value || typeof value !== "object") return;
        const record = value as Record<string, unknown>;
        if (Array.isArray(record["@graph"])) return visit(record["@graph"]);
        records.push(record);
      };
      visit(parsed);
    } catch {
      // Broken JSON-LD should not prevent the ordinary HTML metadata from being used.
    }
  }
  return records;
}

function typeName(value: unknown): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const type = clean(raw, 100)?.replace(/^https?:\/\/schema\.org\//i, "").toLowerCase();
  if (!type) return null;
  if (type.includes("scholarlyarticle")) return "article";
  if (type.includes("article")) return "article";
  if (type.includes("dataset")) return "dataset";
  if (type.includes("software")) return "software";
  if (type.includes("book")) return "book";
  if (type.includes("report")) return "report";
  if (type.includes("webpage")) return "webpage";
  return type.slice(0, 100);
}

function named(value: unknown): string | null {
  if (typeof value === "string") return clean(value);
  if (!value || typeof value !== "object") return null;
  return clean((value as Record<string, unknown>).name);
}

/** Extracts a small citation-oriented subset from ordinary HTML without interpreting its active content. */
export function metadataFromHtml(raw: string, fallbackTitle: string | null = null): SourceMetadata {
  const meta = new Map<string, string[]>();
  for (const match of raw.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = attributes(match[0]);
    const key = clean(attrs.get("name") ?? attrs.get("property"), 100)?.toLowerCase();
    const value = clean(attrs.get("content"));
    if (key && value) meta.set(key, [...(meta.get(key) ?? []), value]);
  }
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1];
  const records = jsonLdRecords(raw);
  const preferred = records.find((record) => typeName(record["@type"]) && typeName(record["@type"]) !== "website") ?? records[0];
  const doi = first(meta, "citation_doi", "dc.identifier", "dc.identifier.doi")
    ?? clean(preferred?.doi ?? preferred?.identifier, 300);
  const title = first(meta, "citation_title", "dc.title", "og:title", "twitter:title")
    ?? clean(preferred?.headline ?? preferred?.name)
    ?? clean(titleTag ? decodeHtml(titleTag.replace(/<[^>]+>/g, " ")) : null)
    ?? fallbackTitle;
  const authors = namesOf(meta.get("citation_author")?.length ? meta.get("citation_author") : preferred?.author);
  const publishedYear = yearOf(first(meta, "citation_publication_date", "citation_date", "article:published_time", "dc.date", "date")
    ?? preferred?.datePublished);
  const isPartOf = preferred?.isPartOf;
  const containerTitle = first(meta, "citation_journal_title", "citation_conference_title", "og:site_name") ?? named(isPartOf);
  const publisher = first(meta, "citation_publisher", "dc.publisher") ?? named(preferred?.publisher);
  const sourceType = typeName(preferred?.["@type"]) ?? (meta.has("citation_title") ? "article" : "webpage");
  return { title, authors, publishedYear, containerTitle, publisher, sourceType, identifier: doi };
}

/** Known query endpoints are not sources; known item endpoints become durable reader-facing locators. */
export function canonicalSourceLocator(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error("source_protocol_not_allowed");
  const host = url.hostname.toLowerCase();
  if (host === "arxiv.org" || host === "www.arxiv.org") {
    const item = /^\/(?:abs|html|pdf)\/(.+?)(?:\.pdf)?$/.exec(url.pathname)?.[1];
    if (!item || !/^(?:\d{4}\.\d{4,5}|[a-z][a-z0-9.-]*\/\d{7})(?:v\d+)?$/i.test(item)) {
      throw new Error("source_must_identify_one_work");
    }
    return `https://arxiv.org/abs/${item}`;
  }
  if (host === "api.crossref.org") {
    const item = /^\/works\/(.+)$/.exec(url.pathname);
    if (!item) throw new Error("source_must_identify_one_work");
    return `https://doi.org/${decodeURIComponent(item[1])}`;
  }
  if (host === "eutils.ncbi.nlm.nih.gov") {
    const ids = (url.searchParams.get("id") ?? "").split(",").map((id) => id.trim()).filter(Boolean);
    if (url.searchParams.get("db")?.toLowerCase() !== "pubmed" || ids.length !== 1 || !/^\d+$/.test(ids[0]!)) {
      throw new Error("source_must_identify_one_work");
    }
    return `https://pubmed.ncbi.nlm.nih.gov/${ids[0]}/`;
  }
  if (host === "api.openalex.org") {
    const item = decodeURIComponent(url.pathname.replace(/^\/works\//, ""));
    if (/^https?:\/\/doi\.org\/10\./i.test(item)) return item.replace(/^http:/i, "https:");
    if (!item || item === url.pathname) throw new Error("source_must_identify_one_work");
  }
  return url.href;
}

export function fallbackSourceTitle(locator: string): string {
  const url = new URL(locator);
  const last = url.pathname.split("/").filter(Boolean).at(-1);
  let leaf = "";
  try { leaf = last ? decodeURIComponent(last) : ""; } catch { leaf = last ?? ""; }
  return (leaf || url.hostname).replace(/[-_]+/g, " ").slice(0, 500);
}
