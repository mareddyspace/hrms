/**
 * Pure builder for Copilot's context (no React), so the same numbers the screens show can be
 * checked outside the app. Everything is the viewer's own data, people below them in the
 * reporting line, or — only when the viewer's access allows — company-wide figures.
 */
import type { CopilotContext } from "../../data/platformData.ts";
import { managementChain, type DemoAccount } from "../../demoAccounts.ts";
import type { PersonRecord } from "../../data/peopleData.ts";
import { getExitDetails } from "../../data/peopleLocal.ts";
import { COURSES, PIPELINE_STAGES } from "../../data/talentData.ts";
import { currentCycle, weightedProgress } from "../../data/homeInsights.ts";
import { personName, workforceInsights, workforceStats, type TeamMember } from "../../data/workforceStats.ts";
import { policiesForPerson, policyCatalog } from "../../data/policyLibrary.ts";
import {
  addDaysISO,
  holidaySet,
  holidaysForCountry,
  holidaysForPerson,
  localPolicy,
  parseISODate,
  workingDays,
  type CountryCode,
  type Employee,
  type LeaveRow,
  type PayslipView,
  type PortalState,
} from "../../model.ts";
import type { getTalentState } from "../../data/talentLocal.ts";

type TalentState = ReturnType<typeof getTalentState>;

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const HR_ROLES = new Set(["hr", "hr_admin", "hrbp"]);
const TAX_LINE = /\b(tds|tax|paye|withholding|federal|state income|medicare|social security|national insurance|ni\b)/i;

export interface CopilotSources {
  today: string;
  viewer: DemoAccount;
  employee: Employee;
  accounts: readonly DemoAccount[];
  state: PortalState;
  leaveTable: readonly LeaveRow[];
  payslips: readonly PayslipView[];
  people: readonly PersonRecord[];
  team: readonly TeamMember[];
  canDecideFor: (id: string) => boolean;
  canVerifyProofs: boolean;
  /** Same number as countWaitingOnMe (Approvals badge). */
  approvalsCount: number;
  weeklyOffDays: number[];
  orgWide: boolean;
  talent: TalentState;
  corrections: readonly { id: string; employeeId: string; date: string; kind: string; status: string }[];
  swaps: readonly { id: string; requesterId: string; teammateId: string; date: string; status: string }[];
  /** Today's rostered shift, when one is published. */
  todayShift?: string;
  compReview?: CopilotContext["compReview"];
  summarisePerson?: CopilotContext["summarisePerson"];
}

/** Monday of the week that holds `iso`. */
export function mondayOf(iso: string): string {
  const day = parseISODate(iso).getDay();
  return addDaysISO(iso, day === 0 ? -6 : 1 - day);
}

function navHas(viewer: DemoAccount, id: string): boolean {
  return viewer.navAccess.includes("*" as never) || viewer.navAccess.includes(id as never);
}

