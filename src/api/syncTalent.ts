/**
 * Recruiting and onboarding from the backend (VITE_API_URL mode only), in the shapes talentLocal uses.
 * Data is kept in memory (never localStorage); it loads when an API session starts, reloads after each
 * change and empties on sign-out. Performance, learning and skills: syncTalentPerf.ts.
 */
import type {
  ApprovalStatus,
  ApprovalStep,
  Candidate,
  Interview,
  JobPosting,
  OfferApproval,
  OfferLetter,
  Recommendation,
  RequisitionReason,
  OfferRecord,
  OfferStatus,
  OnboardingJoiner,
  OnboardingTask,
  PipelineStage,
  PreboardingForm,
  Requisition,
  StageStep,
  EquipmentItem,
} from "../data/talentData.ts";
import { EQUIPMENT_ITEMS } from "../data/talentData.ts";
import { DEMO_ACCOUNTS, findDemoById } from "../demoAccounts.ts";
import { listPeople, subscribePeople, usingApiPeople } from "../data/peopleLocal.ts";
import { TIMEZ_COUNTRIES } from "../model.ts";
import type { CvFields } from "../features/ai/cvReader.ts";
import type { MatchResult } from "../features/ai/candidateMatch.ts";
import { API_ENABLED, API_URL, ApiError, api, apiRequest, apiSessionAccount, onApiSession } from "./client.ts";
import { loadInstances, nameOf, stepsFromInstance, type ApprovalInstanceOut } from "./syncShared.ts";

export { API_ENABLED };

/* ───────── Small mirror (in memory, per API session) ───────── */

export interface TalentMirror<T> {
  get(): T;
  loaded(): boolean;
  subscribe(fn: () => void): () => void;
  reload(): Promise<void>;
}

export function createTalentMirror<T>(empty: () => T, load: (accountId: string) => Promise<T>): TalentMirror<T> {
  let value = empty();
  let isLoaded = false;
  let seq = 0;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((fn) => fn());
  async function reload() {
    const account = apiSessionAccount();
    if (!account) return;
    const mine = ++seq;
    try {
      const next = await load(account);
      if (mine !== seq || apiSessionAccount() !== account) return;
      value = next;
      isLoaded = true;
      emit();
    } catch (error) {
      console.warn("Could not load talent data from the server", error);
    }
  }
  if (API_ENABLED) {
    queueMicrotask(() =>
      onApiSession((account) => {
        if (account) void reload();
        else {
          seq += 1;
          value = empty();
          isLoaded = false;
          emit();
        }
      }),
    );
  }
  return {
    get: () => value,
    loaded: () => isLoaded,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    reload,
  };
}

/** Message for a failed call (shown in the page's existing notice). */
export function apiErrorText(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return "That didn't work. Try again.";
}

/** Runs a change, then reloads the mirrors; resolves to null or the error message. */
export async function runTalentApi(fn: () => Promise<unknown>, ...mirrors: { reload(): Promise<void> }[]): Promise<string | null> {
  let error: string | null = null;
  try {
    await fn();
  } catch (e) {
    error = apiErrorText(e);
  }
  await Promise.all(mirrors.map((m) => m.reload()));
  return error;
}

/** A rule the front end checks before calling the server: rejects with the message as is. */
export class TalentRefusal extends Error {}

/* ───────── Shared helpers ───────── */

const enc = encodeURIComponent;

export function countryName(code: string | null | undefined): string {
  return TIMEZ_COUNTRIES.find((c) => c.code === code)?.name ?? code ?? "";
}

export function countryCode(name: string): string | undefined {
  return TIMEZ_COUNTRIES.find((c) => c.name === name || c.code === name)?.code;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** "2026-10-28T09:31:00Z" → local "2026-10-28T15:01". */
export function localStamp(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 16);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Local date of a timestamp. */
export function localDay(iso: string | null | undefined): string | undefined {
  return iso ? localStamp(iso).slice(0, 10) || undefined : undefined;
}

/** Waits (up to 15 s) for the directory to come from the API, so reporting lines are known. */
export function waitForPeople(): Promise<void> {
  if (usingApiPeople()) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = window.setTimeout(done, 15000);
    const off = subscribePeople(() => {
      if (usingApiPeople()) done();
    });
    function done() {
      window.clearTimeout(timer);
      off();
      resolve();
    }
  });
}

/** Employee ids matched by name in free text such as "Ram Krishnan · Sophie Clark". */
export function idsFromNames(text: string): string[] {
  const parts = text
    .split(/[·,;/+&]|\band\b/i)
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  const people = [...DEMO_ACCOUNTS.map((a) => ({ id: a.id, name: a.fullName })), ...listPeople().map((p) => ({ id: p.id, name: p.fullName }))];
  const out: string[] = [];
  for (const part of parts) {
    const hit = people.find((p) => p.name.trim().toLowerCase() === part) ?? people.find((p) => part.includes(p.name.trim().toLowerCase()));
    if (hit && !out.includes(hit.id)) out.push(hit.id);
  }
  return out;
}

/* ───────── Response shapes (backend/app/schemas/talent.py) ───────── */

export interface RequisitionOut {
  id: string;
  title: string;
  department: string;
  country_code: string;
  location: string;
  openings: number;
  hiring_manager_id: string;
  hiring_manager_name: string | null;
  recruiter_id: string | null;
  recruiter_name: string | null;
  recruiter_assigned_on: string | null;
  status: string;
  approval_id: string | null;
  requirements: string[];
  description: string | null;
  raised_on: string;
  decided_on: string | null;
  candidate_count: number;
  budget?: number | null;
  budget_currency?: string | null;
  reason?: string | null;
  justification?: string | null;
  raised_by?: string | null;
  posting?: PostingOut | null;
  stage_counts?: Record<string, number>;
}

