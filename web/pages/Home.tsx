// The forum's front page: the project's threads as a classic board (pinned first, then by latest post). Subforums are
// vertically stacked sections. Tags are chips, and any number can be on at once: ?tag=a&tag=b shows matching threads.
// ?new=1 opens the new-thread form, whose draft is kept until posted.

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { api, type Subforum, type ThreadSummary } from "../lib/api.ts";
import { plural } from "../lib/format.ts";
import { invalidate } from "../lib/query.ts";
import { link, navigate, path, useRoute } from "../lib/router.ts";
import { Markdown } from "../components/Markdown.tsx";
import { SmartTextarea } from "../components/SmartTextarea.tsx";
import { Avatar, Failure, flashFailure, icons, Loading, Popover, Time, Who } from "../components/ui.tsx";
import { emptyThread, useThreadDraft } from "../state/drafts.ts";
import { useProject } from "../state/project.tsx";
import { keys, useSubforums, useThreads } from "../state/queries.ts";

export const tagsFrom = (text: string) => [...new Set(text.split(",").map((tag) => tag.trim()).filter(Boolean))];

/** How many tag chips show before "+N more". */
const TAG_LIMIT = 10;
/** How many members show their faces before "+N". */
const FACES = 5;

/** Tag names, most used first. */
function tagsOf(threads: ThreadSummary[]): string[] {
  const counts = new Map<string, number>();
  for (const thread of threads) for (const tag of thread.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => name);
}

/**
 * A thread's tags as chips: the ones chosen, the project's most used to switch on, and a box for a new one. What is
 * in the box (`text`) belongs to the form, which counts it as a tag when it is submitted: leaving the box does not
 * turn it into a chip, because that would move the button being reached for.
 */
function TagPicker({ value, known, text, onText, onChange }: {
  value: string[]; known: string[]; text: string; onText(next: string): void; onChange(next: string[]): void;
}) {
  const add = (raw: string) => {
    const added = tagsFrom(raw);
    onText("");
    if (added.length) onChange([...new Set([...value, ...added])]);
  };
  const offered = known.filter((tag) => !value.includes(tag)).slice(0, TAG_LIMIT);
  return (
    <div className="field">
      <span className="field-label">Tags <span className="hint">any number · Enter or a comma adds the one you typed</span></span>
      <div className="chips" role="group" aria-label="Tags">
        {value.map((tag) => (
          <button type="button" key={tag} className="chip on" aria-pressed="true" title={`Remove the tag ${tag}`} onClick={() => onChange(value.filter((each) => each !== tag))}>
            {tag}<span className="chip-x" aria-hidden="true">×</span>
          </button>
        ))}
        {offered.map((tag) => (
          <button type="button" key={tag} className="chip" aria-pressed="false" onClick={() => onChange([...value, tag])}>{tag}</button>
        ))}
        <input
          className="chip-input"
          value={text}
          list="thread-tags"
          maxLength={80}
          placeholder={known.length ? "Another tag…" : "Add a tag…"}
          aria-label="Add a tag"
          onChange={(event) => (event.target.value.includes(",") ? add(event.target.value) : onText(event.target.value))}
          onKeyDown={(event) => {
            if (event.key === "Enter" && text.trim()) {
              event.preventDefault();
              add(text);
            } else if (event.key === "Backspace" && !text && value.length) {
              onChange(value.slice(0, -1));
            }
          }}
        />
        <datalist id="thread-tags">{known.filter((tag) => !value.includes(tag)).map((tag) => <option key={tag} value={tag} />)}</datalist>
      </div>
    </div>
  );
}

