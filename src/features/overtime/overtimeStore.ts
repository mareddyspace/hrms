/**
 * Overtime and comp-off: browser store (local mode) or the backend (/overtime, VITE_API_URL mode). Pages read
 * OvertimeView rows either way. Flow: Submitted → Manager → Approved (paid in the payroll run, or comp-off days).
 */
import { api, API_ENABLED } from "../../api/client.ts";
import { apiRun, createApiMirror } from "../../api/syncOps.ts";
import { DEMO_ACCOUNTS } from "../../demoAccounts.ts";
import { getAttendanceState, attendedMinutes } from "../../data/attendanceLocal.ts";
import { todayISO, uid } from "../../model.ts";
import { lineManagerId, personName } from "../lifecycle/lifecycleShared.ts";
import { createLocalStore } from "../payrequests/localStore.ts";
import { loadScopes, stepsFromApi } from "../payrequests/cashStore.ts";
import { canActOnStep, decideStep, stepViews, type Actor, type FlowStep, type StepView } from "../payrequests/rules.ts";
import { notify } from "../workforce/workforceShared.ts";
import { MAX_DAYS_BACK, compOffDays, hourlyRate, overtimePay, overtimeProblem, overtimeRulesFor } from "./rules.ts";
import { payRulesFor } from "../../countryPay.ts";
import { localInfoOpen, recordLocalEvent } from "../payrequests/threadStore.ts";

export type OvertimeStatus = "Submitted" | "Approved" | "Rejected" | "Withdrawn";
export type OvertimeOutcome = "pay" | "comp_off";

export interface OvertimeView {
  id: string;
  employeeId: string;
  employeeName: string;
  date: string;
  hours: number;
  reason: string;
  outcome: OvertimeOutcome;
  status: OvertimeStatus;
  submittedOn: string;
  /** Worked minutes that day; null = no attendance. */
  attendanceMinutes: number | null;
  hourlyRate: number;
  multiplier: number;
  amount: number;
  currency: string;
  compOffDays: number;
  payoutMonth?: string;
  paid: boolean;
  steps: StepView[];
  canDecide: boolean;
  canWithdraw: boolean;
  infoRequested: boolean;
}

/** What the form shows once a date is picked (attendance, shift, day type, overtime already asked for). */
export interface DayCheck {
  workedMinutes: number | null;
  shiftName: string;
  shiftStart?: string;
  shiftEnd?: string;
  shiftMinutes?: number;
  beyondShiftMinutes: number | null;
  dayType: "working" | "weekend" | "holiday" | "leave";
  holidayName?: string;
  existingId?: string;
  existingStatus?: string;
  eligible: boolean;
  warnings: string[];
}

export interface OvertimePolicyView {
  hourlyRate: number;
  multiplier: number;
  maxHours: number;
  compOff: boolean;
  dayHours: number;
  weeklyHours: number;
  currency: string;
  maxDaysBack: number;
}

export interface OvertimeInput {
  date: string;
  hours: number;
  outcome: OvertimeOutcome;
  reason: string;
}

type Who = Actor & { countryCode?: string; currency?: string };

/* ───────────── Local rows ───────────── */

interface OvertimeRow extends Omit<OvertimeView, "steps" | "canDecide" | "canWithdraw" | "paid" | "infoRequested"> {
  countryCode: string;
  steps: FlowStep[];
  paidRunId?: string;
}

const local = createLocalStore<{ rows: OvertimeRow[] }>("timez.overtime.v1", () => ({ rows: [] }), (saved) =>
  saved && Array.isArray((saved as { rows?: unknown }).rows) ? (saved as { rows: OvertimeRow[] }) : null,
);

function toView(row: OvertimeRow, actor: Actor): OvertimeView {
  const { steps, paidRunId, countryCode: _cc, ...rest } = row;
  return {
    ...rest,
    paid: Boolean(paidRunId),
    steps: stepViews(steps),
    canDecide: row.status === "Submitted" && canActOnStep(actor, row.employeeId, steps),
    canWithdraw: row.status === "Submitted" && actor.id === row.employeeId,
    infoRequested: localInfoOpen("overtime", row.id),
  };
}

function mutate(id: string, fn: (row: OvertimeRow) => string | null): string | null {
  const state = local.get();
  const index = state.rows.findIndex((r) => r.id === id);
  if (index < 0) return "Request not found.";
  const row = structuredClone(state.rows[index]);
  const error = fn(row);
  if (error) return error;
  const rows = state.rows.slice();
  rows[index] = row;
  return local.set({ rows });
}

/* ───────────── Backend ───────────── */

