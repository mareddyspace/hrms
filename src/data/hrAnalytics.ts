/**
 * HR Home analytics — headcount breakdowns, hiring, time to hire, offers, late arrivals and team cover.
 * Everything is derived from the people directory, talent store, attendance history and leave requests.
 */
import { DEMO_ACCOUNTS } from "../demoAccounts.ts";
import { addDaysISO, holidaysForPerson, parseISODate, toISO, type PortalState } from "../model.ts";
import { gradeRank, type PersonRecord } from "./peopleData.ts";
import { buildAttendanceHistory, type AttendanceCorrection, type TodaySession } from "./attendanceData.ts";
import type { OfferRecord, Requisition } from "./talentData.ts";
import { TASK_TEAM } from "./taskTeam.ts";
import { scheduleForEmployee } from "./workSchedule.ts";

const DAY_MS = 86_400_000;
const WFH_CODES = new Set(["wfh", "emergency_wfh"]);
const active = (p: PersonRecord) => p.employmentStatus !== "Terminated";
const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0);
const daysBetween = (from: string, to: string) => Math.round((parseISODate(to).getTime() - parseISODate(from).getTime()) / DAY_MS);
const dayShort = (iso: string) => parseISODate(iso).toLocaleDateString("en-GB", { weekday: "short" });

export interface ShareRow {
  label: string;
  count: number;
  pct: number;
}

/* ───────────── Headcount analysis ───────────── */

export type HeadcountDim = "location" | "country" | "department" | "grade" | "gender" | "type" | "status" | "tenure" | "span";

export const HEADCOUNT_DIMS: { id: HeadcountDim; label: string }[] = [
  { id: "location", label: "Location" },
  { id: "country", label: "Country" },
  { id: "department", label: "Department" },
  { id: "grade", label: "Grade" },
  { id: "gender", label: "Gender" },
  { id: "type", label: "Employment type" },
  { id: "status", label: "Status" },
  { id: "tenure", label: "Tenure" },
  { id: "span", label: "Manager span" },
];

const TENURE_BANDS = ["< 1 yr", "1–3 yrs", "3–5 yrs", "5+ yrs"];
const SPAN_BANDS = ["1–3", "4–7", "8–12", "13+"];

function tenureBand(joined: string, today: string): string {
  const years = daysBetween(joined, today) / 365.25;
  if (years < 1) return TENURE_BANDS[0];
  if (years < 3) return TENURE_BANDS[1];
  if (years < 5) return TENURE_BANDS[2];
  return TENURE_BANDS[3];
}

function spanBand(n: number): string {
  if (n <= 3) return SPAN_BANDS[0];
  if (n <= 7) return SPAN_BANDS[1];
  if (n <= 12) return SPAN_BANDS[2];
  return SPAN_BANDS[3];
}

/**
 * Active people in scope split by one dimension. Manager span counts managers in scope by their number of
 * active direct reports (anywhere in the directory); the note carries the average.
 */
export function headcountBreakdown(
  scopePeople: readonly PersonRecord[],
  allPeople: readonly PersonRecord[],
  dim: HeadcountDim,
  today: string,
  limit = 10,
): { rows: ShareRow[]; total: number; note?: string } {
  const people = scopePeople.filter(active);
  const counts = new Map<string, number>();
  const add = (k: string) => counts.set(k || "Not set", (counts.get(k || "Not set") ?? 0) + 1);
  let order: string[] | null = null;
  let note: string | undefined;
  let total = people.length;

  if (dim === "span") {
    const reports = new Map<string, number>();
    for (const p of allPeople) if (active(p) && p.managerId) reports.set(p.managerId, (reports.get(p.managerId) ?? 0) + 1);
    const managers = people.filter((p) => (reports.get(p.id) ?? 0) > 0);
    for (const m of managers) add(spanBand(reports.get(m.id)!));
    const sum = managers.reduce((n, m) => n + reports.get(m.id)!, 0);
    total = managers.length;
    order = SPAN_BANDS;
    note = managers.length ? `Avg ${(sum / managers.length).toFixed(1)} reports · ${managers.length} managers` : undefined;
  } else {
    for (const p of people) {
      if (dim === "location") add(p.location);
      else if (dim === "country") add(p.countryName || String(p.countryCode));
      else if (dim === "department") add(p.department);
      else if (dim === "grade") add(p.grade);
      else if (dim === "gender") add(p.gender);
      else if (dim === "type") add(p.employmentType);
      else if (dim === "status") add(p.employmentStatus);
      else if (dim === "tenure") add(p.dateOfJoining ? tenureBand(p.dateOfJoining, today) : "");
    }
    if (dim === "tenure") order = TENURE_BANDS;
    if (dim === "grade") order = [...counts.keys()].sort((a, b) => (gradeRank(a) + 1 || 99) - (gradeRank(b) + 1 || 99));
  }

  let rows = (order ? order.filter((k) => counts.has(k)) : [...counts.keys()].sort((a, b) => counts.get(b)! - counts.get(a)!)).map(
    (label) => ({ label, count: counts.get(label)!, pct: pct(counts.get(label)!, total) }),
  );
  if (!order && rows.length > limit) {
    const rest = rows.slice(limit - 1);
    const n = rest.reduce((s, r) => s + r.count, 0);
    rows = [...rows.slice(0, limit - 1), { label: `Other (${rest.length})`, count: n, pct: pct(n, total) }];
  }
  return { rows, total, note };
}

