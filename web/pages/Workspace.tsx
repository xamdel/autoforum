// The Workspace: the project's sandbox, read-only from here. One bar across the top holds the sandbox's state and
// controls; under it, the artifacts and the file tree on the left and one thing at a time in the middle: the gallery
// of artifacts, a file, or the project-owned application. The Scribe's chat is docked on the right (it is the only thing that
// changes the workspace), so asking for a change and watching it land happen side by side.
//
//   #/<project>/workspace              the gallery
//   #/<project>/workspace?file=<path>  one file
//   #/<project>/workspace?live=1       the project-owned server on port 8080

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import "../styles/workspace.css";

import {
  api, ApiError,
  type ModelApiKeyProvider, type ServiceAccessStatus, type ResetPreview, type SandboxStatus, type WorkspaceEntry, type WorkspaceView,
} from "../lib/api.ts";
import { bytes, describeError, plural } from "../lib/format.ts";
import { invalidate } from "../lib/query.ts";
import { navigate, path, useRoute } from "../lib/router.ts";
import { FileView, LiveApplication, startSandbox } from "../components/FileView.tsx";
import { Badge, ConfirmButton, Empty, flash, flashFailure, icons, Loading, Modal, Popover, Switch } from "../components/ui.tsx";
import { useProject } from "../state/project.tsx";
import { keys, useConversations, useModelApiKeys, useSandbox, useServiceAccess, useTree, useUsage, useViews } from "../state/queries.ts";
import { askScribe, chat } from "../state/scribe.ts";

interface TreeNode {
  entry: WorkspaceEntry;
  children: TreeNode[];
}

function buildTree(entries: WorkspaceEntry[]): TreeNode[] {
  const nodes = new Map<string, TreeNode>(entries.map((entry) => [entry.path, { entry, children: [] }]));
  const roots: TreeNode[] = [];
  for (const node of nodes.values()) {
    const cut = node.entry.path.lastIndexOf("/");
    const parent = cut < 0 ? undefined : nodes.get(node.entry.path.slice(0, cut));
    (parent ? parent.children : roots).push(node);
  }
  const order = (list: TreeNode[]) => {
    list.sort((a, b) => Number(b.entry.kind === "directory") - Number(a.entry.kind === "directory") || a.entry.name.localeCompare(b.entry.name));
    for (const node of list) order(node.children);
  };
  order(roots);
  return roots;
}

function Tree({ nodes, depth, open, toggle, active, fresh, onOpen }: {
  nodes: TreeNode[]; depth: number; open: ReadonlySet<string>; toggle(path: string): void; active: string | null; fresh: ReadonlySet<string>; onOpen(path: string): void;
}) {
  return (
    <>
      {nodes.map(({ entry, children }) => entry.kind === "directory" ? (
        <div key={entry.path}>
          <button type="button" className={`tree-row dir ${entry.name.startsWith(".") ? "quiet" : ""}`} style={{ paddingLeft: `${depth * 0.8 + 0.5}rem` }} aria-expanded={open.has(entry.path)} onClick={() => toggle(entry.path)}>
            <span className={`tree-caret ${open.has(entry.path) ? "open" : ""}`}>{icons.caret}</span>{entry.name}
          </button>
          {open.has(entry.path) ? <Tree nodes={children} depth={depth + 1} open={open} toggle={toggle} active={active} fresh={fresh} onOpen={onOpen} /> : null}
        </div>
      ) : (
        <button
          type="button"
          key={entry.path}
          className={`tree-row ${active === entry.path ? "active" : ""} ${fresh.has(entry.path) ? "fresh" : ""} ${entry.name.startsWith(".") || entry.kind !== "regular" ? "quiet" : ""}`}
          style={{ paddingLeft: `${depth * 0.8 + 1.55}rem` }}
          title={`${entry.path}${entry.size === null ? "" : ` · ${bytes(entry.size)}`}`}
          disabled={entry.kind !== "regular"}
          onClick={() => onOpen(entry.path)}
        >
          {entry.name}
        </button>
      ))}
    </>
  );
}

