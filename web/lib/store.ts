// A value outside React that components can read: a few lines instead of a state library.

import { useSyncExternalStore } from "react";

export interface Store<T> {
  get(): T;
  set(next: T | ((current: T) => T)): void;
  subscribe(listener: () => void): () => void;
  use(): T;
}

export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  };
  const get = () => value;
  return {
    get,
    set(next) {
      const resolved = typeof next === "function" ? (next as (current: T) => T)(value) : next;
      if (Object.is(resolved, value)) return;
      value = resolved;
      for (const listener of listeners) listener();
    },
    subscribe,
    use: () => useSyncExternalStore(subscribe, get),
  };
}

/** localStorage that never throws (private windows, blocked storage). */
export const remembered = {
  read<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  },
  write(key: string, value: unknown): void {
    try {
      if (value === null || value === undefined) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch { /* nothing to do */ }
  },
};

/** The same for the tab's session (drafts that should survive a reload but not a new window). */
export const forSession = {
  read<T>(key: string, fallback: T): T {
    try {
      const raw = sessionStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  },
  write(key: string, value: unknown): void {
    try {
      if (value === null || value === undefined) sessionStorage.removeItem(key);
      else sessionStorage.setItem(key, JSON.stringify(value));
    } catch { /* nothing to do */ }
  },
};
