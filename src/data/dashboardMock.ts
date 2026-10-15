import { TIMEZ_COUNTRIES } from "../model.ts";

/** Canonical Infotech workforce numbers — keep dashboards consistent. */
export const TZ_HEADCOUNT = {
  global: 500,
  byCountry: TIMEZ_COUNTRIES.map((c) => ({
    code: c.code,
    name: c.name,
    headcount: c.headcount,
    currency: c.currency,
  })),
  byDepartment: [
    { name: "Engineering", headcount: 168 },
    { name: "Product", headcount: 54 },
    { name: "Sales", headcount: 72 },
    { name: "People", headcount: 38 },
    { name: "Finance", headcount: 41 },
    { name: "Operations", headcount: 65 },
    { name: "Customer Success", headcount: 42 },
    { name: "Other", headcount: 20 },
  ],
  byBusinessUnit: [
    { name: "Infotech India", headcount: 200 },
    { name: "Infotech Americas", headcount: 135 },
    { name: "Infotech EMEA", headcount: 100 },
    { name: "Infotech APAC (ex-IN)", headcount: 65 },
  ],
} as const;

export const TZ_MOVEMENT = {
  joiners30d: 18,
  exits30d: 7,
  netGrowth30d: 11,
  joinersYtd: 96,
  exitsYtd: 41,
  attritionYtdPct: 8.2,
  hiringYtd: 112,
} as const;

export const TZ_RECRUITING = {
  openRequisitions: 24,
  candidates: 142,
  byStage: [
    { stage: "Screen", count: 48 },
    { stage: "HM interview", count: 36 },
    { stage: "Technical", count: 28 },
    { stage: "Offer", count: 18 },
    { stage: "Hired", count: 12 },
  ],
  interviewsThisWeek: 19,
  pendingFeedback: 11,
  offersOut: 8,
  offersAccepted: 5,
  avgTimeToHireDays: 34,
  myOpenReqs: [
    { id: "JOB-221", title: "Senior React Engineer", openings: 3, stage: "Interviewing", owner: "Daniel Ortiz" },
    { id: "JOB-218", title: "HR Business Partner", openings: 1, stage: "Offer", owner: "Sophie Clark" },
    { id: "JOB-210", title: "Talent Sourcer", openings: 2, stage: "Screen", owner: "Sophie Clark" },
    { id: "JOB-205", title: "Finance Analyst", openings: 1, stage: "On hold", owner: "Victor Lang" },
  ],
  candidatesAwaitingFeedback: [
    { name: "Aisha Khan", role: "Senior React Engineer", stage: "Technical", due: "15 Oct" },
    { name: "Tom Hughes", role: "HR Business Partner", stage: "HM interview", due: "16 Oct" },
    { name: "Mei Lin", role: "Talent Sourcer", stage: "Screen", due: "17 Oct" },
  ],
  upcomingInterviews: [
    { when: "Today 2:00 PM", candidate: "Jonas Weber", role: "Finance Analyst", panel: "Hiring manager" },
    { when: "Tomorrow 10:30 AM", candidate: "Aisha Khan", role: "Senior React Engineer", panel: "Tech panel" },
    { when: "17 Oct 4:00 PM", candidate: "Priya Desai", role: "Product Manager", panel: "HM + Recruiter" },
  ],
} as const;

export const TZ_TEAM = {
  managerTeamSize: 12,
  presentToday: 9,
  wfhToday: 2,
  onLeaveToday: 1,
  attendancePct: 92,
  utilizationPct: 88,
  timesheetCompliancePct: 83,
  overtimeHours: 46,
  oneOnOnesDue: 3,
  engagementScore: 7.4,
  attritionRiskCount: 1,
  openRoles: 2,
  directReports: [
    { name: "Babu Menon", code: "EMP1184", role: "Software Engineer", status: "Present" },
    { name: "Priya Nair", code: "LRN6001", role: "L&D Lead", status: "WFH" },
    { name: "Anu Rao", code: "PRF6101", role: "Performance Mgr", status: "Present" },
    { name: "Kabir Sharma", code: "TZ0042", role: "Senior Engineer", status: "Leave" },
    { name: "Diya Patel", code: "TZ0055", role: "QA Analyst", status: "Present" },
  ],
  upcomingLeave: [
    { name: "Kabir Sharma", type: "PTO", from: "14 Oct", to: "16 Oct", coverage: "Diya + Babu" },
    { name: "Priya Nair", type: "PTO", from: "20 Oct", to: "21 Oct", coverage: "Anu (acting)" },
    { name: "Diya Patel", type: "WFH", from: "22 Oct", to: "22 Oct", coverage: "OK" },
  ],
  reviewDeadlines: [
    { name: "Priya Nair", item: "Mid-year check-in", due: "18 Oct", status: "Due soon" },
    { name: "Anu Rao", item: "Skills feedback", due: "22 Oct", status: "Scheduled" },
    { name: "Isha Reddy", item: "30-day probation", due: "05 Nov", status: "On track" },
  ],
  oneOnOnes: [
    { name: "Babu Menon", last: "07 Oct", next: "16 Oct", status: "Booked" },
    { name: "Diya Patel", last: "01 Oct", next: "Overdue", status: "Needs slot" },
    { name: "Kabir Sharma", last: "30 Sep", next: "17 Oct", status: "Booked" },
  ],
  overtimeRisk: [
    { name: "Babu Menon", hours: 14, note: "Sprint crunch" },
    { name: "Diya Patel", hours: 11, note: "Release support" },
  ],
  attritionSignals: [
    { name: "Kabir Sharma", signal: "Low engagement pulse · high OT", risk: "Watch" },
  ],
  newJoiners: [
    { name: "Isha Reddy", start: "06 Oct", role: "Engineer" },
    { name: "Noah Garcia", start: "13 Oct", role: "Designer" },
  ],
  skills: [
    { name: "React / TypeScript", cover: 7, gap: "Need 2 more" },
    { name: "QA automation", cover: 3, gap: "Stretch" },
    { name: "Cloud / DevOps", cover: 4, gap: "OK" },
  ],
  goals: [
    { name: "Sprint delivery", progress: 72 },
    { name: "QA escape rate < 2%", progress: 58 },
    { name: "Client UAT sign-off", progress: 40 },
  ],
  capacityByWeek: [
    { label: "This week", pct: 92 },
    { label: "+1 week", pct: 78 },
    { label: "+2 weeks", pct: 85 },
    { label: "+3 weeks", pct: 88 },
  ],
} as const;

