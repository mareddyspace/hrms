import { COMPANY_NAME, PRODUCT_NAME, PRODUCT_TAGLINE } from "../brand.ts";
import type { DemoAccount, NavAccessId } from "../demoAccounts.ts";
import type { CountryCode, UserRole } from "../model.ts";
import { TIMEZ_COUNTRIES } from "../model.ts";

export type AnalyticsRange = "7d" | "30d" | "90d" | "ytd";

export const ANALYTICS_RANGES: { id: AnalyticsRange; label: string }[] = [
  { id: "7d", label: "Last 7 days" },
  { id: "30d", label: "Last 30 days" },
  { id: "90d", label: "Last 90 days" },
  { id: "ytd", label: "Year to date" },
];


/* —— AI Copilot —— */

export type CopilotPersona =
  | "employee"
  | "manager"
  | "hr"
  | "recruiter"
  | "executive"
  | "admin"
  | "other";

export function copilotPersonaFromRole(role: UserRole): CopilotPersona {
  if (role === "employee") return "employee";
  if (role === "manager" || role === "hiring_manager") return "manager";
  if (role === "hr" || role === "hr_admin" || role === "hrbp") return "hr";
  if (role === "recruiter") return "recruiter";
  if (role === "executive" || role === "founder" || role === "cofounder") return "executive";
  if (role === "it_admin" || role === "admin" || role === "super_admin" || role === "compliance") return "admin";
  return "other";
}

export const COPILOT_SUGGESTIONS: Record<CopilotPersona, string[]> = {
  employee: [
    "How do I apply for leave?",
    "What is my leave balance?",
    "What are my working hours?",
    "Which holidays are coming up?",
  ],
  manager: [
    "What is waiting on my approval?",
    "Who in my team took the most leave?",
    "Summarise Babu Menon",
    "What is my leave balance?",
  ],
  hr: [
    "Give me a headcount snapshot",
    "What is waiting on my approval?",
    "Summarise Ram Krishnan",
    "What is my leave balance?",
  ],
  recruiter: [
    "Where do I see the recruiting pipeline?",
    "What is my leave balance?",
    "Which holidays are coming up?",
    "How do I apply for leave?",
  ],
  executive: [
    "Give me a headcount snapshot",
    "What is waiting on my approval?",
    "Summarise Ram Krishnan",
    "Which holidays are coming up?",
  ],
  admin: [
    "Where do I retry an integration?",
    "What is my leave balance?",
    "Which holidays are coming up?",
    "How do I apply for leave?",
  ],
  other: [
    "How do I apply for leave?",
    "Where are company policies?",
    "Which holidays are coming up?",
    "What can Copilot do?",
  ],
};

export type CopilotAnswerKind = "text" | "table" | "metrics";

export interface CopilotAnswer {
  kind: CopilotAnswerKind;
  summary: string;
  metrics?: { label: string; value: string }[];
  table?: { headers: string[]; rows: string[][] };
  links?: { label: string; to: string }[];
}

function hasAny(q: string, words: string[]) {
  return words.some((w) => q.includes(w));
}

function hasAll(q: string, words: string[]) {
  return words.every((w) => q.includes(w));
}

/** Who is asking — answers and links are trimmed to what this persona may open. */
export type CopilotViewer = Pick<DemoAccount, "role" | "navAccess">;

/**
 * Live, already-scoped data the page hands to Copilot. Everything here is either the viewer's own
 * record or people below them in the reporting line — Copilot never reads anything wider.
 */
export interface CopilotContext {
  viewer: CopilotViewer;
  firstName: string;
  countryName: string;
  timeZone: string;
  shiftHours: string;
  managerName?: string;
  leaveRows: { name: string; code: string; available: number; pending: number }[];
  holidays: { date: string; name: string }[];
  /** Items the viewer decides — same rules and total as countWaitingOnMe. */
  approvals: { who: string; kind: string; detail: string; date: string }[];
  approvalsCount: number;
  teamSize: number;
  /** Approved leave days this year for people below the viewer. */
  teamLeave: { name: string; days: number }[];
  /** True when the viewer may see company-wide workforce numbers. */
  orgWide: boolean;
  workforce?: { headcount: number; joiners: number; exits: number; attritionPct: number };
  /** Set when no live data was supplied. */
  limited?: boolean;
  /**
   * "AI Employee 360": finds a colleague by name and returns their summary only when the viewer is HR,
   * the person themselves, or above them in the reporting line. Never includes pay.
   */
  summarisePerson?: (query: string) => CopilotPersonLookup;
}

