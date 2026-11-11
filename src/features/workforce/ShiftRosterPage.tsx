import { useEffect, useMemo, useState, useSyncExternalStore, type DragEvent } from "react";
import { ActionButton, Banner, Card, DataTable, Dialog, EmptyState, Field, FilterBar, MetricCard, MetricGrid, Page, StatusBadge, SubmitButton, Tabs, notify, useAction } from "../../components/ui.tsx";
import { usePortal } from "../../store.tsx";
import { addDaysISO, holidaysForPerson, monthLabel, parseISODate, todayISO } from "../../model.ts";
import { dayHead, dragShift, droppedShift, isNightShift, monthDates, ShiftChip, shiftColor, shiftHours } from "./rosterUi.tsx";
import { scheduleForEmployee } from "../../data/workSchedule.ts";
import {
  apiCompOffSummary,
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
import "../../styles/pay-claims.css";

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

/** Worked hours of a shift: its length less the unpaid break. */
function netHours(shift: ShiftDef | undefined): number {
  if (!shift) return 0;
  return Math.max(0, Math.round((shiftHours(shift) - (shift.breakMinutes ?? 60) / 60) * 100) / 100);
}

type DayInfo = { date: string; shift?: ShiftDef; managerId?: string };

function ShiftDetailDialog({ info, onClose, actor }: { info: DayInfo; onClose: () => void; actor: WorkforceActor }) {
  const data = useShifts();
  const ctx = useRosterContext();
  const leave = leaveOn(actor.id, info.date, ctx.leaves);
  const holiday = holidayOn(info.date, holidaysForPerson(ctx.holidays, actor.id));
  const swaps = data.swaps.filter((s) => s.date === info.date && (s.requesterId === actor.id || s.teammateId === actor.id));
  const s = info.shift;
  const isWeeklyOff = useWeeklyOff();
  return (
    <Dialog open title={`${shortDay(info.date)}${s ? ` · ${s.name}` : ""}`} onClose={onClose} actions={<button type="button" className="btn-ghost" onClick={onClose}>Close</button>}>
      {s ? (
        <dl className="meta">
          <dt>Shift</dt>
          <dd>
            <ShiftChip shift={s} />
          </dd>
          <dt>Starts</dt>
          <dd>{s.start}</dd>
          <dt>Ends</dt>
          <dd>
            {s.end}
            {isNightShift(s) ? " (next day)" : ""}
          </dd>
          <dt>Break</dt>
          <dd>{s.breakMinutes ?? 60} min</dd>
          <dt>Hours</dt>
          <dd>
            {netHours(s)} h worked ({shiftHours(s)} h with the break)
          </dd>
          <dt>Location</dt>
          <dd>{s.location || "—"}</dd>
          <dt>Manager</dt>
          <dd>{info.managerId ? personName(info.managerId) : "—"}</dd>
          {compOffReason(info.date, holidaysForPerson(ctx.holidays, actor.id)) && (
            <>
              <dt>Comp-off</dt>
              <dd>{compOffReason(info.date, holidaysForPerson(ctx.holidays, actor.id))}: working it earns a comp-off day once your manager credits it.</dd>
            </>
          )}
        </dl>
      ) : (
        <p>{isWeeklyOff(info.date) ? "Weekly off." : "No shift on the published roster."}</p>
      )}
      {holiday && <p className="note">Public holiday: {holiday.name}. Not a working day.</p>}
      {!holiday && leave && <p className="note warn">You are on approved leave this day.</p>}
      {swaps.length > 0 && (
        <div>
          <strong>Swap requests</strong>
          <ul className="wf-plain-list">
            {swaps.map((sw) => (
              <li key={sw.id}>
                {swapLine(sw, data)} · <SwapBadge status={sw.status} />
                {sw.decisionNote && <span className="muted"> “{sw.decisionNote}”</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Dialog>
  );
}

/** Weekly offs from the signed-in person's own schedule (Sat/Sun by default; Fri/Sat in some countries). */
function useWeeklyOff(): (date: string) => boolean {
  const { employee } = usePortal();
  const offs = scheduleForEmployee({ shiftName: employee.shiftName, shiftHours: employee.shiftHours, countryCode: employee.countryCode }).weeklyOffDays;
  return (date: string) => offs.includes(parseISODate(date).getDay());
}

function MyShifts({ actor }: { actor: WorkforceActor }) {
  const data = useShifts();
  const ctx = useRosterContext();
  const today = todayISO();
  const [weekStart, setWeekStart] = useState(() => weekStartOf(today));
  const [mode, setMode] = useState<"week" | "month">("week");
  const [month, setMonth] = useState(() => ({ y: parseISODate(today).getFullYear(), m: parseISODate(today).getMonth() }));
  const [detail, setDetail] = useState<DayInfo | null>(null);
  const [shiftFilter, setShiftFilter] = useState("");
  const [search, setSearch] = useState("");
  const isWeeklyOff = useWeeklyOff();
  const mine = publishedShiftsFor(actor.id, data);
  const myHolidays = holidaysForPerson(ctx.holidays, actor.id);
  /** Why a rostered day isn't worked: a public holiday or approved leave. */
  const offReason = (date: string): string | null => {
    const holiday = holidayOn(date, myHolidays);
    if (holiday) return `Holiday · ${holiday.name}`;
    return leaveOn(actor.id, date, ctx.leaves) ? "On leave" : null;
  };
  const upcoming = mine.filter((a) => a.date >= today);
  const recent = mine.filter((a) => a.date < today && a.date >= addDaysISO(today, -14)).reverse();
  const shown = weekDates(weekStart);
  const credits = creditsFor(actor.id, data).filter((c) => !isCreditExpired(c, today));
  const apiCompOff = apiCompOffSummary();
  const next = upcoming.find((a) => !offReason(a.date));
  const nextShift = next ? shiftById(next.shiftId, data) : undefined;
  const weekRows = mine.filter((a) => shown.includes(a.date) && !offReason(a.date));
  const weekHours = Math.round(weekRows.reduce((sum, a) => sum + netHours(shiftById(a.shiftId, data)), 0) * 100) / 100;
  const nights = weekRows.filter((a) => isNightShift(shiftById(a.shiftId, data))).length;
  const weeklyOffs = shown.filter((d) => isWeeklyOff(d) && !mine.some((a) => a.date === d));
  // Changes to my shifts: approved swaps (either side).
  const changes = data.swaps
    .filter((s) => s.status === "approved" && (s.requesterId === actor.id || s.teammateId === actor.id))
    .sort((a, b) => b.date.localeCompare(a.date));
  const needle = search.trim().toLowerCase();
  const matches = (a: (typeof mine)[number]) => {
    const shift = shiftById(a.shiftId, data);
    if (shiftFilter && a.shiftId !== shiftFilter) return false;
    if (!needle) return true;
    return [shortDay(a.date), a.date, shift?.name ?? "", shift?.location ?? "", personName(a.managerId)].some((v) => v.toLowerCase().includes(needle));
  };
  const open = (date: string) => {
    const a = mine.find((x) => x.date === date);
    setDetail({ date, shift: a ? shiftById(a.shiftId, data) : undefined, managerId: a?.managerId });
  };

  const row = (a: (typeof mine)[number]) => {
    const shift = shiftById(a.shiftId, data);
    const off = offReason(a.date);
    const note = off ? null : compOffReason(a.date, myHolidays);
    return [
      <button key="d" type="button" className="link-btn" onClick={() => open(a.date)}>
        {shortDay(a.date)}
      </button>,
      <ShiftChip key="s" shift={shift} />,
      shift ? `${shift.start}–${shift.end}` : "—",
      off ? "—" : `${netHours(shift)} h`,
      shift?.location || "—",
      off ? <span key="o" className="wf-tag info">{off}</span> : [isWeekend(a.date) ? "Weekend" : "", note ?? ""].filter(Boolean).join(" · "),
    ];
  };
  const monthDays = monthDates(month.y, month.m);

  return (
    <>
      <MetricGrid>
        <MetricCard label="Next shift" value={nextShift ? nextShift.name : "None"} hint={next && nextShift ? `${shortDay(next.date)} · ${nextShift.start}–${nextShift.end}` : undefined} />
        <MetricCard label="Hours this week" value={`${weekHours} h`} hint={`${weekRows.length} shifts${nights ? ` · ${nights} night` : ""}`} />
        <MetricCard label="Weekly offs" value={weeklyOffs.length} hint={weeklyOffs.map((d) => shortDay(d).split(",")[0]).join(", ") || "None this week"} />
        <MetricCard label="Comp-off available" value={apiCompOff ? apiCompOff.available : credits.length} hint="Days" />
      </MetricGrid>
      <Card
        title={mode === "week" ? `Week of ${fmt(weekStart)}` : monthLabel(month.y, month.m)}
        action={
          <div className="row-gap">
            <Tabs
              tabs={[
                { id: "week", label: "Week" },
                { id: "month", label: "Month" },
              ]}
              value={mode}
              onChange={(id) => setMode(id === "month" ? "month" : "week")}
            />
            <button className="btn-ghost btn-tiny" type="button" onClick={() => (mode === "week" ? setWeekStart(addDaysISO(weekStart, -7)) : setMonth(({ y, m }) => (m === 0 ? { y: y - 1, m: 11 } : { y, m: m - 1 })))}>
              Previous
            </button>
            <button
              className="btn-ghost btn-tiny"
              type="button"
              onClick={() => {
                setWeekStart(weekStartOf(today));
                setMonth({ y: parseISODate(today).getFullYear(), m: parseISODate(today).getMonth() });
              }}
            >
              {mode === "week" ? "This week" : "This month"}
            </button>
            <button className="btn-ghost btn-tiny" type="button" onClick={() => (mode === "week" ? setWeekStart(addDaysISO(weekStart, 7)) : setMonth(({ y, m }) => (m === 11 ? { y: y + 1, m: 0 } : { y, m: m + 1 })))}>
              Next
            </button>
          </div>
        }
      >
        {mode === "week" ? (
          <div className="wf-my-week">
            {shown.map((d) => {
              const a = mine.find((x) => x.date === d);
              const shift = a ? shiftById(a.shiftId, data) : undefined;
              const leave = leaveOn(actor.id, d, ctx.leaves);
              const holiday = holidayOn(d, myHolidays);
              const off = Boolean(holiday || leave);
              return (
                <button key={d} type="button" className={`wf-my-day wf-day-btn${isWeekend(d) ? " weekend" : ""}${d === today ? " today" : ""}${holiday ? " sr-holiday" : ""}${d < today ? " sr-past" : ""}`} onClick={() => open(d)} aria-label={`${shortDay(d)}: ${holiday ? holiday.name : leave ? "on leave" : shift ? shift.name : "no shift"}. Open details`}>
                  <strong>{shortDay(d)}</strong>
                  {holiday ? (
                    <span className="sr-off">Holiday</span>
                  ) : leave ? (
                    <span className="sr-off">On leave</span>
                  ) : shift ? (
                    <ShiftChip shift={shift} />
                  ) : (
                    <span className="muted">{isWeeklyOff(d) ? "Weekly off" : "Off"}</span>
                  )}
                  {shift && !off && (
                    <span className="muted">
                      {shift.start}–{shift.end} · {netHours(shift)} h
                    </span>
                  )}
                  {holiday && <span className="muted">{holiday.name}</span>}
                </button>
              );
            })}
          </div>
        ) : (
          <div className="wf-month-cal">
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
              <span key={d} className="wf-month-dow">
                {d}
              </span>
            ))}
            {Array.from({ length: (parseISODate(monthDays[0]).getDay() + 6) % 7 }, (_, i) => (
              <span key={`p${i}`} />
            ))}
            {monthDays.map((d) => {
              const a = mine.find((x) => x.date === d);
              const shift = a ? shiftById(a.shiftId, data) : undefined;
              const leave = leaveOn(actor.id, d, ctx.leaves);
              const holiday = holidayOn(d, myHolidays);
              return (
                <button key={d} type="button" className={`wf-month-day${d === today ? " today" : ""}${isWeekend(d) ? " weekend" : ""}${holiday ? " sr-holiday" : ""}`} onClick={() => open(d)} aria-label={`${shortDay(d)}: ${holiday ? holiday.name : shift ? shift.name : "no shift"}`}>
                  <span className="wf-month-num">{Number(d.slice(8))}</span>
                  {holiday ? <span className="sr-off">Holiday</span> : leave ? <span className="wf-tag warn">Leave</span> : shift ? <ShiftChip shift={shift} short /> : <span className="muted">{isWeeklyOff(d) ? "Off" : ""}</span>}
                </button>
              );
            })}
          </div>
        )}
      </Card>
      <Card
        title="Upcoming"
        action={
          <FilterBar>
            <input type="search" aria-label="Search shifts" placeholder="Search date, shift, location" value={search} onChange={(e) => setSearch(e.target.value)} />
            <select aria-label="Filter by shift" value={shiftFilter} onChange={(e) => setShiftFilter(e.target.value)}>
              <option value="">All shifts</option>
              {data.shifts.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </FilterBar>
        }
      >
        <DataTable headers={["Date", "Shift", "Time", "Hours", "Location", ""]} rows={upcoming.filter(matches).map(row)} empty={<EmptyState title={needle || shiftFilter ? "No shift matches" : "No published shifts"} />} />
      </Card>
      {changes.length > 0 && (
        <Card title="Shift changes">
          <DataTable
            headers={["Date", "Change", "Approved by", "Note"]}
            rows={changes.map((s) => {
              const mineBefore = s.requesterId === actor.id ? s.requesterShiftId : s.teammateShiftId;
              const mineAfter = s.requesterId === actor.id ? s.teammateShiftId : s.requesterShiftId;
              return [
                shortDay(s.date),
                `${shiftById(mineBefore, data)?.name ?? "—"} → ${shiftById(mineAfter, data)?.name ?? "—"} (swap with ${personName(s.requesterId === actor.id ? s.teammateId : s.requesterId)})`,
                s.decidedByName ?? "—",
                s.decisionNote ?? "",
              ];
            })}
          />
        </Card>
      )}
      {recent.filter(matches).length > 0 && (
        <Card title="Last 14 days">
          <DataTable headers={["Date", "Shift", "Time", "Hours", "Location", ""]} rows={recent.filter(matches).map(row)} />
        </Card>
      )}
      {detail && <ShiftDetailDialog info={detail} actor={actor} onClose={() => setDetail(null)} />}
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

/** Requested → teammate → manager, as short steps. */
function SwapSteps({ swap }: { swap: ShiftSwap }) {
  const teammateDone = swap.status === "awaiting_manager" || swap.status === "approved" || swap.status === "rejected";
  const steps: [string, "done" | "now" | "stop" | "todo"][] = [
    [`Requested ${fmt(swap.requestedOn)}`, "done"],
    [
      swap.status === "declined" ? "Teammate declined" : teammateDone ? "Teammate accepted" : "Teammate to accept",
      swap.status === "declined" ? "stop" : teammateDone ? "done" : swap.status === "awaiting_teammate" ? "now" : "todo",
    ],
    [
      swap.status === "approved" ? `Manager approved${swap.decidedByName ? ` (${swap.decidedByName})` : ""}` : swap.status === "rejected" ? `Manager rejected${swap.decidedByName ? ` (${swap.decidedByName})` : ""}` : "Manager to approve",
      swap.status === "approved" ? "done" : swap.status === "rejected" ? "stop" : swap.status === "awaiting_manager" ? "now" : "todo",
    ],
  ];
  if (swap.status === "cancelled") steps.push(["Cancelled", "stop"]);
  return (
    <ol className="wf-steps" aria-label="Swap progress">
      {steps.map(([label, state]) => (
        <li key={label} className={state}>
          {label}
        </li>
      ))}
    </ol>
  );
}

function Swaps({ actor }: { actor: WorkforceActor }) {
  const data = useShifts();
  const ctx = useRosterContext();
  const today = todayISO();
  const [msg, setMsg] = useState<Msg>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [statusFilter, setStatusFilter] = useState<"" | "open" | SwapStatus>("");
  const [search, setSearch] = useState("");

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
  // Backend mode: the server lists only swaps this person may decide (view "to_decide").
  const toApprove = data.swaps.filter(
    (s) => s.status === "awaiting_manager" && (API_ENABLED ? s.requesterId !== actor.id && s.teammateId !== actor.id : canApproveSwap(actor, s)),
  );
  const needle = search.trim().toLowerCase();
  const mine = data.swaps
    .filter((s) => s.requesterId === actor.id || (s.teammateId === actor.id && s.status !== "awaiting_teammate"))
    .filter((s) => (statusFilter === "open" ? s.status === "awaiting_teammate" || s.status === "awaiting_manager" : !statusFilter || s.status === statusFilter))
    .filter((s) => !needle || [swapLine(s, data), s.reason, s.decisionNote ?? "", shortDay(s.date)].some((v) => v.toLowerCase().includes(needle)));

  const swapAction = useAction();

  async function submit() {
    if (!date) return setMsg({ tone: "err", text: "Pick one of your upcoming shifts." }), false;
    if (!teammateId) return setMsg({ tone: "err", text: "Pick a teammate to swap with." }), false;
    if (!reason.trim()) return setMsg({ tone: "err", text: "Give a reason for the swap." }), false;
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
                    <input aria-label="Decision note" placeholder="Comment (needed to reject)" value={notes[s.id] ?? ""} onChange={(e) => setNotes({ ...notes, [s.id]: e.target.value })} />
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
          <EmptyState title="No upcoming shifts to swap" description="Swaps are for your published shifts after today." />
        ) : (
          <form className="stack" onSubmit={swapAction.submit(submit)}>
            <div className="form-grid-2">
              <Field label="Date and shift">
                <select
                  value={date}
                  onChange={(e) => {
                    setDate(e.target.value);
                    setTeammateId("");
                  }}
                >
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
                  <option value="">{!date ? "Pick a date first" : !teammates.length ? "No teammate on another shift that day" : "Pick a teammate"}</option>
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
              <SubmitButton action={swapAction} className="btn">
                Submit request
              </SubmitButton>
            </div>
          </form>
        )}
      </Card>
      <Card
        title="My swaps"
        action={
          <FilterBar>
            <input type="search" aria-label="Search swaps" placeholder="Search name, shift, reason" value={search} onChange={(e) => setSearch(e.target.value)} />
            <select aria-label="Filter swaps by status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}>
              <option value="">All statuses</option>
              <option value="open">Open</option>
              {(Object.keys(SWAP_LABEL) as SwapStatus[]).map((k) => (
                <option key={k} value={k}>
                  {SWAP_LABEL[k][0]}
                </option>
              ))}
            </select>
          </FilterBar>
        }
      >
        <DataTable
          headers={["Date", "Swap", "Progress", "Status", ""]}
          rows={mine.map((s) => [
            shortDay(s.date),
            <span key="l">
              {swapLine(s, data)}
              <span className="muted wf-block">{s.reason}</span>
              {s.decisionNote && <span className="wf-block">Manager: “{s.decisionNote}”</span>}
            </span>,
            <SwapSteps key="p" swap={s} />,
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
          empty={<EmptyState title={needle || statusFilter ? "No swap matches" : "No swaps yet"} />}
        />
      </Card>
    </>
  );
}

// ---------- Comp-off ----------

const LEAVE_STATUS_TONE: Record<string, "ok" | "warn" | "danger" | "neutral"> = { approved: "ok", pending: "warn", rejected: "danger", cancelled: "neutral", withdrawn: "neutral" };

function CompOff({ actor }: { actor: WorkforceActor }) {
  const data = useShifts();
  const ctx = useRosterContext();
  const { state, leaveTable, applyLeave } = usePortal();
  const today = todayISO();
  const [msg, setMsg] = useState<Msg>(null);
  const [date, setDate] = useState("");
  const [reason, setReason] = useState("");
  const [historyFilter, setHistoryFilter] = useState("");
  const mine = creditsFor(actor.id, data);
  const candidates = compOffCandidates(actor, ctx, data);
  const teamCredits = data.credits.filter((c) => c.personId !== actor.id && (API_ENABLED || canDecideFor(actor, c.personId)));
  const apiSummary = apiCompOffSummary();
  const row = leaveTable.find((r) => r.code === "comp_off");
  const earned = row?.quota ?? apiSummary?.earned ?? 0;
  const used = row?.utilized ?? apiSummary?.used ?? 0;
  const pendingDays = row?.pending ?? apiSummary?.pending ?? 0;
  const available = row?.available ?? apiSummary?.available ?? 0;
  const requests = state.leaveRequests
    .filter((r) => r.employeeId === actor.id && r.code === "comp_off")
    .filter((r) => !historyFilter || r.status === historyFilter)
    .sort((a, b) => b.from.localeCompare(a.from));
  const applyAction = useAction();

  async function apply() {
    if (!date) return setMsg({ tone: "err", text: "Pick the day you want off." }), false;
    if (!reason.trim()) return setMsg({ tone: "err", text: "Give a reason." }), false;
    if (available <= 0) return setMsg({ tone: "err", text: "You have no comp-off days available." }), false;
    const error = await applyLeave({ code: "comp_off", from: date, to: date, reason: reason.trim() });
    setMsg(result(error, `Comp-off for ${fmt(date)} sent for approval.`));
    if (error) return false;
    notify(`Comp-off for ${fmt(date)} sent for approval.`);
    setDate("");
    setReason("");
    return true;
  }

  return (
    <>
      <Banner message={msg} />
      <MetricGrid>
        <MetricCard label="Earned" value={earned} hint={apiSummary ? `${apiSummary.fromRoster} from rostered off days · ${apiSummary.fromOvertime} from overtime` : "This year"} />
        <MetricCard label="Used" value={used} hint="Approved comp-off leave" />
        <MetricCard label="Pending" value={pendingDays} hint="Waiting for approval" />
        <MetricCard label="Available" value={available} hint={mine.filter((c) => !isCreditExpired(c, today)).length ? `Next credit expires ${fmt([...mine].filter((c) => !isCreditExpired(c, today)).sort((a, b) => a.expiresOn.localeCompare(b.expiresOn))[0].expiresOn)}` : undefined} />
      </MetricGrid>
      <Card title="Apply for comp-off">
        <form className="stack" onSubmit={applyAction.submit(apply)}>
          <div className="form-grid-2">
            <Field label="Day off">
              <input type="date" value={date} min={addDaysISO(today, -30)} onChange={(e) => setDate(e.target.value)} />
            </Field>
            <Field label="Reason">
              <input value={reason} maxLength={300} placeholder="e.g. For working Saturday's release" onChange={(e) => setReason(e.target.value)} />
            </Field>
          </div>
          <div className="row-gap">
            <SubmitButton action={applyAction} className="btn" disabled={available <= 0}>
              Apply
            </SubmitButton>
            {available <= 0 && <span className="muted">No comp-off days available.</span>}
          </div>
        </form>
      </Card>
      <Card
        title="Request history"
        action={
          <select aria-label="Filter comp-off requests" value={historyFilter} onChange={(e) => setHistoryFilter(e.target.value)}>
            <option value="">All</option>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
            <option value="cancelled">Cancelled</option>
          </select>
        }
      >
        <DataTable
          headers={["Day", "Reason", "Applied", "Status", "Decided by", "Manager comment"]}
          rows={requests.map((r) => [
            r.from === r.to ? fmt(r.from) : `${fmt(r.from)} – ${fmt(r.to)}`,
            r.reason,
            r.appliedOn ? fmt(r.appliedOn.slice(0, 10)) : "—",
            <StatusBadge key="s" status={r.status} tone={LEAVE_STATUS_TONE[r.status] ?? "neutral"} literal />,
            r.decidedByName ?? (r.status === "pending" ? r.approvalProgress ?? "Waiting" : "—"),
            r.decisionNote ?? "—",
          ])}
          empty={<EmptyState title={historyFilter ? "No request with this status" : "No comp-off requests yet"} />}
        />
      </Card>
      {candidates.length > 0 && (
        <Card title="Worked on a weekly off or holiday">
          <DataTable
            headers={["Person", "Date", "Shift", "Why", ""]}
            rows={candidates.map(({ assignment: a, reason: why }) => [
              personName(a.personId),
              shortDay(a.date),
              shiftById(a.shiftId, data)?.name ?? "—",
              why,
              <ActionButton
                key="g"
                className="btn btn-tiny"
                busyLabel="Granting…"
                doneLabel="Granted"
                success={`1 comp-off day credited to ${personName(a.personId)}.`}
                onAction={async () => {
                  const error = await grantCompOff(actor, ctx, a.personId, a.date);
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
          empty={<EmptyState title="No comp-off credits" description="Earned by working a rostered weekly off or holiday, or overtime taken as comp-off." />}
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
  const [mode, setMode] = useState<"week" | "month">("week");
  const [brush, setBrush] = useState<string | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const weekDays = weekDates(weekStart);
  const [month, setMonth] = useState(() => {
    const d = parseISODate(weekStart);
    return { y: d.getFullYear(), m: d.getMonth() };
  });
  const dates = mode === "week" ? weekDays : monthDates(month.y, month.m);
  // A pre-boarding joiner shows from the week they start (days before their start are refused).
  const team = rosterTeamFor(actor.id, dates[dates.length - 1]);
  const week = rosterWeek(actor.id, weekStart, data);
  const published = week?.status === "published";
  const activeShifts = data.shifts.filter((s) => s.active);
  const conflicts = useMemo(() => weekConflicts(data, ctx, actor.id, weekStart), [data, ctx, actor.id, weekStart]);
  const coverage = useMemo(() => weekCoverage(data, ctx, actor.id, weekStart), [data, ctx, actor.id, weekStart]);
  const gaps = useMemo(() => coverageGaps(data, ctx, actor.id, weekStart), [data, ctx, actor.id, weekStart]);
  const gapDays = new Set(gaps.map((g) => g.date));
  const [confirmGaps, setConfirmGaps] = useState(false);
  const weekOver = weekDays[6] < today;
  const publishAction = useAction();
  const copyAction = useAction();
  const busy = publishAction.busy || copyAction.busy;
  const prevWeek = addDaysISO(weekStart, -7);

  useEffect(() => {
    ensureRosterWeek(actor.id, weekStart);
    ensureRosterWeek(actor.id, prevWeek);
  }, [actor.id, weekStart, prevWeek]);
  useEffect(() => {
    if (mode !== "month") return;
    const seen = new Set<string>();
    for (const d of monthDates(month.y, month.m)) seen.add(weekStartOf(d));
    for (const w of seen) ensureRosterWeek(actor.id, w);
  }, [actor.id, mode, month.y, month.m]);

  function moveWeek(delta: number) {
    const next = addDaysISO(weekStart, delta * 7);
    setWeekStart(next);
    const d = parseISODate(next);
    setMonth({ y: d.getFullYear(), m: d.getMonth() });
    setMsg(null);
    setConfirmGaps(false);
  }

  function moveMonth(delta: number) {
    const d = new Date(month.y, month.m + delta, 1);
    setMonth({ y: d.getFullYear(), m: d.getMonth() });
    setMsg(null);
  }

  async function change(personId: string, date: string, shiftId: string) {
    const current = data.assignments.find((a) => a.personId === personId && a.date === date);
    if ((current?.shiftId ?? "") === shiftId) return;
    const error = await assignShift(actor, ctx, personId, date, shiftId || null);
    setMsg(error ? { tone: "err", text: error } : null);
    setConfirmGaps(false);
    if (!error) {
      const shiftName = shiftId ? shiftById(shiftId, data)?.name : undefined;
      notify(shiftName ? `${personName(personId)} assigned to ${shiftName} on ${shortDay(date)}.` : `Shift cleared for ${personName(personId)} on ${shortDay(date)}.`);
    }
  }

  async function copyLastWeek() {
    const prevDays = weekDates(prevWeek);
    // Not the manager's own shifts: nobody can roster themselves, so copying them only produced "Skipped" warnings.
    const source = data.assignments.filter((a) => a.managerId === actor.id && a.personId !== actor.id && prevDays.includes(a.date));
    if (source.length === 0) return "Last week has no shifts to copy.";
    let copied = 0;
    const skipped: string[] = [];
    for (const row of source) {
      const date = addDaysISO(row.date, 7);
      if (date <= today) continue;
      if (getShiftState().assignments.some((a) => a.personId === row.personId && a.date === date)) continue;
      const error = await assignShift(actor, ctx, row.personId, date, row.shiftId);
      if (error) skipped.push(`${personName(row.personId)} ${shortDay(date)}: ${error}`);
      else copied += 1;
    }
    setMsg(
      skipped.length
        ? { tone: "warn", text: `Copied ${copied}. Skipped ${skipped.length}: ${skipped.slice(0, 3).join(" · ")}${skipped.length > 3 ? " …" : ""}` }
        : { tone: "ok", text: copied ? `Copied ${copied} shifts from last week.` : "Nothing new to copy. Those days are already filled." },
    );
    if (copied) notify(`Copied ${copied} shifts from last week.`);
    setConfirmGaps(false);
    return null;
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
    ...weekDays.map((date) => {
      const slot = coverage.find((c) => c.shiftId === shift.id && c.date === date);
      return slot ? <CoverageCell key={date} slot={slot} /> : <span key={date} className="muted">—</span>;
    }),
  ]);
  const myHolidays = holidaysForPerson(ctx.holidays, actor.id);
  const weekHeaders = ["Shift", ...weekDays.map((d) => `${shortDay(d)}${holidayOn(d, myHolidays) ? " · Holiday" : ""}`)];
  const short = mode === "month";

  function cell(personId: string, personFull: string, date: string) {
    const current = data.assignments.find((a) => a.personId === personId && a.date === date);
    const leave = leaveOn(personId, date, ctx.leaves);
    const otherOwner = current && current.managerId !== actor.id;
    const locked = date <= today || !!otherOwner;
    const shift = current ? shiftById(current.shiftId, data) : undefined;
    const classes = ["wf-rcell", isWeekend(date) ? "weekend" : "", locked ? "locked" : "", brush !== null && !locked ? "paint" : ""]
      .filter(Boolean)
      .join(" ");
    const drop = locked
      ? {}
      : {
          onDragOver: (e: DragEvent) => e.preventDefault(),
          onDrop: (e: DragEvent) => {
            e.preventDefault();
            const id = droppedShift(e);
            if (id !== null) void change(personId, date, id);
          },
        };
    return (
      <td key={date} className={classes} {...drop}>
        {locked || short || brush !== null ? (
          <button
            type="button"
            className="wf-cellbtn"
            disabled={locked}
            draggable={!!shift && !locked}
            onDragStart={(e) => shift && dragShift(e, shift.id)}
            aria-label={`${personFull} on ${shortDay(date)}: ${shift?.name ?? "no shift"}`}
            onClick={() => {
              if (locked) return;
              if (brush !== null) void change(personId, date, brush);
              else if (short) {
                setWeekStart(weekStartOf(date));
                setMode("week");
              }
            }}
          >
            <ShiftChip shift={shift} short={short} />
          </button>
        ) : (
          <select
            draggable={false}
            className={shift ? `c-${shiftColor(shift)}` : undefined}
            aria-label={`${personFull} on ${shortDay(date)}`}
            value={current?.shiftId ?? ""}
            onChange={(e) => change(personId, date, e.target.value)}
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
        {leave && <span className="wf-tag warn">{short ? "L" : "On leave"}</span>}
      </td>
    );
  }

  return (
    <>
      <Card
        title={mode === "week" ? `Week of ${fmt(weekStart)}` : monthLabel(month.y, month.m)}
        action={
          <div className="row-gap">
            <Tabs
              tabs={[
                { id: "week", label: "Week" },
                { id: "month", label: "Month" },
              ]}
              value={mode}
              onChange={(id) => setMode(id === "month" ? "month" : "week")}
            />
            <button className="btn-ghost btn-tiny" type="button" onClick={() => (mode === "week" ? moveWeek(-1) : moveMonth(-1))}>
              Previous
            </button>
            {mode === "week" && weekStart !== weekStartOf(today) && (
              <button className="btn-ghost btn-tiny" type="button" onClick={() => moveWeek(Math.round((parseISODate(weekStartOf(today)).getTime() - parseISODate(weekStart).getTime()) / 604800000))}>
                This week
              </button>
            )}
            <button className="btn-ghost btn-tiny" type="button" onClick={() => (mode === "week" ? moveWeek(1) : moveMonth(1))}>
              Next
            </button>
          </div>
        }
      >
        <div className="stack">
          {mode === "week" && (
            <div className="row-between wf-wrap">
              <div className="row-gap">
                <StatusBadge status={published ? "Published" : "Draft"} tone={published ? "ok" : "warn"} literal />
                {published && week?.publishedOn && <span className="muted">Published {fmt(week.publishedOn)} by {week.publishedByName}</span>}
              </div>
              {!weekOver && (
                <div className="row-gap">
                  <ActionButton className="btn-ghost" disabled={busy} action={copyAction} onAction={copyLastWeek} onError={(m) => setMsg({ tone: "err", text: m })}>
                    Copy last week
                  </ActionButton>
                  {!published && (
                    <ActionButton
                      className="btn"
                      disabled={busy}
                      action={publishAction}
                      success="Roster published. Your team can see their shifts."
                      onAction={() => publish(false)}
                    >
                      Publish roster
                    </ActionButton>
                  )}
                  {!published && confirmGaps && gaps.length > 0 && (
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
          )}
          <div className="wf-palette" role="toolbar" aria-label="Quick assign">
            <span className="muted">Quick assign</span>
            {activeShifts.map((s) => (
              <button
                key={s.id}
                type="button"
                draggable
                onDragStart={(e) => dragShift(e, s.id)}
                className={`wf-brush${brush === s.id ? " on" : ""}`}
                aria-pressed={brush === s.id}
                onClick={() => setBrush(brush === s.id ? null : s.id)}
                title={`${shiftLabel(s)} · ${shiftHours(s)} h${s.weekendOnly ? " · weekends" : ""}`}
              >
                <ShiftChip shift={s} />
              </button>
            ))}
            <button
              type="button"
              className={`wf-brush${brush === "" ? " on" : ""}`}
              aria-pressed={brush === ""}
              draggable
              onDragStart={(e) => dragShift(e, "")}
              onClick={() => setBrush(brush === "" ? null : "")}
            >
              <span className="wf-chip c-clear">Clear</span>
            </button>
            {brush !== null && (
              <button type="button" className="btn-ghost btn-tiny" onClick={() => setBrush(null)}>
                Done
              </button>
            )}
          </div>
          <Banner message={msg} />
          {mode === "week" && conflicts.length > 0 && (
            <div className="note wf-warn">
              {conflicts.map((c) => (
                <div key={c}>{c}</div>
              ))}
            </div>
          )}
          {team.length === 0 ? (
            <EmptyState title="No one reports to you" />
          ) : (
            <div className="table-scroll">
              <table className={`wf-roster${short ? " month" : ""}`}>
                <thead>
                  <tr>
                    <th>Person</th>
                    {dates.map((d) => {
                      const h = dayHead(d);
                      const holiday = holidayOn(d, myHolidays);
                      const gap = mode === "week" && gapDays.has(d);
                      return (
                        <th key={d} className={h.weekend ? "weekend" : undefined} title={holiday?.name}>
                          <span className="wf-dow">{short ? h.dow.slice(0, 2) : h.dow}</span> {h.day}
                          {holiday && <span className="wf-tag info">{short ? "H" : "Holiday"}</span>}
                          {gap && <span className="wf-tag danger">Short</span>}
                        </th>
                      );
                    })}
                    <th>Hours</th>
                  </tr>
                </thead>
                <tbody>
                  {team.map((person) => {
                    const hours =
                      Math.round(
                        data.assignments
                          .filter((a) => a.personId === person.id && dates.includes(a.date))
                          .reduce((sum, a) => sum + netHours(shiftById(a.shiftId, data)), 0) * 100,
                      ) / 100;
                    const nights = data.assignments.filter(
                      (a) => a.personId === person.id && dates.includes(a.date) && isNightShift(shiftById(a.shiftId, data)),
                    ).length;
                    return (
                      <tr key={person.id}>
                        <th scope="row">{person.shortName}</th>
                        {dates.map((d) => cell(person.id, person.fullName, d))}
                        <td className="wf-hours">
                          <strong>{hours} h</strong>
                          {nights > 0 && <span className="wf-tag">{nights} night</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Card>
      {mode === "week" && (
        <Card title="Coverage">
          <div className="stack">
            {gaps.length > 0 ? (
              <div className="sr-gaps" role="status">
                <strong>
                  {gaps.length} {gaps.length === 1 ? "shift needs" : "shifts need"} people
                </strong>
                <ul>
                  {gaps.map((g) => (
                    <li key={`${g.date}-${g.shiftId}`}>
                      {shortDay(g.date)} · {shiftById(g.shiftId, data)?.name ?? g.shiftId} · {g.assigned}/{g.required}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              coverage.some((c) => c.required > 0) && <p className="muted">Every shift meets its minimum this week.</p>
            )}
            <div className="wf-grid">
              <DataTable headers={weekHeaders} rows={coverageRows} empty={<EmptyState title="No shifts this week" />} />
            </div>
            <div className="wf-cov-legend muted">
              <span><span className="wf-cov under">0/1</span> Under minimum</span>
              <span><span className="wf-cov ok">1/1</span> Covered</span>
              <span><span className="wf-cov over">2/1</span> Over minimum</span>
            </div>
          </div>
        </Card>
      )}
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

const BLANK = { name: "", start: "09:00", end: "17:00", weekendOnly: false, breakMinutes: "60", location: "" };

function ShiftTypes({ actor }: { actor: WorkforceActor }) {
  const data = useShifts();
  const [msg, setMsg] = useState<Msg>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState(BLANK);

  function edit(s: ShiftDef) {
    setEditing(s.id);
    setForm({ name: s.name, start: s.start, end: s.end, weekendOnly: s.weekendOnly, breakMinutes: String(s.breakMinutes ?? 60), location: s.location ?? "" });
    setMsg(null);
  }

  const saveAction = useAction();

  async function submit() {
    const error = await saveShift(actor, { ...form, breakMinutes: Number(form.breakMinutes), id: editing ?? undefined });
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
          headers={["Shift", "Hours", "Break", "Location", "Days", "Status", ""]}
          rows={data.shifts.map((s) => [
            s.name,
            `${s.start}–${s.end}`,
            `${s.breakMinutes ?? 60} min`,
            s.location || "—",
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
            <Field label="Break (minutes)">
              <input type="number" min={0} max={240} step={5} value={form.breakMinutes} onChange={(e) => setForm({ ...form, breakMinutes: e.target.value })} />
            </Field>
            <Field label="Location">
              <input value={form.location} maxLength={100} placeholder="e.g. Kochi office" onChange={(e) => setForm({ ...form, location: e.target.value })} />
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