export const TZ_HR = {
  pendingHrActions: 27,
  openCases: 14,
  policyAckPending: 63,
  performanceCycle: { name: "H2 2026 Mid-year", completionPct: 61, due: "31 Oct" },
  learningCompletionPct: 74,
  leaveTrend: [
    { label: "Jul", days: 420 },
    { label: "Aug", days: 510 },
    { label: "Sep", days: 480 },
    { label: "Oct", days: 390 },
  ],
  attendanceTrend: [
    { label: "Jul", pct: 94 },
    { label: "Aug", pct: 93 },
    { label: "Sep", pct: 95 },
    { label: "Oct", pct: 94 },
  ],
  hrbpScope: {
    org: "Engineering — India Delivery",
    employees: 86,
    cases: 9,
    movements: [
      { type: "Transfer", who: "Ravi Menon", detail: "Platform → Shared Services", date: "01 Oct" },
      { type: "Promotion", who: "Anita Joseph", detail: "QA → Senior QA", date: "08 Oct" },
      { type: "Exit", who: "Sample Contractor", detail: "Contract end", date: "20 Oct" },
    ],
  },
} as const;

export const TZ_EXEC = {
  criticalSkillGaps: [
    { skill: "AI / ML engineering", gap: "High", countries: "IN, US" },
    { skill: "Cybersecurity", gap: "Medium", countries: "GB, DE" },
    { skill: "Revenue operations", gap: "Medium", countries: "US" },
  ],
  capacity: { utilizedPct: 87, benchPct: 6, hiringPressure: "Elevated" },
  strategicAlerts: [
    { text: "India engineering utilization above 90% for 3 weeks", tone: "warn" as const },
    { text: "EMEA attrition within target (7.4%)", tone: "ok" as const },
    { text: "24 open reqs — 8 in Offer stage", tone: "info" as const },
  ],
  announcements: [
    { title: "Q4 All-hands", when: "22 Oct", audience: "Global" },
    { title: "Benefits open enrollment (US)", when: "01–15 Nov", audience: "United States" },
  ],
} as const;

export const TZ_ADMIN = {
  users: 512,
  activeRoles: 8,
  legalEntities: 8,
  integrations: [
    { name: "Payroll connector", status: "Healthy" },
    { name: "SSO / IdP", status: "Degraded" },
    { name: "ATS webhook", status: "Healthy" },
    { name: "Document store", status: "Healthy" },
  ],
  auditEvents: [
    { at: "14 Oct 09:12", actor: "kai.nakamura@infotech.com", action: "Updated role binding", target: "HRBP" },
    { at: "13 Oct 18:40", actor: "alex.morgan@infotech.com", action: "Rotated API key", target: "Payroll connector" },
    { at: "13 Oct 11:05", actor: "farhan.ali@infotech.com", action: "Published policy", target: "Leave Policy" },
  ],
} as const;

export const TZ_EMPLOYEE_DEFAULTS = {
  profileCompletionPct: 82,
  timesheetStatus: "Draft — week of 13 Oct",
  learningProgress: [
    { name: "Workplace safety", progress: 100 },
    { name: "Secure coding", progress: 45 },
  ],
  goals: [
    { name: "Ship timesheet calendar UX", progress: 70 },
    { name: "Reduce PR cycle time", progress: 55 },
  ],
  recentDocs: [
    { name: "Offer letter addendum", to: "/documents" },
    { name: "Leave policy", to: "/policies" },
    { name: "Payslip Sep 2026", to: "/payslips" },
  ],
} as const;

export type DateRangeKey = "7d" | "30d" | "90d" | "ytd";

export function dateRangeLabel(key: DateRangeKey): string {
  switch (key) {
    case "7d":
      return "Last 7 days";
    case "30d":
      return "Last 30 days";
    case "90d":
      return "Last 90 days";
    default:
      return "Year to date";
  }
}
