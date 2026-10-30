/**
 * Cash advances: browser store (local mode) or the backend (/cash-advances, VITE_API_URL mode). Pages read CashView
 * rows either way. Flow: Submitted → Manager → Finance / HR → Paid, then recovered from pay in monthly instalments.
 */
import { api, API_ENABLED, apiSessionMe } from "../../api/client.ts";
import { apiRun, createApiMirror } from "../../api/syncOps.ts";
import { setPayslipDeductionSource } from "../../data/payslipGenerator.ts";
import { todayISO, uid } from "../../model.ts";
import { isHrRole, personName } from "../lifecycle/lifecycleShared.ts";
import { createLocalStore } from "./localStore.ts";
import {
  CASH_CATEGORIES,
  MAX_INSTALMENTS,
  buildSteps,
  canActOnStep,
  canPayOut,
  cashLimitFor,
  decideStep,
  instalmentSchedule,
  neededByMax,
  stepViews,
  waitingStatus,
  type Actor,
  type FlowStep,
  type Instalment,
  type StepView,
} from "./rules.ts";

export type CashStatus = "Submitted" | "Manager approved" | "Approved" | "Paid" | "Rejected" | "Withdrawn";

export interface CashView {
  id: string;
  employeeId: string;
  employeeName: string;
  amount: number;
  currency: string;
  category: string;
  purpose: string;
  neededBy: string;
  instalments: number;
  status: CashStatus;
  submittedOn: string;
  steps: StepView[];
  canDecide: boolean;
  canWithdraw: boolean;
  canPay: boolean;
  paidOn?: string;
  paidBy?: string;
  reference?: string;
  outstanding: number;
  schedule: Instalment[];
}

export interface CashPolicy {
  limit: number;
  basic: number;
  cap: number;
  currency: string;
  maxInstalments: number;
  categories: readonly string[];
  openId: string | null;
}

export interface CashInput {
  amount: number;
  category: string;
  purpose: string;
  neededBy: string;
  instalments: number;
}

/* ───────────── Local rows ───────────── */

interface CashRow {
  id: string;
  employeeId: string;
  employeeName: string;
  countryCode: string;
  amount: number;
  currency: string;
  category: string;
  purpose: string;
  neededBy: string;
  instalments: number;
  status: CashStatus;
  submittedOn: string;
  steps: FlowStep[];
  paidOn?: string;
  paidBy?: string;
  reference?: string;
}

const local = createLocalStore<{ rows: CashRow[] }>("timez.cashAdvances.v2", () => ({ rows: [] }), (saved) =>
  saved && Array.isArray((saved as { rows?: unknown }).rows) ? (saved as { rows: CashRow[] }) : null,
);

const PENDING: CashStatus[] = ["Submitted", "Manager approved"];

function outstandingOf(row: { status: CashStatus; amount: number; instalments: number; paidOn?: string }, today = todayISO()): number {
  if (row.status !== "Paid" || !row.paidOn) return 0;
  return Math.round(instalmentSchedule(row.amount, row.instalments, row.paidOn, today).filter((i) => !i.recovered).reduce((s, i) => s + i.amount, 0) * 100) / 100;
}

function isOpenRow(row: CashView | CashRow): boolean {
  return PENDING.includes(row.status) || row.status === "Approved" || (row.status === "Paid" && outstandingOf(row) > 0);
}

function toView(row: CashRow, actor: Actor): CashView {
  const today = todayISO();
  return {
    id: row.id,
    employeeId: row.employeeId,
    employeeName: row.employeeName,
    amount: row.amount,
    currency: row.currency,
    category: row.category,
    purpose: row.purpose,
    neededBy: row.neededBy,
    instalments: row.instalments,
    status: row.status,
    submittedOn: row.submittedOn,
    steps: stepViews(row.steps),
    canDecide: PENDING.includes(row.status) && canActOnStep(actor, row.employeeId, row.steps),
    canWithdraw: PENDING.includes(row.status) && actor.id === row.employeeId,
    canPay: row.status === "Approved" && actor.id !== row.employeeId && canPayOut(actor.role),
    ...(row.paidOn ? { paidOn: row.paidOn, paidBy: row.paidBy, reference: row.reference } : {}),
    outstanding: outstandingOf(row, today),
    schedule: row.paidOn ? instalmentSchedule(row.amount, row.instalments, row.paidOn, today) : [],
  };
}

