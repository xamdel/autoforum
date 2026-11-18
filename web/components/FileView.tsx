// One workspace file, wherever it is shown (the Workspace page, or the dock beside a thread). Markdown is rendered
// with the forum's own components; images show as themselves; everything else is read-only text. An HTML artifact
// opens immediately through the sandbox's read-only artifact server, on a random origin isolated from the forum.

import { useEffect, useState, type ReactNode } from "react";

import "../styles/files.css";

import { api, ApiError, type WorkspaceFile } from "../lib/api.ts";
import { bytes, describeError } from "../lib/format.ts";
import { invalidate } from "../lib/query.ts";
import { useProject } from "../state/project.tsx";
import { keys, useFile, useSandbox } from "../state/queries.ts";
import { Markdown } from "./Markdown.tsx";
import { flashFailure, icons, Loading } from "./ui.tsx";

const MARKDOWN = /\.(?:md|markdown)$/i;
const HTML = /\.html?$/i;
const IMAGES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" };

export const isPage = (path: string) => HTML.test(path);
export const downloadHref = (projectId: number, path: string) => `/api/projects/${projectId}/workspace/download?path=${encodeURIComponent(path)}`;

export function startSandbox(projectId: number): Promise<void> {
  return api(`/projects/${projectId}/sandbox/start`, { method: "POST" }).then(() => {
    invalidate(keys.sandbox(projectId));
    invalidate(keys.workspace(projectId));
    invalidate(keys.serviceAccess(projectId));
  }, flashFailure);
}

/** Why a file cannot be shown, with what to do about it. */
function Unavailable({ error, path }: { error: Error; path: string }) {
  const { projectId } = useProject();
  const [starting, setStarting] = useState(false);
  const code = error instanceof ApiError ? error.code : error.message;
  if (code.includes("sandbox_not_running") || code.includes("sandbox_not_created")) {
    return (
      <div className="empty">
        <p>The sandbox is not running, so <code>{path}</code> cannot be read.</p>
        <button type="button" className="primary" disabled={starting} onClick={() => (setStarting(true), void startSandbox(projectId).finally(() => setStarting(false)))}>
          {starting ? "Starting…" : "Start the sandbox"}
        </button>
      </div>
    );
  }
  if (/ENOENT|not_found|no such file/i.test(code)) return <div className="empty">There is no <code>{path}</code> in the workspace (any more).</div>;
  return <div className="empty error">{describeError(error)}</div>;
}

/** The project-owned server on port 8080. This is separate from ordinary HTML artifacts. */
export function LiveApplication({ onClose }: { onClose?: () => void }) {
  const { projectId } = useProject();
  const [origin, setOrigin] = useState<string | null>(null);
  const [shown, setShown] = useState<string | null>(null);
  const [applicationPath, setApplicationPath] = useState("/");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    setBusy(true);
    setError("");
    setShown(null);
    api<{ url: string }>(`/projects/${projectId}/preview/launch`, { method: "POST" })
      .then((result) => {
        if (!active) return;
        setOrigin(new URL(result.url).origin);
        setShown(result.url);
        setApplicationPath("/");
      }, (caught: unknown) => active && setError(describeError(caught)))
      .finally(() => active && setBusy(false));
    return () => { active = false; };
  }, [projectId, reload]);

  const go = (target: string) => {
    if (!origin) return;
    let next: URL;
    try { next = new URL(target.startsWith("/") ? target : `/${target}`, origin); } catch { return; }
    if (next.origin !== origin) return;
    setApplicationPath(next.pathname + next.search);
    setShown(next.href);
  };

  return (
    <div className="live-view">
      <div className="file-bar small">
        <span className="live-on"><i className="nav-dot running" /> Application</span>
        <form className="live-path" onSubmit={(event) => (event.preventDefault(), go(applicationPath))}>
          <input value={applicationPath} onChange={(event) => setApplicationPath(event.target.value)} aria-label="Path in the application" title="A path in the application; Enter goes there" spellCheck={false} />
        </form>
        <span className="file-actions">
          <button type="button" className="link" disabled={busy} onClick={() => setReload((value) => value + 1)} title="Open it again from the start">{icons.refresh} Reload</button>
          {onClose ? <button type="button" className="link" onClick={onClose}>Close</button> : null}
        </span>
      </div>
      {shown ? (
        <iframe key={shown} title="Sandbox application" src={shown} sandbox="allow-scripts allow-same-origin allow-downloads" referrerPolicy="no-referrer" />
      ) : error ? (
        <div className="live-gate">
          <p className="error-text" role="alert">{error}</p>
          <button type="button" onClick={() => setReload((value) => value + 1)}>Try again</button>
        </div>
      ) : <Loading label="Opening the application…" />}
    </div>
  );
}

