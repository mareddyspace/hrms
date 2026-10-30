/** A small browser-saved store (local mode) with the useSyncExternalStore contract. */
export interface LocalStore<T> {
  get(): T;
  set(next: T): string | null;
  subscribe(listener: () => void): () => void;
  version(): number;
}

export function createLocalStore<T>(key: string, empty: () => T, revive?: (saved: unknown) => T | null): LocalStore<T> {
  let cache: T | null = null;
  let version = 0;
  const listeners = new Set<() => void>();

  function read(): T {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return empty();
      const parsed: unknown = JSON.parse(raw);
      return revive ? (revive(parsed) ?? empty()) : (parsed as T);
    } catch {
      return empty();
    }
  }

  // Another tab (another signed-in person in local mode) changed it.
  if (typeof window !== "undefined") {
    window.addEventListener("storage", (event) => {
      if (event.key !== key) return;
      cache = null;
      version += 1;
      listeners.forEach((fn) => fn());
    });
  }

  return {
    get() {
      if (!cache) cache = read();
      return cache;
    },
    set(next) {
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        return "Could not save. Please try again.";
      }
      cache = next;
      version += 1;
      listeners.forEach((fn) => fn());
      return null;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    version: () => version,
  };
}
