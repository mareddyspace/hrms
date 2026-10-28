/** Shared rules for multi-step requests (expense claims, travel requests): who decides the step that's open now. */
import type { ExpenseApprovalStep } from "../model.ts";
import { approversForStep } from "./approvalWorkflows.ts";

export interface SteppedRequest {
  employeeId: string;
  status: string;
  steps?: ExpenseApprovalStep[];
  currentStep?: number;
}

export function isOpenStatus(status: string): boolean {
  return status === "submitted" || status === "pending";
}

export function currentStepOf(request: SteppedRequest): ExpenseApprovalStep | undefined {
  if (!request.steps?.length) return undefined;
  return request.steps[request.currentStep ?? 0];
}

/**
 * Whether this person decides the open step. Manager steps also accept anyone above in the reporting line or an
 * active delegate (via `canApprove`); other steps only their listed approvers. Older requests with no steps follow
 * the reporting line.
 */
export function isWaitingOn(
  request: SteppedRequest,
  myId: string,
  canApprove: (employeeId: string) => boolean,
): boolean {
  if (!isOpenStatus(request.status) || request.employeeId === myId) return false;
  const step = currentStepOf(request);
  if (!step) return canApprove(request.employeeId);
  if (step.approverIds.includes(myId)) return true;
  return (step.role === "manager" || step.role === "skip_manager") && canApprove(request.employeeId);
}

/** Roles that record payments on approved claims. */
export const PAYER_ROLES = ["finance", "admin", "super_admin"];

export function canPayExpenses(role: string, myId: string, employeeId: string): boolean {
  if (myId === employeeId) return false;
  if (PAYER_ROLES.includes(role)) return true;
  // With no finance or admin accounts, whoever the finance step resolves to pays.
  return approversForStep({ role: "finance", label: "" }, employeeId).includes(myId);
}

/** "Manager approval · step 1 of 2" */
export function stepText(request: SteppedRequest): string {
  const step = currentStepOf(request);
  if (!step || !request.steps) return "";
  return `${step.label} · step ${(request.currentStep ?? 0) + 1} of ${request.steps.length}`;
}
