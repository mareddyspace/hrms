/**
 * Infotech frontend RBAC — single source of truth for the 8 demo roles.
 * Frontend-only checks today; shape is ready for backend policy claims later.
 *
 * Roles: Employee · Manager · HR · Recruiter · Hiring Manager · Executive · Compensation · Admin
 */
import type { DemoAccount, NavAccessId, RbacFlags } from "../demoAccounts.ts";
import { accountHasNavAccess } from "../demoAccounts.ts";

export type { RbacFlags };

export type Visibility = "full" | "masked" | "hidden";

/** How much of another person's employee record the viewer may open. */
export type ProfileDepth =
  | "none"
  | "own"
  | "basic"
  | "team"
  | "full_hr"
  | "candidate";

/** Analytics / report domains enforced in UI. */
export type ReportScope =
  | "self"
  | "team"
  | "hr"
  | "recruiting"
  | "hiring"
  | "compensation"
  | "company"
  | "system";

export type PeopleListScope = "none" | "self" | "team" | "org" | "global";

export interface SubjectContext {
  subjectId: string;
  selfId: string;
  /** Subject reports to viewer (manager / HM team). */
  isDirectReport?: boolean;
  /** Same department / org unit as HR demo scope. */
  inHrScope?: boolean;
  /** Subject is on a req the viewer owns or is panel on. */
  inRecruitingScope?: boolean;
}

export function rbacFlags(viewer: DemoAccount): RbacFlags {
  return viewer.rbacFlags ?? {};
}

function isSelf(ctx: SubjectContext): boolean {
  return ctx.subjectId === ctx.selfId;
}

function isHr(role: DemoAccount["role"]): boolean {
  return role === "hr_admin" || role === "hr" || role === "hrbp";
}

function isExecutive(role: DemoAccount["role"]): boolean {
  return role === "executive" || role === "founder" || role === "cofounder";
}

function isAdminPlatform(role: DemoAccount["role"]): boolean {
  return role === "admin" || role === "it_admin" || role === "super_admin" || role === "compliance";
}

/* ───────────── Profile / people ───────────── */

/**
 * Profile depth for an employee record.
 * Everyone may view own profile as "own".
 */
export function getProfileDepth(viewer: DemoAccount, ctx: SubjectContext): ProfileDepth {
  if (isSelf(ctx)) return "own";

  const role = viewer.role;

  if (isHr(role)) {
    return ctx.inHrScope === false ? "basic" : "full_hr";
  }

  if (role === "manager" && ctx.isDirectReport) return "team";
  if (role === "hiring_manager" && (ctx.isDirectReport || ctx.inRecruitingScope)) return "team";

  if (role === "compensation_admin") return "basic"; // limited employee context for pay work
  if (isExecutive(role)) return "basic";
  if (isAdminPlatform(role)) return "basic"; // system admin ≠ full HR dossier

  if (role === "recruiter") return "none"; // use candidate APIs, not employee dossiers

  // Employee / others: no colleague profiles by default
  return "none";
}

export function canOpenEmployeeProfile(viewer: DemoAccount, ctx: SubjectContext): boolean {
  return getProfileDepth(viewer, ctx) !== "none";
}

export function canViewColleagueBasicProfile(viewer: DemoAccount, ctx: SubjectContext): boolean {
  const depth = getProfileDepth(viewer, ctx);
  return depth === "basic" || depth === "team" || depth === "full_hr" || depth === "own";
}

export function canViewFullHrRecord(viewer: DemoAccount, ctx: SubjectContext): boolean {
  const depth = getProfileDepth(viewer, ctx);
  return depth === "full_hr" || depth === "own";
}

export function canViewSensitivePii(viewer: DemoAccount, ctx: SubjectContext): boolean {
  if (isSelf(ctx)) return true;
  const depth = getProfileDepth(viewer, ctx);
  if (depth === "full_hr") return true;
  if (depth === "team" && (viewer.role === "manager" || viewer.role === "hiring_manager" || isHr(viewer.role))) {
    return true;
  }
  return false;
}

export function getPeopleListScope(viewer: DemoAccount): PeopleListScope {
  const role = viewer.role;
  if (isHr(role)) return "global";
  if (role === "compensation_admin") return "org";
  if (isExecutive(role)) return "org";
  if (role === "manager" || role === "hiring_manager") return "team";
  if (role === "recruiter") return "org"; // directory for hiring context — profiles still gated
  if (isAdminPlatform(role)) return "org"; // limited directory for admin ops
  // Everyone else with People access gets the basic company directory (see directoryFieldLevel).
  if (accountHasNavAccess(viewer, "people")) return "org";
  if (accountHasNavAccess(viewer, "team")) return "team";
  return "self";
}

/**
 * Which directory columns the viewer gets. "basic" = name, title, department, country and work email only;
 * "full" adds employee ID, status, manager, location and the other filters.
 */
export function directoryFieldLevel(viewer: DemoAccount): "basic" | "full" {
  const role = viewer.role;
  if (isHr(role) || isExecutive(role) || isAdminPlatform(role)) return "full";
  if (role === "manager" || role === "hiring_manager" || role === "compensation_admin") return "full";
  return "basic";
}

export function canManagePeopleRecords(viewer: DemoAccount): boolean {
  return isHr(viewer.role) || viewer.role === "super_admin";
}

/* ───────────── Candidates (recruiting) ───────────── */

export function candidateAccess(viewer: DemoAccount, inRecruitingScope = true): Visibility {
  const role = viewer.role;
  if (role === "recruiter") return "full";
  if (isHr(role)) return "full";
  if (role === "hiring_manager" && inRecruitingScope) return "full";
  if (isExecutive(role) && inRecruitingScope) return "masked";
  return "hidden";
}

