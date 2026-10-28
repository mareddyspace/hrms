/**
 * Helpers shared by the module sync files (attendance, timesheets, expenses, travel, approvals).
 * Only used in backend mode (VITE_API_URL set).
 */
import { findDemoById } from "../demoAccounts.ts";
import { getPerson, subscribePeople } from "../data/peopleLocal.ts";
import type { ExpenseApprovalStep } from "../model.ts";
import type { FlowDecision, FlowGroup, FlowStep } from "../data/approvalWorkflows.ts";
import { API_ENABLED, API_URL, ApiError, apiRequest, apiSessionAccount, onApiSession } from "./client.ts";

/** Message for a failed call, shown in the page's existing notice. */
export function errorText(error: unknown, fallback = "That didn't work. Try again."): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export const apiPut = <T>(path: string, body: unknown) => apiRequest<T>(path, { method: "PUT", body });
export const apiDelete = <T>(path: string) => apiRequest<T>(path, { method: "DELETE" });

export function nameOf(id: string | null | undefined): string {
  if (!id) return "";
  return getPerson(id)?.fullName ?? findDemoById(id)?.fullName ?? id;
}

/* ───────── Raw (non-JSON) requests: receipt upload and download ───────── */

const TOKEN_KEY = "timez.api.tokens";

function accessToken(): string | null {
  try {
    const raw = sessionStorage.getItem(TOKEN_KEY);
    return raw ? ((JSON.parse(raw) as { access?: string }).access ?? null) : null;
  } catch {
    return null;
  }
}

