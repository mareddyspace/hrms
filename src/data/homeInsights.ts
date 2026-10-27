/**
 * Computed numbers for the role homes — every value comes from a live store
 * (portal state, talent, attendance, lifecycle, compliance), never from fixed figures.
 */
import {
  addDaysISO,
  holidaySet,
  holidaysForCountry,
  parseISODate,
  toISO,
  workingDays,
  type CountryCode,
  type Holiday,
  type LeaveRequest,
  type PortalState,
} from "../model.ts";
import type { PersonRecord } from "./peopleData.ts";
import {
  COURSES,
  LEVEL_RANK,
  PERF_CYCLES,
  PIPELINE_STAGES,
  type Enrollment,
  type PerfCycle,
  type PerfGoal,
  type PerfReview,
  type PipelineStage,
} from "./talentData.ts";
import { cycleCompletion, cycleStatusOf, getTalentState, skillProfileFor } from "./talentLocal.ts";
import { buildAttendanceHistory, type AttendanceCorrection, type TodaySession } from "./attendanceData.ts";
import { COMP_CYCLES, type CompReviewItem } from "./rewardData.ts";

type TalentState = ReturnType<typeof getTalentState>;

const WFH_CODES = new Set(["wfh", "emergency_wfh"]);

export function weeklyOffFor(countryCode: string | undefined): number[] {
  return countryCode === "AE" || countryCode === "SA" ? [5, 6] : [0, 6];
}

/* ───────────── Performance ───────────── */

/** The cycle that is running now: Active first, then Calibration, then the next one in Planning. */
export function currentCycle(talent: Pick<TalentState, "cycleStatus">): PerfCycle & { status: PerfCycle["status"] } {
  const withStatus = PERF_CYCLES.map((c) => ({ ...c, status: cycleStatusOf(talent, c.id) }));
  return (
    withStatus.find((c) => c.status === "Active") ??
    withStatus.find((c) => c.status === "Calibration") ??
    withStatus.find((c) => c.status === "Planning") ??
    withStatus[withStatus.length - 1]
  );
}

/** Share of the cycle's calendar time already gone (0–100). */
export function cycleElapsedPct(cycle: Pick<PerfCycle, "start" | "end">, today: string): number {
  const start = parseISODate(cycle.start).getTime();
  const end = parseISODate(cycle.end).getTime();
  const now = parseISODate(today).getTime();
  if (end <= start) return 100;
  return Math.max(0, Math.min(100, Math.round(((now - start) / (end - start)) * 100)));
}

/** Weighted progress of one person's goals (weights normally add up to 100). */
export function weightedProgress(goals: Pick<PerfGoal, "weight" | "progress">[]): number {
  const weight = goals.reduce((n, g) => n + (g.weight || 0), 0);
  if (!goals.length) return 0;
  if (!weight) return Math.round(goals.reduce((n, g) => n + g.progress, 0) / goals.length);
  return Math.round(goals.reduce((n, g) => n + (g.weight || 0) * g.progress, 0) / weight);
}

export interface GoalPersonRow {
  id: string;
  name: string;
  goals: number;
  progress: number;
  behind: boolean;
}

/**
 * Goal progress for a group in one cycle. Someone is "behind" when their weighted progress trails
 * the share of the cycle already elapsed by more than 15 points.
 */
export function goalProgressFor(goals: PerfGoal[], ids: ReadonlySet<string>, cycle: PerfCycle, today: string) {
  const elapsed = cycleElapsedPct(cycle, today);
  const byOwner = new Map<string, PerfGoal[]>();
  for (const g of goals) {
    if (g.cycleId !== cycle.id || !ids.has(g.ownerId)) continue;
    byOwner.set(g.ownerId, [...(byOwner.get(g.ownerId) ?? []), g]);
  }
  const people: GoalPersonRow[] = [...byOwner.entries()]
    .map(([id, list]) => {
      const progress = weightedProgress(list);
      return { id, name: list[0].ownerName, goals: list.length, progress, behind: progress < elapsed - 15 };
    })
    .sort((a, b) => a.progress - b.progress);
  const avg = people.length ? Math.round(people.reduce((n, p) => n + p.progress, 0) / people.length) : 0;
  return { elapsed, avg, people, behind: people.filter((p) => p.behind) };
}

