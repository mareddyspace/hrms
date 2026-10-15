import type { Employee } from "./model.ts";
import type { RbacFlags } from "./data/rbac.ts";

/** Nav link ids from nav.ts — used for prototype permission filtering. */
export type NavAccessId =
  | "*"
  | "home"
  | "profile"
  | "team"
  | "tasks"
  | "inbox"
  | "messages"
  | "announcements"
  | "notifications"
  | "people"
  | "organization"
  | "jobs"
  | "attendance"
  | "leave"
  | "timesheet"
  | "recruiting"
  | "onboarding"
  | "performance"
  | "learning"
  | "skills"
  | "compensation"
  | "benefits"
  | "documents"
  | "payslips"
  | "workflows"
  | "analytics"
  | "copilot"
  | "agents"
  | "integrations"
  | "payroll"
  | "administration"
  | "locale";

export interface DemoAccount extends Employee {
  /** Prototype-only plain-text password (frontend mock). */
  password: string;
  /** Short label for login cards / role switcher */
  personaLabel: string;
  navAccess: readonly NavAccessId[];
  /** Explicit authorization flags (frontend stand-in for backend claims). */
  rbacFlags?: RbacFlags;
}

/**
 * Access packs aligned with RBAC:
 * - Employee → self-service (own profile, time, own payslips)
 * - Manager → team tools, NO individual salary module by default
 * - Admin → platform + manager tools, NO compensation / confidential pay
 */
const ACCESS_EMPLOYEE: NavAccessId[] = [
  "home",
  "profile",
  "tasks",
  "messages",
  "notifications",
  "announcements",
  "attendance",
  "leave",
  "timesheet",
  "payslips",
  "benefits",
  "documents",
  "copilot",
];

const ACCESS_MANAGER: NavAccessId[] = [
  ...ACCESS_EMPLOYEE,
  "team",
  "inbox",
  "workflows",
  "performance",
  "learning",
  "skills",
  "people",
  "analytics",
  // compensation intentionally omitted — managers do not get salary records by default
];

/** Platform admin: settings & system reports — not confidential pay. */
const ACCESS_ADMIN: NavAccessId[] = [
  ...ACCESS_MANAGER,
  "organization",
  "jobs",
  "recruiting",
  "onboarding",
  "agents",
  "locale",
  "integrations",
  "payroll", // integration status only
  "administration",
  // no "compensation" — Admin does not auto-receive salary access
];

function account(
  partial: Omit<DemoAccount, "employmentType" | "shiftName" | "shiftHours" | "photo" | "mobile" | "address"> &
    Partial<Pick<DemoAccount, "employmentType" | "shiftName" | "shiftHours" | "photo" | "mobile" | "address" | "rbacFlags">>,
): DemoAccount {
  return {
    employmentType: "Full Time",
    shiftName: "General Shift",
    shiftHours: "09:30 AM to 06:30 PM",
    photo: "/profile.svg",
    mobile: "+91 90000 00000",
    address: "TimeZ",
    ...partial,
  };
}

/**
 * Slim demo cast (8 personas) with RBAC-aligned navAccess.
 */
