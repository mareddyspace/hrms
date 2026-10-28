/**
 * Own-profile background edits and profile correction requests.
 *
 * Employees edit their own preferred name, languages, education, previous experience and career goals directly.
 * HR-owned fields (name, date of birth, nationality, job title, department, manager, work arrangement) change only
 * through a correction request: the employee asks, HR approves or rejects, and approval writes the directory record.
 */
import { useSyncExternalStore } from "react";
import { DEMO_ACCOUNTS } from "../demoAccounts.ts";
import type { UserRole } from "../model.ts";
import { appendAuditEntries } from "./auditTrail.ts";
import { pushPersonTaskAlert } from "./collabLocal.ts";
import {
  WORK_ARRANGEMENTS,
  divisionForDepartment,
  familyForDepartment,
  joinName,
  splitName,
  type EducationRecord,
  type ExperienceRecord,
  type PersonRecord,
  type WorkArrangement,
} from "./peopleData.ts";
import { getPerson, upsertPerson, wouldCreateLoop, type LocalPersonRecord } from "./peopleLocal.ts";
import { canManagePeople } from "./peoplePermissions.ts";
import { profileExtrasFor, saveProfileExtras } from "./profileExtras.ts";
import { API_ENABLED, onApiSession } from "../api/client.ts";
import {
  apiDecideCorrection,
  apiListCorrections,
  apiRequestCorrection,
  apiUpdateOwnProfile,
  apiWithdrawCorrection,
  type ApiCorrectionField,
  type ProfileCorrectionOut,
} from "../api/syncProfile.ts";

type Actor = { id: string; fullName: string; role: UserRole };
/** null when saved, otherwise the reason it was refused. */
export type ProfileResult = string | null;
/** In backend mode the save goes to the server, so the result arrives later. */
export type ProfileResultAsync = ProfileResult | Promise<ProfileResult>;

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const show = (value: unknown): string => {
  if (value === undefined || value === null || value === "") return "—";
  if (Array.isArray(value)) return value.length ? value.map((v) => (typeof v === "object" ? Object.values(v as object).join(" ") : String(v))).join("; ").slice(0, 80) : "—";
  return String(value).slice(0, 80);
};

/* ───────────── Own background details ───────────── */

export interface OwnBackgroundInput {
  preferredName: string;
  preferredLanguage: string;
  spokenLanguages: string[];
  education: EducationRecord[];
  experience: ExperienceRecord[];
  careerGoals: string;
}

const ISO_RE = /^\d{4}-\d{2}(-\d{2})?$/;

function validateBackground(input: OwnBackgroundInput, today: string): ProfileResult {
  if (input.preferredName.trim().length > 40) return "Preferred name must be 40 characters or fewer.";
  if (input.spokenLanguages.length > 12) return "List up to 12 languages.";
  if (input.careerGoals.trim().length > 1000) return "Career goals must be 1,000 characters or fewer.";
  const year = Number(today.slice(0, 4));
  for (const [i, e] of input.education.entries()) {
    const n = i + 1;
    if (!e.degree.trim() || !e.institution.trim()) return `Education ${n}: enter the degree and institution.`;
    if (!Number.isInteger(e.year) || e.year < 1950 || e.year > year + 6) return `Education ${n}: enter a valid year.`;
  }
  for (const [i, x] of input.experience.entries()) {
    const n = i + 1;
    if (!x.employer.trim() || !x.title.trim()) return `Experience ${n}: enter the company and title.`;
    if (!ISO_RE.test(x.from) || !ISO_RE.test(x.to)) return `Experience ${n}: enter the from and to dates.`;
    if (x.to < x.from) return `Experience ${n}: the end date is before the start date.`;
    if (x.to.slice(0, 7) > today.slice(0, 7)) return `Experience ${n}: the end date is in the future.`;
  }
  return null;
}

