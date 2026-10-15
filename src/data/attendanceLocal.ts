import {
  CORRECTIONS_SEED,
  type AttendanceCorrection,
  type CorrectionKind,
  type CorrectionStatus,
  type PunchPhase,
  type TodaySession,
} from "./attendanceData.ts";
import { todayISO } from "../model.ts";

const KEY = "timez.attendance.state.v1";

type AttendanceState = {
  sessions: TodaySession[];
  corrections: AttendanceCorrection[];
};

function defaults(): AttendanceState {
  return {
    sessions: [],
    corrections: structuredClone(CORRECTIONS_SEED),
  };
}

function read(): AttendanceState {
  const base = defaults();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw) as Partial<AttendanceState>;
    return {
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : base.sessions,
      corrections: Array.isArray(parsed.corrections) ? parsed.corrections : base.corrections,
    };
  } catch {
    return base;
  }
}

const listeners = new Set<() => void>();
let cache: AttendanceState | null = null;

function write(state: AttendanceState) {
  cache = state;
  localStorage.setItem(KEY, JSON.stringify(state));
  listeners.forEach((fn) => fn());
}

export function subscribeAttendance(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getAttendanceState(): AttendanceState {
  if (!cache) cache = read();
  return cache;
}

function update(mutator: (state: AttendanceState) => void) {
  const state = structuredClone(getAttendanceState());
  mutator(state);
  write(state);
}

function nowHm(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function getTodaySession(employeeId: string): TodaySession {
  const today = todayISO();
  const state = getAttendanceState();
  const existing = state.sessions.find((s) => s.employeeId === employeeId && s.date === today);
  if (existing) return existing;
  return { employeeId, date: today, phase: "not_started", breaks: [] };
}

export function attendanceAction(
  employeeId: string,
  action: "check_in" | "start_break" | "end_break" | "check_out",
): string | null {
  const today = todayISO();
  const nowIso = new Date().toISOString();
  const hm = nowHm();
  let error: string | null = null;

  update((s) => {
    let session = s.sessions.find((row) => row.employeeId === employeeId && row.date === today);
    if (!session) {
      session = { employeeId, date: today, phase: "not_started", breaks: [] };
      s.sessions.unshift(session);
    }

    if (action === "check_in") {
      if (session.phase !== "not_started") {
        error = "You are already checked in for today.";
        return;
      }
      session.phase = "checked_in";
      session.checkIn = nowIso;
      session.checkOut = undefined;
      return;
    }

    if (action === "start_break") {
      if (session.phase !== "checked_in") {
        error = "Check in before starting a break.";
        return;
      }
      session.phase = "on_break";
      session.breaks.push({ start: hm });
      return;
    }

    if (action === "end_break") {
      if (session.phase !== "on_break") {
        error = "You are not on a break.";
        return;
      }
      const open = [...session.breaks].reverse().find((b) => !b.end);
      if (open) open.end = hm;
      session.phase = "checked_in";
      return;
    }

    if (action === "check_out") {
      if (session.phase === "not_started") {
        error = "Check in before checking out.";
        return;
      }
      if (session.phase === "on_break") {
        error = "End your break before checking out.";
        return;
      }
      if (session.phase === "checked_out") {
        error = "You already checked out today.";
        return;
      }
      session.phase = "checked_out";
      session.checkOut = nowIso;
    }
  });

  return error;
}

export function listCorrectionsForEmployee(employeeId: string): AttendanceCorrection[] {
  return getAttendanceState().corrections.filter((c) => c.employeeId === employeeId);
}

export function listCorrectionsForManager(managerId: string): AttendanceCorrection[] {
  return getAttendanceState().corrections.filter((c) => c.managerId === managerId);
}

export function submitCorrection(input: {
  employeeId: string;
  employeeName: string;
  managerId: string;
  date: string;
  kind: CorrectionKind;
  reason: string;
  requestedCheckIn?: string;
  requestedCheckOut?: string;
}): string | null {
  const reason = input.reason.trim();
  if (!reason) return "Enter a reason for the correction.";
  if (!input.date) return "Select a date.";
  const dup = getAttendanceState().corrections.find(
    (c) => c.employeeId === input.employeeId && c.date === input.date && c.status === "Pending",
  );
  if (dup) return "A pending correction already exists for this date.";

  update((s) => {
    s.corrections.unshift({
      id: `ac-local-${Date.now()}`,
      employeeId: input.employeeId,
      employeeName: input.employeeName,
      managerId: input.managerId,
      date: input.date,
      kind: input.kind,
      reason,
      requestedCheckIn: input.requestedCheckIn?.trim() || undefined,
      requestedCheckOut: input.requestedCheckOut?.trim() || undefined,
      status: "Pending",
      createdAt: new Date().toISOString(),
    });
  });
  return null;
}

export function decideCorrection(
  id: string,
  managerId: string,
  status: Extract<CorrectionStatus, "Approved" | "Rejected">,
  note?: string,
): string | null {
  const row = getAttendanceState().corrections.find((c) => c.id === id);
  if (!row) return "Correction not found.";
  if (row.managerId !== managerId) return "You can only review corrections for your team.";
  if (row.status !== "Pending") return "This request was already decided.";
  update((s) => {
    const target = s.corrections.find((c) => c.id === id);
    if (!target) return;
    target.status = status;
    target.decidedAt = new Date().toISOString();
    target.decisionNote = note?.trim() || undefined;
  });
  return null;
}

export function sessionHours(session: TodaySession): {
  breakMinutes: number;
  hoursWorked: number;
  phase: PunchPhase;
} {
  const breaks = session.breaks.map((b) => ({
    start: b.start,
    end: b.end ?? (session.phase === "on_break" ? nowHm() : b.end),
  }));
  let breakMins = 0;
  for (const b of breaks) {
    if (!b.end) continue;
    const [sh, sm] = b.start.split(":").map(Number);
    const [eh, em] = b.end.split(":").map(Number);
    breakMins += Math.max(0, eh * 60 + em - (sh * 60 + sm));
  }

  if (!session.checkIn) return { breakMinutes: breakMins, hoursWorked: 0, phase: session.phase };
  const start = new Date(session.checkIn).getTime();
  const end = session.checkOut ? new Date(session.checkOut).getTime() : Date.now();
  const grossMin = Math.max(0, Math.round((end - start) / 60000));
  const net = Math.max(0, grossMin - breakMins);
  return {
    breakMinutes: breakMins,
    hoursWorked: Math.round((net / 60) * 10) / 10,
    phase: session.phase,
  };
}