/* ───────────── New hiring ───────────── */

export function recentJoiners(people: readonly PersonRecord[], today: string, days: number): PersonRecord[] {
  const from = addDaysISO(today, -(days - 1));
  return people
    .filter((p) => p.dateOfJoining && p.dateOfJoining >= from && p.dateOfJoining <= today)
    .sort((a, b) => b.dateOfJoining.localeCompare(a.dateOfJoining));
}

/** People joining per calendar month for the last `months` months (including people who have since left). */
export function monthlyHires(people: readonly PersonRecord[], today: string, months = 12): { label: string; value: number }[] {
  const now = parseISODate(today);
  return Array.from({ length: months }, (_, i) => {
    const first = new Date(now.getFullYear(), now.getMonth() - (months - 1 - i), 1);
    const from = toISO(first);
    const to = toISO(new Date(first.getFullYear(), first.getMonth() + 1, 0));
    return {
      label: first.toLocaleDateString("en-GB", { month: "short", year: "2-digit" }),
      value: people.filter((p) => p.dateOfJoining >= from && p.dateOfJoining <= to && p.dateOfJoining <= today).length,
    };
  });
}

/* ───────────── Time to hire & offers ───────────── */

function approvedOn(req: Requisition | undefined): string | undefined {
  if (!req) return undefined;
  const step = [...(req.history ?? [])].reverse().find((h) => h.action === "Approved");
  return step?.on ?? (req.approvalStatus === "Approved" ? req.decidedOn : undefined);
}

const reqInScope = (req: Requisition | undefined, countryName?: string) => !countryName || req?.country === countryName;

export interface HireRow {
  id: string;
  candidate: string;
  role: string;
  department: string;
  approvedOn: string;
  acceptedOn: string;
  days: number;
}

/** Days from requisition approval to offer acceptance, for accepted offers with both dates. */
export function timeToHire(offers: readonly OfferRecord[], requisitions: readonly Requisition[], countryName?: string) {
  const reqs = new Map(requisitions.map((r) => [r.id, r]));
  const rows: HireRow[] = [];
  for (const o of offers) {
    if (o.status !== "Accepted" || !o.respondedOn) continue;
    const req = reqs.get(o.requisitionId);
    const approved = approvedOn(req);
    if (!approved || !reqInScope(req, countryName)) continue;
    const days = daysBetween(approved, o.respondedOn);
    if (days < 0) continue;
    rows.push({ id: o.id, candidate: o.candidateName, role: o.role, department: req?.department ?? "—", approvedOn: approved, acceptedOn: o.respondedOn, days });
  }
  rows.sort((a, b) => b.acceptedOn.localeCompare(a.acceptedOn));
  const sorted = rows.map((r) => r.days).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length ? (sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)) : null;
  const avg = sorted.length ? Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length) : null;
  const dept = new Map<string, number[]>();
  for (const r of rows) dept.set(r.department, [...(dept.get(r.department) ?? []), r.days]);
  const byDepartment = [...dept.entries()]
    .map(([label, d]) => ({ label, value: Math.round(d.reduce((a, b) => a + b, 0) / d.length), hires: d.length }))
    .sort((a, b) => b.value - a.value);
  return { rows, avg, median, byDepartment };
}

/** Offers that reached the candidate (have a sent date), by outcome. Rate = accepted ÷ (accepted + declined). */
export function offerStats(offers: readonly OfferRecord[], requisitions: readonly Requisition[], countryName?: string) {
  const reqs = new Map(requisitions.map((r) => [r.id, r]));
  const sentOffers = offers.filter((o) => o.sentOn && reqInScope(reqs.get(o.requisitionId), countryName));
  const accepted = sentOffers.filter((o) => o.status === "Accepted").length;
  const declined = sentOffers.filter((o) => o.status === "Declined").length;
  const pending = sentOffers.filter((o) => o.status === "Sent").length;
  const withdrawn = sentOffers.filter((o) => o.status === "Withdrawn").length;
  return {
    sent: sentOffers.length,
    accepted,
    declined,
    pending,
    withdrawn,
    ratePct: accepted + declined ? pct(accepted, accepted + declined) : null,
    recent: [...sentOffers].sort((a, b) => (b.sentOn ?? "").localeCompare(a.sentOn ?? "")),
  };
}

