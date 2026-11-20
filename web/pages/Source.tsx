// One source: where it is, the excerpts the forum has taken from it, what refers to it, and a reader for either a
// guarded remote fetch or a private upload. Both paths return untrusted source material only as inert text. Selecting
// a passage in the reader offers to attach it, as an excerpt, to the reply you are writing.

import { useEffect, useRef, useState, type FormEvent } from "react";

import { api, type Source, type SourceText } from "../lib/api.ts";
import { describeError } from "../lib/format.ts";
import { invalidate } from "../lib/query.ts";
import { addressLink, link, navigate, path } from "../lib/router.ts";
import { sourceDetails } from "../lib/sources.ts";
import { Markdown, plainLine } from "../components/Markdown.tsx";
import { SmartTextarea } from "../components/SmartTextarea.tsx";
import { AddressChip, copyText, Empty, Failure, flash, flashFailure, icons, KindIcon, Loading, Time } from "../components/ui.tsx";
import { attachExcerpt, recentThread } from "../state/drafts.ts";
import { useProject } from "../state/project.tsx";
import { keys, useBacklinks, useSource, useSubforums } from "../state/queries.ts";

function Reader({ sourceId, address, uploaded }: { sourceId: number; address: string; uploaded: boolean }) {
  const { projectId } = useProject();
  const [state, setState] = useState<{ text?: SourceText; error?: string; busy?: boolean }>({});
  const [selection, setSelection] = useState<{ text: string; top: number; left: number } | null>(null);
  const box = useRef<HTMLPreElement>(null);
  const thread = recentThread(projectId);

  const read = () => {
    setState({ busy: true });
    api<SourceText>(`/projects/${projectId}/sources/${sourceId}/read`, { method: "POST" }).then(
      (text) => setState({ text }),
      (error: unknown) => setState({ error: describeError(error) }),
    );
  };

  useEffect(() => {
    const changed = () => {
      const chosen = document.getSelection();
      const text = chosen?.toString().trim() ?? "";
      if (!chosen || !text || !box.current || !chosen.anchorNode || !box.current.contains(chosen.anchorNode)) return setSelection(null);
      const rect = chosen.getRangeAt(0).getBoundingClientRect();
      setSelection({ text, top: rect.top - 38, left: Math.max(8, Math.min(rect.left, window.innerWidth - 260)) });
    };
    document.addEventListener("selectionchange", changed);
    return () => document.removeEventListener("selectionchange", changed);
  }, []);

  if (!state.text) {
    return (
      <div className="reader-gate">
        <button type="button" disabled={state.busy} onClick={read}>{state.busy ? "Fetching…" : "Read this source here"}</button>
        <span className="muted small">{uploaded ? "Reads the private upload as inert text." : "Fetches its public text now and keeps only a temporary cache unless you make an excerpt."}</span>
        {state.error ? <p className="error-text small" role="alert">{state.error}</p> : null}
      </div>
    );
  }
  return (
    <>
      <p className="muted small">
        {uploaded ? "Read from the uploaded file" : <>Fetched from <code>{state.text.finalUrl}</code></>} ({state.text.contentType}){state.text.truncated ? "; the text is cut off" : ""}. Select a passage to excerpt it.
      </p>
      <pre className="page-text" ref={box}>{state.text.text}</pre>
      {selection ? (
        <div className="selection-tools" style={{ top: Math.max(8, selection.top), left: selection.left }}>
          {thread ? (
            <button
              type="button"
              className="primary small"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                attachExcerpt(projectId, thread.threadId, { source: address, content: selection.text, locator: "" });
                document.getSelection()?.removeAllRanges();
                flash(`Attached to your reply in “${plainLine(thread.title, 40)}”`, "ok");
                navigate(`${path(projectId, "t", thread.threadId)}?compose=1`);
              }}
            >
              Excerpt in my reply
            </button>
          ) : null}
          <button type="button" className="small" onMouseDown={(event) => event.preventDefault()} onClick={() => void copyText(selection.text)}>Copy</button>
        </div>
      ) : null}
    </>
  );
}

