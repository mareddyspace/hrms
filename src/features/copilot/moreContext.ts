/**
 * More of the viewer's own data for the rule-based Copilot (same scope as the backend's
 * app/services/ai_more_context.py): profile facts, today's attendance and this month's late days, tasks and tickets,
 * tax declarations, trips, cash advances, the next pay date, directory cards for named colleagues (only what the
 * Directory shows anyone), the viewer's own reporting line, and department heads for org-wide viewers.
 * Never anyone else's pay, contact or personal details.
 */
import type { CopilotContext } from "../../data/platformData.ts";
import type { DemoAccount } from "../../demoAccounts.ts";
import { inHeadcount, type PersonRecord } from "../../data/peopleData.ts";
import { buildAttendanceHistory, type AttendanceCorrection, type TodaySession } from "../../data/attendanceData.ts";
import type { Ticket } from "../../data/ticketStore.ts";
import type { TravelRequest } from "../../data/travelStore.ts";
import { declarationsAsProofs } from "../taxdecl/taxDeclStore.ts";
import { holidaysForPerson, type Employee, type PortalState } from "../../model.ts";

export interface DirectoryCard {
  name: string;
  self: boolean;
  title: string;
  department: string;
  location: string;
  country: string;
  manager: string;
  joined: string;
  directReports: string[];
}

export interface CopilotMore {
  profile: {
    employeeCode?: string;
    designation: string;
    department: string;
    grade?: string;
    location: string;
    country: string;
    legalEntity?: string;
    joiningDate?: string;
    hiredBy?: string;
    hiringManager?: string;
    workArrangement?: string;
  };
  attendanceToday: { status: string; checkIn?: string; checkOut?: string };
  attendanceMonth: { month: string; present: number; absent: number; leave: number; wfh: number; missing: number; hours: number; lateDays: string[]; overtimeHours: number };
  tasks: { code: string; subject: string; status: string; due?: string; from: string }[];
  ticketsOwned: { id: string; title: string; status: string; priority: string; due?: string }[];
  ticketsRaised: number;
  tax: { fy: string; section: string; title: string; amount: number; currency: string; status: string }[];
  trips: { from: string; to: string; depart: string; back: string; status: string }[];
  cashAdvances: { category: string; amount: number; currency: string; status: string }[];
  nextPayday: string;
  /** Up to 4 directory cards for people whose name appears in the question. */
  findPeople: (question: string) => DirectoryCard[];
  /** The viewer's whole reporting line, by department and country (managers). */
  line?: { byDepartment: { name: string; count: number }[]; byCountry: { name: string; count: number }[] };
  /** Org-wide viewers only. */
  departmentHeads?: { department: string; head: string }[];
}

export type CopilotContextMore = CopilotContext & { more?: CopilotMore };

export interface MoreSources {
  today: string;
  viewer: DemoAccount;
  employee: Employee;
  state: PortalState;
  people: readonly PersonRecord[];
  teamIds: ReadonlySet<string>;
  orgWide: boolean;
  weeklyOffDays: number[];
  attendance?: { sessions: TodaySession[]; corrections: AttendanceCorrection[] };
  tickets?: readonly Ticket[];
  trips?: readonly TravelRequest[];
}

const NOT_NAMES = new Set(
  "may june april august will mark grace joy hope faith summer bill rich sunny the and what how who whom where when which does did can report reports manager team department head heads lead leave holiday my your our their his her this that with for from joined hired located work works title role job about tell show give is are was".split(" "),
);