function ResetDialog({ onClose }: { onClose(): void }) {
  const { projectId, project } = useProject();
  const [preview, setPreview] = useState<ResetPreview | null>(null);
  const [error, setError] = useState("");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<ResetPreview>(`/projects/${projectId}/sandbox/reset-preview`).then(setPreview, (caught: unknown) => setError(describeError(caught)));
  }, [projectId]);
  const reset = () => {
    setBusy(true);
    api(`/projects/${projectId}/sandbox`, { method: "DELETE", json: { confirmation: "RESET" } }).then(() => {
      invalidate(keys.sandbox(projectId));
      invalidate(keys.workspace(projectId));
      flash("The sandbox was reset", "ok");
      navigate(path(projectId, "workspace"), { replace: true });
      onClose();
    }, flashFailure).finally(() => setBusy(false));
  };
  return (
    <Modal title="Reset the sandbox" onClose={onClose}>
      <p>This permanently removes <b>{project.name}</b>'s workspace: every file, its Git history, installed packages, and caches. Results already imported into the forum stay.</p>
      {error ? <p className="error-text">{error}</p> : !preview ? <Loading label="Checking what would be lost…" /> : (
        <>
          <h4>Uncommitted changes</h4>
          {preview.dirty.length ? <pre className="reset-list">{preview.dirty.join("\n")}</pre> : <p className="muted small">None: the Git tree is clean.</p>}
          <h4>Commits that will be removed</h4>
          {preview.commits.length ? <pre className="reset-list">{preview.commits.join("\n")}</pre> : <p className="muted small">None.</p>}
        </>
      )}
      <form className="form reset-form" onSubmit={(event) => (event.preventDefault(), typed === "RESET" && reset())}>
        <label>Type RESET to confirm <input value={typed} onChange={(event) => setTyped(event.target.value)} autoFocus spellCheck={false} autoComplete="off" /></label>
        <div className="row">
          <button type="submit" className="danger" disabled={typed !== "RESET" || busy}>{busy ? "Resetting…" : "Reset the sandbox"}</button>
          <button type="button" className="link" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

type ServiceDraft = Omit<ServiceAccessStatus, "grantedUntil">;
type ServiceBusy = { name: string; label: string };

function grantIsActive(service: ServiceAccessStatus | undefined, now: number): boolean {
  return Boolean(service?.grantedUntil && Date.parse(service.grantedUntil) > now);
}

function grantCountdown(expiresAt: string | null | undefined, now: number): string {
  const seconds = Math.max(0, Math.ceil((Date.parse(expiresAt ?? "") - now) / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

const emptyServiceDraft = (): ServiceDraft => ({
  name: "",
  upstream: "",
  baseUrlEnv: "",
  credentialEnv: "",
  authHeader: "Authorization",
  authPrefix: "Bearer ",
});

function ServiceAccessMenu({ running }: { running: boolean }) {
  const { projectId } = useProject();
  const access = useServiceAccess(projectId, running);
  const modelKeys = useModelApiKeys(running);
  const [draft, setDraft] = useState<ServiceDraft | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [credential, setCredential] = useState("");
  const [busy, setBusy] = useState<ServiceBusy | null>(null);
  const [clock, setClock] = useState(Date.now());
  const services = access.data?.services ?? [];
  const modelProviders = (modelKeys.data ?? []).filter((provider) => (
    Boolean(provider.sandboxService && provider.configured)
    || services.some((service) => service.credentialSource?.provider === provider.id)
  ));
  const otherServices = services.filter((service) => !service.credentialSource);
  const grantSchedule = services.flatMap((service) => service.grantedUntil ? [service.grantedUntil] : []).join("|");
  useEffect(() => {
    setClock(Date.now());
    if (!grantSchedule) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [grantSchedule]);
  const activeServices = services.filter((service) => grantIsActive(service, clock));
  const active = activeServices.length;
  const nextExpiry = activeServices.reduce<string | null>((soonest, service) => (
    !soonest || Date.parse(service.grantedUntil!) < Date.parse(soonest) ? service.grantedUntil : soonest
  ), null);
  const refresh = () => access.refetch();
  const closeForm = () => {
    setDraft(null);
    setEditing(null);
    setCredential("");
  };
  const edit = (service: ServiceAccessStatus) => {
    setDraft({
      name: service.name,
      upstream: service.upstream,
      baseUrlEnv: service.baseUrlEnv,
      credentialEnv: service.credentialEnv,
      authHeader: service.authHeader,
      authPrefix: service.authPrefix,
    });
    setEditing(service.name);
    setCredential("");
  };
  const save = () => {
    if (!draft) return;
    const name = draft.name;
    const entered = credential.trim();
    setBusy({ name, label: "Saving..." });
    api(`/projects/${projectId}/service-access/${encodeURIComponent(name)}`, {
      method: "PUT",
      json: { service: draft, ...(entered ? { credential: entered } : {}) },
    }).then(async () => {
      closeForm();
      await refresh();
      flash(`${name} service saved`, "ok");
    }, flashFailure).finally(() => setBusy(null));
  };
  const allow = (name: string) => {
    setBusy({ name, label: "Starting..." });
    api(`/projects/${projectId}/service-access/${encodeURIComponent(name)}/grant`, { method: "POST" })
      .then(async () => {
        await refresh();
        flash(`${name} has service access for one hour`, "ok");
      }, flashFailure)
      .finally(() => setBusy(null));
  };
  const allowModel = (provider: ModelApiKeyProvider) => {
    const service = provider.sandboxService;
    if (!service) return;
    setBusy({ name: service.name, label: "Starting..." });
    api(`/projects/${projectId}/service-access/${encodeURIComponent(service.name)}`, {
      method: "PUT",
      json: { modelProvider: provider.id },
    }).then(() => api(
      `/projects/${projectId}/service-access/${encodeURIComponent(service.name)}/grant`,
      { method: "POST" },
    )).then(async () => {
      await refresh();
      flash(`${provider.name} model access is available for one hour`, "ok");
    }, flashFailure).finally(() => setBusy(null));
  };
  const revoke = (name: string) => {
    setBusy({ name, label: "Stopping..." });
    api(`/projects/${projectId}/service-access/${encodeURIComponent(name)}/grant`, { method: "DELETE" })
      .then(async () => {
        await refresh();
        flash(`${name} service access stopped`, "ok");
      }, flashFailure)
      .finally(() => setBusy(null));
  };

  if (!running || (!access.data && !access.error)) return null;
  return (
    <Popover
      label="Service access"
      className="service-access-popover"
      button={({ open, toggle }) => (
        <button
          type="button"
          className={`small service-access-trigger ${open ? "on" : ""} ${active ? "active" : ""}`}
          aria-expanded={open}
          onClick={toggle}
          title={active ? `${active} active; next grant expires in ${grantCountdown(nextExpiry, clock)}` : "Authenticated service access for sandbox code"}
        >
          <span className="service-access-bolt">{icons.bolt}</span> Service access
          {active ? <span className="service-access-countdown">{active > 1 ? `${active} / ` : ""}{grantCountdown(nextExpiry, clock)}</span> : null}
          {busy ? <span className="service-access-spinner" aria-label={busy.label} /> : null}
        </button>
      )}
    >
      {() => (
        <>
          <div className="service-access-title row">
            <strong>Service access</strong>
            <span className="row">
              {active ? <Badge tone="good">{active} active</Badge> : <Badge tone="quiet">off</Badge>}
              {!draft ? <button type="button" className="link small" onClick={() => setDraft(emptyServiceDraft())}>Add service</button> : null}
            </span>
          </div>
          <p className="muted small service-access-intro">Keys stay on this host. Each switch grants this sandbox access for one hour.</p>
          {access.error ? <p className="error-text small">{describeError(access.error)}</p> : null}
          {modelKeys.error ? <p className="error-text small">{describeError(modelKeys.error)}</p> : null}
          {modelProviders.length ? (
            <section className="service-access-group">
              <h4>Model APIs</h4>
              <div className="service-access-services">
                {modelProviders.map((provider) => {
                  const linked = services.find((candidate) => candidate.credentialSource?.provider === provider.id);
                  const service = provider.sandboxService ?? linked!;
                  const enabled = grantIsActive(linked, clock);
                  const keyAvailable = Boolean(provider.sandboxService && provider.configured);
                  const changing = busy?.name === service.name;
                  return (
                    <section className="service-access-service" key={provider.id}>
                      <header>
                        <span>
                          <strong>{provider.name}</strong>
                          <small title={service.upstream}><code>{service.baseUrlEnv}</code></small>
                        </span>
                        <span className="service-access-switch-line">
                          <span className={`service-access-state ${changing ? "working" : ""}`} aria-live="polite">
                            {changing ? <><span className="service-access-spinner" />{busy!.label}</> : enabled
                              ? grantCountdown(linked!.grantedUntil, clock)
                              : keyAvailable ? "Off" : "API key needed"}
                          </span>
                          <Switch
                            checked={enabled}
                            label={`${enabled ? "Disable" : "Enable"} ${provider.name} model access`}
                            disabled={changing || (!keyAvailable && !enabled)}
                            title={enabled ? "Stop access now" : keyAvailable ? "Allow access for one hour" : "Configure an API key in Settings first"}
                            onChange={(on) => on ? linked ? allow(linked.name) : allowModel(provider) : linked && revoke(linked.name)}
                          />
                        </span>
                      </header>
                      <div className="service-access-meta"><code>{service.credentialEnv}</code></div>
                    </section>
                  );
                })}
              </div>
            </section>
          ) : null}
          {draft ? (
            <form className="service-access-config" autoComplete="off" onSubmit={(event) => (event.preventDefault(), save())}>
              <label>Name
                <input required disabled={Boolean(editing)} pattern="[a-z][a-z0-9-]{0,63}" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="openrouter" />
              </label>
              <label className="wide">HTTPS upstream
                <input required type="url" value={draft.upstream} onChange={(event) => setDraft({ ...draft, upstream: event.target.value })} placeholder="https://api.example.com/v1" />
              </label>
              <label>Base URL variable
                <input required spellCheck={false} pattern="[A-Z_][A-Z0-9_]{0,127}" value={draft.baseUrlEnv} onChange={(event) => setDraft({ ...draft, baseUrlEnv: event.target.value })} placeholder="EXAMPLE_BASE_URL" />
              </label>
              <label>Credential variable
                <input required spellCheck={false} pattern="[A-Z_][A-Z0-9_]{0,127}" value={draft.credentialEnv} onChange={(event) => setDraft({ ...draft, credentialEnv: event.target.value })} placeholder="EXAMPLE_API_KEY" />
              </label>
              <label>Credential header
                <input required spellCheck={false} value={draft.authHeader} onChange={(event) => setDraft({ ...draft, authHeader: event.target.value })} />
              </label>
              <label>Credential prefix
                <input spellCheck={false} value={draft.authPrefix} onChange={(event) => setDraft({ ...draft, authPrefix: event.target.value })} placeholder="Bearer " />
              </label>
              <label className="wide">Credential
                <input
                  required={!editing}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={credential}
                  onChange={(event) => setCredential(event.target.value)}
                  placeholder={editing ? "Leave blank to keep the saved credential" : "Credential"}
                />
              </label>
              <div className="wide row service-access-form-actions">
                <button type="submit" className="small" disabled={Boolean(busy) || (!editing && !credential.trim())}>{busy?.label ?? "Save service"}</button>
                <button type="button" className="link small" onClick={closeForm}>Cancel</button>
              </div>
            </form>
          ) : null}
          {modelProviders.length && (otherServices.length || draft) ? <h4 className="service-access-subhead">Other services</h4> : null}
          <div className="service-access-services">
            {!modelProviders.length && !otherServices.length && !draft ? <p className="muted small">No authenticated services are configured for this project.</p> : null}
            {otherServices.map((service) => {
              const enabled = grantIsActive(service, clock);
              const changing = busy?.name === service.name;
              return (
                <section className="service-access-service" key={service.name}>
                  <header>
                    <span><strong>{service.name}</strong><small title={service.upstream}><code>{service.baseUrlEnv}</code></small></span>
                    <span className="service-access-switch-line">
                      <span className={`service-access-state ${changing ? "working" : ""}`} aria-live="polite">
                        {changing ? <><span className="service-access-spinner" />{busy!.label}</> : enabled ? grantCountdown(service.grantedUntil, clock) : "Off"}
                      </span>
                      <Switch
                        checked={enabled}
                        label={`${enabled ? "Disable" : "Enable"} ${service.name} authenticated service access`}
                        disabled={changing}
                        title={enabled ? "Stop access now" : "Allow access for one hour"}
                        onChange={(on) => on ? allow(service.name) : revoke(service.name)}
                      />
                    </span>
                  </header>
                  <div className="service-access-service-footer">
                    <span className="service-access-meta"><code>{service.credentialEnv}</code></span>
                    <span className="service-access-actions small">
                      <button type="button" className="link" onClick={() => edit(service)}>Edit</button>
                      <ConfirmButton label="Forget service" confirm="Click again to forget it" className="link danger-link" onConfirm={() => {
                        setBusy({ name: service.name, label: "Removing..." });
                        api(`/projects/${projectId}/service-access/${encodeURIComponent(service.name)}`, { method: "DELETE" })
                          .then(async () => {
                            await refresh();
                            flash(`${service.name} service removed`, "ok");
                          }, flashFailure)
                          .finally(() => setBusy(null));
                      }} />
                    </span>
                  </div>
                </section>
              );
            })}
          </div>
        </>
      )}
    </Popover>
  );
}

function Controls({ status }: { status: SandboxStatus | undefined }) {
  const { projectId } = useProject();
  const usage = useUsage(projectId, status?.state === "running");
  const [busy, setBusy] = useState(false);
  const [resetting, setResetting] = useState(false);
  const running = status?.state === "running";
  const stop = () => {
    setBusy(true);
    // Only the state is asked for again: a stopped sandbox has no files to read until it is started.
    api(`/projects/${projectId}/sandbox/stop`, { method: "POST" }).then(() => {
      invalidate(keys.sandbox(projectId));
      invalidate(keys.serviceAccess(projectId));
    }, flashFailure).finally(() => setBusy(false));
  };
  return (
    <div className="ws-tools">
      {usage.data && running ? <span className="muted ws-usage">{plural(usage.data.files, "file")} · {bytes(usage.data.bytes)}</span> : null}
      <ServiceAccessMenu running={running} />
      {running
        ? <ConfirmButton label="Stop" confirm="Click again to stop" className="small" disabled={busy} onConfirm={stop} />
        : <button type="button" className="primary small" disabled={busy || !status || !status.imageAvailable} onClick={() => (setBusy(true), void startSandbox(projectId).finally(() => setBusy(false)))}>{busy ? "Starting…" : "Start"}</button>}
      {status && status.state !== "absent" ? <button type="button" className="small danger" onClick={() => setResetting(true)}>Reset…</button> : null}
      {resetting ? <ResetDialog onClose={() => setResetting(false)} /> : null}
    </div>
  );
}

function Gallery({ views, applicationAvailable, onOpen, onOpenApplication }: {
  views: WorkspaceView[] | undefined;
  applicationAvailable: boolean;
  onOpen(path: string): void;
  onOpenApplication(): void;
}) {
  const { projectId } = useProject();
  const starters = [
    "Build a page under artifacts/ that ",
    "Write artifacts/notes.md summarizing ",
    "Implement the latest proposal and publish its outputs as a result. ",
  ];
  return (
    <div className="gallery">
      {!views ? <Loading /> : views.length || applicationAvailable ? (
        <div className="cards">
          {applicationAvailable ? (
            <button type="button" className="card-tile application-tile" title="Open the application running on port 8080" onClick={onOpenApplication}>
              <div className="tile-cover"><span className="tile-kind">{icons.play}</span></div>
              <div className="tile-text">
                <b>Application</b>
                <span className="small live-on"><i className="nav-dot running" /> running</span>
              </div>
            </button>
          ) : null}
          {views.map((view) => (
            <button type="button" className="card-tile" key={view.path} title={view.path} onClick={() => onOpen(view.path)}>
              <div className="tile-cover"><span className="tile-kind">{view.kind === "html" ? "</>" : "¶"}</span></div>
              <div className="tile-text">
                <b>{view.path.replace(/^artifacts\//, "")}</b>
                <span className="muted small">{view.kind === "html" ? "page" : "document"}{view.size === null ? "" : ` · ${bytes(view.size)}`}</span>
              </div>
            </button>
          ))}
        </div>
      ) : (
        <div className="gallery-empty">
          <span className="chat-intro-mark">{icons.artifact}</span>
          <h3>No artifacts yet</h3>
          <p className="muted">Documents and pages under <code>artifacts/</code> show here. Ask the Scribe, beside this page, to make one:</p>
          <div className="chat-starters">
            {starters.map((starter) => <button type="button" key={starter} onClick={() => askScribe(projectId, { text: starter })}>{starter.trimEnd()}…</button>)}
          </div>
        </div>
      )}
    </div>
  );
}

function Stopped({ status, error }: { status: SandboxStatus | undefined; error: Error | null }) {
  const { projectId } = useProject();
  const [busy, setBusy] = useState(false);
  if (error && !status) {
    const engine = error instanceof ApiError && error.status === 503;
    return <Empty>{engine ? "The container engine (Podman) is not reachable, so the sandbox's state is unknown." : describeError(error)}</Empty>;
  }
  if (!status) return <Loading />;
  return (
    <div className="gallery-empty">
      <span className="chat-intro-mark">{icons.folder}</span>
      <h3>{status.state === "absent" ? "This project's sandbox has not been started" : "The sandbox is stopped"}</h3>
      {status.imageAvailable ? (
        <>
          <p className="muted">{status.state === "absent" ? "Starting it creates an empty workspace with its own Git repository." : "Its files are kept. Start it to browse them, or to let the Scribe work in it."}</p>
          <button type="button" className="primary" disabled={busy} onClick={() => (setBusy(true), void startSandbox(projectId).finally(() => setBusy(false)))}>{busy ? "Starting…" : "Start the sandbox"}</button>
        </>
      ) : <p className="muted">The sandbox image has not been built on this machine. Run <code>npm run sandbox:build</code>, then start it here.</p>}
    </div>
  );
}

export default function Workspace() {
  const { projectId, isOwner } = useProject();
  const route = useRoute();
  const file = route.query.get("file");
  const live = route.query.get("live") === "1";
  const conversations = useConversations(projectId, isOwner);
  const pending = chat.use().pending;
  const scribeBusy = (conversations.data ?? []).some((conversation) => conversation.status === "running" || pending[conversation.id]);
  const sandbox = useSandbox(projectId, isOwner, true);
  const running = sandbox.data?.state === "running";
  const applicationAvailable = sandbox.data?.applicationAvailable === true;
  // While the Scribe works the tree is watched; otherwise it is read once and after each reply.
  const watch = scribeBusy ? 5_000 : null;
  const tree = useTree(projectId, isOwner && running, watch);
  const views = useViews(projectId, isOwner && running, watch);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(["artifacts"]));
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const known = useRef<Set<string> | null>(null);
  const nodes = useMemo(() => buildTree(tree.data ?? []), [tree.data]);

  // Files that were not there a moment ago are marked briefly, so what the Scribe just wrote is easy to spot.
  useEffect(() => {
    if (!tree.data) return;
    const paths = new Set(tree.data.filter((entry) => entry.kind === "regular").map((entry) => entry.path));
    const before = known.current;
    known.current = paths;
    if (!before) return;
    const added = [...paths].filter((each) => !before.has(each));
    if (!added.length || added.length > 200) return;
    setFresh(new Set(added));
    setOpen((current) => {
      const next = new Set(current);
      for (const each of added) {
        const parts = each.split("/");
        for (let depth = 1; depth < parts.length; depth += 1) next.add(parts.slice(0, depth).join("/"));
      }
      return next;
    });
    const timer = window.setTimeout(() => setFresh(new Set()), 3_500);
    return () => window.clearTimeout(timer);
  }, [tree.data]);

  // Opening a file reveals it in the tree.
  useEffect(() => {
    if (!file) return;
    setOpen((current) => {
      const parts = file.split("/");
      const next = new Set(current);
      for (let depth = 1; depth < parts.length; depth += 1) next.add(parts.slice(0, depth).join("/"));
      return next.size === current.size ? current : next;
    });
  }, [file]);

  if (!isOwner) {
    return (
      <div className="ws-closed">
        <Empty>The Workspace is the project sandbox: files, artifacts, and an optional server-backed application. In this version only the installation's owner can open it. What it produces reaches the forum as results and posts.</Empty>
      </div>
    );
  }

  const openFile = (target: string) => navigate(`${path(projectId, "workspace")}?file=${encodeURIComponent(target)}`);
  const toggle = (directory: string) => setOpen((current) => {
    const next = new Set(current);
    if (!next.delete(directory)) next.add(directory);
    return next;
  });
  const state = sandbox.data?.state;

  let stage: ReactNode;
  if (!running) stage = <Stopped status={sandbox.data} error={sandbox.error} />;
  else if (live && applicationAvailable) stage = <LiveApplication onClose={() => navigate(path(projectId, "workspace"))} />;
  else if (live) stage = <Empty>No server-backed application is answering on port 8080.</Empty>;
  else if (file) {
    stage = (
      <FileView
        key={file}
        path={file}
        refreshEvery={watch}
        extra={<button type="button" className="link" title="Ask the Scribe for a change to this file" onClick={() => askScribe(projectId, { text: `In \`${file}\`: ` })}>{icons.quill} Ask the Scribe</button>}
      />
    );
  } else stage = <Gallery
    views={views.data}
    applicationAvailable={applicationAvailable}
    onOpen={openFile}
    onOpenApplication={() => navigate(`${path(projectId, "workspace")}?live=1`)}
  />;

  return (
    <div className="ws">
      <header className="ws-bar small">
        <div className="ws-where">
          {file || live ? <button type="button" className="link" onClick={() => navigate(path(projectId, "workspace"))}>← Artifacts</button> : <span className="ws-title">Workspace</span>}
          <span className={`ws-state ${state ?? "unknown"}`}>
            <i className={`nav-dot dark ${state ?? "unknown"} ${scribeBusy ? "busy" : ""}`} />
            {state === "running" ? (scribeBusy ? "the Scribe is working in it" : "sandbox running") : state === "stopped" ? "sandbox stopped" : state === "absent" ? "no sandbox yet" : "…"}
          </span>
        </div>
        <Controls status={sandbox.data} />
      </header>
      <div className="ws-body">
        {running ? (
          <nav className="ws-rail" aria-label="Workspace files">
            <div className="rail-head">Artifacts</div>
            {applicationAvailable ? (
              <button type="button" className={`tree-row artifact application ${live ? "active" : ""}`} title="Application running on port 8080" onClick={() => navigate(`${path(projectId, "workspace")}?live=1`)}>
                <span className="application-icon">{icons.play}</span>Application <i className="nav-dot running" />
              </button>
            ) : null}
            {views.data?.length ? views.data.map((view) => (
              <button type="button" key={view.path} className={`tree-row artifact ${file === view.path ? "active" : ""} ${fresh.has(view.path) ? "fresh" : ""}`} title={view.path} onClick={() => openFile(view.path)}>
                <span className="tile-kind small">{view.kind === "html" ? "</>" : "¶"}</span>{view.path.replace(/^artifacts\//, "")}
              </button>
            )) : !applicationAvailable ? <p className="muted small rail-empty">{views.data ? "None yet." : "…"}</p> : null}
            <div className="rail-head">
              Files
              <button type="button" className="icon-button tiny" title="Read the tree again" aria-label="Refresh the file tree" onClick={() => invalidate(keys.workspace(projectId))}>{icons.refresh}</button>
            </div>
            {tree.error && !tree.data ? <p className="error-text small rail-empty">{describeError(tree.error)}</p>
              : !tree.data ? <p className="muted small rail-empty">…</p>
                : nodes.length ? <Tree nodes={nodes} depth={0} open={open} toggle={toggle} active={file} fresh={fresh} onOpen={openFile} />
                  : <p className="muted small rail-empty">The workspace is empty.</p>}
          </nav>
        ) : null}
        <section className="ws-stage">{stage}</section>
      </div>
    </div>
  );
}