function SourceTags({ source }: { source: Source }) {
  const { projectId } = useProject();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(source.tags.join(", "));
  const [busy, setBusy] = useState(false);
  useEffect(() => setValue(source.tags.join(", ")), [source.tags]);
  const save = (event: FormEvent) => {
    event.preventDefault();
    const tags = [...new Set(value.split(",").map((tag) => tag.trim()).filter(Boolean))];
    setBusy(true);
    api(`/projects/${projectId}/sources/${source.id}`, { method: "PATCH", json: { tags } }).then(() => {
      invalidate(keys.source(projectId, source.id));
      invalidate(keys.sources(projectId));
      setEditing(false);
    }, flashFailure).finally(() => setBusy(false));
  };
  if (editing) return (
    <form className="source-tag-editor" onSubmit={save}>
      <input value={value} onChange={(event) => setValue(event.target.value)} maxLength={800} placeholder="methods, 3D, evaluation" autoFocus />
      <button type="submit" className="small primary" disabled={busy}>Save</button>
      <button type="button" className="small link" onClick={() => setEditing(false)}>Cancel</button>
    </form>
  );
  return (
    <div className="source-tags editable">
      {source.tags.map((tag) => <span className="chip" key={tag}>{tag}</span>)}
      <button type="button" className="icon-button tiny" title="Edit source tags" aria-label="Edit source tags" onClick={() => setEditing(true)}>{icons.pencil}</button>
    </div>
  );
}

function SourceMetadataEditor({ source }: { source: Source }) {
  const { projectId } = useProject();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState(source.title);
  const [authors, setAuthors] = useState(source.authors.join("\n"));
  const [year, setYear] = useState(source.publishedYear ? String(source.publishedYear) : "");
  const [container, setContainer] = useState(source.containerTitle ?? "");
  const [publisher, setPublisher] = useState(source.publisher ?? "");
  const [type, setType] = useState(source.sourceType ?? "");
  const [identifier, setIdentifier] = useState(source.identifier ?? "");
  useEffect(() => {
    setTitle(source.title);
    setAuthors(source.authors.join("\n"));
    setYear(source.publishedYear ? String(source.publishedYear) : "");
    setContainer(source.containerTitle ?? "");
    setPublisher(source.publisher ?? "");
    setType(source.sourceType ?? "");
    setIdentifier(source.identifier ?? "");
  }, [source]);
  const save = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    api(`/projects/${projectId}/sources/${source.id}`, {
      method: "PATCH",
      json: {
        title: title.trim(),
        authors: authors.split("\n").map((author) => author.trim()).filter(Boolean),
        publishedYear: year.trim() ? Number(year) : null,
        containerTitle: container.trim() || null,
        publisher: publisher.trim() || null,
        sourceType: type.trim() || null,
        identifier: identifier.trim() || null,
      },
    }).then(() => {
      invalidate(keys.source(projectId, source.id));
      invalidate(keys.sources(projectId));
      setEditing(false);
    }, flashFailure).finally(() => setBusy(false));
  };
  if (!editing) return <button type="button" className="link small" onClick={() => setEditing(true)}>{icons.pencil} Edit reference details</button>;
  return (
    <form className="card form source-metadata-editor" onSubmit={save}>
      <label>Title <input value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={500} /></label>
      <label>Authors <textarea value={authors} onChange={(event) => setAuthors(event.target.value)} rows={4} placeholder="One author per line" /></label>
      <div className="row">
        <label>Publication year <input type="number" min="1500" max="2200" value={year} onChange={(event) => setYear(event.target.value)} /></label>
        <label>Type <input value={type} onChange={(event) => setType(event.target.value)} maxLength={100} placeholder="article, webpage, software…" /></label>
      </div>
      <label>Journal, site, or collection <input value={container} onChange={(event) => setContainer(event.target.value)} maxLength={500} /></label>
      <label>Publisher <input value={publisher} onChange={(event) => setPublisher(event.target.value)} maxLength={500} /></label>
      <label>DOI or other identifier <input value={identifier} onChange={(event) => setIdentifier(event.target.value)} maxLength={500} /></label>
      <div className="row">
        <button type="submit" className="primary small" disabled={busy || !title.trim()}>{busy ? "Saving…" : "Save details"}</button>
        <button type="button" className="link small" onClick={() => setEditing(false)}>Cancel</button>
      </div>
    </form>
  );
}

