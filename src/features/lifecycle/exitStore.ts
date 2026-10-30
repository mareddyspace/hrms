import { API_ENABLED } from "../../api/client.ts";
import { exitsMirror } from "../../api/syncExits.ts";
import type { DemoAccount } from "../../demoAccounts.ts";
import { getPerson, upsertPerson, type LocalPersonRecord } from "../../data/peopleLocal.ts";
import { addLetterRequest } from "../../data/rewardLocal.ts";
import { addDaysISO, todayISO, type AssetAssignment } from "../../model.ts";
import {
  canActForEmployee,
  countryCodeFor,
  isAboveInLine,
  isHrRole,
  isValidISO,
  lineManagerId,
  noticeDaysFor,
  personName,
  seedCandidates,
  type LifecycleActor,
  type LifecycleResult,
} from "./lifecycleShared.ts";

const KEY = "kastech.exits.v1";

/** "Manager approved" and "Rejected" come from the backend only ("Accepted" = the server's "Approved"). */
export type ExitStatus = "Submitted" | "Manager approved" | "Accepted" | "Conversation requested" | "Rejected" | "Withdrawn" | "Completed";
/** Who accepts the resignation: someone above the person, or the Board for the CEO. */
export const BOARD = "Board";
export type ClearanceOwner = "employee" | "manager" | "it" | "finance" | "hr";
export type SettlementStatus = "Pending" | "In progress" | "Paid";

export const EXIT_REASONS = [
  "Career growth",
  "Compensation",
  "Relocation",
  "Higher studies",
  "Personal or family reasons",
  "Health",
  "Work-life balance",
  "Other",
] as const;

export const INTERVIEW_REASONS = [
  "Better role elsewhere",
  "Pay and benefits",
  "Manager relationship",
  "Team culture",
  "Workload",
  "Limited growth",
  "Commute or location",
  "Personal circumstances",
] as const;

export const SETTLEMENT_STEPS: SettlementStatus[] = ["Pending", "In progress", "Paid"];

export const OWNER_LABEL: Record<ClearanceOwner, string> = {
  employee: "Employee",
  manager: "Manager",
  it: "IT",
  finance: "Finance",
  hr: "HR",
};

export interface ClearanceItem {
  id: string;
  label: string;
  owner: ClearanceOwner;
  done: boolean;
  doneBy?: string;
  doneById?: string;
  doneOn?: string;
  /** Backend mode: whether the signed-in person may tick it (the server decides). */
  canTick?: boolean;
}

export interface ExitInterview {
  rating: number;
  reasons: string[];
  wouldReturn: "Yes" | "No" | "Maybe";
  comments: string;
  submittedOn: string;
}

export interface ExitCase {
  id: string;
  employeeId: string;
  employeeName: string;
  submittedOn: string;
  noticeDays: number;
  /** Date the employee asked for. */
  proposedLastDay: string;
  /** Agreed date once accepted (proposed date, or the standard notice date if early release was declined). */
  lastWorkingDay: string;
  earlyRelease: boolean;
  reason: string;
  note: string;
  status: ExitStatus;
  decidedBy?: string;
  decidedById?: string;
  decidedOn?: string;
  decisionNote?: string;
  clearance: ClearanceItem[];
  interview?: ExitInterview;
  settlement: SettlementStatus;
  settlementUpdatedBy?: string;
  settlementUpdatedOn?: string;
  completedBy?: string;
  completedOn?: string;
  completionNote?: string;
  /** Set when the company starts the exit (e.g. probation not confirmed, a termination) rather than a resignation. */
  kind?: ExitKind;
  /** Who raised it (HR for a termination); the employee for a resignation. */
  raisedById?: string;
  raisedBy?: string;
  /** Local mode: the manager's step (then HR accepts). */
  managerDecision?: { by: string; byId: string; on: string; note?: string };
  earlyReason?: string;
  handoverPlan?: string;
  handoverTo?: string;
  /** Retention conversations offered by the manager while the resignation waits. */
  retention?: RetentionNote[];
  /** Backend mode only: what the server adds (approval steps, what this viewer may do, settlement days). */
  api?: ExitApiExtras;
}

