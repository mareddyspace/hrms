import { DEMO_ACCOUNTS } from "../../demoAccounts.ts";
import { resolveWorkflow, type ApprovalStepRole } from "../../data/approvalWorkflows.ts";
import { appendAuditEntries } from "../../data/auditTrail.ts";
import { pushPersonTaskAlert } from "../../data/collabLocal.ts";
import { recordLifecycleChanges } from "../../data/lifecycleHistory.ts";
import {
  LEGAL_BY_COUNTRY,
  costCenterFor,
  divisionForDepartment,
  familyForDepartment,
  jobProfileFor,
  type PersonRecord,
} from "../../data/peopleData.ts";
import { getPerson, listPeople, upsertPerson, wouldCreateLoop, type LocalPersonRecord } from "../../data/peopleLocal.ts";
import { TIMEZ_COUNTRIES, formatShortDate } from "../../model.ts";
import { isAboveInLine, isHrRole, isValidISO, personName, type LifecycleActor, type LifecycleResult } from "./lifecycleShared.ts";

/**
 * Lifecycle actions: transfer, promotion, manager change and location change. Raised by a manager (for
 * people in their reporting line) or HR, decided step by step through the "lifecycle" approval workflow,
 * then applied to the directory record on the effective date.
 */
const KEY = "infotech.lifecycle.actions.v1";
const HREF = "/lifecycle/actions";

export type LifecycleActionType = "Transfer" | "Promotion" | "Manager change" | "Location change";
export const LIFECYCLE_ACTION_TYPES: LifecycleActionType[] = ["Transfer", "Promotion", "Manager change", "Location change"];

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
}

export interface ActionStep {
  role: ApprovalStepRole;
  label: string;
  approverIds: string[];
  decision?: "Approved" | "Rejected";
  byId?: string;
  by?: string;
  on?: string;
  note?: string;
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
}

/** Which fields each action type edits. */
export const FIELDS_BY_TYPE: Record<LifecycleActionType, (keyof JobValues)[]> = {
  Transfer: ["department", "location", "managerId"],
  Promotion: ["designation", "grade"],
  "Manager change": ["managerId"],
  "Location change": ["location"],
};

export const FIELD_LABEL: Record<keyof JobValues, string> = {
  department: "Department",
  location: "Location",
  countryCode: "Country",
  designation: "Title",
  grade: "Grade",
  managerId: "Manager",
  managerName: "Manager",
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
  return out;
}

/* ───────────── Permissions ───────────── */

export function canRaiseFor(actor: LifecycleActor, employeeId: string): boolean {
  if (actor.id === employeeId) return false;
  if (isHrRole(actor.role)) return true;
  return isAboveInLine(actor.id, employeeId);
}

export function currentStepIndex(action: LifecycleAction): number {
  return action.steps.findIndex((s) => !s.decision);
}

export function canDecide(actor: LifecycleActor, action: LifecycleAction): boolean {
  if (action.status !== "Pending" || actor.id === action.employeeId) return false;
  const step = action.steps[currentStepIndex(action)];
  return Boolean(step && step.approverIds.includes(actor.id));
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
    next.businessUnit = country ? `Infotech ${country.name}` : person.businessUnit;
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
  return next;
}

/** Write the change to the directory record. Returns an error if the person is gone. */
function applyToDirectory(action: LifecycleAction, actor: { id: string; fullName: string }): LifecycleResult {
  const person = getPerson(action.employeeId);
  if (!person) return "This person is not in the directory.";
  if (person.employmentStatus === "Terminated") return "This person has left the organisation.";
  const next = applyTo(person, action.after);
  upsertPerson(next);
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
    const preview = applyTo(person, action.after);
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
export function applyDueLifecycleActions(): number {
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
  write(actions.map((a) => done.get(a.id) ?? a));
  return done.size;
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
}

export function raiseLifecycleAction(actor: LifecycleActor, input: RaiseInput): LifecycleResult {
  const person = getPerson(input.employeeId);
  if (!person) return "Choose an employee.";
  if (person.employmentStatus === "Terminated") return "This person has left the organisation.";
  if (!canRaiseFor(actor, person.id)) return actor.id === person.id ? "You cannot raise a change for yourself." : "Only their manager or HR can raise this.";
  if (!LIFECYCLE_ACTION_TYPES.includes(input.type)) return "Choose an action type.";
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
  if (fields.includes("managerId") && input.managerId !== undefined && input.managerId !== before.managerId) {
    if (!input.managerId) return "Choose a manager.";
    const manager = getPerson(input.managerId);
    if (!manager || manager.employmentStatus === "Terminated") return "Choose an active manager.";
    if (wouldCreateLoop(person.id, manager.id)) return "That manager reports to this person.";
    after.managerId = manager.id;
    after.managerName = manager.fullName;
  }
  if (input.type === "Promotion" && !after.designation) return "Enter the new title.";
  const changes = changedFields({ before, after });
  if (!changes.length) return "Change at least one value.";
  if (input.type === "Transfer" && after.department === before.department && after.location === before.location) {
    return "A transfer needs a new department or location.";
  }

  const today = localToday();
  const steps: ActionStep[] = resolveWorkflow("lifecycle", person.id).map((s) => ({
    role: s.role,
    label: s.label,
    approverIds: s.approverIds.filter((id) => id !== person.id),
  }));
  // A step the raiser would decide counts as approved by raising it.
  for (const step of steps) {
    if (step.approverIds.includes(actor.id)) {
      Object.assign(step, { decision: "Approved", byId: actor.id, by: actor.fullName, on: today, note: "Raised by approver" });
    }
  }
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
  };
  auditAction(actor, action, "Created", [
    { field: "type", before: "—", after: action.type },
    { field: "effective date", before: "—", after: action.effectiveDate },
    ...changes,
  ]);
  if (currentStepIndex(action) < 0) action = finalise(action, actor);
  const error = write([action, ...getLifecycleActions()]);
  if (error) return error;
  const next = action.steps[currentStepIndex(action)];
  if (action.status === "Pending" && next) {
    notify(next.approverIds, `${action.type} to approve`, `${actor.fullName} raised a ${action.type.toLowerCase()} for ${person.fullName}, effective ${formatShortDate(action.effectiveDate)}.`);
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
  const steps = current.steps.map((s, i) =>
    i === index ? { ...s, decision: decision === "approve" ? ("Approved" as const) : ("Rejected" as const), byId: actor.id, by: actor.fullName, on: today, note: trimmed } : s,
  );
  let action: LifecycleAction = { ...current, steps };
  auditAction(actor, action, "Updated", [
    { field: steps[index].label, before: "Pending", after: decision === "approve" ? "Approved" : "Rejected" },
    ...(trimmed ? [{ field: "note", before: "—", after: trimmed }] : []),
  ]);
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
    notify(nextStep.approverIds, `${action.type} to approve`, `${action.employeeName}'s ${action.type.toLowerCase()} needs your approval.`);
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
  const waiting = current.steps[currentStepIndex(current)]?.approverIds ?? [];
  notify(waiting.filter((rid) => rid !== actor.id), `${current.type} withdrawn`, `The ${current.type.toLowerCase()} for ${current.employeeName} was withdrawn.`);
  return null;
}

/** Readable names for a step's approvers. */
export function approverNames(step: ActionStep): string {
  return step.approverIds.map((id) => DEMO_ACCOUNTS.find((a) => a.id === id)?.fullName ?? personName(id)).join(", ") || "—";
}
