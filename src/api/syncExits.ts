/**
 * Exits from the backend (VITE_API_URL mode only), in the ExitCase shape exitStore and ExitPages use.
 * GET /exits (mine, team, all) and the change endpoints; reloads after each change.
 * Server statuses: Submitted / Manager approved / Approved / Rejected / Withdrawn / Completed ("Approved" shows
 * as the portal's "Accepted").
 */
import type { ClearanceItem, ClearanceOwner, ExitCase, ExitInterview, ExitStatus, SettlementStatus } from "../features/lifecycle/exitStore.ts";
import { api } from "./client.ts";
import { apiRun, createApiMirror } from "./syncOps.ts";

interface ExitStepOut {
  label: string;
  approver_ids: string[];
  decision: string | null;
  by: string | null;
  note: string | null;
  at: string | null;
}

interface ExitCaseOut {
  id: string;
  employee_id: string;
  employee_name: string | null;
  country_code: string | null;
  exit_type: string;
  submitted_on: string;
  requested_last_day: string;
  standard_last_day: string;
  approved_last_working_day: string | null;
  notice_days: number;
  early_release: boolean;
  early_release_approved: boolean | null;
  reason: string;
  note: string | null;
  status: string;
  raised_by: string;
  raised_by_name: string | null;
  steps: ExitStepOut[];
  can_decide: boolean;
  can_withdraw: boolean;
  clearance: { key: string; label: string; owner: string; done: boolean; done_by: string | null; done_on: string | null; can_tick: boolean }[];
  interview_submitted: boolean;
  interview: { rating: number; reasons: string[]; would_return: string; comments: string; submitted_on: string } | null;
  settlement: { status: string; unused_leave_days: number; frozen: boolean; updated_by: string | null; updated_on: string | null } | null;
  completed_at: string | null;
}

export interface NoticeOut {
  notice_days: number;
  today: string;
  earliest_last_day: string;
  has_manager: boolean;
}

const STATUS: Record<string, ExitStatus> = {
  Submitted: "Submitted",
  "Manager approved": "Manager approved",
  Approved: "Accepted",
  Rejected: "Rejected",
  Withdrawn: "Withdrawn",
  Completed: "Completed",
};

export const EXIT_TYPE_LABEL: Record<string, string> = {
  resignation: "Resignation",
  termination: "Termination",
  retirement: "Retirement",
  end_of_contract: "End of contract",
};

function toCase(c: ExitCaseOut, scopes: Set<string>): ExitCase {
  const decided = [...c.steps].reverse().find((s) => s.decision);
  const clearance: ClearanceItem[] = c.clearance.map((i) => ({
    id: i.key,
    label: i.label,
    owner: i.owner as ClearanceOwner,
    done: i.done,
    ...(i.done_by ? { doneBy: i.done_by } : {}),
    ...(i.done_on ? { doneOn: i.done_on } : {}),
    canTick: i.can_tick,
  }));
  const interview: ExitInterview | undefined = c.interview
    ? {
        rating: c.interview.rating,
        reasons: c.interview.reasons,
        wouldReturn: c.interview.would_return as ExitInterview["wouldReturn"],
        comments: c.interview.comments,
        submittedOn: c.interview.submitted_on,
      }
    : undefined;
  return {
    id: c.id,
    employeeId: c.employee_id,
    employeeName: c.employee_name ?? c.employee_id,
    submittedOn: c.submitted_on,
    noticeDays: c.notice_days,
    proposedLastDay: c.requested_last_day,
    lastWorkingDay: c.approved_last_working_day ?? c.requested_last_day,
    earlyRelease: c.early_release,
    reason: c.reason,
    note: c.note ?? "",
    status: STATUS[c.status] ?? "Submitted",
    ...(decided ? { decidedBy: decided.by ?? undefined, decidedOn: decided.at?.slice(0, 10), decisionNote: decided.note ?? undefined } : {}),
    clearance,
    ...(interview ? { interview } : {}),
    settlement: (c.settlement?.status ?? "Pending") as SettlementStatus,
    ...(c.settlement?.updated_by ? { settlementUpdatedBy: c.settlement.updated_by } : {}),
    ...(c.settlement?.updated_on ? { settlementUpdatedOn: c.settlement.updated_on } : {}),
    ...(c.completed_at ? { completedOn: c.completed_at.slice(0, 10) } : {}),
    api: {
      exitType: c.exit_type,
      typeLabel: EXIT_TYPE_LABEL[c.exit_type] ?? c.exit_type,
      standardLastDay: c.standard_last_day,
      earlyReleaseApproved: c.early_release_approved,
      raisedById: c.raised_by,
      raisedBy: c.raised_by_name ?? c.raised_by,
      steps: c.steps.map((s) => ({ label: s.label, decision: s.decision, by: s.by, note: s.note, on: s.at?.slice(0, 10) ?? null })),
      canDecide: c.can_decide,
      canWithdraw: c.can_withdraw,
      interviewSubmitted: c.interview_submitted,
      ...(c.settlement ? { unusedLeaveDays: c.settlement.unused_leave_days, settlementFrozen: c.settlement.frozen } : {}),
      inTeam: scopes.has("team"),
      inAll: scopes.has("all"),
    },
  };
}

