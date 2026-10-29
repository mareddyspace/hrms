import { DEMO_ACCOUNTS } from "../demoAccounts.ts";
import { TIMEZ_COUNTRIES, todayISO, type CountryCode } from "../model.ts";
import {
  DEPARTMENT_CODE,
  DEPARTMENTS,
  DIVISION_BY_DEPARTMENT,
  DIVISION_ORDER,
  FAMILY_BY_DEPARTMENT,
  JOB_CATALOG,
  TEAMMATE_MANAGER_ID,
  TEAMMATES,
  buildTimezWorkforce,
  gradeForTitle,
} from "../workforce.ts";
import {
  NATIONALITY_BY_COUNTRY,
  profileDetailsFor,
  type DependentRecord,
  type EducationRecord,
  type ExperienceRecord,
  type PersonProfileDetails,
  type WorkArrangement,
} from "./personProfileSeed.ts";

export {
  NATIONALITIES,
  NATIONALITY_BY_COUNTRY,
  WORK_ARRANGEMENTS,
  ageOn,
  joinName,
  splitName,
  type DependentRecord,
  type EducationRecord,
  type ExperienceRecord,
  type PersonProfileDetails,
  type WorkArrangement,
} from "./personProfileSeed.ts";

/** "Notice period": an approved exit, still working until the last working day (backend mode). */
export type EmploymentStatus = "Active" | "Onboarding" | "On Leave" | "Contractor" | "Notice period" | "Terminated";

const PRE_START = new Set(["onboarding", "pre-boarding", "pre_boarding", "preboarding"]);

/**
 * Whether this person has started: pre-boarding joiners (status Onboarding / Pre-boarding, or a joining date still
 * ahead) are in the directory and onboarding, but not in headcount, review lists or rosters yet.
 */
export function hasStarted(p: Pick<PersonRecord, "employmentStatus" | "dateOfJoining">, today: string = todayISO()): boolean {
  if (PRE_START.has(String(p.employmentStatus ?? "").trim().toLowerCase())) return false;
  return !p.dateOfJoining || p.dateOfJoining <= today;
}

/** Counts in headcount: started and not left. */
export function inHeadcount(p: Pick<PersonRecord, "employmentStatus" | "dateOfJoining">, today: string = todayISO()): boolean {
  return p.employmentStatus !== "Terminated" && hasStarted(p, today);
}

export interface PersonRecord {
  id: string;
  employeeCode: string;
  fullName: string;
  email: string;
  personalEmail: string;
  mobile: string;
  photo: string;
  gender: string;
  dateOfJoining: string;
  employmentType: string;
  employmentStatus: EmploymentStatus;
  designation: string;
  jobFamily: string;
  jobProfileId: string;
  positionId: string;
  grade: string;
  department: string;
  division: string;
  businessUnit: string;
  costCenter: string;
  location: string;
  countryCode: CountryCode | string;
  countryName: string;
  legalEntity: string;
  managerId: string;
  managerName: string;
  availability: string;
  timeZone: string;
  currency: string;
  address: string;
  /*
   * Personal & background details (blueprint §8–9). Optional on the type so older stored records and
   * other modules that build records still type-check; every record read through peopleLocal has them filled.
   */
  firstName?: string;
  middleName?: string;
  lastName?: string;
  preferredName?: string;
  dateOfBirth?: string;
  nationality?: string;
  workArrangement?: WorkArrangement;
  education?: EducationRecord[];
  experience?: ExperienceRecord[];
  dependents?: DependentRecord[];
  /** Language the person prefers for communication. Employee-editable. */
  preferredLanguage?: string;
  /** Languages the person speaks. Employee-editable. */
  spokenLanguages?: string[];
  /** Where the person wants their career to go. Employee-editable. */
  careerGoals?: string;
  /** Fixed-term / contractor end date (contract extensions move it). */
  contractEndDate?: string;
  /** Date probation was completed (probation completion action). */
  confirmationDate?: string;
  /** Last working day of an approved exit (backend mode: from the server). */
  lastWorkingDay?: string;
  /** Latest rehire date, when the person left and came back. */
  rehireDate?: string;
  /** Current leave of absence, while the person is on one. */
  leaveOfAbsence?: { type: string; start: string; end: string };
  /* HCM workbook fields and server-held profile details (backend mode; masked parts arrive masked). */
  company?: string;
  holidayCalendar?: string;
  leavePolicy?: string;
  payrollStatus?: string;
  aiProfileStatus?: string;
  addressLine?: string;
  addressCity?: string;
  addressPostcode?: string;
  addressCountry?: string;
  emergencyName?: string;
  emergencyRelationship?: string;
  emergencyPhone?: string;
}

