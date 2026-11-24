// Hash routing. The server serves one document at "/", so every page lives after the "#": a link is a plain
// <a href="#/3/t/12">, a reload always works, and nothing here needs the server's cooperation.
//
//   #/                         the last project used
//   #/<project>/forum          threads            #/<project>/t/<thread>?at=<address>
//   #/<project>/search?q=      search             #/<project>/a/<address>   wherever an address lives
//   #/<project>/library        sources            #/<project>/library/<source>
//   #/<project>/workspace      the sandbox        #/<project>/settings
//   #/<project>/agents         agents             #/<project>/agents/<agent | new | access | scribe | activity>
//   #/<project>/help           the member guide   #/<project>/help/<page>?at=<heading>

import { useSyncExternalStore } from "react";

export interface Route {
  /** The whole location after "#", used as a key. */
  key: string;
  /** Path segments, decoded: ["3", "t", "12"]. */
  segments: string[];
  query: URLSearchParams;
}

function parse(hash: string): Route {
  const raw = hash.replace(/^#/, "") || "/";
  const cut = raw.indexOf("?");
  const path = cut < 0 ? raw : raw.slice(0, cut);
  const segments = path.split("/").filter(Boolean).map((segment) => {
    try { return decodeURIComponent(segment); } catch { return segment; }
  });
  return { key: raw, segments, query: new URLSearchParams(cut < 0 ? "" : raw.slice(cut + 1)) };
}

let current = parse(location.hash);
const listeners = new Set<() => void>();
/** Whether the latest change was Back or Forward, so the page can return to where it was scrolled. */
let traversal = false;

function sync(): void {
  if (location.hash.replace(/^#/, "") === current.key || (!location.hash && current.key === "/")) return;
  current = parse(location.hash);
  for (const listener of listeners) listener();
}

window.addEventListener("hashchange", sync);
window.addEventListener("popstate", sync);
const navigation = (window as { navigation?: EventTarget }).navigation;
navigation?.addEventListener("navigate", (event) => {
  traversal = (event as Event & { navigationType?: string }).navigationType === "traverse";
});

export function useRoute(): Route {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  }, () => current);
}

export const currentRoute = (): Route => current;
export const wasTraversal = (): boolean => traversal;

/** Goes to `to` ("/3/forum"). `replace` rewrites the current entry instead of adding one. */
export function navigate(to: string, options: { replace?: boolean } = {}): void {
  const target = `#${to}`;
  if (target === location.hash) return;
  traversal = false;
  if (options.replace) {
    history.replaceState(history.state, "", target);
    sync();
  } else {
    location.hash = to;
  }
}

/** A path inside a project: link(3, "t", 12) is "#/3/t/12". */
export function link(projectId: number, ...parts: Array<string | number>): string {
  return `#/${projectId}${parts.length ? `/${parts.map((part) => encodeURIComponent(String(part))).join("/")}` : ""}`;
}

/** The same without "#", for navigate(). */
export function path(projectId: number, ...parts: Array<string | number>): string {
  return link(projectId, ...parts).slice(1);
}

/** Where an address lives: its thread when that is already known, otherwise the resolver page. */
export function addressLink(projectId: number, address: string): string {
  return `${link(projectId, "a")}/${encodeURIComponent(address)}`;
}
