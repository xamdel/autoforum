// A small read cache. Each key holds the last answer, so a page shows what it already knows while it asks again.
// Refreshing is by interval (only while the tab is visible) or by invalidate() after a write. An answer identical to
// the one already held is dropped without notifying anyone, so a poll that finds nothing new renders nothing.

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

export interface QueryState<T> {
  data: T | undefined;
  error: Error | null;
  /** True only while the first answer is on its way; background refreshes do not flip it. */
  loading: boolean;
}

interface Entry<T> {
  state: QueryState<T>;
  listeners: Set<() => void>;
  fetcher: (() => Promise<T>) | null;
  inflight: Promise<void> | null;
  serial: number;
  raw: string | null;
  fetchedAt: number;
}

const entries = new Map<string, Entry<unknown>>();
const IDLE: QueryState<never> = { data: undefined, error: null, loading: false };
/** Mounting a second reader of a key this soon after an answer reuses it instead of asking again. */
const FRESH_MS = 1_500;

function entryFor<T>(key: string): Entry<T> {
  let entry = entries.get(key) as Entry<T> | undefined;
  if (!entry) {
    entry = { state: { data: undefined, error: null, loading: false }, listeners: new Set(), fetcher: null, inflight: null, serial: 0, raw: null, fetchedAt: 0 };
    entries.set(key, entry as Entry<unknown>);
  }
  return entry;
}

function publish<T>(entry: Entry<T>, state: QueryState<T>): void {
  entry.state = state;
  for (const listener of entry.listeners) listener();
}

function run<T>(entry: Entry<T>): Promise<void> {
  if (entry.inflight) return entry.inflight;
  const fetcher = entry.fetcher;
  if (!fetcher) return Promise.resolve();
  const serial = ++entry.serial;
  if (entry.state.data === undefined && !entry.state.loading) publish(entry, { data: undefined, error: null, loading: true });
  const request: Promise<void> = fetcher().then(
    (data) => {
      if (serial !== entry.serial) return;
      entry.fetchedAt = Date.now();
      const raw = JSON.stringify(data) ?? "undefined";
      if (raw === entry.raw && !entry.state.error && !entry.state.loading) return;
      // Keep the object readers already hold when only an error is being cleared.
      const same = raw === entry.raw && entry.state.data !== undefined;
      entry.raw = raw;
      publish(entry, { data: same ? entry.state.data : data, error: null, loading: false });
    },
    (error: unknown) => {
      if (serial !== entry.serial) return;
      entry.fetchedAt = Date.now();
      publish(entry, { data: entry.state.data, error: error instanceof Error ? error : new Error(String(error)), loading: false });
    },
  ).finally(() => {
    if (entry.inflight === request) entry.inflight = null;
  });
  entry.inflight = request;
  return request;
}

export interface QueryOptions<T> {
  /** Milliseconds between refreshes while this reader is mounted and the tab is visible; null or 0 for none. */
  every?: number | null | ((data: T | undefined) => number | null);
}

export interface QueryResult<T> extends QueryState<T> {
  refetch(): Promise<void>;
}

/** Reads `key` through `fetcher`. A null key reads nothing (use it while an input is not ready). */
export function useQuery<T>(key: string | null, fetcher: () => Promise<T>, options: QueryOptions<T> = {}): QueryResult<T> {
  const entry = key === null ? null : entryFor<T>(key);
  if (entry) entry.fetcher = fetcher;

  const subscribe = useCallback((listener: () => void) => {
    if (!entry) return () => undefined;
    entry.listeners.add(listener);
    return () => void entry.listeners.delete(listener);
  }, [entry]);
  const state = useSyncExternalStore(subscribe, () => (entry ? entry.state : IDLE as QueryState<T>));

  useEffect(() => {
    if (entry && Date.now() - entry.fetchedAt > FRESH_MS) void run(entry);
  }, [entry]);

  const every = options.every;
  const interval = typeof every === "function" ? every(state.data) : every;
  const intervalRef = useRef(interval);
  intervalRef.current = interval;
  const polling = Boolean(interval);
  useEffect(() => {
    if (!entry || !polling) return;
    let timer: number | undefined;
    const schedule = () => {
      window.clearTimeout(timer);
      const wait = intervalRef.current;
      if (!wait || document.visibilityState !== "visible") return;
      timer = window.setTimeout(() => void run(entry).then(schedule), Math.max(250, wait - (Date.now() - entry.fetchedAt)));
    };
    const visible = () => {
      if (document.visibilityState === "visible") schedule();
      else window.clearTimeout(timer);
    };
    schedule();
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
    // The interval itself is read through the ref, so a faster or slower cadence takes effect at the next tick.
  }, [entry, polling, interval]);

  const refetch = useCallback(() => (entry ? run(entry) : Promise.resolve()), [entry]);
  return { ...state, refetch };
}

/** Asks again for every key starting with `prefix` that someone is reading; the rest are asked when next read. */
export function invalidate(prefix: string): void {
  for (const [key, entry] of entries) {
    if (!key.startsWith(prefix)) continue;
    entry.fetchedAt = 0;
    if (entry.listeners.size) {
      entry.inflight = null;
      void run(entry);
    }
  }
}

/** Replaces what is held for `key` (after a write whose answer is the new value). */
export function setQueryData<T>(key: string, update: (current: T | undefined) => T | undefined): void {
  const entry = entryFor<T>(key);
  const data = update(entry.state.data);
  entry.serial += 1;
  entry.inflight = null;
  entry.raw = JSON.stringify(data) ?? "undefined";
  entry.fetchedAt = Date.now();
  publish(entry, { data, error: null, loading: false });
}

/** Reads what is held without subscribing. */
export function peekQuery<T>(key: string): T | undefined {
  return (entries.get(key) as Entry<T> | undefined)?.state.data;
}

/** Forgets everything (sign-out). */
export function clearQueries(): void {
  for (const entry of entries.values()) {
    entry.serial += 1;
    entry.inflight = null;
    entry.raw = null;
    entry.fetchedAt = 0;
    publish(entry, { data: undefined, error: null, loading: false });
  }
}
