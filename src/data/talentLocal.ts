import {
  CANDIDATES,
  CERTIFICATIONS,
  CLOSED_STAGES,
  DEFAULT_EMPLOYEE_SKILLS,
  ENROLLMENTS,
  EXIT_STAGES,
  FEEDBACK_ITEMS,
  INTERVIEWS,
  OFFER_ELIGIBLE_STAGES,
  OFFERS,
  ONBOARDING_JOINERS,
  ONE_ON_ONES,
  ONBOARDING_TASKS,
  PERF_GOALS,
  PERF_REVIEWS,
  PIPELINE_STAGES,
  REQUISITIONS,
  type ApprovalStatus,
  type Candidate,
  type Certification,
  type EmployeeSkill,
  type Enrollment,
  type FeedbackItem,
  type Interview,
  type OfferRecord,
  type OnboardingJoiner,
  type OnboardingTask,
  type OneOnOne,
  type PerfGoal,
  type PerfReview,
  type PipelineStage,
  type Requisition,
  type SkillProfile,
} from "./talentData.ts";
import { DEMO_ACCOUNTS, managementChain, type DemoAccount } from "../demoAccounts.ts";
import { todayISO, type UserRole } from "../model.ts";

const KEY = "timez.talent.state.v1";

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
  };
}

function read(): TalentState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return deriveJoiners(defaults());
    const saved = JSON.parse(raw) as Partial<Record<keyof TalentState, unknown>>;
    const base = defaults();
    // Keep only saved lists that are still lists; anything damaged or from an older version falls back to defaults.
    for (const key of Object.keys(base) as (keyof TalentState)[]) {
      if (Array.isArray(saved?.[key])) (base as Record<keyof TalentState, unknown>)[key] = saved[key];
    }
    return deriveJoiners(base);
  } catch {
    return deriveJoiners(defaults());
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

/** Manager chain or HR — never the employee themselves. */
export function canManageEmployee(actor: TalentActor, employeeId: string): boolean {
  if (employeeId === actor.id) return false;
  return isHrRole(actor.role) || isAboveInChain(actor.id, employeeId);
}

export function canViewEmployeeTalent(actor: TalentActor, employeeId: string): boolean {
  return actor.id === employeeId || canManageEmployee(actor, employeeId);
}

function sameName(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/* ───────────── Recruiting ───────────── */

/** Next stage forward, or exit to Rejected / Withdrawn. Hired only once the offer is accepted. */
export function allowedStageMoves(candidate: Candidate, offers: OfferRecord[]): PipelineStage[] {
  if (CLOSED_STAGES.includes(candidate.stage)) return [];
  const next = PIPELINE_STAGES[PIPELINE_STAGES.indexOf(candidate.stage) + 1];
  const moves: PipelineStage[] = [];
  if (next && !EXIT_STAGES.includes(next)) {
    if (next !== "Hired" || hasAcceptedOffer(candidate.id, offers)) moves.push(next);
  }
  return [...moves, ...EXIT_STAGES];
}

function hasAcceptedOffer(candidateId: string, offers: OfferRecord[]): boolean {
  return offers.some((o) => o.candidateId === candidateId && o.status === "Accepted");
}

export function setCandidateStage(actor: TalentActor, id: string, stage: PipelineStage): TalentResult {
  return guarded((s) => {
    if (!canEditRecruiting(actor.role)) return "Only recruiters, HR and hiring managers can move candidates.";
    const row = s.candidates.find((c) => c.id === id);
    if (!row) return "Candidate not found.";
    if (stage === row.stage) return null;
    if (stage === "Hired" && !hasAcceptedOffer(id, s.offers)) return "A candidate can only be hired after accepting an offer.";
    if (!allowedStageMoves(row, s.offers).includes(stage)) {
      return CLOSED_STAGES.includes(row.stage)
        ? `${row.name} is already ${row.stage}.`
        : "Candidates move forward one stage at a time (or to Rejected / Withdrawn).";
    }
    row.stage = stage;
    return null;
  });
}

const REQ_TRANSITIONS: Record<ApprovalStatus, ApprovalStatus[]> = {
  Draft: ["Pending approval"],
  "Pending approval": ["Approved", "Rejected", "On hold"],
  // On hold is a parked decision: HR can still approve or reject it.
  "On hold": ["Approved", "Rejected"],
  Approved: [],
  Rejected: [],
};

/** Statuses this actor may move the requisition to. Decisions are HR-only and never by the req's own hiring manager. */
export function requisitionMoves(actor: TalentActor, req: Requisition): ApprovalStatus[] {
  return REQ_TRANSITIONS[req.approvalStatus].filter((next) =>
    next === "Pending approval"
      ? canEditRecruiting(actor.role)
      : isHrRole(actor.role) && !sameName(req.hiringManager, actor.fullName),
  );
}

export function setRequisitionApproval(actor: TalentActor, id: string, approvalStatus: ApprovalStatus): TalentResult {
  return guarded((s) => {
    const row = s.requisitions.find((r) => r.id === id);
    if (!row) return "Requisition not found.";
    if (row.approvalStatus === approvalStatus) return null;
    if (!REQ_TRANSITIONS[row.approvalStatus].includes(approvalStatus)) {
      return `A requisition cannot move from ${row.approvalStatus} to ${approvalStatus}.`;
    }
    if (approvalStatus !== "Pending approval" && sameName(row.hiringManager, actor.fullName)) {
      return "The hiring manager cannot approve their own requisition.";
    }
    if (!requisitionMoves(actor, row).includes(approvalStatus)) {
      return approvalStatus === "Pending approval"
        ? "Only recruiting staff can submit a requisition for approval."
        : "Only HR can decide on a requisition.";
    }
    row.approvalStatus = approvalStatus;
    return null;
  });
}

const OFFER_TRANSITIONS: Record<OfferRecord["status"], OfferRecord["status"][]> = {
  Preparing: ["Sent", "Withdrawn"],
  Sent: ["Accepted", "Declined", "Withdrawn"],
  Accepted: [],
  Declined: [],
  Withdrawn: [],
};

export function offerMoves(offer: OfferRecord): OfferRecord["status"][] {
  return OFFER_TRANSITIONS[offer.status];
}

function hasOpenOffer(candidateId: string, offers: OfferRecord[]): boolean {
  return offers.some((o) => o.candidateId === candidateId && o.status !== "Declined" && o.status !== "Withdrawn");
}

/** Candidates at Final Review / Offer without an open offer. */
export function offerEligibleCandidates(state: Pick<TalentState, "candidates" | "offers">): Candidate[] {
  return state.candidates.filter(
    (c) => OFFER_ELIGIBLE_STAGES.includes(c.stage) && !hasOpenOffer(c.id, state.offers),
  );
}

export function createOffer(actor: TalentActor, candidateId: string, packageNote: string): TalentResult {
  return guarded((s) => {
    if (!canEditRecruiting(actor.role)) return "Only recruiters, HR and hiring managers can prepare offers.";
    const candidate = s.candidates.find((c) => c.id === candidateId);
    if (!candidate) return "Candidate not found.";
    if (!OFFER_ELIGIBLE_STAGES.includes(candidate.stage)) return "Offers can only be prepared at Final Review or Offer stage.";
    if (hasOpenOffer(candidateId, s.offers)) return `${candidate.name} already has an open offer.`;
    if (!packageNote.trim()) return "Add a package note.";
    s.offers.push({
      id: newId("off"),
      candidateId,
      candidateName: candidate.name,
      role: candidate.role,
      status: "Preparing",
      packageNote: packageNote.trim(),
    });
    if (candidate.stage === "Final Review") candidate.stage = "Offer";
    return null;
  });
}

export function setOfferStatus(actor: TalentActor, id: string, status: OfferRecord["status"]): TalentResult {
  return guarded((s) => {
    if (!canEditRecruiting(actor.role)) return "Only recruiters, HR and hiring managers can update offers.";
    const row = s.offers.find((o) => o.id === id);
    if (!row) return "Offer not found.";
    if (row.status === status) return null;
    if (!OFFER_TRANSITIONS[row.status].includes(status)) return `An offer cannot move from ${row.status} to ${status}.`;
    row.status = status;
    if (status === "Sent" && !row.sentOn) row.sentOn = todayISO();
    return null;
  });
}

export function canSubmitInterviewFeedback(actor: TalentActor, interview: Interview): boolean {
  if (actor.role === "recruiter" || isHrRole(actor.role)) return true;
  return interview.panel.toLowerCase().includes(actor.fullName.trim().toLowerCase());
}

export function submitInterviewFeedback(actor: TalentActor, id: string, score: number, feedback: string): TalentResult {
  return guarded((s) => {
    const row = s.interviews.find((i) => i.id === id);
    if (!row) return "Interview not found.";
    if (!canSubmitInterviewFeedback(actor, row)) return "Only panel members, recruiters or HR can submit feedback.";
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

/** HR / recruiter, or whoever the task is assigned to (the joiner, their manager, IT). */
export function canEditOnboardingTask(actor: TalentActor, task: OnboardingTask, joiner: OnboardingJoiner | undefined): boolean {
  if (canEditOnboarding(actor.role)) return true;
  if (task.owner === "IT") return actor.role === "it_admin";
  if (task.owner === "Manager") return sameName(joiner?.manager, actor.fullName);
  if (task.owner === "Employee") return sameName(joiner?.name, actor.fullName);
  return false;
}

export function canAcknowledgePolicies(actor: TalentActor, joiner: OnboardingJoiner): boolean {
  return isHrRole(actor.role) || sameName(joiner.name, actor.fullName);
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

export function setOnboardingTaskStatus(actor: TalentActor, id: string, status: OnboardingTask["status"]): TalentResult {
  return guarded((s) => {
    const row = s.tasks.find((t) => t.id === id);
    if (!row) return "Task not found.";
    const joiner = s.joiners.find((j) => j.id === row.joinerId);
    if (!canEditOnboardingTask(actor, row, joiner)) return `Only HR, recruiting or the task owner (${row.owner}) can update this task.`;
    row.status = status;
    return null;
  });
}

export function setJoinerPolicyAck(actor: TalentActor, id: string, policyAck: OnboardingJoiner["policyAck"]): TalentResult {
  return guarded((s) => {
    const row = s.joiners.find((j) => j.id === id);
    if (!row) return "Joiner not found.";
    if (!canAcknowledgePolicies(actor, row)) return "Only the new joiner (or HR on their behalf) can acknowledge policies.";
    row.policyAck = policyAck;
    if (policyAck === "Complete") {
      s.tasks.forEach((t) => {
        if (t.joinerId === id && t.category === "Policy") t.status = "Done";
      });
    }
    return null;
  });
}

/* ───────────── Performance ───────────── */

export function canEditGoal(actor: TalentActor, goal: PerfGoal): boolean {
  return goal.ownerId === actor.id || isAboveInChain(actor.id, goal.ownerId);
}

export function updateGoalProgress(actor: TalentActor, id: string, progress: number): TalentResult {
  return guarded((s) => {
    const row = s.goals.find((g) => g.id === id);
    if (!row) return "Goal not found.";
    if (!canEditGoal(actor, row)) return "Only the goal owner or their managers can update progress.";
    row.progress = Math.max(0, Math.min(100, Math.round(progress)));
    return null;
  });
}

type ReviewPatch = Partial<Pick<PerfReview, "selfStatus" | "managerStatus" | "feedback360Status" | "rating" | "developmentPlan">>;

export function updateReview(actor: TalentActor, id: string, patch: ReviewPatch): TalentResult {
  return guarded((s) => {
    const row = s.reviews.find((r) => r.id === id);
    if (!row) return "Review not found.";
    const { selfStatus, ...managerFields } = patch;
    if (selfStatus !== undefined && actor.id !== row.employeeId) return "Only the employee can update their self-assessment.";
    if (Object.keys(managerFields).length > 0 && !canManageEmployee(actor, row.employeeId)) {
      return "Only the employee's manager chain or HR can update this.";
    }
    const managerStatus = patch.managerStatus ?? row.managerStatus;
    if (patch.rating && managerStatus !== "Submitted") return "Submit the manager assessment before setting a rating.";
    Object.assign(row, patch);
    if (row.managerStatus !== "Submitted") row.rating = undefined;
    return null;
  });
}

/* ───────────── Learning ───────────── */

/** Self-reported progress stops here; the final assessment is confirmed by HR. */
export const SELF_PROGRESS_CAP = 90;

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

export function completeEnrollment(actor: TalentActor, id: string): TalentResult {
  return guarded((s) => {
    const row = s.enrollments.find((e) => e.id === id);
    if (!row) return "Enrollment not found.";
    if (!isHrRole(actor.role) || row.employeeId === actor.id) return "Only HR can confirm completion for someone else.";
    row.progress = 100;
    row.status = "Completed";
    row.completedOn = todayISO();
    return null;
  });
}

export function enrollInCourse(courseId: string, employeeId: string, employeeName: string) {
  updateTalent((s) => {
    if (s.enrollments.some((e) => e.courseId === courseId && e.employeeId === employeeId)) return;
    s.enrollments.push({
      id: `en-local-${Date.now()}`,
      courseId,
      employeeId,
      employeeName,
      status: "Assigned",
      progress: 0,
      due: isoDaysFromToday(ENROLLMENT_DUE_DAYS),
    });
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

/** Answer an open feedback request: the reply is sent privately to the person who asked. */
export function answerFeedbackRequest(requestId: string, message: string) {
  updateTalent((s) => {
    const request = s.feedback.find((f) => f.id === requestId && f.kind === "Request");
    if (!request) return;
    request.status = "Answered";
    s.feedback.unshift({
      id: newId("fb"),
      kind: "Feedback",
      fromId: request.toId,
      fromName: request.toName,
      toId: request.fromId,
      toName: request.fromName,
      message,
      createdOn: todayISO(),
      createdAt: new Date().toISOString(),
    });
  });
}

/* ───────────── 1:1 check-ins ───────────── */

function meetingStart(meeting: Pick<OneOnOne, "date" | "time">): number {
  return new Date(`${meeting.date}T${meeting.time || "00:00"}`).getTime();
}

export function isMeetingInFuture(meeting: Pick<OneOnOne, "date" | "time">): boolean {
  return meetingStart(meeting) > Date.now();
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

export function setOneOnOneStatus(id: string, status: OneOnOne["status"], notes?: string): TalentResult {
  return guarded((s) => {
    const row = s.oneOnOnes.find((m) => m.id === id);
    if (!row) return "Meeting not found.";
    if (status === "Completed" && isMeetingInFuture(row)) return "A 1:1 can only be completed once it has started.";
    if (notes !== undefined) row.notes = notes;
    row.status = status;
    return null;
  });
}

export function updateOneOnOne(id: string, mutator: (meeting: OneOnOne) => void) {
  updateTalent((s) => {
    const row = s.oneOnOnes.find((m) => m.id === id);
    if (row) mutator(row);
  });
}

export function addCheckInItem(meetingId: string, list: "agenda" | "actionItems", text: string) {
  updateOneOnOne(meetingId, (m) => {
    m[list].push({ id: newId("ci"), text, done: false });
  });
}

export function toggleCheckInItem(meetingId: string, list: "agenda" | "actionItems", itemId: string) {
  updateOneOnOne(meetingId, (m) => {
    const item = m[list].find((i) => i.id === itemId);
    if (item) item.done = !item.done;
  });
}

/* ───────────── Skills ───────────── */

/** The employee's saved skills profile, or the starter profile until they change it. */
export function skillProfileFor(state: Pick<TalentState, "skillProfiles">, employeeId: string): EmployeeSkill[] {
  return state.skillProfiles.find((p) => p.employeeId === employeeId)?.skills ?? DEFAULT_EMPLOYEE_SKILLS;
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
      profile = { employeeId, skills: structuredClone(DEFAULT_EMPLOYEE_SKILLS) };
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
  cache = null;
  listeners.forEach((fn) => fn());
}
