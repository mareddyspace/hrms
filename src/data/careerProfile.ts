import type { PersonRecord } from "./peopleData.ts";
import {
  LEVEL_RANK,
  SKILL_LIBRARY,
  TARGET_ROLES,
  starterSkillsFor,
  type EmployeeSkill,
  type SkillProfile,
  type SkillTrack,
  type TargetRole,
} from "./talentData.ts";
import { apiTargetRoles } from "../api/syncCareer.ts";

const LEVELS = ["Awareness", "Working", "Intermediate", "Advanced", "Expert"];

/** Named people (personas and Ram's teammates) have a hand-written career track in talentData. */
function isNamed(personId: string): boolean {
  return !personId.startsWith("wf-") && !personId.startsWith("local-");
}

const TRACK_BY_DEPARTMENT: Record<string, SkillTrack> = {
  Engineering: "engineering",
  Product: "product",
  People: "people",
  "Talent Acquisition": "recruiting",
  "Total Rewards": "reward",
  IT: "it",
  Executive: "executive",
};

const SKILLS_BY_DEPARTMENT: Record<string, string[]> = {
  Engineering: ["sk-2", "sk-7", "sk-1", "sk-4"],
  Product: ["sk-10", "sk-11", "sk-7"],
  People: ["sk-8", "sk-5", "sk-9"],
  "Talent Acquisition": ["sk-5", "sk-8"],
  "Total Rewards": ["sk-9", "sk-6"],
  Finance: ["sk-6", "sk-11"],
  Sales: ["sk-11", "sk-10"],
  Operations: ["sk-11", "sk-6"],
  "Customer Success": ["sk-10", "sk-11"],
  Legal: ["sk-8", "sk-11"],
  Executive: ["sk-11", "sk-6", "sk-10"],
  IT: ["sk-12", "sk-4"],
};

const GRADE_LEVEL: Record<string, number> = { L3: 1, L4: 1, L5: 2, L6: 3, M1: 3, M2: 3, M3: 4, E1: 4 };
const LEADER_GRADES = new Set(["L6", "M1", "M2", "M3", "E1"]);

function skill(skillId: string, level: number): EmployeeSkill {
  const lv = Math.max(0, Math.min(4, level));
  return {
    skillId,
    skillName: SKILL_LIBRARY.find((s) => s.id === skillId)?.name ?? skillId,
    level: LEVELS[lv],
    targetLevel: LEVELS[Math.min(4, lv + 1)],
  };
}

/** Career track for a person: hand-written for named people, from the department otherwise (null when none fits). */
export function trackFor(person: Pick<PersonRecord, "id" | "department">): SkillTrack | null {
  if (isNamed(person.id)) return starterSkillsFor(person.id).track;
  return TRACK_BY_DEPARTMENT[person.department] ?? null;
}

/** Starting skills before the person edits them: from their department and grade. /skills and the profile both use this. */
export function starterSkills(person: Pick<PersonRecord, "department" | "grade">): EmployeeSkill[] {
  const base = GRADE_LEVEL[person.grade] ?? 1;
  const ids = SKILLS_BY_DEPARTMENT[person.department] ?? ["sk-11"];
  const out = ids.map((id, i) => skill(id, base - (i >= 2 ? 1 : 0)));
  if (LEADER_GRADES.has(person.grade) && !ids.includes("sk-3")) out.push(skill("sk-3", base - 1));
  return out;
}

/** Saved skills, else the department-based starting list. */
export function skillsFor(
  skillProfiles: SkillProfile[],
  person: Pick<PersonRecord, "id" | "department" | "grade">,
): EmployeeSkill[] {
  const saved = skillProfiles.find((p) => p.employeeId === person.id);
  if (saved) return saved.skills;
  return starterSkills(person);
}

export interface SkillGap {
  skillId: string;
  name: string;
  have: string;
  need: string;
  gap: number;
}

/** The next role on the person's track and the skill gaps to reach it. */
export function careerTarget(
  person: Pick<PersonRecord, "id" | "department" | "designation" | "grade">,
  skills: EmployeeSkill[],
): { role: TargetRole; gaps: SkillGap[] } | null {
  const track = trackFor(person);
  if (!track) return null;
  // Backend mode: career paths come from the server (/career/paths) once loaded.
  const roles = (apiTargetRoles() ?? TARGET_ROLES).filter((r) => r.track === track);
  if (!roles.length) return null;
  const current = roles.findIndex((r) => r.title.toLowerCase() === person.designation.toLowerCase());
  const byGrade: Record<string, number> = { L3: 0, L4: 0, L5: 0, L6: 1, M1: 2, M2: 3, M3: 3, E1: 3 };
  const index = current >= 0 ? current + 1 : byGrade[person.grade] ?? 0;
  const role = roles[Math.min(index, roles.length - 1)];
  if (role.title.toLowerCase() === person.designation.toLowerCase()) return null;
  const gaps = Object.entries(role.required).map(([skillId, need]) => {
    const have = skills.find((s) => s.skillId === skillId)?.level ?? "None";
    return {
      skillId,
      name: SKILL_LIBRARY.find((s) => s.id === skillId)?.name ?? skillId,
      have,
      need,
      gap: (LEVEL_RANK[need] ?? 0) - (LEVEL_RANK[have] ?? 0),
    };
  });
  return { role, gaps };
}