function DiscussSource({ source }: { source: Source }) {
  const { projectId, members, isOwner } = useProject();
  const subforums = useSubforums(projectId);
  const [body, setBody] = useState("");
  const [subforumId, setSubforumId] = useState(0);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const choices = subforums.data ?? [];
  const selectedSubforum = choices.some((subforum) => subforum.id === subforumId) ? subforumId : choices[0]?.id ?? 0;
  const agents = members.filter((member) => member.kind === "agent");
  const mention = (handle: string) => {
    const start = input.current?.selectionStart ?? body.length;
    const end = input.current?.selectionEnd ?? start;
    const before = body.slice(0, start);
    const prefix = before && !/[\s(]$/.test(before) ? " " : "";
    const insertion = `${prefix}@${handle} `;
    setBody(before + insertion + body.slice(end));
    requestAnimationFrame(() => {
      const caret = start + insertion.length;
      input.current?.focus();
      input.current?.setSelectionRange(caret, caret);
    });
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!selectedSubforum) return;
    setBusy(true);
    api<{ thread: { id: number } }>(`/projects/${projectId}/threads`, {
      method: "POST",
      json: {
        subforumId: selectedSubforum,
        title: `Discussion: ${source.title}`.slice(0, 240),
        body: `${body.trim()}\n\nSource: [[${source.address}]]`,
        tags: source.tags,
      },
    }).then((result) => {
      invalidate(keys.threads(projectId));
      invalidate(keys.turns(projectId));
      invalidate(keys.projects);
      invalidate(keys.source(projectId, source.id));
      navigate(path(projectId, "t", result.thread.id));
    }, flashFailure).finally(() => setBusy(false));
  };
  return (
    <form className="card form source-discussion" onSubmit={submit}>
      <label>
        Discuss this source
        <SmartTextarea textareaRef={input} rows={5} value={body} onValue={setBody} required maxLength={99_000} placeholder="Ask a question, note something important, or @mention an agent to examine it…" />
      </label>
      {agents.length ? (
        <div className="agent-invites muted small">
          <span>{isOwner ? "Mention an agent to invite it:" : "Agents in this project:"}</span>
          {agents.map((agent) => <button type="button" className="link mention-link" key={agent.id} onClick={() => mention(agent.handle)}>@{agent.handle}</button>)}
        </div>
      ) : null}
      <div className="row">
        {choices.length > 1 ? (
          <label className="source-subforum">In <select value={selectedSubforum} onChange={(event) => setSubforumId(Number(event.target.value))}>{choices.map((subforum) => <option key={subforum.id} value={subforum.id}>{subforum.name}</option>)}</select></label>
        ) : null}
        <button type="submit" className="primary" disabled={busy || !body.trim() || !selectedSubforum}>{busy ? "Starting…" : "Start discussion"}</button>
        <span className="muted small">Creates a forum thread linked to {source.address}.</span>
      </div>
    </form>
  );
}

export default function SourcePage({ sourceId }: { sourceId: number }) {
  const { projectId } = useProject();
  const query = useSource(projectId, sourceId);
  const address = query.data?.source.address ?? null;
  const backlinks = useBacklinks(projectId, address);
  if (query.error && !query.data) return <Failure error={query.error} />;
  if (!query.data) return <Loading />;
  const { source, excerpts } = query.data;
  const url = !source.uploaded && /^https?:\/\//i.test(source.locator);
  return (
    <div className="source-page">
      <div className="crumbs"><a href={link(projectId, "library")}>Library</a> › {source.address}</div>
      <div className="layout">
        <section>
          <h1>{source.title}</h1>
          <p className="muted">{sourceDetails(source)}</p>
          <SourceMetadataEditor source={source} />
          <p className="small">
            {url ? <a href={source.locator} target="_blank" rel="noopener noreferrer">{source.locator}</a> : source.uploaded ? "Uploaded file" : source.locator}
            <span className="muted"> · added by @{source.addedBy} <Time at={source.createdAt} /></span>
          </p>
          <SourceTags source={source} />
          <DiscussSource source={source} />

          <h3>Excerpts</h3>
          {excerpts.length ? excerpts.map((excerpt) => (
            <figure className="record record-excerpt" key={excerpt.address}>
              <blockquote><Markdown text={excerpt.content} /></blockquote>
              <figcaption className="record-head">
                <KindIcon kind="excerpt" />
                <a href={addressLink(projectId, excerpt.address)}>where it was introduced</a>
                {excerpt.locator ? <span className="muted small">{excerpt.locator}</span> : null}
                <span className="muted small"><Time at={excerpt.createdAt} /></span>
                <AddressChip address={excerpt.address} />
              </figcaption>
            </figure>
          )) : <Empty>No excerpts yet. Quote from this source by attaching an excerpt to a post.</Empty>}

          {url || source.uploaded ? (
            <>
              <h3>Read</h3>
              <Reader sourceId={sourceId} address={source.address} uploaded={source.uploaded} />
            </>
          ) : null}
        </section>
        <aside>
          <h3>Cite</h3>
          <p className="small">Write <AddressChip address={source.address} /> in a post, or attach an excerpt from it.</p>
          <h3>Discussed in</h3>
          {backlinks.data?.length ? (
            <ul className="links">
              {backlinks.data.map((backlink) => (
                <li key={backlink.address}>
                  <a href={addressLink(projectId, backlink.address)}><KindIcon kind={backlink.kind} /> {backlink.author ? `@${backlink.author}: ` : ""}{plainLine(backlink.label || backlink.body, 70) || backlink.address}</a>
                </li>
              ))}
            </ul>
          ) : <p className="muted small">Not referenced yet.</p>}
        </aside>
      </div>
    </div>
  );
}
