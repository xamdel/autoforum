// One workspace file, wherever it is shown. Markdown is rendered with the forum's components; images show as
// themselves; everything else is read-only text. Browser pages are rendered by the image-owned workspace shell.

import { useEffect, useState, type ReactNode } from "react";

import "../styles/files.css";

import { api, ApiError, type WorkspaceFile } from "../lib/api.ts";
import { bytes, describeError } from "../lib/format.ts";
import { invalidate } from "../lib/query.ts";
import { useProject } from "../state/project.tsx";
import { keys, useFile } from "../state/queries.ts";
import { Markdown } from "./Markdown.tsx";
import { flashFailure, icons, Loading } from "./ui.tsx";

const MARKDOWN = /\.(?:md|markdown)$/i;
const IMAGES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" };

export const downloadHref = (projectId: number, path: string) => `/api/projects/${projectId}/workspace/download?path=${encodeURIComponent(path)}`;

export function startSandbox(projectId: number): Promise<void> {
  return api(`/projects/${projectId}/sandbox/start`, { method: "POST" }).then(() => {
    invalidate(keys.sandbox(projectId));
    invalidate(keys.workspace(projectId));
    invalidate(keys.serviceAccess(projectId));
  }, flashFailure);
}

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

/** The image-owned workspace shell, reached only through the isolated preview gateway. */
export function WorkspaceShell() {
  const { projectId } = useProject();
  const [shown, setShown] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    setError("");
    setShown(null);
    api<{ url: string }>(`/projects/${projectId}/preview/launch`, { method: "POST" })
      .then((result) => active && setShown(result.url), (caught: unknown) => active && setError(describeError(caught)));
    return () => { active = false; };
  }, [projectId, reload]);

  return (
    <div className="live-view">
      {shown ? (
        <iframe key={shown} title="Project workspace" src={shown} sandbox="allow-scripts allow-same-origin allow-downloads" referrerPolicy="no-referrer" />
      ) : error ? (
        <div className="live-gate">
          <p className="error-text" role="alert">{error}</p>
          <button type="button" onClick={() => setReload((value) => value + 1)}>Try again</button>
        </div>
      ) : <Loading label="Opening the workspace…" />}
    </div>
  );
}

function Body({ file, source }: { file: WorkspaceFile; source: boolean }) {
  const extension = file.path.split(".").pop()?.toLowerCase() ?? "";
  if (IMAGES[extension]) {
    const imageSource = file.encoding === "base64"
      ? `data:${IMAGES[extension]};base64,${file.content}`
      : `data:${IMAGES[extension]};charset=utf-8,${encodeURIComponent(file.content)}`;
    return <div className="file-image-wrap"><img className="file-image" alt={file.path} src={imageSource} /></div>;
  }
  if (file.encoding === "base64") return <div className="empty">A binary file of {bytes(file.size)}. Download it to open it.</div>;
  if (MARKDOWN.test(file.path) && !source) return <div className="doc"><Markdown text={file.content} /></div>;
  return <pre className="file-text">{file.content}</pre>;
}

export function FileView({ path, refreshEvery = null, extra }: { path: string; refreshEvery?: number | null; extra?: ReactNode }) {
  const { projectId } = useProject();
  const [source, setSource] = useState(false);
  const file = useFile(projectId, path, refreshEvery);
  const markdown = MARKDOWN.test(path);
  return (
    <div className="file-view">
      <div className="file-bar small">
        <code className="file-path" title={path}>{path}</code>
        {file.data ? <span className="muted">{bytes(file.data.size)}</span> : null}
        <span className="file-actions">
          {extra}
          {markdown ? <button type="button" className="link" onClick={() => setSource(!source)}>{source ? "Rendered" : "Source"}</button> : null}
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
