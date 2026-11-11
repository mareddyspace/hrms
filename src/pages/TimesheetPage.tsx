import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ActionButton, Banner, Card, Dialog, Page, StatusBadge, StatusPill, downloadText, notify } from "../components/ui.tsx";
import {
  DAY_STATUS_LABEL,
  DAY_STATUS_TONE,
  dayRecordFor,
  dayTargetFor,
  halfDayTargetFor,
  isFixable,
  legacyLockedDate,
  shortfallText,
  useDayRecords,
  type TimeTone,
} from "../data/timesheetDays.ts";
import { TimesheetTeamDays, ToneChip } from "./TimesheetTeamDays.tsx";
import { pendingMirror } from "../api/syncTimeApprovals.ts";
import { managementChain } from "../demoAccounts.ts";
import {
  blockingLeave,
  holidaysForPerson,
  formatHoursAmount,
  formatShortDate,
  halfDayLeave,
  monthLabel,
  mondayOf,
  parseISODate,
  shiftWeek,
  todayISO,
  weekDates,
} from "../model.ts";
import { usePortal } from "../store.tsx";
import { scheduleForEmployee } from "../data/workSchedule.ts";
import { refreshTickets, ticketsAssignedTo, useTickets } from "../data/ticketStore.ts";
import type { Project, Task } from "../model.ts";
import { addDaysISO } from "../model.ts";
import { API_ENABLED } from "../api/client.ts";
import { apiSaveDay, loadApiUtilization, timeMirror, type UtilizationOut } from "../api/syncTimeSheets.ts";
import { TimesheetTeamDetail } from "./TimesheetTeamDetail.tsx";
import { AttendanceStrip, durationText, useTodayAttendance } from "../components/AttendanceStrip.tsx";
import { autoCheckedOutOn, getAttendanceState, subscribeAttendance } from "../data/attendanceLocal.ts";
import { useProjects, TASK_STATUS_LABEL, type PTask } from "../data/projectStore.ts";
import { useProjectContext } from "./projectContext.ts";
import type { TimeEntry } from "../model.ts";
import "./tickets.css";
import "./timesheetExtras.css";
import "../styles/time.css";

type CalendarBlock = {
  id: string;
  projectId: string;
  projectName: string;
  date: string;
  startHour: number;
  hours: number;
  breakMinutes: number;
  note: string;
  billable: boolean;
  workType: WorkType;
  workId: string;
  workLabel: string;
};

type WorkType = "project" | "ticket" | "task";
type Range = "week" | "month";

/** One row of the day editor. work is "" (general project time) or "ticket:<id>" / "task:<id>" (project tasks are "task:pt-…"). */
type Row = {
  key: string;
  start: string;
  end: string;
  projectId: string;
  work: string;
  workLabel: string;
  billable: boolean;
  note: string;
  breakMinutes: number;
};