/** Save the employee-editable background fields on your own directory record. */
export function saveOwnBackground(actor: Pick<Actor, "id" | "fullName">, input: OwnBackgroundInput): ProfileResultAsync {
  if (API_ENABLED) {
    const error = validateBackground(input, localToday());
    if (error) return error;
    return apiUpdateOwnProfile({
      preferred_name: input.preferredName,
      preferred_language: input.preferredLanguage,
      languages: input.spokenLanguages,
      education: input.education.map((e) => ({ degree: e.degree.trim(), institution: e.institution.trim(), year: Number(e.year) })),
      experience: input.experience.map((x) => ({ employer: x.employer.trim(), title: x.title.trim(), from: x.from, to: x.to })),
      career_goals: input.careerGoals,
    });
  }
  const person = getPerson(actor.id);
  if (!person) return "Your directory record was not found.";
  const today = localToday();
  const clean: OwnBackgroundInput = {
    preferredName: input.preferredName.trim(),
    preferredLanguage: input.preferredLanguage.trim(),
    spokenLanguages: [...new Set(input.spokenLanguages.map((l) => l.trim()).filter(Boolean))],
    education: input.education.map((e) => ({ degree: e.degree.trim(), institution: e.institution.trim(), year: Number(e.year) })),
    experience: input.experience.map((x) => ({ employer: x.employer.trim(), title: x.title.trim(), from: x.from, to: x.to })),
    careerGoals: input.careerGoals.trim(),
  };
  const error = validateBackground(clean, today);
  if (error) return error;
  if (clean.preferredLanguage && !clean.spokenLanguages.includes(clean.preferredLanguage)) {
    clean.spokenLanguages = [clean.preferredLanguage, ...clean.spokenLanguages];
  }
  const next: LocalPersonRecord = {
    ...(person as LocalPersonRecord),
    preferredName: clean.preferredName || person.firstName || person.fullName.split(" ")[0],
    preferredLanguage: clean.preferredLanguage,
    spokenLanguages: clean.spokenLanguages,
    education: [...clean.education].sort((a, b) => b.year - a.year),
    experience: [...clean.experience].sort((a, b) => b.from.localeCompare(a.from)),
    careerGoals: clean.careerGoals,
  };
  const labels: [keyof OwnBackgroundInput, string][] = [
    ["preferredName", "Preferred name"],
    ["preferredLanguage", "Preferred language"],
    ["spokenLanguages", "Languages"],
    ["education", "Education"],
    ["experience", "Previous experience"],
    ["careerGoals", "Career goals"],
  ];
  const changes = labels
    .filter(([key]) => JSON.stringify(next[key] ?? "") !== JSON.stringify(person[key] ?? ""))
    .map(([key, field]) => ({ field, before: show(person[key]), after: show(next[key]) }));
  if (!changes.length) return null;
  upsertPerson(next);
  // The profile card and 360 view read the preferred name from the personal details store too.
  const extras = profileExtrasFor(actor.id);
  if (extras.preferredName !== clean.preferredName) saveProfileExtras(actor.id, { ...extras, preferredName: clean.preferredName });
  appendAuditEntries([
    {
      at: new Date().toISOString(),
      actorId: actor.id,
      actorName: actor.fullName,
      entity: "Employee profile",
      entityId: person.id,
      subjectId: person.id,
      action: "Updated",
      changes,
    },
  ]);
  return null;
}

/* ───────────── Correction requests ───────────── */

export type CorrectionField =
  | "fullName"
  | "middleName"
  | "dateOfBirth"
  | "nationality"
  | "designation"
  | "department"
  | "managerId"
  | "workArrangement";

export const CORRECTION_FIELD_LABEL: Record<CorrectionField, string> = {
  fullName: "Legal name",
  middleName: "Middle name",
  dateOfBirth: "Date of birth",
  nationality: "Nationality",
  designation: "Job title",
  department: "Department",
  managerId: "Manager",
  workArrangement: "Work arrangement",
};

export type CorrectionStatus = "Pending" | "Approved" | "Rejected" | "Withdrawn";

export interface ProfileCorrection {
  id: string;
  personId: string;
  personName: string;
  field: CorrectionField;
  currentValue: string;
  requestedValue: string;
  /** For manager corrections: the requested manager's id. */
  requestedId?: string;
  reason: string;
  requestedById: string;
  requestedBy: string;
  requestedOn: string;
  status: CorrectionStatus;
  decidedById?: string;
  decidedBy?: string;
  decidedOn?: string;
  decisionNote?: string;
  /** Approved name corrections: the person's full name after the change (shown in their own header and top bar). */
  appliedName?: string;
  /** Backend mode: the server says this viewer may decide it. */
  canDecide?: boolean;
}

const KEY = "timez.profile.corrections.v1";
const listeners = new Set<() => void>();
let cache: ProfileCorrection[] | null = null;

/* ───────────── Backend mode: requests live on the server ───────────── */

