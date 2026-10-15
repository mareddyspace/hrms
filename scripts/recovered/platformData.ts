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
  const depts = filterHeadcountByDept(dept);
  const countryShare =
    country === "ALL" ? 1 : (countries[0]?.headcount ?? 0) / TZ_HEADCOUNT.global;
  const deptShare =
    dept === "All departments"
      ? 1
      : (depts[0]?.headcount ?? 0) / TZ_HEADCOUNT.global;
  const share = countryShare * (dept === "All departments" ? 1 : Math.max(0.15, deptShare / countryShare || deptShare));

  const headcount = Math.round(
    (country === "ALL" ? TZ_HEADCOUNT.global : countries[0]?.headcount ?? 0) *
      (dept === "All departments" ? 1 : Math.max(0.08, (depts[0]?.headcount ?? 0) / TZ_HEADCOUNT.global / countryShare || 0.2)),
  );

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
    "Explain TimeZ AI Copilot demo limits",
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

export function answerCopilot(question: string): CopilotAnswer {
  const q = question.toLowerCase();
  if (q.includes("leave") && (q.includes("approv") || q.includes("waiting") || q.includes("pending"))) {
    return {
      kind: "table",
      summary: "Simulated approval queue from frontend mock data (not a live workflow engine).",
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
  if (q.includes("leave") && q.includes("balance")) {
    return {
      kind: "metrics",
      summary: "Sample leave balances for the active demo profile — fictional until payroll/leave engines are connected.",
      metrics: [
        { label: "Annual (sample)", value: "12 days" },
        { label: "Sick (sample)", value: "6 days" },
        { label: "WFH (sample)", value: "8 days" },
      ],
      links: [{ label: "Leave & Absence", to: "/leave" }],
    };
  }
  if (q.includes("leave") || q.includes("apply")) {
    return {
      kind: "text",
      summary:
        "To apply for leave in this prototype: open Leave & Absence, choose a leave type, select dates, and submit. Approvals appear in Inbox for managers/HR. Holidays in the active demo region are skipped in working-day counts. Responses are simulated.",
      links: [
        { label: "Leave & Absence", to: "/leave" },
        { label: "Holidays", to: "/holidays" },
      ],
    };
  }
  if (q.includes("policy") || q.includes("acknowledg")) {
    return {
      kind: "table",
      summary: "Policy catalogue excerpt (demo). Acknowledgements are not enforced by a live engine.",
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
  if (q.includes("skill") || q.includes("capacity") || q.includes("gap")) {
    return {
      kind: "table",
      summary: "Critical skill gaps from shared workforce mock (executive/manager demo view).",
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
  if (q.includes("attrition") || q.includes("workforce") || q.includes("headcount") || q.includes("hiring") || q.includes("exit")) {
    return {
      kind: "metrics",
      summary: "Workforce snapshot from shared TimeZ analytics mock. Filter Analytics for country/department detail.",
      metrics: [
        { label: "Global headcount", value: String(TZ_HEADCOUNT.global) },
        { label: "Hiring YTD", value: String(TZ_MOVEMENT.hiringYtd) },
        { label: "Exits YTD", value: String(TZ_MOVEMENT.exitsYtd) },
        { label: "Attrition YTD", value: `${TZ_MOVEMENT.attritionYtdPct}%` },
      ],
      links: [{ label: "Open Analytics", to: "/analytics" }],
    };
  }
  if (q.includes("pipeline") || q.includes("time-to-hire") || q.includes("recruit") || q.includes("requisition") || q.includes("interview")) {
    return {
      kind: "table",
      summary: `Recruiting pipeline demo · avg time-to-hire ${TZ_RECRUITING.avgTimeToHireDays} days (mock).`,
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
  if (q.includes("attendance") || q.includes("overtime")) {
    return {
      kind: "table",
      summary: "Attendance trend (sample %). Overtime figures are fictional demo hours.",
      table: {
        headers: ["Period", "Attendance %"],
        rows: TZ_HR.attendanceTrend.map((r) => [r.label, String(r.pct)]),
      },
      links: [{ label: "Time & Attendance", to: "/attendance" }],
    };
  }
  if (q.includes("integration") || q.includes("sso") || q.includes("audit")) {
    return {
      kind: "text",
      summary:
        "Integration Center and Administration show connection status, last-sync placeholders, and an audit-log table. Retry and permission edits are simulated locally and require a demo authorized-review confirmation for sensitive changes.",
      links: [
        { label: "Integration Center", to: "/integrations" },
        { label: "Administration", to: "/admin" },
      ],
    };
  }
  if (q.includes("learning") || q.includes("certif")) {
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
  return {
    kind: "text",
    summary:
      "I can help with leave, policies, approvals, team skills, recruiting pipeline, and workforce trends using mock TimeZ data. This Copilot is a frontend prototype — answers are rule-based simulations, not live model output.",
    links: [
      { label: "Analytics", to: "/analytics" },
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
    purpose: "Retrieves answers from a fictional policy knowledge base (no live RAG connection).",
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
    description: "SAML / OIDC placeholder for corporate identity providers.",
    status: "Degraded",
    lastSync: "2026-10-14 08:40 IST",
    recordsProcessed: 512,
    errorCount: 3,
    logs: [
      { at: "14 Oct 08:40", level: "warn", message: "Token refresh latency above threshold (demo)" },
      { at: "14 Oct 07:12", level: "info", message: "Directory sync batch completed (demo)" },
      { at: "13 Oct 22:01", level: "error", message: "IdP metadata fetch timeout (simulated)" },
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
      { at: "14 Oct 09:05", level: "info", message: "Digest batch sent (demo)" },
      { at: "14 Oct 06:00", level: "info", message: "Provider health check OK (demo)" },
    ],
  },
  {
    id: "teams",
    name: "Microsoft Teams",
    category: "Collaboration",
    description: "Presence and notification channel placeholders.",
    status: "Connected",
    lastSync: "2026-10-14 09:00 IST",
    recordsProcessed: 910,
    errorCount: 1,
    logs: [
      { at: "14 Oct 09:00", level: "info", message: "Channel notify push (demo)" },
      { at: "13 Oct 16:22", level: "warn", message: "Webhook 429 soft throttle (simulated)" },
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
    description: "Badge / biometric punch feed placeholder.",
    status: "Connected",
    lastSync: "2026-10-14 09:15 IST",
    recordsProcessed: 18420,
    errorCount: 12,
    logs: [
      { at: "14 Oct 09:15", level: "info", message: "Punch import cycle (demo)" },
      { at: "14 Oct 08:02", level: "error", message: "Device TZ-BLR-04 offline (simulated)" },
    ],
  },
  {
    id: "learning",
    name: "Learning LMS",
    category: "Talent",
    description: "Course completion and certification sync placeholder.",
    status: "Connected",
    lastSync: "2026-10-13 23:40 IST",
    recordsProcessed: 640,
    errorCount: 0,
    logs: [{ at: "13 Oct 23:40", level: "info", message: "Completion delta sync (demo)" }],
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
      { at: "12 Oct 18:20", level: "warn", message: "Enrollment file validation warnings (demo)" },
      { at: "11 Oct 18:20", level: "error", message: "SFTP handshake failed once (simulated)" },
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
      { at: "10 Oct 21:00", level: "info", message: "Period file handoff placeholder (demo)" },
      { at: "01 Oct 21:00", level: "info", message: "Prior period acknowledged (demo)" },
    ],
  },
];

/* —— Payroll —— */

export const PAYROLL_STATUS = {
  provider: "TimeZ External Payroll Adapter (demo)",
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
  company: "TimeZ",
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
  { id: "payroll", label: "Payroll placeholder", description: "External payroll status" },
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
    actor: "kai.nakamura@timez.com",
    action: "Updated role binding (demo)",
    target: "HRBP",
    outcome: "Recorded",
  },
  {
    id: "aud-2",
    at: "2026-10-13 18:40",
    actor: "alex.morgan@timez.com",
    action: "Rotated API key (demo)",
    target: "Payroll connector",
    outcome: "Simulated",
  },
  {
    id: "aud-3",
    at: "2026-10-13 11:05",
    actor: "farhan.ali@timez.com",
    action: "Published policy (demo)",
    target: "Leave Policy",
    outcome: "Recorded",
  },
  {
    id: "aud-4",
    at: "2026-10-12 16:30",
    actor: "priya.nair@timez.com",
    action: "Retry integration sync (demo)",
    target: "SSO / Identity",
    outcome: "Simulated",
  },
  {
    id: "aud-5",
    at: "2026-10-11 10:02",
    actor: "maya.chen@timez.com",
    action: "Viewed compensation analytics (demo)",
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
