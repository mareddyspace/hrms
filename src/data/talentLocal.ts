import {
  CANDIDATES,
  CERTIFICATIONS,
  CLOSED_STAGES,
  COURSES,
  ENROLLMENTS,
  EXIT_STAGES,
  FEEDBACK_ITEMS,
  INTERVIEWS,
  OFFER_ELIGIBLE_STAGES,
  OFFERS,
  ONBOARDING_JOINERS,
  ONE_ON_ONES,
  ONBOARDING_TASKS,
  ONBOARDING_TEMPLATE,
  PERF_CYCLES,
  PERF_GOALS,
  PERF_REVIEWS,
  PIPELINE_STAGES,
  RATINGS,
  REQUISITIONS,
  starterSkillsFor,
  type ApprovalStatus,
  type Candidate,
  type Certification,
  type Course,
  type EmployeeSkill,
  type Enrollment,
  type FeedbackItem,
  type Interview,
  type OfferApproval,
  type OfferRecord,
  type OfferStatus,
  type OnboardingJoiner,
  type OnboardingTask,
  type OneOnOne,
  type PerfCycle,
  type PerfGoal,
  type PerfReview,
  type PipelineStage,
  type Requisition,
  type SkillProfile,
  type StageStep,
} from "./talentData.ts";
import { DEMO_ACCOUNTS, managementChain, type DemoAccount } from "../demoAccounts.ts";
import { TIMEZ_COUNTRIES, todayISO, type UserRole } from "../model.ts";
import { legalEntityFor } from "../countryPay.ts";
import { TASK_TEAM } from "./taskTeam.ts";
import { GRADE_BANDS, type GradeBand } from "./rewardData.ts";
import { upsertPerson, type LocalPersonRecord } from "./peopleLocal.ts";

// v3: recruiting seed made consistent (approval trails, structured offers, joiners linked to hires).
// v4: manager → HR → recruiter hiring flow and per-candidate stage history.
const KEY = "timez.talent.state.v4";
/** v3 data is migrated once: recruiting and onboarding restart from the v4 seed, everything else is kept. */
const LEGACY_KEY = "timez.talent.state.v3";
const OLD_KEYS = ["timez.talent.state.v1", "timez.talent.state.v2"];
const RESEEDED_ON_MIGRATION = ["requisitions", "candidates", "interviews", "offers", "joiners", "tasks"] as const;

type TalentState = {
  requisitions: Requisition[];
  candidates: Candidate[];
  interviews: Interview[];
  offers: OfferRecord[];
  joiners: OnboardingJoiner[];
  tasks: OnboardingTask[];
  goals: PerfGoal[];
  reviews: PerfReview[];
  enrollments: Enrollment[];
  certifications: Certification[];
  feedback: FeedbackItem[];
  oneOnOnes: OneOnOne[];
  skillProfiles: SkillProfile[];
  /** Cycle status changes made by HR (cycle id → status). */
  cycleStatus: Record<string, PerfCycle["status"]>;
};

/** Who is performing a talent action — the signed-in persona. */
export type TalentActor = Pick<DemoAccount, "id" | "fullName" | "role">;
/** null when the change was applied, otherwise the reason it was refused. */
export type TalentResult = string | null;

function defaults(): TalentState {
  return {
    requisitions: structuredClone(REQUISITIONS),
    candidates: structuredClone(CANDIDATES),
    interviews: structuredClone(INTERVIEWS),
    offers: structuredClone(OFFERS),
    joiners: structuredClone(ONBOARDING_JOINERS),
    tasks: structuredClone(ONBOARDING_TASKS),
    goals: structuredClone(PERF_GOALS),
    reviews: structuredClone(PERF_REVIEWS),
    enrollments: structuredClone(ENROLLMENTS),
    certifications: structuredClone(CERTIFICATIONS),
    feedback: structuredClone(FEEDBACK_ITEMS),
    oneOnOnes: structuredClone(ONE_ON_ONES),
    skillProfiles: [],
    cycleStatus: {},
  };
}

/** Drops data that should never exist: reviews for people with no one above them (the CEO). */
function clean(state: TalentState): TalentState {
  state.reviews = state.reviews.filter((r) => managementChain(r.employeeId, DEMO_ACCOUNTS).length > 0);
  return deriveJoiners(ensureHistory(state));
}

function read(): TalentState {
  try {
    OLD_KEYS.forEach((k) => localStorage.removeItem(k));
    let raw = localStorage.getItem(KEY);
    const legacy = !raw ? localStorage.getItem(LEGACY_KEY) : null;
    if (legacy) raw = legacy;
    if (!raw) return clean(defaults());
    const saved = JSON.parse(raw) as Partial<Record<keyof TalentState, unknown>>;
    const base = defaults();
    // Keep only saved lists that are still lists; anything damaged falls back to defaults.
    for (const key of Object.keys(base) as (keyof TalentState)[]) {
      if (key === "cycleStatus") continue;
      if (legacy && (RESEEDED_ON_MIGRATION as readonly string[]).includes(key)) continue;
      if (Array.isArray(saved?.[key])) (base as Record<keyof TalentState, unknown>)[key] = saved[key];
    }
    const status = saved?.cycleStatus;
    if (status && typeof status === "object" && !Array.isArray(status)) base.cycleStatus = status as TalentState["cycleStatus"];
    const state = clean(base);
    if (legacy) {
      localStorage.setItem(KEY, JSON.stringify(state));
      localStorage.removeItem(LEGACY_KEY);
    }
    return state;
  } catch {
    return clean(defaults());
  }
}

let cache: TalentState | null = null;

function write(state: TalentState) {
  cache = state;
  localStorage.setItem(KEY, JSON.stringify(state));
  listeners.forEach((fn) => fn());
}

const listeners = new Set<() => void>();