export type ExitKind = "Resignation" | "Probation not confirmed" | "Termination" | "End of contract" | "Retirement";

export interface RetentionNote {
  byId: string;
  by: string;
  note: string;
  on: string;
  meetOn?: string;
}

/** HR-raised exit types (the server's exit_type values). */
export const COMPANY_EXIT_TYPES: { value: "termination" | "end_of_contract" | "retirement"; label: ExitKind }[] = [
  { value: "termination", label: "Termination" },
  { value: "end_of_contract", label: "End of contract" },
  { value: "retirement", label: "Retirement" },
];

export const PENDING_EXIT_STATUSES: ExitStatus[] = ["Submitted", "Manager approved"];

export interface ExitApiExtras {
  exitType: string;
  typeLabel: string;
  standardLastDay: string;
  earlyReleaseApproved: boolean | null;
  raisedById: string;
  raisedBy: string;
  steps: { label: string; decision: string | null; by: string | null; note: string | null; on: string | null }[];
  canDecide: boolean;
  canWithdraw: boolean;
  canAddRetention: boolean;
  interviewSubmitted: boolean;
  /** Unused privilege leave paid out in the final settlement (leaver and HR only). */
  unusedLeaveDays?: number;
  settlementFrozen?: boolean;
  inTeam: boolean;
  inAll: boolean;
}

type ExitState = { cases: ExitCase[] };

export const OPEN_EXIT_STATUSES: ExitStatus[] = ["Submitted", "Manager approved", "Accepted"];

function buildClearance(caseId: string, assets: Pick<AssetAssignment, "id" | "name" | "tag">[]): ClearanceItem[] {
  const items: ClearanceItem[] = assets.map((asset) => ({
    id: `${caseId}-asset-${asset.id}`,
    label: `Asset returned: ${asset.name} (${asset.tag})`,
    owner: "it",
    done: false,
  }));
  if (!assets.length) {
    items.push({ id: `${caseId}-asset-none`, label: "Confirm no company assets are held", owner: "it", done: false });
  }
  items.push(
    { id: `${caseId}-it`, label: "IT access revoked (email, VPN, apps)", owner: "it", done: false },
    { id: `${caseId}-finance`, label: "Finance dues settled (advances, expenses, loans)", owner: "finance", done: false },
    { id: `${caseId}-kt`, label: "Knowledge transfer completed", owner: "employee", done: false },
    { id: `${caseId}-mgr`, label: "Manager sign-off", owner: "manager", done: false },
    { id: `${caseId}-hr`, label: "HR sign-off", owner: "hr", done: false },
  );
  return items;
}

function defaults(): ExitState {
  const person = seedCandidates()[3] ?? seedCandidates()[0];
  if (!person) return { cases: [] };
  const today = todayISO();
  const submittedOn = addDaysISO(today, -10);
  const noticeDays = noticeDaysFor(person.id);
  const lastDay = addDaysISO(submittedOn, noticeDays);
  const id = "exit-seed-1";
  const clearance = buildClearance(id, [{ id: "seed-laptop", name: "Laptop", tag: "LT-4471" }]).map((item) =>
    item.owner === "finance" || item.id.endsWith("-kt")
      ? { ...item, done: true, doneBy: item.owner === "finance" ? "Finance team" : person.fullName, doneById: item.owner === "finance" ? "finance" : person.id, doneOn: addDaysISO(today, -3) }
      : item,
  );
  return {
    cases: [
      {
        id,
        employeeId: person.id,
        employeeName: person.fullName,
        submittedOn,
        noticeDays,
        proposedLastDay: lastDay,
        lastWorkingDay: lastDay,
        earlyRelease: false,
        reason: "Relocation",
        note: "Moving cities for family reasons.",
        status: "Accepted",
        decidedBy: personName(lineManagerId(person.id) ?? "emp-ram"),
        decidedById: lineManagerId(person.id) ?? "emp-ram",
        decidedOn: addDaysISO(submittedOn, 2),
        decisionNote: "Thanks for the notice — handover plan agreed.",
        clearance,
        interview: {
          rating: 4,
          reasons: ["Commute or location", "Personal circumstances"],
          wouldReturn: "Yes",
          comments: "Good team. Leaving only because of the move.",
          submittedOn: addDaysISO(today, -2),
        },
        settlement: "In progress",
        settlementUpdatedBy: "Farhan Ali",
        settlementUpdatedOn: addDaysISO(today, -1),
      },
    ],
  };
}

