import { Fragment, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ActionButton, Card, StatusBadge } from "../components/ui.tsx";
import {
  addDaysISO,
  blockingLeave,
  formatHoursAmount,
  formatShortDate,
  halfDayLeave,
  holidaysForPerson,
  parseISODate,
  todayISO,
  weekDates,
} from "../model.ts";
import { usePortal } from "../store.tsx";
import { sharedProjectsFor } from "../seed.ts";
import { managementChain, findDemoById } from "../demoAccounts.ts";
import { directReportIds, getPerson } from "../data/peopleLocal.ts";
import { API_ENABLED } from "../api/client.ts";
import {
  loadApiTeamDays,
  loadApiWaitingDays,
  timeMirror,
  type TeamPersonOut,
  type TimesheetDayOut,
  type WeekEntryOut,
} from "../api/syncTimeSheets.ts";
import { approvalProgressText } from "../api/approvalProgress.ts";
import { DAY_STATUS_LABEL, DAY_TARGET, HALF_DAY_TARGET, useDayRecords, type DayStatus } from "../data/timesheetDays.ts";
import "./timesheetDays.css";

export function DayStatusBadge({ status }: { status: string }) {
  const key = (status in DAY_STATUS_LABEL ? status : "draft") as DayStatus;
  const tone = key === "approved" ? "ok" : key === "submitted" ? "warn" : key === "rejected" ? "danger" : key === "reopened" ? "info" : "neutral";
  return <StatusBadge status={DAY_STATUS_LABEL[key]} tone={tone} literal />;
}

