import { buildPositions } from "../../data/peopleData.ts";
import { listPeople } from "../../data/peopleLocal.ts";
import type { Candidate, Requisition } from "../../data/talentData.ts";
import { canonicalSkill, findSkills, sameSkill } from "./skillVocab.ts";

export type RoleNeeds = { required: string[]; preferred: string[]; years: number; source: string };

/** Skills that usually come with words in a job title. */
const TITLE_SKILLS: { re: RegExp; skills: string[] }[] = [
  { re: /react|front ?end|frontend/i, skills: ["React", "TypeScript", "Design systems", "Testing"] },
  { re: /engineer|developer/i, skills: ["System design", "TypeScript", "CI/CD", "Agile delivery"] },
  { re: /cloud|devops|platform|sre/i, skills: ["Cloud architecture", "CI/CD", "Platform administration"] },
  { re: /product manager|product owner|head of product/i, skills: ["Product management", "Stakeholder management", "User research", "Data analysis"] },
  { re: /product analyst|analyst/i, skills: ["Data analysis", "SQL", "Stakeholder management"] },
  { re: /designer|ux/i, skills: ["UX design", "User research", "Design systems"] },
  { re: /hr business partner|hrbp|people partner/i, skills: ["Employee relations", "Workforce planning", "Stakeholder management", "Reward and pay"] },
  { re: /recruit|talent|sourcer/i, skills: ["Recruiting", "Boolean search", "ATS proficiency", "Stakeholder management"] },
  { re: /finance|accountant|fp&a/i, skills: ["Financial analysis", "Excel / BI", "Stakeholder management"] },
  { re: /reward|compensation|payroll/i, skills: ["Reward and pay", "Financial analysis", "Excel / BI"] },
  { re: /customer success|account manager|support/i, skills: ["Customer onboarding", "Communication", "Stakeholder management"] },
  { re: /it |administrator|it$/i, skills: ["Platform administration", "Cloud architecture"] },
  { re: /manager|lead|head|director/i, skills: ["People leadership"] },
];

const DEPARTMENT_SKILLS: Record<string, string[]> = {
  Engineering: ["System design", "TypeScript"],
  Product: ["Product management", "Stakeholder management"],
  People: ["Employee relations", "Stakeholder management"],
  Finance: ["Financial analysis", "Excel / BI"],
  "Customer Success": ["Customer onboarding", "Communication"],
  Sales: ["Communication", "Stakeholder management"],
  "Information Technology": ["Platform administration"],
};

export function yearsForTitle(title: string): number {
  if (/director|vp|vice president|chief|head of/i.test(title)) return 10;
  if (/principal|staff|lead/i.test(title)) return 7;
  if (/manager/i.test(title)) return 6;
  if (/senior|sr\.?\s/i.test(title)) return 5;
  if (/junior|associate|intern|graduate|sourcer/i.test(title)) return 1;
  return 3;
}

function uniq(list: string[]): string[] {
  const out: string[] = [];
  for (const s of list) if (s && !out.some((o) => sameSkill(o, s))) out.push(s);
  return out;
}

/** Skills and experience a role asks for: the open position's requirements first, then the title. */
export function needsForRole(title: string, department: string, requirements: string[] = []): RoleNeeds {
  const fromReqs = requirements.map((r) => canonicalSkill(r) ?? r.replace(/^\d+\+?\s*years?\s*(of\s+)?/i, "").trim());
  const stated = requirements.map((r) => r.match(/(\d+)\s*\+?\s*years?/i)?.[1]).filter(Boolean).map(Number);
  const fromTitle = TITLE_SKILLS.filter((t) => t.re.test(` ${title} `)).flatMap((t) => t.skills);
  const fromDept = DEPARTMENT_SKILLS[department] ?? [];
  const all = uniq([...fromReqs, ...fromTitle, ...fromDept]);
  const requiredCount = Math.max(3, Math.min(4, fromReqs.length || 3));
  return {
    required: all.slice(0, requiredCount),
    preferred: all.slice(requiredCount, requiredCount + 3),
    years: stated.length ? Math.max(...stated) : yearsForTitle(title),
    source: requirements.length ? "position requirements and job title" : "job title and department",
  };
}

