import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Link } from "react-router-dom";
import {
  Banner,
  Card,
  DataTable,
  Dialog,
  EmptyState,
  Field,
  MetricCard,
  MetricGrid,
  Page,
  StatusBadge,
  SubmitButton,
  Tabs,
  useAction,
} from "../components/ui.tsx";
import { loadPersonSummary, useTeamToday, type TeamSummaryOut } from "../api/syncTeam.ts";
import { clockText, hoursText, STATUS_TEXT, STATUS_TONE, useTeamSummaryRows } from "../features/manager/teamSummary.ts";
import { localTeamSummary } from "../data/teamSummaryLocal.ts";
import { useTickets } from "../data/ticketStore.ts";
import { getAttendanceState, subscribeAttendance } from "../data/attendanceLocal.ts";
import { listPeople, subscribePeople } from "../data/peopleLocal.ts";
import type { PersonRecord } from "../data/peopleData.ts";
import { personToday } from "../data/teamOverview.ts";
import { useDayRecords } from "../data/timesheetDays.ts";
import { taskPersonById } from "../data/taskTeam.ts";
import { scheduleOneOnOne } from "../data/talentLocal.ts";
import { dayStatus, directReportsOf, teamBelow } from "../data/workforceStats.ts";
import { useApprovalInbox } from "./ApprovalsCenter.tsx";
import { giveKudos, recognitionPeople, RECOGNITION_VALUES } from "../features/recognition/recognitionStore.ts";
import { DEMO_ACCOUNTS } from "../demoAccounts.ts";
import { addDaysISO, formatShortDate, leaveNameFor, parseISODate, plural, TASK_TYPES, todayISO, type TaskPriority, type TaskType } from "../model.ts";
import { usePortal } from "../store.tsx";
import { API_ENABLED } from "../api/client.ts";
import "./team.css";
import "../styles/manager.css";

type QuickAction = { kind: "task" | "kudos" | "oneonone"; person: PersonRecord } | null;

const TS_LABEL: Record<string, string> = {
  draft: "Not sent",
  submitted: "Submitted",
  approved: "Approved",
  rejected: "Sent back",
  reopened: "Reopened",
};
const TS_TONE: Record<string, "ok" | "warn" | "danger" | "neutral"> = {
  draft: "neutral",
  submitted: "warn",
  approved: "ok",
  rejected: "danger",
  reopened: "warn",
};

