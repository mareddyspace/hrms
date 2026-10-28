/** Compensation, benefits, and documents & letters — fictional TimeZ demo data only. */

export const LEGAL_DISCLAIMER =
  "Official employment, tax and legal documents are issued by HR.";

export interface GradeBand {
  id: string;
  grade: string;
  family: string;
  country: string;
  currency: string;
  min: string;
  mid: string;
  max: string;
}

export interface CompHistoryRow {
  id: string;
  employeeId: string;
  employeeName: string;
  effective: string;
  event: string;
  grade: string;
  base: string;
  currency: string;
  managerId?: string;
}

export interface CompCycle {
  id: string;
  name: string;
  status: "Planning" | "Open" | "Manager review" | "Calibration" | "Closed";
  window: string;
  countries: string[];
  /** Cycles HR creates: when new pay takes effect, the budget and the proposal window. */
  effectiveDate?: string;
  budgetPct?: number;
  opensOn?: string;
  closesOn?: string;
  createdBy?: string;
  /** Backend mode: whether the cycle takes proposals today, and (HR) how much of the budget is used. */
  acceptingProposals?: boolean;
  budgetUsedPct?: number;
  proposalCount?: number;
}

export interface CompReviewItem {
  id: string;
  cycleId: string;
  employeeId: string;
  employeeName: string;
  managerId: string;
  managerName: string;
  currentGrade: string;
  proposedGrade: string;
  currentBase: string;
  proposedBase: string;
  proposedIncreasePct: number;
  currency: string;
  /**
   * Draft → Pending approval (someone above the employee in their line, not the proposer)
   * → Pending final approval (HR; for HR's own pay, their line manager) → Approved. Either step can reject.
   */
  status: "Draft" | "Pending approval" | "Pending final approval" | "Approved" | "Rejected";
  bonusProposal: string;
  /** First step: line approval. */
  lineApprover?: string;
  lineApprovedOn?: string;
  /** Final decision (approve or reject). */
  approver?: string;
  decidedOn?: string;
}

export interface BonusRecord {
  id: string;
  employeeId: string;
  employeeName: string;
  type: string;
  period: string;
  amount: string;
  currency: string;
  status: "Accrued" | "Paid" | "Forfeited";
}

export interface BenefitPlan {
  id: string;
  country: string;
  name: string;
  category: string;
  provider: string;
  summary: string;
  employeeCost: string;
  documents: string[];
  /** Statutory plans: enrollment is compulsory and can never be waived. */
  mandatory?: boolean;
  /** Everyone in the country is enrolled automatically (no request needed). */
  autoEnrolled?: boolean;
  /** The employee can add verified dependents to this plan. */
  coversDependents?: boolean;
  /** Who may join. Country is always the plan's own country. */
  eligibility?: PlanEligibility;
}

export interface PlanEligibility {
  /** Employment types that may not join, e.g. "Contract". */
  excludeEmploymentTypes?: string[];
  minServiceMonths?: number;
  /** When set, only these grades may join. */
  grades?: string[];
}

export interface BenefitEnrollment {
  id: string;
  employeeId: string;
  employeeName: string;
  planId: string;
  planName: string;
  country: string;
  status: "Eligible" | "Enrolled" | "Waived" | "Pending";
  effective: string;
  /** Requested with a life event rather than in open enrollment. */
  lifeEventId?: string;
}

/** An employee asks HR to change an enrolled plan; the enrollment itself stays as it is. */
export interface BenefitChangeRequest {
  id: string;
  enrollmentId: string;
  employeeId: string;
  employeeName: string;
  planName: string;
  note: string;
  status: "Pending" | "Done" | "Declined";
  requestedOn: string;
  decidedBy?: string;
  decidedOn?: string;
}

export interface Dependent {
  id: string;
  employeeId: string;
  name: string;
  relationship: string;
  coveredPlans: string[];
  dateOfBirth?: string;
  gender?: string;
  /** HR checks new and edited dependents before they can be covered. */
  verification?: "Pending" | "Verified" | "Rejected";
  verifiedBy?: string;
  verifiedOn?: string;
}

export const DEPENDENT_RELATIONSHIPS = ["Spouse", "Partner", "Child", "Parent", "Parent-in-law"];

export const LIFE_EVENT_TYPES = ["Marriage", "Birth or adoption", "Divorce", "Death of a dependent", "Spouse lost coverage"];

/** A life event opens a 30-day window to change benefits outside open enrollment. */
export interface LifeEvent {
  id: string;
  employeeId: string;
  employeeName: string;
  type: string;
  eventDate: string;
  raisedOn: string;
  windowEnds: string;
  status: "Open" | "Closed";
  closedBy?: string;
}

