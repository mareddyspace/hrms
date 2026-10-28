/**
 * Configurable approval steps per request type (expense, travel, lifecycle, requisition, compensation).
 * Saved in this browser, with a version history per type. A step can be "parallel": several approver
 * groups (e.g. HR + Finance) that must all approve, or any one of them.
 */
import { useSyncExternalStore } from "react";
import { DEMO_ACCOUNTS, managementChain, type DemoAccount } from "../demoAccounts.ts";
import type { ExpenseApprovalStep, ExpenseStepDecision } from "../model.ts";

export type WorkflowType = "expense" | "travel" | "lifecycle" | "requisition" | "compensation";
export type ApprovalStepRole = "manager" | "skip_manager" | "hr" | "finance" | "admin" | "executive";
/** Parallel steps: "all" — every group approves; "any" — one approval from any group closes the step. */
export type ParallelMode = "all" | "any";
/** Roles older saved requests (expense claims) know about. Executive steps are stored as "admin" there. */
export type LegacyStepRole = ExpenseApprovalStep["role"];

export interface ApprovalStep {
  /** The first (or only) approver role. */
  role: ApprovalStepRole;
  /** Two or more roles make a parallel step. Older saved steps have none. */
  roles?: ApprovalStepRole[];
  /** Parallel steps only; "all" when missing. */
  mode?: ParallelMode;
  label: string;
  /** Step only applies when the amount is at least this much. */
  minAmount?: number;
  /** Step only applies when the increase is at least this percent (pay proposals). */
  minPercent?: number;
  /** Backend mode: hours the step may wait before it is escalated. */
  slaHours?: number;
  /** Backend mode: the step only applies when the requester's country / department / grade is one of these. */
  condition?: StepCondition;
  /** Backend mode (leave): the step only applies when the leave needs HR (long, unpaid, maternity...). */
  onlyIf?: "needs_hr";
}

export interface StepCondition {
  field: "country" | "department" | "grade";
  values: string[];
}

export type ApprovalWorkflows = Record<WorkflowType, ApprovalStep[]>;

export const WORKFLOW_TYPES: { id: WorkflowType; label: string }[] = [
  { id: "expense", label: "Expense claims" },
  { id: "travel", label: "Travel requests" },
  { id: "lifecycle", label: "Lifecycle changes" },
  { id: "requisition", label: "Job requisitions" },
  { id: "compensation", label: "Pay proposals" },
];

export const STEP_ROLES: { id: ApprovalStepRole; label: string }[] = [
  { id: "manager", label: "Manager" },
  { id: "skip_manager", label: "Manager's manager" },
  { id: "hr", label: "HR" },
  { id: "finance", label: "Finance" },
  { id: "admin", label: "Admin" },
  { id: "executive", label: "Executive" },
];

/** Expense claims at or above this amount also need Finance by default. */
export const EXPENSE_FINANCE_THRESHOLD = 10000;
/** Pay increases at or above this percent also need an executive by default. */
export const COMP_EXECUTIVE_THRESHOLD_PCT = 10;

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
  // The hiring manager raises it; "manager" here is the hiring manager, so the department head is the step above.
  requisition: [
    { role: "skip_manager", label: "Department head approval" },
    { role: "hr", label: "HR approval" },
    { role: "finance", label: "Finance approval" },
  ],
  // The manager proposes it; the proposer never approves their own proposal.
  compensation: [
    { role: "hr", label: "HR approval" },
    { role: "finance", roles: ["finance", "admin"], mode: "any", label: "Compensation approval" },
    { role: "executive", label: "Executive approval", minPercent: COMP_EXECUTIVE_THRESHOLD_PCT },
  ],
};

/** Workflows where the reporting line starts at the requester (they are the "manager" of the new hire). */
export const LINE_FROM_REQUESTER: WorkflowType[] = ["requisition"];
/** Workflows that use the amount threshold / the percent threshold in the editor. */
export const AMOUNT_TYPES: WorkflowType[] = ["expense", "travel"];
export const PERCENT_TYPES: WorkflowType[] = ["compensation"];