function mutate(id: string, fn: (row: CashRow) => string | null): string | null {
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

interface StepOut {
  label: string;
  approver_names: string[];
  decision: "approve" | "reject" | null;
  by: string | null;
  note: string | null;
  at: string | null;
}

interface CashOut {
  id: string;
  employee_id: string;
  employee_name: string | null;
  amount: number;
  currency: string;
  category: string;
  purpose: string;
  needed_by: string;
  instalments: number;
  status: CashStatus;
  submitted_on: string;
  steps: StepOut[];
  can_decide: boolean;
  can_withdraw: boolean;
  can_pay: boolean;
  paid_on: string | null;
  paid_by: string | null;
  reference: string | null;
  outstanding: number;
  schedule: Instalment[];
}

export function stepsFromApi(steps: StepOut[]): StepView[] {
  return steps.map((s) => ({
    label: s.label,
    approverNames: s.approver_names,
    decision: s.decision,
    by: s.by ?? undefined,
    note: s.note ?? undefined,
    on: s.at?.slice(0, 10),
  }));
}

function fromApi(c: CashOut): CashView {
  return {
    id: c.id,
    employeeId: c.employee_id,
    employeeName: c.employee_name ?? c.employee_id,
    amount: c.amount,
    currency: c.currency,
    category: c.category,
    purpose: c.purpose,
    neededBy: c.needed_by,
    instalments: c.instalments,
    status: c.status,
    submittedOn: c.submitted_on,
    steps: stepsFromApi(c.steps),
    canDecide: c.can_decide,
    canWithdraw: c.can_withdraw,
    canPay: c.can_pay,
    ...(c.paid_on ? { paidOn: c.paid_on, paidBy: c.paid_by ?? undefined, reference: c.reference ?? undefined } : {}),
    outstanding: c.outstanding,
    schedule: c.schedule,
  };
}

/** Roles the API lets see everyone's cash advances and encashments (scope=all). */
export const ALL_SCOPE_ROLES: ReadonlySet<string> = new Set(["hr_admin", "hr", "hrbp", "admin", "super_admin", "finance"]);

/** Loads mine, team and (when the role allows) everyone, keyed by id. Skips scope=all for others (no expected 403s). */
export async function loadScopes<T extends { id: string }>(path: string, allRoles: ReadonlySet<string> = ALL_SCOPE_ROLES): Promise<T[]> {
  const role = (await apiSessionMe().catch(() => null))?.role ?? "";
  const scopes = allRoles.has(role) ? (["mine", "team", "all"] as const) : (["mine", "team"] as const);
  const lists = await Promise.all(
    scopes.map((scope) => api.get<T[]>(path, { scope, limit: 500 }).catch(() => [] as T[])),
  );
  const byId = new Map<string, T>();
  for (const list of lists) for (const row of list) byId.set(row.id, row);
  return [...byId.values()];
}

export const cashMirror = createApiMirror<{ rows: CashView[] }>(
  () => ({ rows: [] }),
  async () => ({ rows: (await loadScopes<CashOut>("/cash-advances")).map(fromApi).sort((a, b) => b.submittedOn.localeCompare(a.submittedOn) || b.id.localeCompare(a.id)) }),
);

/* ───────────── Reading ───────────── */

export function subscribeCash(listener: () => void): () => void {
  return API_ENABLED ? cashMirror.subscribe(listener) : local.subscribe(listener);
}

/** Snapshot for useSyncExternalStore (raw state; turn into views with cashViews). */
export function getCashSnapshot(): object {
  return API_ENABLED ? cashMirror.get() : local.get();
}

export function cashViews(actor: Actor): CashView[] {
  if (API_ENABLED) return cashMirror.get().rows;
  return local
    .get()
    .rows.map((r) => toView(r, actor))
    .sort((a, b) => b.submittedOn.localeCompare(a.submittedOn) || b.id.localeCompare(a.id));
}

export function localCashPolicy(actor: Actor & { countryCode?: string }): CashPolicy {
  const limits = cashLimitFor(actor.countryCode, actor.role);
  const open = local.get().rows.find((r) => r.employeeId === actor.id && isOpenRow(r));
  return { ...limits, maxInstalments: MAX_INSTALMENTS, categories: CASH_CATEGORIES, openId: open?.id ?? null };
}

export async function apiCashPolicy(): Promise<CashPolicy> {
  const p = await api.get<{ limit: number; basic_monthly: number; country_cap: number; currency: string; max_instalments: number; categories: string[]; open_id: string | null }>(
    "/cash-advances/policy",
  );
  return { limit: p.limit, basic: p.basic_monthly, cap: p.country_cap, currency: p.currency, maxInstalments: p.max_instalments, categories: p.categories, openId: p.open_id };
}

/** Requests waiting on this person (local mode; the backend inbox counts its own). */
export function cashWaitingOn(actor: Actor): CashView[] {
  if (API_ENABLED) return [];
  return cashViews(actor).filter((v) => v.canDecide);
}

/* ───────────── Changes ───────────── */

function check(input: CashInput, policy: CashPolicy): string | null {
  if (!Number.isFinite(input.amount) || input.amount <= 0) return "Enter an amount greater than zero.";
  if (input.amount > policy.limit) return `You can ask for up to ${policy.limit.toLocaleString("en-IN")} ${policy.currency}.`;
  if (!input.category) return "Choose a purpose.";
  if (!input.neededBy) return "Choose the date you need it by.";
  if (input.neededBy < todayISO()) return "The needed-by date can't be in the past.";
  if (input.neededBy > neededByMax()) return "The needed-by date must be within 90 days.";
  if (input.instalments < 1 || input.instalments > MAX_INSTALMENTS) return `Repay in 1 to ${MAX_INSTALMENTS} monthly instalments.`;
  if (policy.openId) return "You already have an open cash advance. Finish repaying it first.";
  return null;
}

export async function submitCash(actor: Actor & { countryCode?: string }, input: CashInput, policy: CashPolicy): Promise<string | null> {
  const error = check(input, policy);
  if (error) return error;
  if (API_ENABLED) {
    return apiRun(
      () =>
        api.post("/cash-advances", {
          amount: input.amount,
          category: input.category,
          purpose: input.purpose.trim(),
          needed_by: input.neededBy,
          instalments: input.instalments,
        }),
      cashMirror,
    );
  }
  const row: CashRow = {
    id: uid("cash"),
    employeeId: actor.id,
    employeeName: actor.fullName,
    countryCode: actor.countryCode ?? "IN",
    amount: Math.round(input.amount * 100) / 100,
    currency: policy.currency,
    category: input.category,
    purpose: input.purpose.trim(),
    neededBy: input.neededBy,
    instalments: input.instalments,
    status: "Submitted",
    submittedOn: todayISO(),
    steps: buildSteps(actor.id, { kind: "hr", label: "Finance / HR" }),
  };
  return local.set({ rows: [row, ...local.get().rows] });
}

export async function decideCash(actor: Actor, id: string, decision: "approve" | "reject", note: string): Promise<string | null> {
  if (decision === "reject" && !note.trim()) return "Add a note saying why.";
  if (API_ENABLED) {
    return apiRun(() => api.post(`/cash-advances/${encodeURIComponent(id)}/decision`, { decision, note: note.trim() || null }), cashMirror);
  }
  return mutate(id, (row) => {
    if (!PENDING.includes(row.status)) return `This request is already ${row.status.toLowerCase()}.`;
    const result = decideStep(actor, row.employeeId, row.steps, decision, note);
    if (typeof result === "string") return result;
    row.steps = result.steps;
    row.status = result.outcome === "approved" ? "Approved" : result.outcome === "rejected" ? "Rejected" : waitingStatus(result.steps);
    return null;
  });
}

export async function withdrawCash(actor: Actor, id: string): Promise<string | null> {
  if (API_ENABLED) return apiRun(() => api.post(`/cash-advances/${encodeURIComponent(id)}/withdraw`), cashMirror);
  return mutate(id, (row) => {
    if (row.employeeId !== actor.id) return "Only the person who asked can withdraw it.";
    if (!PENDING.includes(row.status)) return "It can only be withdrawn while it waits for approval.";
    row.status = "Withdrawn";
    return null;
  });
}

export async function payCash(actor: Actor, id: string, reference: string): Promise<string | null> {
  if (API_ENABLED) {
    return apiRun(() => api.post(`/cash-advances/${encodeURIComponent(id)}/pay`, { reference: reference.trim() || null }), cashMirror);
  }
  return mutate(id, (row) => {
    if (!canPayOut(actor.role) || actor.id === row.employeeId) return "Only finance or HR can pay out an advance.";
    if (row.status !== "Approved") return "Only an approved advance can be paid.";
    row.status = "Paid";
    row.paidOn = todayISO();
    row.paidBy = actor.fullName;
    row.reference = reference.trim() || `CA-${row.id.slice(-6).toUpperCase()}`;
    return null;
  });
}

/** What is still to be recovered from this person (final settlement). */
export function outstandingCashFor(employeeId: string): { amount: number; currency: string } | null {
  const rows = API_ENABLED ? cashMirror.get().rows : local.get().rows;
  const row = rows.find((r) => r.employeeId === employeeId && r.status === "Paid" && outstandingOf(r) > 0);
  return row ? { amount: outstandingOf(row), currency: row.currency } : null;
}

export const canSeeAllCash = (role: string) => isHrRole(role as Actor["role"]) || canPayOut(role);

/* ───────────── Payslip recovery lines ───────────── */

setPayslipDeductionSource({
  lines(employeeId, month) {
    const rows = API_ENABLED ? cashMirror.get().rows : local.get().rows;
    const out = [];
    for (const row of rows) {
      if (row.employeeId !== employeeId || row.status !== "Paid" || !row.paidOn) continue;
      const plan = instalmentSchedule(row.amount, row.instalments, row.paidOn);
      const i = plan.findIndex((p) => p.month === month);
      if (i >= 0) out.push({ name: plan.length > 1 ? `Cash advance recovery (${i + 1} of ${plan.length})` : "Cash advance recovery", amount: plan[i].amount });
    }
    return out;
  },
  version: () => (API_ENABLED ? String(cashMirror.get().rows.length) + cashMirror.get().rows.map((r) => r.status[0]).join("") : String(local.version())),
});

export { personName };
