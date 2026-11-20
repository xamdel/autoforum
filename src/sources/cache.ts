import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

import type { SourceMetadata } from "./metadata.ts";

const CACHE_VERSION = 2;
const CACHE_DIRECTORY = path.resolve(".autoforum", "cache", "sources");
const MAX_CACHE_BYTES = 1024 * 1024 * 1024;
const MAX_IDLE_MS = 7 * 24 * 60 * 60 * 1_000;
const CLEANUP_INTERVAL_MS = 60 * 1_000;

export type CachedSourceDocument = {
  version: typeof CACHE_VERSION;
  url: string;
  finalUrl: string;
  contentType: string;
  title: string | null;
  metadata: SourceMetadata;
  bytes: number;
  text?: string;
  pages?: string[];
};

let lastCleanup = 0;

function cachePath(url: string, directory = CACHE_DIRECTORY): string {
  const key = createHash("sha256").update(url).digest("hex");
  return path.join(directory, `${key}.json`);
}

function validDocument(value: unknown, url: string): value is CachedSourceDocument {
  if (!value || typeof value !== "object") return false;
  const document = value as Partial<CachedSourceDocument>;
  return document.version === CACHE_VERSION
    && document.url === url
    && typeof document.finalUrl === "string"
    && typeof document.contentType === "string"
    && (document.title === null || typeof document.title === "string")
    && typeof document.metadata === "object" && document.metadata !== null
    && (document.metadata.title === null || typeof document.metadata.title === "string")
    && Array.isArray(document.metadata.authors) && document.metadata.authors.every((author) => typeof author === "string")
    && (document.metadata.publishedYear === null || typeof document.metadata.publishedYear === "number")
    && (document.metadata.containerTitle === null || typeof document.metadata.containerTitle === "string")
    && (document.metadata.publisher === null || typeof document.metadata.publisher === "string")
    && (document.metadata.sourceType === null || typeof document.metadata.sourceType === "string")
    && (document.metadata.identifier === null || typeof document.metadata.identifier === "string")
    && typeof document.bytes === "number"
    && ((typeof document.text === "string" && document.pages === undefined)
      || (Array.isArray(document.pages) && document.pages.every((page) => typeof page === "string") && document.text === undefined));
}

/** Returns one recently-read source and touches it for least-recently-used eviction. */
export async function readSourceCache(url: string, directory = CACHE_DIRECTORY): Promise<CachedSourceDocument | null> {
  const target = cachePath(url, directory);
  try {
    const metadata = await stat(target);
    if (!metadata.isFile() || Date.now() - metadata.mtimeMs > MAX_IDLE_MS) {
      await rm(target, { force: true });
      return null;
    }
    const parsed: unknown = JSON.parse(await readFile(target, "utf8"));
    if (!validDocument(parsed, url)) {
      await rm(target, { force: true });
      return null;
    }
    const now = new Date();
    await utimes(target, now, now).catch(() => undefined);
    return parsed;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
    if (error instanceof SyntaxError) {
      await rm(target, { force: true }).catch(() => undefined);
      return null;
    }
    throw error;
  }
}

async function cleanSourceCache(directory: string): Promise<void> {
  const now = Date.now();
  const entries = await readdir(directory, { withFileTypes: true });
  const files: Array<{ path: string; bytes: number; usedAt: number }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^[0-9a-f]{64}\.json$/.test(entry.name)) continue;
    const target = path.join(directory, entry.name);
    const metadata = await stat(target).catch(() => null);
    if (!metadata) continue;
    if (now - metadata.mtimeMs > MAX_IDLE_MS) {
      await rm(target, { force: true });
      continue;
    }
    files.push({ path: target, bytes: metadata.size, usedAt: metadata.mtimeMs });
  }
  let total = files.reduce((sum, file) => sum + file.bytes, 0);
  for (const file of files.sort((left, right) => left.usedAt - right.usedAt)) {
    if (total <= MAX_CACHE_BYTES) break;
    await rm(file.path, { force: true });
    total -= file.bytes;
  }
}

/** Atomically stores extracted source text. Cleanup is lazy; no cache process runs in the background. */
export async function writeSourceCache(document: CachedSourceDocument, directory = CACHE_DIRECTORY): Promise<void> {
  await mkdir(directory, { recursive: true });
  const target = cachePath(document.url, directory);
  const temporary = path.join(directory, `.${path.basename(target)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(document), { flag: "wx" });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  if (Date.now() - lastCleanup >= CLEANUP_INTERVAL_MS) {
    lastCleanup = Date.now();
    await cleanSourceCache(directory);
  }
}
