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
  | "tickets"
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
  | "contractors"
  | "auditlog"
  | "mail"
  | "paypreview"
  | "policies";

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
  "tickets",
  "messages",
  "mail",
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
  "compensation", // own pay history only; others' pay stays restricted
  "exit",
  "probation",
  "immigration",
  "privacy",
  "grievances",
  "engagement",
  "internaljobs",
  "shifts",
  "optionalholidays",
  "policies",
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
  "recruiting", // managers see and act on their own requisitions only
  "probationreviews",
  "teamexits",
  "succession",
  "contractors",
  // compensation intentionally omitted — managers do not get salary records by default
];

/** Platform admin: settings & system reports — not confidential pay. */
const ACCESS_ADMIN: NavAccessId[] = [
  // Own self-service (own payslips included) plus platform tools — no team tools without a team, no others' pay.
  ...ACCESS_EMPLOYEE,
  "people",
  "organization",
  "jobs",
  "locale",
  "integrations",
  "payroll", // integration status only
  "administration",
  "bulkdata",
  "reportbuilder",
  "auditlog",
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

/** Country Managers: the CEO's direct reports who lead each country, plus country-wide reports and hiring. */
const ACCESS_COUNTRY_MANAGER: NavAccessId[] = [
  ...ACCESS_MANAGER,
  "organization",
  "jobs",
  "reportbuilder",
  // analytics, recruiting and succession already come with ACCESS_MANAGER; no compensation.
];

/*
 * Country Managers. Ids, names, phones and locations are the directory's generated country heads
 * (buildTimezWorkforce in workforce.ts), so their position and reports stay where they were.
 */
const CM_INDIA = "wf-TZ0001";
const CM_US = "wf-TZ0194";
const CM_UK = "wf-TZ0290";

const COUNTRY_MANAGER_SEEDS: {
  id: string;
  employeeCode: string;
  fullName: string;
  mobile: string;
  countryCode: NonNullable<Employee["countryCode"]>;
  countryName: string;
  legalEntity: string;
  location: string;
  timeZone: string;
  currency: string;
  shiftHours: string;
}[] = [
  { id: CM_INDIA, employeeCode: "CMG4101", fullName: "Aarav Sharma", mobile: "+91 95345 16922", countryCode: "IN", countryName: "India", legalEntity: "Infotech India Pvt Ltd", location: "Bengaluru", timeZone: "Asia/Kolkata", currency: "INR", shiftHours: "09:30 AM to 06:30 PM" },
  { id: CM_US, employeeCode: "CMG4102", fullName: "William Sharma", mobile: "+1 212 555 0190", countryCode: "US", countryName: "United States", legalEntity: "Infotech Inc", location: "New York", timeZone: "America/New_York", currency: "USD", shiftHours: "09:00 AM to 06:00 PM" },
  { id: CM_UK, employeeCode: "CMG4103", fullName: "Hans Schmidt", mobile: "+44 20 7946 0395", countryCode: "GB", countryName: "United Kingdom", legalEntity: "Infotech UK Ltd", location: "London", timeZone: "Europe/London", currency: "GBP", shiftHours: "09:00 AM to 05:30 PM" },
  { id: "wf-TZ0349", employeeCode: "CMG4104", fullName: "Mia Sharma", mobile: "+61 465 640 190", countryCode: "AU", countryName: "Australia", legalEntity: "Infotech Australia Pty", location: "Sydney", timeZone: "Australia/Sydney", currency: "AUD", shiftHours: "09:00 AM to 05:30 PM" },
  { id: "wf-TZ0389", employeeCode: "CMG4105", fullName: "Sara Patel", mobile: "+1 416 555 0518", countryCode: "CA", countryName: "Canada", legalEntity: "Infotech Canada Inc", location: "Toronto", timeZone: "America/Toronto", currency: "CAD", shiftHours: "09:00 AM to 05:00 PM" },
  { id: "wf-TZ0424", employeeCode: "CMG4106", fullName: "Rohan Mueller", mobile: "+971 50 297 3405", countryCode: "AE", countryName: "United Arab Emirates", legalEntity: "Infotech Middle East FZ", location: "Dubai", timeZone: "Asia/Dubai", currency: "AED", shiftHours: "09:00 AM to 06:00 PM" },
  { id: "wf-TZ0449", employeeCode: "CMG4107", fullName: "Sara Nair", mobile: "+966 57 006 8859", countryCode: "SA", countryName: "Saudi Arabia", legalEntity: "Infotech Saudi LLC", location: "Riyadh", timeZone: "Asia/Riyadh", currency: "SAR", shiftHours: "08:00 AM to 05:00 PM" },
  { id: "wf-TZ0469", employeeCode: "CMG4108", fullName: "Mia Khan", mobile: "+49 151 6449 7739", countryCode: "DE", countryName: "Germany", legalEntity: "Infotech Germany GmbH", location: "Berlin", timeZone: "Europe/Berlin", currency: "EUR", shiftHours: "09:00 AM to 05:30 PM" },
];

/**
 * Demo cast. Reporting line (org chart) is separate from RBAC:
 *
 *   Jordan Blake (Executive) ── root
 *   ├── Aarav Sharma (Country Manager · India)
 *   │   ├── Ram Krishnan (Manager)
 *   │   │   └── Babu Menon (Employee)       ← Ram approves Babu's leave via reporting
 *   │   └── Farhan Ali (HR)
 *   │       ├── Sophie Clark (Recruiter)    ← candidate access = Recruiter role, not chart
 *   │       └── Helen Brooks (Compensation) ← pay access = Compensation role, not chart
 *   ├── William Sharma (Country Manager · United States)
 *   │   └── Daniel Ortiz (Hiring Manager)
 *   ├── Hans Schmidt (Country Manager · United Kingdom)
 *   │   └── Alex Morgan (Admin)             ← accounts = Admin role; no auto payslips
 *   └── Country Managers for Australia, Canada, UAE, Saudi Arabia and Germany
 *
 * Country Managers keep their place in the generated directory (same wf-… id and position); the
 * directory takes their name, email and employee code from these accounts.
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
    navAccess: [...ACCESS_EMPLOYEE, "agents"], // AI agents are for employees only
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
    reportsToId: CM_INDIA,
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
    reportsToId: CM_INDIA,
    rbacFlags: { hrCompAuthorized: true },
    navAccess: [
      ...ACCESS_MANAGER,
      "organization",
      "jobs",
      "onboarding",
      "compensation",
      "locale",
      "administration",
      "exitsadmin",
      "bgv",
      "bulkdata",
      "reportbuilder",
      "auditlog",
      "paypreview",
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
    reportsToId: CM_US,
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
    // The CEO is exempt from project timesheets and probation.
    navAccess: [
      ...ACCESS_MANAGER.filter((id) => id !== "timesheet" && id !== "probation"),
      "organization",
      "jobs",
      "recruiting",
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
      "analytics",
      "compensation",
      "payroll",
      "payslips",
      "reportbuilder",
      "paypreview",
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
    reportsToId: CM_UK,
    navAccess: ACCESS_ADMIN,
  }),
  ...COUNTRY_MANAGER_SEEDS.map((cm) =>
    account({
      id: cm.id,
      employeeCode: cm.employeeCode,
      fullName: cm.fullName,
      personaLabel: `Country Manager · ${cm.countryName}`,
      role: "manager",
      designation: "Country Manager",
      email: `${cm.fullName.toLowerCase().replace(/\s+/g, ".")}@infotech.com`,
      password: `CountryMgr@${cm.employeeCode.replace(/\D/g, "")}`,
      mobile: cm.mobile,
      address: `${cm.location}, ${cm.countryName}`,
      timeZone: cm.timeZone,
      countryCode: cm.countryCode,
      countryName: cm.countryName,
      legalEntity: cm.legalEntity,
      location: cm.location,
      department: "Executive",
      currency: cm.currency,
      shiftHours: cm.shiftHours,
      reportsToId: "demo-ceo",
      navAccess: ACCESS_COUNTRY_MANAGER,
    }),
  ),
];

/** Ids of the Country Manager sign-in accounts (they hold the directory's generated country-head seats). */
export const COUNTRY_MANAGER_IDS: ReadonlySet<string> = new Set(COUNTRY_MANAGER_SEEDS.map((cm) => cm.id));

/** Sections of the development sign-in list, in display order. */
export const DEMO_ACCOUNT_GROUPS = ["Leadership", "HR & Admin", "Managers", "Employees"] as const;
export type DemoAccountGroup = (typeof DEMO_ACCOUNT_GROUPS)[number];

const HR_ADMIN_ROLES: readonly string[] = ["hr", "hr_admin", "hrbp", "recruiter", "compensation_admin", "admin", "super_admin", "it_admin"];

export function demoAccountGroup(account: Pick<DemoAccount, "id" | "role">): DemoAccountGroup {
  if (account.role === "executive" || account.role === "founder" || account.role === "cofounder" || COUNTRY_MANAGER_IDS.has(account.id)) {
    return "Leadership";
  }
  if (HR_ADMIN_ROLES.includes(account.role)) return "HR & Admin";
  if (account.role === "manager" || account.role === "hiring_manager") return "Managers";
  return "Employees";
}

/** Accounts split into the sign-in list's sections (empty sections left out). */
export function groupDemoAccounts<T extends Pick<DemoAccount, "id" | "role">>(
  accounts: readonly T[],
): { group: DemoAccountGroup; accounts: T[] }[] {
  return DEMO_ACCOUNT_GROUPS.map((group) => ({ group, accounts: accounts.filter((a) => demoAccountGroup(a) === group) })).filter(
    (g) => g.accounts.length > 0,
  );
}

export type DemoOrgNode = DemoAccount & { children: DemoOrgNode[] };

/** Display order under a leader (story-friendly, not alphabetical). */
const ORG_CHILD_ORDER: Record<string, string[]> = {
  "demo-ceo": ["wf-TZ0001", "wf-TZ0194", "wf-TZ0290", "wf-TZ0349", "wf-TZ0389", "wf-TZ0424", "wf-TZ0449", "wf-TZ0469"],
  "wf-TZ0001": ["emp-ram", "demo-hr-admin"],
  "emp-ram": ["emp-mahesh"],
  "demo-hr-admin": ["demo-recruiter", "demo-compensation"],
};

/** Build reporting tree for the sign-in accounts (Jordan at root). */
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

/**
 * The directory's reporting line (wired up in store.tsx): returns the managers above a person, nearest first,
 * or null when the person isn't in the directory. One source, so the org chart and approvals always agree.
 */
let directoryChainSource: (employeeId: string) => { id: string; fullName: string }[] | null = () => null;

export function setDirectoryChainSource(source: (employeeId: string) => { id: string; fullName: string }[] | null): void {
  directoryChainSource = source;
}

export function managementChain(employeeId: string, accounts: readonly DemoAccount[] = DEMO_ACCOUNTS): DemoAccount[] {
  const fromDirectory = directoryChainSource(employeeId);
  if (fromDirectory) {
    // Managers who aren't sign-in personas are returned with just their id and name.
    return fromDirectory.map(
      (m) => accounts.find((a) => a.id === m.id) ?? DEMO_ACCOUNTS.find((a) => a.id === m.id) ?? ({ id: m.id, fullName: m.fullName } as DemoAccount),
    );
  }
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

/** Per-account grants/revokes saved by an admin in the role editor (wired up in store.tsx). */
let navOverrideSource: (accountId: string) => { grant: string[]; revoke: string[] } | null = () => null;

export function setNavOverrideSource(source: (accountId: string) => { grant: string[]; revoke: string[] } | null): void {
  navOverrideSource = source;
}

export function accountHasNavAccess(account: DemoAccount, linkId: string): boolean {
  const override = navOverrideSource(account.id);
  if (override?.revoke.includes(linkId)) return false;
  if (override?.grant.includes(linkId)) return true;
  if (account.navAccess.includes("*")) return true;
  return account.navAccess.includes(linkId as NavAccessId);
}

/** @deprecated Prefer DEMO_ACCOUNTS from this module */
export const TIMEZ_PERSONAS = DEMO_ACCOUNTS;
