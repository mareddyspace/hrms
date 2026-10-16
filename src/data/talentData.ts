/** Shared Infotech talent modules mock data — recruiting through skills. */

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

export interface Requisition {
  id: string;
  title: string;
  department: string;
  country: string;
  location: string;
  openings: number;
  hiringManager: string;
  recruiter: string;
  approvalStatus: ApprovalStatus;
  stageSummary: string;
  created: string;
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

export interface OfferRecord {
  id: string;
  candidateId: string;
  candidateName: string;
  role: string;
  status: "Preparing" | "Sent" | "Accepted" | "Declined" | "Withdrawn";
  packageNote: string;
  sentOn?: string;
}

export interface OnboardingJoiner {
  id: string;
  name: string;
  role: string;
  startDate: string;
  country: string;
  manager: string;
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
}

export interface PerfGoal {
  id: string;
  ownerId: string;
  ownerName: string;
  type: "Goal" | "OKR" | "KPI";
  title: string;
  progress: number;
  cycleId: string;
}

export interface PerfCycle {
  id: string;
  name: string;
  status: "Planning" | "Active" | "Calibration" | "Closed";
  start: string;
  end: string;
  completionPct: number;
}

export interface PerfReview {
  id: string;
  employeeId: string;
  employeeName: string;
  cycleId: string;
  selfStatus: "Not started" | "Draft" | "Submitted";
  managerStatus: "Not started" | "Draft" | "Submitted";
  feedback360Status: "Not started" | "In progress" | "Complete";
  rating?: string;
  developmentPlan?: string;
  finalDecisionNote: string;
}

export interface Course {
  id: string;
  title: string;
  category: string;
  durationHours: number;
  mandatory: boolean;
  level: string;
}

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

export const REQUISITIONS: Requisition[] = [
  {
    id: "JOB-221",
    title: "Senior React Engineer",
    department: "Engineering",
    country: "India",
    location: "Bengaluru",
    openings: 3,
    hiringManager: "Daniel Ortiz",
    recruiter: "Sophie Clark",
    approvalStatus: "Approved",
    stageSummary: "Interviewing",
    created: "2026-08-12",
  },
  {
    id: "JOB-218",
    title: "HR Business Partner",
    department: "People",
    country: "United Kingdom",
    location: "London",
    openings: 1,
    hiringManager: "Farhan Ali",
    recruiter: "Sophie Clark",
    approvalStatus: "Approved",
    stageSummary: "Offer",
    created: "2026-07-28",
  },
  {
    id: "JOB-210",
    title: "Talent Sourcer",
    department: "People",
    country: "United States",
    location: "New York",
    openings: 2,
    hiringManager: "Farhan Ali",
    recruiter: "Sophie Clark",
    approvalStatus: "Pending approval",
    stageSummary: "Screen",
    created: "2026-09-05",
  },
  {
    id: "JOB-205",
    title: "Finance Analyst",
    department: "Finance",
    country: "Canada",
    location: "Toronto",
    openings: 1,
    hiringManager: "Victor Lang",
    recruiter: "Sophie Clark",
    approvalStatus: "On hold",
    stageSummary: "On hold",
    created: "2026-06-18",
  },
  {
    id: "JOB-230",
    title: "Product Manager",
    department: "Product",
    country: "India",
    location: "Bengaluru",
    openings: 1,
    hiringManager: "Daniel Ortiz",
    recruiter: "Sophie Clark",
    approvalStatus: "Draft",
    stageSummary: "Draft",
    created: "2026-10-01",
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
    resumeNote: "EMEA HRBP background; offer pack in preparation.",
  },
  {
    id: "cand-3",
    name: "Mei Lin",
    email: "mei.lin@example.com",
    phone: "+1 415 xxx 0199",
    role: "Talent Sourcer",
    requisitionId: "JOB-210",
    stage: "Screening",
    country: "United States",
    source: "Referral",
    experienceYears: 4,
    skills: ["Boolean search", "ATS"],
    resumeNote: "High-volume tech sourcing experience.",
  },
  {
    id: "cand-4",
    name: "Jonas Weber",
    email: "jonas.weber@example.com",
    phone: "+49 30 xxx 4412",
    role: "Finance Analyst",
    requisitionId: "JOB-205",
    stage: "Interview",
    country: "Germany",
    source: "Careers site",
    experienceYears: 5,
    skills: ["FP&A", "Excel", "BI"],
    resumeNote: "Open to Toronto relocation; req currently on hold.",
  },
  {
    id: "cand-5",
    name: "Priya Desai",
    email: "priya.desai@example.com",
    phone: "+91 98xxx x3301",
    role: "Product Manager",
    requisitionId: "JOB-230",
    stage: "Applied",
    country: "India",
    source: "Careers site",
    experienceYears: 6,
    skills: ["Roadmapping", "Discovery", "Analytics"],
    resumeNote: "B2B SaaS PM; waiting on req approval.",
  },
  {
    id: "cand-6",
    name: "Noah Garcia",
    email: "noah.garcia@example.com",
    phone: "+1 628 xxx 7710",
    role: "Senior React Engineer",
    requisitionId: "JOB-221",
    stage: "Assessment",
    country: "United States",
    source: "LinkedIn",
    experienceYears: 8,
    skills: ["React", "Node", "System design"],
    resumeNote: "Completed take-home; panel review next.",
  },
  {
    id: "cand-7",
    name: "Isha Reddy",
    email: "isha.reddy@example.com",
    phone: "+91 98xxx x5520",
    role: "Senior React Engineer",
    requisitionId: "JOB-221",
    stage: "Hired",
    country: "India",
    source: "Referral",
    experienceYears: 5,
    skills: ["React", "Testing"],
    resumeNote: "Offer accepted — handoff to onboarding.",
  },
  {
    id: "cand-8",
    name: "Tom Hughes",
    email: "elena.volkov@example.com",
    phone: "+44 20 xxx 2210",
    role: "HR Business Partner",
    requisitionId: "JOB-218",
    stage: "Final Review",
    country: "United Kingdom",
    source: "LinkedIn",
    experienceYears: 8,
    skills: ["HRBP", "Change management"],
    resumeNote: "Final panel complete; HM decision pending.",
  },
];

export const INTERVIEWS: Interview[] = [
  {
    id: "int-1",
    candidateId: "cand-4",
    candidateName: "Jonas Weber",
    role: "Finance Analyst",
    when: "2026-10-14 14:00",
    panel: "Victor Lang",
    type: "Hiring manager",
    feedbackStatus: "Pending",
  },
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
    when: "2026-10-17 16:00",
    panel: "Daniel Ortiz · Sophie Clark",
    type: "HM + Recruiter",
    feedbackStatus: "Pending",
  },
  {
    id: "int-4",
    candidateId: "cand-6",
    candidateName: "Noah Garcia",
    role: "Senior React Engineer",
    when: "2026-10-10 11:00",
    panel: "Ram Krishnan",
    type: "Technical",
    feedbackStatus: "Submitted",
    score: 4,
    feedback: "Solid system design; hire lean-yes. Human decision still required.",
  },
];

