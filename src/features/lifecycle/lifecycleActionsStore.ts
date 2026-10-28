import { DEMO_ACCOUNTS } from "../../demoAccounts.ts";
import { resolveFlow, type ApprovalStepRole, type ParallelMode } from "../../data/approvalWorkflows.ts";
import { appendAuditEntries } from "../../data/auditTrail.ts";
import { pushPersonTaskAlert } from "../../data/collabLocal.ts";
import { recordLifecycleChanges } from "../../data/lifecycleHistory.ts";
import { confirmProbationFromAction } from "./probationStore.ts";
import {
  LEGAL_BY_COUNTRY,
  costCenterFor,
  divisionForDepartment,
  familyForDepartment,
  gradeRank,
  jobProfileFor,
  jobProfileLabel,
  type EmploymentStatus,
  type PersonRecord,
} from "../../data/peopleData.ts";
import { getPerson, listPeople, upsertPerson, wouldCreateLoop, type LocalPersonRecord } from "../../data/peopleLocal.ts";
import { TIMEZ_COUNTRIES, formatShortDate } from "../../model.ts";
import {
  daysBetween,
  isAboveInLine,
  isContractor,
  isHrRole,
  isValidISO,
  personName,
  type LifecycleActor,
  type LifecycleResult,
} from "./lifecycleShared.ts";

/**
 * Lifecycle actions: transfer, promotion, job change, manager and location change, leave of absence and return,
 * contract extension, probation completion and rehire. Raised by a manager (for people in their reporting line)
 * or HR, decided step by step through the "lifecycle" approval workflow, then applied to the directory record on
 * the effective date. A leave of absence ends by itself on its end date.
 */
const KEY = "infotech.lifecycle.actions.v1";
const HREF = "/lifecycle/actions";

export type LifecycleActionType =
  | "Transfer"
  | "Promotion"
  | "Job change"
  | "Manager change"
  | "Location change"
  | "Leave of absence"
  | "Return from leave"
  | "Contract extension"
  | "Probation completion"
  | "Rehire";
export const LIFECYCLE_ACTION_TYPES: LifecycleActionType[] = [
  "Transfer",
  "Promotion",
  "Job change",
  "Manager change",
  "Location change",
  "Leave of absence",
  "Return from leave",
  "Contract extension",
  "Probation completion",
  "Rehire",
];
/** Only HR raises these. */
export const HR_ONLY_ACTION_TYPES: LifecycleActionType[] = ["Rehire"];
export const LEAVE_OF_ABSENCE_TYPES = ["Medical", "Parental", "Sabbatical", "Study", "Personal", "Military service"];
/** Longest leave of absence that can be raised in one go. */
const MAX_LEAVE_DAYS = 730;

export type LifecycleActionStatus = "Pending" | "Scheduled" | "Applied" | "Rejected" | "Withdrawn";

/** The job fields an action can change. */
export interface JobValues {
  department: string;
  location: string;
  countryCode: string;
  designation: string;
  grade: string;
  managerId: string;
  managerName: string;
  /* Added with the newer action types; older stored actions do not carry them. */
  jobProfileId?: string;
  employmentStatus?: EmploymentStatus;
  contractEndDate?: string;
  confirmationDate?: string;
}

interface StepDecisionInfo {
  decision?: "Approved" | "Rejected";
  byId?: string;
  by?: string;
  on?: string;
  note?: string;
}

/** One approver group of a parallel step, with its own decision. */
export interface ActionGroup extends StepDecisionInfo {
  role: ApprovalStepRole;
  label: string;
  approverIds: string[];
}

/** The step's decision is set once the step is done (for a parallel step: from its groups). */
export interface ActionStep extends StepDecisionInfo {
  role: ApprovalStepRole;
  label: string;
  /** Everyone who can act on this step (all groups). */
  approverIds: string[];
  /** Parallel steps only: "all" — every group approves; "any" — one approval closes the step. Older actions have none. */
  mode?: ParallelMode;
  groups?: ActionGroup[];
}