function ArtifactPreview({ path, running, extra, onSource }: {
  path: string; running: boolean | undefined; extra?: ReactNode; onSource(): void;
}) {
  const { projectId } = useProject();
  const [shown, setShown] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!running) return;
    let active = true;
    setShown(null);
    setError(null);
    api<{ url: string }>(`/projects/${projectId}/preview/launch`, { method: "POST", json: { artifact: path } })
      .then((result) => active && setShown(result.url), (caught: unknown) => {
        if (active) setError(caught instanceof Error ? caught : new Error(String(caught)));
      });
    return () => { active = false; };
  }, [path, projectId, reload, running]);

  return (
    <div className="artifact-view">
      <div className="file-bar small">
        <code className="file-path" title={path}>{path}</code>
        <span className="file-actions">
          {extra}
          <button type="button" className="link" onClick={onSource}>Source</button>
          <button type="button" className="link" disabled={!running} title="Reload the artifact" onClick={() => setReload((value) => value + 1)}>{icons.refresh}</button>
          <a href={downloadHref(projectId, path)} title="Download" aria-label="Download">{icons.download}</a>
        </span>
      </div>
      {running === undefined ? <Loading />
        : !running ? <Unavailable error={new Error("sandbox_not_running")} path={path} />
          : shown ? <iframe key={shown} title={`Artifact ${path}`} src={shown} sandbox="allow-scripts allow-same-origin allow-downloads" referrerPolicy="no-referrer" />
            : error ? <div className="empty"><p className="error-text">{describeError(error)}</p><button type="button" onClick={() => setReload((value) => value + 1)}>Try again</button></div>
              : <Loading label="Opening the artifact…" />}
    </div>
  );
}

function Body({ file, source }: { file: WorkspaceFile; source: boolean }) {
  const extension = file.path.split(".").pop()?.toLowerCase() ?? "";
  if (IMAGES[extension]) {
    const source = file.encoding === "base64"
      ? `data:${IMAGES[extension]};base64,${file.content}`
      : `data:${IMAGES[extension]};charset=utf-8,${encodeURIComponent(file.content)}`;
    return <div className="file-image-wrap"><img className="file-image" alt={file.path} src={source} /></div>;
  }
  if (file.encoding === "base64") return <div className="empty">A binary file of {bytes(file.size)}. Download it to open it.</div>;
  if (MARKDOWN.test(file.path) && !source) return <div className="doc"><Markdown text={file.content} /></div>;
  return <pre className="file-text">{file.content}</pre>;
}

/** A file with its bar: HTML preview, rendered Markdown or source, refresh, and download. */
export function FileView({ path, refreshEvery = null, extra }: { path: string; refreshEvery?: number | null; extra?: ReactNode }) {
  const { projectId, isOwner } = useProject();
  const sandbox = useSandbox(projectId, isOwner);
  const [source, setSource] = useState(false);
  const page = isPage(path);
  const file = useFile(projectId, page && !source ? null : path, refreshEvery);
  const markdown = MARKDOWN.test(path);

  if (page && !source) {
    return <ArtifactPreview path={path} running={sandbox.data ? sandbox.data.state === "running" : undefined} extra={extra} onSource={() => setSource(true)} />;
  }
  return (
    <div className="file-view">
      <div className="file-bar small">
        <code className="file-path" title={path}>{path}</code>
        {file.data ? <span className="muted">{bytes(file.data.size)}</span> : null}
        <span className="file-actions">
          {extra}
          {markdown ? <button type="button" className="link" onClick={() => setSource(!source)}>{source ? "Rendered" : "Source"}</button> : null}
          {page ? <button type="button" className="link" disabled={sandbox.data?.state !== "running"} onClick={() => setSource(false)}>{icons.play} Preview</button> : null}
          <button type="button" className="link" title="Read it again" onClick={() => void file.refetch()}>{icons.refresh}</button>
          <a href={downloadHref(projectId, path)} title="Download" aria-label="Download">{icons.download}</a>
        </span>
      </div>
      <div className="file-content">
        {file.data ? <Body file={file.data} source={source} />
          : file.error ? <Unavailable error={file.error} path={path} /> : <Loading />}
      </div>
    </div>
  );
}
