/**
 * Performance (cycles, goals, check-ins, reviews, 360, development actions), learning (courses, enrollments,
 * certifications) and skills from the backend (VITE_API_URL mode only), in the shapes talentLocal uses.
 *
 * Goals, check-ins, enrollments, certifications and skills are read per person: the signed-in person, their
 * direct reports, and for HR the portal's sign-in people too. Reviews come from GET /performance/reviews; a
 * review not opened yet (active cycle, you or a direct report) shows as a placeholder that is opened on the
 * server on its first change.
 */
import {
  LEVEL_RANK,
  SKILL_LIBRARY,
  type Certification,
  type Course,
  type CourseAudience,
  type DevAction,
  type EmployeeSkill,
  type Enrollment,
  type OneOnOne,
  type PerfCycle,
  type PerfGoal,
  type PerfReview,
  type Reviewer360,
  type SkillProfile,
} from "../data/talentData.ts";
import { DEMO_ACCOUNTS, managementChain } from "../demoAccounts.ts";
import { directReportIds, getPerson } from "../data/peopleLocal.ts";
import { api, apiRequest } from "./client.ts";
import { nameOf } from "./syncShared.ts";
import { TalentRefusal, createTalentMirror, localDay, noAccessAsEmpty, qget, runTalentApi, sessionRole, waitForPeople } from "./syncTalent.ts";

const enc = encodeURIComponent;
const HR_ROLES = ["hr", "hr_admin", "hrbp"];
/** Most people whose goals, learning and skills are loaded at once. */
const MAX_PEOPLE = 25;

/* ───────── Response shapes ───────── */

interface CycleOut {
  id: string;
  name: string;
  status: string;
  start_date: string;
  end_date: string;
  self_review_due: string;
  manager_review_due: string;
  created_by: string | null;
}

interface GoalOut {
  id: string;
  employee_id: string;
  cycle_id: string;
  type: string;
  title: string;
  target: string;
  period: string | null;
  weight: number;
  progress: number;
}

interface CheckInOut {
  id: string;
  employee_id: string;
  manager_id: string | null;
  meeting_date: string;
  notes: string;
  action_items: { text?: string; done?: boolean }[];
  created_by: string | null;
  created_at: string;
}

interface Reviewer360Out {
  reviewer_id: string;
  reviewer_name: string | null;
  nominated_by: string;
  nominated_at: string;
  responded: boolean;
  responded_at: string | null;
  rating: number | null;
  comment: string | null;
}

interface DevActionOut {
  id: string;
  review_id: string;
  title: string;
  due: string | null;
  status: string;
}

interface ReviewOut {
  id: string;
  cycle_id: string;
  employee_id: string;
  employee_name: string | null;
  self_status: string;
  self_text: string | null;
  manager_status: string;
  manager_text: string | null;
  rating: string | null;
  released: boolean;
  released_at: string | null;
  feedback_360_status: string;
  reviewers: Reviewer360Out[];
  dev_actions: DevActionOut[];
}

interface Pending360Out {
  review_id: string;
  cycle_id: string;
  employee_id: string;
  employee_name: string | null;
}

interface CourseOut {
  id: string;
  title: string;
  provider: string;
  url: string | null;
  category: string | null;
  duration_hours: number;
  mandatory: boolean;
  audience: string;
  skills: string[];
  active: boolean;
}

interface EnrollmentOut {
  id: string;
  course_id: string;
  course_title: string | null;
  employee_id: string;
  status: string;
  progress: number;
  due: string | null;
  completed_on: string | null;
  score: number | null;
}

interface CertificationOut {
  id: string;
  employee_id: string;
  employee_name: string | null;
  name: string;
  issuer: string | null;
  issued_on: string;
  expires_on: string | null;
  credential_id: string | null;
  days_to_expiry: number | null;
}

interface SkillOut {
  id: number;
  employee_id: string;
  skill: string;
  level: number;
  target_level: number | null;
  years?: number | null;
  last_used?: string | null;
  evidence_url?: string | null;
}

