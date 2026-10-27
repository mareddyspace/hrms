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

// v3: seed rows re-keyed to real people, comp history and benefit change requests stored — older data is replaced.
const KEY = "timez.reward.state.v3";
const OLD_KEYS = ["timez.reward.state.v1", "timez.reward.state.v2"];

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

/** Who may decide the row now: line step = above the employee, never the proposer; final step = Compensation. */
export function canDecideCompReview(actor: Actor, row: CompReviewItem): boolean {
  if (actor.id === row.employeeId || actor.id === row.managerId) return false;
  if (COMP_CYCLES.find((c) => c.id === row.cycleId)?.status === "Closed") return false;
  if (row.status === "Pending approval") return isAboveInLine(actor.id, row.employeeId);
  if (row.status === "Pending final approval") return actor.role === "compensation_admin" && row.lineApprover !== actor.fullName;
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
    // With no one above the proposer in the line (e.g. the CEO's own reports), it goes straight to Compensation.
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
        ? "Compensation makes the final decision."
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
  return canManagePeople(actor.role) || actor.role === "compensation_admin";
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
  if (!canAdminBenefits(actor)) return "Only HR or Compensation can handle change requests.";
  return updateReward((s) => {
    const row = s.changeRequests.find((c) => c.id === id);
    if (!row) return "Request not found.";
    if (row.employeeId === actor.id) return "Someone else must handle your own request.";
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
  if (!canAdminBenefits(actor)) return "Only HR or Compensation can decide enrollment requests.";
  return updateReward((s) => {
    const row = s.enrollments.find((e) => e.id === enrollmentId);
    if (!row) return "Enrollment not found.";
    if (row.employeeId === actor.id) return "Someone else must decide your own request.";
    if (row.status !== "Pending") return "Only pending requests can be decided.";
    if (status === "Waived" && isMandatoryPlan(row.planId)) return "Statutory plans cannot be waived.";
    row.status = status;
    if (status === "Enrolled") row.effective = todayISO();
  });
}

/* ───────────── Letters ───────────── */

const OPEN_LETTER_STATUSES: LetterStatus[] = ["Draft", "Pending approval", "Approved"];

function isRequester(actor: DemoAccount, row: LetterRequest): boolean {
  return row.requestedById ? row.requestedById === actor.id : row.requestedBy === actor.fullName;
}

/** Salary revision / promotion letters stay hidden from their subject until issued. */
export function canViewLetter(actor: DemoAccount, row: LetterRequest): boolean {
  if (canManageLetters(actor)) return true;
  if (row.employeeId === actor.id) {
    return row.status === "Issued" || !SENSITIVE_LETTER_TYPES.includes(row.type);
  }
  return isRequester(actor, row);
}

/** Valid next statuses for this actor — the UI only offers these. */
export function nextLetterStatuses(actor: DemoAccount, row: LetterRequest): LetterStatus[] {
  const hr = canManageLetters(actor);
  switch (row.status) {
    case "Draft":
      return isRequester(actor, row) ? ["Pending approval"] : [];
    case "Pending approval":
      return hr && !isRequester(actor, row) && row.employeeId !== actor.id ? ["Approved", "Rejected"] : [];
    case "Approved":
      return hr ? ["Issued"] : [];
    default:
      return [];
  }
}

export function setLetterStatus(actor: DemoAccount, id: string, status: LetterStatus): RewardResult {
  return updateReward((s) => {
    const row = s.letters.find((l) => l.id === id);
    if (!row) return "Letter request not found.";
    if (!nextLetterStatuses(actor, row).includes(status)) {
      return `You cannot move this letter from ${row.status} to ${status}.`;
    }
    row.status = status;
    if (status === "Approved" || status === "Rejected") {
      row.approver = actor.fullName;
      row.decidedOn = todayISO();
    }
  });
}

export function addLetterRequest(
  actor: DemoAccount,
  input: { employeeId: string; employeeName: string; type: LetterType; note: string },
): RewardResult {
  if (input.employeeId !== actor.id && !canManageLetters(actor)) {
    return "You can only request letters for yourself.";
  }
  return updateReward((s) => {
    const open = s.letters.some(
      (l) => l.employeeId === input.employeeId && l.type === input.type && OPEN_LETTER_STATUSES.includes(l.status),
    );
    if (open) return `There is already an open ${input.type} letter request for ${input.employeeName}.`;
    s.letters.unshift({
      id: `ltr-local-${Date.now()}`,
      employeeId: input.employeeId,
      employeeName: input.employeeName,
      type: input.type,
      status: "Pending approval",
      requestedBy: actor.fullName,
      requestedById: actor.id,
      requestedOn: todayISO(),
      note: input.note,
      previewBody: `[TEMPLATE PREVIEW — NOT AN OFFICIAL DOCUMENT]\n\n${input.type} letter for ${input.employeeName}.\nThe issued letter is provided by HR once approved.`,
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
