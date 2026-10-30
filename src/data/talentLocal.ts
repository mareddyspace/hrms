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
  LEVEL_RANK,
  PIPELINE_STAGES,
  RATINGS,
  REQUISITIONS,
  SKILL_LIBRARY,
  starterSkillsFor,
  type ApprovalStatus,
  type Candidate,
  type Certification,
  type Course,
  type DevAction,
  type EmployeeSkill,
  type Enrollment,
  type FeedbackItem,
  type Interview,
  type JobPosting,
  type OfferApproval,
  type OfferLetter,
  type Recommendation,
  type RequisitionReason,
  type ScorecardCriterion,
  SCORECARD_CRITERIA,
  type OfferRecord,
  type OfferStatus,
  type OnboardingJoiner,
  type OnboardingTask,
  type PreboardingForm,
  EQUIPMENT_LABEL,
  type OneOnOne,
  type PerfCycle,
  type PerfGoal,
  type PerfReview,
  type PipelineStage,
  type Requisition,
  type Reviewer360,
  type SkillProfile,
  type StageStep,
} from "./talentData.ts";
import { DEMO_ACCOUNTS, managementChain, mentionsRetiredAccount, type DemoAccount } from "../demoAccounts.ts";
import { TIMEZ_COUNTRIES, todayISO, type UserRole } from "../model.ts";
import { legalEntityFor, money } from "../countryPay.ts";
import { offerLetterContent, type LetterFields } from "./letterTemplates.ts";
import { TASK_TEAM } from "./taskTeam.ts";
import { GRADE_BANDS, type GradeBand } from "./rewardData.ts";
import { getPerson, upsertPerson, type LocalPersonRecord } from "./peopleLocal.ts";
import type { EmploymentStatus } from "./peopleData.ts";
import { starterSkills } from "./careerProfile.ts";
import { pushPersonTaskAlert } from "./collabLocal.ts";
import { appendAuditEntries } from "./auditTrail.ts";
import { resolveFlow, workflowVersion, type FlowStep } from "./approvalWorkflows.ts";
import { decideFlowStep, isAllParallel, isWaitingOn, stepText, waitingApproverIds, type SteppedRequest } from "./expenseFlow.ts";
import { API_ENABLED } from "../api/client.ts";
import * as talentApi from "../api/syncTalent.ts";
import * as perfApi from "../api/syncTalentPerf.ts";

// v3: recruiting seed made consistent (approval trails, structured offers, joiners linked to hires).
// v4: manager → HR → recruiter hiring flow and per-candidate stage history.
// v5: the Hiring Manager persona was retired — his requisitions, offers, interviews and joiners moved on.
// v6: Country Managers no longer sign in — their requisitions, panels, offers and joiners moved to a sign-in person
// (India roles: Ram Krishnan; other countries: Jordan Blake, the CEO).
const KEY = "timez.talent.state.v6";
/** v5 data is migrated once: recruiting and onboarding restart from the v6 seed, everything else is kept (and cleaned). */
const LEGACY_KEY = "timez.talent.state.v5";
const OLD_KEYS = ["timez.talent.state.v1", "timez.talent.state.v2", "timez.talent.state.v3", "timez.talent.state.v4"];
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
  /** Review cycles HR created (added to PERF_CYCLES). */
  cycles: PerfCycle[];
};

/** Job posts for the open seeded requisitions (the backend seeds the same ones). */
const SEED_POSTINGS: Record<string, JobPosting> = {
  "JOB-221": {
    id: "post-seed-221", title: "Senior React Engineer", location: "Bengaluru", employmentType: "Full-time", closingDate: "", onCareersSite: true,
    status: "Open", publishedBy: "Sophie Clark", publishedOn: "2026-08-14",
    description: "Build the React front end of our HR platform with a small product team in Bengaluru. You will own features end to end, review code and help shape the design system. We look for 5+ years of React, strong TypeScript and good system design sense.",
  },
  "JOB-218": {
    id: "post-seed-218", title: "HR Business Partner", location: "London", employmentType: "Full-time", closingDate: "", onCareersSite: true,
    status: "Open", publishedBy: "Sophie Clark", publishedOn: "2026-07-30",
    description: "Partner with leaders in our London office on organisation design, employee relations and workforce planning. You will be the first people partner for a fast-growing UK team.",
  },
  "JOB-230": {
    id: "post-seed-230", title: "Product Manager", location: "Bengaluru", employmentType: "Full-time", closingDate: "", onCareersSite: true,
    status: "Open", publishedBy: "Sophie Clark", publishedOn: "2026-10-03",
    description: "Lead product discovery and delivery for the people analytics area. Work with engineering, design and HR customers; run user research and own the roadmap.",
  },
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
    cycles: [],
  };
}