export interface PostingOut {
  id: string;
  requisition_id: string;
  title: string;
  description: string;
  location: string;
  employment_type: string;
  closing_date: string;
  on_careers_site: boolean;
  status: string;
  published_by: string | null;
  published_on: string;
  closed_on: string | null;
  applications: number;
}

/** GET /public/careers (no sign-in). */
export interface PublicPostingOut {
  id: string;
  title: string;
  department: string;
  location: string;
  country_name: string;
  employment_type: string;
  description: string;
  closing_date: string;
  openings: number;
}

/** GET /public/offers/{token} (no sign-in). */
export interface PublicOfferOut {
  candidate_name: string;
  title: string;
  department: string;
  location: string;
  grade: string;
  base_salary: number;
  currency: string;
  start_date: string;
  status: "sent" | "accepted" | "declined" | "withdrawn";
  responded_on: string | null;
  letter: OfferLetter | null;
}

export interface CandidateOut {
  id: string;
  requisition_id: string;
  name: string;
  email: string;
  phone: string | null;
  source: string;
  experience_years: number;
  skills: string[];
  cv_note: string | null;
  cv_filename: string | null;
  has_cv: boolean;
  applied_on: string;
  stage: string;
  history: { stage: string; entered_at: string; by_id: string | null; note: string | null }[];
  posting_id?: string | null;
  employee_id?: string | null;
  cover_note?: string | null;
  match_score?: number | null;
}

export interface InterviewOut {
  id: string;
  candidate_id: string;
  scheduled_at: string;
  duration_minutes: number;
  kind: string;
  panel_ids: string[];
  feedback_status: string;
  score: number | null;
  feedback: string | null;
  feedback_by: string | null;
  feedback_at: string | null;
  ratings?: Record<string, number> | null;
  recommendation?: string | null;
}

export interface OfferOut {
  id: string;
  candidate_id: string;
  candidate_name: string | null;
  requisition_id: string;
  grade: string;
  base_salary: number;
  currency: string;
  start_date: string;
  package_note: string | null;
  status: string;
  approvals: { role: string; by_id: string | null; at: string }[];
  created_by: string;
  sent_on: string | null;
  response_note: string | null;
  response_recorded_by?: string | null;
  responded_on: string | null;
  letter?: OfferLetter | null;
  response_token?: string | null;
  responded_via?: string | null;
}

export interface OnboardingTaskOut {
  id: string;
  joiner_id: string;
  key: string;
  title: string;
  owner_role: string;
  category: string;
  due_date: string;
  depends_on: string[];
  status: string;
  done_at: string | null;
  done_by: string | null;
  override_note: string | null;
}

export interface JoinerOut {
  id: string;
  employee_id: string;
  candidate_id: string | null;
  requisition_id: string | null;
  name: string;
  job_title: string;
  country_code: string;
  manager_id: string | null;
  start_date: string;
  policy_ack: boolean;
  policy_ack_at: string | null;
  policy_ack_by: string | null;
  policy_ack_by_hr: boolean;
  status: string;
  completed_at: string | null;
  progress_pct: number;
  employment_status: string | null;
  preboarding?: PreboardingOut | null;
  preboarding_at?: string | null;
  tasks: OnboardingTaskOut[];
}

/** Pre-boarding form as stored on the joiner (backend/app/schemas/onboarding_payroll.py). */
export interface PreboardingOut {
  personal: { confirmed: boolean; preferred_name?: string | null; personal_email?: string | null; mobile?: string | null; address?: string | null };
  emergency_contact: { name: string; relationship: string; phone: string };
  equipment: string[];
  it_request: { systems: string[]; notes?: string | null };
}

/** GET /onboarding/analytics (HR, admin, executive; scoped to the user's data). */
export interface OnboardingAnalyticsOut {
  total_joiners: number;
  joiners_by_month: { month: string; count: number }[];
  joiners_by_country: { country_code: string; count: number }[];
  tasks_total: number;
  tasks_done: number;
  completion_pct: number;
  overdue_by_owner: { owner_role: string; count: number }[];
  overdue_total: number;
  avg_days_to_complete: number | null;
  preboarding_count: number;
  onboarding_count: number;
  completed_count: number;
  status_counts: Record<string, number>;
}

export interface CvParseOut {
  name: string;
  email: string;
  phone: string;
  experience_years: number | null;
  current_title: string;
  current_company: string;
  education: string[];
  library_skills: string[];
  other_skills: string[];
}

export interface MatchOut extends MatchResult {
  candidate_id: string;
  requisition_id: string;
  required: string[];
  preferred: string[];
  source: string;
}

interface RawMatchOut {
  candidate_id: string;
  requisition_id: string;
  score: number;
  band: "Strong" | "Partial" | "Weak";
  matched: string[];
  missing: string[];
  preferred_matched: string[];
  years: number;
  years_needed: number;
  summary: string;
  questions: string[];
  required: string[];
  preferred: string[];
  source: string;
}

export interface ActivityOut {
  at: string;
  action: string;
  entity: string;
  entity_id: string | null;
  subject_id: string | null;
  details: Record<string, unknown> | null;
}

