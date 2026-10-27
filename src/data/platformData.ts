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
  if (role === "manager") return "manager";
  if (role === "hr" || role === "hr_admin" || role === "hrbp") return "hr";
  if (role === "recruiter") return "recruiter";
  if (role === "executive" || role === "founder" || role === "cofounder") return "executive";
  if (role === "it_admin" || role === "admin" || role === "super_admin" || role === "compliance") return "admin";
  return "other";
}

export const COPILOT_SUGGESTIONS: Record<CopilotPersona, string[]> = {
  employee: [
    "What is my leave balance?",
    "When is the next holiday?",
    "My last payslip net pay",
    "Timesheet status this week",
  ],
  manager: [
    "What is waiting on my approval?",
    "Who is on leave this week?",
    "Summarise Babu Menon",
    "What is my leave balance?",
  ],
  hr: [
    "Give me a headcount snapshot",
    "What is waiting on my approval?",
    "Summarise Ram Krishnan",
    "Who is on leave today?",
  ],
  recruiter: [
    "How many open positions are there?",
    "How many candidates are in the pipeline?",
    "What is my leave balance?",
    "When is the next holiday?",
  ],
  executive: [
    "Give me a headcount snapshot",
    "Headcount by country",
    "What is waiting on my approval?",
    "Summarise Ram Krishnan",
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
  leaveRows: { name: string; code: string; available: number; pending: number; quota?: number; utilized?: number }[];
  holidays: { date: string; name: string }[];
  /** Items the viewer decides — same rules and total as countWaitingOnMe. */
  approvals: { who: string; kind: string; detail: string; date: string }[];
  approvalsCount: number;
  teamSize: number;
  /** Approved leave days this year for people below the viewer. */
  teamLeave: { name: string; days: number }[];
  /** True when the viewer may see company-wide workforce numbers. */
  orgWide: boolean;
  workforce?: {
    headcount: number;
    joiners: number;
    exits: number;
    attritionPct: number;
    joinersMonth?: number;
    exitsMonth?: number;
    /** Sentence with 12-month attrition, exits and joiners. */
    attrition12?: string;
    byCountry?: { name: string; count: number }[];
    byDepartment?: { name: string; count: number }[];
  };
  /** Set when no live data was supplied. */
  limited?: boolean;
  /* —— Richer live data (all optional; filled by buildCopilotContext) —— */
  today?: string;
  fullName?: string;
  countryCode?: string;
  currency?: string;
  shiftName?: string;
  todayShift?: string;
  weeklyOff?: string[];
  /** Every holiday that applies to the viewer (country list plus optional picks), all dates. */
  allHolidays?: { date: string; name: string }[];
  leavePolicies?: { code: string; name: string; quota: number; accrual?: string; carryForwardMax?: number }[];
  policies?: { title: string; body?: string }[];
  /** The viewer's own leave requests, newest first. */
  myLeave?: { type: string; code: string; from: string; to: string; days: number; status: string; appliedOn: string; decidedBy?: string; note?: string }[];
  backdated?: { type: string; from: string; to: string; status: string }[];
  team?: { name: string; direct: boolean; designation: string }[];
  /** Approved leave/WFH from today for the next two weeks, within awayScope. */
  away?: { name: string; self: boolean; type: string; wfh: boolean; from: string; to: string }[];
  awayScope?: "org" | "team" | "self";
  recruiting?: {
    approvedReqs: number;
    openings: number;
    pendingReqs: number;
    onHoldReqs: number;
    roles: { title: string; country: string; openings: number }[];
    /** Pipeline figures: only with recruiting access (not just Jobs). */
    candidates?: number;
    byStage?: { stage: string; count: number }[];
    openOffers?: number;
  };
  compReview?: { cycle: string; status: string; total: number; submittedPct: number; approved: number; awaiting: number; avgIncreasePct: number } | null;
  /** The viewer's own payslips, newest first. */
  payslips?: { label: string; month: string; currency: string; gross: number; net: number; tax: number; deductions: { name: string; amount: number }[] }[];
  /** This week, then last week. */
  timesheetWeeks?: { weekStart: string; hours: number; status: string }[];
  corrections?: { date: string; kind: string; status: string }[];
  goals?: { cycle: string; items: { title: string; progress: number; weight: number }[]; weighted: number; review?: string };
  learning?: { title: string; mandatory: boolean; status: string; progress: number; due?: string }[];
  mandatoryCourses?: { title: string; audience: string; status: string; due?: string }[];
  expenses?: { kind: string; category: string; amount: number; currency: string; status: string; date: string }[];
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

import { copilotAnswer, NO_DECISIONS } from "../features/copilot/answers.ts";

export { summaryTarget } from "../features/copilot/answers.ts";

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
    if (/(leave|lea?vs?|pto|vacation|balance|holi|approv|waiting|pending|shift|hours|team|headcount|attrition|pay|salary|tax|goal|course|timesheet|manager|report)/.test(q)) {
      return {
        kind: "text",
        summary: `Open the full Copilot page for answers from your own data. ${NO_DECISIONS}`,
        links: [{ label: "AI Copilot", to: "/ai/copilot" }],
      };
    }
  }
  const { requires, ...raw } = copilotAnswer(question, ctx);
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
