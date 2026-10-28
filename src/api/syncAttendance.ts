/**
 * Attendance from the API (check-in/out sessions, corrections, monthly summary) in the portal's attendance shapes.
 * Backend mode only (VITE_API_URL set); src/data/attendanceLocal.ts reads this mirror instead of its browser copy.
 */
import type { AttendanceCorrection, CorrectionKind, TodaySession } from "../data/attendanceData.ts";
import { addDaysISO, todayISO } from "../model.ts";
import { managementChain } from "../demoAccounts.ts";
import { api } from "./client.ts";
import { createMirror, localHm, mutate, nameOf, utcIso } from "./syncShared.ts";
import { approvalProgressText, type ApprovalProgressOut } from "./approvalProgress.ts";

export interface AttendanceSessionOut {
  id: string;
  employee_id: string;
  work_date: string;
  time_zone?: string;
  check_in: string;
  check_out: string | null;
  break_minutes: number;
  worked_minutes: number | null;
  work_mode: string;
  source?: string;
  shift_start?: string;
  shift_end?: string;
  is_late: boolean;
  late_minutes: number;
  is_early_leave?: boolean;
  early_minutes?: number;
  corrected: boolean;
  note: string | null;
}

export interface CorrectionOut {
  id: string;
  employee_id: string;
  employee_name: string | null;
  work_date: string;
  session_id: string | null;
  requested_check_in: string | null;
  requested_check_out: string | null;
  reason: string;
  status: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
  /** The approval chain's steps and progress (null for requests raised before chains). */
  approval?: ApprovalProgressOut | null;
}

export interface AttendanceSummaryOut {
  employee_id: string;
  month: string;
  working_days: number;
  present: number;
  absent: number;
  on_leave: number;
  late: number;
  early: number;
  hours: number;
  overtime_hours: number;
}

/* Breaks aren't kept by the API (only the total on check-out), so the ones taken today live in this browser. */
const BREAKS_KEY = "timez.api.attendance-breaks";
type BreakMap = Record<string, { start: string; end?: string }[]>;

function readBreaks(): BreakMap {
  try {
    return JSON.parse(localStorage.getItem(BREAKS_KEY) ?? "{}") as BreakMap;
  } catch {
    return {};
  }
}

function writeBreaks(map: BreakMap) {
  try {
    // Keep only the last couple of weeks.
    const cutoff = addDaysISO(todayISO(), -14);
    const kept = Object.fromEntries(Object.entries(map).filter(([key]) => (key.split(":")[1] ?? "") >= cutoff));
    localStorage.setItem(BREAKS_KEY, JSON.stringify(kept));
  } catch {
    /* storage blocked */
  }
}

const breakKey = (employeeId: string, date: string) => `${employeeId}:${date}`;