/** Languages offered in profile forms. */
export const PROFILE_LANGUAGES = [
  "English",
  "Hindi",
  "Tamil",
  "Malayalam",
  "Telugu",
  "Kannada",
  "Arabic",
  "German",
  "French",
  "Spanish",
  "Urdu",
  "Tagalog",
  "Mandarin",
];

/** Fill any missing personal/background fields (older stored records, records built by other modules). */
export function ensureProfileDetails<T extends PersonRecord>(person: T): T & PersonProfileDetails {
  const has =
    person.firstName !== undefined &&
    person.lastName !== undefined &&
    person.preferredName !== undefined &&
    person.dateOfBirth !== undefined &&
    person.nationality !== undefined &&
    person.workArrangement !== undefined &&
    Array.isArray(person.education) &&
    Array.isArray(person.experience) &&
    Array.isArray(person.dependents);
  if (has) return person as T & PersonProfileDetails;
  const seed = profileDetailsFor({
    id: person.id,
    fullName: person.fullName,
    gender: person.gender,
    dateOfJoining: person.dateOfJoining,
    grade: person.grade,
    department: person.department,
    countryCode: String(person.countryCode),
    availability: person.availability,
  });
  return {
    ...person,
    firstName: person.firstName ?? seed.firstName,
    middleName: person.firstName !== undefined ? person.middleName : seed.middleName,
    lastName: person.lastName ?? seed.lastName,
    preferredName: person.preferredName ?? seed.preferredName,
    dateOfBirth: person.dateOfBirth ?? seed.dateOfBirth,
    nationality: person.nationality ?? seed.nationality,
    workArrangement: person.workArrangement ?? seed.workArrangement,
    education: Array.isArray(person.education) ? person.education : seed.education,
    experience: Array.isArray(person.experience) ? person.experience : seed.experience,
    dependents: Array.isArray(person.dependents) ? person.dependents : seed.dependents,
  };
}

export type OrgNodeType =
  | "company"
  | "country"
  | "legalEntity"
  | "businessUnit"
  | "division"
  | "department"
  | "costCenter"
  | "location"
  | "jobFamily"
  | "jobProfile"
  | "position"
  | "grade"
  | "supervisoryOrg"
  | "employee";

export interface OrgNode {
  id: string;
  type: OrgNodeType;
  name: string;
  code?: string;
  headcount?: number;
  children?: OrgNode[];
  managerName?: string;
  /** Employee nodes link to the person's profile. */
  personId?: string;
  /** Org unit closed to new moves (set by the local org overlay). */
  inactive?: boolean;
  /** Key of the editable org unit behind this node (set by the local org overlay). */
  unitKey?: string;
}

export interface JobFamily {
  id: string;
  name: string;
  profiles: number;
}

export interface JobProfile {
  id: string;
  familyId: string;
  familyName: string;
  title: string;
  gradeBand: string;
  description: string;
  /** Closed to new use (set by the local job overlay). */
  inactive?: boolean;
}

export interface PositionRecord {
  id: string;
  code: string;
  title: string;
  jobProfileId: string;
  jobFamily: string;
  grade: string;
  country: string;
  location: string;
  department: string;
  legalEntity: string;
  managerName: string;
  status: "Open" | "Filled" | "Frozen";
  incumbentId?: string;
  incumbentName?: string;
  requirements: string[];
  openings: number;
  /** Budgeted seats; filled + vacant. Set by the local position overlay. */
  headcount?: number;
  filled?: number;
  /** Closed position (set by the local position overlay). */
  inactive?: boolean;
  /** Added in this portal rather than seeded. */
  added?: boolean;
}

export const LEGAL_BY_COUNTRY: Record<string, string> = {
  IN: "TimeZ India Pvt Ltd",
  US: "TimeZ Inc",
  GB: "TimeZ UK Ltd",
  AU: "TimeZ Australia Pty",
  CA: "TimeZ Canada Inc",
  AE: "TimeZ Middle East FZ",
  SA: "TimeZ Saudi LLC",
  DE: "TimeZ Germany GmbH",
};