function NewThread({ tags, subforums, preferredSubforumId, onClose }: {
  tags: string[];
  subforums: Subforum[];
  preferredSubforumId: number | null;
  onClose(): void;
}) {
  const { projectId, user, members } = useProject();
  const [draft, setDraft] = useThreadDraft(projectId);
  const [subforumId, setSubforumId] = useState(preferredSubforumId ?? subforums[0]?.id ?? 0);
  const [tagText, setTagText] = useState("");
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const bodyInput = useRef<HTMLTextAreaElement>(null);
  const agents = members.filter((member) => member.kind === "agent");
  useEffect(() => {
    if (!subforums.some((subforum) => subforum.id === subforumId)) {
      setSubforumId(preferredSubforumId ?? subforums[0]?.id ?? 0);
    }
  }, [preferredSubforumId, subforumId, subforums]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    api<{ thread: { id: number }; turnIds: number[] }>(`/projects/${projectId}/threads`, {
      method: "POST",
      json: { subforumId, title: draft.title.trim(), body: draft.body, tags: tagsFrom(`${draft.tags},${tagText}`) },
    }).then((result) => {
      setDraft(emptyThread());
      invalidate(keys.threads(projectId));
      invalidate(keys.turns(projectId));
      invalidate(keys.projects);
      navigate(path(projectId, "t", result.thread.id));
    }, flashFailure).finally(() => setBusy(false));
  };
  const mention = (handle: string) => {
    const element = bodyInput.current;
    const start = element?.selectionStart ?? draft.body.length;
    const end = element?.selectionEnd ?? start;
    const before = draft.body.slice(0, start);
    const after = draft.body.slice(end);
    const prefix = before && !/[\s(]$/.test(before) ? " " : "";
    const insertion = `${prefix}@${handle} `;
    setDraft({ ...draft, body: before + insertion + after });
    requestAnimationFrame(() => {
      if (!bodyInput.current) return;
      const caret = start + insertion.length;
      bodyInput.current.focus();
      bodyInput.current.setSelectionRange(caret, caret);
    });
  };
  return (
    <form className="card form new-thread" onSubmit={submit}>
      <div className="new-thread-top">
        <label>
          Title
          <input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} required maxLength={240} placeholder="One clear topic, question, or claim" autoFocus />
        </label>
        <label>
          Subforum
          <select value={subforumId} onChange={(event) => setSubforumId(Number(event.target.value))} required>
            {subforums.map((subforum) => <option key={subforum.id} value={subforum.id}>{subforum.name}</option>)}
          </select>
        </label>
      </div>
      <label>
        Opening post <span className="hint">Markdown · <kbd>@</kbd> mentions a member · <kbd>[[</kbd> links a thread, post, source, or result</span>
        <SmartTextarea textareaRef={bodyInput} rows={9} value={draft.body} onValue={(body) => setDraft({ ...draft, body })} required maxLength={100_000} />
      </label>
      <TagPicker value={tagsFrom(draft.tags)} known={tags} text={tagText} onText={setTagText} onChange={(next) => setDraft({ ...draft, tags: next.join(", ") })} />
      {agents.length ? (
        <p className="muted small">
          Mention an agent to invite it within this project's allowances:
          {agents.map((agent, index) => (
            <span key={agent.id}>{index ? ", " : ""}<button type="button" className="link mention-link" onClick={() => mention(agent.handle)}>@{agent.handle}</button></span>
          ))}
        </p>
      ) : null}
      <div className="row">
        <button className="primary" type="submit" disabled={busy || !subforumId || !draft.title.trim() || !draft.body.trim()}>Create thread</button>
        <button type="button" onClick={() => setPreview(!preview)} aria-pressed={preview}>Preview</button>
        <button type="button" className="link" onClick={onClose}>Close</button>
        <span className="muted small push">Posting as @{user.handle}</span>
      </div>
      {preview && draft.body.trim() ? <div className="preview"><Markdown text={draft.body} /></div> : null}
    </form>
  );
}

function NewSubforum({ onClose, onCreated }: { onClose(): void; onCreated(subforum: Subforum): void }) {
  const { projectId } = useProject();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    api<{ subforum: Subforum }>(`/projects/${projectId}/subforums`, {
      method: "POST",
      json: { name, description },
    }).then((result) => {
      invalidate(keys.subforums(projectId));
      onCreated(result.subforum);
    }, flashFailure).finally(() => setBusy(false));
  };
  return (
    <form className="card form new-subforum" onSubmit={submit}>
      <label>Name <input value={name} onChange={(event) => setName(event.target.value)} required maxLength={100} autoFocus /></label>
      <label>Description <input value={description} onChange={(event) => setDescription(event.target.value)} maxLength={500} placeholder="Optional" /></label>
      <div className="row">
        <button className="primary" type="submit" disabled={busy || !name.trim()}>Create subforum</button>
        <button type="button" className="link" onClick={onClose}>Cancel</button>
      </div>
    </form>
  );
}

/** Who takes part in the project: their faces, and the full roll on a click. */
function Members() {
  const { projectId, members, isOwner } = useProject();
  if (!members.length) return null;
  // People before agents, the owner first.
  const ordered = [...members].sort((a, b) => Number(b.isOwner) - Number(a.isOwner) || Number(a.kind === "agent") - Number(b.kind === "agent"));
  const faces = ordered.length > FACES ? ordered.slice(0, FACES - 1) : ordered;
  const rest = ordered.length - faces.length;
  return (
    <Popover
      label="Members"
      className="members-popover"
      button={({ open, toggle }) => (
        <button type="button" className={`facepile ${open ? "on" : ""}`} aria-expanded={open} aria-label={`${plural(members.length, "member")}: show who`} title={plural(members.length, "member")} onClick={toggle}>
          {faces.map((member) => <Avatar key={member.id} handle={member.handle} size="small" />)}
          {rest ? <span className="avatar small more" aria-hidden="true">+{rest}</span> : null}
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="pane-head">
            <span className="pane-title">{plural(members.length, "member")}</span>
            <a className="small" href={link(projectId, "settings")} onClick={close}>{isOwner ? "Manage ›" : "Details ›"}</a>
          </div>
          <ul className="member-roll">
            {ordered.map((member) => (
              <li key={member.id}><Avatar handle={member.handle} size="small" /> <Who handle={member.handle} kind={member.kind} />{member.isOwner ? <span className="muted small"> owner</span> : null}</li>
            ))}
          </ul>
        </>
      )}
    </Popover>
  );
}

/**
 * The board's tags as chips. A chip that is on narrows the board to the threads carrying it; the others are the tags
 * those threads also carry, each with how many would be left by switching it on as well (so no chip leads nowhere).
 */
function TagFilter({ tags, counts, selected, href }: { tags: string[]; counts: Map<string, number>; selected: string[]; href(tags: string[]): string }) {
  const [all, setAll] = useState(false);
  // A tag that is on stays in view even when nothing on this board carries it, so it can be switched off.
  const listed = [...selected.filter((tag) => !tags.includes(tag)), ...tags].filter((tag) => selected.includes(tag) || counts.get(tag));
  const visible = all ? listed : listed.filter((tag, index) => index < TAG_LIMIT || selected.includes(tag));
  const hidden = listed.length - visible.length;
  return (
    <div className="chips tag-filter" role="group" aria-label="Filter by tag">
      <span className="chips-label">Tags</span>
      {visible.map((tag) => {
        const on = selected.includes(tag);
        const count = counts.get(tag) ?? 0;
        return (
          <a key={tag} className={`chip ${on ? "on" : ""}`} aria-current={on ? "true" : undefined} title={on ? `Stop filtering by ${tag}` : undefined} href={href(on ? selected.filter((each) => each !== tag) : [...selected, tag])}>
            {tag}
            {on ? <span className="chip-x" aria-hidden="true">×</span> : <span className="chip-count">{count}</span>}
          </a>
        );
      })}
      {hidden ? <button type="button" className="chip more" onClick={() => setAll(true)}>+{hidden} more</button>
        : all && listed.length > TAG_LIMIT ? <button type="button" className="chip more" onClick={() => setAll(false)}>Fewer</button> : null}
      {selected.length ? <a className="chips-clear small" href={href([])}>Clear</a> : null}
    </div>
  );
}

function ThreadTable({ threads, projectId, selected, showSubforum, boardLink }: {
  threads: ThreadSummary[];
  projectId: number;
  selected: string[];
  showSubforum: boolean;
  boardLink(subforumId: number | undefined, tags: string[]): string;
}) {
  const { kinds } = useProject();
  return (
    <table className="threads">
      <thead>
        <tr>
          <th>Thread</th>
          <th className="num">Posts</th>
          <th>Last post</th>
        </tr>
      </thead>
      <tbody>
        {threads.map((thread) => (
          <tr key={thread.id} className={thread.pinned ? "pinned" : ""}>
            <td>
              <a className="thread-title" href={link(projectId, "t", thread.id)}>
                {thread.pinned ? <span className="pin-mark" title="Pinned">{icons.pin}</span> : null}
                {thread.title}
              </a>
              <div className="thread-sub small">
                <Who handle={thread.createdBy} kind={kinds.get(thread.createdBy.toLowerCase())} />
                <span className="muted"> · <Time at={thread.createdAt} /></span>
                {showSubforum ? <a className="subforum-mark" href={boardLink(thread.subforumId, selected)}>{thread.subforumName}</a> : null}
                {thread.tags.map((tag) => {
                  const on = selected.includes(tag);
                  return <a key={tag} className={`tag ${on ? "on" : ""}`} href={boardLink(showSubforum ? undefined : thread.subforumId, on ? selected.filter((each) => each !== tag) : [...selected, tag])}>{tag}</a>;
                })}
              </div>
            </td>
            <td className="num">{thread.postCount}</td>
            <td className="muted nowrap"><Time at={thread.lastPostAt ?? thread.createdAt} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const quoted = (tags: string[]) => tags.map((tag) => `“${tag}”`).join(" and ");

export function Home() {
  const { projectId, project, isOwner } = useProject();
  const route = useRoute();
  const selected = useMemo(() => [...new Set(route.query.getAll("tag").map((tag) => tag.trim()).filter(Boolean))], [route.key]);
  const requestedSubforumId = Number(route.query.get("subforum"));
  const subforums = useSubforums(projectId);
  const threads = useThreads(projectId);
  const [draft] = useThreadDraft(projectId);
  const [open, setOpen] = useState(route.query.get("new") === "1");
  const [creatingSubforum, setCreatingSubforum] = useState(false);
  const [collapsedSubforums, setCollapsedSubforums] = useState<Set<number>>(() => new Set());
  useEffect(() => {
    if (route.query.get("new") === "1") setOpen(true);
  }, [route.key]);

  const preferredSubforum = subforums.data?.find((subforum) => subforum.id === requestedSubforumId) ?? null;
  useEffect(() => {
    if (!preferredSubforum) return;
    setCollapsedSubforums((current) => {
      if (!current.has(preferredSubforum.id)) return current;
      const next = new Set(current);
      next.delete(preferredSubforum.id);
      return next;
    });
  }, [preferredSubforum?.id]);
  // Every tag in the project is offered to a new thread and to the board-wide filter.
  const projectTags = useMemo(() => tagsOf(threads.data ?? []), [threads.data]);
  const shown = useMemo(() => (threads.data ?? []).filter((thread) => selected.every((tag) => thread.tags.includes(tag))), [threads.data, selected]);
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const thread of shown) for (const tag of thread.tags) map.set(tag, (map.get(tag) ?? 0) + 1);
    return map;
  }, [shown]);

  const hasDraft = Boolean(draft.title.trim() || draft.body.trim());
  const boardLink = (subforum: number | undefined, tags: string[]) => {
    const query = new URLSearchParams();
    if (subforum) query.set("subforum", String(subforum));
    for (const tag of tags) query.append("tag", tag);
    return `${link(projectId, "forum")}${query.size ? `?${query}` : ""}`;
  };
  const toggleSubforum = (id: number) => setCollapsedSubforums((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  return (
    <div className="home">
      <div className="head-row board-head">
        <h1>{project.name}</h1>
        <span className="head-tools">
          <Members />
          {isOwner ? <button type="button" className="link" aria-expanded={creatingSubforum} onClick={() => setCreatingSubforum(!creatingSubforum)}>{icons.plus} New subforum</button> : null}
          <button className="primary" type="button" disabled={!subforums.data?.length} onClick={() => setOpen(!open)} aria-expanded={open}>{hasDraft && !open ? "Continue draft" : "New thread"}</button>
        </span>
      </div>

      {subforums.error && !subforums.data ? <Failure error={subforums.error} /> : null}
      {creatingSubforum ? <NewSubforum onClose={() => setCreatingSubforum(false)} onCreated={(subforum) => {
        setCreatingSubforum(false);
        navigate(path(projectId, "forum") + `?subforum=${subforum.id}`);
      }} /> : null}

      {open && subforums.data?.length ? <NewThread
        tags={projectTags}
        subforums={subforums.data}
        preferredSubforumId={preferredSubforum?.id ?? null}
        onClose={() => (setOpen(false), route.query.get("new") && navigate(path(projectId, "forum"), { replace: true }))}
      /> : null}

      {projectTags.length || selected.length ? <TagFilter tags={projectTags} counts={counts} selected={selected} href={(tags) => boardLink(undefined, tags)} /> : null}

      {threads.error && !threads.data ? <Failure error={threads.error} />
        : !threads.data ? <Loading />
          : subforums.data ? (
            <div className="subforum-list">
              {subforums.data.map((subforum) => {
                const visible = shown.filter((thread) => thread.subforumId === subforum.id);
                const collapsed = collapsedSubforums.has(subforum.id);
                return (
                  <section key={subforum.id} className={`subforum-board ${preferredSubforum?.id === subforum.id ? "targeted" : ""}`}>
                    <button type="button" className="subforum-heading" aria-expanded={!collapsed} aria-controls={`subforum-${subforum.id}`} onClick={() => toggleSubforum(subforum.id)}>
                      <span className={`subforum-chevron ${collapsed ? "" : "open"}`} aria-hidden="true">{icons.chevron}</span>
                      <span className="subforum-name">{subforum.name}</span>
                      <span className="subforum-count">{selected.length ? `${visible.length} of ` : ""}{subforum.threadCount}</span>
                    </button>
                    {!collapsed ? (
                      <div className="subforum-body" id={`subforum-${subforum.id}`}>
                        {subforum.description ? <p className="subforum-description">{subforum.description}</p> : null}
                        {visible.length
                          ? <ThreadTable threads={visible} projectId={projectId} selected={selected} showSubforum={false} boardLink={boardLink} />
                          : <p className="subforum-empty muted">{selected.length ? `No threads tagged ${quoted(selected)}.` : "No threads yet."}</p>}
                      </div>
                    ) : null}
                  </section>
                );
              })}
            </div>
          ) : null}
    </div>
  );
}