function read(): ExitState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    const saved = JSON.parse(raw) as Partial<Record<keyof ExitState, unknown>>;
    const base = defaults();
    if (Array.isArray(saved?.cases)) base.cases = saved.cases as ExitCase[];
    return base;
  } catch {
    return defaults();
  }
}

let cache: ExitState | null = null;
const listeners = new Set<() => void>();

function write(state: ExitState): LifecycleResult {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    return "Could not save. Please try again.";
  }
  cache = state;
  listeners.forEach((fn) => fn());
  return null;
}

export function subscribeExits(listener: () => void) {
  if (API_ENABLED) return exitsMirror.subscribe(listener);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Stable snapshot for useSyncExternalStore. */
export function getExitState(): ExitState {
  if (API_ENABLED) return exitsMirror.get();
  if (!cache) cache = read();
  return cache;
}

function mutateCase(id: string, mutator: (row: ExitCase) => LifecycleResult): LifecycleResult {
  const current = getExitState();
  const index = current.cases.findIndex((c) => c.id === id);
  if (index < 0) return "Exit record not found.";
  const row: ExitCase = structuredClone(current.cases[index]);
  const error = mutator(row);
  if (error) return error;
  const cases = current.cases.slice();
  cases[index] = row;
  return write({ ...current, cases });
}

/* ───────────── Queries ───────────── */

export function openExitFor(employeeId: string): ExitCase | undefined {
  return getExitState().cases.find((c) => c.employeeId === employeeId && OPEN_EXIT_STATUSES.includes(c.status));
}

export function earliestLastDay(employeeId: string, from = todayISO()): string {
  return addDaysISO(from, noticeDaysFor(employeeId));
}

/** Exit interview answers are confidential: only the leaver and HR may read them. */
export function canSeeInterview(actor: LifecycleActor, row: ExitCase): boolean {
  if (API_ENABLED) return Boolean(row.interview); // the server sends the answers to HR only
  return actor.id === row.employeeId || isHrRole(actor.role);
}

export function canTickItem(actor: LifecycleActor, row: ExitCase, item: ClearanceItem): boolean {
  if (API_ENABLED) return Boolean(item.canTick);
  if (row.status !== "Accepted") return false;
  if (actor.id === row.employeeId) return item.owner === "employee";
  switch (item.owner) {
    case "employee":
      return false;
    case "manager":
      // Manager sign-off belongs to the reporting line; for the CEO (no one above), HR records it.
      return lineManagerId(row.employeeId) ? isAboveInLine(actor.id, row.employeeId) : isHrRole(actor.role);
    case "it":
      return isHrRole(actor.role) || actor.role === "it_admin" || actor.role === "admin" || actor.role === "super_admin";
    case "finance":
      return isHrRole(actor.role) || actor.role === "finance";
    case "hr":
      return isHrRole(actor.role);
  }
}

export function clearanceProgress(row: ExitCase): { done: number; total: number } {
  return { done: row.clearance.filter((i) => i.done).length, total: row.clearance.length };
}

export function completionBlocker(row: ExitCase, today = todayISO()): string | null {
  if (row.status !== "Accepted") return "Only accepted exits can be completed.";
  const { done, total } = clearanceProgress(row);
  if (done < total) return `Clearance is incomplete (${done} of ${total} done).`;
  if (row.lastWorkingDay > today) return "The last working day has not been reached yet.";
  return null;
}

/* ───────────── Mutations ───────────── */

export interface ResignationInput {
  proposedLastDay: string;
  reason: string;
  note: string;
  earlyRelease: boolean;
  earlyReason?: string;
  handoverPlan?: string;
  handoverTo?: string;
}

export function submitResignation(actor: LifecycleActor, input: ResignationInput): LifecycleResult {
  const today = todayISO();
  const person = getPerson(actor.id);
  if (person?.employmentStatus === "Terminated") return "Your employment has already ended.";
  if (openExitFor(actor.id)) return "You already have an open resignation.";
  if (!input.reason.trim()) return "Choose a reason for leaving.";
  if (!isValidISO(input.proposedLastDay)) return "Enter a valid last working day.";
  if (input.proposedLastDay < today) return "Last working day cannot be in the past.";
  if (input.note.length > 1000) return "Note must be 1000 characters or fewer.";
  const noticeDays = noticeDaysFor(actor.id);
  const earliest = addDaysISO(today, noticeDays);
  if (input.proposedLastDay < earliest && !input.earlyRelease) {
    return `Your notice period is ${noticeDays} days — choose ${earliest} or later, or request early release.`;
  }
  if (input.earlyRelease && input.proposedLastDay >= earliest) {
    return "Early release is only needed when the date is inside your notice period.";
  }
  if (input.proposedLastDay > addDaysISO(today, 365)) return "Last working day must be within 365 days.";
  const state = getExitState();
  const id = `exit-${Date.now()}`;
  const row: ExitCase = {
    id,
    employeeId: actor.id,
    employeeName: actor.fullName,
    submittedOn: today,
    noticeDays,
    proposedLastDay: input.proposedLastDay,
    lastWorkingDay: input.proposedLastDay,
    earlyRelease: input.earlyRelease,
    reason: input.reason.trim(),
    note: input.note.trim(),
    status: "Submitted",
    clearance: [],
    settlement: "Pending",
    kind: "Resignation",
    raisedById: actor.id,
    raisedBy: actor.fullName,
    ...(input.earlyRelease && input.earlyReason?.trim() ? { earlyReason: input.earlyReason.trim() } : {}),
    ...(input.handoverPlan?.trim() ? { handoverPlan: input.handoverPlan.trim() } : {}),
    ...(input.handoverTo?.trim() ? { handoverTo: input.handoverTo.trim() } : {}),
  };
  return write({ ...state, cases: [row, ...state.cases] });
}

/** HR raises a termination, end of contract or retirement. A second person (HR, admin or executive) approves it. */
export function raiseCompanyExit(
  actor: LifecycleActor,
  input: { employeeId: string; kind: ExitKind; lastWorkingDay: string; reason: string; note: string },
): LifecycleResult {
  if (!isHrRole(actor.role)) return "Only HR can raise an exit for someone else.";
  if (actor.id === input.employeeId) return "You can't raise an exit for yourself here.";
  const person = getPerson(input.employeeId);
  if (!person) return "Pick a person from the directory.";
  if (person.employmentStatus === "Terminated") return "This person has already left.";
  if (openExitFor(input.employeeId)) return "An exit is already open for this person.";
  if (!input.reason.trim()) return "Give a reason.";
  if (!isValidISO(input.lastWorkingDay)) return "Enter a valid last working day.";
  const today = todayISO();
  if (input.lastWorkingDay < today) return "The last working day can't be in the past.";
  if (input.lastWorkingDay > addDaysISO(today, 365)) return "The last working day must be within 365 days.";
  const state = getExitState();
  const row: ExitCase = {
    id: `exit-${Date.now()}`,
    employeeId: person.id,
    employeeName: person.fullName,
    submittedOn: today,
    noticeDays: noticeDaysFor(person.id),
    proposedLastDay: input.lastWorkingDay,
    lastWorkingDay: input.lastWorkingDay,
    earlyRelease: false,
    reason: input.reason.trim(),
    note: input.note.trim(),
    status: "Submitted",
    clearance: [],
    settlement: "Pending",
    kind: input.kind,
    raisedById: actor.id,
    raisedBy: actor.fullName,
  };
  return write({ ...state, cases: [row, ...state.cases] });
}

export function isCompanyRaised(row: ExitCase): boolean {
  if (row.api) return row.api.raisedById !== row.employeeId;
  return Boolean(row.raisedById && row.raisedById !== row.employeeId);
}

/** Local mode: who decides next — the manager, then HR; a company-raised exit needs a second HR / admin / executive. */
export function nextExitStep(row: ExitCase): "manager" | "hr" | "second" | null {
  if (!PENDING_EXIT_STATUSES.includes(row.status)) return null;
  if (isCompanyRaised(row)) return "second";
  if (row.status === "Submitted" && lineManagerId(row.employeeId)) return "manager";
  return "hr";
}

export function canDecideExit(actor: LifecycleActor, row: ExitCase): boolean {
  if (row.api) return row.api.canDecide;
  if (actor.id === row.employeeId) return false;
  const step = nextExitStep(row);
  if (step === "manager") return canActForEmployee(actor, row.employeeId);
  if (step === "hr") return isHrRole(actor.role) && row.managerDecision?.byId !== actor.id;
  if (step === "second") return actor.id !== row.raisedById && (isHrRole(actor.role) || actor.role === "admin" || actor.role === "executive" || actor.role === "super_admin");
  return false;
}

export function canWithdrawExit(actor: LifecycleActor, row: ExitCase): boolean {
  if (row.api) return row.api.canWithdraw;
  return PENDING_EXIT_STATUSES.includes(row.status) && (row.raisedById ?? row.employeeId) === actor.id;
}

export function canAddRetention(actor: LifecycleActor, row: ExitCase): boolean {
  if (row.api) return row.api.canAddRetention;
  return PENDING_EXIT_STATUSES.includes(row.status) && !isCompanyRaised(row) && actor.id !== row.employeeId && (isAboveInLine(actor.id, row.employeeId) || isHrRole(actor.role));
}

export function withdrawResignation(actor: LifecycleActor, id: string): LifecycleResult {
  return mutateCase(id, (row) => {
    if ((row.raisedById ?? row.employeeId) !== actor.id) return "Only the person who raised it can withdraw it.";
    if (!PENDING_EXIT_STATUSES.includes(row.status)) return "It can only be withdrawn before final approval.";
    row.status = "Withdrawn";
    row.decidedOn = todayISO();
    return null;
  });
}

export function addRetentionNote(actor: LifecycleActor, id: string, note: string, meetOn?: string): LifecycleResult {
  return mutateCase(id, (row) => {
    if (!canAddRetention(actor, row)) return "Only the leaver's manager can do this while the resignation waits.";
    if (!note.trim()) return "Write a short note for the conversation.";
    if (meetOn && !isValidISO(meetOn)) return "Enter a valid date.";
    row.retention = [...(row.retention ?? []), { byId: actor.id, by: actor.fullName, note: note.trim().slice(0, 1000), on: todayISO(), ...(meetOn ? { meetOn } : {}) }];
    return null;
  });
}

export function decideResignation(
  actor: LifecycleActor,
  id: string,
  decision: "approve" | "reject",
  options: { note: string; approveEarlyRelease?: boolean; assets: Pick<AssetAssignment, "id" | "name" | "tag" | "employeeId">[] },
): LifecycleResult {
  return mutateCase(id, (row) => {
    if (row.employeeId === actor.id) return "You cannot act on your own resignation.";
    if (!canDecideExit(actor, row)) return "This step is waiting for someone else.";
    const note = options.note.trim();
    const today = todayISO();
    if (decision === "reject") {
      if (!note) return "Add a note saying why.";
      row.status = "Rejected";
    } else if (nextExitStep(row) === "manager") {
      if (row.earlyRelease && options.approveEarlyRelease === false) row.earlyRelease = false;
      row.managerDecision = { by: actor.fullName, byId: actor.id, on: today, ...(note ? { note } : {}) };
      row.status = "Manager approved";
      return null;
    } else {
      const declineEarly = options.approveEarlyRelease === false || (row.proposedLastDay < addDaysISO(row.submittedOn, row.noticeDays) && !row.earlyRelease && !isCompanyRaised(row));
      if (declineEarly) {
        // Early date declined: the standard notice applies from the submission date.
        const standard = addDaysISO(row.submittedOn, row.noticeDays);
        row.lastWorkingDay = standard < today ? today : standard;
      } else {
        row.lastWorkingDay = row.proposedLastDay < today ? today : row.proposedLastDay;
      }
      row.status = "Accepted";
      row.clearance = buildClearance(row.id, options.assets.filter((a) => a.employeeId === row.employeeId));
    }
    row.decidedBy = actor.fullName;
    row.decidedById = actor.id;
    row.decidedOn = today;
    row.decisionNote = note;
    return null;
  });
}

export function setClearanceItem(actor: LifecycleActor, id: string, itemId: string, done: boolean): LifecycleResult {
  return mutateCase(id, (row) => {
    const item = row.clearance.find((i) => i.id === itemId);
    if (!item) return "Checklist item not found.";
    if (row.status !== "Accepted") return "The checklist is locked for this exit.";
    if (!canTickItem(actor, row, item)) {
      return item.owner === "manager" ? "Only the reporting line can sign this off." : `Only ${OWNER_LABEL[item.owner]} can update this item.`;
    }
    if (item.owner === "hr" && done && row.clearance.some((i) => i.id !== item.id && !i.done)) {
      return "HR sign-off comes last — finish the other items first.";
    }
    if (item.owner === "manager" && done) {
      const kt = row.clearance.find((i) => i.id.endsWith("-kt"));
      if (kt && !kt.done) return "Knowledge transfer must be done before manager sign-off.";
    }
    if (!done) {
      const hr = row.clearance.find((i) => i.owner === "hr");
      if (hr?.done && item.owner !== "hr") return "Undo HR sign-off before reopening other items.";
    }
    item.done = done;
    item.doneBy = done ? actor.fullName : undefined;
    item.doneById = done ? actor.id : undefined;
    item.doneOn = done ? todayISO() : undefined;
    return null;
  });
}

export function submitExitInterview(
  actor: LifecycleActor,
  id: string,
  input: { rating: number; reasons: string[]; wouldReturn: ExitInterview["wouldReturn"]; comments: string },
): LifecycleResult {
  return mutateCase(id, (row) => {
    if (row.employeeId !== actor.id) return "Only the leaving employee can fill the exit interview.";
    if (row.status !== "Accepted") return "The exit interview opens once your resignation is accepted.";
    if (row.interview) return "You have already submitted your exit interview.";
    if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) return "Choose an overall rating from 1 to 5.";
    if (!input.reasons.length) return "Pick at least one reason.";
    if (input.reasons.some((r) => !(INTERVIEW_REASONS as readonly string[]).includes(r))) return "One of the reasons is not recognised.";
    if (input.comments.length > 2000) return "Comments must be 2000 characters or fewer.";
    row.interview = {
      rating: input.rating,
      reasons: [...new Set(input.reasons)],
      wouldReturn: input.wouldReturn,
      comments: input.comments.trim(),
      submittedOn: todayISO(),
    };
    return null;
  });
}