/* ───────────── Job catalog ───────────── */

const FAMILY_CODE: Record<string, string> = {
  Engineering: "ENG",
  Product: "PRD",
  People: "PPL",
  Finance: "FIN",
  Sales: "SAL",
  Operations: "OPS",
  "Customer Success": "CSM",
  Legal: "LGL",
  Executive: "EXE",
  "Information Technology": "ITS",
};

const JOB_FAMILY_LIST = Object.keys(FAMILY_CODE);

export const JOB_PROFILES: JobProfile[] = JOB_FAMILY_LIST.flatMap((family, fi) =>
  JOB_CATALOG.filter((j) => j.family === family).map((j, pi) => ({
    id: `JP-${FAMILY_CODE[family]}-${pi + 1}`,
    familyId: `JF-${fi + 1}`,
    familyName: family,
    title: j.title,
    gradeBand: j.grade,
    description: `${j.title} in the ${family} family.`,
  })),
);

export const JOB_FAMILIES: JobFamily[] = JOB_FAMILY_LIST.map((name, i) => ({
  id: `JF-${i + 1}`,
  name,
  profiles: JOB_PROFILES.filter((p) => p.familyName === name).length,
}));

/** Job profile for a title (exact match), or the first profile in the family. */
export function jobProfileFor(title: string, family: string): JobProfile | undefined {
  const t = title.trim().toLowerCase();
  return (
    JOB_PROFILES.find((p) => p.title.toLowerCase() === t) ??
    JOB_PROFILES.find((p) => p.familyName === family)
  );
}

/** Readable job profile, e.g. "Senior Engineer (JP-ENG-3)"; falls back to the raw id. */
export function jobProfileLabel(jobProfileId: string): string {
  if (!jobProfileId) return "";
  const profile = JOB_PROFILES.find((p) => p.id === jobProfileId);
  return profile ? `${profile.title} · ${profile.familyName}` : jobProfileId;
}

/** Readable position: the position title with its code, e.g. "Software Engineer · TIMEZ-ENG-IN-00012". */
export function positionLabel(person: Pick<PersonRecord, "designation" | "positionId">): string {
  if (!person.positionId) return person.designation;
  return `${person.designation} · ${person.positionId}`;
}

export function familyForDepartment(department: string): string {
  return FAMILY_BY_DEPARTMENT[department] ?? "Operations";
}

export function divisionForDepartment(department: string): string {
  return DIVISION_BY_DEPARTMENT[department] ?? "Corporate Services";
}

export function costCenterFor(countryCode: string, department: string): string {
  return `CC-${countryCode}-${DEPARTMENT_CODE[department] ?? "GEN"}`;
}

/* ───────────── Personas ───────────── */

/** Gender and joining date for each named person (the CEO joined first, at founding). */
const NAMED_PEOPLE: Record<string, { gender: string; dateOfJoining: string }> = {
  "demo-ceo": { gender: "Male", dateOfJoining: "2012-03-01" },
  "emp-ram": { gender: "Male", dateOfJoining: "2014-06-16" },
  "demo-hr-admin": { gender: "Male", dateOfJoining: "2015-01-12" },
  "demo-recruiter": { gender: "Female", dateOfJoining: "2018-02-05" },
  "emp-mahesh": { gender: "Male", dateOfJoining: "2019-05-13" },
  "demo-admin": { gender: "Female", dateOfJoining: "2020-01-20" },
};

function countryByCode(code: string) {
  return TIMEZ_COUNTRIES.find((c) => c.code === code) ?? TIMEZ_COUNTRIES[0];
}

/**
 * Reporting line for the sign-in personas. It runs only through other sign-in personas so approvals and the org
 * chart stay within the six accounts: Jordan (CEO) → Farhan → Sophie; Jordan → Ram → Babu; Jordan → Alex.
 * The generated Country Managers keep reporting to the CEO with their own generated teams.
 */
const PERSONA_MANAGER: Record<string, string> = {
  "demo-ceo": "",
  "demo-hr-admin": "demo-ceo",
  "emp-ram": "demo-ceo",
  "demo-admin": "demo-ceo",
  "emp-mahesh": "emp-ram",
  "demo-recruiter": "demo-hr-admin",
};
const CEO_ID = "demo-ceo";

