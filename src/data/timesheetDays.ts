/**
 * Daily timesheets: each working day is submitted on its own for the manager to approve or send back.
 *
 * - A day needs DAY_TARGET (9 h) to submit, HALF_DAY_TARGET (4.5 h) on approved half-day leave; leave days,
 *   holidays and weekly offs have nothing to submit.
 * - No record = draft. submitted / approved days are locked; a day sent back ("rejected") or a missed day the
 *   manager reopened ("reopened") can be logged and submitted later.
 * - A week submitted the old (weekly) way only locks the days it covered.
 * - Local mode keeps the records here (this browser); backend mode reads them from the API (src/api/syncTimeSheets.ts).
 */
import { useSyncExternalStore } from "react";
import { API_ENABLED } from "../api/client.ts";
import { timeMirror, type TimesheetDayOut } from "../api/syncTimeSheets.ts";
import { approvalProgressText } from "../api/approvalProgress.ts";
import { pendingMirror } from "../api/syncTimeApprovals.ts";
import { todayISO } from "../model.ts";

export const DAY_TARGET = 9;
export const HALF_DAY_TARGET = 4.5;

export type DayStatus = "draft" | "submitted" | "approved" | "rejected" | "reopened";

export interface DayRecord {
  id: string;
  personId: string;
  name: string;
  date: string;
  status: Exclude<DayStatus, "draft">;
  hours: number;
  submittedAt: string;
  decidedBy?: string;
  decidedByName?: string;
  decidedOn?: string;
  decisionNote?: string;
  /** Backend mode: "Step 1 of 2 · Manager" while waiting. */
  approvalLabel?: string;
}

export const DAY_STATUS_LABEL: Record<DayStatus, string> = {
  draft: "Draft",
  submitted: "Submitted",
  approved: "Approved",
  rejected: "Sent back",
  reopened: "Reopened",
};

/** Sent back or reopened: the person can log and submit the day later. */
export function isFixable(status: string | undefined): boolean {
  return status === "rejected" || status === "reopened";
}

/** A day a week submitted the old (weekly) way still covers: logged before today, with no day record of its own. */
export function legacyLockedDate(weekLocked: boolean, date: string, hasEntries: boolean, record?: DayRecord): boolean {
  return weekLocked && hasEntries && date < todayISO() && !record;
}

/** "Log at least 9 h to submit (2.5 h to go)" or null when the day can go. */
export function shortfallText(total: number, target: number): string | null {
  if (target <= 0) return null;
  if (total >= target) return null;
  const toGo = Math.round((target - total) * 100) / 100;
  return `Log at least ${target} h to submit (${toGo} h to go)`;
}

/* ───────── Local mode store ───────── */

const KEY = "timez.timesheet-days.v1";
const listeners = new Set<() => void>();
let cache: DayRecord[] | null = null;

function read(): DayRecord[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? (parsed as DayRecord[]) : [];
  } catch {
    return [];
  }
}

export function getLocalDays(): DayRecord[] {
  if (!cache) cache = read();
  return cache;
}

export function saveLocalDays(next: DayRecord[]): string | null {
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    return "Couldn't save in this browser. Free some storage and try again.";
  }
  cache = next;
  listeners.forEach((fn) => fn());
  return null;
}

export function subscribeLocalDays(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Another tab (e.g. the manager signed in elsewhere in this browser) changed the records.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== KEY) return;
    cache = null;
    listeners.forEach((fn) => fn());
  });
}

/* ───────── Backend mode ───────── */

export function dayFromApi(d: TimesheetDayOut): DayRecord | null {
  if (!d.id || d.status === "draft") return null;
  const progress = approvalProgressText(d.approval);
  return {
    id: d.id,
    personId: d.employee_id,
    name: d.employee_name ?? d.employee_id,
    date: d.work_date,
    status: d.status === "approved" || d.status === "rejected" || d.status === "reopened" ? d.status : "submitted",
    hours: d.total_hours,
    submittedAt: d.submitted_at ?? "",
    ...(d.decided_by ? { decidedBy: d.decided_by } : {}),
    ...(d.decided_by_name ? { decidedByName: d.decided_by_name } : {}),
    ...(d.decided_at ? { decidedOn: d.decided_at.slice(0, 10) } : {}),
    ...(d.decision_note ? { decisionNote: d.decision_note } : {}),
    ...(progress ? { approvalLabel: progress } : {}),
  };
}

let apiSnapshot: { source: unknown; list: DayRecord[] } = { source: null, list: [] };

function apiDays(): DayRecord[] {
  const state = timeMirror.get();
  if (apiSnapshot.source !== state.days) {
    apiSnapshot = {
      source: state.days,
      list: Object.values(state.days)
        .map(dayFromApi)
        .filter((d): d is DayRecord => d !== null),
    };
  }
  return apiSnapshot.list;
}

/** Day records: the signed-in person's own in backend mode, everyone's in this browser in local mode. */
export function useDayRecords(): DayRecord[] {
  return useSyncExternalStore(
    API_ENABLED ? timeMirror.subscribe : subscribeLocalDays,
    API_ENABLED ? apiDays : getLocalDays,
    API_ENABLED ? apiDays : getLocalDays,
  );
}

export function dayRecordFor(records: DayRecord[], personId: string, date: string): DayRecord | undefined {
  return records.find((r) => r.personId === personId && r.date === date);
}

/* ───────── For counts elsewhere (home cards, pay basis, copilot) ───────── */

/** A day's status for a person: local mode from this browser; backend mode the signed-in person's own days. */
export function dayStatusOf(personId: string, date: string): DayStatus | undefined {
  if (API_ENABLED) {
    const d = timeMirror.get().days[date];
    return d && d.employee_id === personId ? (d.status as DayStatus) : undefined;
  }
  return dayRecordFor(getLocalDays(), personId, date)?.status;
}

export interface WaitingDay {
  id: string;
  personId: string;
  date: string;
  hours: number;
}

/** Submitted days waiting on the viewer: backend mode from /approvals/pending, local mode from this browser. */
export function waitingDays(decides: (personId: string) => boolean): WaitingDay[] {
  if (API_ENABLED) {
    return pendingMirror
      .get()
      .items.filter((i) => i.kind === "timesheet_day")
      .map((i) => ({
        id: i.id,
        personId: i.employee_id,
        date: /\d{1,2} \w{3} \d{4}/.exec(i.summary) ? toISO(/\d{1,2} \w{3} \d{4}/.exec(i.summary)![0]) : (i.submitted_at ?? "").slice(0, 10),
        hours: Number(/([\d.]+) h/.exec(i.summary)?.[1] ?? 0),
      }));
  }
  return getLocalDays()
    .filter((r) => r.status === "submitted" && decides(r.personId))
    .map((r) => ({ id: r.id, personId: r.personId, date: r.date, hours: r.hours }));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function toISO(text: string): string {
  const [d, mon, y] = text.split(" ");
  const m = MONTHS.indexOf(mon ?? "") + 1;
  return m ? `${y}-${String(m).padStart(2, "0")}-${String(Number(d)).padStart(2, "0")}` : "";
}