/** The annual open enrollment window. HR can open or close it early. */
export interface EnrollmentWindow {
  year: number;
  start: string;
  end: string;
  /** HR override: forced open or closed regardless of the dates. */
  override?: "open" | "closed";
  updatedBy?: string;
}

export const OPEN_ENROLLMENT_SEED: EnrollmentWindow = { year: 2027, start: "2026-10-15", end: "2026-11-15" };

export interface BenefitHistoryRow {
  id: string;
  employeeId: string;
  date: string;
  event: string;
  detail: string;
}

export type LetterType =
  | "Offer"
  | "Appointment"
  | "Employment"
  | "Promotion"
  | "Transfer"
  | "Salary revision"
  | "Experience"
  | "Relieving"
  | "Confirmation"
  | "NOC"
  | "Visa/Travel"
  | "Address proof"
  | "Internship"
  | "Warning"
  | "Termination";

export type LetterStatus = "Draft" | "Pending approval" | "Approved" | "Rejected" | "Issued" | "Cancelled";

/** Letters that must stay hidden from their subject until issued. */
export const SENSITIVE_LETTER_TYPES: LetterType[] = ["Salary revision", "Promotion", "Warning", "Termination"];

/** One generated, approved version of a letter. The markup is frozen at generation time. */
export interface IssuedLetter {
  docId: string;
  version: number;
  referenceNo: string;
  generatedOn: string;
  generatedBy: string;
  approvedBy: string;
  approvedOn: string;
  /** Rendered letter body (HTML, escaped). Wrapped in the print stylesheet when opened. */
  html: string;
}

export interface LetterRequest {
  id: string;
  employeeId: string;
  employeeName: string;
  type: LetterType;
  status: LetterStatus;
  requestedBy: string;
  /** Account id of the requester (older rows may only carry the name) */
  requestedById?: string;
  requestedOn: string;
  approver?: string;
  decidedOn?: string;
  note: string;
  /** Template preview body — not a legal document */
  previewBody: string;
  /** Type-specific input, e.g. destination for a travel letter or purpose for a NOC. */
  details?: string;
  /** Effective date entered by HR (transfer, confirmation…). */
  effectiveDate?: string;
  /** Account id of whoever approved or rejected. */
  approverId?: string;
  /** Generated versions, oldest first. The last one is current. */
  issued?: IssuedLetter[];
  /** Backend mode only: the server-side PDF versions and what this viewer may do. */
  api?: ApiLetterInfo;
}

/** A letter request loaded from the backend (VITE_API_URL mode). */
export interface ApiLetterInfo {
  /** Issued PDF versions, oldest first. */
  issues: { version: number; referenceNo: string; on: string }[];
  /** Waiting on this viewer for approval. */
  canDecide: boolean;
  /** HR may generate (again): approved or issued letters about someone else. */
  canIssue: boolean;
  /** The requester may cancel a pending request. */
  canCancel: boolean;
  /** Why the PDF could not be generated after approval. */
  issueError?: string;
}

export interface DocLibraryItem {
  id: string;
  employeeId: string;
  employeeName: string;
  name: string;
  category: string;
  docType: string;
  uploadedBy: string;
  uploadedAt: string;
  sizeLabel: string;
  /** text or data-url preview */
  preview: string;
  isDemoFile: boolean;
  /** Generated letters: the request and document id, so the PDF can be opened. */
  letterId?: string;
  docId?: string;
}

export const GRADE_BANDS: GradeBand[] = [
  { id: "gb-1", grade: "L4", family: "Engineering", country: "India", currency: "INR", min: "₹12,00,000", mid: "₹15,00,000", max: "₹18,00,000" },
  { id: "gb-2", grade: "L5", family: "Engineering", country: "India", currency: "INR", min: "₹18,00,000", mid: "₹23,00,000", max: "₹28,00,000" },
  { id: "gb-3", grade: "L5", family: "Engineering", country: "United States", currency: "USD", min: "$140,000", mid: "$160,000", max: "$180,000" },
  { id: "gb-4", grade: "L5", family: "People", country: "United Kingdom", currency: "GBP", min: "£65,000", mid: "£75,000", max: "£85,000" },
  { id: "gb-5", grade: "L4", family: "Finance", country: "Canada", currency: "CAD", min: "C$85,000", mid: "C$95,000", max: "C$110,000" },
  { id: "gb-6", grade: "M1", family: "Engineering", country: "India", currency: "INR", min: "₹28,00,000", mid: "₹34,00,000", max: "₹40,00,000" },
  { id: "gb-7", grade: "L6", family: "Product", country: "United States", currency: "USD", min: "$165,000", mid: "$185,000", max: "$210,000" },
];