/* ───────────── Storage (with version history) ───────────── */

export interface WorkflowVersion {
  version: number;
  steps: ApprovalStep[];
  changedById?: string;
  changedBy?: string;
  /** ISO date-time. */
  changedOn?: string;
}

export interface WorkflowRecord extends WorkflowVersion {
  /** Earlier versions, newest first. */
  history: WorkflowVersion[];
}

type Store = Record<WorkflowType, WorkflowRecord>;

const KEY = "kastech.approvalWorkflows.v2";
const OLD_KEY = "kastech.approvalWorkflows.v1";
const MAX_HISTORY = 20;
const TYPE_IDS = WORKFLOW_TYPES.map((t) => t.id);
const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cachedStore: Store = defaultStore();
let cachedSteps: ApprovalWorkflows = DEFAULT_WORKFLOWS;

const ROLE_IDS = new Set<string>(STEP_ROLES.map((r) => r.id));

function defaultStore(): Store {
  const out = {} as Store;
  for (const type of TYPE_IDS) out[type] = { version: 1, steps: DEFAULT_WORKFLOWS[type], history: [] };
  return out;
}

const positive = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined);

function cleanStep(item: unknown): ApprovalStep | null {
  if (!item || typeof item !== "object") return null;
  const step = item as Partial<ApprovalStep>;
  const roles = [...new Set([step.role, ...(Array.isArray(step.roles) ? step.roles : [])])].filter(
    (r): r is ApprovalStepRole => typeof r === "string" && ROLE_IDS.has(r),
  );
  if (!roles.length) return null;
  const label = typeof step.label === "string" && step.label.trim() ? step.label.trim() : stepDefaultLabel(roles);
  const out: ApprovalStep = { role: roles[0]!, label };
  if (roles.length > 1) {
    out.roles = roles;
    out.mode = step.mode === "any" ? "any" : "all";
  }
  const min = positive(step.minAmount);
  if (min !== undefined) out.minAmount = min;
  const pct = positive(step.minPercent);
  if (pct !== undefined) out.minPercent = pct;
  return out;
}

function cleanSteps(value: unknown): ApprovalStep[] | null {
  if (!Array.isArray(value)) return null;
  return value.map(cleanStep).filter((s): s is ApprovalStep => !!s);
}

function cleanVersion(value: unknown): WorkflowVersion | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<WorkflowVersion>;
  const steps = cleanSteps(v.steps);
  if (!steps || typeof v.version !== "number") return null;
  return {
    version: v.version,
    steps,
    ...(typeof v.changedById === "string" ? { changedById: v.changedById } : {}),
    ...(typeof v.changedBy === "string" ? { changedBy: v.changedBy } : {}),
    ...(typeof v.changedOn === "string" ? { changedOn: v.changedOn } : {}),
  };
}

function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function read(): Store {
  const raw = readRaw(KEY);
  if (raw === cachedRaw) return cachedStore;
  cachedRaw = raw;
  const store = defaultStore();
  try {
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Record<WorkflowType, unknown>>;
      for (const type of TYPE_IDS) {
        const rec = cleanVersion(parsed[type]);
        if (!rec) continue;
        const history = Array.isArray((parsed[type] as { history?: unknown }).history)
          ? ((parsed[type] as { history: unknown[] }).history.map(cleanVersion).filter(Boolean) as WorkflowVersion[])
          : [];
        store[type] = { ...rec, history };
      }
    } else {
      // Version 1 kept only the steps per type: they become version 1.
      const old = readRaw(OLD_KEY);
      const parsed = old ? (JSON.parse(old) as Partial<Record<WorkflowType, unknown>>) : {};
      for (const type of TYPE_IDS) {
        const steps = cleanSteps(parsed[type]);
        if (steps) store[type] = { version: 1, steps, history: [] };
      }
    }
  } catch {
    // Damaged data: defaults.
  }
  cachedStore = store;
  cachedSteps = Object.fromEntries(TYPE_IDS.map((t) => [t, store[t].steps])) as ApprovalWorkflows;
  return cachedStore;
}

