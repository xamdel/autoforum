// The app: sign-in, then the header over the routed page with the dock beside it. The forum's own pages are part of
// the first load; the Library, Workspace, Agents, and settings pages are separate chunks fetched when first opened.

import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import "./styles/base.css";
import "./styles/shell.css";
import "./styles/forum.css";
import "./styles/chat.css";

import { AddressCard } from "./components/AddressCard.tsx";
import { Empty, Failure, flashFailure, Loading, Notices, notify } from "./components/ui.tsx";
import { BrandMark, Header } from "./chrome/Header.tsx";
import { Dock } from "./chrome/Dock.tsx";
import { api, onUnauthorized, type AgentTurn, type Project, type User } from "./lib/api.ts";
import { describeError } from "./lib/format.ts";
import { clearQueries, invalidate } from "./lib/query.ts";
import { addressLink, navigate, path, useRoute, wasTraversal } from "./lib/router.ts";
import { remembered } from "./lib/store.ts";
import { AddressPage } from "./pages/Address.tsx";
import { Home } from "./pages/Home.tsx";
import { SearchPage } from "./pages/Search.tsx";
import { ThreadPage } from "./pages/Thread.tsx";
import { closeDockView, dock, type DockContext } from "./state/dock.ts";
import { ProjectContext, type ProjectContextValue } from "./state/project.tsx";
import { isActiveTurn, keys, useMembers, useProjects, useTurns } from "./state/queries.ts";

const Library = lazy(() => import("./pages/Library.tsx"));
const SourcePage = lazy(() => import("./pages/Source.tsx"));
const Workspace = lazy(() => import("./pages/Workspace.tsx"));
const Agents = lazy(() => import("./pages/Agents.tsx"));
const Settings = lazy(() => import("./pages/Settings.tsx"));

const LAST_PROJECT = "autoforum.project";

function clearSignInToken(): void {
  if (location.hash.startsWith("#sign-in=")) history.replaceState(null, "", location.pathname + location.search);
}

function clearInviteToken(): void {
  if (location.hash.startsWith("#invite=")) history.replaceState(null, "", location.pathname + location.search);
}

function SignIn({ onSignedIn }: { onSignedIn(user: User): void }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setBusy(true);
    // A pasted link works as well as its token.
    const value = token.trim().replace(/^.*#sign-in=/, "");
    api<{ user: User }>("/auth/sign-in", { method: "POST", json: { token: decodeURIComponent(value) } })
      .then((result) => onSignedIn(result.user), (caught: unknown) => setError(describeError(caught)))
      .finally(() => setBusy(false));
  };
  return (
    <main className="sign-in">
      <section className="sign-in-plaque card">
        <BrandMark className="sign-in-mark" />
        <h1>Autoforum</h1>
        <p className="muted">Open a sign-in link from the installation's owner, or paste it here.</p>
        <form className="form" onSubmit={submit}>
          <label>Sign-in link or token <input value={token} onChange={(event) => setToken(event.target.value)} required autoFocus spellCheck={false} autoComplete="off" /></label>
          <button type="submit" className="primary" disabled={busy}>Sign in</button>
        </form>
        {error ? <p className="error-text" role="alert">{error}</p> : null}
      </section>
    </main>
  );
}

function ProjectInvite({ token, user, onJoined }: {
  token: string;
  user: User | null;
  onJoined(user: User, projectId: number): void;
}) {
  const [project, setProject] = useState<{ id: number; name: string } | null>(null);
  const [handle, setHandle] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ project: { id: number; name: string } }>(`/project-invites/${encodeURIComponent(token)}`)
      .then((result) => setProject(result.project), (caught: unknown) => setError(describeError(caught)));
  }, [token]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setBusy(true);
    api<{ user: User; project: { id: number; name: string } }>(`/project-invites/${encodeURIComponent(token)}/redeem`, {
      method: "POST",
      json: user ? {} : { handle },
    }).then((result) => onJoined(result.user, result.project.id), (caught: unknown) => setError(describeError(caught)))
      .finally(() => setBusy(false));
  };
  return (
    <main className="sign-in">
      <section className="sign-in-plaque card">
        <BrandMark className="sign-in-mark" />
        <h1>{project ? `Join ${project.name}` : "Project invitation"}</h1>
        {project ? (
          <form className="form" onSubmit={submit}>
            {user
              ? <p>You are signed in as <b>@{user.handle}</b>. This invitation adds you to the project.</p>
              : <label>Choose your handle
                  <input value={handle} onChange={(event) => setHandle(event.target.value.toLowerCase())} required pattern="[a-z][a-z0-9_\-]{1,31}" maxLength={32} autoFocus spellCheck={false} autoComplete="off" />
                </label>}
            <button type="submit" className="primary" disabled={busy || (!user && !handle)}>{busy ? "Joining…" : "Join project"}</button>
          </form>
        ) : !error ? <p className="muted">Checking the invitation…</p> : null}
        {error ? <p className="error-text" role="alert">{error}</p> : null}
      </section>
    </main>
  );
}

