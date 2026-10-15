/** Compensation, benefits, and documents & letters — fictional Infotech demo data only. */

export const LEGAL_DISCLAIMER =
  "Demo templates and figures only. Infotech does not generate real employment, tax, or legal documents from fabricated data in this prototype.";

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
  status: "Draft" | "Pending approval" | "Approved" | "Rejected";
  bonusProposal: string;
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
}

export interface Dependent {
  id: string;
  employeeId: string;
  name: string;
  relationship: string;
  coveredPlans: string[];
}

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
  | "Experience";

export type LetterStatus = "Draft" | "Pending approval" | "Approved" | "Issued";

export interface LetterRequest {
  id: string;
  employeeId: string;
  employeeName: string;
  type: LetterType;
  status: LetterStatus;
  requestedBy: string;
  requestedOn: string;
  approver?: string;
  decidedOn?: string;
  note: string;
  /** Demo template body — not a legal document */
  previewBody: string;
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
  /** text or data-url demo preview */
  preview: string;
  isDemoFile: boolean;
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
  },
  {
    id: "cc-mid",
    name: "H1 2026 Off-cycle adjustments",
    status: "Closed",
    window: "01 Mar – 31 Mar 2026",
    countries: ["India", "United States"],
  },
];

export const COMP_HISTORY: CompHistoryRow[] = [
  { id: "ch-1", employeeId: "emp-mahesh", employeeName: "Babu Menon", effective: "2026-04-01", event: "Annual increment", grade: "L4", base: "₹18,50,000", currency: "INR", managerId: "emp-ram" },
  { id: "ch-2", employeeId: "emp-mahesh", employeeName: "Babu Menon", effective: "2025-04-01", event: "Annual increment", grade: "L4", base: "₹16,20,000", currency: "INR", managerId: "emp-ram" },
  { id: "ch-3", employeeId: "emp-ram", employeeName: "Ram Krishnan", effective: "2026-04-01", event: "Promotion + increment", grade: "M1", base: "₹34,00,000", currency: "INR", managerId: "demo-ceo" },
  { id: "ch-4", employeeId: "demo-hiring-manager", employeeName: "Daniel Ortiz", effective: "2026-04-01", event: "Annual increment", grade: "L6", base: "$178,000", currency: "USD", managerId: "demo-ceo" },
  { id: "ch-5", employeeId: "demo-learning", employeeName: "Priya Nair", effective: "2026-04-01", event: "Annual increment", grade: "L5", base: "₹22,00,000", currency: "INR", managerId: "emp-ram" },
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
    currentBase: "₹18,50,000",
    proposedBase: "₹21,00,000",
    proposedIncreasePct: 13.5,
    currency: "INR",
    status: "Pending approval",
    bonusProposal: "₹1,50,000",
  },
  {
    id: "cr-2",
    cycleId: "cc-2026",
    employeeId: "demo-learning",
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
  {
    id: "cr-3",
    cycleId: "cc-2026",
    employeeId: "demo-hiring-manager",
    employeeName: "Daniel Ortiz",
    managerId: "demo-ceo",
    managerName: "Jordan Blake",
    currentGrade: "L6",
    proposedGrade: "L6",
    currentBase: "$178,000",
    proposedBase: "$186,000",
    proposedIncreasePct: 4.5,
    currency: "USD",
    status: "Approved",
    bonusProposal: "$18,000",
  },
];

export const BONUSES: BonusRecord[] = [
  { id: "bn-1", employeeId: "emp-mahesh", employeeName: "Babu Menon", type: "Annual incentive", period: "FY2025", amount: "₹1,20,000", currency: "INR", status: "Paid" },
  { id: "bn-2", employeeId: "emp-mahesh", employeeName: "Babu Menon", type: "Spot award", period: "Q2 2026", amount: "₹25,000", currency: "INR", status: "Accrued" },
  { id: "bn-3", employeeId: "emp-ram", employeeName: "Ram Krishnan", type: "Annual incentive", period: "FY2025", amount: "₹3,00,000", currency: "INR", status: "Paid" },
  { id: "bn-4", employeeId: "demo-hiring-manager", employeeName: "Daniel Ortiz", type: "Annual incentive", period: "FY2025", amount: "$22,000", currency: "USD", status: "Paid" },
];

