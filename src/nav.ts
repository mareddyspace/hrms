import type { DemoAccount, NavAccessId } from "./demoAccounts.ts";
import { accountHasNavAccess } from "./demoAccounts.ts";
import type { UserRole } from "./model.ts";

/** Navigation groups for the Infotech shell. Visibility is driven by demo navAccess (prototype). */
export type NavGroupKey =
  | "me"
  | "myTime"
  | "myRecords"
  | "team"
  | "people"
  | "talent"
  | "insights"
  | "admin";

export type NavLink = {
  id: string;
  label: string;
  to: string;
  /** Optional badge key resolved in Shell */
  badgeKey?: string;
};

export type NavGroup = {
  key: NavGroupKey;
  label: string;
  links: readonly NavLink[];
};

/** Always shown at the top of the sidebar (when authorized). */
export const pinnedNavLinks: readonly NavLink[] = [
  { id: "home", label: "Home", to: "/" },
] as const;

/**
 * Organised sidebar sections (role-filtered):
 * Me → Time & pay → Team → Company → Talent → Insights → Admin
 */
export const navGroups: readonly NavGroup[] = [
  {
    key: "me",
    label: "Me",
    links: [
      { id: "profile", label: "My profile", to: "/info" },
      { id: "calendar", label: "Calendar", to: "/calendar" },
      { id: "orgchart", label: "Org chart", to: "/org-chart" },
      { id: "tasks", label: "Tasks", to: "/tasks", badgeKey: "/tasks" },
      { id: "messages", label: "Messages", to: "/chat", badgeKey: "/chat" },
      { id: "notifications", label: "Notifications", to: "/notifications", badgeKey: "/notifications" },
      { id: "announcements", label: "Announcements", to: "/announcements" },
      { id: "help", label: "Helpdesk", to: "/help" },
      { id: "copilot", label: "AI Copilot", to: "/ai/copilot" },
    ],
  },
  {
    key: "myTime",
    label: "Time & pay",
    links: [
      { id: "attendance", label: "Time & attendance", to: "/attendance" },
      { id: "leave", label: "Leave & holidays", to: "/leave", badgeKey: "/leave" },
      { id: "holidays", label: "Holiday calendar", to: "/holidays" },
      { id: "timesheet", label: "My timesheets", to: "/timesheet", badgeKey: "/timesheet" },
      { id: "shifts", label: "Shifts & roster", to: "/workforce/shifts" },
      { id: "optionalholidays", label: "Optional holidays", to: "/workforce/optional-holidays" },
      { id: "payslips", label: "Payslips", to: "/payslips" },
      { id: "taxdeclarations", label: "Tax declarations", to: "/investment" },
      { id: "benefits", label: "Benefits", to: "/benefits" },
      { id: "expenses", label: "Reimbursements", to: "/expenses" },
      { id: "documents", label: "Documents & letters", to: "/documents" },
    ],
  },
  {
    key: "myRecords",
    label: "My workplace",
    links: [
      { id: "probation", label: "Probation", to: "/me/probation" },
      { id: "internaljobs", label: "Internal jobs", to: "/internal-jobs" },
      { id: "engagement", label: "Surveys", to: "/engagement-surveys" },
      { id: "immigration", label: "Visas & permits", to: "/me/immigration" },
      { id: "grievances", label: "Raise a concern", to: "/me/grievances" },
      { id: "privacy", label: "Privacy", to: "/me/privacy" },
      { id: "exit", label: "Resignation", to: "/me/exit" },
    ],
  },
  {
    key: "team",
    label: "Team",
    links: [
      { id: "team", label: "Team overview", to: "/team" },
      { id: "inbox", label: "Approvals", to: "/approvals", badgeKey: "/approvals" },
      { id: "workflows", label: "Workflows", to: "/workflows" },
      { id: "probationreviews", label: "Probation reviews", to: "/team/probation" },
      { id: "teamexits", label: "Team exits", to: "/team/exits" },
      { id: "succession", label: "Succession", to: "/succession" },
    ],
  },
  {
    key: "people",
    label: "People & organization",
    links: [
      { id: "people", label: "Directory", to: "/directory" },
      { id: "organization", label: "Organization", to: "/organization" },
      { id: "jobs", label: "Jobs", to: "/jobs" },
      { id: "compensation", label: "Compensation", to: "/compensation" },
      { id: "contractors", label: "Contractors", to: "/workforce/contractors" },
      { id: "exitsadmin", label: "Exits", to: "/people/exits" },
    ],
  },
  {
    key: "talent",
    label: "Talent",
    links: [
      { id: "recruiting", label: "Recruiting", to: "/recruiting" },
      { id: "onboarding", label: "Onboarding", to: "/onboarding" },
      { id: "bgv", label: "Background checks", to: "/talent/background-checks" },
    ],
  },
  {
    key: "insights",
    label: "Performance & learning",
    links: [
      { id: "analytics", label: "Analytics", to: "/analytics" },
      { id: "reportbuilder", label: "Report builder", to: "/data-tools/reports" },
      { id: "performance", label: "Performance", to: "/evaluations", badgeKey: "/evaluations" },
      { id: "learning", label: "Learning", to: "/programs", badgeKey: "/programs" },
      { id: "skills", label: "Skills & career", to: "/skills" },
      { id: "agents", label: "AI Agents", to: "/ai/agents" },
    ],
  },
  {
    key: "admin",
    label: "Admin",
    links: [
      { id: "locale", label: "Locale", to: "/settings/locale" },
      { id: "integrations", label: "Integrations", to: "/integrations" },
      { id: "payroll", label: "Payroll", to: "/payroll" },
      { id: "bulkdata", label: "Bulk data", to: "/data-tools/bulk" },
      { id: "auditlog", label: "Audit log", to: "/admin/audit" },
      { id: "administration", label: "Console", to: "/admin" },
    ],
  },
] as const;

