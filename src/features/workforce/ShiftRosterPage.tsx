import { useMemo, useState, useSyncExternalStore, type FormEvent } from "react";
import { Banner, Card, DataTable, EmptyState, Field, MetricCard, MetricGrid, Page, StatusBadge, Tabs } from "../../components/ui.tsx";
import { usePortal } from "../../store.tsx";
import { addDaysISO, todayISO } from "../../model.ts";
import { taskTeamFor } from "../../data/taskTeam.ts";
import {
  assignShift,
  canApproveSwap,
  cancelSwap,
  compOffCandidates,
  compOffReason,
  creditsFor,
  decideSwap,
  getShiftState,
  grantCompOff,
  holidayOn,
  isCreditExpired,
  leaveOn,
  MAX_DAYS_PER_WEEK,
  MIN_REST_HOURS,
  publishedShiftsFor,
  publishWeek,
  requestSwap,
  respondSwap,
  rosterWeek,
  saveShift,
  setShiftActive,
  shiftById,
  shiftLabel,
  subscribeShifts,
  weekConflicts,
  weekDates,
  type RosterContext,
  type ShiftDef,
  type ShiftSwap,
  type SwapStatus,
} from "./shiftsStore.ts";
import { canDecideFor, fmt, isHrRole, isWeekend, personName, shortDay, weekStartOf, type WorkforceActor } from "./workforceShared.ts";
import "./workforce.css";

type Msg = { tone: "ok" | "err" | "warn" | "info"; text: string } | null;

function useShifts() {
  return useSyncExternalStore(subscribeShifts, getShiftState, getShiftState);
}

function useRosterContext(): RosterContext {
  const { state } = usePortal();
  return useMemo(() => ({ leaves: state.leaveRequests, holidays: state.holidays }), [state.leaveRequests, state.holidays]);
}

function result(error: string | null, ok: string): Msg {
  return error ? { tone: "err", text: error } : { tone: "ok", text: ok };
}

export function ShiftRosterPage() {
  const { demoProfile } = usePortal();
  const actor: WorkforceActor = demoProfile;
  const team = taskTeamFor(actor.id);
  const hr = isHrRole(actor.role);
  const tabs = [
    { id: "mine", label: "My shifts" },
    { id: "swaps", label: "Swaps" },
    { id: "compoff", label: "Comp-off" },
    ...(team.length ? [{ id: "roster", label: "Team roster" }] : []),
    ...(hr ? [{ id: "types", label: "Shift types" }] : []),
  ];
  const [tab, setTab] = useState("mine");
  const active = tabs.some((t) => t.id === tab) ? tab : "mine";

  return (
    <Page title="Shifts & roster">
      <Tabs tabs={tabs} value={active} onChange={setTab} />
      {active === "mine" && <MyShifts actor={actor} />}
      {active === "swaps" && <Swaps actor={actor} />}
      {active === "compoff" && <CompOff actor={actor} />}
      {active === "roster" && <TeamRoster actor={actor} />}
      {active === "types" && <ShiftTypes actor={actor} />}
    </Page>
  );
}

// ---------- My shifts ----------

function MyShifts({ actor }: { actor: WorkforceActor }) {
  const data = useShifts();
  const ctx = useRosterContext();
  const today = todayISO();
  const mine = publishedShiftsFor(actor.id, data);
  const upcoming = mine.filter((a) => a.date >= today);
  const recent = mine.filter((a) => a.date < today && a.date >= addDaysISO(today, -14)).reverse();
  const thisWeek = weekDates(weekStartOf(today));
  const credits = creditsFor(actor.id, data).filter((c) => !isCreditExpired(c, today));
  const next = upcoming[0];

  const row = (a: (typeof mine)[number]) => {
    const shift = shiftById(a.shiftId, data);
    const note = compOffReason(a.date, ctx.holidays);
    return [
      shortDay(a.date),
      shift?.name ?? "—",
      shift ? `${shift.start}–${shift.end}` : "—",
      note ? <StatusBadge status={note} tone="info" literal /> : "",
    ];
  };

  return (
    <>
      <MetricGrid>
        <MetricCard label="Next shift" value={next ? shiftById(next.shiftId, data)?.name ?? "—" : "None"} hint={next ? shortDay(next.date) : undefined} />
        <MetricCard label="Shifts this week" value={mine.filter((a) => thisWeek.includes(a.date)).length} />
        <MetricCard label="Comp-off credits" value={credits.length} hint="Available to use" />
      </MetricGrid>
      <Card title="Upcoming">
        <DataTable
          headers={["Date", "Shift", "Hours", ""]}
          rows={upcoming.map(row)}
          empty={<EmptyState title="No published shifts" />}
        />
      </Card>
      {recent.length > 0 && (
        <Card title="Last 14 days">
          <DataTable headers={["Date", "Shift", "Hours", ""]} rows={recent.map(row)} />
        </Card>
      )}
    </>
  );
}

