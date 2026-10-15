import {
  BENEFIT_ENROLLMENTS,
  BONUSES,
  COMP_REVIEWS,
  DOC_LIBRARY_SEED,
  LETTER_REQUESTS,
  type BenefitEnrollment,
  type BonusRecord,
  type CompReviewItem,
  type DocLibraryItem,
  type LetterRequest,
  type LetterStatus,
  type LetterType,
} from "./rewardData.ts";

const KEY = "timez.reward.state.v1";

type RewardState = {
  reviews: CompReviewItem[];
  bonuses: BonusRecord[];
  enrollments: BenefitEnrollment[];
  letters: LetterRequest[];
  library: DocLibraryItem[];
};

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

function write(state: RewardState) {
  cache = state;
  localStorage.setItem(KEY, JSON.stringify(state));
  listeners.forEach((fn) => fn());
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

export function updateReward(mutator: (state: RewardState) => void) {
  const state = structuredClone(getRewardState());
  mutator(state);
  write(state);
}

export function setReviewStatus(id: string, status: CompReviewItem["status"]) {
  updateReward((s) => {
    const row = s.reviews.find((r) => r.id === id);
    if (row) row.status = status;
  });
}

export function setEnrollmentStatus(id: string, status: BenefitEnrollment["status"]) {
  updateReward((s) => {
    const row = s.enrollments.find((e) => e.id === id);
    if (row) row.status = status;
  });
}

export function setLetterStatus(id: string, status: LetterStatus, approver?: string) {
  updateReward((s) => {
    const row = s.letters.find((l) => l.id === id);
    if (!row) return;
    row.status = status;
    if (approver) row.approver = approver;
    if (status === "Approved" || status === "Issued" || status === "Pending approval") {
      row.decidedOn = new Date().toISOString().slice(0, 10);
    }
  });
}

export function addLetterRequest(input: {
  employeeId: string;
  employeeName: string;
  type: LetterType;
  requestedBy: string;
  note: string;
}) {
  updateReward((s) => {
    s.letters.unshift({
      id: `ltr-local-${Date.now()}`,
      employeeId: input.employeeId,
      employeeName: input.employeeName,
      type: input.type,
      status: "Draft",
      requestedBy: input.requestedBy,
      requestedOn: new Date().toISOString().slice(0, 10),
      note: input.note,
      previewBody: `[DEMO TEMPLATE — NOT A LEGAL DOCUMENT]\n\n${input.type} letter draft for ${input.employeeName}.\nFictional UI content only. Do not use as an official employment document.`,
    });
  });
}

export function addLibraryDoc(doc: Omit<DocLibraryItem, "id" | "uploadedAt">) {
  updateReward((s) => {
    s.library.unshift({
      ...doc,
      id: `dl-local-${Date.now()}`,
      uploadedAt: new Date().toISOString(),
    });
  });
}
