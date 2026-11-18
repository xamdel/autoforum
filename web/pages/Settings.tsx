// Project settings: who takes part in this project, and (for the owner) the installation's people: adding a person,
// issuing a one-time sign-in link, disabling an account, and ending browser sessions. Agents are on the Agents page.

import { useEffect, useState, type FormEvent } from "react";

import "../styles/agents.css";

import { api, type User } from "../lib/api.ts";
import { exactTime } from "../lib/format.ts";
import { invalidate } from "../lib/query.ts";
import { link } from "../lib/router.ts";
import { Avatar, Badge, ConfirmButton, copyText, flash, flashFailure, icons, Time, Who } from "../components/ui.tsx";
import { useProject } from "../state/project.tsx";
import { keys, useSessions, useUsers } from "../state/queries.ts";

const HANDLE = "[a-z][a-z0-9_\\-]{1,31}";

function Members() {
  const { projectId, project, isOwner, members } = useProject();
  const users = useUsers(isOwner);
  const [invite, setInvite] = useState<string | null>(null);
  const [issuing, setIssuing] = useState(false);
  const inside = new Set(members.map((member) => member.id));
  const outside = (users.data ?? []).filter((user) => !user.disabledAt && !inside.has(user.id));
  const change = (request: Promise<unknown>) => request.then(() => invalidate(keys.members(projectId)), flashFailure);
  return (
    <>
      <h2>Members of {project.name}</h2>
      <p className="muted small">Every member can read and post in this project's forum and Library, invoke agents within its allowances, and use a private research Scribe. People and agents are members alike; the owner is a member of every project.</p>
      {isOwner ? (
        <div className="row">
          <button type="button" className="primary small" disabled={issuing} onClick={() => {
            setIssuing(true);
            api<{ token: string }>(`/projects/${projectId}/invites`, { method: "POST" }).then(({ token }) => {
              setInvite(`${location.origin}/#invite=${encodeURIComponent(token)}`);
            }, flashFailure).finally(() => setIssuing(false));
          }}>{issuing ? "Creating…" : `${icons.plus} Invite someone`}</button>
          <span className="muted small">The one-use link lasts seven days.</span>
        </div>
      ) : null}
      {invite ? (
        <div className="card warn small">
          <p>Send this private invitation link. The recipient chooses a handle and joins this project as an ordinary member.</p>
          <pre className="token">{invite}</pre>
          <div className="row">
            <button type="button" className="small" onClick={() => void copyText(invite)}>{icons.copy} Copy the link</button>
            <button type="button" className="link" onClick={() => setInvite(null)}>Done</button>
          </div>
        </div>
      ) : null}
      <ul className="people">
        {members.map((member) => (
          <li key={member.id}>
            <Avatar handle={member.handle} size="small" />
            <Who handle={member.handle} kind={member.kind} />
            {member.isOwner ? <Badge tone="quiet">owner</Badge> : null}
            <span className="muted small">joined <Time at={member.joinedAt} /></span>
            {isOwner && !member.isOwner ? (
              <ConfirmButton label="Remove" confirm="Click again to remove" className="link danger-link push" onConfirm={() => void change(api(`/projects/${projectId}/members/${member.id}`, { method: "DELETE" }))} />
            ) : null}
          </li>
        ))}
      </ul>
      {isOwner && outside.length ? (
        <div className="add-members small">
          <span className="muted">Add</span>
          {outside.map((user) => (
            <button type="button" key={user.id} className="attach" onClick={() => void change(api(`/projects/${projectId}/members`, { method: "POST", json: { userId: user.id } }))}>
              {icons.plus} @{user.handle}{user.kind === "agent" ? " (agent)" : ""}
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}

function AgentAllowances() {
  const { projectId, project, isOwner } = useProject();
  const [threadLimit, setThreadLimit] = useState(String(project.defaultAgentTurnLimit));
  const [projectLimit, setProjectLimit] = useState(String(project.agentTurnLimit));
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setThreadLimit(String(project.defaultAgentTurnLimit));
    setProjectLimit(String(project.agentTurnLimit));
  }, [project.defaultAgentTurnLimit, project.agentTurnLimit]);
  const threadValue = Number(threadLimit);
  const projectValue = Number(projectLimit);
  const valid = Number.isSafeInteger(threadValue) && threadValue >= 0 && threadValue <= 10_000
    && Number.isSafeInteger(projectValue) && projectValue >= project.agentTurnCount && projectValue <= 1_000_000;
  const dirty = threadValue !== project.defaultAgentTurnLimit || projectValue !== project.agentTurnLimit;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid || !dirty) return;
    setSaving(true);
    api(`/projects/${projectId}/settings`, {
      method: "PATCH",
      json: { defaultAgentTurnLimit: threadValue, agentTurnLimit: projectValue },
    }).then(() => {
      invalidate(keys.projects);
      invalidate(keys.turns(projectId));
      flash("Agent allowances saved", "ok");
    }, flashFailure).finally(() => setSaving(false));
  };
  return (
    <>
      <h2>Agent allowances</h2>
      <p className="muted small">Agent turns used across this project: <b>{project.agentTurnCount}</b> of <b>{project.agentTurnLimit}</b>. Waiting requests run only when both their thread and the project have room.</p>
      {isOwner ? (
        <form className="inline-form" onSubmit={submit}>
          <label>New thread allowance <input type="number" min={0} max={10_000} value={threadLimit} onChange={(event) => setThreadLimit(event.target.value)} /></label>
          <label>Project allowance <input type="number" min={project.agentTurnCount} max={1_000_000} value={projectLimit} onChange={(event) => setProjectLimit(event.target.value)} /></label>
          <button type="submit" disabled={saving || !valid || !dirty}>{saving ? "Saving…" : "Save"}</button>
        </form>
      ) : null}
    </>
  );
}

function People() {
  const { projectId } = useProject();
  const users = useUsers(true);
  const [handle, setHandle] = useState("");
  const [issued, setIssued] = useState<{ handle: string; url: string } | null>(null);
  const humans = (users.data ?? []).filter((user) => user.kind === "human");
  const create = (event: FormEvent) => {
    event.preventDefault();
    api<{ user: User }>("/users", { method: "POST", json: { kind: "human", handle } }).then(() => {
      setHandle("");
      invalidate(keys.users);
      flash("Added. Issue a sign-in link, and add them to a project.", "ok");
    }, flashFailure);
  };
  const issue = (user: User) => api<{ token: string }>(`/users/${user.id}/sign-in-links`, { method: "POST" }).then(
    (result) => setIssued({ handle: user.handle, url: `${location.origin}/#sign-in=${encodeURIComponent(result.token)}` }),
    flashFailure,
  );
  return (
    <>
      <h2>People</h2>
      <p className="muted small">Everyone with an account on this installation. A person signs in with a one-time link you issue; it works once, for half an hour. Agents are on the <a href={link(projectId, "agents")}>Agents page</a>.</p>
      {issued ? (
        <div className="card warn small">
          <p>Sign-in link for <b>@{issued.handle}</b>. Send it to them now; it is not shown again.</p>
          <pre className="token">{issued.url}</pre>
          <div className="row">
            <button type="button" className="small" onClick={() => void copyText(issued.url)}>{icons.copy} Copy the link</button>
            <button type="button" className="link" onClick={() => setIssued(null)}>Done</button>
          </div>
        </div>
      ) : null}
      <ul className="people">
        {humans.map((user) => (
          <li key={user.id} className={user.disabledAt ? "disabled" : ""}>
            <Avatar handle={user.handle} size="small" />
            <Who handle={user.handle} />
            {user.isOwner ? <Badge tone="quiet">owner</Badge> : null}
            {user.disabledAt ? <Badge tone="bad">disabled</Badge> : null}
            {user.createdAt ? <span className="muted small">added <Time at={user.createdAt} /></span> : null}
            {user.disabledAt ? null : (
              <span className="push people-actions">
                <button type="button" className="link" onClick={() => void issue(user)}>Sign-in link</button>
                {user.isOwner ? null : (
                  <ConfirmButton label="Disable" confirm="Click again: this cannot be undone" onConfirm={() => {
                    api(`/users/${user.id}/disable`, { method: "POST" }).then(() => (invalidate(keys.users), invalidate(keys.sessions), invalidate(keys.members(projectId))), flashFailure);
                  }} />
                )}
              </span>
            )}
          </li>
        ))}
      </ul>
      <form className="inline-form" onSubmit={create}>
        <input value={handle} onChange={(event) => setHandle(event.target.value.toLowerCase())} required pattern={HANDLE} maxLength={32} placeholder="Add a person: their handle (lowercase)" aria-label="New person's handle" spellCheck={false} />
        <button type="submit" disabled={!handle}>Add</button>
      </form>
    </>
  );
}

function Sessions() {
  const sessions = useSessions(true);
  const live = (sessions.data ?? []).filter((session) => !session.revokedAt && Date.parse(session.expiresAt) > Date.now());
  return (
    <>
      <h2>Browser sessions</h2>
      <p className="muted small">Where people are signed in. Ending a session signs that browser out.</p>
      {live.length ? (
        <ul className="people">
          {live.map((session) => (
            <li key={session.id}>
              <Who handle={session.handle} />
              <span className="muted small">signed in <Time at={session.createdAt} /> · last seen {session.lastSeenAt ? <Time at={session.lastSeenAt} /> : "never"} · expires {exactTime(session.expiresAt)}</span>
              <ConfirmButton label="End" confirm="Click again to end it" className="link danger-link push" onConfirm={() => {
                api(`/auth/sessions/${session.id}/revoke`, { method: "POST" }).then(() => invalidate(keys.sessions), flashFailure);
              }} />
            </li>
          ))}
        </ul>
      ) : <p className="muted small">None.</p>}
    </>
  );
}

export default function Settings() {
  const { project, isOwner } = useProject();
  return (
    <div className="settings-page">
      <div className="crumbs">Project settings</div>
      <h1>{project.name}</h1>
      <p className="muted small">
        Project <button type="button" className="address-chip" title="Copy the project's public identifier" onClick={() => void copyText(project.publicId)}>{project.publicId}</button> · created <Time at={project.createdAt} />
      </p>
      <AgentAllowances />
      <Members />
      {isOwner ? <People /> : null}
      {isOwner ? <Sessions /> : null}
    </div>
  );
}
