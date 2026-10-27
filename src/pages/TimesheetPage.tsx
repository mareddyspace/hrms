import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Banner, Card, Field, Page, StatusPill } from "../components/ui.tsx";
import {
  blockingLeave,
  holidaysForPerson,
  formatHourCompact,
  formatHourLabel,
  formatHoursAmount,
  formatShortDate,
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
import "./tickets.css";

const DAY_TARGET = 8;
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
type OrgFilter = "all" | "submitted" | "approved" | "missing" | "draft";

export function TimesheetPage() {
  const {
    currentProjects,
    state,
    employee,
    isManager,
    addTimeEntry,
    removeTimeEntry,
    submitWeekTimesheets,
    setOrgTimesheetStatus,
    canDecideFor,
  } = usePortal();
  const projects = currentProjects;
  const [view, setView] = useState<TimesheetView>("mine");
  const [orgFilter, setOrgFilter] = useState<OrgFilter>("all");
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
  const [params, setParams] = useSearchParams();
  const tickets = useTickets();
  const myTickets = useMemo(() => ticketsAssignedTo(employee.id, tickets), [employee.id, tickets]);
  const myTasks = useMemo(
    () => state.tasks.filter((t) => t.employeeId === employee.id && (t.status === "open" || t.status === "progress")),
    [employee.id, state.tasks],
  );
  const loggableTasks = myTasks.filter((t) => t.accepted);

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
  const weekCapacity = DAY_TARGET * workDates.length;
  const weekStatus = weekSheets.some((sheet) => sheet.status === "approved")
    ? "approved"
    : weekSheets.some((sheet) => sheet.status === "submitted")
      ? "submitted"
      : "draft";
  const locked = weekStatus === "approved";

  /** Tickets carry a project id; tasks a project or client name. Falls back to the first current project. */
  function projectForWork(type: WorkType, id: string): Project | undefined {
    if (type === "ticket") {
      const t = tickets.find((x) => x.id === id);
      return projects.find((p) => p.id === t?.projectId) ?? projects.find((p) => p.name === t?.projectName) ?? projects[0];
    }
    if (type === "task") {
      const t = state.tasks.find((x) => x.id === id);
      return (
        projects.find((p) => !!t?.projectName && p.name === t.projectName) ??
        projects.find((p) => !!t?.client && p.client === t.client) ??
        projects[0]
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
    const free = (d: string) => workDates.includes(d) && !offDays[d];
    setDate(
      forDate && free(forDate)
        ? forDate
        : free(todayISO())
          ? todayISO()
          : workDates.filter((d) => !offDays[d] && d <= todayISO()).pop() ?? workDates.find((d) => !offDays[d]) ?? workDates[0] ?? todayISO(),
    );
    setStartHour("9.5");
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
    if (locked) {
      setMessage({ tone: "err", text: "This week is approved and locked." });
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

  function onLog(event: FormEvent) {
    event.preventDefault();
    if (logKind === "leave") return;
    if (logKind !== "project" && !workId) {
      setMessage({ tone: "err", text: `Pick a ${logKind}.` });
      return;
    }
    if (offDays[date]) {
      setMessage({ tone: "err", text: `${formatShortDate(date)}: ${offDays[date]}. No hours on this day.` });
      return;
    }
    const error = addTimeEntry(projectId, weekStart, {
      date,
      startHour: Number(startHour),
      hours: Number(hours),
      note,
      billable,
      workType: logKind,
      ...(logKind === "project" ? {} : { workId, workLabel: workLabelFor(logKind, workId) }),
    });
    setMessage(error ? { tone: "err", text: error } : { tone: "ok", text: "Time block added." });
    if (!error) setLogOpen(false);
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

  function onSubmitWeek() {
    const error = submitWeekTimesheets(weekStart);
    setMessage(error ? { tone: "err", text: error } : { tone: "ok", text: "Week submitted for approval." });
  }

  const hourMarks = Array.from({ length: GRID_END - GRID_START + 1 }, (_, index) => GRID_START + index);

  const orgRows = useMemo(() => {
    return state.orgTimesheets
      .filter((row) => row.weekStart === weekStart)
      .filter((row) => (orgFilter === "all" ? true : row.status === orgFilter))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [orgFilter, state.orgTimesheets, weekStart]);

  const orgCounts = useMemo(() => {
    const weekRows = state.orgTimesheets.filter((row) => row.weekStart === weekStart);
    return {
      total: weekRows.length,
      submitted: weekRows.filter((row) => row.status === "submitted").length,
      approved: weekRows.filter((row) => row.status === "approved").length,
      missing: weekRows.filter((row) => row.status === "missing").length,
      draft: weekRows.filter((row) => row.status === "draft").length,
    };
  }, [state.orgTimesheets, weekStart]);

  return (
    <Page
      title={view === "mine" ? "My timesheet" : "Company timesheet"}
      action={view === "mine" ? <StatusPill status={weekStatus} /> : undefined}
    >
      <div className="ts-toolbar">
        <div className="ts-tabs" role="tablist" aria-label="Timesheet views">
          <button
            type="button"
            className={view === "mine" ? "active" : undefined}
            role="tab"
            aria-selected={view === "mine"}
            onClick={() => setView("mine")}
          >
            My timesheet
          </button>
          {isManager && (
            <button
              type="button"
              className={view === "company" ? "active" : undefined}
              role="tab"
              aria-selected={view === "company"}
              onClick={() => setView("company")}
            >
              Company timesheet
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
              <button className="btn" type="button" disabled={locked} onClick={() => openLog()}>
                Log time
              </button>
            </div>
          )}
        </div>
      </div>

      {view === "company" ? (
        <>
          <section className="summary-row" aria-label="Company timesheet summary">
            <div className="summary">
              <span>People</span>
              <strong>{orgCounts.total}</strong>
            </div>
            <div className="summary">
              <span>Submitted</span>
              <strong>{orgCounts.submitted}</strong>
            </div>
            <div className="summary">
              <span>Approved</span>
              <strong>{orgCounts.approved}</strong>
            </div>
            <div className="summary">
              <span>Missing</span>
              <strong>{orgCounts.missing}</strong>
            </div>
          </section>
          <div className="year-bar" role="tablist" aria-label="Company timesheet filter">
            {(
              [
                ["all", "All"],
                ["submitted", "Submitted"],
                ["approved", "Approved"],
                ["missing", "Missing"],
                ["draft", "Draft"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={orgFilter === value}
                className={orgFilter === value ? "year-chip active" : "year-chip"}
                onClick={() => setOrgFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <Card title="Organization timesheets">
            <div className="table-scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Code</th>
                    <th>Department</th>
                    <th>Projects</th>
                    <th>Hours</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {orgRows.length === 0 && (
                    <tr>
                      <td colSpan={7} className="muted">
                        No timesheet records for this week and filter.
                      </td>
                    </tr>
                  )}
                  {orgRows.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <strong>{row.name}</strong>
                      </td>
                      <td>{row.employeeCode}</td>
                      <td>{row.department}</td>
                      <td>{row.projectSummary}</td>
                      <td>{row.status === "missing" ? "—" : formatHoursAmount(row.hours)}</td>
                      <td>
                        <StatusPill status={row.status} />
                      </td>
                      <td>
                        {/* Only the person's reporting line decides — never their own row. */}
                        {row.status === "submitted" && canDecideFor(row.personId) && (
                          <span className="form-actions">
                            <button
                              className="btn btn-tiny"
                              type="button"
                              onClick={() => {
                                const error = setOrgTimesheetStatus(row.id, "approved");
                                setMessage(
                                  error
                                    ? { tone: "err", text: error }
                                    : { tone: "ok", text: `${row.name}'s timesheet approved.` },
                                );
                              }}
                            >
                              Approve
                            </button>
                            <button
                              className="btn-ghost btn-tiny"
                              type="button"
                              onClick={() => {
                                const error = setOrgTimesheetStatus(row.id, "draft");
                                setMessage(
                                  error
                                    ? { tone: "err", text: error }
                                    : { tone: "ok", text: `${row.name}'s timesheet sent back for changes.` },
                                );
                              }}
                            >
                              Send back
                            </button>
                          </span>
                        )}
                        {row.status === "submitted" && !canDecideFor(row.personId) && (
                          <span className="muted">Waiting for their manager</span>
                        )}
                        {row.status === "missing" && <span className="muted">Awaiting employee</span>}
                        {row.status === "draft" && <span className="muted">Not submitted</span>}
                        {row.status === "approved" && <span className="muted">Locked</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Banner message={message} />
          </Card>
        </>
      ) : (
        <>
      <div className={`ts-submit-bar ${weekStatus}`}>
        <span>
          {weekStatus === "approved"
            ? "Timesheet approved"
            : weekStatus === "submitted"
              ? "Timesheet submitted — waiting on manager"
              : "Timesheet unsubmitted"}
        </span>
        {weekStatus !== "approved" && weekStatus !== "submitted" && (
          <button className="btn btn-tiny" type="button" onClick={onSubmitWeek}>
            Submit for approval
          </button>
        )}
      </div>

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
                  <button className="btn btn-tiny" type="button" disabled={locked} onClick={() => openLog(undefined, { type: "ticket", id: t.id })}>
                    Log time
                  </button>
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
                  <button className="btn btn-tiny" type="button" disabled={locked} onClick={() => openLog(undefined, { type: "task", id: t.id })}>
                    Log time
                  </button>
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
                    {offDays[day] ? offDays[day].split(" · ")[0] : `${formatHoursAmount(total)} / ${DAY_TARGET}h`}
                  </span>
                  {!locked && !offDays[day] && (
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
                        {!locked && (
                          <button
                            type="button"
                            className="ts-block-x"
                            aria-label="Remove time block"
                            onClick={() => {
                              const error = removeTimeEntry(block.projectId, weekStart, block.id);
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
                  <span>of {DAY_TARGET}h</span>
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
            <form onSubmit={onLog}>
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
                      Approved leave shows on the calendar. No hours can be logged. <Link to="/leave">Leave</Link>
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
                      <option key={day} value={day} disabled={!!offDays[day]}>
                        {formatShortDate(day)}
                        {offDays[day] ? ` — ${offDays[day].split(" · ")[0]}` : ""}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Start time">
                  <select value={startHour} onChange={(event) => setStartHour(event.target.value)}>
                    {Array.from({ length: 22 }, (_, index) => index * 0.5 + 8).map((value) => (
                      <option key={value} value={String(value)}>
                        {formatHourCompact(value)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Hours">
                  <input type="number" min={0.5} max={12} step={0.5} value={hours} onChange={(event) => setHours(event.target.value)} />
                </Field>
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
                  <button className="btn" type="submit" disabled={logKind !== "project" && !workId}>
                    Add block
                  </button>
                )}
              </div>
            </form>
          </div>
        </div>
      )}
    </Page>
  );
}