function personaManagerId(account: (typeof DEMO_ACCOUNTS)[number]): string {
  return PERSONA_MANAGER[account.id] ?? (account.id === CEO_ID ? "" : CEO_ID);
}

function positionIdFor(department: string, countryCode: string, employeeCode: string): string {
  const num = employeeCode.replace(/\D/g, "").padStart(5, "0").slice(-5);
  return `TIMEZ-${DEPARTMENT_CODE[department] ?? "GEN"}-${countryCode}-${num}`;
}

function buildBasePeople(): PersonRecord[] {
  const workforce = buildTimezWorkforce();
  const nameById = new Map<string, string>([
    ...DEMO_ACCOUNTS.map((a) => [a.id, a.fullName] as [string, string]),
    ...workforce.map((w) => [w.id, w.name] as [string, string]),
  ]);

  const fromWorkforce: PersonRecord[] = workforce.map((row) => {
    const country = countryByCode(row.countryCode);
    const family = familyForDepartment(row.department);
    return {
      id: row.id,
      employeeCode: row.employeeCode,
      fullName: row.name,
      email: row.email,
      personalEmail: row.personalEmail,
      mobile: row.mobile,
      photo: row.photo,
      gender: row.gender,
      dateOfJoining: row.dateOfJoining,
      employmentType: row.status === "Contractor" ? "Contract" : "Full Time",
      employmentStatus: row.status,
      designation: row.designation,
      jobFamily: family,
      jobProfileId: jobProfileFor(row.designation, family)?.id ?? "",
      positionId: row.positionId,
      grade: row.grade,
      department: row.department,
      division: divisionForDepartment(row.department),
      businessUnit: row.businessUnit,
      costCenter: costCenterFor(country.code, row.department),
      location: row.location,
      countryCode: country.code,
      countryName: country.name,
      legalEntity: LEGAL_BY_COUNTRY[country.code] ?? "TimeZ",
      managerId: row.managerId,
      managerName: nameById.get(row.managerId) ?? "",
      availability: row.availability,
      timeZone: country.timeZone,
      currency: country.currency,
      address: `${row.location}, ${country.name}`,
    };
  });

  const personas: PersonRecord[] = DEMO_ACCOUNTS.map((account) => {
    const country = countryByCode(account.countryCode ?? "IN");
    const department = account.department ?? "Engineering";
    const family = familyForDepartment(department);
    const managerId = personaManagerId(account);
    const facts = NAMED_PEOPLE[account.id] ?? { gender: "Unspecified", dateOfJoining: "2020-01-06" };
    return {
      id: account.id,
      employeeCode: account.employeeCode,
      fullName: account.fullName,
      email: account.email,
      personalEmail: account.email.replace("@timez.com", "@mail.example"),
      mobile: account.mobile,
      photo: account.photo,
      gender: facts.gender,
      dateOfJoining: facts.dateOfJoining,
      employmentType: account.employmentType,
      employmentStatus: "Active" as const,
      designation: account.designation,
      jobFamily: family,
      jobProfileId: jobProfileFor(account.designation, family)?.id ?? "",
      positionId: positionIdFor(department, country.code, account.employeeCode),
      grade: gradeForTitle(account.designation),
      department,
      division: divisionForDepartment(department),
      businessUnit: `TimeZ ${country.name}`,
      costCenter: costCenterFor(country.code, department),
      location: account.location ?? "Bengaluru",
      countryCode: country.code,
      countryName: country.name,
      legalEntity: account.legalEntity ?? LEGAL_BY_COUNTRY[country.code],
      managerId,
      managerName: managerId ? nameById.get(managerId) ?? "" : "",
      availability: "In Office",
      timeZone: account.timeZone,
      currency: account.currency ?? country.currency,
      address: account.address,
    };
  });

  const india = countryByCode("IN");
  const teammates: PersonRecord[] = TEAMMATES.map((t) => ({
    id: t.id,
    employeeCode: t.employeeCode,
    fullName: t.name,
    email: `${t.name.toLowerCase().replace(" ", ".")}@timez.com`,
    personalEmail: `${t.name.toLowerCase().replace(" ", ".")}@mail.example`,
    mobile: t.mobile,
    photo: "/profile.svg",
    gender: t.gender,
    dateOfJoining: t.dateOfJoining,
    employmentType: "Full Time",
    employmentStatus: "Active",
    designation: t.title,
    jobFamily: "Engineering",
    jobProfileId: jobProfileFor(t.title, "Engineering")?.id ?? "",
    positionId: positionIdFor("Engineering", "IN", t.employeeCode),
    grade: gradeForTitle(t.title),
    department: "Engineering",
    division: divisionForDepartment("Engineering"),
    businessUnit: `TimeZ ${india.name}`,
    costCenter: costCenterFor("IN", "Engineering"),
    location: "Bengaluru",
    countryCode: "IN",
    countryName: india.name,
    legalEntity: LEGAL_BY_COUNTRY.IN,
    managerId: TEAMMATE_MANAGER_ID,
    managerName: nameById.get(TEAMMATE_MANAGER_ID) ?? "",
    availability: "In Office",
    timeZone: india.timeZone,
    currency: india.currency,
    address: `Bengaluru, ${india.name}`,
  }));

  const byId = new Map<string, PersonRecord>();
  for (const person of [...fromWorkforce, ...personas, ...teammates]) byId.set(person.id, ensureProfileDetails(person));
  return [...byId.values()].sort((a, b) => a.fullName.localeCompare(b.fullName));
}