/** Result of an Employee 360 lookup. Denied results carry no data about the person. */
export type CopilotPersonLookup =
  | {
      status: "ok";
      id: string;
      name: string;
      headline: string;
      metrics: { label: string; value: string }[];
      table?: { headers: string[]; rows: string[][] };
      notes: string[];
    }
  | { status: "denied" }
  | { status: "not_found" }
  | { status: "ambiguous"; names: string[] };

const SUMMARY_INTENT =
  /^(?:please |can you |could you )?(?:summari[sz]e|give me (?:a )?summary of|summary of|summary for|employee 360 (?:for|of)|ai employee 360 (?:for|of)|360 (?:view )?(?:for|of))\s+(.+)$/;

/** The name asked about in "summarise <name>" style questions, or null. */
export function summaryTarget(question: string): string | null {
  const q = question.toLowerCase().replace(/[?!.,'"]/g, " ").replace(/\s+/g, " ").trim();
  const match = q.match(SUMMARY_INTENT);
  const name = match?.[1]?.replace(/^(?:of|for|about)\s+/, "").replace(/\s+(?:please|profile|record)$/, "").trim();
  if (!name || name.length < 2 || /^(?:my|our|the|this|these|all|team|leave|approvals?)\b/.test(name)) return null;
  return name;
}

function personSummaryAnswer(target: string, ctx: CopilotContext): RawCopilotAnswer {
  if (!ctx.summarisePerson) {
    return {
      kind: "text",
      summary: "Open the full Copilot page to get a colleague summary.",
      links: [{ label: "AI Copilot", to: "/ai/copilot" }],
    };
  }
  const found = ctx.summarisePerson(target);
  if (found.status === "denied") {
    return {
      kind: "text",
      summary: "I can only summarise people below you in the reporting line. HR can summarise anyone.",
      links: [{ label: "Directory", to: "/directory" }],
    };
  }
  if (found.status === "not_found") {
    return { kind: "text", summary: `I couldn't find anyone called "${target}". Try their full name.`, links: [{ label: "Directory", to: "/directory" }] };
  }
  if (found.status === "ambiguous") {
    return {
      kind: "text",
      summary: `More than one person matches "${target}": ${found.names.join(", ")}. Which one did you mean?`,
    };
  }
  return {
    kind: "metrics",
    summary: [found.headline, ...found.notes].join(" "),
    metrics: found.metrics,
    table: found.table,
    links: [
      { label: "Open profile", to: `/people/${found.id}` },
      { label: "Performance", to: "/evaluations" },
    ],
  };
}

/** Internal: an answer may name the module whose data it reveals. */
type RawCopilotAnswer = CopilotAnswer & { requires?: NavAccessId };

/** Route → nav access id, so Copilot never links to pages the viewer can't open. */
const COPILOT_LINK_ACCESS: Record<string, NavAccessId> = {
  "/": "home",
  "/info": "profile",
  "/calendar": "calendar",
  "/org-chart": "orgchart",
  "/tasks": "tasks",
  "/chat": "messages",
  "/notifications": "notifications",
  "/announcements": "announcements",
  "/help": "help",
  "/attendance": "attendance",
  "/leave": "leave",
  "/holidays": "holidays",
  "/timesheet": "timesheet",
  "/payslips": "payslips",
  "/benefits": "benefits",
  "/expenses": "expenses",
  "/reimbursement": "expenses",
  "/documents": "documents",
  "/team": "team",
  "/approvals": "inbox",
  "/workflows": "workflows",
  "/directory": "people",
  "/organization": "organization",
  "/jobs": "jobs",
  "/compensation": "compensation",
  "/recruiting": "recruiting",
  "/onboarding": "onboarding",
  "/analytics": "analytics",
  "/evaluations": "performance",
  "/programs": "learning",
  "/skills": "skills",
  "/ai/agents": "agents",
  "/integrations": "integrations",
  "/payroll": "payroll",
  "/admin": "administration",
};

function viewerHas(viewer: CopilotViewer, id: NavAccessId): boolean {
  return viewer.navAccess.includes("*") || viewer.navAccess.includes(id);
}

const NO_DECISIONS = "I can't approve, reject or change anything — decisions are made in Approvals.";

/** Rule-based Copilot over the viewer's own, already-scoped data. */
export function answerCopilot(question: string, input: CopilotContext | CopilotViewer): CopilotAnswer {
  // Callers that only pass the viewer get no personal data: answers point to the right page instead.
  const ctx: CopilotContext =
    "viewer" in input
      ? input
      : {
          viewer: input,
          firstName: "",
          countryName: "your country",
          timeZone: "",
          shiftHours: "",
          leaveRows: [],
          holidays: [],
          approvals: [],
          approvalsCount: 0,
          teamSize: 0,
          teamLeave: [],
          orgWide: false,
          limited: true,
        };
  const { viewer } = ctx;
  if (ctx.limited) {
    const q = question.toLowerCase();
    if (/(leave|balance|holiday|approv|waiting|pending|shift|hours|team|headcount|attrition)/.test(q)) {
      return {
        kind: "text",
        summary: `Open the full Copilot page for answers from your own data. ${NO_DECISIONS}`,
        links: [{ label: "AI Copilot", to: "/ai/copilot" }],
      };
    }
  }
  const { requires, ...raw } = rawCopilotAnswer(question, ctx);
  const allowedLink = (l: { to: string }) => {
    const id = COPILOT_LINK_ACCESS[l.to];
    return !id || viewerHas(viewer, id);
  };
  if (requires && !viewerHas(viewer, requires)) {
    return {
      kind: "text",
      summary: "That isn't available with your current access. Ask your manager or HR if you need it.",
      links: [{ label: "Help", to: "/help" }].filter(allowedLink),
    };
  }
  const links = raw.links?.filter(allowedLink);
  return { ...raw, links: links?.length ? links : undefined };
}

function fmtDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function rawCopilotAnswer(question: string, ctx: CopilotContext): RawCopilotAnswer {
  const q = question.toLowerCase().replace(/[?!.,'"]/g, " ").replace(/\s+/g, " ").trim();
  const balances = ctx.leaveRows.filter((r) => r.code !== "unpaid");

  const target = summaryTarget(question);
  if (target) return personSummaryAnswer(target, ctx);

  if (hasAny(q, ["company name", "organisation name", "organization name", "who are we", "brand name"]) ||
      (hasAny(q, ["company", "organisation", "organization", "employer"]) && hasAny(q, ["name", "called", "brand"]))) {
    return {
      kind: "text",
      summary: `You work for ${COMPANY_NAME} (${PRODUCT_TAGLINE}).`,
      links: [
        { label: "My profile", to: "/info" },
        { label: "Organization", to: "/organization" },
      ],
    };
  }

  if (hasAny(q, ["product name", "app name", "portal name", "what is this app", "what is this portal"])) {
    return { kind: "text", summary: `${PRODUCT_NAME} is the ${COMPANY_NAME} employee portal.`, links: [{ label: "Home", to: "/" }] };
  }

  if (hasAny(q, ["copilot", "how do you work", "are you real", "llm", "chatgpt", "what can you do"])) {
    return {
      kind: "text",
      summary: `I answer from your own portal data and your team's, within your access. Ask "Summarise <name>" for a colleague below you. ${NO_DECISIONS}`,
      links: [{ label: "Help", to: "/help" }],
    };
  }

  if (
    hasAny(q, ["working hours", "work hours", "office hours", "shift", "business hours", "start time", "end time", "what time do i", "when do i work", "working time", "duty hours"]) ||
    (hasAny(q, ["hours", "timing", "timings"]) && hasAny(q, ["work", "working", "office", "day"]))
  ) {
    return {
      kind: "metrics",
      summary: `Your shift is ${ctx.shiftHours} (${ctx.timeZone}).`,
      metrics: [
        { label: "Shift", value: ctx.shiftHours },
        { label: "Time zone", value: ctx.timeZone },
      ],
      links: [
        { label: "Attendance", to: "/attendance" },
        { label: "Timesheet", to: "/timesheet" },
      ],
    };
  }

  if (
    hasAny(q, ["most holiday", "most leave", "most pto", "most vacation", "took most", "who took", "top leave", "highest leave"]) ||
    (hasAny(q, ["who", "which"]) && hasAny(q, ["holiday", "leave", "pto", "vacation", "absence"]) && hasAny(q, ["most", "highest", "top", "max"]))
  ) {
    if (!ctx.teamSize) {
      return { kind: "text", summary: "You can only see your own leave. Nobody reports to you.", links: [{ label: "Leave", to: "/leave" }] };
    }
    const rows = ctx.teamLeave.filter((r) => r.days > 0).slice(0, 5);
    return {
      kind: rows.length ? "table" : "text",
      summary: rows.length ? "Approved leave this year for people in your reporting line." : "No approved leave yet this year in your team.",
      table: rows.length ? { headers: ["Person", "Days"], rows: rows.map((r) => [r.name, String(r.days)]) } : undefined,
      links: [{ label: "Leave", to: "/leave" }],
    };
  }

  if (hasAny(q, ["org chart", "orgchart", "organisation chart", "organization chart", "reporting tree", "who is my manager", "my manager", "reports to"])) {
    return {
      kind: "text",
      summary: ctx.managerName
        ? `You report to ${ctx.managerName}. Your requests are decided by people above you in the line.`
        : "Nobody is above you in the reporting line, so your requests are approved automatically.",
      links: [
        { label: "Org chart", to: "/org-chart" },
        { label: "My profile", to: "/info" },
      ],
    };
  }

  if (hasAny(q, ["calendar", "schedule", "meeting", "meetings", "reminder", "reminders", "ip day", "ip days", "in-person"])) {
    return {
      kind: "text",
      summary: "My calendar shows in-person days, meetings, reminders, leave and holidays.",
      links: [
        { label: "My calendar", to: "/calendar" },
        { label: "Holidays", to: "/holidays" },
      ],
    };
  }

  if (hasAny(q, ["holiday", "holidays", "festival", "closure", "public holiday"])) {
    return {
      kind: ctx.holidays.length ? "table" : "text",
      summary: ctx.holidays.length ? `Upcoming holidays in ${ctx.countryName}.` : `No more holidays this year in ${ctx.countryName}.`,
      table: ctx.holidays.length
        ? { headers: ["Date", "Holiday"], rows: ctx.holidays.map((h) => [fmtDate(h.date), h.name]) }
        : undefined,
      links: [
        { label: "Holidays", to: "/holidays" },
        { label: "Leave", to: "/leave" },
      ],
    };
  }

  if (hasAny(q, ["payslip", "payslips", "salary slip", "pay stub", "paycheck", "net pay", "my pay"])) {
    return {
      kind: "text",
      summary: "Open My payslips to view and download your own slips. I don't read or share anyone's pay.",
      links: [{ label: "My payslips", to: "/payslips" }],
    };
  }

  if (hasAny(q, ["compensation", "salary band", "pay band", "ctc", "bonus cycle", "salary"])) {
    return {
      kind: "text",
      requires: "compensation",
      summary: "Pay details are in Compensation. I don't show other people's pay here.",
      links: [{ label: "Compensation", to: "/compensation" }],
    };
  }

  if (hasAny(q, ["benefit", "benefits", "medical", "insurance", "dependents", "pf", "provident"])) {
    return { kind: "text", summary: `Benefits shows the plans for ${ctx.countryName}, your enrolment and dependents.`, links: [{ label: "Benefits", to: "/benefits" }] };
  }

  if (hasAny(q, ["profile", "my info", "my details", "employee id", "who am i", "my email", "contact"])) {
    return { kind: "text", summary: "Open My profile to see and update your details.", links: [{ label: "My profile", to: "/info" }] };
  }

  if (
    hasAny(q, ["timesheet", "time sheet", "log hours", "fill hours", "submit timesheet", "project hours", "billable"]) &&
    !hasAny(q, ["approv", "waiting", "pending"])
  ) {
    return {
      kind: "text",
      summary: "Log project hours for the week in Timesheet, then submit. Your manager reviews it.",
      links: [
        { label: "Timesheet", to: "/timesheet" },
        { label: "Attendance", to: "/attendance" },
      ],
    };
  }

  if (hasAny(q, ["task", "tasks", "to-do", "todo", "my tasks"])) {
    return { kind: "text", summary: "Tasks lists your open, scheduled and closed work.", links: [{ label: "Tasks", to: "/tasks" }] };
  }

  if (hasAny(q, ["notification", "notifications", "alert", "alerts"])) {
    return { kind: "text", summary: "Notifications holds your payslip, policy and project alerts.", links: [{ label: "Notifications", to: "/notifications" }] };
  }

  if (hasAny(q, ["announcement", "announcements", "company news"])) {
    return { kind: "text", summary: "Company announcements are under Announcements.", links: [{ label: "Announcements", to: "/announcements" }] };
  }

  if (hasAny(q, ["message", "messages", "chat", "dm"])) {
    return { kind: "text", summary: "Use Messages to chat with colleagues.", links: [{ label: "Messages", to: "/chat" }] };
  }

  if (hasAny(q, ["document", "documents", "letter", "offer letter", "forms"])) {
    return { kind: "text", summary: "Documents holds your letters, forms and requests.", links: [{ label: "Documents", to: "/documents" }] };
  }

  if (hasAny(q, ["password", "change password", "reset password", "login"])) {
    return {
      kind: "text",
      summary: "Change your password from the profile menu, or use Forgot password on the sign-in page. I never see or share passwords.",
      links: [{ label: "Help", to: "/help" }],
    };
  }

  if (hasAny(q, ["onboarding", "new joiner", "day 0", "joining"])) {
    return { kind: "text", summary: "Onboarding tracks joiner checklists.", links: [{ label: "Onboarding", to: "/onboarding" }] };
  }

  if (hasAny(q, ["performance", "evaluation", "appraisal", "goals", "okr"])) {
    return {
      kind: "text",
      summary: "Your goals and reviews are in Performance.",
      links: [
        { label: "Performance", to: "/evaluations" },
        { label: "Skills", to: "/skills" },
      ],
    };
  }

  if (
    (hasAny(q, ["leave", "pto", "wfh", "absence", "timesheet", "expense"]) && hasAny(q, ["approv", "waiting", "pending", "queue"])) ||
    hasAll(q, ["waiting", "approval"]) ||
    hasAny(q, ["approvals", "approve", "inbox"])
  ) {
    if (!ctx.approvalsCount) {
      return { kind: "text", summary: `Nothing is waiting on you. ${NO_DECISIONS}`, links: [{ label: "Approvals", to: "/approvals" }] };
    }
    return {
      kind: "table",
      summary: `${ctx.approvalsCount} item${ctx.approvalsCount === 1 ? " is" : "s are"} waiting on you. ${NO_DECISIONS}`,
      table: {
        headers: ["Person", "Type", "Detail", "Date"],
        rows: ctx.approvals.slice(0, 8).map((a) => [a.who, a.kind, a.detail, a.date ? fmtDate(a.date) : "—"]),
      },
      links: [{ label: "Open Approvals", to: "/approvals" }],
    };
  }

  if (
    hasAny(q, ["apply for leave", "request leave", "how do i apply", "take leave", "book leave"]) ||
    (hasAny(q, ["leave"]) && hasAny(q, ["apply", "request", "how", "submit"]))
  ) {
    return {
      kind: "text",
      summary: ctx.managerName
        ? `Open Leave, pick the type and dates, and submit. ${ctx.managerName} or someone above them decides it.`
        : "Open Leave, pick the type and dates, and submit. Your leave is approved automatically.",
      links: [
        { label: "Leave", to: "/leave" },
        { label: "Holidays", to: "/holidays" },
      ],
    };
  }

  if (hasAny(q, ["leave", "pto", "wfh", "absence", "comp off", "casual", "balance"]) && !hasAny(q, ["policy"])) {
    return {
      kind: "metrics",
      summary: balances.length
        ? `Your leave this year: ${balances.map((r) => `${r.name} ${r.available}`).join(" · ")} days available.`
        : "No leave balances found.",
      metrics: balances.slice(0, 6).map((r) => ({
        label: r.name,
        value: `${r.available} day${r.available === 1 ? "" : "s"}${r.pending ? ` (${r.pending} pending)` : ""}`,
      })),
      links: [{ label: "Leave", to: "/leave" }],
    };
  }

  if (hasAny(q, ["policy", "policies", "acknowledg", "handbook"])) {
    return { kind: "text", summary: "Company policies and your acknowledgements are under Policies.", links: [{ label: "Policies", to: "/policies" }] };
  }

  if (hasAny(q, ["team", "direct report", "my reports", "who reports", "my team"])) {
    return {
      kind: "text",
      summary: ctx.teamSize
        ? `${ctx.teamSize} ${ctx.teamSize === 1 ? "person is" : "people are"} below you in the reporting line.`
        : "Nobody reports to you.",
      links: [
        { label: "Team", to: "/team" },
        { label: "Org chart", to: "/org-chart" },
      ],
    };
  }

  if (hasAny(q, ["attrition", "workforce", "headcount", "hiring", "exit", "exits", "turnover", "analytics", "skill", "skills", "capacity", "gap"])) {
    if (!ctx.orgWide || !ctx.workforce) {
      return {
        kind: "text",
        summary: ctx.teamSize
          ? `You can see your own team only: ${ctx.teamSize} ${ctx.teamSize === 1 ? "person" : "people"}. Company-wide numbers need HR or executive access.`
          : "Company-wide numbers need HR or executive access.",
        links: [{ label: "Team", to: "/team" }],
      };
    }
    return {
      kind: "metrics",
      requires: "analytics",
      summary: "Workforce snapshot from the people directory (year to date).",
      metrics: [
        { label: "Headcount", value: String(ctx.workforce.headcount) },
        { label: "Joiners", value: String(ctx.workforce.joiners) },
        { label: "Exits", value: String(ctx.workforce.exits) },
        { label: "Attrition", value: `${ctx.workforce.attritionPct}%` },
      ],
      links: [{ label: "Analytics", to: "/analytics" }],
    };
  }

  if (hasAny(q, ["pipeline", "time-to-hire", "time to hire", "recruit", "requisition", "interview", "candidate", "offer", "ats"])) {
    return { kind: "text", requires: "recruiting", summary: "Requisitions, candidates and interviews are in Recruiting.", links: [{ label: "Recruiting", to: "/recruiting" }] };
  }

  if (hasAny(q, ["attendance", "overtime", "check in", "check-in", "check out", "check-out", "present", "punch", "clock in"])) {
    return { kind: "text", summary: "Check in and out from Home or Attendance. Corrections go to your manager.", links: [{ label: "Attendance", to: "/attendance" }] };
  }

  if (hasAny(q, ["integration", "sso", "audit", "connector", "admin", "administration"])) {
    return {
      kind: "text",
      requires: "integrations",
      summary: "Connector status and retries are in Integration Center; the audit log is in Administration.",
      links: [
        { label: "Integration Center", to: "/integrations" },
        { label: "Administration", to: "/admin" },
      ],
    };
  }

  if (hasAny(q, ["learning", "certif", "training", "course", "lms", "program"])) {
    return { kind: "text", summary: "Your courses and certifications are in Learning.", links: [{ label: "Learning", to: "/programs" }] };
  }

  if (hasAny(q, ["expense", "expenses", "reimbursement", "claim"])) {
    return {
      kind: "text",
      summary: "Submit claims in Expenses. They go to someone above you in the reporting line.",
      links: [
        { label: "Expenses", to: "/expenses" },
        { label: "Reimbursement", to: "/reimbursement" },
      ],
    };
  }

  if (hasAny(q, ["help", "hr request", "support", "ticket", "faq"])) {
    return { kind: "text", summary: "Raise a ticket or browse FAQs in Help.", links: [{ label: "Help", to: "/help" }] };
  }

  return {
    kind: "text",
    summary: "Try asking about your leave balance, holidays, approvals, timesheet, payslips or working hours.",
    links: [
      { label: "Leave", to: "/leave" },
      { label: "Timesheet", to: "/timesheet" },
      { label: "Help", to: "/help" },
    ],
  };
}

/* —— AI Agents —— */

export type AgentDemoStatus = "Demo ready" | "Demo beta" | "Planned demo";

export interface AiAgentCard {
  id: string;
  name: string;
  audience: string;
  purpose: string;
  availability: string;
  demoStatus: AgentDemoStatus;
}

export const AI_AGENTS: AiAgentCard[] = [
  {
    id: "employee",
    name: "Employee agent",
    audience: "Employees",
    purpose: "Answers leave, policy, payslip and self-service questions.",
    availability: "Copilot",
    demoStatus: "Demo ready",
  },
  {
    id: "manager",
    name: "Manager agent",
    audience: "Managers",
    purpose: "Pending approvals, team attendance and skill coverage.",
    availability: "Managers · Approvals",
    demoStatus: "Demo ready",
  },
  {
    id: "hr",
    name: "HR agent",
    audience: "HR / HRBP",
    purpose: "HR cases, policy acknowledgements and workforce movements.",
    availability: "HR",
    demoStatus: "Demo beta",
  },
  {
    id: "recruiter",
    name: "Recruiter agent",
    audience: "Recruiters",
    purpose: "Pipeline stages, interview kits and offer deadlines.",
    availability: "Recruiting module · Copilot prompts",
    demoStatus: "Demo beta",
  },
  {
    id: "knowledge",
    name: "Knowledge agent",
    audience: "All staff",
    purpose: "Retrieves answers from the policy knowledge base.",
    availability: "Copilot · Policies screens",
    demoStatus: "Planned demo",
  },
  {
    id: "analytics",
    name: "Analytics agent",
    audience: "Leaders & HR",
    purpose: "Headcount, attrition and capacity from Analytics.",
    availability: "Analytics page · Copilot",
    demoStatus: "Demo ready",
  },
  {
    id: "document",
    name: "Document agent",
    audience: "HR & employees",
    purpose: "Finds letters and document checklists.",
    availability: "Documents & Letters",
    demoStatus: "Demo beta",
  },
];

/* —— Integrations —— */

export type IntegrationStatus = "Connected" | "Degraded" | "Disconnected" | "Not configured";

export interface IntegrationCard {
  id: string;
  name: string;
  category: string;
  description: string;
  status: IntegrationStatus;
  lastSync: string;
  recordsProcessed: number;
  errorCount: number;
  logs: { at: string; level: "info" | "warn" | "error"; message: string }[];
}

export const INTEGRATION_SEED: IntegrationCard[] = [
  {
    id: "sso",
    name: "SSO / Identity",
    category: "Identity",
    description: "SAML / OIDC for corporate identity providers.",
    status: "Degraded",
    lastSync: "2026-10-14 08:40 IST",
    recordsProcessed: 512,
    errorCount: 3,
    logs: [
      { at: "14 Oct 08:40", level: "warn", message: "Token refresh latency above threshold" },
      { at: "14 Oct 07:12", level: "info", message: "Directory sync batch completed" },
      { at: "13 Oct 22:01", level: "error", message: "IdP metadata fetch timeout" },
    ],
  },
  {
    id: "email",
    name: "Email",
    category: "Communications",
    description: "Transactional email for notifications and digests.",
    status: "Connected",
    lastSync: "2026-10-14 09:05 IST",
    recordsProcessed: 4280,
    errorCount: 0,
    logs: [
      { at: "14 Oct 09:05", level: "info", message: "Digest batch sent" },
      { at: "14 Oct 06:00", level: "info", message: "Provider health check OK" },
    ],
  },
  {
    id: "teams",
    name: "Microsoft Teams",
    category: "Collaboration",
    description: "Presence and notification channels.",
    status: "Connected",
    lastSync: "2026-10-14 09:00 IST",
    recordsProcessed: 910,
    errorCount: 1,
    logs: [
      { at: "14 Oct 09:00", level: "info", message: "Channel notify push" },
      { at: "13 Oct 16:22", level: "warn", message: "Webhook 429 soft throttle" },
    ],
  },
  {
    id: "slack",
    name: "Slack",
    category: "Collaboration",
    description: "Workspace notifications and approval shortcuts.",
    status: "Not configured",
    lastSync: "—",
    recordsProcessed: 0,
    errorCount: 0,
    logs: [{ at: "—", level: "info", message: "Connector not configured" }],
  },
  {
    id: "attendance",
    name: "Attendance devices",
    category: "Workforce",
    description: "Badge / biometric punch feed.",
    status: "Connected",
    lastSync: "2026-10-14 09:15 IST",
    recordsProcessed: 18420,
    errorCount: 12,
    logs: [
      { at: "14 Oct 09:15", level: "info", message: "Punch import cycle" },
      { at: "14 Oct 08:02", level: "error", message: "Device TZ-BLR-04 offline" },
    ],
  },
  {
    id: "learning",
    name: "Learning LMS",
    category: "Talent",
    description: "Course completion and certification sync.",
    status: "Connected",
    lastSync: "2026-10-13 23:40 IST",
    recordsProcessed: 640,
    errorCount: 0,
    logs: [{ at: "13 Oct 23:40", level: "info", message: "Completion delta sync" }],
  },
  {
    id: "benefits",
    name: "Benefits carrier",
    category: "Rewards",
    description: "Eligibility and enrollment file exchange.",
    status: "Degraded",
    lastSync: "2026-10-12 18:20 IST",
    recordsProcessed: 210,
    errorCount: 4,
    logs: [
      { at: "12 Oct 18:20", level: "warn", message: "Enrollment file validation warnings" },
      { at: "11 Oct 18:20", level: "error", message: "SFTP handshake failed once" },
    ],
  },
  {
    id: "payroll",
    name: "External payroll provider",
    category: "Payroll",
    description: "Outbound employee master & attendance summary for third-party payroll.",
    status: "Connected",
    lastSync: "2026-10-10 21:00 IST",
    recordsProcessed: 500,
    errorCount: 0,
    logs: [
      { at: "10 Oct 21:00", level: "info", message: "Period file handoff" },
      { at: "01 Oct 21:00", level: "info", message: "Prior period acknowledged" },
    ],
  },
];

/* —— Payroll —— */

export const PAYROLL_STATUS = {
  notImplemented: [
    "Payroll runs and calculation",
    "Tax calculation and filing",
    "Bank payments",
  ],
};

/** Outbound payroll file handoff, one provider per country / legal entity. */
export interface PayrollProviderRow {
  country: CountryCode;
  provider: string;
  status: IntegrationStatus;
  lastHandoff: string;
  note: string;
}

export const PAYROLL_PROVIDERS: PayrollProviderRow[] = [
  { country: "IN", provider: "Local payroll bureau (IN)", status: "Connected", lastHandoff: "2026-10-10", note: "October file accepted" },
  { country: "US", provider: "US payroll provider", status: "Connected", lastHandoff: "2026-10-09", note: "Bi-weekly file accepted" },
  { country: "GB", provider: "UK payroll bureau", status: "Degraded", lastHandoff: "2026-10-08", note: "2 records rejected — missing NI number" },
  { country: "AU", provider: "AU payroll provider", status: "Connected", lastHandoff: "2026-10-07", note: "Fortnightly file accepted" },
  { country: "CA", provider: "CA payroll provider", status: "Disconnected", lastHandoff: "2026-09-25", note: "Credentials expired — renew with provider" },
  { country: "AE", provider: "GCC payroll partner", status: "Connected", lastHandoff: "2026-10-05", note: "WPS file accepted" },
  { country: "SA", provider: "GCC payroll partner", status: "Degraded", lastHandoff: "2026-10-05", note: "GOSI field mapping warning" },
  { country: "DE", provider: "DE payroll bureau", status: "Not configured", lastHandoff: "—", note: "Handoff not set up yet" },
];

/* —— Administration —— */

export const ADMIN_LOCATIONS = [
  { id: "loc-blr", name: "Bengaluru", country: "India", type: "HQ / Delivery" },
  { id: "loc-hyd", name: "Hyderabad", country: "India", type: "Delivery" },
  { id: "loc-nyc", name: "New York", country: "United States", type: "Regional" },
  { id: "loc-ldn", name: "London", country: "United Kingdom", type: "Regional" },
  { id: "loc-syd", name: "Sydney", country: "Australia", type: "Regional" },
  { id: "loc-tor", name: "Toronto", country: "Canada", type: "Regional" },
  { id: "loc-dxb", name: "Dubai", country: "United Arab Emirates", type: "Regional" },
  { id: "loc-ruh", name: "Riyadh", country: "Saudi Arabia", type: "Regional" },
  { id: "loc-ber", name: "Berlin", country: "Germany", type: "Regional" },
];

export const ADMIN_ORG_SETTINGS = {
  company: "Infotech",
  fiscalYearStart: "April",
  weekStartDefault: "Monday",
  legalEntities: TIMEZ_COUNTRIES.length,
};

export const ROLE_PERMISSION_CATALOG: { id: string; label: string; description: string }[] = [
  { id: "people", label: "People directory", description: "View workforce directory" },
  { id: "organization", label: "Organization", description: "Org chart & entities" },
  { id: "recruiting", label: "Recruiting", description: "Requisitions & candidates" },
  { id: "compensation", label: "Compensation", description: "Pay structures & reviews" },
  { id: "analytics", label: "Analytics", description: "Workforce intelligence" },
  { id: "integrations", label: "Integrations", description: "Connector administration" },
  { id: "administration", label: "Administration", description: "Platform settings" },
  { id: "payroll", label: "Payroll", description: "External payroll status" },
];

export interface AuditLogRow {
  id: string;
  at: string;
  actor: string;
  action: string;
  target: string;
  outcome: "Recorded" | "Success" | "Failed";
}

export const AUDIT_LOG_SEED: AuditLogRow[] = [
  { id: "aud-1", at: "2026-10-14 09:12", actor: "Alex Morgan", action: "Updated notification preference", target: "integrations", outcome: "Success" },
  { id: "aud-2", at: "2026-10-13 18:40", actor: "Alex Morgan", action: "Retry integration sync", target: "Benefits carrier", outcome: "Failed" },
  { id: "aud-3", at: "2026-10-13 11:05", actor: "Farhan Ali", action: "Published policy", target: "Leave Policy", outcome: "Recorded" },
  { id: "aud-4", at: "2026-10-12 16:30", actor: "Alex Morgan", action: "Retry integration sync", target: "SSO / Identity", outcome: "Success" },
];

export interface NotificationPref {
  id: string;
  channel: string;
  description: string;
  email: boolean;
  inApp: boolean;
  digests: boolean;
}

export const NOTIFICATION_PREF_SEED: NotificationPref[] = [
  {
    id: "approvals",
    channel: "Approvals",
    description: "Leave, expense, and workflow decisions",
    email: true,
    inApp: true,
    digests: false,
  },
  {
    id: "announcements",
    channel: "Announcements",
    description: "Company and regional broadcasts",
    email: true,
    inApp: true,
    digests: true,
  },
  {
    id: "learning",
    channel: "Learning",
    description: "Course assignments and due reminders",
    email: false,
    inApp: true,
    digests: true,
  },
  {
    id: "integrations",
    channel: "Integration alerts",
    description: "Connector failures and sync warnings (admins)",
    email: true,
    inApp: true,
    digests: false,
  },
];
