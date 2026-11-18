// The dock beside the page (state/dock.ts says what is in it). The page is a sibling of the dock, so opening it
// narrows the page instead of covering it; its left edge drags to resize and double-clicks back to the default.

import { lazy, Suspense, useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";

import { icons, Loading } from "../components/ui.tsx";
import {
  closeDockView, dock, dockShowing, hideScribe, selectDockTab, setDockWidth, type DockContext, type DockView,
} from "../state/dock.ts";
import { ScribeChat } from "./ScribeChat.tsx";

const Inspector = lazy(() => import("./Inspector.tsx"));

const viewLabel = (view: DockView) => (view.kind === "artifact" ? view.path.replace(/^artifacts\//, "") : view.address);

export function Dock({ context }: { context: DockContext }) {
  const state = dock.use();
  const showing = dockShowing(state, context);
  const view = context === "workspace" ? null : state.view;
  const element = useRef<HTMLElement>(null);

  useEffect(() => {
    document.body.classList.toggle("dock-open", Boolean(showing));
    return () => document.body.classList.remove("dock-open");
  }, [showing]);

  if (!showing) return null;

  const drag = (event: ReactPointerEvent) => {
    event.preventDefault();
    const aside = element.current;
    if (!aside) return;
    let width = aside.offsetWidth;
    const move = (pointer: PointerEvent) => {
      width = Math.max(340, Math.min(window.innerWidth - pointer.clientX, window.innerWidth - 420));
      aside.style.width = `${width}px`;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing");
      setDockWidth(width);
    };
    document.body.classList.add("resizing");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const both = Boolean(view) && state.scribe[context];
  return (
    <aside
      className="dock"
      ref={element}
      style={state.width ? { width: state.width } : undefined}
      aria-label="Side panel"
      onKeyDown={(event) => {
        // Escape closes the innermost thing first: a menu open inside the dock, then the dock.
        if (event.key !== "Escape" || event.defaultPrevented || event.currentTarget.querySelector(".popover")) return;
        if (showing === "view") closeDockView();
        else hideScribe();
      }}
    >
      <div className="dock-resize" onPointerDown={drag} onDoubleClick={() => setDockWidth(null)} title="Drag to resize; double-click to reset" />
      {both && view ? (
        <div className="dock-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={showing === "view"} className={showing === "view" ? "on" : ""} onClick={() => selectDockTab("view")}>
            <span className="dock-tab-label">{viewLabel(view)}</span>
          </button>
          <button type="button" role="tab" aria-selected={showing === "scribe"} className={showing === "scribe" ? "on" : ""} onClick={() => selectDockTab("scribe")}>
            {icons.quill} Scribe
          </button>
        </div>
      ) : null}
      {showing === "view" && view
        ? <Suspense fallback={<Loading />}><Inspector view={view} /></Suspense>
        : <ScribeChat />}
    </aside>
  );
}
