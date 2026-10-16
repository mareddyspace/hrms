import type { DemoAccount } from "../demoAccounts.ts";
import { todayISO } from "../model.ts";
import { canManagePeople } from "./peoplePermissions.ts";
import { canApproveCompReviews, canManageLetters } from "./rbac.ts";
import {
  BENEFIT_ENROLLMENTS,
  BENEFIT_PLANS,
  BONUSES,
  COMP_CYCLES,
  COMP_REVIEWS,
  DOC_LIBRARY_SEED,
  LETTER_REQUESTS,
  SENSITIVE_LETTER_TYPES,
  type BenefitEnrollment,
  type BonusRecord,
  type CompReviewItem,
  type DocLibraryItem,
  type LetterRequest,
  type LetterStatus,
  type LetterType,
} from "./rewardData.ts";

// v2: letters gained "Rejected" + requestedById, plans gained `mandatory`
const KEY = "timez.reward.state.v2";

type RewardState = {
  reviews: CompReviewItem[];
  bonuses: BonusRecord[];
  enrollments: BenefitEnrollment[];
  letters: LetterRequest[];
  library: DocLibraryItem[];
};

/** Mutations return null on success or a user-facing error message. */
export type RewardResult = string | null;

function defaults(): RewardState {
  return {
    reviews: structuredClone(COMP_REVIEWS),
    bonuses: structuredClone(BONUSES),
    enrollments: structuredClone(BENEFIT_ENROLLMENTS),
    letters: structuredClone(LETTER_REQUESTS),
    library: structuredClone(DOC_LIBRARY_SEED),
  };
}

function read(): RewardState {
  const base = defaults();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw) as Partial<RewardState>;
    return {
      reviews: Array.isArray(parsed.reviews) ? parsed.reviews : base.reviews,
      bonuses: Array.isArray(parsed.bonuses) ? parsed.bonuses : base.bonuses,
      enrollments: Array.isArray(parsed.enrollments) ? parsed.enrollments : base.enrollments,
      letters: Array.isArray(parsed.letters) ? parsed.letters : base.letters,
      library: Array.isArray(parsed.library) ? parsed.library : base.library,
    };
  } catch {
    return base;
  }
}

const listeners = new Set<() => void>();
let cache: RewardState | null = null;

function write(state: RewardState): RewardResult {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Usually the storage quota — keep the previous cache so UI and storage agree.
    return "Could not save — browser storage is full. Remove large uploads and try again.";
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

export function setReviewStatus(
  actor: DemoAccount,
  id: string,
  status: "Approved" | "Rejected",
): RewardResult {
  if (!canApproveCompReviews(actor)) return "You are not allowed to approve compensation reviews.";
  return updateReward((s) => {
    const row = s.reviews.find((r) => r.id === id);
    if (!row) return "Review not found.";
    if (row.employeeId === actor.id) return "You cannot approve your own compensation review.";
    if (COMP_CYCLES.find((c) => c.id === row.cycleId)?.status === "Closed") {
      return "This review cycle is closed.";
    }
    if (row.status !== "Pending approval") return "Only pending proposals can be decided.";
    row.status = status;
    row.approver = actor.fullName;
    row.decidedOn = todayISO();
  });
}

/* ───────────── Benefits ───────────── */

export function canAdminBenefits(actor: DemoAccount): boolean {
  return canManagePeople(actor.role);
}

export function isMandatoryPlan(planId: string): boolean {
  return !!BENEFIT_PLANS.find((p) => p.id === planId)?.mandatory;
}

/** Employee asks to join a plan in their own country (creates a Pending row). */
export function requestEnrollment(actor: DemoAccount, planId: string): RewardResult {
  const plan = BENEFIT_PLANS.find((p) => p.id === planId);
  if (!plan) return "Plan not found.";
  if (plan.country !== actor.countryName) return "You can only enroll in plans for your own country.";
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

/** Employee asks HR to change an existing enrollment of their own. */
export function requestEnrollmentChange(actor: DemoAccount, enrollmentId: string): RewardResult {
  return updateReward((s) => {
    const row = s.enrollments.find((e) => e.id === enrollmentId);
    if (!row || row.employeeId !== actor.id) return "You can only change your own enrollments.";
    if (row.status === "Pending") return "A request for this plan is already pending.";
    if (row.status === "Enrolled" && isMandatoryPlan(row.planId)) {
      return "This is a statutory plan and cannot be changed.";
    }
    row.status = "Pending";
  });
}

/** HR decides a pending enrollment request. */
export function decideEnrollment(
  actor: DemoAccount,
  enrollmentId: string,
  status: "Enrolled" | "Waived",
): RewardResult {
  if (!canAdminBenefits(actor)) return "Only HR can decide enrollment requests.";
  return updateReward((s) => {
    const row = s.enrollments.find((e) => e.id === enrollmentId);
    if (!row) return "Enrollment not found.";
    if (row.employeeId === actor.id) return "Another HR approver must decide your own request.";
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