async function loadExits(): Promise<{ cases: ExitCase[] }> {
  const scopes = ["mine", "team", "all"] as const;
  const lists = await Promise.all(
    scopes.map((scope) => api.get<ExitCaseOut[]>("/exits", { scope, limit: 500 }).catch(() => [] as ExitCaseOut[])),
  );
  const byId = new Map<string, { row: ExitCaseOut; scopes: Set<string> }>();
  lists.forEach((list, i) => {
    for (const row of list) {
      const hit = byId.get(row.id) ?? { row, scopes: new Set<string>() };
      hit.scopes.add(scopes[i]);
      byId.set(row.id, hit);
    }
  });
  return {
    cases: [...byId.values()]
      .map(({ row, scopes: s }) => toCase(row, s))
      .sort((a, b) => b.submittedOn.localeCompare(a.submittedOn) || b.id.localeCompare(a.id)),
  };
}

export const exitsMirror = createApiMirror<{ cases: ExitCase[] }>(() => ({ cases: [] }), loadExits);

const path = (id: string, tail = "") => `/exits/${encodeURIComponent(id)}${tail}`;

export function apiMyNotice(): Promise<NoticeOut> {
  return api.get<NoticeOut>("/exits/notice");
}

export function apiSubmitResignation(input: { proposedLastDay: string; reason: string; note: string; earlyRelease: boolean }): Promise<string | null> {
  if (!input.reason.trim()) return Promise.resolve("Choose a reason for leaving.");
  return apiRun(
    () =>
      api.post("/exits", {
        exit_type: "resignation",
        requested_last_day: input.proposedLastDay,
        reason: input.reason.trim(),
        note: input.note.trim() || null,
        early_release: input.earlyRelease,
      }),
    exitsMirror,
  );
}

export function apiWithdrawExit(id: string): Promise<string | null> {
  return apiRun(() => api.post(path(id, "/withdraw")), exitsMirror);
}

export function apiDecideExit(id: string, decision: "approve" | "reject", note: string, approveEarlyRelease?: boolean): Promise<string | null> {
  if (decision === "reject" && !note.trim()) return Promise.resolve("Add a note saying why.");
  return apiRun(
    () =>
      api.post(path(id, "/decision"), {
        decision,
        note: note.trim() || null,
        ...(approveEarlyRelease === undefined ? {} : { approve_early_release: approveEarlyRelease }),
      }),
    exitsMirror,
  );
}

export function apiSetClearance(id: string, key: string, done: boolean): Promise<string | null> {
  return apiRun(() => api.post(path(id, `/clearance/${encodeURIComponent(key)}`), { done }), exitsMirror);
}

export function apiSubmitInterview(
  id: string,
  input: { rating: number; reasons: string[]; wouldReturn: ExitInterview["wouldReturn"]; comments: string },
): Promise<string | null> {
  if (input.rating < 1) return Promise.resolve("Choose an overall rating from 1 to 5.");
  if (!input.reasons.length) return Promise.resolve("Pick at least one reason.");
  return apiRun(
    () => api.post(path(id, "/interview"), { rating: input.rating, reasons: input.reasons, would_return: input.wouldReturn, comments: input.comments }),
    exitsMirror,
  );
}

export function apiSetSettlement(id: string, status: SettlementStatus): Promise<string | null> {
  return apiRun(() => api.post(path(id, "/settlement"), { status }), exitsMirror);
}
