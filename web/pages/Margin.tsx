// A thread's margin: a column beside the posts for what belongs to the thread as a whole. Proposals with their
// results, results addressed to the thread itself, an outline of its
// questions, claims and evidence, the agents at work in it, your conversations with the Scribe about it, and what
// refers to it. Proposals and results open in the dock beside the page; the outline jumps within the thread.

import { useEffect, useRef, useState } from "react";

import { api, type AgentTurn, type DiscourseObject, type ForumResult, type ThreadDetail } from "../lib/api.ts";
import { plural } from "../lib/format.ts";
import { invalidate } from "../lib/query.ts";
import { addressLink } from "../lib/router.ts";
import { stopTurn } from "../chrome/AgentsNav.tsx";
import { plainLine } from "../components/Markdown.tsx";
import { ResultRow } from "../components/Records.tsx";
import { AddressChip, Avatar, Badge, Dots, flashFailure, icons, KindIcon, Time, Timer } from "../components/ui.tsx";
import { dock, openDockView, sameView, type DockView } from "../state/dock.ts";
import { useProject } from "../state/project.tsx";
import { keys, useBacklinks, useConversations } from "../state/queries.ts";
import { askScribe, chat, selectChat } from "../state/scribe.ts";
import { showScribe } from "../state/dock.ts";

/**
 * Keeps the margin in view with no scrollbar of its own. One that fits the window just sticks. One taller than the
 * window moves with the page until an end reaches the window's edge and pins there, so either end is a short scroll
 * away. Sticky offsets count from inside the scroller's padding.
 */
function useStickyBothWays() {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const element = ref.current;
    const page = element?.closest("main");
    if (!element || !page) return;
    const highest = 12 - parseFloat(getComputedStyle(page).paddingTop);
    let top = highest;
    let last = page.scrollTop;
    const place = () => {
      const lowest = Math.min(highest, page.clientHeight - element.offsetHeight - 24 + highest);
      top = Math.min(highest, Math.max(lowest, top + last - page.scrollTop));
      last = page.scrollTop;
      element.style.top = `${top}px`;
    };
    place();
    page.addEventListener("scroll", place, { passive: true });
    const resized = new ResizeObserver(place);
    resized.observe(element);
    resized.observe(page);
    return () => {
      page.removeEventListener("scroll", place);
      resized.disconnect();
    };
  }, []);
  return ref;
}

function useDockView(): DockView | null {
  const state = dock.use();
  return state.tab === "view" ? state.view : null;
}

function ProposalNote({ proposal, results, threadId }: { proposal: DiscourseObject; results: ForumResult[]; threadId: number }) {
  const open: DockView = { kind: "proposal", address: proposal.address, threadId };
  const now = useDockView();
  const expected = Object.keys(proposal.expectedOutputs ?? {});
  const missing = results.length ? results.at(-1)!.missingOutputs.length : expected.length;
  return (
    <button type="button" className={`mnote proposal-note ${sameView(now, open) ? "on" : ""}`} title="Open the proposal beside the page" onClick={() => openDockView(open)}>
      <div className="mn-kind"><KindIcon kind="proposal" /> proposal <span className="mn-address">{proposal.address}</span></div>
      <div className="mn-body clamp">{proposal.label || plainLine(proposal.body, 180)}</div>
      <div className="mn-meta">
        {results.length
          ? <Badge tone={missing ? "busy" : "good"}>{plural(results.length, "result")}</Badge>
          : <Badge tone="open">no results yet</Badge>}
        {expected.length ? <span>{missing ? `${missing} of ${expected.length} outputs missing` : `${plural(expected.length, "output")} expected`}</span> : null}
        <span className="mn-act">open {icons.caret}</span>
      </div>
    </button>
  );
}

