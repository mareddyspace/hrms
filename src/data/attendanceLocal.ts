import {
  CORRECTIONS_SEED,
  nonWorkingReason,
  type AttendanceCorrection,
  type AttendanceDayContext,
  type CorrectionKind,
  type CorrectionStatus,
  type PunchPhase,
  type TodaySession,
} from "./attendanceData.ts";
import { formatShortDate, parseISODate, toISO, todayISO } from "../model.ts";
import { managementChain } from "../demoAccounts.ts";
import { delegatedAuthority } from "./delegations.ts";
import { pushPersonTaskAlert } from "./collabLocal.ts";
import { appendAuditEntries } from "./auditTrail.ts";
import { API_ENABLED } from "../api/client.ts";
import {
  apiBreak,
  apiCheckIn,
  apiCheckOut,
  apiDecideCorrection,
  apiRequestCorrection,
  attendanceMirror,
} from "../api/syncAttendance.ts";

const KEY = "timez.attendance.state.v1";
const CORRECTION_WINDOW_DAYS = 30;
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;

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

/** Saved data from before the seed fix still has ac-1 on a weekly off (Sat 10 Oct) — move it to the seed's date. */
function migrateCorrections(rows: AttendanceCorrection[]): AttendanceCorrection[] {
  const seed = CORRECTIONS_SEED.find((c) => c.id === "ac-1");
  return rows.map((c) => (c.id === "ac-1" && seed && c.date === "2026-10-10" ? { ...c, date: seed.date } : c));
}

function read(): AttendanceState {
  const base = defaults();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw) as Partial<AttendanceState>;
    return {
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : base.sessions,
      corrections: Array.isArray(parsed.corrections) ? migrateCorrections(parsed.corrections) : base.corrections,
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
  // Backend mode: the API mirror changes after loads and punches.
  const off = API_ENABLED ? attendanceMirror.subscribe(listener) : undefined;
  return () => {
    listeners.delete(listener);
    off?.();
  };
}