/** fetch with the bearer token; on 401 lets the client refresh the session once and retries. */
async function authorizedFetch(path: string, init: RequestInit): Promise<Response> {
  const run = () => {
    const token = accessToken();
    return fetch(`${API_URL}/api/v1${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
  };
  let res: Response;
  try {
    res = await run();
    if (res.status === 401) {
      await apiRequest("/auth/me"); // refreshes the tokens (or ends the session)
      res = await run();
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(0, "Can't reach the server. Try again.");
  }
  if (!res.ok) {
    let message = res.status === 413 ? "The file is too large." : "That didn't work. Try again.";
    try {
      const body = (await res.json()) as { detail?: unknown };
      if (typeof body.detail === "string") message = body.detail;
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, message);
  }
  return res;
}

export async function uploadRaw<T>(path: string, file: Blob, contentType: string, filename: string): Promise<T> {
  const res = await authorizedFetch(`${path}?filename=${encodeURIComponent(filename)}`, {
    method: "POST",
    headers: { "Content-Type": contentType, Accept: "application/json" },
    body: file,
  });
  return (await res.json()) as T;
}

export async function downloadBlob(path: string): Promise<Blob> {
  const res = await authorizedFetch(path, { method: "GET" });
  return res.blob();
}

/* ───────── Dates ───────── */

/** "2026-10-28T09:31:00Z" → local "09:31". */
export function localHm(iso: string | null | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function dayOf(iso: string | null | undefined): string | undefined {
  return iso ? iso.slice(0, 10) : undefined;
}

/* ───────── Approval instances (expense and travel steps) ───────── */

export interface ApprovalDecisionOut {
  step: number;
  group: string;
  approver_id: string;
  decision: string;
  note: string | null;
  at: string;
}

export interface ApprovalInstanceOut {
  id: string;
  type: string;
  entity_id: string;
  requester_id: string;
  amount: number | null;
  steps: { roles: string[]; mode: string; min_amount: number | null; groups: Record<string, string[]>; skipped: boolean }[];
  current_step: number;
  status: string;
  completed_at: string | null;
  created_at: string;
  decisions: ApprovalDecisionOut[];
}

const ROLE_LABEL: Record<string, string> = {
  manager: "Manager",
  skip_manager: "Skip-level manager",
  hr: "HR",
  finance: "Finance",
  admin: "Admin",
  executive: "Executive",
};

function legacy(role: string): ExpenseApprovalStep["role"] {
  return (["manager", "skip_manager", "hr", "finance", "admin"].includes(role) ? role : "admin") as ExpenseApprovalStep["role"];
}

/** The instance's steps in the portal's step shape (skipped steps left out) and its decisions. */
export function stepsFromInstance(instance: ApprovalInstanceOut): {
  steps: FlowStep[];
  currentStep: number;
  stepDecisions: FlowDecision[];
  lastDecision?: ApprovalDecisionOut;
} {
  const indexMap = new Map<number, number>();
  const steps: FlowStep[] = [];
  instance.steps.forEach((step, index) => {
    if (step.skipped) return;
    indexMap.set(index, steps.length);
    const groups: FlowGroup[] = Object.entries(step.groups)
      .filter(([, ids]) => ids.length > 0)
      .map(([role, ids]) => ({ role: role as FlowGroup["role"], label: `${ROLE_LABEL[role] ?? role} approval`, approverIds: ids }));
    steps.push({
      role: legacy(step.roles[0] ?? "manager"),
      label: groups.map((g) => g.label.replace(/ approval$/, "")).join(" + ") + " approval",
      approverIds: [...new Set(groups.flatMap((g) => g.approverIds))],
      ...(groups.length > 1 ? { mode: step.mode === "any" ? "any" : "all", groups } : {}),
    });
  });
  const currentStep = indexMap.get(instance.current_step) ?? Math.max(0, steps.length - 1);
  const stepDecisions: FlowDecision[] = instance.decisions.map((d) => {
    const at = indexMap.get(d.step) ?? 0;
    const step = steps[at];
    const groupIndex = step?.groups?.findIndex((g) => g.role === d.group);
    return {
      step: at,
      label: step?.groups?.[groupIndex ?? -1]?.label ?? step?.label ?? "Approval",
      decision: d.decision === "approve" ? "approved" : "rejected",
      byId: d.approver_id,
      byName: nameOf(d.approver_id),
      on: d.at.slice(0, 10),
      ...(d.note ? { note: d.note } : {}),
      ...(groupIndex !== undefined && groupIndex >= 0 ? { group: groupIndex } : {}),
      role: d.group as FlowDecision["role"],
    };
  });
  return { steps, currentStep, stepDecisions, lastDecision: instance.decisions[instance.decisions.length - 1] };
}

/** Loads the approval instances behind a list of requests (one call each, in parallel). */
export async function loadInstances(ids: (string | null | undefined)[]): Promise<Map<string, ApprovalInstanceOut>> {
  const unique = [...new Set(ids.filter((id): id is string => !!id))];
  const out = new Map<string, ApprovalInstanceOut>();
  const results = await Promise.allSettled(
    unique.map((id) => apiRequest<ApprovalInstanceOut>(`/approvals/${encodeURIComponent(id)}`)),
  );
  results.forEach((r) => {
    if (r.status === "fulfilled") out.set(r.value.id, r.value);
  });
  return out;
}

/* ───────── Small subscribable cache used by module stores ───────── */

export function createCache<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: T) {
      value = next;
      listeners.forEach((fn) => fn());
    },
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

/* ───────── API mirror: raw data loaded per session, mapped to portal shapes ───────── */

/** Accepts "…Z", "…+05:30" or a naive UTC timestamp and returns an ISO string the browser reads as UTC. */
export function utcIso(iso: string): string;
export function utcIso(iso: string | null | undefined): string | undefined;
export function utcIso(iso: string | null | undefined): string | undefined {
  if (!iso) return undefined;
  return /[zZ]|[+-]\d\d:?\d\d$/.test(iso) || !iso.includes("T") ? iso : `${iso}Z`;
}

export interface Mirror<R, M> {
  /** Mapped data (stable reference between changes, so it works with useSyncExternalStore). */
  get(): M;
  raw(): R | null;
  loaded(): boolean;
  reload(): Promise<void>;
  subscribe(fn: () => void): () => void;
  /** Re-map the current raw data (e.g. after a browser-only detail changed). */
  remap(): void;
}

/**
 * Loads `load()` whenever an API session starts, empties on sign-out, and re-maps when the people directory
 * changes (names arrive after the first load). Nothing runs unless the backend is on.
 */
export function createMirror<R, M>(empty: () => M, load: (accountId: string) => Promise<R>, map: (raw: R, accountId: string) => M): Mirror<R, M> {
  let raw: R | null = null;
  let mapped: M = empty();
  let account: string | null = null;
  let seq = 0;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((fn) => fn());
  const remap = () => {
    if (raw === null || !account) return;
    mapped = map(raw, account);
    emit();
  };

  async function reload() {
    const who = apiSessionAccount();
    if (!who) return;
    const mine = ++seq;
    try {
      const next = await load(who);
      if (mine !== seq || apiSessionAccount() !== who) return;
      raw = next;
      account = who;
      remap();
    } catch (error) {
      console.warn("Could not load data from the server", error);
    }
  }

  if (API_ENABLED) {
    // Deferred so every module finishes initialising before the first load.
    queueMicrotask(() => {
      onApiSession((who) => {
        if (who) {
          void reload();
        } else {
          seq += 1;
          raw = null;
          account = null;
          mapped = empty();
          emit();
        }
      });
      subscribePeople(remap);
    });
  }

  return {
    get: () => mapped,
    raw: () => raw,
    loaded: () => raw !== null,
    reload,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    remap,
  };
}

/** Runs an API change, then reloads the given mirrors; resolves to the error text or null. */
export async function mutate(run: () => Promise<unknown>, ...mirrors: { reload(): Promise<void> }[]): Promise<string | null> {
  try {
    await run();
  } catch (error) {
    await Promise.all(mirrors.map((m) => m.reload()));
    return errorText(error);
  }
  await Promise.all(mirrors.map((m) => m.reload()));
  return null;
}

export { API_ENABLED };