interface OvertimeOut {
  id: string;
  employee_id: string;
  employee_name: string;
  work_date: string;
  hours: number;
  reason: string;
  outcome: OvertimeOutcome;
  status: OvertimeStatus;
  submitted_on: string;
  attendance_minutes: number | null;
  hourly_rate: number;
  multiplier: number;
  amount: number;
  currency: string;
  comp_off_days: number;
  payout_month: string | null;
  paid: boolean;
  steps: Parameters<typeof stepsFromApi>[0];
  can_decide: boolean;
  can_withdraw: boolean;
  info_requested?: boolean;
}

function fromApi(o: OvertimeOut): OvertimeView {
  return {
    id: o.id,
    employeeId: o.employee_id,
    employeeName: o.employee_name,
    date: o.work_date,
    hours: o.hours,
    reason: o.reason,
    outcome: o.outcome,
    status: o.status,
    submittedOn: o.submitted_on,
    attendanceMinutes: o.attendance_minutes,
    hourlyRate: o.hourly_rate,
    multiplier: o.multiplier,
    amount: o.amount,
    currency: o.currency,
    compOffDays: o.comp_off_days,
    ...(o.payout_month ? { payoutMonth: o.payout_month } : {}),
    paid: o.paid,
    steps: stepsFromApi(o.steps),
    canDecide: o.can_decide,
    canWithdraw: o.can_withdraw,
    infoRequested: !!o.info_requested,
  };
}

const byNewest = (a: OvertimeView, b: OvertimeView) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id);

export const overtimeMirror = createApiMirror<{ rows: OvertimeView[] }>(
  () => ({ rows: [] }),
  async () => ({ rows: (await loadScopes<OvertimeOut>("/overtime")).map(fromApi).sort(byNewest) }),
);

/* ───────────── Reading ───────────── */

export function subscribeOvertime(listener: () => void): () => void {
  return API_ENABLED ? overtimeMirror.subscribe(listener) : local.subscribe(listener);
}

export function getOvertimeSnapshot(): object {
  return API_ENABLED ? overtimeMirror.get() : local.get();
}

export function overtimeViews(actor: Actor): OvertimeView[] {
  if (API_ENABLED) return overtimeMirror.get().rows;
  return local.get().rows.map((r) => toView(r, actor)).sort(byNewest);
}

/** Worked minutes on a date (null = no attendance), for the warning before sending. */
export async function attendanceMinutesOn(employeeId: string, date: string): Promise<number | null> {
  if (!date) return null;
  if (API_ENABLED) {
    const out = await api.get<{ worked_minutes: number | null }>("/overtime/attendance", { work_date: date }).catch(() => null);
    return out?.worked_minutes ?? null;
  }
  const session = getAttendanceState().sessions.find((s) => s.employeeId === employeeId && s.date === date);
  return session ? Math.round(attendedMinutes(session)) : null;
}

interface DayCheckOut {
  worked_minutes: number | null;
  shift_name: string | null;
  shift_start: string | null;
  shift_end: string | null;
  shift_minutes: number | null;
  beyond_shift_minutes: number | null;
  day_type: DayCheck["dayType"];
  holiday_name: string | null;
  existing_id: string | null;
  existing_status: string | null;
  eligible: boolean;
  warnings: string[];
}

const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};