export function setSettlement(actor: LifecycleActor, id: string, next: SettlementStatus): LifecycleResult {
  return mutateCase(id, (row) => {
    if (!isHrRole(actor.role)) return "Only HR can update the final settlement.";
    if (row.employeeId === actor.id) return "You cannot update your own settlement.";
    if (row.status !== "Accepted" && row.status !== "Completed") return "Settlement starts once the resignation is accepted.";
    const from = SETTLEMENT_STEPS.indexOf(row.settlement);
    const to = SETTLEMENT_STEPS.indexOf(next);
    if (to < 0) return "Unknown settlement status.";
    if (to !== from + 1) return `Settlement can only move from ${row.settlement} to ${SETTLEMENT_STEPS[from + 1] ?? "—"}.`;
    row.settlement = next;
    row.settlementUpdatedBy = actor.fullName;
    row.settlementUpdatedOn = todayISO();
    return null;
  });
}

/**
 * HR closes the exit: marks the directory record Terminated (keeping every other field)
 * and raises the relieving/experience letter request.
 * Returns an error, or null plus an optional warning about the letter via `onWarning`.
 */
export function completeExit(actor: DemoAccount, id: string, onWarning?: (text: string) => void): LifecycleResult {
  if (!isHrRole(actor.role)) return "Only HR can complete an exit.";
  const row = getExitState().cases.find((c) => c.id === id);
  if (!row) return "Exit record not found.";
  if (row.employeeId === actor.id) return "You cannot complete your own exit.";
  const blocker = completionBlocker(row);
  if (blocker) return blocker;
  const person = getPerson(row.employeeId);
  if (!person) return "This person is not in the directory.";
  try {
    const updated: LocalPersonRecord = {
      ...person,
      employmentStatus: "Terminated",
      exitDate: row.lastWorkingDay,
      exitReason: row.kind === "Probation not confirmed" ? `Probation not confirmed — ${row.reason}` : `Resignation — ${row.reason}`,
    };
    upsertPerson(updated);
  } catch {
    return "Could not update the directory record. Please try again.";
  }
  const error = mutateCase(id, (r) => {
    r.status = "Completed";
    r.completedBy = actor.fullName;
    r.completedOn = todayISO();
    return null;
  });
  if (error) return error;
  // Leavers get both a relieving letter and an experience letter.
  const letterErrors = (["Relieving", "Experience"] as const)
    .map((type) =>
      addLetterRequest(actor, {
        employeeId: row.employeeId,
        employeeName: row.employeeName,
        type,
        note: `${type} letter — last working day ${row.lastWorkingDay}.`,
      }),
    )
    .filter(Boolean);
  if (letterErrors.length) onWarning?.(`Exit completed, but a letter request was not created: ${letterErrors.join(" ")}`);
  return null;
}

