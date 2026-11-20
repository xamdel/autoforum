// A thread: its head across the top (title, pin, tags), then the posts in order, each with the excerpts and
// discourse objects it introduced, and the composer under them. The margin beside the posts (Margin.tsx) holds what
// belongs to the thread as a whole. ?at=<address> opens the thread at that post or record and marks it.

import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";

import {
  api, type AgentTurn, type DiscourseObject, type Excerpt, type ForumResult, type Post, type ThreadDetail, type ThreadSummary,
} from "../lib/api.ts";
import { plural } from "../lib/format.ts";
import { invalidate, peekQuery } from "../lib/query.ts";
import { link, navigate, path, useRoute } from "../lib/router.ts";
import { stopTurn } from "../chrome/AgentsNav.tsx";
import { Markdown, plainLine } from "../components/Markdown.tsx";
import { ObjectCard } from "../components/Records.tsx";
import type { Suggestion } from "../components/SmartTextarea.tsx";
import {
  AddressChip, Avatar, Dots, Failure, flashFailure, icons, Loading, Time, Timer, Who,
} from "../components/ui.tsx";
import { appendToReply, rememberThread, setReplyTarget } from "../state/drafts.ts";
import { useProject } from "../state/project.tsx";
import { keys, useThread, useTurns } from "../state/queries.ts";
import { askScribe } from "../state/scribe.ts";
import { Composer } from "./Composer.tsx";
import { tagsFrom } from "./Home.tsx";
import { Margin } from "./Margin.tsx";

const NONE: never[] = [];

interface PostActions {
  reply(post: Post): void;
  quote(post: Post): void;
  cite(post: Post): void;
  ask(post: Post): void;
}

const PostView = memo(function PostView({ post, kind, objects, excerpts, resultsByProposal, turn, marked, threadId, projectId, actions }: {
  post: Post;
  kind: "human" | "agent" | undefined;
  objects: DiscourseObject[];
  excerpts: Excerpt[];
  resultsByProposal: ReadonlyMap<string, ForumResult[]>;
  turn: AgentTurn | undefined;
  marked: string | null;
  threadId: number;
  projectId: number;
  actions: PostActions;
}) {
  const excerptMarked = excerpts.some((excerpt) => excerpt.address === marked);
  return (
    <>
      <article className={`post ${kind === "agent" ? "by-agent" : ""} ${marked === post.address || excerptMarked ? "highlight" : ""}`} data-address={post.address}>
        <header>
          <Avatar handle={post.author} size="small" />
          <span className="post-author">
            <Who handle={post.author} kind={kind} />
            {post.agentTurn ? (
              <span
                className="post-model"
                title={`${post.agentTurn.provider}/${post.agentTurn.model} · ${post.agentTurn.thinkingLevel} effort`}
              >
                {post.agentTurn.provider}/{post.agentTurn.model} · {post.agentTurn.thinkingLevel} effort
              </span>
            ) : null}
          </span>
          <span className="muted"><Time at={post.createdAt} /></span>
          {post.replyToAddress ? <a className="reply-to muted" href={`${link(projectId, "t", threadId)}?at=${encodeURIComponent(post.replyToAddress)}`} data-ref={post.replyToAddress}>{icons.reply} {post.replyToAddress}</a> : null}
          <span className="post-id"><AddressChip address={post.address} /></span>
        </header>
        <Markdown text={post.body} />
        {excerpts.map((excerpt) => <span className="record-anchor" data-address={excerpt.address} key={excerpt.id} aria-hidden="true" />)}
        {objects.map((object) => (
          <ObjectCard key={object.id} object={object} results={resultsByProposal.get(object.address)} threadId={threadId} projectId={projectId} highlight={marked === object.address} />
        ))}
        <footer>
          <button type="button" className="link" onClick={() => actions.reply(post)}>Reply</button>
          <button type="button" className="link" onClick={() => actions.quote(post)}>Quote</button>
          <button type="button" className="link" onClick={() => actions.cite(post)}>Cite</button>
          <button type="button" className="link" title="Talk to the Scribe about this post, privately, beside the page" onClick={() => actions.ask(post)}>Ask the Scribe</button>
        </footer>
      </article>
      {turn ? (
        <div className="typing running" role="status">
          <Avatar handle={turn.agent} working size="small" />
          <div className="typing-body">
            <b>@{turn.agent}</b> is writing a reply
            <div className="typing-meta">
              <Dots /> <Timer since={turn.startedAt ?? turn.createdAt} /> ·{" "}
              {turn.provider}/{turn.model} · {turn.thinkingLevel} effort
            </div>
          </div>
          <button type="button" className="small" disabled={Boolean(turn.stopRequestedAt)} onClick={() => stopTurn(projectId, turn.id)}>
            {turn.stopRequestedAt ? "Stopping…" : "Stop"}
          </button>
        </div>
      ) : null}
    </>
  );
});

