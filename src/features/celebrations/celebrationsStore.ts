/**
 * Celebrations: birthdays (day and month only), work anniversaries and new joiners, plus wishes.
 * Backend mode: GET /celebrations (the server leaves out hidden birthdays). Local mode: the browser directory
 * (src/data/peopleLocal.ts), the same rules as backend/app/routers/celebrations.py.
 * Wishes are kudos with value "Celebration" and no points (src/features/recognition/recognitionStore.ts).
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { API_ENABLED, api, apiRequest } from "../../api/client.ts";
import { listPeople, subscribePeople } from "../../data/peopleLocal.ts";
import { addDaysISO, todayISO } from "../../model.ts";
import {
  CELEBRATION_VALUE,
  getRecognitionState,
  postCelebrationKudos,
  reloadRecognition,
  subscribeRecognition,
} from "../recognition/recognitionStore.ts";
import type { PlusActor } from "../talentplus/shared.ts";

export type CelebrationKind = "birthday" | "anniversary" | "new_joiner";

export interface Celebration {
  employeeId: string;
  name: string;
  jobTitle: string;
  department: string;
  location: string;
  kind: CelebrationKind;
  /** This year's date (for a birthday only the day and month mean anything). */
  date: string;
  years?: number;
  wishedByMe: boolean;
}

export const KIND_LABEL: Record<CelebrationKind, string> = {
  birthday: "Birthday",
  anniversary: "Work anniversary",
  new_joiner: "New joiner",
};

const DEFAULT_WISH: Record<CelebrationKind, string> = {
  birthday: "Happy birthday! Have a great day.",
  anniversary: "Happy work anniversary! Thank you for everything.",
  new_joiner: "Welcome to the team! Glad to have you here.",
};

export const defaultWish = (kind: CelebrationKind) => DEFAULT_WISH[kind];

/** "4 Nov" — never the year. */
export function dayMonth(iso: string): string {
  const [, m, d] = iso.split("-").map(Number);
  return new Date(2000, m - 1, d).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export function celebrationText(c: Celebration): string {
  if (c.kind === "anniversary") return `${c.years} ${c.years === 1 ? "year" : "years"}`;
  if (c.kind === "new_joiner") return c.date > todayISO() ? `Joins ${dayMonth(c.date)}` : `Joined ${dayMonth(c.date)}`;
  return dayMonth(c.date);
}

/* ───────────── Hide my birthday (local mode) ───────────── */

const PREF_KEY = "timez.celebrations.hideBirthday.v1";
const prefListeners = new Set<() => void>();
let prefCache: Record<string, boolean> | null = null;

function readPrefs(): Record<string, boolean> {
  if (prefCache) return prefCache;
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(PREF_KEY) ?? "{}");
    prefCache = parsed && typeof parsed === "object" ? (parsed as Record<string, boolean>) : {};
  } catch {
    prefCache = {};
  }
  return prefCache;
}

function subscribePrefs(fn: () => void) {
  prefListeners.add(fn);
  return () => {
    prefListeners.delete(fn);
  };
}

export async function getHideBirthday(employeeId: string): Promise<boolean> {
  if (API_ENABLED) return (await api.get<{ hide_birthday: boolean }>("/celebrations/me/preferences")).hide_birthday;
  return Boolean(readPrefs()[employeeId]);
}

export async function setHideBirthday(employeeId: string, hide: boolean): Promise<string | null> {
  if (API_ENABLED) {
    try {
      await apiRequest("/celebrations/me/preferences", { method: "PUT", body: { hide_birthday: hide } });
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : "Could not save.";
    }
  }
  try {
    const next = { ...readPrefs(), [employeeId]: hide };
    localStorage.setItem(PREF_KEY, JSON.stringify(next));
    prefCache = next;
    prefListeners.forEach((fn) => fn());
    return null;
  } catch {
    return "Could not save. Please try again.";
  }
}

/* ───────────── Local list ───────────── */

