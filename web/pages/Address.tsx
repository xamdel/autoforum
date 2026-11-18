// Where an address lives. A reference ([[claim:42]]) links here; this finds the thread (or Library page) that holds
// the record and goes there, marking it. If it cannot be placed, the record is shown on its own with what refers to it.

import { useEffect, useState } from "react";

import { api, ApiError, encodeAddress } from "../lib/api.ts";
import { addressLink, link, navigate, path } from "../lib/router.ts";
import { plainLine } from "../components/Markdown.tsx";
import { Empty, KindIcon, Loading } from "../components/ui.tsx";
import { useProject } from "../state/project.tsx";
import { useBacklinks, usePreview } from "../state/queries.ts";

const placed = new Map<string, string | null>();

/** A resolved address: the stored row, and the thread that shows it (a source has none). */
interface Resolved {
  record: Record<string, unknown>;
  threadId: number | null;
}

async function resolve(projectId: number, address: string): Promise<Resolved | null> {
  try {
    return await api<Resolved>(`/projects/${projectId}/address/${encodeAddress(address)}`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/** The page that shows `address`, or null when it exists nowhere this page can reach. */
export async function locate(projectId: number, address: string): Promise<string | null> {
  const key = `${projectId}/${address}`;
  if (placed.has(key)) return placed.get(key)!;
  const match = /^([a-z]+):(\d+)(#.+)?$/.exec(address);
  if (!match) return null;
  const [, prefix, number] = match;
  const base = `${prefix}:${number}`;
  const resolved = await resolve(projectId, base);
  let found: string | null = null;
  if (resolved && prefix === "source") found = path(projectId, "library", Number(resolved.record.row_id));
  else if (resolved?.threadId) {
    const thread = path(projectId, "t", resolved.threadId);
    found = prefix === "thread" ? thread : `${thread}?at=${encodeURIComponent(base)}`;
  }
  placed.set(key, found);
  return found;
}

export function AddressPage({ address }: { address: string }) {
  const { projectId } = useProject();
  const [state, setState] = useState<"looking" | "unplaced" | "missing">("looking");
  const preview = usePreview(projectId, state === "unplaced" ? address : null);
  const backlinks = useBacklinks(projectId, state === "unplaced" ? address.replace(/#.*$/, "") : null);

  useEffect(() => {
    let current = true;
    locate(projectId, address).then((target) => {
      if (!current) return;
      if (target) navigate(target, { replace: true });
      else setState("unplaced");
    }, () => current && setState("missing"));
    return () => { current = false; };
  }, [projectId, address]);

  if (state === "looking") return <Loading label={`Finding ${address}…`} />;
  if (state === "missing" || preview.error) {
    return <Empty>There is no <code>{address}</code> in this project. <a href={link(projectId, "forum")}>Back to the forum</a></Empty>;
  }
  if (!preview.data) return <Loading />;
  return (
    <div className="address-page">
      <div className="crumbs"><a href={link(projectId, "forum")}>Forum</a> › {address}</div>
      <h1><KindIcon kind={preview.data.kind} /> {plainLine(preview.data.heading, 200)}</h1>
      {preview.data.content ? <pre className="page-text">{preview.data.content}</pre> : null}
      <h3>Referenced by</h3>
      {backlinks.data?.length ? (
        <ul className="hits">
          {backlinks.data.map((backlink) => (
            <li key={backlink.address}>
              <a href={addressLink(projectId, backlink.address)} className="hit-title"><KindIcon kind={backlink.kind} /><strong>{backlink.address}</strong></a>
              <div className="snippet">{plainLine(backlink.label || backlink.body, 300)}</div>
            </li>
          ))}
        </ul>
      ) : <p className="muted small">Nothing refers to it yet.</p>}
    </div>
  );
}
