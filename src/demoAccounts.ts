import type { Employee } from "./model.ts";

/** Explicit authorization flags (frontend stand-in for backend claims). */
export type RbacFlags = {
  /** Executive may see salary / payslips when true. Default false. */
  salaryAuthorized?: boolean;
  /** HR compensation case authorization. Default true for HR personas in this demo. */
  hrCompAuthorized?: boolean;
};

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
  | "calendar"
  | "orgchart"
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
  | "locale"
  | "help"
  | "holidays"
  | "expenses"
  | "taxdeclarations"
  | "exit"
  | "teamexits"
  | "exitsadmin"
  | "probation"
  | "probationreviews"
  | "immigration"
  | "privacy"
  | "grievances"
  | "bgv"
  | "engagement"
  | "succession"
  | "internaljobs"
  | "bulkdata"
  | "reportbuilder"
  | "shifts"
  | "optionalholidays"
  | "contractors";

export interface DemoAccount extends Employee {
  /** Prototype-only plain-text password (frontend mock). */
  password: string;
  /** Short label for login cards / role switcher */
  personaLabel: string;
  navAccess: readonly NavAccessId[];
  /** Explicit authorization flags (frontend stand-in for backend claims). */
  rbacFlags?: RbacFlags;
  /** Demo org chart parent (another DEMO_ACCOUNTS id). Empty = root. */
  reportsToId?: string;
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
  "calendar",
  "orgchart",
  "attendance",
  "leave",
  "holidays",
  "timesheet",
  "payslips",
  "benefits",
  "expenses",
  "documents",
  "performance",
  "learning",
  "skills",
  "people",
  "help",
  "copilot",
  "locale",
  "taxdeclarations",
  "exit",
  "probation",
  "immigration",
  "privacy",
  "grievances",
  "engagement",
  "internaljobs",
  "shifts",
  "optionalholidays",
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
  "probationreviews",
  "teamexits",
  "succession",
  "contractors",
  // compensation intentionally omitted — managers do not get salary records by default
];

/** Platform admin: settings & system reports — not confidential pay. */
const ACCESS_ADMIN: NavAccessId[] = [
  // Admin inherits manager tools except payslips — role manages accounts, not pay data
  ...ACCESS_MANAGER.filter((id) => id !== "payslips"),
  "organization",
  "jobs",
  "recruiting",
  "onboarding",
  "agents",
  "locale",
  "integrations",
  "payroll", // integration status only
  "administration",
  "bulkdata",
  "reportbuilder",
  "exitsadmin",
  // no "compensation" / "payslips" — Admin does not auto-receive salary access
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
    address: "Infotech",
    ...partial,
  };
}

/**
 * Demo cast (8 personas). Reporting line (org chart) is separate from RBAC:
 *
 *   Jordan Blake (Executive) ── root
 *   ├── Ram Krishnan (Manager)
 *   │   └── Babu Menon (Employee)     ← Ram approves Babu's leave via reporting
 *   ├── Farhan Ali (HR)
 *   │   ├── Sophie Clark (Recruiter)  ← candidate access = Recruiter role, not chart
 *   │   └── Helen Brooks (Compensation) ← pay access = Compensation role, not chart
 *   ├── Daniel Ortiz (Hiring Manager)
 *   └── Alex Morgan (Admin)           ← accounts = Admin role; no auto payslips
 *
 * Jordan sees executive reports; individual salary stays blocked (salaryAuthorized: false).
 */