function occurrenceIn(iso: string, start: string, end: string): string | null {
  const [, m, d] = iso.split("-").map(Number);
  for (const year of [Number(start.slice(0, 4)), Number(start.slice(0, 4)) + 1]) {
    const last = new Date(year, m, 0).getDate();
    const occ = `${year}-${String(m).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
    if (occ >= start && occ <= end) return occ;
  }
  return null;
}

function wishedIds(actorId: string): Set<string> {
  const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
  return new Set(
    getRecognitionState()
      .kudos.filter((k) => k.fromId === actorId && k.value === (CELEBRATION_VALUE as string) && k.createdAt >= since)
      .map((k) => k.toId),
  );
}

export function localCelebrations(actorId: string, days: number, today = todayISO()): Celebration[] {
  const start = addDaysISO(today, -1);
  const end = addDaysISO(today, days - 1);
  const hidden = readPrefs();
  const wished = wishedIds(actorId);
  const out: Celebration[] = [];
  for (const p of listPeople()) {
    if (p.employmentStatus === "Terminated" || !p.dateOfJoining || p.dateOfJoining > today) continue;
    const base = {
      employeeId: p.id,
      name: p.fullName,
      jobTitle: p.designation ?? "",
      department: p.department ?? "",
      location: p.location ?? "",
      wishedByMe: wished.has(p.id),
    };
    if (p.dateOfBirth && !hidden[p.id]) {
      const occ = occurrenceIn(p.dateOfBirth, start, end);
      if (occ) out.push({ ...base, kind: "birthday", date: occ });
    }
    const occ = occurrenceIn(p.dateOfJoining, start, end);
    const years = occ ? Number(occ.slice(0, 4)) - Number(p.dateOfJoining.slice(0, 4)) : 0;
    if (occ && years >= 1) out.push({ ...base, kind: "anniversary", date: occ, years });
    else if (p.dateOfJoining >= addDaysISO(today, -7)) out.push({ ...base, kind: "new_joiner", date: p.dateOfJoining });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}

/* ───────────── Hook ───────────── */

interface CelebrationApi {
  employee_id: string;
  name: string;
  job_title: string;
  department: string;
  location: string;
  kind: CelebrationKind;
  date: string;
  years: number | null;
  wished_by_me: boolean;
}

const fromApi = (c: CelebrationApi): Celebration => ({
  employeeId: c.employee_id,
  name: c.name,
  jobTitle: c.job_title,
  department: c.department,
  location: c.location,
  kind: c.kind,
  date: c.date,
  ...(c.years != null ? { years: c.years } : {}),
  wishedByMe: c.wished_by_me,
});

const noSubscribe = () => () => undefined;
let localTick = 0;
const bumpLocal = () => {
  localTick += 1;
};

function subscribeLocal(fn: () => void) {
  const changed = () => {
    bumpLocal();
    fn();
  };
  const offs = [subscribePeople(changed), subscribeRecognition(changed), subscribePrefs(changed)];
  return () => offs.forEach((off) => off());
}

/** Celebrations from yesterday to `days` ahead, for the signed-in person. */
export function useCelebrations(actorId: string, days: number) {
  useSyncExternalStore(API_ENABLED ? noSubscribe : subscribeLocal, () => (API_ENABLED ? 0 : localTick));
  const [apiRows, setApiRows] = useState<Celebration[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!API_ENABLED) return;
    try {
      setApiRows((await api.get<CelebrationApi[]>("/celebrations", { days })).map(fromApi));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load celebrations.");
    }
  }, [days]);
  useEffect(() => {
    void load();
  }, [load]);
  const rows = API_ENABLED ? (apiRows ?? []) : localCelebrations(actorId, days);
  return { rows, loading: API_ENABLED && apiRows === null && !error, error, reload: load };
}

/** Sends wishes (a kudos on the wall, no points). */
export async function sendWish(actor: PlusActor, c: Celebration, message: string): Promise<string | null> {
  const text = message.trim().replace(/\s+/g, " ") || DEFAULT_WISH[c.kind];
  if (text.length > 500) return "Keep the message under 500 characters.";
  if (c.employeeId === actor.id) return "You can't send wishes to yourself.";
  if (c.wishedByMe) return "You already sent them wishes.";
  if (API_ENABLED) {
    try {
      await api.post("/celebrations/wishes", { to_id: c.employeeId, kind: c.kind, message: text });
      void reloadRecognition();
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : "Could not send.";
    }
  }
  const what = c.kind === "birthday" ? "birthday wishes" : c.kind === "anniversary" ? "work anniversary wishes" : "a welcome";
  const result = postCelebrationKudos(actor, c.employeeId, text, `${actor.fullName} sent you ${what}`);
  bumpLocal();
  return result;
}