/** Drops data that should never exist: reviews for people with no one above them (the CEO), and records of retired accounts. */
function clean(state: TalentState): TalentState {
  // The Compensation persona was retired: its separate offer step is folded into HR's approval.
  state.offers = state.offers.map((o) => ({ ...o, approvals: o.approvals.filter((a) => (a.role as string) !== "Compensation") }));
  for (const key of ["requisitions", "candidates", "interviews", "joiners", "tasks", "goals", "reviews", "enrollments", "certifications", "feedback", "oneOnOnes", "skillProfiles"] as const) {
    (state as Record<typeof key, unknown[]>)[key] = (state[key] as unknown[]).filter((row) => !mentionsRetiredAccount(row));
  }
  state.reviews = state.reviews.filter((r) => managementChain(r.employeeId, DEMO_ACCOUNTS).length > 0);
  for (const r of state.requisitions) {
    const seed = SEED_POSTINGS[r.id];
    if (seed && r.posting === undefined && r.approvalStatus === "Approved") r.posting = { ...seed, closingDate: addDaysTo(todayISO(), 45) };
  }
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

/*
 * Backend mode (VITE_API_URL): recruiting, onboarding, performance, learning and skills come from the API
 * (in memory only, see src/api/syncTalent*.ts). Feedback and praise, and 1:1s still being planned, stay in
 * this browser; a finished 1:1 is recorded on the server as a check-in.
 */
const MIRRORS = [talentApi.recruitingMirror, perfApi.performanceMirror, perfApi.learningMirror] as const;
if (API_ENABLED) MIRRORS.forEach((m) => m.subscribe(() => listeners.forEach((fn) => fn())));

let composed: { local: TalentState; parts: readonly unknown[]; out: TalentState } | null = null;

/** Stable snapshot for useSyncExternalStore — same reference until data changes. */
export function getTalentState(): TalentState {
  if (!cache) cache = read();
  if (!API_ENABLED) return cache;
  const [rec, perf, learn] = [talentApi.recruitingMirror.get(), perfApi.performanceMirror.get(), perfApi.learningMirror.get()];
  if (composed && composed.local === cache && composed.parts[0] === rec && composed.parts[1] === perf && composed.parts[2] === learn) return composed.out;
  const out: TalentState = {
    ...cache,
    ...rec,
    goals: perf.goals,
    reviews: perf.reviews,
    oneOnOnes: [...cache.oneOnOnes.filter((m) => m.status === "Upcoming"), ...perf.checkIns],
    enrollments: learn.enrollments,
    certifications: learn.certifications,
    skillProfiles: learn.skillProfiles,
    cycles: perf.cycles,
    cycleStatus: Object.fromEntries(perf.cycles.map((c) => [c.id, c.status])),
  };
  composed = { local: cache, parts: [rec, perf, learn], out };
  return out;
}

/** Course catalog: the server's in backend mode, otherwise the built-in one. */
export function courseCatalog(): Course[] {
  return API_ENABLED ? perfApi.learningMirror.get().courses : COURSES;
}

/* Backend mode: a change is sent to the server; its result arrives later. */
let pendingApi: Promise<TalentResult> | null = null;
const claimedApi = new WeakSet<Promise<TalentResult>>();
let apiNotice: string | null = null;

/** Sends the change and returns null at once; the answer goes to talentAction's callback or talentApiNotice. */
function viaApi(send: () => Promise<TalentResult>): TalentResult {
  const p = send();
  pendingApi = p;
  void p.then((error) => {
    if (error && !claimedApi.has(p)) {
      apiNotice = error;
      listeners.forEach((fn) => fn());
    }
  });
  return null;
}

/**
 * Runs a talent change and reports its result. Without the backend this is synchronous, exactly as calling the
 * change directly; in backend mode `done` gets the server's answer (null, or the error message) once it arrives.
 */
export function talentAction(change: () => TalentResult, done: (result: TalentResult) => void): void {
  if (!API_ENABLED) {
    done(change());
    return;
  }
  pendingApi = null;
  const result = change();
  const p = pendingApi as Promise<TalentResult> | null;
  pendingApi = null;
  if (result || !p) {
    done(result);
    return;
  }
  claimedApi.add(p);
  void p.then(done);
}

/** Backend mode: the last server refusal of a change made outside talentAction (e.g. from Approvals). */
export function talentApiNotice(): string | null {
  return apiNotice;
}

export function clearTalentApiNotice() {
  if (!apiNotice) return;
  apiNotice = null;
  listeners.forEach((fn) => fn());
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
  return role === "recruiter" || isHrRole(role);
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
// (HR also signs off offers above band) → recruiter sends and records the answer. Nobody approves their own step.

/** Recruiter assigned when HR approves without picking one. */
export const DEFAULT_RECRUITER_ID = "demo-recruiter";

function accountId(name: string): string | undefined {
  return DEMO_ACCOUNTS.find((a) => sameName(a.fullName, name))?.id;
}

export function hiringManagerIdOf(req: Requisition): string | undefined {
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

const RAISING_ROLES: readonly UserRole[] = ["manager", "executive", "founder", "cofounder"];

/** The manager who needs the role raises the requisition (a recruiter or HR may raise it for them). */
export function canRaiseRequisition(actor: TalentActor): boolean {
  return RAISING_ROLES.includes(actor.role) || canRaiseForOthers(actor);
}

/** A recruiter or HR raises a requisition for the hiring manager they name. */
export function canRaiseForOthers(actor: TalentActor): boolean {
  return actor.role === "recruiter" || isHrRole(actor.role);
}

/** People who can be named hiring manager: managers and executives. */
export function hiringManagerOptions(): DemoAccount[] {
  return DEMO_ACCOUNTS.filter((a) => RAISING_ROLES.includes(a.role));
}

/* Requisition approval follows the "requisition" approval workflow (department head → HR → finance by default),
   fixed when it's raised. Requisitions raised before workflows have a single HR step. */

const NO_LINE_OVERRIDE = () => false;

function hrIdsFor(req: Requisition): string[] {
  const hm = hiringManagerIdOf(req);
  return DEMO_ACCOUNTS.filter((a) => isHrRole(a.role) && a.id !== hm).map((a) => a.id);
}

/** The requisition's approval steps (older requisitions: a single HR step). */
export function requisitionFlowSteps(req: Requisition): FlowStep[] {
  return req.approvalSteps ?? [{ role: "hr", label: "HR approval", approverIds: hrIdsFor(req) }];
}

function reqFlow(req: Requisition): SteppedRequest {
  const open = req.approvalStatus === "Pending approval" || req.approvalStatus === "On hold";
  return {
    employeeId: hiringManagerIdOf(req) ?? "",
    status: open ? "pending" : "closed",
    steps: requisitionFlowSteps(req),
    currentStep: req.currentStep ?? 0,
    stepDecisions: req.stepDecisions ?? [],
  };
}

/** Every approval step is done (a hold after that is a pause HR lifts). */
function approvalComplete(req: Requisition): boolean {
  if (req.approvalSteps) return (req.currentStep ?? 0) >= req.approvalSteps.length;
  return req.approvalStatus === "Approved" || (req.approvalStatus === "On hold" && (req.history ?? []).some((h) => h.action === "Approved"));
}

/** Who decides now: the open step's approvers still to act; HR once approval is complete. Never the hiring manager. */
export function requisitionApprovers(req: Requisition): DemoAccount[] {
  const ids = approvalComplete(req) ? hrIdsFor(req) : waitingApproverIds(reqFlow(req));
  return DEMO_ACCOUNTS.filter((a) => ids.includes(a.id));
}

/** The open approval step, e.g. "HR approval · step 2 of 3" (empty once approval is complete). */
export function requisitionWaitingFor(req: Requisition): string {
  return approvalComplete(req) ? "" : stepText(reqFlow(req));
}

function isReqDecider(actor: TalentActor, req: Requisition): boolean {
  if (isHiringManagerOf(actor, req)) return false;
  if (approvalComplete(req)) return isHrRole(actor.role);
  return isWaitingOn(reqFlow(req), actor.id, NO_LINE_OVERRIDE);
}

/** True when this actor's approval would complete approval (so a recruiter gets assigned). */
export function requisitionApprovalCompletes(actor: TalentActor, req: Requisition): boolean {
  if (approvalComplete(req)) return true;
  const result = decideFlowStep(reqFlow(req), actor, "approved", undefined, NO_LINE_OVERRIDE, todayISO());
  return typeof result !== "string" && result.outcome === "approved";
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
  if (candidate.stage === "Interview") moves.push("Final Review"); // the assessment is optional
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
  if (API_ENABLED) {
    if (stage === "Rejected" && note.trim().length < 3) return "Give a reason to reject.";
    return viaApi(() => talentApi.apiSetCandidateStage(id, stage, note));
  }
  const alerts: Alert[] = [];
  const result = guarded((s) => {
    const row = s.candidates.find((c) => c.id === id);
    if (!row) return "Candidate not found.";
    const req = reqFor(s, row.requisitionId);
    if (!req) return "Requisition not found.";
    if (!canActOnRequisition(actor, req)) return "Only the assigned recruiter, HR or the hiring manager can move candidates.";
    if (stage === row.stage) return null;
    if (stage === "Rejected" && note.trim().length < 3) return "Give a reason to reject.";
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
    if (stage === "Hired") createJoiner(s, row, req, actor);
    const hm = hiringManagerIdOf(req);
    if (stage === "Final Review" && hm && hm !== actor.id) alerts.push({ to: [hm], title: `${row.name} is ready for your decision`, body: `Final Review for ${req.title} (${req.id}).`, href: candidateHref(row.id) });
    if (stage === "Offer" && req.recruiterId && req.recruiterId !== actor.id) alerts.push({ to: [req.recruiterId], title: `Prepare an offer for ${row.name}`, body: `The hiring manager moved ${row.name} to Offer.`, href: candidateHref(row.id) });
    if (row.employeeId && APPLICANT_TEXT[stage]) alerts.push({ to: [row.employeeId], title: `Your application: ${req.title}`, body: APPLICANT_TEXT[stage]!, href: "/internal-jobs" });
    return null;
  });
  if (!result) sendAlerts(alerts);
  return result;
}

/* ───────────── Hiring chain hand-offs ───────────── */

type Alert = { to: string[]; title: string; body: string; href: string };

function sendAlerts(alerts: Alert[]) {
  for (const a of alerts) for (const recipientId of new Set(a.to)) if (recipientId) pushPersonTaskAlert({ recipientId, title: a.title, body: a.body, href: a.href });
}

/** Links that open the right place in Recruiting (the same pages server links map to). */
export function candidateHref(id: string): string {
  return `/recruiting?candidate=${encodeURIComponent(id)}`;
}
export function requisitionHref(id: string): string {
  return `/recruiting?req=${encodeURIComponent(id)}`;
}

const APPLICANT_TEXT: Partial<Record<PipelineStage, string>> = {
  Screening: "Recruiting is reviewing your application.",
  Shortlisted: "You are shortlisted.",
  Interview: "You are invited to interview.",
  Offer: "An offer is being prepared.",
  Rejected: "The team decided not to move forward this time.",
  Hired: "Welcome to your new role.",
};

/** Taking applications: published, not past its closing date, and the requisition is open. */
export function isPostingOpen(req: Requisition, today = todayISO()): boolean {
  return !!req.posting && req.posting.status === "Open" && req.posting.closingDate >= today && isRequisitionOpen(req);
}

/** Job posts on the internal board (everyone) — and the public careers page (onCareersSite). */
export function openPostings(reqs: Requisition[], careersOnly = false): Requisition[] {
  return reqs.filter((r) => isPostingOpen(r) && (!careersOnly || r.posting!.onCareersSite));
}

export function requisitionByPosting(reqs: Requisition[], postingId: string): Requisition | undefined {
  return reqs.find((r) => r.posting?.id === postingId);
}

export type PostingInput = { title: string; description: string; location: string; employmentType: string; closingDate: string; onCareersSite: boolean };

/** The recruiter (or HR) publishes the approved requisition as a job post; publishing again updates (and reopens) it. */
export function publishPosting(actor: TalentActor, reqId: string, input: PostingInput): TalentResult {
  if (API_ENABLED) return viaApi(() => talentApi.apiPublishPosting(reqId, input));
  let alerts: Alert[] = [];
  const result = guarded((s) => {
    const req = reqFor(s, reqId);
    if (!req) return "Requisition not found.";
    if (!canRunPipeline(actor, req)) return "Only the assigned recruiter or HR publishes job posts.";
    if (!isRequisitionOpen(req)) return `${req.id} can be posted once it is approved and has a recruiter.`;
    if (input.title.trim().length < 2) return "Enter the job title.";
    if (input.description.trim().length < 20) return "Write a job description (at least 20 characters).";
    if (!input.location.trim()) return "Enter a location.";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.closingDate) || input.closingDate < todayISO()) return "Choose a closing date that is not in the past.";
    const first = !req.posting;
    req.posting = {
      id: req.posting?.id ?? newId("post"),
      title: input.title.trim(),
      description: input.description.trim(),
      location: input.location.trim(),
      employmentType: input.employmentType.trim() || "Full-time",
      closingDate: input.closingDate,
      onCareersSite: input.onCareersSite,
      status: "Open",
      publishedBy: actor.fullName,
      publishedOn: req.posting?.publishedOn ?? todayISO(),
    };
    req.history = [...(req.history ?? []), { on: todayISO(), by: actor.fullName, byId: actor.id, action: first ? "Posted" : "Post updated" }];
    const hm = hiringManagerIdOf(req);
    if (first && hm && hm !== actor.id) alerts = [{ to: [hm], title: `${req.posting.title} is posted`, body: `Open for applications until ${input.closingDate}${input.onCareersSite ? " (careers page too)" : ""}.`, href: requisitionHref(req.id) }];
    return null;
  });
  if (!result) sendAlerts(alerts);
  return result;
}

export function closePosting(actor: TalentActor, reqId: string): TalentResult {
  if (API_ENABLED) return viaApi(() => talentApi.apiClosePosting(reqId));
  return guarded((s) => {
    const req = reqFor(s, reqId);
    if (!req) return "Requisition not found.";
    if (!canRunPipeline(actor, req)) return "Only the assigned recruiter or HR closes job posts.";
    if (!req.posting || req.posting.status !== "Open") return "This job post is not open.";
    req.posting = { ...req.posting, status: "Closed", closedOn: todayISO() };
    req.history = [...(req.history ?? []), { on: todayISO(), by: actor.fullName, byId: actor.id, action: "Post closed" }];
    return null;
  });
}

export type ApplicationInput = { name: string; email: string; phone: string; coverNote: string; cvFile: File | null };

/** Without the backend, a careers-page application (same browser): the candidate lands at Applied. Returns an error or null. */
export function applyFromCareers(postingId: string, input: ApplicationInput): TalentResult {
  let alerts: Alert[] = [];
  const result = guarded((s) => {
    const req = requisitionByPosting(s.requisitions, postingId);
    if (!req || !isPostingOpen(req) || !req.posting!.onCareersSite) return "This job is not open for applications.";
    const name = input.name.trim();
    const email = input.email.trim().toLowerCase();
    if (name.length < 2) return "Enter your full name.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "Enter a valid email.";
    if (!input.cvFile) return "Attach your CV.";
    if (!/\.(pdf|docx?|txt)$/i.test(input.cvFile.name)) return "Attach your CV as a PDF, DOC, DOCX or TXT file.";
    if (input.cvFile.size > 5 * 1024 * 1024) return "The CV is larger than 5 MB.";
    if (s.candidates.some((c) => c.requisitionId === req.id && c.email.toLowerCase() === email)) return "You've already applied for this job.";
    const id = newId("cand");
    s.candidates.push({
      id, name, email, phone: input.phone.trim(), role: req.title, requisitionId: req.id, stage: "Applied", country: req.country,
      source: "Careers site", experienceYears: 0, skills: [], resumeNote: "", postingId,
      coverNote: input.coverNote.trim() || undefined, cvFilename: input.cvFile.name,
      history: [{ stage: "Applied", enteredOn: nowStamp(), by: name, note: "Applied on the careers page" }],
    });
    if (req.recruiterId) alerts = [{ to: [req.recruiterId], title: `New application: ${name}`, body: `${req.posting!.title} (${req.id}) from the careers page.`, href: candidateHref(id) }];
    return null;
  });
  if (!result) sendAlerts(alerts);
  return result;
}

/** An employee applies from the internal jobs board; the application lands in the job's pipeline (source Internal). */
export function applyInternally(actor: TalentActor, postingId: string, coverNote: string): TalentResult {
  if (API_ENABLED) return viaApi(() => talentApi.apiApplyInternally(postingId, coverNote));
  let alerts: Alert[] = [];
  const result = guarded((s) => {
    const req = requisitionByPosting(s.requisitions, postingId);
    if (!req || !isPostingOpen(req)) return "This job is not open for applications.";
    if (isHiringManagerOf(actor, req)) return "You're the hiring manager for this role.";
    if (req.recruiterId === actor.id) return "You run this role's pipeline.";
    if (coverNote.trim().length > 3000) return "Keep your note under 3000 characters.";
    const person = getPerson(actor.id);
    const email = (person?.email ?? `${actor.id}@timez.com`).toLowerCase();
    if (s.candidates.some((c) => c.requisitionId === req.id && (c.employeeId === actor.id || c.email.toLowerCase() === email))) return "You've already applied.";
    const id = newId("cand");
    s.candidates.push({
      id, name: actor.fullName, email, phone: person?.mobile ?? "", role: req.title, requisitionId: req.id, stage: "Applied",
      country: req.country, source: "Internal", experienceYears: 0, skills: [], postingId, employeeId: actor.id,
      resumeNote: person ? `Internal: ${person.designation}, ${person.department}` : "Internal applicant",
      coverNote: coverNote.trim() || undefined,
      history: [{ stage: "Applied", enteredOn: nowStamp(), by: actor.fullName, byId: actor.id, note: "Applied on the internal jobs board" }],
    });
    const manager = managementChain(actor.id, DEMO_ACCOUNTS)[0]?.id;
    alerts = [
      ...(req.recruiterId ? [{ to: [req.recruiterId], title: `Internal application: ${actor.fullName}`, body: `${req.posting!.title} (${req.id}).`, href: candidateHref(id) }] : []),
      ...(manager && manager !== req.recruiterId ? [{ to: [manager], title: "Internal application", body: `${actor.fullName} applied for ${req.posting!.title}.`, href: "/internal-jobs" }] : []),
    ];
    return null;
  });
  if (!result) sendAlerts(alerts);
  return result;
}

/** Screening decision: shortlist (Applied → Screening → Shortlisted) or reject with a reason; the match score is kept. */
export function screenCandidate(actor: TalentActor, id: string, decision: "shortlist" | "reject", reason: string, matchScore?: number): TalentResult {
  if (API_ENABLED) return viaApi(() => talentApi.apiScreenCandidate(id, decision, reason));
  let alerts: Alert[] = [];
  const result = guarded((s) => {
    const row = s.candidates.find((c) => c.id === id);
    if (!row) return "Candidate not found.";
    const req = reqFor(s, row.requisitionId);
    if (!req || !canRunPipeline(actor, req)) return "Only the assigned recruiter or HR screens candidates.";
    if (!isRequisitionOpen(req)) return `${req.id} is not open.`;
    if (row.stage !== "Applied" && row.stage !== "Screening") return `${row.name} is already past screening (${row.stage}).`;
    if (decision === "reject" && reason.trim().length < 3) return "Give a reason to reject.";
    if (matchScore !== undefined) row.matchScore = matchScore;
    if (row.stage === "Applied") pushStep(row, actor, "Screening", matchScore !== undefined ? `Match ${matchScore}%` : "");
    pushStep(row, actor, decision === "shortlist" ? "Shortlisted" : "Rejected", reason);
    const hm = hiringManagerIdOf(req);
    if (decision === "shortlist" && hm && hm !== actor.id) alerts.push({ to: [hm], title: `${row.name} shortlisted for ${req.title}`, body: matchScore !== undefined ? `Match ${matchScore}%. Interviews come next.` : "Interviews come next.", href: candidateHref(row.id) });
    if (row.employeeId) alerts.push({ to: [row.employeeId], title: `Your application: ${req.title}`, body: APPLICANT_TEXT[decision === "shortlist" ? "Shortlisted" : "Rejected"]!, href: "/internal-jobs" });
    return null;
  });
  if (!result) sendAlerts(alerts);
  return result;
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

/** Raise: the hiring manager. Decide (approve / reject / hold): whoever the open workflow step waits on, never the hiring manager. */
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

type ReqStep = { label: string; done: boolean; by?: string; on?: string };

/** Manager raised → each approval step (or group of a parallel step) → recruiter assigned, with who and when. */
export function requisitionSteps(req: Requisition): ReqStep[] {
  const find = (...actions: string[]) => [...(req.history ?? [])].reverse().find((h) => actions.includes(h.action));
  const raised = find("Raised", "Submitted for approval");
  const assigned = find("Recruiter assigned");
  const approvals: ReqStep[] = [];
  if (!req.approvalSteps) {
    const approved = find("Approved");
    approvals.push({ label: "HR approved", done: !!approved, by: approved?.by, on: approved?.on });
  } else {
    const decisions = req.stepDecisions ?? [];
    req.approvalSteps.forEach((step, index) => {
      const parts = isAllParallel(step) ? step.groups.map((g, gi) => ({ label: g.label, group: gi as number | undefined })) : [{ label: step.label, group: undefined }];
      for (const part of parts) {
        const d = decisions.find((x) => x.step === index && x.decision === "approved" && (part.group === undefined || x.group === part.group));
        approvals.push({ label: part.label, done: !!d, by: d?.byName, on: d?.on });
      }
    });
  }
  return [
    { label: "Manager raised", done: !!raised, by: raised?.by, on: raised?.on },
    ...approvals,
    {
      label: "Recruiter assigned",
      done: !!(req.recruiterId || req.recruiter),
      by: req.recruiter || assigned?.note,
      on: req.recruiterAssignedOn ?? assigned?.on,
    },
  ];
}

type ReqAlert = { to: string[]; title: string; body: string; href?: string };

function sendReqAlerts(alerts: ReqAlert[]) {
  for (const a of alerts) {
    for (const recipientId of new Set(a.to)) {
      if (recipientId) pushPersonTaskAlert({ recipientId, title: a.title, body: a.body, href: a.title === "Requisition to approve" ? "/approvals" : a.href ?? "/recruiting" });
    }
  }
}

/** Fix the workflow steps on a requisition being raised. */
function startReqApproval(row: Requisition) {
  const hm = hiringManagerIdOf(row) ?? "";
  row.approvalSteps = resolveFlow("requisition", hm, { excludeIds: [hm] });
  row.currentStep = 0;
  row.stepDecisions = [];
  row.workflowVersion = workflowVersion("requisition");
}

function assignRecruiter(row: Requisition, recruiter: DemoAccount, stamp: { on: string; by: string; byId: string }) {
  row.recruiter = recruiter.fullName;
  row.recruiterId = recruiter.id;
  row.recruiterAssignedOn = stamp.on;
  row.history.push({ ...stamp, action: "Recruiter assigned", note: recruiter.fullName });
}

/**
 * Raise (hiring manager), approve / reject / hold (the open workflow step's approvers). Approving the last step
 * approves the requisition and assigns the recruiter. Once approved, HR can pause it and lift the pause.
 */
export function setRequisitionApproval(actor: TalentActor, id: string, approvalStatus: ApprovalStatus, note = "", recruiterId = DEFAULT_RECRUITER_ID): TalentResult {
  if (API_ENABLED) return viaApi(() => talentApi.apiSetRequisitionApproval(id, approvalStatus, note, recruiterId));
  let alerts: ReqAlert[] = [];
  const result = guarded((s) => {
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
      if (approvalStatus === "Pending approval") return "Only the hiring manager can raise this requisition.";
      const waiting = requisitionWaitingFor(row);
      return waiting ? `This requisition is waiting for ${waiting.split(" · ")[0]!.toLowerCase()}.` : "Only HR can decide this requisition.";
    }
    const today = todayISO();
    const cleanNote = note.trim();
    const stamp = { on: today, by: actor.fullName, byId: actor.id };
    const log = (action: string) => {
      row.history = [...(row.history ?? []), { ...stamp, action, ...(cleanNote ? { note: cleanNote } : {}) }];
    };
    const hm = hiringManagerIdOf(row) ?? "";
    const pickRecruiter = () => (row.recruiterId ? undefined : recruiterOptions().find((a) => a.id === recruiterId));

    if (approvalStatus === "Pending approval") {
      startReqApproval(row);
      row.approvalStatus = "Pending approval";
      row.stageSummary = "Awaiting approval";
      log(REQ_ACTION["Pending approval"]);
      alerts = [{ to: waitingApproverIds(reqFlow(row)), title: "Requisition to approve", body: `${row.id} · ${row.title} · raised by ${row.hiringManager}` }];
      return null;
    }

    if (approvalStatus === "On hold") {
      row.approvalStatus = "On hold";
      row.approver = actor.fullName;
      row.decidedOn = today;
      row.stageSummary = "On hold";
      log(REQ_ACTION["On hold"]);
      alerts = [{ to: [hm], title: `${row.id} put on hold`, body: `${row.title} · by ${actor.fullName}` }];
      return null;
    }

    // Approval already complete: HR lifts a pause (Approved) or closes it (Rejected).
    if (approvalComplete(row)) {
      const recruiter = approvalStatus === "Approved" ? pickRecruiter() : undefined;
      if (approvalStatus === "Approved" && !row.recruiterId && !recruiter) return "Choose a recruiter.";
      row.approvalStatus = approvalStatus;
      row.approver = actor.fullName;
      row.decidedOn = today;
      row.stageSummary = approvalStatus === "Approved" ? "Sourcing" : "Closed";
      log(REQ_ACTION[approvalStatus]);
      if (recruiter) assignRecruiter(row, recruiter, stamp);
      return null;
    }

    const flow = reqFlow(row);
    const decision = decideFlowStep(flow, actor, approvalStatus === "Approved" ? "approved" : "rejected", cleanNote, NO_LINE_OVERRIDE, today);
    if (typeof decision === "string") return decision;
    const recruiter = decision.outcome === "approved" ? pickRecruiter() : undefined;
    if (decision.outcome === "approved" && !row.recruiterId && !recruiter) return "Choose a recruiter.";
    // Older requisitions get their single HR step saved with the decision.
    row.approvalSteps = decision.steps as FlowStep[];
    row.stepDecisions = [...(row.stepDecisions ?? []), ...decision.entries];
    const labels = decision.entries.map((e) => e.label).join(", ");

    if (decision.outcome === "rejected") {
      row.approvalStatus = "Rejected";
      row.approver = actor.fullName;
      row.decidedOn = today;
      row.stageSummary = "Closed";
      log(`Rejected · ${labels}`);
      alerts = [{ to: [hm], title: `${row.id} rejected`, body: `${row.title} · ${labels} · by ${actor.fullName}${cleanNote ? ` · “${cleanNote}”` : ""}` }];
      return null;
    }
    if (decision.outcome === "waiting" || decision.outcome === "advanced") {
      row.currentStep = decision.currentStep;
      row.approvalStatus = "Pending approval";
      row.stageSummary = "Awaiting approval";
      log(`Approved · ${labels}`);
      if (decision.outcome === "advanced") {
        alerts = [
          { to: waitingApproverIds(reqFlow(row)), title: "Requisition to approve", body: `${row.id} · ${row.title} · ${decision.next?.label ?? ""}` },
          { to: [hm], title: `${row.id} moved on`, body: `${decision.step.label} done by ${actor.fullName}. Now with ${(decision.next?.label ?? "").toLowerCase()}.` },
        ];
      }
      return null;
    }
    // Last step approved.
    row.currentStep = row.approvalSteps.length;
    row.approvalStatus = "Approved";
    row.approver = actor.fullName;
    row.decidedOn = today;
    row.stageSummary = "Sourcing";
    log(REQ_ACTION.Approved);
    if (recruiter) assignRecruiter(row, recruiter, stamp);
    alerts = [
      { to: [hm], title: `${row.id} approved`, body: `${row.title} · recruiter ${row.recruiter}` },
      ...(recruiter ? [{ to: [recruiter.id], title: "Requisition assigned to you", body: `${row.id} · ${row.title}` }] : []),
    ];
    return null;
  });
  if (!result) sendReqAlerts(alerts);
  return result;
}

export type RequisitionInput = {
  title: string;
  department: string;
  country: string;
  location: string;
  openings: number;
  budget?: number;
  reason?: RequisitionReason;
  justification?: string;
  /** A recruiter or HR raising it names the hiring manager. */
  hiringManagerId?: string;
};

/** The hiring manager raises a requisition; it goes to the first approval step (no approvers: approved at once). */
export function raiseRequisition(actor: TalentActor, input: RequisitionInput): TalentResult {
  const forOther = !!input.hiringManagerId && input.hiringManagerId !== actor.id;
  const hm = forOther ? DEMO_ACCOUNTS.find((a) => a.id === input.hiringManagerId) : actor;
  if (forOther && !canRaiseForOthers(actor)) return "Only a recruiter or HR can raise a requisition for another manager.";
  if (!forOther && !RAISING_ROLES.includes(actor.role)) return canRaiseForOthers(actor) ? "Choose the hiring manager." : "Only the manager who needs the role can raise a requisition.";
  if (!hm) return "Choose the hiring manager.";
  if (input.budget !== undefined && (!Number.isFinite(input.budget) || input.budget < 0)) return "Enter the budget as a number.";
  if (API_ENABLED) {
    if (!TIMEZ_COUNTRIES.some((c) => c.name === input.country)) return "Choose a country.";
    return viaApi(() => talentApi.apiRaiseRequisition(input));
  }
  let alerts: ReqAlert[] = [];
  const result = guarded((s) => {
    const title = input.title.trim();
    if (!title) return "Enter a job title.";
    if (!input.department.trim()) return "Enter a department.";
    if (!TIMEZ_COUNTRIES.some((c) => c.name === input.country)) return "Choose a country.";
    if (!input.location.trim()) return "Enter a location.";
    if (!Number.isInteger(input.openings) || input.openings < 1 || input.openings > 50) return "Openings must be 1–50.";
    const next = Math.max(200, ...s.requisitions.map((r) => Number(r.id.replace(/\D/g, "")) || 0)) + 1;
    const today = todayISO();
    const row: Requisition = {
      id: `JOB-${next}`,
      title,
      department: input.department.trim(),
      country: input.country,
      location: input.location.trim(),
      openings: input.openings,
      hiringManager: hm.fullName,
      hiringManagerId: hm.id,
      recruiter: forOther && actor.role === "recruiter" ? actor.fullName : "",
      ...(forOther && actor.role === "recruiter" ? { recruiterId: actor.id, recruiterAssignedOn: today } : {}),
      approvalStatus: "Pending approval",
      stageSummary: "Awaiting approval",
      created: today,
      history: [{ on: today, by: actor.fullName, byId: actor.id, action: "Raised", ...(forOther ? { note: `for ${hm.fullName}` } : {}) }],
      ...(input.budget !== undefined ? { budget: Math.round(input.budget), budgetCurrency: TIMEZ_COUNTRIES.find((c) => c.name === input.country)?.currency } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.justification?.trim() ? { justification: input.justification.trim() } : {}),
      raisedById: actor.id,
      raisedBy: actor.fullName,
    };
    startReqApproval(row);
    if (!row.approvalSteps?.length) {
      const recruiter = recruiterOptions().find((a) => a.id === DEFAULT_RECRUITER_ID) ?? recruiterOptions()[0];
      row.approvalStatus = "Approved";
      row.stageSummary = "Sourcing";
      row.decidedOn = today;
      row.history.push({ on: today, by: actor.fullName, byId: actor.id, action: "Approved", note: "No approver for this requisition" });
      if (recruiter) assignRecruiter(row, recruiter, { on: today, by: actor.fullName, byId: actor.id });
    } else {
      alerts = [{ to: waitingApproverIds(reqFlow(row)), title: "Requisition to approve", body: `${row.id} · ${title} · raised by ${actor.fullName}` }];
    }
    if (forOther) alerts.push({ to: [hm.id], title: `Requisition ${row.id} raised for you`, body: `${title} (${row.location}). Raised by ${actor.fullName}.` });
    s.requisitions.unshift(row);
    return null;
  });
  if (!result) sendReqAlerts(alerts);
  return result;
}

/** Backend mode may add the confirmed CV details and file (ApiCandidateExtras). */
export type CandidateInput = { requisitionId: string; name: string; email: string; source: string; appliedOn: string } & talentApi.ApiCandidateExtras;

/** Requisitions this actor can add candidates to: approved, staffed, and run by them (recruiter or HR). */
export function candidateIntakeRequisitions(actor: TalentActor, reqs: Requisition[]): Requisition[] {
  return reqs.filter((r) => isRequisitionOpen(r) && canRunPipeline(actor, r) && r.stageSummary !== "Filled");
}

/** The recruiter or HR adds a candidate to an approved requisition; they start at the first pipeline stage. */
export function addCandidate(actor: TalentActor, input: CandidateInput): TalentResult {
  if (API_ENABLED) return viaApi(() => talentApi.apiAddCandidate(input));
  return guarded((s) => {
    const req = reqFor(s, input.requisitionId);
    if (!req) return "Choose a requisition.";
    if (!canRunPipeline(actor, req)) return "Only the assigned recruiter or HR can add candidates.";
    if (!isRequisitionOpen(req)) return `${req.id} is not approved yet.`;
    const name = input.name.trim();
    if (name.length < 2) return "Enter the candidate's name.";
    const email = input.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "Enter a valid email.";
    if (s.candidates.some((c) => c.requisitionId === req.id && c.email.toLowerCase() === email)) return `${email} is already on ${req.id}.`;
    if (!input.source.trim()) return "Enter the source.";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.appliedOn) || input.appliedOn > todayISO()) return "Choose an applied date that is not in the future.";
    const stage = PIPELINE_STAGES[0];
    const id = newId("cand");
    s.candidates.push({
      id,
      name,
      email,
      phone: "",
      role: req.title,
      requisitionId: req.id,
      stage,
      country: req.country,
      source: input.source.trim(),
      experienceYears: 0,
      skills: [],
      resumeNote: "",
      history: [{ stage, enteredOn: `${input.appliedOn}T09:00`, by: name, note: `Added by ${actor.fullName} · ${input.source.trim()}` }],
    });
    appendAuditEntries([
      {
        at: new Date().toISOString(),
        actorId: actor.id,
        actorName: actor.fullName,
        entity: "Candidate",
        entityId: id,
        action: "Created",
        changes: [
          { field: "Name", before: "", after: name },
          { field: "Requisition", before: "", after: req.id },
        ],
      },
    ]);
    return null;
  });
}

