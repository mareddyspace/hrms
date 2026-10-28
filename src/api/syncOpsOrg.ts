/**
 * Organization structure from the backend (VITE_API_URL mode only): org units, job families, job profiles
 * and positions. Raw API rows live in an in-memory mirror; orgStructureLocal.ts maps them to the portal's
 * shapes. Everyone signed in can read; HR and administrators can change (the API checks).
 */
import { api, apiRequest } from "./client.ts";
import { apiRun, createApiMirror } from "./syncOps.ts";

export type ApiOrgUnitType =
  | "company"
  | "legal_entity"
  | "country"
  | "business_unit"
  | "division"
  | "department"
  | "team"
  | "supervisory_org"
  | "cost_centre"
  | "location";

export interface OrgUnitOut {
  id: string;
  code: string;
  name: string;
  type: ApiOrgUnitType;
  parent_id: string | null;
  country_code: string | null;
  active: boolean;
  /** Effective dating (backend migration 0013). */
  manager_id?: string | null;
  headcount?: number | null;
  effective_from?: string | null;
  effective_to?: string | null;
}

export interface JobFamilyOut {
  id: string;
  code: string;
  name: string;
  description: string | null;
  active: boolean;
}

export interface JobProfileOut {
  id: string;
  code: string;
  title: string;
  family_id: string | null;
  grade: string | null;
  description: string | null;
  required_skills: string[];
  preferred_skills: string[];
  active: boolean;
  job_level?: string | null;
  experience_min_years?: number | null;
  experience_max_years?: number | null;
  education?: string | null;
  responsibilities?: string[] | null;
  effective_from?: string | null;
  effective_to?: string | null;
}

export interface PositionOut {
  id: string;
  code: string;
  profile_id: string;
  title: string | null;
  department_id: string | null;
  location_id: string | null;
  country_code: string;
  grade: string | null;
  manager_id: string | null;
  headcount: number;
  filled: number;
  status: "open" | "frozen" | "filled" | string;
  active: boolean;
  effective_from?: string | null;
  effective_to?: string | null;
}

/** One effective-dated version of an org unit, job profile or position (newest first). */
export interface OrgVersionOut {
  id: number;
  entity: "org_unit" | "job_profile" | "position" | string;
  entity_id: string;
  effective_from: string;
  effective_to: string | null;
  change: "created" | "updated" | "deactivated" | "reactivated" | "baseline" | string;
  changed_fields: string[];
  snapshot: Record<string, unknown>;
  changed_by: string | null;
  changed_by_name: string | null;
  reason: string | null;
  created_at: string;
}

export type OrgHistoryEntity = "units" | "job-profiles" | "positions";

/** Version history of one record (everyone signed in can read). */
export function apiOrgHistory(entity: OrgHistoryEntity, id: string): Promise<OrgVersionOut[]> {
  return api.get<OrgVersionOut[]>(`/org/${entity}/${encodeURIComponent(id)}/history`);
}

/** Active org units as they stood on a day (YYYY-MM-DD). */
export function apiOrgUnitsAsOf(day: string): Promise<OrgUnitOut[]> {
  return api.get<OrgUnitOut[]>("/org/units", { as_of: day });
}

/** Change date and reason sent with an update (date defaults to today on the server; no future dates). */
export interface EffectiveDated {
  effective_from?: string | null;
  reason?: string | null;
}

export interface ApiOrgData {
  units: OrgUnitOut[];
  families: JobFamilyOut[];
  profiles: JobProfileOut[];
  positions: PositionOut[];
}

function emptyOrg(): ApiOrgData {
  return { units: [], families: [], profiles: [], positions: [] };
}

/** Active and inactive rows of one list (the API returns active only unless asked). */
async function both<T>(path: string, extra: Record<string, string | number> = {}): Promise<T[]> {
  const [on, off] = await Promise.all([
    api.get<T[]>(path, { ...extra, active: true }),
    api.get<T[]>(path, { ...extra, active: false }),
  ]);
  return [...on, ...off];
}

