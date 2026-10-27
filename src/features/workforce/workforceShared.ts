import { DEMO_ACCOUNTS, findDemoById, managementChain, type DemoAccount } from "../../demoAccounts.ts";
import { taskPersonById } from "../../data/taskTeam.ts";
import { getPerson } from "../../data/peopleLocal.ts";
import { pushPersonTaskAlert } from "../../data/collabLocal.ts";
import { delegatedAuthority, type DelegationScope } from "../../data/delegations.ts";
import { formatShortDate, parseISODate, toISO, type UserRole } from "../../model.ts";

/** Who is performing an action — the signed-in persona. */
export type WorkforceActor = Pick<DemoAccount, "id" | "fullName" | "role">;
/** null when the change was applied, otherwise the reason it was refused. */
export type WorkforceResult = string | null;

export const SAVE_FAILED = "Could not save. Please try again.";

export function isHrRole(role: UserRole): boolean {
  return role === "hr" || role === "hr_admin" || role === "hrbp" || role === "super_admin";
}

export function isHrOrAdmin(role: UserRole): boolean {
  return isHrRole(role) || role === "admin";
}

/**
 * Only someone above the person in their reporting line decides — or a colleague an approver delegated to (§25)
 * while that delegation is active and covers this request type. Never the person themselves.
 */
export function canDecideFor(actor: WorkforceActor, personId: string, scope: DelegationScope = "others"): boolean {
  if (actor.id === personId) return false;
  if (managementChain(personId).some((m) => m.id === actor.id)) return true;
  return delegatedAuthority(actor.id, personId, scope) !== null;
}

export function personName(id: string): string {
  return taskPersonById(id)?.fullName ?? findDemoById(id)?.fullName ?? getPerson(id)?.fullName ?? id;
}

export function hrPersonaIds(): string[] {
  return DEMO_ACCOUNTS.filter((a) => isHrRole(a.role)).map((a) => a.id);
}

type Alert = { recipientId: string; title: string; body: string; href: string };
let pending: Alert[] | null = null;

function send(alert: Alert) {
  try {
    pushPersonTaskAlert(alert);
  } catch {
    // Notifications are best-effort; the change itself is already saved.
  }
}

/** Inside a store mutation the alert waits until the change is saved; otherwise it goes out now. */
export function notify(recipientId: string, title: string, body: string, href: string) {
  const alert = { recipientId, title, body, href };
  if (pending) pending.push(alert);
  else send(alert);
}

export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function isISODate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return toISO(parseISODate(value)) === value;
}

export function isWeekend(iso: string): boolean {
  const day = parseISODate(iso).getDay();
  return day === 0 || day === 6;
}

/** Monday of the week containing this date. */
export function weekStartOf(iso: string): string {
  const date = parseISODate(iso);
  const offset = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - offset);
  return toISO(date);
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((parseISODate(toIso).getTime() - parseISODate(fromIso).getTime()) / 86_400_000);
}

export function shortDay(iso: string): string {
  return parseISODate(iso).toLocaleDateString("en-IN", { weekday: "short", day: "2-digit", month: "short" });
}

export const fmt = formatShortDate;

/**
 * Small localStorage-backed store: tolerant read, module-level cache, listeners,
 * and a write that only updates the cache when the save succeeds.
 */
export function createStore<S extends object>(key: string, defaults: () => S, normalize: (saved: Partial<S>, base: S) => S) {
  const listeners = new Set<() => void>();
  let cache: S | null = null;

  function read(): S {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return defaults();
      const saved = JSON.parse(raw) as Partial<S>;
      if (!saved || typeof saved !== "object") return defaults();
      return normalize(saved, defaults());
    } catch {
      return defaults();
    }
  }

  function getState(): S {
    if (!cache) cache = read();
    return cache;
  }

  function write(next: S): WorkforceResult {
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      return SAVE_FAILED;
    }
    cache = next;
    listeners.forEach((fn) => fn());
    return null;
  }

  function subscribe(listener: () => void) {
    listeners.add(listener);
    const onStorage = (event: StorageEvent) => {
      if (event.key === key) {
        cache = null;
        listener();
      }
    };
    window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(listener);
      window.removeEventListener("storage", onStorage);
    };
  }

  /** Apply a change to a copy; save only if the mutator returns no error. */
  function mutate(fn: (draft: S) => WorkforceResult): WorkforceResult {
    const draft = structuredClone(getState());
    pending = [];
    try {
      const error = fn(draft) ?? write(draft);
      if (!error) pending.forEach(send);
      return error;
    } finally {
      pending = null;
    }
  }

  function reset() {
    try {
      localStorage.removeItem(key);
    } catch {
      // ignore
    }
    cache = null;
    listeners.forEach((fn) => fn());
  }

  return { getState, subscribe, mutate, reset };
}

/** Keep only saved arrays that are still arrays; anything damaged falls back to the seed. */
export function keepArrays<S extends object>(saved: Partial<S>, base: S): S {
  const out = { ...base } as Record<string, unknown>;
  for (const key of Object.keys(base)) {
    const value = (saved as Record<string, unknown>)[key];
    const seed = (base as Record<string, unknown>)[key];
    if (Array.isArray(seed) ? Array.isArray(value) : value && typeof value === "object" && !Array.isArray(value)) out[key] = value;
  }
  return out as S;
}
