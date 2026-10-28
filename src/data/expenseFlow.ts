/**
 * Shared rules for multi-step requests (expense claims, travel requests, requisitions, pay proposals): who decides
 * the step that's open now. A parallel step has several approver groups; with mode "all" it completes once every
 * group has approved, with "any" the first approval completes it.
 */
import type { ExpenseApprovalStep, ExpenseStepDecision } from "../model.ts";
import { approversForStep, withoutPriorApprovers, type FlowDecision, type FlowGroup, type ParallelMode } from "./approvalWorkflows.ts";

/** A saved step: the expense claim shape, plus parallel groups on newer requests. */
export type SavedStep = ExpenseApprovalStep & { mode?: ParallelMode; groups?: FlowGroup[] };
export type SavedDecision = ExpenseStepDecision & { group?: number };

export interface SteppedRequest {
  employeeId: string;
  status: string;
  steps?: SavedStep[];
  currentStep?: number;
  stepDecisions?: SavedDecision[];
}

export function isOpenStatus(status: string): boolean {
  return status === "submitted" || status === "pending";
}

export function currentStepOf(request: Pick<SteppedRequest, "steps" | "currentStep">): SavedStep | undefined {
  if (!request.steps?.length) return undefined;
  return request.steps[request.currentStep ?? 0];
}

/** A step where every one of several groups must approve. */
export function isAllParallel(step: SavedStep | undefined): step is SavedStep & { groups: FlowGroup[] } {
  return !!step && step.mode !== "any" && (step.groups?.length ?? 0) > 1;
}

/** Groups of the open step still waiting for an approval (parallel "all" steps only). */
export function pendingGroups(request: Pick<SteppedRequest, "steps" | "currentStep" | "stepDecisions">): { index: number; group: FlowGroup }[] {
  const step = currentStepOf(request);
  if (!isAllParallel(step)) return [];
  const at = request.currentStep ?? 0;
  const done = new Set(
    (request.stepDecisions ?? []).filter((d) => d.step === at && d.decision === "approved" && d.group !== undefined).map((d) => d.group!),
  );
  return step.groups.map((group, index) => ({ index, group })).filter(({ index }) => !done.has(index));
}

const LINE_ROLES = new Set<string>(["manager", "skip_manager"]);

/** People who approved a step before `step` (they don't approve a later step of the same request). */
export function approvedBefore(request: Pick<SteppedRequest, "stepDecisions">, step: number): Set<string> {
  return new Set((request.stepDecisions ?? []).filter((d) => d.step < step && d.decision === "approved").map((d) => d.byId));
}

function canDecideGroup(group: Pick<FlowGroup, "role" | "approverIds">, employeeId: string, myId: string, canApprove: (employeeId: string) => boolean) {
  return group.approverIds.includes(myId) || (LINE_ROLES.has(group.role) && canApprove(employeeId));
}

/** Pending groups of the open step this person can approve. */
export function myPendingGroups(request: SteppedRequest, myId: string, canApprove: (employeeId: string) => boolean): { index: number; group: FlowGroup }[] {
  return pendingGroups(request).filter(({ group }) => canDecideGroup(group, request.employeeId, myId, canApprove));
}

/**
 * Whether this person decides the open step. Manager steps also accept anyone above in the reporting line or an
 * active delegate (via `canApprove`); other steps only their listed approvers. Older requests with no steps follow
 * the reporting line. On a parallel "all" step, only groups still waiting count.
 */
export function isWaitingOn(
  request: SteppedRequest,
  myId: string,
  canApprove: (employeeId: string) => boolean,
): boolean {
  if (!isOpenStatus(request.status) || request.employeeId === myId) return false;
  const step = currentStepOf(request);
  if (!step) return canApprove(request.employeeId);
  if (approvedBefore(request, request.currentStep ?? 0).has(myId)) return false;
  if (isAllParallel(step)) return myPendingGroups(request, myId, canApprove).length > 0;
  if (step.approverIds.includes(myId)) return true;
  if (step.groups?.some((g) => canDecideGroup(g, request.employeeId, myId, canApprove))) return true;
  return LINE_ROLES.has(step.role) && canApprove(request.employeeId);
}

export type FlowOutcome =
  /** Recorded; other groups of this parallel step still have to approve. */
  | "waiting"
  /** The step is done; the next step is open. */
  | "advanced"
  | "approved"
  | "rejected";

