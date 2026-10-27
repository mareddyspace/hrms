/**
 * Letter workflow (blueprint §24 / §39): request → type → approved employee data → template →
 * validate → approval → final document → stored with id + version → visible in the employee's documents.
 */
import { DEMO_ACCOUNTS, managementChain, type DemoAccount } from "../demoAccounts.ts";
import { getExitState } from "../features/lifecycle/exitStore.ts";
import { todayISO } from "../model.ts";
import {
  entityFor,
  letterDate,
  letterDocumentHtml,
  localeFor,
  missingFields,
  referenceNumber,
  renderLetterBody,
  type LetterFields,
} from "./letterTemplates.ts";
import { getPerson, type LocalPersonRecord } from "./peopleLocal.ts";
import { canManageLetters } from "./rbac.ts";
import { letterTemplate, type CompHistoryRow, type IssuedLetter, type LetterRequest, type LetterType } from "./rewardData.ts";
import { addLetterRequest, canApproveLetter, updateReward, type RewardResult } from "./rewardLocal.ts";

const isoInText = (text: string) => text.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? "";

/** Last working day from the exit record (accepted or completed), else the directory exit date. */
export function lastWorkingDayFor(employeeId: string): string {
  const exit = getExitState()
    .cases.filter((c) => c.employeeId === employeeId && (c.status === "Accepted" || c.status === "Completed"))
    .sort((a, b) => b.lastWorkingDay.localeCompare(a.lastWorkingDay))[0];
  if (exit) return exit.lastWorkingDay;
  return (getPerson(employeeId) as LocalPersonRecord | undefined)?.exitDate ?? "";
}

/** Employees can request an experience letter once they have left (or their last day has passed). */
export function hasExited(employeeId: string, today = todayISO()): boolean {
  const person = getPerson(employeeId);
  if (person?.employmentStatus === "Terminated") return true;
  return getExitState().cases.some(
    (c) => c.employeeId === employeeId && (c.status === "Completed" || (c.status === "Accepted" && c.lastWorkingDay <= today)),
  );
}

/** Merge fields from the directory, exit store and (pay letters only) compensation history. */
export function collectLetterFields(row: LetterRequest, history: CompHistoryRow[]): LetterFields {
  const person = getPerson(row.employeeId);
  const account = DEMO_ACCOUNTS.find((a) => a.id === row.employeeId);
  const countryCode = String(person?.countryCode ?? account?.countryCode ?? "");
  const template = letterTemplate(row.type);

  let salary = "";
  let previousSalary = "";
  let compEffective = "";
  let compGrade = "";
  if (template.payLetter) {
    const rows = history.filter((h) => h.employeeId === row.employeeId).sort((a, b) => b.effective.localeCompare(a.effective));
    // Offer / appointment use the starting salary; promotion / revision use the latest approved one.
    const pick = row.type === "Offer" || row.type === "Appointment" ? rows[rows.length - 1] : rows[0];
    if (pick) {
      salary = pick.base;
      compEffective = pick.effective;
      compGrade = pick.grade;
      if (row.type === "Salary revision") previousSalary = rows[1]?.base ?? "";
    }
  }

  const effectiveDate =
    row.effectiveDate ||
    (row.type === "Promotion" || row.type === "Salary revision" ? compEffective : "") ||
    (row.type === "Confirmation" ? isoInText(row.note) : "");

  return {
    employeeName: person?.fullName ?? account?.fullName ?? row.employeeName,
    employeeCode: person?.employeeCode ?? account?.employeeCode ?? "",
    title: person?.designation ?? account?.designation ?? "",
    department: person?.department ?? account?.department ?? "",
    grade: (row.type === "Promotion" && compGrade) || person?.grade || compGrade || "",
    joiningDate: person?.dateOfJoining ?? "",
    lastWorkingDay: lastWorkingDayFor(row.employeeId),
    manager: person?.managerName || managementChain(row.employeeId)[0]?.fullName || "",
    countryCode,
    countryName: person?.countryName ?? account?.countryName ?? "",
    legalEntity: countryCode ? entityFor(countryCode) : "",
    address: person?.address ?? account?.address ?? "",
    salary,
    previousSalary,
    effectiveDate,
    details: row.details ?? "",
  };
}

export type LetterPreview = { fields: LetterFields; missing: string[]; html: string };

/** Draft preview with a DRAFT watermark. */
export function previewLetter(row: LetterRequest, history: CompHistoryRow[]): LetterPreview {
  const fields = collectLetterFields(row, history);
  const today = todayISO();
  const body = renderLetterBody(fields, { type: row.type, date: today, referenceNo: "DRAFT" });
  return {
    fields,
    missing: missingFields(row.type, fields),
    html: letterDocumentHtml(body, { title: `${letterTemplate(row.type).label} (draft)`, draft: true, lang: localeFor(fields.countryCode) }),
  };
}

export function currentIssue(row: LetterRequest, version?: number): IssuedLetter | undefined {
  const list = row.issued ?? [];
  return version ? list.find((i) => i.version === version) : list[list.length - 1];
}

/** The stored final letter as a print-ready document (no watermark). */
export function issuedLetterHtml(row: LetterRequest, issue: IssuedLetter): string {
  return letterDocumentHtml(issue.html, { title: `${letterTemplate(row.type).label} ${issue.referenceNo}`, draft: false });
}

/* ───────────── Workflow ───────────── */

/** Types this person may request for themselves. HR may issue any type for anyone. */
export function canRequestType(actor: DemoAccount, type: LetterType, employeeId: string): string | null {
  if (canManageLetters(actor)) return null;
  if (employeeId !== actor.id) return "You can only request letters for yourself.";
  const template = letterTemplate(type);
  if (!template.employeeCanRequest) return `${template.label}s are issued by HR.`;
  if (type === "Experience" && !hasExited(actor.id)) return "An experience letter is available after your exit.";
  return null;
}

