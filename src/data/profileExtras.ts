import { useSyncExternalStore } from "react";

/**
 * Employee-owned personal details that the core Employee record doesn't carry yet:
 * personal email, preferred name and an emergency contact. Kept per user id in this browser.
 */
export interface ProfileExtras {
  personalEmail: string;
  /** Name the person likes to be called; empty means "use the HR record". */
  preferredName: string;
  emergencyName: string;
  emergencyRelation: string;
  emergencyPhone: string;
}

const KEY = "timez.profile.extras.v1";

export const EMPTY_PROFILE_EXTRAS: ProfileExtras = {
  personalEmail: "",
  preferredName: "",
  emergencyName: "",
  emergencyRelation: "",
  emergencyPhone: "",
};

type Store = Record<string, ProfileExtras>;

let cache: Store | null = null;
const listeners = new Set<() => void>();

function readStore(): Store {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    cache = parsed && typeof parsed === "object" ? (parsed as Store) : {};
  } catch {
    cache = {};
  }
  return cache;
}

export function profileExtrasFor(userId: string): ProfileExtras {
  return { ...EMPTY_PROFILE_EXTRAS, ...readStore()[userId] };
}

export function saveProfileExtras(userId: string, extras: ProfileExtras) {
  const next: Store = {
    ...readStore(),
    [userId]: {
      personalEmail: extras.personalEmail.trim(),
      preferredName: (extras.preferredName ?? "").trim(),
      emergencyName: extras.emergencyName.trim(),
      emergencyRelation: extras.emergencyRelation.trim(),
      emergencyPhone: extras.emergencyPhone.trim(),
    },
  };
  cache = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage full or blocked — the values still apply for this session.
  }
  listeners.forEach((fn) => fn());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Live view of one user's personal details. */
export function useProfileExtras(userId: string): ProfileExtras {
  const store = useSyncExternalStore(subscribe, readStore, readStore);
  return { ...EMPTY_PROFILE_EXTRAS, ...store[userId] };
}