export interface LifecycleAction {
  id: string;
  employeeId: string;
  employeeName: string;
  type: LifecycleActionType;
  effectiveDate: string;
  reason: string;
  before: JobValues;
  after: JobValues;
  raisedById: string;
  raisedBy: string;
  raisedOn: string;
  steps: ActionStep[];
  status: LifecycleActionStatus;
  appliedOn?: string;
  closedNote?: string;
  /** Leave of absence details (type and dates). */
  leave?: { type: string; start: string; end: string };
  /** Set when a leave of absence ended (automatically on its end date, or by a return from leave). */
  returnedOn?: string;
}

/** Which fields each action type edits. */
export const FIELDS_BY_TYPE: Record<LifecycleActionType, (keyof JobValues)[]> = {
  Transfer: ["department", "location", "managerId"],
  Promotion: ["designation", "grade"],
  "Job change": ["designation", "jobProfileId", "grade"],
  "Manager change": ["managerId"],
  "Location change": ["location"],
  "Leave of absence": [],
  "Return from leave": [],
  "Contract extension": ["contractEndDate"],
  "Probation completion": [],
  Rehire: ["designation", "department", "location", "grade", "managerId"],
};

export const FIELD_LABEL: Record<keyof JobValues, string> = {
  department: "Department",
  location: "Location",
  countryCode: "Country",
  designation: "Title",
  grade: "Grade",
  managerId: "Manager",
  managerName: "Manager",
  jobProfileId: "Job profile",
  employmentStatus: "Status",
  contractEndDate: "Contract end",
  confirmationDate: "Confirmed",
};

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function read(): LifecycleAction[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? (parsed as LifecycleAction[]).filter((a) => a && Array.isArray(a.steps)) : [];
  } catch {
    return [];
  }
}

let cache: LifecycleAction[] | null = null;
const listeners = new Set<() => void>();

function write(actions: LifecycleAction[]): LifecycleResult {
  try {
    localStorage.setItem(KEY, JSON.stringify(actions));
  } catch {
    return "Could not save. Please try again.";
  }
  cache = actions;
  listeners.forEach((fn) => fn());
  return null;
}

