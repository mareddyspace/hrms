import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ActionButton, Banner, Card, Field, Page, StatusPill, SubmitButton, notify, useAction } from "../components/ui.tsx";
import { DAY_TARGET, HALF_DAY_TARGET, dayRecordFor, isFixable, legacyLockedDate, shortfallText, useDayRecords } from "../data/timesheetDays.ts";
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
  mondayOf,
  parseISODate,
  shiftWeek,
  todayISO,
  weekDates,
} from "../model.ts";
import { usePortal } from "../store.tsx";
import { scheduleForEmployee } from "../data/workSchedule.ts";
import { ticketsAssignedTo, useTickets } from "../data/ticketStore.ts";
import type { Project, Task } from "../model.ts";
import { addDaysISO } from "../model.ts";
import { API_ENABLED } from "../api/client.ts";
import { loadApiUtilization, timeMirror, type UtilizationOut } from "../api/syncTimeSheets.ts";
import { TimesheetTeamDetail } from "./TimesheetTeamDetail.tsx";
import { AttendanceStrip, durationText, useTodayAttendance } from "../components/AttendanceStrip.tsx";
import "./tickets.css";

const GRID_START = 8;
const GRID_END = 20;
const HOUR_PX = 56;

type CalendarBlock = {
  id: string;
  projectId: string;
  projectName: string;
  date: string;
  startHour: number;
  hours: number;
  note: string;
  billable: boolean;
  workType: WorkType;
  workLabel: string;
};