/** 9.5 -> "09:30" (for time inputs) and back. */
function toHHMM(hour: number): string {
  const total = Math.round(hour * 60);
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function fromHHMM(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return null;
  return Number(match[1]) + Number(match[2]) / 60;
}

/** Start and end of a row in hours; an end of 00:00 is midnight at the end of the day. */
function rowSpan(r: Pick<Row, "start" | "end">): { start: number; end: number } | null {
  const start = fromHHMM(r.start);
  let end = fromHHMM(r.end);
  if (start === null || end === null) return null;
  if (end === 0 && start > 0) end = 24;
  return { start, end };
}

const quarter = (h: number) => Math.round(h * 4) / 4;

/** Internal clients are non-billable by default; client work is billable. */
function billableFor(project: Project | undefined): boolean {
  return !!project && !/alderline|internal/i.test(project.client);
}

function parseWork(raw: string | null): { type: "ticket" | "task"; id: string } | null {
  if (!raw) return null;
  const [type, ...rest] = raw.split(":");
  const id = rest.join(":");
  return (type === "ticket" || type === "task") && id ? { type, id } : null;
}

function weekRangeLabel(weekStart: string): string {
  return `${formatShortDate(weekStart)} – ${formatShortDate(addDaysISO(weekStart, 6))}`;
}

function monthDays(ym: string): string[] {
  const [y, m] = ym.split("-").map(Number);
  const count = new Date(y, m, 0).getDate();
  return Array.from({ length: count }, (_, i) => `${ym}-${String(i + 1).padStart(2, "0")}`);
}

/** "09:41" from an ISO time stamp (attendance check-in / check-out), in the browser's time zone. */
function clockOf(iso: string | undefined): string | null {
  if (!iso) return null;
  if (/^\d{2}:\d{2}$/.test(iso)) return iso;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const csvCell = (v: string | number) => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
const rowSig = (rows: Row[]) => JSON.stringify(rows.map(({ key: _key, ...rest }) => rest));
const tick = () => new Promise<void>((resolve) => window.setTimeout(resolve, 20));
let rowSeq = 0;

type TimesheetView = "mine" | "company";

export function TimesheetPage() {
  const portal = usePortal();
  const { currentProjects, state, employee, isManager, canDecideFor, demoProfile, taskAction } = portal;
  // Local mode saves a day block by block; each step needs the store as it is after the previous one.
  const portalRef = useRef(portal);
  portalRef.current = portal;
  const projects = currentProjects;
  const [params, setParams] = useSearchParams();
  // /timesheet?view=team (from an approval notification) opens the team tab.
  const [view, setView] = useState<TimesheetView>(() => (params.get("view") === "team" ? "company" : "mine"));
  const [openRow, setOpenRow] = useState<string | null>(null);
  const teamLabel = "Team timesheets";
  // /timesheet?day=YYYY-MM-DD (from the 9-hour check-out notice) opens that day.
  const linkedDay = /^\d{4}-\d{2}-\d{2}$/.test(params.get("day") ?? "") && (params.get("day") ?? "") <= todayISO() ? params.get("day")! : null;
  const [weekStart, setWeekStart] = useState(() => mondayOf(linkedDay ?? todayISO()));
  const [range, setRange] = useState<Range>("week");
  const [selDay, setSelDay] = useState(linkedDay ?? todayISO());
  const [month, setMonth] = useState(() => todayISO().slice(0, 7));
  const [editing, setEditing] = useState<{ day: string; rows: Row[] } | null>(null);
  const [taskInfo, setTaskInfo] = useState<Task | null>(null);
  const [projTaskInfo, setProjTaskInfo] = useState<(PTask & { projectId: string; projectName: string }) | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const viewParam = params.get("view");
  useEffect(() => {
    // The breadcrumb (/timesheet with no view) takes the page back to My timesheet.
    setView(viewParam === "team" ? "company" : "mine");
  }, [viewParam]);
  function chooseView(next: TimesheetView) {
    setView(next);
    const nextParams = new URLSearchParams(params);
    nextParams.set("view", next === "company" ? "team" : "mine");
    setParams(nextParams, { replace: true });
  }
  const dayRecords = useDayRecords();
  const myDay = (day: string) => dayRecordFor(dayRecords, employee.id, day);
  const pending = useSyncExternalStore(pendingMirror.subscribe, pendingMirror.get, pendingMirror.get);
  const attState = useSyncExternalStore(subscribeAttendance, getAttendanceState, getAttendanceState);
  const tickets = useTickets();
  // Backend mode only loads tickets when asked; without this the ticket list stays empty until the Tickets page is opened.
  useEffect(() => {
    void refreshTickets();
  }, []);
  const myTickets = useMemo(() => ticketsAssignedTo(employee.id, tickets), [employee.id, tickets]);
  const myTasks = useMemo(
    () => state.tasks.filter((t) => t.employeeId === employee.id && (t.status === "open" || t.status === "progress")),
    [employee.id, state.tasks],
  );
  const loggableTasks = myTasks.filter((t) => t.accepted);
  // Project tasks (Projects page) assigned to me and still open, by project.
  const projectCtx = useProjectContext();
  const projectInfos = useProjects(projectCtx);
  const myProjectTasks = useMemo(
    () =>
      projectInfos
        .filter((p) => p.active)
        .flatMap((p) => p.tasks.filter((t) => t.assigneeId === employee.id && t.status !== "done").map((t) => ({ ...t, projectId: p.id, projectName: p.name }))),
    [projectInfos, employee.id],
  );
  // Backend mode: the API lists only the weeks this user decides, and knows why a week was sent back.
  const apiTime = useSyncExternalStore(timeMirror.subscribe, timeMirror.get, timeMirror.get);
  const decides = (personId: string) => API_ENABLED || canDecideFor(personId);
  // Waiting count for the Team timesheets tab: submitted days (and older submitted weeks) I can decide now.
  const isHr = demoProfile.role === "hr" || demoProfile.role === "hr_admin";
  const waitingCount = API_ENABLED
    ? pending.items.filter((i) => i.kind === "timesheet_day" || i.kind === "timesheet_week").length
    : dayRecords.filter(
        (r) =>
          r.status === "submitted" &&
          r.personId !== employee.id &&
          (canDecideFor(r.personId, "timesheets") || (isHr && managementChain(r.personId).length === 0)),
      ).length +
      state.orgTimesheets.filter((row) => row.status === "submitted" && row.personId !== employee.id && canDecideFor(row.personId, "timesheets")).length;
  const [utilization, setUtilization] = useState<UtilizationOut | null>(null);
  useEffect(() => {
    if (!API_ENABLED || view !== "company") return;
    let stale = false;
    loadApiUtilization(weekStart, addDaysISO(weekStart, 6))
      .then((out) => {
        if (!stale) setUtilization(out);
      })
      .catch(() => {
        if (!stale) setUtilization(null);
      });
    return () => {
      stale = true;
    };
  }, [view, weekStart, apiTime]);

  useEffect(() => {
    if (!isManager && view === "company") setView("mine");
  }, [isManager, view]);

  // The person's own working days (e.g. Sun–Thu in Saudi Arabia), not a fixed Mon–Fri.
  const weeklyOffDays = scheduleForEmployee({
    shiftName: employee.shiftName,
    shiftHours: employee.shiftHours,
    countryCode: employee.countryCode,
  }).weeklyOffDays;
  const isWorkDay = (d: string) => !weeklyOffDays.includes(parseISODate(d).getDay());
  const weekDays = weekDates(weekStart);

  // Approved leave and holidays are non-working days; no hours can go on them.
  const holidayByDate = useMemo(() => new Map(holidaysForPerson(state.holidays, employee.id).map((h) => [h.date, h.name])), [state.holidays, employee.id]);
  const offDayFor = (day: string): string | undefined => {
    if (holidayByDate.has(day)) return `Holiday · ${holidayByDate.get(day)}`;
    if (blockingLeave(state.leaveRequests, employee.id, day)) {
      const request = state.leaveRequests.find((r) => r.employeeId === employee.id && r.status === "approved" && r.from <= day && day <= r.to);
      const name = state.leavePolicies.find((p) => p.code === request?.code)?.name ?? "Leave";
      return `On leave · ${name}`;
    }
    return undefined;
  };

  // Every block I logged (any week).
  const allBlocks = useMemo<CalendarBlock[]>(() => {
    const list: CalendarBlock[] = [];
    for (const sheet of state.timesheets) {
      if (sheet.employeeId !== employee.id) continue;
      const project = projects.find((item) => item.id === sheet.projectId) ?? state.projects.find((item) => item.id === sheet.projectId);
      for (const entry of sheet.entries ?? []) {
        list.push({
          id: entry.id,
          projectId: sheet.projectId,
          projectName: project?.name ?? "Project",
          date: entry.date,
          startHour: entry.startHour,
          hours: entry.hours,
          breakMinutes: entry.breakMinutes ?? 0,
          note: entry.note,
          billable: entry.billable,
          workType: entry.workType ?? "project",
          workId: entry.workId ?? "",
          workLabel: entry.workLabel ?? "",
        });
      }
    }
    return list.sort((a, b) => a.date.localeCompare(b.date) || a.startHour - b.startHour);
  }, [projects, state.projects, state.timesheets, employee.id]);
  const allBlocksRef = useRef(allBlocks);
  allBlocksRef.current = allBlocks;
  const weekEnd = addDaysISO(weekStart, 6);
  const blocks = useMemo(() => allBlocks.filter((b) => b.date >= weekStart && b.date <= weekEnd), [allBlocks, weekStart, weekEnd]);
  const hoursOn = (day: string) => round2(allBlocks.filter((b) => b.date === day).reduce((sum, b) => sum + b.hours, 0));

  const weekStatusOf = (ws: string) => {
    const sheets = state.timesheets.filter((sheet) => sheet.employeeId === employee.id && sheet.weekStart === ws);
    return sheets.some((sheet) => sheet.status === "approved") ? "approved" : sheets.some((sheet) => sheet.status === "submitted") ? "submitted" : "draft";
  };
  const weekStatus = weekStatusOf(weekStart);
  // A week submitted the old (weekly) way only locks the days it covered; other days are logged day by day.
  const legacyDay = (day: string) => legacyLockedDate(weekStatusOf(mondayOf(day)) !== "draft", day, hoursOn(day) > 0, myDay(day));
  // Time is logged on the day itself; a week the manager sent back can be fixed on any of its days.
  const weekSentBackFor = (ws: string) =>
    API_ENABLED
      ? apiTime.weeks[ws]?.status === "rejected"
      : state.orgTimesheets.some((row) => row.personId === employee.id && row.weekStart === ws && row.status === "draft" && !!row.decidedBy);
  const daySentBack = (day: string) => isFixable(myDay(day)?.status);
  const dayLocked = (day: string) => {
    const status = myDay(day)?.status;
    return status === "submitted" || status === "approved";
  };
  const canLogOn = (day: string) =>
    isWorkDay(day) && !offDayFor(day) && !dayLocked(day) && !legacyDay(day) &&
    (day === todayISO() || weekSentBackFor(mondayOf(day)) || daySentBack(day) || autoCheckedOutOn(employee.id, day));
  const approverName = managementChain(employee.id)[0]?.fullName ?? "HR";
  const managerFirstName = approverName.split(" ")[0] || "your manager";
  /** Why a day can't take time. */
  function whyLocked(day: string): string {
    if (!isWorkDay(day)) return `${formatShortDate(day)} is a weekly off.`;
    const off = offDayFor(day);
    if (off) return `${formatShortDate(day)}: ${off}. No hours on this day.`;
    const rec = myDay(day);
    if (rec?.status === "submitted") return `Waiting on ${rec.approvalLabel ?? approverName}. Locked until it's decided.`;
    if (rec?.status === "approved") return `Approved${rec.decidedByName ? ` by ${rec.decidedByName}` : ""}. Locked.`;
    if (legacyDay(day)) return `${formatShortDate(day)} was submitted with the whole week and can't be changed.`;
    if (day > todayISO()) return "Time is logged on the day itself, not ahead.";
    return `Time is logged on the day itself. Ask ${managerFirstName} to reopen ${formatShortDate(day)} if you missed it.`;
  }

  /** Tickets carry a project id; tasks a project or client name. Unmatched work goes to the internal project. */
  function projectForWork(type: WorkType, id: string): Project | undefined {
    const same = (a?: string, b?: string) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
    const internal = projects.find((p) => /internal/i.test(p.name) || p.client === "Internal") ?? projects[0];
    if (type === "ticket") {
      const t = tickets.find((x) => x.id === id);
      return projects.find((p) => p.id === t?.projectId) ?? projects.find((p) => same(p.name, t?.projectName)) ?? internal;
    }
    if (type === "task") {
      const pt = myProjectTasks.find((x) => x.id === id);
      if (pt) return projects.find((p) => p.id === pt.projectId) ?? internal;
      const t = state.tasks.find((x) => x.id === id);
      return (
        projects.find((p) => same(p.name, t?.projectName)) ??
        projects.find((p) => !!t?.projectName && p.name.toLowerCase().startsWith(t.projectName.toLowerCase().split(" ")[0])) ??
        projects.find((p) => same(p.client, t?.client)) ??
        internal
      );
    }
    return projects.find((p) => p.id === id) ?? projects[0];
  }

  function workLabelFor(type: WorkType, id: string): string {
    if (type === "ticket") {
      const t = tickets.find((x) => x.id === id);
      return t ? `${t.id} ${t.title}` : id;
    }
    if (type === "task") {
      const pt = myProjectTasks.find((x) => x.id === id);
      if (pt) return `${pt.code} ${pt.title}`;
      const t = state.tasks.find((x) => x.id === id);
      return t ? `${t.code} ${t.subject}` : id;
    }
    return "";
  }
  /** What the work is called, for a row's description when none is typed. */
  function workTitleFor(type: WorkType, id: string): string {
    if (type === "ticket") return tickets.find((x) => x.id === id)?.title ?? "";
    if (type === "task") return myProjectTasks.find((x) => x.id === id)?.title ?? state.tasks.find((x) => x.id === id)?.subject ?? "";
    return "";
  }

  /** Minimum hours to submit a day: the person's normal day (dayTargetFor), half on half-day leave, 0 on leave / days off. */
  function targetFor(day: string): number {
    if (offDayFor(day) || !isWorkDay(day)) return 0;
    return halfDayLeave(state.leaveRequests, employee.id, day) ? halfDayTargetFor(employee) : dayTargetFor(employee);
  }

  const today = todayISO();
  const att = useTodayAttendance();
  const sessionOn = (day: string) => attState.sessions.find((s) => s.employeeId === employee.id && s.date === day);
  // Days to fix: sent back or reopened by the manager (any week), oldest first.
  const daysToFix = dayRecords
    .filter((r) => r.personId === employee.id && r.date !== today && isFixable(r.status))
    .sort((a, b) => a.date.localeCompare(b.date));
  // Earlier days the server stopped at 9 hours whose timesheet isn't in yet: the person adds and submits them.
  const autoDays = attState.sessions
    .filter((s) => s.employeeId === employee.id && s.autoCheckout && s.date !== today)
    .map((s) => s.date)
    .filter((d) => !myDay(d))
    .sort();

  /* ───────── the period: a week strip or a month ───────── */
  const periodDays = range === "week" ? weekDays : monthDays(month);
  const periodLabel = range === "week" ? weekRangeLabel(weekStart) : monthLabel(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1);
  const periodBlocks = allBlocks.filter((b) => b.date >= periodDays[0] && b.date <= periodDays[periodDays.length - 1]);
  const periodTotal = round2(periodBlocks.reduce((a, b) => a + b.hours, 0));
  const periodBillable = round2(periodBlocks.filter((b) => b.billable).reduce((a, b) => a + b.hours, 0));
  const periodTarget = periodDays.reduce((a, d) => a + targetFor(d), 0);
  /** Past working days still short of the minimum and not submitted: missing time. */
  const isMissing = (d: string) => {
    if (d >= today || !isWorkDay(d) || targetFor(d) === 0 || legacyDay(d)) return false;
    const status = myDay(d)?.status;
    if (status === "submitted" || status === "approved") return false;
    return hoursOn(d) < targetFor(d);
  };
  const missingDays = periodDays.filter(isMissing);
  const statusCounts = periodDays.reduce(
    (acc, d) => {
      const s = myDay(d)?.status;
      if (s === "approved") acc.approved += 1;
      else if (s === "submitted") acc.pending += 1;
      else if (s === "rejected" || s === "reopened") acc.back += 1;
      return acc;
    },
    { approved: 0, pending: 0, back: 0 },
  );

  /** A day's colour and word in the legend. */
  function dayLook(d: string): { tone: TimeTone; label: string; dashed?: boolean } {
    const rec = myDay(d);
    if (rec) return { tone: DAY_STATUS_TONE[rec.status], label: DAY_STATUS_LABEL[rec.status] };
    if (!isWorkDay(d)) return { tone: "grey", label: "Weekly off" };
    const off = offDayFor(d);
    if (off?.startsWith("Holiday")) return { tone: "blue", label: "Holiday" };
    if (off) return { tone: "purple", label: "Leave" };
    if (isMissing(d)) return { tone: "red", label: "Missing", dashed: true };
    if (d > today) return { tone: "none", label: "" };
    return { tone: "grey", label: "Draft" };
  }

  /* ───────── the day editor ───────── */
  function rowFromBlock(b: CalendarBlock): Row {
    return {
      key: b.id,
      start: toHHMM(b.startHour),
      end: toHHMM(b.startHour + b.hours + b.breakMinutes / 60),
      projectId: b.projectId,
      work: b.workType === "project" || !b.workId ? "" : `${b.workType}:${b.workId}`,
      workLabel: b.workLabel,
      billable: b.billable,
      note: b.note,
      breakMinutes: b.breakMinutes,
    };
  }
  const baseRows = useMemo(() => allBlocks.filter((b) => b.date === selDay).map(rowFromBlock), [allBlocks, selDay]);
  const rows = editing && editing.day === selDay ? editing.rows : baseRows;
  const dirty = !!editing && editing.day === selDay && rowSig(editing.rows) !== rowSig(baseRows);
  const editable = canLogOn(selDay);
  const selTarget = targetFor(selDay);
  const selRecord = myDay(selDay);

  function rowHours(r: Row): number {
    const span = rowSpan(r);
    return span ? round2(span.end - span.start - r.breakMinutes / 60) : 0;
  }
  const rowsTotal = round2(rows.reduce((a, r) => a + Math.max(0, rowHours(r)), 0));
  const rowsBillable = round2(rows.filter((r) => r.billable).reduce((a, r) => a + Math.max(0, rowHours(r)), 0));

  /** Problems per row (and for the day), checked before anything is saved. */
  const rowErrors = useMemo(() => {
    const out: Record<string, string> = {};
    const spans: { key: string; start: number; end: number }[] = [];
    for (const r of rows) {
      const span = rowSpan(r);
      if (!r.projectId) out[r.key] = "Choose a project.";
      else if (!span) out[r.key] = "Enter a start and an end time.";
      else if (span.end <= span.start) out[r.key] = "The end must be after the start.";
      else if (span.end - span.start - r.breakMinutes / 60 <= 0) out[r.key] = "The break is as long as the block.";
      else spans.push({ key: r.key, ...span });
    }
    spans.sort((a, b) => a.start - b.start);
    for (let i = 1; i < spans.length; i += 1) {
      if (spans[i].start < spans[i - 1].end - 1e-6 && !out[spans[i].key]) out[spans[i].key] = `Overlaps ${toHHMM(spans[i - 1].start)}–${toHHMM(spans[i - 1].end)}.`;
    }
    return out;
  }, [rows]);
  const hasRowErrors = Object.keys(rowErrors).length > 0;

  function setRows(next: Row[]) {
    setFormError(null);
    setEditing({ day: selDay, rows: next });
  }
  function updateRow(key: string, patch: Partial<Row>) {
    setRows(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }
  /** A new block: from where the day's last block ends (or the check-in), long enough to reach the day's target. */
  function newRow(day: string, current: Row[], preset?: Partial<Row>): Row {
    const lastEnd = current.reduce((max, r) => Math.max(max, rowSpan(r)?.end ?? 0), 0);
    const checkIn = clockOf(sessionOn(day)?.checkIn);
    const start = lastEnd > 0 ? lastEnd : quarter(fromHHMM(checkIn ?? "") ?? 9.5);
    const logged = current.reduce((a, r) => a + Math.max(0, rowHours(r)), 0);
    const toGo = targetFor(day) - logged;
    const end = Math.min(24, start + (toGo > 0 ? quarter(toGo) || 0.25 : 1));
    const last = current[current.length - 1];
    const projectId = last?.projectId ?? projects[0]?.id ?? "";
    return {
      key: `new-${(rowSeq += 1)}`,
      start: toHHMM(Math.min(start, 23.75)),
      end: end >= 24 ? "00:00" : toHHMM(end),
      projectId,
      work: "",
      workLabel: "",
      billable: last?.billable ?? billableFor(projects.find((p) => p.id === projectId)),
      note: "",
      breakMinutes: 0,
      ...preset,
    };
  }
  function addRow(preset?: Partial<Row>) {
    setRows([...rows, newRow(selDay, rows, preset)]);
  }
  function chooseRowWork(key: string, work: string) {
    const parsed = parseWork(work);
    const row = rows.find((r) => r.key === key);
    if (!row) return;
    if (!parsed) {
      updateRow(key, { work: "", workLabel: "" });
      return;
    }
    const project = projectForWork(parsed.type, parsed.id);
    updateRow(key, {
      work,
      workLabel: workLabelFor(parsed.type, parsed.id),
      projectId: project?.id ?? row.projectId,
      billable: billableFor(project),
      note: row.note.trim() ? row.note : workTitleFor(parsed.type, parsed.id),
    });
  }
  /** Check-in to check-out of the day (from attendance) as one block. */
  const selSession = sessionOn(selDay);
  const attIn = clockOf(selSession?.checkIn);
  const attOut = clockOf(selSession?.checkOut);
  function fillFromAttendance() {
    if (!attIn || !attOut) return;
    if (rows.length > 0 && !window.confirm("Replace the blocks with one block from check-in to check-out?")) return;
    const brk = (selSession?.breaks ?? []).reduce((sum, b) => {
      const s = clockOf(b.start);
      const e = clockOf(b.end);
      const a = s ? fromHHMM(s) : null;
      const z = e ? fromHHMM(e) : null;
      return a !== null && z !== null && z > a ? sum + Math.round((z - a) * 60) : sum;
    }, 0);
    const base = newRow(selDay, []);
    setRows([{ ...base, start: attIn, end: attOut, breakMinutes: brk }]);
  }

  function inputFor(day: string, r: Row): { projectId: string; input: Omit<TimeEntry, "id"> } {
    const span = rowSpan(r)!;
    const parsed = parseWork(r.work);
    const project = projects.find((p) => p.id === r.projectId) ?? state.projects.find((p) => p.id === r.projectId);
    const note = (r.note.trim() || (parsed ? workTitleFor(parsed.type, parsed.id) || r.workLabel : "") || project?.name || "Project work").slice(0, 200);
    return {
      projectId: r.projectId,
      input: {
        date: day,
        startHour: span.start,
        hours: round2(span.end - span.start - r.breakMinutes / 60),
        ...(r.breakMinutes ? { breakMinutes: r.breakMinutes } : {}),
        note,
        billable: r.billable,
        workType: parsed?.type ?? "project",
        ...(parsed ? { workId: parsed.id, workLabel: r.workLabel || workLabelFor(parsed.type, parsed.id) } : {}),
      },
    };
  }

  /** Save the day's blocks: in one call to the API; in this browser block by block (the old ones out, the new ones in). */
  async function saveRows(day: string, list: Row[]): Promise<string | null> {
    if (Object.keys(rowErrors).length) return "Fix the highlighted blocks first.";
    if (list.reduce((a, r) => a + rowHours(r), 0) > 24) return "A day can't have more than 24 h.";
    const items = list.map((r) => inputFor(day, r));
    if (API_ENABLED) return apiSaveDay(day, items);
    for (const b of allBlocksRef.current.filter((x) => x.date === day)) {
      const error = await portalRef.current.removeTimeEntry(b.projectId, mondayOf(day), b.id);
      if (error) return error;
      await tick();
    }
    for (const item of items) {
      const error = await portalRef.current.addTimeEntry(item.projectId, mondayOf(day), item.input);
      if (error) return error;
      await tick();
    }
    return null;
  }

  async function onSave(): Promise<string | null> {
    const error = await saveRows(selDay, rows);
    if (error) {
      setFormError(error);
      return error;
    }
    setEditing(null);
    setFormError(null);
    return null;
  }

  async function onSubmit(): Promise<string | null> {
    if (dirty) {
      const error = await onSave();
      if (error) return error;
      await tick();
    }
    const error = await portalRef.current.submitDayTimesheet(selDay);
    if (error) {
      setFormError(error);
      return error;
    }
    setMessage({ tone: "ok", text: `${formatShortDate(selDay)} submitted for approval.` });
    notify(`Timesheet for ${formatShortDate(selDay)} sent to ${approverName}.`);
    return null;
  }

  const needCheckOut = selDay === today && (selRecord?.status ?? "draft") === "draft" && selTarget > 0 && !att.checkedOut;
  const shortBy = shortfallText(rowsTotal, selTarget);
  const submitBlocked = hasRowErrors
    ? "Fix the highlighted blocks"
    : needCheckOut
      ? "Check out first"
      : selTarget === 0 && rowsTotal === 0
        ? "Nothing to submit"
        : shortBy;
  const overLogged = selDay === today && att.checkedOut && rowsTotal * 60 > att.minutes + 30;

  /** Pick a day in the strip (asks before dropping unsaved changes). */
  function selectDay(d: string): boolean {
    if (d !== selDay && dirty && !window.confirm(`Discard the unsaved changes on ${formatShortDate(selDay)}?`)) return false;
    if (d !== selDay) {
      setEditing(null);
      setFormError(null);
      setSelDay(d);
    }
    setWeekStart(mondayOf(d));
    return true;
  }
  function moveRange(delta: number) {
    if (range === "week") {
      const next = shiftWeek(weekStart, delta);
      const keep = weekDates(next).find((d) => d === today) ?? weekDates(next).filter(isWorkDay)[0] ?? next;
      if (dirty && !window.confirm(`Discard the unsaved changes on ${formatShortDate(selDay)}?`)) return;
      setEditing(null);
      setWeekStart(next);
      setSelDay(keep);
    } else {
      const [y, m] = month.split("-").map(Number);
      const next = new Date(y, m - 1 + delta, 1);
      setMonth(`${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`);
    }
    setMessage(null);
  }
  function goToday() {
    if (selectDay(today)) setMonth(today.slice(0, 7));
  }
  function chooseRange(next: Range) {
    if (next === "month") setMonth(selDay.slice(0, 7));
    setRange(next);
  }
  /** Assigned work → a block on the day shown (today when that day is closed). */
  function logWork(work?: { type: WorkType; id: string }, preset?: { projectId: string; projectTaskId?: string }) {
    const day = canLogOn(selDay) ? selDay : today;
    if (!canLogOn(day)) {
      setMessage({ tone: "err", text: whyLocked(day) });
      return;
    }
    const base = editing && editing.day === day ? editing.rows : allBlocks.filter((b) => b.date === day).map(rowFromBlock);
    let patch: Partial<Row> = {};
    if (work && work.type !== "project") {
      const project = projectForWork(work.type, work.id);
      patch = { work: `${work.type}:${work.id}`, workLabel: workLabelFor(work.type, work.id), projectId: project?.id ?? "", billable: billableFor(project), note: workTitleFor(work.type, work.id) };
    } else if (preset) {
      const project = projects.find((p) => p.id === preset.projectId);
      const pt = preset.projectTaskId ? myProjectTasks.find((x) => x.id === preset.projectTaskId) : undefined;
      patch = { projectId: preset.projectId, billable: billableFor(project), ...(pt ? { work: `task:${pt.id}`, workLabel: `${pt.code} ${pt.title}`, note: pt.title } : {}) };
    }
    setRange("week");
    setSelDay(day);
    setWeekStart(mondayOf(day));
    setFormError(null);
    setEditing({ day, rows: [...base, newRow(day, base, patch)] });
  }

  // /timesheet?work=ticket:TCK-1042 or task:<id> adds a block for it; ?project=<id>&ptask=<id> from Projects.
  const workParam = params.get("work");
  const projectParam = params.get("project");
  useEffect(() => {
    const work = parseWork(workParam);
    if (!workParam && !projectParam) return;
    const next = new URLSearchParams(params);
    next.delete("work");
    next.delete("project");
    next.delete("ptask");
    setParams(next, { replace: true });
    setView("mine");
    if (projectParam) {
      if (!projects.some((p) => p.id === projectParam)) {
        setMessage({ tone: "err", text: "That project isn't open for time logging." });
        return;
      }
      logWork(undefined, { projectId: projectParam, projectTaskId: params.get("ptask") ?? undefined });
      return;
    }
    if (!work) return;
    const known = work.type === "ticket" ? myTickets.some((t) => t.id === work.id) : loggableTasks.some((t) => t.id === work.id);
    if (!known) {
      setMessage({ tone: "err", text: work.type === "ticket" ? "That ticket isn't open and assigned to you." : "Accept that task before logging time." });
      return;
    }
    logWork(work);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workParam, projectParam]);

  /* ───────── exports ───────── */
  const exportRows = periodBlocks.map((b) => {
    const rec = myDay(b.date);
    return {
      Date: b.date,
      Day: parseISODate(b.date).toLocaleDateString("en-GB", { weekday: "short" }),
      Start: toHHMM(b.startHour),
      End: toHHMM(b.startHour + b.hours + b.breakMinutes / 60),
      "Break (min)": b.breakMinutes,
      Hours: b.hours,
      Project: b.projectName,
      "Work type": b.workType === "project" ? "Project" : b.workType === "ticket" ? "Ticket" : "Task",
      "Task / ticket": b.workLabel,
      Description: b.note,
      Billable: b.billable ? "Yes" : "No",
      "Day status": DAY_STATUS_LABEL[rec?.status ?? "draft"],
      "Manager comment": rec?.decisionNote ?? "",
    };
  });
  const fileBase = `timesheet-${employee.employeeCode ?? employee.id}-${range === "week" ? weekStart : month}`;
  function exportCsv() {
    if (!exportRows.length) return "Nothing logged in this period.";
    const headers = Object.keys(exportRows[0]);
    const lines = [headers.join(","), ...exportRows.map((r) => headers.map((h) => csvCell((r as Record<string, string | number>)[h])).join(","))];
    downloadText(`${fileBase}.csv`, lines.join("\n"));
    return null;
  }
  async function exportXlsx() {
    if (!exportRows.length) return "Nothing logged in this period.";
    const XLSX = await import("xlsx");
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(exportRows), "Entries");
    const summary = [
      { Item: "Employee", Value: `${employee.fullName} (${employee.employeeCode ?? employee.id})` },
      { Item: "Period", Value: periodLabel },
      { Item: "Total hours", Value: periodTotal },
      { Item: "Billable hours", Value: periodBillable },
      { Item: "Non-billable hours", Value: round2(periodTotal - periodBillable) },
      { Item: "Expected hours", Value: periodTarget },
      { Item: "Days approved", Value: statusCounts.approved },
      { Item: "Days pending", Value: statusCounts.pending },
      { Item: "Days sent back", Value: statusCounts.back },
      { Item: "Days missing time", Value: missingDays.length },
    ];
    XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(summary), "Summary");
    XLSX.writeFile(book, `${fileBase}.xlsx`);
    return null;
  }
  function exportPdf() {
    if (!exportRows.length) return "Nothing logged in this period.";
    const win = window.open("", "_blank", "width=1000,height=800");
    if (!win) return "Allow pop-ups for this site to open the printable timesheet.";
    const headers = Object.keys(exportRows[0]);
    const body = exportRows.map((r) => `<tr>${headers.map((h) => `<td>${escapeHtml(String((r as Record<string, string | number>)[h]))}</td>`).join("")}</tr>`).join("");
    win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(fileBase)}</title><style>
      body{font:12px/1.4 system-ui,sans-serif;margin:24px;color:#14181c}h1{font-size:18px;margin:0 0 4px}p{margin:0 0 12px;color:#4a5560}
      table{border-collapse:collapse;width:100%}th,td{border:1px solid #cfd6d3;padding:4px 6px;text-align:left;vertical-align:top}th{background:#eef2f0}
      .sum{display:flex;gap:18px;margin:0 0 12px}@media print{button{display:none}}</style></head><body>
      <h1>Timesheet · ${escapeHtml(employee.fullName)}</h1><p>${escapeHtml(periodLabel)} · approver ${escapeHtml(approverName)}</p>
      <div class="sum"><span>Total ${periodTotal} h</span><span>Billable ${periodBillable} h</span><span>Expected ${periodTarget} h</span>
      <span>Approved days ${statusCounts.approved}</span><span>Pending ${statusCounts.pending}</span><span>Sent back ${statusCounts.back}</span><span>Missing ${missingDays.length}</span></div>
      <table><thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table>
      <p style="margin-top:12px"><button onclick="window.print()">Print / Save as PDF</button></p></body></html>`);
    win.document.close();
    win.focus();
    window.setTimeout(() => win.print(), 300);
    return null;
  }

  // Weeks submitted before daily timesheets stay readable and decidable here: every week still waiting (any date),
  // plus the weeks shown that were approved or sent back.
  const orgRows = useMemo(() => {
    return state.orgTimesheets
      .filter(
        (row) =>
          row.personId !== employee.id &&
          (row.status === "submitted" || (row.weekStart === weekStart && (row.status === "approved" || (row.status === "draft" && !!row.decidedBy)))),
      )
      .sort((a, b) => b.weekStart.localeCompare(a.weekStart) || a.name.localeCompare(b.name));
  }, [employee.id, state.orgTimesheets, weekStart]);

  // The week by project (saved blocks).
  const weekByProject = useMemo(() => {
    const map = new Map<string, { name: string; hours: number; billable: number }>();
    for (const b of blocks) {
      const row = map.get(b.projectId) ?? { name: b.projectName, hours: 0, billable: 0 };
      row.hours += b.hours;
      if (b.billable) row.billable += b.hours;
      map.set(b.projectId, row);
    }
    return [...map.values()].sort((a, b) => b.hours - a.hours);
  }, [blocks]);
  const weekTotal = round2(blocks.reduce((a, b) => a + b.hours, 0));
  const weekBillable = round2(blocks.filter((b) => b.billable).reduce((a, b) => a + b.hours, 0));
  const weekTarget = weekDays.reduce((a, d) => a + targetFor(d), 0);
  const legacyWeek = weekStatus === "approved" || weekStatus === "submitted";

  function dayBox(d: string, compact = false) {
    const look = dayLook(d);
    const total = d === selDay && editing && editing.day === d ? rowsTotal : hoursOn(d);
    const target = targetFor(d);
    const pct = target > 0 ? Math.min(100, Math.round((total / target) * 100)) : total > 0 ? 100 : 0;
    const dow = parseISODate(d).toLocaleDateString("en-GB", compact ? { day: "numeric" } : { weekday: "short", day: "numeric", month: "short" });
    return (
      <button
        key={d}
        type="button"
        className={`tsx-daybox tz-tone-${look.tone}${d === selDay && range === "week" ? " selected" : ""}${d === today ? " today" : ""}${look.dashed ? " missing" : ""}`}
        aria-pressed={d === selDay}
        aria-label={`${formatShortDate(d)}: ${formatHoursAmount(total)}${target ? ` of ${target} h` : ""}${look.label ? `, ${look.label}` : ""}`}
        title={myDay(d)?.decisionNote ? `“${myDay(d)?.decisionNote}”` : offDayFor(d)}
        onClick={() => {
          if (selectDay(d)) setRange("week");
        }}
      >
        <span className="tsx-dow">{dow}</span>
        <span className="tsx-hours">
          {formatHoursAmount(total)}
          {target > 0 && <small> / {target}h</small>}
        </span>
        {target > 0 && (
          <span className="tsx-bar-mini" aria-hidden>
            <i style={{ width: `${pct}%` }} />
          </span>
        )}
        <span className="tsx-state">{look.label || " "}</span>
      </button>
    );
  }

  const legend: { tone: TimeTone; label: string; dashed?: boolean }[] = [
    { tone: "grey", label: "Draft" },
    { tone: "amber", label: "Pending" },
    { tone: "green", label: "Approved" },
    { tone: "red", label: "Sent back" },
    { tone: "teal", label: "Reopened" },
    { tone: "red", label: "Missing", dashed: true },
    { tone: "purple", label: "Leave" },
    { tone: "blue", label: "Holiday" },
  ];

  const selDayTitle = parseISODate(selDay).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  const projectOptions = (r: Row) => {
    const list = [...projects];
    if (r.projectId && !list.some((p) => p.id === r.projectId)) {
      const old = state.projects.find((p) => p.id === r.projectId);
      if (old) list.push(old);
    }
    return list;
  };

  return (
    <Page title={view === "mine" ? "My timesheet" : teamLabel}>
      <div className="tsx-page">
        <div className="ts-tabs" role="tablist" aria-label="Timesheet views">
          <button type="button" className={view === "mine" ? "active" : undefined} role="tab" aria-selected={view === "mine"} onClick={() => chooseView("mine")}>
            My timesheet
          </button>
          {isManager && (
            <button type="button" className={view === "company" ? "active" : undefined} role="tab" aria-selected={view === "company"} onClick={() => chooseView("company")}>
              {teamLabel}
              {waitingCount > 0 && (
                <span className="ts-count" aria-label={`${waitingCount} waiting`}>
                  {waitingCount}
                </span>
              )}
            </button>
          )}
        </div>

        <div className="tsx-bar">
          <div className="tsx-nav">
            {view === "mine" && (
              <div className="ts-range" role="radiogroup" aria-label="Show">
                {(["week", "month"] as Range[]).map((r) => (
                  <button key={r} type="button" role="radio" aria-checked={range === r} className={range === r ? "active" : undefined} onClick={() => chooseRange(r)}>
                    {r === "week" ? "Week" : "Month"}
                  </button>
                ))}
              </div>
            )}
            <button className="btn-ghost btn-tiny" type="button" aria-label="Previous" onClick={() => (view === "mine" ? moveRange(-1) : setWeekStart(shiftWeek(weekStart, -1)))}>
              ‹
            </button>
            <strong>{view === "mine" ? periodLabel : weekRangeLabel(weekStart)}</strong>
            <button className="btn-ghost btn-tiny" type="button" aria-label="Next" onClick={() => (view === "mine" ? moveRange(1) : setWeekStart(shiftWeek(weekStart, 1)))}>
              ›
            </button>
            <button className="btn-ghost btn-tiny" type="button" onClick={view === "mine" ? goToday : () => setWeekStart(mondayOf(today))}>
              {range === "month" && view === "mine" ? "This month" : "This week"}
            </button>
          </div>
          {view === "mine" && (
            <div className="tsx-exports">
              <ActionButton className="btn-ghost btn-tiny" success="Excel file downloaded." toastError onAction={exportXlsx}>
                Excel
              </ActionButton>
              <ActionButton className="btn-ghost btn-tiny" success="CSV downloaded." toastError onAction={exportCsv}>
                CSV
              </ActionButton>
              <ActionButton className="btn-ghost btn-tiny" success="Printable timesheet opened." toastError onAction={exportPdf}>
                PDF
              </ActionButton>
            </div>
          )}
        </div>

        {view === "company" ? (
        <>
          <TimesheetTeamDays weekStart={weekStart} />
          {API_ENABLED && utilization && (
            <Card title="Utilization this week" action={<span className="muted">Everyone in your scope</span>}>
              <section className="summary-row" aria-label="Utilization">
                <div className="summary">
                  <span>Hours logged</span>
                  <strong>{formatHoursAmount(utilization.total_hours)}</strong>
                </div>
                <div className="summary">
                  <span>Billable</span>
                  <strong>{formatHoursAmount(utilization.billable_hours)}</strong>
                </div>
                <div className="summary">
                  <span>Billable share</span>
                  <strong>{utilization.billable_pct}%</strong>
                </div>
              </section>
              {utilization.projects.length > 0 && (
                <div className="table-scroll">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>Project</th>
                        <th>Hours</th>
                        <th>Billable</th>
                        <th>Billable %</th>
                      </tr>
                    </thead>
                    <tbody>
                      {utilization.projects.map((p) => (
                        <tr key={p.id}>
                          <td>{p.name}</td>
                          <td>{formatHoursAmount(p.total_hours)}</td>
                          <td>{formatHoursAmount(p.billable_hours)}</td>
                          <td>{p.billable_pct}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          )}
          {orgRows.length > 0 && (
            <Card
              title={`Weekly timesheets · ${orgRows.filter((r) => r.status === "submitted" && decides(r.personId)).length} waiting`}
              action={<span className="muted">Submitted as whole weeks before daily timesheets</span>}
            >
              <div className="table-scroll">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Employee</th>
                      <th>Week</th>
                      <th>Department</th>
                      <th>Projects</th>
                      <th>Hours</th>
                      <th>Status</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {orgRows.flatMap((row) => [
                      <tr key={row.id}>
                        <td>
                          <strong>{row.name}</strong>
                        </td>
                        <td>{weekRangeLabel(row.weekStart)}</td>
                        <td>{row.department}</td>
                        <td>{row.projectSummary || <span className="muted">Open to see</span>}</td>
                        <td>{row.status === "missing" ? "—" : formatHoursAmount(row.hours)}</td>
                        <td>
                          <StatusPill status={row.status} />
                          {row.status === "submitted" && row.approvalProgress && <span className="muted request-decision">{row.approvalProgress}</span>}
                        </td>
                        <td>
                          {/* Only the person's reporting line decides — never their own row. */}
                          {row.status !== "missing" && (
                            <button
                              type="button"
                              className={row.status === "submitted" && decides(row.personId) ? "btn btn-tiny" : "btn-ghost btn-tiny"}
                              aria-expanded={openRow === row.id}
                              onClick={() => setOpenRow(openRow === row.id ? null : row.id)}
                            >
                              {openRow === row.id ? "Hide" : row.status === "submitted" && decides(row.personId) ? "Review" : "View"}
                            </button>
                          )}{" "}
                          {row.status === "submitted" && !decides(row.personId) && <span className="muted">Waiting for their manager</span>}
                          {row.status === "missing" && <span className="muted">Awaiting employee</span>}
                          {row.status === "draft" && <span className="muted">Not submitted</span>}
                          {row.status === "approved" && <span className="muted">Locked</span>}
                        </td>
                      </tr>,
                      openRow === row.id && (
                        <tr key={`${row.id}-detail`}>
                          <td colSpan={7}>
                            <TimesheetTeamDetail row={row} canDecide={decides(row.personId)} />
                          </td>
                        </tr>
                      ),
                    ])}
                  </tbody>
                </table>
              </div>
              <Banner message={message} />
            </Card>
          )}
        </>
        ) : (
          <>
            <Banner message={message} />
            <AttendanceStrip main={!att.checkedOut && (myDay(today)?.status ?? "draft") === "draft"} />

            {(autoDays.length > 0 || daysToFix.length > 0) && (
              <ul className="tsx-attention" aria-label="Days that need you">
                {autoDays.map((d) => (
                  <li key={`auto-${d}`} className="tz-tone-amber">
                    <span>
                      <strong>{formatShortDate(d)}</strong> stopped at 9 hours · {formatHoursAmount(hoursOn(d))} of {targetFor(d)} h logged · add the blocks and submit
                    </span>
                    <button className="btn btn-tiny" type="button" onClick={() => { setRange("week"); selectDay(d); }}>
                      Open day
                    </button>
                  </li>
                ))}
                {daysToFix.map((record) => (
                  <li key={`fix-${record.date}`} className={`tz-tone-${DAY_STATUS_TONE[record.status]}`}>
                    <span>
                      <strong>{formatShortDate(record.date)}</strong> {record.status === "reopened" ? "reopened" : "sent back"}
                      {record.decidedByName ? ` by ${record.decidedByName}` : ""}
                      {record.decisionNote ? `: “${record.decisionNote}”` : ""} · {formatHoursAmount(hoursOn(record.date))} logged
                    </span>
                    <button className="btn btn-tiny" type="button" onClick={() => { setRange("week"); selectDay(record.date); }}>
                      Open day
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {legacyWeek && range === "week" && (
              <p className="muted" style={{ margin: 0 }}>
                {weekStatus === "approved"
                  ? "Days logged before today were approved as a weekly timesheet."
                  : `Days logged before today were submitted as a weekly timesheet — waiting on ${(API_ENABLED && apiTime.weeks[weekStart]?.approval?.current_label?.toLowerCase()) || "manager"}.`}
              </p>
            )}

            <div>
              <ul className="tz-legend" aria-label="Colours">
                {legend.map((l) => (
                  <li key={`${l.label}`}>
                    <ToneChip tone={l.tone} label={l.label} dashed={l.dashed} />
                  </li>
                ))}
              </ul>
              {range === "week" ? (
                <div className="tsx-strip" role="group" aria-label="Days of the week">
                  {weekDays.map((d) => dayBox(d))}
                </div>
              ) : (
                <div className="ts-month">
                  {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
                    <span key={d} className="ts-month-dow">
                      {d}
                    </span>
                  ))}
                  {Array.from({ length: (parseISODate(periodDays[0]).getDay() + 6) % 7 }, (_, i) => (
                    <span key={`pad-${i}`} />
                  ))}
                  {periodDays.map((d) => dayBox(d, true))}
                </div>
              )}
            </div>

            {range === "week" && (
              <div className="tsx-main">
                <Card>
                  <div className="tsx-editor">
                    <div className="tsx-editor-head">
                      <h2>
                        {selDayTitle}
                        {(selRecord || selDay <= today) && dayLook(selDay).label && (
                          <ToneChip tone={dayLook(selDay).tone} label={dayLook(selDay).label} dashed={dayLook(selDay).dashed} />
                        )}
                      </h2>
                      {editable && (
                        <div className="tsx-add">
                          {attIn && attOut && (
                            <button type="button" className="btn-ghost btn-tiny" onClick={fillFromAttendance} title={`Check-in ${attIn} to check-out ${attOut}`}>
                              Use attendance {attIn}–{attOut}
                            </button>
                          )}
                          <button type="button" className="btn btn-tiny" onClick={() => addRow()} disabled={projects.length === 0}>
                            Add block
                          </button>
                        </div>
                      )}
                    </div>

                    {selRecord?.decisionNote && (
                      <p className={`note ${selRecord.status === "approved" ? "ok" : "warn"}`} style={{ margin: 0 }}>
                        {selRecord.decidedByName ? `${selRecord.decidedByName}: ` : ""}“{selRecord.decisionNote}”
                      </p>
                    )}

                    {editable ? (
                      <>
                        {rows.length === 0 ? (
                          <p className="muted" style={{ margin: 0 }}>
                            No blocks yet.
                          </p>
                        ) : (
                          <div className="tsx-rows">
                            <div className="tsx-row head" aria-hidden>
                              <span>Start</span>
                              <span>End</span>
                              <span>Project</span>
                              <span>Task (optional)</span>
                              <span>Comment</span>
                              <span>Billable</span>
                              <span style={{ textAlign: "right" }}>Hours</span>
                              <span />
                            </div>
                            {rows.map((r, i) => {
                              const ptasks = myProjectTasks.filter((t) => t.projectId === r.projectId);
                              const known =
                                !r.work ||
                                ptasks.some((t) => `task:${t.id}` === r.work) ||
                                myTickets.some((t) => `ticket:${t.id}` === r.work) ||
                                loggableTasks.some((t) => `task:${t.id}` === r.work);
                              const h = rowHours(r);
                              return (
                                <div key={r.key} className={`tsx-row${rowErrors[r.key] ? " bad" : ""}`}>
                                  <input type="time" step={300} aria-label={`Block ${i + 1} start`} value={r.start} onChange={(e) => updateRow(r.key, { start: e.target.value })} />
                                  <input type="time" step={300} aria-label={`Block ${i + 1} end`} value={r.end} onChange={(e) => updateRow(r.key, { end: e.target.value })} />
                                  <select
                                    aria-label={`Block ${i + 1} project`}
                                    value={r.projectId}
                                    onChange={(e) => {
                                      const project = projects.find((p) => p.id === e.target.value);
                                      updateRow(r.key, { projectId: e.target.value, billable: billableFor(project), ...(r.work.startsWith("task:pt-") ? { work: "", workLabel: "" } : {}) });
                                    }}
                                  >
                                    {!r.projectId && <option value="">Choose…</option>}
                                    {projectOptions(r).map((p) => (
                                      <option key={p.id} value={p.id}>
                                        {p.name}
                                      </option>
                                    ))}
                                  </select>
                                  <select aria-label={`Block ${i + 1} task`} value={r.work} onChange={(e) => chooseRowWork(r.key, e.target.value)}>
                                    <option value="">General project time</option>
                                    {!known && <option value={r.work}>{r.workLabel || r.work}</option>}
                                    {ptasks.length > 0 && (
                                      <optgroup label="Project tasks">
                                        {ptasks.map((t) => (
                                          <option key={t.id} value={`task:${t.id}`}>
                                            {t.code} · {t.title}
                                          </option>
                                        ))}
                                      </optgroup>
                                    )}
                                    {myTickets.length > 0 && (
                                      <optgroup label="Tickets">
                                        {myTickets.map((t) => (
                                          <option key={t.id} value={`ticket:${t.id}`}>
                                            {t.id} · {t.title}
                                          </option>
                                        ))}
                                      </optgroup>
                                    )}
                                    {loggableTasks.length > 0 && (
                                      <optgroup label="Tasks">
                                        {loggableTasks.map((t) => (
                                          <option key={t.id} value={`task:${t.id}`}>
                                            {t.code} · {t.subject}
                                          </option>
                                        ))}
                                      </optgroup>
                                    )}
                                  </select>
                                  <input
                                    className="tsx-cell-wide"
                                    aria-label={`Block ${i + 1} comment`}
                                    value={r.note}
                                    maxLength={200}
                                    placeholder="What you worked on"
                                    onChange={(e) => updateRow(r.key, { note: e.target.value })}
                                  />
                                  <label className="tsx-bill">
                                    <input type="checkbox" checked={r.billable} onChange={(e) => updateRow(r.key, { billable: e.target.checked })} />
                                    <span className="sr-only">Billable</span>
                                  </label>
                                  <span className="tsx-row-hours" title={r.breakMinutes ? `Includes a ${r.breakMinutes} min break` : undefined}>
                                    {h > 0 ? formatHoursAmount(h) : "—"}
                                  </span>
                                  <button type="button" className="tsx-row-remove" aria-label={`Remove block ${i + 1}`} onClick={() => setRows(rows.filter((x) => x.key !== r.key))}>
                                    ×
                                  </button>
                                  {rowErrors[r.key] && <span className="tsx-row-error">{rowErrors[r.key]}</span>}
                                </div>
                              );
                            })}
                          </div>
                        )}

                        <div className="tsx-totals">
                          <div className="tsx-meter tz-tone-green">
                            <strong>
                              {formatHoursAmount(rowsTotal)}
                              {selTarget > 0 ? ` of ${selTarget} h` : ""}
                            </strong>
                            {selTarget > 0 && (
                              <span className="tsx-bar-mini" aria-hidden>
                                <i style={{ width: `${Math.min(100, Math.round((rowsTotal / selTarget) * 100))}%` }} />
                              </span>
                            )}
                            <span className="tsx-why">
                              Billable {formatHoursAmount(rowsBillable)} · non-billable {formatHoursAmount(round2(rowsTotal - rowsBillable))}
                              {selDay === today && att.session.checkIn ? ` · attended ${durationText(att.minutes)}` : ""}
                            </span>
                          </div>
                          <div className="tsx-actions">
                            {submitBlocked && <span className="tsx-why">{submitBlocked}</span>}
                            {dirty && (
                              <button type="button" className="btn-ghost" onClick={() => { setEditing(null); setFormError(null); }}>
                                Undo changes
                              </button>
                            )}
                            <ActionButton className="btn-ghost" disabled={!dirty || hasRowErrors} busyLabel="Saving…" doneLabel="Saved" success="Draft saved." onAction={onSave}>
                              Save draft
                            </ActionButton>
                            <ActionButton className="btn" disabled={!!submitBlocked} title={submitBlocked ?? undefined} busyLabel="Submitting…" doneLabel="Submitted" onAction={onSubmit}>
                              {selRecord?.status === "rejected" ? "Submit again" : "Submit for approval"}
                            </ActionButton>
                          </div>
                        </div>
                        {overLogged && (
                          <p className="tsx-error">
                            {formatHoursAmount(rowsTotal)} logged but checked in for {durationText(att.minutes)}.
                          </p>
                        )}
                        {formError && (
                          <p className="tsx-error" role="alert">
                            {formError}
                          </p>
                        )}
                      </>
                    ) : (
                      <>
                        {baseRows.length > 0 ? (
                          <ul className="tsx-readonly">
                            {allBlocks
                              .filter((b) => b.date === selDay)
                              .map((b) => (
                                <li key={b.id}>
                                  <span>
                                    {toHHMM(b.startHour)}–{toHHMM(b.startHour + b.hours + b.breakMinutes / 60)}
                                  </span>
                                  <span>
                                    <strong>{b.projectName}</strong>
                                    {b.workLabel ? ` · ${b.workLabel}` : ""} · {b.note}
                                    {b.billable ? "" : " · non-billable"}
                                  </span>
                                  <span>{formatHoursAmount(b.hours)}</span>
                                </li>
                              ))}
                          </ul>
                        ) : null}
                        <p className="muted" style={{ margin: 0 }}>
                          {baseRows.length > 0 ? `${formatHoursAmount(hoursOn(selDay))}${selTarget ? ` of ${selTarget} h` : ""} · ` : ""}
                          {whyLocked(selDay)}
                        </p>
                      </>
                    )}
                  </div>
                </Card>

                <aside>
                  <Card title="This week by project">
                    {weekByProject.length === 0 ? (
                      <p className="muted" style={{ margin: 0 }}>
                        Nothing logged this week.
                      </p>
                    ) : (
                      <ul className="tsx-projects">
                        {weekByProject.map((p) => (
                          <li key={p.name} className="tz-tone-blue">
                            <div className="tsx-proj-line">
                              <span title={p.name}>{p.name}</span>
                              <strong>{formatHoursAmount(round2(p.hours))}</strong>
                            </div>
                            <span className="tsx-bar-mini" aria-hidden>
                              <i style={{ width: `${weekTotal ? Math.round((p.hours / weekTotal) * 100) : 0}%` }} />
                            </span>
                            <span className="tsx-why">Billable {formatHoursAmount(round2(p.billable))}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="tsx-week-sum">
                      <span>Week</span>
                      <strong>
                        {formatHoursAmount(weekTotal)} / {weekTarget}h
                      </strong>
                    </div>
                    <div className="tsx-week-sum" style={{ borderTop: 0, marginTop: 0, paddingTop: 4 }}>
                      <span>Billable</span>
                      <strong>
                        {formatHoursAmount(weekBillable)} · {weekTarget ? Math.round((weekBillable / weekTarget) * 100) : 0}%
                      </strong>
                    </div>
                  </Card>

                  <Card title="Assigned to you">
                    {myTickets.length + myTasks.length + myProjectTasks.length === 0 ? (
                      <p className="muted" style={{ margin: 0 }}>
                        Nothing assigned right now.
                      </p>
                    ) : (
                      <ul className="tsx-assigned">
                        {myTickets.map((t) => (
                          <li key={t.id}>
                            <div>
                              <Link to={`/tickets?id=${t.id}`} title={t.title}>
                                {t.id} {t.title}
                              </Link>
                              <span className="muted">Ticket · {t.projectName ?? "No project"}</span>
                            </div>
                            <button className="btn-ghost btn-tiny" type="button" onClick={() => logWork({ type: "ticket", id: t.id })}>
                              Log
                            </button>
                          </li>
                        ))}
                        {myTasks.map((t: Task) => (
                          <li key={t.id}>
                            <div>
                              <button type="button" className="link-btn ts-assigned-title" onClick={() => setTaskInfo(t)}>
                                {t.code} {t.subject}
                              </button>
                              <span className="muted">Task · {t.status === "progress" ? "In progress" : t.accepted ? "Accepted" : "Not accepted"}</span>
                            </div>
                            {t.accepted ? (
                              <button className="btn-ghost btn-tiny" type="button" onClick={() => logWork({ type: "task", id: t.id })}>
                                Log
                              </button>
                            ) : (
                              <button className="btn-ghost btn-tiny" type="button" onClick={() => setTaskInfo(t)}>
                                Accept
                              </button>
                            )}
                          </li>
                        ))}
                        {myProjectTasks.map((t) => (
                          <li key={t.id}>
                            <div>
                              <button type="button" className="link-btn ts-assigned-title" onClick={() => setProjTaskInfo(t)}>
                                {t.code} {t.title}
                              </button>
                              <span className="muted">
                                {t.projectName} · {TASK_STATUS_LABEL[t.status]}
                              </span>
                            </div>
                            {projects.some((p) => p.id === t.projectId) && (
                              <button className="btn-ghost btn-tiny" type="button" onClick={() => logWork(undefined, { projectId: t.projectId, projectTaskId: t.id })}>
                                Log
                              </button>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </Card>
                </aside>
              </div>
            )}

            {range === "month" && (
              <section className="summary-row" aria-label="Month summary">
                <div className="summary">
                  <span>Logged</span>
                  <strong>{formatHoursAmount(periodTotal)}</strong>
                  <span className="muted">of {periodTarget} h expected</span>
                </div>
                <div className="summary">
                  <span>Billable / non-billable</span>
                  <strong>
                    {formatHoursAmount(periodBillable)} / {formatHoursAmount(round2(periodTotal - periodBillable))}
                  </strong>
                </div>
                <div className="summary">
                  <span>Days</span>
                  <strong>
                    {statusCounts.approved} approved · {statusCounts.pending} pending
                  </strong>
                  <span className="muted">{statusCounts.back} sent back</span>
                </div>
                <div className="summary">
                  <span>Missing time</span>
                  <strong className={missingDays.length ? "ts-missing-count" : undefined}>{missingDays.length} days</strong>
                </div>
              </section>
            )}
          </>
        )}
      </div>

      {taskInfo && (
        <Dialog
          open
          title={`${taskInfo.code} ${taskInfo.subject}`}
          onClose={() => setTaskInfo(null)}
          actions={
            <>
              <Link className="btn-ghost" to={`/tasks?task=${encodeURIComponent(taskInfo.id)}`}>
                Open in Tasks
              </Link>
              {!(state.tasks.find((t) => t.id === taskInfo.id)?.accepted ?? taskInfo.accepted) ? (
                <ActionButton
                  className="btn"
                  busyLabel="Accepting…"
                  doneLabel="Accepted"
                  success="Task accepted. You can log time to it now."
                  onAction={() => {
                    const error = taskAction(taskInfo.id, "accept");
                    setMessage(error ? { tone: "err", text: error } : { tone: "ok", text: `${taskInfo.code} accepted.` });
                    return error;
                  }}
                >
                  Accept task
                </ActionButton>
              ) : (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setTaskInfo(null);
                    logWork({ type: "task", id: taskInfo.id });
                  }}
                >
                  Log time
                </button>
              )}
            </>
          }
        >
          {(() => {
            const t = state.tasks.find((x) => x.id === taskInfo.id) ?? taskInfo;
            return (
              <dl className="meta">
                <dt>Status</dt>
                <dd>
                  <StatusBadge status={t.status === "progress" ? "In progress" : t.accepted ? "Accepted" : "Waiting for you to accept"} tone={t.accepted ? "ok" : "warn"} literal keepCase />
                </dd>
                <dt>Project / client</dt>
                <dd>{t.projectName ?? t.client ?? "—"}</dd>
                <dt>Priority</dt>
                <dd>{t.priority}</dd>
                <dt>Due</dt>
                <dd>{t.due ? formatShortDate(t.due) : "—"}</dd>
                <dt>Estimated</dt>
                <dd>{t.estimatedHours ? `${t.estimatedHours} h` : "—"}</dd>
                <dt>Spent so far</dt>
                <dd>{formatHoursAmount(t.hoursSpent ?? 0)}</dd>
                <dt>Assigned by</dt>
                <dd>{t.assignedBy}</dd>
                <dt>Notes</dt>
                <dd>{t.notes || "—"}</dd>
              </dl>
            );
          })()}
        </Dialog>
      )}

      {projTaskInfo && (
        <Dialog
          open
          title={`${projTaskInfo.code} ${projTaskInfo.title}`}
          onClose={() => setProjTaskInfo(null)}
          actions={
            <>
              <Link className="btn-ghost" to={`/projects?id=${encodeURIComponent(projTaskInfo.projectId)}`}>
                Open project
              </Link>
              {projects.some((p) => p.id === projTaskInfo.projectId) && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    const t = projTaskInfo;
                    setProjTaskInfo(null);
                    logWork(undefined, { projectId: t.projectId, projectTaskId: t.id });
                  }}
                >
                  Log time
                </button>
              )}
            </>
          }
        >
          <p style={{ marginTop: 0 }}>{projTaskInfo.description || <span className="muted">No description.</span>}</p>
          <dl className="meta">
            <dt>Project</dt>
            <dd>{projTaskInfo.projectName}</dd>
            <dt>Status</dt>
            <dd>{TASK_STATUS_LABEL[projTaskInfo.status]}</dd>
            <dt>Deadline</dt>
            <dd>{projTaskInfo.due ? formatShortDate(projTaskInfo.due) : "—"}</dd>
            <dt>Estimated</dt>
            <dd>{projTaskInfo.estimate} h</dd>
            <dt>Logged</dt>
            <dd>{formatHoursAmount(projTaskInfo.loggedHours)}</dd>
          </dl>
        </Dialog>
      )}
    </Page>
  );
}
