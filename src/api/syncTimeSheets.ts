/**
 * Timesheets from the API (backend mode only): the user's projects, entries and weeks, the team's weeks to
 * approve, and utilization — in the portal's Project / Timesheet / OrgTimesheetRecord shapes.
 */
import { addDaysISO, mondayOf, todayISO } from "../model.ts";
import type { OrgTimesheetRecord, OrgTimesheetStatus, Project, TimeEntry, Timesheet, TimesheetStatus } from "../model.ts";
import { getPerson } from "../data/peopleLocal.ts";
import { api } from "./client.ts";
import { apiDelete, apiPut, createMirror, mutate, nameOf } from "./syncShared.ts";
import { approvalProgressText, type ApprovalProgressOut } from "./approvalProgress.ts";

export interface ProjectOut {
  id: string;
  code: string;
  name: string;
  client: string | null;
  billable_default: boolean;
  active: boolean;
}

export interface TimesheetEntryOut {
  id: string;
  employee_id: string;
  week_id: string;
  work_date: string;
  project_id: string;
  task: string;
  hours: number;
  billable: boolean;
  comment: string | null;
}

export interface TimesheetWeekOut {
  id: string;
  employee_id: string;
  employee_name: string | null;
  week_start: string;
  status: "draft" | "submitted" | "approved" | "rejected" | string;
  total_hours: number;
  submitted_at: string | null;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  /** The approval chain's steps and progress (null for weeks submitted before chains). */
  approval?: ApprovalProgressOut | null;
}

export interface UtilizationRow {
  id: string;
  name: string;
  total_hours: number;
  billable_hours: number;
  billable_pct: number;
}

export interface UtilizationOut {
  from_date: string;
  to_date: string;
  total_hours: number;
  billable_hours: number;
  billable_pct: number;
  people: UtilizationRow[];
  projects: UtilizationRow[];
}

/* Start time and the ticket/task a block was for aren't API fields; this browser remembers them per entry. */
const META_KEY = "timez.api.time-entry-meta";
type EntryMeta = Pick<TimeEntry, "startHour" | "workType" | "workId" | "workLabel">;

function readMeta(): Record<string, EntryMeta> {
  try {
    return JSON.parse(localStorage.getItem(META_KEY) ?? "{}") as Record<string, EntryMeta>;
  } catch {
    return {};
  }
}

function writeMeta(map: Record<string, EntryMeta>) {
  try {
    localStorage.setItem(META_KEY, JSON.stringify(map));
  } catch {
    /* storage blocked */
  }
}

/** One person's day (daily timesheets). id is null for a day not submitted yet. */
export interface TimesheetDayOut {
  id: string | null;
  employee_id: string;
  employee_name: string | null;
  work_date: string;
  status: "draft" | "submitted" | "approved" | "rejected" | string;
  total_hours: number;
  target_hours: number;
  day_kind: string | null;
  submitted_at: string | null;
  decided_by: string | null;
  decided_by_name: string | null;
  decided_at: string | null;
  decision_note: string | null;
  approval?: ApprovalProgressOut | null;
  waiting_on_me: boolean;
  can_decide: boolean;
  entries: WeekEntryOut[];
}

/** A person in the manager's Team timesheets: the week's days, hours per project and day status. */
export interface TeamPersonOut {
  employee_id: string;
  employee_name: string;
  employee_code: string;
  department: string;
  week_total: number;
  projects: Record<string, number>;
  days: TimesheetDayOut[];
}

interface RawTime {
  projects: ProjectOut[];
  entries: TimesheetEntryOut[];
  weeks: TimesheetWeekOut[];
  team: TimesheetWeekOut[];
  days: TimesheetDayOut[];
}

export interface ApiTimeState {
  projects: Project[];
  timesheets: Timesheet[];
  orgTimesheets: OrgTimesheetRecord[];
  /** The user's own weeks by week start (decision notes for sent-back weeks). */
  weeks: Record<string, TimesheetWeekOut>;
  /** The user's own submitted / approved / sent-back days by date (daily timesheets). */
  days: Record<string, TimesheetDayOut>;
}

const emptyTime = (): ApiTimeState => ({ projects: [], timesheets: [], orgTimesheets: [], weeks: {}, days: {} });

function sheetStatus(status: string): TimesheetStatus {
  return status === "submitted" || status === "approved" ? status : "draft"; // draft, rejected (sent back)
}

