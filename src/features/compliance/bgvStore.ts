import { todayISO, type UserRole } from "../../model.ts";
import { listPeople } from "../../data/peopleLocal.ts";
import { getTalentState } from "../../data/talentLocal.ts";
import {
  createLocalStore,
  isHr,
  isISODate,
  newId,
  nowStamp,
  relDay,
  sameName,
  type ComplianceActor,
  type ComplianceResult,
} from "./shared.ts";

export const CHECK_TYPES = ["Identity", "Education", "Previous employment", "Criminal record", "Address", "Reference"] as const;
export type CheckType = (typeof CHECK_TYPES)[number];
export const CHECK_STATUSES = ["Not started", "In progress", "Clear", "Discrepancy", "Unable to verify"] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];
export type OverallResult = "Awaiting consent" | "Not started" | "In progress" | "Clear" | "Needs review" | "Incomplete";

export const BGV_VENDORS = ["SecureCheck", "AuthBridge", "First Advantage", "HireRight", "Sterling"] as const;

export type BgvCheck = {
  type: CheckType;
  status: CheckStatus;
  vendor: string;
  initiatedOn?: string;
  completedOn?: string;
  remarks: string;
};

export type BgvRecord = {
  id: string;
  subjectKind: "joiner" | "employee";
  /** Joiner id (talent state) or person id. */
  subjectId: string;
  subjectName: string;
  role: string;
  consent?: { givenOn: string; recordedById: string; at: string };
  checks: BgvCheck[];
  createdOn: string;
};

type BgvState = { records: BgvRecord[] };

const DONE: CheckStatus[] = ["Clear", "Discrepancy", "Unable to verify"];

function blankChecks(): BgvCheck[] {
  return CHECK_TYPES.map((type) => ({ type, status: "Not started", vendor: "", remarks: "" }));
}

function check(type: CheckType, status: CheckStatus, vendor: string, initiatedOn?: string, completedOn?: string, remarks = ""): BgvCheck {
  return { type, status, vendor, initiatedOn, completedOn, remarks };
}

function defaults(): BgvState {
  return {
    records: [
      {
        id: "bgv-ob-1",
        subjectKind: "joiner",
        subjectId: "ob-1",
        subjectName: "Riya Kapoor",
        role: "Senior React Engineer",
        consent: { givenOn: "2026-09-08", recordedById: "ob-1", at: "2026-09-08T10:00:00.000Z" },
        createdOn: "2026-09-08",
        checks: [
          check("Identity", "Clear", "AuthBridge", "2026-09-09", "2026-09-11"),
          check("Education", "Clear", "AuthBridge", "2026-09-09", "2026-09-19"),
          check("Previous employment", "Clear", "AuthBridge", "2026-09-09", "2026-09-22"),
          check("Criminal record", "Clear", "AuthBridge", "2026-09-09", "2026-09-24"),
          check("Address", "Clear", "AuthBridge", "2026-09-09", "2026-09-18"),
          check("Reference", "Clear", "AuthBridge", "2026-09-10", "2026-09-15"),
        ],
      },
      {
        id: "bgv-ob-2",
        subjectKind: "joiner",
        subjectId: "ob-2",
        subjectName: "Noah Garcia",
        role: "Designer",
        consent: { givenOn: "2026-09-20", recordedById: "ob-2", at: "2026-09-20T15:30:00.000Z" },
        createdOn: "2026-09-20",
        checks: [
          check("Identity", "Clear", "HireRight", "2026-09-21", "2026-09-23"),
          check("Education", "Discrepancy", "HireRight", "2026-09-21", "2026-10-02", "Graduation year on CV is 2019; registrar confirms 2020."),
          check("Previous employment", "In progress", "HireRight", "2026-09-21"),
          check("Criminal record", "In progress", "HireRight", "2026-09-21"),
          check("Address", "Clear", "HireRight", "2026-09-21", "2026-09-30"),
          check("Reference", "Not started", ""),
        ],
      },
      {
        id: "bgv-ob-3",
        subjectKind: "joiner",
        subjectId: "ob-3",
        subjectName: "Amira Hassan",
        role: "Customer Success Associate",
        createdOn: relDay(-3),
        checks: blankChecks(),
      },
      {
        id: "bgv-emp-mahesh",
        subjectKind: "employee",
        subjectId: "emp-mahesh",
        subjectName: "Babu Menon",
        role: "Software Engineer",
        consent: { givenOn: "2026-08-01", recordedById: "emp-mahesh", at: "2026-08-01T09:00:00.000Z" },
        createdOn: "2026-08-01",
        checks: [
          check("Identity", "Clear", "SecureCheck", "2026-08-02", "2026-08-04"),
          check("Criminal record", "In progress", "SecureCheck", "2026-08-02"),
          check("Address", "Clear", "SecureCheck", "2026-08-02", "2026-08-10"),
          ...(["Education", "Previous employment", "Reference"] as CheckType[]).map((t) => check(t, "Not started", "")),
        ],
      },
    ],
  };
}

