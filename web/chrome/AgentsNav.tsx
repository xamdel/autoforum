// "Agents" in the header. A light runs under the word while any agent is working (a forum agent's turn is queued or
// running, or the Scribe is replying). Resting the pointer on it opens a pane: who is working and for how long, what
// is queued, the day's totals, and the recent turns. Clicking goes to the Agents page.

import { useEffect, useRef, useState } from "react";

import { api, type AgentRunnerStatus, type AgentTurn, type Conversation } from "../lib/api.ts";
import { money, plural, tokens } from "../lib/format.ts";
import { invalidate, setQueryData } from "../lib/query.ts";
import { addressLink, link } from "../lib/router.ts";
import { Avatar, Badge, Dots, flashFailure, icons, Time, Timer } from "../components/ui.tsx";
import { showScribe } from "../state/dock.ts";
import { useProject } from "../state/project.tsx";
import { isActiveTurn, keys, useAgentRunner, useConversations, usePreview, useTurns } from "../state/queries.ts";
import { chat, selectChat } from "../state/scribe.ts";

export const turnTokens = (turn: AgentTurn) => turn.usage?.totalTokens ?? ((turn.usage?.input ?? 0) + (turn.usage?.output ?? 0));

export function stopTurn(projectId: number, turnId: number): void {
  api(`/projects/${projectId}/agent-turns/${turnId}/stop`, { method: "POST" }).then(() => {
    invalidate(keys.turns(projectId));
    invalidate(keys.projects);
  }, flashFailure);
}

/** The thread a turn's trigger post is in, once the preview has it. */
export function TurnThread({ projectId, turn }: { projectId: number; turn: AgentTurn }) {
  const preview = usePreview(projectId, `post:${turn.triggerLocalId}`);
  const title = preview.data?.heading.replace(/^@\S+ in /, "");
  return title ? <span className="turn-thread">in <a href={addressLink(projectId, `post:${turn.triggerLocalId}`)}>{title}</a></span> : null;
}

const STATUS_TONE: Record<string, string> = { pending: "open", completed: "good", failed: "bad", stopped: "quiet", running: "busy", queued: "open" };

/** One finished turn, as a line of the log. */
export function TurnLine({ projectId, turn }: { projectId: number; turn: AgentTurn }) {
  const used = turnTokens(turn);
  return (
    <li className={`turn-line ${turn.status}`}>
      <Badge tone={STATUS_TONE[turn.status]}>{turn.status}</Badge>
      <span className="turn-what">
        <b className="who agent">@{turn.agent}</b>{" "}
        {turn.outputLocalId
          ? <>replied in <a href={addressLink(projectId, `post:${turn.outputLocalId}`)}>post:{turn.outputLocalId}</a></>
          : <>on <a href={addressLink(projectId, `post:${turn.triggerLocalId}`)}>post:{turn.triggerLocalId}</a></>}
        {turn.error ? <span className="turn-error" title={turn.error}> · {turn.error.replace(/_/g, " ")}</span> : null}
      </span>
      <span className="turn-meta">
        <Time at={turn.finishedAt ?? turn.createdAt} />
        {used ? ` · ${tokens(used)}` : ""}
        {turn.reportedCost ? ` · ${money(turn.reportedCost)}` : ""}
      </span>
    </li>
  );
}