export const BENEFIT_PLANS: BenefitPlan[] = [
  {
    id: "bp-in-med",
    country: "India",
    name: "Group Medical (India)",
    category: "Medical",
    provider: "Demo Health India",
    summary: "Employee + family floater · demo plan summary only",
    employeeCost: "Employer paid",
    documents: ["India Medical SPD (demo).pdf"],
  },
  {
    id: "bp-in-pf",
    country: "India",
    name: "Provident Fund",
    category: "Retirement",
    provider: "EPFO (demo)",
    summary: "Statutory PF contribution demo record",
    employeeCost: "12% employee share (demo)",
    documents: ["PF FAQ (demo).pdf"],
  },
  {
    id: "bp-us-med",
    country: "United States",
    name: "Medical PPO",
    category: "Medical",
    provider: "DemoCare US",
    summary: "PPO network · open enrollment Nov",
    employeeCost: "$120 / paycheck (demo)",
    documents: ["US Medical SBC (demo).pdf"],
  },
  {
    id: "bp-us-401",
    country: "United States",
    name: "401(k)",
    category: "Retirement",
    provider: "Demo Fidelity",
    summary: "4% match demo description",
    employeeCost: "Elective deferral",
    documents: ["401k Summary (demo).pdf"],
  },
  {
    id: "bp-uk-med",
    country: "United Kingdom",
    name: "Private Medical",
    category: "Medical",
    provider: "Demo Health UK",
    summary: "Employee + optional dependents",
    employeeCost: "£45 / month (demo)",
    documents: ["UK PMI guide (demo).pdf"],
  },
  {
    id: "bp-ae-med",
    country: "United Arab Emirates",
    name: "DHA Medical",
    category: "Medical",
    provider: "Demo Gulf Care",
    summary: "Mandatory medical insurance demo",
    employeeCost: "Employer paid",
    documents: ["UAE Medical (demo).pdf"],
  },
];

export const BENEFIT_ENROLLMENTS: BenefitEnrollment[] = [
  { id: "be-1", employeeId: "emp-mahesh", employeeName: "Babu Menon", planId: "bp-in-med", planName: "Group Medical (India)", country: "India", status: "Enrolled", effective: "2026-01-01" },
  { id: "be-2", employeeId: "emp-mahesh", employeeName: "Babu Menon", planId: "bp-in-pf", planName: "Provident Fund", country: "India", status: "Enrolled", effective: "2024-11-04" },
  { id: "be-3", employeeId: "demo-hiring-manager", employeeName: "Daniel Ortiz", planId: "bp-us-med", planName: "Medical PPO", country: "United States", status: "Enrolled", effective: "2026-01-01" },
  { id: "be-4", employeeId: "demo-hiring-manager", employeeName: "Daniel Ortiz", planId: "bp-us-401", planName: "401(k)", country: "United States", status: "Enrolled", effective: "2025-03-01" },
  { id: "be-5", employeeId: "demo-hrbp", employeeName: "Meera Iyer", planId: "bp-in-med", planName: "Group Medical (India)", country: "India", status: "Enrolled", effective: "2026-01-01" },
  { id: "be-6", employeeId: "demo-ceo", employeeName: "Jordan Blake", planId: "bp-us-med", planName: "Medical PPO", country: "United States", status: "Eligible", effective: "2026-11-01" },
];

export const DEPENDENTS: Dependent[] = [
  { id: "dep-1", employeeId: "emp-mahesh", name: "Ananya Menon", relationship: "Spouse", coveredPlans: ["Group Medical (India)"] },
  { id: "dep-2", employeeId: "emp-mahesh", name: "Arjun Menon", relationship: "Child", coveredPlans: ["Group Medical (India)"] },
  { id: "dep-3", employeeId: "demo-hiring-manager", name: "Sam Ortiz", relationship: "Spouse", coveredPlans: ["Medical PPO"] },
];