/** Last working day of the month (as paydayFor in src/data/payslipGenerator.ts and the backend payday()). */
export function lastWorkingDay(year: number, month: number, country: string): string {
  const weekend = country === "SA" ? [5, 6] : [0, 6];
  const d = new Date(year, month, 0);
  while (weekend.includes(d.getDay())) d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function counts(values: string[]): { name: string; count: number }[] {
  const m = new Map<string, number>();
  for (const v of values) m.set(v || "Other", (m.get(v || "Other") ?? 0) + 1);
  return [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
}

export function buildMore(src: MoreSources): CopilotMore {
  const { today, employee, state, people } = src;
  const me = employee.id;
  const record = people.find((p) => p.id === me);
  const byId = new Map(people.map((p) => [p.id, p]));
  const nameOf = (id?: string) => (id ? byId.get(id)?.fullName ?? id : "nobody");

  // Attendance: same history the Attendance page builds.
  const monthStart = `${today.slice(0, 7)}-01`;
  const rows = src.attendance
    ? buildAttendanceHistory({
        employeeId: me,
        employeeName: employee.fullName,
        from: monthStart,
        to: today,
        holidays: holidaysForPerson(state.holidays, me),
        leaveRequests: state.leaveRequests,
        absences: state.absences,
        shiftHours: employee.shiftHours,
        corrections: src.attendance.corrections,
        weeklyOffDays: src.weeklyOffDays,
        sessions: src.attendance.sessions,
      })
    : [];
  const todayRow = rows.find((r) => r.date === today);
  const session = src.attendance?.sessions.find((s) => s.employeeId === me && s.date === today);
  const todayStatus = session?.checkOut
    ? "checked out"
    : session?.checkIn
      ? "checked in"
      : todayRow?.kind === "leave"
        ? "on leave"
        : todayRow?.kind === "holiday"
          ? "holiday"
          : todayRow?.kind === "weekend"
            ? "weekly off"
            : "not checked in";
  const past = rows.filter((r) => r.date <= today);
  const kind = (k: string) => past.filter((r) => r.kind === k).length;

  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  let nextPayday = lastWorkingDay(year, month, employee.countryCode ?? "IN");
  if (nextPayday < today) nextPayday = lastWorkingDay(month === 12 ? year + 1 : year, month === 12 ? 1 : month + 1, employee.countryCode ?? "IN");

  // Department heads: the most senior person in each department (their manager sits outside it).
  let departmentHeads: CopilotMore["departmentHeads"];
  const active = people.filter((p) => inHeadcount(p, today));
  if (src.orgWide) {
    const heads = new Map<string, { name: string; reports: number }>();
    for (const p of active) {
      const mgr = byId.get(p.managerId);
      if (mgr && mgr.department === p.department && inHeadcount(mgr, today)) continue;
      const reports = active.filter((x) => x.managerId === p.id).length;
      const cur = heads.get(p.department);
      if (!cur || reports > cur.reports) heads.set(p.department, { name: p.fullName, reports });
    }
    departmentHeads = [...heads.entries()].map(([department, h]) => ({ department, head: h.name })).sort((a, b) => a.department.localeCompare(b.department));
  }

  const lineRows = active.filter((p) => src.teamIds.has(p.id));

  return {
    profile: {
      employeeCode: record?.employeeCode,
      designation: record?.designation ?? employee.designation ?? "",
      department: record?.department ?? employee.department ?? "",
      grade: record?.grade,
      location: record?.location ?? "",
      country: record?.countryName ?? employee.countryName ?? "",
      legalEntity: record?.legalEntity ?? employee.legalEntity,
      joiningDate: record?.dateOfJoining,
      hiredBy: record?.hiredBy,
      hiringManager: record?.hiringManager,
      workArrangement: (record as { workArrangement?: string } | undefined)?.workArrangement,
    },
    attendanceToday: { status: todayStatus, checkIn: session?.checkIn, checkOut: session?.checkOut },
    attendanceMonth: {
      month: today.slice(0, 7),
      present: kind("present"),
      absent: kind("absent"),
      leave: kind("leave"),
      wfh: kind("wfh"),
      missing: kind("missing_punch"),
      hours: Math.round(past.reduce((n, r) => n + (r.hoursWorked || 0), 0) * 10) / 10,
      lateDays: past.filter((r) => r.lateMinutes > 0).map((r) => r.date),
      overtimeHours: Math.round(past.reduce((n, r) => n + r.overtimeMinutes, 0) / 6) / 10,
    },
    tasks: state.tasks
      .filter((t) => t.employeeId === me && t.status !== "done")
      .sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999"))
      .map((t) => ({ code: t.code, subject: t.subject, status: t.status, due: t.due || undefined, from: t.assignedBy })),
    ticketsOwned: (src.tickets ?? [])
      .filter((t) => (t.assigneeId === me || t.subOwnerId === me) && t.status !== "Resolved" && t.status !== "Closed")
      .map((t) => ({ id: t.id, title: t.title, status: t.status, priority: t.priority, due: t.due })),
    ticketsRaised: (src.tickets ?? []).filter((t) => t.requesterId === me && t.status !== "Resolved" && t.status !== "Closed").length,
    tax: declarationsAsProofs(state.investmentProofs)
      .filter((p) => p.employeeId === me)
      .map((p) => ({ fy: p.financialYear, section: p.section, title: p.title, amount: p.amount, currency: p.currency ?? employee.currency ?? "INR", status: p.status })),
    trips: (src.trips ?? [])
      .filter((t) => t.employeeId === me)
      .sort((a, b) => b.departOn.localeCompare(a.departOn))
      .map((t) => ({ from: t.fromCity, to: t.toCity, depart: t.departOn, back: t.returnOn, status: t.status })),
    cashAdvances: state.cashAdvances
      .filter((c) => c.employeeId === me)
      .map((c) => ({ category: c.category, amount: c.amount, currency: c.currency ?? employee.currency ?? "INR", status: c.status })),
    nextPayday,
    findPeople: (question: string) => {
      const words = new Set(
        question
          .toLowerCase()
          .replace(/'s\b/g, "")
          .split(/[^a-z'-]+/)
          .filter((w) => w.length > 2 && !NOT_NAMES.has(w)),
      );
      if (!words.size) return [];
      const hits = people.filter((p) => {
        if (p.employmentStatus === "Terminated") return false;
        const parts = p.fullName.toLowerCase().split(" ");
        return parts.some((w) => words.has(w)) || (p.preferredName && words.has(p.preferredName.toLowerCase()));
      });
      const rank = (p: PersonRecord) => {
        const parts = p.fullName.toLowerCase().split(" ");
        let s = parts.filter((w) => words.has(w)).length * 4;
        if (src.teamIds.has(p.id) || p.id === record?.managerId || p.managerId === record?.managerId) s += 2;
        if (p.department === record?.department) s += 1;
        if (String(p.countryCode) === String(record?.countryCode)) s += 1;
        return s;
      };
      return hits
        .sort((a, b) => rank(b) - rank(a) || a.fullName.localeCompare(b.fullName))
        .slice(0, 4)
        .map((p) => ({
          name: p.fullName,
          self: p.id === me,
          title: p.designation,
          department: p.department,
          location: p.location,
          country: p.countryName || String(p.countryCode),
          manager: p.managerName || nameOf(p.managerId),
          joined: p.dateOfJoining,
          directReports: active.filter((x) => x.managerId === p.id).map((x) => x.fullName).sort(),
        }));
    },
    line: lineRows.length ? { byDepartment: counts(lineRows.map((p) => p.department)), byCountry: counts(lineRows.map((p) => p.countryName || String(p.countryCode))) } : undefined,
    departmentHeads,
  };
}
