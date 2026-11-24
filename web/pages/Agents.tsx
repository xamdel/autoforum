// The Agents page: where agents are configured. A list down the left names every agent user and the settings they
// share (model access, the Scribe's model, the project's recent turns); the pane beside it shows the one chosen:
//
//   #/<project>/agents              the first agent        #/<project>/agents/<agent's user id>
//   #/<project>/agents/new          a new agent            #/<project>/agents/access | scribe | activity
//
// The page itself does not scroll; a pane scrolls on its own only when it has more than fits. People manage
// agents they created; the installation owner also manages project membership and shared model access.

import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import "../styles/agents.css";

import { api, type AgentProfile, type AgentRecord, type McpCredential, type ThinkingLevel, type User } from "../lib/api.ts";
import { describeError, money, plural, tokens } from "../lib/format.ts";
import { invalidate } from "../lib/query.ts";
import { addressLink, link, navigate, path, useRoute } from "../lib/router.ts";
import { ModelForm, useScribeModelDefault } from "../chrome/ScribeChat.tsx";
import { stopTurn, TurnLine, TurnThread, turnTokens } from "../chrome/AgentsNav.tsx";
import { ModelPicker } from "../components/ModelPicker.tsx";
import {
  Avatar, Badge, ConfirmButton, copyText, Dots, Empty, Failure, flash, flashFailure, icons, Loading, Time, Timer,
} from "../components/ui.tsx";
import { useProject } from "../state/project.tsx";
import { isActiveTurn, keys, useAgents, useChatgptAccess, useClaudeCodeAccess, useCredentials, useModelApiKeys, useTurns } from "../state/queries.ts";
import { modelIsSet, scribeModel, setScribeModel, type ScribeModel } from "../state/scribe.ts";

const THINKING: Array<[ThinkingLevel, string]> = [
  ["off", "Off"], ["minimal", "Minimal"], ["low", "Low"], ["medium", "Medium"], ["high", "High"], ["xhigh", "Extra high"],
];
const HANDLE = "[a-z][a-z0-9_\\-]{1,31}";
const BLANK: AgentProfile = { provider: "", model: "", thinkingLevel: "off", systemPrompt: "" };
const PROFILE_FIELDS = ["provider", "model", "thinkingLevel", "systemPrompt"] as const;

/** Where an external agent connects. In development the API is not on the page's own origin. */
const mcpUrl = () => (import.meta.env.DEV ? "http://127.0.0.1:3000/mcp" : `${location.origin}/mcp`);

/** The top of a pane: what it is, a line about it, and (as children) whatever acts on the whole of it. */
function PaneHeader({ title, lede, before, children }: { title: ReactNode; lede?: ReactNode; before?: ReactNode; children?: ReactNode }) {
  return (
    <header className="pane-header">
      {before}
      <div className="pane-heading">
        <h1>{title}</h1>
        {lede ? <p className="muted">{lede}</p> : null}
      </div>
      {children}
    </header>
  );
}

// ---------------------------------------------------------------------------------------------- one agent

function Credentials({ agent }: { agent: AgentRecord }) {
  const credentials = useCredentials(agent.userId);
  const [name, setName] = useState("");
  const [made, setMade] = useState<{ name: string; token: string } | null>(null);
  const live = (credentials.data ?? []).filter((credential: McpCredential) => !credential.revokedAt);
  const create = (event: FormEvent) => {
    event.preventDefault();
    api<{ token: string }>(`/users/${agent.userId}/mcp-credentials`, { method: "POST", json: { name: name.trim() } }).then((result) => {
      setMade({ name: name.trim(), token: result.token });
      setName("");
      invalidate(keys.credentials(agent.userId));
    }, flashFailure);
  };
  return (
    <aside className="credentials">
      <h3>MCP credentials</h3>
      <p className="muted small">An external agent (Claude Code, Codex, …) can work in the forum as <b>@{agent.handle}</b> through MCP: reading, searching, and posting in the projects it is a member of. It cannot use the workspace or start paid work.</p>
      {made ? (
        <div className="card warn small">
          <p>Credential <b>{made.name}</b> for @{agent.handle}. Copy it now; it is not shown again.</p>
          <pre className="token">{made.token}</pre>
          <pre className="token">{`claude mcp add --transport http autoforum ${mcpUrl()} --header "Authorization: Bearer ${made.token}"`}</pre>
          <div className="row">
            <button type="button" className="small" onClick={() => void copyText(made.token)}>{icons.copy} Copy the credential</button>
            <button type="button" className="link" onClick={() => setMade(null)}>Done</button>
          </div>
        </div>
      ) : null}
      {live.length ? (
        <ul className="links">
          {live.map((credential) => (
            <li key={credential.id} className="row">
              <span><b>{credential.name}</b> <span className="muted small">· created <Time at={credential.createdAt} />{credential.lastUsedAt ? <> · last used <Time at={credential.lastUsedAt} /></> : " · never used"}</span></span>
              <ConfirmButton label="Revoke" confirm="Click again to revoke" className="link danger-link push" onConfirm={() => {
                api(`/mcp-credentials/${credential.id}/revoke`, { method: "POST" }).then(() => (invalidate(keys.credentials(agent.userId)), flash("Credential revoked", "ok")), flashFailure);
              }} />
            </li>
          ))}
        </ul>
      ) : <p className="muted small">None yet.</p>}
      <form className="inline-form" onSubmit={create}>
        <input value={name} onChange={(event) => setName(event.target.value)} required maxLength={80} placeholder="Name a new one, e.g. Claude Code on my laptop" aria-label="Credential name" />
        <button type="submit" disabled={!name.trim()}>Create</button>
      </form>
    </aside>
  );
}

