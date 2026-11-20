// Small shared pieces: icons, avatars, names, times, badges, two-click buttons, switches, menus, modals, notices.
// Their styles are in styles/base.css and styles/shell.css.

import {
  useEffect, useId, useRef, useState, useSyncExternalStore,
  type CSSProperties, type ReactNode, type RefObject,
} from "react";

import { ago, describeError, elapsed, exactTime } from "../lib/format.ts";
import { createStore } from "../lib/store.ts";

// ---------------------------------------------------------------------------------------------- icons

const line = (body: ReactNode, size = 18) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {body}
  </svg>
);

/** Line icons, drawn on a 24px grid. */
export const icons = {
  quill: line(<><path d="M20 4c-6.5 0-11.5 4-13.5 10.5L4 21l6.5-2.5C17 16.5 20 11 20 4z" /><path d="M5 19 13 11" /></>),
  search: line(<><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></>),
  pin: line(<path d="M9 3h6l-1 6 4 4H6l4-4-1-6zM12 13v8" />),
  pencil: line(<path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4" />),
  close: line(<path d="M6 6l12 12M18 6 6 18" />),
  plus: line(<path d="M12 5v14M5 12h14" />),
  chevron: line(<path d="m6 9 6 6 6-6" />, 14),
  caret: line(<path d="m9 6 6 6-6 6" />, 14),
  expand: line(<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />),
  external: line(<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />, 15),
  copy: line(<><rect x="9" y="9" width="11" height="11" rx="1.5" /><path d="M5 15V5a1 1 0 0 1 1-1h10" /></>, 15),
  check: line(<path d="m5 12.5 4.5 4.5L19 7.5" />, 15),
  glance: line(<path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />),
  people: line(<><circle cx="9" cy="8" r="3.2" /><path d="M3 20c.6-3.4 3-5 6-5s5.4 1.6 6 5M16 5.2a3.2 3.2 0 0 1 0 5.6M18 15.3c1.7.7 2.7 2.2 3 4.7" /></>),
  file: line(<path d="M7 3h7l5 5v13H7zM14 3v5h5" />, 16),
  folder: line(<path d="M3 6h6l2 2.5h10V19H3z" />, 16),
  play: line(<path d="M7 5v14l12-7z" />, 15),
  pause: line(<path d="M8 5v14M16 5v14" />, 15),
  stop: line(<rect x="6.5" y="6.5" width="11" height="11" rx="1" />, 15),
  refresh: line(<path d="M20 11a8 8 0 0 0-14.3-4M4 4v4h4M4 13a8 8 0 0 0 14.3 4M20 20v-4h-4" />, 16),
  download: line(<path d="M12 4v11M7.5 11 12 15.5 16.5 11M5 20h14" />, 16),
  signOut: line(<path d="M10 4H5v16h5M14 8l4 4-4 4M18 12H9" />, 16),
  key: line(<><circle cx="8" cy="15.5" r="4" /><path d="m11 12.5 8.5-8.5M16 7.5l2.5 2.5M13.5 10l2 2" /></>, 16),
  gear: line(<><circle cx="12" cy="12" r="2.8" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" /></>, 16),
  reply: line(<path d="M10 8 5 12.5 10 17M5 12.5h9a5 5 0 0 1 5 5V19" />, 15),
  chat: line(<path d="M4 5h16v11H9l-5 4z" />),
  bolt: line(<path d="M13 3 5 13.5h6L10 21l8-10.5h-6z" />, 15),
  // What a record is.
  thread: line(<path d="M4 5h16v11H9l-5 4z" />, 15),
  post: line(<path d="M5 5h14v11h-7l-4 3.5V16H5z" />, 15),
  question: line(<><circle cx="12" cy="12" r="8.5" /><path d="M9.6 9.6a2.5 2.5 0 1 1 3.6 2.2c-.8.4-1.2 1-1.2 1.9M12 17v.2" /></>, 15),
  claim: line(<path d="M12 3.5 20.5 12 12 20.5 3.5 12z" />, 15),
  evidence: line(<><circle cx="12" cy="12" r="8.5" /><path d="m8 12.3 2.8 2.8L16 9.6" /></>, 15),
  proposal: line(<path d="M9 3h6M10 3v6L4.5 19a1.5 1.5 0 0 0 1.3 2h12.4a1.5 1.5 0 0 0 1.3-2L14 9V3M7 15h10" />, 15),
  relation: line(<path d="M4 8h13M14 5l3 3-3 3M20 16H7M10 13l-3 3 3 3" />, 15),
  excerpt: line(<path d="M5 17c2 0 3.5-1.5 3.5-4V8H4.5v5H7M14.5 17c2 0 3.5-1.5 3.5-4V8h-4v5h2.5" />, 15),
  result: line(<path d="M4 20h16M7 20v-6M12 20V6M17 20v-9" />, 15),
  source: line(<path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h11" />, 15),
} as const;

export type IconName = keyof typeof icons;

const KIND_ICONS: Record<string, IconName> = {
  thread: "thread", post: "post", question: "question", claim: "claim", evidence: "evidence", proposal: "proposal",
  relation: "relation", rel: "relation", excerpt: "excerpt", result: "result", source: "source",
  agent: "bolt", human: "people",
};

/** The icon for a record's kind (an address prefix or a discourse-object kind). */
export const KindIcon = ({ kind }: { kind: string }) => <span className={`kind-icon kind-${kind === "relation" ? "rel" : kind}`}>{icons[KIND_ICONS[kind] ?? "post"]}</span>;

// ---------------------------------------------------------------------------------------------- people

const AVATAR_HUES = [8, 28, 44, 160, 200, 225, 300, 340];

export function Avatar({ handle, working = false, size }: { handle: string; working?: boolean; size?: "small" | "tiny" }) {
  const parts = handle.split(/[-_.]/).filter(Boolean);
  const initials = (parts.length > 1 ? parts[0]![0]! + parts[1]![0]! : handle.slice(0, 2)).toUpperCase();
  let hash = 0;
  for (const character of handle) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return (
    <span className={`avatar ${size ?? ""} ${working ? "working" : ""}`} style={{ "--hue": AVATAR_HUES[hash % AVATAR_HUES.length] } as CSSProperties} aria-hidden="true">
      {initials}
    </span>
  );
}

export const Who = ({ handle, kind }: { handle: string; kind?: string }) => (
  <span className={`who ${kind === "agent" ? "agent" : ""}`}>
    @{handle}
    {kind === "agent" ? <small>agent</small> : null}
  </span>
);

// ---------------------------------------------------------------------------------------------- time

// One clock for every relative time on the page, and one for every running timer; neither ticks unless read.
function ticker(interval: number) {
  let count = 0;
  let timer: number | undefined;
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    timer ??= window.setInterval(() => {
      count += 1;
      for (const each of listeners) each();
    }, interval);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) {
        window.clearInterval(timer);
        timer = undefined;
      }
    };
  };
  const snapshot = () => count;
  return () => useSyncExternalStore(subscribe, snapshot);
}
const useMinuteTick = ticker(30_000);
const useSecondTick = ticker(1_000);