const TO_API_FIELD: Record<CorrectionField, ApiCorrectionField> = {
  fullName: "full_name",
  middleName: "middle_name",
  dateOfBirth: "date_of_birth",
  nationality: "nationality",
  designation: "job_title",
  department: "department",
  managerId: "manager_id",
  workArrangement: "work_arrangement",
};
const FROM_API_FIELD = Object.fromEntries(Object.entries(TO_API_FIELD).map(([k, v]) => [v, k])) as Record<ApiCorrectionField, CorrectionField>;
const API_STATUS: Record<ProfileCorrectionOut["status"], CorrectionStatus> = {
  pending: "Pending",
  approved: "Approved",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
};

let apiRows: ProfileCorrection[] = [];

function fromApi(r: ProfileCorrectionOut): ProfileCorrection {
  const field = FROM_API_FIELD[r.field] ?? "nationality";
  const requester = getPerson(r.requested_by);
  const decider = r.decided_by ? getPerson(r.decided_by) : undefined;
  return {
    id: r.id,
    personId: r.employee_id,
    personName: r.employee_name ?? r.employee_id,
    field,
    currentValue: r.current_value ?? "",
    requestedValue: field === "managerId" ? (r.requested_label ?? r.requested_value ?? "") : (r.requested_value ?? ""),
    requestedId: field === "managerId" ? (r.requested_value ?? undefined) : undefined,
    reason: r.reason,
    requestedById: r.requested_by,
    requestedBy: requester?.fullName ?? r.requested_by,
    requestedOn: r.created_at.slice(0, 10),
    status: API_STATUS[r.status] ?? "Pending",
    decidedById: r.decided_by ?? undefined,
    decidedBy: decider?.fullName ?? r.decided_by ?? undefined,
    decidedOn: r.decided_at ? r.decided_at.slice(0, 10) : undefined,
    decisionNote: r.decision_note ?? undefined,
    canDecide: r.can_decide,
  };
}

/** Reload requests from the server (backend mode). */
export async function refreshApiCorrections(): Promise<void> {
  if (!API_ENABLED) return;
  try {
    apiRows = (await apiListCorrections()).map(fromApi);
  } catch {
    return; // keep what is shown
  }
  listeners.forEach((fn) => fn());
}

if (API_ENABLED) {
  onApiSession((account) => {
    if (account) void refreshApiCorrections();
    else {
      apiRows = [];
      listeners.forEach((fn) => fn());
    }
  });
}

async function afterApi(result: Promise<ProfileResult>): Promise<ProfileResult> {
  const error = await result;
  if (!error) await refreshApiCorrections();
  return error;
}

function read(): ProfileCorrection[] {
  if (API_ENABLED) return apiRows;
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    cache = Array.isArray(parsed) ? (parsed as ProfileCorrection[]).filter((c) => c && typeof c.id === "string") : [];
  } catch {
    cache = [];
  }
  return cache;
}

function write(list: ProfileCorrection[]): ProfileResult {
  cache = list;
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    return "Could not save. Please try again.";
  } finally {
    listeners.forEach((fn) => fn());
  }
  return null;
}