function TagEditor({ tags, known, onChange }: { tags: string[]; known: string[]; onChange(next: string[]): void }) {
  const [adding, setAdding] = useState(false);
  const [value, setValue] = useState("");
  const submit = () => {
    const added = tagsFrom(value);
    setValue("");
    setAdding(false);
    if (added.length) onChange([...new Set([...tags, ...added])]);
  };
  return (
    <div className="tagbar">
      {tags.map((tag) => (
        <span key={tag} className="tag removable">
          {tag}
          <button type="button" className="link" title={`Remove the tag ${tag}`} aria-label={`Remove the tag ${tag}`} onClick={() => onChange(tags.filter((each) => each !== tag))}>×</button>
        </span>
      ))}
      {adding ? (
        <form className="tag-add" onSubmit={(event) => (event.preventDefault(), submit())}>
          <input
            autoFocus
            list="tag-options"
            placeholder="tag, tag"
            value={value}
            maxLength={200}
            onChange={(event) => setValue(event.target.value)}
            onBlur={() => !value.trim() && setAdding(false)}
            onKeyDown={(event) => event.key === "Escape" && (setValue(""), setAdding(false))}
          />
          <datalist id="tag-options">{known.map((tag) => <option key={tag} value={tag} />)}</datalist>
        </form>
      ) : (
        <button type="button" className="tag tag-plus" onClick={() => setAdding(true)}>+ tag</button>
      )}
    </div>
  );
}

function ThreadHead({ detail, known }: { detail: ThreadDetail; known: string[] }) {
  const { projectId, kinds } = useProject();
  const { thread, posts } = detail;
  const [title, setTitle] = useState<string | null>(null);
  const update = (change: { title?: string; tags?: string[]; pinned?: boolean }) =>
    api(`/projects/${projectId}/threads/${thread.id}`, { method: "PATCH", json: change }).then(() => {
      invalidate(keys.thread(projectId, thread.id));
      invalidate(keys.threads(projectId));
    }, flashFailure);
  const others = [...new Set(posts.map((post) => post.author))].filter((handle) => handle !== thread.createdBy);
  return (
    <div className="thread-head">
      <div className="crumbs">
        <a href={link(projectId, "forum")}>Forum</a> › <a href={`${link(projectId, "forum")}?subforum=${thread.subforumId}`}>{thread.subforumName}</a> › {thread.address}
      </div>
      <div className="head-row">
        {title === null ? <h1>{thread.title}</h1> : (
          <form className="title-edit" onSubmit={(event) => {
            event.preventDefault();
            if (title.trim() && title.trim() !== thread.title) void update({ title: title.trim() });
            setTitle(null);
          }}>
            <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={240} autoFocus aria-label="Thread title" onKeyDown={(event) => event.key === "Escape" && setTitle(null)} />
            <button type="submit" className="primary small">Save</button>
            <button type="button" className="link" onClick={() => setTitle(null)}>Cancel</button>
          </form>
        )}
        <span className="head-tools">
          {title === null ? <button type="button" className="icon-button" title="Rename this thread" aria-label="Rename this thread" onClick={() => setTitle(thread.title)}>{icons.pencil}</button> : null}
          <button
            type="button"
            className={`icon-button ${thread.pinned ? "on" : ""}`}
            aria-pressed={thread.pinned}
            title={thread.pinned ? "Pinned (listed first); click to unpin" : "Pin this thread (pinned threads are listed first)"}
            aria-label={thread.pinned ? "Unpin this thread" : "Pin this thread"}
            onClick={() => void update({ pinned: !thread.pinned })}
          >
            {icons.pin}
          </button>
        </span>
      </div>
      <TagEditor tags={thread.tags} known={known} onChange={(tags) => void update({ tags })} />
      <div className="meta-row">
        started by <Who handle={thread.createdBy} kind={kinds.get(thread.createdBy.toLowerCase())} /> <Time at={thread.createdAt} /> · {plural(posts.length, "post")}
        {others.length ? <span className="respondents">· with {others.map((handle) => <span key={handle} className={`who ${kinds.get(handle.toLowerCase()) === "agent" ? "agent" : ""}`}>@{handle}</span>)}</span> : null}
      </div>
    </div>
  );
}