type WorkType = "project" | "ticket" | "task";
type LogKind = WorkType | "leave";

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
  } = usePortal();
  const projects = currentProjects;
  const [params, setParams] = useSearchParams();
  // /timesheet?view=team (from an approval notification) opens the team tab.
  const [view, setView] = useState<TimesheetView>(() => (params.get("view") === "team" ? "company" : "mine"));
  const [openRow, setOpenRow] = useState<string | null>(null);
  const teamLabel = "Team timesheets";
  const [weekStart, setWeekStart] = useState(() => mondayOf(todayISO()));
  const [logOpen, setLogOpen] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [date, setDate] = useState(todayISO());
  const [startHour, setStartHour] = useState("9.5");
  const [hours, setHours] = useState("1");
  const [note, setNote] = useState("");
  const [billable, setBillable] = useState(true);
  const [logKind, setLogKind] = useState<LogKind>("project");
  const [workId, setWorkId] = useState("");
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
  const myTickets = useMemo(() => ticketsAssignedTo(employee.id, tickets), [employee.id, tickets]);
  const myTasks = useMemo(
    () => state.tasks.filter((t) => t.employeeId === employee.id && (t.status === "open" || t.status === "progress")),
    [employee.id, state.tasks],
  );
  const loggableTasks = myTasks.filter((t) => t.accepted);
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
  const workDates = weekDates(weekStart).filter((d) => !weeklyOffDays.includes(parseISODate(d).getDay()));
  const weekSheets = state.timesheets.filter((sheet) => sheet.employeeId === employee.id && sheet.weekStart === weekStart);

  // Approved leave and holidays show as non-working days; no hours can go on them.
  const holidayByDate = new Map(holidaysForPerson(state.holidays, employee.id).map((h) => [h.date, h.name]));
  const offDays: Record<string, string> = {};
  for (const day of workDates) {
    if (holidayByDate.has(day)) offDays[day] = `Holiday · ${holidayByDate.get(day)}`;
    else if (blockingLeave(state.leaveRequests, employee.id, day)) {
      const request = state.leaveRequests.find(
        (r) => r.employeeId === employee.id && r.status === "approved" && r.from <= day && day <= r.to,
      );
      const name = state.leavePolicies.find((p) => p.code === request?.code)?.name ?? "Leave";
      offDays[day] = `On leave · ${name}`;
    }
  }
  const leaveDays = workDates.filter((d) => offDays[d]?.startsWith("On leave"));

  const blocks = useMemo<CalendarBlock[]>(() => {
    const list: CalendarBlock[] = [];
    for (const sheet of weekSheets) {
      const project = projects.find((item) => item.id === sheet.projectId);
      for (const entry of sheet.entries ?? []) {
        list.push({
          id: entry.id,
          projectId: sheet.projectId,
          projectName: project?.name ?? "Project",
          date: entry.date,
          startHour: entry.startHour,
          hours: entry.hours,
          note: entry.note,
          billable: entry.billable,
          workType: entry.workType ?? "project",
          workLabel: entry.workLabel ?? "",
        });
      }
    }
    return list;
  }, [projects, weekSheets]);

  const dayTotals = useMemo(() => {
    const totals: Record<string, number> = {};
    for (const dateKey of workDates) totals[dateKey] = 0;
    for (const block of blocks) totals[block.date] = (totals[block.date] ?? 0) + block.hours;
    return totals;
  }, [blocks, workDates]);

  const weekTotal = Object.values(dayTotals).reduce((sum, value) => sum + value, 0);
  const billableTotal = blocks.filter((block) => block.billable).reduce((sum, block) => sum + block.hours, 0);
  const nonBillableTotal = weekTotal - billableTotal;
  // Capacity follows the person's own working days this week.
  const weekCapacity = workDates.reduce((sum, d) => sum + (offDays[d] ? 0 : DAY_TARGET), 0);
  const weekStatus = weekSheets.some((sheet) => sheet.status === "approved")
    ? "approved"
    : weekSheets.some((sheet) => sheet.status === "submitted")
      ? "submitted"
      : "draft";
  // A week submitted the old (weekly) way only locks the days it covered; other days are logged day by day.
  const legacyDay = (day: string) => legacyLockedDate(weekStatus !== "draft", day, (dayTotals[day] ?? 0) > 0, myDay(day));
  // Time is logged on the day itself; a week the manager sent back can be fixed on any of its days.
  const weekSentBack = API_ENABLED
    ? apiTime.weeks[weekStart]?.status === "rejected"
    : state.orgTimesheets.some(
        (row) => row.personId === employee.id && row.weekStart === weekStart && row.status === "draft" && !!row.decidedBy,
      );
  const daySentBack = (day: string) => isFixable(myDay(day)?.status);
  const dayLocked = (day: string) => {
    const status = myDay(day)?.status;
    return status === "submitted" || status === "approved";
  };
  const canLogOn = (day: string) =>
    !offDays[day] && !dayLocked(day) && !legacyDay(day) && (day === todayISO() || weekSentBack || daySentBack(day));
  const canLogThisWeek = workDates.some(canLogOn);

  /** Tickets carry a project id; tasks a project or client name. Unmatched work goes to the internal project. */
  function projectForWork(type: WorkType, id: string): Project | undefined {
    const same = (a?: string, b?: string) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
    const internal =
      projects.find((p) => /internal/i.test(p.name) || p.client === "Internal") ?? projects[0];
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
    if (kind === "leave") return;
    const project = kind === "project" ? projects.find((p) => p.id === id) ?? projects[0] : projectForWork(kind, id);
    setProjectId(project?.id ?? "");
    setBillable(billableFor(project));
    if (kind === "ticket") setNote(tickets.find((t) => t.id === id)?.title ?? "");
    else if (kind === "task") setNote(state.tasks.find((t) => t.id === id)?.subject ?? "");
  }

  function openLog(forDate?: string, work?: { type: WorkType; id: string }) {
    const free = (d: string) => workDates.includes(d) && canLogOn(d);
    setDate(
      forDate && free(forDate)
        ? forDate
        : free(todayISO())
          ? todayISO()
          : workDates.filter((d) => free(d) && d <= todayISO()).pop() ?? workDates.find(free) ?? todayISO(),
    );
    const chosen = forDate && free(forDate) ? forDate : todayISO();
    const lastEnd = blocks.filter((b) => b.date === chosen).reduce((max, b) => Math.max(max, b.startHour + b.hours), 0);
    setStartHour(String(lastEnd > 0 && lastEnd < 23 ? lastEnd : 9.5));
    setHours("1");
    setNote("");
    chooseWork(work?.type ?? "project", work?.id ?? projects[0]?.id ?? "");
    setLogOpen(true);
  }

  // /timesheet?work=ticket:TCK-1042 or task:<id> opens the dialog prefilled.
  const workParam = params.get("work");
  useEffect(() => {
    const work = parseWork(workParam);
    if (!workParam) return;
    const next = new URLSearchParams(params);
    next.delete("work");
    setParams(next, { replace: true });
    if (!work) return;
    setView("mine");
    const known =
      work.type === "ticket" ? myTickets.some((t) => t.id === work.id) : loggableTasks.some((t) => t.id === work.id);
    if (!known) {
      setMessage({
        tone: "err",
        text: work.type === "ticket" ? "That ticket isn't open and assigned to you." : "Accept that task before logging time.",
      });
      return;
    }
    if (!canLogThisWeek) {
      setMessage({ tone: "err", text: "Time can only be logged for today." });
      return;
    }
    openLog(undefined, work);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workParam]);

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

  async function onLog(): Promise<boolean> {
    if (logKind === "leave") return false;
    if (logKind !== "project" && !workId) {
      setMessage({ tone: "err", text: `Pick a ${logKind}.` });
      return false;
    }
    if (offDays[date]) {
      setMessage({ tone: "err", text: `${formatShortDate(date)}: ${offDays[date]}. No hours on this day.` });
      return false;
    }
    const error = await addTimeEntry(projectId, weekStart, {
      date,
      startHour: Number(startHour),
      hours: Number(hours),
      note,
      billable,
      workType: logKind,
      ...(logKind === "project" ? {} : { workId, workLabel: workLabelFor(logKind, workId) }),
    });
    setMessage(error ? { tone: "err", text: error } : { tone: "ok", text: "Time block added." });
    if (error) return false;
    notify("Block added.");
    setLogOpen(false);
    return true;
  }

  // Week summary by what the time went on.
  const breakdown = useMemo(() => {
    const sum = (key: (b: CalendarBlock) => string | null) => {
      const map = new Map<string, number>();
      for (const b of blocks) {
        const k = key(b);
        if (k) map.set(k, (map.get(k) ?? 0) + b.hours);
      }
      return [...map.entries()].sort((a, b) => b[1] - a[1]);
    };
    return {
      project: sum((b) => b.projectName),
      ticket: sum((b) => (b.workType === "ticket" ? b.workLabel || "Ticket" : null)),
      task: sum((b) => (b.workType === "task" ? b.workLabel || "Task" : null)),
      projectOnly: blocks.filter((b) => b.workType === "project").reduce((a, b) => a + b.hours, 0),
    };
  }, [blocks]);

  /** Minimum hours to submit a day: 9, 4.5 on half-day leave, 0 on leave, holidays and weekly offs. */
  function targetFor(day: string): number {
    if (offDays[day] || !workDates.includes(day)) return 0;
    return halfDayLeave(state.leaveRequests, employee.id, day) ? HALF_DAY_TARGET : DAY_TARGET;
  }
  const approverName = managementChain(employee.id)[0]?.fullName ?? "HR";

  async function onSubmitDay(day: string) {
    const error = await submitDayTimesheet(day);
    setMessage(error ? { tone: "err", text: error } : { tone: "ok", text: `${formatShortDate(day)} submitted for approval.` });
    if (error) return false;
    notify(`Timesheet for ${formatShortDate(day)} sent to ${approverName}.`);
    return true;
  }

  const today = todayISO();
  const todayInWeek = weekDates(weekStart).includes(today) || (today >= weekStart && today <= addDaysISO(weekStart, 6));
  const todayTotal = blocks.filter((b) => b.date === today).reduce((sum, b) => sum + b.hours, 0);
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
  const hoursOn = (day: string) =>
    state.timesheets
      .filter((sheet) => sheet.employeeId === employee.id)
      .flatMap((sheet) => sheet.entries ?? [])
      .filter((entry) => entry.date === day)
      .reduce((sum, entry) => sum + entry.hours, 0);
  const managerFirstName = approverName.split(" ")[0] || "your manager";
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

  return (
    <Page
      title={view === "mine" ? "My timesheet" : teamLabel}
      action={view === "mine" && todayInWeek ? <DayStatusBadge status={todayStatus} /> : undefined}
    >
      <div className="ts-toolbar">
        <div className="ts-tabs" role="tablist" aria-label="Timesheet views">
          <button
            type="button"
            className={view === "mine" ? "active" : undefined}
            role="tab"
            aria-selected={view === "mine"}
            onClick={() => chooseView("mine")}
          >
            My timesheet
          </button>
          {isManager && (
            <button
              type="button"
              className={view === "company" ? "active" : undefined}
              role="tab"
              aria-selected={view === "company"}
              onClick={() => chooseView("company")}
            >
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
            <button className="btn-ghost" type="button" onClick={() => setWeekStart(shiftWeek(weekStart, -1))}>
              ‹
            </button>
            <strong>{weekRangeLabel(weekStart)}</strong>
            <button className="btn-ghost" type="button" onClick={() => setWeekStart(shiftWeek(weekStart, 1))}>
              ›
            </button>
            <button className="btn-ghost btn-tiny" type="button" onClick={() => setWeekStart(mondayOf(todayISO()))}>
              This week
            </button>
          </div>
          {view === "mine" && (
            <div className="form-actions">
              <button
                className="btn"
                type="button"
                disabled={!canLogThisWeek}
                title={logBlockedReason ?? undefined}
                onClick={() => openLog()}
              >
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
                        {row.status === "submitted" && row.approvalProgress && (
                          <span className="muted request-decision">{row.approvalProgress}</span>
                        )}
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
                        {row.status === "submitted" && !decides(row.personId) && (
                          <span className="muted">Waiting for their manager</span>
                        )}
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
      {legacyWeek && (
        <p className="muted">
          {weekStatus === "approved"
            ? "Days logged before today were approved as a weekly timesheet."
            : `Days logged before today were submitted as a weekly timesheet — waiting on ${(API_ENABLED && apiTime.weeks[weekStart]?.approval?.current_label?.toLowerCase()) || "manager"}.`}
        </p>
      )}
      <AttendanceStrip main={!att.checkedOut && todayStatus === "draft"} />
      {todayInWeek ? (
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
                    ? offDays[today] ?? "Day off — nothing to submit."
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
            <ActionButton
              className={needCheckOut ? "btn-ghost btn-tiny" : "btn btn-tiny"}
              disabled={!!todayBlocked}
              title={todayBlocked ?? undefined}
              onAction={() => onSubmitDay(today)}
            >
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
              const inWeek = mondayOf(d) === weekStart;
              return (
                <li key={d}>
                  <span>
                    <strong>{formatShortDate(d)}</strong> {record.status === "reopened" ? "reopened" : "sent back"}
                    {record.decidedByName ? ` by ${record.decidedByName}` : ""}
                    {record.decisionNote ? `: “${record.decisionNote}”` : ""} · {formatHoursAmount(total)} of {target} h
                    {short ? <span className="ts-why"> · {short}</span> : null}
                  </span>
                  <span className="form-actions" style={{ marginTop: 0 }}>
                    {inWeek ? (
                      <button className="btn-ghost btn-tiny" type="button" onClick={() => openLog(d)}>
                        Log time
                      </button>
                    ) : (
                      <button className="btn-ghost btn-tiny" type="button" onClick={() => setWeekStart(mondayOf(d))}>
                        Open week
                      </button>
                    )}
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

      <Card title="Assigned to you" action={<span className="muted">Tickets and accepted tasks</span>}>
        {myTickets.length + myTasks.length === 0 ? (
          <p className="muted">Nothing assigned right now. Work assigned to you shows up here.</p>
        ) : (
          <ul className="ts-assigned">
            {myTickets.map((t) => (
              <li key={t.id}>
                <div>
                  <span className="ts-kind">Ticket · {t.status}</span>
                  <strong title={t.title}>
                    {t.id} {t.title}
                  </strong>
                  <span className="muted">
                    {t.projectName ?? "No project"}
                    {t.due ? ` · due ${formatShortDate(t.due)}` : ""}
                  </span>
                </div>
                <span className="form-actions" style={{ marginTop: 0 }}>
                  <Link className="btn-ghost btn-tiny" to={`/tickets?id=${t.id}`}>
                    Open
                  </Link>
                  {canLogThisWeek && (
                    <button className="btn btn-tiny" type="button" onClick={() => openLog(undefined, { type: "ticket", id: t.id })}>
                      Log time
                    </button>
                  )}
                </span>
              </li>
            ))}
            {myTasks.map((t: Task) => (
              <li key={t.id}>
                <div>
                  <span className="ts-kind">Task · {t.status === "progress" ? "In progress" : t.accepted ? "Accepted" : "Not accepted"}</span>
                  <strong title={t.subject}>
                    {t.code} {t.subject}
                  </strong>
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
                  <Link className="btn-ghost btn-tiny" to="/tasks">
                    Accept first
                  </Link>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <div className="ts-cal">
          <div className="ts-cal-head">
            <div className="ts-gutter" />
            {workDates.map((day) => {
              const dayDate = parseISODate(day);
              const label = dayDate.toLocaleDateString("en-IN", { weekday: "short", day: "numeric" });
              const total = dayTotals[day] ?? 0;
              return (
                <div key={day} className="ts-day-head">
                  <strong>{label}</strong>
                  <span>
                    {offDays[day] ? offDays[day].split(" · ")[0] : `${formatHoursAmount(total)} / ${targetFor(day)}h`}
                  </span>
                  {!offDays[day] && !legacyWeek && (myDay(day) || (day <= today && total > 0)) && (
                    <span className="ts-day-status" title={myDay(day)?.decisionNote ?? undefined}>
                      <DayStatusBadge status={myDay(day)?.status ?? "draft"} />
                    </span>
                  )}
                  {isFixable(myDay(day)?.status) && myDay(day)?.decisionNote && (
                    <span className="ts-day-note">“{myDay(day)?.decisionNote}”</span>
                  )}
                  {canLogOn(day) && (
                    <button className="ts-add-day" type="button" onClick={() => openLog(day)} aria-label={`Log time on ${label}`}>
                      +
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          <div className="ts-cal-body" style={{ height: (GRID_END - GRID_START) * HOUR_PX }}>
            <div className="ts-gutter">
              {hourMarks.map((hour) => (
                <div key={hour} className="ts-hour-label" style={{ top: (hour - GRID_START) * HOUR_PX }}>
                  {formatHourLabel(hour)}
                </div>
              ))}
            </div>

            {workDates.map((day) => (
              <div key={day} className="ts-day-col">
                {hourMarks.map((hour) => (
                  <div key={hour} className="ts-hour-line" style={{ top: (hour - GRID_START) * HOUR_PX }} />
                ))}
                {offDays[day] && (
                  <article
                    className="ts-block offday"
                    style={{ top: (9 - GRID_START) * HOUR_PX, height: DAY_TARGET * HOUR_PX - 4 }}
                    title={offDays[day]}
                  >
                    <strong>{offDays[day].split(" · ")[0]}</strong>
                    <span>{offDays[day].split(" · ").slice(1).join(" · ")}</span>
                    <em>No hours</em>
                  </article>
                )}
                {blocks
                  .filter((block) => block.date === day)
                  .map((block) => {
                    const top = (block.startHour - GRID_START) * HOUR_PX;
                    const height = Math.max(block.hours * HOUR_PX - 4, 28);
                    return (
                      <article
                        key={block.id}
                        className={`ts-block ${block.billable ? "billable" : "nonbillable"}`}
                        style={{ top, height }}
                        title={`${block.projectName}${block.workLabel ? ` · ${block.workLabel}` : ""}: ${block.note}`}
                      >
                        {block.workType !== "project" && (
                          <span className="ts-work-tag">
                            {block.workType === "ticket" ? block.workLabel.split(" ")[0] || "Ticket" : "Task"}
                          </span>
                        )}
                        <strong>{block.note}</strong>
                        <span>
                          {formatHourCompact(block.startHour)} – {formatHourCompact(block.startHour + block.hours)}
                        </span>
                        <em>{block.projectName}</em>
                        {canLogOn(block.date) && (
                          <button
                            type="button"
                            className="ts-block-x"
                            aria-label="Remove time block"
                            onClick={async () => {
                              const error = await removeTimeEntry(block.projectId, weekStart, block.id);
                              setMessage(error ? { tone: "err", text: error } : { tone: "ok", text: "Time block removed." });
                            }}
                          >
                            ×
                          </button>
                        )}
                      </article>
                    );
                  })}
              </div>
            ))}
          </div>

          <div className="ts-day-totals" aria-label="Daily totals">
            <div className="ts-gutter">
              <span>Daily total</span>
            </div>
            {workDates.map((day) => {
              const total = dayTotals[day] ?? 0;
              return (
                <div key={day} className="ts-day-total-cell">
                  <strong>{formatHoursAmount(total)}</strong>
                  <span>{offDays[day] ? "day off" : `of ${targetFor(day)}h`}</span>
                </div>
              );
            })}
          </div>

          <div className="ts-cal-foot">
            <div className="ts-legend">
              <span>
                <i className="dot billable" /> Billable time: {formatHoursAmount(billableTotal)}
              </span>
              <span>
                <i className="dot nonbillable" /> Non-billable time: {formatHoursAmount(nonBillableTotal)}
              </span>
              <span>Utilization: {weekCapacity ? Math.round((billableTotal / weekCapacity) * 100) : 0}%</span>
            </div>
            <strong>
              Week total: {formatHoursAmount(weekTotal)} / {weekCapacity}h
            </strong>
          </div>
        </div>
        <Banner message={message} />
      </Card>

      <Card title="Week by work">
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
        {breakdown.projectOnly > 0 && (
          <p className="muted">
            General project time (no ticket or task): {formatHoursAmount(breakdown.projectOnly)}
          </p>
        )}
      </Card>
        </>
      )}

      {view === "mine" && logOpen && (
        <div className="modal-root" role="presentation">
          <button className="modal-scrim" type="button" aria-label="Close" onClick={() => setLogOpen(false)} />
          <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="log-time-title">
            <h2 id="log-time-title">Log time</h2>
            <form onSubmit={logAction.submit(onLog)}>
              <div className="stack" style={{ marginTop: 12 }}>
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
                        chooseWork(
                          kind,
                          kind === "ticket"
                            ? myTickets[0]?.id ?? ""
                            : kind === "task"
                              ? loggableTasks[0]?.id ?? ""
                              : kind === "project"
                                ? projects[0]?.id ?? ""
                                : "",
                        )
                      }
                    >
                      {label}
                    </button>
                  ))}
                </div>
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
                <Field label={logKind === "project" ? "Project" : "Charged to project"}>
                  <select
                    value={projectId}
                    onChange={(event) => {
                      setProjectId(event.target.value);
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
                <Field label="Date">
                  <select value={date} onChange={(event) => setDate(event.target.value)}>
                    {workDates.map((day) => (
                      <option key={day} value={day} disabled={!canLogOn(day)}>
                        {formatShortDate(day)}
                        {offDays[day] ? ` — ${offDays[day].split(" · ")[0]}` : ""}
                      </option>
                    ))}
                  </select>
                </Field>
                <div className="ts-time-pair">
                  <Field label="Start">
                    <input
                      type="time"
                      step={900}
                      value={toHHMM(Number(startHour) || 0)}
                      onChange={(event) => {
                        const value = fromHHMM(event.target.value);
                        if (value !== null) setStartHour(String(value));
                      }}
                    />
                  </Field>
                  <Field label="End">
                    <input
                      type="time"
                      step={900}
                      value={toHHMM((Number(startHour) || 0) + (Number(hours) || 0))}
                      onChange={(event) => {
                        const value = fromHHMM(event.target.value);
                        const start = Number(startHour) || 0;
                        if (value !== null && value > start) setHours(String(Math.round((value - start) * 4) / 4));
                      }}
                    />
                  </Field>
                  <Field label="Hours">
                    <input type="number" min={0.25} max={24} step={0.25} value={hours} onChange={(event) => setHours(event.target.value)} />
                  </Field>
                </div>
                {date && (
                  <p className="muted" style={{ margin: 0 }}>
                    {formatShortDate(date)}: {formatHoursAmount(dayTotals[date] ?? 0)} logged
                    {Number(hours) > 0 ? ` → ${formatHoursAmount((dayTotals[date] ?? 0) + Number(hours))} with this block` : ""} of {targetFor(date)} h
                  </p>
                )}
                <Field label="What did you work on?">
                  <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="e.g. Invoice export polish" />
                </Field>
                <label className="check-row">
                  <input type="checkbox" checked={billable} onChange={(event) => setBillable(event.target.checked)} />
                  Billable time
                </label>
                  </>
                )}
              </div>
              <div className="form-actions">
                <button className="btn-ghost" type="button" onClick={() => setLogOpen(false)}>
                  {logKind === "leave" ? "Close" : "Cancel"}
                </button>
                {logKind !== "leave" && (
                  <SubmitButton action={logAction} className="btn" disabled={logKind !== "project" && !workId}>
                    Add block
                  </SubmitButton>
                )}
              </div>
            </form>
          </div>
        </div>
      )}
    </Page>
  );
}
