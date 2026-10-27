import type { DemoAccount } from "../../demoAccounts.ts";
import type { UserRole } from "../../model.ts";
import { addDaysISO, todayISO } from "../../model.ts";
import { getPerson } from "../../data/peopleLocal.ts";

/** Who is performing a compliance action — the signed-in persona. */
export type ComplianceActor = Pick<DemoAccount, "id" | "fullName" | "role"> & { email?: string };
/** null when the change was applied, otherwise the one-line reason it was refused. */
export type ComplianceResult = string | null;

const HR_ROLES: readonly UserRole[] = ["hr", "hr_admin", "hrbp"];

export function isHr(role: UserRole): boolean {
  return HR_ROLES.includes(role);
}

export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export function nowStamp(): string {
  return new Date().toISOString();
}

export function daysBetween(fromISO: string, toISO: string): number {
  const a = Date.parse(`${fromISO.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${toISO.slice(0, 10)}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

export function relDay(days: number): string {
  return addDaysISO(todayISO(), days);
}

export function isISODate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

export function formatStamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function sameName(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function personName(id: string, fallback = "Unknown"): string {
  return getPerson(id)?.fullName ?? fallback;
}

/** Country of a person (people directory first, persona record as fallback). */
export function personCountry(id: string, fallback?: { countryCode?: string; countryName?: string }) {
  const person = getPerson(id);
  return {
    code: String(person?.countryCode ?? fallback?.countryCode ?? "IN"),
    name: person?.countryName ?? fallback?.countryName ?? "India",
  };
}

const PRIVACY_LAWS: Record<string, string> = {
  IN: "DPDP Act 2023",
  GB: "UK GDPR",
  DE: "EU GDPR",
  AE: "UAE PDPL",
  SA: "Saudi PDPL",
  US: "US state privacy laws",
  AU: "Privacy Act 1988",
  CA: "PIPEDA",
};

export function privacyLawFor(countryCode: string): string {
  return PRIVACY_LAWS[countryCode] ?? "Local data protection law";
}

/** Generic tolerant localStorage store: per-field fallback, cached snapshot, safe write. */
export function createLocalStore<T extends Record<string, unknown>>(key: string, defaults: () => T) {
  const listeners = new Set<() => void>();
  let cache: T | null = null;

  function read(): T {
    const base = defaults();
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return base;
      const saved = JSON.parse(raw) as Partial<Record<keyof T, unknown>> | null;
      if (!saved || typeof saved !== "object") return base;
      for (const field of Object.keys(base) as (keyof T)[]) {
        const fallback = base[field];
        const value = saved[field];
        if (Array.isArray(fallback) ? Array.isArray(value) : value !== undefined && typeof value === typeof fallback) {
          (base as Record<keyof T, unknown>)[field] = value;
        }
      }
      return base;
    } catch {
      return base;
    }
  }

  function write(state: T): boolean {
    try {
      localStorage.setItem(key, JSON.stringify(state));
    } catch {
      return false;
    }
    cache = state;
    listeners.forEach((fn) => fn());
    return true;
  }

  function getState(): T {
    if (!cache) cache = read();
    return cache;
  }

  function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  /** Apply a change to a fresh copy; `apply` returns an error to refuse, or null to save. */
  function guarded(apply: (state: T) => ComplianceResult): ComplianceResult {
    const state = structuredClone(getState());
    const error = apply(state);
    if (error) return error;
    return write(state) ? null : "Could not save. Please try again.";
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

  return { key, read, write, getState, subscribe, guarded, reset };
}
