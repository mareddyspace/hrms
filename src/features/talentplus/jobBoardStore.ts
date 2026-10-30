import { todayISO } from "../../model.ts";
import { DEMO_ACCOUNTS, mentionsRetiredAccount } from "../../demoAccounts.ts";
import { getPerson } from "../../data/peopleLocal.ts";
import { applyInternally as applyToPipeline, getTalentState, isPostingOpen } from "../../data/talentLocal.ts";
import type { Candidate, PipelineStage, Requisition } from "../../data/talentData.ts";
import { API_ENABLED } from "../../api/client.ts";
import { myApplicationsMirror } from "../../api/syncTalent.ts";
import { pushPersonTaskAlert } from "../../data/collabLocal.ts";
import {
  addDays,
  arrayOr,
  createLocalStore,

  isHr,
  newId,
  type PlusActor,
  type PlusResult,
} from "./shared.ts";

export const STAGES = ["Submitted", "Screening", "Interview", "Hired", "Not selected"] as const;
export type Stage = (typeof STAGES)[number];
const FORWARD: Stage[] = ["Submitted", "Screening", "Interview", "Hired"];

export const RELATIONSHIPS = ["Former colleague", "Friend", "Classmate", "Professional network", "Family", "Other"] as const;

export const MIN_TENURE_MONTHS = 12;
export const BONUS_WAIT_DAYS = 90;

export interface InternalApplication {
  id: string;
  postingId: string;
  employeeId: string;
  employeeName: string;
  note: string;
  status: Stage;
  submittedOn: string;
  updatedOn: string;
}

export interface Referral {
  id: string;
  postingId: string;
  referrerId: string;
  referrerName: string;
  name: string;
  email: string;
  phone: string;
  relationship: string;
  linkedIn: string;
  note: string;
  status: Stage;
  submittedOn: string;
  updatedOn: string;
  hiredOn?: string;
  bonusPaidOn?: string;
}

interface JobBoardState {
  applications: InternalApplication[];
  referrals: Referral[];
}

function defaults(): JobBoardState {
  return {
    applications: [
    ],
    referrals: [
      { id: "rf-seed-1", postingId: "JOB-221", referrerId: "emp-mahesh", referrerName: "Babu Menon", name: "Riya Kapoor", email: "riya.kapoor@example.com", phone: "", relationship: "Former colleague", linkedIn: "", note: "Worked together on the payments UI.", status: "Hired", submittedOn: "2026-08-20", updatedOn: "2026-09-22", hiredOn: "2026-09-22" },
      { id: "rf-seed-2", postingId: "JOB-221", referrerId: "emp-mahesh", referrerName: "Babu Menon", name: "Neha Varghese", email: "neha.v@mail.example", phone: "+91 98450 11223", relationship: "Classmate", linkedIn: "", note: "", status: "Submitted", submittedOn: "2026-09-28", updatedOn: "2026-10-09" },
      { id: "rf-seed-3", postingId: "JOB-218", referrerId: "emp-ram", referrerName: "Ram Krishnan", name: "Tom Hughes", email: "tom.hughes@mail.example", phone: "", relationship: "Professional network", linkedIn: "", note: "", status: "Submitted", submittedOn: "2026-10-14", updatedOn: "2026-10-14" },
    ],
  };
}

function normalize(saved: unknown, base: JobBoardState): JobBoardState {
  const s = (saved ?? {}) as Partial<JobBoardState>;
  // Applications and referrals by a retired sign-in account (Compensation, Hiring Manager) are dropped.
  const live = <T,>(rows: T[]) => rows.filter((row) => !mentionsRetiredAccount(row));
  return { applications: live(arrayOr(s.applications, base.applications)), referrals: live(arrayOr(s.referrals, base.referrals)) };
}

// v2: referral seed matches the recruiting pipeline.
try {
  localStorage.removeItem("kastech.jobboard.v1");
} catch {
  /* ignore */
}
const store = createLocalStore<JobBoardState>("kastech.jobboard.v3", defaults, normalize);