export function subscribeTalent(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Stable snapshot for useSyncExternalStore — same reference until data changes. */
export function getTalentState(): TalentState {
  if (!cache) cache = read();
  return cache;
}

export function updateTalent(mutator: (state: TalentState) => void) {
  const state = read();
  mutator(state);
  write(deriveJoiners(state));
}

/** Runs a guarded change: `apply` returns an error message to refuse, or null to save. */
function guarded(apply: (state: TalentState) => TalentResult): TalentResult {
  const state = read();
  const error = apply(state);
  if (error) return error;
  write(deriveJoiners(state));
  return null;
}

/* ───────────── Permissions ───────────── */

const HR_ROLES: readonly UserRole[] = ["hr", "hr_admin", "hrbp"];

export function isHrRole(role: UserRole): boolean {
  return HR_ROLES.includes(role);
}

/** Recruiter, HR and hiring managers run the hiring workflow. */
export function canEditRecruiting(role: UserRole): boolean {
  return role === "recruiter" || role === "hiring_manager" || isHrRole(role);
}

/** True when `actorId` sits above `employeeId` in the reporting line. */
export function isAboveInChain(actorId: string, employeeId: string): boolean {
  return managementChain(employeeId, DEMO_ACCOUNTS).some((m) => m.id === actorId);
}

/** Decisions about a person: only someone above them in the reporting line — never HR by role, never themselves. */
export function canManageEmployee(actor: TalentActor, employeeId: string): boolean {
  return employeeId !== actor.id && isAboveInChain(actor.id, employeeId);
}

/** Viewing: yourself, your reporting line, or HR. */
export function canViewEmployeeTalent(actor: TalentActor, employeeId: string): boolean {
  return actor.id === employeeId || isHrRole(actor.role) || isAboveInChain(actor.id, employeeId);
}

function sameName(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/* ───────────── Recruiting ───────────── */
// Order: the hiring manager raises a requisition → HR approves it and assigns a recruiter →
// the recruiter runs the pipeline (HR may too) → the hiring manager gives interview feedback and the
// Final Review decision → offer: recruiter prepares → hiring manager agrees → HR approves
// (+ Compensation above band) → recruiter sends and records the answer. Nobody approves their own step.

/** Recruiter assigned when HR approves without picking one. */
export const DEFAULT_RECRUITER_ID = "demo-recruiter";

function accountId(name: string): string | undefined {
  return DEMO_ACCOUNTS.find((a) => sameName(a.fullName, name))?.id;
}

function hiringManagerIdOf(req: Requisition): string | undefined {
  return req.hiringManagerId || accountId(req.hiringManager);
}

/** True when the actor is the requisition's hiring manager. */
export function isHiringManagerOf(actor: TalentActor, req: Requisition): boolean {
  return hiringManagerIdOf(req) === actor.id;
}

/** True when the actor is the recruiter HR assigned to this requisition. */
export function isAssignedRecruiter(actor: TalentActor, req: Requisition): boolean {
  if (actor.role !== "recruiter") return false;
  return req.recruiterId ? req.recruiterId === actor.id : sameName(req.recruiter, actor.fullName);
}

/** Pipeline work — screening, interviews, stage moves, offers: the assigned recruiter, or HR. */
export function canRunPipeline(actor: TalentActor, req: Requisition): boolean {
  return isAssignedRecruiter(actor, req) || isHrRole(actor.role);
}

/** Anyone with a part in this requisition: its recruiter, HR or its hiring manager. */
export function canActOnRequisition(actor: TalentActor, req: Requisition): boolean {
  return canRunPipeline(actor, req) || isHiringManagerOf(actor, req);
}

const RAISING_ROLES: readonly UserRole[] = ["manager", "hiring_manager", "executive", "founder", "cofounder"];

/** The manager who needs the role raises the requisition. */
export function canRaiseRequisition(actor: TalentActor): boolean {
  return RAISING_ROLES.includes(actor.role);
}

/** HR decides requisitions — never the requisition's own hiring manager. */
export function requisitionApprovers(req: Requisition): DemoAccount[] {
  const hm = hiringManagerIdOf(req);
  return DEMO_ACCOUNTS.filter((a) => isHrRole(a.role) && a.id !== hm);
}

function isReqDecider(actor: TalentActor, req: Requisition): boolean {
  return isHrRole(actor.role) && !isHiringManagerOf(actor, req);
}

/** Recruiters HR can assign. */
export function recruiterOptions(): DemoAccount[] {
  return DEMO_ACCOUNTS.filter((a) => a.role === "recruiter");
}

function reqFor(s: TalentState, id: string): Requisition | undefined {
  return s.requisitions.find((r) => r.id === id);
}

/** Approved and staffed: candidates can be added and moved. */
export function isRequisitionOpen(req: Requisition): boolean {
  return req.approvalStatus === "Approved" && !!(req.recruiterId || req.recruiter);
}

/** Requisitions in this actor's pipeline: HR sees all; a recruiter the ones assigned to them; a hiring manager their own. */
export function myPipelineRequisitions(actor: TalentActor, reqs: Requisition[]): Requisition[] {
  if (isHrRole(actor.role)) return reqs;
  return reqs.filter((r) => isAssignedRecruiter(actor, r) || isHiringManagerOf(actor, r));
}

/** Local date + time, e.g. "2026-10-27T14:05". */
export function nowStamp(date = new Date()): string {
  return `${localISO(date)}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** Stage history, oldest first. Older records without one get a minimal trail. */
export function candidateHistory(c: Candidate): StageStep[] {
  if (Array.isArray(c.history) && c.history.length) return c.history;
  return backfillHistory(c);
}

function backfillHistory(c: Candidate): StageStep[] {
  const seed = CANDIDATES.find((s) => s.id === c.id);
  if (seed?.history?.length) {
    const upTo = seed.history.findIndex((h) => h.stage === c.stage);
    if (upTo >= 0) return structuredClone(seed.history.slice(0, upTo + 1));
  }
  const on = `${todayISO()}T09:00`;
  const steps: StageStep[] = [{ stage: "Applied", enteredOn: on, by: c.name }];
  if (c.stage !== "Applied") steps.push({ stage: c.stage, enteredOn: on, by: "Recruiting", note: "Recorded before stage history" });
  return steps;
}

function ensureHistory(state: TalentState): TalentState {
  for (const c of state.candidates) if (!Array.isArray(c.history) || !c.history.length) c.history = backfillHistory(c);
  return state;
}

/** Next stage forward (blueprint order), or exit to Rejected / Withdrawn. Hired only once the offer is accepted. */
export function allowedStageMoves(candidate: Candidate, offers: OfferRecord[], req?: Requisition): PipelineStage[] {
  if (CLOSED_STAGES.includes(candidate.stage)) return [];
  if (req && !isRequisitionOpen(req)) return [];
  const next = PIPELINE_STAGES[PIPELINE_STAGES.indexOf(candidate.stage) + 1];
  const moves: PipelineStage[] = [];
  if (next && !EXIT_STAGES.includes(next)) {
    if (next !== "Hired" || hasAcceptedOffer(candidate.id, offers)) moves.push(next);
  }
  return [...moves, ...EXIT_STAGES];
}

/** Moves this actor may make. The recruiter (or HR) runs the pipeline; at Final Review the hiring manager decides. */
export function stageMovesFor(actor: TalentActor, candidate: Candidate, offers: OfferRecord[], req: Requisition | undefined): PipelineStage[] {
  if (!req) return [];
  const moves = allowedStageMoves(candidate, offers, req);
  if (candidate.stage === "Final Review") {
    return moves.filter((m) => (m === "Withdrawn" ? canRunPipeline(actor, req) : isHiringManagerOf(actor, req)));
  }
  return canRunPipeline(actor, req) ? moves : [];
}

function hasAcceptedOffer(candidateId: string, offers: OfferRecord[]): boolean {
  return offers.some((o) => o.candidateId === candidateId && o.status === "Accepted");
}

function pushStep(candidate: Candidate, actor: TalentActor, stage: PipelineStage, note = "") {
  candidate.history = [
    ...candidateHistory(candidate),
    { stage, enteredOn: nowStamp(), by: actor.fullName, byId: actor.id, ...(note.trim() ? { note: note.trim() } : {}) },
  ];
  candidate.stage = stage;
}

export function setCandidateStage(actor: TalentActor, id: string, stage: PipelineStage, note = ""): TalentResult {
  return guarded((s) => {
    const row = s.candidates.find((c) => c.id === id);
    if (!row) return "Candidate not found.";
    const req = reqFor(s, row.requisitionId);
    if (!req) return "Requisition not found.";
    if (!canActOnRequisition(actor, req)) return "Only the assigned recruiter, HR or the hiring manager can move candidates.";
    if (stage === row.stage) return null;
    if (req.approvalStatus !== "Approved") return `${req.id} is ${req.approvalStatus.toLowerCase()}. Candidates can't move until HR approves it.`;
    if (!isRequisitionOpen(req)) return `${req.id} has no recruiter yet.`;
    if (stage === "Hired" && !hasAcceptedOffer(id, s.offers)) return "A candidate can only be hired after accepting an offer.";
    if (!allowedStageMoves(row, s.offers, req).includes(stage)) {
      return CLOSED_STAGES.includes(row.stage)
        ? `${row.name} is already ${row.stage}.`
        : "Candidates move forward one stage at a time (or to Rejected / Withdrawn).";
    }
    if (!stageMovesFor(actor, row, s.offers, req).includes(stage)) {
      return row.stage === "Final Review" && stage !== "Withdrawn"
        ? "The hiring manager makes the Final Review decision."
        : "Only the assigned recruiter or HR runs the pipeline.";
    }
    pushStep(row, actor, stage, note);
    if (stage === "Hired") createJoiner(s, row, req);
    return null;
  });
}