/* ───────── Mapping ───────── */

const REQ_STATUS: Record<string, ApprovalStatus> = {
  draft: "Draft",
  pending_approval: "Pending approval",
  approved: "Approved",
  rejected: "Rejected",
  on_hold: "On hold",
};

const OFFER_STATUS: Record<string, OfferStatus> = {
  preparing: "Preparing",
  pending_approval: "Pending approval",
  approved: "Approved",
  sent: "Sent",
  accepted: "Accepted",
  declined: "Declined",
  withdrawn: "Withdrawn",
};
const OFFER_STATUS_TO_API = Object.fromEntries(Object.entries(OFFER_STATUS).map(([k, v]) => [v, k])) as Record<OfferStatus, string>;

const TASK_OWNER: Record<string, OnboardingTask["owner"]> = { hr: "HR", it: "IT", manager: "Manager", employee: "Employee" };
const TASK_STATUS: Record<string, OnboardingTask["status"]> = { pending: "Pending", in_progress: "In progress", done: "Done" };
const TASK_STATUS_TO_API: Record<OnboardingTask["status"], string> = { Pending: "pending", "In progress": "in_progress", Done: "done" };
const JOINER_STATUS: Record<string, OnboardingJoiner["overallStatus"]> = {
  pre_boarding: "Pre-boarding",
  day1_ready: "Day 1 ready",
  in_progress: "In progress",
  completed: "Completed",
};

const REASON: Record<string, RequisitionReason> = { new_role: "New role", replacement: "Replacement" };
const REASON_TO_API: Record<RequisitionReason, string> = { "New role": "new_role", Replacement: "replacement" };
const RECOMMENDATION: Record<string, Recommendation> = { strong_yes: "Strong yes", yes: "Yes", no: "No", strong_no: "Strong no" };
const RECOMMENDATION_TO_API = Object.fromEntries(Object.entries(RECOMMENDATION).map(([k, v]) => [v, k])) as Record<Recommendation, string>;

function toPosting(p: PostingOut): JobPosting {
  return {
    id: p.id,
    title: p.title,
    description: p.description,
    location: p.location,
    employmentType: p.employment_type,
    closingDate: p.closing_date,
    onCareersSite: p.on_careers_site,
    status: p.status === "open" ? "Open" : "Closed",
    publishedBy: p.published_by ? nameOf(p.published_by) : "",
    publishedOn: p.published_on,
    ...(p.closed_on ? { closedOn: p.closed_on } : {}),
  };
}

function toRequisition(r: RequisitionOut, cands: CandidateOut[], inst: ApprovalInstanceOut | undefined): Requisition {
  const status = REQ_STATUS[r.status] ?? "Pending approval";
  const hm = r.hiring_manager_name ?? nameOf(r.hiring_manager_id);
  const recruiter = r.recruiter_id ? (r.recruiter_name ?? nameOf(r.recruiter_id)) : "";
  const history: ApprovalStep[] = [{ on: r.raised_on, by: hm, byId: r.hiring_manager_id, action: "Raised" }];
  const flow = inst ? stepsFromInstance(inst) : null;
  for (const d of flow?.stepDecisions ?? []) {
    history.push({ on: d.on, by: d.byName, byId: d.byId, action: `${d.decision === "approved" ? "Approved" : "Rejected"} · ${d.label}`, ...(d.note ? { note: d.note } : {}) });
  }
  const decidedBy = flow?.lastDecision ? nameOf(flow.lastDecision.approver_id) : "";
  if ((status === "Approved" || status === "On hold") && r.decided_on) {
    history.push({ on: r.decided_on, by: decidedBy || "HR", byId: flow?.lastDecision?.approver_id ?? "", action: "Approved" });
  }
  if (status === "Rejected") history.push({ on: r.decided_on ?? r.raised_on, by: decidedBy || "Approver", byId: flow?.lastDecision?.approver_id ?? "", action: "Rejected" });
  if (r.recruiter_id) history.push({ on: r.recruiter_assigned_on ?? r.decided_on ?? r.raised_on, by: "HR", byId: "", action: "Recruiter assigned", note: recruiter });
  if (status === "On hold") history.push({ on: r.decided_on ?? r.raised_on, by: "HR", byId: "", action: "Put on hold" });
  if (r.posting) history.push({ on: r.posting.published_on, by: r.posting.published_by ? nameOf(r.posting.published_by) : "Recruiting", byId: r.posting.published_by ?? "", action: "Posted" });
  if (r.posting?.closed_on) history.push({ on: r.posting.closed_on, by: "Recruiting", byId: "", action: "Post closed" });
  const mine = cands.filter((c) => c.requisition_id === r.id);
  const hired = mine.filter((c) => c.stage === "Hired").length;
  const stageSummary =
    status === "Pending approval"
      ? "Awaiting approval"
      : status === "On hold"
        ? "On hold"
        : status === "Rejected"
          ? "Closed"
          : hired >= r.openings
            ? "Filled"
            : mine.some((c) => ["Interview", "Assessment", "Final Review", "Offer"].includes(c.stage))
              ? "Interviewing"
              : "Sourcing";
  return {
    id: r.id,
    title: r.title,
    department: r.department,
    country: countryName(r.country_code),
    location: r.location,
    openings: r.openings,
    hiringManager: hm,
    hiringManagerId: r.hiring_manager_id,
    recruiter,
    ...(r.recruiter_id ? { recruiterId: r.recruiter_id } : {}),
    ...(r.recruiter_assigned_on ? { recruiterAssignedOn: r.recruiter_assigned_on } : {}),
    approvalStatus: status,
    stageSummary,
    created: r.raised_on,
    ...(decidedBy ? { approver: decidedBy } : {}),
    ...(r.decided_on ? { decidedOn: r.decided_on } : {}),
    history,
    ...(flow && status === "Pending approval" ? { approvalSteps: flow.steps, currentStep: flow.currentStep, stepDecisions: flow.stepDecisions } : {}),
    ...(flow && status !== "Pending approval" ? { approvalSteps: flow.steps, currentStep: flow.steps.length, stepDecisions: flow.stepDecisions } : {}),
    requirements: r.requirements,
    ...(r.budget != null ? { budget: r.budget, ...(r.budget_currency ? { budgetCurrency: r.budget_currency } : {}) } : {}),
    ...(r.reason && REASON[r.reason] ? { reason: REASON[r.reason] } : {}),
    ...(r.justification ? { justification: r.justification } : {}),
    ...(r.raised_by ? { raisedById: r.raised_by, raisedBy: nameOf(r.raised_by) } : {}),
    ...(r.posting ? { posting: toPosting(r.posting) } : {}),
    ...(r.stage_counts && Object.keys(r.stage_counts).length ? { stageCounts: r.stage_counts as Requisition["stageCounts"] } : {}),
  };
}