/** Extra locale links (also reachable from profile menu). */
export const localeLinks = [
  { id: "locale", label: "Locale settings", to: "/settings/locale" },
  { id: "countries", label: "Country configuration", to: "/admin/countries" },
] as const;

export const aboutLinks = [
  { id: "help", label: "Help", to: "/help" },
  { id: "terms", label: "Terms", to: "/terms" },
] as const;

export function roleLabel(role: UserRole): string {
  switch (role) {
    case "manager":
      return "Manager";
    case "hr":
    case "hr_admin":
      return "HR";
    case "hrbp":
      return "HR Business Partner";
    case "recruiter":
      return "Recruiter";
    case "hiring_manager":
      return "Hiring Manager";
    case "executive":
      return "Executive";
    case "founder":
      return "Founder";
    case "cofounder":
      return "Co-founder";
    case "learning_admin":
      return "Learning Administrator";
    case "performance_admin":
      return "Performance Administrator";
    case "compensation_admin":
      return "Compensation";
    case "finance":
      return "Finance User";
    case "it_admin":
    case "admin":
      return "Admin";
    case "compliance":
      return "Compliance / Audit";
    case "super_admin":
      return "Super Admin";
    default:
      return "Employee";
  }
}

export function filterPinnedForAccount(account: DemoAccount): NavLink[] {
  return pinnedNavLinks.filter((link) => accountHasNavAccess(account, link.id));
}

export function filterNavForAccount(account: DemoAccount): NavGroup[] {
  return navGroups
    .map((group) => ({
      ...group,
      links: group.links.filter((link) => accountHasNavAccess(account, link.id)),
    }))
    .filter((group) => group.links.length > 0);
}

/** @deprecated Prefer filterNavForAccount */
export function filterNavForRole(_role: UserRole): NavGroup[] {
  return [...navGroups];
}

export function findNavLink(pathname: string): { group: NavGroup; link: NavLink } | null {
  for (const link of pinnedNavLinks) {
    if (pathname === link.to || (link.to !== "/" && pathname.startsWith(`${link.to}/`))) {
      return { group: { key: "me", label: "Me", links: pinnedNavLinks }, link };
    }
  }
  for (const group of navGroups) {
    for (const link of group.links) {
      if (pathname === link.to || (link.to !== "/" && pathname.startsWith(`${link.to}/`))) {
        return { group, link };
      }
    }
  }
  return null;
}

export function breadcrumbsFor(pathname: string): { label: string; to?: string }[] {
  const crumbs: { label: string; to?: string }[] = [{ label: "Home", to: "/" }];
  if (pathname === "/") return crumbs;
  const hit = findNavLink(pathname);
  if (hit) {
    if (hit.group.label !== "Me" || hit.link.id !== "home") {
      crumbs.push({ label: hit.group.label });
    }
    crumbs.push({ label: hit.link.label });
    return crumbs;
  }
  crumbs.push({ label: "Page" });
  return crumbs;
}

export type { NavAccessId };