// ---------- Swaps ----------

const SWAP_LABEL: Record<SwapStatus, [string, "ok" | "warn" | "danger" | "neutral"]> = {
  awaiting_teammate: ["Waiting for teammate", "warn"],
  awaiting_manager: ["Waiting for manager", "warn"],
  approved: ["Approved", "ok"],
  declined: ["Declined", "danger"],
  rejected: ["Rejected", "danger"],
  cancelled: ["Cancelled", "neutral"],
};

function SwapBadge({ status }: { status: SwapStatus }) {
  const [label, tone] = SWAP_LABEL[status];
  return <StatusBadge status={label} tone={tone} literal />;
}

function swapLine(swap: ShiftSwap, data: ReturnType<typeof getShiftState>) {
  return `${personName(swap.requesterId)} (${shiftById(swap.requesterShiftId, data)?.name ?? "—"}) ↔ ${personName(swap.teammateId)} (${shiftById(swap.teammateShiftId, data)?.name ?? "—"})`;
}

function Swaps({ actor }: { actor: WorkforceActor }) {
  const data = useShifts();
  const ctx = useRosterContext();
  const today = todayISO();
  const [msg, setMsg] = useState<Msg>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});

  const myUpcoming = publishedShiftsFor(actor.id, data).filter((a) => a.date > today);
  const [date, setDate] = useState("");
  const [teammateId, setTeammateId] = useState("");
  const [reason, setReason] = useState("");
  const mineOnDate = myUpcoming.find((a) => a.date === date);
  const teammates = mineOnDate
    ? data.assignments.filter(
        (a) =>
          a.date === date &&
          a.managerId === mineOnDate.managerId &&
          a.personId !== actor.id &&
          a.shiftId !== mineOnDate.shiftId &&
          rosterWeek(a.managerId, weekStartOf(a.date), data)?.status === "published",
      )
    : [];

  const forMe = data.swaps.filter((s) => s.teammateId === actor.id && s.status === "awaiting_teammate");
  const toApprove = data.swaps.filter((s) => s.status === "awaiting_manager" && canApproveSwap(actor, s));
  const mine = data.swaps.filter((s) => s.requesterId === actor.id || (s.teammateId === actor.id && s.status !== "awaiting_teammate"));

  function submit(e: FormEvent) {
    e.preventDefault();
    const error = requestSwap(actor, ctx, { teammateId, date, reason });
    setMsg(result(error, `Swap request sent to ${personName(teammateId)}.`));
    if (!error) {
      setDate("");
      setTeammateId("");
      setReason("");
    }
  }

  return (
    <>
      <Banner message={msg} />
      {forMe.length > 0 && (
        <Card title="Waiting for you">
          <ul className="approval-list">
            {forMe.map((s) => (
              <li key={s.id} className="approval-item">
                <strong>{shortDay(s.date)}</strong>
                <span>{swapLine(s, data)}</span>
                <p className="muted">{s.reason}</p>
                <div className="approval-actions">
                  <button className="btn btn-tiny" type="button" onClick={() => setMsg(result(respondSwap(actor, s.id, true), "Accepted — sent to your manager."))}>
                    Accept
                  </button>
                  <button className="btn-ghost btn-tiny" type="button" onClick={() => setMsg(result(respondSwap(actor, s.id, false), "Swap declined."))}>
                    Decline
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {toApprove.length > 0 && (
        <Card title="For your approval">
          <ul className="approval-list">
            {toApprove.map((s) => (
              <li key={s.id} className="approval-item">
                <strong>{shortDay(s.date)}</strong>
                <span>{swapLine(s, data)}</span>
                <p className="muted">{s.reason}</p>
                <div className="approval-actions">
                  <input
                    placeholder="Note (needed to reject)"
                    value={notes[s.id] ?? ""}
                    onChange={(e) => setNotes({ ...notes, [s.id]: e.target.value })}
                  />
                  <button className="btn btn-tiny" type="button" onClick={() => setMsg(result(decideSwap(actor, ctx, s.id, true, notes[s.id]), "Swap approved — roster updated."))}>
                    Approve
                  </button>
                  <button className="btn-ghost btn-tiny" type="button" onClick={() => setMsg(result(decideSwap(actor, ctx, s.id, false, notes[s.id]), "Swap rejected."))}>
                    Reject
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Card title="Request a swap">
        {myUpcoming.length === 0 ? (
          <EmptyState title="No upcoming shifts to swap" />
        ) : (
          <form className="stack" onSubmit={submit}>
            <div className="form-grid-2">
              <Field label="Date">
                <select value={date} onChange={(e) => { setDate(e.target.value); setTeammateId(""); }}>
                  <option value="">Pick one of your shifts</option>
                  {myUpcoming.map((a) => (
                    <option key={a.id} value={a.date}>
                      {shortDay(a.date)} · {shiftById(a.shiftId, data)?.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Swap with">
                <select value={teammateId} onChange={(e) => setTeammateId(e.target.value)} disabled={!date}>
                  <option value="">{date && !teammates.length ? "No teammate on a different shift" : "Pick a teammate"}</option>
                  {teammates.map((a) => (
                    <option key={a.id} value={a.personId}>
                      {personName(a.personId)} · {shiftById(a.shiftId, data)?.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Reason" wide>
                <input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
              </Field>
            </div>
            <div className="row-gap">
              <button className="btn" type="submit">Send request</button>
            </div>
          </form>
        )}
      </Card>
      <Card title="My swaps">
        <DataTable
          headers={["Date", "Swap", "Status", ""]}
          rows={mine.map((s) => [
            shortDay(s.date),
            <span key="l">
              {swapLine(s, data)}
              {s.decisionNote && <span className="muted wf-block">{s.decisionNote}</span>}
            </span>,
            <SwapBadge key="b" status={s.status} />,
            s.requesterId === actor.id && (s.status === "awaiting_teammate" || s.status === "awaiting_manager") ? (
              <button key="c" className="btn-ghost btn-tiny" type="button" onClick={() => setMsg(result(cancelSwap(actor, s.id), "Swap request cancelled."))}>
                Cancel
              </button>
            ) : (
              ""
            ),
          ])}
          empty={<EmptyState title="No swaps yet" />}
        />
      </Card>
    </>
  );
}

// ---------- Comp-off ----------

function CompOff({ actor }: { actor: WorkforceActor }) {
  const data = useShifts();
  const ctx = useRosterContext();
  const today = todayISO();
  const [msg, setMsg] = useState<Msg>(null);
  const mine = creditsFor(actor.id, data);
  const available = mine.filter((c) => !isCreditExpired(c, today));
  const candidates = compOffCandidates(actor, ctx, data);
  const teamCredits = data.credits.filter((c) => canDecideFor(actor, c.personId));

  return (
    <>
      <Banner message={msg} />
      <MetricGrid>
        <MetricCard label="Available" value={available.length} hint="Comp-off days" />
        <MetricCard
          label="Next expiry"
          value={available.length ? fmt([...available].sort((a, b) => a.expiresOn.localeCompare(b.expiresOn))[0].expiresOn) : "—"}
        />
      </MetricGrid>
      {candidates.length > 0 && (
        <Card title="Worked on a weekly off or holiday">
          <DataTable
            headers={["Person", "Date", "Shift", "Why", ""]}
            rows={candidates.map(({ assignment: a, reason }) => [
              personName(a.personId),
              shortDay(a.date),
              shiftById(a.shiftId, data)?.name ?? "—",
              reason,
              <button
                key="g"
                className="btn btn-tiny"
                type="button"
                onClick={() => setMsg(result(grantCompOff(actor, ctx, a.personId, a.date), `1 comp-off day credited to ${personName(a.personId)}.`))}
              >
                Grant 1 day
              </button>,
            ])}
          />
        </Card>
      )}
      <Card title="My comp-off credits">
        <DataTable
          headers={["Worked on", "Why", "Granted by", "Use by", "Status"]}
          rows={mine.map((c) => [
            fmt(c.workedDate),
            c.reason,
            c.grantedByName,
            fmt(c.expiresOn),
            isCreditExpired(c, today) ? <StatusBadge key="s" status="Expired" tone="danger" literal /> : <StatusBadge key="s" status="Available" tone="ok" literal />,
          ])}
          empty={<EmptyState title="No comp-off credits" description="Earned by working an off day." />}
        />
      </Card>
      {teamCredits.length > 0 && (
        <Card title="Team credits">
          <DataTable
            headers={["Person", "Worked on", "Granted by", "Use by", "Status"]}
            rows={teamCredits.map((c) => [
              personName(c.personId),
              fmt(c.workedDate),
              c.grantedByName,
              fmt(c.expiresOn),
              isCreditExpired(c, today) ? <StatusBadge key="s" status="Expired" tone="danger" literal /> : <StatusBadge key="s" status="Available" tone="ok" literal />,
            ])}
          />
        </Card>
      )}
    </>
  );
}

// ---------- Team roster ----------

function TeamRoster({ actor }: { actor: WorkforceActor }) {
  const data = useShifts();
  const ctx = useRosterContext();
  const today = todayISO();
  const team = taskTeamFor(actor.id);
  const [weekStart, setWeekStart] = useState(() => weekStartOf(addDaysISO(today, 7)));
  const [msg, setMsg] = useState<Msg>(null);
  const dates = weekDates(weekStart);
  const week = rosterWeek(actor.id, weekStart, data);
  const published = week?.status === "published";
  const activeShifts = data.shifts.filter((s) => s.active);
  const conflicts = useMemo(() => weekConflicts(data, ctx, actor.id, weekStart), [data, ctx, actor.id, weekStart]);
  const weekOver = dates[6] < today;

  function change(personId: string, date: string, shiftId: string) {
    const error = assignShift(actor, ctx, personId, date, shiftId || null);
    setMsg(error ? { tone: "err", text: error } : null);
  }

  const rows = team.map((person) => [
    <strong key="n">{person.shortName}</strong>,
    ...dates.map((date) => {
      const current = data.assignments.find((a) => a.personId === person.id && a.date === date);
      const leave = leaveOn(person.id, date, ctx.leaves);
      const otherOwner = current && current.managerId !== actor.id;
      const locked = date <= today || !!otherOwner;
      const shift = current ? shiftById(current.shiftId, data) : undefined;
      return (
        <div key={date} className="wf-cell">
          {locked ? (
            <span className={shift ? "wf-locked" : "muted"}>{shift?.name ?? "—"}</span>
          ) : (
            <select
              aria-label={`${person.fullName} on ${shortDay(date)}`}
              value={current?.shiftId ?? ""}
              onChange={(e) => change(person.id, date, e.target.value)}
            >
              <option value="">—</option>
              {activeShifts.filter((s) => !s.weekendOnly || isWeekend(date)).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
              {shift && !shift.active && <option value={shift.id}>{shift.name}</option>}
            </select>
          )}
          {leave && <span className="wf-tag warn">On leave</span>}
        </div>
      );
    }),
  ]);

  const headers = [
    "Person",
    ...dates.map((d) => {
      const holiday = holidayOn(d, ctx.holidays);
      return `${shortDay(d)}${holiday ? " · Holiday" : ""}`;
    }),
  ];

  return (
    <>
      <Card
        title={`Week of ${fmt(weekStart)}`}
        action={
          <div className="row-gap">
            <button className="btn-ghost btn-tiny" type="button" onClick={() => { setWeekStart(addDaysISO(weekStart, -7)); setMsg(null); }}>
              Previous
            </button>
            <button className="btn-ghost btn-tiny" type="button" onClick={() => { setWeekStart(addDaysISO(weekStart, 7)); setMsg(null); }}>
              Next
            </button>
          </div>
        }
      >
        <div className="stack">
          <div className="row-between wf-wrap">
            <div className="row-gap">
              <StatusBadge status={published ? "Published" : "Draft"} tone={published ? "ok" : "warn"} literal />
              {published && week?.publishedOn && <span className="muted">Published {fmt(week.publishedOn)} by {week.publishedByName}</span>}
            </div>
            {!published && !weekOver && (
              <button className="btn" type="button" onClick={() => setMsg(result(publishWeek(actor, ctx, weekStart), "Roster published — your team can see their shifts."))}>
                Publish roster
              </button>
            )}
          </div>
          <Banner message={msg} />
          {conflicts.length > 0 && (
            <div className="note wf-warn">
              {conflicts.map((c) => (
                <div key={c}>{c}</div>
              ))}
            </div>
          )}
          <div className="wf-grid">
            <DataTable headers={headers} rows={rows} empty={<EmptyState title="No one reports to you" />} />
          </div>
          <p className="muted">
            One shift a day · {MIN_REST_HOURS} h rest between shifts · up to {MAX_DAYS_PER_WEEK} days a week · no shifts on approved leave. Past days are locked.
          </p>
        </div>
      </Card>
      <Card title="Shift hours">
        <div className="row-gap">
          {activeShifts.map((s) => (
            <span key={s.id} className="pill">
              {shiftLabel(s)}
              {s.weekendOnly ? " · weekends" : ""}
            </span>
          ))}
        </div>
      </Card>
    </>
  );
}

// ---------- Shift types (HR) ----------

const BLANK = { name: "", start: "09:00", end: "17:00", weekendOnly: false };

function ShiftTypes({ actor }: { actor: WorkforceActor }) {
  const data = useShifts();
  const [msg, setMsg] = useState<Msg>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState(BLANK);

  function edit(s: ShiftDef) {
    setEditing(s.id);
    setForm({ name: s.name, start: s.start, end: s.end, weekendOnly: s.weekendOnly });
    setMsg(null);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const error = saveShift(actor, { ...form, id: editing ?? undefined });
    setMsg(result(error, editing ? "Shift updated." : "Shift added."));
    if (!error) {
      setEditing(null);
      setForm(BLANK);
    }
  }

  return (
    <>
      <Banner message={msg} />
      <Card title="Shift types">
        <DataTable
          headers={["Shift", "Hours", "Days", "Status", ""]}
          rows={data.shifts.map((s) => [
            s.name,
            `${s.start}–${s.end}`,
            s.weekendOnly ? "Sat–Sun" : "Any day",
            <StatusBadge key="s" status={s.active ? "Active" : "Inactive"} tone={s.active ? "ok" : "neutral"} literal />,
            <div key="a" className="row-gap">
              <button className="btn-ghost btn-tiny" type="button" onClick={() => edit(s)}>
                Edit
              </button>
              <button
                className="btn-ghost btn-tiny"
                type="button"
                onClick={() => setMsg(result(setShiftActive(actor, s.id, !s.active), s.active ? `${s.name} turned off.` : `${s.name} turned on.`))}
              >
                {s.active ? "Turn off" : "Turn on"}
              </button>
            </div>,
          ])}
        />
      </Card>
      <Card title={editing ? "Edit shift" : "Add a shift"}>
        <form className="stack" onSubmit={submit}>
          <div className="form-grid-2">
            <Field label="Name" wide>
              <input value={form.name} maxLength={40} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label="Starts">
              <input type="time" value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} />
            </Field>
            <Field label="Ends">
              <input type="time" value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} />
            </Field>
          </div>
          <label className="row-gap">
            <input type="checkbox" checked={form.weekendOnly} onChange={(e) => setForm({ ...form, weekendOnly: e.target.checked })} />
            <span>Weekends only</span>
          </label>
          <div className="row-gap">
            <button className="btn" type="submit">{editing ? "Save shift" : "Add shift"}</button>
            {editing && (
              <button className="btn-ghost" type="button" onClick={() => { setEditing(null); setForm(BLANK); }}>
                Cancel
              </button>
            )}
          </div>
        </form>
      </Card>
    </>
  );
}