export const COMP_CYCLES: CompCycle[] = [
  {
    id: "cc-2026",
    name: "FY2026 Annual compensation review",
    status: "Manager review",
    window: "01 Oct – 30 Nov 2026",
    countries: ["India", "United States", "United Kingdom", "Canada"],
    effectiveDate: "2027-04-01",
    budgetPct: 8,
    opensOn: "2026-10-01",
    closesOn: "2026-11-30",
  },
  {
    id: "cc-mid",
    name: "H1 2026 Off-cycle adjustments",
    status: "Closed",
    window: "01 Mar – 31 Mar 2026",
    countries: ["India", "United States"],
    effectiveDate: "2026-04-01",
    budgetPct: 3,
    opensOn: "2026-03-01",
    closesOn: "2026-03-31",
  },
];

export const COMP_HISTORY: CompHistoryRow[] = [
  { id: "ch-1", employeeId: "emp-mahesh", employeeName: "Babu Menon", effective: "2026-04-01", event: "Annual increment", grade: "L4", base: "₹17,40,000", currency: "INR", managerId: "emp-ram" },
  { id: "ch-2", employeeId: "emp-mahesh", employeeName: "Babu Menon", effective: "2025-04-01", event: "Annual increment", grade: "L4", base: "₹16,20,000", currency: "INR", managerId: "emp-ram" },
  { id: "ch-3", employeeId: "emp-ram", employeeName: "Ram Krishnan", effective: "2026-04-01", event: "Promotion + increment", grade: "M1", base: "₹34,00,000", currency: "INR", managerId: "demo-ceo" },
  { id: "ch-5", employeeId: "emp-priya", employeeName: "Priya Nair", effective: "2026-04-01", event: "Annual increment", grade: "L5", base: "₹22,00,000", currency: "INR", managerId: "emp-ram" },
];

export const COMP_REVIEWS: CompReviewItem[] = [
  {
    id: "cr-1",
    cycleId: "cc-2026",
    employeeId: "emp-mahesh",
    employeeName: "Babu Menon",
    managerId: "emp-ram",
    managerName: "Ram Krishnan",
    currentGrade: "L4",
    proposedGrade: "L5",
    currentBase: "₹17,40,000",
    proposedBase: "₹19,50,000",
    proposedIncreasePct: 12.1,
    currency: "INR",
    status: "Pending approval",
    bonusProposal: "₹1,50,000",
  },
  {
    id: "cr-2",
    cycleId: "cc-2026",
    employeeId: "emp-priya",
    employeeName: "Priya Nair",
    managerId: "emp-ram",
    managerName: "Ram Krishnan",
    currentGrade: "L5",
    proposedGrade: "L5",
    currentBase: "₹22,00,000",
    proposedBase: "₹23,50,000",
    proposedIncreasePct: 6.8,
    currency: "INR",
    status: "Draft",
    bonusProposal: "₹1,00,000",
  },
];

export const BONUSES: BonusRecord[] = [
  { id: "bn-1", employeeId: "emp-mahesh", employeeName: "Babu Menon", type: "Annual incentive", period: "FY2025", amount: "₹1,20,000", currency: "INR", status: "Paid" },
  { id: "bn-2", employeeId: "emp-mahesh", employeeName: "Babu Menon", type: "Spot award", period: "Q2 2026", amount: "₹25,000", currency: "INR", status: "Accrued" },
  { id: "bn-3", employeeId: "emp-ram", employeeName: "Ram Krishnan", type: "Annual incentive", period: "FY2025", amount: "₹3,00,000", currency: "INR", status: "Paid" },
];