/** Checks a date before sending (both modes give the same answers). */
export async function checkOvertimeDay(actor: Who & { shiftStart?: string; shiftEnd?: string }, date: string): Promise<DayCheck | null> {
  if (!date) return null;
  if (API_ENABLED) {
    const o = await api.get<DayCheckOut>("/overtime/attendance", { work_date: date });
    return {
      workedMinutes: o.worked_minutes,
      shiftName: o.shift_name ?? "Your shift",
      ...(o.shift_start ? { shiftStart: o.shift_start, shiftEnd: o.shift_end ?? undefined } : {}),
      ...(o.shift_minutes !== null ? { shiftMinutes: o.shift_minutes } : {}),
      beyondShiftMinutes: o.beyond_shift_minutes,
      dayType: o.day_type,
      ...(o.holiday_name ? { holidayName: o.holiday_name } : {}),
      ...(o.existing_id ? { existingId: o.existing_id, existingStatus: o.existing_status ?? undefined } : {}),
      eligible: o.eligible,
      warnings: o.warnings,
    };
  }
  const today = todayISO();
  const worked = await attendanceMinutesOn(actor.id, date);
  const start = actor.shiftStart ?? "09:30";
  const end = actor.shiftEnd ?? "18:30";
  const shiftMinutes = (minutesOf(end) - minutesOf(start) + 1440) % 1440 || 1440;
  const weekday = new Date(`${date}T00:00:00`).getDay();
  const dayType: DayCheck["dayType"] = weekday === 0 || weekday === 6 ? "weekend" : "working";
  const existing = local.get().rows.find((r) => r.employeeId === actor.id && r.date === date && (r.status === "Submitted" || r.status === "Approved"));
  const warnings: string[] = [];
  let eligible = true;
  if (date >= today) {
    eligible = false;
    warnings.push("Choose a past date: overtime is claimed after it is worked.");
  } else if ((Date.parse(today) - Date.parse(date)) / 86_400_000 > MAX_DAYS_BACK) {
    eligible = false;
    warnings.push(`Overtime can be claimed up to ${MAX_DAYS_BACK} days back.`);
  }
  if (existing) {
    eligible = false;
    warnings.push(`You already asked for overtime on this date (${existing.id.toUpperCase()}, ${existing.status.toLowerCase()}).`);
  }
  if (worked === null) warnings.push("No attendance recorded on this date. Your manager will see this.");
  let beyond: number | null = null;
  if (worked !== null && dayType === "working") {
    beyond = Math.max(0, worked - shiftMinutes);
    if (beyond === 0) warnings.push("Attendance shows no time beyond your shift that day.");
  } else if (worked !== null) beyond = worked;
  return {
    workedMinutes: worked,
    shiftName: "Your shift",
    shiftStart: start,
    shiftEnd: end,
    shiftMinutes,
    beyondShiftMinutes: beyond,
    dayType,
    ...(existing ? { existingId: existing.id, existingStatus: existing.status } : {}),
    eligible,
    warnings,
  };
}

/** The rate and limits the estimate uses: the server's in backend mode (its hourly rate comes from the pay record). */
export async function overtimePolicy(actor: Who): Promise<OvertimePolicyView> {
  if (API_ENABLED) {
    const p = await api.get<{ weekly_hours: number; day_hours: number; multiplier: number; max_hours: number; comp_off: boolean; max_days_back: number; hourly_rate: number; currency: string }>(
      "/overtime/policy",
    );
    return { hourlyRate: p.hourly_rate, multiplier: p.multiplier, maxHours: p.max_hours, compOff: p.comp_off, dayHours: p.day_hours, weeklyHours: p.weekly_hours, currency: p.currency, maxDaysBack: p.max_days_back };
  }
  const r = overtimeRulesFor(actor.countryCode);
  return {
    hourlyRate: hourlyRate(actor.id, actor.countryCode, actor.role),
    multiplier: r.multiplier,
    maxHours: r.maxHours,
    compOff: r.compOff,
    dayHours: r.dayHours,
    weeklyHours: r.weeklyHours,
    currency: actor.currency ?? payRulesFor(actor.countryCode as never).currency,
    maxDaysBack: MAX_DAYS_BACK,
  };
}

/* ───────────── Changes ───────────── */

export async function submitOvertime(actor: Who, input: OvertimeInput): Promise<string | null> {
  const today = todayISO();
  const problem = overtimeProblem(input, actor.countryCode, today);
  if (problem) return problem;
  if (API_ENABLED) {
    return apiRun(
      () => api.post("/overtime", { work_date: input.date, hours: input.hours, reason: input.reason.trim(), outcome: input.outcome }),
      overtimeMirror,
    );
  }
  if (local.get().rows.some((r) => r.employeeId === actor.id && r.date === input.date && (r.status === "Submitted" || r.status === "Approved"))) {
    return "You already have overtime for that date.";
  }
  const role = DEMO_ACCOUNTS.find((a) => a.id === actor.id)?.role ?? actor.role;
  const rate = hourlyRate(actor.id, actor.countryCode, role);
  const rules = overtimeRulesFor(actor.countryCode);
  const manager = lineManagerId(actor.id);
  const steps: FlowStep[] = manager ? [{ label: "Manager", kind: "manager", approverIds: [manager] }] : [];
  const row: OvertimeRow = {
    id: uid("ot"),
    employeeId: actor.id,
    employeeName: actor.fullName,
    countryCode: actor.countryCode ?? "IN",
    date: input.date,
    hours: input.hours,
    reason: input.reason.trim(),
    outcome: input.outcome,
    status: manager ? "Submitted" : "Approved",
    submittedOn: today,
    attendanceMinutes: await attendanceMinutesOn(actor.id, input.date),
    hourlyRate: rate,
    multiplier: rules.multiplier,
    amount: input.outcome === "pay" ? overtimePay(input.hours, rate, actor.countryCode) : 0,
    currency: actor.currency ?? "INR",
    compOffDays: input.outcome === "comp_off" ? compOffDays(input.hours, actor.countryCode) : 0,
    ...(!manager && input.outcome === "pay" ? { payoutMonth: input.date.slice(0, 7) } : {}),
    steps,
  };
  const error = local.set({ rows: [row, ...local.get().rows] });
  if (!error) recordLocalEvent("overtime", row.id, "overtime_submitted", actor.fullName);
  if (!error && manager) notify(manager, `Approve overtime · ${actor.fullName}`, `${input.hours} h on ${input.date}.`, `/overtime?open=${row.id}`);
  return error;
}