const REQ_TRANSITIONS: Record<ApprovalStatus, ApprovalStatus[]> = {
  Draft: ["Pending approval"],
  "Pending approval": ["Approved", "Rejected", "On hold"],
  // On hold is a parked decision: HR can still approve or reject it.
  "On hold": ["Approved", "Rejected"],
  // HR can pause an approved requisition (e.g. budget review).
  Approved: ["On hold"],
  Rejected: [],
};

/** Raise: the hiring manager. Decide (approve / reject / hold): HR, never the hiring manager. */
export function requisitionMoves(actor: TalentActor, req: Requisition): ApprovalStatus[] {
  return REQ_TRANSITIONS[req.approvalStatus].filter((next) =>
    next === "Pending approval" ? isHiringManagerOf(actor, req) : isReqDecider(actor, req),
  );
}

const REQ_ACTION: Record<ApprovalStatus, string> = {
  Draft: "Saved as draft",
  "Pending approval": "Raised",
  Approved: "Approved",
  Rejected: "Rejected",
  "On hold": "Put on hold",
};

/** Raised-by-manager → HR approved → recruiter assigned, with who and when. */
export function requisitionSteps(req: Requisition): { label: string; done: boolean; by?: string; on?: string }[] {
  const find = (...actions: string[]) => [...(req.history ?? [])].reverse().find((h) => actions.includes(h.action));
  const raised = find("Raised", "Submitted for approval");
  const approved = find("Approved");
  const assigned = find("Recruiter assigned");
  return [
    { label: "Manager raised", done: !!raised, by: raised?.by, on: raised?.on },
    { label: "HR approved", done: !!approved, by: approved?.by, on: approved?.on },
    {
      label: "Recruiter assigned",
      done: !!(req.recruiterId || req.recruiter),
      by: req.recruiter || assigned?.note,
      on: req.recruiterAssignedOn ?? assigned?.on,
    },
  ];
}

export function setRequisitionApproval(actor: TalentActor, id: string, approvalStatus: ApprovalStatus, note = "", recruiterId = DEFAULT_RECRUITER_ID): TalentResult {
  return guarded((s) => {
    const row = reqFor(s, id);
    if (!row) return "Requisition not found.";
    if (row.approvalStatus === approvalStatus) return null;
    if (!REQ_TRANSITIONS[row.approvalStatus].includes(approvalStatus)) {
      return `A requisition cannot move from ${row.approvalStatus} to ${approvalStatus}.`;
    }
    if (approvalStatus !== "Pending approval" && isHiringManagerOf(actor, row)) {
      return "The hiring manager cannot decide their own requisition.";
    }
    if (!requisitionMoves(actor, row).includes(approvalStatus)) {
      return approvalStatus === "Pending approval" ? "Only the hiring manager can raise this requisition." : "Only HR can decide this requisition.";
    }
    const today = todayISO();
    const recruiter = approvalStatus === "Approved" && !row.recruiterId ? recruiterOptions().find((a) => a.id === recruiterId) : undefined;
    if (approvalStatus === "Approved" && !row.recruiterId && !recruiter) return "Choose a recruiter.";
    const step = { on: today, by: actor.fullName, byId: actor.id };
    row.approvalStatus = approvalStatus;
    if (approvalStatus === "Pending approval") row.stageSummary = "Awaiting approval";
    else {
      row.approver = actor.fullName;
      row.decidedOn = today;
      row.stageSummary = approvalStatus === "Approved" ? "Sourcing" : approvalStatus === "On hold" ? "On hold" : "Closed";
    }
    row.history = [...(row.history ?? []), { ...step, action: REQ_ACTION[approvalStatus], ...(note.trim() ? { note: note.trim() } : {}) }];
    if (recruiter) {
      row.recruiter = recruiter.fullName;
      row.recruiterId = recruiter.id;
      row.recruiterAssignedOn = today;
      row.history.push({ ...step, action: "Recruiter assigned", note: recruiter.fullName });
    }
    return null;
  });
}

export type RequisitionInput = { title: string; department: string; country: string; location: string; openings: number };

/** The hiring manager raises a requisition; it goes straight to HR for approval. */
export function raiseRequisition(actor: TalentActor, input: RequisitionInput): TalentResult {
  return guarded((s) => {
    if (!canRaiseRequisition(actor)) return "Only the manager who needs the role can raise a requisition.";
    const title = input.title.trim();
    if (!title) return "Enter a job title.";
    if (!input.department.trim()) return "Enter a department.";
    if (!TIMEZ_COUNTRIES.some((c) => c.name === input.country)) return "Choose a country.";
    if (!input.location.trim()) return "Enter a location.";
    if (!Number.isInteger(input.openings) || input.openings < 1 || input.openings > 50) return "Openings must be 1–50.";
    const next = Math.max(200, ...s.requisitions.map((r) => Number(r.id.replace(/\D/g, "")) || 0)) + 1;
    const today = todayISO();
    s.requisitions.unshift({
      id: `JOB-${next}`,
      title,
      department: input.department.trim(),
      country: input.country,
      location: input.location.trim(),
      openings: input.openings,
      hiringManager: actor.fullName,
      hiringManagerId: actor.id,
      recruiter: "",
      approvalStatus: "Pending approval",
      stageSummary: "Awaiting approval",
      created: today,
      history: [{ on: today, by: actor.fullName, byId: actor.id, action: "Raised" }],
    });
    return null;
  });
}

/* ───────────── Interviews ───────────── */

export type InterviewInput = { when: string; panel: string; type: string };

/** The assigned recruiter (or HR) schedules interviews for candidates at the Interview stage. */
export function scheduleInterview(actor: TalentActor, candidateId: string, input: InterviewInput): TalentResult {
  return guarded((s) => {
    const candidate = s.candidates.find((c) => c.id === candidateId);
    if (!candidate) return "Candidate not found.";
    const req = reqFor(s, candidate.requisitionId);
    if (!req || !canRunPipeline(actor, req)) return "Only the assigned recruiter or HR schedules interviews.";
    if (!isRequisitionOpen(req)) return `${req.id} is not open.`;
    if (candidate.stage !== "Interview") return "Move the candidate to Interview first.";
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(input.when) || input.when <= nowStamp()) return "Choose a future date and time.";
    if (!input.panel.trim()) return "Add the panel.";
    s.interviews.push({
      id: newId("int"),
      candidateId,
      candidateName: candidate.name,
      role: candidate.role,
      when: input.when.replace("T", " "),
      panel: input.panel.trim(),
      type: input.type.trim() || "Interview",
      feedbackStatus: "Pending",
    });
    return null;
  });
}

/* ───────────── Offers ───────────── */

const OFFER_TRANSITIONS: Record<OfferStatus, OfferStatus[]> = {
  Preparing: ["Pending approval", "Withdrawn"],
  "Pending approval": ["Approved", "Preparing", "Withdrawn"],
  Approved: ["Sent", "Withdrawn"],
  Sent: ["Accepted", "Declined", "Withdrawn"],
  Accepted: [],
  Declined: [],
  Withdrawn: [],
};

function parseAmount(text: string): number {
  return Number(text.replace(/[^0-9.]/g, "")) || 0;
}

/** The salary band for the offer's grade and country, if one exists. */
export function bandFor(offer: Pick<OfferRecord, "grade">, req: Pick<Requisition, "country" | "department"> | undefined): GradeBand | undefined {
  if (!req) return undefined;
  const bands = GRADE_BANDS.filter((b) => b.grade === offer.grade && b.country === req.country);
  return bands.find((b) => b.family === req.department) ?? bands[0];
}

