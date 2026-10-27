import { DEMO_ACCOUNTS, managementChain, type DemoAccount } from "../../demoAccounts.ts";
import { getPerson } from "../../data/peopleLocal.ts";
import { TASK_TEAM } from "../../data/taskTeam.ts";
import type { UserRole } from "../../model.ts";

/** The signed-in persona performing an action. */
export type PlusActor = Pick<DemoAccount, "id" | "fullName" | "role"> & {
  department?: string;
  countryCode?: string;
};

/** null when the change was applied, otherwise the reason it was refused. */
export type PlusResult = string | null;

const HR_ROLES: readonly UserRole[] = ["hr", "hr_admin", "hrbp"];
const EXEC_ROLES: readonly UserRole[] = ["executive", "founder", "cofounder", "super_admin"];

export function isHr(role: UserRole): boolean {
  return HR_ROLES.includes(role);
}

export function isExecutive(role: UserRole): boolean {
  return EXEC_ROLES.includes(role);
}

/**
 * Ids of everyone above `personId`, nearest first. Uses the real reporting line (sign-in personas and
 * their teammates) so every module shows the same teams; other directory records have no line here.
 */
export function chainIdsOf(personId: string): string[] {
  return managementChain(personId, DEMO_ACCOUNTS).map((m) => m.id);
}

/** True for the top of the organisation: a sign-in persona with no one above them (the CEO). */
export function isTopOfOrg(personId: string): boolean {
  return DEMO_ACCOUNTS.some((a) => a.id === personId) && chainIdsOf(personId).length === 0;
}

export type OrgPerson = { id: string; fullName: string; designation: string; employmentStatus: string };

/** A person from the directory, or one of the engineering teammates who are not in it. */
export function lookupPerson(id: string): OrgPerson | undefined {
  const p = getPerson(id);
  if (p) return { id: p.id, fullName: p.fullName, designation: p.designation, employmentStatus: p.employmentStatus };
  const t = TASK_TEAM.find((x) => x.id === id);
  return t ? { id: t.id, fullName: t.fullName, designation: t.role, employmentStatus: "Active" } : undefined;
}

/** True when `actorId` sits above `personId` in the reporting line. */
export function isInReportingLine(actorId: string, personId: string): boolean {
  if (actorId === personId) return false;
  return chainIdsOf(personId).includes(actorId);
}

export function directManagerId(personId: string): string | undefined {
  return chainIdsOf(personId)[0];
}

export function personName(id: string): string {
  return lookupPerson(id)?.fullName ?? DEMO_ACCOUNTS.find((a) => a.id === id)?.fullName ?? id;
}

export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, (m ?? 1) - 1, d ?? 1);
  date.setDate(date.getDate() + days);
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${mm}-${dd}`;
}

export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

export function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Small localStorage store: tolerant read, module-level cache, stable snapshot,
 * write updates the cache only when localStorage accepted the value.
 */
export function createLocalStore<T>(key: string, defaults: () => T, normalize: (saved: unknown, base: T) => T) {
  const listeners = new Set<() => void>();
  let cache: T | null = null;

  function read(): T {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return defaults();
      return normalize(JSON.parse(raw), defaults());
    } catch {
      return defaults();
    }
  }

  function write(next: T): PlusResult {
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      return "Could not save the change. Storage may be full or blocked.";
    }
    cache = next;
    listeners.forEach((fn) => fn());
    return null;
  }

  function getState(): T {
    if (!cache) cache = read();
    return cache;
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

  /** Runs a guarded change on a fresh copy: `apply` returns an error to refuse, or null to save. */
  function mutate(apply: (draft: T) => PlusResult): PlusResult {
    const draft = structuredClone(getState());
    const error = apply(draft);
    if (error) return error;
    return write(draft);
  }

  function reset() {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
    cache = null;
    listeners.forEach((fn) => fn());
  }

  return { getState, subscribe, mutate, reset };
}

export function arrayOr<T>(value: unknown, fallback: T[]): T[] {
  return Array.isArray(value) ? (value as T[]) : fallback;
}