function toCandidate(c: CandidateOut, req: RequisitionOut | undefined): Candidate {
  const history: StageStep[] = c.history.map((h) => ({
    stage: h.stage as PipelineStage,
    enteredOn: localStamp(h.entered_at),
    by: h.by_id ? nameOf(h.by_id) : h.stage === "Applied" ? c.name : "Recruiting",
    ...(h.by_id ? { byId: h.by_id } : {}),
    ...(h.note ? { note: h.note } : {}),
  }));
  return {
    id: c.id,
    name: c.name,
    email: c.email,
    phone: c.phone ?? "",
    role: req?.title ?? "",
    requisitionId: c.requisition_id,
    stage: c.stage as PipelineStage,
    country: countryName(req?.country_code),
    source: c.source,
    experienceYears: c.experience_years,
    skills: c.skills,
    resumeNote: c.cv_note ?? "",
    history: history.length ? history : [{ stage: "Applied", enteredOn: `${c.applied_on}T09:00`, by: c.name }],
    hasCv: c.has_cv,
    ...(c.cv_filename ? { cvFilename: c.cv_filename } : {}),
    ...(c.posting_id ? { postingId: c.posting_id } : {}),
    ...(c.employee_id ? { employeeId: c.employee_id } : {}),
    ...(c.cover_note ? { coverNote: c.cover_note } : {}),
    ...(c.match_score != null ? { matchScore: c.match_score } : {}),
  };
}

function toInterview(i: InterviewOut, cand: Candidate | undefined): Interview {
  return {
    id: i.id,
    candidateId: i.candidate_id,
    candidateName: cand?.name ?? i.candidate_id,
    role: cand?.role ?? "",
    when: localStamp(i.scheduled_at).replace("T", " "),
    panel: i.panel_ids.map((id) => nameOf(id)).join(" · "),
    panelIds: i.panel_ids,
    type: i.kind,
    feedbackStatus: i.feedback_status === "submitted" ? "Submitted" : "Pending",
    ...(i.score != null ? { score: i.score } : {}),
    ...(i.feedback ? { feedback: i.feedback } : {}),
    ...(i.ratings ? { ratings: i.ratings as Interview["ratings"] } : {}),
    ...(i.recommendation && RECOMMENDATION[i.recommendation] ? { recommendation: RECOMMENDATION[i.recommendation] } : {}),
    ...(i.feedback_by ? { feedbackBy: nameOf(i.feedback_by) } : {}),
  };
}

function toOffer(o: OfferOut, cand: Candidate | undefined, req: RequisitionOut | undefined): OfferRecord {
  const approvals: OfferApproval[] = o.approvals
    .filter((a) => a.role === "hiring_manager" || a.role === "hr")
    .map((a) => ({ role: a.role === "hr" ? "HR" : "Hiring manager", by: nameOf(a.by_id), byId: a.by_id ?? "", on: localDay(a.at) ?? "" }));
  return {
    id: o.id,
    candidateId: o.candidate_id,
    candidateName: o.candidate_name ?? cand?.name ?? o.candidate_id,
    requisitionId: o.requisition_id,
    role: req?.title ?? cand?.role ?? "",
    status: OFFER_STATUS[o.status] ?? "Preparing",
    grade: o.grade,
    baseSalary: o.base_salary,
    currency: o.currency,
    startDate: o.start_date,
    packageNote: o.package_note ?? "",
    createdBy: nameOf(o.created_by),
    createdById: o.created_by,
    approvals,
    ...(o.sent_on ? { sentOn: o.sent_on } : {}),
    ...(o.response_note ? { responseNote: o.response_note } : {}),
    ...(o.response_recorded_by ? { responseRecordedBy: nameOf(o.response_recorded_by) } : {}),
    ...(o.responded_on ? { respondedOn: o.responded_on } : {}),
    ...(o.letter ? { letter: o.letter } : {}),
    ...(o.response_token ? { responseToken: o.response_token } : {}),
    ...(o.responded_via === "link" || o.responded_via === "recorded" ? { respondedVia: o.responded_via } : {}),
  };
}