function Pane({
  turns,
  scribeBusy,
  runner,
}: {
  turns: AgentTurn[] | undefined;
  scribeBusy: Conversation[];
  runner: AgentRunnerStatus | undefined;
}) {
  const { projectId, isOwner, members } = useProject();
  const pending = chat.use().pending;
  const [changingRunner, setChangingRunner] = useState(false);
  if (!isOwner) {
    const agents = members.filter((member) => member.kind === "agent");
    const active = (turns ?? []).filter(isActiveTurn);
    return (
      <>
        <div className="pane-title">Agents in this project</div>
        {active.map((turn) => (
          <div className="member working" key={turn.id}>
            <Avatar handle={turn.agent} working={turn.status === "running"} />
            <div className="member-body">
              <b className="member-name">@{turn.agent}</b>
              <div className="member-status">{turn.status === "running" ? "writing a reply to" : "queued for"} <a href={addressLink(projectId, `post:${turn.triggerLocalId}`)}>post:{turn.triggerLocalId}</a></div>
            </div>
          </div>
        ))}
        {scribeBusy.map((conversation) => (
          <button type="button" className="member working" key={`s${conversation.id}`} onClick={() => (selectChat(projectId, conversation.id), showScribe())}>
            <span className="avatar scribe working" aria-hidden="true">{icons.quill}</span>
            <span className="member-body"><b className="member-name">Your Scribe</b><span className="member-status">replying to you</span></span>
          </button>
        ))}
        {agents.length
          ? <ul className="agent-roll">{agents.map((agent) => <li key={agent.id}><Avatar handle={agent.handle} size="small" /> <b className="who agent">@{agent.handle}</b></li>)}</ul>
          : <p className="muted small">No agents take part in this project yet.</p>}
        <p className="muted small pane-foot">Mention an agent in a post to invite it. Requests run while the thread and project allowances have room.</p>
      </>
    );
  }
  const list = turns ?? [];
  const running = list.filter((turn) => turn.status === "running");
  const queued = list.filter((turn) => turn.status === "queued");
  const waiting = list.filter((turn) => turn.status === "pending");
  const finished = list.filter((turn) => !isActiveTurn(turn) && turn.status !== "pending");
  const since = Date.now() - 86_400_000;
  const day = list.filter((turn) => Date.parse(turn.createdAt) >= since);
  const count = (status: string) => day.filter((turn) => turn.status === status).length;
  const dayTokens = day.reduce((sum, turn) => sum + turnTokens(turn), 0);
  const dayCost = day.reduce((sum, turn) => sum + (turn.reportedCost ?? 0), 0);
  const idle = !running.length && !queued.length && !scribeBusy.length;
  const paused = runner?.paused ?? false;
  const toggleRunner = async () => {
    setChangingRunner(true);
    try {
      const status = await api<AgentRunnerStatus>("/agent-runner", { method: "PUT", json: { paused: !paused } });
      setQueryData(keys.agentRunner, () => status);
    } catch (error) {
      flashFailure(error);
    } finally {
      setChangingRunner(false);
    }
  };
  return (
    <>
      <div className="pane-head">
        <span className="pane-title">Agents</span>
        <span className="agent-runner-control">
          <span className={`small ${paused ? "bad" : "muted"}`}>{paused ? "Paused" : "Playing"}</span>
          <button
            type="button"
            className="icon-button tiny"
            disabled={changingRunner || runner === undefined}
            title={paused ? "Resume queued forum-agent turns" : "Pause after the current forum-agent turn"}
            aria-label={paused ? "Resume forum agents" : "Pause forum agents"}
            onClick={() => void toggleRunner()}
          >{changingRunner ? <Dots /> : paused ? icons.play : icons.pause}</button>
          <a className="small" href={link(projectId, "agents")}>Configure ›</a>
        </span>
      </div>

      {paused ? <p className="agent-runner-note">Queued forum-agent turns are paused. A reply already running will finish.</p> : null}

      <h4>{idle ? "Nobody is working" : "Working now"}</h4>
      {running.map((turn) => (
        <div className="member working" key={turn.id}>
          <Avatar handle={turn.agent} working />
          <div className="member-body">
            <b className="member-name">@{turn.agent}</b>
            <div className="member-status working"><Dots /> writing a reply to <a href={addressLink(projectId, `post:${turn.triggerLocalId}`)}>post:{turn.triggerLocalId}</a> · <Timer since={turn.startedAt ?? turn.createdAt} /></div>
            <div className="member-meta">{turn.provider}/{turn.model} <TurnThread projectId={projectId} turn={turn} /></div>
          </div>
          <button type="button" className="small" disabled={Boolean(turn.stopRequestedAt)} onClick={() => stopTurn(projectId, turn.id)}>{turn.stopRequestedAt ? "Stopping…" : "Stop"}</button>
        </div>
      ))}
      {scribeBusy.map((conversation) => (
        <div className="member working" key={`s${conversation.id}`}>
          <span className="avatar scribe working" aria-hidden="true">{icons.quill}</span>
          <div className="member-body">
            <b className="member-name">Scribe</b>
            <div className="member-status working"><Dots /> replying to you · <Timer since={pending[conversation.id]?.startedAt ?? conversation.updatedAt} /></div>
            <div className="member-meta">{conversation.preview ?? "a new conversation"}</div>
          </div>
          <button type="button" className="small" onClick={() => (selectChat(projectId, conversation.id), showScribe())}>Open</button>
        </div>
      ))}
      {queued.map((turn) => (
        <div className="member queued" key={turn.id}>
          <Avatar handle={turn.agent} />
          <div className="member-body">
            <b className="member-name">@{turn.agent}</b>
            <div className="member-status">queued for <a href={addressLink(projectId, `post:${turn.triggerLocalId}`)}>post:{turn.triggerLocalId}</a> · <Time at={turn.createdAt} /></div>
          </div>
          <button type="button" className="small" onClick={() => stopTurn(projectId, turn.id)}>Cancel</button>
        </div>
      ))}
      {waiting.length ? (
        <p className="muted small">{plural(waiting.length, "agent request")} waiting for approval inside its thread.</p>
      ) : null}
      {idle ? <p className="muted small">Mention an agent in a post to invite it, or ask the Scribe.</p> : null}

      <h4>Last 24 hours</h4>
      {day.length ? (
        <div className="stat-row">
          <span><b>{day.length}{list.length >= 100 && day.length === list.length ? "+" : ""}</b> {day.length === 1 ? "turn" : "turns"}</span>
          <span><b>{count("completed")}</b> completed</span>
          {count("failed") ? <span className="bad"><b>{count("failed")}</b> failed</span> : null}
          {count("stopped") ? <span><b>{count("stopped")}</b> stopped</span> : null}
          <span><b>{tokens(dayTokens)}</b> tokens</span>
          <span><b>{money(dayCost)}</b> reported</span>
        </div>
      ) : <p className="muted small">No agent turns.</p>}

      <h4>Activity</h4>
      {finished.length
        ? <ul className="turn-log">{finished.slice(0, 8).map((turn) => <TurnLine key={turn.id} projectId={projectId} turn={turn} />)}</ul>
        : <p className="muted small">Nothing yet.</p>}
      {finished.length > 8 ? <a className="small pane-foot" href={link(projectId, "agents", "activity")}>All {plural(list.length, "recent turn")} ›</a> : null}
    </>
  );
}