export function subscribeLifecycleActions(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Stable snapshot for useSyncExternalStore, newest first. */
export function getLifecycleActions(): LifecycleAction[] {
  if (!cache) cache = read().sort((a, b) => b.raisedOn.localeCompare(a.raisedOn) || b.id.localeCompare(a.id));
  return cache;
}

export function lifecycleActionsFor(employeeId: string, actions = getLifecycleActions()): LifecycleAction[] {
  return actions.filter((a) => a.employeeId === employeeId);
}

export function jobValuesOf(person: PersonRecord): JobValues {
  return {
    department: person.department,
    location: person.location,
    countryCode: String(person.countryCode),
    designation: person.designation,
    grade: person.grade,
    managerId: person.managerId || "",
    managerName: person.managerName || "",
    jobProfileId: person.jobProfileId || "",
    employmentStatus: person.employmentStatus,
    contractEndDate: person.contractEndDate || "",
    confirmationDate: person.confirmationDate || "",
  };
}

/** Fields that differ between before and after (manager compared by id). */
export function changedFields(action: Pick<LifecycleAction, "before" | "after">): { field: string; before: string; after: string }[] {
  const out: { field: string; before: string; after: string }[] = [];
  const { before: b, after: a } = action;
  const country = (cc: string) => TIMEZ_COUNTRIES.find((c) => c.code === cc)?.name ?? cc;
  if (b.department !== a.department) out.push({ field: "Department", before: b.department || "—", after: a.department || "—" });
  if (b.location !== a.location || b.countryCode !== a.countryCode) {
    const same = b.countryCode === a.countryCode;
    out.push({
      field: "Location",
      before: same ? b.location || "—" : `${b.location} · ${country(b.countryCode)}`,
      after: same ? a.location || "—" : `${a.location} · ${country(a.countryCode)}`,
    });
  }
  if (b.designation !== a.designation) out.push({ field: "Title", before: b.designation || "—", after: a.designation || "—" });
  if (b.grade !== a.grade) out.push({ field: "Grade", before: b.grade || "—", after: a.grade || "—" });
  if (b.managerId !== a.managerId) out.push({ field: "Manager", before: b.managerName || "No manager", after: a.managerName || "No manager" });
  // Newer fields: older stored actions have them undefined on both sides, so nothing shows.
  if ((b.jobProfileId ?? "") !== (a.jobProfileId ?? "")) {
    out.push({ field: "Job profile", before: b.jobProfileId ? jobProfileLabel(b.jobProfileId) : "—", after: a.jobProfileId ? jobProfileLabel(a.jobProfileId) : "—" });
  }
  if (a.employmentStatus && b.employmentStatus !== a.employmentStatus) out.push({ field: "Status", before: b.employmentStatus || "—", after: a.employmentStatus });
  if ((b.contractEndDate ?? "") !== (a.contractEndDate ?? "")) {
    out.push({ field: "Contract end", before: b.contractEndDate ? formatShortDate(b.contractEndDate) : "—", after: a.contractEndDate ? formatShortDate(a.contractEndDate) : "—" });
  }
  if ((b.confirmationDate ?? "") !== (a.confirmationDate ?? "")) {
    out.push({ field: "Probation", before: b.confirmationDate ? "Confirmed" : "In probation", after: a.confirmationDate ? `Confirmed ${formatShortDate(a.confirmationDate)}` : "—" });
  }
  return out;
}

/* ───────────── Permissions ───────────── */

export function canRaiseFor(actor: LifecycleActor, employeeId: string, type?: LifecycleActionType): boolean {
  if (actor.id === employeeId) return false;
  if (isHrRole(actor.role)) return true;
  if (type && HR_ONLY_ACTION_TYPES.includes(type)) return false;
  return isAboveInLine(actor.id, employeeId);
}

/** Why this person cannot take this action right now, or null when they can. */
export function actionBlocker(person: PersonRecord, type: LifecycleActionType): string | null {
  const left = person.employmentStatus === "Terminated";
  if (type === "Rehire") return left ? null : "Only people who have left can be rehired.";
  if (left) return "This person has left the organisation.";
  if (type === "Return from leave" && person.employmentStatus !== "On Leave") return "This person is not on a leave of absence.";
  if (type === "Leave of absence" && person.employmentStatus === "On Leave") return "This person is already on a leave of absence.";
  if (type === "Contract extension" && !isContractor(person) && !person.contractEndDate) return "Only contractors and fixed-term staff have a contract end date.";
  if (type === "Probation completion" && person.confirmationDate) return `Probation was already completed on ${formatShortDate(person.confirmationDate)}.`;
  return null;
}

export function currentStepIndex(action: LifecycleAction): number {
  return action.steps.findIndex((s) => !s.decision);
}

/** A step where every one of several groups must approve. */
function isAllParallel(step: ActionStep | undefined): step is ActionStep & { groups: ActionGroup[] } {
  return !!step && step.mode !== "any" && (step.groups?.length ?? 0) > 1;
}

/** Groups of a parallel "all" step still waiting for a decision. */
export function pendingGroupsOf(step: ActionStep | undefined): ActionGroup[] {
  return isAllParallel(step) ? step.groups.filter((g) => !g.decision) : [];
}

/** People who still have to act on the open step. */
export function waitingIdsOf(action: LifecycleAction): string[] {
  const step = action.steps[currentStepIndex(action)];
  if (!step) return [];
  if (isAllParallel(step)) return [...new Set(pendingGroupsOf(step).flatMap((g) => g.approverIds))];
  return step.approverIds;
}

type DecisionInput = Required<Pick<StepDecisionInfo, "decision" | "byId" | "by" | "on">> & { note?: string };

/**
 * Record one person's decision on a step. On a parallel "all" step it counts for every waiting group they're in;
 * the step closes once every group approved, or any group rejected. On an "any" step the first decision closes it.
 */
function decideStep(step: ActionStep, actorId: string, info: DecisionInput): ActionStep {
  if (!step.groups || step.groups.length < 2) return { ...step, ...info };
  const all = isAllParallel(step);
  let marked = false;
  const groups = step.groups.map((g) => {
    if (g.decision || !g.approverIds.includes(actorId) || (!all && marked)) return g;
    marked = true;
    return { ...g, ...info };
  });
  const rejected = groups.some((g) => g.decision === "Rejected");
  const done = rejected || (all ? groups.every((g) => g.decision === "Approved") : groups.some((g) => g.decision));
  return done ? { ...step, groups, ...info, decision: rejected ? "Rejected" : "Approved" } : { ...step, groups };
}

export function canDecide(actor: LifecycleActor, action: LifecycleAction): boolean {
  if (action.status !== "Pending" || actor.id === action.employeeId) return false;
  return waitingIdsOf(action).includes(actor.id);
}

/** Actions this person may see: their own, ones they raised or decide, their reporting line, or everything for HR/admin. */
export function canSeeAction(actor: LifecycleActor, action: LifecycleAction): boolean {
  if (isHrRole(actor.role) || actor.role === "admin" || actor.role === "super_admin") return true;
  if (action.employeeId === actor.id || action.raisedById === actor.id) return true;
  if (action.steps.some((s) => s.approverIds.includes(actor.id))) return true;
  return isAboveInLine(actor.id, action.employeeId);
}

/* ───────────── Notifications and audit ───────────── */

function notify(ids: string[], title: string, body: string) {
  for (const recipientId of new Set(ids)) {
    if (recipientId) pushPersonTaskAlert({ recipientId, title, body, href: HREF });
  }
}

function auditAction(
  actor: { id: string; fullName: string },
  action: LifecycleAction,
  kind: "Created" | "Updated",
  changes: { field: string; before: string; after: string }[],
) {
  appendAuditEntries([
    {
      at: new Date().toISOString(),
      actorId: actor.id,
      actorName: actor.fullName,
      entity: "Lifecycle action",
      entityId: action.id,
      subjectId: action.employeeId,
      action: kind,
      changes,
    },
  ]);
}

/* ───────────── Applying ───────────── */

/** Build the new directory record for an approved action. */
function applyTo(person: PersonRecord, after: JobValues): LocalPersonRecord {
  const next: LocalPersonRecord = { ...(person as LocalPersonRecord) };
  if (after.department !== person.department) {
    next.department = after.department;
    next.division = divisionForDepartment(after.department);
    next.jobFamily = familyForDepartment(after.department);
  }
  if (after.countryCode !== String(person.countryCode)) {
    const country = TIMEZ_COUNTRIES.find((c) => c.code === after.countryCode);
    const peer = listPeople().find((p) => String(p.countryCode) === after.countryCode);
    next.countryCode = after.countryCode;
    next.countryName = country?.name ?? after.countryCode;
    next.legalEntity = LEGAL_BY_COUNTRY[after.countryCode] ?? person.legalEntity;
    next.businessUnit = country ? `TimeZ ${country.name}` : person.businessUnit;
    if (peer) {
      next.timeZone = peer.timeZone;
      next.currency = peer.currency;
    }
  }
  if (after.department !== person.department || after.countryCode !== String(person.countryCode)) {
    next.costCenter = costCenterFor(after.countryCode, after.department);
  }
  next.location = after.location;
  if (after.designation !== person.designation) {
    next.designation = after.designation;
    // Only switch profile on an exact title match; otherwise keep the current one.
    const profile = jobProfileFor(after.designation, next.jobFamily);
    if (profile && profile.title.toLowerCase() === after.designation.trim().toLowerCase()) next.jobProfileId = profile.id;
  }
  next.grade = after.grade;
  next.managerId = after.managerId;
  next.managerName = after.managerName;
  if (after.jobProfileId) next.jobProfileId = after.jobProfileId;
  if (after.contractEndDate && after.contractEndDate !== person.contractEndDate) next.contractEndDate = after.contractEndDate;
  if (after.confirmationDate && after.confirmationDate !== person.confirmationDate) next.confirmationDate = after.confirmationDate;
  return next;
}

/** Status changes that come with the action type (leave, return, rehire). */
function applyStatus(next: LocalPersonRecord, action: Pick<LifecycleAction, "type" | "effectiveDate" | "leave">): LocalPersonRecord {
  const activeStatus = (p: PersonRecord): EmploymentStatus => (/contract/i.test(p.employmentType) ? "Contractor" : "Active");
  switch (action.type) {
    case "Leave of absence":
      return { ...next, employmentStatus: "On Leave", availability: "On Leave", leaveOfAbsence: action.leave };
    case "Return from leave":
      return { ...next, employmentStatus: activeStatus(next), availability: "In Office", leaveOfAbsence: undefined };
    case "Rehire":
      return {
        ...next,
        employmentStatus: activeStatus(next),
        availability: "In Office",
        rehireDate: action.effectiveDate,
        exitDate: undefined,
        exitReason: undefined,
        leaveOfAbsence: undefined,
      };
    default:
      return next;
  }
}

/** Write the change to the directory record. Returns an error if the person is gone. */
function applyToDirectory(action: LifecycleAction, actor: { id: string; fullName: string }): LifecycleResult {
  const person = getPerson(action.employeeId);
  if (!person) return "This person is not in the directory.";
  if (action.type === "Rehire") {
    if (person.employmentStatus !== "Terminated") return "This person is already active.";
  } else if (person.employmentStatus === "Terminated") return "This person has left the organisation.";
  const next = applyStatus(applyTo(person, action.after), action);
  upsertPerson(next);
  // A return from leave closes the open leave of absence so it is not ended a second time.
  if (action.type === "Return from leave") markLeaveReturned(action.employeeId, action.effectiveDate);
  // Keep the Probation page in step with the directory.
  if (action.type === "Probation completion") confirmProbationFromAction(action.employeeId, action.effectiveDate, actor);
  auditAction(actor, action, "Updated", [
    { field: "status", before: action.status, after: "Applied" },
    ...changedFields({ before: jobValuesOf(person), after: jobValuesOf(next) }),
  ]);
  return null;
}

/** Final approval: apply now when the date has arrived, otherwise schedule it. */
function finalise(action: LifecycleAction, actor: { id: string; fullName: string }): LifecycleAction {
  const today = localToday();
  const person = getPerson(action.employeeId);
  // Record the timeline events now; a future date shows as Scheduled in the history.
  if (person) {
    const preview = applyStatus(applyTo(person, action.after), action);
    recordLifecycleChanges(person, preview, action.effectiveDate, { id: action.raisedById, fullName: action.raisedBy });
  }
  if (action.effectiveDate <= today) {
    const error = applyToDirectory(action, actor);
    return error ? { ...action, status: "Rejected", closedNote: `Could not apply: ${error}` } : { ...action, status: "Applied", appliedOn: today };
  }
  return { ...action, status: "Scheduled" };
}

/**
 * Apply scheduled actions whose effective date has arrived. Safe to call on every load (and on page mount);
 * returns how many were applied.
 */
function applyDueScheduled(): number {
  const today = localToday();
  const actions = getLifecycleActions();
  const due = actions.filter((a) => a.status === "Scheduled" && a.effectiveDate <= today);
  if (!due.length) return 0;
  const system = { id: "system", fullName: "Scheduled change" };
  const done = new Map<string, LifecycleAction>();
  for (const action of [...due].sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate))) {
    const error = applyToDirectory(action, system);
    done.set(
      action.id,
      error ? { ...action, status: "Rejected", closedNote: `Could not apply: ${error}` } : { ...action, status: "Applied", appliedOn: today },
    );
    if (!error) {
      notify(
        [action.employeeId, action.raisedById],
        `${action.type} in effect`,
        `${action.employeeName}'s ${action.type.toLowerCase()} took effect on ${formatShortDate(action.effectiveDate)}.`,
      );
    }
  }
  write(getLifecycleActions().map((a) => done.get(a.id) ?? a));
  return done.size;
}