export function ThreadPage({ threadId }: { threadId: number }) {
  const { projectId, kindById } = useProject();
  const route = useRoute();
  const at = route.query.get("at");
  const query = useThread(projectId, threadId);
  const turns = useTurns(projectId, true);
  const detail = query.data;
  const input = useRef<HTMLTextAreaElement | null>(null);
  const [marked, setMarked] = useState<string | null>(null);
  const threadAddress = useRef<string | null>(null);
  threadAddress.current = detail?.thread.address ?? null;

  const derived = useMemo(() => {
    if (!detail) return null;
    const objectsByPost = new Map<number, DiscourseObject[]>();
    for (const object of detail.objects) objectsByPost.set(object.bornInPostId, [...(objectsByPost.get(object.bornInPostId) ?? []), object]);
    const excerptsByPost = new Map<number, Excerpt[]>();
    for (const excerpt of detail.excerpts) excerptsByPost.set(excerpt.bornInPostId, [...(excerptsByPost.get(excerpt.bornInPostId) ?? []), excerpt]);
    const resultsByProposal = new Map<string, ForumResult[]>();
    for (const result of detail.results) {
      if (result.proposalAddress) resultsByProposal.set(result.proposalAddress, [...(resultsByProposal.get(result.proposalAddress) ?? []), result]);
    }
    const addresses = new Set<string>([
      ...detail.posts.map((post) => post.address), ...detail.objects.map((object) => object.address),
      ...detail.excerpts.map((excerpt) => excerpt.address), ...detail.results.map((result) => result.address),
    ]);
    const nearby: Suggestion[] = [
      ...detail.objects.map((object) => ({ label: object.label || plainLine(object.body, 70) || object.kind, detail: object.address, insert: `[[${object.address}]]`, kind: object.kind })),
      ...detail.results.map((result) => ({ label: `${Object.keys(result.outputs).join(", ")}`, detail: result.address, insert: `[[${result.address}]]`, kind: "result" })),
      ...detail.excerpts.map((excerpt) => ({ label: plainLine(excerpt.content, 70), detail: excerpt.address, insert: `[[${excerpt.address}]]`, kind: "excerpt" })),
      ...[...detail.posts].reverse().map((post) => ({ label: `@${post.author}: ${plainLine(post.body, 60)}`, detail: post.address, insert: `[[${post.address}]]`, kind: "post" })),
    ];
    return { objectsByPost, excerptsByPost, resultsByProposal, addresses, nearby };
  }, [detail]);

  // The margin receives every turn, while posts show only the agent currently writing beneath its trigger post.
  const postNumbers = useMemo(() => new Set(detail?.posts.map((post) => post.localId)), [detail]);
  const threadTurns = useMemo(() => (turns.data ?? []).filter((turn) => postNumbers.has(turn.triggerLocalId)), [turns.data, postNumbers]);
  const runningByPost = useMemo(() => {
    const map = new Map<number, AgentTurn>();
    for (const turn of [...threadTurns].sort((left, right) => left.id - right.id)) {
      if (turn.status === "running" && !map.has(turn.triggerLocalId)) map.set(turn.triggerLocalId, turn);
    }
    return map;
  }, [threadTurns]);

  const title = detail?.thread.title;
  useEffect(() => {
    if (title) rememberThread(projectId, threadId, title);
  }, [projectId, threadId, title]);

  const focus = useCallback((address: string) => {
    const target = address.replace(/#.*$/, "");
    const element = document.querySelector<HTMLElement>(`[data-address="${CSS.escape(target)}"]`);
    if (!element) return false;
    // Glide to something nearby; go straight to something far away.
    const far = Math.abs(element.getBoundingClientRect().top) > window.innerHeight * 1.5;
    element.scrollIntoView({ block: "center", behavior: far ? "auto" : "smooth" });
    setMarked(target);
    return true;
  }, []);

  // Arriving with ?at=: go there once it is on the page. A post just published is not there until the thread has
  // been read again, so the wish is kept until it can be granted, and granted only once.
  const loaded = Boolean(detail);
  const wanted = useRef<string | null>(null);
  useEffect(() => {
    wanted.current = at;
  }, [at]);
  useEffect(() => {
    const target = wanted.current;
    if (!detail || !target) return;
    const timer = window.setTimeout(() => {
      if (focus(target)) wanted.current = null;
    }, 60);
    return () => window.clearTimeout(timer);
  }, [detail, at, focus]);
  useEffect(() => {
    if (!marked) return;
    const timer = window.setTimeout(() => setMarked(null), 2_600);
    return () => window.clearTimeout(timer);
  }, [marked]);

  const compose = route.query.get("compose");
  useEffect(() => {
    if (!loaded || !compose) return;
    navigate(path(projectId, "t", threadId), { replace: true });
    window.setTimeout(() => {
      input.current?.scrollIntoView({ block: "center" });
      input.current?.focus();
    }, 60);
  }, [loaded, compose, projectId, threadId]);

  const toComposer = useCallback(() => window.setTimeout(() => {
    input.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    input.current?.focus({ preventScroll: true });
  }, 0), []);
  const actions = useMemo<PostActions>(() => ({
    reply: (post) => (setReplyTarget(projectId, threadId, post.address), toComposer()),
    quote: (post) => {
      const quoted = post.body.split("\n").slice(0, 12).map((lineOfPost) => `> ${lineOfPost}`).join("\n");
      appendToReply(projectId, threadId, `> **@${post.author}** in [[${post.address}]]:\n>\n${quoted}\n\n`);
      toComposer();
    },
    cite: (post) => (appendToReply(projectId, threadId, `[[${post.address}]] `), toComposer()),
    // The conversation is anchored to the thread, so everything asked about it stays together.
    ask: (post) => askScribe(projectId, { anchor: threadAddress.current, text: `About [[${post.address}]] by @${post.author}: ` }),
  }), [projectId, threadId, toComposer]);

  // A reference to something in this thread jumps to it instead of leaving and coming back.
  const jump = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const reference = (event.target as HTMLElement).closest<HTMLElement>("a[data-ref]");
    const address = reference?.dataset.ref?.replace(/#.*$/, "");
    if (!address || !derived?.addresses.has(address)) return;
    event.preventDefault();
    if (focus(address)) navigate(`${path(projectId, "t", threadId)}?at=${encodeURIComponent(address)}`, { replace: true });
  };

  if (query.error && !detail) return <Failure error={query.error} />;
  if (!detail || !derived) return <Loading />;

  return (
    <div className="thread-page with-margin" onClick={jump}>
      <ThreadHead detail={detail} known={[...new Set((peekQuery<ThreadSummary[]>(keys.threads(projectId)) ?? []).flatMap((each) => each.tags))]} />
      <div className="thread-main">
        {detail.posts.map((post) => {
          const objects = derived.objectsByPost.get(post.id) ?? NONE;
          const excerpts = derived.excerptsByPost.get(post.id) ?? NONE;
          // Only the post that holds the marked record is told about it, so marking one re-renders one.
          const here = marked !== null && (marked === post.address || objects.some((object) => object.address === marked) || excerpts.some((excerpt) => excerpt.address === marked));
          return (
            <PostView
              key={post.id}
              post={post}
              kind={kindById.get(post.authorId)}
              objects={objects}
              excerpts={excerpts}
              resultsByProposal={derived.resultsByProposal}
              turn={runningByPost.get(post.localId)}
              marked={here ? marked : null}
              threadId={threadId}
              projectId={projectId}
              actions={actions}
            />
          );
        })}
        <Composer threadId={threadId} nearby={derived.nearby} input={input} />
      </div>
      <Margin detail={detail} turns={threadTurns} resultsByProposal={derived.resultsByProposal} onFocus={focus} />
    </div>
  );
}