/* ───────────── Interviews ───────────── */

export type InterviewInput = { when: string; panelIds: string[]; type: string };

/** The assigned recruiter (or HR) schedules interviews for candidates at the Interview stage. */
export function scheduleInterview(actor: TalentActor, candidateId: string, input: InterviewInput): TalentResult {
  if (API_ENABLED) return viaApi(() => talentApi.apiScheduleInterview(candidateId, input));
  let alerts: Alert[] = [];
  const result = guarded((s) => {
    const candidate = s.candidates.find((c) => c.id === candidateId);
    if (!candidate) return "Candidate not found.";
    const req = reqFor(s, candidate.requisitionId);
    if (!req || !canRunPipeline(actor, req)) return "Only the assigned recruiter or HR schedules interviews.";
    if (!isRequisitionOpen(req)) return `${req.id} is not open.`;
    if (candidate.stage !== "Interview") return "Move the candidate to Interview first.";
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(input.when) || input.when <= nowStamp()) return "Choose a future date and time.";
    const panel = DEMO_ACCOUNTS.filter((a) => input.panelIds.includes(a.id));
    if (!panel.length) return "Choose who interviews.";
    const id = newId("int");
    s.interviews.push({
      id,
      candidateId,
      candidateName: candidate.name,
      role: candidate.role,
      when: input.when.replace("T", " "),
      panel: panel.map((a) => a.fullName).join(" · "),
      panelIds: panel.map((a) => a.id),
      type: input.type.trim() || "Interview",
      feedbackStatus: "Pending",
    });
    alerts = [{ to: panel.map((a) => a.id).filter((x) => x !== actor.id), title: `Interview: ${candidate.name}`, body: `${input.type.trim() || "Interview"} for ${req.title} on ${input.when.replace("T", " ")}.`, href: "/recruiting?tab=interviews" }];
    return null;
  });
  if (!result) sendAlerts(alerts);
  return result;
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

