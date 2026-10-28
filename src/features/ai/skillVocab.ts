import { SKILL_LIBRARY } from "../../data/talentData.ts";

/** A skill we can spot in free text. `libraryId` is set when it is in the company skills library. */
export type VocabSkill = { name: string; libraryId?: string; category: string; aliases: string[] };

/** Extra words that point to a library skill. */
const LIBRARY_ALIASES: Record<string, string[]> = {
  "sk-1": ["react", "react.js", "reactjs", "next.js", "nextjs", "redux"],
  "sk-2": ["typescript", "type script"],
  "sk-3": ["people leadership", "people management", "team lead", "led a team", "managed a team", "line management", "mentoring", "mentored"],
  "sk-4": ["cloud architecture", "aws", "azure", "gcp", "google cloud", "kubernetes", "terraform", "cloud"],
  "sk-5": ["recruiting", "recruitment", "talent acquisition", "sourcing", "hiring", "headhunting"],
  "sk-6": ["financial analysis", "fp&a", "financial modelling", "financial modeling", "budgeting", "forecasting", "month-end close"],
  "sk-7": ["system design", "systems design", "software architecture", "distributed systems", "microservices", "scalable systems"],
  "sk-8": ["employee relations", "hrbp", "hr business partner", "grievance", "disciplinary", "workplace investigations"],
  "sk-9": ["reward", "compensation", "payroll", "benefits", "total rewards", "pay benchmarking"],
  "sk-10": ["product management", "product manager", "roadmap", "product discovery", "product owner"],
  "sk-11": ["business strategy", "strategy", "strategic planning", "go-to-market", "p&l"],
  "sk-12": ["platform administration", "system administration", "sysadmin", "active directory", "okta", "identity management", "it administration"],
};

/** Common skills outside the library; kept so recruiters still see them. */
const EXTRA: { name: string; category: string; aliases: string[] }[] = [
  { name: "JavaScript", category: "Engineering", aliases: ["javascript", "es6", "js"] },
  { name: "Node.js", category: "Engineering", aliases: ["node.js", "nodejs", "node", "express"] },
  { name: "Python", category: "Engineering", aliases: ["python", "django", "flask"] },
  { name: "Java", category: "Engineering", aliases: ["java", "spring boot"] },
  { name: "SQL", category: "Data", aliases: ["sql", "postgres", "postgresql", "mysql"] },
  { name: "Design systems", category: "Engineering", aliases: ["design systems", "design system", "component library", "storybook"] },
  { name: "Testing", category: "Engineering", aliases: ["jest", "cypress", "playwright", "unit testing", "test automation"] },
  { name: "CI/CD", category: "Engineering", aliases: ["ci/cd", "github actions", "jenkins", "devops"] },
  { name: "Data analysis", category: "Data", aliases: ["data analysis", "analytics", "tableau", "power bi", "looker"] },
  { name: "Excel / BI", category: "Finance", aliases: ["excel", "power bi", "bi tools"] },
  { name: "User research", category: "Product", aliases: ["user research", "usability testing", "user interviews"] },
  { name: "UX design", category: "Product", aliases: ["ux", "ui design", "figma", "wireframing", "prototyping"] },
  { name: "Workforce planning", category: "People", aliases: ["workforce planning", "headcount planning", "org design"] },
  { name: "Boolean search", category: "People", aliases: ["boolean search", "x-ray search"] },
  { name: "ATS proficiency", category: "People", aliases: ["ats", "greenhouse", "lever", "workday recruiting", "applicant tracking"] },
  { name: "Stakeholder management", category: "Business", aliases: ["stakeholder management", "stakeholder", "cross-functional"] },
  { name: "Customer onboarding", category: "Customer", aliases: ["customer onboarding", "customer success", "account management", "renewals"] },
  { name: "Communication", category: "Business", aliases: ["communication", "presentation", "public speaking"] },
  { name: "Agile delivery", category: "Engineering", aliases: ["agile", "scrum", "kanban", "sprint planning"] },
  { name: "Employment law", category: "Legal", aliases: ["employment law", "labour law", "labor law"] },
];

export const VOCAB: VocabSkill[] = [
  ...SKILL_LIBRARY.map((s) => ({ name: s.name, libraryId: s.id, category: s.category, aliases: LIBRARY_ALIASES[s.id] ?? [s.name.toLowerCase()] })),
  ...EXTRA,
];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when `alias` appears in `text` as a whole word or phrase. */
export function mentions(text: string, alias: string): boolean {
  const re = new RegExp(`(^|[^a-z0-9+#])${escapeRe(alias.toLowerCase())}($|[^a-z0-9+#])`, "i");
  return re.test(text);
}

/** Skills named in the text, library skills first. */
export function findSkills(text: string): VocabSkill[] {
  const lower = text.toLowerCase();
  const found = VOCAB.filter((s) => s.aliases.some((a) => mentions(lower, a)) || mentions(lower, s.name));
  return [...found.filter((s) => s.libraryId), ...found.filter((s) => !s.libraryId)];
}

/** Map a free-text skill (e.g. "5+ years React", "reactjs") to a vocabulary name, if any. */
export function canonicalSkill(raw: string): string | undefined {
  return findSkills(raw)[0]?.name;
}

/** Same skill, ignoring case and aliases. */
export function sameSkill(a: string, b: string): boolean {
  if (a.trim().toLowerCase() === b.trim().toLowerCase()) return true;
  const ca = canonicalSkill(a);
  return !!ca && ca === canonicalSkill(b);
}