export function requestLetter(
  actor: DemoAccount,
  input: { employeeId: string; type: LetterType; note: string; details?: string; effectiveDate?: string },
): RewardResult {
  const blocked = canRequestType(actor, input.type, input.employeeId);
  if (blocked) return blocked;
  const template = letterTemplate(input.type);
  if (template.detailsLabel && !input.details?.trim()) return `Enter ${template.detailsLabel.toLowerCase()}.`;
  const person = getPerson(input.employeeId);
  const name = person?.fullName ?? DEMO_ACCOUNTS.find((a) => a.id === input.employeeId)?.fullName;
  if (!name) return "Employee not found.";
  return addLetterRequest(actor, {
    employeeId: input.employeeId,
    employeeName: name,
    type: input.type,
    note: input.note.trim() || "No reason given",
    details: input.details?.trim().slice(0, 200),
    effectiveDate: canManageLetters(actor) ? input.effectiveDate : undefined,
  });
}

/** HR (or the requester, for their own details) fills missing inputs before approval. */
export function updateLetterInputs(actor: DemoAccount, id: string, input: { details?: string; effectiveDate?: string }): RewardResult {
  return updateReward((s) => {
    const row = s.letters.find((l) => l.id === id);
    if (!row) return "Letter request not found.";
    if (row.status !== "Pending approval" && row.status !== "Draft") return "Only open requests can be edited.";
    const hr = canManageLetters(actor) && actor.id !== row.employeeId;
    const requester = row.requestedById === actor.id;
    if (!hr && !requester) return "Only HR or the requester can edit this request.";
    if (input.details !== undefined) row.details = input.details.trim().slice(0, 200) || undefined;
    if (input.effectiveDate !== undefined) {
      if (!hr) return "Only HR sets the effective date.";
      row.effectiveDate = input.effectiveDate || undefined;
    }
  });
}

function generate(actor: DemoAccount, row: LetterRequest, s: { letters: LetterRequest[]; history: CompHistoryRow[] }) {
  const fields = collectLetterFields(row, s.history);
  const missing = missingFields(row.type, fields);
  if (missing.length) return { error: `Cannot generate — missing: ${missing.join(", ")}.` } as const;
  const today = todayISO();
  const serial = s.letters.reduce((n, l) => n + (l.issued?.length ?? 0), 0) + 1;
  const version = (row.issued?.length ?? 0) + 1;
  const docId = `DOC-${today.replace(/-/g, "")}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const referenceNo = referenceNumber(row.type, fields.countryCode, serial, today);
  const html = renderLetterBody(fields, {
    type: row.type,
    date: today,
    referenceNo,
    approval: { by: actor.fullName, on: today },
    docId,
    version,
  });
  const issue: IssuedLetter = { docId, version, referenceNo, generatedOn: today, generatedBy: actor.fullName, approvedBy: actor.fullName, approvedOn: today, html };
  return { issue, fields } as const;
}

function storeIssue(
  s: Parameters<Parameters<typeof updateReward>[0]>[0],
  row: LetterRequest,
  issue: IssuedLetter,
  fields: LetterFields,
) {
  row.issued = [...(row.issued ?? []), issue];
  const label = letterTemplate(row.type).label;
  s.library.unshift({
    id: `dl-${issue.docId}`,
    employeeId: row.employeeId,
    employeeName: row.employeeName,
    name: `${label} v${issue.version}`,
    category: "Letters",
    docType: "Letter",
    uploadedBy: issue.generatedBy,
    uploadedAt: new Date().toISOString(),
    sizeLabel: "PDF (A4)",
    preview: `${label} for ${fields.employeeName}\nRef ${issue.referenceNo} · ${issue.docId} · v${issue.version}\nApproved by ${issue.approvedBy} on ${letterDate(issue.approvedOn, fields.countryCode)}`,
    isDemoFile: false,
    letterId: row.id,
    docId: issue.docId,
  });
}

/** Approve, generate the final letter and store it (v1). */
export function approveLetter(actor: DemoAccount, id: string): RewardResult {
  return updateReward((s) => {
    const row = s.letters.find((l) => l.id === id);
    if (!row) return "Letter request not found.";
    if (row.employeeId === actor.id) return "You cannot approve your own letter.";
    if (row.status !== "Pending approval" && row.status !== "Approved") return `This letter is ${row.status.toLowerCase()}.`;
    if (!canApproveLetter(actor, row)) return "Only HR can approve this letter (or the line manager when the letter is for HR).";
    const result = generate(actor, row, s);
    if ("error" in result) return result.error ?? "Cannot generate.";
    row.status = "Issued";
    row.approver = actor.fullName;
    row.approverId = actor.id;
    row.decidedOn = todayISO();
    storeIssue(s, row, result.issue, result.fields);
  });
}

/** Re-generate an issued letter from current data — a new version, approved by the person regenerating. */
export function regenerateLetter(actor: DemoAccount, id: string): RewardResult {
  return updateReward((s) => {
    const row = s.letters.find((l) => l.id === id);
    if (!row) return "Letter request not found.";
    if (row.status !== "Issued") return "Only issued letters can be regenerated.";
    if (!canApproveLetter(actor, row)) return "Only an approver for this letter can regenerate it.";
    const result = generate(actor, row, s);
    if ("error" in result) return result.error ?? "Cannot generate.";
    storeIssue(s, row, result.issue, result.fields);
  });
}
