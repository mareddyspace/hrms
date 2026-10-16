import type { DemoAccount } from "../../demoAccounts.ts";
import type { PersonRecord } from "../../data/peopleData.ts";
import { getPerson, listPeople } from "../../data/peopleLocal.ts";
import { addLetterRequest } from "../../data/rewardLocal.ts";
import { addDaysISO, todayISO } from "../../model.ts";
import {
  addMonthsISO,
  baseProbationEnd,
  daysBetween,
  isAboveInLine,
  isContractor,
  isHrRole,
  joiningForProbationEnd,
  seedCandidates,
  type LifecycleActor,
  type LifecycleResult,
} from "./lifecycleShared.ts";

const KEY = "kastech.probation.v1";

export type Recommendation = "Confirm" | "Extend" | "Not confirm";
export type ProbationStatus = "In probation" | "Review pending HR" | "Confirmed" | "Not confirmed";

export const MAX_EXTENSIONS = 2;
export const DUE_WINDOW_DAYS = 60;

export interface ProbationReview {
  id: string;
  recommendation: Recommendation;
  extendMonths?: number;
  reason: string;
  rating: number;
  comments: string;
  submittedBy: string;
  submittedById: string;
  submittedOn: string;
  outcome?: "Approved" | "Returned";
  decidedBy?: string;
  decidedById?: string;
  decidedOn?: string;
  decisionNote?: string;
}

export interface ProbationExtension {
  months: number;
  reason: string;
  approvedBy: string;
  approvedOn: string;
}

export interface ProbationRecord {
  employeeId: string;
  /** Overrides the directory joining date (seeded joiners only). */
  joiningDate?: string;
  status: ProbationStatus;
  extensions: ProbationExtension[];
  reviews: ProbationReview[];
  finalisedOn?: string;
}

type ProbationState = { records: ProbationRecord[] };

function defaults(): ProbationState {
  const people = seedCandidates();
  const today = todayISO();
  const records: ProbationRecord[] = [];
  const seed = (person: PersonRecord | undefined, endISO: string, extra: Partial<ProbationRecord> = {}) => {
    if (!person) return;
    records.push({
      employeeId: person.id,
      joiningDate: joiningForProbationEnd(endISO, String(person.countryCode)),
      status: "In probation",
      extensions: [],
      reviews: [],
      ...extra,
    });
  };
  // Ends soon, no review yet.
  seed(people[0], addDaysISO(today, 18));
  // Overdue — the review was missed.
  seed(people[1], addDaysISO(today, -9));
  // Review already submitted, waiting for HR.
  seed(people[2], addDaysISO(today, 35), {
    status: "Review pending HR",
    reviews: [
      {
        id: "prb-seed-review",
        recommendation: "Confirm",
        reason: "",
        rating: 4,
        comments: "Settled in quickly and owns the release checklist.",
        submittedBy: "Ram Krishnan",
        submittedById: "emp-ram",
        submittedOn: addDaysISO(today, -2),
      },
    ],
  });
  return { records };
}

function read(): ProbationState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    const saved = JSON.parse(raw) as Partial<Record<keyof ProbationState, unknown>>;
    const base = defaults();
    if (Array.isArray(saved?.records)) {
      base.records = (saved.records as ProbationRecord[]).map((r) => ({
        ...r,
        extensions: Array.isArray(r.extensions) ? r.extensions : [],
        reviews: Array.isArray(r.reviews) ? r.reviews : [],
      }));
    }
    return base;
  } catch {
    return defaults();
  }
}

let cache: ProbationState | null = null;
const listeners = new Set<() => void>();

function write(state: ProbationState): LifecycleResult {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    return "Could not save — browser storage is full or unavailable.";
  }
  cache = state;
  listeners.forEach((fn) => fn());
  return null;
}

