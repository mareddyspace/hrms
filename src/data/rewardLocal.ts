import { DEMO_ACCOUNTS, managementChain, type DemoAccount } from "../demoAccounts.ts";
import { todayISO } from "../model.ts";
import { canManagePeople } from "./peoplePermissions.ts";
import { canManageLetters } from "./rbac.ts";
import {
  BENEFIT_ENROLLMENTS,
  BENEFIT_PLANS,
  BONUSES,
  COMP_CYCLES,
  COMP_HISTORY,
  COMP_REVIEWS,
  DOC_LIBRARY_SEED,
  LETTER_REQUESTS,
  SENSITIVE_LETTER_TYPES,
  type BenefitChangeRequest,
  type BenefitEnrollment,
  type BonusRecord,
  type CompHistoryRow,
  type CompReviewItem,
  type DocLibraryItem,
  type LetterRequest,
  type LetterStatus,
  type LetterType,
} from "./rewardData.ts";

// v4: the Compensation persona was retired (HR owns compensation & benefits) — older data is replaced.
const KEY = "timez.reward.state.v4";
const OLD_KEYS = ["timez.reward.state.v1", "timez.reward.state.v2", "timez.reward.state.v3"];

type RewardState = {
  reviews: CompReviewItem[];
  history: CompHistoryRow[];
  bonuses: BonusRecord[];
  enrollments: BenefitEnrollment[];
  changeRequests: BenefitChangeRequest[];
  letters: LetterRequest[];
  library: DocLibraryItem[];
};

/** Mutations return null on success or a user-facing error message. */
export type RewardResult = string | null;

function defaults(): RewardState {
  return {
    reviews: structuredClone(COMP_REVIEWS),
    history: structuredClone(COMP_HISTORY),
    bonuses: structuredClone(BONUSES),
    enrollments: structuredClone(BENEFIT_ENROLLMENTS),
    changeRequests: [],
    letters: structuredClone(LETTER_REQUESTS),
    library: structuredClone(DOC_LIBRARY_SEED),
  };
}

/** Plans everyone in a country is enrolled in automatically (India PF, UK pension). */
function withAutoEnrollments(state: RewardState): RewardState {
  for (const person of DEMO_ACCOUNTS) {
    for (const plan of BENEFIT_PLANS) {
      if (!plan.autoEnrolled || plan.country !== person.countryName) continue;
      if (state.enrollments.some((e) => e.employeeId === person.id && e.planId === plan.id)) continue;
      state.enrollments.push({
        id: `be-auto-${person.id}-${plan.id}`,
        employeeId: person.id,
        employeeName: person.fullName,
        planId: plan.id,
        planName: plan.name,
        country: plan.country,
        status: "Enrolled",
        effective: "2026-01-01",
      });
    }
  }
  return state;
}

function read(): RewardState {
  const base = defaults();
  try {
    OLD_KEYS.forEach((k) => localStorage.removeItem(k));
    const raw = localStorage.getItem(KEY);
    if (!raw) return withAutoEnrollments(base);
    const parsed = JSON.parse(raw) as Partial<RewardState>;
    const list = <K extends keyof RewardState>(key: K): RewardState[K] =>
      (Array.isArray(parsed[key]) ? parsed[key] : base[key]) as RewardState[K];
    return withAutoEnrollments({
      reviews: list("reviews"),
      history: list("history"),
      bonuses: list("bonuses"),
      enrollments: list("enrollments"),
      changeRequests: list("changeRequests"),
      letters: list("letters"),
      library: list("library"),
    });
  } catch {
    return withAutoEnrollments(base);
  }
}

const listeners = new Set<() => void>();
let cache: RewardState | null = null;

function write(state: RewardState): RewardResult {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Usually the storage quota — keep the previous cache so UI and storage agree.
    return "Could not save — storage is full. Remove large uploads and try again.";
  }
  cache = state;
  listeners.forEach((fn) => fn());
  return null;
}

