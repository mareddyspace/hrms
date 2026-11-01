import { useEffect, useMemo, useState, useSyncExternalStore, type MouseEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ActionButton, Banner, Card, Dialog, Field, Page, StatusBadge, StatusPill, SubmitButton, downloadText, notify, useAction } from "../components/ui.tsx";
import { DAY_STATUS_LABEL, DAY_TARGET, HALF_DAY_TARGET, dayRecordFor, isFixable, legacyLockedDate, shortfallText, useDayRecords } from "../data/timesheetDays.ts";
import { DayStatusBadge, HoursMeter, TimesheetTeamDays } from "./TimesheetTeamDays.tsx";
import { pendingMirror } from "../api/syncTimeApprovals.ts";
import { managementChain } from "../demoAccounts.ts";
import {
  blockingLeave,
  holidaysForPerson,
  formatHourCompact,
  formatHourLabel,
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
import { loadApiUtilization, timeMirror, type UtilizationOut } from "../api/syncTimeSheets.ts";
import { TimesheetTeamDetail } from "./TimesheetTeamDetail.tsx";
import { AttendanceStrip, durationText, useTodayAttendance } from "../components/AttendanceStrip.tsx";
import { useProjects, TASK_STATUS_LABEL, type PTask } from "../data/projectStore.ts";
import { useProjectContext } from "./projectContext.ts";
import "./tickets.css";
import "./timesheetExtras.css";

const GRID_START = 7;
const GRID_END = 21;
const HOUR_PX = 56;

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
type LogKind = WorkType | "leave";
type Range = "day" | "week" | "month";

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
  const dates = weekDates(weekStart);
  const end = dates[4] ?? dates[dates.length - 1];
  return `${formatShortDate(weekStart)} – ${formatShortDate(end)}`;
}