export function needsForRequisition(req: Requisition): RoleNeeds {
  let requirements: string[] = [];
  try {
    const pos = buildPositions(listPeople()).find((p) => p.status !== "Filled" && p.title.toLowerCase() === req.title.toLowerCase());
    requirements = pos?.requirements ?? [];
  } catch {
    requirements = [];
  }
  return needsForRole(req.title, req.department, requirements);
}

export type MatchResult = {
  score: number;
  band: "Strong" | "Partial" | "Weak";
  matched: string[];
  missing: string[];
  preferredMatched: string[];
  years: number;
  yearsNeeded: number;
  summary: string;
  questions: string[];
};

/** Candidate skills, plus anything recognisable in their CV note. */
function candidateSkills(c: Candidate): string[] {
  return uniq([...c.skills, ...findSkills(c.resumeNote).map((s) => s.name)]);
}

const has = (skills: string[], need: string) => skills.some((s) => sameSkill(s, need));

function questionFor(skill: string): string {
  const q: Record<string, string> = {
    React: "Walk us through how you would structure state in a large React app.",
    TypeScript: "How have you used TypeScript types to prevent bugs in a real project?",
    "System design": "Design a service that handles a sudden 10x traffic spike. What would you change first?",
    "Design systems": "How would you roll out a shared component across several teams?",
    "People leadership": "Tell us about a time you helped someone on your team improve.",
    "Cloud architecture": "How would you choose between managed services and running your own in the cloud?",
    Recruiting: "How do you build a shortlist for a hard-to-fill role?",
    "Employee relations": "Describe a difficult employee relations case and how you handled it.",
    "Workforce planning": "How would you plan headcount for a team growing 30% next year?",
    "Stakeholder management": "Tell us about a time you had to align people with different goals.",
    "Financial analysis": "How would you explain a budget variance to a non-finance manager?",
    "Product management": "How do you decide what goes into the next release and what waits?",
    "Boolean search": "Show how you would search for this role on LinkedIn.",
    "ATS proficiency": "Which ATS have you used and how did you keep the data clean?",
  };
  return q[skill] ?? `This role needs ${skill}. Tell us about any related work you have done.`;
}

/** Rule-based fit between a candidate and a role. A draft for people to review, not a decision. */
export function matchCandidate(c: Candidate, needs: RoleNeeds): MatchResult {
  const skills = candidateSkills(c);
  const matched = needs.required.filter((s) => has(skills, s));
  const missing = needs.required.filter((s) => !has(skills, s));
  const preferredMatched = needs.preferred.filter((s) => has(skills, s));
  const req = needs.required.length ? matched.length / needs.required.length : 1;
  const pref = needs.preferred.length ? preferredMatched.length / needs.preferred.length : 0;
  const exp = needs.years ? Math.min(1, c.experienceYears / needs.years) : 1;
  const score = Math.round(req * 60 + pref * 15 + exp * 25);
  const band = score >= 75 ? "Strong" : score >= 50 ? "Partial" : "Weak";
  const first = c.name.split(" ")[0];

  const parts: string[] = [];
  parts.push(
    matched.length
      ? `${first} shows ${matched.length} of ${needs.required.length} core skills (${matched.join(", ")}).`
      : `${first}'s profile does not show the core skills for this role yet.`,
  );
  if (c.experienceYears >= needs.years) parts.push(`${c.experienceYears} years of experience meets the ${needs.years}+ asked for.`);
  else parts.push(`${c.experienceYears} years of experience is below the ${needs.years}+ asked for.`);
  if (missing.length) parts.push(`Worth probing: ${missing.join(", ")}.`);
  if (preferredMatched.length) parts.push(`Also brings ${preferredMatched.join(", ")}.`);

  const questions: string[] = missing.map(questionFor);
  if (c.experienceYears < needs.years) questions.push(`You have about ${c.experienceYears} years of experience. What work best shows you are ready for this level?`);
  for (const s of matched) {
    if (questions.length >= 5) break;
    questions.push(`Give an example where your ${s} work made a clear difference. What would you do differently now?`);
  }
  const fallback = [
    "What attracted you to this role, and what would you want to achieve in the first 90 days?",
    "Tell us about a time a project did not go to plan. What did you learn?",
    "How do you keep your skills current?",
  ];
  for (const f of fallback) if (questions.length < 5) questions.push(f);

  return {
    score,
    band,
    matched,
    missing,
    preferredMatched,
    years: c.experienceYears,
    yearsNeeded: needs.years,
    summary: parts.join(" "),
    questions: questions.slice(0, 5),
  };
}
