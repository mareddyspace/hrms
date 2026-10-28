import { COURSES, LEVEL_RANK, SKILL_LIBRARY, TARGET_ROLES, type Course, type EmployeeSkill, type Requisition, type SkillTrack } from "./talentData.ts";
import type { CareerInterests } from "./talentLocal.ts";

/** Role tracks shown as the functions people pick in their career interests. */
export const TRACK_FUNCTION: Record<SkillTrack, string> = {
  engineering: "Engineering",
  people: "People",
  recruiting: "Talent Acquisition",
  reward: "Total Rewards",
  product: "Product",
  it: "IT",
  executive: "Leadership",
};

/** Requisitions carry no skills, so each department gets a typical requirement. */
const DEPARTMENT_SKILLS: Record<string, Record<string, string>> = {
  Engineering: { "sk-1": "Intermediate", "sk-2": "Intermediate", "sk-7": "Working" },
  IT: { "sk-12": "Advanced", "sk-4": "Intermediate" },
  People: { "sk-8": "Intermediate", "sk-5": "Working" },
  "Talent Acquisition": { "sk-5": "Advanced", "sk-8": "Working" },
  "Total Rewards": { "sk-9": "Advanced", "sk-6": "Intermediate" },
  Finance: { "sk-6": "Advanced", "sk-11": "Working" },
  Product: { "sk-10": "Advanced", "sk-11": "Intermediate" },
};
const FALLBACK_SKILLS: Record<string, string> = { "sk-11": "Working", "sk-3": "Working" };

const DEPARTMENT_FUNCTION: Record<string, string> = {
  Engineering: "Engineering",
  IT: "IT",
  People: "People",
  "Talent Acquisition": "Talent Acquisition",
  "Total Rewards": "Total Rewards",
  Finance: "Total Rewards",
  Product: "Product",
};

export interface RoleOption {
  key: string;
  title: string;
  /** "Career path" (TARGET_ROLES) or "Open job" (approved requisition). */
  source: "Career path" | "Open job";
  function: string;
  required: Record<string, string>;
  targetRoleId?: string;
  location?: string;
  postingId?: string;
}

export interface GapSkill {
  skillId: string;
  name: string;
  have: string;
  need: string;
  levels: number;
  courses: Course[];
}

export interface RoleMatch {
  role: RoleOption;
  /** Skill match, 0–100. */
  match: number;
  /** Ranking score: skill match plus interest fit. */
  score: number;
  reasons: string[];
  gaps: GapSkill[];
}

function requirementFromTitle(title: string): { required: Record<string, string>; targetRoleId?: string } | null {
  const t = title.toLowerCase();
  const role = TARGET_ROLES.find((r) => t.includes(r.title.toLowerCase()));
  return role ? { required: role.required, targetRoleId: role.id } : null;
}

export function roleOptions(openings: Requisition[] = []): RoleOption[] {
  const paths: RoleOption[] = TARGET_ROLES.map((r) => ({
    key: r.id,
    title: r.title,
    source: "Career path",
    function: TRACK_FUNCTION[r.track],
    required: r.required,
    targetRoleId: r.id,
  }));
  const jobs: RoleOption[] = openings.map((req) => {
    const fromTitle = requirementFromTitle(req.title);
    return {
      key: req.id,
      title: req.title,
      source: "Open job",
      function: DEPARTMENT_FUNCTION[req.department] ?? req.department,
      required: fromTitle?.required ?? DEPARTMENT_SKILLS[req.department] ?? FALLBACK_SKILLS,
      targetRoleId: fromTitle?.targetRoleId,
      location: [req.location, req.country].filter(Boolean).join(", "),
      postingId: req.id,
    };
  });
  return [...paths, ...jobs];
}

const rank = (level: string | undefined) => (level ? LEVEL_RANK[level] ?? 0 : 0);

/**
 * Scores each role by how well the person's skills meet its requirements, then nudges the ranking
 * toward their stated interests. Roles they already hold are left out.
 */
export function rankRoles(input: {
  skills: EmployeeSkill[];
  interests?: CareerInterests;
  currentTitle?: string;
  homeLocation?: string;
  openings?: Requisition[];
  courseOpen: (course: Course) => boolean;
  completedCourseIds: string[];
  limit?: number;
}): RoleMatch[] {
  const { skills, interests, currentTitle, homeLocation } = input;
  const current = currentTitle?.trim().toLowerCase();
  return roleOptions(input.openings)
    .filter((role) => role.title.trim().toLowerCase() !== current)
    .map((role) => {
      const entries = Object.entries(role.required);
      const gaps: GapSkill[] = [];
      let total = 0;
      for (const [skillId, need] of entries) {
        const have = skills.find((s) => s.skillId === skillId)?.level;
        total += Math.min(1, rank(have) / Math.max(1, rank(need)));
        const levels = rank(need) - rank(have);
        if (levels > 0) {
          gaps.push({
            skillId,
            name: SKILL_LIBRARY.find((d) => d.id === skillId)?.name ?? skillId,
            have: have ?? "None",
            need,
            levels,
            courses: COURSES.filter((c) => c.skills.includes(skillId) && input.courseOpen(c) && !input.completedCourseIds.includes(c.id)),
          });
        }
      }
      const match = entries.length ? Math.round((total / entries.length) * 100) : 0;
      const reasons: string[] = [];
      let score = match;
      if (interests && role.targetRoleId && interests.targetRoleIds.includes(role.targetRoleId)) {
        score += 15;
        reasons.push("Your target role");
      }
      if (interests?.functions.includes(role.function)) {
        score += 8;
        reasons.push("Preferred function");
      }
      if (role.source === "Open job") {
        score += 3;
        reasons.push("Open now");
        const away = role.location && homeLocation && !role.location.toLowerCase().includes(homeLocation.toLowerCase());
        if (away) {
          if (interests && !interests.openToRelocation) score -= 20;
          reasons.push(interests?.openToRelocation ? "Relocation (you're open to it)" : "Needs relocation");
        }
      }
      return { role, match, score, reasons, gaps: gaps.sort((a, b) => b.levels - a.levels) };
    })
    .sort((a, b) => b.score - a.score || b.match - a.match || a.role.title.localeCompare(b.role.title))
    .slice(0, input.limit ?? 5);
}