export const BENEFIT_PLANS: BenefitPlan[] = [
  {
    id: "bp-in-med",
    country: "India",
    name: "Group Medical (India)",
    category: "Medical",
    provider: "Northwind Health India",
    summary: "Employee + family floater cover",
    employeeCost: "Employer paid",
    documents: ["India Medical SPD"],
    coversDependents: true,
    eligibility: { excludeEmploymentTypes: ["Contract"] },
  },
  {
    id: "bp-in-pf",
    country: "India",
    name: "Provident Fund",
    category: "Retirement",
    provider: "EPFO",
    summary: "Statutory PF. Every employee is enrolled from day one.",
    employeeCost: "12% of basic",
    documents: ["PF FAQ"],
    mandatory: true,
    autoEnrolled: true,
  },
  {
    id: "bp-us-med",
    country: "United States",
    name: "Medical PPO",
    category: "Medical",
    provider: "Northwind Care US",
    summary: "PPO network · open enrollment Nov",
    employeeCost: "$120 / paycheck",
    documents: ["US Medical SBC"],
    coversDependents: true,
    eligibility: { excludeEmploymentTypes: ["Contract"], minServiceMonths: 1 },
  },
  {
    id: "bp-us-401",
    country: "United States",
    name: "401(k)",
    category: "Retirement",
    provider: "Harbor Retirement Services",
    summary: "4% employer match",
    employeeCost: "Elective deferral",
    documents: ["401k Summary"],
    eligibility: { excludeEmploymentTypes: ["Contract"], minServiceMonths: 3 },
  },
  {
    id: "bp-uk-med",
    country: "United Kingdom",
    name: "Private Medical",
    category: "Medical",
    provider: "Northwind Health UK",
    summary: "Employee + optional dependents",
    employeeCost: "£45 / month",
    documents: ["UK PMI guide"],
    coversDependents: true,
    eligibility: { excludeEmploymentTypes: ["Contract"], minServiceMonths: 6, grades: ["L5", "L6", "M1", "M2", "M3", "E1"] },
  },
  {
    id: "bp-uk-pen",
    country: "United Kingdom",
    name: "Workplace Pension",
    category: "Retirement",
    provider: "Harbor Pensions UK",
    summary: "Auto-enrolment pension · 3% employer contribution. You can opt out.",
    employeeCost: "5% of qualifying earnings",
    documents: ["UK Pension guide"],
    eligibility: { excludeEmploymentTypes: ["Contract"], minServiceMonths: 3 },
    autoEnrolled: true,
  },
  {
    id: "bp-ae-med",
    country: "United Arab Emirates",
    name: "DHA Medical",
    category: "Medical",
    provider: "Gulf Shield Care",
    summary: "Mandatory medical insurance (DHA)",
    employeeCost: "Employer paid",
    documents: ["UAE Medical"],
    coversDependents: true,
    mandatory: true,
  },
];

export const BENEFIT_ENROLLMENTS: BenefitEnrollment[] = [
  { id: "be-1", employeeId: "emp-mahesh", employeeName: "Babu Menon", planId: "bp-in-med", planName: "Group Medical (India)", country: "India", status: "Enrolled", effective: "2026-01-01" },
  { id: "be-2", employeeId: "emp-mahesh", employeeName: "Babu Menon", planId: "bp-in-pf", planName: "Provident Fund", country: "India", status: "Enrolled", effective: "2024-11-04" },
  { id: "be-5", employeeId: "demo-hr-admin", employeeName: "Farhan Ali", planId: "bp-in-med", planName: "Group Medical (India)", country: "India", status: "Enrolled", effective: "2026-01-01" },
  { id: "be-6", employeeId: "demo-ceo", employeeName: "Jordan Blake", planId: "bp-us-med", planName: "Medical PPO", country: "United States", status: "Eligible", effective: "2026-11-01" },
];

export const DEPENDENTS: Dependent[] = [
  { id: "dep-1", employeeId: "emp-mahesh", name: "Ananya Menon", relationship: "Spouse", coveredPlans: ["Group Medical (India)"], dateOfBirth: "1993-08-21", gender: "Female", verification: "Verified" },
  { id: "dep-2", employeeId: "emp-mahesh", name: "Arjun Menon", relationship: "Child", coveredPlans: ["Group Medical (India)"], dateOfBirth: "2025-05-30", gender: "Male", verification: "Verified" },
];

export const BENEFIT_HISTORY: BenefitHistoryRow[] = [
  { id: "bh-1", employeeId: "emp-mahesh", date: "2026-01-01", event: "Enrollment", detail: "Renewed Group Medical (India)" },
  { id: "bh-2", employeeId: "emp-mahesh", date: "2025-06-12", event: "Dependent add", detail: "Added Arjun Menon to medical" },
];

export interface LetterTemplateInfo {
  type: LetterType;
  label: string;
  description: string;
  /** Employees may request this for themselves; HR can issue any type. */
  employeeCanRequest: boolean;
  /** Pay letters carry salary from compensation data. */
  payLetter: boolean;
  /** Label for the type-specific input, when the letter needs one. */
  detailsLabel?: string;
  /** HR enters an effective date for this letter. */
  effectiveInput?: boolean;
}