/** Above the band's maximum, or no band for this grade and country: Compensation must approve too. */
export function needsCompApproval(offer: Pick<OfferRecord, "grade" | "baseSalary">, req: Pick<Requisition, "country" | "department"> | undefined): boolean {
  const band = bandFor(offer, req);
  return !band || offer.baseSalary > parseAmount(band.max);
}

/** Next approval on a pending offer: hiring manager → HR → Compensation (above band), or null when done. */
export function offerApprovalNeeded(offer: OfferRecord, req: Requisition | undefined): OfferApproval["role"] | null {
  const has = (role: OfferApproval["role"]) => offer.approvals.some((a) => a.role === role);
  if (!has("Hiring manager")) return "Hiring manager";
  if (!has("HR")) return "HR";
  if (needsCompApproval(offer, req) && !has("Compensation")) return "Compensation";
  return null;
}

export function canApproveOffer(actor: TalentActor, offer: OfferRecord, req: Requisition | undefined): boolean {
  if (offer.status !== "Pending approval" || !req) return false;
  if (offer.createdById === actor.id) return false;
  if (offer.approvals.some((a) => a.byId === actor.id)) return false;
  const step = offerApprovalNeeded(offer, req);
  if (step === "Hiring manager") return isHiringManagerOf(actor, req);
  if (step === "HR") return isHrRole(actor.role) && !isHiringManagerOf(actor, req);
  if (step === "Compensation") return actor.role === "compensation_admin" && !isHiringManagerOf(actor, req);
  return false;
}

/** Status moves this actor may make (approval itself goes through approveOffer). */
export function offerMoves(actor: TalentActor, offer: OfferRecord, req: Requisition | undefined): OfferStatus[] {
  if (!req) return [];
  const staff = canRunPipeline(actor, req);
  return OFFER_TRANSITIONS[offer.status].filter((next) => {
    if (next === "Approved") return false;
    if (next === "Preparing") return canApproveOffer(actor, offer, req); // send back
    return staff;
  });
}

function hasOpenOffer(candidateId: string, offers: OfferRecord[]): boolean {
  return offers.some((o) => o.candidateId === candidateId && o.status !== "Declined" && o.status !== "Withdrawn");
}

/** Candidates the hiring manager moved to Offer, without an open offer, on requisitions this actor runs. */
export function offerEligibleCandidates(state: Pick<TalentState, "candidates" | "offers" | "requisitions">, actor?: TalentActor): Candidate[] {
  return state.candidates.filter((c) => {
    if (!OFFER_ELIGIBLE_STAGES.includes(c.stage) || hasOpenOffer(c.id, state.offers)) return false;
    const req = state.requisitions.find((r) => r.id === c.requisitionId);
    return !!req && isRequisitionOpen(req) && (!actor || canRunPipeline(actor, req));
  });
}

export type OfferInput = { candidateId: string; grade: string; baseSalary: number; startDate: string; packageNote: string };

export function createOffer(actor: TalentActor, input: OfferInput): TalentResult {
  return guarded((s) => {
    const candidate = s.candidates.find((c) => c.id === input.candidateId);
    if (!candidate) return "Candidate not found.";
    const req = reqFor(s, candidate.requisitionId);
    if (!req || !canRunPipeline(actor, req)) return "Only the assigned recruiter or HR prepares offers.";
    if (!isRequisitionOpen(req)) return "The requisition is not approved.";
    if (!OFFER_ELIGIBLE_STAGES.includes(candidate.stage)) return "The hiring manager must move the candidate to Offer first.";
    if (hasOpenOffer(candidate.id, s.offers)) return `${candidate.name} already has an open offer.`;
    if (!input.grade) return "Choose a grade.";
    if (!Number.isFinite(input.baseSalary) || input.baseSalary <= 0) return "Enter the annual base salary.";
    if (!input.startDate || input.startDate <= todayISO()) return "Choose a start date in the future.";
    const country = TIMEZ_COUNTRIES.find((c) => c.name === req.country);
    s.offers.push({
      id: newId("off"),
      candidateId: candidate.id,
      candidateName: candidate.name,
      requisitionId: req.id,
      role: candidate.role,
      status: "Preparing",
      grade: input.grade,
      baseSalary: Math.round(input.baseSalary),
      currency: country?.currency ?? "USD",
      startDate: input.startDate,
      packageNote: input.packageNote.trim(),
      createdBy: actor.fullName,
      createdById: actor.id,
      createdOn: todayISO(),
      approvals: [],
    });
    return null;
  });
}

const APPROVAL_REFUSAL: Record<OfferApproval["role"], string> = {
  "Hiring manager": "The hiring manager must agree first.",
  HR: "HR approves after the hiring manager (not the hiring manager themselves).",
  Compensation: "This offer is outside the band and needs Compensation approval.",
};

export function approveOffer(actor: TalentActor, id: string): TalentResult {
  return guarded((s) => {
    const row = s.offers.find((o) => o.id === id);
    if (!row) return "Offer not found.";
    const req = reqFor(s, row.requisitionId);
    if (row.createdById === actor.id) return "You can't approve an offer you created.";
    if (row.approvals.some((a) => a.byId === actor.id)) return "You already approved a step of this offer.";
    const step = offerApprovalNeeded(row, req);
    if (!step || !canApproveOffer(actor, row, req)) return step ? APPROVAL_REFUSAL[step] : "Nothing left to approve.";
    row.approvals.push({ role: step, by: actor.fullName, byId: actor.id, on: todayISO() });
    if (!offerApprovalNeeded(row, req)) row.status = "Approved";
    return null;
  });
}

/** Moves an offer. Accepted / Declined record the candidate's answer and need a note on how it was received. */
export function setOfferStatus(actor: TalentActor, id: string, status: OfferStatus, note = ""): TalentResult {
  return guarded((s) => {
    const row = s.offers.find((o) => o.id === id);
    if (!row) return "Offer not found.";
    const req = reqFor(s, row.requisitionId);
    if (row.status === status) return null;
    if (!OFFER_TRANSITIONS[row.status].includes(status)) return `An offer cannot move from ${row.status} to ${status}.`;
    if (status === "Approved") return "Use Approve.";
    if (!offerMoves(actor, row, req).includes(status)) return "You can't make this change to the offer.";
    if (status === "Accepted" || status === "Declined") {
      if (note.trim().length < 5) return "Say how the candidate's answer was received.";
      row.responseNote = note.trim();
      row.responseRecordedBy = actor.fullName;
      row.respondedOn = todayISO();
    }
    if (status === "Preparing") row.approvals = [];
    row.status = status;
    if (status === "Sent" && !row.sentOn) row.sentOn = todayISO();
    return null;
  });
}

/** Average days from requisition approval to offer acceptance, or null with no hires yet. */
export function averageTimeToHire(state: Pick<TalentState, "offers" | "requisitions">): number | null {
  const days = state.offers
    .filter((o) => o.status === "Accepted" && o.respondedOn)
    .map((o) => {
      const approved = state.requisitions.find((r) => r.id === o.requisitionId)?.history?.find((h) => h.action === "Approved")?.on;
      return approved ? (Date.parse(o.respondedOn!) - Date.parse(approved)) / 86_400_000 : null;
    })
    .filter((d): d is number => d !== null && d >= 0);
  return days.length ? Math.round(days.reduce((a, b) => a + b, 0) / days.length) : null;
}

/** Feedback comes from the panel and the hiring manager. */
export function canSubmitInterviewFeedback(actor: TalentActor, interview: Interview): boolean {
  if (interview.panel.toLowerCase().includes(actor.fullName.trim().toLowerCase())) return true;
  const state = getTalentState();
  const candidate = state.candidates.find((c) => c.id === interview.candidateId);
  const req = candidate ? state.requisitions.find((r) => r.id === candidate.requisitionId) : undefined;
  return !!req && isHiringManagerOf(actor, req);
}

