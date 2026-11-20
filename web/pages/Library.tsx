// The project's sources: searchable and filterable locally, with small usage stats. Adding a source accepts either a
// public URL or a bounded PDF/UTF-8 text upload and takes the reader straight to the resulting source page.

import { useMemo, useRef, useState, type FormEvent } from "react";

import { api, type Source } from "../lib/api.ts";
import { plural } from "../lib/format.ts";
import { invalidate } from "../lib/query.ts";
import { link, navigate, path } from "../lib/router.ts";
import { sourceDetails } from "../lib/sources.ts";
import { AddressChip, Empty, Failure, flashFailure, icons, KindIcon, Loading, Modal, Time } from "../components/ui.tsx";
import { useProject } from "../state/project.tsx";
import { keys, useSources } from "../state/queries.ts";

function AddSource({ onClose }: { onClose(): void }) {
  const { projectId } = useProject();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<"link" | "file" | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const finish = (result: { source: Source }) => {
    invalidate(keys.sources(projectId));
    navigate(path(projectId, "library", result.source.id));
  };
  const addLink = (event: FormEvent) => {
    event.preventDefault();
    setBusy("link");
    api<{ source: Source }>(`/projects/${projectId}/sources`, { method: "POST", json: { url: url.trim() } })
      .then(finish, flashFailure).finally(() => setBusy(null));
  };
  const upload = (file: File | undefined) => {
    if (!file) return;
    setBusy("file");
    api<{ source: Source }>(`/projects/${projectId}/sources/upload?filename=${encodeURIComponent(file.name)}`, {
      method: "POST",
      body: file,
      headers: { "content-type": file.type || "application/octet-stream" },
    }).then(finish, flashFailure).finally(() => {
      setBusy(null);
      if (fileInput.current) fileInput.current.value = "";
    });
  };
  return (
    <Modal title="Add a source" onClose={onClose}>
      <form className="form add-source" onSubmit={addLink}>
        <label>
          Public link
          <div className="row">
            <input type="url" value={url} onChange={(event) => setUrl(event.target.value)} required maxLength={2_000} placeholder="https://…" autoFocus />
            <button className="primary" type="submit" disabled={Boolean(busy) || !url.trim()}>{busy === "link" ? "Adding…" : "Add link"}</button>
          </div>
        </label>
        <div className="source-or"><span>or</span></div>
        <input
          ref={fileInput}
          className="visually-hidden"
          type="file"
          accept=".pdf,.txt,.md,.csv,.json,.html,.htm,application/pdf,text/*"
          onChange={(event) => upload(event.target.files?.[0])}
        />
        <button type="button" className="upload-source" disabled={Boolean(busy)} onClick={() => fileInput.current?.click()}>
          {icons.file} {busy === "file" ? "Uploading…" : "Upload a PDF or text file"}
        </button>
        <p className="muted small">PDFs are limited to 20 MB; UTF-8 text files to 2 MB. Files are stored privately and shown only as extracted text.</p>
        <p className="muted small">Each source should be one work or document, not a search page or results list.</p>
      </form>
    </Modal>
  );
}

function sourceMatches(source: Source, query: string): boolean {
  if (!query) return true;
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const haystack = [
    source.title,
    source.locator,
    ...source.authors,
    source.publishedYear,
    source.containerTitle,
    source.publisher,
    source.sourceType,
    source.identifier,
    ...source.tags,
  ].filter(Boolean).join(" ").toLocaleLowerCase();
  return words.every((word) => haystack.includes(word));
}

export default function Library() {
  const { projectId } = useProject();
  const sources = useSources(projectId);
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState("");
  const [tag, setTag] = useState<string | null>(null);
  const list = sources.data ?? [];
  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const source of list) for (const sourceTag of source.tags) counts.set(sourceTag, (counts.get(sourceTag) ?? 0) + 1);
    return [...counts].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  }, [list]);
  const shown = useMemo(() => list.filter((source) => (!tag || source.tags.includes(tag)) && sourceMatches(source, search.trim())), [list, search, tag]);
  const excerpts = list.reduce((sum, source) => sum + source.excerptCount, 0);
  const discussions = list.reduce((sum, source) => sum + source.discussionCount, 0);
  return (
    <div className="library">
      <div className="head-row">
        <div>
          <div className="crumbs">Library</div>
          <h1>Sources</h1>
        </div>
        <span className="head-tools">
          <button type="button" className="library-add primary" title="Add a source" aria-label="Add a source" onClick={() => setAdding(true)}>{icons.plus}</button>
        </span>
      </div>
      {adding ? <AddSource onClose={() => setAdding(false)} /> : null}
      {sources.error && !sources.data ? <Failure error={sources.error} />
        : !sources.data ? <Loading />
          : list.length ? (
            <>
              <div className="library-tools">
                <label className="library-search">{icons.search}<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search this library" /></label>
                <div className="library-stats muted small">
                  <span><b>{list.length}</b> sources</span>
                  <span><b>{excerpts}</b> excerpts</span>
                  <span><b>{discussions}</b> thread references</span>
                </div>
              </div>
              {tagCounts.length ? (
                <div className="chips library-tags" aria-label="Filter sources by tag">
                  {tagCounts.map(([name, count]) => (
                    <button type="button" className={`chip ${tag === name ? "on" : ""}`} key={name} aria-pressed={tag === name} onClick={() => setTag(tag === name ? null : name)}>
                      {name} <span className="chip-count">{count}</span>
                    </button>
                  ))}
                </div>
              ) : null}
              {shown.length ? (
                <div className="source-list">
                  {shown.map((source) => (
                    <article className="source-card" key={source.id}>
                      <a className="source-title" href={link(projectId, "library", source.id)}><KindIcon kind="source" /> {source.title}</a>
                      <div className="muted small">{sourceDetails(source)}</div>
                      {source.tags.length ? <div className="source-tags">{source.tags.map((name) => <span className="chip" key={name}>{name}</span>)}</div> : null}
                      <div className="source-foot small">
                        <span className="muted">added by @{source.addedBy} <Time at={source.createdAt} /> · {plural(source.excerptCount, "excerpt")} · {plural(source.discussionCount, "thread")}</span>
                        <AddressChip address={source.address} />
                      </div>
                    </article>
                  ))}
                </div>
              ) : <Empty>No sources match this search.</Empty>}
            </>
          ) : <Empty>The Library is empty. Add the first source.</Empty>}
    </div>
  );
}