export const DEMO_ACCOUNTS: DemoAccount[] = [
  account({
    id: "emp-mahesh",
    employeeCode: "EMP1184",
    fullName: "Babu Menon",
    personaLabel: "Employee",
    role: "employee",
    designation: "Software Engineer",
    email: "babu.menon@infotech.com",
    password: "Employee@1184",
    mobile: "+91 98450 22110",
    address: "Bengaluru, India",
    timeZone: "Asia/Kolkata",
    countryCode: "IN",
    countryName: "India",
    legalEntity: "Infotech India Pvt Ltd",
    location: "Bengaluru",
    department: "Engineering",
    currency: "INR",
    reportsToId: "emp-ram",
    navAccess: ACCESS_EMPLOYEE,
  }),
  account({
    id: "emp-ram",
    employeeCode: "MGR1001",
    fullName: "Ram Krishnan",
    personaLabel: "Manager",
    role: "manager",
    designation: "Engineering Manager",
    email: "ram.krishnan@infotech.com",
    password: "Manager@1001",
    mobile: "+91 98450 11001",
    address: "Bengaluru, India",
    timeZone: "Asia/Kolkata",
    countryCode: "IN",
    countryName: "India",
    legalEntity: "Infotech India Pvt Ltd",
    location: "Bengaluru",
    department: "Engineering",
    currency: "INR",
    reportsToId: "demo-ceo",
    navAccess: ACCESS_MANAGER,
  }),
  account({
    id: "demo-hr-admin",
    employeeCode: "HR2001",
    fullName: "Farhan Ali",
    personaLabel: "HR",
    role: "hr_admin",
    designation: "HR Director",
    email: "farhan.ali@infotech.com",
    password: "HrAdmin@2001",
    mobile: "+91 98450 44001",
    address: "Bengaluru, India",
    timeZone: "Asia/Kolkata",
    countryCode: "IN",
    countryName: "India",
    legalEntity: "Infotech India Pvt Ltd",
    location: "Bengaluru",
    department: "People",
    currency: "INR",
    reportsToId: "demo-ceo",
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
      "exitsadmin",
      "bgv",
      "bulkdata",
      "reportbuilder",
    ],
  }),
  account({
    id: "demo-recruiter",
    employeeCode: "REC3001",
    fullName: "Sophie Clark",
    personaLabel: "Recruiter",
    role: "recruiter",
    designation: "Talent Acquisition Lead",
    email: "sophie.clark@infotech.com",
    password: "Recruiter@3001",
    mobile: "+1 212 555 0188",
    address: "New York, USA",
    timeZone: "America/New_York",
    countryCode: "US",
    countryName: "United States",
    legalEntity: "Infotech Inc",
    location: "New York",
    department: "Talent Acquisition",
    currency: "USD",
    shiftHours: "09:00 AM to 06:00 PM",
    /** Org parent is HR; recruiting access comes from Recruiter role, not this line. */
    reportsToId: "demo-hr-admin",
    navAccess: [
      ...ACCESS_EMPLOYEE,
      "people",
      "organization",
      "jobs",
      "recruiting",
      "onboarding",
      "analytics",
      "agents",
      "bgv",
    ],
  }),
  account({
    id: "demo-hiring-manager",
    employeeCode: "HM1102",
    fullName: "Daniel Ortiz",
    personaLabel: "Hiring Manager",
    role: "hiring_manager",
    designation: "Director of Product",
    email: "daniel.ortiz@infotech.com",
    password: "Hiring@1102",
    mobile: "+1 415 555 0190",
    address: "San Francisco, USA",
    timeZone: "America/Los_Angeles",
    countryCode: "US",
    countryName: "United States",
    legalEntity: "Infotech Inc",
    location: "San Francisco",
    department: "Product",
    currency: "USD",
    shiftHours: "08:30 AM to 05:30 PM",
    reportsToId: "demo-ceo",
    navAccess: [...ACCESS_MANAGER, "jobs", "recruiting", "onboarding"],
  }),
  account({
    id: "demo-ceo",
    employeeCode: "EXE5001",
    fullName: "Jordan Blake",
    personaLabel: "Executive",
    role: "executive",
    designation: "Chief Executive Officer",
    email: "jordan.blake@infotech.com",
    password: "Executive@5001",
    mobile: "+1 415 555 0142",
    address: "San Francisco, USA",
    timeZone: "America/Los_Angeles",
    countryCode: "US",
    countryName: "United States",
    legalEntity: "Infotech Inc",
    location: "San Francisco",
    department: "Executive",
    currency: "USD",
    /** Executive reports yes; individual salary/payslips require explicit grant. */
    rbacFlags: { salaryAuthorized: false },
    navAccess: [
      ...ACCESS_MANAGER,
      "organization",
      "jobs",
      "recruiting",
      "agents",
      "reportbuilder",
      "exitsadmin",
      // no compensation — salary stays restricted unless salaryAuthorized
    ],
  }),
  account({
    id: "demo-compensation",
    employeeCode: "CMP6201",
    fullName: "Helen Brooks",
    personaLabel: "Compensation",
    role: "compensation_admin",
    designation: "Compensation & Benefits Manager",
    email: "helen.brooks@infotech.com",
    password: "Comp@6201",
    mobile: "+1 646 555 0177",
    address: "New York, USA",
    timeZone: "America/New_York",
    countryCode: "US",
    countryName: "United States",
    legalEntity: "Infotech Inc",
    location: "New York",
    department: "Total Rewards",
    currency: "USD",
    shiftHours: "09:00 AM to 06:00 PM",
    /** Reports to HR; compensation access is from Compensation role, not chart position. */
    reportsToId: "demo-hr-admin",
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
      "reportbuilder",
    ],
  }),
  account({
    id: "demo-admin",
    employeeCode: "ADM8001",
    fullName: "Alex Morgan",
    personaLabel: "Admin",
    role: "admin",
    designation: "Platform Administrator",
    email: "alex.morgan@infotech.com",
    password: "Admin@8001",
    mobile: "+44 20 7946 0991",
    address: "London, UK",
    timeZone: "Europe/London",
    countryCode: "GB",
    countryName: "United Kingdom",
    legalEntity: "Infotech UK Ltd",
    location: "London",
    department: "IT",
    currency: "GBP",
    shiftHours: "09:00 AM to 05:30 PM",
    reportsToId: "demo-ceo",
    navAccess: ACCESS_ADMIN,
  }),
];