export function canViewCandidateProfile(viewer: DemoAccount, inRecruitingScope = true): boolean {
  return candidateAccess(viewer, inRecruitingScope) !== "hidden";
}

/* ───────────── Salary & payslips ───────────── */

/**
 * Individual salary / bonus amounts.
 * - Employee: own only (masked display of figures is still allowed as "full" for own slip UI)
 * - Manager / Recruiter / Hiring Manager: never by default
 * - HR: when hrCompAuthorized (default true in demo)
 * - Executive: only when salaryAuthorized flag is true
 * - Compensation: authorized full
 * - Admin: does NOT receive confidential salary (own masked only)
 */
export function getSalaryVisibility(viewer: DemoAccount, ctx: SubjectContext): Visibility {
  const role = viewer.role;
  const flags = rbacFlags(viewer);

  if (isSelf(ctx)) {
    // Admin and everyone else may see their own pay; show full on own payslip UI
    return "full";
  }

  if (role === "compensation_admin" || role === "finance") return "full";

  if (isHr(role)) {
    return flags.hrCompAuthorized === false ? "hidden" : "full";
  }

  if (isExecutive(role)) {
    return flags.salaryAuthorized ? "full" : "hidden";
  }

  // Explicit denials
  if (role === "manager" || role === "recruiter" || role === "hiring_manager") return "hidden";
  if (isAdminPlatform(role)) return "hidden"; // platform admin ≠ pay access
  if (role === "employee") return "hidden";

  return "hidden";
}

export function canViewPayslip(viewer: DemoAccount, ctx: SubjectContext): boolean {
  return getSalaryVisibility(viewer, ctx) !== "hidden";
}

export function canViewCompensationModule(viewer: DemoAccount): boolean {
  const role = viewer.role;
  if (role === "compensation_admin" || role === "finance") return true;
  if (isHr(role) && rbacFlags(viewer).hrCompAuthorized !== false) return true;
  if (isExecutive(role) && rbacFlags(viewer).salaryAuthorized) return true;
  // Managers may see non-amount structures only via separate helper — module entry for structures
  if (role === "manager" || role === "hiring_manager") return accountHasNavAccess(viewer, "compensation");
  return accountHasNavAccess(viewer, "compensation");
}

export function canViewCompStructures(viewer: DemoAccount): boolean {
  const role = viewer.role;
  if (role === "compensation_admin" || role === "finance" || isHr(role)) return true;
  if (role === "manager" || role === "hiring_manager" || isExecutive(role)) return true;
  return accountHasNavAccess(viewer, "compensation");
}

export function canApproveCompReviews(viewer: DemoAccount): boolean {
  return viewer.role === "compensation_admin";
}

/* ───────────── Reports ───────────── */

export function getReportScopes(viewer: DemoAccount): ReportScope[] {
  const role = viewer.role;
  switch (role) {
    case "employee":
      return ["self"];
    case "manager":
      return ["self", "team"];
    case "hr":
    case "hr_admin":
    case "hrbp":
      return ["self", "team", "hr", "company"];
    case "recruiter":
      return ["self", "recruiting"];
    case "hiring_manager":
      return ["self", "team", "hiring"];
    case "executive":
    case "founder":
    case "cofounder":
      return ["self", "company"];
    case "compensation_admin":
    case "finance":
      return ["self", "compensation", "company"];
    case "admin":
    case "it_admin":
    case "super_admin":
    case "compliance":
      return ["self", "system"];
    default:
      return ["self"];
  }
}

export function canViewReport(viewer: DemoAccount, scope: ReportScope): boolean {
  return getReportScopes(viewer).includes(scope);
}

/* ───────────── Documents / letters ───────────── */

export function canManageLetters(viewer: DemoAccount): boolean {
  return isHr(viewer.role) || viewer.role === "super_admin";
}

export function canViewEmployeeDocuments(viewer: DemoAccount, ctx: SubjectContext): Visibility {
  if (isSelf(ctx)) return "full";
  if (isHr(viewer.role)) return "full";
  if (viewer.role === "compensation_admin") return "masked";
  if (viewer.role === "manager" && ctx.isDirectReport) return "masked";
  if (isExecutive(viewer.role)) return "masked";
  return "hidden";
}

/* ───────────── Module nav helper ───────────── */

export function hasModuleAccess(account: DemoAccount, module: NavAccessId): boolean {
  return accountHasNavAccess(account, module);
}

export function displayMoney(value: string, access: Visibility): string {
  if (access === "full") return value;
  if (access === "masked") return "••••••";
  return "Restricted";
}

export function formatCompAmount(visibility: Visibility, display: string, masked = "••••••"): string {
  if (visibility === "full") return display;
  if (visibility === "masked") return masked;
  return "—";
}

/** Human-readable policy blurb for UI banners. */
export function rbacPolicySummary(viewer: DemoAccount): string {
  const scopes = getReportScopes(viewer).join(", ");
  const flags = rbacFlags(viewer);
  const salaryNote =
    viewer.role === "executive"
      ? flags.salaryAuthorized
        ? "Salary access explicitly authorized."
        : "Salary / payslips not authorized for this executive."
      : viewer.role === "admin" || viewer.role === "it_admin"
        ? "Admin manages settings — no automatic salary access."
        : viewer.role === "manager" || viewer.role === "recruiter" || viewer.role === "hiring_manager"
          ? "Own payslips allowed; team/colleague salary & slips stay blocked."
          : viewer.role === "compensation_admin"
            ? "Authorized compensation & payslip access."
            : isHr(viewer.role)
              ? "HR compensation access for authorized cases."
              : "Own salary & payslips only.";
  return `${viewer.personaLabel}: reports [${scopes}]. ${salaryNote}`;
}