let cachedPeople: PersonRecord[] | null = null;

export function getBasePeople(): PersonRecord[] {
  if (!cachedPeople) cachedPeople = buildBasePeople();
  return cachedPeople.map((p) => ({ ...p }));
}

/* ───────────── Positions ───────────── */

const GRADE_RANK = ["L3", "L4", "L5", "L6", "M1", "M2", "M3", "E1"];
export function gradeRank(grade: string): number {
  return GRADE_RANK.indexOf(grade);
}

/** The person at the top of a country's department (the one whose manager sits outside it). */
export function departmentHead(people: PersonRecord[], countryCode: string, department: string): PersonRecord | undefined {
  const group = people.filter(
    (p) => p.countryCode === countryCode && p.department === department && p.employmentStatus !== "Terminated",
  );
  const ids = new Set(group.map((p) => p.id));
  const tops = group.filter((p) => !p.managerId || !ids.has(p.managerId));
  return tops.sort((a, b) => gradeRank(b.grade) - gradeRank(a.grade))[0];
}

type OpenPositionSeed = {
  id: string;
  number: string;
  title: string;
  profileTitle: string;
  department: string;
  countryCode: string;
  location: string;
  status: "Open" | "Frozen";
  requirements: string[];
  openings: number;
  /** Budgeted seats; filled + vacant. Set by the local position overlay. */
  headcount?: number;
  filled?: number;
  /** Closed position (set by the local position overlay). */
  inactive?: boolean;
  /** Added in this portal rather than seeded. */
  added?: boolean;
};

const OPEN_POSITION_SEEDS: OpenPositionSeed[] = [
  { id: "pos-221", number: "90221", title: "Senior React Engineer", profileTitle: "Senior Engineer", department: "Engineering", countryCode: "IN", location: "Bengaluru", status: "Open", requirements: ["5+ years React", "TypeScript", "Design systems"], openings: 3 },
  { id: "pos-218", number: "90218", title: "HR Business Partner", profileTitle: "HR Business Partner", department: "People", countryCode: "GB", location: "London", status: "Open", requirements: ["HRBP experience", "Employee relations", "Workforce planning"], openings: 1 },
  { id: "pos-210", number: "90210", title: "Talent Sourcer", profileTitle: "Talent Acquisition Specialist", department: "People", countryCode: "US", location: "New York", status: "Open", requirements: ["Boolean search", "ATS proficiency", "Stakeholder management"], openings: 2 },
  { id: "pos-205", number: "90205", title: "Finance Analyst", profileTitle: "Finance Analyst", department: "Finance", countryCode: "CA", location: "Toronto", status: "Frozen", requirements: ["FP&A", "Excel / BI", "Month-end close"], openings: 1 },
];