export function buildCopilotContext(src: CopilotSources): CopilotContext {
  const { today, viewer, employee, state, people } = src;
  const year = today.slice(0, 4);
  const me = employee.id;
  const name = (id: string) => (id === me ? employee.fullName : personName(id, people));
  const localPolicies = state.leavePolicies.map((p) => localPolicy(p, employee.countryCode));
  const policyName = (code: string) => localPolicies.find((p) => p.code === code)?.name ?? code;
  const myHolidays = holidaysForPerson(state.holidays, me);
  const myHolidayDates = holidaySet(myHolidays);
  const teamIds = new Set(src.team.map((m) => m.id));

  // Approved leave days this year for people below the viewer.
  const leaveDays = new Map<string, number>();
  for (const r of state.leaveRequests) {
    if (r.status !== "approved" || !teamIds.has(r.employeeId) || !r.from.startsWith(year)) continue;
    if (r.code === "wfh" || r.code === "emergency_wfh") continue;
    const days = workingDays(r.from, r.to, holidaySet(holidaysForPerson(state.holidays, r.employeeId)), [0, 6]);
    leaveDays.set(r.employeeId, (leaveDays.get(r.employeeId) ?? 0) + days);
  }

  // Who is away in the next two weeks — scoped to what the viewer may see.
  const awayScope: "org" | "team" | "self" = src.orgWide || HR_ROLES.has(viewer.role) ? "org" : teamIds.size ? "team" : "self";
  const horizon = addDaysISO(today, 13);
  const away = state.leaveRequests
    .filter(
      (r) =>
        r.status === "approved" &&
        r.from <= horizon &&
        r.to >= today &&
        (awayScope === "org" || r.employeeId === me || teamIds.has(r.employeeId)),
    )
    .map((r) => ({ name: name(r.employeeId), self: r.employeeId === me, type: policyName(r.code), wfh: r.code === "wfh" || r.code === "emergency_wfh", from: r.from, to: r.to }))
    .sort((a, b) => a.from.localeCompare(b.from));

  // Items waiting on the viewer: same lists as countWaitingOnMe, including attendance corrections and shift swaps.
  const open = (s: string) => s === "pending" || s === "submitted";
  const mine = (id: string) => id !== me && src.canDecideFor(id);
  const approvals: CopilotContext["approvals"] = [];
  const add = (list: readonly { employeeId: string; status: string }[], kind: string, detail: (x: never) => string, date: (x: never) => string) => {
    for (const x of list) if (open(x.status) && mine(x.employeeId)) approvals.push({ who: name(x.employeeId), kind, detail: detail(x as never), date: date(x as never) });
  };
  add(state.backdatedPermissions ?? [], "Past-date leave", (x: { code: string }) => `${policyName(x.code)} permission`, (x: { from: string }) => x.from);
  add(state.leaveRequests, "Leave", (x: { code: string; from: string; to: string }) => `${policyName(x.code)} · ${x.from === x.to ? "1 day" : `to ${x.to}`}`, (x: { from: string }) => x.from);
  add(state.encashments, "Encashment", (x: { days: number }) => `${x.days} days`, (x: { appliedOn: string }) => x.appliedOn);
  add(state.expenses, "Expense", (x: { category: string }) => x.category, (x: { date: string }) => x.date);
  add(state.reimbursements, "Reimbursement", (x: { category: string }) => x.category, (x: { date: string }) => x.date);
  add(state.cashAdvances, "Cash advance", (x: { category: string }) => x.category, (x: { date: string }) => x.date);
  add(state.assetRequests, "Asset", (x: { item: string }) => x.item, (x: { date: string }) => x.date);
  add(state.softwareRequests, "Software", (x: { software: string }) => x.software, (x: { date: string }) => x.date);
  add(state.cabBookings, "Cab", (x: { to: string }) => x.to, (x: { date: string }) => x.date);
  for (const row of state.orgTimesheets) {
    if (row.status === "submitted" && mine(row.personId)) approvals.push({ who: name(row.personId), kind: "Timesheet", detail: `${row.hours} h`, date: row.weekStart });
  }
  if (src.canVerifyProofs) {
    for (const p of state.investmentProofs) {
      if (p.status === "submitted" && p.employeeId !== me) approvals.push({ who: name(p.employeeId), kind: "Tax proof", detail: p.section, date: p.submittedOn });
    }
  }
  for (const c of src.corrections) {
    if (c.status === "Pending" && mine(c.employeeId)) approvals.push({ who: name(c.employeeId), kind: "Attendance correction", detail: c.kind.replace(/_/g, " "), date: c.date });
  }
  for (const w of src.swaps) {
    if ((w.status === "awaiting_teammate" && w.teammateId === me) || (w.status === "awaiting_manager" && mine(w.requesterId) && mine(w.teammateId))) {
      approvals.push({ who: name(w.requesterId), kind: "Shift swap", detail: w.teammateId === me ? "with you" : `with ${name(w.teammateId)}`, date: w.date });
    }
  }
  approvals.sort((a, b) => a.date.localeCompare(b.date));

  // Workforce numbers (only for people allowed to see company-wide data).
  let workforce: CopilotContext["workforce"];
  if (src.orgWide) {
    const ytd = workforceStats(people, { country: "ALL", range: "ytd", today });
    const monthStart = `${today.slice(0, 7)}-01`;
    const active = people.filter((p) => p.employmentStatus !== "Terminated");
    const joinersMonth = active.filter((p) => p.dateOfJoining >= monthStart && p.dateOfJoining <= today).length;
    const exitsMonth = people.filter((p) => {
      if (p.employmentStatus !== "Terminated") return false;
      const d = getExitDetails(p).exitDate;
      return Boolean(d && d >= monthStart && d <= today);
    }).length;
    const attrition12 = workforceInsights(people, "ALL", today).find((i) => i.id === "attrition")?.text;
    workforce = {
      headcount: ytd.headcount,
      joiners: ytd.joiners,
      exits: ytd.exits,
      attritionPct: ytd.attritionPct,
      joinersMonth,
      exitsMonth,
      attrition12,
      byCountry: ytd.byCountry.filter((c) => c.count > 0).map((c) => ({ name: c.name, count: c.count })),
      byDepartment: ytd.byDepartment,
    };
  }

  // Recruiting numbers (only with recruiting / jobs access).
  let recruiting: CopilotContext["recruiting"];
  if (navHas(viewer, "recruiting") || navHas(viewer, "jobs")) {
    const reqs = src.talent.requisitions;
    const approved = reqs.filter((r) => r.approvalStatus === "Approved");
    recruiting = {
      approvedReqs: approved.length,
      openings: approved.reduce((n, r) => n + r.openings, 0),
      pendingReqs: reqs.filter((r) => r.approvalStatus === "Pending approval").length,
      onHoldReqs: reqs.filter((r) => r.approvalStatus === "On hold").length,
      roles: approved.map((r) => ({ title: r.title, country: r.country, openings: r.openings })),
      ...(navHas(viewer, "recruiting")
        ? {
            candidates: src.talent.candidates.length,
            byStage: PIPELINE_STAGES.map((stage) => ({ stage: String(stage), count: src.talent.candidates.filter((c) => c.stage === stage).length })).filter((s) => s.count > 0),
            openOffers: src.talent.offers.filter((o) => !["Accepted", "Declined", "Withdrawn"].includes(o.status)).length,
          }
        : {}),
    };
  }

  // Performance and learning (own records).
  const cycle = currentCycle(src.talent);
  const goals = src.talent.goals.filter((g) => g.ownerId === me && g.cycleId === cycle.id);
  const review = src.talent.reviews.find((r) => r.employeeId === me && r.cycleId === cycle.id);
  const enrollments = src.talent.enrollments.filter((e) => e.employeeId === me);
  const courseTitle = (id: string) => COURSES.find((c) => c.id === id)?.title ?? "Course";

  const thisWeek = mondayOf(today);
  const sheets = state.timesheets.filter((t) => t.employeeId === me);
  const weekRow = (weekStart: string) => {
    const rows = sheets.filter((t) => t.weekStart === weekStart);
    const hours = rows.reduce((n, t) => n + Object.values(t.hours).reduce((a, b) => a + b, 0), 0);
    const status = !rows.length
      ? "not started"
      : rows.every((t) => t.status === "approved")
        ? "approved"
        : rows.some((t) => t.status === "draft")
          ? "draft"
          : "submitted";
    return { weekStart, hours, status };
  };

  return {
    viewer,
    firstName: employee.fullName.split(" ")[0],
    fullName: employee.fullName,
    today,
    countryName: employee.countryName ?? "your country",
    countryCode: employee.countryCode,
    currency: employee.currency,
    timeZone: employee.timeZone,
    shiftHours: employee.shiftHours,
    shiftName: employee.shiftName,
    todayShift: src.todayShift,
    weeklyOff: [...src.weeklyOffDays].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => DAY_NAMES[d]),
    // Same reporting line as the org chart and approvals.
    managerName: managementChain(viewer.id)[0]?.fullName,
    leaveRows: src.leaveTable.map((r) => ({ name: r.name, code: r.code, available: r.available, pending: r.pending, quota: r.quota, utilized: r.utilized })),
    leavePolicies: localPolicies.filter((p) => p.quota > 0).map((p) => ({ code: p.code, name: p.name, quota: p.quota, accrual: p.accrual, carryForwardMax: p.carryForwardMax })),
    policies: state.policies.map((p) => ({ title: p.title, body: p.body })),
    // Same catalog and audience filter as the Policies page.
    policyLibrary: policiesForPerson(
      { countryCode: (employee.countryCode ?? "IN") as CountryCode, legalEntity: employee.legalEntity, role: employee.role, employmentType: employee.employmentType },
      { holidays: myHolidays, shiftName: employee.shiftName, shiftHours: employee.shiftHours },
    ),
    policyCatalog: policyCatalog((code) => holidaysForCountry(state.holidays, code)),
    myLeave: state.leaveRequests
      .filter((r) => r.employeeId === me)
      .map((r) => ({
        type: policyName(r.code),
        code: r.code,
        from: r.from,
        to: r.to,
        days: workingDays(r.from, r.to, myHolidayDates, src.weeklyOffDays),
        status: r.status,
        appliedOn: r.appliedOn,
        decidedBy: r.decidedByName,
        note: r.decisionNote,
      }))
      .sort((a, b) => b.appliedOn.localeCompare(a.appliedOn) || b.from.localeCompare(a.from)),
    backdated: (state.backdatedPermissions ?? [])
      .filter((p) => p.employeeId === me)
      .map((p) => ({ type: policyName(p.code), from: p.from, to: p.to, status: p.status })),
    holidays: myHolidays.filter((h) => h.date >= today).map((h) => ({ date: h.date, name: h.name })),
    allHolidays: myHolidays.map((h) => ({ date: h.date, name: h.name })),
    approvals,
    approvalsCount: src.approvalsCount,
    teamSize: src.team.length,
    team: src.team.map((m) => ({ name: m.name, direct: m.direct, designation: m.designation })),
    teamLeave: [...leaveDays.entries()].map(([id, days]) => ({ name: name(id), days })).sort((a, b) => b.days - a.days),
    away,
    awayScope,
    orgWide: src.orgWide,
    workforce,
    recruiting,
    compReview: src.compReview,
    payslips: src.payslips.map((p) => ({
      label: new Date(Number(p.month.slice(0, 4)), Number(p.month.slice(5, 7)) - 1, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" }),
      month: p.month,
      currency: p.currency ?? "INR",
      gross: p.gross,
      net: p.net,
      deductions: p.deductions.map((d) => ({ name: d.name, amount: d.amount })),
      tax: p.deductions.filter((d) => TAX_LINE.test(d.name)).reduce((n, d) => n + d.amount, 0),
    })),
    timesheetWeeks: [weekRow(thisWeek), weekRow(addDaysISO(thisWeek, -7))],
    corrections: src.corrections
      .filter((c) => c.employeeId === me)
      .map((c) => ({ date: c.date, kind: c.kind.replace(/_/g, " "), status: c.status }))
      .sort((a, b) => b.date.localeCompare(a.date)),
    goals: {
      cycle: cycle.name,
      items: goals.map((g) => ({ title: g.title, progress: g.progress, weight: g.weight })),
      weighted: weightedProgress(goals),
      review: review ? `self review ${review.selfStatus.toLowerCase()}, manager review ${review.managerStatus.toLowerCase()}` : undefined,
    },
    learning: enrollments.map((e) => ({
      title: courseTitle(e.courseId),
      mandatory: COURSES.find((c) => c.id === e.courseId)?.mandatory ?? false,
      status: e.status,
      progress: e.progress,
      due: e.due,
    })),
    mandatoryCourses: COURSES.filter((c) => c.mandatory).map((c) => {
      const mineEnr = enrollments.find((e) => e.courseId === c.id);
      return { title: c.title, audience: c.audience, status: mineEnr?.status ?? "Not assigned", due: mineEnr?.due };
    }),
    expenses: [
      ...state.expenses.filter((x) => x.employeeId === me).map((x) => ({ kind: "Expense", category: x.category, amount: x.amount, currency: x.currency ?? employee.currency ?? "INR", status: x.status, date: x.date })),
      ...state.reimbursements.filter((x) => x.employeeId === me).map((x) => ({ kind: "Reimbursement", category: x.category, amount: x.amount, currency: (x as { currency?: string }).currency ?? employee.currency ?? "INR", status: x.status, date: x.date })),
    ],
    summarisePerson: src.summarisePerson,
  };
}
