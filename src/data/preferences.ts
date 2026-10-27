import { useEffect, useMemo, useSyncExternalStore } from "react";

/** How each person wants the portal to look and behave. Saved per person on this device. */
export interface Preferences {
  theme: "light" | "night" | "system";
  textSize: "small" | "default" | "large" | "xlarge";
  density: "comfortable" | "compact";
  reduceMotion: boolean;
  /** "icons": the sidebar shows one icon per section; clicking it opens that section's pages. */
  menuStyle: "full" | "icons";
  /** Page opened after signing in ("/" = Home). */
  startPage: string;
  /** Home sections in the order the person wants them; unknown sections follow in their default order. */
  homeOrder: string[];
  homeHidden: string[];
  /** Menu links (by id) pinned at the top of the sidebar, in order. */
  favourites: string[];
  /** Home sections last shown to this person, so the settings page can list them. */
  knownHomeSections: { id: string; label: string }[];
}

export const DEFAULT_PREFERENCES: Preferences = {
  theme: "light",
  textSize: "default",
  density: "comfortable",
  reduceMotion: false,
  menuStyle: "icons",
  startPage: "/",
  homeOrder: [],
  homeHidden: [],
  favourites: [],
  knownHomeSections: [],
};

export const TEXT_SCALE: Record<Preferences["textSize"], number> = {
  small: 0.92,
  default: 1,
  large: 1.1,
  xlarge: 1.2,
};

const KEY = "kastech.prefs";
const LEGACY_THEME_KEY = "kastech.ess.theme";
const USER_KEY = "kastech.ess.user";

const listeners = new Set<() => void>();
const cache = new Map<string, Preferences>();

function storageKey(userId: string) {
  return `${KEY}.${userId}`;
}

function currentUserId(): string {
  try {
    return localStorage.getItem(USER_KEY) ?? "anonymous";
  } catch {
    return "anonymous";
  }
}

function read(userId: string): Preferences {
  const cached = cache.get(userId);
  if (cached) return cached;
  let prefs: Preferences = { ...DEFAULT_PREFERENCES };
  try {
    const raw = localStorage.getItem(storageKey(userId));
    if (raw) {
      prefs = { ...DEFAULT_PREFERENCES, ...(JSON.parse(raw) as Partial<Preferences>) };
    } else if (localStorage.getItem(LEGACY_THEME_KEY) === "night") {
      // Carry over the old device-wide night theme the first time.
      prefs = { ...prefs, theme: "night" };
    }
  } catch {
    /* storage blocked: defaults */
  }
  cache.set(userId, prefs);
  return prefs;
}

export function getPreferences(userId: string = currentUserId()): Preferences {
  return read(userId);
}

export function updatePreferences(userId: string, patch: Partial<Preferences>): void {
  const next = { ...read(userId), ...patch };
  cache.set(userId, next);
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(next));
  } catch {
    /* keep in memory for this session */
  }
  listeners.forEach((fn) => fn());
}

export function resetPreferences(userId: string): void {
  cache.set(userId, { ...DEFAULT_PREFERENCES, knownHomeSections: read(userId).knownHomeSections });
  try {
    localStorage.removeItem(storageKey(userId));
  } catch {
    /* ignore */
  }
  listeners.forEach((fn) => fn());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePreferences(userId: string): Preferences {
  return useSyncExternalStore(
    subscribe,
    () => read(userId),
    () => read(userId),
  );
}

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches;
}

/** Applies theme, text size, density and motion to the page for the signed-in person. */
export function useApplyPreferences(userId: string): Preferences {
  const prefs = usePreferences(userId);
  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      const dark = prefs.theme === "night" || (prefs.theme === "system" && systemPrefersDark());
      root.dataset.theme = dark ? "night" : "light";
    };
    apply();
    root.style.setProperty("--ui-scale", String(TEXT_SCALE[prefs.textSize]));
    root.dataset.density = prefs.density;
    root.dataset.motion = prefs.reduceMotion ? "reduced" : "full";
    if (prefs.theme !== "system") return;
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    media?.addEventListener("change", apply);
    return () => media?.removeEventListener("change", apply);
  }, [prefs.theme, prefs.textSize, prefs.density, prefs.reduceMotion]);
  return prefs;
}

/**
 * Orders a Home page's sections the way the person chose and drops hidden ones.
 * Also remembers which sections exist, so the Personalisation page can list them.
 */
export function useHomeLayout<T extends { id: string; label: string }>(userId: string, sections: T[]): T[] {
  const prefs = usePreferences(userId);
  const signature = sections.map((s) => `${s.id}:${s.label}`).join("|");
  useEffect(() => {
    const known = sections.map(({ id, label }) => ({ id, label }));
    const current = read(userId).knownHomeSections;
    if (current.map((s) => `${s.id}:${s.label}`).join("|") !== signature) {
      updatePreferences(userId, { knownHomeSections: known });
    }
    // signature captures the section list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, signature]);
  return useMemo(() => {
    const rank = (id: string) => {
      const i = prefs.homeOrder.indexOf(id);
      return i === -1 ? prefs.homeOrder.length + sections.findIndex((s) => s.id === id) : i;
    };
    return sections.filter((s) => !prefs.homeHidden.includes(s.id)).sort((a, b) => rank(a.id) - rank(b.id));
  }, [prefs.homeOrder, prefs.homeHidden, sections]);
}