function orgStatus(status: string): OrgTimesheetStatus {
  return status === "submitted" || status === "approved" ? status : "draft";
}

function toProject(p: ProjectOut, employeeId: string): Project {
  return {
    id: p.id,
    name: p.name,
    code: p.code,
    vendor: "",
    client: p.client ?? "Internal",
    startDate: "",
    endDate: "",
    timesheetType: "Weekly",
    maxHours: null,
    status: p.active ? "current" : "previous",
    employeeId,
  };
}

function mapTime(raw: RawTime, accountId: string): ApiTimeState {
  const meta = readMeta();
  const weekById = new Map(raw.weeks.map((w) => [w.id, w]));
  const projectName = new Map(raw.projects.map((p) => [p.id, p.name]));
  // Blocks without a remembered start time stack from 09:30 in the order they were logged.
  const nextStart = new Map<string, number>();
  const sheets = new Map<string, Timesheet>();
  for (const e of raw.entries) {
    const week = weekById.get(e.week_id);
    const weekStart = week?.week_start ?? mondayOf(e.work_date);
    const key = `${e.week_id}|${e.project_id}`;
    const m = meta[e.id];
    const start = m?.startHour ?? nextStart.get(e.work_date) ?? 9.5;
    nextStart.set(e.work_date, Math.max(nextStart.get(e.work_date) ?? 9.5, start + e.hours));
    const entry: TimeEntry = {
      id: e.id,
      date: e.work_date,
      startHour: start,
      hours: e.hours,
      note: e.task,
      billable: e.billable,
      ...(m?.workType && m.workType !== "project" ? { workType: m.workType, workId: m.workId, workLabel: m.workLabel } : {}),
    };
    let sheet = sheets.get(key);
    if (!sheet) {
      sheet = { id: key, employeeId: e.employee_id, projectId: e.project_id, weekStart, hours: {}, entries: [], status: sheetStatus(week?.status ?? "draft") };
      sheets.set(key, sheet);
    }
    sheet.entries.push(entry);
    sheet.hours[e.work_date] = (sheet.hours[e.work_date] ?? 0) + e.hours;
  }
  const projectsByWeek = new Map<string, Set<string>>();
  for (const e of raw.entries) {
    const set = projectsByWeek.get(e.week_id) ?? new Set<string>();
    set.add(projectName.get(e.project_id) ?? e.project_id);
    projectsByWeek.set(e.week_id, set);
  }
  const orgTimesheets: OrgTimesheetRecord[] = raw.team.map((w) => {
    const person = getPerson(w.employee_id);
    return {
      id: w.id,
      personId: w.employee_id,
      name: w.employee_name ?? nameOf(w.employee_id),
      employeeCode: person?.employeeCode ?? "",
      department: person?.department ?? "",
      weekStart: w.week_start,
      hours: w.total_hours,
      status: orgStatus(w.status),
      projectSummary: [...(projectsByWeek.get(w.id) ?? [])].join(", "),
      ...(approvalProgressText(w.approval) ? { approvalProgress: approvalProgressText(w.approval) } : {}),
      ...(w.decision_note ? { decisionNote: w.decision_note } : {}),
      ...(w.decided_by ? { decidedBy: w.decided_by } : {}),
    };
  });
  return {
    projects: raw.projects.map((p) => toProject(p, accountId)),
    timesheets: [...sheets.values()],
    orgTimesheets,
    weeks: Object.fromEntries(raw.weeks.map((w) => [w.week_start, w])),
    days: Object.fromEntries(raw.days.map((d) => [d.work_date, d])),
  };
}

async function loadTime(): Promise<RawTime> {
  const today = todayISO();
  const [projects, entries, weeks, team, days] = await Promise.all([
    api.get<ProjectOut[]>("/timesheets/projects"),
    api.get<TimesheetEntryOut[]>("/timesheets/entries", { from: addDaysISO(mondayOf(today), -26 * 7), to: addDaysISO(mondayOf(today), 13) }),
    api.get<TimesheetWeekOut[]>("/timesheets/weeks", { view: "mine", limit: 100 }),
    api.get<TimesheetWeekOut[]>("/timesheets/weeks", { view: "team", limit: 300 }),
    // A server without daily timesheets (404) still shows entries and weeks.
    api.get<TimesheetDayOut[]>("/timesheets/days", { from: addDaysISO(mondayOf(today), -26 * 7), to: addDaysISO(mondayOf(today), 13) }).catch(() => []),
  ]);
  return { projects, entries, weeks, team, days };
}