/** Self / manager assessment status for a group in one cycle (null ids = everyone). */
export function reviewStatusFor(reviews: PerfReview[], ids: ReadonlySet<string> | null, cycleId: string) {
  const rows = reviews.filter((r) => r.cycleId === cycleId && (!ids || ids.has(r.employeeId)));
  const selfDone = rows.filter((r) => r.selfStatus === "Submitted").length;
  const managerDone = rows.filter((r) => r.managerStatus === "Submitted").length;
  return {
    rows,
    total: rows.length,
    selfDone,
    managerDone,
    completionPct: cycleCompletion({ reviews: rows }, cycleId),
    awaitingManager: rows.filter((r) => r.managerStatus !== "Submitted"),
    calibrated: rows.filter((r) => Boolean(r.rating)).length,
    released: rows.filter((r) => r.released).length,
  };
}

/* ───────────── Skills ───────────── */

export interface SkillRow {
  name: string;
  people: number;
  /** People below their target level for this skill. */
  gaps: number;
  avgLevel: number;
  countries: string[];
}

/** Top skills and gaps across a group, from each person's skills profile. */
export function skillCoverage(talent: Pick<TalentState, "skillProfiles">, members: readonly { id: string; countryCode?: string }[]) {
  const map = new Map<string, { people: number; gaps: number; levels: number; countries: Set<string> }>();
  for (const m of members) {
    for (const s of skillProfileFor(talent, m.id)) {
      const row = map.get(s.skillName) ?? { people: 0, gaps: 0, levels: 0, countries: new Set<string>() };
      row.people += 1;
      row.levels += LEVEL_RANK[s.level] ?? 0;
      if ((LEVEL_RANK[s.level] ?? 0) < (LEVEL_RANK[s.targetLevel] ?? 0)) {
        row.gaps += 1;
        if (m.countryCode) row.countries.add(m.countryCode);
      }
      map.set(s.skillName, row);
    }
  }
  const rows: SkillRow[] = [...map.entries()].map(([name, r]) => ({
    name,
    people: r.people,
    gaps: r.gaps,
    avgLevel: r.people ? Number((r.levels / r.people).toFixed(1)) : 0,
    countries: [...r.countries].sort(),
  }));
  return {
    top: [...rows].sort((a, b) => b.people - a.people || b.avgLevel - a.avgLevel).slice(0, 5),
    gaps: rows.filter((r) => r.gaps > 0).sort((a, b) => b.gaps - a.gaps).slice(0, 5),
  };
}

export function gapSeverity(gaps: number, people: number): "High" | "Medium" | "Low" {
  const share = people ? gaps / people : 0;
  return share >= 0.5 ? "High" : share >= 0.25 ? "Medium" : "Low";
}

/** Skill gaps across a population, shaped for tables: skill, severity, countries affected. */
export function criticalSkillGaps(
  talent: Pick<TalentState, "skillProfiles">,
  members: readonly { id: string; countryCode?: string }[],
): { skill: string; gap: "High" | "Medium" | "Low"; people: number; countries: string }[] {
  return skillCoverage(talent, [...members]).gaps.map((g) => ({
    skill: g.name,
    gap: gapSeverity(g.gaps, g.people),
    people: g.gaps,
    countries: g.countries.slice(0, 4).join(", ") || "—",
  }));
}

/* ───────────── Recruiting ───────────── */

const FUNNEL: PipelineStage[] = PIPELINE_STAGES.filter((s) => s !== "Rejected" && s !== "Withdrawn");

/** Candidates by stage, in funnel order. countryName filters by the candidate's country. */
export function pipelineFunnel(candidates: TalentState["candidates"], countryName?: string) {
  const inScope = candidates.filter((c) => !countryName || c.country === countryName);
  return FUNNEL.map((stage) => ({ stage, count: inScope.filter((c) => c.stage === stage).length }));
}

/* ───────────── Learning ───────────── */

