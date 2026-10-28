/** Configurable approval steps per request type (expense, travel, lifecycle). Saved in this browser. */
import { useSyncExternalStore } from "react";
import { DEMO_ACCOUNTS, managementChain, type DemoAccount } from "../demoAccounts.ts";

export type WorkflowType = "expense" | "travel" | "lifecycle";
export type ApprovalStepRole = "manager" | "skip_manager" | "hr" | "finance" | "admin";

export interface ApprovalStep {
  role: ApprovalStepRole;
  label: string;
  /** Step only applies when the amount is at least this much. */
  minAmount?: number;
}

export type ApprovalWorkflows = Record<WorkflowType, ApprovalStep[]>;

export const WORKFLOW_TYPES: { id: WorkflowType; label: string }[] = [
  { id: "expense", label: "Expense claims" },
  { id: "travel", label: "Travel requests" },
  { id: "lifecycle", label: "Lifecycle changes" },
];

export const STEP_ROLES: { id: ApprovalStepRole; label: string }[] = [
  { id: "manager", label: "Manager" },
  { id: "skip_manager", label: "Manager's manager" },
  { id: "hr", label: "HR" },
  { id: "finance", label: "Finance" },
  { id: "admin", label: "Admin" },
];

/** Expense claims at or above this amount also need Finance by default. */
export const EXPENSE_FINANCE_THRESHOLD = 10000;

export const DEFAULT_WORKFLOWS: ApprovalWorkflows = {
  expense: [
    { role: "manager", label: "Manager approval" },
    { role: "finance", label: "Finance approval", minAmount: EXPENSE_FINANCE_THRESHOLD },
  ],
  travel: [
    { role: "manager", label: "Manager approval" },
    { role: "hr", label: "HR approval" },
  ],
  lifecycle: [
    { role: "manager", label: "Manager approval" },
    { role: "hr", label: "HR approval" },
  ],
};

const KEY = "kastech.approvalWorkflows.v1";
const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cached: ApprovalWorkflows = DEFAULT_WORKFLOWS;

const ROLE_IDS = new Set<string>(STEP_ROLES.map((r) => r.id));

function cleanSteps(value: unknown): ApprovalStep[] | null {
  if (!Array.isArray(value)) return null;
  const steps: ApprovalStep[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const step = item as Partial<ApprovalStep>;
    if (!step.role || !ROLE_IDS.has(step.role)) continue;
    const label = typeof step.label === "string" && step.label.trim() ? step.label.trim() : roleLabel(step.role);
    const min = typeof step.minAmount === "number" && Number.isFinite(step.minAmount) && step.minAmount > 0 ? step.minAmount : undefined;
    steps.push(min === undefined ? { role: step.role, label } : { role: step.role, label, minAmount: min });
  }
  return steps;
}

function read(): ApprovalWorkflows {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    raw = null;
  }
  if (raw === cachedRaw) return cached;
  cachedRaw = raw;
  let parsed: Partial<Record<WorkflowType, unknown>> = {};
  try {
    parsed = raw ? (JSON.parse(raw) as Partial<Record<WorkflowType, unknown>>) : {};
  } catch {
    parsed = {};
  }
  cached = {
    expense: cleanSteps(parsed.expense) ?? DEFAULT_WORKFLOWS.expense,
    travel: cleanSteps(parsed.travel) ?? DEFAULT_WORKFLOWS.travel,
    lifecycle: cleanSteps(parsed.lifecycle) ?? DEFAULT_WORKFLOWS.lifecycle,
  };
  return cached;
}

function write(next: ApprovalWorkflows) {
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    cachedRaw = undefined;
    cached = next;
  }
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY) fn();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(fn);
    window.removeEventListener("storage", onStorage);
  };
}

export function roleLabel(role: ApprovalStepRole): string {
  return STEP_ROLES.find((r) => r.id === role)?.label ?? role;
}

export function getApprovalWorkflows(): ApprovalWorkflows {
  return read();
}

export function useApprovalWorkflows(): ApprovalWorkflows {
  return useSyncExternalStore(subscribe, read, read);
}

/** Save the steps for one workflow. An empty list means requests are approved on submit. */
export function saveApprovalSteps(type: WorkflowType, steps: ApprovalStep[]): void {
  const current = read();
  write({ ...current, [type]: cleanSteps(steps) ?? [] });
}

export function resetApprovalSteps(type: WorkflowType): void {
  saveApprovalSteps(type, DEFAULT_WORKFLOWS[type]);
}

/** Steps that apply to a request of this type and amount (steps with a min amount are skipped below it). */
export function approvalStepsFor(type: WorkflowType, amount?: number): ApprovalStep[] {
  return read()[type].filter((step) => step.minAmount === undefined || (amount ?? 0) >= step.minAmount);
}

function idsWithRole(roles: string[], accounts: readonly DemoAccount[]): string[] {
  return accounts.filter((a) => roles.includes(a.role)).map((a) => a.id);
}

/** Account ids who can decide this step for this employee (never the employee themselves). */
export function approversForStep(step: ApprovalStep, employeeId: string, accounts: readonly DemoAccount[] = DEMO_ACCOUNTS): string[] {
  let ids: string[] = [];
  switch (step.role) {
    case "manager":
      ids = managementChain(employeeId, accounts).slice(0, 1).map((m) => m.id);
      break;
    case "skip_manager":
      ids = managementChain(employeeId, accounts).slice(1, 2).map((m) => m.id);
      break;
    case "hr":
      ids = idsWithRole(["hr", "hr_admin"], accounts);
      break;
    case "finance":
      ids = idsWithRole(["finance"], accounts);
      if (ids.length === 0) ids = idsWithRole(["admin", "super_admin"], accounts);
      if (ids.length === 0) ids = idsWithRole(["hr", "hr_admin"], accounts);
      break;
    case "admin":
      ids = idsWithRole(["admin", "super_admin"], accounts);
      break;
  }
  return ids.filter((id) => id !== employeeId);
}

/** A step with its resolved approvers. */
export interface ResolvedStep extends ApprovalStep {
  approverIds: string[];
}

/** Steps for this employee, with approvers resolved. Steps nobody can decide are dropped. */
export function resolveWorkflow(type: WorkflowType, employeeId: string, amount?: number): ResolvedStep[] {
  return approvalStepsFor(type, amount)
    .map((step) => ({ ...step, approverIds: approversForStep(step, employeeId) }))
    .filter((step) => step.approverIds.length > 0);
}

/** One decision on one step of a request. */
export interface StepDecision {
  step: number;
  role: ApprovalStepRole;
  label: string;
  decision: "approved" | "rejected";
  byId: string;
  byName: string;
  on: string;
  note?: string;
}
