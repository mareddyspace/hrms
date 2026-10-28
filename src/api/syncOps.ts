/**
 * Shared helpers for module stores that read from the backend (VITE_API_URL mode only).
 *
 * A mirror keeps API data in memory (never localStorage) in the store's own state shape. It loads when an
 * API session starts, reloads after each change, and empties on sign-out. Stores read the mirror instead of
 * their browser copy when API_ENABLED; with the backend off nothing here runs.
 */
import { API_ENABLED, ApiError, apiSessionAccount, onApiSession } from "./client.ts";

export { API_ENABLED };

export interface ApiMirror<T> {
  /** API data, or the empty value until the first load finishes. */
  get(): T;
  /** True once data for the current session has loaded. */
  loaded(): boolean;
  subscribe(listener: () => void): () => void;
  /** Load again (after a change). Resolves when done; errors are kept in lastError(). */
  reload(): Promise<void>;
  /** Replace the data in place (e.g. a single row came back from a mutation). */
  set(next: T): void;
  lastError(): string | null;
}

/**
 * Creates a mirror that loads with `load(accountId)` whenever an API session starts.
 * `empty()` is shown before the first load and after sign-out.
 */
export function createApiMirror<T>(empty: () => T, load: (accountId: string) => Promise<T>): ApiMirror<T> {
  let state: T = empty();
  let isLoaded = false;
  let error: string | null = null;
  let seq = 0;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((fn) => fn());

  async function reload() {
    const account = apiSessionAccount();
    if (!account) return;
    const mine = ++seq;
    try {
      const next = await load(account);
      if (mine !== seq || apiSessionAccount() !== account) return;
      state = next;
      isLoaded = true;
      error = null;
      emit();
    } catch (e) {
      if (mine !== seq) return;
      error = errorText(e);
      console.warn("API load failed", e);
      emit();
    }
  }

  if (API_ENABLED) {
    // Deferred so stores finish initialising before the first load.
    queueMicrotask(() =>
      onApiSession((account) => {
        if (account) {
          void reload();
        } else {
          seq += 1;
          state = empty();
          isLoaded = false;
          error = null;
          emit();
        }
      }),
    );
  }

  return {
    get: () => state,
    loaded: () => isLoaded,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reload,
    set(next) {
      state = next;
      emit();
    },
    lastError: () => error,
  };
}

/** One-line message for any thrown value. */
export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error && e.message) return e.message;
  return "That didn't work. Try again.";
}

/**
 * Runs an API change, then reloads the given mirrors. Resolves to null on success or the error message
 * (the same contract as the local stores' ComplianceResult).
 */
export async function apiRun(fn: () => Promise<unknown>, ...reload: { reload(): Promise<void> }[]): Promise<string | null> {
  try {
    await fn();
  } catch (e) {
    return errorText(e);
  } finally {
    await Promise.all(reload.map((m) => m.reload()));
  }
  return null;
}

/** Subscribe to several sources at once. */
export function subscribeAll(...sources: ((listener: () => void) => () => void)[]) {
  return (listener: () => void) => {
    const offs = sources.map((s) => s(listener));
    return () => offs.forEach((off) => off());
  };
}

/** "2026-10-28T09:00:00Z" → "2026-10-28". */
export function isoDay(value: string | null | undefined): string | undefined {
  return value ? value.slice(0, 10) : undefined;
}
