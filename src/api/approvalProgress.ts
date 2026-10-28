/**
 * Approval chain progress the API attaches to leave requests, attendance corrections and timesheet weeks
 * (backend/app/services/time_approvals.py progress), plus a short "Step 2 of 2 · HR" text for the UI.
 */

export interface ApprovalStepProgressOut {
  index: number;
  label: string;
  roles: string[];
  status: "done" | "current" | "waiting" | "rejected" | string;
  approvers: string[];
  decisions: { by: string; on_behalf_of: string | null; decision: string; note: string | null; at: string | null }[];
  sla_hours: number | null;
  escalated: boolean;
}

export interface ApprovalProgressOut {
  instance_id: string;
  status: string;
  step: number;
  total_steps: number;
  current_label: string | null;
  steps: ApprovalStepProgressOut[];
  waiting_on_me: boolean;
}

export type WithApproval = { approval?: ApprovalProgressOut | null };

/** "Step 2 of 2 · HR" while a multi-step request is pending; undefined otherwise. */
export function approvalProgressText(p: ApprovalProgressOut | null | undefined): string | undefined {
  if (!p || p.status !== "pending" || p.total_steps < 2) return undefined;
  const done = p.steps
    .filter((s) => s.status === "done")
    .map((s) => {
      const d = s.decisions.find((x) => x.decision === "approve");
      return d ? `${s.label} approved by ${d.by}${d.on_behalf_of ? ` for ${d.on_behalf_of}` : ""}` : "";
    })
    .filter(Boolean);
  return [`Step ${p.step} of ${p.total_steps}${p.current_label ? ` · ${p.current_label}` : ""}`, ...done].join(" · ");
}
