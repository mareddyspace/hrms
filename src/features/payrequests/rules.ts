/**
 * Rules shared by cash advances, leave encashment and software requests. The backend applies the same numbers
 * (backend/app/services/self_service.py), so local and backend modes agree.
 */
import { claimLimitsFor, payRulesFor } from "../../countryPay.ts";
import { DEMO_ACCOUNTS } from "../../demoAccounts.ts";
import { payScaleFor } from "../../data/payslipGenerator.ts";
import { addDaysISO, todayISO, type CountryCode, type UserRole } from "../../model.ts";
import { addMonthsISO, isAboveInLine, isHrRole, lineManagerId, personName } from "../lifecycle/lifecycleShared.ts";

export const CASH_CATEGORIES = ["Medical", "Family event", "Education", "Relocation", "Home repair", "Travel", "Other"] as const;
export const MAX_INSTALMENTS = 6;
export const NEEDED_BY_MAX_DAYS = 90;

export const ENCASHABLE_CODES = ["pto"];
export const ENCASH_MAX_DAYS_A_YEAR = 10;
export const ENCASH_KEEP_DAYS = 5;
export const ENCASH_CUTOFF_DAY = 20;
const WORKING_DAYS_A_MONTH = 22;

export const IT_ROLES: string[] = ["admin", "super_admin", "it_admin"];
export const isItRole = (role: string) => IT_ROLES.includes(role);
export const canPayOut = (role: UserRole | string) => isHrRole(role as UserRole) || role === "finance" || role === "admin" || role === "super_admin";

/** One month's basic pay (the first pay line × seniority), as on the payslips. */
export function basicMonthly(countryCode: CountryCode | string | undefined, role: UserRole | string): number {
  const rules = payRulesFor(countryCode as CountryCode);
  return Math.round((rules.earnings[0]?.amount ?? 0) * payScaleFor(role));
}

export function cashLimitFor(countryCode: CountryCode | string | undefined, role: UserRole | string) {
  const basic = basicMonthly(countryCode, role);
  const cap = claimLimitsFor(countryCode as CountryCode).maxCashAdvance;
  return { limit: Math.min(basic, cap), basic, cap, currency: payRulesFor(countryCode as CountryCode).currency };
}

export function perDayPay(countryCode: CountryCode | string | undefined, role: UserRole | string): number {
  return Math.round((basicMonthly(countryCode, role) / WORKING_DAYS_A_MONTH) * 100) / 100;
}

export function monthKey(iso: string): string {
  return iso.slice(0, 7);
}

/** "2026-11" → "Nov 2026". */
export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, 1).toLocaleDateString("en-GB", { month: "short", year: "numeric" });
}

export interface Instalment {
  month: string;
  amount: number;
  recovered: boolean;
}

/** Equal monthly instalments from the month after `paidOn` (the last one takes the rounding). */
export function instalmentSchedule(amount: number, count: number, paidOn: string, today = todayISO()): Instalment[] {
  const n = Math.max(1, count);
  const each = Math.round((amount / n) * 100) / 100;
  const start = addMonthsISO(`${paidOn.slice(0, 7)}-01`, 1);
  return Array.from({ length: n }, (_, i) => {
    const month = monthKey(addMonthsISO(start, i));
    const value = i === n - 1 ? Math.round((amount - each * (n - 1)) * 100) / 100 : each;
    return { month, amount: value, recovered: month < monthKey(today) };
  });
}

/** Preview before it is paid: as if paid today. */
export function previewSchedule(amount: number, count: number, today = todayISO()): Instalment[] {
  return instalmentSchedule(amount, count, today, today).map((i) => ({ ...i, recovered: false }));
}

export function payoutMonth(approvedOn: string): string {
  const day = Number(approvedOn.slice(8, 10));
  return day <= ENCASH_CUTOFF_DAY ? monthKey(approvedOn) : monthKey(addMonthsISO(`${approvedOn.slice(0, 7)}-01`, 1));
}

export function neededByMax(today = todayISO()): string {
  return addDaysISO(today, NEEDED_BY_MAX_DAYS);
}

/* ───────────── Local approval steps (browser mode) ───────────── */

/** "named": only the listed approvers (fallback when nobody else holds the role, e.g. HR's own request). */
export type StepKind = "manager" | "hr" | "it" | "named";

