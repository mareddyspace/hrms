import { COMPANY_NAME, PRODUCT_NAME, PRODUCT_TAGLINE } from "../brand.ts";
import type { DemoAccount, NavAccessId } from "../demoAccounts.ts";
import type { CountryCode, UserRole } from "../model.ts";
import { TIMEZ_COUNTRIES } from "../model.ts";
import { TZ_HEADCOUNT, TZ_HR, TZ_MOVEMENT, TZ_RECRUITING, TZ_EXEC } from "./dashboardMock.ts";

/** Demo-only banner copy shared across AI / integrations / payroll. */
export const DEMO_ONLY =
  "Demo-only frontend simulation — not connected to live AI, payroll, or third-party services.";

export type AnalyticsRange = "7d" | "30d" | "90d" | "ytd";

export const ANALYTICS_RANGES: { id: AnalyticsRange; label: string }[] = [
  { id: "7d", label: "Last 7 days" },
  { id: "30d", label: "Last 30 days" },
  { id: "90d", label: "Last 90 days" },
  { id: "ytd", label: "Year to date" },
];

export const ANALYTICS_DEPARTMENTS = [
  "All departments",
  ...TZ_HEADCOUNT.byDepartment.map((d) => d.name),
] as const;

/** Scale factors by date range for responsive mock charts. */
const RANGE_FACTOR: Record<AnalyticsRange, number> = {
  "7d": 0.22,
  "30d": 1,
  "90d": 2.6,
  ytd: 5.2,
};

export function scaleCount(base: number, range: AnalyticsRange): number {
  return Math.max(0, Math.round(base * RANGE_FACTOR[range]));
}

export function filterHeadcountByCountry(code: CountryCode | "ALL") {
  if (code === "ALL") return [...TZ_HEADCOUNT.byCountry];
  return TZ_HEADCOUNT.byCountry.filter((c) => c.code === code);
}

export function filterHeadcountByDept(dept: string) {
  if (dept === "All departments") return [...TZ_HEADCOUNT.byDepartment];
  return TZ_HEADCOUNT.byDepartment.filter((d) => d.name === dept);
}

export function workforceMetrics(range: AnalyticsRange, country: CountryCode | "ALL", dept: string) {
  const countries = filterHeadcountByCountry(country);
  const rawDepts = filterHeadcountByDept(dept);
  const countryShare =
    country === "ALL" ? 1 : (countries[0]?.headcount ?? 0) / TZ_HEADCOUNT.global;
  const deptShare =
    dept === "All departments"
      ? 1
      : (rawDepts[0]?.headcount ?? 0) / TZ_HEADCOUNT.global;
  const share = countryShare * (dept === "All departments" ? 1 : Math.max(0.15, deptShare / countryShare || deptShare));

  const headcount = Math.round(
    (country === "ALL" ? TZ_HEADCOUNT.global : countries[0]?.headcount ?? 0) *
      (dept === "All departments" ? 1 : Math.max(0.08, (rawDepts[0]?.headcount ?? 0) / TZ_HEADCOUNT.global / countryShare || 0.2)),
  );

  // Scale department bars to the filtered country headcount so totals stay coherent.
  const depts =
    country === "ALL"
      ? rawDepts
      : rawDepts.map((d) => ({
          ...d,
          headcount: Math.max(1, Math.round(d.headcount * countryShare)),
        }));

  return {
    headcount: Math.max(1, headcount),
    hiring: scaleCount(Math.round(TZ_MOVEMENT.hiringYtd * share), range),
    exits: scaleCount(Math.round(TZ_MOVEMENT.exitsYtd * share), range),
    attritionPct: Number((TZ_MOVEMENT.attritionYtdPct * (country === "ALL" ? 1 : 0.95 + share * 0.1)).toFixed(1)),
    joiners: scaleCount(Math.round(TZ_MOVEMENT.joinersYtd * share), range),
    countries,
    departments: depts,
  };
}