/** Close any open leave of absence for this person (a return from leave took effect). */
function markLeaveReturned(employeeId: string, on: string) {
  const actions = getLifecycleActions();
  if (!actions.some((a) => a.employeeId === employeeId && a.type === "Leave of absence" && a.status === "Applied" && !a.returnedOn)) return;
  write(actions.map((a) => (a.employeeId === employeeId && a.type === "Leave of absence" && a.status === "Applied" && !a.returnedOn ? { ...a, returnedOn: on } : a)));
}

/**
 * End leaves of absence whose end date has arrived: the person goes back to active on the end date.
 * Returns how many leaves ended.
 */
export function returnDueLeaves(): number {
  const today = localToday();
  const actions = getLifecycleActions();
  const due = actions.filter((a) => a.type === "Leave of absence" && a.status === "Applied" && !a.returnedOn && a.leave && a.leave.end <= today);
  if (!due.length) return 0;
  const system = { id: "system", fullName: "Scheduled change" };
  const done = new Map<string, LifecycleAction>();
  for (const action of due) {
    const end = action.leave!.end;
    done.set(action.id, { ...action, returnedOn: end });
    const person = getPerson(action.employeeId);
    if (!person || person.employmentStatus !== "On Leave") continue;
    const next = applyStatus({ ...(person as LocalPersonRecord) }, { type: "Return from leave", effectiveDate: end });
    upsertPerson(next);
    recordLifecycleChanges(person, next, end, system);
    auditAction(system, action, "Updated", [{ field: "Status", before: "On Leave", after: next.employmentStatus }]);
    notify(
      [action.employeeId, action.raisedById, person.managerId],
      "Back from leave",
      `${action.employeeName}'s leave of absence ended on ${formatShortDate(end)}.`,
    );
  }
  write(getLifecycleActions().map((a) => done.get(a.id) ?? a));
  return done.size;
}

