/**
 * Leave encashment. Local mode keeps requests in the portal store (state.encashments, so leave balances count them);
 * backend mode uses /encashments (Manager → HR). Both show EncashView rows and the same rules.
 */
import { api, API_ENABLED } from "../../api/client.ts";
import { apiRun, createApiMirror } from "../../api/syncOps.ts";
import type { Encashment, LeaveRow } from "../../model.ts";
import { loadScopes, stepsFromApi } from "./cashStore.ts";
import { ENCASH_CUTOFF_DAY, ENCASH_KEEP_DAYS, ENCASH_MAX_DAYS_A_YEAR, ENCASHABLE_CODES, payoutMonth, type StepView } from "./rules.ts";

export type EncashStatus = "Submitted" | "Manager approved" | "Approved" | "Rejected" | "Withdrawn";

export interface EncashView {
  id: string;
  employeeId: string;
  employeeName: string;
  code: string;
  days: number;
  perDay: number;
  amount: number;
  currency: string;
  status: EncashStatus;
  submittedOn: string;
  payoutMonth?: string;
  steps: StepView[];
  canDecide: boolean;
  canWithdraw: boolean;
}

export interface EncashType {
  code: string;
  name: string;
  available: number;
  encashable: number;
  usedThisYear: number;
  eligible: boolean;
  whyNot?: string;
}

export interface EncashPolicy {
  perDay: number;
  currency: string;
  maxDaysAYear: number;
  keepDays: number;
  cutoffDay: number;
  types: EncashType[];
}

/** Local mode: the same rules over the portal's leave table and encashments. */
export function localEncashPolicy(rows: LeaveRow[], encashments: Encashment[], employeeId: string, perDay: number, currency: string): EncashPolicy {
  const year = new Date().getFullYear();
  const types = rows.map((row): EncashType => {
    if (!ENCASHABLE_CODES.includes(row.code)) {
      return { code: row.code, name: row.name, available: row.available, encashable: 0, usedThisYear: 0, eligible: false, whyNot: "Not encashable" };
    }
    const used = encashments
      .filter((e) => e.employeeId === employeeId && e.code === row.code && Number(e.appliedOn.slice(0, 4)) === year && (e.status === "approved" || e.status === "pending"))
      .reduce((s, e) => s + e.days, 0);
    const roomYear = Math.max(0, ENCASH_MAX_DAYS_A_YEAR - used);
    const roomBalance = Math.max(0, row.available - ENCASH_KEEP_DAYS);
    const encashable = Math.floor(Math.min(roomYear, roomBalance) * 2) / 2;
    return {
      code: row.code,
      name: row.name,
      available: row.available,
      encashable,
      usedThisYear: used,
      eligible: encashable > 0,
      ...(encashable > 0 ? {} : { whyNot: roomYear <= 0 ? `Yearly limit of ${ENCASH_MAX_DAYS_A_YEAR} days reached` : `Keep at least ${ENCASH_KEEP_DAYS} days in your balance` }),
    };
  });
  return { perDay, currency, maxDaysAYear: ENCASH_MAX_DAYS_A_YEAR, keepDays: ENCASH_KEEP_DAYS, cutoffDay: ENCASH_CUTOFF_DAY, types };
}

/** Local mode rows (one approval step: the manager, or HR for the CEO). */
export function localEncashViews(
  encashments: Encashment[],
  ctx: { perDayOf: (employeeId: string) => number; currencyOf: (employeeId: string) => string; nameOf: (id: string) => string; approverOf: (employeeId: string) => string },
): EncashView[] {
  return encashments.map((e) => {
    const perDay = ctx.perDayOf(e.employeeId);
    const status: EncashStatus = e.status === "pending" ? "Submitted" : e.status === "approved" ? "Approved" : e.status === "rejected" ? "Rejected" : "Withdrawn";
    const decided = e.status === "approved" || e.status === "rejected";
    return {
      id: e.id,
      employeeId: e.employeeId,
      employeeName: ctx.nameOf(e.employeeId),
      code: e.code,
      days: e.days,
      perDay,
      amount: Math.round(perDay * e.days * 100) / 100,
      currency: ctx.currencyOf(e.employeeId),
      status,
      submittedOn: e.appliedOn,
      ...(e.status === "approved" ? { payoutMonth: payoutMonth(e.decidedOn ?? e.appliedOn) } : {}),
      steps: [
        {
          label: "Approval",
          approverNames: [ctx.approverOf(e.employeeId)],
          decision: decided ? (e.status === "approved" ? "approve" : "reject") : null,
          by: e.decidedByName,
          note: e.decisionNote,
          on: e.decidedOn,
        },
      ],
      canDecide: false,
      canWithdraw: e.status === "pending",
    };
  });
}

/* ───────────── Backend ───────────── */

interface EncashOut {
  id: string;
  employee_id: string;
  employee_name: string | null;
  leave_code: string;
  days: number;
  per_day: number;
  amount: number;
  currency: string;
  status: EncashStatus;
  submitted_on: string;
  payout_month: string | null;
  steps: Parameters<typeof stepsFromApi>[0];
  can_decide: boolean;
  can_withdraw: boolean;
}

export const encashMirror = createApiMirror<{ rows: EncashView[] }>(
  () => ({ rows: [] }),
  async () => ({
    rows: (await loadScopes<EncashOut>("/encashments"))
      .map(
        (r): EncashView => ({
          id: r.id,
          employeeId: r.employee_id,
          employeeName: r.employee_name ?? r.employee_id,
          code: r.leave_code,
          days: r.days,
          perDay: r.per_day,
          amount: r.amount,
          currency: r.currency,
          status: r.status,
          submittedOn: r.submitted_on,
          ...(r.payout_month ? { payoutMonth: r.payout_month } : {}),
          steps: stepsFromApi(r.steps),
          canDecide: r.can_decide,
          canWithdraw: r.can_withdraw,
        }),
      )
      .sort((a, b) => b.submittedOn.localeCompare(a.submittedOn) || b.id.localeCompare(a.id)),
  }),
);

export async function apiEncashPolicy(): Promise<EncashPolicy> {
  const p = await api.get<{
    per_day: number;
    currency: string;
    max_days_a_year: number;
    keep_days: number;
    cutoff_day: number;
    types: { code: string; name: string; available: number; encashable: number; used_this_year: number; eligible: boolean; why_not: string | null }[];
  }>("/encashments/policy");
  return {
    perDay: p.per_day,
    currency: p.currency,
    maxDaysAYear: p.max_days_a_year,
    keepDays: p.keep_days,
    cutoffDay: p.cutoff_day,
    types: p.types.map((t) => ({ code: t.code, name: t.name, available: t.available, encashable: t.encashable, usedThisYear: t.used_this_year, eligible: t.eligible, ...(t.why_not ? { whyNot: t.why_not } : {}) })),
  };
}

export function apiSubmitEncashment(code: string, days: number): Promise<string | null> {
  return apiRun(() => api.post("/encashments", { leave_code: code, days }), encashMirror);
}

export function apiDecideEncashment(id: string, decision: "approve" | "reject", note: string): Promise<string | null> {
  if (decision === "reject" && !note.trim()) return Promise.resolve("Add a note saying why.");
  return apiRun(() => api.post(`/encashments/${encodeURIComponent(id)}/decision`, { decision, note: note.trim() || null }), encashMirror);
}

export function apiWithdrawEncashment(id: string): Promise<string | null> {
  return apiRun(() => api.post(`/encashments/${encodeURIComponent(id)}/withdraw`), encashMirror);
}

export { API_ENABLED };
