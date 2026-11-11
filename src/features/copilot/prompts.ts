/**
 * Suggested Copilot questions per role. Every one of these is answered by the built-in rules (answers.ts,
 * moreAnswers.ts, analytics) and, when AI is on, from the same permission-checked data on the server.
 */
export type PromptPersona = "employee" | "manager" | "hr" | "recruiter" | "executive" | "admin" | "other";

export function promptPersona(role: string): PromptPersona {
  if (role === "employee") return "employee";
  if (role === "manager") return "manager";
  if (role === "hr" || role === "hr_admin" || role === "hrbp") return "hr";
  if (role === "recruiter") return "recruiter";
  if (role === "executive" || role === "founder" || role === "cofounder") return "executive";
  if (role === "it_admin" || role === "admin" || role === "super_admin" || role === "compliance") return "admin";
  return "other";
}

/** Questions everyone can ask about their own data. */
const SELF_SERVICE = [
  "What is my leave balance?",
  "Do I have any upcoming leave?",
  "When is the next holiday?",
  "Did I check in today?",
  "How many days was I late this month?",
  "Timesheet status this week",
  "When is payday?",
  "My last payslip net pay",
  "Status of my tax declarations",
  "Status of my expense claims",
  "My travel requests",
  "What tasks are assigned to me?",
  "Which tickets do I own?",
  "Which mandatory courses are due for me?",
  "How are my goals going?",
  "Who is my manager?",
  "When did I join?",
  "Who hired me?",
  "Where do I update my bank details?",
  "What is the sick leave policy?",
];

export const COPILOT_PROMPTS: Record<PromptPersona, string[]> = {
  employee: [...SELF_SERVICE, "Who does Ram Krishnan report to?", "Where do I raise an HR request?", "What skills do I need for my next role?"],
  manager: [
    "What is waiting on my approval?",
    "Who is on leave this week?",
    "Who in my team took the most leave?",
    "Who reports to me?",
    "My team by country",
    "Summarise Babu Menon",
    "Overtime by person this month",
    ...SELF_SERVICE,
  ],
  hr: [
    "Give me a headcount snapshot",
    "Headcount by department",
    "Headcount by country",
    "Who are the department heads?",
    "Attrition this year",
    "Joiners this month",
    "Who is on leave today?",
    "What is waiting on my approval?",
    "Who hasn't finished mandatory training?",
    "How many candidates are in the pipeline?",
    "Summarise Ram Krishnan",
    ...SELF_SERVICE,
  ],
  recruiter: [
    "How many open positions are there?",
    "How many candidates are in the pipeline?",
    "Candidates by stage",
    "How many offers are open?",
    "Joiners this quarter by department",
    ...SELF_SERVICE,
  ],
  executive: [
    "Give me a headcount snapshot",
    "Headcount by country",
    "Headcount by department",
    "Who are the department heads?",
    "Attrition this year",
    "What is waiting on my approval?",
    "Summarise Ram Krishnan",
    ...SELF_SERVICE,
  ],
  admin: ["Where do I retry an integration?", "Where are AI settings?", "Where do I change roles and permissions?", ...SELF_SERVICE],
  other: ["How do I apply for leave?", "Where are company policies?", "Which holidays are coming up?", "What can Copilot do?", ...SELF_SERVICE],
};

export function promptsForRole(role: string): string[] {
  return [...new Set(COPILOT_PROMPTS[promptPersona(role)])];
}
