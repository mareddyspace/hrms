import {
  attendanceOn,
  formatShortDate,
  parseISODate,
  toISO,
  todayISO,
  type Holiday,
  type LeaveRequest,
} from "../model.ts";
import { buildDefaultCountrySettings, countryByCode } from "../locale/countryConfig.ts";
import { scheduleForEmployee } from "./workSchedule.ts";

export type PunchPhase = "not_started" | "checked_in" | "on_break" | "checked_out";

export type AttendanceDayKind =
  | "present"
  | "absent"
  | "leave"
  | "wfh"
  | "holiday"
  | "weekend"
  | "missing_punch"
  | "pending_correction"
  | "not_checked_in"
  | "upcoming";

export type CorrectionStatus = "Pending" | "Approved" | "Rejected";
export type CorrectionKind = "missing_check_in" | "missing_check_out" | "wrong_time" | "other";

export interface AttendanceBreak {
  start: string; // HH:mm
  end?: string;
}

export interface AttendanceDayRecord {
  id: string;
  employeeId: string;
  employeeName: string;
  date: string;
  kind: AttendanceDayKind;
  checkIn?: string;
  checkOut?: string;
  breaks: AttendanceBreak[];
  hoursWorked: number;
  lateMinutes: number;
  overtimeMinutes: number;
  note?: string;
}

export interface AttendanceCorrection {
  id: string;
  employeeId: string;
  employeeName: string;
  managerId: string;
  date: string;
  kind: CorrectionKind;
  reason: string;
  requestedCheckIn?: string;
  requestedCheckOut?: string;
  status: CorrectionStatus;
  createdAt: string;
  decidedAt?: string;
  decisionNote?: string;
}

export interface TodaySession {
  employeeId: string;
  date: string;
  phase: PunchPhase;
  checkIn?: string; // ISO
  checkOut?: string;
  breaks: { start: string; end?: string }[];
}

/** Sample shift rules — illustrative demo only, not a legal entitlement. */
export const SAMPLE_SHIFT = {
  name: "General shift",
  start: "09:30",
  end: "18:30",
  expectedHours: 8.5,
  /** Fallback when schedule helper is unavailable — Sat/Sun. */
  weeklyOffDays: [0, 6] as number[],
  weeklyOffs: ["Saturday", "Sunday"] as const,
  lateGraceMinutes: 15,
  overtimeAfterMinutes: 30,
  note: "Sample shift policy for UI demos only — not a contractual entitlement.",
};

/** What makes a date a non-working day for one employee — shared by Home and Attendance. */
export interface AttendanceDayContext {
  holidays: Holiday[];
  leaveRequests: LeaveRequest[];
  weeklyOffDays: number[];
}

const COUNTRY_SETTINGS = buildDefaultCountrySettings();