export function submitInterviewFeedback(actor: TalentActor, id: string, score: number, feedback: string): TalentResult {
  return guarded((s) => {
    const row = s.interviews.find((i) => i.id === id);
    if (!row) return "Interview not found.";
    if (!canSubmitInterviewFeedback(actor, row)) return "Only the panel or the hiring manager can submit feedback.";
    if (row.feedbackStatus === "Submitted") return "Feedback for this interview was already submitted.";
    if (!Number.isInteger(score) || score < 1 || score > 5) return "Score must be a whole number from 1 to 5.";
    if (!feedback.trim()) return "Add feedback notes.";
    row.feedbackStatus = "Submitted";
    row.score = score;
    row.feedback = feedback.trim();
    return null;
  });
}

/* ───────────── Onboarding ───────────── */

export function canEditOnboarding(role: UserRole): boolean {
  return role === "recruiter" || isHrRole(role);
}

/** Whoever owns the task: HR, IT (platform admin), the joiner's manager, or the joiner. */
export function isTaskOwner(actor: TalentActor, task: OnboardingTask, joiner: OnboardingJoiner | undefined): boolean {
  if (task.owner === "HR") return isHrRole(actor.role);
  if (task.owner === "IT") return actor.role === "it_admin" || actor.role === "admin";
  if (task.owner === "Manager") return !!joiner && (joiner.managerId === actor.id || sameName(joiner.manager, actor.fullName));
  return !!joiner && (joiner.personId === actor.id || sameName(joiner.name, actor.fullName));
}

/** The owner updates a task; HR may update someone else's task only with a recorded reason. */
export function canEditOnboardingTask(actor: TalentActor, task: OnboardingTask, joiner: OnboardingJoiner | undefined): boolean {
  return isTaskOwner(actor, task, joiner) || isHrRole(actor.role);
}

/** Only the joiner acknowledges policies. */
export function canAcknowledgePolicies(actor: TalentActor, joiner: OnboardingJoiner): boolean {
  return joiner.personId === actor.id || sameName(joiner.name, actor.fullName);
}

/** Progress and overall status come from the checklist, not from stored numbers. */
function deriveJoiners(state: TalentState): TalentState {
  const today = todayISO();
  for (const joiner of state.joiners) {
    const tasks = state.tasks.filter((t) => t.joinerId === joiner.id);
    if (tasks.length === 0) continue;
    const done = tasks.filter((t) => t.status === "Done").length;
    joiner.preboardingPct = Math.round((done / tasks.length) * 100);
    if (done === tasks.length && joiner.policyAck === "Complete") joiner.overallStatus = "Completed";
    else if (joiner.startDate > today) joiner.overallStatus = done === tasks.length ? "Day 1 ready" : "Pre-boarding";
    else joiner.overallStatus = "In progress";
  }
  return state;
}

function addDaysTo(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return localISO(new Date(y, m - 1, d + days));
}

/** A hire becomes a joiner with the standard checklist. */
function createJoiner(s: TalentState, candidate: Candidate, req: Requisition) {
  if (s.joiners.some((j) => j.candidateId === candidate.id)) return;
  const offer = s.offers.find((o) => o.candidateId === candidate.id && o.status === "Accepted");
  const id = newId("ob");
  const startDate = offer?.startDate ?? addDaysTo(todayISO(), 14);
  s.joiners.push({
    id,
    name: candidate.name,
    role: req.title,
    startDate,
    country: req.country,
    manager: req.hiringManager,
    managerId: hiringManagerIdOf(req) ?? "",
    candidateId: candidate.id,
    requisitionId: req.id,
    preboardingPct: 0,
    docsStatus: "Not started",
    policyAck: "Pending",
    overallStatus: "Pre-boarding",
  });
  ONBOARDING_TEMPLATE.forEach((t, i) =>
    s.tasks.push({ id: `${id}-t${i + 1}`, joinerId: id, title: t.title, owner: t.owner, category: t.category, status: "Pending", due: addDaysTo(startDate, t.dueOffset) }),
  );
  const hired = s.candidates.filter((c) => c.requisitionId === req.id && c.stage === "Hired").length;
  if (hired >= req.openings) req.stageSummary = "Filled";
}

/** When onboarding completes, the joiner becomes an employee in the directory (probation runs from the joining date). */
function addToDirectory(s: TalentState, joiner: OnboardingJoiner) {
  if (joiner.personId || joiner.overallStatus !== "Completed") return;
  const candidate = s.candidates.find((c) => c.id === joiner.candidateId);
  const req = s.requisitions.find((r) => r.id === joiner.requisitionId);
  const offer = s.offers.find((o) => o.candidateId === joiner.candidateId && o.status === "Accepted");
  const country = TIMEZ_COUNTRIES.find((c) => c.name === joiner.country) ?? TIMEZ_COUNTRIES[0];
  const department = req?.department ?? "Operations";
  const location = req?.location ?? country.name;
  const [first, ...rest] = joiner.name.toLowerCase().split(/\s+/);
  const person: LocalPersonRecord = {
    id: joiner.id,
    employeeCode: `NJ${joiner.id.replace(/\D/g, "").slice(-4).padStart(4, "0")}`,
    fullName: joiner.name,
    email: `${first}.${rest.join("") || "joiner"}@infotech.com`,
    personalEmail: candidate?.email ?? "",
    mobile: candidate?.phone ?? "",
    photo: "/profile.svg",
    gender: "",
    dateOfJoining: joiner.startDate,
    employmentType: "Full Time",
    employmentStatus: "Active",
    designation: joiner.role,
    jobFamily: department,
    jobProfileId: "",
    positionId: req ? `POS-${req.id}` : "",
    grade: offer?.grade ?? "",
    department,
    division: `${department} Delivery`,
    businessUnit: `Infotech ${country.name}`,
    costCenter: `CC-${country.code}-1`,
    location,
    countryCode: country.code,
    countryName: country.name,
    legalEntity: legalEntityFor(country.code),
    managerId: joiner.managerId,
    managerName: joiner.manager,
    availability: "In Office",
    timeZone: country.timeZone,
    currency: country.currency,
    address: `${location}, ${country.name}`,
  };
  upsertPerson(person);
  joiner.personId = person.id;
}

export function setOnboardingTaskStatus(actor: TalentActor, id: string, status: OnboardingTask["status"], reason = ""): TalentResult {
  return guarded((s) => {
    const row = s.tasks.find((t) => t.id === id);
    if (!row) return "Task not found.";
    const joiner = s.joiners.find((j) => j.id === row.joinerId);
    if (!isTaskOwner(actor, row, joiner)) {
      if (!isHrRole(actor.role)) return `Only the task owner (${row.owner}) can update this task.`;
      if (reason.trim().length < 5) return "Give a reason for updating someone else's task.";
      row.overrideNote = `${actor.fullName}, ${todayISO()}: ${reason.trim()}`;
    }
    row.status = status;
    deriveJoiners(s);
    if (joiner) addToDirectory(s, joiner);
    return null;
  });
}

export function setJoinerPolicyAck(actor: TalentActor, id: string, policyAck: OnboardingJoiner["policyAck"]): TalentResult {
  return guarded((s) => {
    const row = s.joiners.find((j) => j.id === id);
    if (!row) return "Joiner not found.";
    if (!canAcknowledgePolicies(actor, row)) return "Only the new joiner can acknowledge policies.";
    row.policyAck = policyAck;
    if (policyAck === "Complete") {
      s.tasks.forEach((t) => {
        if (t.joinerId === id && t.category === "Policy") t.status = "Done";
      });
    }
    deriveJoiners(s);
    addToDirectory(s, row);
    return null;
  });
}