/** Open positions plus one filled position per current employee (every person has their own). */
export function buildPositions(people: PersonRecord[]): PositionRecord[] {
  const open: PositionRecord[] = OPEN_POSITION_SEEDS.map((seed) => {
    const country = countryByCode(seed.countryCode);
    const family = familyForDepartment(seed.department);
    const profile = jobProfileFor(seed.profileTitle, family);
    const manager =
      seed.id === "pos-210"
        ? people.find((p) => p.id === "demo-recruiter")
        : departmentHead(people, seed.countryCode, seed.department);
    return {
      id: seed.id,
      code: `TIMEZ-${DEPARTMENT_CODE[seed.department]}-${seed.countryCode}-${seed.number}`,
      title: seed.title,
      jobProfileId: profile?.id ?? "",
      jobFamily: family,
      grade: profile?.gradeBand ?? gradeForTitle(seed.title),
      country: country.name,
      location: seed.location,
      department: seed.department,
      legalEntity: LEGAL_BY_COUNTRY[seed.countryCode],
      managerName: manager?.fullName ?? "",
      status: seed.status,
      requirements: seed.requirements,
      openings: seed.openings,
    };
  });
  const byId = new Map(people.map((p) => [p.id, p]));
  const filled: PositionRecord[] = people
    .filter((p) => p.employmentStatus !== "Terminated" && p.positionId)
    .map((p) => ({
      id: `pos-${p.id}`,
      code: p.positionId,
      title: p.designation,
      jobProfileId: p.jobProfileId,
      jobFamily: p.jobFamily,
      grade: p.grade,
      country: p.countryName,
      location: p.location,
      department: p.department,
      legalEntity: p.legalEntity,
      managerName: (p.managerId && byId.get(p.managerId)?.fullName) || p.managerName,
      status: "Filled" as const,
      incumbentId: p.id,
      incumbentName: p.fullName,
      requirements: [],
      openings: 0,
    }));
  return [...open, ...filled];
}

/* ───────────── Organization tree ───────────── */

const DEPARTMENT_ORDER: string[] = ["Executive", ...DEPARTMENTS, "IT", "Talent Acquisition", "Total Rewards"];
function departmentSort(a: string, b: string): number {
  const ia = DEPARTMENT_ORDER.indexOf(a);
  const ib = DEPARTMENT_ORDER.indexOf(b);
  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
}

function groupBy<T>(rows: T[], key: (row: T) => string): [string, T[]][] {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = map.get(k);
    if (list) list.push(row);
    else map.set(k, [row]);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
}

/**
 * Below a location: Job family → Job profile → Position → Grade → Supervisory organization
 * ("<Manager>'s team") → Employee. Built from the people at that location only.
 */
function jobLevels(people: PersonRecord[], parentId: string, nameById: Map<string, string>): OrgNode[] {
  return groupBy(people, (p) => p.jobFamily || "Unassigned").map(([family, inFamily]) => {
    const familyId = `${parentId}|jf-${family}`;
    return {
      id: familyId,
      type: "jobFamily" as const,
      name: family,
      headcount: inFamily.length,
      children: groupBy(inFamily, (p) => p.jobProfileId || "none").map(([profileId, inProfile]) => {
        const profileNodeId = `${familyId}|jp-${profileId}`;
        const profile = JOB_PROFILES.find((jp) => jp.id === profileId);
        return {
          id: profileNodeId,
          type: "jobProfile" as const,
          name: profile?.title ?? "No job profile",
          code: profile?.id,
          headcount: inProfile.length,
          children: groupBy(inProfile, (p) => p.positionId || p.id).map(([positionCode, inPosition]) => {
            const positionNodeId = `${profileNodeId}|pos-${positionCode}`;
            return {
              id: positionNodeId,
              type: "position" as const,
              name: inPosition[0].designation,
              code: inPosition[0].positionId || undefined,
              headcount: inPosition.length,
              children: groupBy(inPosition, (p) => p.grade || "—").map(([grade, inGrade]) => {
                const gradeNodeId = `${positionNodeId}|gr-${grade}`;
                return {
                  id: gradeNodeId,
                  type: "grade" as const,
                  name: grade,
                  headcount: inGrade.length,
                  children: groupBy(inGrade, (p) => p.managerId || "").map(([managerId, inTeam]) => {
                    const teamNodeId = `${gradeNodeId}|sup-${managerId || "top"}`;
                    const managerName = (managerId && nameById.get(managerId)) || inTeam[0].managerName;
                    return {
                      id: teamNodeId,
                      type: "supervisoryOrg" as const,
                      name: managerName ? `${managerName}'s team` : "Top of the company",
                      headcount: inTeam.length,
                      managerName: managerName || undefined,
                      children: inTeam.map((p) => ({
                        id: `${teamNodeId}|emp-${p.id}`,
                        type: "employee" as const,
                        name: p.fullName,
                        code: p.employeeCode,
                        headcount: 1,
                        personId: p.id,
                      })),
                    };
                  }),
                };
              }),
            };
          }),
        };
      }),
    };
  });
}