export function HoursMeter({ total, target }: { total: number; target: number }) {
  const pct = target > 0 ? Math.min(100, Math.round((total / target) * 100)) : total > 0 ? 100 : 0;
  return (
    <div className="ts-today-meter">
      <strong>
        {formatHoursAmount(total)}
        {target > 0 ? ` of ${target} h` : ""}
      </strong>
      {target > 0 && (
        <div className={`ts-progress ${total >= target ? "full" : ""}`} role="progressbar" aria-valuemin={0} aria-valuemax={target} aria-valuenow={total}>
          <i style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

function submittedText(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

function projectSplit(entries: WeekEntryOut[]): [string, number][] {
  const map = new Map<string, number>();
  for (const e of entries) {
    const name = e.project_name || e.project_code;
    map.set(name, (map.get(name) ?? 0) + e.hours);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

/** Team timesheets (daily): what's waiting on the manager, and who logged how many hours this week. */
export function TimesheetTeamDays({ weekStart, onWaitingCount }: { weekStart: string; onWaitingCount?: (n: number) => void }) {
  const portal = usePortal();
  const { state, employee, canDecideFor, decideTimesheetDay, reopenTimesheetDay } = portal;
  const records = useDayRecords();
  const apiTime = useSyncExternalStore(timeMirror.subscribe, timeMirror.get, timeMirror.get);
  const [apiTeam, setApiTeam] = useState<TeamPersonOut[] | null>(null);
  const [apiWaiting, setApiWaiting] = useState<TimesheetDayOut[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [comments, setComments] = useState<Record<string, string>>({});
  // "Reopen a day": a missed past working day the person can then log and submit.
  const [reopenFor, setReopenFor] = useState<string | null>(null);
  const [reopenDate, setReopenDate] = useState("");
  const [reopenNote, setReopenNote] = useState("");
  const today = todayISO();

  useEffect(() => {
    if (!API_ENABLED) return;
    let stale = false;
    // Each list on its own: a server without daily timesheets (404) still leaves the weekly list below working.
    const fail = (err: unknown) => {
      if (!stale) setLoadError(err instanceof Error && err.message ? `Daily timesheets: ${err.message}` : "Could not load daily timesheets.");
    };
    loadApiTeamDays(weekStart)
      .then((team) => {
        if (!stale) setApiTeam(team);
      })
      .catch((err: unknown) => {
        if (!stale) setApiTeam([]);
        fail(err);
      });
    loadApiWaitingDays()
      .then((waiting) => {
        if (!stale) setApiWaiting(waiting);
      })
      .catch((err: unknown) => {
        if (!stale) setApiWaiting([]);
        fail(err);
      });
    return () => {
      stale = true;
    };
  }, [weekStart, apiTime]);

  // Local mode: built from the timesheets and day records kept in this browser.
  const local = useMemo(() => {
    if (API_ENABLED) return { team: [] as TeamPersonOut[], waiting: [] as TimesheetDayOut[] };
    const isHr = portal.demoProfile.role === "hr" || portal.demoProfile.role === "hr_admin";
    const decides = (personId: string) =>
      personId !== employee.id &&
      (canDecideFor(personId, "timesheets") || (isHr && managementChain(personId).length === 0));
    const nameOf = (id: string) => getPerson(id)?.fullName ?? findDemoById(id)?.fullName ?? id;
    const projectName = (personId: string, id: string) =>
      state.projects.find((p) => p.id === id)?.name ?? sharedProjectsFor(personId).find((p) => p.id === id)?.name ?? id;
    const entriesOf = (personId: string, from: string, to: string): WeekEntryOut[] =>
      state.timesheets
        .filter((s) => s.employeeId === personId)
        .flatMap((s) =>
          (s.entries ?? [])
            .filter((e) => e.date >= from && e.date <= to)
            .map((e) => ({
              id: e.id,
              employee_id: personId,
              week_id: s.id,
              work_date: e.date,
              project_id: s.projectId,
              task: e.note,
              hours: e.hours,
              billable: e.billable,
              comment: e.workLabel ?? null,
              project_code: "",
              project_name: projectName(personId, s.projectId),
            })),
        );
    const dayOut = (personId: string, date: string, entries: WeekEntryOut[]): TimesheetDayOut => {
      const rec = records.find((r) => r.personId === personId && r.date === date);
      const weekday = parseISODate(date).getDay();
      const holiday = holidaysForPerson(state.holidays, personId).some((h) => h.date === date);
      const leave = blockingLeave(state.leaveRequests, personId, date);
      const half = halfDayLeave(state.leaveRequests, personId, date);
      const kind = leave ? "leave" : weekday === 0 || weekday === 6 ? "weekend" : holiday ? "holiday" : half ? "half-day leave" : null;
      const target = kind === "half-day leave" ? HALF_DAY_TARGET : kind ? 0 : DAY_TARGET;
      const canDecide = rec?.status === "submitted" && decides(personId);
      return {
        id: rec?.id ?? null,
        employee_id: personId,
        employee_name: nameOf(personId),
        work_date: date,
        status: rec?.status ?? "draft",
        total_hours: entries.reduce((a, e) => a + e.hours, 0),
        target_hours: target,
        day_kind: kind,
        submitted_at: rec?.submittedAt ?? null,
        decided_by: rec?.decidedBy ?? null,
        decided_by_name: rec?.decidedByName ?? null,
        decided_at: rec?.decidedOn ?? null,
        decision_note: rec?.decisionNote ?? null,
        waiting_on_me: canDecide,
        can_decide: canDecide,
        entries,
      };
    };
    const end = addDaysISO(weekStart, 6);
    const ids = new Set<string>(directReportIds(employee.id));
    for (const s of state.timesheets) if (s.weekStart === weekStart && decides(s.employeeId)) ids.add(s.employeeId);
    for (const r of records) if (r.date >= weekStart && r.date <= end && decides(r.personId)) ids.add(r.personId);
    ids.delete(employee.id);
    const team: TeamPersonOut[] = [...ids]
      .map((id) => {
        const entries = entriesOf(id, weekStart, end);
        const projects: Record<string, number> = {};
        for (const [name, h] of projectSplit(entries)) projects[name] = h;
        return {
          employee_id: id,
          employee_name: nameOf(id),
          employee_code: getPerson(id)?.employeeCode ?? "",
          department: getPerson(id)?.department ?? "",
          week_total: entries.reduce((a, e) => a + e.hours, 0),
          projects,
          days: weekDates(weekStart).length
            ? Array.from({ length: 7 }, (_, i) => addDaysISO(weekStart, i)).map((d) => dayOut(id, d, entries.filter((e) => e.work_date === d)))
            : [],
        };
      })
      .sort((a, b) => a.employee_name.localeCompare(b.employee_name));
    const waiting = records
      .filter((r) => r.status === "submitted" && decides(r.personId))
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((r) => dayOut(r.personId, r.date, entriesOf(r.personId, r.date, r.date)));
    return { team, waiting };
  }, [canDecideFor, employee.id, portal.demoProfile.role, records, state.holidays, state.leaveRequests, state.projects, state.timesheets, weekStart]);

  const team = API_ENABLED ? apiTeam : local.team;
  const waiting = API_ENABLED ? apiWaiting : local.waiting;
  const readyCount = (waiting ?? []).filter((d) => d.total_hours >= d.target_hours).length;

  useEffect(() => {
    onWaitingCount?.((waiting ?? []).length);
  }, [waiting, onWaitingCount]);

  async function decide(day: TimesheetDayOut, decision: "approved" | "rejected") {
    if (!day.id) return "Nothing submitted for this day.";
    const note = comments[day.id]?.trim();
    if (decision === "rejected" && !note) return "Add a comment saying what to change.";
    const error = await decideTimesheetDay(day.id, decision, note);
    if (error) return error;
    setComments((c) => ({ ...c, [day.id!]: "" }));
    if (API_ENABLED) setApiWaiting((list) => (list ?? []).filter((d) => d.id !== day.id));
    return null;
  }

  async function approveAllReady() {
    const ready = (waiting ?? []).filter((d) => d.total_hours >= d.target_hours && d.id);
    if (ready.length === 0) return "No submitted day meets 9 h.";
    let failed = 0;
    for (const d of ready) {
      const error = await decideTimesheetDay(d.id!, "approved");
      if (error) failed += 1;
    }
    if (API_ENABLED) setApiWaiting((list) => (list ?? []).filter((d) => !ready.some((r) => r.id === d.id)));
    return failed ? `${ready.length - failed} approved, ${failed} couldn't be approved.` : null;
  }

  function decideControls(day: TimesheetDayOut) {
    if (!day.id || day.status !== "submitted" || !day.can_decide) return null;
    const who = day.employee_name ?? "them";
    return (
      <div className="ts-decide">
        <ActionButton className="btn btn-tiny" success={`${who}'s ${formatShortDate(day.work_date)} approved.`} toastError onAction={() => decide(day, "approved")}>
          Approve
        </ActionButton>
        <input
          aria-label="Comment"
          placeholder="Comment (needed to send back)"
          value={comments[day.id] ?? ""}
          onChange={(e) => setComments((c) => ({ ...c, [day.id!]: e.target.value }))}
        />
        <ActionButton className="btn-ghost btn-tiny" success={`Sent back to ${who}.`} toastError onAction={() => decide(day, "rejected")}>
          Send back
        </ActionButton>
      </div>
    );
  }

  function entriesTable(day: TimesheetDayOut) {
    if (day.entries.length === 0) return <p className="muted">No hours logged on {formatShortDate(day.work_date)}.</p>;
    return (
      <table className="data ts-entries">
        <thead>
          <tr>
            <th>Project</th>
            <th>Work</th>
            <th>Hours</th>
            <th>Billable</th>
          </tr>
        </thead>
        <tbody>
          {day.entries.map((e) => (
            <tr key={e.id}>
              <td>{e.project_name || e.project_code}</td>
              <td>
                {e.task}
                {e.comment ? <span className="muted"> · {e.comment}</span> : null}
              </td>
              <td>{formatHoursAmount(e.hours)}</td>
              <td>{e.billable ? "Yes" : "No"}</td>
            </tr>
          ))}
          <tr>
            <td colSpan={2}>
              <strong>Day total</strong>
            </td>
            <td colSpan={2}>
              <strong>{formatHoursAmount(day.total_hours)}</strong>
            </td>
          </tr>
        </tbody>
      </table>
    );
  }

  const workDays = (person: TeamPersonOut) =>
    person.days.filter((d) => d.day_kind !== "weekend" || d.total_hours > 0 || d.id);

  return (
    <>
      {loadError && <p className="note err">{loadError}</p>}
      <Card
        title={`Waiting for you · ${(waiting ?? []).length}`}
        action={
          (waiting ?? []).length > 0 ? (
            <ActionButton
              className="btn btn-tiny"
              disabled={readyCount === 0}
              success={`Approved ${readyCount} day${readyCount === 1 ? "" : "s"}.`}
              toastError
              onAction={approveAllReady}
            >
              Approve all that meet 9 h ({readyCount})
            </ActionButton>
          ) : undefined
        }
      >
        {waiting === null ? (
          <p className="muted">Loading…</p>
        ) : waiting.length === 0 ? (
          <p className="muted">No timesheets waiting for you.</p>
        ) : (
          <div className="table-scroll">
            <table className="data ts-team-table">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Day</th>
                  <th>Hours</th>
                  <th>Projects</th>
                  <th>Submitted</th>
                  <th>Decision</th>
                </tr>
              </thead>
              <tbody>
                {waiting.map((day) => {
                  const key = `w-${day.id}`;
                  return (
                    <Fragment key={key}>
                      <tr>
                        <td>
                          <button type="button" className="link-btn" onClick={() => setOpen(open === key ? null : key)} aria-expanded={open === key}>
                            <strong>{day.employee_name}</strong>
                          </button>
                        </td>
                        <td>
                          {parseISODate(day.work_date).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" })}
                          {day.day_kind && <span className="ts-day-note">{day.day_kind}</span>}
                        </td>
                        <td className="ts-hours-cell">
                          <HoursMeter total={day.total_hours} target={day.target_hours} />
                        </td>
                        <td>
                          <div className="ts-proj-split">
                            {projectSplit(day.entries).map(([name, h]) => (
                              <div key={name}>
                                {name} <span>{formatHoursAmount(h)}</span>
                              </div>
                            ))}
                          </div>
                        </td>
                        <td>
                          {submittedText(day.submitted_at)}
                          {API_ENABLED && approvalProgressText(day.approval) && (
                            <span className="ts-day-note">{approvalProgressText(day.approval)}</span>
                          )}
                        </td>
                        <td>{decideControls(day)}</td>
                      </tr>
                      {open === key && (
                        <tr>
                          <td colSpan={6}>{entriesTable(day)}</td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Who logged what this week" action={<span className="muted">Click a day to see entries</span>}>
        {team === null ? (
          <p className="muted">Loading…</p>
        ) : team.length === 0 ? (
          <p className="muted">No one in your team has timesheets to show.</p>
        ) : (
          <div className="table-scroll">
            <table className="data ts-team-table">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Today</th>
                  <th>Week</th>
                  <th>Projects</th>
                  <th>Days</th>
                </tr>
              </thead>
              <tbody>
                {team.map((person) => {
                  const todayDay = person.days.find((d) => d.work_date === today);
                  const openDay = person.days.find((d) => open === `${person.employee_id}|${d.work_date}`);
                  return (
                    <Fragment key={person.employee_id}>
                      <tr>
                        <td>
                          <strong>{person.employee_name}</strong>
                          <span className="ts-day-note">
                            {[person.employee_code, person.department].filter(Boolean).join(" · ")}
                          </span>
                          <button
                            type="button"
                            className="link-btn ts-day-note"
                            aria-expanded={reopenFor === person.employee_id}
                            onClick={() => {
                              setReopenFor(reopenFor === person.employee_id ? null : person.employee_id);
                              setReopenDate(addDaysISO(today, -1));
                              setReopenNote("");
                            }}
                          >
                            Reopen a day
                          </button>
                        </td>
                        <td className="ts-hours-cell">
                          {todayDay ? (
                            <>
                              <HoursMeter total={todayDay.total_hours} target={todayDay.target_hours} />
                              <span className="ts-day-status">
                                <DayStatusBadge status={todayDay.status} />
                              </span>
                            </>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                        <td>
                          <strong>{formatHoursAmount(person.week_total)}</strong>
                        </td>
                        <td>
                          <div className="ts-proj-split">
                            {Object.keys(person.projects).length === 0 && <span>No time logged</span>}
                            {Object.entries(person.projects).map(([name, h]) => (
                              <div key={name}>
                                {name} <span>{formatHoursAmount(h)}</span>
                              </div>
                            ))}
                          </div>
                        </td>
                        <td>
                          <div className="ts-day-chips">
                            {workDays(person).map((d) => {
                              const key = `${person.employee_id}|${d.work_date}`;
                              const label = parseISODate(d.work_date).toLocaleDateString("en-IN", { weekday: "short", day: "numeric" });
                              return (
                                <button
                                  key={d.work_date}
                                  type="button"
                                  className={`ts-day-chip ${d.status} ${open === key ? "open" : ""}`}
                                  title={`${label}: ${DAY_STATUS_LABEL[(d.status in DAY_STATUS_LABEL ? d.status : "draft") as DayStatus]}${d.decision_note ? ` · “${d.decision_note}”` : ""}`}
                                  onClick={() => setOpen(open === key ? null : key)}
                                  aria-expanded={open === key}
                                >
                                  <span>{label}</span>
                                  <strong>{d.day_kind === "leave" || d.day_kind === "holiday" ? d.day_kind : formatHoursAmount(d.total_hours)}</strong>
                                  <span>{d.status === "draft" ? (d.work_date > today ? "" : "Draft") : DAY_STATUS_LABEL[d.status as DayStatus] ?? d.status}</span>
                                </button>
                              );
                            })}
                          </div>
                        </td>
                      </tr>
                      {reopenFor === person.employee_id && (
                        <tr>
                          <td colSpan={5}>
                            <div className="ts-reopen">
                              <span>
                                Reopen a missed day for <strong>{person.employee_name}</strong>:
                              </span>
                              <input
                                type="date"
                                aria-label="Day to reopen"
                                max={addDaysISO(today, -1)}
                                value={reopenDate}
                                onChange={(e) => setReopenDate(e.target.value)}
                              />
                              <input
                                type="text"
                                aria-label="Reason"
                                placeholder="Short reason, e.g. Forgot to log the client visit"
                                value={reopenNote}
                                onChange={(e) => setReopenNote(e.target.value)}
                              />
                              <ActionButton
                                className="btn btn-tiny"
                                toastError
                                success={`${formatShortDate(reopenDate || today)} reopened for ${person.employee_name}.`}
                                onAction={() => reopenTimesheetDay(person.employee_id, reopenDate, reopenNote)}
                                onSuccess={() => setReopenFor(null)}
                              >
                                Reopen
                              </ActionButton>
                              <button type="button" className="btn-ghost btn-tiny" onClick={() => setReopenFor(null)}>
                                Cancel
                              </button>
                            </div>
                            <p className="muted" style={{ margin: "4px 0 0" }}>
                              They can then log time for that day and submit it. They get a notification.
                            </p>
                          </td>
                        </tr>
                      )}
                      {openDay && (
                        <tr>
                          <td colSpan={5}>
                            <p>
                              <strong>
                                {person.employee_name} ·{" "}
                                {parseISODate(openDay.work_date).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "short" })}
                              </strong>{" "}
                              <DayStatusBadge status={openDay.status} />
                              {openDay.submitted_at && <span className="muted"> · submitted {submittedText(openDay.submitted_at)}</span>}
                              {openDay.decision_note && <span className="muted"> · “{openDay.decision_note}”</span>}
                              {openDay.decided_by_name && openDay.status !== "submitted" && (
                                <span className="muted"> · by {openDay.decided_by_name}</span>
                              )}
                            </p>
                            {entriesTable(openDay)}
                            {decideControls(openDay)}
                            {openDay.status === "submitted" && !openDay.can_decide && (
                              <p className="muted">Waiting for {approvalProgressText(openDay.approval) || "their manager"}.</p>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