/** Apply scheduled actions and end leaves of absence that are due today. Safe to call on every load (and on page mount); returns how many changed. */
export function applyDueLifecycleActions(): number {
  return applyDueScheduled() + returnDueLeaves();
}

/* ───────────── Raise ───────────── */

export interface RaiseInput {
  employeeId: string;
  type: LifecycleActionType;
  effectiveDate: string;
  reason: string;
  department?: string;
  location?: string;
  countryCode?: string;
  designation?: string;
  grade?: string;
  managerId?: string;
  jobProfileId?: string;
  /** Contract extension: the new end date. */
  contractEndDate?: string;
  /** Leave of absence: type and last day (the effective date is the first day). */
  leaveType?: string;
  leaveEnd?: string;
}

export function raiseLifecycleAction(actor: LifecycleActor, input: RaiseInput): LifecycleResult {
  const person = getPerson(input.employeeId);
  if (!person) return "Choose an employee.";
  if (!LIFECYCLE_ACTION_TYPES.includes(input.type)) return "Choose an action type.";
  if (!canRaiseFor(actor, person.id, input.type)) {
    if (actor.id === person.id) return "You cannot raise a change for yourself.";
    return HR_ONLY_ACTION_TYPES.includes(input.type) ? "Only HR can raise this." : "Only their manager or HR can raise this.";
  }
  const blocker = actionBlocker(person, input.type);
  if (blocker) return blocker;
  if (!isValidISO(input.effectiveDate)) return "Enter a valid effective date.";
  const reason = input.reason.trim();
  if (!reason) return "Give a reason.";
  if (reason.length > 500) return "Reason must be 500 characters or fewer.";
  if (getLifecycleActions().some((a) => a.employeeId === person.id && (a.status === "Pending" || a.status === "Scheduled"))) {
    return `${person.fullName} already has an open change. Wait for it to take effect or withdraw it.`;
  }

  const before = jobValuesOf(person);
  const after: JobValues = { ...before };
  const fields = FIELDS_BY_TYPE[input.type];
  if (fields.includes("department") && input.department) after.department = input.department.trim();
  if (fields.includes("location") && input.location) {
    after.location = input.location.trim();
    after.countryCode = input.countryCode || before.countryCode;
  }
  if (fields.includes("designation") && input.designation !== undefined) after.designation = input.designation.trim();
  if (fields.includes("grade") && input.grade) after.grade = input.grade;
  if (fields.includes("jobProfileId") && input.jobProfileId) after.jobProfileId = input.jobProfileId;
  if (fields.includes("managerId") && input.managerId !== undefined && input.managerId !== before.managerId) {
    if (!input.managerId) return "Choose a manager.";
    const manager = getPerson(input.managerId);
    if (!manager || manager.employmentStatus === "Terminated") return "Choose an active manager.";
    if (wouldCreateLoop(person.id, manager.id)) return "That manager reports to this person.";
    after.managerId = manager.id;
    after.managerName = manager.fullName;
  }
  if ((input.type === "Promotion" || input.type === "Job change" || input.type === "Rehire") && !after.designation) return "Enter the title.";
  if (input.type === "Job change" && gradeRank(after.grade) > gradeRank(before.grade)) {
    return "A higher grade is a promotion. Raise a promotion instead.";
  }

  let leave: LifecycleAction["leave"];
  if (input.type === "Leave of absence") {
    const type = (input.leaveType ?? "").trim();
    if (!LEAVE_OF_ABSENCE_TYPES.includes(type)) return "Choose the type of leave.";
    const end = input.leaveEnd ?? "";
    if (!isValidISO(end)) return "Enter a valid end date.";
    if (end < input.effectiveDate) return "The end date is before the start date.";
    if (daysBetween(input.effectiveDate, end) > MAX_LEAVE_DAYS) return "A leave of absence can be up to two years.";
    leave = { type, start: input.effectiveDate, end };
    after.employmentStatus = "On Leave";
  }
  if (input.type === "Return from leave" || input.type === "Rehire") {
    after.employmentStatus = /contract/i.test(person.employmentType) ? "Contractor" : "Active";
  }
  if (input.type === "Contract extension") {
    const end = input.contractEndDate ?? "";
    if (!isValidISO(end)) return "Enter the new contract end date.";
    const floor = before.contractEndDate && before.contractEndDate > input.effectiveDate ? before.contractEndDate : input.effectiveDate;
    if (end <= floor) return `The new end date must be after ${formatShortDate(floor)}.`;
    after.contractEndDate = end;
  }
  if (input.type === "Probation completion") {
    if (input.effectiveDate < person.dateOfJoining) return "Probation cannot end before the joining date.";
    after.confirmationDate = input.effectiveDate;
  }

  const changes = changedFields({ before, after });
  if (!changes.length) return "Change at least one value.";
  if (input.type === "Transfer" && after.department === before.department && after.location === before.location) {
    return "A transfer needs a new department or location.";
  }

  const today = localToday();
  // Parallel steps keep their approver groups.
  const resolved: ActionStep[] = resolveFlow("lifecycle", person.id, { excludeIds: [person.id] }).map((s) => ({
    role: s.groups?.[0]?.role ?? s.role,
    label: s.label,
    approverIds: s.approverIds,
    ...(s.groups ? { mode: s.mode ?? "all", groups: s.groups.map((g) => ({ role: g.role, label: g.label, approverIds: g.approverIds })) } : {}),
  }));
  // A step (or parallel group) the raiser would decide counts as approved by raising it.
  const steps = resolved.map((step) =>
    step.approverIds.includes(actor.id)
      ? decideStep(step, actor.id, { decision: "Approved", byId: actor.id, by: actor.fullName, on: today, note: "Raised by approver" })
      : step,
  );
  let action: LifecycleAction = {
    id: `lca-${Date.now().toString(36)}`,
    employeeId: person.id,
    employeeName: person.fullName,
    type: input.type,
    effectiveDate: input.effectiveDate,
    reason,
    before,
    after,
    raisedById: actor.id,
    raisedBy: actor.fullName,
    raisedOn: today,
    steps,
    status: "Pending",
    ...(leave ? { leave } : {}),
  };
  auditAction(actor, action, "Created", [
    { field: "type", before: "—", after: action.type },
    { field: "effective date", before: "—", after: action.effectiveDate },
    ...(leave ? [{ field: "leave", before: "—", after: `${leave.type} until ${leave.end}` }] : []),
    ...changes,
  ]);
  if (currentStepIndex(action) < 0) action = finalise(action, actor);
  const error = write([action, ...getLifecycleActions()]);
  if (error) return error;
  const next = action.steps[currentStepIndex(action)];
  if (action.status === "Pending" && next) {
    notify(waitingIdsOf(action), `${action.type} to approve`, `${actor.fullName} raised a ${action.type.toLowerCase()} for ${person.fullName}, effective ${formatShortDate(action.effectiveDate)}.`);
  } else {
    notify([person.id], `${action.type} approved`, `Your ${action.type.toLowerCase()} is ${action.status === "Scheduled" ? `scheduled for ${formatShortDate(action.effectiveDate)}` : "in effect"}.`);
  }
  return null;
}