function docsStatus(tasks: OnboardingTaskOut[]): OnboardingJoiner["docsStatus"] {
  const docs = tasks.filter((t) => t.category === "Documents");
  if (!docs.length) return "Not started";
  if (docs.every((t) => t.status === "done")) return "Verified";
  if (docs.some((t) => t.status !== "pending")) return "In progress";
  return "Not started";
}

function toJoiner(j: JoinerOut): OnboardingJoiner {
  return {
    id: j.id,
    name: j.name,
    role: j.job_title,
    startDate: j.start_date,
    country: countryName(j.country_code),
    manager: nameOf(j.manager_id),
    managerId: j.manager_id ?? "",
    ...(j.candidate_id ? { candidateId: j.candidate_id } : {}),
    ...(j.requisition_id ? { requisitionId: j.requisition_id } : {}),
    personId: j.employee_id,
    preboardingPct: j.progress_pct,
    docsStatus: docsStatus(j.tasks),
    policyAck: j.policy_ack ? "Complete" : "Pending",
    ...(j.policy_ack_at ? { policyAckOn: localDay(j.policy_ack_at) } : {}),
    ...(j.policy_ack_by ? { policyAckBy: nameOf(j.policy_ack_by) } : {}),
    ...(j.policy_ack ? { policyAckByHr: j.policy_ack_by_hr } : {}),
    overallStatus: JOINER_STATUS[j.status] ?? "Pre-boarding",
    ...(j.preboarding ? { preboarding: toPreboarding(j.preboarding) } : {}),
    ...(j.preboarding_at ? { preboardingOn: localDay(j.preboarding_at) } : {}),
  };
}

function toPreboarding(p: PreboardingOut): PreboardingForm {
  const pe = p.personal ?? { confirmed: false };
  return {
    personal: {
      confirmed: !!pe.confirmed,
      ...(pe.preferred_name ? { preferredName: pe.preferred_name } : {}),
      ...(pe.personal_email ? { personalEmail: pe.personal_email } : {}),
      ...(pe.mobile ? { mobile: pe.mobile } : {}),
      ...(pe.address ? { address: pe.address } : {}),
    },
    emergencyContact: { ...p.emergency_contact },
    equipment: (p.equipment ?? []).filter((e): e is EquipmentItem => (EQUIPMENT_ITEMS as readonly string[]).includes(e)),
    itRequest: { systems: p.it_request?.systems ?? [], ...(p.it_request?.notes ? { notes: p.it_request.notes } : {}) },
  };
}

function toTask(t: OnboardingTaskOut): OnboardingTask {
  return {
    id: t.id,
    joinerId: t.joiner_id,
    title: t.title,
    owner: TASK_OWNER[t.owner_role] ?? "HR",
    category: t.category as OnboardingTask["category"],
    status: TASK_STATUS[t.status] ?? "Pending",
    due: t.due_date,
    key: t.key,
    dependsOn: t.depends_on ?? [],
    ...(t.override_note ? { overrideNote: t.override_note } : {}),
  };
}

/* ───────── Recruiting + onboarding mirror ───────── */

export interface RecruitingData {
  requisitions: Requisition[];
  candidates: Candidate[];
  interviews: Interview[];
  offers: OfferRecord[];
  joiners: OnboardingJoiner[];
  tasks: OnboardingTask[];
}

const emptyRecruiting = (): RecruitingData => ({ requisitions: [], candidates: [], interviews: [], offers: [], joiners: [], tasks: [] });

/** A role without access to a list (403 / 404) sees none of it; other failures fail the load (old data stays). */
export function noAccessAsEmpty<T>(p: Promise<T>, fallback: T): Promise<T> {
  return p.catch((error) => {
    if (error instanceof ApiError && (error.status === 403 || error.status === 404)) return fallback;
    throw error;
  });
}

const settle = noAccessAsEmpty;

/*
 * Loads go through a small queue: many parallel requests at sign-in (every module loads at once) can use up the
 * server's database connections.
 */
const MAX_PARALLEL = 4;
let active = 0;
const waiting: (() => void)[] = [];

export async function queued<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_PARALLEL) await new Promise<void>((resolve) => waiting.push(resolve));
  active += 1;
  try {
    return await fn();
  } finally {
    active -= 1;
    waiting.shift()?.();
  }
}

/** GET through the load queue. */
export function qget<T>(path: string, query?: Record<string, string | number | boolean | null | undefined>): Promise<T> {
  return queued(() => api.get<T>(path, query));
}

async function loadRecruiting(): Promise<RecruitingData> {
  await waitForPeople();
  const [ownReqs, postings, cands, interviews, offers, joiners] = await Promise.all([
    settle(qget<RequisitionOut[]>("/recruiting/requisitions"), []),
    // Internal job board: open roles everyone may see (no pipeline details).
    settle(qget<RequisitionOut[]>("/recruiting/postings"), []),
    settle(qget<CandidateOut[]>("/recruiting/candidates"), []),
    settle(qget<InterviewOut[]>("/recruiting/interviews"), []),
    settle(qget<OfferOut[]>("/recruiting/offers"), []),
    settle(qget<JoinerOut[]>("/onboarding/joiners"), []),
  ]);
  const reqs = [...ownReqs, ...postings.filter((p) => !ownReqs.some((r) => r.id === p.id))];
  const instances = await queued(() => loadInstances(reqs.filter((r) => r.status === "pending_approval" || r.approval_id).map((r) => r.approval_id)));
  const reqById = new Map(reqs.map((r) => [r.id, r]));
  const candidates = cands.map((c) => toCandidate(c, reqById.get(c.requisition_id)));
  const candById = new Map(candidates.map((c) => [c.id, c]));
  return {
    requisitions: reqs.map((r) => toRequisition(r, cands, r.approval_id ? instances.get(r.approval_id) : undefined)),
    candidates,
    interviews: interviews.map((i) => toInterview(i, candById.get(i.candidate_id))),
    offers: offers.map((o) => toOffer(o, candById.get(o.candidate_id), reqById.get(o.requisition_id))),
    joiners: joiners.map(toJoiner),
    tasks: joiners.flatMap((j) => j.tasks.map(toTask)),
  };
}

