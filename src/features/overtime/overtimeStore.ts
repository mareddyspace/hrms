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
import { compOffDays, hourlyRate, overtimePay, overtimeProblem, overtimeRulesFor } from "./rules.ts";

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
}

export interface OvertimeInput {
  date: string;
  hours: number;
  outcome: OvertimeOutcome;
  reason: string;
}

type Who = Actor & { countryCode?: string; currency?: string };

/* ───────────── Local rows ───────────── */

interface OvertimeRow extends Omit<OvertimeView, "steps" | "canDecide" | "canWithdraw" | "paid"> {
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
  if (!error && manager) notify(manager, `Approve overtime · ${actor.fullName}`, `${input.hours} h on ${input.date}.`, "/overtime");
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
