// What you are writing: one reply draft per thread and one new-thread draft per project. Drafts live outside the
// pages so the Scribe's chat and the Library can hand text to a composer, and so leaving a page (or reloading it)
// does not lose a half-written post. Nothing here is sent anywhere until you post it.

import { useCallback, useSyncExternalStore } from "react";

import type { ObjectKind, RelationType } from "../lib/api.ts";
import { forSession } from "../lib/store.ts";

export interface DraftObject {
  key: string;
  kind: ObjectKind;
  label: string;
  body: string;
  /** A proposal's expected outputs: result key and what it should hold. */
  outputs: Array<{ key: string; note: string }>;
  relationType: RelationType;
  subjects: string;
  objects: string;
}

export interface DraftExcerpt {
  key: string;
  source: string;
  content: string;
  locator: string;
}

export interface ReplyDraft {
  body: string;
  replyTo: string | null;
  objects: DraftObject[];
  excerpts: DraftExcerpt[];
}

export interface ThreadDraft {
  title: string;
  body: string;
  tags: string;
}

export const emptyReply = (): ReplyDraft => ({ body: "", replyTo: null, objects: [], excerpts: [] });
export const emptyThread = (): ThreadDraft => ({ title: "", body: "", tags: "" });
export const replyIsEmpty = (draft: ReplyDraft) => !draft.body.trim() && !draft.objects.length && !draft.excerpts.length;

const values = new Map<string, unknown>();
const listeners = new Map<string, Set<() => void>>();
const timers = new Map<string, number>();

function read<T>(key: string, fallback: () => T): T {
  if (!values.has(key)) values.set(key, forSession.read<T | null>(key, null) ?? fallback());
  return values.get(key) as T;
}

function write<T>(key: string, value: T, empty: boolean): void {
  values.set(key, value);
  for (const listener of listeners.get(key) ?? []) listener();
  window.clearTimeout(timers.get(key));
  timers.set(key, window.setTimeout(() => forSession.write(key, empty ? null : value), 400));
}

function useDraft<T>(key: string, fallback: () => T, isEmpty: (value: T) => boolean) {
  const subscribe = useCallback((listener: () => void) => {
    const set = listeners.get(key) ?? new Set();
    listeners.set(key, set);
    set.add(listener);
    return () => void set.delete(listener);
  }, [key]);
  const value = useSyncExternalStore(subscribe, () => read(key, fallback));
  const update = useCallback((next: T | ((current: T) => T)) => {
    const resolved = typeof next === "function" ? (next as (current: T) => T)(read(key, fallback)) : next;
    write(key, resolved, isEmpty(resolved));
  }, [key, fallback, isEmpty]);
  return [value, update] as const;
}

const replyKey = (projectId: number, threadId: number) => `autoforum.reply.${projectId}.${threadId}`;
const threadKey = (projectId: number) => `autoforum.thread.${projectId}`;
const threadIsEmpty = (draft: ThreadDraft) => !draft.title.trim() && !draft.body.trim() && !draft.tags.trim();

export const useReplyDraft = (projectId: number, threadId: number) => useDraft(replyKey(projectId, threadId), emptyReply, replyIsEmpty);
export const useThreadDraft = (projectId: number) => useDraft(threadKey(projectId), emptyThread, threadIsEmpty);

/** Adds text to a thread's reply draft (after what is already there). */
export function appendToReply(projectId: number, threadId: number, text: string): void {
  const key = replyKey(projectId, threadId);
  const draft = read(key, emptyReply);
  write(key, { ...draft, body: draft.body.trim() ? `${draft.body.trimEnd()}\n\n${text}` : text }, false);
}

/** Marks a thread's reply draft as answering one of its posts (null: the thread in general). */
export function setReplyTarget(projectId: number, threadId: number, address: string | null): void {
  const key = replyKey(projectId, threadId);
  const draft = read(key, emptyReply);
  write(key, { ...draft, replyTo: address }, replyIsEmpty(draft) && !address);
}

/** Starts (or extends) the project's new-thread draft. */
export function appendToThreadDraft(projectId: number, text: string): void {
  const key = threadKey(projectId);
  const draft = read(key, emptyThread);
  write(key, { ...draft, body: draft.body.trim() ? `${draft.body.trimEnd()}\n\n${text}` : text }, false);
}

/** Attaches an excerpt to a thread's reply draft (from the Library's reader). */
export function attachExcerpt(projectId: number, threadId: number, excerpt: Omit<DraftExcerpt, "key">): void {
  const key = replyKey(projectId, threadId);
  const draft = read(key, emptyReply);
  write(key, { ...draft, excerpts: [...draft.excerpts, { ...excerpt, key: nextKey("x", draft) }] }, false);
}

/** The first unused attachment key with this prefix: c1, c2, … */
export function nextKey(prefix: string, draft: ReplyDraft): string {
  const used = new Set([...draft.objects, ...draft.excerpts].map((item) => item.key));
  for (let index = 1; ; index += 1) if (!used.has(`${prefix}${index}`)) return `${prefix}${index}`;
}

// The thread you were last reading, so "use as a reply" in the chat and "excerpt this" in the Library know where to put text.
let lastThread: { projectId: number; threadId: number; title: string } | null = forSession.read("autoforum.lastThread", null);
export const recentThread = (projectId: number) => (lastThread?.projectId === projectId ? lastThread : null);
export function rememberThread(projectId: number, threadId: number, title: string): void {
  lastThread = { projectId, threadId, title };
  forSession.write("autoforum.lastThread", lastThread);
}
