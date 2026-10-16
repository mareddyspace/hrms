import { DEMO_ACCOUNTS, managementChain, type DemoAccount } from "../../demoAccounts.ts";
import { canManagePeople } from "../../data/peoplePermissions.ts";
import { getBasePeople, type PersonRecord } from "../../data/peopleData.ts";
import { getPerson } from "../../data/peopleLocal.ts";
import { addDaysISO, parseISODate, toISO, type UserRole } from "../../model.ts";

/** Who is acting — the signed-in persona. */
export type LifecycleActor = Pick<DemoAccount, "id" | "fullName" | "role">;
/** null when the change was applied, otherwise the reason it was refused. */
export type LifecycleResult = string | null;

export function isHrRole(role: UserRole): boolean {
  return canManagePeople(role);
}

/** Everyone above this person in the reporting line (directory manager first, then the persona chain). */
export function reportingLineIds(employeeId: string): string[] {
  const ids: string[] = [];
  const push = (id: string | undefined) => {
    if (id && id !== employeeId && !ids.includes(id)) ids.push(id);
  };
  for (const manager of managementChain(employeeId)) push(manager.id);
  const directManager = getPerson(employeeId)?.managerId;
  if (directManager) {
    push(directManager);
    for (const manager of managementChain(directManager)) push(manager.id);
  }
  return ids;
}

export function isAboveInLine(actorId: string, employeeId: string): boolean {
  return actorId !== employeeId && reportingLineIds(employeeId).includes(actorId);
}

/** Reporting line or HR — never the person themselves. */
export function canActForEmployee(actor: LifecycleActor, employeeId: string): boolean {
  if (actor.id === employeeId) return false;
  return isHrRole(actor.role) || isAboveInLine(actor.id, employeeId);
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidISO(value: string): boolean {
  if (!ISO_RE.test(value)) return false;
  return toISO(parseISODate(value)) === value;
}

export function addMonthsISO(iso: string, months: number): string {
  const date = parseISODate(iso);
  const day = date.getDate();
  date.setDate(1);
  date.setMonth(date.getMonth() + months);
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  date.setDate(Math.min(day, lastDay));
  return toISO(date);
}

export function daysBetween(fromISO: string, toISOValue: string): number {
  const ms = parseISODate(toISOValue).getTime() - parseISODate(fromISO).getTime();
  return Math.round(ms / 86_400_000);
}

export function countryCodeFor(employeeId: string, fallback?: string): string {
  const person = getPerson(employeeId);
  const code = person?.countryCode ?? DEMO_ACCOUNTS.find((a) => a.id === employeeId)?.countryCode ?? fallback;
  return String(code ?? "IN");
}

export function isContractor(person: Pick<PersonRecord, "employmentType" | "employmentStatus"> | undefined): boolean {
  if (!person) return false;
  return person.employmentStatus === "Contractor" || /contract/i.test(person.employmentType);
}

/* ───────────── Notice periods ───────────── */

export const NOTICE_POLICY: { code: string; country: string; days: number; basis: string }[] = [
  { code: "IN", country: "India", days: 30, basis: "Employment contract" },
  { code: "AE", country: "United Arab Emirates", days: 30, basis: "Labour law minimum" },
  { code: "SA", country: "Saudi Arabia", days: 30, basis: "Labour law minimum" },
  { code: "GB", country: "United Kingdom", days: 30, basis: "Employment contract" },
  { code: "US", country: "United States", days: 14, basis: "At-will courtesy notice" },
  { code: "AU", country: "Australia", days: 28, basis: "Fair Work notice" },
  { code: "CA", country: "Canada", days: 14, basis: "Provincial standard" },
  { code: "DE", country: "Germany", days: 30, basis: "Statutory notice" },
];

export const CONTRACTOR_NOTICE_DAYS = 7;

export function noticeDaysFor(employeeId: string): number {
  const person = getPerson(employeeId);
  if (isContractor(person)) return CONTRACTOR_NOTICE_DAYS;
  const code = countryCodeFor(employeeId);
  return NOTICE_POLICY.find((row) => row.code === code)?.days ?? 30;
}

/* ───────────── Probation periods ───────────── */

export const PROBATION_POLICY: { code: string; country: string; months?: number; days?: number }[] = [
  { code: "IN", country: "India", months: 6 },
  { code: "AE", country: "United Arab Emirates", months: 6 },
  { code: "SA", country: "Saudi Arabia", days: 90 },
  { code: "GB", country: "United Kingdom", months: 6 },
  { code: "US", country: "United States", days: 90 },
  { code: "AU", country: "Australia", months: 6 },
  { code: "CA", country: "Canada", months: 3 },
  { code: "DE", country: "Germany", months: 6 },
];

export function probationPolicyFor(countryCode: string) {
  return PROBATION_POLICY.find((row) => row.code === countryCode) ?? { code: countryCode, country: countryCode, months: 6 };
}

export function probationLabel(countryCode: string): string {
  const policy = probationPolicyFor(countryCode);
  return policy.days ? `${policy.days} days` : `${policy.months} months`;
}

/** Base probation end (before extensions). */
export function baseProbationEnd(joiningISO: string, countryCode: string): string {
  const policy = probationPolicyFor(countryCode);
  return policy.days ? addDaysISO(joiningISO, policy.days) : addMonthsISO(joiningISO, policy.months ?? 6);
}

/** Inverse of baseProbationEnd — used to seed joiners whose probation ends on a chosen date. */
export function joiningForProbationEnd(endISO: string, countryCode: string): string {
  const policy = probationPolicyFor(countryCode);
  return policy.days ? addDaysISO(endISO, -policy.days) : addMonthsISO(endISO, -(policy.months ?? 6));
}

/* ───────────── Seed helpers ───────────── */

/** Stable list of non-persona directory employees reporting to Ram — used only for seed data. */
export function seedCandidates(): PersonRecord[] {
  const personaIds = new Set(DEMO_ACCOUNTS.map((a) => a.id));
  return getBasePeople()
    .filter(
      (p) =>
        p.managerId === "emp-ram" &&
        p.employmentStatus === "Active" &&
        !personaIds.has(p.id) &&
        !/contract/i.test(p.employmentType),
    )
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function personName(employeeId: string, fallback = "Unknown"): string {
  return getPerson(employeeId)?.fullName ?? DEMO_ACCOUNTS.find((a) => a.id === employeeId)?.fullName ?? fallback;
}