function monthDays(ym: string): string[] {
  const [y, m] = ym.split("-").map(Number);
  const count = new Date(y, m, 0).getDate();
  return Array.from({ length: count }, (_, i) => `${ym}-${String(i + 1).padStart(2, "0")}`);
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const csvCell = (v: string | number) => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

type TimesheetView = "mine" | "company";

export function TimesheetPage() {
  const {
    currentProjects,
    state,
    employee,
    isManager,
    addTimeEntry,
    removeTimeEntry,
    submitDayTimesheet,
    canDecideFor,
    demoProfile,
    taskAction,
  } = usePortal();
  const projects = currentProjects;
  const [params, setParams] = useSearchParams();
  // /timesheet?view=team (from an approval notification) opens the team tab.
  const [view, setView] = useState<TimesheetView>(() => (params.get("view") === "team" ? "company" : "mine"));
  const [openRow, setOpenRow] = useState<string | null>(null);
  const teamLabel = "Team timesheets";
  const [weekStart, setWeekStart] = useState(() => mondayOf(todayISO()));
  const [range, setRange] = useState<Range>("week");
  const [focusDay, setFocusDay] = useState(todayISO());
  const [month, setMonth] = useState(() => todayISO().slice(0, 7));
  const [logOpen, setLogOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [viewBlock, setViewBlock] = useState<CalendarBlock | null>(null);
  const [taskInfo, setTaskInfo] = useState<Task | null>(null);
  const [projTaskInfo, setProjTaskInfo] = useState<(PTask & { projectId: string; projectName: string }) | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [date, setDate] = useState(todayISO());
  const [startHour, setStartHour] = useState("9.5");
  const [endHour, setEndHour] = useState("10.5");
  const [breakMin, setBreakMin] = useState("0");
  const [note, setNote] = useState("");
  const [billable, setBillable] = useState(true);
  const [logKind, setLogKind] = useState<LogKind>("project");
  const [workId, setWorkId] = useState("");
  const [projTaskId, setProjTaskId] = useState("");
  const viewParam = params.get("view");
  useEffect(() => {
    if (viewParam === "team") setView("company");
    else if (viewParam === "mine") setView("mine");
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
  const tickets = useTickets();
  // Backend mode only loads tickets when asked; without this "Ticket (0)" shows until the Tickets page is opened.
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
  const workDates = weekDates(weekStart).filter(isWorkDay);

  // Approved leave and holidays show as non-working days; no hours can go on them.
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
  const offDays: Record<string, string> = {};
  for (const day of workDates) {
    const off = offDayFor(day);
    if (off) offDays[day] = off;
  }
  const leaveDays = workDates.filter((d) => offDays[d]?.startsWith("On leave"));

  // Every block I logged (any week), as calendar blocks.
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
  const weekEnd = addDaysISO(weekStart, 6);
  const blocks = useMemo(() => allBlocks.filter((b) => b.date >= weekStart && b.date <= weekEnd), [allBlocks, weekStart, weekEnd]);
  const hoursOn = (day: string) => round2(allBlocks.filter((b) => b.date === day).reduce((sum, b) => sum + b.hours, 0));

  const dayTotals = useMemo(() => {
    const totals: Record<string, number> = {};
    for (const dateKey of workDates) totals[dateKey] = 0;
    for (const block of blocks) totals[block.date] = (totals[block.date] ?? 0) + block.hours;
    return totals;
  }, [blocks, workDates]);

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
  const weekSentBack = weekSentBackFor(weekStart);
  const daySentBack = (day: string) => isFixable(myDay(day)?.status);
  const dayLocked = (day: string) => {
    const status = myDay(day)?.status;
    return status === "submitted" || status === "approved";
  };
  const canLogOn = (day: string) =>
    isWorkDay(day) && !offDayFor(day) && !dayLocked(day) && !legacyDay(day) && (day === todayISO() || weekSentBackFor(mondayOf(day)) || daySentBack(day));
  const canLogThisWeek = workDates.some(canLogOn);
  const approverName = managementChain(employee.id)[0]?.fullName ?? "HR";
  const managerFirstName = approverName.split(" ")[0] || "your manager";
  /** Why a day can't take time (for clicks on locked days). */
  function whyLocked(day: string): string {
    if (!isWorkDay(day)) return `${formatShortDate(day)} is a weekly off.`;
    const off = offDayFor(day);
    if (off) return `${formatShortDate(day)}: ${off}. No hours on this day.`;
    const status = myDay(day)?.status;
    if (status === "submitted") return `${formatShortDate(day)} is waiting for approval and locked until it's decided.`;
    if (status === "approved") return `${formatShortDate(day)} is approved and locked.`;
    if (legacyDay(day)) return `${formatShortDate(day)} was submitted with the whole week and can't be changed.`;
    if (day > todayISO()) return "You can only log time for today, not ahead.";
    return `Time is logged on the day itself. Ask ${managerFirstName} to reopen ${formatShortDate(day)} if you missed it.`;
  }

  const weekTotal = Object.values(dayTotals).reduce((sum, value) => sum + value, 0);
  const billableTotal = blocks.filter((block) => block.billable).reduce((sum, block) => sum + block.hours, 0);
  const nonBillableTotal = weekTotal - billableTotal;
  // Capacity follows the person's own working days this week.
  const weekCapacity = workDates.reduce((sum, d) => sum + (offDays[d] ? 0 : DAY_TARGET), 0);

  /** Tickets carry a project id; tasks a project or client name. Unmatched work goes to the internal project. */
  function projectForWork(type: WorkType, id: string): Project | undefined {
    const same = (a?: string, b?: string) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
    const internal = projects.find((p) => /internal/i.test(p.name) || p.client === "Internal") ?? projects[0];
    if (type === "ticket") {
      const t = tickets.find((x) => x.id === id);
      return projects.find((p) => p.id === t?.projectId) ?? projects.find((p) => same(p.name, t?.projectName)) ?? internal;
    }
    if (type === "task") {
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

  function chooseWork(kind: LogKind, id: string) {
    setLogKind(kind);
    setWorkId(id);
    setProjTaskId("");
    if (kind === "leave") return;
    const project = kind === "project" ? projects.find((p) => p.id === id) ?? projects[0] : projectForWork(kind, id);
    setProjectId(project?.id ?? "");
    setBillable(billableFor(project));
    if (kind === "ticket") setNote(tickets.find((t) => t.id === id)?.title ?? "");
    else if (kind === "task") setNote(state.tasks.find((t) => t.id === id)?.subject ?? "");
  }

  function setTimes(start: number, end: number, brk = 0) {
    setStartHour(String(start));
    setEndHour(String(Math.min(24, end)));
    setBreakMin(String(brk));
  }

  /** Opens the Log time form: on a day (today by default), optionally at an hour, for a ticket / task / project task. */
  function openLog(forDate?: string, work?: { type: WorkType; id: string }, atHour?: number, preset?: { projectId: string; projectTaskId?: string }) {
    const days = range === "month" || range === "day" ? weekDates(mondayOf(forDate ?? todayISO())).filter(isWorkDay) : workDates;
    const free = (d: string) => days.includes(d) && canLogOn(d);
    const chosen = forDate && free(forDate) ? forDate : free(todayISO()) ? todayISO() : days.filter((d) => free(d) && d <= todayISO()).pop() ?? days.find(free) ?? todayISO();
    if (mondayOf(chosen) !== weekStart) setWeekStart(mondayOf(chosen));
    setDate(chosen);
    const lastEnd = allBlocks.filter((b) => b.date === chosen).reduce((max, b) => Math.max(max, b.startHour + b.hours + b.breakMinutes / 60), 0);
    const start = atHour ?? (lastEnd > 0 && lastEnd < 23 ? lastEnd : 9.5);
    setTimes(start, start + 1);
    setNote("");
    setEditId(null);
    setFormError(null);
    chooseWork(work?.type ?? "project", work?.id ?? preset?.projectId ?? projects[0]?.id ?? "");
    if (preset?.projectTaskId) {
      const t = myProjectTasks.find((x) => x.id === preset.projectTaskId);
      if (t) {
        setProjTaskId(t.id);
        setNote(t.title);
      }
    }
    setLogOpen(true);
  }

  function openEdit(block: CalendarBlock) {
    setEditId(block.id);
    setFormError(null);
    setDate(block.date);
    setTimes(block.startHour, block.startHour + block.hours + block.breakMinutes / 60, block.breakMinutes);
    setNote(block.note);
    setBillable(block.billable);
    setProjectId(block.projectId);
    if (block.workType === "task" && block.workId.startsWith("pt-")) {
      setLogKind("project");
      setWorkId(block.projectId);
      setProjTaskId(block.workId);
    } else {
      setLogKind(block.workType);
      setWorkId(block.workType === "project" ? block.projectId : block.workId);
      setProjTaskId("");
    }
    setLogOpen(true);
  }

  function onBlockClick(block: CalendarBlock) {
    if (canLogOn(block.date)) openEdit(block);
    else setViewBlock(block);
  }

  function onSlotClick(day: string, event: MouseEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return; // a block handles its own clicks
    if (!canLogOn(day)) {
      setMessage({ tone: "err", text: whyLocked(day) });
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const hour = GRID_START + Math.floor(((event.clientY - rect.top) / HOUR_PX) * 4) / 4;
    openLog(day, undefined, Math.max(0, Math.min(23, hour)));
  }

  // /timesheet?work=ticket:TCK-1042 or task:<id> opens the dialog prefilled; ?project=<id>&ptask=<id> from Projects.
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
      if (!canLogOn(todayISO()) && !workDates.some(canLogOn)) {
        setMessage({ tone: "err", text: whyLocked(todayISO()) });
        return;
      }
      openLog(undefined, undefined, undefined, { projectId: projectParam, projectTaskId: params.get("ptask") ?? undefined });
      return;
    }
    if (!work) return;
    const known = work.type === "ticket" ? myTickets.some((t) => t.id === work.id) : loggableTasks.some((t) => t.id === work.id);
    if (!known) {
      setMessage({ tone: "err", text: work.type === "ticket" ? "That ticket isn't open and assigned to you." : "Accept that task before logging time." });
      return;
    }
    if (!canLogThisWeek) {
      setMessage({ tone: "err", text: "Time can only be logged for today." });
      return;
    }
    openLog(undefined, work);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workParam, projectParam]);

  function workLabelFor(type: WorkType, id: string): string {
    if (type === "ticket") {
      const t = tickets.find((x) => x.id === id);
      return t ? `${t.id} ${t.title}` : id;
    }
    if (type === "task") {
      const t = state.tasks.find((x) => x.id === id);
      return t ? `${t.code} ${t.subject}` : id;
    }
    return "";
  }

  const logAction = useAction();
  const start = Number(startHour) || 0;
  const end = Number(endHour) || 0;
  const brk = Math.max(0, Number(breakMin) || 0);
  const workedHours = round2(end - start - brk / 60);
  const projectTasksFor = myProjectTasks.filter((t) => t.projectId === projectId || t.id === projTaskId);

  async function onLog(): Promise<boolean> {
    if (logKind === "leave") return false;
    const fail = (text: string) => {
      setFormError(text);
      return false;
    };
    if (logKind !== "project" && !workId) return fail(`Pick a ${logKind}.`);
    if (offDayFor(date)) return fail(`${formatShortDate(date)}: ${offDayFor(date)}. No hours on this day.`);
    if (end <= start) return fail("The end time must be after the start time.");
    if (workedHours <= 0) return fail("The break is as long as the block. Shorten the break or move the end time.");
    if (!note.trim()) return fail("Describe what you worked on.");
    const ptask = projTaskId ? myProjectTasks.find((t) => t.id === projTaskId) : undefined;
    const error = await addTimeEntry(
      projectId,
      mondayOf(date),
      {
        date,
        startHour: start,
        hours: workedHours,
        breakMinutes: brk,
        note,
        billable,
        workType: ptask ? "task" : logKind,
        ...(ptask
          ? { workId: ptask.id, workLabel: `${ptask.code} ${ptask.title}` }
          : logKind === "project"
            ? {}
            : { workId, workLabel: workLabelFor(logKind, workId) }),
      },
      editId ?? undefined,
    );
    if (error) return fail(error);
    setMessage({ tone: "ok", text: editId ? "Time block updated." : "Time block added." });
    notify(editId ? "Block updated." : "Block added.");
    setLogOpen(false);
    setEditId(null);
    return true;
  }

  async function onRemove(block: CalendarBlock) {
    if (!window.confirm(`Delete the block ${formatHourCompact(block.startHour)}–${formatHourCompact(block.startHour + block.hours + block.breakMinutes / 60)} (${block.note})?`)) return false;
    const error = await removeTimeEntry(block.projectId, mondayOf(block.date), block.id);
    setMessage(error ? { tone: "err", text: error } : { tone: "ok", text: "Time block deleted." });
    if (!error) notify("Block deleted.");
    return error ?? true;
  }

  /** Minimum hours to submit a day: 9, 4.5 on half-day leave, 0 on leave, holidays and weekly offs. */
  function targetFor(day: string): number {
    if (offDayFor(day) || !isWorkDay(day)) return 0;
    return halfDayLeave(state.leaveRequests, employee.id, day) ? HALF_DAY_TARGET : DAY_TARGET;
  }

  async function onSubmitDay(day: string) {
    const error = await submitDayTimesheet(day);
    setMessage(error ? { tone: "err", text: error } : { tone: "ok", text: `${formatShortDate(day)} submitted for approval.` });
    if (error) return false;
    notify(`Timesheet for ${formatShortDate(day)} sent to ${approverName}.`);
    return true;
  }

  const today = todayISO();
  const todayInWeek = weekDates(weekStart).includes(today) || (today >= weekStart && today <= addDaysISO(weekStart, 6));
  const todayTotal = hoursOn(today);
  const todayTarget = targetFor(today);
  const todayRecord = myDay(today);
  const todayStatus = todayRecord?.status ?? "draft";
  const todayShort = shortfallText(todayTotal, todayTarget);
  // Today's timesheet goes in after checking out (a day sent back doesn't need attendance).
  const att = useTodayAttendance();
  const needCheckOut = todayStatus === "draft" && todayTarget > 0 && !att.checkedOut;
  const todayToGo = Math.round((todayTarget - todayTotal) * 100) / 100;
  const todayBlocked = needCheckOut ? "Check out first" : todayShort ? `Log at least ${todayTarget} h (${todayToGo} h to go)` : null;
  const overLogged = att.checkedOut && todayTotal * 60 > att.minutes + 30;
  const legacyWeek = weekStatus === "approved" || weekStatus === "submitted";
  // Days to fix: sent back or reopened by the manager (any week), oldest first.
  const daysToFix = dayRecords
    .filter((r) => r.personId === employee.id && r.date !== today && isFixable(r.status))
    .sort((a, b) => a.date.localeCompare(b.date));
  // One short reason next to "Log time" when nothing can be logged in the week shown.
  const logBlockedReason = canLogThisWeek
    ? null
    : !todayInWeek
      ? "Today only"
      : todayStatus === "submitted"
        ? `Today submitted · waiting on ${todayRecord?.approvalLabel ?? approverName}`
        : todayStatus === "approved"
          ? "Today approved"
          : offDays[today]
            ? `Today: ${offDays[today].split(" · ")[0]}`
            : !workDates.includes(today)
              ? "Day off today"
              : "Today only";

  const hourMarks = Array.from({ length: GRID_END - GRID_START + 1 }, (_, index) => GRID_START + index);

  /* ───────── the period shown: a day, the week or a month ───────── */
  const periodDays = range === "day" ? [focusDay] : range === "week" ? weekDates(weekStart) : monthDays(month);
  const periodLabel =
    range === "day"
      ? parseISODate(focusDay).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })
      : range === "week"
        ? weekRangeLabel(weekStart)
        : monthLabel(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1);
  const periodBlocks = allBlocks.filter((b) => b.date >= periodDays[0] && b.date <= periodDays[periodDays.length - 1]);
  const periodTotal = round2(periodBlocks.reduce((a, b) => a + b.hours, 0));
  const periodBillable = round2(periodBlocks.filter((b) => b.billable).reduce((a, b) => a + b.hours, 0));
  const periodTarget = periodDays.reduce((a, d) => a + targetFor(d), 0);
  const dayStatusLabel = (d: string) => DAY_STATUS_LABEL[myDay(d)?.status ?? "draft"];
  /** Past working days (not leave / holiday) still short of the minimum and not submitted: missing time. */
  const missingDays = periodDays.filter((d) => {
    if (d >= today || !isWorkDay(d) || targetFor(d) === 0 || legacyDay(d)) return false;
    const status = myDay(d)?.status;
    if (status === "submitted" || status === "approved") return false;
    return hoursOn(d) < targetFor(d);
  });
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

  function moveRange(delta: number) {
    if (range === "day") {
      let d = addDaysISO(focusDay, delta);
      for (let i = 0; i < 7 && !isWorkDay(d); i += 1) d = addDaysISO(d, delta);
      setFocusDay(d);
      setWeekStart(mondayOf(d));
    } else if (range === "week") setWeekStart(shiftWeek(weekStart, delta));
    else {
      const [y, m] = month.split("-").map(Number);
      const next = new Date(y, m - 1 + delta, 1);
      setMonth(`${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`);
    }
    setMessage(null);
  }
  function goToday() {
    setFocusDay(today);
    setWeekStart(mondayOf(today));
    setMonth(today.slice(0, 7));
  }
  function chooseRange(next: Range) {
    if (next === "day") {
      const d = weekDates(weekStart).includes(today) ? today : workDates[0] ?? weekStart;
      setFocusDay(d);
    } else if (next === "month") setMonth((range === "day" ? focusDay : weekStart).slice(0, 7));
    else if (range === "day") setWeekStart(mondayOf(focusDay));
    setRange(next);
  }
  function openDay(d: string) {
    setFocusDay(d);
    setWeekStart(mondayOf(d));
    setRange("day");
  }

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
  const fileBase = `timesheet-${employee.employeeCode ?? employee.id}-${range === "day" ? focusDay : range === "week" ? weekStart : month}`;
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
    const rows = exportRows.map((r) => `<tr>${headers.map((h) => `<td>${escapeHtml(String((r as Record<string, string | number>)[h]))}</td>`).join("")}</tr>`).join("");
    win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(fileBase)}</title><style>
      body{font:12px/1.4 system-ui,sans-serif;margin:24px;color:#14181c}h1{font-size:18px;margin:0 0 4px}p{margin:0 0 12px;color:#4a5560}
      table{border-collapse:collapse;width:100%}th,td{border:1px solid #cfd6d3;padding:4px 6px;text-align:left;vertical-align:top}th{background:#eef2f0}
      .sum{display:flex;gap:18px;margin:0 0 12px}@media print{button{display:none}}</style></head><body>
      <h1>Timesheet · ${escapeHtml(employee.fullName)}</h1><p>${escapeHtml(periodLabel)} · approver ${escapeHtml(approverName)}</p>
      <div class="sum"><span>Total ${periodTotal} h</span><span>Billable ${periodBillable} h</span><span>Expected ${periodTarget} h</span>
      <span>Approved days ${statusCounts.approved}</span><span>Pending ${statusCounts.pending}</span><span>Sent back ${statusCounts.back}</span><span>Missing ${missingDays.length}</span></div>
      <table><thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table>
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

  // Week summary by what the time went on (for the period shown).
  const breakdown = useMemo(() => {
    const sum = (key: (b: CalendarBlock) => string | null) => {
      const map = new Map<string, number>();
      for (const b of periodBlocks) {
        const k = key(b);
        if (k) map.set(k, (map.get(k) ?? 0) + b.hours);
      }
      return [...map.entries()].sort((a, b) => b[1] - a[1]);
    };
    return {
      project: sum((b) => b.projectName),
      ticket: sum((b) => (b.workType === "ticket" ? b.workLabel || "Ticket" : null)),
      task: sum((b) => (b.workType === "task" ? b.workLabel || "Task" : null)),
      projectOnly: periodBlocks.filter((b) => b.workType === "project").reduce((a, b) => a + b.hours, 0),
    };
  }, [periodBlocks]);

  const calendarDays = range === "day" ? [focusDay] : workDates;
  const gridCols = { gridTemplateColumns: `64px repeat(${calendarDays.length}, minmax(0, 1fr))` };

  return (
    <Page
      title={view === "mine" ? "My timesheet" : teamLabel}
      action={view === "mine" && todayInWeek ? <DayStatusBadge status={todayStatus} /> : undefined}
    >
      <div className="ts-toolbar">
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
        <div className="ts-toolbar-row">
          <div className="week-nav">
            {view === "mine" && (
              <div className="ts-range" role="radiogroup" aria-label="Show">
                {(["day", "week", "month"] as Range[]).map((r) => (
                  <button key={r} type="button" role="radio" aria-checked={range === r} className={range === r ? "active" : undefined} onClick={() => chooseRange(r)}>
                    {r === "day" ? "Day" : r === "week" ? "Week" : "Month"}
                  </button>
                ))}
              </div>
            )}
            <button className="btn-ghost" type="button" aria-label={`Previous ${view === "mine" ? range : "week"}`} onClick={() => (view === "mine" ? moveRange(-1) : setWeekStart(shiftWeek(weekStart, -1)))}>
              ‹
            </button>
            <strong>{view === "mine" ? periodLabel : weekRangeLabel(weekStart)}</strong>
            <button className="btn-ghost" type="button" aria-label={`Next ${view === "mine" ? range : "week"}`} onClick={() => (view === "mine" ? moveRange(1) : setWeekStart(shiftWeek(weekStart, 1)))}>
              ›
            </button>
            <button className="btn-ghost btn-tiny" type="button" onClick={goToday}>
              {range === "day" ? "Today" : range === "month" ? "This month" : "This week"}
            </button>
          </div>
          {view === "mine" && (
            <div className="form-actions">
              <button className="btn" type="button" disabled={!canLogThisWeek && !canLogOn(today)} title={logBlockedReason ?? undefined} onClick={() => openLog(range === "day" ? focusDay : undefined)}>
                Log time
              </button>
              <span className="muted">
                {logBlockedReason ?? (weekSentBack || daysToFix.length ? "Fix the days below, or log today." : `Today only. Missed a day? Ask ${managerFirstName} to reopen it.`)}
              </span>
            </div>
          )}
        </div>
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
          {legacyWeek && range === "week" && (
            <p className="muted">
              {weekStatus === "approved"
                ? "Days logged before today were approved as a weekly timesheet."
                : `Days logged before today were submitted as a weekly timesheet — waiting on ${(API_ENABLED && apiTime.weeks[weekStart]?.approval?.current_label?.toLowerCase()) || "manager"}.`}
            </p>
          )}
          <AttendanceStrip main={!att.checkedOut && todayStatus === "draft"} />
          {todayInWeek || (range === "day" && focusDay === today) ? (
            <div className={`ts-submit-bar ${todayStatus === "rejected" ? "" : todayStatus}`}>
              <div className="ts-today">
                <span>Today</span>
                <HoursMeter total={todayTotal} target={todayTarget} />
                {att.session.checkIn && <span className="muted">Attended {durationText(att.minutes)}</span>}
                <DayStatusBadge status={todayStatus} />
                <span className="ts-why">
                  {todayStatus === "submitted"
                    ? `Waiting on ${todayRecord?.approvalLabel ?? approverName}. Locked until it's decided.`
                    : todayStatus === "approved"
                      ? `Approved${todayRecord?.decidedByName ? ` by ${todayRecord.decidedByName}` : ""}. Locked.`
                      : todayTarget === 0
                        ? offDayFor(today) ?? "Day off — nothing to submit."
                        : todayStatus === "rejected"
                          ? `Sent back${todayRecord?.decidedByName ? ` by ${todayRecord.decidedByName}` : ""}${todayRecord?.decisionNote ? `: “${todayRecord.decisionNote}”` : ""}. Fix it and submit again.`
                          : todayBlocked ?? "Ready to submit."}
                </span>
                {overLogged && todayStatus === "draft" && (
                  <span className="ts-att-warn">
                    You logged {Math.round(todayTotal * 100) / 100} h but were checked in for {durationText(att.minutes)}
                  </span>
                )}
              </div>
              {(todayStatus === "draft" || todayStatus === "rejected") && todayTarget > 0 && (
                <ActionButton className={needCheckOut ? "btn-ghost btn-tiny" : "btn btn-tiny"} disabled={!!todayBlocked} title={todayBlocked ?? undefined} onAction={() => onSubmitDay(today)}>
                  {todayStatus === "rejected" ? "Submit again" : "Submit for approval"}
                </ActionButton>
              )}
            </div>
          ) : null}
          {daysToFix.length > 0 && (
            <section aria-label="Days to fix">
              <h3 className="ts-fix-title">Days to fix · {daysToFix.length}</h3>
              <ul className="ts-sent-back-list">
                {daysToFix.map((record) => {
                  const d = record.date;
                  const total = hoursOn(d);
                  const target = halfDayLeave(state.leaveRequests, employee.id, d) ? HALF_DAY_TARGET : DAY_TARGET;
                  const short = shortfallText(total, target);
                  return (
                    <li key={d}>
                      <span>
                        <strong>{formatShortDate(d)}</strong> {record.status === "reopened" ? "reopened" : "sent back"}
                        {record.decidedByName ? ` by ${record.decidedByName}` : ""}
                        {record.decisionNote ? `: “${record.decisionNote}”` : ""} · {formatHoursAmount(total)} of {target} h
                        {short ? <span className="ts-why"> · {short}</span> : null}
                      </span>
                      <span className="form-actions" style={{ marginTop: 0 }}>
                        <button className="btn-ghost btn-tiny" type="button" onClick={() => openLog(d)}>
                          Log time
                        </button>
                        <button className="btn-ghost btn-tiny" type="button" onClick={() => openDay(d)}>
                          Open day
                        </button>
                        <ActionButton className="btn btn-tiny" disabled={!!short} title={short ?? undefined} onAction={() => onSubmitDay(d)}>
                          {record.status === "reopened" ? "Submit" : "Submit again"}
                        </ActionButton>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          <Card title="Assigned to you" action={<span className="muted">Tickets, tasks and project tasks · click one for details</span>}>
            {myTickets.length + myTasks.length + myProjectTasks.length === 0 ? (
              <p className="muted">Nothing assigned right now. Work assigned to you shows up here.</p>
            ) : (
              <ul className="ts-assigned">
                {myTickets.map((t) => (
                  <li key={t.id}>
                    <div>
                      <span className="ts-kind">Ticket · {t.status}</span>
                      <Link to={`/tickets?id=${t.id}`} title={t.title}>
                        <strong>
                          {t.id} {t.title}
                        </strong>
                      </Link>
                      <span className="muted">
                        {t.projectName ?? "No project"}
                        {t.due ? ` · due ${formatShortDate(t.due)}` : ""}
                      </span>
                    </div>
                    {canLogThisWeek && (
                      <button className="btn btn-tiny" type="button" onClick={() => openLog(undefined, { type: "ticket", id: t.id })}>
                        Log time
                      </button>
                    )}
                  </li>
                ))}
                {myTasks.map((t: Task) => (
                  <li key={t.id}>
                    <div>
                      <span className="ts-kind">Task · {t.status === "progress" ? "In progress" : t.accepted ? "Accepted" : "Not accepted"}</span>
                      <button type="button" className="link-btn ts-assigned-title" onClick={() => setTaskInfo(t)}>
                        {t.code} {t.subject}
                      </button>
                      <span className="muted">
                        {t.projectName ?? t.client}
                        {t.due ? ` · due ${formatShortDate(t.due)}` : ""} · from {t.assignedBy}
                      </span>
                    </div>
                    {t.accepted ? (
                      canLogThisWeek && (
                        <button className="btn btn-tiny" type="button" onClick={() => openLog(undefined, { type: "task", id: t.id })}>
                          Log time
                        </button>
                      )
                    ) : (
                      <button className="btn-ghost btn-tiny" type="button" onClick={() => setTaskInfo(t)}>
                        View and accept
                      </button>
                    )}
                  </li>
                ))}
                {myProjectTasks.map((t) => (
                  <li key={t.id}>
                    <div>
                      <span className="ts-kind">Project task · {TASK_STATUS_LABEL[t.status]}</span>
                      <button type="button" className="link-btn ts-assigned-title" onClick={() => setProjTaskInfo(t)}>
                        {t.code} {t.title}
                      </button>
                      <span className="muted">
                        {t.projectName}
                        {t.due ? ` · due ${formatShortDate(t.due)}` : ""} · {t.estimate} h estimated
                      </span>
                    </div>
                    {canLogThisWeek && projects.some((p) => p.id === t.projectId) && (
                      <button className="btn btn-tiny" type="button" onClick={() => openLog(undefined, undefined, undefined, { projectId: t.projectId, projectTaskId: t.id })}>
                        Log time
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <section className="summary-row" aria-label="Period summary">
            <div className="summary">
              <span>Logged · {range}</span>
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

          {range === "month" ? (
            <Card title={periodLabel} action={<span className="muted">Click a day to open it</span>}>
              <div className="ts-month">
                {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
                  <span key={d} className="ts-month-dow">
                    {d}
                  </span>
                ))}
                {Array.from({ length: (parseISODate(periodDays[0]).getDay() + 6) % 7 }, (_, i) => (
                  <span key={`pad-${i}`} />
                ))}
                {periodDays.map((d) => {
                  const off = !isWorkDay(d) ? "Weekly off" : offDayFor(d)?.split(" · ")[0];
                  const rec = myDay(d);
                  const missing = missingDays.includes(d);
                  return (
                    <button
                      key={d}
                      type="button"
                      className={`ts-month-day${d === today ? " today" : ""}${off ? " off" : ""}${missing ? " missing" : ""}`}
                      onClick={() => openDay(d)}
                      aria-label={`${formatShortDate(d)}: ${hoursOn(d)} hours${rec ? `, ${DAY_STATUS_LABEL[rec.status]}` : ""}${missing ? ", missing time" : ""}`}
                    >
                      <span className="ts-month-num">{Number(d.slice(8))}</span>
                      {off ? <span className="muted">{off}</span> : <strong>{formatHoursAmount(hoursOn(d))}</strong>}
                      {rec ? <DayStatusBadge status={rec.status} /> : missing ? <span className="ts-missing">Missing</span> : null}
                    </button>
                  );
                })}
              </div>
            </Card>
          ) : (
            <Card>
              <div className="ts-cal">
                <div className="ts-cal-head" style={gridCols}>
                  <div className="ts-gutter" />
                  {calendarDays.map((day) => {
                    const dayDate = parseISODate(day);
                    const label = dayDate.toLocaleDateString("en-IN", { weekday: "short", day: "numeric" });
                    const total = hoursOn(day);
                    const off = offDayFor(day);
                    return (
                      <div key={day} className={`ts-day-head${missingDays.includes(day) ? " missing" : ""}`}>
                        <button type="button" className="link-btn ts-day-link" onClick={() => openDay(day)} disabled={range === "day"}>
                          {label}
                        </button>
                        <span>{off ? off.split(" · ")[0] : `${formatHoursAmount(total)} / ${targetFor(day)}h`}</span>
                        {!off && !legacyWeek && (myDay(day) || (day <= today && total > 0)) && (
                          <span className="ts-day-status" title={myDay(day)?.decisionNote ?? undefined}>
                            <DayStatusBadge status={myDay(day)?.status ?? "draft"} />
                          </span>
                        )}
                        {missingDays.includes(day) && <span className="ts-missing">Missing</span>}
                        {myDay(day)?.decisionNote && <span className="ts-day-note">“{myDay(day)?.decisionNote}”</span>}
                        {canLogOn(day) && (
                          <button className="ts-add-day" type="button" onClick={() => openLog(day)} aria-label={`Log time on ${label}`}>
                            +
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>

                <div className="ts-cal-body" style={{ ...gridCols, height: (GRID_END - GRID_START) * HOUR_PX }}>
                  <div className="ts-gutter">
                    {hourMarks.map((hour) => (
                      <div key={hour} className="ts-hour-label" style={{ top: (hour - GRID_START) * HOUR_PX }}>
                        {formatHourLabel(hour)}
                      </div>
                    ))}
                  </div>

                  {calendarDays.map((day) => (
                    <div
                      key={day}
                      className={`ts-day-col${canLogOn(day) ? " open" : ""}`}
                      onClick={(e) => onSlotClick(day, e)}
                      title={canLogOn(day) ? "Click a time to log a block" : undefined}
                    >
                      {offDayFor(day) && (
                        <article className="ts-block offday" style={{ top: (9 - GRID_START) * HOUR_PX, height: DAY_TARGET * HOUR_PX - 4 }} title={offDayFor(day)}>
                          <strong>{offDayFor(day)?.split(" · ")[0]}</strong>
                          <span>{offDayFor(day)?.split(" · ").slice(1).join(" · ")}</span>
                          <em>No hours</em>
                        </article>
                      )}
                      {blocks
                        .filter((block) => block.date === day)
                        .map((block) => {
                          const span = block.hours + block.breakMinutes / 60;
                          const top = Math.max(0, (block.startHour - GRID_START) * HOUR_PX);
                          const height = Math.max(span * HOUR_PX - 4, 28);
                          return (
                            <article
                              key={block.id}
                              className={`ts-block ${block.billable ? "billable" : "nonbillable"} clickable`}
                              style={{ top, height }}
                              role="button"
                              tabIndex={0}
                              aria-label={`${block.note}, ${formatHourCompact(block.startHour)} to ${formatHourCompact(block.startHour + span)}${canLogOn(day) ? ", click to edit" : ""}`}
                              title={`${block.projectName}${block.workLabel ? ` · ${block.workLabel}` : ""}: ${block.note}${block.breakMinutes ? ` · ${block.breakMinutes} min break` : ""}`}
                              onClick={() => onBlockClick(block)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  onBlockClick(block);
                                }
                              }}
                            >
                              {block.workType !== "project" && (
                                <span className="ts-work-tag">{block.workType === "ticket" ? block.workLabel.split(" ")[0] || "Ticket" : block.workLabel.split(" ")[0] || "Task"}</span>
                              )}
                              <strong>{block.note}</strong>
                              <span>
                                {formatHourCompact(block.startHour)} – {formatHourCompact(block.startHour + span)}
                                {block.breakMinutes ? ` · ${block.breakMinutes}m break` : ""}
                              </span>
                              <em>
                                {block.projectName} · {block.billable ? "Billable" : "Non-billable"}
                              </em>
                            </article>
                          );
                        })}
                    </div>
                  ))}
                </div>

                <div className="ts-day-totals" aria-label="Daily totals" style={gridCols}>
                  <div className="ts-gutter">
                    <span>Daily total</span>
                  </div>
                  {calendarDays.map((day) => (
                    <div key={day} className="ts-day-total-cell">
                      <strong>{formatHoursAmount(hoursOn(day))}</strong>
                      <span>{offDayFor(day) ? "day off" : `of ${targetFor(day)}h`}</span>
                    </div>
                  ))}
                </div>

                <div className="ts-cal-foot">
                  <div className="ts-legend">
                    <span>
                      <i className="dot billable" /> Billable time: {formatHoursAmount(range === "day" ? periodBillable : billableTotal)}
                    </span>
                    <span>
                      <i className="dot nonbillable" /> Non-billable time: {formatHoursAmount(range === "day" ? round2(periodTotal - periodBillable) : nonBillableTotal)}
                    </span>
                    {range === "week" && <span>Utilization: {weekCapacity ? Math.round((billableTotal / weekCapacity) * 100) : 0}%</span>}
                  </div>
                  <strong>{range === "day" ? `Day total: ${formatHoursAmount(periodTotal)} / ${periodTarget}h` : `Week total: ${formatHoursAmount(weekTotal)} / ${weekCapacity}h`}</strong>
                </div>
              </div>
              <Banner message={message} />
            </Card>
          )}
          {range === "month" && <Banner message={message} />}

          {missingDays.length > 0 && (
            <Card title={`Missing time · ${missingDays.length}`} action={<span className="muted">Past working days short of the minimum and not submitted</span>}>
              <ul className="ts-sent-back-list">
                {missingDays.map((d) => (
                  <li key={d}>
                    <span>
                      <strong>{formatShortDate(d)}</strong> · {formatHoursAmount(hoursOn(d))} of {targetFor(d)} h · {dayStatusLabel(d)}
                    </span>
                    <span className="form-actions" style={{ marginTop: 0 }}>
                      {canLogOn(d) ? (
                        <button className="btn-ghost btn-tiny" type="button" onClick={() => openLog(d)}>
                          Log time
                        </button>
                      ) : (
                        <span className="muted">Ask {managerFirstName} to reopen it</span>
                      )}
                      <button className="btn-ghost btn-tiny" type="button" onClick={() => openDay(d)}>
                        Open day
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card
            title={`Entries · ${periodLabel}`}
            action={
              <div className="row-gap">
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
            }
          >
            {periodBlocks.length === 0 ? (
              <p className="muted">Nothing logged in this {range}.</p>
            ) : (
              <div className="table-scroll">
                <table className="data ts-entries">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Time</th>
                      <th>Break</th>
                      <th>Project</th>
                      <th>Task / ticket</th>
                      <th>Description</th>
                      <th>Hours</th>
                      <th>Billable</th>
                      <th>Day status</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {periodBlocks.map((b) => {
                      const rec = myDay(b.date);
                      const editable = canLogOn(b.date);
                      return (
                        <tr key={b.id}>
                          <td>{formatShortDate(b.date)}</td>
                          <td>
                            {toHHMM(b.startHour)}–{toHHMM(b.startHour + b.hours + b.breakMinutes / 60)}
                          </td>
                          <td>{b.breakMinutes ? `${b.breakMinutes} min` : "—"}</td>
                          <td>{b.projectName}</td>
                          <td>{b.workLabel || "—"}</td>
                          <td>{b.note}</td>
                          <td>{formatHoursAmount(b.hours)}</td>
                          <td>
                            <span className={`ts-bill ${b.billable ? "yes" : "no"}`}>{b.billable ? "Billable" : "Non-billable"}</span>
                          </td>
                          <td>
                            <DayStatusBadge status={rec?.status ?? "draft"} />
                            {rec?.decisionNote && <span className="muted ts-entry-note">“{rec.decisionNote}”</span>}
                          </td>
                          <td className="ts-entry-actions">
                            {editable ? (
                              <>
                                <button type="button" className="btn-ghost btn-tiny" onClick={() => openEdit(b)}>
                                  Edit
                                </button>
                                <ActionButton className="btn-ghost btn-tiny" onAction={() => onRemove(b)}>
                                  Delete
                                </ActionButton>
                              </>
                            ) : (
                              <button type="button" className="btn-ghost btn-tiny" onClick={() => setViewBlock(b)}>
                                View
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title={`By project and task · ${range}`}>
            <div className="ts-breakdown">
              {(
                [
                  ["Projects", breakdown.project, "No time yet."],
                  ["Tickets", breakdown.ticket, "No ticket time."],
                  ["Tasks", breakdown.task, "No task time."],
                ] as const
              ).map(([label, rows, empty]) => (
                <section key={label}>
                  <h4>
                    {label}
                    <span>{formatHoursAmount(rows.reduce((a, [, h]) => a + h, 0))}</span>
                  </h4>
                  {rows.length === 0 ? (
                    <p className="muted">{empty}</p>
                  ) : (
                    <ul>
                      {rows.map(([name, h]) => (
                        <li key={name}>
                          <span title={name}>{name}</span>
                          <strong>{formatHoursAmount(h)}</strong>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              ))}
            </div>
            {breakdown.projectOnly > 0 && <p className="muted">General project time (no ticket or task): {formatHoursAmount(breakdown.projectOnly)}</p>}
          </Card>
        </>
      )}

      {view === "mine" && logOpen && (
        <div className="modal-root" role="presentation">
          <button className="modal-scrim" type="button" aria-label="Close" onClick={() => setLogOpen(false)} />
          <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="log-time-title">
            <h2 id="log-time-title">{editId ? "Edit time block" : "Log time"}</h2>
            <form onSubmit={logAction.submit(onLog)}>
              <div className="stack" style={{ marginTop: 12 }}>
                {!editId && (
                  <div className="ts-worktype" role="radiogroup" aria-label="Log time against">
                    {(
                      [
                        ["project", "Project"],
                        ["ticket", `Ticket (${myTickets.length})`],
                        ["task", `Task (${loggableTasks.length})`],
                        ["leave", "Leave"],
                      ] as [LogKind, string][]
                    ).map(([kind, label]) => (
                      <button
                        key={kind}
                        type="button"
                        role="radio"
                        aria-checked={logKind === kind}
                        className={logKind === kind ? "active" : undefined}
                        onClick={() =>
                          chooseWork(kind, kind === "ticket" ? myTickets[0]?.id ?? "" : kind === "task" ? loggableTasks[0]?.id ?? "" : kind === "project" ? projects[0]?.id ?? "" : "")
                        }
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}
                {logKind === "leave" ? (
                  <div>
                    {leaveDays.length === 0 ? (
                      <p className="muted">No approved leave this week.</p>
                    ) : (
                      <ul className="ts-assigned">
                        {leaveDays.map((d) => (
                          <li key={d}>
                            <span>{formatShortDate(d)}</span>
                            <span className="muted">{offDays[d].split(" · ")[1]}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                    <p className="muted">
                      No hours on leave days. <Link to="/leave">Leave</Link>
                    </p>
                  </div>
                ) : (
                  <>
                    {logKind === "ticket" && (
                      <Field label="Ticket">
                        {myTickets.length === 0 ? (
                          <span className="muted">No open tickets assigned to you.</span>
                        ) : (
                          <select value={workId} onChange={(event) => chooseWork("ticket", event.target.value)}>
                            {myTickets.map((t) => (
                              <option key={t.id} value={t.id}>
                                {t.id} · {t.title}
                              </option>
                            ))}
                          </select>
                        )}
                      </Field>
                    )}
                    {logKind === "task" && (
                      <Field label="Task">
                        {loggableTasks.length === 0 ? (
                          <span className="muted">No accepted open tasks.</span>
                        ) : (
                          <select value={workId} onChange={(event) => chooseWork("task", event.target.value)}>
                            {loggableTasks.map((t) => (
                              <option key={t.id} value={t.id}>
                                {t.code} · {t.subject}
                              </option>
                            ))}
                          </select>
                        )}
                      </Field>
                    )}
                    <div className="form-grid-2">
                      <Field label="Date">
                        <select value={date} onChange={(event) => setDate(event.target.value)}>
                          {weekDates(mondayOf(date))
                            .filter(isWorkDay)
                            .map((day) => (
                              <option key={day} value={day} disabled={!canLogOn(day) && day !== date}>
                                {formatShortDate(day)}
                                {offDayFor(day) ? ` — ${offDayFor(day)?.split(" · ")[0]}` : !canLogOn(day) ? " — locked" : ""}
                              </option>
                            ))}
                        </select>
                      </Field>
                      <Field label={logKind === "project" ? "Project" : "Charged to project"}>
                        <select
                          value={projectId}
                          onChange={(event) => {
                            setProjectId(event.target.value);
                            setProjTaskId("");
                            setBillable(billableFor(projects.find((p) => p.id === event.target.value)));
                          }}
                        >
                          {projects.map((project) => (
                            <option key={project.id} value={project.id}>
                              {project.name}
                            </option>
                          ))}
                        </select>
                      </Field>
                    </div>
                    {logKind === "project" && (
                      <Field label="Project task (optional)">
                        <select
                          value={projTaskId}
                          onChange={(event) => {
                            setProjTaskId(event.target.value);
                            const t = myProjectTasks.find((x) => x.id === event.target.value);
                            if (t && !note.trim()) setNote(t.title);
                          }}
                        >
                          <option value="">General project time</option>
                          {projectTasksFor.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.code} · {t.title}
                            </option>
                          ))}
                        </select>
                      </Field>
                    )}
                    <div className="ts-time-pair ts-time-quad">
                      <Field label="Start">
                        <input
                          type="time"
                          step={300}
                          value={toHHMM(start)}
                          onChange={(event) => {
                            const value = fromHHMM(event.target.value);
                            if (value === null) return;
                            const length = end - start;
                            setStartHour(String(value));
                            setEndHour(String(Math.min(24, value + (length > 0 ? length : 1))));
                          }}
                        />
                      </Field>
                      <Field label="End">
                        <input
                          type="time"
                          step={300}
                          value={toHHMM(end)}
                          onChange={(event) => {
                            const value = fromHHMM(event.target.value);
                            if (value !== null) setEndHour(String(value === 0 ? 24 : value));
                          }}
                        />
                      </Field>
                      <Field label="Break (min)">
                        <input type="number" min={0} max={600} step={5} value={breakMin} onChange={(event) => setBreakMin(event.target.value)} />
                      </Field>
                      <Field label="Hours (auto)">
                        <output className={`ts-hours-out${workedHours <= 0 ? " bad" : ""}`} aria-live="polite">
                          {workedHours > 0 ? `${workedHours} h` : "—"}
                        </output>
                      </Field>
                    </div>
                    {date && (
                      <p className="muted" style={{ margin: 0 }}>
                        {formatShortDate(date)}: {formatHoursAmount(round2(hoursOn(date) - (editId ? allBlocks.find((b) => b.id === editId)?.hours ?? 0 : 0)))} logged
                        {workedHours > 0 ? ` → ${formatHoursAmount(round2(hoursOn(date) - (editId ? allBlocks.find((b) => b.id === editId)?.hours ?? 0 : 0) + workedHours))} with this block` : ""} of {targetFor(date)} h
                      </p>
                    )}
                    <Field label="Description">
                      <input value={note} maxLength={200} onChange={(event) => setNote(event.target.value)} placeholder="e.g. Invoice export polish" />
                    </Field>
                    <label className="check-row">
                      <input type="checkbox" checked={billable} onChange={(event) => setBillable(event.target.checked)} />
                      Billable time
                    </label>
                    {formError && <p className="note warn" role="alert">{formError}</p>}
                  </>
                )}
              </div>
              <div className="form-actions">
                {editId && (
                  <ActionButton
                    className="btn-ghost"
                    onAction={async () => {
                      const block = allBlocks.find((b) => b.id === editId);
                      if (!block) return "That block was removed.";
                      const result = await onRemove(block);
                      if (result === true) setLogOpen(false);
                      return result;
                    }}
                  >
                    Delete block
                  </ActionButton>
                )}
                <button className="btn-ghost" type="button" onClick={() => setLogOpen(false)}>
                  {logKind === "leave" ? "Close" : "Cancel"}
                </button>
                {logKind !== "leave" && (
                  <SubmitButton action={logAction} className="btn" disabled={(logKind !== "project" && !workId) || workedHours <= 0}>
                    {editId ? "Save changes" : "Add block"}
                  </SubmitButton>
                )}
              </div>
            </form>
          </div>
        </div>
      )}

      {viewBlock && (
        <Dialog open title={viewBlock.note} onClose={() => setViewBlock(null)} actions={<button type="button" className="btn-ghost" onClick={() => setViewBlock(null)}>Close</button>}>
          <dl className="meta">
            <dt>Date</dt>
            <dd>{formatShortDate(viewBlock.date)}</dd>
            <dt>Time</dt>
            <dd>
              {toHHMM(viewBlock.startHour)}–{toHHMM(viewBlock.startHour + viewBlock.hours + viewBlock.breakMinutes / 60)}
              {viewBlock.breakMinutes ? ` (${viewBlock.breakMinutes} min break)` : ""}
            </dd>
            <dt>Hours</dt>
            <dd>{formatHoursAmount(viewBlock.hours)}</dd>
            <dt>Project</dt>
            <dd>{viewBlock.projectName}</dd>
            <dt>Task / ticket</dt>
            <dd>{viewBlock.workLabel || "—"}</dd>
            <dt>Billable</dt>
            <dd>{viewBlock.billable ? "Yes" : "No"}</dd>
            <dt>Day status</dt>
            <dd>
              <DayStatusBadge status={myDay(viewBlock.date)?.status ?? "draft"} />
              {myDay(viewBlock.date)?.decisionNote && <span className="muted"> “{myDay(viewBlock.date)?.decisionNote}”</span>}
            </dd>
          </dl>
          <p className="muted">{whyLocked(viewBlock.date)}</p>
        </Dialog>
      )}

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
                canLogThisWeek && (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      setTaskInfo(null);
                      openLog(undefined, { type: "task", id: taskInfo.id });
                    }}
                  >
                    Log time
                  </button>
                )
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
              {canLogThisWeek && projects.some((p) => p.id === projTaskInfo.projectId) && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    const t = projTaskInfo;
                    setProjTaskInfo(null);
                    openLog(undefined, undefined, undefined, { projectId: t.projectId, projectTaskId: t.id });
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
          <p className="muted">Change the status on the project page.</p>
        </Dialog>
      )}
    </Page>
  );
}