/** Backend mode: sessions and corrections come from the API (in memory); otherwise from this browser. */
export function getAttendanceState(): AttendanceState {
  if (API_ENABLED) return attendanceMirror.get();
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

function shiftISO(iso: string, days: number): string {
  const d = parseISODate(iso);
  d.setDate(d.getDate() + days);
  return toISO(d);
}

const isOpen = (s: TodaySession) => s.phase === "checked_in" || s.phase === "on_break";

/** Latest session that was checked in but never checked out (any date). */
export function getOpenSession(employeeId: string, state = getAttendanceState()): TodaySession | undefined {
  return state.sessions
    .filter((s) => s.employeeId === employeeId && isOpen(s))
    .sort((a, b) => (a.date < b.date ? 1 : -1))[0];
}

export function getTodaySession(employeeId: string): TodaySession {
  const today = todayISO();
  const state = getAttendanceState();
  const existing = state.sessions.find((s) => s.employeeId === employeeId && s.date === today);
  if (existing) return existing;
  return { employeeId, date: today, phase: "not_started", breaks: [] };
}

/**
 * The session the punch card should act on: today's, or a session still open from yesterday
 * (overnight shift) so it can be checked out. Older open sessions are "Missing check-out".
 */
export function getCurrentSession(employeeId: string, state = getAttendanceState()): TodaySession {
  const today = todayISO();
  const existing = state.sessions.find((s) => s.employeeId === employeeId && s.date === today);
  if (existing) return existing;
  const open = getOpenSession(employeeId, state);
  if (open && open.date === shiftISO(today, -1)) return open;
  return { employeeId, date: today, phase: "not_started", breaks: [] };
}

/** Sessions from earlier days that were never checked out (excluding an overnight carry-over). */
export function missingCheckOutSessions(employeeId: string, state = getAttendanceState()): TodaySession[] {
  const current = getCurrentSession(employeeId, state);
  return state.sessions
    .filter((s) => s.employeeId === employeeId && isOpen(s) && s.date < todayISO() && s !== current)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

/**
 * Punch actions. `context` (holidays, approved leave, weekly offs) blocks check-in on non-working days —
 * there is no overtime / comp-off punch flow in this demo.
 */
export function attendanceAction(
  employeeId: string,
  action: "check_in" | "start_break" | "end_break" | "check_out",
  context?: AttendanceDayContext,
): string | null {
  if (API_ENABLED) {
    // Dashboards call this synchronously: report rule errors now, send the punch in the background.
    const pre = apiPunchCheck(employeeId, action, context);
    if (pre) return pre;
    void runApiPunch(employeeId, action).then((err) => {
      if (err) console.warn("Attendance punch failed", err);
    });
    return null;
  }
  const today = todayISO();
  const nowIso = new Date().toISOString();
  const hm = nowHm();
  let error: string | null = null;

  update((s) => {
    if (action === "check_in") {
      const blocked = context ? nonWorkingReason(employeeId, today, context) : null;
      if (blocked) {
        error = `${blocked} Check-in is not needed.`;
        return;
      }
      const carry = getCurrentSession(employeeId, s);
      if (carry.date !== today && isOpen(carry)) {
        error = `You are still checked in from ${formatShortDate(carry.date)}. Check out first.`;
        return;
      }
      let session = s.sessions.find((row) => row.employeeId === employeeId && row.date === today);
      if (session && session.phase !== "not_started") {
        error = "You are already checked in for today.";
        return;
      }
      if (!session) {
        session = { employeeId, date: today, phase: "not_started", breaks: [] };
        s.sessions.unshift(session);
      }
      session.phase = "checked_in";
      session.checkIn = nowIso;
      session.checkOut = undefined;
      return;
    }

    // Break / check-out act on the latest open session, which may have started yesterday.
    const session = getOpenSession(employeeId, s);
    if (session && session.date < shiftISO(today, -1)) {
      error = `Your session from ${formatShortDate(session.date)} is missing a check-out — request a correction.`;
      return;
    }

    if (action === "start_break") {
      if (!session || session.phase !== "checked_in") {
        error = session ? "You are already on a break." : "Check in before starting a break.";
        return;
      }
      session.phase = "on_break";
      session.breaks.push({ start: hm });
      return;
    }

    if (action === "end_break") {
      if (!session || session.phase !== "on_break") {
        error = "You are not on a break.";
        return;
      }
      const open = [...session.breaks].reverse().find((b) => !b.end);
      if (open) open.end = hm;
      session.phase = "checked_in";
      return;
    }

    if (action === "check_out") {
      if (!session) {
        const todays = s.sessions.find((row) => row.employeeId === employeeId && row.date === today);
        error = todays?.phase === "checked_out" ? "You already checked out today." : "Check in before checking out.";
        return;
      }
      if (session.phase === "on_break") {
        error = "End your break before checking out.";
        return;
      }
      session.phase = "checked_out";
      session.checkOut = nowIso;
    }
  });

  return error;
}

/* ───────── Backend mode (VITE_API_URL): punches and corrections go to the API ───────── */

type PunchAction = "check_in" | "start_break" | "end_break" | "check_out";

/** The same rule checks as the browser flow, against the API's sessions. */
function apiPunchCheck(employeeId: string, action: PunchAction, context?: AttendanceDayContext): string | null {
  const state = getAttendanceState();
  const today = todayISO();
  const current = getCurrentSession(employeeId, state);
  if (action === "check_in") {
    const blocked = context ? nonWorkingReason(employeeId, today, context) : null;
    if (blocked) return `${blocked} Check-in is not needed.`;
    if (current.date !== today && isOpen(current)) return `You are still checked in from ${formatShortDate(current.date)}. Check out first.`;
    if (current.phase === "checked_out") return "You already checked out today.";
    if (current.phase !== "not_started") return "You are already checked in for today.";
    return null;
  }
  const open = getOpenSession(employeeId, state);
  if (open && open.date < shiftISO(today, -1)) {
    return `Your session from ${formatShortDate(open.date)} is missing a check-out — request a correction.`;
  }
  if (action === "start_break") {
    if (!open || open.phase !== "checked_in") return open ? "You are already on a break." : "Check in before starting a break.";
    return null;
  }
  if (action === "end_break") return open?.phase === "on_break" ? null : "You are not on a break.";
  if (!open) return current.phase === "checked_out" ? "You already checked out today." : "Check in before checking out.";
  if (open.phase === "on_break") return "End your break before checking out.";
  return null;
}

async function runApiPunch(employeeId: string, action: PunchAction): Promise<string | null> {
  if (action === "check_in") return apiCheckIn();
  const open = getOpenSession(employeeId);
  if (!open) return "Check in first.";
  if (action === "check_out") return apiCheckOut(open);
  apiBreak(open, action === "start_break" ? "start" : "end");
  return null;
}

/** Punches that wait for the server in backend mode (its errors come back as text); same as attendanceAction otherwise. */
export async function attendanceActionAsync(employeeId: string, action: PunchAction, context?: AttendanceDayContext): Promise<string | null> {
  if (!API_ENABLED) return attendanceAction(employeeId, action, context);
  const pre = apiPunchCheck(employeeId, action, context);
  if (pre) return pre;
  return runApiPunch(employeeId, action);
}

export function listCorrectionsForEmployee(employeeId: string): AttendanceCorrection[] {
  return getAttendanceState().corrections.filter((c) => c.employeeId === employeeId);
}

export function listCorrectionsForManager(managerId: string): AttendanceCorrection[] {
  return getAttendanceState().corrections.filter((c) => c.managerId === managerId);
}

/** HR can review any correction, not only their own reporting line. */
export function isHrReviewer(role: string): boolean {
  return role === "hr" || role === "hr_admin";
}

/** Corrections the viewer may decide — `canApprove` is the portal's reporting-line check; HR sees every request but their own. */
export function listCorrectionsForApprover(
  canApprove: (employeeId: string) => boolean,
  viewer?: { id: string; role: string },
): AttendanceCorrection[] {
  // Backend mode: the API only returns other people's corrections this user may decide (or has decided).
  if (API_ENABLED) return getAttendanceState().corrections.filter((c) => c.employeeId !== viewer?.id);
  const hr = viewer ? isHrReviewer(viewer.role) : false;
  return getAttendanceState().corrections.filter(
    (c) => canApprove(c.employeeId) || (hr && c.employeeId !== viewer?.id),
  );
}

/** HH:MM of a session punch, or "—". */
function punchHm(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function sessionFor(state: AttendanceState, employeeId: string, date: string): TodaySession | undefined {
  return state.sessions.find((x) => x.employeeId === employeeId && x.date === date);
}

/** Nearest manager in the reporting line — the default reviewer for a correction. */
export function correctionApproverFor(employeeId: string): string | undefined {
  return managementChain(employeeId)[0]?.id;
}

export interface CorrectionInput {
  employeeId: string;
  employeeName: string;
  managerId: string;
  date: string;
  kind: CorrectionKind;
  reason: string;
  requestedCheckIn?: string;
  requestedCheckOut?: string;
  /** Non-working-day rules; when given, holidays, weekly offs and leave days are rejected. */
  context?: AttendanceDayContext;
  /** Whether the day already has a check-in. False: no attendance that day, so both times are needed. */
  dayHasCheckIn?: boolean;
}

/** Sends the correction to the API in backend mode (after the same checks); same as submitCorrection otherwise. */
export async function submitCorrectionAsync(input: CorrectionInput): Promise<string | null> {
  if (!API_ENABLED) return submitCorrection(input);
  // The API routes it to the reporting line itself, so a missing manager in this browser's directory doesn't block it.
  const invalid = correctionInputError({ ...input, managerId: input.managerId || "api" });
  if (invalid) return invalid;
  return apiRequestCorrection({
    date: input.date,
    checkIn: input.requestedCheckIn?.trim() || undefined,
    checkOut: input.requestedCheckOut?.trim() || undefined,
    reason: input.reason.trim(),
  });
}

/** Decides through the API in backend mode; same as decideCorrection otherwise. */
export async function decideCorrectionAsync(
  id: string,
  approver: { id: string; role: string; fullName?: string },
  status: Extract<CorrectionStatus, "Approved" | "Rejected">,
  note?: string,
): Promise<string | null> {
  if (!API_ENABLED) return decideCorrection(id, approver, status, note);
  const row = getAttendanceState().corrections.find((c) => c.id === id);
  if (!row) return "Correction not found.";
  if (row.employeeId === approver.id) return "You cannot decide your own correction request.";
  if (row.status !== "Pending") return "This request was already decided.";
  return apiDecideCorrection(id, status === "Approved" ? "approve" : "reject", note);
}

function correctionInputError(input: CorrectionInput): string | null {
  const today = todayISO();
  const reason = input.reason.trim();
  const checkIn = input.requestedCheckIn?.trim() || undefined;
  const checkOut = input.requestedCheckOut?.trim() || undefined;
  if (!input.managerId) return "There is no manager in your reporting line to review this. Contact HR.";
  if (!input.date || !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) return "Select a date.";
  if (input.date > today) return "You cannot request a correction for a future date.";
  if (input.date < shiftISO(today, -CORRECTION_WINDOW_DAYS)) {
    return `Corrections can only be requested for the last ${CORRECTION_WINDOW_DAYS} days.`;
  }
  const offDay = input.context ? nonWorkingReason(input.employeeId, input.date, input.context) : null;
  if (offDay) return `${offDay} No attendance correction is needed.`;
  if (input.kind === "missing_check_in" && !checkIn) return "Enter the requested check-in time.";
  if (input.kind === "missing_check_in" && input.dayHasCheckIn === false && !checkOut) {
    return "No attendance that day: enter both check-in and check-out times.";
  }
  if (input.kind === "missing_check_out" && input.dayHasCheckIn === false && !checkIn) {
    return "No check-in that day. Choose Missing check-in and enter both times.";
  }
  if (input.kind === "missing_check_out" && !checkOut) return "Enter the requested check-out time.";
  if (input.kind === "wrong_time" && !checkIn && !checkOut) return "Enter the corrected check-in or check-out time.";
  if (checkIn && !HM.test(checkIn)) return "Check-in time must be HH:MM between 00:00 and 23:59.";
  if (checkOut && !HM.test(checkOut)) return "Check-out time must be HH:MM between 00:00 and 23:59.";
  if (checkIn && checkOut && checkOut <= checkIn) return "Check-out time must be after check-in time.";
  if (!reason) return "Enter a reason for the correction.";
  const sameDay = getAttendanceState().corrections.filter(
    (c) => c.employeeId === input.employeeId && c.date === input.date,
  );
  if (sameDay.some((c) => c.status === "Pending")) return "A pending correction already exists for this date.";
  if (sameDay.some((c) => c.status === "Approved")) return "A correction for this date was already approved.";
  return null;
}

export function submitCorrection(input: CorrectionInput): string | null {
  const invalid = correctionInputError(input);
  if (invalid) return invalid;
  const reason = input.reason.trim();
  const checkIn = input.requestedCheckIn?.trim() || undefined;
  const checkOut = input.requestedCheckOut?.trim() || undefined;
  const id = `ac-local-${Date.now()}`;
  const current = sessionFor(getAttendanceState(), input.employeeId, input.date);
  update((s) => {
    s.corrections.unshift({
      id,
      employeeId: input.employeeId,
      employeeName: input.employeeName,
      managerId: input.managerId,
      date: input.date,
      kind: input.kind,
      reason,
      requestedCheckIn: checkIn,
      requestedCheckOut: checkOut,
      status: "Pending",
      createdAt: new Date().toISOString(),
    });
  });
  appendAuditEntries([
    {
      at: new Date().toISOString(),
      actorId: input.employeeId,
      actorName: input.employeeName,
      entity: "Attendance correction",
      entityId: id,
      subjectId: input.employeeId,
      action: "Created",
      changes: [
        { field: "Date", before: "", after: input.date },
        { field: "Check-in", before: punchHm(current?.checkIn), after: checkIn ?? punchHm(current?.checkIn) },
        { field: "Check-out", before: punchHm(current?.checkOut), after: checkOut ?? punchHm(current?.checkOut) },
        { field: "Status", before: "", after: "Pending" },
      ],
    },
  ]);
  pushPersonTaskAlert({
    recipientId: input.managerId,
    title: "Attendance correction",
    body: `${input.employeeName} asked to correct ${formatShortDate(input.date)}.`,
    href: "/attendance",
  });
  return null;
}

/** Decide a correction. Someone above the employee in their reporting line, or HR, may decide — never self. */
export function decideCorrection(
  id: string,
  approver: { id: string; role: string; fullName?: string },
  status: Extract<CorrectionStatus, "Approved" | "Rejected">,
  note?: string,
): string | null {
  const row = getAttendanceState().corrections.find((c) => c.id === id);
  if (!row) return "Correction not found.";
  if (row.employeeId === approver.id) return "You cannot decide your own correction request.";
  // Corrections are decided by the reporting line, like every other request.
  // An active approval delegation covering attendance corrections counts too (§25).
  const inLine =
    managementChain(row.employeeId).some((m) => m.id === approver.id) ||
    delegatedAuthority(approver.id, row.employeeId, "attendance") !== null ||
    isHrReviewer(approver.role);
  if (!inLine) return "Only someone above this person in their reporting line, or HR, can review this correction.";
  if (row.status !== "Pending") return "This request was already decided.";
  const before = sessionFor(getAttendanceState(), row.employeeId, row.date);
  const beforeIn = punchHm(before?.checkIn);
  const beforeOut = punchHm(before?.checkOut);
  update((s) => {
    const target = s.corrections.find((c) => c.id === id);
    if (!target) return;
    target.status = status;
    target.decidedAt = new Date().toISOString();
    target.decidedById = approver.id;
    target.decidedByName = approver.fullName;
    target.decisionNote = note?.trim() || undefined;
    if (status !== "Approved") return;
    // An approved correction fixes the day itself: close the open session with the agreed times.
    const session = s.sessions.find((x) => x.employeeId === target.employeeId && x.date === target.date);
    const at = (hm?: string) => (hm ? new Date(`${target.date}T${hm}:00`).toISOString() : undefined);
    if (session) {
      session.checkIn = at(target.requestedCheckIn) ?? session.checkIn;
      session.checkOut = at(target.requestedCheckOut) ?? session.checkOut;
      session.breaks = session.breaks.map((b) => (b.end ? b : { ...b, end: session.checkOut ?? b.start }));
      if (session.checkOut) session.phase = "checked_out";
    } else if (target.requestedCheckIn || target.requestedCheckOut) {
      s.sessions.push({
        employeeId: target.employeeId,
        date: target.date,
        phase: target.requestedCheckOut ? "checked_out" : "checked_in",
        checkIn: at(target.requestedCheckIn),
        checkOut: at(target.requestedCheckOut),
        breaks: [],
      });
    }
  });
  const after = sessionFor(getAttendanceState(), row.employeeId, row.date);
  appendAuditEntries([
    {
      at: new Date().toISOString(),
      actorId: approver.id,
      actorName: approver.fullName ?? approver.id,
      entity: "Attendance correction",
      entityId: row.id,
      subjectId: row.employeeId,
      action: "Updated",
      changes: [
        { field: "Status", before: "Pending", after: status },
        { field: "Check-in", before: beforeIn, after: punchHm(after?.checkIn) },
        { field: "Check-out", before: beforeOut, after: punchHm(after?.checkOut) },
      ],
    },
  ]);
  pushPersonTaskAlert({
    recipientId: row.employeeId,
    title: `Correction ${status.toLowerCase()}`,
    body: `${approver.fullName ?? "Your reviewer"} ${status.toLowerCase()} your correction for ${formatShortDate(row.date)}.${note?.trim() ? ` Note: ${note.trim()}` : ""}`,
    href: "/attendance",
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