/* ───────────── Performance ───────────── */

/** The CEO (or anyone with no one above them) is not put through a review. */
export function inReviewCycle(employeeId: string): boolean {
  return managementChain(employeeId, DEMO_ACCOUNTS).length > 0;
}

export function cycleStatusOf(state: Pick<TalentState, "cycleStatus">, cycleId: string): PerfCycle["status"] {
  return state.cycleStatus[cycleId] ?? PERF_CYCLES.find((c) => c.id === cycleId)?.status ?? "Planning";
}

const CYCLE_NEXT: Record<PerfCycle["status"], PerfCycle["status"] | null> = {
  Planning: "Active",
  Active: "Calibration",
  Calibration: "Closed",
  Closed: null,
};

export function nextCycleStatus(status: PerfCycle["status"]): PerfCycle["status"] | null {
  return CYCLE_NEXT[status];
}

/** HR moves a cycle forward one step. */
export function advanceCycle(actor: TalentActor, cycleId: string): TalentResult {
  return guarded((s) => {
    if (!isHrRole(actor.role)) return "Only HR can change the cycle status.";
    const next = CYCLE_NEXT[cycleStatusOf(s, cycleId)];
    if (!next) return "This cycle is closed.";
    s.cycleStatus[cycleId] = next;
    return null;
  });
}

/** Share of self and manager assessments submitted in the cycle. */
export function cycleCompletion(state: Pick<TalentState, "reviews">, cycleId: string): number {
  const rows = state.reviews.filter((r) => r.cycleId === cycleId);
  if (!rows.length) return 0;
  const done = rows.reduce((n, r) => n + Number(r.selfStatus === "Submitted") + Number(r.managerStatus === "Submitted"), 0);
  return Math.round((done / (rows.length * 2)) * 100);
}

/** Yourself, anyone below you, or everyone for HR. */
export function canViewReview(actor: TalentActor, employeeId: string): boolean {
  return canViewEmployeeTalent(actor, employeeId);
}

/** Only people above the employee in the reporting line write the manager assessment and rating. */
export function canWriteManagerReview(actor: TalentActor, employeeId: string): boolean {
  return isAboveInChain(actor.id, employeeId);
}

/** What this viewer may see of the rating: the employee only once it is released. */
export function visibleRating(actor: TalentActor, review: PerfReview): string | undefined {
  if (review.employeeId === actor.id) return review.released ? review.rating : undefined;
  return canViewReview(actor, review.employeeId) ? review.rating : undefined;
}

function reviewFor(s: TalentState, id: string): PerfReview | string {
  const row = s.reviews.find((r) => r.id === id);
  if (!row) return "Review not found.";
  if (!inReviewCycle(row.employeeId)) return `${row.employeeName} is not in the review cycle.`;
  return row;
}

export function saveSelfAssessment(actor: TalentActor, id: string, text: string, submit: boolean): TalentResult {
  return guarded((s) => {
    const row = reviewFor(s, id);
    if (typeof row === "string") return row;
    if (row.employeeId !== actor.id) return "Only the employee can write their self-assessment.";
    if (cycleStatusOf(s, row.cycleId) !== "Active") return "Self-assessments are only open while the cycle is active.";
    if (row.selfStatus === "Submitted") return "Your self-assessment is already submitted.";
    const clean = text.trim();
    if (submit && clean.length < 10) return "Write at least 10 characters before submitting.";
    row.selfText = clean;
    row.selfStatus = submit ? "Submitted" : clean ? "Draft" : "Not started";
    return null;
  });
}

export function saveManagerAssessment(actor: TalentActor, id: string, text: string, submit: boolean): TalentResult {
  return guarded((s) => {
    const row = reviewFor(s, id);
    if (typeof row === "string") return row;
    if (!canWriteManagerReview(actor, row.employeeId)) return "Only someone above the employee in their reporting line can do this.";
    if (cycleStatusOf(s, row.cycleId) !== "Active") return "Manager assessments are only open while the cycle is active.";
    if (row.managerStatus === "Submitted") return "The manager assessment is already submitted.";
    const clean = text.trim();
    if (submit && clean.length < 10) return "Write at least 10 characters before submitting.";
    row.managerText = clean;
    row.managerStatus = submit ? "Submitted" : clean ? "Draft" : "Not started";
    return null;
  });
}

export function set360Status(actor: TalentActor, id: string, status: PerfReview["feedback360Status"]): TalentResult {
  return guarded((s) => {
    const row = reviewFor(s, id);
    if (typeof row === "string") return row;
    if (!canWriteManagerReview(actor, row.employeeId)) return "Only someone above the employee in their reporting line can do this.";
    if (cycleStatusOf(s, row.cycleId) !== "Active") return "360 feedback is only open while the cycle is active.";
    row.feedback360Status = status;
    return null;
  });
}

export function setRating(actor: TalentActor, id: string, rating: string | undefined): TalentResult {
  return guarded((s) => {
    const row = reviewFor(s, id);
    if (typeof row === "string") return row;
    if (!canWriteManagerReview(actor, row.employeeId)) return "Only someone above the employee in their reporting line can rate.";
    const status = cycleStatusOf(s, row.cycleId);
    if (status !== "Active" && status !== "Calibration") return status === "Closed" ? "This cycle is closed." : "Ratings open once the cycle starts.";
    if (row.released) return "This rating is already released.";
    if (rating && !(RATINGS as readonly string[]).includes(rating)) return "Choose a rating.";
    if (rating && row.selfStatus !== "Submitted") return "The employee must submit their self-assessment first.";
    if (rating && row.managerStatus !== "Submitted") return "Submit the manager assessment first.";
    row.rating = rating || undefined;
    return null;
  });
}

export function setDevelopmentPlan(actor: TalentActor, id: string, plan: string): TalentResult {
  return guarded((s) => {
    const row = reviewFor(s, id);
    if (typeof row === "string") return row;
    if (!canWriteManagerReview(actor, row.employeeId)) return "Only someone above the employee in their reporting line can edit the plan.";
    if (cycleStatusOf(s, row.cycleId) === "Closed") return "This cycle is closed.";
    row.developmentPlan = plan.slice(0, 300);
    return null;
  });
}

/** HR shares the calibrated rating with the employee. */
export function releaseRating(actor: TalentActor, id: string): TalentResult {
  return guarded((s) => {
    const row = reviewFor(s, id);
    if (typeof row === "string") return row;
    if (!isHrRole(actor.role)) return "Only HR can release ratings.";
    if (row.employeeId === actor.id) return "Another HR person must release your own rating.";
    if (cycleStatusOf(s, row.cycleId) !== "Calibration") return "Ratings are released during calibration.";
    if (!row.rating) return "There is no rating to release yet.";
    if (row.released) return "Already released.";
    row.released = true;
    row.releasedBy = actor.fullName;
    row.releasedOn = todayISO();
    return null;
  });
}

/* ───────────── Goals ───────────── */

export function canEditGoal(actor: TalentActor, goal: Pick<PerfGoal, "ownerId">): boolean {
  return goal.ownerId === actor.id || isAboveInChain(actor.id, goal.ownerId);
}

export function goalWeightTotal(goals: PerfGoal[], ownerId: string, cycleId: string, skipId?: string): number {
  return goals
    .filter((g) => g.ownerId === ownerId && g.cycleId === cycleId && g.id !== skipId)
    .reduce((sum, g) => sum + (Number(g.weight) || 0), 0);
}

/** People whose goals this actor may set: themselves and everyone below them. */
export function goalOwnerOptions(actor: TalentActor): { id: string; name: string }[] {
  const below = TASK_TEAM.filter((p) => p.id !== actor.id && isAboveInChain(actor.id, p.id)).map((p) => ({ id: p.id, name: p.fullName }));
  return [{ id: actor.id, name: actor.fullName }, ...below];
}

