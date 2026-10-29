import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ActionButton, Banner, Card, DataTable, EmptyState, Field, MetricCard, MetricGrid, Page, StatusBadge, SubmitButton, Tabs, notify, useAction } from "../../components/ui.tsx";
import { usePortal } from "../../store.tsx";
import { addDaysISO, holidaysForPerson, todayISO } from "../../model.ts";
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
  canSetCoverage,
  checkCoverageAlerts,
  CAN_RESET_COVERAGE,
  ensureRosterWeek,
  COMPANY_SCOPE,
  coverageGaps,
  coverageMinimum,
  describeGaps,
  hasOwnCoverageRule,
  MAX_COVERAGE,
  resetCoverage,
  setCoverageMinimum,
  swapCoverageImpact,
  weekCoverage,
  WEEKDAY_NAMES,
  type CoverageSlot,
  type RosterContext,
  type ShiftDef,
  type ShiftSwap,
  type SwapStatus,
} from "./shiftsStore.ts";
import { API_ENABLED } from "../../api/syncOps.ts";
import { canDecideFor, fmt, isHrRole, rosterTeamFor, isWeekend, personName, shortDay, swapPartnerError, weekStartOf, type WorkforceActor } from "./workforceShared.ts";
import { apiSwapPartners } from "../../api/syncOpsShifts.ts";
import "./workforce.css";
import "./coverage.css";

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
  const team = rosterTeamFor(actor.id);
  const hr = isHrRole(actor.role);
  const ctx = useRosterContext();
  const tabs = [
    { id: "mine", label: "My shifts" },
    { id: "swaps", label: "Swaps" },
    { id: "compoff", label: "Comp-off" },
    ...(team.length ? [{ id: "roster", label: "Team roster" }] : []),
    ...(team.length || hr ? [{ id: "coverage", label: "Coverage" }] : []),
    ...(hr ? [{ id: "types", label: "Shift types" }] : []),
  ];
  const [tab, setTab] = useState("mine");
  const active = tabs.some((t) => t.id === tab) ? tab : "mine";

  // Leave approved since the roster was published can leave a shift short — tell the roster owner once.
  useEffect(() => {
    checkCoverageAlerts(ctx);
  }, [ctx]);

  return (
    <Page title="Shifts & roster">
      <Tabs tabs={tabs} value={active} onChange={setTab} />
      {active === "mine" && <MyShifts actor={actor} />}
      {active === "swaps" && <Swaps actor={actor} />}
      {active === "compoff" && <CompOff actor={actor} />}
      {active === "roster" && <TeamRoster actor={actor} />}
      {active === "coverage" && <CoverageSettings actor={actor} />}
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
  // Backend mode: teammates' shifts aren't visible to an employee, so the API lists who can be asked
  // (same roster, another shift, started, with a sign-in account to respond).
  const [partners, setPartners] = useState<{ date: string; ids: string[] }>({ date: "", ids: [] });
  useEffect(() => {
    if (!API_ENABLED || !date || !mineOnDate) return;
    let live = true;
    apiSwapPartners(date)
      .then((rows) => live && setPartners({ date, ids: rows.map((r) => r.id) }))
      .catch(() => live && setPartners({ date, ids: [] }));
    return () => {
      live = false;
    };
  }, [date, mineOnDate]);
  const teammates = API_ENABLED
    ? (partners.date === date && mineOnDate ? partners.ids : []).map((id) => ({ id: `${id}-${date}`, personId: id, shiftId: "" }))
    : mineOnDate
    ? data.assignments.filter(
        (a) =>
          a.date === date &&
          a.managerId === mineOnDate.managerId &&
          a.personId !== actor.id &&
          a.shiftId !== mineOnDate.shiftId &&
          rosterWeek(a.managerId, weekStartOf(a.date), data)?.status === "published" &&
          !swapPartnerError(a.personId, date),
      )
    : [];

  const forMe = data.swaps.filter((s) => s.teammateId === actor.id && s.status === "awaiting_teammate");
  const toApprove = data.swaps.filter((s) => s.status === "awaiting_manager" && canApproveSwap(actor, s));
  const mine = data.swaps.filter((s) => s.requesterId === actor.id || (s.teammateId === actor.id && s.status !== "awaiting_teammate"));

  const swapAction = useAction();

  async function submit() {
    const error = await requestSwap(actor, ctx, { teammateId, date, reason });
    setMsg(result(error, `Swap request sent to ${personName(teammateId)}.`));
    if (error) return false;
    notify(`Swap request sent to ${personName(teammateId)}.`);
    setDate("");
    setTeammateId("");
    setReason("");
    return true;
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
                  <ActionButton
                    className="btn btn-tiny"
                    busyLabel="Accepting…"
                    doneLabel="Accepted"
                    success="Swap accepted and sent to your manager."
                    onAction={async () => {
                      const error = await respondSwap(actor, s.id, true);
                      setMsg(result(error, "Accepted — sent to your manager."));
                      return error;
                    }}
                  >
                    Accept
                  </ActionButton>
                  <ActionButton
                    className="btn-ghost btn-tiny"
                    success="Swap declined."
                    onAction={async () => {
                      const error = await respondSwap(actor, s.id, false);
                      setMsg(result(error, "Swap declined."));
                      return error;
                    }}
                  >
                    Decline
                  </ActionButton>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {toApprove.length > 0 && (
        <Card title="For your approval">
          <ul className="approval-list">
            {toApprove.map((s) => {
              const impact = swapCoverageImpact(ctx, s.id, data);
              return (
              <li key={s.id} className="approval-item">
                <strong>{shortDay(s.date)}</strong>
                <span>{swapLine(s, data)}</span>
                <p className="muted">{s.reason}</p>
                {impact.length > 0 && <p className="note wf-danger">Leaves {describeGaps(impact, data)} under-covered.</p>}
                <div className="approval-actions">
                  <input aria-label="Decision note"
                    placeholder="Note (needed to reject)"
                    value={notes[s.id] ?? ""}
                    onChange={(e) => setNotes({ ...notes, [s.id]: e.target.value })}
                  />
                  <ActionButton
                    className="btn btn-tiny"
                    success="Swap approved. Roster updated."
                    onAction={async () => {
                      const error = await decideSwap(actor, ctx, s.id, true, notes[s.id], impact.length > 0);
                      setMsg(result(error, "Swap approved — roster updated."));
                      return error;
                    }}
                  >
                    {impact.length ? "Approve anyway" : "Approve"}
                  </ActionButton>
                  <ActionButton
                    className="btn-ghost btn-tiny"
                    success="Swap rejected."
                    onAction={async () => {
                      const error = await decideSwap(actor, ctx, s.id, false, notes[s.id]);
                      setMsg(result(error, "Swap rejected."));
                      return error;
                    }}
                  >
                    Reject
                  </ActionButton>
                </div>
              </li>
              );
            })}
          </ul>
        </Card>
      )}
      <Card title="Request a swap">
        {myUpcoming.length === 0 ? (
          <EmptyState title="No upcoming shifts to swap" />
        ) : (
          <form className="stack" onSubmit={swapAction.submit(submit)}>
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
                      {personName(a.personId)}
                      {a.shiftId ? ` · ${shiftById(a.shiftId, data)?.name ?? ""}` : ""}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Reason" wide>
                <input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
              </Field>
            </div>
            <div className="row-gap">
              <SubmitButton action={swapAction} className="btn">Submit request</SubmitButton>
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
              <ActionButton
                key="c"
                className="btn-ghost btn-tiny"
                success="Swap request cancelled."
                onAction={async () => {
                  const error = await cancelSwap(actor, s.id);
                  setMsg(result(error, "Swap request cancelled."));
                  return error;
                }}
              >
                Cancel
              </ActionButton>
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
              <ActionButton
                key="g"
                className="btn btn-tiny"
                busyLabel="Granting…"
                doneLabel="Granted"
                success={`1 comp-off day credited to ${personName(a.personId)}.`}
                onAction={() => {
                  const error = grantCompOff(actor, ctx, a.personId, a.date);
                  setMsg(result(error, `1 comp-off day credited to ${personName(a.personId)}.`));
                  return error;
                }}
              >
                Grant 1 day
              </ActionButton>,
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
  const [weekStart, setWeekStart] = useState(() => weekStartOf(addDaysISO(today, 7)));
  const [msg, setMsg] = useState<Msg>(null);
  const dates = weekDates(weekStart);
  // A pre-boarding joiner shows from the week they start (days before their start are refused).
  const team = rosterTeamFor(actor.id, dates[6]);
  const week = rosterWeek(actor.id, weekStart, data);
  const published = week?.status === "published";
  const activeShifts = data.shifts.filter((s) => s.active);
  const conflicts = useMemo(() => weekConflicts(data, ctx, actor.id, weekStart), [data, ctx, actor.id, weekStart]);
  const coverage = useMemo(() => weekCoverage(data, ctx, actor.id, weekStart), [data, ctx, actor.id, weekStart]);
  const gaps = useMemo(() => coverageGaps(data, ctx, actor.id, weekStart), [data, ctx, actor.id, weekStart]);
  const [confirmGaps, setConfirmGaps] = useState(false);
  const weekOver = dates[6] < today;
  const publishAction = useAction();
  const busy = publishAction.busy;

  useEffect(() => {
    ensureRosterWeek(actor.id, weekStart);
  }, [actor.id, weekStart]);

  async function change(personId: string, date: string, shiftId: string) {
    const error = await assignShift(actor, ctx, personId, date, shiftId || null);
    setMsg(error ? { tone: "err", text: error } : null);
    setConfirmGaps(false);
    if (!error) {
      const shiftName = shiftId ? shiftById(shiftId, data)?.name : undefined;
      notify(shiftName ? `${personName(personId)} assigned to ${shiftName} on ${shortDay(date)}.` : `Shift cleared for ${personName(personId)} on ${shortDay(date)}.`);
    }
  }

  async function publish(allowGaps: boolean) {
    if (gaps.length && !allowGaps) {
      setConfirmGaps(true);
      setMsg({ tone: "warn", text: `Under-covered: ${describeGaps(gaps, data)}. Fill these shifts or publish anyway.` });
      return false;
    }
    setConfirmGaps(false);
    const error = await publishWeek(actor, ctx, weekStart, allowGaps);
    if (error && /under-covered/i.test(error)) setConfirmGaps(true);
    setMsg(result(error, "Roster published — your team can see their shifts."));
    return error ? false : true;
  }

  const coverageShifts = data.shifts.filter((s) => coverage.some((c) => c.shiftId === s.id));
  const coverageRows = coverageShifts.map((shift) => [
    <strong key="n">{shift.name}</strong>,
    ...dates.map((date) => {
      const slot = coverage.find((c) => c.shiftId === shift.id && c.date === date);
      return slot ? <CoverageCell key={date} slot={slot} /> : <span key={date} className="muted">—</span>;
    }),
  ]);

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
      const holiday = holidayOn(d, holidaysForPerson(ctx.holidays, actor.id));
      return `${shortDay(d)}${holiday ? " · Holiday" : ""}`;
    }),
  ];

  return (
    <>
      <Card
        title={`Week of ${fmt(weekStart)}`}
        action={
          <div className="row-gap">
            <button className="btn-ghost btn-tiny" type="button" onClick={() => { setWeekStart(addDaysISO(weekStart, -7)); setMsg(null); setConfirmGaps(false); }}>
              Previous
            </button>
            <button className="btn-ghost btn-tiny" type="button" onClick={() => { setWeekStart(addDaysISO(weekStart, 7)); setMsg(null); setConfirmGaps(false); }}>
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
              <div className="row-gap">
                <ActionButton
                  className="btn"
                  disabled={busy}
                  action={publishAction}
                  success="Roster published. Your team can see their shifts."
                  onAction={() => publish(false)}
                >
                  Publish roster
                </ActionButton>
                {confirmGaps && gaps.length > 0 && (
                  <ActionButton
                    className="btn-ghost"
                    disabled={busy}
                    success="Roster published with gaps. Your team can see their shifts."
                    onAction={() => publish(true)}
                  >
                    Publish anyway
                  </ActionButton>
                )}
              </div>
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
      <Card title="Coverage">
        <div className="stack">
          {gaps.length > 0 ? (
            <p className="note wf-danger">
              {gaps.length} under-covered {gaps.length === 1 ? "shift" : "shifts"}: {describeGaps(gaps, data)}.
            </p>
          ) : (
            coverage.some((c) => c.required > 0) && <p className="muted">Every shift meets its minimum this week.</p>
          )}
          <div className="wf-grid">
            <DataTable headers={headers.map((h, i) => (i === 0 ? "Shift" : h))} rows={coverageRows} empty={<EmptyState title="No shifts this week" />} />
          </div>
          <div className="wf-cov-legend muted">
            <span><span className="wf-cov under">0/1</span> Under minimum</span>
            <span><span className="wf-cov ok">1/1</span> Covered</span>
            <span><span className="wf-cov over">2/1</span> Over minimum</span>
            <span>People on approved leave don't count.</span>
          </div>
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

// ---------- Coverage ----------

function CoverageCell({ slot }: { slot: CoverageSlot }) {
  const title =
    slot.status === "under"
      ? `Needs ${slot.required - slot.assigned} more`
      : slot.status === "over"
        ? `${slot.assigned - slot.required} over minimum`
        : slot.status === "none"
          ? "Not needed"
          : "Covered";
  const leaveNote = slot.onLeave.length ? ` · ${slot.onLeave.map(personName).join(", ")} on leave` : "";
  return (
    <div className="wf-cell">
      <span className={`wf-cov ${slot.status}`} title={title + leaveNote}>
        {slot.assigned}/{slot.required}
      </span>
      {slot.onLeave.length > 0 && <span className="wf-tag warn">{slot.onLeave.length} on leave</span>}
    </div>
  );
}

const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

function CoverageSettings({ actor }: { actor: WorkforceActor }) {
  const data = useShifts();
  const hr = isHrRole(actor.role);
  const hasTeam = rosterTeamFor(actor.id).length > 0;
  const scopes = [
    ...(hr ? [{ id: COMPANY_SCOPE, label: "Company default" }] : []),
    ...(hasTeam ? [{ id: actor.id, label: "My team" }] : []),
  ];
  const [scope, setScope] = useState(scopes[0]?.id ?? actor.id);
  const [msg, setMsg] = useState<Msg>(null);
  const editable = canSetCoverage(actor, scope);
  const shifts = data.shifts.filter((s) => s.active);
  const ownCount = data.coverage.filter((r) => r.scope === scope).length;

  async function change(shiftId: string, weekday: number, value: string) {
    if (value === "") return;
    const error = await setCoverageMinimum(actor, scope, shiftId, weekday, Number(value));
    setMsg(error ? { tone: "err", text: error } : null);
  }

  const rows = shifts.map((shift) => [
    <span key="n">
      <strong>{shift.name}</strong>
      <span className="muted wf-block">{shift.start}–{shift.end}</span>
    </span>,
    ...WEEK_ORDER.map((weekday) => {
      const weekend = weekday === 0 || weekday === 6;
      if (shift.weekendOnly && !weekend) return <span key={weekday} className="muted">—</span>;
      const value = coverageMinimum(scope, shift.id, weekday, data);
      const own = hasOwnCoverageRule(scope, shift.id, weekday, data);
      return editable ? (
        <input
          key={weekday}
          className={`wf-cov-input${own ? " own" : ""}`}
          type="number"
          min={0}
          max={MAX_COVERAGE}
          aria-label={`${shift.name} minimum on ${WEEKDAY_NAMES[weekday]}`}
          value={value}
          onChange={(e) => change(shift.id, weekday, e.target.value)}
        />
      ) : (
        <span key={weekday}>{value}</span>
      );
    }),
  ]);

  return (
    <>
      <Banner message={msg} />
      <Card
        title="Minimum staffing"
        action={
          scopes.length > 1 ? (
            <select aria-label="Whose minimums" value={scope} onChange={(e) => { setScope(e.target.value); setMsg(null); }}>
              {scopes.map((s) => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </select>
          ) : undefined
        }
      >
        <div className="stack">
          <p className="muted">
            {scope === COMPANY_SCOPE
              ? "People needed on each shift, per day. Applies to every team unless a manager sets their own."
              : "People needed on each shift in your team, per day. Highlighted values are your own; the rest follow the company default."}{" "}
            Holidays need no one.
          </p>
          <div className="wf-grid">
            <DataTable headers={["Shift", ...WEEK_ORDER.map((d) => WEEKDAY_NAMES[d])]} rows={rows} empty={<EmptyState title="No active shifts" />} />
          </div>
          {editable && ownCount > 0 && CAN_RESET_COVERAGE && (
            <div className="row-gap">
              <ActionButton
                className="btn-ghost btn-tiny"
                busyLabel="Resetting…"
                doneLabel="Done"
                success={scope === COMPANY_SCOPE ? "Company minimums reset to the defaults." : "Your team now follows the company minimums."}
                onAction={() => {
                  const error = resetCoverage(actor, scope);
                  setMsg(result(error, scope === COMPANY_SCOPE ? "Company minimums reset to the defaults." : "Your team now follows the company minimums."));
                  return error;
                }}
              >
                {scope === COMPANY_SCOPE ? "Reset to defaults" : "Use company minimums"}
              </ActionButton>
            </div>
          )}
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

  const saveAction = useAction();

  async function submit() {
    const error = await saveShift(actor, { ...form, id: editing ?? undefined });
    setMsg(result(error, editing ? "Shift updated." : "Shift added."));
    if (error) return false;
    notify(editing ? `Shift ${form.name.trim()} updated.` : `Shift ${form.name.trim()} added.`);
    setEditing(null);
    setForm(BLANK);
    return true;
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
              <ActionButton
                className="btn-ghost btn-tiny"
                busyLabel="Updating…"
                doneLabel="Done"
                success={s.active ? `${s.name} turned off.` : `${s.name} turned on.`}
                onAction={async () => {
                  const error = await setShiftActive(actor, s.id, !s.active);
                  setMsg(result(error, s.active ? `${s.name} turned off.` : `${s.name} turned on.`));
                  return error;
                }}
              >
                {s.active ? "Turn off" : "Turn on"}
              </ActionButton>
            </div>,
          ])}
        />
      </Card>
      <Card title={editing ? "Edit shift" : "Add a shift"}>
        <form className="stack" onSubmit={saveAction.submit(submit)}>
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
            <SubmitButton action={saveAction} className="btn">{editing ? "Save shift" : "Add shift"}</SubmitButton>
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
