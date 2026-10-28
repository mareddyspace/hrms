import { COMPANY_NAME } from "../../brand.ts";
import type { JobProfile } from "../../data/peopleData.ts";
import { needsForRole } from "./candidateMatch.ts";

export type JobDraftInput = {
  title: string;
  familyName: string;
  gradeBand: string;
  department?: string;
  location?: string;
  requirements?: string[];
};

export type JobDraft = {
  summary: string;
  responsibilities: string[];
  required: string[];
  preferred: string[];
  experience: string;
  education: string;
};

const LEVEL: Record<string, { label: string; years: number; scope: string }> = {
  L3: { label: "early-career", years: 1, scope: "deliver well-defined tasks with guidance from senior colleagues" },
  L4: { label: "mid-level", years: 3, scope: "own features and pieces of work end to end with light guidance" },
  L5: { label: "senior", years: 5, scope: "own larger pieces of work and help others on the team" },
  L6: { label: "staff-level", years: 8, scope: "lead work that spans several teams and set direction in your area" },
  M1: { label: "first-line manager", years: 6, scope: "lead a small team and its day-to-day delivery" },
  M2: { label: "manager", years: 8, scope: "lead a team or group of teams, its plans and its people" },
  M3: { label: "senior manager", years: 10, scope: "lead a function, its leaders and its budget" },
  E1: { label: "executive", years: 12, scope: "lead a business area and its strategy" },
};

const FAMILY_WORK: Record<string, string[]> = {
  Engineering: [
    "Design, build and maintain reliable software",
    "Review code and keep quality high through testing",
    "Work with product and design to shape solutions",
    "Improve performance, security and developer tooling",
  ],
  Product: [
    "Understand customer needs through research and data",
    "Own the roadmap and decide priorities with stakeholders",
    "Write clear requirements and success measures",
    "Track outcomes after launch and adjust plans",
  ],
  People: [
    "Advise managers and employees on people matters",
    "Run people processes such as hiring, reviews and changes",
    "Keep policies and records accurate and compliant",
    "Use people data to spot trends and suggest actions",
  ],
  Finance: [
    "Prepare budgets, forecasts and monthly reporting",
    "Analyse variances and explain them to managers",
    "Support month-end close and audits",
    "Improve finance processes and controls",
  ],
  Sales: [
    "Build and manage a pipeline of opportunities",
    "Run discovery calls, demos and proposals",
    "Negotiate and close deals",
    "Keep CRM records accurate and forecasts current",
  ],
  Operations: [
    "Run day-to-day operational processes",
    "Find and fix bottlenecks with data",
    "Coordinate with teams across the business",
    "Track and report service levels",
  ],
  "Customer Success": [
    "Onboard new customers and drive adoption",
    "Be the main contact for a set of accounts",
    "Spot risks early and plan renewals",
    "Share customer feedback with product teams",
  ],
  Legal: [
    "Draft and review contracts and policies",
    "Advise teams on legal and compliance risk",
    "Track regulatory changes that affect the business",
    "Work with outside counsel when needed",
  ],
  Executive: [
    "Set strategy and goals for the business area",
    "Lead senior leaders and build strong teams",
    "Own budget, results and key risks",
    "Represent the company with customers, partners and the board",
  ],
  "Information Technology": [
    "Run and secure the company's systems and devices",
    "Manage user access and identity",
    "Support employees with IT issues",
    "Plan upgrades and work with vendors",
  ],
};

const EDUCATION: Record<string, string> = {
  Engineering: "Degree in computer science or a related field, or equivalent practical experience.",
  Product: "Degree in business, engineering, design or a related field, or equivalent experience.",
  People: "Degree in HR, psychology, business or a related field; a professional HR qualification is a plus.",
  Finance: "Degree in finance, accounting or economics; a professional qualification (e.g. CA, CPA, ACCA) is a plus.",
  Legal: "Law degree and the right to practise in the relevant country.",
  Executive: "Degree or equivalent experience; an advanced degree is a plus.",
  "Information Technology": "Degree in IT or a related field, or relevant certifications and experience.",
};

function level(grade: string) {
  return LEVEL[grade] ?? LEVEL.L4;
}

/** Rule-based job description draft from the role's title, family, grade and the skills library. */
export function draftJobDescription(input: JobDraftInput, variant = 0): JobDraft {
  const lvl = level(input.gradeBand);
  const family = input.familyName || "Operations";
  const needs = needsForRole(input.title, input.department || family, input.requirements ?? []);
  const isManager = /^M|^E/.test(input.gradeBand) || /manager|head|director|lead/i.test(input.title);
  const where = input.location ? ` in ${input.location}` : "";
  const article = /^[aeiou]/i.test(lvl.label) ? "an" : "a";

  const openings = [
    `We are looking for ${article} ${lvl.label} ${input.title} to join our ${family} team${where}.`,
    `${COMPANY_NAME} is hiring ${article} ${input.title}${where} in the ${family} family.`,
    `Join ${COMPANY_NAME} as ${article} ${input.title} and help grow our ${family} team${where}.`,
  ];
  const summary = `${openings[variant % openings.length]} In this ${input.gradeBand} role you will ${lvl.scope}.`;

  const responsibilities = [...(FAMILY_WORK[family] ?? FAMILY_WORK.Operations)];
  if (isManager) responsibilities.push("Hire, coach and grow the team; run regular 1:1s and reviews");
  else if (["L5", "L6"].includes(input.gradeBand)) responsibilities.push("Mentor colleagues and share good practice");
  if (input.gradeBand === "L6" || /^M[23]|^E/.test(input.gradeBand)) responsibilities.push("Set direction and standards across teams");

  const years = Math.max(lvl.years, needs.years);
  const required = [...needs.required];
  if (isManager && !required.includes("People leadership")) required.push("People leadership");

  return {
    summary,
    responsibilities,
    required,
    preferred: needs.preferred.filter((s) => !required.includes(s)),
    experience: `${years}+ years in a similar role${isManager ? ", including leading people" : ""}.`,
    education: EDUCATION[family] ?? "Degree or equivalent practical experience.",
  };
}

export function formatJobDraft(title: string, d: JobDraft): string {
  const list = (items: string[]) => items.map((i) => `- ${i}`).join("\n");
  return [
    title,
    "",
    "Summary",
    d.summary,
    "",
    "Responsibilities",
    list(d.responsibilities),
    "",
    "Required skills",
    list(d.required),
    ...(d.preferred.length ? ["", "Preferred skills", list(d.preferred)] : []),
    "",
    "Experience",
    d.experience,
    "",
    "Education",
    d.education,
  ].join("\n");
}

/** Other profiles that look closest: same family, shared title words, nearby grade. */
export function similarRoles(target: { id?: string; title: string; familyName: string; gradeBand: string }, profiles: JobProfile[], limit = 5): JobProfile[] {
  const words = new Set(target.title.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
  const gradeIdx = (g: string) => Object.keys(LEVEL).indexOf(g);
  return profiles
    .filter((p) => p.id !== target.id && !p.inactive && p.title.toLowerCase() !== target.title.toLowerCase())
    .map((p) => {
      const shared = p.title.toLowerCase().split(/\W+/).filter((w) => words.has(w)).length;
      const gap = Math.abs(gradeIdx(p.gradeBand) - gradeIdx(target.gradeBand));
      return { p, score: (p.familyName === target.familyName ? 3 : 0) + shared * 2 - gap * 0.5 };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.p);
}
