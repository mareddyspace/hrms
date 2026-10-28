/** Approval workflow analytics: items in flight, average approval time and the slowest step, per workflow type. */
import type { Expense } from "../model.ts";
import type { WorkflowType } from "./approvalWorkflows.ts";
import type { LifecycleAction } from "../features/lifecycle/lifecycleActionsStore.ts";
import type { Requisition } from "./talentData.ts";
import type { CompProposal } from "./rewardLocal.ts";
import type { TravelRequest } from "./travelStore.ts";

export interface WorkflowStats {
  type: WorkflowType;
  inFlight: number;
  /** Fully approved items with a known start date. */
  completed: number;
  /** Average days from raised to final approval, or null with nothing completed. */
  avgDays: number | null;
  slowestStep: { label: string; avgDays: number } | null;
}

/** One request, reduced to what the numbers need. Marks are decisions, by step index. */
interface Track {
  open: boolean;
  start?: string;
  /** Final approval date (approved items only). */
  end?: string;
  marks: { step: number; label: string; on: string }[];
}

const day = (iso: string) => Date.parse(iso.slice(0, 10));
const daysBetween = (from: string, to: string) => Math.max(0, (day(to) - day(from)) / 86_400_000);
const round1 = (n: number) => Math.round(n * 10) / 10;

function statsFor(type: WorkflowType, tracks: Track[]): WorkflowStats {
  const totals: number[] = [];
  const byStep = new Map<string, number[]>();
  for (const t of tracks) {
    if (t.start && t.end && !Number.isNaN(day(t.start)) && !Number.isNaN(day(t.end))) totals.push(daysBetween(t.start, t.end));
    for (const m of t.marks) {
      if (Number.isNaN(day(m.on))) continue;
      const earlier = t.marks.filter((x) => x.step < m.step && !Number.isNaN(day(x.on))).map((x) => x.on).sort();
      const from = earlier.at(-1) ?? t.start;
      if (!from || Number.isNaN(day(from))) continue;
      const list = byStep.get(m.label) ?? [];
      list.push(daysBetween(from, m.on));
      byStep.set(m.label, list);
    }
  }
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  let slowest: WorkflowStats["slowestStep"] = null;
  for (const [label, xs] of byStep) {
    const a = avg(xs);
    if (!slowest || a > slowest.avgDays) slowest = { label, avgDays: round1(a) };
  }
  return {
    type,
    inFlight: tracks.filter((t) => t.open).length,
    completed: totals.length,
    avgDays: totals.length ? round1(avg(totals)) : null,
    slowestStep: slowest,
  };
}

const decisionMarks = (decisions: { step: number; label: string; on: string }[] | undefined) =>
  (decisions ?? []).map((d) => ({ step: d.step, label: d.label, on: d.on }));

export function expenseStats(expenses: readonly Expense[]): WorkflowStats {
  return statsFor(
    "expense",
    expenses.map((e) => ({
      open: e.status === "submitted",
      start: e.submittedOn,
      end: (e.status === "approved" || e.status === "paid") && e.steps?.length ? e.decidedOn : undefined,
      marks: decisionMarks(e.stepDecisions),
    })),
  );
}

export function travelStats(requests: readonly TravelRequest[]): WorkflowStats {
  return statsFor(
    "travel",
    requests.map((t) => ({
      open: t.status === "pending",
      start: t.submittedOn,
      end: t.status === "approved" && t.steps.length ? t.decidedOn : undefined,
      marks: decisionMarks(t.stepDecisions),
    })),
  );
}

export function lifecycleStats(actions: readonly LifecycleAction[]): WorkflowStats {
  return statsFor(
    "lifecycle",
    actions.map((a) => {
      const marks = a.steps.flatMap((s, i) => (s.on && s.decision ? [{ step: i, label: s.label, on: s.on }] : []));
      const approved = a.status === "Applied" || a.status === "Scheduled";
      return { open: a.status === "Pending", start: a.raisedOn, end: approved && marks.length ? marks.map((m) => m.on).sort().at(-1) : undefined, marks };
    }),
  );
}

export function requisitionStats(reqs: readonly Requisition[]): WorkflowStats {
  return statsFor(
    "requisition",
    reqs.map((r) => {
      const raised = (r.history ?? []).find((h) => h.action === "Raised" || h.action === "Submitted for approval")?.on ?? r.created;
      const approvedOn = [...(r.history ?? [])].reverse().find((h) => h.action === "Approved")?.on;
      const marks = r.stepDecisions?.length
        ? decisionMarks(r.stepDecisions)
        : approvedOn
          ? [{ step: 0, label: "HR approval", on: approvedOn }]
          : [];
      return { open: r.approvalStatus === "Pending approval" || r.approvalStatus === "On hold", start: raised, end: approvedOn, marks };
    }),
  );
}

export function compensationStats(rows: readonly CompProposal[]): WorkflowStats {
  return statsFor(
    "compensation",
    rows.map((r) => {
      const marks = r.stepDecisions?.length
        ? decisionMarks(r.stepDecisions)
        : [
            ...(r.lineApprovedOn ? [{ step: 0, label: "Line approval", on: r.lineApprovedOn }] : []),
            ...(r.status === "Approved" && r.decidedOn ? [{ step: 1, label: "Final approval", on: r.decidedOn }] : []),
          ];
      return {
        open: r.status === "Pending approval" || r.status === "Pending final approval",
        start: r.submittedOn,
        end: r.status === "Approved" ? r.decidedOn : undefined,
        marks,
      };
    }),
  );
}