function write(next: Store) {
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable: keep the change in memory for this session.
    cachedStore = next;
    cachedSteps = Object.fromEntries(TYPE_IDS.map((t) => [t, next[t].steps])) as ApprovalWorkflows;
    cachedRaw = readRaw(KEY);
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

function readSteps(): ApprovalWorkflows {
  read();
  return cachedSteps;
}

export function roleLabel(role: ApprovalStepRole): string {
  return STEP_ROLES.find((r) => r.id === role)?.label ?? role;
}

/** Roles of a step: several for a parallel step, otherwise just its role. */
export function stepRoles(step: Pick<ApprovalStep, "role" | "roles">): ApprovalStepRole[] {
  return step.roles && step.roles.length > 1 ? step.roles : [step.role];
}

export function isParallelStep(step: Pick<ApprovalStep, "role" | "roles">): boolean {
  return stepRoles(step).length > 1;
}

/** "HR approval", "HR + Finance approval", "HR or Finance approval". */
export function stepDefaultLabel(roles: ApprovalStepRole[], mode: ParallelMode = "all"): string {
  return `${roles.map(roleLabel).join(mode === "any" ? " or " : " + ")} approval`;
}

export function getApprovalWorkflows(): ApprovalWorkflows {
  return readSteps();
}

export function useApprovalWorkflows(): ApprovalWorkflows {
  return useSyncExternalStore(subscribe, readSteps, readSteps);
}

/** Steps, version and history for every type. */
export function getWorkflowRecords(): Record<WorkflowType, WorkflowRecord> {
  return read();
}

export function useWorkflowRecords(): Record<WorkflowType, WorkflowRecord> {
  return useSyncExternalStore(subscribe, read, read);
}

/** Current version number of a workflow (stored on requests when they start). */
export function workflowVersion(type: WorkflowType): number {
  return read()[type].version;
}

/**
 * Save the steps for one workflow as a new version (the previous steps go to the history). An empty list
 * means requests are approved on submit. Saving the same steps again does nothing.
 */
export function saveApprovalSteps(type: WorkflowType, steps: ApprovalStep[], by?: { id: string; fullName: string }): void {
  const store = read();
  const current = store[type];
  const clean = cleanSteps(steps) ?? [];
  if (JSON.stringify(clean) === JSON.stringify(current.steps)) return;
  const previous: WorkflowVersion = {
    version: current.version,
    steps: current.steps,
    ...(current.changedById ? { changedById: current.changedById } : {}),
    ...(current.changedBy ? { changedBy: current.changedBy } : {}),
    ...(current.changedOn ? { changedOn: current.changedOn } : {}),
  };
  write({
    ...store,
    [type]: {
      version: current.version + 1,
      steps: clean,
      ...(by ? { changedById: by.id, changedBy: by.fullName } : {}),
      changedOn: new Date().toISOString(),
      history: [previous, ...current.history].slice(0, MAX_HISTORY),
    },
  });
}

export function resetApprovalSteps(type: WorkflowType, by?: { id: string; fullName: string }): void {
  saveApprovalSteps(type, DEFAULT_WORKFLOWS[type], by);
}

/* ───────────── Resolving approvers ───────────── */

export interface ResolveOptions {
  amount?: number;
  /** Pay increase in percent (pay proposals). */
  percent?: number;
  /** People who may not approve (e.g. whoever raised or proposed it). */
  excludeIds?: string[];
}

function applies(step: ApprovalStep, opts: ResolveOptions): boolean {
  if (step.minAmount !== undefined && (opts.amount ?? 0) < step.minAmount) return false;
  if (step.minPercent !== undefined && (opts.percent ?? 0) < step.minPercent) return false;
  return true;
}

/** Steps that apply to a request of this type and amount (steps with a min amount are skipped below it). */
export function approvalStepsFor(type: WorkflowType, amount?: number, percent?: number): ApprovalStep[] {
  return readSteps()[type].filter((step) => applies(step, { amount, percent }));
}

function idsWithRole(roles: string[], accounts: readonly DemoAccount[]): string[] {
  return accounts.filter((a) => roles.includes(a.role)).map((a) => a.id);
}

/**
 * Account ids for one role, for this employee (never the employee themselves). With `lineFromSelf`, the
 * employee counts as the "manager" (a requisition's hiring manager), so "manager's manager" is the person above them.
 */
export function approversForRole(
  role: ApprovalStepRole,
  employeeId: string,
  accounts: readonly DemoAccount[] = DEMO_ACCOUNTS,
  lineFromSelf = false,
): string[] {
  const chain = () => {
    const above = managementChain(employeeId, accounts).map((m) => m.id);
    return lineFromSelf ? [employeeId, ...above] : above;
  };
  let ids: string[] = [];
  switch (role) {
    case "manager":
      ids = chain().slice(0, 1);
      break;
    case "skip_manager":
      ids = chain().slice(1, 2);
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
    case "executive":
      ids = idsWithRole(["executive", "founder", "cofounder"], accounts);
      if (ids.length === 0) ids = idsWithRole(["super_admin"], accounts);
      break;
  }
  return ids.filter((id) => id !== employeeId);
}

/** Account ids who can decide this step for this employee (all its roles; never the employee themselves). */
export function approversForStep(
  step: Pick<ApprovalStep, "role" | "roles">,
  employeeId: string,
  accounts: readonly DemoAccount[] = DEMO_ACCOUNTS,
): string[] {
  return [...new Set(stepRoles(step).flatMap((role) => approversForRole(role, employeeId, accounts)))];
}

/** One approver group of a step (a single-role step has none; a parallel step has one per role). */
export interface FlowGroup {
  role: ApprovalStepRole;
  label: string;
  approverIds: string[];
}

/** A step fixed on a request when it starts. Compatible with the expense claim step shape. */
export interface FlowStep {
  role: LegacyStepRole;
  label: string;
  /** Everyone who can act on this step (all groups). */
  approverIds: string[];
  /** Parallel steps only. */
  mode?: ParallelMode;
  groups?: FlowGroup[];
}

/** One decision on one step (and, for parallel steps, one group) of a request. */
export interface FlowDecision extends ExpenseStepDecision {
  role?: ApprovalStepRole;
  /** Index into the step's groups, for parallel steps. */
  group?: number;
}

export function legacyRole(role: ApprovalStepRole): LegacyStepRole {
  return role === "executive" ? "admin" : role;
}

/** Fallback when a group loses everyone because they approved an earlier step: admin, then executive. */
function fallbackFor(role: string, employeeId: string, blocked: ReadonlySet<string>, accounts: readonly DemoAccount[]): string[] {
  const order: ApprovalStepRole[] = role === "executive" ? [] : role === "admin" ? ["executive"] : ["admin", "executive"];
  for (const alt of order) {
    const ids = approversForRole(alt, employeeId, accounts).filter((id) => !blocked.has(id));
    if (ids.length) return ids;
  }
  return [];
}

/** Drop earlier approvers from a group; if that empties it, fall back (still never them). */
function keepApprovers(role: string, ids: string[], employeeId: string, prior: ReadonlySet<string>, blocked: ReadonlySet<string>, accounts: readonly DemoAccount[]): string[] {
  const left = ids.filter((id) => !blocked.has(id));
  if (left.length || !ids.some((id) => prior.has(id))) return left;
  return fallbackFor(role, employeeId, blocked, accounts);
}

/** People who will have approved this step once it completes (the only person in a group that must approve). */
function certainApprovers(step: Pick<FlowStep, "approverIds" | "mode" | "groups">): string[] {
  if (new Set(step.approverIds).size === 1) return [step.approverIds[0]!];
  if (step.groups && step.mode !== "any") return step.groups.filter((g) => g.approverIds.length === 1).map((g) => g.approverIds[0]!);
  return [];
}

type RetargetStep = { role: string; approverIds: string[]; groups?: { role: string; approverIds: string[] }[] };

/**
 * A later step of a request without anyone who approved an earlier step (nobody approves two steps). A group left
 * empty falls back to admin, then executive; returns null when nobody is left (the step is skipped).
 */
export function withoutPriorApprovers<S extends RetargetStep>(
  step: S,
  prior: ReadonlySet<string>,
  employeeId: string,
  excludeIds: Iterable<string> = [],
  accounts: readonly DemoAccount[] = DEMO_ACCOUNTS,
): S | null {
  const blocked = new Set([...prior, ...excludeIds, employeeId]);
  if (step.groups && step.groups.length > 1) {
    const groups = step.groups
      .map((g) => ({ ...g, approverIds: keepApprovers(g.role, g.approverIds, employeeId, prior, blocked, accounts) }))
      .filter((g) => g.approverIds.length);
    if (!groups.length) return null;
    return { ...step, groups, approverIds: [...new Set(groups.flatMap((g) => g.approverIds))] };
  }
  const approverIds = keepApprovers(step.groups?.[0]?.role ?? step.role, step.approverIds, employeeId, prior, blocked, accounts);
  return approverIds.length ? { ...step, approverIds } : null;
}

/**
 * Steps for this request with approvers resolved, parallel groups kept. Groups (and steps) nobody can decide
 * are dropped; groups with exactly the same people are merged. Whoever is the only approver of a step is left
 * out of the later steps (nobody approves two steps of one request).
 */
export function resolveFlow(type: WorkflowType, employeeId: string, opts: ResolveOptions = {}, accounts: readonly DemoAccount[] = DEMO_ACCOUNTS): FlowStep[] {
  const exclude = new Set(opts.excludeIds ?? []);
  const lineFromSelf = LINE_FROM_REQUESTER.includes(type);
  const out: FlowStep[] = [];
  const prior = new Set<string>();
  for (const step of readSteps()[type]) {
    if (!applies(step, opts)) continue;
    const roles = stepRoles(step);
    const groups: FlowGroup[] = [];
    const blocked = new Set([...exclude, ...prior, employeeId]);
    for (const role of roles) {
      const all = approversForRole(role, employeeId, accounts, lineFromSelf).filter((id) => !exclude.has(id));
      const ids = keepApprovers(role, all, employeeId, prior, blocked, accounts);
      if (!ids.length) continue;
      const key = [...ids].sort().join(",");
      const same = groups.find((g) => [...g.approverIds].sort().join(",") === key);
      if (same) {
        same.label = `${same.label.replace(/ approval$/, "")} / ${roleLabel(role)} approval`;
        continue;
      }
      groups.push({ role, label: `${roleLabel(role)} approval`, approverIds: ids });
    }
    if (!groups.length) continue;
    const approverIds = [...new Set(groups.flatMap((g) => g.approverIds))];
    const resolved: FlowStep =
      groups.length === 1
        ? { role: legacyRole(groups[0]!.role), label: step.label, approverIds }
        : { role: legacyRole(groups[0]!.role), label: step.label, approverIds, mode: step.mode === "any" ? "any" : "all", groups };
    out.push(resolved);
    certainApprovers(resolved).forEach((id) => prior.add(id));
  }
  return out;
}

/** A step with its resolved approvers, one approver group per step. */
export interface ResolvedStep {
  role: LegacyStepRole;
  label: string;
  approverIds: string[];
}

/**
 * Steps for this employee, one approver group each — for request types that decide one group per step.
 * An "all" parallel step becomes one step per group (each must approve); an "any" step is one step anyone in
 * its groups can decide. Use resolveFlow with decideFlowStep (expenseFlow.ts) to run groups in parallel.
 */
export function resolveWorkflow(type: WorkflowType, employeeId: string, amount?: number, opts: Omit<ResolveOptions, "amount"> = {}): ResolvedStep[] {
  return resolveFlow(type, employeeId, { ...opts, amount }).flatMap((step) =>
    step.groups && step.mode !== "any"
      ? step.groups.map((g) => ({ role: legacyRole(g.role), label: g.label, approverIds: g.approverIds }))
      : [{ role: step.role, label: step.label, approverIds: step.approverIds }],
  );
}

/** One decision on one step of a request. */
export type StepDecision = FlowDecision;