export const OFFERS: OfferRecord[] = [
  {
    id: "off-1",
    candidateId: "cand-2",
    candidateName: "Lucas Meyer",
    role: "HR Business Partner",
    status: "Preparing",
    packageNote: "L5 London band · relocation support TBD",
  },
  {
    id: "off-2",
    candidateId: "cand-7",
    candidateName: "Isha Reddy",
    role: "Senior React Engineer",
    status: "Accepted",
    packageNote: "L5 Bengaluru · start 06 Oct",
    sentOn: "2026-09-20",
  },
];

export const ONBOARDING_JOINERS: OnboardingJoiner[] = [
  {
    id: "ob-1",
    name: "Isha Reddy",
    role: "Software Engineer",
    startDate: "2026-10-06",
    country: "India",
    manager: "Ram Krishnan",
    preboardingPct: 100,
    docsStatus: "Verified",
    policyAck: "Complete",
    overallStatus: "In progress",
  },
  {
    id: "ob-2",
    name: "Noah Garcia",
    role: "Designer",
    startDate: "2026-10-13",
    country: "United States",
    manager: "Daniel Ortiz",
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
    preboardingPct: 40,
    docsStatus: "In progress",
    policyAck: "Pending",
    overallStatus: "Pre-boarding",
  },
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
  {
    id: "cyc-h2",
    name: "H2 2026 Mid-year",
    status: "Active",
    start: "2026-07-01",
    end: "2026-10-31",
    completionPct: 61,
  },
  {
    id: "cyc-y26",
    name: "FY2026 Annual",
    status: "Planning",
    start: "2026-11-01",
    end: "2027-02-28",
    completionPct: 8,
  },
];

