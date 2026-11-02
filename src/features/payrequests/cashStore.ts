/**
 * Cash advances: browser store (local mode) or the backend (/cash-advances, VITE_API_URL mode). Pages read CashView
 * rows either way. Flow: Submitted → Manager → Finance / HR → Paid, then recovered from pay in monthly instalments.
 */
import { api, API_ENABLED, apiSessionMe } from "../../api/client.ts";
import { apiRun, createApiMirror } from "../../api/syncOps.ts";
import { setPayslipDeductionSource } from "../../data/payslipGenerator.ts";
import { addDaysISO, todayISO, uid } from "../../model.ts";
import { DEMO_ACCOUNTS } from "../../demoAccounts.ts";
import { notify as notifyLocal } from "../workforce/workforceShared.ts";
import { localFiles, localInfoOpen, recordLocalEvent } from "./threadStore.ts";
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
  paySourceFor,
  SETTLEMENT_MAX_DAYS,
  stepViews,
  waitingStatus,
  type Actor,
  type FlowStep,
  type Instalment,
  type StepView,
} from "./rules.ts";

export type CashStatus = "Submitted" | "Manager approved" | "Approved" | "Paid" | "Settled" | "Rejected" | "Withdrawn";
export type SettlementStatus = "Submitted" | "Verified" | "Rejected";

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
  expectedSettlement?: string;
  tripId?: string;
  project?: string;
  settlementStatus?: SettlementStatus;
  settlementSpent?: number;
  settlementReturned?: number;
  settlementNote?: string;
  settlementOn?: string;
  settlementReference?: string;
  settlementVerifiedBy?: string;
  settlementVerifiedOn?: string;
  /** What a settlement must account for now (the advance less what pay has recovered). */
  settlementDue: number;
  canSettle: boolean;
  canVerifySettlement: boolean;
  settlementOverdue: boolean;
  infoRequested: boolean;
}

export interface CashPolicy {
  limit: number;
  basic: number;
  cap: number;
  currency: string;
  maxInstalments: number;
  categories: readonly string[];
  openId: string | null;
  /** "compensation": limits from your pay record (as on payslips); "standard": the role's standard package. */
  paySource: "compensation" | "standard";
  annualPay: number;
}

export interface CashInput {
  amount: number;
  category: string;
  purpose: string;
  neededBy: string;
  instalments: number;
  expectedSettlement?: string;
  tripId?: string;
  project?: string;
}