export function learningCompletion(enrollments: Enrollment[], ids?: ReadonlySet<string>, today?: string) {
  const rows = enrollments.filter((e) => !ids || ids.has(e.employeeId));
  const completed = rows.filter((e) => e.status === "Completed").length;
  const mandatoryIds = new Set(COURSES.filter((c) => c.mandatory).map((c) => c.id));
  const mandatory = rows.filter((e) => mandatoryIds.has(e.courseId));
  const mandatoryDone = mandatory.filter((e) => e.status === "Completed").length;
  const overdue = today ? rows.filter((e) => e.status !== "Completed" && e.due && e.due < today).length : 0;
  const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0);
  return {
    total: rows.length,
    completed,
    pct: pct(completed, rows.length),
    mandatoryTotal: mandatory.length,
    mandatoryDone,
    mandatoryPct: pct(mandatoryDone, mandatory.length),
    overdue,
  };
}

/* ───────────── Leave & attendance trends ───────────── */

/** Approved leave days (excluding WFH) per month for the last `months` months, counted on working days. */
export function leaveTrend(
  leaveRequests: LeaveRequest[],
  holidays: Holiday[],
  countryOf: (employeeId: string) => string | undefined,
  country: CountryCode | "ALL",
  today: string,
  months = 6,
): { label: string; days: number }[] {
  const now = parseISODate(today);
  const buckets = Array.from({ length: months }, (_, i) => {
    const first = new Date(now.getFullYear(), now.getMonth() - (months - 1 - i), 1);
    const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
    return { from: toISO(first), to: toISO(last), label: first.toLocaleDateString("en-GB", { month: "short" }), days: 0 };
  });
  const holidayCache = new Map<string, Set<string>>();
  for (const r of leaveRequests) {
    if (r.status !== "approved" || WFH_CODES.has(r.code)) continue;
    const code = countryOf(r.employeeId) ?? "IN";
    if (country !== "ALL" && code !== country) continue;
    if (!holidayCache.has(code)) holidayCache.set(code, holidaySet(holidaysForCountry(holidays, code as CountryCode)));
    for (const b of buckets) {
      const from = r.from > b.from ? r.from : b.from;
      const to = r.to < b.to ? r.to : b.to;
      if (from <= to) b.days += workingDays(from, to, holidayCache.get(code)!, weeklyOffFor(code));
    }
  }
  return buckets.map(({ label, days }) => ({ label, days }));
}

const ATTENDED = new Set(["present", "wfh", "missing_punch", "pending_correction"]);
const EXPECTED = new Set([...ATTENDED, "absent"]);

/**
 * Weekly attendance rate (days attended ÷ working days expected, leave excluded) and overtime hours by
 * department for the last `weeks` full weeks, built from the same history the Attendance page shows.
 */
export function attendanceAnalytics(
  people: readonly Pick<PersonRecord, "id" | "fullName" | "countryCode" | "department">[],
  state: Pick<PortalState, "holidays" | "leaveRequests" | "absences">,
  attendance: { sessions: TodaySession[]; corrections: AttendanceCorrection[] },
  today: string,
  weeks = 6,
) {
  const end = addDaysISO(today, -1);
  const start = addDaysISO(end, -(weeks * 7 - 1));
  const startMs = parseISODate(start).getTime();
  const buckets = Array.from({ length: weeks }, (_, i) => ({ from: addDaysISO(start, i * 7), attended: 0, expected: 0 }));
  const overtime = new Map<string, number>();
  for (const p of people) {
    const code = String(p.countryCode || "IN");
    const rows = buildAttendanceHistory({
      employeeId: p.id,
      employeeName: p.fullName,
      from: start,
      to: end,
      holidays: holidaysForCountry(state.holidays, code as CountryCode),
      leaveRequests: state.leaveRequests,
      absences: state.absences,
      shiftHours: "09:30 AM to 06:30 PM",
      corrections: attendance.corrections,
      weeklyOffDays: weeklyOffFor(code),
      sessions: attendance.sessions,
    });
    for (const row of rows) {
      if (row.overtimeMinutes > 0) {
        const dept = p.department || "Other";
        overtime.set(dept, (overtime.get(dept) ?? 0) + row.overtimeMinutes);
      }
      if (!EXPECTED.has(row.kind)) continue;
      const b = buckets[Math.floor((parseISODate(row.date).getTime() - startMs) / (7 * 86400000))];
      if (!b) continue;
      b.expected += 1;
      if (ATTENDED.has(row.kind)) b.attended += 1;
    }
  }
  return {
    trend: buckets
      .filter((b) => b.expected > 0)
      .map((b) => ({
        label: parseISODate(b.from).toLocaleDateString("en-GB", { day: "2-digit", month: "short" }),
        pct: Math.round((b.attended / b.expected) * 100),
        days: b.expected,
      })),
    overtime: [...overtime.entries()]
      .map(([label, minutes]) => ({ label, hours: Math.round(minutes / 60) }))
      .filter((r) => r.hours > 0)
      .sort((a, b) => b.hours - a.hours)
      .slice(0, 8),
  };
}