/* ───────────── Shifts & working days ───────────── */

const DEMO_BY_ID = new Map(DEMO_ACCOUNTS.map((a) => [a.id, a]));
const to12 = (h: number, m: string) => `${String(h % 12 || 12).padStart(2, "0")}:${m} ${h >= 12 ? "PM" : "AM"}`;

/** Person's shift ("09:30 AM to 06:30 PM") and weekly offs: persona shift, else their country's standard hours. */
export function shiftFor(p: Pick<PersonRecord, "id" | "countryCode">): { hours: string; offs: number[] } {
  const demo = DEMO_BY_ID.get(p.id);
  const sched = scheduleForEmployee({ shiftName: demo?.shiftName, shiftHours: demo?.shiftHours, countryCode: p.countryCode });
  let hours = sched.hoursLabel;
  const m = hours.match(/(\d{1,2}):(\d{2})\s*[–—-]\s*(\d{1,2}):(\d{2})/);
  if (!/AM|PM/i.test(hours) && m) hours = `${to12(Number(m[1]), m[2])} to ${to12(Number(m[3]), m[4])}`;
  return { hours, offs: sched.weeklyOffDays };
}

/* ───────────── Late arrivals ───────────── */

/** Personas and teammates first, then everyone else — all in scope, capped so history stays quick to build. */
export function attendanceSample(people: readonly PersonRecord[], country: string, cap = 200): PersonRecord[] {
  const inScope = people.filter((p) => active(p) && (country === "ALL" || p.countryCode === country));
  const first = new Set([...DEMO_ACCOUNTS.map((a) => a.id), ...TASK_TEAM.map((t) => t.id)]);
  return [...inScope.filter((p) => first.has(p.id)), ...inScope.filter((p) => !first.has(p.id))].slice(0, cap);
}

export function lateArrivals(
  sample: readonly PersonRecord[],
  state: Pick<PortalState, "holidays" | "leaveRequests" | "absences">,
  attendance: { sessions: TodaySession[]; corrections: AttendanceCorrection[] },
  today: string,
  weeks = 4,
) {
  const start = addDaysISO(today, -(weeks * 7 - 1));
  const startMs = parseISODate(start).getTime();
  const buckets = Array.from({ length: weeks }, (_, i) => ({ from: addDaysISO(start, i * 7), late: 0, attended: 0 }));
  const todayLate: { person: PersonRecord; checkIn: string; minutes: number }[] = [];
  const byLocation = new Map<string, number>();
  const byDept = new Map<string, number>();
  for (const p of sample) {
    const shift = shiftFor(p);
    const rows = buildAttendanceHistory({
      employeeId: p.id,
      employeeName: p.fullName,
      from: start,
      to: today,
      holidays: holidaysForPerson(state.holidays, p.id),
      leaveRequests: state.leaveRequests,
      absences: state.absences,
      shiftHours: shift.hours,
      corrections: attendance.corrections,
      weeklyOffDays: shift.offs,
      sessions: attendance.sessions,
    });
    for (const r of rows) {
      if (!r.checkIn) continue;
      const b = buckets[Math.floor((parseISODate(r.date).getTime() - startMs) / (7 * DAY_MS))];
      if (b) b.attended += 1;
      if (r.lateMinutes <= 0) continue;
      if (b) b.late += 1;
      byLocation.set(p.location || "Not set", (byLocation.get(p.location || "Not set") ?? 0) + 1);
      byDept.set(p.department || "Not set", (byDept.get(p.department || "Not set") ?? 0) + 1);
      if (r.date === today) todayLate.push({ person: p, checkIn: r.checkIn, minutes: r.lateMinutes });
    }
  }
  const top = (m: Map<string, number>) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([label, value]) => ({ label, value }));
  const totalLate = buckets.reduce((n, b) => n + b.late, 0);
  const totalAttended = buckets.reduce((n, b) => n + b.attended, 0);
  return {
    sampleSize: sample.length,
    today: todayLate.sort((a, b) => b.minutes - a.minutes),
    trend: buckets.map((b) => ({
      label: parseISODate(b.from).toLocaleDateString("en-GB", { day: "2-digit", month: "short" }),
      value: b.late,
      pct: pct(b.late, b.attended),
    })),
    totalLate,
    latePct: pct(totalLate, totalAttended),
    byLocation: top(byLocation),
    byDepartment: top(byDept),
  };
}

