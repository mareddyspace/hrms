/**
 * Live numbers for homes, Analytics and Copilot — built from the people directory and portal state,
 * so every screen agrees and nothing is hard-coded.
 */
import { DEMO_ACCOUNTS, managementChain, type DemoAccount } from "../demoAccounts.ts";
import {
  TIMEZ_COUNTRIES,
  addDaysISO,
  holidaysForCountry,
  parseISODate,
  type CountryCode,
  type Holiday,
  type PortalState,
} from "../model.ts";
import type { PersonRecord } from "./peopleData.ts";
import { getExitDetails } from "./peopleLocal.ts";
import { taskPersonById } from "./taskTeam.ts";
import { getAttendanceState } from "./attendanceLocal.ts";
import { isWaitingOn } from "./expenseFlow.ts";
import { getTravelRequests } from "./travelStore.ts";
import { getShiftState } from "../features/workforce/shiftsStore.ts";

export type RangeKey = "7d" | "30d" | "90d" | "ytd";

/* ───────────── Business units (derived from country so totals always match the country table) ───────────── */

const BU_BY_COUNTRY: Record<CountryCode, string> = {
  IN: "TimeZ India",
  US: "TimeZ Americas",
  CA: "TimeZ Americas",
  GB: "TimeZ EMEA",
  DE: "TimeZ EMEA",
  AE: "TimeZ EMEA",
  SA: "TimeZ EMEA",
  AU: "TimeZ APAC",
};

export function businessUnitFor(code: string): string {
  return BU_BY_COUNTRY[code as CountryCode] ?? "Other";
}

export function rangeStart(range: RangeKey, today: string): string {
  if (range === "ytd") return `${today.slice(0, 4)}-01-01`;
  return addDaysISO(today, range === "7d" ? -6 : range === "30d" ? -29 : -89);
}

export function rangeLabel(range: RangeKey): string {
  return range === "7d" ? "Last 7 days" : range === "30d" ? "Last 30 days" : range === "90d" ? "Last 90 days" : "Year to date";
}