export function attendanceTrend(
  people: readonly Pick<PersonRecord, "id" | "fullName" | "countryCode">[],
  state: Pick<PortalState, "holidays" | "leaveRequests" | "absences">,
  attendance: { sessions: TodaySession[]; corrections: AttendanceCorrection[] },
  today: string,
  weeks = 6,
): { label: string; pct: number; days: number }[] {
  return attendanceAnalytics(people.map((p) => ({ ...p, department: "" })), state, attendance, today, weeks).trend;
}

/* ───────────── Learning detail ───────────── */

/** Mandatory still open, certifications earned this year, and the busiest courses' completion. */
export function learningDetail(
  enrollments: Enrollment[],
  certifications: { employeeId: string; earnedOn: string }[],
  ids: ReadonlySet<string> | undefined,
  today: string,
) {
  const rows = enrollments.filter((e) => !ids || ids.has(e.employeeId));
  const mandatoryIds = new Set(COURSES.filter((c) => c.mandatory).map((c) => c.id));
  const byCourse = new Map<string, { total: number; done: number }>();
  for (const e of rows) {
    const r = byCourse.get(e.courseId) ?? { total: 0, done: 0 };
    r.total += 1;
    if (e.status === "Completed") r.done += 1;
    byCourse.set(e.courseId, r);
  }
  return {
    mandatoryPending: rows.filter((e) => mandatoryIds.has(e.courseId) && e.status !== "Completed").length,
    certificationsYtd: certifications.filter((c) => (!ids || ids.has(c.employeeId)) && c.earnedOn >= `${today.slice(0, 4)}-01-01` && c.earnedOn <= today).length,
    topCourses: [...byCourse.entries()]
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, 5)
      .map(([id, r]) => ({ name: COURSES.find((c) => c.id === id)?.title ?? id, completionPct: Math.round((r.done / r.total) * 100), enrolled: r.total })),
  };
}

/* ───────────── Compensation review ───────────── */

/** Status of the open compensation cycle from the proposals in the reward store. */
export function compReviewStatus(
  reviews: readonly CompReviewItem[],
  ids?: ReadonlySet<string>,
): { cycle: string; status: string; total: number; submittedPct: number; pendingManagers: number; approved: number; awaiting: number; avgIncreasePct: number } | null {
  const cycle = COMP_CYCLES.find((c) => c.status !== "Closed") ?? COMP_CYCLES[0];
  if (!cycle) return null;
  const rows = reviews.filter((r) => r.cycleId === cycle.id && (!ids || ids.has(r.employeeId)));
  const submitted = rows.filter((r) => r.status !== "Draft");
  const approved = rows.filter((r) => r.status === "Approved");
  const live = rows.filter((r) => r.status !== "Rejected");
  return {
    cycle: cycle.name,
    status: cycle.status,
    total: rows.length,
    submittedPct: rows.length ? Math.round((submitted.length / rows.length) * 100) : 0,
    pendingManagers: new Set(rows.filter((r) => r.status === "Draft").map((r) => r.managerId)).size,
    approved: approved.length,
    awaiting: rows.filter((r) => r.status === "Pending approval" || r.status === "Pending final approval").length,
    avgIncreasePct: live.length ? Number((live.reduce((n, r) => n + r.proposedIncreasePct, 0) / live.length).toFixed(1)) : 0,
  };
}