/* ───────────── Decide / withdraw ───────────── */

export function decideLifecycleAction(actor: LifecycleActor, id: string, decision: "approve" | "reject", note: string): LifecycleResult {
  const actions = getLifecycleActions();
  const current = actions.find((a) => a.id === id);
  if (!current) return "Action not found.";
  if (current.status !== "Pending") return "This action is no longer waiting for a decision.";
  if (actor.id === current.employeeId) return "You cannot decide a change to your own record.";
  if (!canDecide(actor, current)) return "This step is waiting for someone else.";
  const trimmed = note.trim();
  if (decision === "reject" && !trimmed) return "Add a note explaining the rejection.";
  if (trimmed.length > 500) return "Note must be 500 characters or fewer.";
  const today = localToday();
  const index = currentStepIndex(current);
  const verdict = decision === "approve" ? ("Approved" as const) : ("Rejected" as const);
  const before = current.steps[index]!;
  const decided = decideStep(before, actor.id, { decision: verdict, byId: actor.id, by: actor.fullName, on: today, note: trimmed });
  const steps = current.steps.map((s, i) => (i === index ? decided : s));
  let action: LifecycleAction = { ...current, steps };
  // Parallel step: one row per group this person decided.
  const decidedGroups = (decided.groups ?? []).filter((g, gi) => g.decision && !before.groups?.[gi]?.decision);
  auditAction(actor, action, "Updated", [
    ...(decidedGroups.length
      ? decidedGroups.map((g) => ({ field: `${before.label} · ${g.label}`, before: "Pending", after: verdict }))
      : [{ field: before.label, before: "Pending", after: verdict }]),
    ...(trimmed ? [{ field: "note", before: "—", after: trimmed }] : []),
  ]);
  // Other groups of this parallel step still have to approve: they were told when the step opened.
  if (decision === "approve" && !decided.decision) {
    return write(actions.map((a) => (a.id === id ? action : a)));
  }
  if (decision === "reject") {
    action = { ...action, status: "Rejected", closedNote: trimmed };
  } else if (currentStepIndex(action) < 0) {
    action = finalise(action, actor);
  }
  const error = write(actions.map((a) => (a.id === id ? action : a)));
  if (error) return error;

  const nextStep = action.steps[currentStepIndex(action)];
  if (action.status === "Rejected") {
    notify([action.raisedById], `${action.type} rejected`, `${actor.fullName} rejected the ${action.type.toLowerCase()} for ${action.employeeName}. ${action.closedNote ?? ""}`.trim());
  } else if (action.status === "Pending" && nextStep) {
    notify(waitingIdsOf(action), `${action.type} to approve`, `${action.employeeName}'s ${action.type.toLowerCase()} needs your approval.`);
    notify([action.raisedById].filter((rid) => rid !== actor.id), `${action.type} moving`, `${actor.fullName} approved the ${action.type.toLowerCase()} for ${action.employeeName}.`);
  } else {
    const when = action.status === "Scheduled" ? `takes effect on ${formatShortDate(action.effectiveDate)}` : "is now in effect";
    notify([action.raisedById, action.employeeId].filter((rid) => rid !== actor.id), `${action.type} approved`, `${action.employeeName}'s ${action.type.toLowerCase()} ${when}.`);
  }
  return null;
}