/** Company holidays plus the employee's country calendar (country wins on the same date). */
export function employeeHolidayList(holidays: Holiday[], countryCode?: string): Holiday[] {
  const home = countryByCode(countryCode || "IN", COUNTRY_SETTINGS);
  const byDate = new Map<string, Holiday>();
  for (const h of holidays) byDate.set(h.date, { id: h.id, date: h.date, name: h.name });
  for (const h of home?.holidays ?? []) byDate.set(h.date, { id: `country-${h.date}`, date: h.date, name: h.name });
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

export function attendanceContextFor(
  employee: { shiftName?: string; shiftHours?: string; countryCode?: string },
  holidays: Holiday[],
  leaveRequests: LeaveRequest[],
): AttendanceDayContext {
  return {
    holidays: employeeHolidayList(holidays, employee.countryCode),
    leaveRequests,
    weeklyOffDays: scheduleForEmployee({
      shiftName: employee.shiftName,
      shiftHours: employee.shiftHours,
      countryCode: employee.countryCode,
    }).weeklyOffDays,
  };
}

/** Why no punches are expected on this date, or null for a normal working day. WFH counts as working. */
export function nonWorkingReason(employeeId: string, date: string, ctx: AttendanceDayContext): string | null {
  const holiday = ctx.holidays.find((h) => h.date === date);
  if (holiday) return `${dayLabel(date)} is a holiday (${holiday.name}).`;
  const leave = ctx.leaveRequests.find(
    (r) =>
      r.employeeId === employeeId &&
      r.status === "approved" &&
      r.code !== "wfh" &&
      r.code !== "emergency_wfh" &&
      r.from <= date &&
      date <= r.to,
  );
  if (leave) return `You are on approved leave ${date === todayISO() ? "today" : `on ${formatShortDate(date)}`}.`;
  if (ctx.weeklyOffDays.includes(parseISODate(date).getDay())) return `${dayLabel(date)} is a weekly off.`;
  return null;
}

function dayLabel(iso: string): string {
  return iso === todayISO() ? "Today" : formatShortDate(iso);
}

export function minutesBetween(startHm: string, endHm: string): number {
  const [sh, sm] = startHm.split(":").map(Number);
  const [eh, em] = endHm.split(":").map(Number);
  return eh * 60 + em - (sh * 60 + sm);
}

export function formatHm(isoOrHm: string): string {
  if (/^\d{2}:\d{2}$/.test(isoOrHm)) return isoOrHm;
  try {
    const d = new Date(isoOrHm);
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  } catch {
    return isoOrHm;
  }
}

export function breakMinutes(breaks: AttendanceBreak[]): number {
  return breaks.reduce((sum, b) => {
    if (!b.end) return sum;
    return sum + Math.max(0, minutesBetween(b.start, b.end));
  }, 0);
}

export function computeHoursWorked(checkIn?: string, checkOut?: string, breaks: AttendanceBreak[] = []): number {
  if (!checkIn || !checkOut) return 0;
  const gross = minutesBetween(checkIn, checkOut);
  const net = Math.max(0, gross - breakMinutes(breaks));
  return Math.round((net / 60) * 10) / 10;
}

export function phaseLabel(phase: PunchPhase): string {
  if (phase === "checked_in") return "Checked in";
  if (phase === "on_break") return "On break";
  if (phase === "checked_out") return "Checked out";
  return "Not checked in";
}

export function kindLabel(kind: AttendanceDayKind): string {
  const map: Record<AttendanceDayKind, string> = {
    present: "Present",
    absent: "Absent",
    leave: "Leave",
    wfh: "Work from home",
    holiday: "Holiday",
    weekend: "Weekly Off",
    missing_punch: "Missing punch",
    pending_correction: "Correction pending",
    not_checked_in: "Not checked in",
    upcoming: "Upcoming",
  };
  return map[kind];
}

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function hmAdd(base: string, addMin: number): string {
  const [h, m] = base.split(":").map(Number);
  const total = h * 60 + m + addMin;
  return `${pad(Math.floor(total / 60) % 24)}:${pad(total % 60)}`;
}

/** Local HH:mm for an ISO stamp (or pass-through for HH:mm). */
export function hmOf(isoOrHm: string): string {
  if (/^\d{2}:\d{2}$/.test(isoOrHm)) return isoOrHm;
  const d = new Date(isoOrHm);
  if (Number.isNaN(d.getTime())) return isoOrHm;
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Late / overtime minutes for a pair of punches against the sample shift. */
function punchFlags(checkIn?: string, checkOut?: string) {
  const late = checkIn ? Math.max(0, minutesBetween(SAMPLE_SHIFT.start, checkIn) - SAMPLE_SHIFT.lateGraceMinutes) : 0;
  const overtime =
    checkOut && minutesBetween(SAMPLE_SHIFT.end, checkOut) > SAMPLE_SHIFT.overtimeAfterMinutes
      ? minutesBetween(SAMPLE_SHIFT.end, checkOut)
      : 0;
  return { lateMinutes: late, overtimeMinutes: overtime };
}

type DayBase = { id: string; employeeId: string; employeeName: string; date: string };

/** Day record from a real check-in session. Sessions still open from earlier days are missing a check-out. */
function recordFromSession(base: DayBase, session: TodaySession, today: string): AttendanceDayRecord {
  const checkIn = session.checkIn ? hmOf(session.checkIn) : undefined;
  const checkOut = session.checkOut ? hmOf(session.checkOut) : undefined;
  const breaks = session.breaks.map((b) => ({ ...b }));
  const open = session.phase === "checked_in" || session.phase === "on_break";
  let hoursWorked = computeHoursWorked(checkIn, checkOut, breaks);
  if (open && session.checkIn && session.date === today) {
    const gross = Math.round((Date.now() - new Date(session.checkIn).getTime()) / 60000);
    hoursWorked = Math.round((Math.max(0, gross - breakMinutes(breaks)) / 60) * 10) / 10;
  }
  const stale = open && session.date < today;
  return {
    ...base,
    kind: stale ? "missing_punch" : "present",
    checkIn,
    checkOut,
    breaks,
    hoursWorked,
    ...punchFlags(checkIn, checkOut),
    note: stale ? "Missing check-out" : open ? phaseLabel(session.phase) : undefined,
  };
}

/** Apply an approved correction's requested times on top of the day's record. */
function applyCorrection(row: AttendanceDayRecord, correction: AttendanceCorrection): AttendanceDayRecord {
  const checkIn = correction.requestedCheckIn || row.checkIn;
  const checkOut = correction.requestedCheckOut || row.checkOut;
  const complete = Boolean(checkIn && checkOut);
  const fixable = row.kind === "missing_punch" || row.kind === "absent" || row.kind === "not_checked_in";
  return {
    ...row,
    kind: complete && fixable ? "present" : row.kind,
    checkIn,
    checkOut,
    hoursWorked: complete ? computeHoursWorked(checkIn, checkOut, row.breaks) : row.hoursWorked,
    ...punchFlags(checkIn, checkOut),
    note: "Corrected (approved)",
  };
}

/** Working day used by the sample "forgot to check out" record and its seed correction. */
const SAMPLE_MISSING_CHECKOUT_DATE = "2026-10-09";

/**
 * Build history for an employee from leave/holiday/absence, real check-in sessions and approved corrections.
 * Sample punches are only generated for past dates before the employee's first real session.
 */
export function buildAttendanceHistory(input: {
  employeeId: string;
  employeeName: string;
  from: string;
  to: string;
  holidays: Holiday[];
  leaveRequests: LeaveRequest[];
  absences: string[];
  shiftHours: string;
  corrections: AttendanceCorrection[];
  weeklyOffDays?: number[];
  sessions?: TodaySession[];
}): AttendanceDayRecord[] {
  const today = todayISO();
  const weeklyOffDays = input.weeklyOffDays ?? SAMPLE_SHIFT.weeklyOffDays;
  const sessions = (input.sessions ?? []).filter((s) => s.employeeId === input.employeeId && s.phase !== "not_started");
  const sessionByDate = new Map(sessions.map((s) => [s.date, s]));
  const firstSessionDate = sessions.reduce<string | null>((min, s) => (!min || s.date < min ? s.date : min), null);
  const rows: AttendanceDayRecord[] = [];
  const start = parseISODate(input.from);
  const end = parseISODate(input.to);
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const date = toISO(d);
    const base: DayBase = { id: `att-${input.employeeId}-${date}`, employeeId: input.employeeId, employeeName: input.employeeName, date };
    const empty = { breaks: [] as AttendanceBreak[], hoursWorked: 0, lateMinutes: 0, overtimeMinutes: 0 };
    const cell = attendanceOn(
      date,
      input.holidays,
      input.leaveRequests,
      input.absences,
      input.shiftHours,
      today,
      input.employeeId,
      weeklyOffDays,
    );
    const mine = input.corrections.filter((c) => c.employeeId === input.employeeId && c.date === date);
    const pending = mine.some((c) => c.status === "Pending");
    const approved = mine.filter((c) => c.status === "Approved").sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    const session = sessionByDate.get(date);

    let row: AttendanceDayRecord;
    if (cell.kind === "weekend" || cell.kind === "holiday" || cell.kind === "leave") {
      row = { ...base, ...empty, kind: cell.kind, note: cell.detail };
    } else if (session) {
      row = recordFromSession(base, session, today);
    } else if (cell.kind === "wfh") {
      row = {
        ...base,
        kind: "wfh",
        checkIn: SAMPLE_SHIFT.start,
        checkOut: SAMPLE_SHIFT.end,
        breaks: [{ start: "13:00", end: "13:30" }],
        hoursWorked: SAMPLE_SHIFT.expectedHours,
        lateMinutes: 0,
        overtimeMinutes: 0,
        note: cell.detail,
      };
    } else if (cell.kind === "absent") {
      row = { ...base, ...empty, kind: "absent", note: "Marked absent" };
    } else if (cell.kind === "upcoming" || date > today) {
      row = { ...base, ...empty, kind: "upcoming" };
    } else if (date === today) {
      row = { ...base, ...empty, kind: "not_checked_in" };
    } else if (firstSessionDate && date >= firstSessionDate) {
      // Real punches are recorded from this point on — a day without any is not "present".
      row = { ...base, ...empty, kind: "absent", note: "No punches recorded" };
    } else {
      // Sample punches for past seed dates, keyed by date for stability.
      const dayNum = Number(date.slice(-2));
      const isMissingOut = date === SAMPLE_MISSING_CHECKOUT_DATE;
      const isLate = dayNum % 7 === 3;
      const isOt = dayNum % 11 === 0;
      const checkIn = isLate ? hmAdd(SAMPLE_SHIFT.start, 22) : hmAdd(SAMPLE_SHIFT.start, (dayNum % 5) - 2);
      const checkOut = isMissingOut ? undefined : isOt ? hmAdd(SAMPLE_SHIFT.end, 45) : hmAdd(SAMPLE_SHIFT.end, (dayNum % 4) - 1);
      const breaks: AttendanceBreak[] = [{ start: "13:00", end: "13:40" }];
      row = {
        ...base,
        kind: isMissingOut ? "missing_punch" : "present",
        checkIn,
        checkOut,
        breaks,
        hoursWorked: computeHoursWorked(checkIn, checkOut, breaks),
        ...punchFlags(checkIn, checkOut),
        note: isMissingOut ? "Forgot to check out" : undefined,
      };
    }

    for (const correction of approved) row = applyCorrection(row, correction);
    if (pending && row.kind !== "upcoming") row = { ...row, kind: "pending_correction" };
    rows.push(row);
  }
  return rows;
}

export const CORRECTIONS_SEED: AttendanceCorrection[] = [
  {
    id: "ac-1",
    employeeId: "emp-mahesh",
    employeeName: "Babu Menon",
    managerId: "emp-ram",
    date: "2026-10-09",
    kind: "missing_check_out",
    reason: "Forgot to check out after client call; left office around 18:32.",
    requestedCheckOut: "18:32",
    status: "Pending",
    createdAt: "2026-10-11T08:00:00",
  },
  {
    id: "ac-2",
    employeeId: "emp-mahesh",
    employeeName: "Babu Menon",
    managerId: "emp-ram",
    date: "2026-09-18",
    kind: "wrong_time",
    reason: "Badge reader delayed check-in by 12 minutes.",
    requestedCheckIn: "09:30",
    status: "Approved",
    createdAt: "2026-09-18T19:10:00",
    decidedAt: "2026-09-19T10:00:00",
    decisionNote: "Approved — reader outage logged.",
  },
];
