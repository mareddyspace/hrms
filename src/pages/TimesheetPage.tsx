import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Banner, Card, Field, Page, StatusPill } from "../components/ui.tsx";
import {
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
};

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

  function openLog(forDate?: string) {
    setDate(forDate && workDates.includes(forDate) ? forDate : workDates.includes(todayISO()) ? todayISO() : workDates[0] ?? todayISO());
    setProjectId(projects[0]?.id ?? "");
    setStartHour("9.5");
    setHours("1");
    setNote("");
    setBillable(true);
    setLogOpen(true);
  }

  function onLog(event: FormEvent) {
    event.preventDefault();
    const error = addTimeEntry(projectId, weekStart, {
      date,
      startHour: Number(startHour),
      hours: Number(hours),
      note,
      billable,
    });
    setMessage(error ? { tone: "err", text: error } : { tone: "ok", text: "Time block added to the week." });
    if (!error) setLogOpen(false);
  }

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
                    {formatHoursAmount(total)} / {DAY_TARGET}h
                  </span>
                  {!locked && (
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
                        title={`${block.projectName}: ${block.note}`}
                      >
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
        </>
      )}

      {view === "mine" && logOpen && (
        <div className="modal-root" role="presentation">
          <button className="modal-scrim" type="button" aria-label="Close" onClick={() => setLogOpen(false)} />
          <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="log-time-title">
            <h2 id="log-time-title">Log time</h2>
            <form onSubmit={onLog}>
              <div className="stack" style={{ marginTop: 12 }}>
                <Field label="Project">
                  <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
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
                      <option key={day} value={day}>
                        {formatShortDate(day)}
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
              </div>
              <div className="form-actions">
                <button className="btn-ghost" type="button" onClick={() => setLogOpen(false)}>
                  Cancel
                </button>
                <button className="btn" type="submit">
                  Add block
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </Page>
  );
}