export const subscribeJobBoard = store.subscribe;
export const getJobBoardState = store.getState;
export const resetJobBoard = store.reset;

/* ───────────── Postings ───────────── */

const CLOSED_SUMMARIES = ["closed", "filled", "on hold", "cancelled", "draft"];

/** On the board: the recruiter published a job post that is still taking applications. */
export function isOpenPosting(req: Requisition): boolean {
  return isPostingOpen(req) && !CLOSED_SUMMARIES.includes(req.stageSummary.trim().toLowerCase());
}

/* Internal applications live in the job's pipeline (candidates with source Internal); the board shows their stage. */
const BOARD_STAGE: Record<PipelineStage, Stage> = {
  Applied: "Submitted",
  Screening: "Screening",
  Shortlisted: "Screening",
  Interview: "Interview",
  Assessment: "Interview",
  "Final Review": "Interview",
  Offer: "Interview",
  Hired: "Hired",
  Rejected: "Not selected",
  Withdrawn: "Not selected",
};

function fromCandidate(c: Candidate): InternalApplication {
  const applied = (c.history ?? []).find((h) => h.stage === "Applied")?.enteredOn.slice(0, 10) ?? todayISO();
  const last = (c.history ?? []).at(-1)?.enteredOn.slice(0, 10) ?? applied;
  return { id: c.id, postingId: c.requisitionId, employeeId: c.employeeId ?? "", employeeName: c.name, note: c.coverNote ?? "", status: BOARD_STAGE[c.stage], submittedOn: applied, updatedOn: last };
}

/** My internal applications (backend mode: from the server, as candidates are not visible to applicants). */
export function myInternalApplications(actorId: string): InternalApplication[] {
  if (API_ENABLED) {
    return myApplicationsMirror.get().map((a) => ({
      id: a.id, postingId: a.requisition_id, employeeId: actorId, employeeName: "", note: a.cover_note ?? "",
      status: BOARD_STAGE[a.stage as PipelineStage] ?? "Submitted", submittedOn: a.applied_on, updatedOn: a.applied_on,
    }));
  }
  return getTalentState().candidates.filter((c) => c.employeeId === actorId).map(fromCandidate);
}

/** Every internal application recruiting can see (the recruiter / HR review list). */
export function allInternalApplications(): InternalApplication[] {
  return getTalentState().candidates.filter((c) => !!c.employeeId).map(fromCandidate);
}

export function openPostings(): Requisition[] {
  return getTalentState().requisitions.filter(isOpenPosting);
}

export function postingById(id: string): Requisition | undefined {
  return getTalentState().requisitions.find((r) => r.id === id);
}

/** Requisitions carry no grade, so derive one of the real grade bands (L4–L6, M1) from the title. */
export function gradeFor(req: Requisition): string {
  const t = req.title.toLowerCase();
  if (/(director|head|vp|chief)/.test(t)) return "M1";
  if (/(manager|principal|lead|partner)/.test(t)) return "L6";
  if (/(senior|sr\.?)\b/.test(t)) return "L5";
  return "L4";
}

export function isRecruitingDesk(actor: PlusActor): boolean {
  return actor.role === "recruiter" || isHr(actor.role);
}

/* ───────────── Eligibility ───────────── */

function monthsBetween(fromIso: string, toIso: string): number {
  const [fy, fm, fd] = fromIso.split("-").map(Number);
  const [ty, tm, td] = toIso.split("-").map(Number);
  let months = (ty - fy) * 12 + (tm - fm);
  if (td < fd) months -= 1;
  return months;
}