export function subscribeProbation(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Stable snapshot for useSyncExternalStore. */
export function getProbationState(): ProbationState {
  if (!cache) cache = read();
  return cache;
}

/* ───────────── Derived view ───────────── */

export interface ProbationView {
  person: PersonRecord;
  record?: ProbationRecord;
  joiningDate: string;
  baseEnd: string;
  endDate: string;
  status: ProbationStatus;
  daysLeft: number;
  /** Ends within the due window or is overdue, and no final decision yet. */
  due: boolean;
  overdue: boolean;
  pendingReview?: ProbationReview;
}

export function probationViewFor(person: PersonRecord, record = findRecord(person.id), today = todayISO()): ProbationView {
  const joiningDate = record?.joiningDate ?? person.dateOfJoining;
  const baseEnd = baseProbationEnd(joiningDate, String(person.countryCode));
  const extraMonths = (record?.extensions ?? []).reduce((sum, e) => sum + e.months, 0);
  const endDate = extraMonths ? addMonthsISO(baseEnd, extraMonths) : baseEnd;
  const status: ProbationStatus = record?.status ?? (endDate < addDaysISO(today, -365) ? "Confirmed" : "In probation");
  const daysLeft = daysBetween(today, endDate);
  const open = status === "In probation" || status === "Review pending HR";
  const pendingReview = status === "Review pending HR" ? record?.reviews.find((r) => !r.outcome) : undefined;
  return {
    person,
    record,
    joiningDate,
    baseEnd,
    endDate,
    status,
    daysLeft,
    due: open && daysLeft <= DUE_WINDOW_DAYS,
    overdue: open && daysLeft < 0,
    pendingReview,
  };
}

function findRecord(employeeId: string): ProbationRecord | undefined {
  return getProbationState().records.find((r) => r.employeeId === employeeId);
}

/**
 * People in probation tracking: anyone with a probation record, plus active
 * full-time joiners from the last 12 months.
 */
export function trackedProbations(people: PersonRecord[] = listPeople(), today = todayISO()): ProbationView[] {
  const records = new Map(getProbationState().records.map((r) => [r.employeeId, r]));
  const yearAgo = addDaysISO(today, -365);
  return people
    .filter((p) => p.employmentStatus !== "Terminated" && !isContractor(p))
    .filter((p) => records.has(p.id) || p.dateOfJoining >= yearAgo)
    .map((p) => probationViewFor(p, records.get(p.id), today))
    .sort((a, b) => a.endDate.localeCompare(b.endDate));
}

export function canReview(actor: LifecycleActor, employeeId: string): boolean {
  return actor.id !== employeeId && isAboveInLine(actor.id, employeeId);
}

/* ───────────── Mutations ───────────── */

function upsertRecord(employeeId: string, mutator: (record: ProbationRecord) => LifecycleResult): LifecycleResult {
  const state = getProbationState();
  const existing = state.records.find((r) => r.employeeId === employeeId);
  const record: ProbationRecord = existing
    ? structuredClone(existing)
    : { employeeId, status: "In probation", extensions: [], reviews: [] };
  const error = mutator(record);
  if (error) return error;
  const records = existing
    ? state.records.map((r) => (r.employeeId === employeeId ? record : r))
    : [...state.records, record];
  return write({ ...state, records });
}

export function submitProbationReview(
  actor: LifecycleActor,
  employeeId: string,
  input: { recommendation: Recommendation; extendMonths?: number; reason: string; rating: number; comments: string },
): LifecycleResult {
  if (actor.id === employeeId) return "You cannot review your own probation.";
  if (!canReview(actor, employeeId)) return "Only someone in the reporting line can submit this review.";
  const person = getPerson(employeeId);
  if (!person) return "This person is not in the directory.";
  if (person.employmentStatus === "Terminated") return "This person has left the organisation.";
  const view = probationViewFor(person);
  if (view.status === "Review pending HR") return "A review is already waiting for HR.";
  if (view.status !== "In probation") return `Probation is already closed (${view.status.toLowerCase()}).`;
  if (view.daysLeft > DUE_WINDOW_DAYS) return `Reviews open ${DUE_WINDOW_DAYS} days before probation ends.`;
  if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) return "Choose a rating from 1 to 5.";
  const reason = input.reason.trim();
  const comments = input.comments.trim();
  if (!comments) return "Add review comments.";
  if (comments.length > 2000) return "Comments must be 2000 characters or fewer.";
  if (input.recommendation === "Extend") {
    const months = input.extendMonths ?? 0;
    if (!Number.isInteger(months) || months < 1 || months > 3) return "Extension must be 1 to 3 months.";
    if ((view.record?.extensions.length ?? 0) >= MAX_EXTENSIONS) return `Probation can be extended at most ${MAX_EXTENSIONS} times.`;
    if (!reason) return "Give a reason for the extension.";
  }
  if (input.recommendation === "Not confirm" && !reason) return "Give a reason for not confirming.";
  return upsertRecord(employeeId, (record) => {
    record.status = "Review pending HR";
    record.reviews.push({
      id: `prb-${Date.now()}`,
      recommendation: input.recommendation,
      extendMonths: input.recommendation === "Extend" ? input.extendMonths : undefined,
      reason,
      rating: input.rating,
      comments,
      submittedBy: actor.fullName,
      submittedById: actor.id,
      submittedOn: todayISO(),
    });
    return null;
  });
}

/** HR approves the manager's recommendation, or returns it for rework. */
export function finaliseProbation(
  actor: DemoAccount,
  employeeId: string,
  decision: "approve" | "return",
  note: string,
  onWarning?: (text: string) => void,
): LifecycleResult {
  if (!isHrRole(actor.role)) return "Only HR can finalise probation.";
  if (actor.id === employeeId) return "You cannot finalise your own probation.";
  const person = getPerson(employeeId);
  if (!person) return "This person is not in the directory.";
  const record = findRecord(employeeId);
  const review = record?.reviews.find((r) => !r.outcome);
  if (!record || record.status !== "Review pending HR" || !review) return "There is no review waiting for HR.";
  if (review.submittedById === actor.id) return "Another HR colleague must finalise a review you submitted.";
  const trimmed = note.trim();
  if (decision === "return" && !trimmed) return "Add a note explaining why the review is returned.";
  if (decision === "approve" && review.recommendation === "Extend" && record.extensions.length >= MAX_EXTENSIONS) {
    return `Probation can be extended at most ${MAX_EXTENSIONS} times.`;
  }
  const today = todayISO();
  const error = upsertRecord(employeeId, (r) => {
    const target = r.reviews.find((x) => x.id === review.id)!;
    target.outcome = decision === "approve" ? "Approved" : "Returned";
    target.decidedBy = actor.fullName;
    target.decidedById = actor.id;
    target.decidedOn = today;
    target.decisionNote = trimmed;
    if (decision === "return") {
      r.status = "In probation";
      return null;
    }
    if (review.recommendation === "Confirm") {
      r.status = "Confirmed";
      r.finalisedOn = today;
    } else if (review.recommendation === "Not confirm") {
      r.status = "Not confirmed";
      r.finalisedOn = today;
    } else {
      r.status = "In probation";
      r.extensions.push({ months: review.extendMonths ?? 1, reason: review.reason, approvedBy: actor.fullName, approvedOn: today });
    }
    return null;
  });
  if (error) return error;
  if (decision === "approve" && review.recommendation === "Confirm") {
    const letterError = addLetterRequest(actor, {
      employeeId,
      employeeName: person.fullName,
      type: "Confirmation",
      note: `Probation completed on ${today}.`,
    });
    if (letterError) onWarning?.(`Confirmed, but the letter request was not created: ${letterError}`);
  }
  return null;
}