function countBy<T>(items: readonly T[], key: (item: T) => string): { name: string; count: number }[] {
  const map = new Map<string, number>();
  for (const item of items) map.set(key(item), (map.get(key(item)) ?? 0) + 1);
  return [...map.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
}

export interface WorkforceStats {
  headcount: number;
  joiners: number;
  exits: number;
  /** Exits in the range as a share of current headcount. */
  attritionPct: number;
  byCountry: { code: string; name: string; count: number }[];
  byDepartment: { name: string; count: number }[];
  byBusinessUnit: { name: string; count: number }[];
  departments: string[];
}

/** Headcount and movement from the directory, filtered by country and department. */
export function workforceStats(
  people: readonly PersonRecord[],
  filter: { country: CountryCode | "ALL"; department?: string; range: RangeKey; today: string },
): WorkforceStats {
  const inScope = people.filter(
    (p) =>
      (filter.country === "ALL" || p.countryCode === filter.country) &&
      (!filter.department || filter.department === "All departments" || p.department === filter.department),
  );
  const active = inScope.filter((p) => p.employmentStatus !== "Terminated");
  const from = rangeStart(filter.range, filter.today);
  const joiners = active.filter((p) => p.dateOfJoining >= from && p.dateOfJoining <= filter.today).length;
  const exits = inScope.filter((p) => {
    if (p.employmentStatus !== "Terminated") return false;
    const date = getExitDetails(p).exitDate;
    return Boolean(date && date >= from && date <= filter.today);
  }).length;
  const countryRows = TIMEZ_COUNTRIES.map((c) => ({
    code: c.code as string,
    name: c.name as string,
    count: active.filter((p) => p.countryCode === c.code).length,
  })).filter((c) => filter.country === "ALL" || c.code === filter.country);
  return {
    headcount: active.length,
    joiners,
    exits,
    attritionPct: active.length ? Number(((exits / active.length) * 100).toFixed(1)) : 0,
    byCountry: countryRows,
    byDepartment: countBy(active, (p) => p.department || "Other"),
    byBusinessUnit: countBy(active, (p) => businessUnitFor(String(p.countryCode))),
    departments: [...new Set(people.map((p) => p.department).filter(Boolean))].sort(),
  };
}

/* ───────────── Workforce insights (computed facts for HR / executive homes) ───────────── */

export interface WorkforceInsight {
  id: string;
  text: string;
}

/** Years between two ISO dates, one decimal. */
export function yearsBetween(fromISO: string, toISO: string): number {
  const ms = parseISODate(toISO).getTime() - parseISODate(fromISO).getTime();
  return Math.max(0, ms / (365.25 * 86400000));
}

/** Short tenure label, e.g. "3 yrs 4 mos" or "5 mos". */
export function tenureLabel(fromISO: string, toISO: string): string {
  if (!fromISO) return "—";
  const from = parseISODate(fromISO);
  const to = parseISODate(toISO);
  let months = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
  if (to.getDate() < from.getDate()) months -= 1;
  months = Math.max(0, months);
  const y = Math.floor(months / 12);
  const m = months % 12;
  if (!y) return `${m} mo${m === 1 ? "" : "s"}`;
  return m ? `${y} yr${y === 1 ? "" : "s"} ${m} mo${m === 1 ? "" : "s"}` : `${y} yr${y === 1 ? "" : "s"}`;
}

/** 3–5 short facts computed from the directory: attrition, tenure, span of control, largest department, contractors. */
export function workforceInsights(
  people: readonly PersonRecord[],
  country: CountryCode | "ALL",
  today: string,
): WorkforceInsight[] {
  const inScope = people.filter((p) => country === "ALL" || p.countryCode === country);
  const active = inScope.filter((p) => p.employmentStatus !== "Terminated");
  if (!active.length) return [];
  const yearAgo = addDaysISO(today, -365);
  const exits12 = inScope.filter((p) => {
    if (p.employmentStatus !== "Terminated") return false;
    const d = getExitDetails(p).exitDate;
    return Boolean(d && d >= yearAgo && d <= today);
  }).length;
  const startHeadcount = inScope.filter(
    (p) => p.dateOfJoining <= yearAgo && (p.employmentStatus !== "Terminated" || (getExitDetails(p).exitDate ?? "") >= yearAgo),
  ).length;
  const avgHeadcount = (startHeadcount + active.length) / 2 || active.length;
  const attrition = ((exits12 / avgHeadcount) * 100).toFixed(1);
  const avgTenure = active.reduce((n, p) => n + yearsBetween(p.dateOfJoining, today), 0) / active.length;
  const reports = new Map<string, number>();
  for (const p of active) if (p.managerId && p.managerId !== p.id) reports.set(p.managerId, (reports.get(p.managerId) ?? 0) + 1);
  const managers = [...reports.values()];
  const span = managers.length ? managers.reduce((a, b) => a + b, 0) / managers.length : 0;
  const widest = Math.max(0, ...managers);
  const largest = countBy(active, (p) => p.department || "Other")[0];
  const contractors = active.filter((p) => p.employmentStatus === "Contractor" || /contract/i.test(p.employmentType)).length;
  const joiners12 = active.filter((p) => p.dateOfJoining >= yearAgo && p.dateOfJoining <= today).length;
  const out: WorkforceInsight[] = [
    { id: "attrition", text: `Attrition over the last 12 months is ${attrition}% (${exits12} exit${exits12 === 1 ? "" : "s"}, ${joiners12} joiner${joiners12 === 1 ? "" : "s"}).` },
    { id: "tenure", text: `Average tenure is ${avgTenure.toFixed(1)} years across ${active.length} people.` },
    {
      id: "span",
      text: managers.length
        ? `${managers.length} people manage others, with an average span of control of ${span.toFixed(1)} (widest ${widest}).`
        : "Nobody in this scope has direct reports.",
    },
  ];
  if (largest) {
    out.push({ id: "largest", text: `${largest.name} is the largest department with ${largest.count} people (${Math.round((largest.count / active.length) * 100)}%).` });
  }
  if (contractors) {
    out.push({ id: "contractors", text: `${contractors} contractor${contractors === 1 ? "" : "s"} make up ${Math.round((contractors / active.length) * 100)}% of the workforce.` });
  }
  return out.slice(0, 5);
}

/* ───────────── Team below the viewer ───────────── */

export interface TeamMember {
  id: string;
  name: string;
  designation: string;
  department: string;
  countryCode: string;
  /** Reports straight to the viewer. */
  direct: boolean;
}

function directManagerOf(id: string, people: Map<string, PersonRecord>): string | undefined {
  const chain = managementChain(id, DEMO_ACCOUNTS);
  return chain[0]?.id ?? people.get(id)?.managerId;
}

/**
 * Everyone below the viewer in the reporting line: anyone the viewer decides for (canDecideFor),
 * plus everyone whose directory manager chain reaches the viewer. Terminated people are left out.
 */
export function teamBelow(
  viewerId: string,
  people: readonly PersonRecord[],
  canDecideFor: (id: string) => boolean,
  extraIds: readonly string[] = [],
): TeamMember[] {
  const byId = new Map(people.map((p) => [p.id, p]));
  const reaches = (id: string): boolean => {
    if (canDecideFor(id)) return true;
    const seen = new Set<string>([id]);
    let cursor = byId.get(id)?.managerId;
    while (cursor && !seen.has(cursor)) {
      if (cursor === viewerId) return true;
      seen.add(cursor);
      cursor = byId.get(cursor)?.managerId;
    }
    return false;
  };
  const candidates = new Set<string>([...people.map((p) => p.id), ...DEMO_ACCOUNTS.map((a) => a.id), ...extraIds]);
  const out: TeamMember[] = [];
  for (const id of candidates) {
    if (id === viewerId || !reaches(id)) continue;
    const person = byId.get(id);
    if (person?.employmentStatus === "Terminated") continue;
    const demo: DemoAccount | undefined = DEMO_ACCOUNTS.find((a) => a.id === id);
    const teammate = taskPersonById(id);
    out.push({
      id,
      name: demo?.fullName ?? person?.fullName ?? teammate?.fullName ?? id,
      designation: demo?.designation ?? person?.designation ?? teammate?.role ?? "",
      department: demo?.department ?? person?.department ?? teammate?.department ?? "",
      countryCode: demo?.countryCode ?? String(person?.countryCode ?? "IN"),
      direct: directManagerOf(id, byId) === viewerId,
    });
  }
  return out.sort((a, b) => Number(b.direct) - Number(a.direct) || a.name.localeCompare(b.name));
}

/* ───────────── Today's status ───────────── */

export type DayStatus = "Working" | "WFH" | "On leave" | "Holiday" | "Weekly off";

export function dayStatus(state: PortalState, personId: string, countryCode: string, today: string): DayStatus {
  const leave = state.leaveRequests.find(
    (r) => r.employeeId === personId && r.status === "approved" && r.from <= today && r.to >= today,
  );
  if (leave) return leave.code === "wfh" || leave.code === "emergency_wfh" ? "WFH" : "On leave";
  if (holidaysForCountry(state.holidays, countryCode as CountryCode).some((h) => h.date === today)) return "Holiday";
  const dow = parseISODate(today).getDay();
  const weekendFriSat = countryCode === "AE" || countryCode === "SA";
  if (weekendFriSat ? dow === 5 || dow === 6 : dow === 0 || dow === 6) return "Weekly off";
  return "Working";
}

export function upcomingHolidays(holidays: Holiday[], countryCode: string | undefined, today: string, count = 3): Holiday[] {
  return holidaysForCountry(holidays, (countryCode ?? "IN") as CountryCode)
    .filter((h) => h.date >= today)
    .slice(0, count);
}

/* ───────────── Items waiting on the viewer (same rules as countWaitingOnMe) ───────────── */

export interface WaitingItem {
  id: string;
  employeeId: string;
  kind: string;
  detail: string;
  date: string;
}

export function waitingItems(
  state: PortalState,
  myId: string,
  canDecideFor: (id: string) => boolean,
  canVerifyProofs: boolean,
): WaitingItem[] {
  const open = (s: string) => s === "pending" || s === "submitted";
  const mine = (id: string) => id !== myId && canDecideFor(id);
  const items: WaitingItem[] = [];
  const add = (list: { id: string; employeeId: string; status: string }[], kind: string, detail: (x: never) => string, date: (x: never) => string) => {
    for (const x of list) if (open(x.status) && mine(x.employeeId)) items.push({ id: x.id, employeeId: x.employeeId, kind, detail: detail(x as never), date: date(x as never) });
  };
  add(state.backdatedPermissions, "Past-date leave", () => "Permission request", (x: { from?: string }) => x.from ?? "");
  add(state.leaveRequests, "Leave", (x: { code: string }) => x.code.toUpperCase(), (x: { from: string }) => x.from);
  add(state.encashments, "Encashment", (x: { days: number }) => `${x.days} days`, (x: { appliedOn: string }) => x.appliedOn);
  // Expense claims and travel follow their approval steps, like the Approvals count.
  for (const x of state.expenses) {
    if (isWaitingOn(x, myId, canDecideFor)) items.push({ id: x.id, employeeId: x.employeeId, kind: "Expense", detail: x.category, date: x.date });
  }
  for (const x of getTravelRequests()) {
    if (isWaitingOn(x, myId, canDecideFor)) items.push({ id: x.id, employeeId: x.employeeId, kind: "Travel", detail: x.toCity, date: x.departOn });
  }
  for (const c of getAttendanceState().corrections) {
    if (c.status === "Pending" && mine(c.employeeId)) items.push({ id: c.id, employeeId: c.employeeId, kind: "Attendance fix", detail: "Correction", date: c.date });
  }
  for (const w of getShiftState().swaps) {
    const teammate = w.status === "awaiting_teammate" && w.teammateId === myId;
    const manager = w.status === "awaiting_manager" && mine(w.requesterId) && mine(w.teammateId);
    if (teammate || manager) items.push({ id: w.id, employeeId: w.requesterId, kind: "Shift swap", detail: teammate ? "Asked you to swap" : "Swap", date: w.date });
  }
  add(state.reimbursements, "Reimbursement", (x: { category: string }) => x.category, (x: { date: string }) => x.date);
  add(state.cashAdvances, "Cash advance", (x: { category: string }) => x.category, (x: { date: string }) => x.date);
  add(state.assetRequests, "Asset", (x: { item: string }) => x.item, (x: { date: string }) => x.date);
  add(state.softwareRequests, "Software", (x: { software: string }) => x.software, (x: { date: string }) => x.date);
  add(state.cabBookings, "Cab", (x: { to: string }) => x.to, (x: { date: string }) => x.date);
  for (const row of state.orgTimesheets) {
    if (row.status === "submitted" && mine(row.personId)) {
      items.push({ id: row.id, employeeId: row.personId, kind: "Timesheet", detail: `${row.hours} h`, date: row.weekStart });
    }
  }
  if (canVerifyProofs) {
    for (const p of state.investmentProofs) {
      if (p.status === "submitted" && p.employeeId !== myId) {
        items.push({ id: p.id, employeeId: p.employeeId, kind: "Tax proof", detail: p.section, date: p.submittedOn });
      }
    }
  }
  return items.sort((a, b) => a.date.localeCompare(b.date));
}

/** Display name for any person id — never show raw ids. */
export function personName(id: string, people: readonly PersonRecord[]): string {
  return (
    DEMO_ACCOUNTS.find((a) => a.id === id)?.fullName ??
    people.find((p) => p.id === id)?.fullName ??
    taskPersonById(id)?.fullName ??
    "Colleague"
  );
}