export const DEMO_ACCOUNTS: DemoAccount[] = [
  account({
    id: "emp-mahesh",
    employeeCode: "EMP1184",
    fullName: "Babu Menon",
    personaLabel: "Employee",
    role: "employee",
    designation: "Software Engineer",
    email: "babu.menon@timez.com",
    password: "Employee@1184",
    mobile: "+91 98450 22110",
    address: "Bengaluru, India",
    timeZone: "Asia/Kolkata",
    countryCode: "IN",
    countryName: "India",
    legalEntity: "TimeZ India Pvt Ltd",
    location: "Bengaluru",
    department: "Engineering",
    currency: "INR",
    navAccess: ACCESS_EMPLOYEE,
  }),
  account({
    id: "emp-ram",
    employeeCode: "MGR1001",
    fullName: "Ram Krishnan",
    personaLabel: "Manager",
    role: "manager",
    designation: "Engineering Manager",
    email: "ram.krishnan@timez.com",
    password: "Manager@1001",
    mobile: "+91 98450 11001",
    address: "Bengaluru, India",
    timeZone: "Asia/Kolkata",
    countryCode: "IN",
    countryName: "India",
    legalEntity: "TimeZ India Pvt Ltd",
    location: "Bengaluru",
    department: "Engineering",
    currency: "INR",
    navAccess: ACCESS_MANAGER,
  }),
  account({
    id: "demo-hr-admin",
    employeeCode: "HR2001",
    fullName: "Farhan Ali",
    personaLabel: "HR",
    role: "hr_admin",
    designation: "HR Director",
    email: "farhan.ali@timez.com",
    password: "HrAdmin@2001",
    mobile: "+91 98450 44001",
    address: "Bengaluru, India",
    timeZone: "Asia/Kolkata",
    countryCode: "IN",
    countryName: "India",
    legalEntity: "TimeZ India Pvt Ltd",
    location: "Bengaluru",
    department: "People",
    currency: "INR",
    rbacFlags: { hrCompAuthorized: true },
    navAccess: [
      ...ACCESS_MANAGER,
      "organization",
      "jobs",
      "onboarding",
      "compensation",
      "agents",
      "locale",
      "administration",
    ],
  }),
  account({
    id: "demo-recruiter",
    employeeCode: "REC3001",
    fullName: "Sophie Clark",
    personaLabel: "Recruiter",
    role: "recruiter",
    designation: "Talent Acquisition Lead",
    email: "sophie.clark@timez.com",
    password: "Recruiter@3001",
    mobile: "+1 212 555 0188",
    address: "New York, USA",
    timeZone: "America/New_York",
    countryCode: "US",
    countryName: "United States",
    legalEntity: "TimeZ Inc",
    location: "New York",
    department: "Talent Acquisition",
    currency: "USD",
    shiftHours: "09:00 AM to 06:00 PM",
    navAccess: [
      ...ACCESS_EMPLOYEE,
      "people",
      "organization",
      "jobs",
      "recruiting",
      "onboarding",
      "analytics",
      "agents",
    ],
  }),
  account({
    id: "demo-hiring-manager",
    employeeCode: "HM1102",
    fullName: "Daniel Ortiz",
    personaLabel: "Hiring Manager",
    role: "hiring_manager",
    designation: "Director of Product",
    email: "daniel.ortiz@timez.com",
    password: "Hiring@1102",
    mobile: "+1 415 555 0190",
    address: "San Francisco, USA",
    timeZone: "America/Los_Angeles",
    countryCode: "US",
    countryName: "United States",
    legalEntity: "TimeZ Inc",
    location: "San Francisco",
    department: "Product",
    currency: "USD",
    shiftHours: "08:30 AM to 05:30 PM",
    navAccess: [...ACCESS_MANAGER, "jobs", "recruiting", "onboarding"],
  }),
  account({
    id: "demo-ceo",
    employeeCode: "EXE5001",
    fullName: "Jordan Blake",
    personaLabel: "Executive",
    role: "executive",
    designation: "Chief Executive Officer",
    email: "jordan.blake@timez.com",
    password: "Executive@5001",
    mobile: "+1 415 555 0142",
    address: "San Francisco, USA",
    timeZone: "America/Los_Angeles",
    countryCode: "US",
    countryName: "United States",
    legalEntity: "TimeZ Inc",
    location: "San Francisco",
    department: "Executive",
    currency: "USD",
    /** Salary / payslips require explicit grant — off by default for this demo. */
    rbacFlags: { salaryAuthorized: false },
    navAccess: [
      ...ACCESS_MANAGER,
      "organization",
      "jobs",
      "recruiting",
      "agents",
      // no compensation unless salaryAuthorized + nav added later
    ],
  }),
  account({
    id: "demo-compensation",
    employeeCode: "CMP6201",
    fullName: "Helen Brooks",
    personaLabel: "Compensation",
    role: "compensation_admin",
    designation: "Compensation & Benefits Manager",
    email: "helen.brooks@timez.com",
    password: "Comp@6201",
    mobile: "+1 646 555 0177",
    address: "New York, USA",
    timeZone: "America/New_York",
    countryCode: "US",
    countryName: "United States",
    legalEntity: "TimeZ Inc",
    location: "New York",
    department: "Total Rewards",
    currency: "USD",
    shiftHours: "09:00 AM to 06:00 PM",
    navAccess: [
      ...ACCESS_EMPLOYEE,
      "people",
      "organization",
      "team",
      "workflows",
      "analytics",
      "compensation",
      "payroll",
      "payslips",
    ],
  }),
  account({
    id: "demo-admin",
    employeeCode: "ADM8001",
    fullName: "Alex Morgan",
    personaLabel: "Admin",
    role: "admin",
    designation: "Platform Administrator",
    email: "alex.morgan@timez.com",
    password: "Admin@8001",
    mobile: "+44 20 7946 0991",
    address: "London, UK",
    timeZone: "Europe/London",
    countryCode: "GB",
    countryName: "United Kingdom",
    legalEntity: "TimeZ UK Ltd",
    location: "London",
    department: "IT",
    currency: "GBP",
    shiftHours: "09:00 AM to 05:30 PM",
    navAccess: ACCESS_ADMIN,
  }),
];

export function findDemoByCode(code: string): DemoAccount | undefined {
  return DEMO_ACCOUNTS.find((account) => account.employeeCode.toUpperCase() === code.trim().toUpperCase());
}

export function findDemoById(id: string): DemoAccount | undefined {
  return DEMO_ACCOUNTS.find((account) => account.id === id);
}

export function findDemoByEmailOrCode(value: string): DemoAccount | undefined {
  const needle = value.trim().toLowerCase();
  if (!needle) return undefined;
  return DEMO_ACCOUNTS.find(
    (account) =>
      account.email.toLowerCase() === needle || account.employeeCode.toLowerCase() === needle,
  );
}

export function demoPasswordFor(employeeCode: string): string {
  return findDemoByCode(employeeCode)?.password ?? "welcome";
}

export function accountHasNavAccess(account: DemoAccount, linkId: string): boolean {
  if (account.navAccess.includes("*")) return true;
  return account.navAccess.includes(linkId as NavAccessId);
}

/** @deprecated Prefer DEMO_ACCOUNTS from this module */
export const TIMEZ_PERSONAS = DEMO_ACCOUNTS;