export const PERF_GOALS: PerfGoal[] = [
  { id: "g1", ownerId: "emp-mahesh", ownerName: "Babu Menon", type: "Goal", title: "Ship timesheet calendar UX", progress: 70, cycleId: "cyc-h2" },
  { id: "g2", ownerId: "emp-mahesh", ownerName: "Babu Menon", type: "OKR", title: "Reduce PR cycle time by 20%", progress: 55, cycleId: "cyc-h2" },
  { id: "g3", ownerId: "emp-mahesh", ownerName: "Babu Menon", type: "KPI", title: "Sprint predictability ≥ 85%", progress: 82, cycleId: "cyc-h2" },
  { id: "g4", ownerId: "emp-ram", ownerName: "Ram Krishnan", type: "OKR", title: "Team delivery on roadmap", progress: 68, cycleId: "cyc-h2" },
  { id: "g5", ownerId: "demo-learning", ownerName: "Priya Nair", type: "Goal", title: "Mandatory learning ≥ 80%", progress: 74, cycleId: "cyc-h2" },
];

export const PERF_REVIEWS: PerfReview[] = [
  {
    id: "rev-1",
    employeeId: "emp-mahesh",
    employeeName: "Babu Menon",
    cycleId: "cyc-h2",
    selfStatus: "Submitted",
    managerStatus: "Draft",
    feedback360Status: "In progress",
    rating: undefined,
    developmentPlan: "Expand system design mentoring.",
    finalDecisionNote: "Final rating requires manager + calibration — not auto-decided by AI.",
  },
  {
    id: "rev-2",
    employeeId: "demo-learning",
    employeeName: "Priya Nair",
    cycleId: "cyc-h2",
    selfStatus: "Draft",
    managerStatus: "Not started",
    feedback360Status: "Not started",
    finalDecisionNote: "Human reviewers own the outcome.",
  },
  {
    id: "rev-3",
    employeeId: "demo-performance",
    employeeName: "Anu Rao",
    cycleId: "cyc-h2",
    selfStatus: "Submitted",
    managerStatus: "Submitted",
    feedback360Status: "Complete",
    rating: "Strong",
    developmentPlan: "Lead calibration facilitation for eng orgs.",
    finalDecisionNote: "Rating set by manager; locked pending calibration.",
  },
];

export const COURSES: Course[] = [
  { id: "crs-1", title: "Workplace safety", category: "Compliance", durationHours: 1, mandatory: true, level: "All" },
  { id: "crs-2", title: "Secure coding fundamentals", category: "Engineering", durationHours: 4, mandatory: true, level: "Engineering" },
  { id: "crs-3", title: "Manager essentials", category: "Leadership", durationHours: 6, mandatory: false, level: "Managers" },
  { id: "crs-4", title: "Inclusive hiring", category: "People", durationHours: 2, mandatory: true, level: "Hiring" },
  { id: "crs-5", title: "React performance patterns", category: "Engineering", durationHours: 3, mandatory: false, level: "Engineering" },
  { id: "crs-6", title: "Data privacy basics", category: "Compliance", durationHours: 1.5, mandatory: true, level: "All" },
];

export const LEARNING_PATHS: LearningPath[] = [
  { id: "lp-1", title: "New hire compliance", courses: ["crs-1", "crs-6"], audience: "All new joiners" },
  { id: "lp-2", title: "Frontend craft", courses: ["crs-2", "crs-5"], audience: "Engineering" },
  { id: "lp-3", title: "People leader starter", courses: ["crs-3", "crs-4"], audience: "Managers & recruiters" },
];

