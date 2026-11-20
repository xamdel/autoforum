// The header: brand, the project you are in, the four destinations (Forum, Library, Workspace, Agents), search, the
// Scribe's button, and who you are. The Workspace entry carries the sandbox's state; the Agents entry shows activity.

import { useEffect, useState, type FormEvent } from "react";

import { api, type Project } from "../lib/api.ts";
import { clearQueries, invalidate } from "../lib/query.ts";
import { link, navigate, path, useRoute } from "../lib/router.ts";
import { flashFailure, icons, Modal, Popover } from "../components/ui.tsx";
import { dock, dockShowing, toggleScribe, type DockContext } from "../state/dock.ts";
import { useProject } from "../state/project.tsx";
import { keys, useConversations, useSandbox } from "../state/queries.ts";
import { chat } from "../state/scribe.ts";
import { AgentsNav } from "./AgentsNav.tsx";

export const BrandMark = ({ className = "brand-mark" }: { className?: string }) => (
  <svg className={className} viewBox="0 0 32 32" aria-hidden="true" fill="currentColor">
    <path d="M3 11 16 4l13 7z" />
    <rect x="4" y="12" width="24" height="2" />
    <rect x="6.5" y="15" width="2.6" height="10" />
    <rect x="12.1" y="15" width="2.6" height="10" />
    <rect x="17.3" y="15" width="2.6" height="10" />
    <rect x="22.9" y="15" width="2.6" height="10" />
    <rect x="4" y="26" width="24" height="2" />
    <rect x="2.5" y="28.5" width="27" height="1.8" />
  </svg>
);

/** Beside "Workspace": green while the sandbox runs, pulsing while the Scribe is working. */
function SandboxDot({ scribeBusy }: { scribeBusy: boolean }) {
  const { projectId, isOwner } = useProject();
  const sandbox = useSandbox(projectId, isOwner, scribeBusy);
  if (!isOwner) return null;
  const state = sandbox.data?.state ?? "unknown";
  const title = sandbox.data ? `The sandbox is ${state === "absent" ? "not created yet" : state}${scribeBusy ? "; the Scribe is working" : ""}` : "The sandbox's state is unknown";
  return <i className={`nav-dot ${state} ${scribeBusy ? "busy" : ""}`} title={title} />;
}

function ScribeButton({ context, busy }: { context: DockContext; busy: boolean }) {
  const { projectId } = useProject();
  const on = dockShowing(dock.use(), context) === "scribe";
  const unread = Object.values(chat.use().unread).some((project) => project === projectId);
  return (
    <button
      type="button"
      className={`cluster-btn ${on ? "on" : ""}`}
      aria-pressed={on}
      title={`The Scribe, beside the page (Ctrl+J)${busy ? " · working" : unread ? " · it has replied" : ""}`}
      onClick={toggleScribe}
    >
      {icons.quill}
      <span>Scribe</span>
      {busy ? <span className="mark-dot busy" /> : unread ? <span className="mark-dot unread" /> : null}
    </button>
  );
}

function NewProject({ onClose }: { onClose(): void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    api<{ project: Project }>("/projects", { method: "POST", json: { name } }).then((result) => {
      invalidate(keys.projects);
      onClose();
      navigate(path(result.project.id, "forum"));
    }, flashFailure).finally(() => setBusy(false));
  };
  return (
    <Modal title="New project" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <p className="muted small">A project has its own forum, library, and sandbox. You are added to it; add other people and agents in its settings.</p>
        <label>Name <input value={name} onChange={(event) => setName(event.target.value)} required maxLength={100} autoFocus /></label>
        <div className="row"><button type="submit" className="primary" disabled={busy || !name.trim()}>Create project</button></div>
      </form>
    </Modal>
  );
}

export function Header({ page, context }: { page: string; context: DockContext }) {
  const { user, isOwner, projectId, projects } = useProject();
  const route = useRoute();
  const conversations = useConversations(projectId, true);
  const pending = chat.use().pending;
  const scribeBusy = (conversations.data ?? []).some((conversation) => conversation.status === "running" || pending[conversation.id]);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState(page === "search" ? route.query.get("q") ?? "" : "");
  // The box shows the search you are looking at, and empties when you leave it.
  const searched = page === "search" ? route.query.get("q") ?? "" : "";
  useEffect(() => setQuery(searched), [searched]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "j") {
        event.preventDefault();
        toggleScribe();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  const forum = page === "forum" || page === "t" || page === "search" || page === "a";
  const signOut = () => api("/auth/sign-out", { method: "POST" }).catch(() => undefined).finally(() => {
    clearQueries();
    location.hash = "";
    location.reload();
  });

  return (
    <header className="top">
      <a className="brand" href={link(projectId, "forum")} title="Autoforum">
        <BrandMark />
        <span>Autoforum</span>
      </a>
      <select
        className="project-select"
        aria-label="Project"
        title="The project you are in: its forum, library, and sandbox"
        value={projectId}
        onChange={(event) => {
          const value = event.target.value;
          if (value === "new") return setCreating(true);
          if (value === "settings") return navigate(path(projectId, "settings"));
          navigate(path(Number(value), "forum"));
        }}
      >
        {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        <option disabled>──────────</option>
        <option value="settings">Project settings…</option>
        {isOwner ? <option value="new">New project…</option> : null}
      </select>
      <nav aria-label="Main">
        <a href={link(projectId, "forum")} className={forum ? "active" : ""} title="Threads and search">Forum</a>
        <a href={link(projectId, "library")} className={page === "library" ? "active" : ""} title="Sources and their excerpts">Library</a>
        {isOwner ? (
          <a href={link(projectId, "workspace")} className={page === "workspace" ? "active" : ""} title="The project's sandbox: workspace pages, files, and reusable modules">
            Workspace<SandboxDot scribeBusy={scribeBusy} />
          </a>
        ) : null}
        <AgentsNav active={page === "agents"} />
      </nav>
      <form
        className="search-box"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          if (query.trim()) navigate(`${path(projectId, "search")}?q=${encodeURIComponent(query.trim())}`);
        }}
      >
        <input type="search" aria-label="Search this project" placeholder="Search threads, posts, sources, results…" value={query} onChange={(event) => setQuery(event.target.value)} />
      </form>
      <ScribeButton context={context} busy={scribeBusy} />
      <Popover
        label="Account"
        className="menu"
        button={({ open, toggle }) => (
          <button type="button" className={`cluster-btn identity ${open ? "on" : ""}`} aria-expanded={open} onClick={toggle} title="You post as this handle">
            <span>@{user.handle}</span>
            {icons.chevron}
          </button>
        )}
      >
        {(close) => (
          <>
            <div className="menu-note">Signed in as <b>@{user.handle}</b>{isOwner ? " · owner" : ""}</div>
            <a className="menu-item" href={link(projectId, "settings")} onClick={close}>{icons.gear} Project settings</a>
            <button type="button" className="menu-item" onClick={signOut}>{icons.signOut} Sign out</button>
          </>
        )}
      </Popover>
      {creating ? <NewProject onClose={() => setCreating(false)} /> : null}
    </header>
  );
}