/** Local mode: the month the pay goes out — the work month unless that month's run is already closed. */
let closedMonthCheck: (employeeId: string, month: string) => boolean = () => false;
export function setOvertimeClosedMonthCheck(fn: (employeeId: string, month: string) => boolean): void {
  closedMonthCheck = fn;
}

function nextMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

export async function decideOvertime(actor: Actor, id: string, decision: "approve" | "reject", note: string): Promise<string | null> {
  if (decision === "reject" && !note.trim()) return "Add a note saying why.";
  if (API_ENABLED) {
    return apiRun(() => api.post(`/overtime/${encodeURIComponent(id)}/decision`, { decision, note: note.trim() || null }), overtimeMirror);
  }
  let notice: { to: string; title: string; body: string } | null = null;
  const error = mutate(id, (row) => {
    if (row.status !== "Submitted") return `This request is already ${row.status.toLowerCase()}.`;
    const result = decideStep(actor, row.employeeId, row.steps, decision, note);
    if (typeof result === "string") return result;
    row.steps = result.steps;
    recordLocalEvent("overtime", row.id, decision === "approve" ? "overtime_approved" : "overtime_rejected", actor.fullName);
    if (result.outcome === "rejected") row.status = "Rejected";
    if (result.outcome === "approved") {
      row.status = "Approved";
      if (row.outcome === "pay") {
        let month = row.date.slice(0, 7);
        for (let i = 0; i < 24 && closedMonthCheck(row.employeeId, month); i += 1) month = nextMonth(month);
        row.payoutMonth = month;
      }
    }
    if (row.status !== "Submitted") {
      notice = {
        to: row.employeeId,
        title: `Overtime ${row.status.toLowerCase()}`,
        body: row.status === "Approved" ? (row.outcome === "comp_off" ? `${row.compOffDays} comp-off day(s) added to your leave balance.` : `Paid with ${row.payoutMonth} pay.`) : "Open it to see the note.",
      };
    }
    return null;
  });
  const sent = notice as { to: string; title: string; body: string } | null;
  if (!error && sent) notify(sent.to, sent.title, sent.body, "/overtime");
  return error;
}

export async function withdrawOvertime(actor: Actor, id: string): Promise<string | null> {
  if (API_ENABLED) return apiRun(() => api.post(`/overtime/${encodeURIComponent(id)}/withdraw`), overtimeMirror);
  return mutate(id, (row) => {
    if (row.employeeId !== actor.id) return "Only the person who asked can withdraw it.";
    if (row.status !== "Submitted") return "It can only be withdrawn while it waits for approval.";
    row.status = "Withdrawn";
    recordLocalEvent("overtime", row.id, "overtime_withdrawn", actor.fullName);
    return null;
  });
}

/* ───────────── For leave balances and payroll (local mode) ───────────── */

/** Approved comp-off days from overtime worked in the year. */
export function overtimeCompOffDays(employeeId: string, year: number): number {
  if (API_ENABLED) return 0; // the server adds them to the comp-off balance
  return local
    .get()
    .rows.filter((r) => r.employeeId === employeeId && r.status === "Approved" && r.outcome === "comp_off" && r.date.startsWith(String(year)))
    .reduce((s, r) => s + r.compOffDays, 0);
}

/** Approved paid overtime due by this month and not paid yet (local payroll runs). */
export function localPayableOvertime(employeeId: string, month: string): { ids: string[]; hours: number; amount: number } {
  const rows = local
    .get()
    .rows.filter((r) => r.employeeId === employeeId && r.status === "Approved" && r.outcome === "pay" && !r.paidRunId && (r.payoutMonth ?? "9999") <= month);
  return { ids: rows.map((r) => r.id), hours: rows.reduce((s, r) => s + r.hours, 0), amount: rows.reduce((s, r) => s + r.amount, 0) };
}

/** Local payroll run locked: these requests are paid. */
export function markOvertimePaid(ids: string[], runId: string): void {
  if (API_ENABLED || !ids.length) return;
  const set = new Set(ids);
  local.set({ rows: local.get().rows.map((r) => (set.has(r.id) ? { ...r, paidRunId: runId } : r)) });
}

export function overtimeVersion(): number {
  return local.version();
}

export { personName };