export type GoalInput = Pick<PerfGoal, "ownerId" | "type" | "title" | "target" | "weight" | "period" | "cycleId"> & { id?: string };

export function saveGoal(actor: TalentActor, input: GoalInput): TalentResult {
  return guarded((s) => {
    const owner = goalOwnerOptions(actor).find((o) => o.id === input.ownerId);
    if (!owner) return "You can only set goals for yourself or people below you.";
    if (cycleStatusOf(s, input.cycleId) === "Closed") return "This cycle is closed.";
    const title = input.title.trim();
    if (!title) return "Enter a goal title.";
    if (!input.target.trim()) return "Enter a target.";
    if (!input.period.trim()) return "Enter the period.";
    const weight = Math.round(Number(input.weight));
    if (!Number.isFinite(weight) || weight < 1 || weight > 100) return "Weight must be between 1 and 100.";
    const total = goalWeightTotal(s.goals, input.ownerId, input.cycleId, input.id) + weight;
    if (total > 100) return `Weights would total ${total}%. Keep ${owner.name}'s goals at 100%.`;
    const fields = { ownerId: owner.id, ownerName: owner.name, type: input.type, title, target: input.target.trim(), weight, period: input.period.trim(), cycleId: input.cycleId };
    if (input.id) {
      const row = s.goals.find((g) => g.id === input.id);
      if (!row) return "Goal not found.";
      if (!canEditGoal(actor, row)) return "Only the goal owner or their managers can edit this goal.";
      Object.assign(row, fields);
    } else {
      s.goals.push({ id: newId("g"), progress: 0, ...fields });
    }
    return null;
  });
}

export function updateGoalProgress(actor: TalentActor, id: string, progress: number): TalentResult {
  return guarded((s) => {
    const row = s.goals.find((g) => g.id === id);
    if (!row) return "Goal not found.";
    if (!canEditGoal(actor, row)) return "Only the goal owner or their managers can update progress.";
    if (cycleStatusOf(s, row.cycleId) === "Closed") return "This cycle is closed.";
    row.progress = Math.max(0, Math.min(100, Math.round(progress)));
    return null;
  });
}

/* ───────────── Learning ───────────── */

/** Self-reported progress stops here; the final assessment is confirmed by HR. */
export const SELF_PROGRESS_CAP = 90;
export const PASS_MARK = 70;

type Learner = Pick<DemoAccount, "id" | "fullName" | "role"> & { department?: string };

function hasReports(id: string): boolean {
  return DEMO_ACCOUNTS.some((a) => a.reportsToId === id);
}

/** Audience rules: manager courses for people with reports, hiring courses for people who interview. */
export function courseOpenTo(course: Course, learner: Learner): boolean {
  switch (course.audience) {
    case "All":
      return true;
    case "Managers":
      return hasReports(learner.id);
    case "Hiring":
      return hasReports(learner.id) || learner.role === "recruiter" || learner.role === "hiring_manager" || isHrRole(learner.role);
    case "Engineering":
      return learner.department === "Engineering" || learner.department === "IT";
  }
}

export function enrollInCourse(learner: Learner, courseId: string): TalentResult {
  return guarded((s) => {
    const course = COURSES.find((c) => c.id === courseId);
    if (!course) return "Course not found.";
    if (!courseOpenTo(course, learner)) return `${course.title} is for ${course.audience.toLowerCase()} only.`;
    if (s.enrollments.some((e) => e.courseId === courseId && e.employeeId === learner.id)) return "You are already enrolled.";
    s.enrollments.push({
      id: newId("en"),
      courseId,
      employeeId: learner.id,
      employeeName: learner.fullName,
      status: "Assigned",
      progress: 0,
      due: isoDaysFromToday(ENROLLMENT_DUE_DAYS),
    });
    return null;
  });
}

export function updateEnrollmentProgress(actor: TalentActor, id: string, progress: number): TalentResult {
  return guarded((s) => {
    const row = s.enrollments.find((e) => e.id === id);
    if (!row) return "Enrollment not found.";
    if (row.employeeId !== actor.id) return "You can only update your own learning progress.";
    if (row.status === "Completed") return "Completed courses can only be changed by HR.";
    row.progress = Math.max(0, Math.min(SELF_PROGRESS_CAP, Math.round(progress)));
    row.status = row.progress > 0 ? "In progress" : "Assigned";
    delete row.completedOn;
    return null;
  });
}

/** A certificate is issued only for a real completion: 90%+ progress or a passed assessment. */
export function earnedCertificate(e: Enrollment): boolean {
  return e.status === "Completed" && (e.progress >= SELF_PROGRESS_CAP || (e.assessmentScore ?? -1) >= PASS_MARK);
}

/** HR confirms completion at 90%+ progress, or with a passing assessment score. */
export function completeEnrollment(actor: TalentActor, id: string, score?: number): TalentResult {
  return guarded((s) => {
    const row = s.enrollments.find((e) => e.id === id);
    if (!row) return "Enrollment not found.";
    if (!isHrRole(actor.role) || row.employeeId === actor.id) return "Only HR can confirm completion for someone else.";
    if (row.status === "Completed") return "Already completed.";
    if (score !== undefined) {
      if (!Number.isInteger(score) || score < 0 || score > 100) return "Score must be a whole number from 0 to 100.";
      row.assessmentScore = score;
      if (score < PASS_MARK) return `Below the pass mark of ${PASS_MARK}.`;
    } else if (row.progress < SELF_PROGRESS_CAP) {
      return `Needs ${SELF_PROGRESS_CAP}% progress or an assessment score.`;
    }
    row.progress = 100;
    row.status = "Completed";
    row.completedOn = todayISO();
    return null;
  });
}

/** Self-enrolled courses get a due date so they show up in due-soon / overdue tracking. */
const ENROLLMENT_DUE_DAYS = 30;

function isoDaysFromToday(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return localISO(date);
}