function FirstProject({ user, onCreated }: { user: User; onCreated(project: Project): void }) {
  const [name, setName] = useState("");
  if (!user.isOwner) {
    return (
      <main className="sign-in">
        <section className="sign-in-plaque card">
          <BrandMark className="sign-in-mark" />
          <h1>Welcome, @{user.handle}</h1>
          <p className="muted">You are not a member of any project yet. Ask the owner to add you to one.</p>
        </section>
      </main>
    );
  }
  return (
    <main className="sign-in">
      <section className="sign-in-plaque card">
        <BrandMark className="sign-in-mark" />
        <h1>Start a project</h1>
        <p className="muted">A project has its own forum, library, and sandbox.</p>
        <form className="form" onSubmit={(event) => {
          event.preventDefault();
          api<{ project: Project }>("/projects", { method: "POST", json: { name } }).then((result) => onCreated(result.project), flashFailure);
        }}>
          <label>Project name <input value={name} onChange={(event) => setName(event.target.value)} required maxLength={100} autoFocus /></label>
          <button type="submit" className="primary" disabled={!name.trim()}>Create project</button>
        </form>
      </section>
    </main>
  );
}

/** Turns that finish change what the forum shows: refresh the threads, and say so when the reply is elsewhere. */
function useTurnOutcomes(projectId: number, isOwner: boolean, openThread: number | null): void {
  const turns = useTurns(projectId, isOwner);
  const seen = useRef<{ project: number; active: Set<number> } | null>(null);
  useEffect(() => {
    const list = turns.data;
    if (!list) return;
    const active = new Set(list.filter(isActiveTurn).map((turn) => turn.id));
    const before = seen.current?.project === projectId ? seen.current.active : null;
    seen.current = { project: projectId, active };
    if (!before) return;
    const finished = list.filter((turn: AgentTurn) => before.has(turn.id) && !active.has(turn.id));
    if (!finished.length) return;
    invalidate(keys.threadsPrefix(projectId));
    invalidate(keys.projects);
    for (const turn of finished) {
      if (turn.status === "completed" && turn.outputLocalId && !openThread) {
        notify(`@${turn.agent} replied in post:${turn.outputLocalId}`, { href: addressLink(projectId, `post:${turn.outputLocalId}`) });
      } else if (turn.status === "failed") {
        notify(`@${turn.agent} could not reply to post:${turn.triggerLocalId}`, { href: addressLink(projectId, `post:${turn.triggerLocalId}`) });
      }
    }
  }, [turns.data, projectId, openThread]);
}

