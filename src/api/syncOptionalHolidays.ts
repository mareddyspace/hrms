/** Optional holidays from the API (backend mode): the list per country and year, and HR's add / remove. */
import { api, onApiSession } from "./client.ts";
import { apiDelete } from "./syncShared.ts";

export interface OptionalHolidayOut {
  id: string;
  country_code: string;
  date: string;
  name: string;
  /** Open picks (pending or approved); filled for HR only. */
  picked_by: number;
}

const cache = new Map<string, OptionalHolidayOut[]>();
const loading = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

const keyOf = (country: string | null, year: number) => `${country ?? "me"}|${year}`;

// "me" lists belong to whoever is signed in: drop them when the account changes (no reload between sign-ins).
onApiSession(() => {
  if (cache.size === 0) return;
  cache.clear();
  emit();
});

function emit() {
  version += 1;
  for (const l of listeners) l();
}

export function subscribeApiOptional(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function apiOptionalVersion(): number {
  return version;
}

/** Cached list (empty until loaded); starts a load the first time. `country` null = the signed-in person's country. */
export function apiOptionalList(country: string | null, year: number): OptionalHolidayOut[] {
  const key = keyOf(country, year);
  const hit = cache.get(key);
  if (!hit && !loading.has(key)) void load(country, year);
  return hit ?? [];
}

async function load(country: string | null, year: number): Promise<void> {
  const key = keyOf(country, year);
  loading.add(key);
  try {
    const rows = await api.get<OptionalHolidayOut[]>("/leave/optional-holidays", { year, ...(country ? { country } : {}) });
    cache.set(key, rows);
  } catch (e) {
    console.warn("Optional holidays load failed", e);
    cache.set(key, []);
  } finally {
    loading.delete(key);
    emit();
  }
}

function reloadAll() {
  const keys = [...cache.keys()];
  cache.clear();
  for (const k of keys) {
    const [c, y] = k.split("|");
    void load(c === "me" ? null : c!, Number(y));
  }
}

export async function apiAddOptional(country: string, date: string, name: string): Promise<string | null> {
  try {
    await api.post("/leave/optional-holidays", { country_code: country, date, name: name.trim() });
    reloadAll();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : "Could not add the holiday.";
  }
}

export async function apiRemoveOptional(id: string): Promise<string | null> {
  try {
    await apiDelete(`/leave/optional-holidays/${encodeURIComponent(id)}`);
    reloadAll();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : "Could not remove the holiday.";
  }
}

/** Picks change who has picked what (HR counts); call after a leave request for an optional holiday. */
export function refreshApiOptional(): void {
  reloadAll();
}