export function subscribeCorrections(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Stable snapshot, newest first. */
export function getCorrections(): ProfileCorrection[] {
  return read();
}

export function useProfileCorrections(): ProfileCorrection[] {
  return useSyncExternalStore(subscribeCorrections, getCorrections, getCorrections);
}

/** The person's name from their latest approved name correction, if any. */
export function approvedNameFor(personId: string, list: ProfileCorrection[] = read()): string | undefined {
  let best: ProfileCorrection | undefined;
  for (const c of list) {
    if (c.personId !== personId || c.status !== "Approved" || !c.appliedName) continue;
    // Newest first: an older row only wins with a later decision date.
    if (!best || (c.decidedOn ?? "") > (best.decidedOn ?? "")) best = c;
  }
  return best?.appliedName;
}

/** The value shown today for an HR-owned field. */
export function currentFieldValue(person: PersonRecord, field: CorrectionField): string {
  switch (field) {
    case "managerId":
      return person.managerName || "No manager";
    case "workArrangement":
      return person.workArrangement ?? "";
    default:
      return String(person[field] ?? "");
  }
}

export function canDecideCorrection(actor: Pick<Actor, "id" | "role">, row: ProfileCorrection): boolean {
  if (API_ENABLED) return row.status === "Pending" && Boolean(row.canDecide);
  return row.status === "Pending" && canManagePeople(actor.role) && actor.id !== row.personId;
}

/** HR sign-ins who receive correction requests. */
function hrRecipients(excludeId: string): string[] {
  return DEMO_ACCOUNTS.filter((a) => canManagePeople(a.role) && a.id !== excludeId).map((a) => a.id);
}

function audit(actor: Pick<Actor, "id" | "fullName">, row: ProfileCorrection, kind: "Created" | "Updated", changes: { field: string; before: string; after: string }[]) {
  appendAuditEntries([
    {
      at: new Date().toISOString(),
      actorId: actor.id,
      actorName: actor.fullName,
      entity: "Profile correction",
      entityId: row.id,
      subjectId: row.personId,
      action: kind,
      changes,
    },
  ]);
}

function validateRequested(person: PersonRecord, field: CorrectionField, value: string, requestedId?: string): ProfileResult {
  switch (field) {
    case "fullName":
      if (value.split(/\s+/).filter(Boolean).length < 2) return "Enter the full legal name (first and last name).";
      if (value.length > 80) return "Name must be 80 characters or fewer.";
      return null;
    case "dateOfBirth": {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return "Enter a valid date of birth.";
      const years = Number(localToday().slice(0, 4)) - Number(value.slice(0, 4));
      if (years < 15 || years > 90) return "Enter a valid date of birth.";
      return null;
    }
    case "workArrangement":
      return WORK_ARRANGEMENTS.includes(value as WorkArrangement) ? null : "Choose Office, Hybrid or Remote.";
    case "managerId": {
      if (!requestedId) return "Choose the correct manager.";
      const manager = getPerson(requestedId);
      if (!manager || manager.employmentStatus === "Terminated") return "Choose an active manager.";
      if (wouldCreateLoop(person.id, manager.id)) return "That manager reports to this person.";
      return null;
    }
    default:
      return value.length > 80 ? "Keep the value to 80 characters or fewer." : null;
  }
}

/** Raise a correction for an HR-owned field on your own record. HR is notified. */
export function requestProfileCorrection(
  actor: Pick<Actor, "id" | "fullName">,
  input: { field: CorrectionField; requestedValue: string; requestedId?: string; reason: string },
): ProfileResultAsync {
  const person = getPerson(actor.id);
  if (!person) return "Your directory record was not found.";
  if (!CORRECTION_FIELD_LABEL[input.field]) return "Choose a field.";
  const requestedValue = input.requestedValue.trim();
  const reason = input.reason.trim();
  if (input.field !== "middleName" && !requestedValue) return "Enter the correct value.";
  if (!reason) return "Give a reason.";
  if (reason.length > 300) return "Reason must be 300 characters or fewer.";
  const current = currentFieldValue(person, input.field);
  if (input.field === "managerId" ? input.requestedId === person.managerId : requestedValue === current) {
    return "That is already the value on your record.";
  }
  const invalid = validateRequested(person, input.field, requestedValue, input.requestedId);
  if (invalid) return invalid;
  if (API_ENABLED) {
    return afterApi(
      apiRequestCorrection(person.id, {
        field: TO_API_FIELD[input.field],
        requested_value: input.field === "managerId" ? (input.requestedId ?? "") : requestedValue,
        reason,
      }),
    );
  }
  if (read().some((c) => c.personId === person.id && c.field === input.field && c.status === "Pending")) {
    return `You already have an open ${CORRECTION_FIELD_LABEL[input.field].toLowerCase()} correction.`;
  }
  const row: ProfileCorrection = {
    id: `pcr-${Date.now().toString(36)}`,
    personId: person.id,
    personName: person.fullName,
    field: input.field,
    currentValue: current,
    requestedValue,
    requestedId: input.field === "managerId" ? input.requestedId : undefined,
    reason,
    requestedById: actor.id,
    requestedBy: actor.fullName,
    requestedOn: localToday(),
    status: "Pending",
  };
  const error = write([row, ...read()]);
  if (error) return error;
  const label = CORRECTION_FIELD_LABEL[row.field];
  audit(actor, row, "Created", [{ field: label, before: row.currentValue || "—", after: row.requestedValue || "—" }]);
  for (const recipientId of hrRecipients(person.id)) {
    pushPersonTaskAlert({
      recipientId,
      title: "Profile correction to review",
      body: `${person.fullName} asked to change ${label.toLowerCase()} to "${row.requestedValue || "blank"}".`,
      href: `/people/${person.id}`,
    });
  }
  return null;
}

/** Build the directory record with an approved correction applied. */
function applyCorrection(person: PersonRecord, row: ProfileCorrection): LocalPersonRecord | string {
  const next: LocalPersonRecord = { ...(person as LocalPersonRecord) };
  const value = row.requestedValue;
  switch (row.field) {
    case "fullName": {
      const parts = splitName(value);
      next.fullName = value;
      next.firstName = parts.firstName;
      next.middleName = parts.middleName;
      next.lastName = parts.lastName;
      break;
    }
    case "middleName":
      next.middleName = value || undefined;
      next.fullName = joinName(person.firstName ?? splitName(person.fullName).firstName, value || undefined, person.lastName ?? splitName(person.fullName).lastName);
      break;
    case "department":
      next.department = value;
      next.division = divisionForDepartment(value);
      next.jobFamily = familyForDepartment(value);
      break;
    case "managerId": {
      const manager = row.requestedId ? getPerson(row.requestedId) : undefined;
      if (!manager || manager.employmentStatus === "Terminated") return "The requested manager is no longer active.";
      if (wouldCreateLoop(person.id, manager.id)) return "That manager reports to this person.";
      next.managerId = manager.id;
      next.managerName = manager.fullName;
      break;
    }
    case "workArrangement":
      next.workArrangement = value as WorkArrangement;
      break;
    default:
      (next as unknown as Record<string, string>)[row.field] = value;
  }
  return next;
}

export function decideProfileCorrection(actor: Actor, id: string, decision: "approve" | "reject", note: string): ProfileResultAsync {
  if (API_ENABLED) {
    if (decision === "reject" && !note.trim()) return "Add a note explaining the rejection.";
    return afterApi(apiDecideCorrection(id, decision, note));
  }
  const list = read();
  const row = list.find((c) => c.id === id);
  if (!row) return "Request not found.";
  if (row.status !== "Pending") return "This request is no longer open.";
  if (!canDecideCorrection(actor, row)) return actor.id === row.personId ? "You cannot decide your own request." : "Only HR can decide this request.";
  const trimmed = note.trim();
  if (decision === "reject" && !trimmed) return "Add a note explaining the rejection.";
  if (trimmed.length > 300) return "Note must be 300 characters or fewer.";
  const today = localToday();
  const label = CORRECTION_FIELD_LABEL[row.field];
  let appliedName: string | undefined;
  if (decision === "approve") {
    const person = getPerson(row.personId);
    if (!person) return "This person is not in the directory.";
    const next = applyCorrection(person, row);
    if (typeof next === "string") return next;
    upsertPerson(next);
    if (row.field === "fullName" || row.field === "middleName") appliedName = next.fullName;
    appendAuditEntries([
      {
        at: new Date().toISOString(),
        actorId: actor.id,
        actorName: actor.fullName,
        entity: "Employee profile",
        entityId: person.id,
        subjectId: person.id,
        action: "Updated",
        changes: [{ field: label, before: currentFieldValue(person, row.field) || "—", after: currentFieldValue(next, row.field) || "—" }],
      },
    ]);
  }
  const decided: ProfileCorrection = {
    ...row,
    status: decision === "approve" ? "Approved" : "Rejected",
    decidedById: actor.id,
    decidedBy: actor.fullName,
    decidedOn: today,
    decisionNote: trimmed || undefined,
    ...(appliedName ? { appliedName } : {}),
  };
  const error = write(list.map((c) => (c.id === id ? decided : c)));
  if (error) return error;
  audit(actor, decided, "Updated", [
    { field: "status", before: "Pending", after: decided.status },
    ...(trimmed ? [{ field: "note", before: "—", after: trimmed }] : []),
  ]);
  pushPersonTaskAlert({
    recipientId: row.requestedById,
    title: `Profile correction ${decision === "approve" ? "approved" : "rejected"}`,
    body:
      decision === "approve"
        ? `Your ${label.toLowerCase()} is now "${row.requestedValue || "blank"}".`
        : `${actor.fullName} rejected your ${label.toLowerCase()} correction. ${trimmed}`.trim(),
    href: "/info",
  });
  return null;
}

export function withdrawProfileCorrection(actor: Pick<Actor, "id" | "fullName">, id: string): ProfileResultAsync {
  if (API_ENABLED) return afterApi(apiWithdrawCorrection(id));
  const list = read();
  const row = list.find((c) => c.id === id);
  if (!row) return "Request not found.";
  if (row.status !== "Pending") return "Only open requests can be withdrawn.";
  if (row.requestedById !== actor.id) return "Only the person who asked can withdraw it.";
  const next: ProfileCorrection = { ...row, status: "Withdrawn", decidedOn: localToday() };
  const error = write(list.map((c) => (c.id === id ? next : c)));
  if (error) return error;
  audit(actor, next, "Updated", [{ field: "status", before: "Pending", after: "Withdrawn" }]);
  return null;
}