/** null when eligible; otherwise why not. Unknown join dates are treated as eligible. */
export function applyBlocker(actor: PlusActor, req: Requisition): string | null {
  if (!isOpenPosting(req)) return "This posting isn't open.";
  if (req.hiringManager.trim().toLowerCase() === actor.fullName.trim().toLowerCase())
    return "You're the hiring manager for this role.";
  if (req.recruiterId === actor.id) return "You run this role's pipeline.";
  if (myInternalApplications(actor.id).some((a) => a.postingId === req.id)) return "You've already applied.";
  const joined = getPerson(actor.id)?.dateOfJoining;
  if (joined && /^\d{4}-\d{2}-\d{2}$/.test(joined) && monthsBetween(joined, todayISO()) < MIN_TENURE_MONTHS)
    return `You need ${MIN_TENURE_MONTHS} months in your current role to apply.`;
  return null;
}

/* ───────────── Validation helpers ───────────── */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function validLinkedIn(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && /(^|\.)linkedin\.com$/i.test(parsed.hostname);
  } catch {
    return false;
  }
}

function accountIdByName(name: string): string | undefined {
  return DEMO_ACCOUNTS.find((a) => a.fullName.toLowerCase() === name.trim().toLowerCase())?.id;
}

/* ───────────── Mutations ───────────── */

/**
 * An employee applies for a job post: the application lands in that job's pipeline (source Internal); the recruiter
 * and the employee's manager are told. `reqId` is the requisition behind the post. Backend mode: the answer comes
 * later (run it through talentAction).
 */
export function applyInternally(actor: PlusActor, reqId: string, note: string): PlusResult {
  const req = postingById(reqId);
  if (!req?.posting) return "Posting not found.";
  const blocker = applyBlocker(actor, req);
  if (blocker) return blocker;
  if (note.trim().length > 3000) return "Keep your note under 3000 characters.";
  return applyToPipeline(actor, req.posting.id, note);
}

export type ReferralInput = {
  postingId: string;
  name: string;
  email: string;
  phone: string;
  relationship: string;
  linkedIn: string;
  note: string;
};

export function submitReferral(actor: PlusActor, input: ReferralInput): PlusResult {
  const req = postingById(input.postingId);
  if (!req) return "Choose a posting.";
  if (!isOpenPosting(req)) return "This posting isn't open.";
  const name = input.name.trim();
  const email = input.email.trim().toLowerCase();
  const phone = input.phone.trim();
  const linkedIn = input.linkedIn.trim();
  if (name.length < 2) return "Enter the candidate's full name.";
  if (name.length > 80) return "Keep the name under 80 characters.";
  if (!email) return "Enter the candidate's email.";
  if (!EMAIL_RE.test(email)) return "Enter a valid email address.";
  const own = getPerson(actor.id)?.email?.toLowerCase();
  if (own && own === email) return "You can't refer yourself.";
  if (phone && !/^\+?[0-9 ()-]{7,20}$/.test(phone)) return "Enter a valid phone number or leave it blank.";
  if (!(RELATIONSHIPS as readonly string[]).includes(input.relationship)) return "Choose how you know the candidate.";
  if (linkedIn && !validLinkedIn(linkedIn)) return "LinkedIn must be an https://linkedin.com link.";
  if (input.note.trim().length > 500) return "Keep the note under 500 characters.";
  const result = store.mutate((s) => {
    if (s.referrals.some((r) => r.postingId === req.id && r.email.toLowerCase() === email))
      return "This candidate has already been referred for this posting.";
    const today = todayISO();
    s.referrals.unshift({
      id: newId("rf"),
      postingId: req.id,
      referrerId: actor.id,
      referrerName: actor.fullName,
      name,
      email,
      phone,
      relationship: input.relationship,
      linkedIn,
      note: input.note.trim(),
      status: "Submitted",
      submittedOn: today,
      updatedOn: today,
    });
    return null;
  });
  if (result) return result;
  const recruiterId = accountIdByName(req.recruiter);
  if (recruiterId && recruiterId !== actor.id) {
    pushPersonTaskAlert({
      recipientId: recruiterId,
      title: "New referral",
      body: `${actor.fullName} referred ${name} for ${req.title} (${req.id}).`,
      href: "/internal-jobs",
    });
  }
  return null;
}

