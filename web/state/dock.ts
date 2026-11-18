// The dock: one column on the right of every page. It holds the Scribe's chat and, beside a thread, whatever was
// opened from it (an artifact, a proposal, a result). When both are open they are two tabs of the same column, so
// opening one never throws the other away. The page reflows beside the dock; nothing floats over what you are reading.

import { currentRoute, navigate, path } from "../lib/router.ts";
import { createStore, remembered } from "../lib/store.ts";

export type DockView =
  | { kind: "artifact"; path: string }
  | { kind: "proposal"; address: string; threadId: number }
  | { kind: "result"; address: string; threadId: number };

/** The Scribe is open by default on the Workspace page and closed elsewhere; each is remembered on its own. */
export type DockContext = "workspace" | "elsewhere";

interface DockState {
  view: DockView | null;
  tab: "view" | "scribe";
  scribe: Record<DockContext, boolean>;
  /** A dragged width in pixels, or null for the stylesheet's. */
  width: number | null;
}

const SCRIBE_KEY = "autoforum.dock.scribe";
const WIDTH_KEY = "autoforum.dock.width";
/** Below this window width a dock would squeeze the page, so things open full-size instead. */
export const DOCK_MIN_WINDOW = 1_080;

export const dock = createStore<DockState>({
  view: null,
  tab: "scribe",
  scribe: { workspace: true, elsewhere: false, ...remembered.read<Partial<Record<DockContext, boolean>>>(SCRIBE_KEY, {}) },
  width: remembered.read<number | null>(WIDTH_KEY, null),
});

export const dockContext = (): DockContext => (currentRoute().segments[1] === "workspace" ? "workspace" : "elsewhere");

function setScribe(context: DockContext, open: boolean): void {
  dock.set((state) => {
    const scribe = { ...state.scribe, [context]: open };
    remembered.write(SCRIBE_KEY, scribe);
    return { ...state, scribe, tab: open ? "scribe" : state.view ? "view" : state.tab };
  });
}

/** What the dock shows right now, or null when it is closed. */
export function dockShowing(state: DockState, context: DockContext): "view" | "scribe" | null {
  const view = context === "workspace" ? null : state.view;
  const scribe = state.scribe[context];
  if (view && (state.tab === "view" || !scribe)) return "view";
  return scribe ? "scribe" : null;
}

export const showScribe = () => setScribe(dockContext(), true);
export const hideScribe = () => setScribe(dockContext(), false);

/** The header's button and Ctrl+J: bring the Scribe forward, or put it away if it is already in front. */
export function toggleScribe(): void {
  const context = dockContext();
  setScribe(context, dockShowing(dock.get(), context) !== "scribe");
}

export const selectDockTab = (tab: "view" | "scribe") => dock.set((state) => ({ ...state, tab }));
export const closeDockView = () => dock.set((state) => (state.view ? { ...state, view: null, tab: "scribe" } : state));
export const sameView = (a: DockView | null, b: DockView | null) => JSON.stringify(a) === JSON.stringify(b);

/** Opens something from a thread beside it. Opening what is already in front closes it. */
export function openDockView(view: DockView): void {
  dock.set((state) => (sameView(state.view, view) && state.tab === "view" ? { ...state, view: null, tab: "scribe" } : { ...state, view, tab: "view" }));
}

/** An artifact opens beside the page when the window has room, and on the Workspace page when it does not. */
export function openArtifact(projectId: number, artifactPath: string): void {
  if (window.innerWidth < DOCK_MIN_WINDOW || dockContext() === "workspace") openInWorkspace(projectId, artifactPath);
  else openDockView({ kind: "artifact", path: artifactPath });
}

/** The full view: the Workspace page with this file open. */
export function openInWorkspace(projectId: number, filePath: string): void {
  navigate(`${path(projectId, "workspace")}?file=${encodeURIComponent(filePath)}`);
}

export function setDockWidth(width: number | null): void {
  const clamped = width === null ? null : Math.round(Math.max(340, Math.min(width, window.innerWidth - 420)));
  remembered.write(WIDTH_KEY, clamped);
  dock.set((state) => ({ ...state, width: clamped }));
}
