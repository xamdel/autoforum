// A textarea that completes the two things posts are full of: "@" suggests the project's members (agents first),
// and "[[" suggests addresses: what is in the thread you are in, then threads and sources by title, then a full-text
// search once a few letters are typed. Arrow keys choose, Enter or Tab accepts, Escape closes.

import {
  useEffect, useLayoutEffect, useMemo, useRef, useState,
  type KeyboardEvent, type Ref, type TextareaHTMLAttributes,
} from "react";

import { api, type SearchHit, type Source, type ThreadSummary } from "../lib/api.ts";
import { peekQuery } from "../lib/query.ts";
import { useProject } from "../state/project.tsx";
import { keys } from "../state/queries.ts";
import { plainLine } from "./Markdown.tsx";
import { KindIcon } from "./ui.tsx";

export interface Suggestion {
  label: string;
  detail: string;
  insert: string;
  kind: string;
}

interface Trigger {
  type: "mention" | "reference";
  start: number;
  query: string;
}

function triggerAt(value: string, caret: number): Trigger | null {
  const before = value.slice(0, caret);
  const mention = /(?:^|[\s(])@([a-z0-9_-]{0,31})$/i.exec(before);
  if (mention) return { type: "mention", start: caret - mention[1]!.length - 1, query: mention[1]!.toLowerCase() };
  const reference = /\[\[([^\[\]\n]{0,60})$/.exec(before);
  if (reference) return { type: "reference", start: caret - reference[1]!.length - 2, query: reference[1]!.toLowerCase() };
  return null;
}

const matches = (suggestion: Suggestion, query: string) => !query || `${suggestion.label} ${suggestion.detail}`.toLowerCase().includes(query);

interface Props extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange" | "ref"> {
  value: string;
  onValue(next: string): void;
  /** Addresses close at hand (the open thread's posts and records), offered before anything else. */
  nearby?: Suggestion[];
  textareaRef?: Ref<HTMLTextAreaElement>;
}

export function SmartTextarea({ value, onValue, nearby, textareaRef, onKeyDown, onBlur, ...rest }: Props) {
  const { projectId, members } = useProject();
  const inner = useRef<HTMLTextAreaElement | null>(null);
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [index, setIndex] = useState(0);
  const [found, setFound] = useState<{ query: string; hits: Suggestion[] }>({ query: "", hits: [] });
  const [above, setAbove] = useState(false);
  const caretAfter = useRef<number | null>(null);

  const list = useMemo<Suggestion[]>(() => {
    if (!trigger) return [];
    if (trigger.type === "mention") {
      return members
        .map((member) => ({ label: `@${member.handle}`, detail: member.kind === "agent" ? "agent" : member.isOwner ? "owner" : "member", insert: `@${member.handle} `, kind: member.kind }))
        .filter((suggestion) => suggestion.label.slice(1).toLowerCase().includes(trigger.query))
        .sort((a, b) => Number(b.kind === "agent") - Number(a.kind === "agent") || Number(!a.label.slice(1).startsWith(trigger.query)) - Number(!b.label.slice(1).startsWith(trigger.query)))
        .slice(0, 8);
    }
    const threads = (peekQuery<ThreadSummary[]>(keys.threads(projectId)) ?? []).map((thread) => ({ label: thread.title, detail: thread.address, insert: `[[${thread.address}]]`, kind: "thread" }));
    const sources = (peekQuery<Source[]>(keys.sources(projectId)) ?? []).map((source) => ({ label: source.title, detail: source.address, insert: `[[${source.address}]]`, kind: "source" }));
    const seen = new Set<string>();
    return [...(nearby ?? []), ...threads, ...sources, ...(found.query === trigger.query ? found.hits : [])]
      .filter((suggestion) => matches(suggestion, trigger.query) && !seen.has(suggestion.insert) && Boolean(seen.add(suggestion.insert)))
      .slice(0, 9);
  }, [trigger, members, nearby, projectId, found]);

  // Full-text search fills in what the lists at hand do not have.
  const query = trigger?.type === "reference" ? trigger.query : "";
  useEffect(() => {
    if (query.length < 3 || /^[a-z]+:\d*$/.test(query)) return;
    const timer = window.setTimeout(() => {
      api<{ results: SearchHit[] }>(`/projects/${projectId}/search?q=${encodeURIComponent(query)}`).then((result) => {
        setFound({
          query,
          hits: result.results.slice(0, 8).map((hit) => ({
            label: plainLine(hit.heading || hit.snippet, 70) || hit.address,
            detail: hit.address,
            insert: `[[${hit.address}]]`,
            kind: hit.address.slice(0, hit.address.indexOf(":")),
          })),
        });
      }, () => undefined);
    }, 220);
    return () => window.clearTimeout(timer);
  }, [query, projectId]);

  useEffect(() => setIndex(0), [trigger?.type, trigger?.query]);

  useLayoutEffect(() => {
    if (caretAfter.current === null || !inner.current) return;
    inner.current.selectionStart = inner.current.selectionEnd = caretAfter.current;
    caretAfter.current = null;
  }, [value]);

  const inspect = (element: HTMLTextAreaElement) => {
    const next = element.selectionStart === element.selectionEnd ? triggerAt(element.value, element.selectionStart) : null;
    setTrigger(next);
    if (next) setAbove(element.getBoundingClientRect().bottom > window.innerHeight - 280);
  };

  const accept = (suggestion: Suggestion) => {
    const element = inner.current;
    if (!element || !trigger) return;
    const end = element.selectionStart;
    caretAfter.current = trigger.start + suggestion.insert.length;
    onValue(value.slice(0, trigger.start) + suggestion.insert + value.slice(end));
    setTrigger(null);
    element.focus();
  };

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (trigger && list.length) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setIndex((current) => (current + (event.key === "ArrowDown" ? 1 : list.length - 1)) % list.length);
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && !event.nativeEvent.isComposing) {
        event.preventDefault();
        accept(list[Math.min(index, list.length - 1)]!);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setTrigger(null);
        return;
      }
    }
    onKeyDown?.(event);
  };

  return (
    <div className="smart-textarea">
      <textarea
        {...rest}
        ref={(element) => {
          inner.current = element;
          if (typeof textareaRef === "function") textareaRef(element);
          else if (textareaRef) (textareaRef as { current: HTMLTextAreaElement | null }).current = element;
        }}
        value={value}
        onChange={(event) => {
          onValue(event.target.value);
          inspect(event.target);
        }}
        onKeyDown={keyDown}
        onKeyUp={(event) => {
          if (event.key.startsWith("Arrow") && !(trigger && list.length)) inspect(event.currentTarget);
        }}
        onClick={(event) => inspect(event.currentTarget)}
        onBlur={(event) => {
          window.setTimeout(() => setTrigger(null), 120);
          onBlur?.(event);
        }}
        aria-autocomplete="list"
      />
      {trigger && list.length ? (
        <ul className={`suggestions ${above ? "above" : ""}`} role="listbox">
          {list.map((suggestion, position) => (
            <li
              key={suggestion.insert}
              role="option"
              aria-selected={position === index}
              className={position === index ? "active" : ""}
              onMouseDown={(event) => {
                event.preventDefault();
                accept(suggestion);
              }}
              onMouseEnter={() => setIndex(position)}
            >
              <KindIcon kind={suggestion.kind} />
              <span className="suggestion-label">{suggestion.label}</span>
              <span className="suggestion-detail">{suggestion.detail}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
