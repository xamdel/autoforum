// One preview card for every [[address]] on the page. Rather than each reference carrying its own tooltip, the
// document is watched for the pointer (or keyboard focus) resting on any element with data-ref; the preview is
// fetched once per address and shown in a single card placed against the viewport, so it is never clipped by the
// column the reference happens to sit in.

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { useProject } from "../state/project.tsx";
import { usePreview } from "../state/queries.ts";
import { KindIcon } from "./ui.tsx";

interface Target {
  address: string;
  rect: DOMRect;
}

const SHOW_AFTER = 220;
const HIDE_AFTER = 140;

export function AddressCard() {
  const { projectId } = useProject();
  const [target, setTarget] = useState<Target | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const preview = usePreview(projectId, target?.address ?? null);

  useEffect(() => {
    let timer: number | undefined;
    const referenceAt = (node: EventTarget | null) => (node instanceof Element ? node.closest<HTMLElement>("[data-ref]") : null);
    const enter = (event: Event) => {
      const element = referenceAt(event.target);
      if (!element) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (element.isConnected) setTarget({ address: element.dataset.ref ?? "", rect: element.getBoundingClientRect() });
      }, SHOW_AFTER);
    };
    const leave = (event: Event) => {
      const next = (event as MouseEvent).relatedTarget;
      if (!referenceAt(event.target) && !card.current?.contains(event.target as Node)) return;
      if (next instanceof Node && (card.current?.contains(next) || referenceAt(next))) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setTarget(null), HIDE_AFTER);
    };
    const hide = () => {
      window.clearTimeout(timer);
      setTarget(null);
    };
    document.addEventListener("mouseover", enter);
    document.addEventListener("mouseout", leave);
    document.addEventListener("focusin", enter);
    document.addEventListener("focusout", hide);
    document.addEventListener("scroll", hide, true);
    document.addEventListener("click", hide, true);
    window.addEventListener("hashchange", hide);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("mouseover", enter);
      document.removeEventListener("mouseout", leave);
      document.removeEventListener("focusin", enter);
      document.removeEventListener("focusout", hide);
      document.removeEventListener("scroll", hide, true);
      document.removeEventListener("click", hide, true);
      window.removeEventListener("hashchange", hide);
    };
  }, []);

  // Below the reference when there is room, above it when there is not, and always inside the window.
  useLayoutEffect(() => {
    const element = card.current;
    if (!element || !target) return;
    const { rect } = target;
    const height = element.offsetHeight;
    const width = element.offsetWidth;
    const below = rect.bottom + 6 + height <= window.innerHeight - 8 || rect.top < height + 14;
    element.style.top = `${Math.max(8, below ? rect.bottom + 6 : rect.top - height - 6)}px`;
    element.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
  }, [target, preview.data, preview.error]);

  if (!target) return null;
  const kind = target.address.slice(0, target.address.indexOf(":"));
  return (
    <div className="address-card" ref={card} role="tooltip">
      <div className="address-card-kind"><KindIcon kind={kind} /> {target.address}</div>
      {preview.data ? (
        <>
          <strong className="address-card-heading">{preview.data.heading.replace(/\[\[([^\]]+)\]\]/g, "$1")}</strong>
          {preview.data.content ? <p className="address-card-body">{preview.data.content}</p> : null}
        </>
      ) : preview.error ? (
        <p className="muted small">Not found in this project.</p>
      ) : (
        <p className="muted small">…</p>
      )}
    </div>
  );
}