export const ENROLLMENTS: Enrollment[] = [
  { id: "en-1", courseId: "crs-1", employeeId: "emp-mahesh", employeeName: "Babu Menon", status: "Completed", progress: 100, completedOn: "2026-03-12" },
  { id: "en-2", courseId: "crs-2", employeeId: "emp-mahesh", employeeName: "Babu Menon", status: "In progress", progress: 45, due: "2026-10-31" },
  { id: "en-3", courseId: "crs-6", employeeId: "emp-mahesh", employeeName: "Babu Menon", status: "Assigned", progress: 0, due: "2026-11-15" },
  { id: "en-4", courseId: "crs-1", employeeId: "ob-1", employeeName: "Isha Reddy", status: "Assigned", progress: 0, due: "2026-10-20" },
  { id: "en-5", courseId: "crs-4", employeeId: "demo-recruiter", employeeName: "Sophie Clark", status: "Completed", progress: 100, completedOn: "2026-05-02" },
  { id: "en-6", courseId: "crs-4", employeeId: "emp-ram", employeeName: "Ram Krishnan", status: "In progress", progress: 30, due: "2026-10-05" },
];

export const CERTIFICATIONS: Certification[] = [
  { id: "cert-1", employeeId: "emp-mahesh", employeeName: "Babu Menon", name: "Professional Scrum Master", issuer: "Scrum.org", earnedOn: "2023-06-01" },
  { id: "cert-2", employeeId: "demo-learning", employeeName: "Priya Nair", name: "ATD Master Trainer", issuer: "ATD", earnedOn: "2024-11-18", expiresOn: "2027-11-18", validityYears: 3 },
  { id: "cert-3", employeeId: "emp-mahesh", employeeName: "Babu Menon", name: "AWS Certified Developer – Associate", issuer: "Amazon Web Services", earnedOn: "2023-11-20", expiresOn: "2026-11-20", validityYears: 3 },
  { id: "cert-4", employeeId: "emp-ram", employeeName: "Ram Krishnan", name: "First Aid at Work", issuer: "St John Ambulance", earnedOn: "2023-09-01", expiresOn: "2026-09-01", validityYears: 3 },
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
    date: "2026-10-20",
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

export const SKILL_LIBRARY: SkillDef[] = [
  { id: "sk-1", name: "React", category: "Engineering", levels: ["Awareness", "Working", "Intermediate", "Advanced", "Expert"] },
  { id: "sk-2", name: "TypeScript", category: "Engineering", levels: ["Awareness", "Working", "Intermediate", "Advanced", "Expert"] },
  { id: "sk-3", name: "People leadership", category: "Leadership", levels: ["Awareness", "Working", "Intermediate", "Advanced", "Expert"] },
  { id: "sk-4", name: "Cloud architecture", category: "Engineering", levels: ["Awareness", "Working", "Intermediate", "Advanced", "Expert"] },
  { id: "sk-5", name: "Recruiting", category: "People", levels: ["Awareness", "Working", "Intermediate", "Advanced", "Expert"] },
  { id: "sk-6", name: "Financial analysis", category: "Finance", levels: ["Awareness", "Working", "Intermediate", "Advanced", "Expert"] },
  { id: "sk-7", name: "System design", category: "Engineering", levels: ["Awareness", "Working", "Intermediate", "Advanced", "Expert"] },
];

export const TARGET_ROLES = [
  { id: "tr-1", title: "Senior Engineer", required: { "sk-1": "Advanced", "sk-2": "Advanced", "sk-7": "Intermediate" } },
  { id: "tr-2", title: "Tech Lead", required: { "sk-1": "Advanced", "sk-3": "Intermediate", "sk-7": "Advanced" } },
  { id: "tr-3", title: "Engineering Manager", required: { "sk-3": "Advanced", "sk-7": "Intermediate", "sk-4": "Working" } },
];

export const DEFAULT_EMPLOYEE_SKILLS: EmployeeSkill[] = [
  { skillId: "sk-1", skillName: "React", level: "Advanced", targetLevel: "Expert" },
  { skillId: "sk-2", skillName: "TypeScript", level: "Intermediate", targetLevel: "Advanced" },
  { skillId: "sk-3", skillName: "People leadership", level: "Working", targetLevel: "Intermediate" },
  { skillId: "sk-4", skillName: "Cloud architecture", level: "Working", targetLevel: "Intermediate" },
  { skillId: "sk-7", skillName: "System design", level: "Intermediate", targetLevel: "Advanced" },
];

export const LEVEL_RANK: Record<string, number> = {
  Awareness: 1,
  Working: 2,
  Intermediate: 3,
  Advanced: 4,
  Expert: 5,
};

export const AI_GUARDRAIL =
  "AI may suggest drafts only. Hiring advances, offer decisions, performance ratings, and final employment outcomes require an explicit human action in this prototype.";