const store = createLocalStore<BgvState>("kastech.bgv.v1", defaults);

export const subscribeBgv = store.subscribe;
export const getBgvState = store.getState;
export const resetBgv = store.reset;
export const BGV_KEY = store.key;

/* ───────────── Derived ───────────── */

export function overallResult(record: BgvRecord): OverallResult {
  const checks = record.checks;
  if (!record.consent) return "Awaiting consent";
  if (checks.some((c) => c.status === "Discrepancy")) return "Needs review";
  if (checks.length > 0 && checks.every((c) => c.status === "Clear")) return "Clear";
  if (checks.every((c) => c.status === "Not started")) return "Not started";
  if (checks.every((c) => DONE.includes(c.status))) return "Incomplete";
  return "In progress";
}

/* ───────────── Permissions ───────────── */

export function canManageBgv(role: UserRole): boolean {
  return isHr(role) || role === "recruiter";
}

export function canReadAllBgv(role: UserRole): boolean {
  return canManageBgv(role) || role === "hiring_manager";
}

/** Hiring managers only see the outcome, never the individual checks. */
export function seesOutcomeOnly(role: UserRole): boolean {
  return role === "hiring_manager";
}

/** The outcome a hiring manager sees: Clear, Not clear, or Pending while checks are still running. */
export function outcomeLabel(record: BgvRecord): "Clear" | "Not clear" | "Pending" {
  const overall = overallResult(record);
  if (overall === "Clear") return "Clear";
  if (overall === "Needs review" || overall === "Incomplete") return "Not clear";
  return "Pending";
}

/** The person the record is about (employee by id; joiner by name, as joiners have no account yet). */
export function isSubject(actor: ComplianceActor, record: BgvRecord): boolean {
  return record.subjectKind === "employee" ? record.subjectId === actor.id : sameName(record.subjectName, actor.fullName);
}

/** Managers of the process — never on their own record. */
export function canEditRecord(actor: ComplianceActor, record: BgvRecord): boolean {
  return canManageBgv(actor.role) && !isSubject(actor, record);
}

/* ───────────── Mutations ───────────── */

export function startVerification(actor: ComplianceActor, kind: "joiner" | "employee", subjectId: string): ComplianceResult {
  return store.guarded((s) => {
    if (!canManageBgv(actor.role)) return "Only HR and recruiters can start verification.";
    if (s.records.some((r) => r.subjectKind === kind && r.subjectId === subjectId)) return "A verification already exists for this person.";
    let name = "";
    let role = "";
    if (kind === "joiner") {
      const joiner = getTalentState().joiners.find((j) => j.id === subjectId);
      if (!joiner) return "Joiner not found.";
      name = joiner.name;
      role = joiner.role;
    } else {
      const person = listPeople().find((p) => p.id === subjectId);
      if (!person) return "Choose an employee from the list.";
      if (person.id === actor.id) return "You cannot run your own verification.";
      name = person.fullName;
      role = person.designation;
    }
    if (sameName(name, actor.fullName)) return "You cannot run your own verification.";
    s.records.unshift({ id: newId("bgv"), subjectKind: kind, subjectId, subjectName: name, role, checks: blankChecks(), createdOn: todayISO() });
    return null;
  });
}