/** Above the band's maximum, or no band for this grade and country: HR's approval covers the exception (compensation sits with HR). */
export function needsCompApproval(offer: Pick<OfferRecord, "grade" | "baseSalary">, req: Pick<Requisition, "country" | "department"> | undefined): boolean {
  const band = bandFor(offer, req);
  return !band || offer.baseSalary > parseAmount(band.max);
}

/** Next approval on a pending offer: hiring manager → HR (HR also approves above-band offers), or null when done. */
export function offerApprovalNeeded(offer: OfferRecord, req: Requisition | undefined): OfferApproval["role"] | null {
  void req;
  const has = (role: OfferApproval["role"]) => offer.approvals.some((a) => a.role === role);
  if (!has("Hiring manager")) return "Hiring manager";
  if (!has("HR")) return "HR";
  return null;
}

export function canApproveOffer(actor: TalentActor, offer: OfferRecord, req: Requisition | undefined): boolean {
  if (offer.status !== "Pending approval" || !req) return false;
  if (offer.createdById === actor.id) return false;
  if (offer.approvals.some((a) => a.byId === actor.id)) return false;
  const step = offerApprovalNeeded(offer, req);
  if (step === "Hiring manager") return isHiringManagerOf(actor, req);
  if (step === "HR") return isHrRole(actor.role) && !isHiringManagerOf(actor, req);
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
  if (API_ENABLED) {
    if (!input.grade) return "Choose a grade.";
    if (!Number.isFinite(input.baseSalary) || input.baseSalary <= 0) return "Enter the annual base salary.";
    return viaApi(() => talentApi.apiCreateOffer(input));
  }
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
    const letter = makeOfferLetter(candidate, req, input, country?.currency ?? "USD", country?.code ?? "IN");
    s.offers.push({
      letter,
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
};

/** The Offer letter template filled for the candidate (fields kept in the server's names). */
function makeOfferLetter(candidate: Candidate, req: Requisition, input: OfferInput, currency: string, countryCode: string): OfferLetter {
  const salary = money(Math.round(input.baseSalary), currency);
  const fields: LetterFields = {
    employeeName: candidate.name, employeeCode: "", title: req.title, department: req.department, grade: input.grade,
    joiningDate: input.startDate, lastWorkingDay: "", manager: req.hiringManager, countryCode, countryName: req.country,
    legalEntity: legalEntityFor(countryCode as Parameters<typeof legalEntityFor>[0]), address: "", salary, previousSalary: "",
    effectiveDate: "", details: "", nationality: "", endDate: "", customText: input.packageNote.trim(),
  };
  const content = offerLetterContent(fields);
  return {
    ...content,
    date: todayISO(),
    fields: {
      employee_name: fields.employeeName, title: fields.title, department: fields.department, grade: fields.grade,
      joining_date: fields.joiningDate, manager: fields.manager, country_code: countryCode, country_name: fields.countryName,
      legal_entity: fields.legalEntity, salary,
    },
  };
}

function offerToken(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Accepted: Hired and onboarding starts (an internal applicant's move goes to HR). Declined: nothing else moves. */
function applyOfferAnswer(s: TalentState, row: OfferRecord, accepted: boolean, note: string, by: TalentActor | null, via: "link" | "recorded"): Alert[] {
  row.status = accepted ? "Accepted" : "Declined";
  row.responseNote = note.trim() || undefined;
  row.respondedOn = todayISO();
  row.responseRecordedBy = by?.fullName;
  row.respondedVia = via;
  const candidate = s.candidates.find((c) => c.id === row.candidateId);
  const req = reqFor(s, row.requisitionId);
  if (!candidate || !req) return [];
  const actor: TalentActor = by ?? { id: "", fullName: candidate.name, role: "employee" };
  const alerts: Alert[] = [];
  const hr = DEMO_ACCOUNTS.filter((a) => isHrRole(a.role)).map((a) => a.id);
  if (accepted && candidate.stage === "Offer") {
    pushStep(candidate, actor, "Hired", via === "link" ? "Accepted the offer (answer link)" : "Accepted the offer");
    if (candidate.employeeId) {
      alerts.push({ to: [...hr, hiringManagerIdOf(req) ?? ""], title: `Internal move: ${candidate.name}`, body: `${candidate.name} accepted ${req.title}. Record the transfer in Lifecycle actions.`, href: candidateHref(candidate.id) });
      alerts.push({ to: [candidate.employeeId], title: `Your application: ${req.title}`, body: APPLICANT_TEXT.Hired!, href: "/internal-jobs" });
    } else createJoiner(s, candidate, req, actor);
  }
  alerts.push({
    to: [hiringManagerIdOf(req) ?? "", req.recruiterId ?? ""].filter((x) => x && x !== by?.id),
    title: `${candidate.name} ${accepted ? "accepted" : "declined"} the offer`,
    body: note.trim() || (accepted ? "Onboarding has started." : ""),
    href: candidateHref(candidate.id),
  });
  return alerts;
}

/** The candidate's offer, found by the token in their link (this browser's data without the backend). */
export function offerByToken(token: string): { offer: OfferRecord; req?: Requisition; candidate?: Candidate } | undefined {
  const s = getTalentState();
  const offer = s.offers.find((o) => o.responseToken && o.responseToken === token);
  if (!offer) return undefined;
  return { offer, req: s.requisitions.find((r) => r.id === offer.requisitionId), candidate: s.candidates.find((c) => c.id === offer.candidateId) };
}

/** Without the backend: the candidate accepts or declines through their link. */
export function answerOfferByToken(token: string, accept: boolean, note: string): TalentResult {
  let alerts: Alert[] = [];
  const result = guarded((s) => {
    const row = s.offers.find((o) => o.responseToken && o.responseToken === token);
    if (!row) return "This offer link is not valid.";
    if (row.status !== "Sent") return "This offer is no longer waiting for an answer.";
    alerts = applyOfferAnswer(s, row, accept, note, null, "link");
    return null;
  });
  if (!result) sendAlerts(alerts);
  return result;
}

/** Full link for the candidate's answer page. */
export function offerLink(token: string): string {
  return `${window.location.origin}/offer/${token}`;
}

export function approveOffer(actor: TalentActor, id: string): TalentResult {
  if (API_ENABLED) return viaApi(() => talentApi.apiApproveOffer(id));
  let alerts: Alert[] = [];
  const result = guarded((s) => {
    const row = s.offers.find((o) => o.id === id);
    if (!row) return "Offer not found.";
    const req = reqFor(s, row.requisitionId);
    if (row.createdById === actor.id) return "You can't approve an offer you created.";
    if (row.approvals.some((a) => a.byId === actor.id)) return "You already approved a step of this offer.";
    const step = offerApprovalNeeded(row, req);
    if (!step || !canApproveOffer(actor, row, req)) return step ? APPROVAL_REFUSAL[step] : "Nothing left to approve.";
    row.approvals.push({ role: step, by: actor.fullName, byId: actor.id, on: todayISO() });
    if (!offerApprovalNeeded(row, req)) {
      row.status = "Approved";
      alerts = [{ to: [row.createdById], title: `Offer for ${row.candidateName} approved`, body: "You can send it now.", href: "/recruiting?tab=offers" }];
    } else {
      const hm = req ? hiringManagerIdOf(req) : undefined;
      alerts = [{ to: DEMO_ACCOUNTS.filter((a) => isHrRole(a.role) && a.id !== hm && a.id !== row.createdById).map((a) => a.id), title: `Offer for ${row.candidateName} needs HR approval`, body: `${row.role}, ${row.grade}.`, href: "/recruiting?tab=offers" }];
    }
    return null;
  });
  if (!result) sendAlerts(alerts);
  return result;
}

/** Moves an offer. Accepted / Declined record the candidate's answer and need a note on how it was received. */
export function setOfferStatus(actor: TalentActor, id: string, status: OfferStatus, note = ""): TalentResult {
  if (API_ENABLED) return viaApi(() => talentApi.apiSetOfferStatus(id, status, note));
  let alerts: Alert[] = [];
  const result = guarded((s) => {
    const row = s.offers.find((o) => o.id === id);
    if (!row) return "Offer not found.";
    const req = reqFor(s, row.requisitionId);
    if (row.status === status) return null;
    if (!OFFER_TRANSITIONS[row.status].includes(status)) return `An offer cannot move from ${row.status} to ${status}.`;
    if (status === "Approved") return "Use Approve.";
    if (!offerMoves(actor, row, req).includes(status)) return "You can't make this change to the offer.";
    if (status === "Accepted" || status === "Declined") {
      if (note.trim().length < 5) return "Say how the candidate's answer was received.";
      alerts = applyOfferAnswer(s, row, status === "Accepted", note, actor, "recorded");
      return null;
    }
    if (status === "Preparing") row.approvals = [];
    row.status = status;
    const hm = req ? hiringManagerIdOf(req) : undefined;
    if (status === "Pending approval" && hm) alerts = [{ to: [hm], title: `Offer for ${row.candidateName} needs your agreement`, body: `${row.grade}, start ${row.startDate}.`, href: "/recruiting?tab=offers" }];
    if (status === "Sent") {
      row.sentOn = row.sentOn ?? todayISO();
      row.responseToken = row.responseToken ?? offerToken();
      if (hm && hm !== actor.id) alerts = [{ to: [hm], title: `Offer sent to ${row.candidateName}`, body: `${row.role}, start ${row.startDate}. Waiting for the answer.`, href: candidateHref(row.candidateId) }];
    }
    return null;
  });
  if (!result) sendAlerts(alerts);
  return result;
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
  if (interview.panelIds?.includes(actor.id)) return true;
  if (interview.panel.toLowerCase().includes(actor.fullName.trim().toLowerCase())) return true;
  const state = getTalentState();
  const candidate = state.candidates.find((c) => c.id === interview.candidateId);
  const req = candidate ? state.requisitions.find((r) => r.id === candidate.requisitionId) : undefined;
  return !!req && isHiringManagerOf(actor, req);
}

export type Scorecard = { ratings: Partial<Record<ScorecardCriterion, number>>; recommendation: Recommendation | ""; notes: string };

/** Overall score: the average of the ratings, rounded. */
export function scorecardScore(ratings: Partial<Record<ScorecardCriterion, number>>): number | null {
  const values = SCORECARD_CRITERIA.map((c) => ratings[c]).filter((v): v is number => typeof v === "number");
  return values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null;
}

/** The interview has started (scorecards open then; "pending feedback" counts only these). */
export function interviewStarted(interview: Pick<Interview, "when">, now = nowStamp()): boolean {
  return interview.when.replace(" ", "T").slice(0, 16) <= now;
}

function scorecardError(card: Scorecard): string | null {
  if (SCORECARD_CRITERIA.some((c) => !card.ratings[c] || card.ratings[c]! < 1 || card.ratings[c]! > 5)) return `Rate ${SCORECARD_CRITERIA.join(", ")} from 1 to 5.`;
  if (!card.recommendation) return "Choose a recommendation.";
  if (!card.notes.trim()) return "Add notes for the hiring team.";
  return null;
}

export function submitInterviewFeedback(actor: TalentActor, id: string, card: Scorecard): TalentResult {
  const invalid = scorecardError(card);
  if (invalid) return invalid;
  if (API_ENABLED) return viaApi(() => talentApi.apiSubmitInterviewFeedback(id, card));
  let alerts: Alert[] = [];
  const result = guarded((s) => {
    const row = s.interviews.find((i) => i.id === id);
    if (!row) return "Interview not found.";
    if (!canSubmitInterviewFeedback(actor, row)) return "Only the panel or the hiring manager can submit feedback.";
    if (row.feedbackStatus === "Submitted") return "Feedback for this interview was already submitted.";
    if (!interviewStarted(row)) return "The scorecard opens once the interview has started.";
    row.feedbackStatus = "Submitted";
    row.ratings = { ...card.ratings };
    row.recommendation = card.recommendation as Recommendation;
    row.score = scorecardScore(card.ratings) ?? undefined;
    row.feedback = card.notes.trim();
    row.feedbackBy = actor.fullName;
    const candidate = s.candidates.find((c) => c.id === row.candidateId);
    const req = candidate ? reqFor(s, candidate.requisitionId) : undefined;
    if (req && candidate) alerts = [{ to: [req.recruiterId ?? "", hiringManagerIdOf(req) ?? ""].filter((x) => x && x !== actor.id), title: `Scorecard for ${candidate.name}`, body: `Score ${row.score}/5 · ${row.recommendation}.`, href: candidateHref(candidate.id) }];
    return null;
  });
  if (!result) sendAlerts(alerts);
  return result;
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

/** True when the actor is the joiner themselves. */
export function isJoinerSelf(actor: TalentActor, joiner: OnboardingJoiner): boolean {
  return joiner.personId === actor.id || sameName(joiner.name, actor.fullName);
}

/** The joiner acknowledges policies, or HR records the acknowledgment on their behalf. */
export function canAcknowledgePolicies(actor: TalentActor, joiner: OnboardingJoiner): boolean {
  return isJoinerSelf(actor, joiner) || isHrRole(actor.role);
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

/** A hire becomes a joiner with the standard checklist and a directory record (status Onboarding). HR and the hiring manager are told. */
function createJoiner(s: TalentState, candidate: Candidate, req: Requisition, actor: TalentActor) {
  if (s.joiners.some((j) => j.candidateId === candidate.id)) return;
  const offer = s.offers.find((o) => o.candidateId === candidate.id && o.status === "Accepted");
  const id = newId("ob");
  const startDate = offer?.startDate ?? addDaysTo(todayISO(), 14);
  const joiner: OnboardingJoiner = {
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
  };
  s.joiners.push(joiner);
  ONBOARDING_TEMPLATE.forEach((t, i) =>
    s.tasks.push({
      id: `${id}-t${i + 1}`, joinerId: id, key: t.key, title: t.title, owner: t.owner, category: t.category, status: "Pending",
      due: addDaysTo(startDate, t.dueOffset), dependsOn: [...t.dependsOn],
    }),
  );
  const hired = s.candidates.filter((c) => c.requisitionId === req.id && c.stage === "Hired").length;
  if (hired >= req.openings) req.stageSummary = "Filled";
  saveDirectoryRecord(s, joiner, "Onboarding");
  appendAuditEntries([
    {
      at: new Date().toISOString(),
      actorId: actor.id,
      actorName: actor.fullName,
      entity: "Joiner",
      entityId: id,
      subjectId: joiner.personId,
      action: "Created",
      changes: [
        { field: "Name", before: "", after: joiner.name },
        { field: "Role", before: "", after: joiner.role },
        { field: "Start date", before: "", after: startDate },
      ],
    },
  ]);
  const recipients = new Set([...DEMO_ACCOUNTS.filter((a) => isHrRole(a.role)).map((a) => a.id), joiner.managerId]);
  recipients.delete(actor.id);
  recipients.delete("");
  for (const recipientId of recipients) {
    pushPersonTaskAlert({
      recipientId,
      title: `${joiner.name} hired`,
      body: `${joiner.name} joins as ${joiner.role} on ${startDate}. Onboarding has started.`,
      href: `/onboarding?joiner=${id}`,
    });
  }
}

/**
 * The joiner's directory record. Created with status Onboarding when the candidate is hired,
 * and set to Active once onboarding completes (probation runs from the joining date).
 */
function saveDirectoryRecord(s: TalentState, joiner: OnboardingJoiner, status: "Onboarding" | "Active") {
  const personId = joiner.personId ?? joiner.id;
  const existing = getPerson(personId);
  const employmentStatus: EmploymentStatus = status;
  if (existing) {
    if (existing.employmentStatus !== employmentStatus && existing.employmentStatus !== "Terminated") upsertPerson({ ...existing, employmentStatus });
    joiner.personId = existing.id;
    return;
  }
  const candidate = s.candidates.find((c) => c.id === joiner.candidateId);
  const req = s.requisitions.find((r) => r.id === joiner.requisitionId);
  const offer = s.offers.find((o) => o.candidateId === joiner.candidateId && o.status === "Accepted");
  const country = TIMEZ_COUNTRIES.find((c) => c.name === joiner.country) ?? TIMEZ_COUNTRIES[0];
  const department = req?.department ?? "Operations";
  const location = req?.location ?? country.name;
  const [first, ...rest] = joiner.name.toLowerCase().split(/\s+/);
  const person: LocalPersonRecord = {
    id: personId,
    employeeCode: `NJ${joiner.id.replace(/\D/g, "").slice(-4).padStart(4, "0")}`,
    fullName: joiner.name,
    email: `${first}.${rest.join("") || "joiner"}@timez.com`,
    personalEmail: candidate?.email ?? "",
    mobile: candidate?.phone ?? "",
    photo: "/profile.svg",
    gender: "",
    dateOfJoining: joiner.startDate,
    employmentType: "Full Time",
    employmentStatus,
    designation: joiner.role,
    jobFamily: department,
    jobProfileId: "",
    positionId: req ? `POS-${req.id}` : "",
    grade: offer?.grade ?? "",
    department,
    division: `${department} Delivery`,
    businessUnit: `TimeZ ${country.name}`,
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

/** After a checklist change: make sure the record exists, and activate it the first time onboarding completes. */
function syncJoinerRecord(s: TalentState, joiner: OnboardingJoiner, before: OnboardingJoiner["overallStatus"], actor: TalentActor) {
  deriveJoiners(s);
  const completed = joiner.overallStatus === "Completed";
  saveDirectoryRecord(s, joiner, completed ? "Active" : "Onboarding");
  if (!completed || before === "Completed") return;
  appendAuditEntries([
    {
      at: new Date().toISOString(),
      actorId: actor.id,
      actorName: actor.fullName,
      entity: "Joiner",
      entityId: joiner.id,
      subjectId: joiner.personId,
      action: "Updated",
      changes: [
        { field: "Onboarding", before, after: "Completed" },
        { field: "Employment status", before: "Onboarding", after: "Active" },
      ],
    },
  ]);
}

export function setOnboardingTaskStatus(actor: TalentActor, id: string, status: OnboardingTask["status"], reason = ""): TalentResult {
  if (API_ENABLED) return viaApi(() => talentApi.apiSetOnboardingTaskStatus(id, status, reason));
  return guarded((s) => {
    const row = s.tasks.find((t) => t.id === id);
    if (!row) return "Task not found.";
    const joiner = s.joiners.find((j) => j.id === row.joinerId);
    if (!isTaskOwner(actor, row, joiner)) {
      if (!isHrRole(actor.role)) return `Only the task owner (${row.owner}) can update this task.`;
      if (reason.trim().length < 5) return "Give a reason for updating someone else's task.";
      row.overrideNote = `${actor.fullName}, ${todayISO()}: ${reason.trim()}`;
    }
    if (status !== "Pending" && row.dependsOn?.length) {
      const waiting = s.tasks.filter((t) => t.joinerId === row.joinerId && t.key && row.dependsOn!.includes(t.key) && t.status !== "Done");
      if (waiting.length) return `Finish first: ${waiting.map((t) => t.title).join(", ")}.`;
    }
    const before = joiner?.overallStatus ?? "Pre-boarding";
    row.status = status;
    if (joiner) syncJoinerRecord(s, joiner, before, actor);
    return null;
  });
}

/**
 * Pre-boarding form (the joiner or HR): kept on the joiner; each equipment item and the IT request becomes an IT task
 * (once — sending the form again updates the open tasks). The laptop uses the checklist's own laptop task.
 */
export function submitPreboarding(actor: TalentActor, joinerId: string, form: PreboardingForm): TalentResult {
  if (form.emergencyContact.name.trim().length < 2 || form.emergencyContact.phone.trim().length < 5)
    return "Add an emergency contact name and phone.";
  if (API_ENABLED) return viaApi(() => talentApi.apiSubmitPreboarding(joinerId, form));
  return guarded((s) => {
    const joiner = s.joiners.find((j) => j.id === joinerId);
    if (!joiner) return "Joiner not found.";
    if (!canAcknowledgePolicies(actor, joiner)) return "Only the new joiner or HR can fill in the pre-boarding form.";
    if (joiner.overallStatus === "Completed") return "Onboarding is already complete.";
    joiner.preboarding = structuredClone(form);
    joiner.preboardingOn = todayISO();
    const mine = s.tasks.filter((t) => t.joinerId === joinerId);
    const hasLaptop = mine.some((t) => t.key === "laptop");
    const wanted: { key: string; title: string; category: OnboardingTask["category"]; offset: number; dependsOn: string[] }[] =
      form.equipment
        .filter((item) => !(item === "laptop" && hasLaptop))
        .map((item) => ({ key: `equip_${item}`, title: `Equipment: ${EQUIPMENT_LABEL[item]}`, category: "Equipment", offset: -2, dependsOn: [] }));
    if (form.itRequest.systems.length || form.itRequest.notes?.trim())
      wanted.push({
        key: "it_request",
        title: `IT provisioning: ${form.itRequest.systems.join(", ") || "see notes"}`,
        category: "Accounts",
        offset: -1,
        dependsOn: mine.some((t) => t.key === "it_account") ? ["it_account"] : [],
      });
    for (const w of wanted) {
      const task = mine.find((t) => t.key === w.key);
      if (!task)
        s.tasks.push({
          id: newId("ot"), joinerId, key: w.key, title: w.title, owner: "IT", category: w.category, status: "Pending",
          due: addDaysTo(joiner.startDate, w.offset), dependsOn: w.dependsOn,
        });
      else if (task.status !== "Done") task.title = w.title;
    }
    syncJoinerRecord(s, joiner, joiner.overallStatus, actor);
    return null;
  });
}

/** The joiner acknowledges policies themselves, or HR records it for them (kept with the date and "recorded by HR"). */
export function setJoinerPolicyAck(actor: TalentActor, id: string, policyAck: OnboardingJoiner["policyAck"]): TalentResult {
  if (API_ENABLED) {
    if (policyAck !== "Complete") return "A recorded acknowledgment can't be undone.";
    return viaApi(() => talentApi.apiAcknowledgePolicies(id));
  }
  return guarded((s) => {
    const row = s.joiners.find((j) => j.id === id);
    if (!row) return "Joiner not found.";
    if (!canAcknowledgePolicies(actor, row)) return "Only the new joiner or HR can record the policy acknowledgment.";
    const before = row.overallStatus;
    row.policyAck = policyAck;
    if (policyAck === "Complete") {
      row.policyAckOn = todayISO();
      row.policyAckBy = actor.fullName;
      row.policyAckByHr = !isJoinerSelf(actor, row);
      s.tasks.forEach((t) => {
        if (t.joinerId === id && t.category === "Policy") t.status = "Done";
      });
    } else {
      delete row.policyAckOn;
      delete row.policyAckBy;
      delete row.policyAckByHr;
    }
    syncJoinerRecord(s, row, before, actor);
    return null;
  });
}

/* ───────────── Performance ───────────── */

/** The CEO (or anyone with no one above them) is not put through a review. */
export function inReviewCycle(employeeId: string): boolean {
  return managementChain(employeeId, DEMO_ACCOUNTS).length > 0;
}

export function cycleStatusOf(state: Pick<TalentState, "cycleStatus"> & Partial<Pick<TalentState, "cycles">>, cycleId: string): PerfCycle["status"] {
  if (API_ENABLED) return state.cycleStatus[cycleId] ?? state.cycles?.find((c) => c.id === cycleId)?.status ?? "Planning";
  return (
    state.cycleStatus[cycleId] ??
    PERF_CYCLES.find((c) => c.id === cycleId)?.status ??
    state.cycles?.find((c) => c.id === cycleId)?.status ??
    "Planning"
  );
}

/** Built-in cycles plus the ones HR created, each with its current status. */
export function allCycles(state: Pick<TalentState, "cycleStatus" | "cycles">): PerfCycle[] {
  if (API_ENABLED) return state.cycles.map((c) => ({ ...c, status: cycleStatusOf(state, c.id) }));
  return [...PERF_CYCLES, ...(state.cycles ?? [])].map((c) => ({ ...c, status: cycleStatusOf(state, c.id) }));
}

export type CycleInput = { name: string; start: string; end: string; selfReviewDue: string; managerReviewDue: string };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** HR creates a review cycle (it starts in Planning). Everyone with a manager gets a review in it. */
export function createReviewCycle(actor: TalentActor, input: CycleInput): TalentResult {
  if (API_ENABLED) {
    if (!isHrRole(actor.role)) return "Only HR can create review cycles.";
    if (input.name.trim().length < 3) return "Enter a cycle name.";
    if (![input.start, input.end, input.selfReviewDue, input.managerReviewDue].every((d) => ISO_DATE.test(d))) return "Fill in all four dates.";
    return viaApi(() => perfApi.apiCreateCycle(input));
  }
  return guarded((s) => {
    if (!isHrRole(actor.role)) return "Only HR can create review cycles.";
    const name = input.name.trim();
    if (name.length < 3) return "Enter a cycle name.";
    if ([...PERF_CYCLES, ...s.cycles].some((c) => sameName(c.name, name))) return "A cycle with this name already exists.";
    const dates = [input.start, input.end, input.selfReviewDue, input.managerReviewDue];
    if (!dates.every((d) => ISO_DATE.test(d))) return "Fill in all four dates.";
    if (input.end <= input.start) return "The end date must be after the start date.";
    if (input.selfReviewDue < input.start || input.selfReviewDue > input.end) return "Self-review due must fall within the cycle.";
    if (input.managerReviewDue < input.selfReviewDue || input.managerReviewDue > input.end) return "Manager review is due after self-review and before the cycle ends.";
    const id = newId("cyc");
    s.cycles.push({
      id,
      name,
      status: "Planning",
      start: input.start,
      end: input.end,
      selfReviewDue: input.selfReviewDue,
      managerReviewDue: input.managerReviewDue,
      createdBy: actor.fullName,
    });
    DEMO_ACCOUNTS.filter((a) => inReviewCycle(a.id) && !mentionsRetiredAccount(a)).forEach((a, i) =>
      s.reviews.push({
        id: `${id}-r${i + 1}`,
        employeeId: a.id,
        employeeName: a.fullName,
        cycleId: id,
        selfStatus: "Not started",
        managerStatus: "Not started",
        feedback360Status: "Not started",
        finalDecisionNote: "",
      }),
    );
    return null;
  });
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
  if (API_ENABLED) return viaApi(() => perfApi.apiAdvanceCycle(cycleId));
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

/** Manager assessment and rating: the direct manager only (skip-level managers and HR may view, not write). */
export function canAssessAsManager(actor: TalentActor, employeeId: string): boolean {
  return employeeId !== actor.id && managementChain(employeeId, DEMO_ACCOUNTS)[0]?.id === actor.id;
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
  if (API_ENABLED) return viaApi(() => perfApi.apiSaveAssessment(id, "self", text, submit));
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
  if (API_ENABLED) return viaApi(() => perfApi.apiSaveAssessment(id, "manager", text, submit));
  return guarded((s) => {
    const row = reviewFor(s, id);
    if (typeof row === "string") return row;
    if (!canAssessAsManager(actor, row.employeeId)) return "Only the employee's direct manager can write the manager assessment.";
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
  if (API_ENABLED) return "The 360 status follows the reviewers' answers.";
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
  if (API_ENABLED) return viaApi(() => perfApi.apiSetRating(id, rating));
  return guarded((s) => {
    const row = reviewFor(s, id);
    if (typeof row === "string") return row;
    if (!canAssessAsManager(actor, row.employeeId)) return "Only the employee's direct manager can propose a rating.";
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

/* ───────────── 360 feedback ───────────── */

export const MAX_360_REVIEWERS = 3;

/** The employee or someone above them picks the 360 reviewers. */
export function canNominate360(actor: TalentActor, review: Pick<PerfReview, "employeeId">): boolean {
  return review.employeeId === actor.id || canWriteManagerReview(actor, review.employeeId);
}

/** 360 answers are read by the employee's managers and HR (never the employee). */
export function canSee360Responses(actor: TalentActor, review: Pick<PerfReview, "employeeId">): boolean {
  if (review.employeeId === actor.id) return false;
  return isHrRole(actor.role) || canWriteManagerReview(actor, review.employeeId);
}

/** People who can be nominated: anyone who signs in, except the employee and anyone already nominated. */
export function reviewer360Options(review: PerfReview): DemoAccount[] {
  const taken = new Set((review.reviewers360 ?? []).map((r) => r.reviewerId));
  return DEMO_ACCOUNTS.filter((a) => a.id !== review.employeeId && !taken.has(a.id) && !mentionsRetiredAccount(a));
}

/** Open 360 requests addressed to this person. */
export function pending360For(state: Pick<TalentState, "reviews" | "cycleStatus" | "cycles">, reviewerId: string): { review: PerfReview; reviewer: Reviewer360 }[] {
  const out: { review: PerfReview; reviewer: Reviewer360 }[] = [];
  for (const review of state.reviews) {
    if (cycleStatusOf(state, review.cycleId) === "Closed") continue;
    const reviewer = review.reviewers360?.find((r) => r.reviewerId === reviewerId && !r.respondedOn);
    if (reviewer) out.push({ review, reviewer });
  }
  return out;
}

export function nominate360Reviewer(actor: TalentActor, reviewId: string, reviewerId: string): TalentResult {
  if (API_ENABLED) return viaApi(() => perfApi.apiNominate360(reviewId, reviewerId));
  return guarded((s) => {
    const row = reviewFor(s, reviewId);
    if (typeof row === "string") return row;
    if (!canNominate360(actor, row)) return "Only the employee or their manager can nominate reviewers.";
    const status = cycleStatusOf(s, row.cycleId);
    if (status === "Closed" || status === "Calibration") return "360 nominations are closed for this cycle.";
    const list = row.reviewers360 ?? [];
    if (list.length >= MAX_360_REVIEWERS) return `Up to ${MAX_360_REVIEWERS} reviewers.`;
    const person = reviewer360Options(row).find((a) => a.id === reviewerId);
    if (!person) return "Choose a reviewer.";
    row.reviewers360 = [...list, { reviewerId: person.id, reviewerName: person.fullName, nominatedBy: actor.fullName, nominatedOn: todayISO() }];
    if (row.feedback360Status === "Not started") row.feedback360Status = "In progress";
    pushPersonTaskAlert({
      recipientId: person.id,
      title: "360 feedback requested",
      body: `Please give 360 feedback for ${row.employeeName}.`,
      href: "/evaluations",
    });
    return null;
  });
}

/** Removes a nominee who has not answered yet. */
export function remove360Reviewer(actor: TalentActor, reviewId: string, reviewerId: string): TalentResult {
  if (API_ENABLED) return viaApi(() => perfApi.apiRemove360(reviewId, reviewerId));
  return guarded((s) => {
    const row = reviewFor(s, reviewId);
    if (typeof row === "string") return row;
    if (!canNominate360(actor, row)) return "Only the employee or their manager can change reviewers.";
    const entry = row.reviewers360?.find((r) => r.reviewerId === reviewerId);
    if (!entry) return "Reviewer not found.";
    if (entry.respondedOn) return "This reviewer has already answered.";
    row.reviewers360 = (row.reviewers360 ?? []).filter((r) => r.reviewerId !== reviewerId);
    return null;
  });
}

/** A nominee answers: a 1–5 rating and a comment. The 360 is complete once every nominee has answered. */
export function submit360Response(actor: TalentActor, reviewId: string, rating: number, comment: string): TalentResult {
  if (API_ENABLED) {
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return "Rating must be 1 to 5.";
    if (comment.trim().length < 5) return "Add a short comment.";
    return viaApi(() => perfApi.apiAnswer360(reviewId, rating, comment.slice(0, 600)));
  }
  return guarded((s) => {
    const row = reviewFor(s, reviewId);
    if (typeof row === "string") return row;
    const entry = row.reviewers360?.find((r) => r.reviewerId === actor.id);
    if (!entry) return "You were not asked for 360 feedback on this review.";
    if (entry.respondedOn) return "You already answered.";
    if (cycleStatusOf(s, row.cycleId) === "Closed") return "This cycle is closed.";
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return "Rating must be 1 to 5.";
    const text = comment.trim();
    if (text.length < 5) return "Add a short comment.";
    entry.rating = rating;
    entry.comment = text.slice(0, 600);
    entry.respondedOn = todayISO();
    if ((row.reviewers360 ?? []).every((r) => r.respondedOn)) row.feedback360Status = "Complete";
    return null;
  });
}

/* ───────────── Development plan ───────────── */

export const DEV_ACTION_STATUSES: readonly DevAction["status"][] = ["Not started", "In progress", "Done"];

/** The plan's actions. Older reviews with a single text plan show it as the first action. */
export function devActionsOf(review: Pick<PerfReview, "id" | "devActions" | "developmentPlan">): DevAction[] {
  if (review.devActions) return review.devActions;
  const text = review.developmentPlan?.trim();
  return text ? [{ id: `${review.id}-a1`, title: text, due: "", status: "Not started" }] : [];
}

/** The employee and anyone above them keep the plan up to date. */
export function canEditDevPlan(actor: TalentActor, review: Pick<PerfReview, "employeeId">): boolean {
  return review.employeeId === actor.id || canWriteManagerReview(actor, review.employeeId);
}

function devPlanFor(s: TalentState, actor: TalentActor, reviewId: string): PerfReview | string {
  const row = reviewFor(s, reviewId);
  if (typeof row === "string") return row;
  if (!canEditDevPlan(actor, row)) return "Only the employee or their manager can edit the plan.";
  if (cycleStatusOf(s, row.cycleId) === "Closed") return "This cycle is closed.";
  row.devActions = structuredClone(devActionsOf(row));
  return row;
}

export function addDevAction(actor: TalentActor, reviewId: string, input: { title: string; due: string }): TalentResult {
  if (API_ENABLED) {
    if (input.title.trim().length < 3) return "Enter the action.";
    if (input.due && !ISO_DATE.test(input.due)) return "Choose a valid due date.";
    return viaApi(() => perfApi.apiAddDevAction(reviewId, { title: input.title.trim().slice(0, 160), due: input.due }));
  }
  return guarded((s) => {
    const row = devPlanFor(s, actor, reviewId);
    if (typeof row === "string") return row;
    const title = input.title.trim();
    if (title.length < 3) return "Enter the action.";
    if (input.due && !ISO_DATE.test(input.due)) return "Choose a valid due date.";
    if ((row.devActions ?? []).length >= 12) return "Up to 12 actions.";
    row.devActions = [...(row.devActions ?? []), { id: newId("da"), title: title.slice(0, 160), due: input.due, status: "Not started" }];
    return null;
  });
}

export function updateDevAction(
  actor: TalentActor,
  reviewId: string,
  actionId: string,
  patch: Partial<Pick<DevAction, "title" | "due" | "status">>,
): TalentResult {
  if (API_ENABLED) {
    if (patch.title !== undefined && patch.title.trim().length < 3) return "Enter the action.";
    if (patch.due && !ISO_DATE.test(patch.due)) return "Choose a valid due date.";
    return viaApi(() => perfApi.apiUpdateDevAction(actionId, patch));
  }
  return guarded((s) => {
    const row = devPlanFor(s, actor, reviewId);
    if (typeof row === "string") return row;
    const action = row.devActions?.find((a) => a.id === actionId);
    if (!action) return "Action not found.";
    if (patch.title !== undefined) {
      if (patch.title.trim().length < 3) return "Enter the action.";
      action.title = patch.title.trim().slice(0, 160);
    }
    if (patch.due !== undefined) {
      if (patch.due && !ISO_DATE.test(patch.due)) return "Choose a valid due date.";
      action.due = patch.due;
    }
    if (patch.status !== undefined) {
      if (!DEV_ACTION_STATUSES.includes(patch.status)) return "Choose a status.";
      action.status = patch.status;
    }
    return null;
  });
}

export function removeDevAction(actor: TalentActor, reviewId: string, actionId: string): TalentResult {
  if (API_ENABLED) return viaApi(() => perfApi.apiRemoveDevAction(actionId));
  return guarded((s) => {
    const row = devPlanFor(s, actor, reviewId);
    if (typeof row === "string") return row;
    if (!row.devActions?.some((a) => a.id === actionId)) return "Action not found.";
    row.devActions = row.devActions.filter((a) => a.id !== actionId);
    return null;
  });
}

/** HR shares the calibrated rating with the employee. */
export function releaseRating(actor: TalentActor, id: string): TalentResult {
  if (API_ENABLED) return viaApi(() => perfApi.apiReleaseRating(id));
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
  if (API_ENABLED) {
    if (!input.title.trim()) return "Enter a goal title.";
    if (!input.target.trim()) return "Enter a target.";
    const weight = Math.round(Number(input.weight));
    if (!Number.isFinite(weight) || weight < 1 || weight > 100) return "Weight must be between 1 and 100.";
    return viaApi(() => perfApi.apiSaveGoal({ ...input, weight }));
  }
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
  if (API_ENABLED) return viaApi(() => perfApi.apiGoalProgress(id, progress));
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
      return hasReports(learner.id) || learner.role === "recruiter" || isHrRole(learner.role);
    case "Engineering":
      return learner.department === "Engineering" || learner.department === "IT";
  }
}

export function enrollInCourse(learner: Learner, courseId: string): TalentResult {
  if (API_ENABLED) {
    if (!courseCatalog().some((c) => c.id === courseId)) return "Course not found.";
    return viaApi(() => perfApi.apiEnroll(courseId, isoDaysFromToday(ENROLLMENT_DUE_DAYS)));
  }
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
  if (API_ENABLED) return viaApi(() => perfApi.apiEnrollmentProgress(id, Math.min(SELF_PROGRESS_CAP, progress)));
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
  if (API_ENABLED) {
    const row = getTalentState().enrollments.find((e) => e.id === id);
    if (!row) return "Enrollment not found.";
    if (score !== undefined) {
      if (!Number.isInteger(score) || score < 0 || score > 100) return "Score must be a whole number from 0 to 100.";
      if (score < PASS_MARK) return `Below the pass mark of ${PASS_MARK}.`;
    } else if (row.progress < SELF_PROGRESS_CAP) {
      return `Needs ${SELF_PROGRESS_CAP}% progress or an assessment score.`;
    }
    return viaApi(() => perfApi.apiCompleteEnrollment(id, score));
  }
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

/** Backend mode: renewals and HR verification are not kept on the server yet. */
const CERT_CHECKS_OFFLINE = "Certification renewals and verification aren't available on the server yet.";

/** The employee records a renewal; it stays pending until HR verifies it. */
export function requestCertificationRenewal(actor: TalentActor, id: string, expiresOn?: string): TalentResult {
  if (API_ENABLED) return CERT_CHECKS_OFFLINE;
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
  if (API_ENABLED) return CERT_CHECKS_OFFLINE;
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
  if (API_ENABLED) return CERT_CHECKS_OFFLINE;
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

/** Backend mode: check-ins recorded on the server (they can't be changed). */
const SAVED_CHECK_IN = "This check-in is saved on the server and can't be changed.";

function isServerCheckIn(id: string): boolean {
  return API_ENABLED && perfApi.performanceMirror.get().checkIns.some((m) => m.id === id);
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
  if (API_ENABLED) {
    if (isServerCheckIn(id)) return SAVED_CHECK_IN;
    if (status === "Completed") {
      const row = read().oneOnOnes.find((m) => m.id === id);
      if (!row) return "Meeting not found.";
      if (!isParticipant(actor, row)) return "Only the two people in this 1:1 can change it.";
      if (isMeetingInFuture(row)) return "A 1:1 can only be completed once it has started.";
      // Recorded on the server as a check-in; the planning copy in this browser is then removed.
      return viaApi(async () => {
        const error = await perfApi.apiRecordCheckIn(row, notes ?? row.notes);
        if (!error) updateTalent((s) => void (s.oneOnOnes = s.oneOnOnes.filter((m) => m.id !== id)));
        return error;
      });
    }
  }
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
  if (API_ENABLED && isServerCheckIn(id)) return SAVED_CHECK_IN;
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

/** Proficiency levels, lowest first. */
export const SKILL_LEVELS: readonly string[] = Object.keys(LEVEL_RANK);

/** The starting list before the person edits it: department-based, the same one the profile page shows. */
function startingSkills(employeeId: string): EmployeeSkill[] {
  const person = getPerson(employeeId);
  return structuredClone(person ? starterSkills(person) : starterSkillsFor(employeeId).skills);
}

/** The employee's saved skills profile, or their starting list until they change it. */
export function skillProfileFor(state: Pick<TalentState, "skillProfiles">, employeeId: string): EmployeeSkill[] {
  return state.skillProfiles.find((p) => p.employeeId === employeeId)?.skills ?? startingSkills(employeeId);
}

function ownProfile(s: TalentState, employeeId: string): SkillProfile {
  let profile = s.skillProfiles.find((p) => p.employeeId === employeeId);
  if (!profile) {
    profile = { employeeId, skills: startingSkills(employeeId) };
    s.skillProfiles.push(profile);
  }
  return profile;
}

/** Backend mode: apply the change to a copy of my profile, then save it on the server. */
function saveSkillsViaApi(actor: TalentActor, employeeId: string, change: (skills: EmployeeSkill[]) => TalentResult): TalentResult {
  if (actor.id !== employeeId) return "You can only edit your own skills profile.";
  const before = skillProfileFor(getTalentState(), employeeId);
  const next = structuredClone(before);
  const error = change(next);
  if (error) return error;
  return viaApi(() => perfApi.apiSaveMySkills(employeeId, before, next));
}

export function updateEmployeeSkill(
  actor: TalentActor,
  employeeId: string,
  skillId: string,
  patch: Partial<Pick<EmployeeSkill, "level" | "targetLevel" | "years" | "lastUsed" | "evidenceUrl">>,
): TalentResult {
  const detailError = skillDetailError(patch);
  if (detailError) return detailError;
  if (API_ENABLED) {
    return saveSkillsViaApi(actor, employeeId, (skills) => {
      if (patch.level !== undefined && !SKILL_LEVELS.includes(patch.level)) return "Choose a level.";
      if (patch.targetLevel !== undefined && !SKILL_LEVELS.includes(patch.targetLevel)) return "Choose a target level.";
      const skill = skills.find((k) => k.skillId === skillId);
      if (!skill) return "Skill not found.";
      Object.assign(skill, patch);
      return null;
    });
  }
  return guarded((s) => {
    if (actor.id !== employeeId) return "You can only edit your own skills profile.";
    if (patch.level !== undefined && !SKILL_LEVELS.includes(patch.level)) return "Choose a level.";
    if (patch.targetLevel !== undefined && !SKILL_LEVELS.includes(patch.targetLevel)) return "Choose a target level.";
    const skill = ownProfile(s, employeeId).skills.find((k) => k.skillId === skillId);
    if (!skill) return "Skill not found.";
    Object.assign(skill, patch);
    return null;
  });
}

export type SkillDetails = Partial<Pick<EmployeeSkill, "targetLevel" | "years" | "lastUsed" | "evidenceUrl">>;

/** Checks years, last used and the evidence link. */
function skillDetailError(d: SkillDetails): string | null {
  if (d.years !== undefined && (!Number.isFinite(d.years) || d.years < 0 || d.years > 50)) return "Years must be between 0 and 50.";
  if (d.lastUsed && !/^\d{4}-(0[1-9]|1[0-2])$/.test(d.lastUsed)) return "Choose the month you last used it.";
  if (d.lastUsed && d.lastUsed > new Date().toISOString().slice(0, 7)) return "Last used can't be in the future.";
  if (d.evidenceUrl && !/^https?:\/\/\S+$/.test(d.evidenceUrl)) return "The evidence link must start with http:// or https://.";
  if (d.targetLevel !== undefined && !SKILL_LEVELS.includes(d.targetLevel)) return "Choose a target level.";
  return null;
}

/** Adds a skill to your own profile: a library skill by name, or a new one. */
export function addEmployeeSkill(actor: TalentActor, employeeId: string, name: string, level: string, details: SkillDetails = {}): TalentResult {
  const detailError = skillDetailError(details);
  if (detailError) return detailError;
  const extras = (rank: number): Pick<EmployeeSkill, "targetLevel"> & SkillDetails => ({
    targetLevel: details.targetLevel ?? SKILL_LEVELS[Math.min(SKILL_LEVELS.length - 1, rank + 1)],
    ...(details.years !== undefined ? { years: details.years } : {}),
    ...(details.lastUsed ? { lastUsed: details.lastUsed } : {}),
    ...(details.evidenceUrl ? { evidenceUrl: details.evidenceUrl } : {}),
  });
  if (API_ENABLED) {
    return saveSkillsViaApi(actor, employeeId, (skills) => {
      const clean = name.trim().replace(/\s+/g, " ");
      if (clean.length < 2) return "Enter a skill name.";
      if (!SKILL_LEVELS.includes(level)) return "Choose a level.";
      if (skills.some((k) => sameName(k.skillName, clean))) return `${clean} is already on your profile.`;
      if (skills.length >= 20) return "Up to 20 skills.";
      const def = SKILL_LIBRARY.find((d) => sameName(d.name, clean));
      const rank = SKILL_LEVELS.indexOf(level);
      const skillName = def?.name ?? clean.slice(0, 40);
      skills.push({ skillId: perfApi.skillIdFor(skillName), skillName, level, ...extras(rank) });
      return null;
    });
  }
  return guarded((s) => {
    if (actor.id !== employeeId) return "You can only edit your own skills profile.";
    const clean = name.trim().replace(/\s+/g, " ");
    if (clean.length < 2) return "Enter a skill name.";
    if (!SKILL_LEVELS.includes(level)) return "Choose a level.";
    const profile = ownProfile(s, employeeId);
    if (profile.skills.some((k) => sameName(k.skillName, clean))) return `${clean} is already on your profile.`;
    if (profile.skills.length >= 20) return "Up to 20 skills.";
    const def = SKILL_LIBRARY.find((d) => sameName(d.name, clean));
    const rank = SKILL_LEVELS.indexOf(level);
    profile.skills.push({
      skillId: def?.id ?? `sk-own-${clean.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      skillName: def?.name ?? clean.slice(0, 40),
      level,
      ...extras(rank),
    });
    return null;
  });
}

export function removeEmployeeSkill(actor: TalentActor, employeeId: string, skillId: string): TalentResult {
  if (API_ENABLED) {
    return saveSkillsViaApi(actor, employeeId, (skills) => {
      const at = skills.findIndex((k) => k.skillId === skillId);
      if (at < 0) return "Skill not found.";
      skills.splice(at, 1);
      return null;
    });
  }
  return guarded((s) => {
    if (actor.id !== employeeId) return "You can only edit your own skills profile.";
    const profile = ownProfile(s, employeeId);
    if (!profile.skills.some((k) => k.skillId === skillId)) return "Skill not found.";
    profile.skills = profile.skills.filter((k) => k.skillId !== skillId);
    return null;
  });
}

export function resetTalentState() {
  localStorage.removeItem(KEY);
  localStorage.removeItem(LEGACY_KEY);
  cache = null;
  listeners.forEach((fn) => fn());
}

/* ───────────── Career interests ───────────── */

export const CAREER_TIMEFRAMES = ["Next 6 months", "6–12 months", "1–2 years", "2+ years"] as const;
export type CareerTimeframe = (typeof CAREER_TIMEFRAMES)[number];

/** Functions someone can say they would like to work in (matches role tracks and requisition departments). */
export const CAREER_FUNCTIONS = ["Engineering", "People", "Talent Acquisition", "Total Rewards", "Product", "IT", "Leadership"] as const;

export interface CareerInterests {
  employeeId: string;
  /** TARGET_ROLES ids. */
  targetRoleIds: string[];
  functions: string[];
  openToRelocation: boolean;
  timeframe: CareerTimeframe;
  note: string;
  updatedOn: string;
}

const INTERESTS_KEY = "timez.career.interests.v1";
let interestsCache: CareerInterests[] | null = null;

function readInterests(): CareerInterests[] {
  try {
    const raw = localStorage.getItem(INTERESTS_KEY);
    const saved = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(saved) ? (saved as CareerInterests[]).filter((i) => i && typeof i.employeeId === "string") : [];
  } catch {
    return [];
  }
}

/** Stable snapshot for useSyncExternalStore (subscribe with subscribeTalent). */
export function getCareerInterestsList(): CareerInterests[] {
  if (!interestsCache) interestsCache = readInterests();
  return interestsCache;
}

export function careerInterestsFor(employeeId: string, list: CareerInterests[] = getCareerInterestsList()): CareerInterests | undefined {
  return list.find((i) => i.employeeId === employeeId);
}

/** The employee, anyone above them, and HR can see career interests. */
export function canViewCareerInterests(actor: TalentActor, employeeId: string): boolean {
  return canViewEmployeeTalent(actor, employeeId);
}

/** Career interests the actor may see for other people: their reporting line, or everyone for HR. */
export function visibleCareerInterests(actor: TalentActor, list: CareerInterests[] = getCareerInterestsList()): CareerInterests[] {
  return list.filter((i) => i.employeeId !== actor.id && canViewCareerInterests(actor, i.employeeId));
}

export type CareerInterestsInput = Pick<CareerInterests, "targetRoleIds" | "functions" | "openToRelocation" | "timeframe" | "note">;

export function saveCareerInterests(actor: TalentActor, input: CareerInterestsInput, validRoleIds: readonly string[]): TalentResult {
  const roles = [...new Set(input.targetRoleIds)];
  const functions = [...new Set(input.functions)];
  const note = input.note.trim();
  if (!roles.length && !functions.length) return "Pick at least one target role or function.";
  if (roles.length > 3) return "Pick up to 3 target roles.";
  if (roles.some((id) => !validRoleIds.includes(id))) return "One of the roles is no longer available.";
  if (functions.some((f) => !(CAREER_FUNCTIONS as readonly string[]).includes(f))) return "Choose functions from the list.";
  if (!CAREER_TIMEFRAMES.includes(input.timeframe)) return "Choose a timeframe.";
  if (note.length > 500) return "Keep the note under 500 characters.";
  const list = getCareerInterestsList();
  const before = careerInterestsFor(actor.id, list);
  const next: CareerInterests = {
    employeeId: actor.id,
    targetRoleIds: roles,
    functions,
    openToRelocation: !!input.openToRelocation,
    timeframe: input.timeframe,
    note,
    updatedOn: todayISO(),
  };
  const updated = [...list.filter((i) => i.employeeId !== actor.id), next];
  try {
    localStorage.setItem(INTERESTS_KEY, JSON.stringify(updated));
  } catch {
    return "Could not save. Please try again.";
  }
  interestsCache = updated;
  listeners.forEach((fn) => fn());
  const managerId = managementChain(actor.id, DEMO_ACCOUNTS)[0]?.id;
  if (managerId) {
    try {
      pushPersonTaskAlert({
        recipientId: managerId,
        title: "Career interests updated",
        body: `${actor.fullName} updated their career interests (${next.timeframe}).`,
        href: "/skills",
      });
    } catch {
      // Notifications are best-effort.
    }
  }
  appendAuditEntries([
    {
      at: new Date().toISOString(),
      actorId: actor.id,
      actorName: actor.fullName,
      entity: "Career interests",
      entityId: actor.id,
      subjectId: actor.id,
      action: before ? "Updated" : "Created",
      changes: [
        { field: "Target roles", before: before?.targetRoleIds.join(", ") ?? "", after: roles.join(", ") },
        { field: "Functions", before: before?.functions.join(", ") ?? "", after: functions.join(", ") },
        { field: "Open to relocation", before: before ? (before.openToRelocation ? "Yes" : "No") : "", after: next.openToRelocation ? "Yes" : "No" },
        { field: "Timeframe", before: before?.timeframe ?? "", after: next.timeframe },
      ].filter((c) => c.before !== c.after),
    },
  ]);
  return null;
}

/** The review whose development plan the person can add to now: the latest one in a cycle that isn't closed. */
export function openDevPlanReview(state: Pick<TalentState, "reviews" | "cycleStatus" | "cycles">, employeeId: string): PerfReview | undefined {
  const startOf = (cycleId: string) => allCycles(state).find((c) => c.id === cycleId)?.start ?? "";
  return state.reviews
    .filter((r) => r.employeeId === employeeId && cycleStatusOf(state, r.cycleId) !== "Closed")
    .sort((a, b) => startOf(b.cycleId).localeCompare(startOf(a.cycleId)))[0];
}
