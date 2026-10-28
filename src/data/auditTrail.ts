import { useSyncExternalStore } from "react";
import { RETIRED_ACCOUNT_IDS, mentionsRetiredAccount } from "../demoAccounts.ts";

/** One recorded change: who did what to which record, with the values before and after. */
export interface AuditEntry {
  id: string;
  at: string;
  actorId: string;
  actorName: string;
  /** Record type, e.g. "Leave request". */
  entity: string;
  entityId: string;
  /** Whose record it is, when known. */
  subjectId?: string;
  action: "Created" | "Updated" | "Removed";
  changes: { field: string; before: string; after: string }[];
}

const KEY = "kastech.audit.v1";
const MAX_ENTRIES = 2000;
const listeners = new Set<() => void>();
let cache: AuditEntry[] | null = null;

function read(): AuditEntry[] {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    const saved = raw ? (JSON.parse(raw) as AuditEntry[]) : [];
    // Entries by or about a retired sign-in account (the Compensation persona) are dropped.
    cache = saved.filter((e) => !RETIRED_ACCOUNT_IDS.has(e.actorId) && !mentionsRetiredAccount(e));
  } catch {
    cache = [];
  }
  return cache;
}

export function listAudit(): AuditEntry[] {
  return read();
}

export function appendAuditEntries(entries: Omit<AuditEntry, "id">[]): void {
  if (entries.length === 0) return;
  const batch = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const stamped = entries.map((entry, i) => ({ ...entry, id: `au-${batch}-${i}` }));
  const next = [...stamped.reverse(), ...read()].slice(0, MAX_ENTRIES);
  cache = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* keep in memory */
  }
  listeners.forEach((fn) => fn());
}

export function useAuditTrail(): AuditEntry[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    read,
    read,
  );
}

function show(value: unknown): string {
  if (value === undefined || value === null || value === "") return "—";
  if (typeof value === "object") return JSON.stringify(value).slice(0, 80);
  return String(value).slice(0, 80);
}

/** Lists in the portal state that hold business records, with a readable name for each. */
const TRACKED: Record<string, string> = {
  leaveRequests: "Leave request",
  backdatedPermissions: "Backdated leave permission",
  encashments: "Leave encashment",
  expenses: "Expense claim",
  reimbursements: "Reimbursement",
  cashAdvances: "Cash advance",
  assetRequests: "Asset request",
  softwareRequests: "Software request",
  investmentProofs: "Tax declaration",
  orgTimesheets: "Timesheet",
  timesheets: "Timesheet entry",
  tasks: "Task",
};

type Row = { id: string; employeeId?: string; personId?: string } & Record<string, unknown>;

/** Compares two versions of the portal state and describes every created, changed or removed record. */
export function diffForAudit(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  actor: { id: string; name: string },
): Omit<AuditEntry, "id">[] {
  const at = new Date().toISOString();
  const out: Omit<AuditEntry, "id">[] = [];
  for (const [key, entity] of Object.entries(TRACKED)) {
    const prevList = before[key] as Row[] | undefined;
    const nextList = after[key] as Row[] | undefined;
    if (!Array.isArray(prevList) || !Array.isArray(nextList) || prevList === nextList) continue;
    const prevById = new Map(prevList.map((row) => [row.id, row]));
    const nextById = new Map(nextList.map((row) => [row.id, row]));
    for (const row of nextList) {
      const old = prevById.get(row.id);
      const subjectId = row.employeeId ?? row.personId;
      if (!old) {
        out.push({ at, actorId: actor.id, actorName: actor.name, entity, entityId: row.id, subjectId, action: "Created", changes: [] });
        continue;
      }
      if (old === row) continue;
      const changes = Object.keys({ ...old, ...row })
        .filter((field) => JSON.stringify(old[field]) !== JSON.stringify(row[field]))
        .map((field) => ({ field, before: show(old[field]), after: show(row[field]) }));
      if (changes.length) {
        out.push({ at, actorId: actor.id, actorName: actor.name, entity, entityId: row.id, subjectId, action: "Updated", changes });
      }
    }
    for (const row of prevList) {
      if (!nextById.has(row.id)) {
        out.push({
          at,
          actorId: actor.id,
          actorName: actor.name,
          entity,
          entityId: row.id,
          subjectId: row.employeeId ?? row.personId,
          action: "Removed",
          changes: [],
        });
      }
    }
  }
  return out;
}