export interface SettlementInput {
  spent: number;
  returned: number;
  note: string;
  reference: string;
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
  expectedSettlement?: string;
  tripId?: string;
  project?: string;
  settlementStatus?: SettlementStatus;
  settlementSpent?: number;
  settlementReturned?: number;
  settlementNote?: string;
  settlementOn?: string;
  settlementReference?: string;
  settlementVerifiedBy?: string;
  settlementVerifiedOn?: string;
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

function recoveredOf(row: { status: CashStatus; amount: number; instalments: number; paidOn?: string }, today = todayISO()): number {
  if (row.status !== "Paid" || !row.paidOn) return 0;
  return Math.round(instalmentSchedule(row.amount, row.instalments, row.paidOn, today).filter((i) => i.recovered).reduce((s, i) => s + i.amount, 0) * 100) / 100;
}

function dueOf(row: CashRow, today = todayISO()): number {
  return row.status === "Paid" ? Math.round(Math.max(0, row.amount - recoveredOf(row, today)) * 100) / 100 : 0;
}

function overdueOf(row: CashRow, today = todayISO()): boolean {
  return (
    row.status === "Paid" &&
    !!row.expectedSettlement &&
    row.expectedSettlement < today &&
    row.settlementStatus !== "Submitted" &&
    row.settlementStatus !== "Verified" &&
    dueOf(row, today) > 0
  );
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
    outstanding: row.status === "Settled" ? 0 : outstandingOf(row, today),
    schedule: row.paidOn ? instalmentSchedule(row.amount, row.instalments, row.paidOn, today) : [],
    ...(row.expectedSettlement ? { expectedSettlement: row.expectedSettlement } : {}),
    ...(row.tripId ? { tripId: row.tripId } : {}),
    ...(row.project ? { project: row.project } : {}),
    ...(row.settlementStatus
      ? {
          settlementStatus: row.settlementStatus,
          settlementSpent: row.settlementSpent,
          settlementReturned: row.settlementReturned,
          settlementNote: row.settlementNote,
          settlementOn: row.settlementOn,
          settlementReference: row.settlementReference,
          settlementVerifiedBy: row.settlementVerifiedBy,
          settlementVerifiedOn: row.settlementVerifiedOn,
        }
      : {}),
    settlementDue: dueOf(row, today),
    canSettle: row.status === "Paid" && actor.id === row.employeeId && row.settlementStatus !== "Submitted" && row.settlementStatus !== "Verified" && dueOf(row, today) > 0,
    canVerifySettlement: row.settlementStatus === "Submitted" && actor.id !== row.employeeId && canPayOut(actor.role),
    settlementOverdue: overdueOf(row, today),
    infoRequested: localInfoOpen("cash_advance", row.id),
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
  expected_settlement?: string | null;
  trip_id?: string | null;
  project?: string | null;
  settlement_status?: SettlementStatus | null;
  settlement_spent?: number | null;
  settlement_returned?: number | null;
  settlement_note?: string | null;
  settlement_on?: string | null;
  settlement_reference?: string | null;
  settlement_verified_by?: string | null;
  settlement_verified_on?: string | null;
  settlement_due?: number;
  can_settle?: boolean;
  can_verify_settlement?: boolean;
  settlement_overdue?: boolean;
  info_requested?: boolean;
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
    ...(c.expected_settlement ? { expectedSettlement: c.expected_settlement } : {}),
    ...(c.trip_id ? { tripId: c.trip_id } : {}),
    ...(c.project ? { project: c.project } : {}),
    ...(c.settlement_status
      ? {
          settlementStatus: c.settlement_status,
          settlementSpent: c.settlement_spent ?? undefined,
          settlementReturned: c.settlement_returned ?? undefined,
          settlementNote: c.settlement_note ?? undefined,
          settlementOn: c.settlement_on ?? undefined,
          settlementReference: c.settlement_reference ?? undefined,
          settlementVerifiedBy: c.settlement_verified_by ?? undefined,
          settlementVerifiedOn: c.settlement_verified_on ?? undefined,
        }
      : {}),
    settlementDue: c.settlement_due ?? 0,
    canSettle: !!c.can_settle,
    canVerifySettlement: !!c.can_verify_settlement,
    settlementOverdue: !!c.settlement_overdue,
    infoRequested: !!c.info_requested,
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
  const limits = cashLimitFor(actor.countryCode, actor.role, actor.id);
  const pay = paySourceFor(actor.countryCode, actor.role, actor.id);
  const open = local.get().rows.find((r) => r.employeeId === actor.id && isOpenRow(r));
  return { ...limits, maxInstalments: MAX_INSTALMENTS, categories: CASH_CATEGORIES, openId: open?.id ?? null, paySource: pay.source, annualPay: pay.annual };
}

export async function apiCashPolicy(): Promise<CashPolicy> {
  const p = await api.get<{
    limit: number;
    basic_monthly: number;
    country_cap: number;
    currency: string;
    max_instalments: number;
    categories: string[];
    open_id: string | null;
    pay_source?: "compensation" | "standard";
    annual_pay?: number;
  }>("/cash-advances/policy");
  return {
    limit: p.limit,
    basic: p.basic_monthly,
    cap: p.country_cap,
    currency: p.currency,
    maxInstalments: p.max_instalments,
    categories: p.categories,
    openId: p.open_id,
    paySource: p.pay_source ?? "standard",
    annualPay: p.annual_pay ?? 0,
  };
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
  if (!input.purpose.trim()) return "Describe what the money is for.";
  if (input.expectedSettlement && input.expectedSettlement < input.neededBy) return "The settlement date can't be before the date you need the money.";
  if (input.expectedSettlement && input.expectedSettlement > addDaysISO(input.neededBy, SETTLEMENT_MAX_DAYS))
    return `Settle within ${SETTLEMENT_MAX_DAYS} days of receiving the advance.`;
  if (policy.openId) return "You already have an open cash advance. Finish repaying it first.";
  return null;
}

/** Sends the request; resolves to its id, or the error. */
export async function submitCash(actor: Actor & { countryCode?: string }, input: CashInput, policy: CashPolicy): Promise<{ error: string | null; id?: string }> {
  const problem = check(input, policy);
  if (problem) return { error: problem };
  if (API_ENABLED) {
    let id: string | undefined;
    const failed = await apiRun(async () => {
      const out = await api.post<CashOut>("/cash-advances", {
          amount: input.amount,
          category: input.category,
          purpose: input.purpose.trim(),
          needed_by: input.neededBy,
          instalments: input.instalments,
          currency: policy.currency,
          expected_settlement: input.expectedSettlement || null,
          trip_id: input.tripId || null,
          project: input.project?.trim() || null,
        });
      id = out.id;
    }, cashMirror);
    return failed ? { error: failed } : { error: null, id };
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
    ...(input.expectedSettlement ? { expectedSettlement: input.expectedSettlement } : {}),
    ...(input.tripId ? { tripId: input.tripId } : {}),
    ...(input.project?.trim() ? { project: input.project.trim().slice(0, 120) } : {}),
  };
  const error = local.set({ rows: [row, ...local.get().rows] });
  if (!error) {
    recordLocalEvent("cash_advance", row.id, "cash_advance_submitted", actor.fullName);
    const first = row.steps[0];
    first?.approverIds.forEach((id) => notifyLocal(id, `Cash advance to approve · ${actor.fullName}`, `${row.amount} ${row.currency} · ${row.category}`, `/cash?open=${row.id}`));
  }
  return error ? { error } : { error: null, id: row.id };
}

/* ───────────── Settlement ───────────── */

export async function settleCash(actor: Actor, id: string, input: SettlementInput): Promise<string | null> {
  const spent = Math.round(input.spent * 100) / 100;
  const returned = Math.round(input.returned * 100) / 100;
  if (!Number.isFinite(spent) || !Number.isFinite(returned) || spent < 0 || returned < 0) return "Enter the amounts spent and returned.";
  if (API_ENABLED) {
    return apiRun(
      () =>
        api.post(`/cash-advances/${encodeURIComponent(id)}/settlement`, {
          spent,
          returned,
          note: input.note.trim(),
          reference: input.reference.trim() || null,
        }),
      cashMirror,
    );
  }
  return mutate(id, (row) => {
    if (row.employeeId !== actor.id) return "Only the person who received the advance can settle it.";
    if (row.status !== "Paid") return "Only a paid advance can be settled.";
    if (row.settlementStatus === "Submitted" || row.settlementStatus === "Verified") return `The settlement is already ${row.settlementStatus.toLowerCase()}.`;
    const due = dueOf(row);
    if (spent > due) return `You can account for up to ${due.toFixed(2)} ${row.currency}. Claim anything more as a reimbursement.`;
    if (Math.abs(spent + returned - due) > 0.01) return `Spent plus returned must equal ${due.toFixed(2)} ${row.currency} (the advance less what pay has recovered).`;
    if (returned > 0 && !input.reference.trim()) return "Add the reference of the transfer that returned the unspent money.";
    if (spent > 0 && !localFiles("cash_advance", row.id).some((f) => f.purpose === "settlement")) return "Attach the receipts for what you spent first.";
    row.settlementStatus = "Submitted";
    row.settlementSpent = spent;
    row.settlementReturned = returned;
    row.settlementNote = input.note.trim() || undefined;
    row.settlementReference = input.reference.trim() || undefined;
    row.settlementOn = todayISO();
    row.settlementVerifiedBy = undefined;
    row.settlementVerifiedOn = undefined;
    recordLocalEvent("cash_advance", row.id, "cash_advance_settlement_submitted", actor.fullName);
    for (const a of DEMO_ACCOUNTS) if (a.id !== actor.id && canPayOut(a.role)) notifyLocal(a.id, `${actor.fullName} settled a cash advance`, `Spent ${spent}, returned ${returned} ${row.currency}. Verify it.`, `/cash?open=${row.id}`);
    return null;
  });
}

export async function verifySettlement(actor: Actor, id: string, decision: "verify" | "reject", note: string): Promise<string | null> {
  if (decision === "reject" && !note.trim()) return "Add a note saying what is missing.";
  if (API_ENABLED) {
    return apiRun(() => api.post(`/cash-advances/${encodeURIComponent(id)}/settlement/decision`, { decision, note: note.trim() || null }), cashMirror);
  }
  return mutate(id, (row) => {
    if (row.settlementStatus !== "Submitted") return "There is no settlement waiting to be verified.";
    if (row.employeeId === actor.id) return "You can't verify your own settlement.";
    if (!canPayOut(actor.role)) return "Only finance or HR can verify a settlement.";
    row.settlementStatus = decision === "verify" ? "Verified" : "Rejected";
    row.settlementVerifiedBy = actor.fullName;
    row.settlementVerifiedOn = todayISO();
    if (note.trim()) row.settlementNote = `${row.settlementNote ? `${row.settlementNote}\n` : ""}${actor.fullName}: ${note.trim()}`;
    if (decision === "verify") row.status = "Settled";
    recordLocalEvent("cash_advance", row.id, `cash_advance_settlement_${decision === "verify" ? "verified" : "rejected"}`, actor.fullName);
    notifyLocal(
      row.employeeId,
      decision === "verify" ? "Cash advance settled" : "Cash advance settlement sent back",
      decision === "verify" ? "Nothing more will be recovered from your pay." : note.trim(),
      `/cash?open=${row.id}`,
    );
    return null;
  });
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
    recordLocalEvent("cash_advance", row.id, decision === "approve" ? "cash_advance_approved" : "cash_advance_rejected", actor.fullName);
    if (result.outcome) notifyLocal(row.employeeId, `Cash advance ${result.outcome}`, note.trim() || (result.outcome === "approved" ? "It will be paid to your bank account soon." : ""), `/cash?open=${row.id}`);
    return null;
  });
}

export async function withdrawCash(actor: Actor, id: string): Promise<string | null> {
  if (API_ENABLED) return apiRun(() => api.post(`/cash-advances/${encodeURIComponent(id)}/withdraw`), cashMirror);
  return mutate(id, (row) => {
    if (row.employeeId !== actor.id) return "Only the person who asked can withdraw it.";
    if (!PENDING.includes(row.status)) return "It can only be withdrawn while it waits for approval.";
    row.status = "Withdrawn";
    recordLocalEvent("cash_advance", row.id, "cash_advance_withdrawn", actor.fullName);
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
    recordLocalEvent("cash_advance", row.id, "cash_advance_paid", actor.fullName);
    notifyLocal(row.employeeId, "Cash advance paid", `Reference ${row.reference}.`, `/cash?open=${row.id}`);
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