/* ───────── Mapping ───────── */

const CYCLE_STATUS: Record<string, PerfCycle["status"]> = { planning: "Planning", active: "Active", calibration: "Calibration", closed: "Closed" };
const GOAL_TYPE: Record<string, PerfGoal["type"]> = { goal: "Goal", okr: "OKR", kpi: "KPI" };
const STEP_STATUS: Record<string, PerfReview["selfStatus"]> = { not_started: "Not started", draft: "Draft", submitted: "Submitted" };
const STATUS_360: Record<string, PerfReview["feedback360Status"]> = { not_started: "Not started", in_progress: "In progress", complete: "Complete" };
const DEV_STATUS: Record<string, DevAction["status"]> = { not_started: "Not started", in_progress: "In progress", done: "Done" };
const DEV_STATUS_TO_API: Record<DevAction["status"], string> = { "Not started": "not_started", "In progress": "in_progress", Done: "done" };
const ENROLL_STATUS: Record<string, Enrollment["status"]> = { assigned: "Assigned", in_progress: "In progress", completed: "Completed" };

/** Proficiency names, lowest first (1 = Awareness … 5 = Expert). */
const LEVELS = Object.keys(LEVEL_RANK).sort((a, b) => LEVEL_RANK[a]! - LEVEL_RANK[b]!);

function levelName(n: number | null | undefined): string | undefined {
  return n ? LEVELS[Math.max(1, Math.min(LEVELS.length, n)) - 1] : undefined;
}

function levelNumber(name: string): number {
  return LEVEL_RANK[name] ?? 1;
}