function ThreadAgents({ detail, turns }: { detail: ThreadDetail; turns: AgentTurn[] }) {
  const { projectId, project, isOwner, members } = useProject();
  const active = turns.filter((turn) => turn.status === "queued" || turn.status === "running");
  const pending = turns.filter((turn) => turn.status === "pending");
  const failed = turns.filter((turn) => turn.status === "failed" && Date.now() - Date.parse(turn.finishedAt ?? turn.createdAt) < 3_600_000);
  const agents = members.filter((member) => member.kind === "agent");
  const [limit, setLimit] = useState(String(detail.thread.agentTurnLimit));
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const parsedLimit = Number(limit);
  const validLimit = Number.isSafeInteger(parsedLimit) && parsedLimit >= detail.thread.agentTurnCount && parsedLimit <= 10_000;
  useEffect(() => setLimit(String(detail.thread.agentTurnLimit)), [detail.thread.agentTurnLimit]);
  useEffect(() => setSelected((current) => new Set([...current].filter((id) => pending.some((turn) => turn.id === id)))), [turns]);
  const refresh = () => {
    invalidate(keys.thread(projectId, detail.thread.id));
    invalidate(keys.turns(projectId));
    invalidate(keys.projects);
  };
  const approve = (turnIds: number[]) => {
    if (!turnIds.length) return;
    api(`/projects/${projectId}/threads/${detail.thread.id}/agent-turns/approve`, { method: "POST", json: { turnIds } }).then(refresh, flashFailure);
  };
  const cancel = (turnIds: number[]) => {
    if (!turnIds.length) return;
    Promise.all(turnIds.map((turnId) => api(`/projects/${projectId}/agent-turns/${turnId}/stop`, { method: "POST" })))
      .then(refresh, flashFailure);
  };
  const updateLimit = () => {
    if (!validLimit) return;
    api(`/projects/${projectId}/threads/${detail.thread.id}`, { method: "PATCH", json: { agentTurnLimit: parsedLimit } }).then(refresh, flashFailure);
  };
  return (
    <section className="mnote agents-note">
      <div className="mn-kind">{icons.bolt} agents in this thread</div>
      <p className="muted small">Thread {detail.thread.agentTurnCount}/{detail.thread.agentTurnLimit} · project {project.agentTurnCount}/{project.agentTurnLimit}</p>
      {isOwner ? (
        <>
          <form className="turn-limit" onSubmit={(event) => (event.preventDefault(), updateLimit())}>
            <label>Turns <b>{detail.thread.agentTurnCount}</b> / <input type="number" min={detail.thread.agentTurnCount} max={10_000} value={limit} onChange={(event) => setLimit(event.target.value)} aria-label="Agent turn limit" /></label>
            <button type="submit" className="small" disabled={!validLimit || parsedLimit === detail.thread.agentTurnLimit}>Update</button>
          </form>
          <p className="muted small turn-warning">The limit bounds paid agent inference in this thread. Raising it admits waiting requests oldest-first.</p>
        </>
      ) : null}
      {active.map((turn) => (
        <div className="typing" key={turn.id}>
          <Avatar handle={turn.agent} working={turn.status === "running"} size="small" />
          <div className="typing-body">
            <b>@{turn.agent}</b> {turn.status === "running" ? <>is writing a reply to post:{turn.triggerLocalId}</> : <>is queued for post:{turn.triggerLocalId}</>}
            <div className="typing-meta">
              {turn.status === "running" ? <><Dots /> <Timer since={turn.startedAt ?? turn.createdAt} /> · </> : null}
              {isOwner ? <button type="button" className="link" disabled={Boolean(turn.stopRequestedAt)} onClick={() => stopTurn(projectId, turn.id)}>{turn.stopRequestedAt ? "stopping…" : turn.status === "running" ? "stop" : "cancel"}</button> : null}
            </div>
          </div>
        </div>
      ))}
      {failed.map((turn) => (
        <p className="mn-fail small" key={turn.id}>@{turn.agent} could not reply to post:{turn.triggerLocalId}: {(turn.error ?? "unknown error").replace(/_/g, " ")}</p>
      ))}
      {isOwner && pending.length ? (
        <div className="turn-requests">
          <div className="small"><b>{plural(detail.thread.pendingTurnCount, "request")} waiting</b></div>
          {pending.map((turn) => (
            <div className="turn-request" key={turn.id}>
              <input type="checkbox" aria-label={`Select @${turn.agent}'s request on post:${turn.triggerLocalId}`} checked={selected.has(turn.id)} onChange={(event) => setSelected((current) => {
                const next = new Set(current);
                if (event.target.checked) next.add(turn.id); else next.delete(turn.id);
                return next;
              })} />
              <span><b>@{turn.agent}</b> requested by @{turn.requestedBy} on <a href={addressLink(projectId, `post:${turn.triggerLocalId}`)}>post:{turn.triggerLocalId}</a></span>
              <button type="button" className="link" onClick={() => approve([turn.id])}>Approve</button>
              <button type="button" className="link" onClick={() => cancel([turn.id])}>Cancel</button>
            </div>
          ))}
          <div className="turn-request-actions">
            <button type="button" className="small" disabled={!selected.size} onClick={() => approve([...selected])}>Approve selected</button>
            <button type="button" className="small" disabled={!selected.size} onClick={() => cancel([...selected])}>Cancel selected</button>
          </div>
        </div>
      ) : null}
      {!active.length ? (
        <p className="muted small mn-quiet agent-invites">
          {agents.length
            ? <><span>Mention one to invite it:</span> {agents.map((agent) => <span key={agent.id} className="mention agent">@{agent.handle}</span>)}</>
            : "No agents take part in this project yet."}
        </p>
      ) : null}
    </section>
  );
}