function localISO(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function addYears(iso: string, years: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return localISO(new Date(y + years, m - 1, d));
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}

export function isCertExpired(c: Pick<Certification, "expiresOn">, today = todayISO()): boolean {
  return !!c.expiresOn && c.expiresOn < today;
}

/** The employee records a renewal; it stays pending until HR verifies it. */
export function requestCertificationRenewal(actor: TalentActor, id: string, expiresOn?: string): TalentResult {
  return guarded((s) => {
    const row = s.certifications.find((c) => c.id === id);
    if (!row) return "Certification not found.";
    if (row.employeeId !== actor.id) return "You can only record renewals for your own certifications.";
    if (row.renewalStatus) return "A renewal is already waiting for HR verification.";
    const today = todayISO();
    if (!row.validityYears) {
      if (!expiresOn) return "Enter the new expiry date.";
      if (expiresOn <= today) return "The new expiry date must be in the future.";
    }
    row.renewalStatus = "Pending verification";
    row.renewalRequestedOn = today;
    row.renewalExpiresOn = row.validityYears ? undefined : expiresOn;
    return null;
  });
}

export function verifyCertificationRenewal(actor: TalentActor, id: string): TalentResult {
  return guarded((s) => {
    const row = s.certifications.find((c) => c.id === id);
    if (!row) return "Certification not found.";
    if (!isHrRole(actor.role) || row.employeeId === actor.id) return "Only HR can verify someone else's renewal.";
    if (row.renewalStatus !== "Pending verification") return "There is no renewal waiting for verification.";
    const earnedOn = row.renewalRequestedOn ?? todayISO();
    row.earnedOn = earnedOn;
    if (row.validityYears) row.expiresOn = addYears(earnedOn, row.validityYears);
    else if (row.renewalExpiresOn) row.expiresOn = row.renewalExpiresOn;
    delete row.renewalStatus;
    delete row.renewalRequestedOn;
    delete row.renewalExpiresOn;
    row.verifiedBy = actor.fullName;
    row.verifiedOn = todayISO();
    return null;
  });
}

/** HR confirms a certification with the issuer and records its credential number. */
export function verifyCertification(actor: TalentActor, id: string, credentialId: string): TalentResult {
  return guarded((s) => {
    const row = s.certifications.find((c) => c.id === id);
    if (!row) return "Certification not found.";
    if (!isHrRole(actor.role) || row.employeeId === actor.id) return "Only HR can verify someone else's certification.";
    if (row.verifiedBy) return "Already verified.";
    if (isCertExpired(row)) return "This certification has expired.";
    row.verifiedBy = actor.fullName;
    row.verifiedOn = todayISO();
    if (credentialId.trim()) row.credentialId = credentialId.trim().slice(0, 40);
    return null;
  });
}

/* ───────────── Feedback & praise ───────────── */

const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;
export const DAILY_PRAISE_LIMIT = 10;

function normalizeMessage(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

export function addFeedback(item: Omit<FeedbackItem, "id" | "createdOn" | "createdAt">): TalentResult {
  return guarded((s) => {
    const now = Date.now();
    const today = todayISO();
    const message = normalizeMessage(item.message);
    const duplicate = s.feedback.some(
      (f) =>
        f.fromId === item.fromId &&
        f.toId === item.toId &&
        normalizeMessage(f.message) === message &&
        !!f.createdAt &&
        now - Date.parse(f.createdAt) < DUPLICATE_WINDOW_MS,
    );
    if (duplicate) return "You already sent this message to them in the last 10 minutes.";
    if (item.kind === "Praise") {
      const sentToday = s.feedback.filter((f) => f.kind === "Praise" && f.fromId === item.fromId && f.createdOn === today).length;
      if (sentToday >= DAILY_PRAISE_LIMIT) return `You can post up to ${DAILY_PRAISE_LIMIT} praise messages a day.`;
    }
    s.feedback.unshift({ ...item, id: newId("fb"), createdOn: today, createdAt: new Date(now).toISOString() });
    return null;
  });
}

/** Answer an open feedback request addressed to you: the reply goes privately to the person who asked. */
export function answerFeedbackRequest(actor: TalentActor, requestId: string, message: string): TalentResult {
  return guarded((s) => {
    const request = s.feedback.find((f) => f.id === requestId && f.kind === "Request");
    if (!request) return "Request not found.";
    if (request.toId !== actor.id) return "Only the person asked can answer this request.";
    if (request.status === "Answered") return "This request is already answered.";
    const text = message.trim();
    if (text.length < 10) return "Write at least 10 characters.";
    request.status = "Answered";
    s.feedback.unshift({
      id: newId("fb"),
      kind: "Feedback",
      fromId: request.toId,
      fromName: request.toName,
      toId: request.fromId,
      toName: request.fromName,
      message: text,
      createdOn: todayISO(),
      createdAt: new Date().toISOString(),
    });
    return null;
  });
}

/* ───────────── 1:1 check-ins ───────────── */

function meetingStart(meeting: Pick<OneOnOne, "date" | "time">): number {
  return new Date(`${meeting.date}T${meeting.time || "00:00"}`).getTime();
}

export function isMeetingInFuture(meeting: Pick<OneOnOne, "date" | "time">): boolean {
  return meetingStart(meeting) > Date.now();
}

function isParticipant(actor: TalentActor, meeting: OneOnOne): boolean {
  return actor.id === meeting.managerId || actor.id === meeting.employeeId;
}

export function scheduleOneOnOne(
  actor: TalentActor,
  meeting: Omit<OneOnOne, "id" | "status" | "agenda" | "actionItems" | "notes">,
): { id: string } | { error: string } {
  const id = newId("oo");
  const error = guarded((s) => {
    if (actor.id !== meeting.managerId && actor.id !== meeting.employeeId) return "You can only schedule your own 1:1s.";
    const report = DEMO_ACCOUNTS.find((a) => a.id === meeting.employeeId);
    if (!report || report.reportsToId !== meeting.managerId) return "1:1s are between a manager and a direct report.";
    if (!meeting.date || !meeting.time) return "Choose a date and time.";
    if (!isMeetingInFuture(meeting)) return "Pick a date and time in the future.";
    const people = [meeting.managerId, meeting.employeeId];
    const clash = s.oneOnOnes.some(
      (m) =>
        m.status === "Upcoming" &&
        m.date === meeting.date &&
        m.time === meeting.time &&
        (people.includes(m.managerId) || people.includes(m.employeeId)),
    );
    if (clash) return "There is already a 1:1 in that slot.";
    s.oneOnOnes.push({ ...meeting, id, status: "Upcoming", agenda: [], actionItems: [], notes: "" });
    return null;
  });
  return error ? { error } : { id };
}

export function setOneOnOneStatus(actor: TalentActor, id: string, status: OneOnOne["status"], notes?: string): TalentResult {
  return guarded((s) => {
    const row = s.oneOnOnes.find((m) => m.id === id);
    if (!row) return "Meeting not found.";
    if (!isParticipant(actor, row)) return "Only the two people in this 1:1 can change it.";
    if (status === "Completed" && isMeetingInFuture(row)) return "A 1:1 can only be completed once it has started.";
    if (notes !== undefined) row.notes = notes;
    row.status = status;
    return null;
  });
}

export function updateOneOnOne(actor: TalentActor, id: string, mutator: (meeting: OneOnOne) => void): TalentResult {
  return guarded((s) => {
    const row = s.oneOnOnes.find((m) => m.id === id);
    if (!row) return "Meeting not found.";
    if (!isParticipant(actor, row)) return "Only the two people in this 1:1 can change it.";
    mutator(row);
    return null;
  });
}

export function addCheckInItem(actor: TalentActor, meetingId: string, list: "agenda" | "actionItems", text: string): TalentResult {
  return updateOneOnOne(actor, meetingId, (m) => {
    m[list].push({ id: newId("ci"), text, done: false });
  });
}

export function toggleCheckInItem(actor: TalentActor, meetingId: string, list: "agenda" | "actionItems", itemId: string): TalentResult {
  return updateOneOnOne(actor, meetingId, (m) => {
    const item = m[list].find((i) => i.id === itemId);
    if (item) item.done = !item.done;
  });
}

/* ───────────── Skills ───────────── */

/** The employee's saved skills profile, or their starter profile until they change it. */
export function skillProfileFor(state: Pick<TalentState, "skillProfiles">, employeeId: string): EmployeeSkill[] {
  return state.skillProfiles.find((p) => p.employeeId === employeeId)?.skills ?? starterSkillsFor(employeeId).skills;
}

export function updateEmployeeSkill(
  actor: TalentActor,
  employeeId: string,
  skillId: string,
  patch: Partial<Pick<EmployeeSkill, "level" | "targetLevel">>,
): TalentResult {
  return guarded((s) => {
    if (actor.id !== employeeId) return "You can only edit your own skills profile.";
    let profile = s.skillProfiles.find((p) => p.employeeId === employeeId);
    if (!profile) {
      profile = { employeeId, skills: structuredClone(starterSkillsFor(employeeId).skills) };
      s.skillProfiles.push(profile);
    }
    const skill = profile.skills.find((k) => k.skillId === skillId);
    if (!skill) return "Skill not found.";
    Object.assign(skill, patch);
    return null;
  });
}

export function resetTalentState() {
  localStorage.removeItem(KEY);
  localStorage.removeItem(LEGACY_KEY);
  cache = null;
  listeners.forEach((fn) => fn());
}