export function Time({ at }: { at: string | null | undefined }) {
  useMinuteTick();
  return at ? <time dateTime={at} title={exactTime(at)}>{ago(at)}</time> : null;
}

/** A running clock since `since` (an ISO time or epoch milliseconds). */
export function Timer({ since }: { since: string | number }) {
  useSecondTick();
  const start = typeof since === "number" ? since : Date.parse(since);
  return <span className="timer">{elapsed(Date.now() - start)}</span>;
}

export const Dots = () => <span className="dots" aria-hidden="true"><i /><i /><i /></span>;

// ---------------------------------------------------------------------------------------------- small things

export const Badge = ({ tone, children }: { tone?: string; children: ReactNode }) => <span className={`badge ${tone ? `badge-${tone}` : ""}`}>{children}</span>;
export const Empty = ({ children }: { children: ReactNode }) => <div className="empty">{children}</div>;
export const Loading = ({ label = "Loading…" }: { label?: string }) => <div className="empty loading-note">{label}</div>;
export const Failure = ({ error }: { error: unknown }) => <div className="empty error">{describeError(error)}</div>;

export async function copyText(text: string, done = "Copied"): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    flash(done, "ok");
  } catch {
    flash("The browser refused to copy. Select the text and copy it yourself.");
  }
}

/** An address as a chip that copies its citation when clicked. */
export function AddressChip({ address, title }: { address: string; title?: string }) {
  return (
    <button type="button" className="address-chip" title={title ?? `Copy [[${address}]] to cite this`} onClick={() => void copyText(`[[${address}]]`, `Copied [[${address}]]`)}>
      {address}
    </button>
  );
}

/** Acts on the second click, so a stray click is harmless. */
export function ConfirmButton({ label, confirm, onConfirm, className = "link danger-link", icon, disabled }: {
  label: string; confirm: string; onConfirm(): void; className?: string; icon?: ReactNode; disabled?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), 4_000);
    return () => window.clearTimeout(timer);
  }, [armed]);
  const click = () => {
    if (!armed) return setArmed(true);
    setArmed(false);
    onConfirm();
  };
  if (icon) {
    return (
      <button type="button" className={`icon-button ${armed ? "armed" : ""}`} title={armed ? confirm : label} aria-label={armed ? confirm : label} onClick={click} disabled={disabled}>
        {icon}
        {armed ? <span className="armed-note">{confirm}</span> : null}
      </button>
    );
  }
  return (
    <button type="button" className={`${className} ${armed ? "armed" : ""}`} onClick={click} disabled={disabled}>
      {armed ? confirm : label}
    </button>
  );
}