export function recordConsent(actor: ComplianceActor, id: string, givenOn: string): ComplianceResult {
  return store.guarded((s) => {
    const row = s.records.find((r) => r.id === id);
    if (!row) return "Verification not found.";
    if (!isSubject(actor, row)) return "Only the person being verified can give consent.";
    if (row.consent) return "Consent is already on record.";
    if (!isISODate(givenOn)) return "Enter the date consent was given.";
    if (givenOn > todayISO()) return "Consent date cannot be in the future.";
    row.consent = { givenOn, recordedById: actor.id, at: nowStamp() };
    return null;
  });
}

export type CheckPatch = { status: CheckStatus; vendor: string; initiatedOn: string; completedOn: string; remarks: string };

export function updateCheck(actor: ComplianceActor, id: string, type: CheckType, patch: CheckPatch): ComplianceResult {
  return store.guarded((s) => {
    const row = s.records.find((r) => r.id === id);
    if (!row) return "Verification not found.";
    if (!canEditRecord(actor, row)) return isSubject(actor, row) ? "You cannot update your own verification." : "Only HR and recruiters can update checks.";
    const item = row.checks.find((c) => c.type === type);
    if (!item) return "Check not found.";
    const today = todayISO();
    const vendor = patch.vendor.trim();
    const remarks = patch.remarks.trim();
    if (patch.status === "Not started") {
      if (item.status !== "Not started") return "A check that has started cannot go back to Not started.";
      item.vendor = vendor;
      item.remarks = remarks;
      return null;
    }
    if (!row.consent) return "Record the candidate's consent before initiating checks.";
    if (!vendor) return "Choose the verification vendor.";
    if (!isISODate(patch.initiatedOn)) return "Enter the initiated date.";
    if (patch.initiatedOn > today) return "Initiated date cannot be in the future.";
    if (patch.initiatedOn < row.consent.givenOn) return "Checks cannot start before consent was given.";
    const done = DONE.includes(patch.status);
    if (done) {
      if (!isISODate(patch.completedOn)) return "Enter the completed date.";
      if (patch.completedOn > today) return "Completed date cannot be in the future.";
      if (patch.completedOn < patch.initiatedOn) return "Completed date cannot be before the initiated date.";
      if (patch.status !== "Clear" && remarks.length < 5) return `Add remarks explaining the ${patch.status.toLowerCase()} result.`;
    }
    Object.assign(item, {
      status: patch.status,
      vendor,
      initiatedOn: patch.initiatedOn,
      completedOn: done ? patch.completedOn : undefined,
      remarks,
    } satisfies Partial<BgvCheck>);
    return null;
  });
}

export function removeVerification(actor: ComplianceActor, id: string): ComplianceResult {
  return store.guarded((s) => {
    const row = s.records.find((r) => r.id === id);
    if (!row) return "Verification not found.";
    if (!canEditRecord(actor, row) || !isHr(actor.role)) return "Only HR can remove a verification.";
    if (row.checks.some((c) => c.status !== "Not started")) return "Verifications with started checks cannot be removed.";
    s.records = s.records.filter((r) => r.id !== id);
    return null;
  });
}

/** Overall status only — what the subject is allowed to see. */
export function bgvSummaryForPerson(actor: ComplianceActor) {
  return getBgvState()
    .records.filter((r) => isSubject(actor, r))
    .map((r) => ({ startedOn: r.createdOn, consentGivenOn: r.consent?.givenOn, overall: overallResult(r) }));
}