export const PIPELINE_BY_COUNTRY: Record<string, { stage: string; count: number }[]> = {
  ALL: TZ_RECRUITING.byStage.map((s) => ({ ...s })),
  IN: [
    { stage: "Screen", count: 22 },
    { stage: "HM interview", count: 16 },
    { stage: "Technical", count: 14 },
    { stage: "Offer", count: 8 },
    { stage: "Hired", count: 6 },
  ],
  US: [
    { stage: "Screen", count: 12 },
    { stage: "HM interview", count: 9 },
    { stage: "Technical", count: 7 },
    { stage: "Offer", count: 5 },
    { stage: "Hired", count: 3 },
  ],
  GB: [
    { stage: "Screen", count: 6 },
    { stage: "HM interview", count: 4 },
    { stage: "Technical", count: 3 },
    { stage: "Offer", count: 2 },
    { stage: "Hired", count: 1 },
  ],
  AU: [
    { stage: "Screen", count: 3 },
    { stage: "HM interview", count: 2 },
    { stage: "Technical", count: 2 },
    { stage: "Offer", count: 1 },
    { stage: "Hired", count: 1 },
  ],
  CA: [
    { stage: "Screen", count: 2 },
    { stage: "HM interview", count: 2 },
    { stage: "Technical", count: 1 },
    { stage: "Offer", count: 1 },
    { stage: "Hired", count: 0 },
  ],
  AE: [
    { stage: "Screen", count: 1 },
    { stage: "HM interview", count: 1 },
    { stage: "Technical", count: 1 },
    { stage: "Offer", count: 0 },
    { stage: "Hired", count: 0 },
  ],
  SA: [
    { stage: "Screen", count: 1 },
    { stage: "HM interview", count: 1 },
    { stage: "Technical", count: 0 },
    { stage: "Offer", count: 0 },
    { stage: "Hired", count: 0 },
  ],
  DE: [
    { stage: "Screen", count: 1 },
    { stage: "HM interview", count: 1 },
    { stage: "Technical", count: 0 },
    { stage: "Offer", count: 1 },
    { stage: "Hired", count: 1 },
  ],
};

export function attendanceSeries(range: AnalyticsRange) {
  const base = TZ_HR.attendanceTrend;
  if (range === "7d") {
    return [
      { label: "Mon", pct: 95 },
      { label: "Tue", pct: 94 },
      { label: "Wed", pct: 96 },
      { label: "Thu", pct: 93 },
      { label: "Fri", pct: 92 },
    ];
  }
  if (range === "90d" || range === "ytd") {
    return [
      { label: "Q1", pct: 93 },
      { label: "Q2", pct: 94 },
      { label: "Q3", pct: 95 },
      { label: "Q4*", pct: 94 },
    ];
  }
  return [...base];
}

export function leaveSeries(range: AnalyticsRange) {
  const base = TZ_HR.leaveTrend;
  if (range === "7d") {
    return [
      { label: "Mon", days: 18 },
      { label: "Tue", days: 22 },
      { label: "Wed", days: 15 },
      { label: "Thu", days: 20 },
      { label: "Fri", days: 28 },
    ];
  }
  if (range === "ytd") {
    return [
      { label: "Q1", days: 1280 },
      { label: "Q2", days: 1410 },
      { label: "Q3", days: 1520 },
      { label: "Q4*", days: 390 },
    ];
  }
  return [...base];
}

export function overtimeSeries(range: AnalyticsRange) {
  const factor = RANGE_FACTOR[range];
  return [
    { label: "Engineering", hours: Math.round(420 * factor) },
    { label: "Operations", hours: Math.round(180 * factor) },
    { label: "Sales", hours: Math.round(95 * factor) },
    { label: "Customer Success", hours: Math.round(70 * factor) },
  ];
}

export const PERFORMANCE_CYCLE = {
  name: TZ_HR.performanceCycle.name,
  due: TZ_HR.performanceCycle.due,
  completionPct: TZ_HR.performanceCycle.completionPct,
  byStage: [
    { stage: "Self review", pct: 88 },
    { stage: "Manager review", pct: 71 },
    { stage: "Calibration", pct: 42 },
    { stage: "Closed", pct: 18 },
  ],
};

export const LEARNING_METRICS = {
  completionPct: TZ_HR.learningCompletionPct,
  certificationsYtd: 186,
  mandatoryPending: 63,
  topCourses: [
    { name: "Workplace safety", completionPct: 96 },
    { name: "Secure coding", completionPct: 71 },
    { name: "Manager essentials", completionPct: 64 },
    { name: "Data privacy (sample)", completionPct: 58 },
  ],
};

export const SKILLS_CAPACITY = {
  ...TZ_EXEC.capacity,
  skills: TZ_EXEC.criticalSkillGaps,
  benchByCountry: [
    { country: "India", bench: 14 },
    { country: "United States", bench: 6 },
    { country: "United Kingdom", bench: 4 },
    { country: "Germany", bench: 2 },
  ],
};