export const recruitingMirror = createTalentMirror(emptyRecruiting, () => loadRecruiting());

const run = (fn: () => Promise<unknown>) => runTalentApi(fn, recruitingMirror);

/* ───────── Recruiting changes ───────── */

export function apiRaiseRequisition(input: {
  title: string;
  department: string;
  country: string;
  location: string;
  openings: number;
  budget?: number;
  reason?: RequisitionReason;
  justification?: string;
  hiringManagerId?: string;
}) {
  return run(async () => {
    const code = countryCode(input.country);
    if (!code) throw new TalentRefusal("Choose a country.");
    await api.post("/recruiting/requisitions", {
      title: input.title.trim(),
      department: input.department.trim(),
      country_code: code,
      location: input.location.trim(),
      openings: input.openings,
      requirements: [],
      ...(input.budget !== undefined ? { budget: input.budget } : {}),
      ...(input.reason ? { reason: REASON_TO_API[input.reason] } : {}),
      ...(input.justification?.trim() ? { justification: input.justification.trim() } : {}),
      ...(input.hiringManagerId ? { hiring_manager_id: input.hiringManagerId } : {}),
    });
  });
}

/* ───────── Job posts, applications, screening ───────── */

export function apiPublishPosting(reqId: string, input: { title: string; description: string; location: string; employmentType: string; closingDate: string; onCareersSite: boolean }) {
  return run(() =>
    api.post(`/recruiting/requisitions/${enc(reqId)}/posting`, {
      title: input.title.trim(),
      description: input.description.trim(),
      location: input.location.trim(),
      employment_type: input.employmentType.trim() || "Full-time",
      closing_date: input.closingDate,
      on_careers_site: input.onCareersSite,
    }),
  );
}

export function apiClosePosting(reqId: string) {
  return run(() => api.post(`/recruiting/requisitions/${enc(reqId)}/posting/close`));
}

export function apiApplyInternally(postingId: string, coverNote: string) {
  return runTalentApi(() => api.post(`/recruiting/postings/${enc(postingId)}/apply`, { cover_note: coverNote.trim() || null }), recruitingMirror, myApplicationsMirror);
}

export function apiScreenCandidate(id: string, decision: "shortlist" | "reject", reason: string) {
  return run(() => api.post(`/recruiting/candidates/${enc(id)}/screen`, { decision, reason: reason.trim() || null }));
}

export interface MyApplicationOut {
  id: string;
  requisition_id: string;
  posting_id: string | null;
  title: string;
  applied_on: string;
  stage: string;
  cover_note: string | null;
}

/** My internal applications (stage from the job's pipeline). */
export const myApplicationsMirror = createTalentMirror<MyApplicationOut[]>(() => [], () => settle(qget<MyApplicationOut[]>("/recruiting/my-applications"), []));

/* ───────── Public pages (no sign-in) ───────── */

export function apiCareers(): Promise<PublicPostingOut[]> {
  return apiRequest<PublicPostingOut[]>("/public/careers", { anonymous: true });
}

export function apiCareerPost(id: string): Promise<PublicPostingOut> {
  return apiRequest<PublicPostingOut>(`/public/careers/${enc(id)}`, { anonymous: true });
}

function fileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.onerror = () => reject(new TalentRefusal("The CV file could not be read. Attach it again."));
    reader.readAsDataURL(file);
  });
}

/** Careers page application; resolves to null or the error message. */
export async function apiApplyCareers(postingId: string, input: { name: string; email: string; phone: string; coverNote: string; cvFile: File | null; website?: string }): Promise<string | null> {
  try {
    if (!input.cvFile) throw new TalentRefusal("Attach your CV.");
    if (input.cvFile.size > 5 * 1024 * 1024) throw new TalentRefusal("The CV is larger than 5 MB.");
    await apiRequest(`/public/careers/${enc(postingId)}/apply`, {
      method: "POST",
      anonymous: true,
      body: {
        name: input.name.trim(),
        email: input.email.trim(),
        phone: input.phone.trim() || null,
        cover_note: input.coverNote.trim() || null,
        cv_filename: input.cvFile.name,
        cv_base64: await fileBase64(input.cvFile),
        website: input.website || null,
      },
    });
    return null;
  } catch (error) {
    return apiErrorText(error);
  }
}

export function apiPublicOffer(token: string): Promise<PublicOfferOut> {
  return apiRequest<PublicOfferOut>(`/public/offers/${enc(token)}`, { anonymous: true });
}

export function apiAnswerOffer(token: string, accept: boolean, note: string): Promise<PublicOfferOut> {
  return apiRequest<PublicOfferOut>(`/public/offers/${enc(token)}/respond`, {
    method: "POST",
    anonymous: true,
    body: { decision: accept ? "accept" : "decline", note: note.trim() || null },
  });
}