export function AgentsNav({ active }: { active: boolean }) {
  const { projectId, isOwner } = useProject();
  const turns = useTurns(projectId, true);
  const runner = useAgentRunner(isOwner);
  const conversations = useConversations(projectId, true);
  const pending = chat.use().pending;
  const [open, setOpen] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const activeTurns = (turns.data ?? []).filter(isActiveTurn).length;
  const scribeBusy = (conversations.data ?? []).filter((conversation) => conversation.status === "running" || pending[conversation.id]);
  const busy = activeTurns + scribeBusy.length;
  const later = (value: boolean, wait: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setOpen(value);
      if (value) void turns.refetch();
    }, wait);
  };

  return (
    <span
      className="agents-nav"
      onMouseEnter={() => later(true, 140)}
      onMouseLeave={() => later(false, 260)}
      onFocus={() => later(true, 0)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) later(false, 0);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") later(false, 0);
      }}
    >
      <a
        href={link(projectId, "agents")}
        className={`${active ? "active" : ""} ${busy ? "working" : ""}`}
        aria-label={busy ? `Agents, ${busy} working` : "Agents"}
        aria-expanded={open}
        onClick={() => later(false, 0)}
      >
        Agents
        {busy ? <span className="nav-count" aria-hidden="true">{busy}</span> : null}
        {busy ? <span className="nav-activity" aria-hidden="true" /> : null}
      </a>
      {open ? (
        <div className="popover agents-pane" role="dialog" aria-label="Agent activity" onClick={(event) => (event.target as HTMLElement).closest("a") && later(false, 0)}>
          <Pane turns={turns.data} scribeBusy={scribeBusy} runner={runner.data} />
        </div>
      ) : null}
    </span>
  );
}
