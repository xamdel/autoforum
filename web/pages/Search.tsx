// Full-text search across the project (?q=): thread titles, posts, discourse objects, sources, excerpts, results.

import type { ReactNode } from "react";

import { plural } from "../lib/format.ts";
import { addressLink, useRoute } from "../lib/router.ts";
import { plainLine } from "../components/Markdown.tsx";
import { Empty, Failure, KindIcon, Loading, Time } from "../components/ui.tsx";
import { useProject } from "../state/project.tsx";
import { useSearch } from "../state/queries.ts";

/** The text with the query's words marked. Matching is the server's (stemmed); this only shows where to look. */
function marked(text: string, words: string[]): ReactNode {
  if (!words.length) return text;
  const pattern = new RegExp(`(${words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return text.split(pattern).map((part, index) => (index % 2 ? <mark key={index}>{part}</mark> : part));
}

export function SearchPage() {
  const { projectId } = useProject();
  const query = (useRoute().query.get("q") ?? "").trim();
  const results = useSearch(projectId, query);
  const words = query.split(/\s+/).filter((word) => word.length > 2);
  return (
    <div className="search-page">
      <div className="crumbs">Forum › search</div>
      <h1>{query ? `“${query}”` : "Search"}</h1>
      {!query ? <p className="muted">Type in the search box above to search this project's threads, posts, records, sources, and results.</p>
        : results.error && !results.data ? <Failure error={results.error} />
          : !results.data ? <Loading label="Searching…" />
            : results.data.length ? (
              <>
                <p className="muted small">{plural(results.data.length, "result")}{results.data.length >= 50 ? " (the 50 most recent)" : ""}</p>
                <ul className="hits">
                  {results.data.map((hit) => (
                    <li key={hit.address}>
                      <a href={addressLink(projectId, hit.address)} className="hit-title">
                        <KindIcon kind={hit.kind} />
                        <strong>{marked(plainLine(hit.heading, 140) || hit.address, words)}</strong>
                      </a>
                      <span className="muted small"> {hit.kind} · {hit.address} · <Time at={hit.createdAt} /></span>
                      {hit.snippet ? <div className="snippet">{marked(plainLine(hit.snippet, 320), words)}</div> : null}
                    </li>
                  ))}
                </ul>
              </>
            ) : <Empty>Nothing in this project matches “{query}”.</Empty>}
    </div>
  );
}