export function withdrawLifecycleAction(actor: LifecycleActor, id: string): LifecycleResult {
  const actions = getLifecycleActions();
  const current = actions.find((a) => a.id === id);
  if (!current) return "Action not found.";
  if (current.status !== "Pending") return "Only actions waiting for approval can be withdrawn.";
  if (current.raisedById !== actor.id && !isHrRole(actor.role)) return "Only the person who raised it or HR can withdraw it.";
  const action: LifecycleAction = { ...current, status: "Withdrawn", closedNote: `Withdrawn by ${actor.fullName}` };
  const error = write(actions.map((a) => (a.id === id ? action : a)));
  if (error) return error;
  auditAction(actor, action, "Updated", [{ field: "status", before: "Pending", after: "Withdrawn" }]);
  const waiting = waitingIdsOf(current);
  notify(waiting.filter((rid) => rid !== actor.id), `${current.type} withdrawn`, `The ${current.type.toLowerCase()} for ${current.employeeName} was withdrawn.`);
  return null;
}

/** Readable names for a step's approvers. */
export function approverNames(step: Pick<ActionStep, "approverIds">): string {
  return step.approverIds.map((id) => DEMO_ACCOUNTS.find((a) => a.id === id)?.fullName ?? personName(id)).join(", ") || "—";
}