function Shell({ user, projects, project }: { user: User; projects: Project[]; project: Project }) {
  const route = useRoute();
  const page = route.segments[1] ?? "forum";
  const members = useMembers(project.id);
  const main = useRef<HTMLElement>(null);
  const positions = useRef(new Map<string, number>());
  const context: DockContext = page === "workspace" ? "workspace" : "elsewhere";
  const openThread = page === "t" ? Number(route.segments[2]) || null : null;

  const value = useMemo<ProjectContextValue>(() => {
    const list = members.data ?? [];
    return {
      user,
      isOwner: user.isOwner,
      project,
      projectId: project.id,
      projects,
      members: list,
      kinds: new Map(list.map((member) => [member.handle.toLowerCase(), member.kind])),
      kindById: new Map(list.map((member) => [member.id, member.kind])),
    };
  }, [user, project, projects, members.data]);

  useEffect(() => remembered.write(LAST_PROJECT, project.id), [project.id]);
  useEffect(() => {
    document.title = `${project.name} · Autoforum`;
  }, [project.name]);

  // A new page starts at its top; Back and Forward return to where the page was left. Only the path counts:
  // a change of query on the same page (?at= in a thread, ?tag= on the board) leaves the scroll where it is.
  const place = route.segments.join("/");
  useLayoutEffect(() => {
    const element = main.current;
    if (!element) return;
    const saved = wasTraversal() ? positions.current.get(place) : undefined;
    element.scrollTop = saved ?? 0;
    if (saved) requestAnimationFrame(() => { element.scrollTop = saved; });
  }, [place]);

  // What was opened from a thread closes when you leave that thread.
  useEffect(() => {
    const view = dock.get().view;
    if (!view) return;
    if (page === "workspace" || ("threadId" in view && view.threadId !== openThread)) closeDockView();
  }, [page, openThread, project.id]);

  useTurnOutcomes(project.id, true, openThread);

  let content: ReactNode;
  switch (page) {
    case "forum": content = <Home />; break;
    case "t": content = openThread ? <ThreadPage key={openThread} threadId={openThread} /> : <Empty>That thread does not exist.</Empty>; break;
    case "search": content = <SearchPage />; break;
    case "a": content = <AddressPage key={route.segments[2]} address={route.segments[2] ?? ""} />; break;
    case "library": content = Number(route.segments[2]) ? <SourcePage key={route.segments[2]} sourceId={Number(route.segments[2])} /> : <Library />; break;
    case "workspace": content = <Workspace />; break;
    case "agents": content = <Agents />; break;
    case "settings": content = <Settings />; break;
    default: content = <Empty>Page not found.</Empty>;
  }

  return (
    <ProjectContext.Provider value={value}>
      <Header page={page} context={context} />
      <div className="shell">
        <main
          id="page"
          ref={main}
          // The Workspace, and the owner's Agents page, fill the window and scroll inside themselves.
          className={page === "workspace" || (page === "agents" && user.isOwner) ? "full" : ""}
          onScroll={(event) => positions.current.set(place, event.currentTarget.scrollTop)}
        >
          <Suspense fallback={<Loading />}>{content}</Suspense>
        </main>
        <Dock context={context} />
      </div>
      <AddressCard />
    </ProjectContext.Provider>
  );
}

function App({ user }: { user: User }) {
  const route = useRoute();
  const projects = useProjects();
  const list = projects.data;
  const requested = Number(route.segments[0]);
  const project = list?.find((each) => each.id === requested);

  // "#/" (or a project you cannot see) goes to the project you were last in.
  useEffect(() => {
    if (!list?.length || project) return;
    const last = remembered.read<number | null>(LAST_PROJECT, null);
    const target = list.find((each) => each.id === last) ?? list[0]!;
    navigate(path(target.id, "forum"), { replace: true });
  }, [list, project]);

  if (projects.error && !list) return <main className="sign-in"><Failure error={projects.error} /></main>;
  if (!list) return <main className="loading-screen">Opening Autoforum…</main>;
  if (!list.length) return <FirstProject user={user} onCreated={(created) => (invalidate(keys.projects), navigate(path(created.id, "forum")))} />;
  if (!project) return <main className="loading-screen">Opening Autoforum…</main>;
  return <Shell key={project.id} user={user} projects={list} project={project} />;
}

function Root() {
  const [session, setSession] = useState<{ loading: boolean; user: User | null }>({ loading: true, user: null });
  const [inviteToken, setInviteToken] = useState(() => location.hash.startsWith("#invite=") ? decodeURIComponent(location.hash.slice("#invite=".length)) : null);

  useEffect(() => {
    onUnauthorized(() => {
      clearQueries();
      setSession({ loading: false, user: null });
    });
    const token = location.hash.startsWith("#sign-in=") ? decodeURIComponent(location.hash.slice("#sign-in=".length)) : null;
    if (token) clearSignInToken();
    const request = token
      ? api<{ user: User }>("/auth/sign-in", { method: "POST", json: { token } })
      : api<{ user: User }>("/auth/me");
    request.then(({ user }) => setSession({ loading: false, user }), () => setSession({ loading: false, user: null }));
  }, []);

  return (
    <>
      {session.loading
        ? <main className="loading-screen">Opening Autoforum…</main>
        : inviteToken
          ? <ProjectInvite token={inviteToken} user={session.user} onJoined={(user, projectId) => {
              clearInviteToken();
              clearQueries();
              setInviteToken(null);
              setSession({ loading: false, user });
              navigate(path(projectId, "forum"), { replace: true });
            }} />
        : session.user
          ? <App user={session.user} />
          : <SignIn onSignedIn={(user) => (clearSignInToken(), setSession({ loading: false, user }))} />}
      <Notices />
    </>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
createRoot(root).render(<Root />);