/** Statuses a record may move to: the next forward step, or Not selected. Final states don't move. */
export function nextStages(current: Stage): Stage[] {
  if (current === "Hired" || current === "Not selected") return [];
  const i = FORWARD.indexOf(current);
  return [FORWARD[i + 1], "Not selected"];
}

function canMove(current: Stage, next: Stage): string | null {
  if (!(STAGES as readonly string[]).includes(next)) return "Unknown status.";
  if (current === next) return `Already ${current.toLowerCase()}.`;
  if (current === "Hired" || current === "Not selected") return "This record is closed.";
  if (next === "Not selected") return null;
  if (FORWARD.indexOf(next) !== FORWARD.indexOf(current) + 1) return "Statuses only move one step forward.";
  return null;
}

export function moveApplication(actor: PlusActor, applicationId: string, next: Stage): PlusResult {
  if (!isRecruitingDesk(actor)) return "Only recruiters and HR can update applications.";
  let notify: { id: string; title: string } | null = null;
  const result = store.mutate((s) => {
    const app = s.applications.find((a) => a.id === applicationId);
    if (!app) return "Application not found.";
    if (app.employeeId === actor.id) return "You can't update your own application.";
    const error = canMove(app.status, next);
    if (error) return error;
    app.status = next;
    app.updatedOn = todayISO();
    notify = { id: app.employeeId, title: postingById(app.postingId)?.title ?? app.postingId };
    return null;
  });
  if (!result && notify) {
    const n = notify as { id: string; title: string };
    pushPersonTaskAlert({ recipientId: n.id, title: "Application update", body: `Your application for ${n.title} is now: ${next}.`, href: "/internal-jobs" });
  }
  return result;
}

export function moveReferral(actor: PlusActor, referralId: string, next: Stage): PlusResult {
  if (!isRecruitingDesk(actor)) return "Only recruiters and HR can update referrals.";
  let notify: { id: string; body: string } | null = null;
  const result = store.mutate((s) => {
    const ref = s.referrals.find((r) => r.id === referralId);
    if (!ref) return "Referral not found.";
    if (ref.referrerId === actor.id) return "You can't update a referral you made.";
    const error = canMove(ref.status, next);
    if (error) return error;
    ref.status = next;
    ref.updatedOn = todayISO();
    if (next === "Hired") ref.hiredOn = ref.updatedOn;
    notify = { id: ref.referrerId, body: `Your referral ${ref.name} is now: ${next}.` };
    return null;
  });
  if (!result && notify) {
    const n = notify as { id: string; body: string };
    pushPersonTaskAlert({ recipientId: n.id, title: "Referral update", body: n.body, href: "/internal-jobs" });
  }
  return result;
}

export function markBonusPaid(actor: PlusActor, referralId: string): PlusResult {
  if (!isHr(actor.role)) return "Only HR can mark a referral bonus as paid.";
  return store.mutate((s) => {
    const ref = s.referrals.find((r) => r.id === referralId);
    if (!ref) return "Referral not found.";
    if (ref.referrerId === actor.id) return "You can't approve your own referral bonus.";
    if (ref.status !== "Hired" || !ref.hiredOn) return "The bonus applies only after the candidate is hired.";
    if (ref.bonusPaidOn) return "This bonus is already paid.";
    const due = addDays(ref.hiredOn, BONUS_WAIT_DAYS);
    if (todayISO() < due) return "The bonus can be paid once the hire completes 90 days.";
    ref.bonusPaidOn = todayISO();
    return null;
  });
}

export type BonusStatus = { label: string; tone: "ok" | "warn" | "info" | "neutral"; payableOn?: string };

export function bonusStatus(ref: Referral, today = todayISO()): BonusStatus | null {
  if (ref.status !== "Hired" || !ref.hiredOn) return null;
  if (ref.bonusPaidOn) return { label: "Bonus paid", tone: "ok" };
  const due = addDays(ref.hiredOn, BONUS_WAIT_DAYS);
  if (today >= due) return { label: "Bonus payable", tone: "info", payableOn: due };
  return { label: "Bonus pending", tone: "warn", payableOn: due };
}