/** Team overview: who's in today, hours, timesheets, leave left and open tasks per person, with quick actions. */
export function MyTeamPage() {
  const { employee, state, canDecideFor, demoProfile } = usePortal();
  const people = useSyncExternalStore(subscribePeople, listPeople, listPeople);
  useSyncExternalStore(subscribeAttendance, getAttendanceState, getAttendanceState);
  useDayRecords();
  const apiToday = useTeamToday();
  const [view, setView] = useState("direct");
  const [quick, setQuick] = useState<QuickAction>(null);
  const [drill, setDrill] = useState<string | null>(null);
  const today = todayISO();

  const { direct, everyone, joiningSoon } = useMemo(() => {
    const byId = new Map(people.map((p) => [p.id, p]));
    const mine = directReportsOf(employee.id, people);
    const rows = teamBelow(employee.id, people, canDecideFor)
      .map((m) => byId.get(m.id))
      .filter((p): p is NonNullable<typeof p> => Boolean(p))
      .sort((a, b) => a.fullName.localeCompare(b.fullName));
    return { direct: mine.active, everyone: rows, joiningSoon: mine.joiningSoon };
  }, [employee.id, people, canDecideFor]);

  const teamIds = useMemo(() => new Set(everyone.map((p) => p.id)), [everyone]);
  // Same list (and rules) as Workflows and Approvals, so "Approve (n)" matches what opens there.
  const { waiting } = useApprovalInbox();
  const waitingBy = new Map<string, number>();
  for (const w of waiting) if (teamIds.has(w.employeeId)) waitingBy.set(w.employeeId, (waitingBy.get(w.employeeId) ?? 0) + 1);
  const leaveName = (code: string, id: string) => leaveNameFor(state.leavePolicies, code, id) ?? code;

  const scope = view === "direct" ? direct : everyone;
  const shown = useMemo(() => scope.slice(0, 200), [scope]);
  const summary = useTeamSummaryRows(shown, waitingBy);
  const byPerson = new Map(summary.rows.map((r) => [r.employee_id, r]));
  const rows = shown.map((person) => {
    const s = byPerson.get(person.id);
    const now = personToday(state, person.id, today, apiToday.rows.get(person.id));
    // Until the summary arrives, fall back to the calendar status.
    const status = s?.status ?? (dayStatus(state, person.id, String(person.countryCode), today) === "On leave" ? "on_leave" : "not_in");
    return { person, s, now, status };
  });
  const outToday = rows.filter((r) => r.status === "on_leave" || r.status === "holiday");
  const notIn = rows.filter((r) => r.status === "not_in");
  const inToday = rows.filter((r) => Boolean(r.s?.check_in)).length;
  const scopeIds = new Set(scope.map((p) => p.id));
  const waitingCount = waiting.filter((w) => scopeIds.has(w.employeeId)).length;
  const sum = (key: "open_tasks" | "overdue_tasks" | "open_tickets" | "overdue_tickets" | "timesheet_submitted") =>
    rows.reduce((n, r) => n + (r.s?.[key] ?? 0), 0);
  const drillRow = drill ? rows.find((r) => r.person.id === drill) : undefined;

  const until = addDaysISO(today, 14);
  const upcoming = state.leaveRequests
    .filter((r) => scopeIds.has(r.employeeId) && (r.status === "approved" || r.status === "pending") && r.to >= today && r.from <= until)
    .filter((r) => !(r.from <= today && r.to >= today && r.status === "approved"))
    .sort((a, b) => a.from.localeCompare(b.from));
  const nameOf = (id: string) => people.find((p) => p.id === id)?.fullName ?? "Colleague";

  const kudosIds = new Set(recognitionPeople().map((p) => p.id));
  const canTask = (id: string) => Boolean(taskPersonById(id)) && canDecideFor(id);
  const canOneOnOne = (id: string) => DEMO_ACCOUNTS.some((a) => a.id === id && a.reportsToId === employee.id);

  const joiningCard =
    joiningSoon.length > 0 ? (
      <Card title={`Joining soon · ${joiningSoon.length}`}>
        <DataTable
          headers={["Name", "Title", "Department", "Starts"]}
          rows={joiningSoon.map((person) => [
            <Link key={person.id} to={`/people/${person.id}`}>{person.fullName}</Link>,
            person.designation,
            person.department,
            formatShortDate(person.dateOfJoining),
          ])}
        />
      </Card>
    ) : null;

  if (everyone.length === 0) {
    return (
      <Page title="Team overview">
        <EmptyState title="No team" description={joiningSoon.length ? "No one reports to you yet." : "No one reports to you."} />
        {joiningCard}
      </Page>
    );
  }

  return (
    <Page title="Team overview">
      <div className="team-tiles">
      <MetricGrid>
        <MetricCard label="In today" value={`${inToday} of ${rows.length}`} />
        <MetricCard label="Out today" value={outToday.length} />
        <MetricCard label="Not checked in" value={notIn.length} />
        <MetricCard label="Waiting on you" value={waitingCount} />
        <MetricCard label="Open tasks" value={sum("open_tasks")} hint={sum("overdue_tasks") ? `${sum("overdue_tasks")} overdue` : undefined} />
        <MetricCard label="Open tickets" value={sum("open_tickets")} hint={sum("overdue_tickets") ? `${sum("overdue_tickets")} overdue` : undefined} />
      </MetricGrid>
      </div>

      {(outToday.length > 0 || notIn.length > 0) && (
        <Card title="Who's out today">
          <ul className="team-out-list">
            {outToday.map((r) => (
              <li key={r.person.id}>
                <Link to={`/people/${r.person.id}`}>{r.person.fullName}</Link> <StatusBadge status={STATUS_TEXT[r.status]} tone="info" literal />
              </li>
            ))}
            {notIn.map((r) => (
              <li key={r.person.id}>
                <Link to={`/people/${r.person.id}`}>{r.person.fullName}</Link>{" "}
                <StatusBadge status="Not checked in" tone="warn" literal keepCase />
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card
        title="Team today"
        action={
          <span className="mgr-links">
            <Link to="/timesheet?view=team">Timesheets{sum("timesheet_submitted") ? ` (${sum("timesheet_submitted")})` : ""}</Link>
            <Link to="/tasks">Tasks</Link>
            <Link to="/tickets">Tickets</Link>
          </span>
        }
      >
        <Tabs
          tabs={[
            { id: "direct", label: `Direct (${direct.length})` },
            { id: "all", label: `Everyone (${everyone.length})` },
          ]}
          value={view}
          onChange={setView}
        />
        {API_ENABLED && !summary.loaded && <p className="muted">Loading today…</p>}
        {summary.error && <p className="note err">{summary.error}</p>}
        <DataTable
          headers={["Name", "Today", "Hours today", "This week", "This month", "Late", "Overtime", "Timesheet", "Work", ""]}
          rows={rows.map(({ person, s, now, status }) => {
            const waitingN = waitingBy.get(person.id) ?? 0;
            const clock = s?.check_in ? `${clockText(s.check_in)}${s.check_out ? `–${clockText(s.check_out)}` : ""}` : "";
            return [
              <span key="n" className="team-name">
                <button type="button" className="link-btn" onClick={() => setDrill(person.id)}>
                  <strong>{person.fullName}</strong>
                </button>
                <span className="muted">{person.designation}</span>
              </span>,
              <span key="s" className="team-name">
                <StatusBadge status={STATUS_TEXT[status] ?? status} tone={STATUS_TONE[status]} literal keepCase />
                {clock && <span className="muted">{clock}</span>}
              </span>,
              s ? <HoursVsTarget key="h" minutes={s.today_minutes} target={s.today_target_minutes} /> : "—",
              s ? <HoursVsTarget key="w" minutes={s.week_minutes} target={s.week_target_minutes} /> : "—",
              s ? <HoursVsTarget key="m" minutes={s.month_minutes} target={s.month_target_minutes} /> : "—",
              s?.late_days_month ? <span key="l" className="mgr-flag warn">{plural(s.late_days_month, "day")}</span> : "—",
              s?.overtime_minutes_month ? hoursText(s.overtime_minutes_month) : "—",
              <span key="t" className="team-name">
                <StatusBadge status={TS_LABEL[now.timesheetStatus] ?? now.timesheetStatus} tone={TS_TONE[now.timesheetStatus]} literal keepCase />
                {s?.timesheet_missing_days ? <span className="mgr-flag danger">{s.timesheet_missing_days} missing</span> : null}
              </span>,
              <span key="k" className="mgr-work">
                <Link to="/tasks">{plural(s?.open_tasks ?? 0, "task")}</Link>
                {s?.overdue_tasks ? <span className="mgr-flag danger">{s.overdue_tasks} overdue</span> : null}
                <Link to="/tickets">{plural(s?.open_tickets ?? 0, "ticket")}</Link>
                {s?.overdue_tickets ? <span className="mgr-flag danger">{s.overdue_tickets} overdue</span> : null}
              </span>,
              <span key="a" className="team-actions">
                {waitingN > 0 && (
                  <Link className="btn btn-tiny" to={`/approvals?person=${encodeURIComponent(person.id)}`}>
                    Review ({waitingN})
                  </Link>
                )}
                {canTask(person.id) && (
                  <button type="button" className="btn-ghost btn-tiny" onClick={() => setQuick({ kind: "task", person })}>
                    Assign task
                  </button>
                )}
                {kudosIds.has(person.id) && person.id !== employee.id && (
                  <button type="button" className="btn-ghost btn-tiny" onClick={() => setQuick({ kind: "kudos", person })}>
                    Kudos
                  </button>
                )}
                {canOneOnOne(person.id) && (
                  <button type="button" className="btn-ghost btn-tiny" onClick={() => setQuick({ kind: "oneonone", person })}>
                    1:1
                  </button>
                )}
              </span>,
            ];
          })}
          empty={<EmptyState title="No team members" description="No one in this view." />}
        />
        {scope.length > 200 && <p className="muted">Showing 200 of {scope.length}.</p>}
      </Card>

      {drillRow && (
        <PersonDrillDialog
          person={drillRow.person}
          row={drillRow.s}
          leaveLeft={drillRow.now.leaveLeft}
          pending={waitingBy.get(drillRow.person.id) ?? 0}
          onClose={() => setDrill(null)}
        />
      )}

      <Card title="Leave in the next 14 days">
        <DataTable
          headers={["Name", "Leave", "Dates", "Status"]}
          rows={upcoming.map((r) => [
            nameOf(r.employeeId),
            leaveName(r.code, r.employeeId),
            r.from === r.to ? formatShortDate(r.from) : `${formatShortDate(r.from)} – ${formatShortDate(r.to)}`,
            <StatusBadge key={r.id} status={r.status} />,
          ])}
          empty={<p className="muted">No leave coming up.</p>}
        />
      </Card>

      {joiningCard}

      {quick?.kind === "task" && <AssignTaskDialog person={quick.person} onClose={() => setQuick(null)} />}
      {quick?.kind === "kudos" && (
        <KudosDialog person={quick.person} actor={{ id: demoProfile.id, fullName: demoProfile.fullName, role: demoProfile.role, department: demoProfile.department }} onClose={() => setQuick(null)} />
      )}
      {quick?.kind === "oneonone" && (
        <OneOnOneDialog person={quick.person} me={{ id: employee.id, fullName: employee.fullName, role: demoProfile.role }} onClose={() => setQuick(null)} />
      )}
    </Page>
  );
}

/** "7.5 of 9 h" with a thin bar; red when under target on a finished period. */
function HoursVsTarget({ minutes, target }: { minutes: number; target: number }) {
  const pct = target > 0 ? Math.min(100, Math.round((minutes / target) * 100)) : minutes > 0 ? 100 : 0;
  return (
    <span className="mgr-hours">
      <span>
        {hoursText(minutes)}
        {target > 0 && <span className="muted"> / {hoursText(target)}</span>}
      </span>
      {target > 0 && (
        <span className={`mgr-meter ${minutes >= target ? "full" : ""}`} aria-hidden>
          <i style={{ width: `${pct}%` }} />
        </span>
      )}
    </span>
  );
}

const DAY_KIND_TEXT: Record<string, string> = { weekend: "Weekly off", holiday: "Holiday", leave: "On leave", "half-day leave": "Half-day leave" };

/** One report's month: each day's attendance against the target, late, overtime and the timesheet logged. */
function PersonDrillDialog({
  person,
  row,
  leaveLeft,
  pending,
  onClose,
}: {
  person: PersonRecord;
  row?: TeamSummaryOut;
  leaveLeft: { code: string; name: string; available: number }[];
  pending: number;
  onClose: () => void;
}) {
  const { state, employee } = usePortal();
  const records = useDayRecords();
  const tickets = useTickets();
  const att = useSyncExternalStore(subscribeAttendance, getAttendanceState, getAttendanceState);
  const [apiRow, setApiRow] = useState<TeamSummaryOut | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!API_ENABLED) return;
    let live = true;
    loadPersonSummary(person.id)
      .then((r) => live && setApiRow(r))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : "Could not load."));
    return () => {
      live = false;
    };
  }, [person.id]);
  const data = useMemo(() => {
    if (API_ENABLED) return apiRow;
    return localTeamSummary({
      state, people: [person], managerId: employee.id, sessions: att.sessions, records, tickets,
      pendingBy: new Map([[person.id, pending]]), today: todayISO(), withDays: true,
    })[0];
  }, [apiRow, state, person, employee.id, att.sessions, records, tickets, pending]);
  const s = data ?? row;
  return (
    <Dialog open wide title={person.fullName} onClose={onClose}>
      <div className="mgr-drill">
        {error && <p className="note err">{error}</p>}
        {s && (
          <div className="mgr-drill-stats">
            <div>
              <span className="muted">Today</span>
              <StatusBadge status={STATUS_TEXT[s.status] ?? s.status} tone={STATUS_TONE[s.status]} literal keepCase />
            </div>
            <div>
              <span className="muted">This week</span>
              <HoursVsTarget minutes={s.week_minutes} target={s.week_target_minutes} />
            </div>
            <div>
              <span className="muted">This month</span>
              <HoursVsTarget minutes={s.month_minutes} target={s.month_target_minutes} />
            </div>
            <div>
              <span className="muted">Late this month</span>
              <strong>{plural(s.late_days_month, "day")}</strong>
            </div>
            <div>
              <span className="muted">Overtime</span>
              <strong>{hoursText(s.overtime_minutes_month)}</strong>
              {s.approved_overtime_hours_month > 0 && <span className="muted">{s.approved_overtime_hours_month} h approved</span>}
            </div>
            <div>
              <span className="muted">Waiting on you</span>
              <strong>{pending}</strong>
            </div>
            <div>
              <span className="muted">Tasks · tickets</span>
              <strong>
                {s.open_tasks} · {s.open_tickets}
              </strong>
              {s.overdue_tasks + s.overdue_tickets > 0 && <span className="mgr-flag danger">{s.overdue_tasks + s.overdue_tickets} overdue</span>}
            </div>
          </div>
        )}
        {leaveLeft.length > 0 && (
          <p className="muted">Leave left: {leaveLeft.map((b) => `${b.name} ${b.available} d`).join(" · ")}</p>
        )}
        {API_ENABLED && !data && !error ? (
          <p className="muted">Loading…</p>
        ) : (
          <div className="table-scroll">
            <table className="data mgr-days">
              <thead>
                <tr>
                  <th>Day</th>
                  <th>Attendance</th>
                  <th>Worked</th>
                  <th>Late</th>
                  <th>Overtime</th>
                  <th>Timesheet</th>
                </tr>
              </thead>
              <tbody>
                {[...(data?.days ?? [])].reverse().map((d) => {
                  const mismatch = (d.worked_minutes > 0 || d.timesheet_hours > 0) && Math.abs(d.timesheet_hours - d.worked_minutes / 60) > 1;
                  return (
                    <tr key={d.date} className={d.kind ? "mgr-off" : undefined}>
                      <td>{parseISODate(d.date).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}</td>
                      <td>
                        {d.check_in ? (
                          `${clockText(d.check_in)}${d.check_out ? `–${clockText(d.check_out)}` : " · in"}${d.work_mode && d.work_mode !== "office" ? ` · ${d.work_mode}` : ""}`
                        ) : d.kind ? (
                          DAY_KIND_TEXT[d.kind] ?? d.kind
                        ) : d.date < todayISO() ? (
                          <span className="mgr-flag danger">No check-in</span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td>
                        <HoursVsTarget minutes={d.worked_minutes} target={d.target_minutes} />
                      </td>
                      <td>{d.late_minutes ? <span className="mgr-flag warn">{d.late_minutes} min</span> : "—"}</td>
                      <td>{d.overtime_minutes ? hoursText(d.overtime_minutes) : "—"}</td>
                      <td>
                        <span className="team-name">
                          <span>
                            {d.timesheet_hours} h{" "}
                            <StatusBadge status={TS_LABEL[d.timesheet_status] ?? d.timesheet_status} tone={TS_TONE[d.timesheet_status]} literal keepCase />
                          </span>
                          {mismatch && <span className="mgr-flag warn">Differs from attendance</span>}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="form-actions">
          <Link className="btn-ghost btn-tiny" to={`/people/${person.id}`}>Profile</Link>
          <Link className="btn-ghost btn-tiny" to="/timesheet?view=team">Timesheets</Link>
          {pending > 0 && (
            <Link className="btn btn-tiny" to={`/approvals?person=${encodeURIComponent(person.id)}`}>
              Review ({pending})
            </Link>
          )}
        </div>
      </div>
    </Dialog>
  );
}

function AssignTaskDialog({ person, onClose }: { person: PersonRecord; onClose: () => void }) {
  const { createTask } = usePortal();
  const [form, setForm] = useState({ subject: "", taskType: TASK_TYPES[0] as TaskType, priority: "medium" as TaskPriority, due: addDaysISO(todayISO(), 3) });
  const [msg, setMsg] = useState<{ tone: "err"; text: string } | null>(null);
  const act = useAction();
  return (
    <Dialog open title={`Assign task · ${person.fullName}`} onClose={onClose}>
      <form
        onSubmit={act.submit(
          () => {
            const error = createTask({ subject: form.subject, ownerId: person.id, taskType: form.taskType, priority: form.priority, due: form.due });
            if (error) setMsg({ tone: "err", text: error });
            return error;
          },
          { success: `Task assigned to ${person.fullName}.`, onSuccess: onClose },
        )}
      >
        <Banner message={msg} />
        <Field label="Task" wide>
          <input value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} maxLength={120} required />
        </Field>
        <div className="form-grid">
          <Field label="Type">
            <select value={form.taskType} onChange={(e) => setForm({ ...form, taskType: e.target.value as TaskType })}>
              {TASK_TYPES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </Field>
          <Field label="Priority">
            <select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value as TaskPriority })}>
              {(["low", "medium", "high", "urgent"] as const).map((p) => (
                <option key={p} value={p}>
                  {p[0].toUpperCase() + p.slice(1)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Due">
            <input type="date" value={form.due} min={todayISO()} onChange={(e) => setForm({ ...form, due: e.target.value })} required />
          </Field>
        </div>
        <div className="form-actions">
          <SubmitButton action={act} className="btn">Assign task</SubmitButton>
          <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Dialog>
  );
}

function KudosDialog({ person, actor, onClose }: { person: PersonRecord; actor: Parameters<typeof giveKudos>[0]; onClose: () => void }) {
  const [value, setValue] = useState<string>(RECOGNITION_VALUES[0]);
  const [message, setMessage] = useState("");
  const [msg, setMsg] = useState<{ tone: "err"; text: string } | null>(null);
  const act = useAction();
  return (
    <Dialog open title={`Kudos · ${person.fullName}`} onClose={onClose}>
      <form
        onSubmit={act.submit(
          async () => {
            const error = await giveKudos(actor, { toId: person.id, value, message, points: 0 });
            const text = typeof error === "string" ? error : null;
            if (text) setMsg({ tone: "err", text });
            return text;
          },
          { success: `Kudos sent to ${person.fullName}.`, onSuccess: onClose },
        )}
      >
        <Banner message={msg} />
        <Field label="Value" wide>
          <select value={value} onChange={(e) => setValue(e.target.value)}>
            {RECOGNITION_VALUES.map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </Field>
        <Field label="Message" wide>
          <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={3} maxLength={500} required />
        </Field>
        <div className="form-actions">
          <SubmitButton action={act} className="btn">Send kudos</SubmitButton>
          <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Dialog>
  );
}

function OneOnOneDialog({ person, me, onClose }: { person: PersonRecord; me: { id: string; fullName: string; role: (typeof DEMO_ACCOUNTS)[number]["role"] }; onClose: () => void }) {
  const [date, setDate] = useState(addDaysISO(todayISO(), 1));
  const [time, setTime] = useState("10:00");
  const [msg, setMsg] = useState<{ tone: "err"; text: string } | null>(null);
  const act = useAction();
  return (
    <Dialog open title={`1:1 · ${person.fullName}`} onClose={onClose}>
      <form
        onSubmit={act.submit(
          () => {
            const result = scheduleOneOnOne(me, { managerId: me.id, managerName: me.fullName, employeeId: person.id, employeeName: person.fullName, date, time });
            if ("error" in result) {
              setMsg({ tone: "err", text: result.error });
              return result.error;
            }
            return null;
          },
          { success: `1:1 with ${person.fullName} scheduled.`, onSuccess: onClose },
        )}
      >
        <Banner message={msg} />
        <div className="form-grid">
          <Field label="Date">
            <input type="date" value={date} min={todayISO()} onChange={(e) => setDate(e.target.value)} required />
          </Field>
          <Field label="Time">
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} required />
          </Field>
        </div>
        <div className="form-actions">
          <SubmitButton action={act} className="btn">Schedule 1:1</SubmitButton>
          <Link className="btn-ghost" to="/evaluations">All check-ins</Link>
        </div>
      </form>
    </Dialog>
  );
}
