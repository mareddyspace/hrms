/**
 * Skills library, career paths, career profiles and role matches from the backend (VITE_API_URL mode only),
 * plus the AI drafts (Employee 360 summary, candidate comparison, interview feedback summary).
 * Kept in memory per API session; nothing goes to localStorage.
 */
import type { SkillTrack, TargetRole } from "../data/talentData.ts";
import type { CareerInterests, CareerTimeframe } from "../data/talentLocal.ts";
import { API_ENABLED, api, apiRequest, apiSessionMe } from "./client.ts";
import { createTalentMirror, runTalentApi } from "./syncTalent.ts";

/* ───────── Shapes (backend/app/schemas/career.py) ───────── */

export interface CareerSkillOut {
  id: string;
  name: string;
  category: "technical" | "behavioural";
  area: string | null;
  description: string;
  related_profile_ids: string[];
  related_course_ids: string[];
  certifications: string[];
  active: boolean;
}

export interface CareerPathOut {
  id: string;
  title: string;
  track: string;
  function: string;
  from_profile_id: string | null;
  to_profile_id: string | null;
  required_skills: Record<string, string>;
  active: boolean;
}

export interface CareerProfileOut {
  employee_id: string;
  employee_name: string | null;
  current_role: string | null;
  target_role_ids: string[];
  target_roles: string[];
  interests: string[];
  timeframe: string;
  open_to_relocation: boolean;
  mentor_id: string | null;
  mentor_name: string | null;
  note: string;
  saved: boolean;
  updated_at: string | null;
}

export interface CareerCourseOut {
  id: string;
  title: string;
  duration_hours: number;
}

export interface CareerRoleMatchOut {
  key: string;
  title: string;
  source: "Career path" | "Open job";
  function: string;
  target_role_id: string | null;
  location: string | null;
  posting_id: string | null;
  match: number;
  score: number;
  reasons: string[];
  gaps: { skill_id: string; name: string; have: string; need: string; levels: number; courses: CareerCourseOut[] }[];
  recommended_courses: CareerCourseOut[];
  timeline: { from_week: number; to_week: number; skill: string | null; text: string }[];
  total_weeks: number;
}

export interface CareerMatchesOut {
  employee_id: string;
  skills_saved: boolean;
  matches: CareerRoleMatchOut[];
}

/* ───────── Mirror ───────── */

export interface CareerData {
  skills: CareerSkillOut[];
  paths: CareerPathOut[];
  me: CareerProfileOut | null;
  team: CareerProfileOut[];
  isHr: boolean;
}

const HR = new Set(["hr_admin", "hr", "hrbp"]);

async function loadCareer(): Promise<CareerData> {
  const who = await apiSessionMe();
  const isHr = HR.has(who.role);
  const seesTeam = isHr || who.scope !== "self";
  const [skills, paths, me, team] = await Promise.all([
    api.get<CareerSkillOut[]>("/career/skills", isHr ? { include_inactive: true } : undefined),
    api.get<CareerPathOut[]>("/career/paths"),
    who.employee_id ? api.get<CareerProfileOut>("/career/me").catch(() => null) : Promise.resolve(null),
    seesTeam ? api.get<CareerProfileOut[]>("/career/team-interests").catch(() => [] as CareerProfileOut[]) : Promise.resolve([] as CareerProfileOut[]),
  ]);
  return { skills, paths, me, team, isHr };
}

export const careerMirror = createTalentMirror<CareerData>(() => ({ skills: [], paths: [], me: null, team: [], isHr: false }), loadCareer);

export const CAREER_API = API_ENABLED;

/** Server career paths in the TARGET_ROLES shape (null until loaded). */
export function apiTargetRoles(): TargetRole[] | null {
  if (!API_ENABLED || !careerMirror.loaded()) return null;
  const paths = careerMirror.get().paths;
  if (!paths.length) return null;
  return paths.map((p) => ({ id: p.id, title: p.title, track: p.track as SkillTrack, required: p.required_skills }));
}

/** A saved server profile in the CareerInterests shape. */
export function toInterests(p: CareerProfileOut | null | undefined): CareerInterests | undefined {
  if (!p || !p.saved) return undefined;
  return {
    employeeId: p.employee_id,
    targetRoleIds: p.target_role_ids,
    functions: p.interests,
    openToRelocation: p.open_to_relocation,
    timeframe: p.timeframe as CareerTimeframe,
    note: p.note,
    updatedOn: (p.updated_at ?? "").slice(0, 10),
  };
}

/* ───────── Writes ───────── */

export function apiSaveCareerProfile(input: {
  targetRoleIds: string[];
  functions: string[];
  openToRelocation: boolean;
  timeframe: string;
  note: string;
  mentorId?: string | null;
}): Promise<string | null> {
  return runTalentApi(
    () =>
      apiRequest("/career/me", {
        method: "PUT",
        body: {
          target_role_ids: input.targetRoleIds,
          interests: input.functions,
          open_to_relocation: input.openToRelocation,
          timeframe: input.timeframe,
          note: input.note,
          mentor_id: input.mentorId ?? careerMirror.get().me?.mentor_id ?? null,
        },
      }),
    careerMirror,
  );
}

export interface SkillInput {
  name: string;
  category: "technical" | "behavioural";
  area: string;
  description: string;
}

export function apiAddSkill(input: SkillInput): Promise<string | null> {
  return runTalentApi(() => api.post("/career/skills", input), careerMirror);
}

export function apiRetireSkill(id: string): Promise<string | null> {
  return runTalentApi(() => apiRequest(`/career/skills/${encodeURIComponent(id)}`, { method: "DELETE" }), careerMirror);
}

export function apiRoleMatches(employeeId?: string): Promise<CareerMatchesOut> {
  return api.get<CareerMatchesOut>("/career/matches", employeeId ? { employee_id: employeeId } : undefined);
}

/* ───────── AI drafts ───────── */

export interface EmployeeSummaryOut {
  employee_id: string;
  summary: string | null;
  used_ai: boolean;
  model: string | null;
  sections: string[];
}

export function apiEmployeeSummary(employeeId: string): Promise<EmployeeSummaryOut> {
  return api.post<EmployeeSummaryOut>("/ai/employee-summary", { employee_id: employeeId });
}

export interface CompareRowOut {
  candidate_id: string;
  name: string;
  stage: string;
  experience_years: number;
  matched_skills: string[];
  missing_skills: string[];
  match_score: number;
  interview_scores: number[];
  average_score: number | null;
  interviews_done: number;
  interviews_pending: number;
}

export interface CompareOut {
  requisition_id: string;
  requisition_title: string;
  rows: CompareRowOut[];
  summary: string;
  used_ai: boolean;
  model: string | null;
  note: string;
}

export function apiCompareCandidates(requisitionId: string, candidateIds: string[]): Promise<CompareOut> {
  return api.post<CompareOut>("/recruiting/compare", { requisition_id: requisitionId, candidate_ids: candidateIds });
}

export interface FeedbackSummaryOut {
  candidate_id: string;
  summary: string;
  used_ai: boolean;
  model: string | null;
  interviews_done: number;
  interviews_pending: number;
  average_score: number | null;
  note: string;
}

export function apiFeedbackSummary(candidateId: string): Promise<FeedbackSummaryOut> {
  return api.post<FeedbackSummaryOut>(`/recruiting/candidates/${encodeURIComponent(candidateId)}/feedback-summary`);
}