export const LETTER_TEMPLATES: LetterTemplateInfo[] = [
  { type: "Employment", label: "Employment certificate", description: "Confirms current employment, role and joining date.", employeeCanRequest: true, payLetter: false },
  { type: "Experience", label: "Experience letter", description: "Service period and role. Available after exit.", employeeCanRequest: true, payLetter: false },
  { type: "Relieving", label: "Relieving letter", description: "Confirms release from duties on the last working day.", employeeCanRequest: false, payLetter: false },
  { type: "Offer", label: "Offer letter", description: "Role, grade, start date and base salary.", employeeCanRequest: false, payLetter: true },
  { type: "Appointment", label: "Appointment letter", description: "Formal appointment with grade, manager and salary.", employeeCanRequest: false, payLetter: true },
  { type: "Confirmation", label: "Confirmation letter", description: "Confirms employment after probation.", employeeCanRequest: false, payLetter: false, effectiveInput: true },
  { type: "Promotion", label: "Promotion letter", description: "New grade and salary from the approved review.", employeeCanRequest: false, payLetter: true },
  { type: "Salary revision", label: "Salary revision letter", description: "Revised base salary from compensation data.", employeeCanRequest: false, payLetter: true },
  { type: "Transfer", label: "Transfer letter", description: "Move to a new location or department.", employeeCanRequest: false, payLetter: false, detailsLabel: "New location / department", effectiveInput: true },
  { type: "NOC", label: "No objection certificate", description: "No objection for a stated purpose.", employeeCanRequest: true, payLetter: false, detailsLabel: "Purpose" },
  { type: "Visa/Travel", label: "Visa / travel letter", description: "Supports a visa or travel application.", employeeCanRequest: true, payLetter: false, detailsLabel: "Destination and travel dates" },
  { type: "Address proof", label: "Address proof letter", description: "Confirms the address on the employee record.", employeeCanRequest: true, payLetter: false },
];

export function letterTemplate(type: LetterType): LetterTemplateInfo {
  return LETTER_TEMPLATES.find((t) => t.type === type) ?? LETTER_TEMPLATES[0];
}

export const LETTER_REQUESTS: LetterRequest[] = [
  {
    id: "ltr-1",
    employeeId: "emp-mahesh",
    employeeName: "Babu Menon",
    type: "Employment",
    status: "Issued",
    requestedBy: "Babu Menon",
    requestedById: "emp-mahesh",
    requestedOn: "2026-09-01",
    approver: "Farhan Ali",
    decidedOn: "2026-09-03",
    note: "Bank KYC support",
    previewBody:
      "[TEMPLATE PREVIEW — NOT AN OFFICIAL DOCUMENT]\n\nEmployment particulars summary for Babu Menon (EMP1184).\nRole: Software Engineer · Entity: TimeZ India Pvt Ltd.\nPreview only — the issued letter is provided by HR.",
  },
  {
    id: "ltr-2",
    employeeId: "emp-mahesh",
    employeeName: "Babu Menon",
    type: "Salary revision",
    status: "Pending approval",
    requestedBy: "Ram Krishnan",
    requestedById: "emp-ram",
    requestedOn: "2026-10-08",
    note: "Linked to FY2026 review proposal",
    previewBody:
      "[TEMPLATE PREVIEW — NOT AN OFFICIAL DOCUMENT]\n\nSalary revision draft for Babu Menon.\nAmounts are placeholders and masked according to viewer permissions.\nDo not treat as an official compensation letter.",
  },
  {
    id: "ltr-3",
    employeeId: "emp-priya",
    employeeName: "Priya Nair",
    type: "Promotion",
    status: "Draft",
    requestedBy: "Farhan Ali",
    requestedById: "demo-hr-admin",
    requestedOn: "2026-10-10",
    note: "Pending cycle approval",
    previewBody:
      "[TEMPLATE PREVIEW — NOT AN OFFICIAL DOCUMENT]\n\nPromotion notification draft for Priya Nair.\nPreview only — the issued letter is provided by HR.",
  },
];

export const DOC_LIBRARY_SEED: DocLibraryItem[] = [
  {
    id: "dl-1",
    employeeId: "emp-mahesh",
    employeeName: "Babu Menon",
    name: "PAN card scan",
    category: "Identity",
    docType: "ID",
    uploadedBy: "Babu Menon",
    uploadedAt: "2024-11-05T10:00:00",
    sizeLabel: "240 KB",
    preview: "PAN card scan · metadata only. The original is held by HR.",
    isDemoFile: true,
  },
  {
    id: "dl-2",
    employeeId: "emp-mahesh",
    employeeName: "Babu Menon",
    name: "Signed NDA",
    category: "Compliance",
    docType: "Agreement",
    uploadedBy: "HR Ops",
    uploadedAt: "2024-11-04T09:00:00",
    sizeLabel: "110 KB",
    preview: "NDA acknowledgement · signed copy held by HR.",
    isDemoFile: true,
  },
];
