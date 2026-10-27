/** Shared Infotech talent modules mock data — recruiting through skills. */

/** Blueprint order. Rejected / Withdrawn are exits, reachable from any open stage. */
export const PIPELINE_STAGES = [
  "Applied",
  "Screening",
  "Shortlisted",
  "Interview",
  "Assessment",
  "Final Review",
  "Offer",
  "Hired",
  "Rejected",
  "Withdrawn",
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/** Stages a candidate can always be moved to (from any non-final stage). */
export const EXIT_STAGES: readonly PipelineStage[] = ["Rejected", "Withdrawn"];
/** Final stages — no further moves. */
export const CLOSED_STAGES: readonly PipelineStage[] = ["Hired", "Rejected", "Withdrawn"];
/** Candidates at these stages can be given an offer. */
export const OFFER_ELIGIBLE_STAGES: readonly PipelineStage[] = ["Final Review", "Offer"];

export type ApprovalStatus = "Draft" | "Pending approval" | "Approved" | "Rejected" | "On hold";

/** One entry in an approval trail. */
export interface ApprovalStep {
  on: string;
  by: string;
  byId: string;
  action: string;
  note?: string;
}

export interface Requisition {
  id: string;
  title: string;
  department: string;
  country: string;
  location: string;
  openings: number;
  hiringManager: string;
  /** Account id of the hiring manager; approval goes to people above them. */
  hiringManagerId: string;
  recruiter: string;
  approvalStatus: ApprovalStatus;
  stageSummary: string;
  created: string;
  /** Last decision (approve / reject / hold). */
  approver?: string;
  decidedOn?: string;
  history: ApprovalStep[];
}

export interface Candidate {
  id: string;
  name: string;
  email: string;
  phone: string;
  role: string;
  requisitionId: string;
  stage: PipelineStage;
  country: string;
  source: string;
  experienceYears: number;
  skills: string[];
  resumeNote: string;
}

export interface Interview {
  id: string;
  candidateId: string;
  candidateName: string;
  role: string;
  when: string;
  panel: string;
  type: string;
  feedbackStatus: "Pending" | "Submitted";
  score?: number;
  feedback?: string;
}

export type OfferStatus = "Preparing" | "Pending approval" | "Approved" | "Sent" | "Accepted" | "Declined" | "Withdrawn";

export interface OfferApproval {
  role: "Line" | "Compensation";
  by: string;
  byId: string;
  on: string;
}

export interface OfferRecord {
  id: string;
  candidateId: string;
  candidateName: string;
  requisitionId: string;
  role: string;
  status: OfferStatus;
  grade: string;
  /** Annual base salary in `currency`. */
  baseSalary: number;
  currency: string;
  startDate: string;
  packageNote: string;
  createdBy: string;
  createdById: string;
  approvals: OfferApproval[];
  sentOn?: string;
  /** The candidate's answer, recorded by recruiting with how it was received. */
  responseNote?: string;
  responseRecordedBy?: string;
  respondedOn?: string;
}

export interface OnboardingJoiner {
  id: string;
  name: string;
  role: string;
  startDate: string;
  country: string;
  manager: string;
  managerId: string;
  candidateId?: string;
  requisitionId?: string;
  /** Set once onboarding is complete and the person is added to the directory. */
  personId?: string;
  preboardingPct: number;
  docsStatus: "Not started" | "In progress" | "Submitted" | "Verified";
  policyAck: "Pending" | "Complete";
  overallStatus: "Pre-boarding" | "Day 1 ready" | "In progress" | "Completed";
}

export interface OnboardingTask {
  id: string;
  joinerId: string;
  title: string;
  owner: "HR" | "IT" | "Manager" | "Employee";
  category: "Documents" | "Equipment" | "Accounts" | "Orientation" | "Training" | "Policy";
  status: "Pending" | "In progress" | "Done";
  due: string;
  /** When HR updates a task someone else owns, the reason is kept here. */
  overrideNote?: string;
}

export interface PerfGoal {
  id: string;
  ownerId: string;
  ownerName: string;
  type: "Goal" | "OKR" | "KPI";
  title: string;
  /** Measurable target, e.g. "≥ 85%". */
  target: string;
  /** Share of the owner's goals in the cycle, in percent. A person's goals in a cycle should add up to 100. */
  weight: number;
  /** Period the goal covers, e.g. "Jul–Oct 2026". */
  period: string;
  progress: number;
  cycleId: string;
}

export interface PerfCycle {
  id: string;
  name: string;
  status: "Planning" | "Active" | "Calibration" | "Closed";
  start: string;
  end: string;
}

export interface PerfReview {
  id: string;
  employeeId: string;
  employeeName: string;
  cycleId: string;
  selfStatus: "Not started" | "Draft" | "Submitted";
  managerStatus: "Not started" | "Draft" | "Submitted";
  feedback360Status: "Not started" | "In progress" | "Complete";
  /** Employee's own summary; required to submit. */
  selfText?: string;
  /** Manager's summary; required to submit. */
  managerText?: string;
  rating?: string;
  /** The employee sees the rating only once HR releases it after calibration. */
  released?: boolean;
  releasedBy?: string;
  releasedOn?: string;
  developmentPlan?: string;
  finalDecisionNote: string;
}

export const RATINGS = ["Needs improvement", "Solid", "Strong", "Exceptional"] as const;

export interface Course {
  id: string;
  title: string;
  category: string;
  durationHours: number;
  mandatory: boolean;
  /** Who may enroll. */
  audience: CourseAudience;
  /** Skill ids (SKILL_LIBRARY) this course builds. */
  skills: string[];
}

export type CourseAudience = "All" | "Engineering" | "Managers" | "Hiring";

export interface LearningPath {
  id: string;
  title: string;
  courses: string[];
  audience: string;
}

export interface Enrollment {
  id: string;
  courseId: string;
  employeeId: string;
  employeeName: string;
  status: "Assigned" | "In progress" | "Completed";
  progress: number;
  due?: string;
  completedOn?: string;
  /** Final assessment score (0–100) recorded by HR. */
  assessmentScore?: number;
}

export interface Certification {
  id: string;
  employeeId: string;
  employeeName: string;
  name: string;
  issuer: string;
  earnedOn: string;
  /** Empty when the certification never expires. */
  expiresOn?: string;
  /** How long a renewal is valid for, in years. */
  validityYears?: number;
  /** Set when the employee records a renewal; dates only change once HR verifies it. */
  renewalStatus?: "Pending verification";
  renewalRequestedOn?: string;
  /** New expiry entered by the employee when the certification has no fixed validity. */
  renewalExpiresOn?: string;
  /** Set once HR has checked the certificate with the issuer. */
  verifiedBy?: string;
  verifiedOn?: string;
  /** Credential number from the issuer, recorded by HR when verifying. */
  credentialId?: string;
}

export const PRAISE_BADGES = ["Teamwork", "Ownership", "Customer first", "Innovation", "Mentorship"] as const;
export type PraiseBadge = (typeof PRAISE_BADGES)[number];

/** Continuous feedback: public praise, private feedback, or a request for feedback. */
export interface FeedbackItem {
  id: string;
  kind: "Praise" | "Feedback" | "Request";
  fromId: string;
  fromName: string;
  toId: string;
  toName: string;
  /** For a Request: whose work the feedback should be about. */
  aboutName?: string;
  badge?: PraiseBadge;
  message: string;
  createdOn: string;
  /** Full timestamp (ISO) for duplicate detection; missing on older items. */
  createdAt?: string;
  /** Requests only. */
  status?: "Open" | "Answered";
}

export interface CheckInItem {
  id: string;
  text: string;
  done: boolean;
}

/** Recurring manager–employee 1:1 meeting with shared agenda, action items and notes. */
export interface OneOnOne {
  id: string;
  managerId: string;
  managerName: string;
  employeeId: string;
  employeeName: string;
  date: string;
  time: string;
  status: "Upcoming" | "Completed";
  agenda: CheckInItem[];
  actionItems: CheckInItem[];
  notes: string;
}

export interface SkillDef {
  id: string;
  name: string;
  category: string;
  levels: string[];
}

export interface EmployeeSkill {
  skillId: string;
  skillName: string;
  level: string;
  targetLevel: string;
}

export interface SkillProfile {
  employeeId: string;
  skills: EmployeeSkill[];
}

const SOPHIE = { by: "Sophie Clark", byId: "demo-recruiter" };
const JORDAN = { by: "Jordan Blake", byId: "demo-ceo" };

export const REQUISITIONS: Requisition[] = [
  {
    id: "JOB-221",
    title: "Senior React Engineer",
    department: "Engineering",
    country: "India",
    location: "Bengaluru",
    openings: 3,
    hiringManager: "Ram Krishnan",
    hiringManagerId: "emp-ram",
    recruiter: "Sophie Clark",
    approvalStatus: "Approved",
    stageSummary: "Interviewing",
    created: "2026-08-12",
    approver: "Jordan Blake",
    decidedOn: "2026-08-14",
    history: [
      { ...SOPHIE, on: "2026-08-12", action: "Submitted for approval" },
      { ...JORDAN, on: "2026-08-14", action: "Approved" },
    ],
  },
  {
    id: "JOB-218",
    title: "HR Business Partner",
    department: "People",
    country: "United Kingdom",
    location: "London",
    openings: 1,
    hiringManager: "Farhan Ali",
    hiringManagerId: "demo-hr-admin",
    recruiter: "Sophie Clark",
    approvalStatus: "Approved",
    stageSummary: "Offer",
    created: "2026-07-28",
    approver: "Jordan Blake",
    decidedOn: "2026-07-30",
    history: [
      { ...SOPHIE, on: "2026-07-28", action: "Submitted for approval" },
      { ...JORDAN, on: "2026-07-30", action: "Approved" },
    ],
  },
  {
    id: "JOB-210",
    title: "Talent Sourcer",
    department: "People",
    country: "United States",
    location: "New York",
    openings: 2,
    hiringManager: "Farhan Ali",
    hiringManagerId: "demo-hr-admin",
    recruiter: "Sophie Clark",
    approvalStatus: "Pending approval",
    stageSummary: "Awaiting approval",
    created: "2026-09-05",
    history: [{ ...SOPHIE, on: "2026-09-05", action: "Submitted for approval" }],
  },
  {
    id: "JOB-205",
    title: "Product Analyst",
    department: "Product",
    country: "Canada",
    location: "Toronto",
    openings: 1,
    hiringManager: "Daniel Ortiz",
    hiringManagerId: "demo-hiring-manager",
    recruiter: "Sophie Clark",
    approvalStatus: "On hold",
    stageSummary: "On hold",
    created: "2026-06-18",
    approver: "Jordan Blake",
    decidedOn: "2026-07-02",
    history: [
      { ...SOPHIE, on: "2026-06-18", action: "Submitted for approval" },
      { ...JORDAN, on: "2026-07-02", action: "Put on hold", note: "Budget review" },
    ],
  },
  {
    id: "JOB-230",
    title: "Product Manager",
    department: "Product",
    country: "India",
    location: "Bengaluru",
    openings: 1,
    hiringManager: "Daniel Ortiz",
    hiringManagerId: "demo-hiring-manager",
    recruiter: "Sophie Clark",
    approvalStatus: "Approved",
    stageSummary: "Interviewing",
    created: "2026-10-01",
    approver: "Jordan Blake",
    decidedOn: "2026-10-03",
    history: [
      { ...SOPHIE, on: "2026-10-01", action: "Submitted for approval" },
      { ...JORDAN, on: "2026-10-03", action: "Approved" },
    ],
  },
  {
    id: "JOB-226",
    title: "Product Designer",
    department: "Product",
    country: "United States",
    location: "San Francisco",
    openings: 1,
    hiringManager: "Daniel Ortiz",
    hiringManagerId: "demo-hiring-manager",
    recruiter: "Sophie Clark",
    approvalStatus: "Approved",
    stageSummary: "Filled",
    created: "2026-08-01",
    approver: "Jordan Blake",
    decidedOn: "2026-08-03",
    history: [
      { ...SOPHIE, on: "2026-08-01", action: "Submitted for approval" },
      { ...JORDAN, on: "2026-08-03", action: "Approved" },
    ],
  },
  {
    id: "JOB-224",
    title: "Customer Success Associate",
    department: "Customer Success",
    country: "United Arab Emirates",
    location: "Dubai",
    openings: 1,
    hiringManager: "Farhan Ali",
    hiringManagerId: "demo-hr-admin",
    recruiter: "Sophie Clark",
    approvalStatus: "Approved",
    stageSummary: "Filled",
    created: "2026-08-20",
    approver: "Jordan Blake",
    decidedOn: "2026-08-22",
    history: [
      { ...SOPHIE, on: "2026-08-20", action: "Submitted for approval" },
      { ...JORDAN, on: "2026-08-22", action: "Approved" },
    ],
  },
];

export const CANDIDATES: Candidate[] = [
  {
    id: "cand-1",
    name: "Aisha Khan",
    email: "aisha.khan@example.com",
    phone: "+91 98xxx x2144",
    role: "Senior React Engineer",
    requisitionId: "JOB-221",
    stage: "Interview",
    country: "India",
    source: "LinkedIn",
    experienceYears: 7,
    skills: ["React", "TypeScript", "Design systems"],
    resumeNote: "Strong frontend portfolio; hybrid Bengaluru preference.",
  },
  {
    id: "cand-2",
    name: "Lucas Meyer",
    email: "lucas.meyer@example.com",
    phone: "+44 20 xxx 0881",
    role: "HR Business Partner",
    requisitionId: "JOB-218",
    stage: "Offer",
    country: "United Kingdom",
    source: "Agency",
    experienceYears: 9,
    skills: ["Employee relations", "Workforce planning"],
    resumeNote: "EMEA HRBP background; offer in preparation.",
  },
  {
    id: "cand-4",
    name: "Jonas Weber",
    email: "jonas.weber@example.com",
    phone: "+49 30 xxx 4412",
    role: "Product Analyst",
    requisitionId: "JOB-205",
    stage: "Screening",
    country: "Germany",
    source: "Careers site",
    experienceYears: 5,
    skills: ["SQL", "Product analytics", "Experimentation"],
    resumeNote: "Open to Toronto relocation. Requisition is on hold.",
  },
  {
    id: "cand-5",
    name: "Priya Desai",
    email: "priya.desai@example.com",
    phone: "+91 98xxx x3301",
    role: "Product Manager",
    requisitionId: "JOB-230",
    stage: "Interview",
    country: "India",
    source: "Careers site",
    experienceYears: 6,
    skills: ["Roadmapping", "Discovery", "Analytics"],
    resumeNote: "B2B SaaS PM.",
  },
  {
    id: "cand-6",
    name: "Karthik Rao",
    email: "karthik.rao@example.com",
    phone: "+91 98xxx x7710",
    role: "Senior React Engineer",
    requisitionId: "JOB-221",
    stage: "Assessment",
    country: "India",
    source: "LinkedIn",
    experienceYears: 8,
    skills: ["React", "Node", "System design"],
    resumeNote: "Completed take-home; panel review next.",
  },
  {
    id: "cand-7",
    name: "Riya Kapoor",
    email: "riya.kapoor@example.com",
    phone: "+91 98xxx x5520",
    role: "Senior React Engineer",
    requisitionId: "JOB-221",
    stage: "Hired",
    country: "India",
    source: "Referral",
    experienceYears: 5,
    skills: ["React", "Testing"],
    resumeNote: "Offer accepted. Started 06 Oct.",
  },
  {
    id: "cand-8",
    name: "Tom Hughes",
    email: "tom.hughes@example.com",
    phone: "+44 20 xxx 2210",
    role: "HR Business Partner",
    requisitionId: "JOB-218",
    stage: "Final Review",
    country: "United Kingdom",
    source: "Referral",
    experienceYears: 8,
    skills: ["HRBP", "Change management"],
    resumeNote: "Final panel complete; hiring manager decision pending.",
  },
  {
    id: "cand-9",
    name: "Noah Garcia",
    email: "noah.garcia@example.com",
    phone: "+1 628 xxx 7710",
    role: "Product Designer",
    requisitionId: "JOB-226",
    stage: "Hired",
    country: "United States",
    source: "Referral",
    experienceYears: 6,
    skills: ["Figma", "Design systems", "User research"],
    resumeNote: "Offer accepted. Started 13 Oct.",
  },
  {
    id: "cand-10",
    name: "Amira Hassan",
    email: "amira.hassan@example.com",
    phone: "+971 50 xxx 3390",
    role: "Customer Success Associate",
    requisitionId: "JOB-224",
    stage: "Hired",
    country: "United Arab Emirates",
    source: "Careers site",
    experienceYears: 3,
    skills: ["Customer support", "Arabic", "English"],
    resumeNote: "Offer accepted. Starts 27 Oct.",
  },
];

export const INTERVIEWS: Interview[] = [
  {
    id: "int-2",
    candidateId: "cand-1",
    candidateName: "Aisha Khan",
    role: "Senior React Engineer",
    when: "2026-10-15 10:30",
    panel: "Ram Krishnan · Tech panel",
    type: "Technical",
    feedbackStatus: "Pending",
  },
  {
    id: "int-3",
    candidateId: "cand-5",
    candidateName: "Priya Desai",
    role: "Product Manager",
    when: "2026-10-29 16:00",
    panel: "Daniel Ortiz · Sophie Clark",
    type: "Hiring manager + recruiter",
    feedbackStatus: "Pending",
  },
  {
    id: "int-4",
    candidateId: "cand-6",
    candidateName: "Karthik Rao",
    role: "Senior React Engineer",
    when: "2026-10-10 11:00",
    panel: "Ram Krishnan",
    type: "Technical",
    feedbackStatus: "Submitted",
    score: 4,
    feedback: "Solid system design; lean yes.",
  },
];

export const OFFERS: OfferRecord[] = [
  {
    id: "off-1",
    candidateId: "cand-2",
    candidateName: "Lucas Meyer",
    requisitionId: "JOB-218",
    role: "HR Business Partner",
    status: "Preparing",
    grade: "L5",
    baseSalary: 72000,
    currency: "GBP",
    startDate: "2026-12-01",
    packageNote: "London hybrid · relocation support TBD",
    createdBy: "Sophie Clark",
    createdById: "demo-recruiter",
    approvals: [],
  },
  {
    id: "off-2",
    candidateId: "cand-7",
    candidateName: "Riya Kapoor",
    requisitionId: "JOB-221",
    role: "Senior React Engineer",
    status: "Accepted",
    grade: "L5",
    baseSalary: 2400000,
    currency: "INR",
    startDate: "2026-10-06",
    packageNote: "Bengaluru hybrid",
    createdBy: "Sophie Clark",
    createdById: "demo-recruiter",
    approvals: [{ role: "Line", ...JORDAN, on: "2026-09-18" }],
    sentOn: "2026-09-20",
    responseNote: "Signed offer letter returned by email.",
    responseRecordedBy: "Sophie Clark",
    respondedOn: "2026-09-22",
  },
  {
    id: "off-3",
    candidateId: "cand-9",
    candidateName: "Noah Garcia",
    requisitionId: "JOB-226",
    role: "Product Designer",
    status: "Accepted",
    grade: "L6",
    baseSalary: 170000,
    currency: "USD",
    startDate: "2026-10-13",
    packageNote: "San Francisco office",
    createdBy: "Sophie Clark",
    createdById: "demo-recruiter",
    approvals: [{ role: "Line", ...JORDAN, on: "2026-09-10" }],
    sentOn: "2026-09-12",
    responseNote: "Signed through the e-sign portal.",
    responseRecordedBy: "Sophie Clark",
    respondedOn: "2026-09-15",
  },
  {
    id: "off-4",
    candidateId: "cand-10",
    candidateName: "Amira Hassan",
    requisitionId: "JOB-224",
    role: "Customer Success Associate",
    status: "Accepted",
    grade: "L4",
    baseSalary: 120000,
    currency: "AED",
    startDate: "2026-10-27",
    packageNote: "Dubai office · no UAE band yet, so Compensation approved",
    createdBy: "Sophie Clark",
    createdById: "demo-recruiter",
    approvals: [
      { role: "Line", ...JORDAN, on: "2026-09-25" },
      { role: "Compensation", by: "Helen Brooks", byId: "demo-compensation", on: "2026-09-26" },
    ],
    sentOn: "2026-09-27",
    responseNote: "Accepted by phone; signed copy received by email.",
    responseRecordedBy: "Sophie Clark",
    respondedOn: "2026-09-30",
  },
];

export const ONBOARDING_JOINERS: OnboardingJoiner[] = [
  {
    id: "ob-1",
    name: "Riya Kapoor",
    role: "Senior React Engineer",
    startDate: "2026-10-06",
    country: "India",
    manager: "Ram Krishnan",
    managerId: "emp-ram",
    candidateId: "cand-7",
    requisitionId: "JOB-221",
    preboardingPct: 100,
    docsStatus: "Verified",
    policyAck: "Complete",
    overallStatus: "In progress",
  },
  {
    id: "ob-2",
    name: "Noah Garcia",
    role: "Product Designer",
    startDate: "2026-10-13",
    country: "United States",
    manager: "Daniel Ortiz",
    managerId: "demo-hiring-manager",
    candidateId: "cand-9",
    requisitionId: "JOB-226",
    preboardingPct: 70,
    docsStatus: "Submitted",
    policyAck: "Pending",
    overallStatus: "Pre-boarding",
  },
  {
    id: "ob-3",
    name: "Amira Hassan",
    role: "Customer Success Associate",
    startDate: "2026-10-27",
    country: "United Arab Emirates",
    manager: "Farhan Ali",
    managerId: "demo-hr-admin",
    candidateId: "cand-10",
    requisitionId: "JOB-224",
    preboardingPct: 40,
    docsStatus: "In progress",
    policyAck: "Pending",
    overallStatus: "Pre-boarding",
  },
];

/** Checklist created for every new hire; due dates are days relative to the start date. */
export const ONBOARDING_TEMPLATE: { title: string; owner: OnboardingTask["owner"]; category: OnboardingTask["category"]; dueOffset: number }[] = [
  { title: "Verify identity & tax docs", owner: "HR", category: "Documents", dueOffset: -5 },
  { title: "Laptop & peripherals", owner: "IT", category: "Equipment", dueOffset: -3 },
  { title: "Email and system accounts", owner: "IT", category: "Accounts", dueOffset: 0 },
  { title: "Team orientation", owner: "Manager", category: "Orientation", dueOffset: 1 },
  { title: "Mandatory security training", owner: "Employee", category: "Training", dueOffset: 14 },
  { title: "Acknowledge Code of Conduct", owner: "Employee", category: "Policy", dueOffset: 1 },
];

export const ONBOARDING_TASKS: OnboardingTask[] = [
  { id: "ot-1", joinerId: "ob-1", title: "Verify identity & tax docs", owner: "HR", category: "Documents", status: "Done", due: "2026-10-01" },
  { id: "ot-2", joinerId: "ob-1", title: "Laptop & peripherals", owner: "IT", category: "Equipment", status: "Done", due: "2026-10-03" },
  { id: "ot-3", joinerId: "ob-1", title: "SSO / email / Slack", owner: "IT", category: "Accounts", status: "In progress", due: "2026-10-06" },
  { id: "ot-4", joinerId: "ob-1", title: "Team orientation", owner: "Manager", category: "Orientation", status: "Pending", due: "2026-10-07" },
  { id: "ot-5", joinerId: "ob-1", title: "Mandatory security training", owner: "Employee", category: "Training", status: "Pending", due: "2026-10-20" },
  { id: "ot-6", joinerId: "ob-1", title: "Acknowledge Code of Conduct", owner: "Employee", category: "Policy", status: "Done", due: "2026-10-05" },
  { id: "ot-7", joinerId: "ob-2", title: "Collect I-9 / tax forms", owner: "HR", category: "Documents", status: "In progress", due: "2026-10-10" },
  { id: "ot-8", joinerId: "ob-2", title: "MacBook provision", owner: "IT", category: "Equipment", status: "Pending", due: "2026-10-12" },
  { id: "ot-9", joinerId: "ob-2", title: "Okta + Google Workspace", owner: "IT", category: "Accounts", status: "Pending", due: "2026-10-13" },
  { id: "ot-10", joinerId: "ob-2", title: "Buddy introduction", owner: "Manager", category: "Orientation", status: "Pending", due: "2026-10-13" },
  { id: "ot-11", joinerId: "ob-2", title: "Policy acknowledgements", owner: "Employee", category: "Policy", status: "Pending", due: "2026-10-15" },
  { id: "ot-12", joinerId: "ob-3", title: "Pre-boarding data form", owner: "Employee", category: "Documents", status: "In progress", due: "2026-10-20" },
  { id: "ot-13", joinerId: "ob-3", title: "Visa / work docs check", owner: "HR", category: "Documents", status: "Pending", due: "2026-10-22" },
  { id: "ot-14", joinerId: "ob-3", title: "Account provisioning", owner: "IT", category: "Accounts", status: "Pending", due: "2026-10-26" },
];

export const PERF_CYCLES: PerfCycle[] = [
  { id: "cyc-h2", name: "H2 2026 review", status: "Active", start: "2026-07-01", end: "2026-10-31" },
  { id: "cyc-y26", name: "FY2026 annual review", status: "Planning", start: "2026-11-01", end: "2027-02-28" },
];

const H2 = "Jul–Oct 2026";

export const PERF_GOALS: PerfGoal[] = [
  { id: "g1", ownerId: "emp-mahesh", ownerName: "Babu Menon", type: "Goal", title: "Ship timesheet calendar UX", target: "Live for all users", weight: 40, period: H2, progress: 70, cycleId: "cyc-h2" },
  { id: "g2", ownerId: "emp-mahesh", ownerName: "Babu Menon", type: "OKR", title: "Reduce PR cycle time", target: "−20%", weight: 30, period: H2, progress: 55, cycleId: "cyc-h2" },
  { id: "g3", ownerId: "emp-mahesh", ownerName: "Babu Menon", type: "KPI", title: "Sprint predictability", target: "≥ 85%", weight: 30, period: H2, progress: 82, cycleId: "cyc-h2" },
  { id: "g4", ownerId: "emp-ram", ownerName: "Ram Krishnan", type: "OKR", title: "Team delivery on roadmap", target: "90% of committed items", weight: 60, period: H2, progress: 68, cycleId: "cyc-h2" },
  { id: "g6", ownerId: "emp-ram", ownerName: "Ram Krishnan", type: "Goal", title: "Hire two senior engineers", target: "2 hires", weight: 40, period: H2, progress: 50, cycleId: "cyc-h2" },
  { id: "g5", ownerId: "emp-priya", ownerName: "Priya Nair", type: "KPI", title: "Team mandatory learning", target: "≥ 80% complete", weight: 100, period: H2, progress: 74, cycleId: "cyc-h2" },
  { id: "g7", ownerId: "emp-anu", ownerName: "Anu Rao", type: "Goal", title: "Prepare H2 calibration packs", target: "All packs ready", weight: 100, period: H2, progress: 60, cycleId: "cyc-h2" },
  { id: "g8", ownerId: "emp-kabir", ownerName: "Kabir Sharma", type: "OKR", title: "Cut API p95 latency", target: "< 300 ms", weight: 100, period: H2, progress: 45, cycleId: "cyc-h2" },
  { id: "g9", ownerId: "emp-diya", ownerName: "Diya Patel", type: "KPI", title: "Automate regression suite", target: "≥ 70% of cases", weight: 100, period: H2, progress: 65, cycleId: "cyc-h2" },
];

function review(id: string, employeeId: string, employeeName: string, extra: Partial<PerfReview> = {}): PerfReview {
  return {
    id,
    employeeId,
    employeeName,
    cycleId: "cyc-h2",
    selfStatus: "Not started",
    managerStatus: "Not started",
    feedback360Status: "Not started",
    finalDecisionNote: "",
    ...extra,
  };
}

/** Everyone with a manager is in the cycle. The CEO has no one above him, so he has no review. */
export const PERF_REVIEWS: PerfReview[] = [
  review("rev-1", "emp-mahesh", "Babu Menon", {
    selfStatus: "Submitted",
    selfText: "Shipped the timesheet calendar and cut PR cycle time. Want to grow in system design.",
    managerStatus: "Draft",
    managerText: "Strong delivery this half.",
    feedback360Status: "In progress",
    developmentPlan: "Expand system design mentoring.",
  }),
  review("rev-2", "emp-priya", "Priya Nair", { selfStatus: "Draft", selfText: "Ran the mandatory learning push for the team." }),
  review("rev-3", "emp-anu", "Anu Rao", {
    selfStatus: "Submitted",
    selfText: "Prepared calibration packs and coached two new reviewers.",
    managerStatus: "Submitted",
    managerText: "Reliable and well organised. Ready for more scope.",
    feedback360Status: "Complete",
    rating: "Strong",
    developmentPlan: "Lead calibration facilitation for eng orgs.",
  }),
  review("rev-4", "emp-kabir", "Kabir Sharma"),
  review("rev-5", "emp-diya", "Diya Patel"),
  review("rev-6", "emp-ram", "Ram Krishnan", { selfStatus: "Draft" }),
  review("rev-7", "demo-hr-admin", "Farhan Ali"),
  review("rev-8", "demo-recruiter", "Sophie Clark"),
  review("rev-9", "demo-compensation", "Helen Brooks"),
  review("rev-10", "demo-hiring-manager", "Daniel Ortiz"),
  review("rev-11", "demo-admin", "Alex Morgan"),
];

export const COURSES: Course[] = [
  { id: "crs-1", title: "Workplace safety", category: "Compliance", durationHours: 1, mandatory: true, audience: "All", skills: [] },
  { id: "crs-2", title: "Secure coding fundamentals", category: "Engineering", durationHours: 4, mandatory: true, audience: "Engineering", skills: ["sk-2", "sk-7"] },
  { id: "crs-3", title: "Manager essentials", category: "Leadership", durationHours: 6, mandatory: false, audience: "Managers", skills: ["sk-3"] },
  { id: "crs-4", title: "Inclusive hiring", category: "People", durationHours: 2, mandatory: false, audience: "Hiring", skills: ["sk-5"] },
  { id: "crs-5", title: "React performance patterns", category: "Engineering", durationHours: 3, mandatory: false, audience: "Engineering", skills: ["sk-1"] },
  { id: "crs-6", title: "Data privacy basics", category: "Compliance", durationHours: 1.5, mandatory: true, audience: "All", skills: [] },
  { id: "crs-7", title: "Cloud architecture foundations", category: "Engineering", durationHours: 5, mandatory: false, audience: "Engineering", skills: ["sk-4", "sk-7"] },
  { id: "crs-8", title: "Employee relations essentials", category: "People", durationHours: 3, mandatory: false, audience: "All", skills: ["sk-8"] },
  { id: "crs-9", title: "Reward and pay planning", category: "People", durationHours: 3, mandatory: false, audience: "All", skills: ["sk-9", "sk-6"] },
  { id: "crs-10", title: "Product strategy", category: "Product", durationHours: 4, mandatory: false, audience: "All", skills: ["sk-10", "sk-11"] },
  { id: "crs-11", title: "Leading leaders", category: "Leadership", durationHours: 6, mandatory: false, audience: "Managers", skills: ["sk-3", "sk-11"] },
  { id: "crs-12", title: "Platform operations", category: "IT", durationHours: 4, mandatory: false, audience: "All", skills: ["sk-12", "sk-4"] },
];

export const LEARNING_PATHS: LearningPath[] = [
  { id: "lp-1", title: "New hire compliance", courses: ["crs-1", "crs-6"], audience: "All new joiners" },
  { id: "lp-2", title: "Frontend craft", courses: ["crs-2", "crs-5"], audience: "Engineering" },
  { id: "lp-3", title: "People leader starter", courses: ["crs-3", "crs-4"], audience: "Managers" },
];

export const ENROLLMENTS: Enrollment[] = [
  { id: "en-1", courseId: "crs-1", employeeId: "emp-mahesh", employeeName: "Babu Menon", status: "Completed", progress: 100, completedOn: "2026-03-12" },
  { id: "en-2", courseId: "crs-2", employeeId: "emp-mahesh", employeeName: "Babu Menon", status: "In progress", progress: 45, due: "2026-10-31" },
  { id: "en-3", courseId: "crs-6", employeeId: "emp-mahesh", employeeName: "Babu Menon", status: "Assigned", progress: 0, due: "2026-11-15" },
  { id: "en-4", courseId: "crs-1", employeeId: "ob-1", employeeName: "Riya Kapoor", status: "Assigned", progress: 0, due: "2026-10-20" },
  { id: "en-5", courseId: "crs-4", employeeId: "demo-recruiter", employeeName: "Sophie Clark", status: "Completed", progress: 100, completedOn: "2026-05-02" },
  { id: "en-6", courseId: "crs-4", employeeId: "emp-ram", employeeName: "Ram Krishnan", status: "In progress", progress: 30, due: "2026-10-05" },
  { id: "en-7", courseId: "crs-1", employeeId: "emp-priya", employeeName: "Priya Nair", status: "Completed", progress: 100, completedOn: "2026-04-02" },
  { id: "en-8", courseId: "crs-6", employeeId: "emp-anu", employeeName: "Anu Rao", status: "In progress", progress: 90, due: "2026-11-15" },
  { id: "en-9", courseId: "crs-2", employeeId: "emp-kabir", employeeName: "Kabir Sharma", status: "Completed", progress: 100, completedOn: "2026-08-19" },
  { id: "en-10", courseId: "crs-1", employeeId: "emp-diya", employeeName: "Diya Patel", status: "Assigned", progress: 0, due: "2026-11-30" },
];

export const CERTIFICATIONS: Certification[] = [
  { id: "cert-1", employeeId: "emp-mahesh", employeeName: "Babu Menon", name: "Professional Scrum Master", issuer: "Scrum.org", earnedOn: "2023-06-01", verifiedBy: "Farhan Ali", verifiedOn: "2023-06-12" },
  { id: "cert-2", employeeId: "emp-priya", employeeName: "Priya Nair", name: "ATD Master Trainer", issuer: "ATD", earnedOn: "2024-11-18", expiresOn: "2027-11-18", validityYears: 3 },
  { id: "cert-3", employeeId: "emp-mahesh", employeeName: "Babu Menon", name: "AWS Certified Developer – Associate", issuer: "Amazon Web Services", earnedOn: "2023-11-20", expiresOn: "2026-11-20", validityYears: 3, verifiedBy: "Farhan Ali", verifiedOn: "2023-12-01" },
  { id: "cert-4", employeeId: "emp-ram", employeeName: "Ram Krishnan", name: "First Aid at Work", issuer: "St John Ambulance", earnedOn: "2023-09-01", expiresOn: "2026-09-01", validityYears: 3, verifiedBy: "Farhan Ali", verifiedOn: "2023-09-10" },
  { id: "cert-5", employeeId: "demo-recruiter", employeeName: "Sophie Clark", name: "Certified Diversity Recruiter", issuer: "AIRS", earnedOn: "2025-02-10", expiresOn: "2028-02-10", validityYears: 3 },
];

export const FEEDBACK_ITEMS: FeedbackItem[] = [
  {
    id: "fb-1",
    kind: "Praise",
    fromId: "emp-ram",
    fromName: "Ram Krishnan",
    toId: "emp-mahesh",
    toName: "Babu Menon",
    badge: "Ownership",
    message: "Took the timesheet calendar from idea to release in two sprints and handled every review comment quickly.",
    createdOn: "2026-10-09",
  },
  {
    id: "fb-2",
    kind: "Praise",
    fromId: "emp-mahesh",
    fromName: "Babu Menon",
    toId: "demo-recruiter",
    toName: "Sophie Clark",
    badge: "Teamwork",
    message: "Thanks for lining up the frontend interview panel at short notice.",
    createdOn: "2026-10-02",
  },
  {
    id: "fb-3",
    kind: "Feedback",
    fromId: "emp-ram",
    fromName: "Ram Krishnan",
    toId: "emp-mahesh",
    toName: "Babu Menon",
    message: "Great demo on Friday. Next time, share the agenda a day earlier so product can prepare questions.",
    createdOn: "2026-10-11",
  },
  {
    id: "fb-4",
    kind: "Request",
    fromId: "emp-ram",
    fromName: "Ram Krishnan",
    toId: "emp-mahesh",
    toName: "Babu Menon",
    aboutName: "Ram Krishnan",
    message: "How can I make our sprint planning more useful for you?",
    createdOn: "2026-10-13",
    status: "Open",
  },
];

export const ONE_ON_ONES: OneOnOne[] = [
  {
    id: "oo-1",
    managerId: "emp-ram",
    managerName: "Ram Krishnan",
    employeeId: "emp-mahesh",
    employeeName: "Babu Menon",
    date: "2026-11-03",
    time: "11:00",
    status: "Upcoming",
    agenda: [
      { id: "oo-1-a1", text: "Progress on PR cycle time OKR", done: false },
      { id: "oo-1-a2", text: "System design mentoring plan", done: false },
    ],
    actionItems: [{ id: "oo-1-x1", text: "Babu to draft reviewer rotation proposal", done: false }],
    notes: "",
  },
  {
    id: "oo-2",
    managerId: "emp-ram",
    managerName: "Ram Krishnan",
    employeeId: "emp-mahesh",
    employeeName: "Babu Menon",
    date: "2026-10-06",
    time: "11:00",
    status: "Completed",
    agenda: [
      { id: "oo-2-a1", text: "Mid-year self-assessment", done: true },
      { id: "oo-2-a2", text: "Secure coding course timeline", done: true },
    ],
    actionItems: [
      { id: "oo-2-x1", text: "Submit self-assessment", done: true },
      { id: "oo-2-x2", text: "Finish secure coding module 2", done: false },
    ],
    notes: "Self-assessment looks good. Agreed to finish secure coding before month end.",
  },
];

const LEVELS = ["Awareness", "Working", "Intermediate", "Advanced", "Expert"];

export const SKILL_LIBRARY: SkillDef[] = [
  { id: "sk-1", name: "React", category: "Engineering", levels: LEVELS },
  { id: "sk-2", name: "TypeScript", category: "Engineering", levels: LEVELS },
  { id: "sk-3", name: "People leadership", category: "Leadership", levels: LEVELS },
  { id: "sk-4", name: "Cloud architecture", category: "Engineering", levels: LEVELS },
  { id: "sk-5", name: "Recruiting", category: "People", levels: LEVELS },
  { id: "sk-6", name: "Financial analysis", category: "Finance", levels: LEVELS },
  { id: "sk-7", name: "System design", category: "Engineering", levels: LEVELS },
  { id: "sk-8", name: "Employee relations", category: "People", levels: LEVELS },
  { id: "sk-9", name: "Reward and pay", category: "People", levels: LEVELS },
  { id: "sk-10", name: "Product management", category: "Product", levels: LEVELS },
  { id: "sk-11", name: "Business strategy", category: "Leadership", levels: LEVELS },
  { id: "sk-12", name: "Platform administration", category: "IT", levels: LEVELS },
];

export type SkillTrack = "engineering" | "people" | "recruiting" | "reward" | "product" | "it" | "executive";

export interface TargetRole {
  id: string;
  title: string;
  track: SkillTrack;
  required: Record<string, string>;
}

export const TARGET_ROLES: TargetRole[] = [
  { id: "tr-1", title: "Senior Engineer", track: "engineering", required: { "sk-1": "Advanced", "sk-2": "Advanced", "sk-7": "Intermediate" } },
  { id: "tr-2", title: "Tech Lead", track: "engineering", required: { "sk-1": "Advanced", "sk-3": "Intermediate", "sk-7": "Advanced" } },
  { id: "tr-3", title: "Engineering Manager", track: "engineering", required: { "sk-3": "Advanced", "sk-7": "Intermediate", "sk-4": "Working" } },
  { id: "tr-4", title: "Director of Engineering", track: "engineering", required: { "sk-3": "Expert", "sk-11": "Advanced", "sk-4": "Intermediate" } },
  { id: "tr-5", title: "Chief People Officer", track: "people", required: { "sk-8": "Expert", "sk-3": "Expert", "sk-11": "Advanced" } },
  { id: "tr-6", title: "Talent Acquisition Manager", track: "recruiting", required: { "sk-5": "Expert", "sk-3": "Intermediate", "sk-8": "Working" } },
  { id: "tr-7", title: "HR Business Partner", track: "recruiting", required: { "sk-8": "Advanced", "sk-5": "Intermediate", "sk-9": "Working" } },
  { id: "tr-8", title: "Head of Total Rewards", track: "reward", required: { "sk-9": "Expert", "sk-6": "Advanced", "sk-3": "Intermediate" } },
  { id: "tr-9", title: "VP Product", track: "product", required: { "sk-10": "Expert", "sk-11": "Advanced", "sk-3": "Advanced" } },
  { id: "tr-10", title: "IT Manager", track: "it", required: { "sk-12": "Expert", "sk-4": "Advanced", "sk-3": "Intermediate" } },
];

const skill = (skillId: string, level: string, targetLevel: string): EmployeeSkill => ({
  skillId,
  skillName: SKILL_LIBRARY.find((s) => s.id === skillId)?.name ?? skillId,
  level,
  targetLevel,
});

/** Starter profile per person until they edit it. */
const STARTER_SKILLS: Record<string, { track: SkillTrack; skills: EmployeeSkill[] }> = {
  "emp-mahesh": { track: "engineering", skills: [skill("sk-1", "Advanced", "Expert"), skill("sk-2", "Intermediate", "Advanced"), skill("sk-7", "Intermediate", "Advanced"), skill("sk-4", "Working", "Intermediate")] },
  "emp-ram": { track: "engineering", skills: [skill("sk-3", "Advanced", "Expert"), skill("sk-7", "Advanced", "Expert"), skill("sk-1", "Intermediate", "Intermediate"), skill("sk-4", "Working", "Intermediate"), skill("sk-11", "Working", "Advanced")] },
  "demo-hr-admin": { track: "people", skills: [skill("sk-8", "Expert", "Expert"), skill("sk-3", "Advanced", "Expert"), skill("sk-5", "Intermediate", "Intermediate"), skill("sk-9", "Working", "Intermediate"), skill("sk-11", "Intermediate", "Advanced")] },
  "demo-recruiter": { track: "recruiting", skills: [skill("sk-5", "Advanced", "Expert"), skill("sk-8", "Working", "Intermediate"), skill("sk-3", "Awareness", "Intermediate")] },
  "demo-compensation": { track: "reward", skills: [skill("sk-9", "Advanced", "Expert"), skill("sk-6", "Intermediate", "Advanced"), skill("sk-8", "Working", "Intermediate"), skill("sk-3", "Working", "Intermediate")] },
  "demo-hiring-manager": { track: "product", skills: [skill("sk-10", "Advanced", "Expert"), skill("sk-3", "Advanced", "Advanced"), skill("sk-11", "Intermediate", "Advanced"), skill("sk-5", "Working", "Working")] },
  "demo-ceo": { track: "executive", skills: [skill("sk-11", "Expert", "Expert"), skill("sk-3", "Expert", "Expert"), skill("sk-6", "Advanced", "Advanced"), skill("sk-10", "Advanced", "Advanced")] },
  "demo-admin": { track: "it", skills: [skill("sk-12", "Advanced", "Expert"), skill("sk-4", "Intermediate", "Advanced"), skill("sk-7", "Working", "Intermediate")] },
  "emp-priya": { track: "engineering", skills: [skill("sk-3", "Working", "Intermediate"), skill("sk-8", "Intermediate", "Advanced"), skill("sk-2", "Working", "Intermediate")] },
  "emp-anu": { track: "engineering", skills: [skill("sk-3", "Intermediate", "Advanced"), skill("sk-7", "Working", "Intermediate"), skill("sk-2", "Working", "Intermediate")] },
  "emp-kabir": { track: "engineering", skills: [skill("sk-7", "Advanced", "Expert"), skill("sk-4", "Advanced", "Expert"), skill("sk-2", "Advanced", "Advanced"), skill("sk-1", "Intermediate", "Advanced")] },
  "emp-diya": { track: "engineering", skills: [skill("sk-2", "Intermediate", "Advanced"), skill("sk-1", "Working", "Intermediate"), skill("sk-7", "Awareness", "Working")] },
};

/** Starter skills and career track for a person (engineering profile when unknown). */
export function starterSkillsFor(employeeId: string): { track: SkillTrack; skills: EmployeeSkill[] } {
  return STARTER_SKILLS[employeeId] ?? { track: "engineering", skills: [skill("sk-2", "Working", "Intermediate"), skill("sk-7", "Awareness", "Working")] };
}

export const LEVEL_RANK: Record<string, number> = {
  Awareness: 1,
  Working: 2,
  Intermediate: 3,
  Advanced: 4,
  Expert: 5,
};

export const AI_GUARDRAIL =
  "AI may suggest drafts only. Hiring advances, offer decisions, performance ratings, and final employment outcomes require an explicit human action.";