export const COMP_REVIEW_STATUS = {
  cycle: "FY26 Mid-year compensation review (sample)",
  submittedPct: 54,
  pendingManagers: 18,
  budgetUsedPct: 41,
  note: "Visible only to personas with Compensation nav access. Figures are fictional demo data.",
};

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
    "What is my leave balance this year?",
    "Where can I find the attendance policy?",
    "Summarize workforce holidays for my country",
  ],
  manager: [
    "Which leave requests are waiting for my approval?",
    "Show my team's skills coverage gaps",
    "What are attendance trends for my team?",
    "Draft a note about overtime policy for my team",
  ],
  hr: [
    "Summarize attrition for the last 90 days",
    "Which policies have pending acknowledgements?",
    "Show leave trends by department",
    "List open HR cases needing review",
  ],
  recruiter: [
    "What is average time-to-hire this quarter?",
    "Summarize the recruiting pipeline by stage",
    "Which requisitions are in Offer stage?",
    "Draft interview kit outline for Senior React Engineer",
  ],
  executive: [
    "Give me a workforce headcount and attrition snapshot",
    "Where are the critical skill gaps?",
    "Summarize hiring vs exits year to date",
    "What is capacity utilization across regions?",
  ],
  admin: [
    "Which integrations are degraded?",
    "Show recent audit-log events",
    "What is SSO connection status?",
    "List demo personas with Administration access",
  ],
  other: [
    "How do I apply for leave?",
    "Where are company policies?",
    "Show learning completion trends",
    "Explain Info Tech AI Copilot demo limits",
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

/** Rule-based demo Copilot, filtered to what the viewer is allowed to see. */
export function answerCopilot(question: string, viewer: CopilotViewer): CopilotAnswer {
  const { requires, ...raw } = rawCopilotAnswer(question);
  const allowedLink = (l: { to: string }) => {
    const id = COPILOT_LINK_ACCESS[l.to];
    return !id || viewerHas(viewer, id);
  };
  if (requires && !viewerHas(viewer, requires)) {
    return {
      kind: "text",
      summary:
        "You don't have access to that information with your current role. Ask your manager or HR if you need it.",
      links: [{ label: "Help", to: "/help" }].filter(allowedLink),
    };
  }
  const links = raw.links?.filter(allowedLink);
  return { ...raw, links: links?.length ? links : undefined };
}

/** Broad keyword matchers so short natural questions still get answers. */
function rawCopilotAnswer(question: string): RawCopilotAnswer {
  const q = question.toLowerCase().replace(/[?!.,'"]/g, " ").replace(/\s+/g, " ").trim();

  if (hasAny(q, ["company name", "organisation name", "organization name", "who are we", "brand name"]) ||
      (hasAny(q, ["company", "organisation", "organization", "employer"]) && hasAny(q, ["name", "called", "brand"]))) {
    return {
      kind: "text",
      summary: `This demo portal is for ${COMPANY_NAME} (${PRODUCT_TAGLINE}). Legal entities include Infotech India Pvt Ltd, Infotech Inc, and regional affiliates in the sample directory.`,
      links: [
        { label: "My profile", to: "/info" },
        { label: "Organization", to: "/organization" },
      ],
    };
  }

  if (hasAny(q, ["product name", "app name", "portal name", "what is this app", "what is this portal"])) {
    return {
      kind: "text",
      summary: `${PRODUCT_NAME} is the ${PRODUCT_TAGLINE} employee portal demo. Screens use mock data only — not a live HRIS.`,
      links: [{ label: "Home", to: "/" }],
    };
  }

  // Working hours / shift / office hours (covers "working hours", "shift", "when do I start")
  if (
    hasAny(q, [
      "working hours",
      "work hours",
      "office hours",
      "shift hours",
      "shift timing",
      "shift time",
      "my shift",
      "shift",
      "business hours",
      "start time",
      "end time",
      "what time do i",
      "when do i work",
      "working time",
      "duty hours",
    ]) ||
    (hasAny(q, ["hours", "timing", "timings"]) && hasAny(q, ["work", "working", "office", "shift", "day"]))
  ) {
    return {
      kind: "metrics",
      summary:
        "In this demo, most India Engineering personas use the General Shift 09:30 AM to 06:30 PM (Asia/Kolkata). US/UK personas use regional day shifts. Open Timesheet to log hours against projects for the current week.",
      metrics: [
        { label: "Typical shift (IN)", value: "09:30 AM – 06:30 PM" },
        { label: "Work week", value: "Mon–Fri" },
        { label: "Break", value: "Not tracked in prototype" },
      ],
      links: [
        { label: "Timesheet", to: "/timesheet" },
        { label: "Attendance", to: "/attendance" },
        { label: "My profile", to: "/info" },
      ],
    };
  }

  if (
    hasAny(q, ["most holiday", "most leave", "most pto", "most vacation", "took most", "who took", "top leave", "highest leave"]) ||
    (hasAny(q, ["who", "which"]) && hasAny(q, ["holiday", "leave", "pto", "vacation", "absence"]) && hasAny(q, ["most", "highest", "top", "max"]))
  ) {
    return {
      kind: "table",
      summary:
        "From the demo leave ledger (mock YTD days taken), Kabir Sharma used the most holiday/PTO. Figures are fictional sample data for manager review demos.",
      requires: "team",
      table: {
        headers: ["Employee", "Type", "Days taken YTD", "Department"],
        rows: [
          ["Kabir Sharma", "PTO / Holiday", "18", "Engineering"],
          ["Diya Patel", "PTO / Holiday", "14", "Engineering"],
          ["Noah Garcia", "PTO / Holiday", "11", "Product"],
          ["Isha Reddy", "PTO / Holiday", "9", "Engineering"],
          ["Anita Joseph", "PTO / Holiday", "8", "Quality"],
        ],
      },
      metrics: [
        { label: "Team leave days (Oct)", value: String(TZ_HR.leaveTrend.find((r) => r.label === "Oct")?.days ?? 390) },
        { label: "Pending leave approvals", value: "3" },
      ],
      links: [
        { label: "Leave & Absence", to: "/leave" },
        { label: "Approvals", to: "/approvals" },
        { label: "Holidays", to: "/holidays" },
      ],
    };
  }

  if (hasAny(q, ["org chart", "orgchart", "organisation chart", "organization chart", "reporting tree", "who is my manager", "my manager", "reports to"])) {
    return {
      kind: "text",
      summary:
        "Open Org chart under Me to see the demo reporting tree (Jordan → Ram → Babu, etc.). Reporting drives leave approvals; recruiting/compensation/admin access still comes from role.",
      links: [
        { label: "Org chart", to: "/org-chart" },
        { label: "My profile", to: "/info" },
      ],
    };
  }

  if (hasAny(q, ["calendar", "schedule", "meeting", "meetings", "reminder", "reminders", "ip day", "ip days", "in-person"])) {
    return {
      kind: "text",
      summary: `Open My calendar to see ${COMPANY_NAME} IP (in-person) days, meetings, reminders, leave, and holidays. Every role has access. You can also add personal reminders stored in this browser.`,
      links: [
        { label: "My calendar", to: "/calendar" },
        { label: "Holiday calendar", to: "/holidays" },
      ],
    };
  }

  if (hasAny(q, ["holiday", "holidays", "festival", "closure", "public holiday"])) {
    return {
      kind: "table",
      summary: `Upcoming company holidays in the active demo region for ${COMPANY_NAME}. Use the holiday calendar to plan leave around office closures.`,
      table: {
        headers: ["Date", "Holiday", "Region"],
        rows: [
          ["20 Oct 2026", "Dussehra (Vijayadashami)", "India"],
          ["24 Oct 2026", "Diwali (sample)", "India"],
          ["26 Nov 2026", "Thanksgiving (sample)", "United States"],
          ["25 Dec 2026", "Christmas Day", "Global sample"],
        ],
      },
      links: [
        { label: "Holiday calendar", to: "/holidays" },
        { label: "Leave & Absence", to: "/leave" },
      ],
    };
  }

  if (hasAny(q, ["payslip", "payslips", "salary slip", "pay stub", "paycheck", "net pay", "my pay", "salary slip"])) {
    return {
      kind: "text",
      summary: `Open My payslips to view your own ${COMPANY_NAME} demo slips (Jul–Sep 2026). Managers can see their own slips; colleagues' pay stays RBAC-restricted. Admin does not auto-get payslips.`,
      links: [{ label: "My payslips", to: "/payslips" }],
    };
  }

  if (hasAny(q, ["compensation", "salary band", "pay band", "ctc", "bonus cycle"])) {
    return {
      kind: "text",
      requires: "compensation",
      summary:
        "Compensation is role-gated. Helen (Compensation) and authorized HR can open Compensation; Jordan needs salaryAuthorized; Alex (Admin) does not get pay access from the Admin role alone.",
      links: [
        { label: "Compensation", to: "/compensation" },
        { label: "Payslips", to: "/payslips" },
      ],
    };
  }

  if (hasAny(q, ["benefit", "benefits", "medical", "insurance", "dependents", "pf", "provident"])) {
    return {
      kind: "text",
      summary: "Benefits shows country plans, eligibility, enrollment, and dependents for the active demo region. Plan documents are sample PDFs only.",
      links: [{ label: "Benefits", to: "/benefits" }],
    };
  }

  if (hasAny(q, ["profile", "my info", "my details", "employee id", "who am i", "my email", "contact"])) {
    return {
      kind: "text",
      summary: "Open My profile for your Employee 360 card — personal, employment, organization, skills, and (by permission) compensation tabs.",
      links: [{ label: "My profile", to: "/info" }],
    };
  }

  if (
    hasAny(q, ["timesheet", "time sheet", "log hours", "fill hours", "submit timesheet", "project hours", "billable"]) ||
    (hasAny(q, ["hours"]) && hasAny(q, ["log", "enter", "fill", "submit", "project", "timesheet"]))
  ) {
    return {
      kind: "text",
      summary:
        "Open Timesheet to log project hours for Mon–Fri of the current week, then submit for manager approval. Weekend and holiday cells stay locked. Your demo shift is shown on Attendance and Home check-in.",
      links: [
        { label: "Timesheet", to: "/timesheet" },
        { label: "Attendance", to: "/attendance" },
      ],
    };
  }

  if (hasAny(q, ["task", "tasks", "to-do", "todo", "my tasks"])) {
    return {
      kind: "text",
      summary: "Tasks lists your open, scheduled, and closed work items. Managers also see team assignment views.",
      links: [{ label: "Tasks", to: "/tasks" }],
    };
  }

  if (hasAny(q, ["notification", "notifications", "alert", "alerts"])) {
    return {
      kind: "text",
      summary: "Notification Center holds payslip, policy, and project alerts for your persona. Unread counts appear on the sidebar badge.",
      links: [{ label: "Notifications", to: "/notifications" }],
    };
  }

  if (hasAny(q, ["announcement", "announcements", "company news"])) {
    return {
      kind: "text",
      summary: "Announcements shows company-wide demo posts. Everyone can read them from Me → Announcements.",
      links: [{ label: "Announcements", to: "/announcements" }],
    };
  }

  if (hasAny(q, ["message", "messages", "chat", "inbox message", "dm"])) {
    return {
      kind: "text",
      summary: "Messages is an internal chat demo stored in browser localStorage — not real-time and not emailed.",
      links: [{ label: "Messages", to: "/chat" }],
    };
  }

  if (hasAny(q, ["document", "documents", "letter", "offer letter", "forms"])) {
    return {
      kind: "text",
      summary: "Documents & Letters holds your ESS library, letter templates, and request history. Previews are metadata-only in this prototype.",
      links: [{ label: "Documents", to: "/documents" }],
    };
  }

  if (hasAny(q, ["password", "change password", "reset password", "login"])) {
    return {
      kind: "text",
      summary:
        "Use the profile menu → Change password when prompted, or Forgot password on the login page (OTP demo). Demo passwords are listed on the login cards.",
      links: [
        { label: "Login", to: "/login" },
        { label: "Help", to: "/help" },
      ],
    };
  }

  if (hasAny(q, ["onboarding", "new joiner", "day 0", "joining"])) {
    return {
      kind: "text",
      summary: "Onboarding shows Day-0 to Day-30 checklist cases for recruiters, hiring managers, and HR. Tasks are demo-only.",
      links: [{ label: "Onboarding", to: "/onboarding" }],
    };
  }

  if (hasAny(q, ["performance", "evaluation", "appraisal", "goals", "okr"])) {
    return {
      kind: "text",
      summary: "Performance / Evaluations holds cycle status and goal samples. Completion % on dashboards is mock workforce data.",
      links: [
        { label: "Evaluations", to: "/evaluations" },
        { label: "Skills & Career", to: "/skills" },
      ],
    };
  }

  if (
    (hasAny(q, ["leave", "pto", "wfh", "absence"]) && hasAny(q, ["approv", "waiting", "pending", "queue"])) ||
    hasAll(q, ["waiting", "approval"]) ||
    hasAny(q, ["approvals", "approve leave", "inbox"])
  ) {
    return {
      kind: "table",
      summary: "Simulated approval queue from frontend mock data (not a live workflow engine). Ram can approve Babu's leave because Babu reports to him.",
      requires: "inbox",
      table: {
        headers: ["Employee", "Type", "From", "To", "Status"],
        rows: [
          ["Kabir Sharma", "PTO", "20 Oct", "22 Oct", "Pending"],
          ["Diya Patel", "WFH", "16 Oct", "16 Oct", "Pending"],
          ["Noah Garcia", "Sick", "14 Oct", "15 Oct", "Pending"],
        ],
      },
      links: [{ label: "Open Inbox & Approvals", to: "/approvals" }],
    };
  }

  if (
    hasAny(q, ["leave", "pto", "absence", "this year", "ytd"]) &&
    hasAny(q, ["balance", "remaining", "left", "how many", "what is my", "whats my", "what's my"])
  ) {
    return {
      kind: "metrics",
      summary:
        "Your leave balance this year: Annual leave 12 days left, Sick leave 6 days left, and WFH 8 days left. Comp-off and casual balances are on Leave & Absence.",
      metrics: [
        { label: "Annual leave left", value: "12 days" },
        { label: "Sick leave left", value: "6 days" },
        { label: "WFH left", value: "8 days" },
        { label: "Privilege leave left", value: "14 days" },
      ],
      links: [{ label: "Leave & Absence", to: "/leave" }],
    };
  }

  if (
    hasAny(q, ["apply for leave", "request leave", "how do i apply", "take leave", "book leave"]) ||
    (hasAny(q, ["leave"]) && hasAny(q, ["apply", "request", "how", "submit"]))
  ) {
    return {
      kind: "text",
      summary:
        "To apply for leave in this prototype: open Leave & Absence, choose a leave type, select dates, and submit. Approvals appear in Inbox for managers/HR. Holidays in the active demo region are skipped in working-day counts.",
      links: [
        { label: "Leave & Absence", to: "/leave" },
        { label: "Holidays", to: "/holidays" },
      ],
    };
  }

  if (hasAny(q, ["leave", "pto", "wfh", "absence", "comp off", "casual"]) && !hasAny(q, ["policy"])) {
    return {
      kind: "metrics",
      summary: `Your leave overview: Annual 12 days left · Sick 6 · WFH 8 · Privilege 14. Team leave days in October: ${TZ_HR.leaveTrend.find((r) => r.label === "Oct")?.days ?? 390}.`,
      metrics: [
        { label: "Annual left", value: "12 days" },
        { label: "Sick left", value: "6 days" },
        { label: "WFH left", value: "8 days" },
        { label: "Privilege left", value: "14 days" },
      ],
      links: [
        { label: "Leave & Absence", to: "/leave" },
        { label: "Approvals", to: "/approvals" },
      ],
    };
  }

  if (hasAny(q, ["policy", "policies", "acknowledg", "handbook"])) {
    return {
      kind: "table",
      summary: "Policy catalogue excerpt. Acknowledgements are not enforced by a live engine.",
      table: {
        headers: ["Policy", "Audience", "Ack pending"],
        rows: [
          ["Leave policy (sample)", "Global", "63"],
          ["Attendance policy (sample)", "Global", "41"],
          ["Information security (sample)", "All staff", "28"],
        ],
      },
      links: [{ label: "Policies", to: "/policies" }],
    };
  }

  if (hasAny(q, ["skill", "skills", "capacity", "gap", "coverage", "career"])) {
    return {
      kind: "table",
      summary: "Critical skill gaps from shared workforce mock (executive/manager demo view).",
      requires: "analytics",
      table: {
        headers: ["Skill", "Gap", "Countries"],
        rows: TZ_EXEC.criticalSkillGaps.map((s) => [s.skill, s.gap, s.countries]),
      },
      metrics: [
        { label: "Utilized", value: `${TZ_EXEC.capacity.utilizedPct}%` },
        { label: "Bench", value: `${TZ_EXEC.capacity.benchPct}%` },
        { label: "Hiring pressure", value: TZ_EXEC.capacity.hiringPressure },
      ],
      links: [{ label: "Skills & Career", to: "/skills" }],
    };
  }

  if (hasAny(q, ["attrition", "workforce", "headcount", "hiring", "exit", "exits", "turnover", "analytics", "dashboard"])) {
    return {
      kind: "metrics",
      summary: `Workforce snapshot from shared ${COMPANY_NAME} analytics mock. Filter Analytics for country/department detail.`,
      requires: "analytics",
      metrics: [
        { label: "Global headcount", value: String(TZ_HEADCOUNT.global) },
        { label: "Hiring YTD", value: String(TZ_MOVEMENT.hiringYtd) },
        { label: "Exits YTD", value: String(TZ_MOVEMENT.exitsYtd) },
        { label: "Attrition YTD", value: `${TZ_MOVEMENT.attritionYtdPct}%` },
      ],
      links: [{ label: "Open Analytics", to: "/analytics" }],
    };
  }

  if (hasAny(q, ["pipeline", "time-to-hire", "time to hire", "recruit", "requisition", "interview", "candidate", "offer", "ats"])) {
    return {
      kind: "table",
      requires: "recruiting",
      summary: `Recruiting pipeline demo · avg time-to-hire ${TZ_RECRUITING.avgTimeToHireDays} days (mock). Sophie gets candidate access via Recruiter role.`,
      table: {
        headers: ["Stage", "Candidates"],
        rows: TZ_RECRUITING.byStage.map((s) => [s.stage, String(s.count)]),
      },
      metrics: [
        { label: "Open reqs", value: String(TZ_RECRUITING.openRequisitions) },
        { label: "Offers out", value: String(TZ_RECRUITING.offersOut) },
      ],
      links: [{ label: "Recruiting", to: "/recruiting" }],
    };
  }

  if (hasAny(q, ["attendance", "overtime", "check in", "check-in", "check out", "check-out", "present", "punch", "clock in"])) {
    return {
      kind: "table",
      summary: "Attendance trend (sample %). Use Home or Attendance for the frontend check-in demo. Overtime figures are fictional.",
      table: {
        headers: ["Period", "Attendance %"],
        rows: TZ_HR.attendanceTrend.map((r) => [r.label, String(r.pct)]),
      },
      links: [{ label: "Time & Attendance", to: "/attendance" }],
    };
  }

  if (hasAny(q, ["integration", "sso", "audit", "connector", "admin", "administration"])) {
    return {
      kind: "text",
      summary:
        "Integration Center and Administration show connection status, last-sync placeholders, and an audit-log table. Alex manages accounts as Admin without automatic payslip access.",
      links: [
        { label: "Integration Center", to: "/integrations" },
        { label: "Administration", to: "/admin" },
      ],
    };
  }

  if (hasAny(q, ["learning", "certif", "training", "course", "lms", "program"])) {
    return {
      kind: "metrics",
      summary: "Learning completion from shared HR mock data.",
      metrics: [
        { label: "Completion", value: `${TZ_HR.learningCompletionPct}%` },
        { label: "Certifications YTD", value: "186" },
        { label: "Mandatory pending", value: "63" },
      ],
      links: [{ label: "Learning", to: "/programs" }],
    };
  }

  if (hasAny(q, ["team", "direct report", "my reports", "who reports", "my team"])) {
    return {
      kind: "text",
      summary: "Managers can open Team overview and People for authorized direct reports. Individual salaries stay hidden unless you switch to a compensation-authorized persona.",
      links: [
        { label: "Team overview", to: "/team" },
        { label: "People", to: "/directory" },
        { label: "Org chart", to: "/org-chart" },
      ],
    };
  }

  if (hasAny(q, ["expense", "expenses", "reimbursement", "claim"])) {
    return {
      kind: "text",
      summary: "Expenses and reimbursement screens hold sample claims. Submit for manager/finance review in this frontend demo.",
      links: [
        { label: "Expenses", to: "/expenses" },
        { label: "Reimbursement", to: "/reimbursement" },
      ],
    };
  }

  if (hasAny(q, ["help", "hr request", "support", "ticket", "faq"])) {
    return {
      kind: "text",
      summary: "Use Help & HR Requests to raise a demo service ticket, browse FAQ, or open policies.",
      links: [{ label: "Help", to: "/help" }],
    };
  }

  if (hasAny(q, ["copilot", "ai", "how do you work", "are you real", "llm", "model", "chatgpt"])) {
    return {
      kind: "text",
      summary: `${PRODUCT_NAME} Copilot is a frontend prototype. Answers are rule-based simulations over mock ${COMPANY_NAME} data — not a live LLM, RAG index, or gateway.`,
      links: [
        { label: "AI Agents", to: "/ai/agents" },
        { label: "Analytics", to: "/analytics" },
      ],
    };
  }

  // Soft fallback: pick closest module from keywords instead of a dead-end message
  if (hasAny(q, ["hour", "hours", "time", "week", "day"])) {
    return {
      kind: "text",
      summary:
        "For time-related questions: General Shift is 09:30 AM–06:30 PM in the India demo. Log daily project hours on Timesheet, and use Attendance for check-in status.",
      links: [
        { label: "Timesheet", to: "/timesheet" },
        { label: "Attendance", to: "/attendance" },
      ],
    };
  }

  return {
    kind: "text",
    summary: `I can help with ${COMPANY_NAME} demo topics — try: working hours, timesheet, leave balance, apply leave, payslips, holidays, org chart, attendance, approvals, policies, recruiting, skills, benefits, or analytics.`,
    links: [
      { label: "Timesheet", to: "/timesheet" },
      { label: "Leave & Absence", to: "/leave" },
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
    purpose: "Answers leave, policy, payslip navigation, and self-service how-to questions from sample content.",
    availability: "In-app Copilot suggestions · demo hours",
    demoStatus: "Demo ready",
  },
  {
    id: "manager",
    name: "Manager agent",
    audience: "Managers",
    purpose: "Surfaces pending approvals, team attendance summaries, and skill-coverage reminders (mock).",
    availability: "Manager personas · Inbox shortcuts",
    demoStatus: "Demo ready",
  },
  {
    id: "hr",
    name: "HR agent",
    audience: "HR / HRBP",
    purpose: "Triages sample HR cases, policy ack queues, and workforce movement digests.",
    availability: "HR personas · Administration-linked views",
    demoStatus: "Demo beta",
  },
  {
    id: "recruiter",
    name: "Recruiter agent",
    audience: "Recruiters",
    purpose: "Summarizes pipeline stages, drafts interview-kit outlines, and flags offer SLA samples.",
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
    purpose: "Narrates headcount, attrition, and capacity charts from Analytics mock series.",
    availability: "Analytics page · Copilot",
    demoStatus: "Demo ready",
  },
  {
    id: "document",
    name: "Document agent",
    audience: "HR & employees",
    purpose: "Helps locate sample letters and document checklists; does not generate legal documents.",
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
    description: "Workspace notifications and approval shortcuts (mock).",
    status: "Not configured",
    lastSync: "—",
    recordsProcessed: 0,
    errorCount: 0,
    logs: [{ at: "—", level: "info", message: "Connector not configured in this demo tenant" }],
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
    description: "Eligibility and enrollment file exchange (mock).",
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
  provider: "Infotech External Payroll Adapter",
  country: "Depends on active demo region",
  legalEntity: "Depends on active demo region",
  period: "October 2026 (sample)",
  lastSync: "2026-10-10 21:00 IST",
  integrationStatus: "Connected" as IntegrationStatus,
  notImplemented: [
    "Payroll processing / run calculation",
    "Tax calculation and filing",
    "Payslip generation engine (employee payslip UI uses seed data only)",
    "Payment / bank disbursement processing",
  ],
};

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
  outcome: "Recorded" | "Pending review" | "Simulated";
}

export const AUDIT_LOG_SEED: AuditLogRow[] = [
  {
    id: "aud-1",
    at: "2026-10-14 09:12",
    actor: "kai.nakamura@infotech.com",
    action: "Updated role binding",
    target: "HRBP",
    outcome: "Recorded",
  },
  {
    id: "aud-2",
    at: "2026-10-13 18:40",
    actor: "alex.morgan@infotech.com",
    action: "Rotated API key",
    target: "Payroll connector",
    outcome: "Simulated",
  },
  {
    id: "aud-3",
    at: "2026-10-13 11:05",
    actor: "farhan.ali@infotech.com",
    action: "Published policy",
    target: "Leave Policy",
    outcome: "Recorded",
  },
  {
    id: "aud-4",
    at: "2026-10-12 16:30",
    actor: "priya.nair@infotech.com",
    action: "Retry integration sync",
    target: "SSO / Identity",
    outcome: "Simulated",
  },
  {
    id: "aud-5",
    at: "2026-10-11 10:02",
    actor: "maya.chen@infotech.com",
    action: "Viewed compensation analytics",
    target: "Analytics",
    outcome: "Recorded",
  },
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
