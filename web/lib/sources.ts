import type { Source } from "./api.ts";

export function sourceHost(source: Source): string {
  if (source.uploaded) return "uploaded file";
  try { return new URL(source.locator).hostname.replace(/^www\./, ""); } catch { return source.locator; }
}

export function sourceAuthors(authors: readonly string[], limit = 4): string | null {
  if (!authors.length) return null;
  return authors.length > limit ? `${authors.slice(0, limit).join(", ")} et al.` : authors.join(", ");
}

/** Stable, omission-friendly citation details; absent metadata never becomes a placeholder. */
export function sourceDetails(source: Source): string {
  return [
    sourceAuthors(source.authors),
    source.publishedYear ? String(source.publishedYear) : null,
    source.containerTitle,
    source.publisher && source.publisher !== source.containerTitle ? source.publisher : null,
    sourceHost(source),
  ].filter(Boolean).join(" · ");
}