/** The library id for a skill name, or a stable id for skills outside the library. */
export function skillIdFor(name: string): string {
  const clean = name.trim().replace(/\s+/g, " ");
  const def = SKILL_LIBRARY.find((d) => d.name.toLowerCase() === clean.toLowerCase());
  return def?.id ?? `sk-own-${clean.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

function toCycle(c: CycleOut): PerfCycle {
  return {
    id: c.id,
    name: c.name,
    status: CYCLE_STATUS[c.status] ?? "Planning",
    start: c.start_date,
    end: c.end_date,
    selfReviewDue: c.self_review_due,
    managerReviewDue: c.manager_review_due,
    ...(c.created_by ? { createdBy: nameOf(c.created_by) } : {}),
  };
}

function toGoal(g: GoalOut): PerfGoal {
  return {
    id: g.id,
    ownerId: g.employee_id,
    ownerName: nameOf(g.employee_id),
    type: GOAL_TYPE[g.type] ?? "Goal",
    title: g.title,
    target: g.target,
    weight: g.weight,
    period: g.period ?? "",
    progress: g.progress,
    cycleId: g.cycle_id,
  };
}

/** A recorded check-in, shown as a completed 1:1 (read-only). */
function toCheckIn(c: CheckInOut): OneOnOne {
  return {
    id: c.id,
    managerId: c.manager_id ?? "",
    managerName: nameOf(c.manager_id),
    employeeId: c.employee_id,
    employeeName: nameOf(c.employee_id),
    date: c.meeting_date,
    time: "",
    status: "Completed",
    agenda: [],
    actionItems: c.action_items.map((a, i) => ({ id: `${c.id}-x${i + 1}`, text: a.text ?? "", done: !!a.done })),
    notes: c.notes,
  };
}

function toReviewer(r: Reviewer360Out): Reviewer360 {
  return {
    reviewerId: r.reviewer_id,
    reviewerName: r.reviewer_name ?? nameOf(r.reviewer_id),
    nominatedBy: nameOf(r.nominated_by),
    nominatedOn: localDay(r.nominated_at) ?? "",
    ...(r.rating != null ? { rating: r.rating } : {}),
    ...(r.comment ? { comment: r.comment } : {}),
    ...(r.responded ? { respondedOn: localDay(r.responded_at) ?? localDay(new Date().toISOString()) } : {}),
  };
}

function toReview(r: ReviewOut): PerfReview {
  return {
    id: r.id,
    employeeId: r.employee_id,
    employeeName: r.employee_name ?? nameOf(r.employee_id),
    cycleId: r.cycle_id,
    selfStatus: STEP_STATUS[r.self_status] ?? "Not started",
    managerStatus: STEP_STATUS[r.manager_status] ?? "Not started",
    feedback360Status: STATUS_360[r.feedback_360_status] ?? "Not started",
    ...(r.self_text ? { selfText: r.self_text } : {}),
    ...(r.manager_text ? { managerText: r.manager_text } : {}),
    ...(r.rating ? { rating: r.rating } : {}),
    released: r.released,
    ...(r.released_at ? { releasedOn: localDay(r.released_at) } : {}),
    devActions: r.dev_actions.map((a) => ({ id: a.id, title: a.title, due: a.due ?? "", status: DEV_STATUS[a.status] ?? "Not started" })),
    reviewers360: r.reviewers.map(toReviewer),
    finalDecisionNote: "",
  };
}

const PLACEHOLDER = "new:";

function placeholderReview(cycleId: string, employeeId: string): PerfReview {
  return {
    id: `${PLACEHOLDER}${cycleId}:${employeeId}`,
    employeeId,
    employeeName: nameOf(employeeId),
    cycleId,
    selfStatus: "Not started",
    managerStatus: "Not started",
    feedback360Status: "Not started",
    devActions: [],
    reviewers360: [],
    finalDecisionNote: "",
  };
}

function toCourse(c: CourseOut): Course {
  return {
    id: c.id,
    title: c.title,
    category: c.category ?? "General",
    durationHours: c.duration_hours,
    mandatory: c.mandatory,
    audience: (["All", "Engineering", "Managers", "Hiring"].includes(c.audience) ? c.audience : "All") as CourseAudience,
    skills: c.skills.map(skillIdFor),
  };
}

function toEnrollment(e: EnrollmentOut): Enrollment {
  return {
    id: e.id,
    courseId: e.course_id,
    employeeId: e.employee_id,
    employeeName: nameOf(e.employee_id),
    status: ENROLL_STATUS[e.status] ?? "Assigned",
    progress: e.progress,
    ...(e.due ? { due: e.due } : {}),
    ...(e.completed_on ? { completedOn: e.completed_on } : {}),
    ...(e.score != null ? { assessmentScore: e.score } : {}),
  };
}

function toCertification(c: CertificationOut): Certification {
  return {
    id: c.id,
    employeeId: c.employee_id,
    employeeName: c.employee_name ?? nameOf(c.employee_id),
    name: c.name,
    issuer: c.issuer ?? "",
    earnedOn: c.issued_on,
    ...(c.expires_on ? { expiresOn: c.expires_on } : {}),
    ...(c.credential_id ? { credentialId: c.credential_id } : {}),
  };
}

function toSkill(s: SkillOut): EmployeeSkill {
  const level = levelName(s.level) ?? LEVELS[0]!;
  return {
    skillId: skillIdFor(s.skill),
    skillName: s.skill,
    level,
    targetLevel: levelName(s.target_level) ?? LEVELS[Math.min(LEVELS.length - 1, LEVEL_RANK[level] ?? 1)]!,
    ...(s.years != null ? { years: s.years } : {}),
    ...(s.last_used ? { lastUsed: s.last_used } : {}),
    ...(s.evidence_url ? { evidenceUrl: s.evidence_url } : {}),
  };
}

/* ───────── Whose records to load ───────── */

function hasManager(id: string): boolean {
  return managementChain(id, DEMO_ACCOUNTS).length > 0 || !!getPerson(id)?.managerId;
}

function peopleFor(accountId: string): { all: string[]; reports: string[] } {
  const reports = directReportIds(accountId);
  const ids = [accountId, ...reports];
  if (HR_ROLES.includes(sessionRole(accountId) ?? "")) ids.push(...DEMO_ACCOUNTS.map((a) => a.id));
  return { all: [...new Set(ids)].slice(0, MAX_PEOPLE), reports };
}

/** Per-person list; people outside the caller's scope (404/403) are skipped. */
async function perPerson<T>(path: string, ids: string[]): Promise<T[]> {
  const lists = await Promise.all(ids.map((id) => noAccessAsEmpty(qget<T[]>(path, { employee_id: id }), [] as T[])));
  return lists.flat();
}

const orEmpty = <T>(p: Promise<T[]>): Promise<T[]> => noAccessAsEmpty(p, [] as T[]);

/* ───────── Performance mirror ───────── */

export interface PerformanceData {
  cycles: PerfCycle[];
  goals: PerfGoal[];
  reviews: PerfReview[];
  checkIns: OneOnOne[];
}

async function loadPerformance(accountId: string): Promise<PerformanceData> {
  await waitForPeople();
  const { all, reports } = peopleFor(accountId);
  const [cycles, goals, checkIns, reviews, pending] = await Promise.all([
    orEmpty(qget<CycleOut[]>("/performance/cycles")),
    perPerson<GoalOut>("/performance/goals", all),
    perPerson<CheckInOut>("/performance/check-ins", [accountId, ...reports].slice(0, MAX_PEOPLE)),
    orEmpty(qget<ReviewOut[]>("/performance/reviews")),
    orEmpty(qget<Pending360Out[]>("/performance/360/pending")),
  ]);
  const mapped = reviews.map(toReview);
  // 360 requests on reviews outside my scope: a stub with just my own nomination.
  for (const p of pending) {
    if (mapped.some((r) => r.id === p.review_id)) continue;
    mapped.push({
      ...placeholderReview(p.cycle_id, p.employee_id),
      id: p.review_id,
      employeeName: p.employee_name ?? nameOf(p.employee_id),
      reviewers360: [{ reviewerId: accountId, reviewerName: nameOf(accountId), nominatedBy: "", nominatedOn: "" }],
    });
  }
  // Reviews not opened yet: me and my direct reports in active cycles.
  for (const cycle of cycles.filter((c) => c.status === "active")) {
    for (const id of [accountId, ...reports]) {
      if (!hasManager(id) || mapped.some((r) => r.cycleId === cycle.id && r.employeeId === id)) continue;
      mapped.push(placeholderReview(cycle.id, id));
    }
  }
  const seen = new Set<string>();
  return {
    cycles: cycles.map(toCycle).sort((a, b) => a.start.localeCompare(b.start)),
    goals: goals.filter((g) => !seen.has(g.id) && seen.add(g.id)).map(toGoal),
    reviews: mapped,
    checkIns: checkIns.filter((c) => !seen.has(c.id) && seen.add(c.id)).map(toCheckIn),
  };
}

export const performanceMirror = createTalentMirror<PerformanceData>(() => ({ cycles: [], goals: [], reviews: [], checkIns: [] }), loadPerformance);

const runPerf = (fn: () => Promise<unknown>) => runTalentApi(fn, performanceMirror);

export function isPlaceholderReview(id: string): boolean {
  return id.startsWith(PLACEHOLDER);
}

/** The review's server id, opening it first when it is a placeholder. */
async function reviewId(id: string): Promise<string> {
  if (!isPlaceholderReview(id)) return id;
  const [cycleId, employeeId] = id.slice(PLACEHOLDER.length).split(":");
  const opened = await api.get<ReviewOut>(`/performance/cycles/${enc(cycleId!)}/reviews/${enc(employeeId!)}`);
  return opened.id;
}

const reviewPath = async (id: string) => `/performance/reviews/${enc(await reviewId(id))}`;

export function apiCreateCycle(input: { name: string; start: string; end: string; selfReviewDue: string; managerReviewDue: string }) {
  return runPerf(() =>
    api.post("/performance/cycles", {
      name: input.name.trim(),
      start_date: input.start,
      end_date: input.end,
      self_review_due: input.selfReviewDue,
      manager_review_due: input.managerReviewDue,
    }),
  );
}

export function apiAdvanceCycle(cycleId: string) {
  return runPerf(() => api.post(`/performance/cycles/${enc(cycleId)}/advance`));
}

export function apiSaveGoal(input: { id?: string; ownerId: string; cycleId: string; type: PerfGoal["type"]; title: string; target: string; period: string; weight: number }) {
  const body = {
    employee_id: input.ownerId,
    cycle_id: input.cycleId,
    type: input.type.toLowerCase(),
    title: input.title.trim(),
    target: input.target.trim(),
    period: input.period.trim() || null,
    weight: Math.round(Number(input.weight)),
  };
  return runPerf(() =>
    input.id ? apiRequest(`/performance/goals/${enc(input.id)}`, { method: "PUT", body }) : api.post("/performance/goals", body),
  );
}

export function apiGoalProgress(id: string, progress: number) {
  return runPerf(() =>
    apiRequest(`/performance/goals/${enc(id)}/progress`, { method: "PATCH", body: { progress: Math.max(0, Math.min(100, Math.round(progress))) } }),
  );
}

export function apiSaveAssessment(id: string, who: "self" | "manager", text: string, submit: boolean) {
  return runPerf(async () => apiRequest(`${await reviewPath(id)}/${who}`, { method: "PUT", body: { text: text.trim(), submit } }));
}

export function apiSetRating(id: string, rating: string | undefined) {
  return runPerf(async () => api.post(`${await reviewPath(id)}/rating`, { rating: rating || null }));
}

export function apiReleaseRating(id: string) {
  return runPerf(async () => api.post(`${await reviewPath(id)}/release`));
}

export function apiNominate360(id: string, reviewerId: string) {
  return runPerf(async () => api.post(`${await reviewPath(id)}/reviewers`, { reviewer_id: reviewerId }));
}

export function apiRemove360(id: string, reviewerId: string) {
  return runPerf(async () => apiRequest(`${await reviewPath(id)}/reviewers/${enc(reviewerId)}`, { method: "DELETE" }));
}

export function apiAnswer360(id: string, rating: number, comment: string) {
  return runPerf(async () => api.post(`${await reviewPath(id)}/360`, { rating, comment: comment.trim() }));
}

export function apiAddDevAction(id: string, input: { title: string; due: string }) {
  return runPerf(async () => api.post(`${await reviewPath(id)}/actions`, { title: input.title.trim(), due: input.due || null }));
}

export function apiUpdateDevAction(actionId: string, patch: Partial<Pick<DevAction, "title" | "due" | "status">>) {
  const body: Record<string, unknown> = {};
  if (patch.title !== undefined) body.title = patch.title.trim();
  if (patch.due !== undefined) body.due = patch.due || null;
  if (patch.status !== undefined) body.status = DEV_STATUS_TO_API[patch.status];
  return runPerf(() => apiRequest(`/performance/actions/${enc(actionId)}`, { method: "PATCH", body }));
}

export function apiRemoveDevAction(actionId: string) {
  return runPerf(() => apiRequest(`/performance/actions/${enc(actionId)}`, { method: "DELETE" }));
}

/** A finished 1:1 is recorded on the server as a check-in (notes and action items). */
export function apiRecordCheckIn(meeting: OneOnOne, notes: string) {
  return runPerf(() =>
    api.post("/performance/check-ins", {
      employee_id: meeting.employeeId,
      meeting_date: meeting.date,
      notes: [notes.trim(), meeting.agenda.length ? `Agenda: ${meeting.agenda.map((a) => `${a.done ? "✓ " : ""}${a.text}`).join("; ")}` : ""]
        .filter(Boolean)
        .join("\n\n")
        .slice(0, 10_000),
      action_items: meeting.actionItems.slice(0, 30).map((a) => ({ text: a.text.slice(0, 500) || "Action", done: a.done })),
    }),
  );
}

/* ───────── Learning + skills mirror ───────── */

export interface LearningData {
  courses: Course[];
  enrollments: Enrollment[];
  certifications: Certification[];
  skillProfiles: SkillProfile[];
}

/** Server skill rows by employee, for edits (the portal works with skill ids). */
let skillRows = new Map<string, SkillOut[]>();

async function loadLearning(accountId: string): Promise<LearningData> {
  await waitForPeople();
  const { all, reports } = peopleFor(accountId);
  const [courses, enrollments, certs, expiring, skills] = await Promise.all([
    orEmpty(qget<CourseOut[]>("/learning/courses")),
    perPerson<EnrollmentOut>("/learning/enrollments", all),
    perPerson<CertificationOut>("/learning/certifications", all),
    orEmpty(qget<CertificationOut[]>("/learning/expiring", { days: 365 })),
    perPerson<SkillOut>("/learning/skills", [accountId, ...reports].slice(0, MAX_PEOPLE)),
  ]);
  const byEmployee = new Map<string, SkillOut[]>();
  for (const s of skills) byEmployee.set(s.employee_id, [...(byEmployee.get(s.employee_id) ?? []), s]);
  skillRows = byEmployee;
  const certMap = new Map<string, CertificationOut>();
  [...certs, ...expiring].forEach((c) => certMap.set(c.id, c));
  const seen = new Set<string>();
  return {
    courses: courses.map(toCourse),
    enrollments: enrollments.filter((e) => !seen.has(e.id) && seen.add(e.id)).map(toEnrollment),
    certifications: [...certMap.values()].map(toCertification),
    skillProfiles: [...byEmployee].map(([employeeId, rows]) => ({ employeeId, skills: rows.map(toSkill) })),
  };
}

export const learningMirror = createTalentMirror<LearningData>(() => ({ courses: [], enrollments: [], certifications: [], skillProfiles: [] }), loadLearning);

const runLearning = (fn: () => Promise<unknown>) => runTalentApi(fn, learningMirror);

export function apiEnroll(courseId: string, due: string | undefined) {
  return runLearning(() => api.post("/learning/enrollments", { course_id: courseId, ...(due ? { due } : {}) }));
}

export function apiEnrollmentProgress(id: string, progress: number) {
  return runLearning(() => apiRequest(`/learning/enrollments/${enc(id)}/progress`, { method: "PATCH", body: { progress: Math.max(0, Math.round(progress)) } }));
}

export function apiCompleteEnrollment(id: string, score: number | undefined) {
  return runLearning(() => api.post(`/learning/enrollments/${enc(id)}/complete`, { score: score ?? null }));
}

/**
 * Saves my skills profile. `next` is the whole list after the change; `before` is what was shown. Until the
 * person has saved skills on the server they see a starting list, so the first change saves the whole list.
 */
export function apiSaveMySkills(employeeId: string, before: EmployeeSkill[], next: EmployeeSkill[]) {
  return runLearning(async () => {
    const rows = skillRows.get(employeeId) ?? [];
    const onServer = (s: EmployeeSkill) => rows.find((r) => skillIdFor(r.skill) === s.skillId);
    const removed = before.filter((b) => !next.some((n) => n.skillId === b.skillId));
    const changed = next.filter((n) => {
      const row = onServer(n);
      return (
        !row ||
        levelName(row.level) !== n.level ||
        levelName(row.target_level) !== n.targetLevel ||
        (row.years ?? undefined) !== n.years ||
        (row.last_used || undefined) !== n.lastUsed ||
        (row.evidence_url || undefined) !== n.evidenceUrl
      );
    });
    for (const s of changed) {
      await apiRequest("/learning/skills/me", {
        method: "PUT",
        body: {
          skill: s.skillName,
          level: levelNumber(s.level),
          target_level: levelNumber(s.targetLevel),
          years: s.years ?? null,
          last_used: s.lastUsed || null,
          evidence_url: s.evidenceUrl || null,
        },
      });
    }
    for (const s of removed) {
      const row = onServer(s);
      if (row) await apiRequest(`/learning/skills/me/${row.id}`, { method: "DELETE" });
    }
    if (!next.length && !rows.length) throw new TalentRefusal("Add at least one skill.");
  });
}