/* ───────────── Team absence & cover ───────────── */

export interface AbsenceRow {
  person: PersonRecord;
  /** Working days off from today to the end of the week. */
  days: string[];
  outToday: boolean;
  cover?: PersonRecord;
  coverIsManager: boolean;
}

export interface TeamAbsence {
  managerId: string;
  manager?: PersonRecord;
  name: string;
  size: number;
  expectedToday: number;
  presentToday: number;
  pctToday: number | null;
  weekLowPct: number | null;
  weekLowDay?: string;
  absences: AbsenceRow[];
}

export interface CoverageRisk {
  id: string;
  severity: "High" | "Medium" | "Low";
  text: string;
  team: string;
}

const SEVERITY_RANK = { High: 0, Medium: 1, Low: 2 } as const;
const titleCore = (t: string) => t.toLowerCase().replace(/\b(senior|sr\.?|junior|jr\.?|lead|principal|associate|staff)\b/g, "").replace(/\s+/g, " ").trim();

/**
 * Teams = active people in scope grouped by managerId. A person is absent on a working day (not a weekly off
 * or holiday for them) covered by approved non-WFH leave. Covers come from the same team and department,
 * same title or grade within one step, present on every day the person is out and not already covering.
 */
export function teamAbsence(
  allPeople: readonly PersonRecord[],
  scopePeople: readonly PersonRecord[],
  state: Pick<PortalState, "holidays" | "leaveRequests">,
  today: string,
  threshold = 70,
) {
  const byId = new Map(allPeople.map((p) => [p.id, p]));
  const dow = parseISODate(today).getDay();
  const weekEnd = addDaysISO(today, (7 - dow) % 7); // through Sunday
  const days: string[] = [];
  for (let d = today; d <= weekEnd; d = addDaysISO(d, 1)) days.push(d);

  const workCache = new Map<string, Set<string>>();
  const workingDaysOf = (p: PersonRecord): Set<string> => {
    let set = workCache.get(p.id);
    if (!set) {
      const offs = shiftFor(p).offs;
      const hol = new Set(holidaysForPerson(state.holidays, p.id).map((h) => h.date));
      set = new Set(days.filter((d) => !offs.includes(parseISODate(d).getDay()) && !hol.has(d)));
      workCache.set(p.id, set);
    }
    return set;
  };
  const leaveDays = new Map<string, Set<string>>();
  for (const r of state.leaveRequests) {
    if (r.status !== "approved" || WFH_CODES.has(r.code) || r.to < today || r.from > weekEnd) continue;
    const set = leaveDays.get(r.employeeId) ?? new Set<string>();
    for (const d of days) if (d >= r.from && d <= r.to) set.add(d);
    leaveDays.set(r.employeeId, set);
  }
  const outDays = (p: PersonRecord) => {
    const work = workingDaysOf(p);
    return [...(leaveDays.get(p.id) ?? [])].filter((d) => work.has(d)).sort();
  };
  const presentOn = (p: PersonRecord, ds: string[]) => {
    const work = workingDaysOf(p);
    const off = leaveDays.get(p.id);
    return ds.every((d) => work.has(d) && !off?.has(d));
  };

  const groups = new Map<string, PersonRecord[]>();
  for (const p of scopePeople) {
    if (!active(p) || !p.managerId) continue;
    groups.set(p.managerId, [...(groups.get(p.managerId) ?? []), p]);
  }

  const teams: TeamAbsence[] = [];
  const covering = new Set<string>();
  const risks: CoverageRisk[] = [];
  for (const [managerId, members] of groups) {
    const manager = byId.get(managerId);
    const name = manager ? `${manager.fullName}'s team` : "Unassigned team";
    const absences: AbsenceRow[] = members
      .map((p) => ({ person: p, days: outDays(p) }))
      .filter((a) => a.days.length > 0)
      .map((a) => ({ ...a, outToday: a.days[0] === today, coverIsManager: false }));
    const absentIds = new Set(absences.map((a) => a.person.id));

    const dayPct = days
      .map((d) => {
        const expected = members.filter((m) => workingDaysOf(m).has(d));
        const present = expected.filter((m) => !leaveDays.get(m.id)?.has(d)).length;
        return { d, expected: expected.length, present, pct: expected.length ? pct(present, expected.length) : null };
      })
      .filter((x) => x.pct !== null);
    const todayRow = dayPct.find((x) => x.d === today);
    const low = [...dayPct].sort((a, b) => (a.pct ?? 100) - (b.pct ?? 100))[0];

    for (const a of absences.sort((x, y) => x.days[0].localeCompare(y.days[0]) || gradeRank(y.person.grade) - gradeRank(x.person.grade))) {
      const core = titleCore(a.person.designation);
      const options = members
        .filter((m) => m.id !== a.person.id && !absentIds.has(m.id) && !covering.has(m.id))
        .filter((m) => m.department === a.person.department && presentOn(m, a.days))
        .map((m) => ({ m, same: titleCore(m.designation) === core, gap: Math.abs(gradeRank(m.grade) - gradeRank(a.person.grade)) }))
        .filter((o) => o.same || o.gap <= 1)
        .sort((x, y) => Number(y.same) - Number(x.same) || x.gap - y.gap || x.m.fullName.localeCompare(y.m.fullName));
      if (options[0]) {
        a.cover = options[0].m;
        covering.add(options[0].m.id);
      } else if (manager && active(manager) && presentOn(manager, a.days)) {
        a.cover = manager;
        a.coverIsManager = true;
        risks.push({ id: `peer-${a.person.id}`, severity: "Medium", team: name, text: `${a.person.fullName}: no peer cover, manager covers` });
      } else {
        risks.push({ id: `none-${a.person.id}`, severity: "High", team: name, text: `${a.person.fullName}: no cover — manager also out` });
      }
    }

    if (todayRow && todayRow.pct !== null && todayRow.pct < threshold) {
      risks.push({ id: `today-${managerId}`, severity: "High", team: name, text: `${name}: ${todayRow.pct}% present today` });
    } else if (low && low.pct !== null && low.pct < threshold) {
      risks.push({ id: `week-${managerId}`, severity: "Medium", team: name, text: `${name}: ${low.pct}% present on ${dayShort(low.d)}` });
    }

    teams.push({
      managerId,
      manager,
      name,
      size: members.length,
      expectedToday: todayRow?.expected ?? 0,
      presentToday: todayRow?.present ?? 0,
      pctToday: todayRow?.pct ?? null,
      weekLowPct: low?.pct ?? null,
      weekLowDay: low?.d,
      absences,
    });
  }

  const withAbsence = teams
    .filter((t) => t.absences.length > 0)
    .sort((a, b) => (a.pctToday ?? 100) - (b.pctToday ?? 100) || (a.weekLowPct ?? 100) - (b.weekLowPct ?? 100));
  return {
    weekEnd,
    teamCount: teams.length,
    teams: withAbsence,
    belowToday: teams.filter((t) => t.pctToday !== null && t.pctToday < threshold).length,
    absentToday: withAbsence.reduce((n, t) => n + t.absences.filter((a) => a.outToday).length, 0),
    absentWeek: withAbsence.reduce((n, t) => n + t.absences.length, 0),
    risks: risks.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.text.localeCompare(b.text)),
  };
}

