/**
 * A minimal shared store. The UI is many small windows, and the windows of
 * one tool (a scan's controls, its findings, its file types) are drawn
 * separately but show the same state, so that state lives here rather than
 * inside any one window.
 */
import { useSyncExternalStore } from "react";

export interface Store<T> {
  get: () => T;
  set: (update: (state: T) => T) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set: (update) => {
      const next = update(state);
      if (next === state) return;
      state = next;
      listeners.forEach((listener) => listener());
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * Read part of a store and re-render when it changes. `select` must return
 * something stable (a value already in the store, or a primitive).
 */
export function useStore<T, S>(store: Store<T>, select: (state: T) => S): S {
  return useSyncExternalStore(store.subscribe, () => select(store.get()));
}