/** Approve / reject (the open workflow step), put on hold or resume (HR). */
export function apiSetRequisitionApproval(id: string, next: ApprovalStatus, note: string, recruiterId: string) {
  return run(async () => {
    const req = recruitingMirror.get().requisitions.find((r) => r.id === id);
    if (!req) throw new TalentRefusal("Requisition not found.");
    if (req.approvalStatus === next) return;
    const path = `/recruiting/requisitions/${enc(id)}`;
    const clean = note.trim();
    if (next === "On hold") {
      await api.post(`${path}/hold`, { note: clean.length >= 5 ? clean : "Put on hold by HR." });
    } else if (req.approvalStatus === "On hold") {
      if (next !== "Approved") throw new TalentRefusal("A requisition on hold can only be resumed.");
      await api.post(`${path}/resume`);
    } else if (next === "Approved" || next === "Rejected") {
      await api.post(`${path}/decision`, {
        decision: next === "Approved" ? "approve" : "reject",
        note: clean || null,
        ...(next === "Approved" && recruiterId && !req.recruiterId ? { recruiter_id: recruiterId } : {}),
      });
    } else {
      throw new TalentRefusal(`A requisition cannot move from ${req.approvalStatus} to ${next}.`);
    }
  });
}

export interface ApiCandidateExtras {
  phone?: string;
  experienceYears?: number | null;
  skills?: string[];
  cvNote?: string;
  cvFile?: File | null;
}

export function apiAddCandidate(input: { requisitionId: string; name: string; email: string; source: string; appliedOn: string } & ApiCandidateExtras) {
  return run(async () => {
    const created = await api.post<CandidateOut>("/recruiting/candidates", {
      requisition_id: input.requisitionId,
      name: input.name.trim(),
      email: input.email.trim().toLowerCase(),
      source: input.source.trim(),
      applied_on: input.appliedOn,
      ...(input.phone ? { phone: input.phone.slice(0, 64) } : {}),
      ...(input.experienceYears != null ? { experience_years: input.experienceYears } : {}),
      ...(input.skills?.length ? { skills: [...new Set(input.skills)].slice(0, 50) } : {}),
      ...(input.cvNote ? { cv_note: input.cvNote.slice(0, 5000) } : {}),
    });
    if (input.cvFile) await uploadCvFile(created.id, input.cvFile);
  });
}

export function apiSetCandidateStage(id: string, stage: PipelineStage, note: string) {
  return run(() => api.post(`/recruiting/candidates/${enc(id)}/stage`, { stage, note: note.trim() || null }));
}

export function apiScheduleInterview(candidateId: string, input: { when: string; panelIds: string[]; type: string }) {
  return run(async () => {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(input.when)) throw new TalentRefusal("Choose a future date and time.");
    const when = new Date(input.when);
    if (Number.isNaN(when.getTime()) || when.getTime() <= Date.now()) throw new TalentRefusal("Choose a future date and time.");
    const panel = input.panelIds;
    if (!panel.length) throw new TalentRefusal("Choose who interviews.");
    await api.post(`/recruiting/candidates/${enc(candidateId)}/interviews`, {
      scheduled_at: when.toISOString(),
      kind: input.type.trim() || "Interview",
      panel_ids: panel.slice(0, 8),
    });
  });
}

export function apiSubmitInterviewFeedback(id: string, card: { ratings: Record<string, number | undefined>; recommendation: Recommendation | ""; notes: string }) {
  return run(() =>
    api.post(`/recruiting/interviews/${enc(id)}/feedback`, {
      ratings: card.ratings,
      ...(card.recommendation ? { recommendation: RECOMMENDATION_TO_API[card.recommendation] } : {}),
      notes: card.notes.trim(),
    }),
  );
}

export function apiCreateOffer(input: { candidateId: string; grade: string; baseSalary: number; startDate: string; packageNote: string }) {
  return run(() =>
    api.post("/recruiting/offers", {
      candidate_id: input.candidateId,
      grade: input.grade,
      base_salary: Math.round(input.baseSalary),
      start_date: input.startDate,
      package_note: input.packageNote.trim() || null,
    }),
  );
}

export function apiApproveOffer(id: string) {
  return run(() => api.post(`/recruiting/offers/${enc(id)}/approve`));
}

export function apiSetOfferStatus(id: string, status: OfferStatus, note: string) {
  return run(async () => {
    const offer = recruitingMirror.get().offers.find((o) => o.id === id);
    if (!offer) throw new TalentRefusal("Offer not found.");
    if (offer.status === status) return;
    const path = `/recruiting/offers/${enc(id)}`;
    if (status === "Approved") throw new TalentRefusal("Use Approve.");
    if (status === "Pending approval") await api.post(`${path}/submit`);
    else if (status === "Preparing") await api.post(`${path}/send-back`, { note: note.trim().length >= 5 ? note.trim() : "Sent back for changes." });
    else await api.post(`${path}/status`, { status: OFFER_STATUS_TO_API[status], note: note.trim() || null });
  });
}

/* ───────── CVs, CV reader, match, my activity ───────── */

const TOKEN_KEY = "timez.api.tokens";

function accessToken(): string | null {
  try {
    const raw = sessionStorage.getItem(TOKEN_KEY);
    return raw ? ((JSON.parse(raw) as { access?: string }).access ?? null) : null;
  } catch {
    return null;
  }
}