/**
 * Company → Country → Legal entity → Business unit → Division → Department → Cost center → Location →
 * Job family → Job profile → Position → Grade → Supervisory organization → Employee (blueprint §11).
 * The page renders only expanded nodes, so the deep levels cost nothing until opened.
 */
export function buildOrgTree(people: PersonRecord[]): OrgNode {
  const active = people.filter((p) => p.employmentStatus !== "Terminated");
  const nameById = new Map(people.map((p) => [p.id, p.fullName]));
  const byCountry: OrgNode[] = TIMEZ_COUNTRIES.map((country) => {
    const inCountry = active.filter((p) => p.countryCode === country.code);
    const divisions = [...new Set(inCountry.map((p) => p.division || divisionForDepartment(p.department)))].sort(
      (a, b) => DIVISION_ORDER.indexOf(a) - DIVISION_ORDER.indexOf(b),
    );
    const countryHead = departmentHead(people, country.code, "Executive");
    return {
      id: `country-${country.code}`,
      type: "country" as const,
      name: country.name,
      code: country.code,
      headcount: inCountry.length,
      managerName: countryHead?.fullName,
      children: [
        {
          id: `le-${country.code}`,
          type: "legalEntity" as const,
          name: LEGAL_BY_COUNTRY[country.code],
          headcount: inCountry.length,
          children: [
            {
              id: `bu-${country.code}`,
              type: "businessUnit" as const,
              name: `TimeZ ${country.name}`,
              headcount: inCountry.length,
              children: divisions.map((division) => {
                const inDivision = inCountry.filter((p) => (p.division || divisionForDepartment(p.department)) === division);
                const depts = [...new Set(inDivision.map((p) => p.department))].sort(departmentSort);
                return {
                  id: `div-${country.code}-${division}`,
                  type: "division" as const,
                  name: division,
                  headcount: inDivision.length,
                  children: depts.map((dept) => {
                    const inDept = inDivision.filter((p) => p.department === dept);
                    const centers = [...new Set(inDept.map((p) => p.costCenter))].sort();
                    return {
                      id: `dept-${country.code}-${dept}`,
                      type: "department" as const,
                      name: dept,
                      headcount: inDept.length,
                      managerName: departmentHead(people, country.code, dept)?.fullName,
                      children: centers.map((cc) => {
                        const inCc = inDept.filter((p) => p.costCenter === cc);
                        const locations = [...new Set(inCc.map((p) => p.location))].sort();
                        return {
                          id: `cc-${country.code}-${dept}-${cc}`,
                          type: "costCenter" as const,
                          name: cc,
                          headcount: inCc.length,
                          children: locations.map((loc) => {
                            const inLoc = inCc.filter((p) => p.location === loc);
                            const locId = `loc-${country.code}-${dept}-${cc}-${loc}`;
                            return {
                              id: locId,
                              type: "location" as const,
                              name: loc,
                              headcount: inLoc.length,
                              children: jobLevels(inLoc, locId, nameById),
                            };
                          }),
                        };
                      }),
                    };
                  }),
                };
              }),
            },
          ],
        },
      ],
    };
  });

  return {
    id: "company-timez",
    type: "company",
    name: "TimeZ",
    headcount: active.length,
    children: byCountry,
  };
}

export const FILTER_OPTIONS = {
  countries: TIMEZ_COUNTRIES.map((c) => c.name),
  legalEntities: TIMEZ_COUNTRIES.map((c) => LEGAL_BY_COUNTRY[c.code]),
  // Use the departments people actually belong to, so every employee can be found by the filter.
  departments: [...new Set(getBasePeople().map((p) => p.department))].sort(departmentSort),
  employmentStatuses: ["Active", "On Leave", "Contractor", "Terminated"] as EmploymentStatus[],
  jobFamilies: JOB_FAMILY_LIST,
  businessUnits: TIMEZ_COUNTRIES.map((c) => `TimeZ ${c.name}`),
  grades: GRADE_RANK,
};

/** Nationality of someone working in this country (used as a form default). */
export function nationalityForCountry(countryCode: string): string {
  return NATIONALITY_BY_COUNTRY[countryCode] ?? "Other";
}
