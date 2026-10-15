import {
  attendanceOn,
  parseISODate,
  toISO,
  todayISO,
  type Holiday,
  type LeaveRequest,
} from "../model.ts";

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

/** Build month history for an employee from leave/holiday/absence + realistic punches. */
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
}): AttendanceDayRecord[] {
  const today = todayISO();
  const weeklyOffDays = input.weeklyOffDays ?? SAMPLE_SHIFT.weeklyOffDays;
  const rows: AttendanceDayRecord[] = [];
  const start = parseISODate(input.from);
  const end = parseISODate(input.to);
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const date = toISO(d);
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
    const pending = input.corrections.some(
      (c) => c.employeeId === input.employeeId && c.date === date && c.status === "Pending",
    );

    if (cell.kind === "weekend" || cell.kind === "holiday" || cell.kind === "leave" || cell.kind === "wfh") {
      rows.push({
        id: `att-${input.employeeId}-${date}`,
        employeeId: input.employeeId,
        employeeName: input.employeeName,
        date,
        kind: pending ? "pending_correction" : cell.kind,
        breaks: [],
        hoursWorked: cell.kind === "wfh" ? SAMPLE_SHIFT.expectedHours : 0,
        lateMinutes: 0,
        overtimeMinutes: 0,
        note: cell.detail,
        ...(cell.kind === "wfh"
          ? { checkIn: SAMPLE_SHIFT.start, checkOut: SAMPLE_SHIFT.end, breaks: [{ start: "13:00", end: "13:30" }] }
          : {}),
      });
      continue;
    }

    if (cell.kind === "absent") {
      rows.push({
        id: `att-${input.employeeId}-${date}`,
        employeeId: input.employeeId,
        employeeName: input.employeeName,
        date,
        kind: pending ? "pending_correction" : "absent",
        breaks: [],
        hoursWorked: 0,
        lateMinutes: 0,
        overtimeMinutes: 0,
        note: "Marked absent",
      });
      continue;
    }

    if (cell.kind === "upcoming" || date > today) {
      rows.push({
        id: `att-${input.employeeId}-${date}`,
        employeeId: input.employeeId,
        employeeName: input.employeeName,
        date,
        kind: "upcoming",
        breaks: [],
        hoursWorked: 0,
        lateMinutes: 0,
        overtimeMinutes: 0,
      });
      continue;
    }

    // Present / working day with synthetic punches keyed by date for stability
    const dayNum = Number(date.slice(-2));
    const isMissingOut = date === "2026-10-10";
    const isLate = dayNum % 7 === 3;
    const isOt = dayNum % 11 === 0;
    const checkIn = isLate ? hmAdd(SAMPLE_SHIFT.start, 22) : hmAdd(SAMPLE_SHIFT.start, (dayNum % 5) - 2);
    const checkOut = isMissingOut ? undefined : isOt ? hmAdd(SAMPLE_SHIFT.end, 45) : hmAdd(SAMPLE_SHIFT.end, (dayNum % 4) - 1);
    const breaks: AttendanceBreak[] = [{ start: "13:00", end: "13:40" }];
    const hoursWorked = computeHoursWorked(checkIn, checkOut, breaks);
    const lateMinutes = Math.max(0, minutesBetween(SAMPLE_SHIFT.start, checkIn) - SAMPLE_SHIFT.lateGraceMinutes);
    const overtimeMinutes =
      checkOut && minutesBetween(SAMPLE_SHIFT.end, checkOut) > SAMPLE_SHIFT.overtimeAfterMinutes
        ? minutesBetween(SAMPLE_SHIFT.end, checkOut)
        : 0;

    let kind: AttendanceDayKind = "present";
    if (isMissingOut || pending) kind = pending ? "pending_correction" : "missing_punch";

    rows.push({
      id: `att-${input.employeeId}-${date}`,
      employeeId: input.employeeId,
      employeeName: input.employeeName,
      date,
      kind,
      checkIn,
      checkOut,
      breaks,
      hoursWorked,
      lateMinutes: lateMinutes > 0 ? lateMinutes : 0,
      overtimeMinutes,
      note: isMissingOut ? "Forgot to check out" : undefined,
    });
  }
  return rows;
}

export const CORRECTIONS_SEED: AttendanceCorrection[] = [
  {
    id: "ac-1",
    employeeId: "emp-mahesh",
    employeeName: "Babu Menon",
    managerId: "emp-ram",
    date: "2026-10-10",
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