/** Raw-body request with the bearer token; on 401 lets the client refresh once and retries. */
async function rawFetch(path: string, init: RequestInit): Promise<Response> {
  const go = () => {
    const token = accessToken();
    return fetch(`${API_URL}/api/v1${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
  };
  let res: Response;
  try {
    res = await go();
    if (res.status === 401) {
      await apiRequest("/auth/me");
      res = await go();
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(0, "The server is starting up. Try again in about 30 seconds.");
  }
  if (!res.ok) {
    let message = res.status === 413 ? "The file is larger than 5 MB." : "That didn't work. Try again.";
    try {
      const body = (await res.json()) as { detail?: unknown };
      if (typeof body.detail === "string") message = body.detail;
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, message);
  }
  return res;
}

const CV_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
};

async function uploadCvFile(candidateId: string, file: File): Promise<void> {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!CV_TYPES[ext]) throw new TalentRefusal("Only PDF, DOC, DOCX or TXT files are accepted.");
  if (file.size > 5 * 1024 * 1024) throw new TalentRefusal("The file is larger than 5 MB.");
  await rawFetch(`/recruiting/candidates/${enc(candidateId)}/cv?filename=${enc(file.name)}`, {
    method: "PUT",
    headers: { "Content-Type": CV_TYPES[ext], Accept: "application/json" },
    body: file,
  });
}

/** Uploads (or replaces) a candidate's CV file. */
export function apiUploadCv(candidateId: string, file: File): Promise<string | null> {
  return run(() => uploadCvFile(candidateId, file));
}

/** Downloads the candidate's CV and opens the browser's save dialog. */
export async function apiDownloadCv(candidateId: string, filename: string): Promise<string | null> {
  try {
    const res = await rawFetch(`/recruiting/candidates/${enc(candidateId)}/cv`, { method: "GET" });
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = filename || "cv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 10000);
    return null;
  } catch (error) {
    return apiErrorText(error);
  }
}

/** A candidate's full phone number (assigned recruiter or HR; audited). Lists carry it masked. */
export async function apiRevealCandidatePhone(id: string): Promise<string | null> {
  const res = await api.get<{ field: string; value: string | null }>(`/recruiting/candidates/${encodeURIComponent(id)}/reveal`, { field: "phone" });
  return res.value;
}

/** Server CV reader (same rules as cvReader.ts). */
export async function apiParseCv(text: string): Promise<CvFields> {
  const out = await api.post<CvParseOut>("/recruiting/cv/parse", { text: text.slice(0, 100_000) });
  return {
    name: out.name,
    email: out.email,
    phone: out.phone,
    experienceYears: out.experience_years,
    currentTitle: out.current_title,
    currentCompany: out.current_company,
    education: out.education,
    librarySkills: out.library_skills,
    otherSkills: out.other_skills,
  };
}

/** Server match of a candidate to their requisition (a draft for people to review). */
export async function apiCandidateMatch(candidateId: string): Promise<MatchOut> {
  const m = await api.get<RawMatchOut>(`/recruiting/candidates/${enc(candidateId)}/match`);
  return {
    candidate_id: m.candidate_id,
    requisition_id: m.requisition_id,
    score: m.score,
    band: m.band,
    matched: m.matched,
    missing: m.missing,
    preferredMatched: m.preferred_matched,
    years: m.years,
    yearsNeeded: m.years_needed,
    summary: m.summary,
    questions: m.questions,
    required: m.required,
    preferred: m.preferred,
    source: m.source,
  };
}

/** Recruiting actions I took, newest first. */
export function apiMyRecruitingActivity(days = 90, limit = 50): Promise<ActivityOut[]> {
  return api.get<ActivityOut[]>("/recruiting/my-activity", { days, limit });
}

/* ───────── Onboarding changes ───────── */

export function apiSetOnboardingTaskStatus(id: string, status: OnboardingTask["status"], reason: string) {
  return run(() => apiRequest(`/onboarding/tasks/${enc(id)}`, { method: "PATCH", body: { status: TASK_STATUS_TO_API[status], reason: reason.trim() || null } }));
}

export function apiAcknowledgePolicies(joinerId: string) {
  return run(() => api.post(`/onboarding/joiners/${enc(joinerId)}/acknowledge`));
}

export function apiSubmitPreboarding(joinerId: string, form: PreboardingForm) {
  const body = {
    personal: {
      confirmed: form.personal.confirmed,
      preferred_name: form.personal.preferredName?.trim() || null,
      personal_email: form.personal.personalEmail?.trim() || null,
      mobile: form.personal.mobile?.trim() || null,
      address: form.personal.address?.trim() || null,
    },
    emergency_contact: {
      name: form.emergencyContact.name.trim(),
      relationship: form.emergencyContact.relationship.trim(),
      phone: form.emergencyContact.phone.trim(),
    },
    equipment: form.equipment,
    it_request: { systems: form.itRequest.systems, notes: form.itRequest.notes?.trim() || null },
  };
  return run(() => apiRequest(`/onboarding/joiners/${enc(joinerId)}/preboarding`, { method: "PUT", body }));
}

/** Onboarding analytics for the Analytics page and the HR home. */
export function apiOnboardingAnalytics(country?: string): Promise<OnboardingAnalyticsOut> {
  return api.get<OnboardingAnalyticsOut>("/onboarding/analytics", country ? { country } : undefined);
}

/** Role of the signed-in account (accounts are the portal's sign-in personas). */
export function sessionRole(accountId: string): string | undefined {
  return findDemoById(accountId)?.role;
}