function ScribeNote({ detail }: { detail: ThreadDetail }) {
  const { projectId } = useProject();
  const conversations = useConversations(projectId, true);
  const pending = chat.use().pending;
  const here = new Set([detail.thread.address, ...detail.posts.map((post) => post.address), ...detail.objects.map((object) => object.address), ...detail.results.map((result) => result.address)]);
  const mine = (conversations.data ?? []).filter((conversation) => conversation.anchor && here.has(conversation.anchor));
  return (
    <section className="mnote scribe-note">
      <div className="mn-kind">{icons.quill} scribe <span className="muted mn-private">private to you</span></div>
      {mine.slice(0, 4).map((conversation) => (
        <button type="button" className="mn-row" key={conversation.id} onClick={() => (selectChat(projectId, conversation.id), showScribe())}>
          <span className="mn-row-text">
            <b>{plainLine(conversation.preview, 60) || "New conversation"}</b>
            <span className="muted small">
              {conversation.status === "running" || pending[conversation.id] ? <><Dots /> replying · </> : null}
              <Time at={conversation.updatedAt} />{conversation.anchor !== detail.thread.address ? ` · ${conversation.anchor}` : ""}
            </span>
          </span>
        </button>
      ))}
      <button type="button" className="link small" onClick={() => askScribe(projectId, { anchor: detail.thread.address })}>
        {mine.length ? "Continue about this thread" : "Ask the Scribe about this thread"} {icons.caret}
      </button>
    </section>
  );
}

function ReferencesNote({ address }: { address: string }) {
  const { projectId } = useProject();
  const backlinks = useBacklinks(projectId, address);
  const [all, setAll] = useState(false);
  const list = backlinks.data ?? [];
  const shown = all ? list : list.slice(0, 6);
  return (
    <section className="mnote refs-note">
      <div className="mn-kind">{icons.relation} referenced by <AddressChip address={address} title="Copy this thread's citation" /></div>
      {shown.length ? (
        <ul className="ref-list">
          {shown.map((backlink) => (
            <li key={backlink.address}>
              <a href={addressLink(projectId, backlink.address)} title={plainLine(backlink.body, 200)}>
                <KindIcon kind={backlink.kind} />
                <span className="ref-title">{backlink.author ? `@${backlink.author}: ` : ""}{plainLine(backlink.label || backlink.body, 80) || backlink.address}</span>
              </a>
            </li>
          ))}
        </ul>
      ) : <p className="muted small mn-quiet">Nothing refers to this thread yet.</p>}
      {list.length > shown.length ? <button type="button" className="link small" onClick={() => setAll(true)}>{list.length - shown.length} more</button> : null}
    </section>
  );
}

const OUTLINE_KINDS = ["question", "claim", "evidence"];

export function Margin({ detail, turns, resultsByProposal, onFocus }: {
  detail: ThreadDetail;
  turns: AgentTurn[];
  resultsByProposal: ReadonlyMap<string, ForumResult[]>;
  onFocus(address: string): void;
}) {
  const { projectId } = useProject();
  const column = useStickyBothWays();
  const now = useDockView();
  const threadId = detail.thread.id;
  const proposals = detail.objects.filter((object) => object.kind === "proposal");
  const loose = detail.results.filter((result) => !result.proposalAddress);
  const outline = detail.objects.filter((object) => OUTLINE_KINDS.includes(object.kind));
  const relations = detail.objects.filter((object) => object.kind === "relation").length;

  return (
    <aside className="margin" ref={column} aria-label="About this thread">
      {proposals.map((proposal) => <ProposalNote key={proposal.id} proposal={proposal} results={resultsByProposal.get(proposal.address) ?? []} threadId={threadId} />)}

      {loose.length ? (
        <section className="mnote results-note">
          <div className="mn-kind"><KindIcon kind="result" /> results for this thread</div>
          {loose.map((result) => <ResultRow key={result.id} result={result} threadId={threadId} active={sameView(now, { kind: "result", address: result.address, threadId })} />)}
        </section>
      ) : null}

      {outline.length ? (
        <section className="mnote outline-note">
          <div className="mn-kind">{icons.glance} outline {relations ? <span className="muted">· {plural(relations, "relation")}</span> : null}</div>
          <ul className="ref-list">
            {outline.map((object) => (
              <li key={object.id}>
                <a href={addressLink(projectId, object.address)} data-ref={object.address} onClick={(event) => (event.preventDefault(), onFocus(object.address))}>
                  <KindIcon kind={object.kind} />
                  <span className="ref-title">{object.label || plainLine(object.body, 90)}</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <ThreadAgents detail={detail} turns={turns} />
      <ScribeNote detail={detail} />
      <ReferencesNote address={detail.thread.address} />
    </aside>
  );
}