export const shortDay = dayShort;

/* ───────────── Where the team works ───────────── */

export type TodayPlace = "In office" | "WFH today" | "On leave" | "Not checked in" | "Off today";
export const TODAY_PLACES: TodayPlace[] = ["In office", "WFH today", "On leave", "Not checked in", "Off today"];
export const ARRANGEMENTS = ["Office", "Hybrid", "Remote", "Not set"] as const;

export interface PlaceMember {
  id: string;
  name: string;
  arrangement: (typeof ARRANGEMENTS)[number];
  today: TodayPlace;
}

/**
 * Work arrangement from the person record, and today's place:
 * leave (non-WFH) → On leave; holiday / weekly off → Off today; approved WFH → WFH today;
 * checked in → In office (Remote → WFH today); not checked in → WFH today for Remote/Hybrid, else Not checked in.
 */
export function teamWorkplace(
  members: readonly { id: string; name: string; status: "Working" | "WFH" | "On leave" | "Holiday" | "Weekly off" }[],
  peopleById: ReadonlyMap<string, PersonRecord>,
  checkedIn: ReadonlySet<string>,
): PlaceMember[] {
  return members.map((m) => {
    const arrangement = peopleById.get(m.id)?.workArrangement ?? "Not set";
    let today: TodayPlace;
    if (m.status === "On leave") today = "On leave";
    else if (m.status === "Holiday" || m.status === "Weekly off") today = "Off today";
    else if (m.status === "WFH" || arrangement === "Remote") today = "WFH today";
    else if (checkedIn.has(m.id)) today = "In office";
    else today = arrangement === "Hybrid" ? "WFH today" : "Not checked in";
    return { id: m.id, name: m.name, arrangement, today };
  });
}