function hmPlus(hm: string, minutes: number): string {
  const [h, m] = hm.split(":").map(Number);
  const total = h * 60 + m + minutes;
  return `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function toSession(s: AttendanceSessionOut, breaks: BreakMap): TodaySession {
  const local = breaks[breakKey(s.employee_id, s.work_date)];
  const open = !s.check_out;
  let list = local ?? [];
  // Closed days only know the total: show it as one break so hours add up.
  if (!open && s.break_minutes > 0 && !list.length) list = [{ start: "13:00", end: hmPlus("13:00", s.break_minutes) }];
  const onBreak = open && list.some((b) => !b.end);
  return {
    employeeId: s.employee_id,
    date: s.work_date,
    phase: open ? (onBreak ? "on_break" : "checked_in") : "checked_out",
    checkIn: utcIso(s.check_in),
    checkOut: utcIso(s.check_out),
    breaks: list,
  };
}

function kindOf(c: CorrectionOut): CorrectionKind {
  if (c.requested_check_in && c.requested_check_out) return "wrong_time";
  if (c.requested_check_in) return c.session_id ? "wrong_time" : "missing_check_in";
  if (c.requested_check_out) return "missing_check_out";
  return "other";
}

function toCorrection(c: CorrectionOut): AttendanceCorrection {
  const progress = approvalProgressText(c.approval);
  return {
    id: c.id,
    employeeId: c.employee_id,
    employeeName: c.employee_name ?? nameOf(c.employee_id),
    managerId: managementChain(c.employee_id)[0]?.id ?? "",
    date: c.work_date,
    kind: kindOf(c),
    reason: c.reason,
    requestedCheckIn: localHm(utcIso(c.requested_check_in)),
    requestedCheckOut: localHm(utcIso(c.requested_check_out)),
    status: c.status === "approved" ? "Approved" : c.status === "rejected" ? "Rejected" : "Pending",
    createdAt: utcIso(c.created_at),
    decidedAt: utcIso(c.decided_at),
    decidedById: c.decided_by ?? undefined,
    decidedByName: c.decided_by ? nameOf(c.decided_by) : undefined,
    decisionNote: c.decision_note ?? undefined,
    ...(progress ? { approvalProgress: progress } : {}),
  };
}

interface RawAttendance {
  sessions: AttendanceSessionOut[];
  corrections: CorrectionOut[];
  /** Ids of corrections this user may decide (to-decide view). */
  decidable: string[];
}

export interface ApiAttendanceState {
  sessions: TodaySession[];
  corrections: AttendanceCorrection[];
  decidable: Set<string>;
}

const emptyState = (): ApiAttendanceState => ({ sessions: [], corrections: [], decidable: new Set() });

async function load(): Promise<RawAttendance> {
  const today = todayISO();
  const [sessions, mine, pending, approved, rejected] = await Promise.all([
    api.get<AttendanceSessionOut[]>("/attendance", { from: addDaysISO(today, -365), to: today }),
    api.get<CorrectionOut[]>("/attendance/corrections", { view: "mine", limit: 200 }),
    api.get<CorrectionOut[]>("/attendance/corrections", { view: "to-decide", limit: 200 }),
    api.get<CorrectionOut[]>("/attendance/corrections", { view: "to-decide", status: "approved", limit: 100 }),
    api.get<CorrectionOut[]>("/attendance/corrections", { view: "to-decide", status: "rejected", limit: 100 }),
  ]);
  const byId = new Map<string, CorrectionOut>();
  for (const c of [...mine, ...pending, ...approved, ...rejected]) byId.set(c.id, c);
  return {
    sessions,
    corrections: [...byId.values()].sort((a, b) => b.created_at.localeCompare(a.created_at)),
    decidable: pending.map((c) => c.id),
  };
}

export const attendanceMirror = createMirror<RawAttendance, ApiAttendanceState>(emptyState, load, (raw) => {
  const breaks = readBreaks();
  return {
    sessions: raw.sessions.map((s) => toSession(s, breaks)),
    corrections: raw.corrections.map(toCorrection),
    decidable: new Set(raw.decidable),
  };
});

/* ───────── Actions ───────── */

function nowHm(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function breakTotal(list: { start: string; end?: string }[], closeAt: string): number {
  let total = 0;
  for (const b of list) {
    const end = b.end ?? closeAt;
    const [sh, sm] = b.start.split(":").map(Number);
    const [eh, em] = end.split(":").map(Number);
    total += Math.max(0, eh * 60 + em - (sh * 60 + sm));
  }
  return total;
}

export function apiCheckIn(): Promise<string | null> {
  return mutate(() => api.post<AttendanceSessionOut>("/attendance/check-in", { work_mode: "office", source: "web" }), attendanceMirror);
}

/** Starts or ends a break on the open session (kept in this browser; the total goes to the API on check-out). */
export function apiBreak(session: TodaySession, action: "start" | "end") {
  const map = readBreaks();
  const key = breakKey(session.employeeId, session.date);
  const list = [...(map[key] ?? session.breaks)].map((b) => ({ ...b }));
  if (action === "start") list.push({ start: nowHm() });
  else {
    const open = [...list].reverse().find((b) => !b.end);
    if (open) open.end = nowHm();
  }
  map[key] = list;
  writeBreaks(map);
  attendanceMirror.remap();
}

export function apiCheckOut(session: TodaySession): Promise<string | null> {
  const list = readBreaks()[breakKey(session.employeeId, session.date)] ?? session.breaks;
  const minutes = Math.max(0, Math.min(720, Math.round(breakTotal(list, nowHm()))));
  return mutate(() => api.post<AttendanceSessionOut>("/attendance/check-out", { break_minutes: minutes }), attendanceMirror);
}

/** Times are HH:MM in the person's own time zone (the API reads naive times that way). */
export function apiRequestCorrection(input: { date: string; checkIn?: string; checkOut?: string; reason: string }): Promise<string | null> {
  return mutate(
    () =>
      api.post<CorrectionOut>("/attendance/corrections", {
        work_date: input.date,
        requested_check_in: input.checkIn ? `${input.date}T${input.checkIn}:00` : null,
        requested_check_out: input.checkOut ? `${input.date}T${input.checkOut}:00` : null,
        reason: input.reason,
      }),
    attendanceMirror,
  );
}

export function apiDecideCorrection(id: string, decision: "approve" | "reject", note?: string): Promise<string | null> {
  const text = note?.trim() || (decision === "reject" ? "Not approved." : "");
  return mutate(
    () => api.post<CorrectionOut>(`/attendance/corrections/${encodeURIComponent(id)}/decision`, { decision, note: text || null }),
    attendanceMirror,
  );
}

/** The API's month summary (YYYY-MM) for the signed-in person. */
export function loadApiAttendanceSummary(month: string): Promise<AttendanceSummaryOut> {
  return api.get<AttendanceSummaryOut>("/attendance/summary", { month });
}