export interface FlowResult {
  entries: FlowDecision[];
  outcome: FlowOutcome;
  /** Index of the open step after this decision. */
  currentStep: number;
  /** The step that was decided. */
  step: SavedStep;
  /** The step now open, when the outcome is "advanced". */
  next?: SavedStep;
  /** Steps after an approval: later steps without anyone who already approved (save these). */
  steps: SavedStep[];
}

/**
 * Record one person's decision on the open step. A parallel "all" step needs every group: one person's approval
 * counts for each pending group they belong to. A rejection by any group closes the request.
 * Returns an error message when this person can't decide the open step.
 */
export function decideFlowStep(
  request: SteppedRequest,
  actor: { id: string; fullName: string },
  decision: "approved" | "rejected",
  note: string | undefined,
  canApprove: (employeeId: string) => boolean,
  on: string,
  /** People who may never approve (e.g. whoever proposed it). */
  excludeIds: string[] = [],
): FlowResult | string {
  const step = currentStepOf(request);
  if (!step || !request.steps) return "This request has no open step.";
  if (!isWaitingOn(request, actor.id, canApprove)) return "This request isn't waiting on you.";
  const at = request.currentStep ?? 0;
  const steps = request.steps;
  const base = { step: at, decision, byId: actor.id, byName: actor.fullName, on, note: note?.trim() || undefined };
  const advance = (entries: FlowDecision[]): FlowResult => {
    // Nobody approves two steps: later steps lose this step's approvers (fallback admin -> executive, else skipped).
    const prior = approvedBefore({ stepDecisions: [...(request.stepDecisions ?? []), ...entries] }, at + 1);
    const later = steps.slice(at + 1).flatMap((s) => withoutPriorApprovers(s, prior, request.employeeId, excludeIds) ?? []);
    const nextSteps = [...steps.slice(0, at + 1), ...later];
    const next = nextSteps[at + 1];
    return next
      ? { entries, outcome: "advanced", currentStep: at + 1, step, next, steps: nextSteps }
      : { entries, outcome: "approved", currentStep: at, step, steps: nextSteps };
  };
  if (isAllParallel(step)) {
    const mine = myPendingGroups(request, actor.id, canApprove);
    const entries: FlowDecision[] = mine.map(({ index, group }) => ({ ...base, label: group.label, role: group.role, group: index }));
    if (decision === "rejected") return { entries, outcome: "rejected", currentStep: at, step, steps };
    const left = pendingGroups(request).length - mine.length;
    if (left > 0) return { entries, outcome: "waiting", currentStep: at, step, steps };
    return advance(entries);
  }
  const entries: FlowDecision[] = [{ ...base, label: step.label }];
  if (decision === "rejected") return { entries, outcome: "rejected", currentStep: at, step, steps };
  return advance(entries);
}

/** People who still have to act on the open step (pending groups of a parallel step, or the step's approvers). */
export function waitingApproverIds(request: Pick<SteppedRequest, "steps" | "currentStep" | "stepDecisions">): string[] {
  const step = currentStepOf(request);
  if (!step) return [];
  if (isAllParallel(step)) return [...new Set(pendingGroups(request).flatMap(({ group }) => group.approverIds))];
  return step.approverIds;
}

/** Roles that record payments on approved claims. */
export const PAYER_ROLES = ["finance", "admin", "super_admin"];

export function canPayExpenses(role: string, myId: string, employeeId: string): boolean {
  if (myId === employeeId) return false;
  if (PAYER_ROLES.includes(role)) return true;
  // With no finance or admin accounts, whoever the finance step resolves to pays.
  return approversForStep({ role: "finance" }, employeeId).includes(myId);
}

/** "Manager approval · step 1 of 2", or "HR + Finance approval · waiting on Finance · step 2 of 3". */
export function stepText(request: Pick<SteppedRequest, "steps" | "currentStep" | "stepDecisions">): string {
  const step = currentStepOf(request);
  if (!step || !request.steps) return "";
  const waiting = isAllParallel(step) ? pendingGroups(request).map(({ group }) => group.label.replace(/ approval$/, "")) : [];
  return `${step.label}${waiting.length && waiting.length < (step.groups?.length ?? 0) ? ` · waiting on ${waiting.join(" + ")}` : ""} · step ${(request.currentStep ?? 0) + 1} of ${request.steps.length}`;
}