export const BENEFIT_HISTORY: BenefitHistoryRow[] = [
  { id: "bh-1", employeeId: "emp-mahesh", date: "2026-01-01", event: "Enrollment", detail: "Renewed Group Medical (India)" },
  { id: "bh-2", employeeId: "emp-mahesh", date: "2025-06-12", event: "Dependent add", detail: "Added Arjun Menon to medical" },
  { id: "bh-3", employeeId: "demo-hiring-manager", date: "2025-11-15", event: "Open enrollment", detail: "Confirmed PPO + 401(k)" },
];

export const LETTER_TEMPLATES: { type: LetterType; description: string }[] = [
  { type: "Offer", description: "Demo offer letter shell — not a binding offer" },
  { type: "Appointment", description: "Demo appointment confirmation shell" },
  { type: "Employment", description: "Demo employment particulars summary" },
  { type: "Promotion", description: "Demo promotion notification shell" },
  { type: "Transfer", description: "Demo internal transfer confirmation" },
  { type: "Salary revision", description: "Demo salary revision notice shell" },
  { type: "Experience", description: "Demo experience / relieving letter shell" },
];

export const LETTER_REQUESTS: LetterRequest[] = [
  {
    id: "ltr-1",
    employeeId: "emp-mahesh",
    employeeName: "Babu Menon",
    type: "Employment",
    status: "Issued",
    requestedBy: "Babu Menon",
    requestedOn: "2026-09-01",
    approver: "Farhan Ali",
    decidedOn: "2026-09-03",
    note: "Bank KYC support",
    previewBody:
      "[DEMO TEMPLATE — NOT A LEGAL DOCUMENT]\n\nEmployment particulars summary for Babu Menon (EMP1184).\nRole: Software Engineer · Entity: Infotech India Pvt Ltd (demo).\nThis text is fictional and must not be used as an official letter.",
  },
  {
    id: "ltr-2",
    employeeId: "emp-mahesh",
    employeeName: "Babu Menon",
    type: "Salary revision",
    status: "Pending approval",
    requestedBy: "Ram Krishnan",
    requestedOn: "2026-10-08",
    note: "Linked to FY2026 review proposal",
    previewBody:
      "[DEMO TEMPLATE — NOT A LEGAL DOCUMENT]\n\nSalary revision draft for Babu Menon.\nAmounts are placeholders and masked according to viewer permissions.\nDo not treat as an official compensation letter.",
  },
  {
    id: "ltr-3",
    employeeId: "demo-learning",
    employeeName: "Priya Nair",
    type: "Promotion",
    status: "Draft",
    requestedBy: "Farhan Ali",
    requestedOn: "2026-10-10",
    note: "Pending cycle approval",
    previewBody:
      "[DEMO TEMPLATE — NOT A LEGAL DOCUMENT]\n\nPromotion notification draft for Priya Nair.\nFictional content for UI demonstration only.",
  },
];

export const DOC_LIBRARY_SEED: DocLibraryItem[] = [
  {
    id: "dl-1",
    employeeId: "emp-mahesh",
    employeeName: "Babu Menon",
    name: "PAN card (demo scan)",
    category: "Identity",
    docType: "ID",
    uploadedBy: "Babu Menon",
    uploadedAt: "2024-11-05T10:00:00",
    sizeLabel: "240 KB",
    preview: "Demo file placeholder: PAN scan metadata only. No real identity document stored.",
    isDemoFile: true,
  },
  {
    id: "dl-2",
    employeeId: "emp-mahesh",
    employeeName: "Babu Menon",
    name: "Signed NDA (demo)",
    category: "Compliance",
    docType: "Agreement",
    uploadedBy: "HR Ops",
    uploadedAt: "2024-11-04T09:00:00",
    sizeLabel: "110 KB",
    preview: "Demo NDA acknowledgement text. Not an executed legal agreement.",
    isDemoFile: true,
  },
  {
    id: "dl-3",
    employeeId: "demo-hiring-manager",
    employeeName: "Daniel Ortiz",
    name: "I-9 worksheet (demo)",
    category: "Onboarding",
    docType: "Form",
    uploadedBy: "HR US",
    uploadedAt: "2025-02-01T15:00:00",
    sizeLabel: "88 KB",
    preview: "Demo onboarding form metadata for US entity.",
    isDemoFile: true,
  },
];