/** An on/off switch that acts at once. With `children` it is a labelled line; without, pass `label` for assistive technology. */
export function Switch({ checked, onChange, label, title, disabled, children }: {
  checked: boolean; onChange(next: boolean): void; label?: string; title?: string; disabled?: boolean; children?: ReactNode;
}) {
  const control = (
    <button type="button" role="switch" className="toggle-switch" aria-checked={checked} aria-label={label} title={title} disabled={disabled} onClick={() => onChange(!checked)}>
      <span />
    </button>
  );
  return children ? <label className={`switch-line ${checked ? "" : "off"}`} title={title}>{control}<span>{children}</span></label> : control;
}

/** Closes something when the pointer goes down outside `ref`, or on Escape. */
export function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLElement | null>(null);
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) latest.current();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") latest.current();
    };
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", key);
    };
  }, [open]);
  return ref;
}

/** A button that opens a small menu or panel under itself. */
export function Popover({ button, className = "", align = "right", children, label }: {
  button: (state: { open: boolean; toggle(): void }) => ReactNode;
  className?: string;
  align?: "left" | "right";
  label: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  return (
    <span className="popover-anchor" ref={ref as RefObject<HTMLSpanElement>}>
      {button({ open, toggle: () => setOpen((value) => !value) })}
      {open ? <div className={`popover ${align} ${className}`} role="dialog" aria-label={label}>{children(() => setOpen(false))}</div> : null}
    </span>
  );
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose(): void; children: ReactNode; wide?: boolean }) {
  const heading = useId();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", key);
    const previous = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLElement>("[autofocus], input, textarea, select, button.primary")?.focus();
    return () => {
      window.removeEventListener("keydown", key);
      previous?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className={`modal card ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={heading} ref={box}>
        <header className="modal-head">
          <h2 id={heading}>{title}</h2>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>{icons.close}</button>
        </header>
        {children}
      </div>
    </div>
  );
}

/** The frame every dock panel shares: a title, a subtitle, actions, and close. */
export function PanelFrame({ label, title, sub, actions, onClose, children }: {
  label: string; title: ReactNode; sub?: ReactNode; actions?: ReactNode; onClose(): void; children: ReactNode;
}) {
  return (
    <section className="panel-frame" aria-label={label}>
      <header className="panel-head">
        <span className="panel-title">{title}</span>
        {sub ? <span className="panel-sub">{sub}</span> : null}
        <span className="panel-tools">
          {actions}
          <button type="button" className="icon-button" title="Close (Esc)" aria-label="Close" onClick={onClose}>{icons.close}</button>
        </span>
      </header>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------- notices

interface Notice {
  id: number;
  kind: "error" | "ok" | "info" | "agent";
  text: string;
  href?: string;
  onClick?: () => void;
}

const notices = createStore<Notice[]>([]);
let nextNotice = 1;

function post(notice: Omit<Notice, "id">, milliseconds: number): void {
  const id = nextNotice++;
  notices.set((list) => [...list.slice(-3), { ...notice, id }]);
  window.setTimeout(() => notices.set((list) => list.filter((each) => each.id !== id)), milliseconds);
}

/** A short notice in the corner: an outcome, or what went wrong. */
export const flash = (text: string, kind: "error" | "ok" | "info" = "error") => post({ kind, text }, kind === "error" ? 7_000 : 2_600);
export const flashFailure = (error: unknown) => flash(describeError(error));
/** A notice that goes somewhere when clicked (something an agent or the Scribe just did). */
export const notify = (text: string, target: { href?: string; onClick?: () => void }) => post({ kind: "agent", text, ...target }, 9_000);

export function Notices() {
  const list = notices.use();
  const dismiss = (id: number) => notices.set((all) => all.filter((each) => each.id !== id));
  return (
    <div id="notices" role="status" aria-live="polite">
      {list.map((notice) => notice.href || notice.onClick ? (
        <a key={notice.id} className="flash agent" href={notice.href ?? "#"} onClick={(event) => {
          if (notice.onClick) {
            event.preventDefault();
            notice.onClick();
          }
          dismiss(notice.id);
        }}>{notice.text}</a>
      ) : (
        <button type="button" key={notice.id} className={`flash ${notice.kind}`} onClick={() => dismiss(notice.id)}>{notice.text}</button>
      ))}
    </div>
  );
}

/** Grows a textarea with its text, up to the CSS max-height. */
export function useAutoGrow(value: string) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight + 2}px`;
  }, [value]);
  return ref;
}