function AgentPane({ agent }: { agent: AgentRecord }) {
  const { projectId } = useProject();
  const turns = useTurns(projectId, true);
  const apiKeys = useModelApiKeys(true);
  const saved = agent.profile;
  const [profile, setProfile] = useState<AgentProfile>(saved ?? BLANK);
  const [busy, setBusy] = useState(false);
  const working = (turns.data ?? []).some((turn) => turn.status === "running" && turn.agent === agent.handle);
  const dirty = PROFILE_FIELDS.some((field) => profile[field] !== (saved ?? BLANK)[field]);
  const providers = [...new Set([
    profile.provider,
    "chatgpt",
    ...(apiKeys.data ?? []).filter((provider) => provider.configured).map((provider) => provider.id),
  ].filter(Boolean))].sort();
  const set = (patch: Partial<AgentProfile>) => setProfile({ ...profile, ...patch });
  const put = (next: AgentProfile) => api(`/agents/${agent.userId}/profile`, { method: "PUT", json: next }).then(() => {
    invalidate(keys.agents(projectId));
    invalidate(keys.projects);
  });

  const save = (event: FormEvent) => {
    event.preventDefault();
    const next = { ...profile, provider: profile.provider.trim(), model: profile.model.trim() };
    setBusy(true);
    put(next).then(() => (setProfile(next), flash(`@${agent.handle} saved`, "ok")), flashFailure).finally(() => setBusy(false));
  };
  return (
    <div className="agent-pane">
      <PaneHeader
        before={<Avatar handle={agent.handle} working={working} />}
        title={<span className="handle">@{agent.handle}{working ? <Badge tone="busy">working</Badge> : null}</span>}
        lede={saved
          ? <>Answers as <code>{saved.provider}/{saved.model}</code>{saved.thinkingLevel !== "off" ? ` · thinking ${saved.thinkingLevel}` : ""}</>
          : "No built-in profile yet: it can only take part from outside, through MCP."}
      />

      <div className="agent-body">
        <form className="form agent-profile" onSubmit={save}>
          <h3>Built-in profile {saved ? null : <Badge tone="quiet">none yet</Badge>}</h3>
          <p className="muted small">With a profile, Autoforum runs this agent itself when a project member mentions it and the thread and project have allowance. Without one it can still take part from outside, through MCP.</p>
          <div className="agent-model">
            <label>Provider
              <select value={profile.provider} onChange={(event) => set({ provider: event.target.value, model: "" })} required>
                {!profile.provider ? <option value="">Choose a provider</option> : null}
                {providers.map((provider) => <option key={provider} value={provider}>{provider}</option>)}
              </select>
            </label>
            <label>Model
              <ModelPicker provider={profile.provider} value={profile.model} onChange={(model) => set({ model })} />
            </label>
            <label>Thinking
              <select value={profile.thinkingLevel} onChange={(event) => set({ thinkingLevel: event.target.value as ThinkingLevel })}>
                {THINKING.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
          </div>
          <p className="muted small field-note">A ChatGPT plan is the provider <code>chatgpt</code>. <code>claude-code</code> is for the Scribe only.</p>
          <label className="agent-prompt">
            <span>System prompt <span className="hint">who this agent is and what it cares about</span></span>
            <textarea rows={8} value={profile.systemPrompt} onChange={(event) => set({ systemPrompt: event.target.value })} required maxLength={20_000} />
          </label>
          <div className="row">
            <button type="submit" className="primary" disabled={busy || !dirty || !profile.provider || !profile.model}>{saved ? "Save profile" : "Create profile"}</button>
            {dirty ? <span className="muted small">Unsaved changes</span> : null}
            {dirty && saved ? <button type="button" className="link small" onClick={() => setProfile(saved)}>Revert</button> : null}
            <ConfirmButton label="Disable this agent" confirm="Click again: this cannot be undone" className="link danger-link push" onConfirm={() => {
              api(`/users/${agent.userId}/disable`, { method: "POST" }).then(() => {
                invalidate(keys.agents(projectId));
                invalidate(keys.users);
                invalidate(keys.projects);
                invalidate("p");
                flash(`@${agent.handle} disabled`, "ok");
                navigate(path(projectId, "agents"), { replace: true });
              }, flashFailure);
            }} />
          </div>
        </form>
        <Credentials agent={agent} />
      </div>
    </div>
  );
}

function AgentSummaryPane({ agent }: { agent: AgentRecord }) {
  const { projectId } = useProject();
  const turns = useTurns(projectId, true);
  const working = (turns.data ?? []).some((turn) => turn.status === "running" && turn.agent === agent.handle);
  return (
    <div className="agent-pane">
      <PaneHeader
        before={<Avatar handle={agent.handle} working={working} />}
        title={<span className="handle">@{agent.handle}{working ? <Badge tone="busy">working</Badge> : null}</span>}
        lede={agent.provider && agent.model
          ? <>Answers as <code>{agent.provider}/{agent.model}</code>{agent.thinkingLevel && agent.thinkingLevel !== "off" ? ` · thinking ${agent.thinkingLevel}` : ""}</>
          : "Takes part from an external MCP client."}
      />
      <div className="card">
        <p>This agent is managed by <b>@{agent.ownerHandle ?? "the installation owner"}</b>.</p>
        <p className="muted small">It is installed in this project, so any project member can mention <b>@{agent.handle}</b> to invite a reply within the thread and project allowances.</p>
      </div>
    </div>
  );
}

function NewAgent({ first }: { first: boolean }) {
  const { projectId, isOwner } = useProject();
  const [handle, setHandle] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    api<{ user: User }>("/users", { method: "POST", json: { kind: "agent", handle } })
      .then(async ({ user }) => {
        if (isOwner) await api(`/projects/${projectId}/members`, { method: "POST", json: { userId: user.id } });
        invalidate(keys.agents(projectId));
        invalidate(keys.users);
        invalidate(keys.members(projectId));
        if (!isOwner) flash(`@${user.handle} created. The installation owner can now add it to this project.`, "ok");
        navigate(path(projectId, "agents", user.id));
      })
      .catch(flashFailure)
      .finally(() => setBusy(false));
  };
  return (
    <>
      <PaneHeader
        title={first ? "Your first agent" : "New agent"}
        lede={<>Agents are forum members. Mention one as <code>@handle</code> in a post and it reads the thread and answers with one post of its own. Who is working now is under “Agents” in the header.</>}
      />
      <form className="card form new-agent" onSubmit={submit}>
        <label>Handle <span className="hint">lowercase; it cannot be changed later</span>
          <input value={handle} onChange={(event) => setHandle(event.target.value.toLowerCase())} required pattern={HANDLE} maxLength={32} placeholder="skeptic" autoFocus spellCheck={false} />
        </label>
        <div className="row">
          <button type="submit" className="primary" disabled={busy || !handle}>Create agent</button>
          <span className="muted small">Next: give it a model and a system prompt.{isOwner ? " It will join this project now." : " The installation owner chooses which projects it joins."}</span>
        </div>
      </form>
    </>
  );
}

