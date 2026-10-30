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
  | "approvalsmenu"
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
  | "policies"
  | "projects"
  | "encashment"
  | "cashadvance"
  | "assets"
  | "software"
  | "hrcases"
  | "travel"
  | "workflowsconfig"
  | "emailoutbox"
  | "lifecycleactions"
  | "recognition"
  | "accessroles"
  | "aisettings"
  | "leavepolicies";

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
  "projects",
  "encashment",
  "cashadvance",
  "assets",
  "software",
  "travel",
  "recognition",
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
  "lifecycleactions",
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
  "approvalsmenu",
  "workflowsconfig",
  "emailoutbox",
  "lifecycleactions",
  "accessroles", // Roles & permissions (/admin/roles)
  "aisettings", // AI settings (/admin/ai)
  "leavepolicies", // Leave policies (/admin/leave-policies)
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
 * The six sign-in accounts. Reporting line (org chart) is separate from RBAC:
 *
 *   Jordan Blake (Executive) ── root
 *   ├── Farhan Ali (HR)
 *   │   └── Sophie Clark (Recruiter)    ← candidate access = Recruiter role, not chart
 *   │       (HR also owns compensation & benefits: final pay approvals, benefits, pay preview)
 *   ├── Ram Krishnan (Manager)
 *   │   └── Babu Menon (Employee)       ← Ram approves Babu's leave via reporting
 *   └── Alex Morgan (Admin)             ← accounts = Admin role; no auto payslips
 *
 * The generated directory's Country Managers (wf-TZ0001 … wf-TZ0469) are ordinary people who cannot sign in.
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
    reportsToId: "demo-ceo",
    navAccess: [...ACCESS_MANAGER, "onboarding"], // follows new joiners in the team
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
    reportsToId: "demo-ceo",
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
      "payroll", // HR owns compensation & benefits: payroll status and pay preview
      "paypreview",
      "hrcases",
      "integrations", // sync health for payroll and HR data
      "leavepolicies", // Leave policies (/admin/leave-policies)
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
    legalEntity: "TimeZ USA Inc",
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
    legalEntity: "TimeZ USA Inc",
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
    reportsToId: "demo-ceo",
    navAccess: ACCESS_ADMIN,
  }),
];

/**
 * Sign-in accounts that were retired. Saved browser data that still mentions them is dropped on load.
 * (The Compensation & Benefits persona was removed — HR now owns compensation & benefits. The Hiring Manager persona
 * was removed — line managers raise requisitions; his now sit with the CEO.)
 */
export const RETIRED_ACCOUNT_IDS: ReadonlySet<string> = new Set(["demo-compensation", "demo-hiring-manager"]);
export const RETIRED_ACCOUNT_NAMES: ReadonlySet<string> = new Set(["Helen Brooks", "Daniel Ortiz"]);

/**
 * The eight Country Managers no longer sign in. They are still people in the generated directory, so records that
 * mention them stay; only a saved session or per-account settings for them are cleared on load.
 */
export const RETIRED_COUNTRY_MANAGER_IDS: ReadonlySet<string> = new Set([
  "wf-TZ0001", "wf-TZ0194", "wf-TZ0290", "wf-TZ0349", "wf-TZ0389", "wf-TZ0424", "wf-TZ0449", "wf-TZ0469",
]);

/** Every id that was once a sign-in account and no longer is: a saved session for any of them is signed out. */
export const RETIRED_SIGN_IN_IDS: ReadonlySet<string> = new Set([...RETIRED_ACCOUNT_IDS, ...RETIRED_COUNTRY_MANAGER_IDS]);

/**
 * The directory seat that took over a retired account's reports: the Hiring Manager led US Product, now led by the
 * generated US Head of Product (wf-TZ0490).
 */
export const RETIRED_SEAT_SUCCESSOR: Readonly<Record<string, { id: string; fullName: string }>> = {
  "demo-hiring-manager": { id: "wf-TZ0490", fullName: "James Iyer" },
};

/** True when a saved record (any shape) points at a retired account by id or name. */
export function mentionsRetiredAccount(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const text = JSON.stringify(value);
  for (const id of RETIRED_ACCOUNT_IDS) if (text.includes(`"${id}"`)) return true;
  for (const name of RETIRED_ACCOUNT_NAMES) if (text.includes(name)) return true;
  return false;
}

export type DemoOrgNode = DemoAccount & { children: DemoOrgNode[] };

/** Display order under a leader (story-friendly, not alphabetical). */
const ORG_CHILD_ORDER: Record<string, string[]> = {
  "demo-ceo": ["demo-hr-admin", "emp-ram", "demo-admin"],
  "emp-ram": ["emp-mahesh"],
  "demo-hr-admin": ["demo-recruiter"],
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

/** Lower-cased, trimmed sign-in email; addresses from before the rename (@infotech.com) map to @timez.com. */
export function normalizeSignInEmail(value: string): string {
  return value.trim().toLowerCase().replace(/@infotech\.com$/, "@timez.com");
}

export function findDemoByEmailOrCode(value: string): DemoAccount | undefined {
  const needle = normalizeSignInEmail(value);
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

/**
 * Page access set in Admin → Roles & permissions (src/data/accessControl.ts). When an account has an entry here it
 * fully decides that account's pages: role baseline plus its grants, minus its revokes. Read straight from storage so
 * it applies from the first render, before any page loads the access store.
 */
export const PAGE_ACCESS_KEY = "timez.access.pages.v1";
export type PageAccessOverride = { grant: string[]; revoke: string[] };
let pageAccessCache: Record<string, PageAccessOverride> | null = null;

export function getPageAccessOverrides(): Record<string, PageAccessOverride> {
  if (pageAccessCache) return pageAccessCache;
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(PAGE_ACCESS_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, Partial<PageAccessOverride>>) : {};
    const clean = (list: unknown) => (Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : []);
    pageAccessCache = Object.fromEntries(
      Object.entries(parsed && typeof parsed === "object" ? parsed : {}).map(([id, v]) => [id, { grant: clean(v?.grant), revoke: clean(v?.revoke) }]),
    );
  } catch {
    pageAccessCache = {};
  }
  return pageAccessCache;
}

/** Called by the access store after it saves, so the sidebar and route guards follow at once. */
export function setPageAccessOverrides(map: Record<string, PageAccessOverride>): void {
  pageAccessCache = map;
}

/** Page access without the Roles & permissions page edits (role baseline plus Console role edits). */
export function accountDefaultNavAccess(account: DemoAccount, linkId: string): boolean {
  const override = navOverrideSource(account.id);
  if (override?.revoke.includes(linkId)) return false;
  if (override?.grant.includes(linkId)) return true;
  if (account.navAccess.includes("*")) return true;
  return account.navAccess.includes(linkId as NavAccessId);
}

export function accountHasNavAccess(account: DemoAccount, linkId: string): boolean {
  const page = getPageAccessOverrides()[account.id];
  if (page) {
    if (page.revoke.includes(linkId)) return false;
    if (page.grant.includes(linkId)) return true;
    return account.navAccess.includes("*") || account.navAccess.includes(linkId as NavAccessId);
  }
  return accountDefaultNavAccess(account, linkId);
}

/** @deprecated Prefer DEMO_ACCOUNTS from this module */
export const TIMEZ_PERSONAS = DEMO_ACCOUNTS;