/**
 * The company starts an exit (probation not confirmed). It is accepted straight away by the person who
 * approved the decision, so clearance can begin; HR then completes it like any other exit.
 */
export function startCompanyExit(
  actor: LifecycleActor,
  employeeId: string,
  input: { reason: string; lastWorkingDay: string; assets?: Pick<AssetAssignment, "id" | "name" | "tag" | "employeeId">[] },
): LifecycleResult {
  if (actor.id === employeeId) return "You cannot start your own exit.";
  const person = getPerson(employeeId);
  if (!person) return "This person is not in the directory.";
  if (person.employmentStatus === "Terminated") return "This person has already left.";
  if (openExitFor(employeeId)) return "An exit is already open for this person.";
  const today = todayISO();
  const id = `exit-${Date.now()}`;
  const state = getExitState();
  const row: ExitCase = {
    id,
    employeeId,
    employeeName: person.fullName,
    submittedOn: today,
    noticeDays: noticeDaysFor(employeeId),
    proposedLastDay: input.lastWorkingDay,
    lastWorkingDay: input.lastWorkingDay,
    earlyRelease: false,
    reason: input.reason.trim() || "Probation not confirmed",
    note: "",
    status: "Accepted",
    decidedBy: actor.fullName,
    decidedById: actor.id,
    decidedOn: today,
    decisionNote: "Probation not confirmed.",
    clearance: buildClearance(id, (input.assets ?? []).filter((a) => a.employeeId === employeeId)),
    settlement: "Pending",
    kind: "Probation not confirmed",
  };
  return write({ ...state, cases: [row, ...state.cases] });
}

/** Re-export so pages can show the person's country without extra imports. */
export function exitCountry(employeeId: string): string {
  return getPerson(employeeId)?.countryName ?? countryCodeFor(employeeId);
}

export { personName };
