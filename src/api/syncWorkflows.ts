/**
 * Approval workflows from the API (backend mode): every request type the server knows (GET /workflows), saved
 * with PUT /workflows/{type}. Steps map to the editor's ApprovalStep shape, plus per-step SLA hours and a
 * condition on country / department / grade.
 */
import { useSyncExternalStore } from "react";
import type { ApprovalStep, ApprovalStepRole, StepCondition } from "../data/approvalWorkflows.ts";
import { api } from "./client.ts";
import { apiPut, errorText } from "./syncShared.ts";

export interface ApiWorkflowStep {
  roles: ApprovalStepRole[];
  mode?: "all" | "any";
  min_amount?: number | null;
  label?: string | null;
  sla_hours?: number | null;
  condition?: StepCondition | null;
  only_if?: "needs_hr" | "via_manager" | null;
}

export interface ApiWorkflowType {
  type: string;
  label: string;
  version: number;
  steps: ApiWorkflowStep[];
  default_steps: ApiWorkflowStep[];
  created_by: string | null;
  created_at: string | null;
}

const ROLE_LABEL: Record<string, string> = {
  manager: "Manager",
  skip_manager: "Manager's manager",
  hr: "HR",
  finance: "Finance",
  admin: "Admin",
  executive: "Executive",
};

export function fromApiStep(s: ApiWorkflowStep): ApprovalStep {
  const roles = s.roles.length ? s.roles : (["manager"] as ApprovalStepRole[]);
  const step: ApprovalStep = {
    role: roles[0]!,
    label: s.label || `${roles.map((r) => ROLE_LABEL[r] ?? r).join(" + ")} approval`,
  };
  if (roles.length > 1) {
    step.roles = roles;
    step.mode = s.mode ?? "any";
  }
  if (s.min_amount) step.minAmount = s.min_amount;
  if (s.sla_hours) step.slaHours = s.sla_hours;
  if (s.condition?.values?.length) step.condition = s.condition;
  if (s.only_if) step.onlyIf = s.only_if;
  return step;
}

export function toApiStep(s: ApprovalStep): ApiWorkflowStep {
  const roles = s.roles?.length ? s.roles : [s.role];
  return {
    roles,
    mode: roles.length > 1 ? (s.mode ?? "all") : "any",
    min_amount: s.minAmount ?? null,
    label: s.label.trim() || null,
    sla_hours: s.slaHours ?? null,
    condition: s.condition?.values.length ? s.condition : null,
    only_if: s.onlyIf ?? null,
  };
}

let types: ApiWorkflowType[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());

export async function loadApiWorkflows(): Promise<string | null> {
  try {
    types = await api.get<ApiWorkflowType[]>("/workflows");
    emit();
    return null;
  } catch (error) {
    return errorText(error, "Could not load approval steps.");
  }
}

export function useApiWorkflowTypes(): ApiWorkflowType[] {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => types,
    () => types,
  );
}

/** Saves a new version; returns an error message or null. */
export async function saveApiWorkflow(type: string, steps: ApprovalStep[]): Promise<string | null> {
  if (!steps.length) return "Add at least one step.";
  try {
    await apiPut(`/workflows/${encodeURIComponent(type)}`, { steps: steps.map(toApiStep) });
  } catch (error) {
    return errorText(error, "Could not save. Try again.");
  }
  return loadApiWorkflows();
}