async function loadOrg(): Promise<ApiOrgData> {
  const [units, families, profiles, positions] = await Promise.all([
    both<OrgUnitOut>("/org/units"),
    both<JobFamilyOut>("/org/job-families"),
    both<JobProfileOut>("/org/job-profiles"),
    both<PositionOut>("/org/positions", { limit: 1000 }),
  ]);
  return { units, families, profiles, positions };
}

export const orgMirror = createApiMirror<ApiOrgData>(emptyOrg, () => loadOrg());

/** Upper-case code in the API's format (A-Z, 0-9, single dashes), e.g. "DEPT-PEOPLE-OPS". */
export function makeOrgCode(prefix: string, name: string): string {
  const slug = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return [prefix, slug || "NEW"].filter(Boolean).join("-");
}

export function cleanOrgCode(code: string): string {
  return code.trim().toUpperCase().replace(/\s+/g, "-");
}

const send = <T>(method: "POST" | "PATCH", path: string, body: unknown = {}) => apiRequest<T>(path, { method, body });

/* ───────── Org units ───────── */

export function apiCreateOrgUnit(input: { code: string; name: string; type: ApiOrgUnitType; parent_id: string | null; country_code: string | null }) {
  return apiRun(() => send("POST", "/org/units", input), orgMirror);
}

export function apiUpdateOrgUnit(
  id: string,
  patch: { code?: string; name?: string; active?: boolean; parent_id?: string | null; manager_id?: string | null; headcount?: number | null } & EffectiveDated,
) {
  return apiRun(() => send("PATCH", `/org/units/${encodeURIComponent(id)}`, patch), orgMirror);
}

export function apiDeactivateOrgUnit(id: string) {
  return apiRun(() => send("POST", `/org/units/${encodeURIComponent(id)}/deactivate`), orgMirror);
}

/* ───────── Job families ───────── */

/** Creates a family; resolves to the new row, or the error message. */
export async function apiCreateJobFamily(input: { code: string; name: string }): Promise<JobFamilyOut | string> {
  let row: JobFamilyOut | null = null;
  const error = await apiRun(async () => {
    row = await send<JobFamilyOut>("POST", "/org/job-families", { ...input, description: null });
  }, orgMirror);
  return error ?? row ?? "That didn't work. Try again.";
}

/* ───────── Job profiles ───────── */

export function apiCreateJobProfile(input: { code: string; title: string; family_id: string | null; grade: string | null; description: string | null }) {
  return apiRun(() => send("POST", "/org/job-profiles", input), orgMirror);
}

export function apiUpdateJobProfile(
  id: string,
  patch: {
    title?: string;
    family_id?: string | null;
    grade?: string | null;
    description?: string | null;
    active?: boolean;
    job_level?: string | null;
    experience_min_years?: number | null;
    experience_max_years?: number | null;
    education?: string | null;
    responsibilities?: string[];
  } & EffectiveDated,
) {
  return apiRun(() => send("PATCH", `/org/job-profiles/${encodeURIComponent(id)}`, patch), orgMirror);
}

export function apiDeactivateJobProfile(id: string) {
  return apiRun(() => send("POST", `/org/job-profiles/${encodeURIComponent(id)}/deactivate`), orgMirror);
}

/* ───────── Positions ───────── */

export interface PositionInput {
  profile_id: string;
  department_id: string | null;
  location_id: string | null;
  country_code: string;
  grade: string | null;
  manager_id: string | null;
  headcount: number;
  filled: number;
  status: "open" | "frozen";
}

export function apiCreatePosition(input: PositionInput) {
  return apiRun(() => send("POST", "/org/positions", input), orgMirror);
}

export function apiUpdatePosition(id: string, patch: Partial<Omit<PositionInput, "country_code">> & { active?: boolean } & EffectiveDated) {
  return apiRun(() => send("PATCH", `/org/positions/${encodeURIComponent(id)}`, patch), orgMirror);
}

export function apiDeactivatePosition(id: string) {
  return apiRun(() => send("POST", `/org/positions/${encodeURIComponent(id)}/deactivate`), orgMirror);
}