export interface FlowStep {
  label: string;
  kind: StepKind;
  approverIds: string[];
  decision?: "approve" | "reject";
  byId?: string;
  by?: string;
  note?: string;
  on?: string;
}

/** Shown on every page, whichever mode: what each step is and who decided it. */
export interface StepView {
  label: string;
  approverNames: string[];
  decision: "approve" | "reject" | null;
  by?: string;
  note?: string;
  on?: string;
}

export type Actor = { id: string; fullName: string; role: UserRole };

function idsWithRole(test: (role: string) => boolean, except: string): string[] {
  return DEMO_ACCOUNTS.filter((a) => test(a.role) && a.id !== except).map((a) => a.id);
}

/** Manager (when there is one), then HR or IT. */
export function buildSteps(employeeId: string, second: { kind: "hr" | "it"; label: string }): FlowStep[] {
  const steps: FlowStep[] = [];
  const manager = lineManagerId(employeeId);
  if (manager) steps.push({ label: "Manager", kind: "manager", approverIds: [manager] });
  // Never the requester; the manager doesn't approve twice. Nobody left (HR asking for themselves): admin, then the executive.
  const ids = (second.kind === "hr" ? idsWithRole((r) => isHrRole(r as UserRole), employeeId) : idsWithRole(isItRole, employeeId)).filter((id) => id !== manager);
  if (ids.length) {
    steps.push({ label: second.label, kind: second.kind, approverIds: ids });
  } else {
    const fallback = [...idsWithRole((r) => r === "admin" || r === "super_admin", employeeId), ...idsWithRole((r) => r === "executive", employeeId)].filter(
      (id) => id !== manager,
    );
    if (fallback.length) steps.push({ label: second.label, kind: "named", approverIds: fallback });
  }
  return steps;
}

export function currentStepIndex(steps: FlowStep[]): number {
  return steps.findIndex((s) => !s.decision);
}

export function canActOnStep(actor: Actor, employeeId: string, steps: FlowStep[]): boolean {
  const index = currentStepIndex(steps);
  if (index < 0 || actor.id === employeeId) return false;
  if (steps.some((s, i) => i < index && s.byId === actor.id)) return false;
  const step = steps[index];
  if (step.kind === "manager") return isAboveInLine(actor.id, employeeId);
  if (step.kind === "hr") return isHrRole(actor.role);
  if (step.kind === "named") return step.approverIds.includes(actor.id);
  return isItRole(actor.role);
}

/** Records the decision. Returns the outcome when the last step (or a rejection) closes it, or an error. */
export function decideStep(
  actor: Actor,
  employeeId: string,
  steps: FlowStep[],
  decision: "approve" | "reject",
  note: string,
): { steps: FlowStep[]; outcome: "approved" | "rejected" | null } | string {
  if (actor.id === employeeId) return "You can't decide your own request.";
  if (!canActOnStep(actor, employeeId, steps)) return "This step is waiting for someone else.";
  if (decision === "reject" && !note.trim()) return "Add a note saying why.";
  const index = currentStepIndex(steps);
  const next = steps.map((s, i) =>
    i === index ? { ...s, decision, byId: actor.id, by: actor.fullName, note: note.trim() || undefined, on: todayISO() } : s,
  );
  if (decision === "reject") return { steps: next, outcome: "rejected" };
  return { steps: next, outcome: currentStepIndex(next) < 0 ? "approved" : null };
}

/** "Submitted" until the first step is approved, then "Manager approved" while the next waits. */
export function waitingStatus(steps: FlowStep[]): "Submitted" | "Manager approved" {
  return steps.some((s) => s.decision === "approve") ? "Manager approved" : "Submitted";
}

export function stepViews(steps: FlowStep[]): StepView[] {
  return steps.map((s) => ({
    label: s.label,
    approverNames: s.approverIds.map((id) => personName(id, id)),
    decision: s.decision ?? null,
    by: s.by,
    note: s.note,
    on: s.on,
  }));
}

/** Who to show as waiting for the open step. */
export function waitingOn(steps: StepView[]): string | null {
  const open = steps.find((s) => !s.decision);
  if (!open) return null;
  return open.approverNames.length ? `${open.label} · ${open.approverNames.slice(0, 2).join(", ")}` : open.label;
}