export type DemoOrgNode = DemoAccount & { children: DemoOrgNode[] };

/** Display order under a leader (story-friendly, not alphabetical). */
const ORG_CHILD_ORDER: Record<string, string[]> = {
  "demo-ceo": ["emp-ram", "demo-hr-admin", "demo-hiring-manager", "demo-admin"],
  "emp-ram": ["emp-mahesh"],
  "demo-hr-admin": ["demo-recruiter", "demo-compensation"],
};

/** Build reporting tree for the 8 demo personas (Jordan at root). */
export function buildDemoOrgTree(accounts: readonly DemoAccount[] = DEMO_ACCOUNTS): DemoOrgNode[] {
  const byId = new Map(accounts.map((a) => [a.id, { ...a, children: [] as DemoOrgNode[] }]));
  const roots: DemoOrgNode[] = [];
  for (const node of byId.values()) {
    const parentId = node.reportsToId;
    if (parentId && byId.has(parentId) && parentId !== node.id) {
      byId.get(parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const sortNodes = (nodes: DemoOrgNode[], parentId?: string) => {
    const preferred = parentId ? ORG_CHILD_ORDER[parentId] : ["demo-ceo"];
    nodes.sort((a, b) => {
      if (preferred) {
        const ia = preferred.indexOf(a.id);
        const ib = preferred.indexOf(b.id);
        if (ia >= 0 || ib >= 0) return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
      }
      return a.fullName.localeCompare(b.fullName);
    });
    nodes.forEach((n) => sortNodes(n.children, n.id));
  };
  sortNodes(roots);
  return roots;
}

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

/** Everyone above this person in the reporting line, nearest first (manager, their manager, …). */
/** Engineering teammates who aren't sign-in personas but appear in leave, tasks and timesheets. */
const TEAMMATE_REPORTS_TO: Record<string, string> = {
  "emp-priya": "emp-ram",
  "emp-anu": "emp-ram",
  "emp-kabir": "emp-ram",
  "emp-diya": "emp-ram",
};

export function managementChain(employeeId: string, accounts: readonly DemoAccount[] = DEMO_ACCOUNTS): DemoAccount[] {
  const chain: DemoAccount[] = [];
  const seen = new Set<string>([employeeId]);
  let current =
    accounts.find((a) => a.id === employeeId) ??
    (TEAMMATE_REPORTS_TO[employeeId]
      ? ({ id: employeeId, reportsToId: TEAMMATE_REPORTS_TO[employeeId] } as DemoAccount)
      : undefined);
  while (current?.reportsToId && !seen.has(current.reportsToId)) {
    const manager = accounts.find((a) => a.id === current!.reportsToId);
    if (!manager) break;
    chain.push(manager);
    seen.add(manager.id);
    current = manager;
  }
  return chain;
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
