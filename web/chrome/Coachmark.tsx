// Pointing at a part of the page: a bubble beside it and, for the tour, a spotlight that dims everything else. The
// target is found by a function rather than held as a ref, so the tour and the hints can point at the existing chrome
// (a header link, the Scribe's panel, a textarea) without those components knowing about either.

import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

export interface Rect { top: number; left: number; width: number; height: number }
export type Placement = "below" | "above" | "left";

/** Space between the target and the bubble, and the least space kept between the bubble and the window's edge. */
const GAP = 14;
const MARGIN = 12;

function measure(element: Element): Rect | null {
  const box = element.getBoundingClientRect();
  if (!box.width && !box.height) return null;
  return { top: Math.round(box.top), left: Math.round(box.left), width: Math.round(box.width), height: Math.round(box.height) };
}

const sameRect = (a: Rect, b: Rect) => a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height;

/** Whether any of the element shows in the window below the header. */
export function inView(element: Element): boolean {
  const box = element.getBoundingClientRect();
  const top = document.querySelector("header.top")?.getBoundingClientRect().bottom ?? 0;
  return box.height > 0 && box.bottom > top && box.top < window.innerHeight;
}

/** Where `find`'s element is. It is followed every frame while found, and looked for twice a second while not;
 *  `key` starts the search again at once (the tour's next step). */
export function useAnchor<T>(find: () => { element: Element; data: T } | null, active: boolean, key: unknown = null): { rect: Rect; data: T } | null {
  const finder = useRef(find);
  finder.current = find;
  const [anchor, setAnchor] = useState<{ rect: Rect; data: T } | null>(null);
  // A layout effect, so a new step's bubble is placed before it is first painted.
  useLayoutEffect(() => {
    if (!active) {
      setAnchor(null);
      return;
    }
    let frame = 0;
    let timer = 0;
    // Undefined until the first look, so a restarted search always replaces what the last one found.
    let last: { rect: Rect; data: T } | null | undefined;
    const tick = () => {
      const found = finder.current();
      const rect = found ? measure(found.element) : null;
      const next = found && rect ? { rect, data: found.data } : null;
      const unchanged = last !== undefined && (next && last ? sameRect(next.rect, last.rect) && Object.is(next.data, last.data) : next === last);
      if (!unchanged) setAnchor(next);
      last = next;
      if (next) frame = requestAnimationFrame(tick);
      else timer = window.setTimeout(tick, 500);
    };
    tick();
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [active, key]);
  return anchor;
}

type Side = Placement | "center";

/** Where a bubble of `size` goes beside `rect`: on the preferred side when it fits there, else on the roomier one. */
function place(rect: Rect | null, size: { width: number; height: number }, preferred: Placement) {
  const { innerWidth: width, innerHeight: height } = window;
  const { width: w, height: h } = size;
  const clampX = (x: number) => Math.max(MARGIN, Math.min(x, width - w - MARGIN));
  const clampY = (y: number) => Math.max(MARGIN, Math.min(y, height - h - MARGIN));
  const between = (value: number, low: number, high: number) => Math.max(low, Math.min(value, high));
  if (!rect) return { side: "center" as Side, top: clampY((height - h) / 2), left: clampX((width - w) / 2), arrow: 0 };

  const middleY = rect.top + rect.height / 2;
  if (preferred === "left" && rect.left - GAP - MARGIN >= w) {
    const top = clampY(middleY - 32);
    return { side: "left" as Side, top, left: rect.left - GAP - w, arrow: between(middleY - top, 18, h - 18) };
  }
  const roomBelow = height - (rect.top + rect.height) - GAP - MARGIN;
  const roomAbove = rect.top - GAP - MARGIN;
  const side: Side = preferred === "above"
    ? (roomAbove >= h || roomAbove >= roomBelow ? "above" : "below")
    : (roomBelow >= h || roomBelow >= roomAbove ? "below" : "above");
  const top = clampY(side === "below" ? rect.top + rect.height + GAP : rect.top - GAP - h);
  const left = clampX(rect.left + rect.width / 2 - w / 2);
  return { side, top, left, arrow: between(rect.left + rect.width / 2 - left, 18, w - 18) };
}

/** A bubble pointing at `rect`, or centred in the window when there is no rect. */
export function Bubble({ rect, placement = "below", labelledBy, modal = false, className = "", onKeyDown, children }: {
  rect: Rect | null;
  placement?: Placement;
  labelledBy: string;
  modal?: boolean;
  className?: string;
  onKeyDown?(event: KeyboardEvent<HTMLDivElement>): void;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const read = () => setSize((current) => current.width === element.offsetWidth && current.height === element.offsetHeight
      ? current
      : { width: element.offsetWidth, height: element.offsetHeight });
    read();
    const observer = new ResizeObserver(read);
    observer.observe(element);
    window.addEventListener("resize", read);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", read);
    };
  }, []);
  const at = place(rect, size, placement);
  return (
    <div
      ref={box}
      className={`coach-bubble at-${at.side} ${size.width ? "" : "measuring"} ${className}`}
      style={{ top: at.top, left: at.left }}
      role="dialog"
      aria-modal={modal || undefined}
      aria-labelledby={labelledBy}
      onKeyDown={onKeyDown}
    >
      {at.side === "center" ? null : <span className="coach-arrow" aria-hidden="true" style={at.side === "left" ? { top: at.arrow } : { left: at.arrow }} />}
      {children}
    </div>
  );
}

/** Dims the page except `rect`, and takes the page's clicks while the tour is showing. */
export function Spotlight({ rect }: { rect: Rect | null }) {
  return (
    <div className={`coach-layer ${rect ? "" : "dim"}`} aria-hidden="true">
      {rect ? <div className="coach-spot" style={{ top: rect.top - 6, left: rect.left - 6, width: rect.width + 12, height: rect.height + 12 }} /> : null}
    </div>
  );
}