export function subscribeReward(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Stable snapshot for useSyncExternalStore — same reference until data changes. */
export function getRewardState(): RewardState {
  if (!cache) cache = read();
  return cache;
}

/** Mutator returns an error string to abort without writing. */
export function updateReward(mutator: (state: RewardState) => RewardResult | void): RewardResult {
  const state = structuredClone(getRewardState());
  const error = mutator(state);
  if (error) return error;
  return write(state);
}

/* ───────────── Compensation reviews ───────────── */

type Actor = Pick<DemoAccount, "id" | "fullName" | "role">;

function chainIds(employeeId: string): string[] {
  return managementChain(employeeId, DEMO_ACCOUNTS).map((m) => m.id);
}

/** True when `actorId` sits above `employeeId` in the reporting line. */
export function isAboveInLine(actorId: string, employeeId: string): boolean {
  return actorId !== employeeId && chainIds(employeeId).includes(actorId);
}

/** Someone above the employee who isn't the proposer, so the line step can happen at all. */
function hasLineApprover(row: CompReviewItem): boolean {
  return chainIds(row.employeeId).some((id) => id !== row.managerId);
}

/** HR roles that own compensation & benefits decisions. */
const PAY_HR_ROLES = new Set<string>(["hr", "hr_admin"]);

export function isPayHr(actor: Pick<DemoAccount, "role">): boolean {
  return PAY_HR_ROLES.has(actor.role);
}

/**
 * Who decides a pay / benefits item about `subjectId`: any HR sign-in account other than the subject (and other
 * than anyone in `skip`). When HR is the subject (HR's own pay), the subject's line manager decides instead —
 * the nearest person above them who isn't skipped. Never the subject.
 */
export function payDecidersFor(
  subjectId: string,
  isDecider: (a: DemoAccount) => boolean = isPayHr,
  skip: (a: Pick<DemoAccount, "id" | "fullName">) => boolean = () => false,
): { id: string; fullName: string }[] {
  const pool = DEMO_ACCOUNTS.filter((a) => isDecider(a) && a.id !== subjectId && !skip(a));
  if (pool.length) return pool.map((a) => ({ id: a.id, fullName: a.fullName }));
  const manager = managementChain(subjectId, DEMO_ACCOUNTS).find((m) => m.id !== subjectId && !skip(m));
  return manager ? [{ id: manager.id, fullName: manager.fullName }] : [];
}

/** Who may decide the row now: line step = above the employee, never the proposer; final step = HR (or, for HR's own pay, their line manager). */
export function canDecideCompReview(actor: Actor, row: CompReviewItem): boolean {
  if (actor.id === row.employeeId || actor.id === row.managerId) return false;
  if (COMP_CYCLES.find((c) => c.id === row.cycleId)?.status === "Closed") return false;
  if (row.status === "Pending approval") return isAboveInLine(actor.id, row.employeeId);
  if (row.status === "Pending final approval") {
    if (row.lineApprover === actor.fullName) return false;
    return payDecidersFor(row.employeeId, isPayHr, (a) => a.id === row.managerId || a.fullName === row.lineApprover).some(
      (a) => a.id === actor.id,
    );
  }
  return false;
}

/** The proposer sends a draft for approval. */
export function submitCompReview(actor: Actor, id: string): RewardResult {
  return updateReward((s) => {
    const row = s.reviews.find((r) => r.id === id);
    if (!row) return "Proposal not found.";
    if (row.managerId !== actor.id) return "Only the person who proposed this can submit it.";
    if (row.status !== "Draft") return "Only drafts can be submitted.";
    if (COMP_CYCLES.find((c) => c.id === row.cycleId)?.status === "Closed") return "This review cycle is closed.";
    // With no one above the proposer in the line (e.g. the CEO's own reports), it goes straight to HR for the final decision.
    row.status = hasLineApprover(row) ? "Pending approval" : "Pending final approval";
  });
}

export function decideCompReview(actor: Actor, id: string, decision: "Approved" | "Rejected"): RewardResult {
  return updateReward((s) => {
    const row = s.reviews.find((r) => r.id === id);
    if (!row) return "Proposal not found.";
    if (row.employeeId === actor.id) return "You cannot decide your own compensation.";
    if (row.managerId === actor.id) return "You cannot approve your own proposal.";
    if (!canDecideCompReview(actor, row)) {
      return row.status === "Pending final approval"
        ? "HR makes the final decision (for HR's own pay, their line manager)."
        : "Only someone above the employee in their reporting line can approve this.";
    }
    const today = todayISO();
    if (decision === "Rejected") {
      row.status = "Rejected";
      row.approver = actor.fullName;
      row.decidedOn = today;
      return;
    }
    if (row.status === "Pending approval") {
      row.status = "Pending final approval";
      row.lineApprover = actor.fullName;
      row.lineApprovedOn = today;
      return;
    }
    row.status = "Approved";
    row.approver = actor.fullName;
    row.decidedOn = today;
    const cycle = COMP_CYCLES.find((c) => c.id === row.cycleId);
    s.history.unshift({
      id: `ch-${row.id}`,
      employeeId: row.employeeId,
      employeeName: row.employeeName,
      effective: today,
      event: cycle?.name ?? "Compensation review",
      grade: row.proposedGrade,
      base: row.proposedBase,
      currency: row.currency,
      managerId: row.managerId,
    });
    if (row.bonusProposal) {
      s.bonuses.unshift({
        id: `bn-${row.id}`,
        employeeId: row.employeeId,
        employeeName: row.employeeName,
        type: "Annual incentive",
        period: cycle?.name.split(" ")[0] ?? today.slice(0, 4),
        amount: row.bonusProposal,
        currency: row.currency,
        status: "Accrued",
      });
    }
  });
}

/* ───────────── Benefits ───────────── */

export function canAdminBenefits(actor: Pick<DemoAccount, "role">): boolean {
  return canManagePeople(actor.role);
}

/** Who may decide a benefits request for `employeeId`: HR (benefits admins), never the employee; HR's own requests go to their line manager. */
export function canDecideBenefitFor(actor: Pick<DemoAccount, "id" | "role">, employeeId: string): boolean {
  if (actor.id === employeeId) return false;
  return payDecidersFor(employeeId, (a) => canAdminBenefits(a)).some((a) => a.id === actor.id);
}

export function isMandatoryPlan(planId: string): boolean {
  return !!BENEFIT_PLANS.find((p) => p.id === planId)?.mandatory;
}

export function isAutoPlan(planId: string): boolean {
  return !!BENEFIT_PLANS.find((p) => p.id === planId)?.autoEnrolled;
}

/** Employee asks to join a plan in their own country (creates a Pending row). */
export function requestEnrollment(actor: DemoAccount, planId: string): RewardResult {
  const plan = BENEFIT_PLANS.find((p) => p.id === planId);
  if (!plan) return "Plan not found.";
  if (plan.country !== actor.countryName) return "You can only enroll in plans for your own country.";
  if (plan.mandatory) return "You are enrolled in this plan automatically.";
  return updateReward((s) => {
    const existing = s.enrollments.find((e) => e.employeeId === actor.id && e.planId === planId);
    if (existing) {
      if (existing.status === "Pending") return "A request for this plan is already pending.";
      if (existing.status === "Enrolled") return "You are already enrolled in this plan.";
      existing.status = "Pending";
      return;
    }
    s.enrollments.unshift({
      id: `be-local-${Date.now()}`,
      employeeId: actor.id,
      employeeName: actor.fullName,
      planId: plan.id,
      planName: plan.name,
      country: plan.country,
      status: "Pending",
      effective: todayISO(),
    });
  });
}

export function pendingChangeFor(state: Pick<RewardState, "changeRequests">, enrollmentId: string): BenefitChangeRequest | undefined {
  return state.changeRequests.find((c) => c.enrollmentId === enrollmentId && c.status === "Pending");
}

/** Employee asks HR to change an enrolled plan. The enrollment stays active until HR acts. */
export function requestEnrollmentChange(actor: DemoAccount, enrollmentId: string, note: string): RewardResult {
  return updateReward((s) => {
    const row = s.enrollments.find((e) => e.id === enrollmentId);
    if (!row || row.employeeId !== actor.id) return "You can only change your own enrollments.";
    if (row.status !== "Enrolled") return "Only active enrollments can be changed.";
    if (isMandatoryPlan(row.planId)) return "This is a statutory plan and cannot be changed.";
    if (pendingChangeFor(s, row.id)) return "A change request for this plan is already with HR.";
    const text = note.trim();
    if (text.length < 5) return "Say what you want to change.";
    s.changeRequests.unshift({
      id: `bcr-${Date.now()}`,
      enrollmentId: row.id,
      employeeId: actor.id,
      employeeName: actor.fullName,
      planName: row.planName,
      note: text.slice(0, 200),
      status: "Pending",
      requestedOn: todayISO(),
    });
  });
}

export function decideChangeRequest(actor: DemoAccount, id: string, status: "Done" | "Declined"): RewardResult {
  return updateReward((s) => {
    const row = s.changeRequests.find((c) => c.id === id);
    if (!row) return "Request not found.";
    if (row.employeeId === actor.id) return "Someone else must handle your own request.";
    if (!canDecideBenefitFor(actor, row.employeeId)) return "Only HR can handle change requests (HR's own go to their line manager).";
    if (row.status !== "Pending") return "This request is already closed.";
    row.status = status;
    row.decidedBy = actor.fullName;
    row.decidedOn = todayISO();
  });
}

/** HR decides a pending enrollment request. */
export function decideEnrollment(
  actor: DemoAccount,
  enrollmentId: string,
  status: "Enrolled" | "Waived",
): RewardResult {
  return updateReward((s) => {
    const row = s.enrollments.find((e) => e.id === enrollmentId);
    if (!row) return "Enrollment not found.";
    if (row.employeeId === actor.id) return "Someone else must decide your own request.";
    if (!canDecideBenefitFor(actor, row.employeeId)) return "Only HR can decide enrollment requests (HR's own go to their line manager).";
    if (row.status !== "Pending") return "Only pending requests can be decided.";
    if (status === "Waived" && isMandatoryPlan(row.planId)) return "Statutory plans cannot be waived.";
    row.status = status;
    if (status === "Enrolled") row.effective = todayISO();
  });
}

/* ───────────── Letters ───────────── */

const OPEN_LETTER_STATUSES: LetterStatus[] = ["Draft", "Pending approval", "Approved"];

type LetterActor = Pick<DemoAccount, "id" | "fullName" | "role">;

const isLetterHr = (actor: Pick<DemoAccount, "role">) => canManageLetters(actor as DemoAccount);

function isRequester(actor: LetterActor, row: LetterRequest): boolean {
  return row.requestedById ? row.requestedById === actor.id : row.requestedBy === actor.fullName;
}

/**
 * Who may approve a letter: any HR sign-in account other than the subject. When the subject is the
 * only HR account (HR's own letter), the subject's line manager approves instead — never the subject.
 */
export function letterApprovers(row: Pick<LetterRequest, "employeeId">): { id: string; fullName: string }[] {
  const hr = DEMO_ACCOUNTS.filter((a) => isLetterHr(a) && a.id !== row.employeeId);
  if (hr.length) return hr.map((a) => ({ id: a.id, fullName: a.fullName }));
  const manager = managementChain(row.employeeId).find((m) => m.id !== row.employeeId);
  return manager ? [{ id: manager.id, fullName: manager.fullName }] : [];
}

export function canApproveLetter(actor: LetterActor, row: LetterRequest): boolean {
  if (actor.id === row.employeeId) return false;
  return letterApprovers(row).some((a) => a.id === actor.id);
}

/** Salary revision / promotion letters stay hidden from their subject until issued. */
export function canViewLetter(actor: DemoAccount, row: LetterRequest): boolean {
  if (row.employeeId === actor.id) {
    return row.status === "Issued" || !SENSITIVE_LETTER_TYPES.includes(row.type);
  }
  if (isLetterHr(actor)) return true;
  return isRequester(actor, row) || canApproveLetter(actor, row);
}

/** Valid next statuses for this actor. Approval itself goes through approveLetter (it generates the document). */
export function nextLetterStatuses(actor: DemoAccount, row: LetterRequest): LetterStatus[] {
  switch (row.status) {
    case "Draft":
      return isRequester(actor, row) ? ["Pending approval"] : [];
    case "Pending approval":
    case "Approved":
      return canApproveLetter(actor, row) ? ["Approved", "Rejected"] : [];
    default:
      return [];
  }
}

/** Submit a draft or reject a request. Approving is done by approveLetter in letterService. */
export function setLetterStatus(actor: DemoAccount, id: string, status: LetterStatus): RewardResult {
  if (status === "Approved" || status === "Issued") return "Approve the letter to generate it.";
  return updateReward((s) => {
    const row = s.letters.find((l) => l.id === id);
    if (!row) return "Letter request not found.";
    if (!nextLetterStatuses(actor, row).includes(status)) {
      return `You cannot move this letter from ${row.status} to ${status}.`;
    }
    row.status = status;
    if (status === "Rejected") {
      row.approver = actor.fullName;
      row.approverId = actor.id;
      row.decidedOn = todayISO();
    }
  });
}

/** Raw request — also used by exit and probation flows. Checks on who may request what live in letterService. */
export function addLetterRequest(
  actor: LetterActor,
  input: { employeeId: string; employeeName: string; type: LetterType; note: string; details?: string; effectiveDate?: string },
): RewardResult {
  if (input.employeeId !== actor.id && !isLetterHr(actor)) {
    return "You can only request letters for yourself.";
  }
  return updateReward((s) => {
    const open = s.letters.some(
      (l) => l.employeeId === input.employeeId && l.type === input.type && OPEN_LETTER_STATUSES.includes(l.status),
    );
    if (open) return `There is already an open ${input.type} letter request for ${input.employeeName}.`;
    s.letters.unshift({
      id: `ltr-local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      employeeId: input.employeeId,
      employeeName: input.employeeName,
      type: input.type,
      status: "Pending approval",
      requestedBy: actor.fullName,
      requestedById: actor.id,
      requestedOn: todayISO(),
      note: input.note,
      details: input.details?.trim() || undefined,
      effectiveDate: input.effectiveDate || undefined,
      previewBody: `${input.type} letter for ${input.employeeName}. Generated once approved.`,
    });
  });
}

/* ───────────── Document library ───────────── */

export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
export const UPLOAD_EXTENSIONS = ["pdf", "png", "jpg", "jpeg", "webp", "txt", "csv"];

export function validateUpload(file: { name: string; size: number }): RewardResult {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!UPLOAD_EXTENSIONS.includes(ext)) {
    return `Unsupported file type. Allowed: ${UPLOAD_EXTENSIONS.join(", ")}.`;
  }
  if (file.size > MAX_UPLOAD_BYTES) return "File is larger than 2 MB.";
  return null;
}

export function addLibraryDoc(doc: Omit<DocLibraryItem, "id" | "uploadedAt">): RewardResult {
  return updateReward((s) => {
    s.library.unshift({
      ...doc,
      id: `dl-local-${Date.now()}`,
      uploadedAt: new Date().toISOString(),
    });
  });
}
