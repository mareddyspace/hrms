import { useMemo, useState, useSyncExternalStore } from "react";
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
import { useTeamToday } from "../api/syncTeam.ts";
import { getAttendanceState, subscribeAttendance } from "../data/attendanceLocal.ts";
import { listPeople, subscribePeople } from "../data/peopleLocal.ts";
import type { PersonRecord } from "../data/peopleData.ts";
import { personToday, TIMESHEET_TARGET } from "../data/teamOverview.ts";
import { useDayRecords } from "../data/timesheetDays.ts";
import { taskPersonById } from "../data/taskTeam.ts";
import { scheduleOneOnOne } from "../data/talentLocal.ts";
import { dayStatus, directReportsOf, teamBelow } from "../data/workforceStats.ts";
import { useApprovalInbox } from "./ApprovalsCenter.tsx";
import { giveKudos, recognitionPeople, RECOGNITION_VALUES } from "../features/recognition/recognitionStore.ts";
import { DEMO_ACCOUNTS } from "../demoAccounts.ts";
import { addDaysISO, formatShortDate, leaveNameFor, TASK_TYPES, todayISO, type TaskPriority, type TaskType } from "../model.ts";
import { usePortal } from "../store.tsx";
import { API_ENABLED } from "../api/client.ts";
import "./team.css";

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
  const openTasksBy = new Map<string, number>();
  for (const t of state.tasks) {
    if ((t.status === "open" || t.status === "progress") && teamIds.has(t.employeeId)) openTasksBy.set(t.employeeId, (openTasksBy.get(t.employeeId) ?? 0) + 1);
  }
  const leaveName = (code: string, id: string) => leaveNameFor(state.leavePolicies, code, id) ?? code;

  const rows = (view === "direct" ? direct : everyone).slice(0, 200).map((person) => {
    const day = dayStatus(state, person.id, String(person.countryCode), today);
    const now = personToday(state, person.id, today, apiToday.rows.get(person.id));
    const apiRow = apiToday.rows.get(person.id);
    const status = apiRow?.leave_code ? (apiRow.leave_code.includes("wfh") ? "WFH" : "On leave") : apiRow?.holiday ? "Holiday" : day;
    const out = status === "On leave" || status === "Holiday" || status === "Weekly off";
    const notIn = !out && !now.checkIn;
    return { person, status, now, out, notIn };
  });
  const scope = view === "direct" ? direct : everyone;
  const outToday = rows.filter((r) => r.status === "On leave" || r.status === "Holiday");
  const notIn = rows.filter((r) => r.notIn);
  const inToday = rows.filter((r) => r.now.checkIn).length;
  const scopeIds = new Set(scope.map((p) => p.id));
  const waitingCount = waiting.filter((w) => scopeIds.has(w.employeeId)).length;
  const openTasks = [...openTasksBy].filter(([id]) => scopeIds.has(id)).reduce((n, [, c]) => n + c, 0);

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
        <MetricCard label="Open tasks" value={openTasks} />
      </MetricGrid>
      </div>

      {(outToday.length > 0 || notIn.length > 0) && (
        <Card title="Who's out today">
          <ul className="team-out-list">
            {outToday.map((r) => (
              <li key={r.person.id}>
                <Link to={`/people/${r.person.id}`}>{r.person.fullName}</Link> <StatusBadge status={r.status} tone="info" literal />
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

      <Card title="Team today">
        <Tabs
          tabs={[
            { id: "direct", label: `Direct (${direct.length})` },
            { id: "all", label: `Everyone (${everyone.length})` },
          ]}
          value={view}
          onChange={setView}
        />
        {API_ENABLED && !apiToday.loaded && <p className="muted">Loading today…</p>}
        <DataTable
          headers={["Name", "Today", "Hours", "Timesheet", "Leave left", "Tasks", ""]}
          rows={rows.map(({ person, status, now, notIn: missing }) => {
            // The main paid leave (privilege leave / PTO / annual leave), not whichever balance is largest (e.g. sabbatical).
            const main =
              now.leaveLeft.find((b) => b.code === "pto" || b.code === "annual") ??
              [...now.leaveLeft].filter((b) => b.code !== "sabbatical").sort((a, b) => b.available - a.available)[0];
            const waitingN = waitingBy.get(person.id) ?? 0;
            return [
              <span key="n" className="team-name">
                <Link to={`/people/${person.id}`}>{person.fullName}</Link>
                <span className="muted">{person.designation}</span>
              </span>,
              now.checkIn ? (
                <StatusBadge key="s" status={`In ${now.checkIn}${now.checkOut ? `–${now.checkOut}` : ""}`} tone="ok" literal keepCase />
              ) : missing ? (
                <StatusBadge key="s" status="Not checked in" tone="warn" literal keepCase />
              ) : (
                <StatusBadge key="s" status={status} tone="info" literal keepCase />
              ),
              now.hoursWorked ? `${now.hoursWorked} h` : "—",
              <span key="t" className="team-name">
                <span>{`${now.timesheetHours} of ${TIMESHEET_TARGET} h`}</span>
                <StatusBadge status={TS_LABEL[now.timesheetStatus] ?? now.timesheetStatus} tone={TS_TONE[now.timesheetStatus]} literal keepCase />
              </span>,
              main ? (
                <span key="l" title={now.leaveLeft.map((b) => `${b.name}: ${b.available}`).join("\n")}>
                  {main.available} d <span className="muted">{main.name}</span>
                </span>
              ) : (
                "—"
              ),
              openTasksBy.get(person.id) ?? 0,
              <span key="a" className="team-actions">
                {canTask(person.id) && (
                  <button type="button" className="btn-ghost btn-tiny" onClick={() => setQuick({ kind: "task", person })}>
                    Assign task
                  </button>
                )}
                {waitingN > 0 && (
                  <Link className="btn-ghost btn-tiny" to={`/workflows?person=${encodeURIComponent(person.id)}`}>
                    Approve ({waitingN})
                  </Link>
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