export const timeMirror = createMirror<RawTime, ApiTimeState>(emptyTime, loadTime, mapTime);

/* ───────── Changes ───────── */

export function apiAddTimeEntry(projectId: string, input: Omit<TimeEntry, "id">): Promise<string | null> {
  return mutate(async () => {
    const out = await api.post<TimesheetEntryOut>("/timesheets/entries", {
      work_date: input.date,
      project_id: projectId,
      task: input.note.trim().slice(0, 200),
      hours: Math.round(input.hours * 4) / 4,
      billable: input.billable,
      comment: input.workLabel?.trim() || null,
    });
    const map = readMeta();
    map[out.id] = { startHour: input.startHour, workType: input.workType, workId: input.workId, workLabel: input.workLabel };
    writeMeta(map);
  }, timeMirror);
}

export function apiUpdateTimeEntry(entryId: string, projectId: string, input: Omit<TimeEntry, "id">): Promise<string | null> {
  return mutate(
    () =>
      apiPut<TimesheetEntryOut>(`/timesheets/entries/${encodeURIComponent(entryId)}`, {
        work_date: input.date,
        project_id: projectId,
        task: input.note.trim().slice(0, 200),
        hours: Math.round(input.hours * 4) / 4,
        billable: input.billable,
        comment: input.workLabel?.trim() || null,
      }),
    timeMirror,
  );
}

export function apiRemoveTimeEntry(entryId: string): Promise<string | null> {
  return mutate(async () => {
    await apiDelete(`/timesheets/entries/${encodeURIComponent(entryId)}`);
    const map = readMeta();
    delete map[entryId];
    writeMeta(map);
  }, timeMirror);
}


/** Submit one day (needs 9 h, 4.5 h on half-day leave) to the manager. */
export function apiSubmitDay(date: string): Promise<string | null> {
  return mutate(() => api.post<TimesheetDayOut>(`/timesheets/days/${encodeURIComponent(date)}/submit`), timeMirror);
}

/** Approve, or send back ("reject" with a comment) a submitted day. */
export function apiDecideDay(dayId: string, decision: "approve" | "reject", note?: string): Promise<string | null> {
  return mutate(
    () => api.post<TimesheetDayOut>(`/timesheets/days/${encodeURIComponent(dayId)}/decision`, { decision, note: note?.trim() || null }),
    timeMirror,
  );
}

/** Manager (HR for someone with no manager): open a missed past day so the person can log and submit it. */
export function apiReopenDay(employeeId: string, date: string, note: string): Promise<string | null> {
  return mutate(
    () => api.post<TimesheetDayOut>(`/timesheets/team/${encodeURIComponent(employeeId)}/days/${encodeURIComponent(date)}/reopen`, { note }),
    timeMirror,
  );
}

/** Team timesheets for a week: per person, per day hours by project and day status. */
export function loadApiTeamDays(weekStart: string): Promise<TeamPersonOut[]> {
  return api.get<TeamPersonOut[]>("/timesheets/team-days", { week_start: weekStart });
}

/** Everyone's submitted days the signed-in user can approve or send back now (any date). */
export function loadApiWaitingDays(): Promise<TimesheetDayOut[]> {
  return api.get<TimesheetDayOut[]>("/timesheets/days", { view: "waiting" });
}

/** Approve, or send back ("reject" with a note) a submitted week. */
export function apiDecideWeek(weekId: string, decision: "approve" | "reject", note?: string): Promise<string | null> {
  const text = note?.trim() || (decision === "reject" ? "Sent back for changes." : "");
  return mutate(
    () => api.post<TimesheetWeekOut>(`/timesheets/weeks/${encodeURIComponent(weekId)}/decision`, { decision, note: text || null }),
    timeMirror,
  );
}

/** Billable share of hours for everyone in the user's scope over a date range. */
export function loadApiUtilization(from: string, to: string): Promise<UtilizationOut> {
  return api.get<UtilizationOut>("/timesheets/utilization", { from, to });
}

export interface WeekEntryOut extends TimesheetEntryOut {
  project_code: string;
  project_name: string;
}

/** One week's entries with project names — for the person and whoever decides it. */
export function loadApiWeekDetail(weekId: string): Promise<{ week: TimesheetWeekOut; entries: WeekEntryOut[] }> {
  return api.get(`/timesheets/weeks/${encodeURIComponent(weekId)}/detail`);
}