// ---------------------------------------------------------------------------------------------- shared settings

function ModelAccess() {
  const chatgpt = useChatgptAccess(true);
  const claude = useClaudeCodeAccess(true);
  const apiKeys = useModelApiKeys(true);
  const [apiProvider, setApiProvider] = useState("openrouter");
  const [apiKey, setApiKey] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const refreshChatgpt = () => invalidate(keys.chatgptAccess);
  const refreshClaude = () => api("/model-access/claude-code/refresh", { method: "POST" }).then(
    () => invalidate(keys.claudeCodeAccess),
    flashFailure,
  );
  const connectChatgpt = () => api<{ url: string }>("/model-access/chatgpt/sign-in", { method: "POST" }).then(
    ({ url }) => { window.location.href = url; },
    flashFailure,
  );
  const saveApiKey = (event: FormEvent) => {
    event.preventDefault();
    if (!apiProvider || !apiKey.trim()) return;
    setSavingKey(true);
    api(`/model-access/api-keys/${encodeURIComponent(apiProvider)}`, { method: "PUT", json: { key: apiKey.trim() } }).then(() => {
      setApiKey("");
      invalidate(keys.modelApiKeys);
      invalidate(keys.modelCatalog(apiProvider));
      flash("API key saved", "ok");
    }, flashFailure).finally(() => setSavingKey(false));
  };
  const configuredKeys = (apiKeys.data ?? []).filter((provider) => provider.configured);
  return (
    <>
      <PaneHeader title="Model access" lede="How this installation reaches the models its agents and the Scribe answer with. A provider's name says which of these a reply is billed to." />
      <div className="model-access-grid">
        <div className="card model-access-card">
          <div className="row">
            <strong>ChatGPT plan</strong>
            {chatgpt.data?.planUsage ? <Badge tone="good">connected</Badge>
              : chatgpt.data?.signedIn ? <Badge tone="bad">permission missing</Badge>
                : <Badge tone="quiet">not connected</Badge>}
          </div>
          {chatgpt.error ? <p className="small error-text">{describeError(chatgpt.error)}</p>
            : chatgpt.data?.signedIn ? <p className="small">{chatgpt.data.email ?? "ChatGPT account"}</p>
              : <p className="muted small">Connect an eligible ChatGPT plan without putting an OpenAI API key in Autoforum.</p>}
          <p className="muted small">Available to forum agents and the Scribe as provider <code>chatgpt</code>, and used for forum-agent web search.</p>
          <div className="row">
            <button type="button" className={chatgpt.data?.signedIn ? "small" : "primary small"} data-oai-siwc-button onClick={connectChatgpt}>
              {chatgpt.data?.signedIn ? "Connect again" : "Continue with ChatGPT"}
            </button>
            {chatgpt.data?.signedIn ? (
              <ConfirmButton label="Disconnect" confirm="Click again to disconnect" className="link danger-link" onConfirm={() => {
                api("/model-access/chatgpt/sign-out", { method: "POST" }).then(() => (refreshChatgpt(), flash("ChatGPT disconnected", "ok")), flashFailure);
              }} />
            ) : <button type="button" className="link small" onClick={refreshChatgpt}>Refresh</button>}
          </div>
        </div>
        <div className="card model-access-card">
          <div className="row">
            <strong>Claude Code</strong>
            {claude.data?.signedIn ? <Badge tone="good">signed in</Badge> : <Badge tone="quiet">not signed in</Badge>}
          </div>
          {claude.error ? <p className="small error-text">{describeError(claude.error)}</p>
            : claude.data?.signedIn ? <p className="small">{claude.data.email ?? "Claude account"}{claude.data.subscription ? ` · ${claude.data.subscription}` : ""}</p>
              : <p className="muted small">Install Claude Code, run <code>claude</code> in a host terminal, and sign in with <code>/login</code>.</p>}
          <p className="muted small">Available to the Scribe as provider <code>claude-code</code>. Autoforum never reads the Claude credential.</p>
          <div className="row">
            <button type="button" className="small" onClick={() => void refreshClaude()}>Check again</button>
          </div>
        </div>
        <div className="card model-access-card model-api-keys">
          <div className="row">
            <strong>Provider API keys</strong>
            <Badge tone={configuredKeys.length ? "good" : "quiet"}>{configuredKeys.length ? `${configuredKeys.length} set` : "none"}</Badge>
          </div>
          <p className="muted small">Saved only on this host. Autoforum never returns a saved key or sends it to a sandbox. An OpenAI key can also power forum-agent web search when ChatGPT is not connected.</p>
          {apiKeys.error ? <p className="small error-text">{describeError(apiKeys.error)}</p> : null}
          {configuredKeys.length ? (
            <ul className="links model-key-list">
              {configuredKeys.map((provider) => (
                <li className="row" key={provider.id}>
                  <span><b>{provider.name}</b> <span className="muted small">{provider.source === "stored" ? "saved by Autoforum" : provider.sourceLabel ?? "configured on the host"}</span></span>
                  {provider.source === "stored" ? (
                    <ConfirmButton label="Remove" confirm="Click again to remove" className="link danger-link push" onConfirm={() => {
                      api(`/model-access/api-keys/${encodeURIComponent(provider.id)}`, { method: "DELETE" }).then(() => {
                        invalidate(keys.modelApiKeys);
                        invalidate(keys.modelCatalog(provider.id));
                        flash(`${provider.name} key removed`, "ok");
                      }, flashFailure);
                    }} />
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          <form className="form model-key-form" autoComplete="off" onSubmit={saveApiKey}>
            <label>Provider
              <select value={apiProvider} onChange={(event) => setApiProvider(event.target.value)}>
                {(apiKeys.data ?? []).map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
              </select>
            </label>
            <label>API key
              <input type="password" autoComplete="off" spellCheck={false} value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="Paste once" />
            </label>
            <button type="submit" disabled={savingKey || !apiKey.trim()}>{savingKey ? "Saving…" : "Save key"}</button>
          </form>
          <p className="muted small">Keys from <code>.env</code> still work and can only be changed on the host.</p>
        </div>
      </div>
    </>
  );
}

function ScribeSettings({ agents }: { agents: AgentRecord[] }) {
  const { projectId, project } = useProject();
  const local = scribeModel.use();
  const saved: ScribeModel = project.scribeProvider && project.scribeModel
    ? { provider: project.scribeProvider, model: project.scribeModel, thinkingLevel: project.scribeThinkingLevel }
    : { provider: "", model: "", thinkingLevel: "off" };
  const initial = modelIsSet(saved) ? saved : local;
  const [draft, setDraft] = useState<ScribeModel>(initial);
  useEffect(() => setDraft(modelIsSet(saved) ? saved : local), [saved.provider, saved.model, saved.thinkingLevel, local]);
  const dirty = draft.provider !== saved.provider || draft.model !== saved.model || draft.thinkingLevel !== saved.thinkingLevel;
  return (
    <>
      <PaneHeader
        title="The Scribe"
        lede="Your assistant, in the panel beside every page (Ctrl+J): it reads the forum and sources, drafts posts for you to publish, and builds and runs things in the project sandbox. The saved model also powers each member's private research Scribe, which has no workspace access."
      />
      <div className="card scribe-settings">
        <ModelForm
          model={draft}
          agents={agents}
          showAgentShortcuts
          update={setDraft}
          save={{
            disabled: !dirty || !draft.provider || !draft.model,
            run: () => {
              api(`/projects/${projectId}/settings`, { method: "PATCH", json: { scribe: draft } }).then(() => {
                setScribeModel(draft);
                invalidate(keys.projects);
                flash("Scribe model saved for this project", "ok");
              }, flashFailure);
            },
          }}
        />
      </div>
    </>
  );
}

function Activity() {
  const { projectId } = useProject();
  const turns = useTurns(projectId, true);
  const list = turns.data ?? [];
  const active = list.filter(isActiveTurn);
  const pending = list.filter((turn) => turn.status === "pending");
  const finished = list.filter((turn) => !isActiveTurn(turn) && turn.status !== "pending");
  const used = list.reduce((sum, turn) => sum + turnTokens(turn), 0);
  const cost = list.reduce((sum, turn) => sum + (turn.reportedCost ?? 0), 0);
  return (
    <div className="activity-pane">
      <PaneHeader
        title="Activity"
        lede={turns.data
          ? <>The latest {plural(list.length, "turn")} in this project: {tokens(used)} tokens, {money(cost)} reported by providers. A turn has fixed limits on steps, tool calls, time, and output; a stopped or failed turn publishes nothing.</>
          : "The project's recent agent turns."}
      />
      {turns.error && !turns.data ? <Failure error={turns.error} /> : !turns.data ? <Loading /> : (
        <>
          {active.map((turn) => (
            <div className={`typing ${turn.status}`} key={turn.id}>
              <Avatar handle={turn.agent} working={turn.status === "running"} size="small" />
              <div className="typing-body">
                <b>@{turn.agent}</b> {turn.status === "running" ? "is writing a reply to" : "is queued for"} <a href={addressLink(projectId, `post:${turn.triggerLocalId}`)}>post:{turn.triggerLocalId}</a> <TurnThread projectId={projectId} turn={turn} />
                <div className="typing-meta">{turn.status === "running" ? <><Dots /> <Timer since={turn.startedAt ?? turn.createdAt} /> · </> : null}{turn.provider}/{turn.model}</div>
              </div>
              <button type="button" className="small" disabled={Boolean(turn.stopRequestedAt)} onClick={() => stopTurn(projectId, turn.id)}>{turn.stopRequestedAt ? "Stopping…" : turn.status === "running" ? "Stop" : "Cancel"}</button>
            </div>
          ))}
          {pending.length ? <p className="small muted">{plural(pending.length, "agent request")} waiting for approval in its thread.</p> : null}
          {finished.length ? <ul className="turn-log wide">{finished.map((turn) => <TurnLine key={turn.id} projectId={projectId} turn={turn} />)}</ul>
            : !active.length && !pending.length ? <Empty>No agent has been invited in this project yet. Mention one in a post.</Empty> : null}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- the page

const SETTINGS: Array<[section: string, label: string, icon: ReactNode]> = [
  ["access", "Model access", icons.key],
  ["scribe", "The Scribe", icons.quill],
  ["activity", "Activity", icons.result],
];

/** Why an agent is or is not answering here, in a few words. */
function standing(agent: AgentRecord): string {
  if (!agent.inProject) return "yours · not in this project";
  if (!agent.provider || !agent.model) return "external · MCP only";
  return `${agent.provider}/${agent.model}`;
}

function Nav({ agents, current }: { agents: AgentRecord[]; current: string }) {
  const { projectId, isOwner } = useProject();
  const turns = useTurns(projectId, true);
  const working = new Set((turns.data ?? []).filter((turn) => turn.status === "running").map((turn) => turn.agent));
  const active = (turns.data ?? []).filter(isActiveTurn).length;
  const item = (section: string) => ({
    href: link(projectId, "agents", section),
    "aria-current": current === section ? "page" as const : undefined,
  });
  return (
    <nav className="settings-nav" aria-label="Agents and their settings">
      <div className="settings-title">Agents</div>
      <div className="settings-group">Forum agents and yours</div>
      {agents.map((agent) => (
          <a key={agent.userId} className={`settings-item ${agent.inProject ? "" : "quiet"}`} {...item(String(agent.userId))}>
            <Avatar handle={agent.handle} size="small" working={working.has(agent.handle)} />
            <span className="settings-item-text"><b>@{agent.handle}</b><span>{standing(agent)}</span></span>
          </a>
      ))}
      <a className="settings-item add" {...item("new")}><span className="settings-icon">{icons.plus}</span> New agent</a>
      {isOwner ? <>
        <div className="settings-group">Installation settings</div>
        {SETTINGS.map(([section, label, icon]) => (
          <a key={section} className="settings-item" {...item(section)}>
            <span className="settings-icon">{icon}</span> {label}
            {section === "activity" && active ? <span className="count-badge push" title={`${plural(active, "turn")} queued or running`}>{active}</span> : null}
          </a>
        ))}
      </> : null}
    </nav>
  );
}

export default function Agents() {
  const { projectId, isOwner } = useProject();
  const route = useRoute();
  const agents = useAgents(projectId, true);
  useScribeModelDefault(agents.data, isOwner);

  const live = (agents.data ?? []).filter((agent) => !agent.disabledAt)
    .sort((left, right) => Number(right.inProject) - Number(left.inProject) || left.handle.localeCompare(right.handle));
  const section = route.segments[2];
  const chosen = section === undefined ? live[0] : live.find((agent) => String(agent.userId) === section);
  let current = section ?? "";
  let pane: ReactNode;
  if (section === "access" && isOwner) pane = <ModelAccess />;
  else if (section === "scribe" && isOwner) pane = <ScribeSettings agents={live} />;
  else if (section === "activity" && isOwner) pane = <Activity />;
  else if (section === "new") pane = <NewAgent first={false} />;
  else if (agents.error && !agents.data) pane = <Failure error={agents.error} />;
  else if (!agents.data) pane = <Loading />;
  else if (chosen) {
    current = String(chosen.userId);
    pane = chosen.canManage
      ? <AgentPane key={chosen.userId} agent={chosen} />
      : <AgentSummaryPane key={chosen.userId} agent={chosen} />;
  } else if (section === undefined) {
    current = "new";
    pane = <NewAgent first />;
  } else pane = <Empty>That agent does not exist, or has been disabled.</Empty>;

  return (
    <div className="settings">
      <Nav agents={live} current={current} />
      <section className="settings-pane" key={current}>{pane}</section>
    </div>
  );
}
