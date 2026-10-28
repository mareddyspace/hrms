import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  Banner,
  Card,
  EmptyState,
  FilterBar,
  MetricCard,
  MetricGrid,
  Page,
  StatusBadge,
  Tabs,
  downloadText,
} from "../components/ui.tsx";
import {
  SAMPLE_SHIFT,
  attendanceContextFor,
  buildAttendanceHistory,
  breakMinutes,
  formatHm,
  kindLabel,
  nonWorkingReason,
  phaseLabel,
  type AttendanceCorrection,
  type AttendanceDayKind,
  type AttendanceDayRecord,
  type CorrectionKind,
} from "../data/attendanceData.ts";
import {
  attendanceAction,
  decideCorrection,
  getAttendanceState,
  getCurrentSession,
  isHrReviewer,
  listCorrectionsForApprover,
  listCorrectionsForEmployee,
  missingCheckOutSessions,
  sessionHours,
  submitCorrection,
  subscribeAttendance,
} from "../data/attendanceLocal.ts";
import { RegionalFilter } from "../locale/RegionalFilter.tsx";
import { useLocale } from "../locale/LocaleContext.tsx";
import {
  formatShortDate,
  formatStamp,
  monthCells,
  monthLabel,
  parseISODate,
  toISO,
  todayISO,
} from "../model.ts";
import {
  isPrimaryWeeklyOffLabel,
  scheduleForEmployee,
  shortHolidayName,
} from "../data/workSchedule.ts";
import { managementChain } from "../demoAccounts.ts";
import { usePortal } from "../store.tsx";

type RangeMode = "week" | "month" | "custom";
type AttTab = "overview" | "history" | "corrections" | "schedule";

function useAttendance() {
  return useSyncExternalStore(subscribeAttendance, getAttendanceState, getAttendanceState);
}

function startOfWeek(iso: string): string {
  const d = parseISODate(iso);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return toISO(d);
}

function endOfWeek(iso: string): string {
  const d = parseISODate(startOfWeek(iso));
  d.setDate(d.getDate() + 6);
  return toISO(d);
}

function monthBounds(year: number, month: number): { from: string; to: string } {
  const from = toISO(new Date(year, month, 1));
  const to = toISO(new Date(year, month + 1, 0));
  return { from, to };
}

function formatBreakDuration(mins: number): string {
  if (mins <= 0) return "0m";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function correctionKindLabel(kind: CorrectionKind): string {
  if (kind === "missing_check_in") return "Missing check-in";
  if (kind === "missing_check_out") return "Missing check-out";
  if (kind === "wrong_time") return "Wrong time";
  return "Other";
}

export function AttendancePage() {
  const { state, employee, isManager, demoProfile, demoAccounts, canDecideFor } = usePortal();
  const { activeCountry, t } = useLocale();
  const attState = useAttendance();
  const today = todayISO();
  const initial = new Date();

  const [tab, setTab] = useState<AttTab>("overview");
  const [cursor, setCursor] = useState({ year: initial.getFullYear(), month: initial.getMonth() });
  const [rangeMode, setRangeMode] = useState<RangeMode>("month");
  const [customFrom, setCustomFrom] = useState(() => monthBounds(initial.getFullYear(), initial.getMonth()).from);
  const [customTo, setCustomTo] = useState(() => monthBounds(initial.getFullYear(), initial.getMonth()).to);
  const [selectedDate, setSelectedDate] = useState(today);
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [historyQ, setHistoryQ] = useState("");
  const [historyKind, setHistoryKind] = useState("");
  const [corrDate, setCorrDate] = useState(today);
  const [corrKind, setCorrKind] = useState<CorrectionKind>("missing_check_out");
  const [corrReason, setCorrReason] = useState("");
  const [corrIn, setCorrIn] = useState("");
  const [corrOut, setCorrOut] = useState("");
  const [corrError, setCorrError] = useState<string | null>(null);
  // Decision notes are per correction so typing on one row does not leak into another.
  const [decideNotes, setDecideNotes] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!message) return;
    const tmr = window.setTimeout(() => setMessage(null), 3200);
    return () => window.clearTimeout(tmr);
  }, [message]);

  // Corrections go to the nearest manager in the reporting line; none means nobody can review them.
  const approver = managementChain(employee.id, demoAccounts)[0];
  const managerId = approver?.id ?? "";
  const schedule = useMemo(
    () =>
      scheduleForEmployee({
        shiftName: employee.shiftName,
        shiftHours: employee.shiftHours,
        countryCode: employee.countryCode,
      }),
    [employee.shiftName, employee.shiftHours, employee.countryCode],
  );
  const myCorrections = useMemo(
    () => listCorrectionsForEmployee(employee.id),
    [attState.corrections, employee.id],
  );
  const teamCorrections = useMemo(
    () => listCorrectionsForApprover(canDecideFor, { id: employee.id, role: demoProfile.role }),
    [attState.corrections, canDecideFor, employee.id, demoProfile.role],
  );

  const range = useMemo(() => {
    if (rangeMode === "week") {
      const mid = selectedDate || today;
      return { from: startOfWeek(mid), to: endOfWeek(mid) };
    }
    if (rangeMode === "custom") {
      const from = customFrom <= customTo ? customFrom : customTo;
      const to = customFrom <= customTo ? customTo : customFrom;
      return { from, to };
    }
    return monthBounds(cursor.year, cursor.month);
  }, [rangeMode, cursor, customFrom, customTo, selectedDate, today]);

  const dayContext = useMemo(
    () => attendanceContextFor(employee, state.holidays, state.leaveRequests),
    [employee, state.holidays, state.leaveRequests],
  );
  const employeeHolidays = dayContext.holidays;

  const history = useMemo(
    () =>
      buildAttendanceHistory({
        employeeId: employee.id,
        employeeName: employee.fullName,
        from: range.from,
        to: range.to,
        holidays: employeeHolidays,
        leaveRequests: state.leaveRequests,
        absences: state.absences,
        shiftHours: employee.shiftHours,
        corrections: myCorrections,
        weeklyOffDays: schedule.weeklyOffDays,
        sessions: attState.sessions,
      }),
    [
      employee.id,
      employee.fullName,
      employee.shiftHours,
      range.from,
      range.to,
      employeeHolidays,
      state.leaveRequests,
      state.absences,
      myCorrections,
      schedule.weeklyOffDays,
      attState.sessions,
    ],
  );

  const monthHistory = useMemo(() => {
    const bounds = monthBounds(cursor.year, cursor.month);
    return buildAttendanceHistory({
      employeeId: employee.id,
      employeeName: employee.fullName,
      from: bounds.from,
      to: bounds.to,
      holidays: employeeHolidays,
      leaveRequests: state.leaveRequests,
      absences: state.absences,
      shiftHours: employee.shiftHours,
      corrections: myCorrections,
      weeklyOffDays: schedule.weeklyOffDays,
      sessions: attState.sessions,
    });
  }, [
    cursor.year,
    cursor.month,
    employee.id,
    employee.fullName,
    employee.shiftHours,
    employeeHolidays,
    state.leaveRequests,
    state.absences,
    myCorrections,
    schedule.weeklyOffDays,
    attState.sessions,
  ]);

  const byDate = useMemo(() => new Map(monthHistory.map((r) => [r.date, r])), [monthHistory]);

  const summary = useMemo(() => {
    const s = { present: 0, absent: 0, leave: 0, wfh: 0, exceptions: 0, holiday: 0 };
    for (const row of history) {
      if (row.kind === "present") s.present += 1;
      else if (row.kind === "absent") s.absent += 1;
      else if (row.kind === "leave") s.leave += 1;
      else if (row.kind === "wfh") s.wfh += 1;
      else if (row.kind === "holiday") s.holiday += 1;
      else if (row.kind === "missing_punch" || row.kind === "pending_correction") s.exceptions += 1;
    }
    return s;
  }, [history]);

  const session = getCurrentSession(employee.id, attState);
  const missingOut = missingCheckOutSessions(employee.id, attState);
  const todayOff = session.phase === "not_started" ? nonWorkingReason(employee.id, today, dayContext) : null;
  const live = sessionHours(session);
  const openBreak = session.breaks.find((b) => !b.end);

  const cells = monthCells(cursor.year, cursor.month);
  const selectedRecord: AttendanceDayRecord | undefined =
    byDate.get(selectedDate) || history.find((r) => r.date === selectedDate);

  const filteredHistory = useMemo(() => {
    const q = historyQ.trim().toLowerCase();
    return history
      .filter((r) => r.kind !== "upcoming" && r.kind !== "weekend")
      .filter((r) => {
        if (historyKind && r.kind !== historyKind) return false;
        if (!q) return true;
        return `${r.date} ${kindLabel(r.kind)} ${r.note ?? ""} ${r.checkIn ?? ""} ${r.checkOut ?? ""}`
          .toLowerCase()
          .includes(q);
      })
      .slice()
      .sort((a, b) => (a.date < b.date ? 1 : -1));
  }, [history, historyQ, historyKind]);

  const monthExpectedDays = monthHistory.filter(
    (r) =>
      r.kind === "present" ||
      r.kind === "wfh" ||
      r.kind === "missing_punch" ||
      r.kind === "pending_correction" ||
      r.kind === "not_checked_in",
  ).length;
  const monthExpectedHours = monthExpectedDays * SAMPLE_SHIFT.expectedHours;
  const monthRecordedHours = monthHistory.reduce((sum, r) => sum + r.hoursWorked, 0);

  function moveMonth(delta: number) {
    setCursor((prev) => {
      const d = new Date(prev.year, prev.month + delta, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });
  }

  function moveWeek(delta: number) {
    const base = parseISODate(selectedDate);
    base.setDate(base.getDate() + delta * 7);
    const next = toISO(base);
    setSelectedDate(next);
    setCursor({ year: base.getFullYear(), month: base.getMonth() });
  }

  function runPunch(action: "check_in" | "start_break" | "end_break" | "check_out") {
    const error = attendanceAction(employee.id, action, dayContext);
    if (error) {
      setMessage({ tone: "err", text: error });
      return;
    }
    const labels = {
      check_in: "Checked in.",
      start_break: "Break started.",
      end_break: "Break ended.",
      check_out: "Checked out.",
    } as const;
    setMessage({ tone: "ok", text: labels[action] });
  }

  function submitCorr() {
    const error = submitCorrection({
      employeeId: employee.id,
      employeeName: employee.fullName,
      managerId,
      date: corrDate,
      kind: corrKind,
      reason: corrReason,
      requestedCheckIn: corrIn || undefined,
      requestedCheckOut: corrOut || undefined,
      context: dayContext,
    });
    setCorrError(error);
    if (error) return;
    setMessage({ tone: "ok", text: `Correction request submitted — ${approver?.fullName ?? "your manager"} will review it.` });
    setCorrReason("");
    setCorrIn("");
    setCorrOut("");
    setTab("corrections");
  }

  function decide(row: AttendanceCorrection, status: "Approved" | "Rejected") {
    const error = decideCorrection(row.id, { id: employee.id, role: demoProfile.role, fullName: employee.fullName }, status, decideNotes[row.id]);
    setMessage(error ? { tone: "err", text: error } : { tone: "ok", text: `Correction ${status.toLowerCase()}.` });
    if (!error) setDecideNotes((prev) => ({ ...prev, [row.id]: "" }));
  }

  function openCorrection(date: string, kind: CorrectionKind) {
    setCorrDate(date);
    setCorrKind(kind);
    setCorrError(null);
    setTab("corrections");
  }

  function downloadReport() {
    const lines = [
      "Date,Status,Check-in,Check-out,Break minutes,Hours,Late (min),OT (min),Note",
      ...filteredHistory.map((r) =>
        [
          r.date,
          kindLabel(r.kind),
          r.checkIn ?? "",
          r.checkOut ?? "",
          breakMinutes(r.breaks),
          r.hoursWorked,
          r.lateMinutes,
          r.overtimeMinutes,
          (r.note ?? "").replace(/,/g, ";"),
        ].join(","),
      ),
    ];
    downloadText(
      `attendance-${employee.employeeCode}-${range.from}_${range.to}.csv`,
      `${lines.join("\n")}\n`,
    );
    setMessage({ tone: "ok", text: "Attendance CSV downloaded." });
  }

  const regionHolidays = employeeHolidays.filter((h) => h.date >= range.from && h.date <= range.to);

  return (
    <Page
      title="Time & attendance"
      action={
        <button type="button" className="btn-ghost" onClick={downloadReport}>
          Download report
        </button>
      }
    >
      {message && <Banner message={message} />}

      <Tabs
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "history", label: "History" },
          { id: "corrections", label: "Corrections" },
          { id: "schedule", label: "Schedule" },
        ]}
        value={tab}
        onChange={(id) => setTab(id as AttTab)}
      />

      <>
          {tab === "overview" && (
            <>
              <Card title="Today's attendance" action={<StatusBadge status={phaseLabel(session.phase)} />}>
                <div className="att-today-grid">
                  <div>
                    <span className="muted">Status</span>
                    <strong>{phaseLabel(session.phase)}</strong>
                  </div>
                  <div>
                    <span className="muted">Check-in</span>
                    <strong>{session.checkIn ? formatHm(session.checkIn) : "—"}</strong>
                  </div>
                  <div>
                    <span className="muted">Check-out</span>
                    <strong>{session.checkOut ? formatHm(session.checkOut) : "—"}</strong>
                  </div>
                  <div>
                    <span className="muted">Break</span>
                    <strong>
                      {formatBreakDuration(live.breakMinutes)}
                      {session.phase === "on_break" && openBreak ? ` · since ${openBreak.start}` : ""}
                    </strong>
                  </div>
                  <div>
                    <span className="muted">Hours worked</span>
                    <strong>{live.hoursWorked.toFixed(1)}h</strong>
                  </div>
                  <div>
                    <span className="muted">Shift</span>
                    <strong>
                      {employee.shiftName || SAMPLE_SHIFT.name} · {employee.shiftHours || `${SAMPLE_SHIFT.start}–${SAMPLE_SHIFT.end}`}
                    </strong>
                  </div>
                </div>
                {session.date !== today && session.phase !== "not_started" && (
                  <p className="note warn">Session started {formatShortDate(session.date)} (overnight) — check out to close it.</p>
                )}
                {missingOut.map((s) => (
                  <p key={s.date} className="note warn att-missing-out">
                    Missing check-out on {formatShortDate(s.date)} (checked in {s.checkIn ? formatHm(s.checkIn) : "—"}).{" "}
                    <button type="button" className="btn-ghost" onClick={() => openCorrection(s.date, "missing_check_out")}>
                      Request correction
                    </button>
                  </p>
                ))}
                <div className="form-actions">
                  {session.phase === "not_started" &&
                    (todayOff ? (
                      <p className="note">{todayOff} No check-in needed.</p>
                    ) : (
                      <button type="button" className="btn" onClick={() => runPunch("check_in")}>
                        Check in
                      </button>
                    ))}
                  {session.phase === "checked_in" && (
                    <>
                      <button type="button" className="btn-ghost" onClick={() => runPunch("start_break")}>
                        Start break
                      </button>
                      <button type="button" className="btn" onClick={() => runPunch("check_out")}>
                        Check out
                      </button>
                    </>
                  )}
                  {session.phase === "on_break" && (
                    <button type="button" className="btn" onClick={() => runPunch("end_break")}>
                      End break
                    </button>
                  )}
                  {session.phase === "checked_out" && (
                    <p className="note">Day closed.</p>
                  )}
                </div>
              </Card>

              <FilterBar>
                <label className="filter-label">
                  Range
                  <select value={rangeMode} onChange={(e) => setRangeMode(e.target.value as RangeMode)}>
                    <option value="week">This week</option>
                    <option value="month">This month</option>
                    <option value="custom">Custom</option>
                  </select>
                </label>
                {rangeMode === "custom" && (
                  <>
                    <label className="filter-label">
                      From
                      <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
                    </label>
                    <label className="filter-label">
                      To
                      <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
                    </label>
                  </>
                )}
                {rangeMode === "week" && (
                  <div className="row-gap">
                    <button type="button" className="btn-ghost" onClick={() => moveWeek(-1)}>
                      ← Prev week
                    </button>
                    <button type="button" className="btn-ghost" onClick={() => moveWeek(1)}>
                      Next week →
                    </button>
                  </div>
                )}
                {rangeMode === "month" && (
                  <div className="row-gap">
                    <button type="button" className="btn-ghost" onClick={() => moveMonth(-1)}>
                      ← Prev month
                    </button>
                    <button type="button" className="btn-ghost" onClick={() => moveMonth(1)}>
                      Next month →
                    </button>
                  </div>
                )}
                <RegionalFilter label={t("locale.region")} />
              </FilterBar>

              <p className="note">
                {formatShortDate(range.from)} – {formatShortDate(range.to)}
              </p>

              <MetricGrid>
                <MetricCard label="Present" value={summary.present} />
                <MetricCard label="Absent" value={summary.absent} />
                <MetricCard label="Leave" value={summary.leave} />
                <MetricCard label="Work from home" value={summary.wfh} />
                <MetricCard label="Exceptions" value={summary.exceptions} hint="Missing punch / pending" />
                <MetricCard label="Holidays" value={summary.holiday} />
              </MetricGrid>

              <div className="att-workbench">
                <Card
                  title={monthLabel(cursor.year, cursor.month)}
                  action={
                    rangeMode === "month" ? undefined : (
                      <div className="row-gap">
                        <button type="button" className="btn-ghost" onClick={() => moveMonth(-1)}>
                          ←
                        </button>
                        <button type="button" className="btn-ghost" onClick={() => moveMonth(1)}>
                          →
                        </button>
                      </div>
                    )
                  }
                >
                  <div className="cal-legend">
                    <span className="day present legend-swatch">Present</span>
                    <span className="day leave legend-swatch">Leave</span>
                    <span className="day wfh legend-swatch">WFH</span>
                    <span className="day holiday legend-swatch">Holiday</span>
                    <span className="day absent legend-swatch">Absent</span>
                    <span className="day weekend legend-swatch">Weekly off</span>
                    <span className="day missing_punch legend-swatch">Missing punch</span>
                    <span className="day pending_correction legend-swatch">Correction</span>
                  </div>
                  <div className="cal att-cal">
                    {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((label) => (
                      <div key={label} className="cal-head">
                        {label}
                      </div>
                    ))}
                    {cells.map((date, index) => {
                      if (!date) return <div key={`blank-${index}`} />;
                      const row = byDate.get(date);
                      const kind = (row?.kind ?? "upcoming") as AttendanceDayKind;
                      let caption: string | null = null;
                      if (kind === "holiday") caption = shortHolidayName(row?.note || "Holiday");
                      else if (kind === "leave") caption = "Leave";
                      else if (kind === "wfh") caption = "WFH";
                      else if (kind === "absent") caption = "Absent";
                      else if (kind === "missing_punch") caption = "Missing punch";
                      else if (kind === "pending_correction") caption = "Correction";
                      else if (kind === "not_checked_in") caption = "Not checked in";
                      else if (kind === "present") {
                        caption = row && row.hoursWorked > 0 ? `${row.hoursWorked}h` : schedule.hoursLabel;
                      } else if (
                        kind === "weekend" &&
                        isPrimaryWeeklyOffLabel(date, schedule.weeklyOffDays)
                      ) {
                        caption = "Weekly off";
                      }
                      const tip = [
                        formatShortDate(date),
                        kindLabel(kind),
                        row?.note && kind === "holiday" ? row.note : null,
                        row?.checkIn ? `In ${row.checkIn}` : null,
                        row?.checkOut ? `Out ${row.checkOut}` : null,
                        kind === "weekend" ? `Off · ${schedule.workDaysLabel}` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ");
                      return (
                        <button
                          key={date}
                          type="button"
                          title={tip}
                          className={`day att-day ${kind} ${date === today ? "today" : ""} ${date === selectedDate ? "selected" : ""}`}
                          onClick={() => setSelectedDate(date)}
                        >
                          <strong>{Number(date.slice(-2))}</strong>
                          {caption ? <span className="att-day-meta">{caption}</span> : null}
                          {row?.lateMinutes ? <span className="att-flag">Late</span> : null}
                          {row?.overtimeMinutes ? <span className="att-flag ot">OT</span> : null}
                        </button>
                      );
                    })}
                  </div>
                </Card>

                <aside className="att-detail-panel">
                  <Card title={selectedDate ? formatShortDate(selectedDate) : "Day detail"}>
                    {!selectedRecord ? (
                      <EmptyState title="No day selected" description="Click a date on the calendar." />
                    ) : (
                      <div className="stack">
                        <div className="att-today-grid">
                          <div>
                            <span className="muted">Status</span>
                            <StatusBadge status={kindLabel(selectedRecord.kind)} />
                          </div>
                          <div>
                            <span className="muted">Hours</span>
                            <strong>{selectedRecord.hoursWorked.toFixed(1)}h</strong>
                          </div>
                          <div>
                            <span className="muted">Check-in</span>
                            <strong>{selectedRecord.checkIn ?? "—"}</strong>
                          </div>
                          <div>
                            <span className="muted">Check-out</span>
                            <strong>{selectedRecord.checkOut ?? "—"}</strong>
                          </div>
                        </div>
                        <div>
                          <span className="muted">Breaks</span>
                          {(selectedRecord.breaks?.length ?? 0) === 0 ? (
                            <p className="muted">None</p>
                          ) : (
                            <ul className="todo">
                              {selectedRecord.breaks.map((b, i) => (
                                <li key={`${b.start}-${i}`}>
                                  {b.start} – {b.end ?? "…"} ({formatBreakDuration(b.end ? breakMinutes([b]) : 0)})
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                        {selectedRecord.note && <p className="note">{selectedRecord.note}</p>}
                        {(selectedRecord.lateMinutes > 0 || selectedRecord.overtimeMinutes > 0) && (
                          <p className="note">
                            {selectedRecord.lateMinutes > 0 ? `Late by ${selectedRecord.lateMinutes} min. ` : ""}
                            {selectedRecord.overtimeMinutes > 0
                              ? `Overtime ${selectedRecord.overtimeMinutes} min.`
                              : ""}
                          </p>
                        )}
                        {!["upcoming", "weekend", "holiday", "leave"].includes(selectedRecord.kind) && (
                          <button
                            type="button"
                            className="btn-ghost"
                            onClick={() =>
                              openCorrection(
                                selectedRecord.date,
                                !selectedRecord.checkIn
                                  ? "missing_check_in"
                                  : !selectedRecord.checkOut
                                    ? "missing_check_out"
                                    : "wrong_time",
                              )
                            }
                          >
                            Request correction
                          </button>
                        )}
                      </div>
                    )}
                  </Card>

                  <Card title={`Holidays · ${employee.countryName || activeCountry.name}`}>
                    {regionHolidays.length === 0 ? (
                      <p className="muted">No holidays in this range.</p>
                    ) : (
                      <ul className="todo">
                        {regionHolidays.map((h) => (
                          <li key={h.date}>
                            {h.date} · {h.name}
                          </li>
                        ))}
                      </ul>
                    )}
                    {activeCountry.leavePolicy.note && <p className="note">{activeCountry.leavePolicy.note}</p>}
                  </Card>
                </aside>
              </div>
            </>
          )}

          {tab === "history" && (
            <Card
              title="Attendance history"
              action={
                <button type="button" className="btn-ghost" onClick={downloadReport}>
                  Export CSV
                </button>
              }
            >
              <FilterBar>
                <label className="filter-label">
                  Search
                  <input
                    value={historyQ}
                    onChange={(e) => setHistoryQ(e.target.value)}
                    placeholder="Date, status, note…"
                  />
                </label>
                <label className="filter-label">
                  Status
                  <select value={historyKind} onChange={(e) => setHistoryKind(e.target.value)}>
                    <option value="">All</option>
                    <option value="present">Present</option>
                    <option value="absent">Absent</option>
                    <option value="leave">Leave</option>
                    <option value="wfh">WFH</option>
                    <option value="missing_punch">Missing punch</option>
                    <option value="pending_correction">Correction pending</option>
                    <option value="not_checked_in">Not checked in</option>
                    <option value="holiday">Holiday</option>
                  </select>
                </label>
              </FilterBar>
              {filteredHistory.length === 0 ? (
                <EmptyState title="No records" />
              ) : (
                <div className="table-scroll">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Status</th>
                        <th>In</th>
                        <th>Out</th>
                        <th>Hours</th>
                        <th>Late</th>
                        <th>OT</th>
                        <th>Note</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredHistory.map((r) => (
                        <tr
                          key={r.id}
                          className={r.date === selectedDate ? "row-active" : undefined}
                          onClick={() => {
                            setSelectedDate(r.date);
                            setTab("overview");
                          }}
                        >
                          <td>{formatShortDate(r.date)}</td>
                          <td>
                            <StatusBadge status={kindLabel(r.kind)} />
                          </td>
                          <td>{r.checkIn ?? "—"}</td>
                          <td>{r.checkOut ?? "—"}</td>
                          <td>{r.hoursWorked.toFixed(1)}h</td>
                          <td>{r.lateMinutes ? `${r.lateMinutes}m` : "—"}</td>
                          <td>{r.overtimeMinutes ? `${r.overtimeMinutes}m` : "—"}</td>
                          <td>{r.note || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          )}

          {tab === "corrections" && (
            <div className="att-corr-grid">
              <Card title="Request a correction">
                <p className="note">
                  Own punches only, within the last 30 days.{" "}
                  {approver ? `Reviewed by ${approver.fullName}.` : "No manager in your reporting line — contact HR."}
                </p>
                <div className="form-grid-2">
                  <label className="field">
                    Date
                    <input type="date" value={corrDate} max={today} onChange={(e) => setCorrDate(e.target.value)} />
                  </label>
                  <label className="field">
                    Type
                    <select value={corrKind} onChange={(e) => setCorrKind(e.target.value as CorrectionKind)}>
                      <option value="missing_check_in">Missing check-in</option>
                      <option value="missing_check_out">Missing check-out</option>
                      <option value="wrong_time">Wrong time</option>
                      <option value="other">Other</option>
                    </select>
                  </label>
                  <label className="field">
                    Requested check-in{corrKind === "missing_check_in" ? " *" : ""}
                    <input type="time" value={corrIn} onChange={(e) => setCorrIn(e.target.value)} placeholder="HH:mm" />
                  </label>
                  <label className="field">
                    Requested check-out{corrKind === "missing_check_out" ? " *" : ""}
                    <input type="time" value={corrOut} onChange={(e) => setCorrOut(e.target.value)} placeholder="HH:mm" />
                  </label>
                  <label className="field" style={{ gridColumn: "1 / -1" }}>
                    Reason
                    <input
                      value={corrReason}
                      onChange={(e) => setCorrReason(e.target.value)}
                      placeholder="Why does this need correcting?"
                    />
                  </label>
                </div>
                {corrError && (
                  <p className="note err" role="alert">
                    {corrError}
                  </p>
                )}
                <div className="form-actions">
                  <button type="button" className="btn" onClick={submitCorr} disabled={!approver}>
                    Submit request
                  </button>
                </div>
              </Card>

              <Card title="My correction requests">
                {myCorrections.length === 0 ? (
                  <EmptyState title="No requests" />
                ) : (
                  <ul className="att-corr-list">
                    {myCorrections.map((c) => (
                      <CorrectionRow key={c.id} row={c} />
                    ))}
                  </ul>
                )}
              </Card>

              {(isManager || isHrReviewer(demoProfile.role) || teamCorrections.length > 0) && (
                <Card title={isHrReviewer(demoProfile.role) ? "Correction queue" : "Team correction queue"} className="att-corr-span">
                  {teamCorrections.length === 0 ? (
                    <EmptyState title="No team requests" />
                  ) : (
                    <ul className="att-corr-list">
                      {teamCorrections.map((c) => (
                        <li key={c.id} className="att-corr-item">
                          <CorrectionRow row={c} />
                          {c.status === "Pending" && (
                            <div className="row-gap" style={{ marginTop: 8 }}>
                              <input
                                value={decideNotes[c.id] ?? ""}
                                onChange={(e) => setDecideNotes((prev) => ({ ...prev, [c.id]: e.target.value }))}
                                placeholder="Decision note (optional)"
                                aria-label={`Decision note for ${c.employeeName}, ${c.date}`}
                                style={{ flex: 1 }}
                              />
                              <button type="button" className="btn" onClick={() => decide(c, "Approved")}>
                                Approve
                              </button>
                              <button type="button" className="btn-ghost" onClick={() => decide(c, "Rejected")}>
                                Reject
                              </button>
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              )}
            </div>
          )}

          {tab === "schedule" && (
            <div className="att-corr-grid">
              <Card title="Work schedule">
                <div className="att-today-grid">
                  <div>
                    <span className="muted">Assigned shift</span>
                    <strong>{employee.shiftName || SAMPLE_SHIFT.name}</strong>
                  </div>
                  <div>
                    <span className="muted">Expected hours</span>
                    <strong>
                      {SAMPLE_SHIFT.start} – {SAMPLE_SHIFT.end} ({SAMPLE_SHIFT.expectedHours}h / day)
                    </strong>
                  </div>
                  <div>
                    <span className="muted">Weekly offs</span>
                    <strong>{schedule.weeklyOffLabels.join(", ")}</strong>
                  </div>
                  <div>
                    <span className="muted">Work days</span>
                    <strong>{schedule.workDaysLabel}</strong>
                  </div>
                </div>
                <p className="note">{schedule.note}</p>
              </Card>

              <Card title={`Monthly summary · ${monthLabel(cursor.year, cursor.month)}`}>
                <MetricGrid>
                  <MetricCard label="Expected hours" value={monthExpectedHours.toFixed(1)} hint="Working days × shift" />
                  <MetricCard label="Recorded hours" value={monthRecordedHours.toFixed(1)} />
                  <MetricCard
                    label="Variance"
                    value={`${(monthRecordedHours - monthExpectedHours).toFixed(1)}h`}
                    hint={monthRecordedHours >= monthExpectedHours ? "On / above target" : "Below target"}
                  />
                </MetricGrid>
                <p className="note">
                  Late after {SAMPLE_SHIFT.lateGraceMinutes} min grace · overtime after {SAMPLE_SHIFT.overtimeAfterMinutes} min past shift end.
                </p>
              </Card>
            </div>
          )}
      </>
    </Page>
  );
}

function CorrectionRow({ row }: { row: AttendanceCorrection }) {
  return (
    <div className="att-corr-item">
      <div className="row-between">
        <strong>
          {formatShortDate(row.date)} · {correctionKindLabel(row.kind)}
        </strong>
        <StatusBadge status={row.status} />
      </div>
      <p style={{ margin: "6px 0 0" }}>{row.reason}</p>
      <p className="muted" style={{ margin: "4px 0 0" }}>
        {row.employeeName} · requested {formatStamp(row.createdAt)}
        {row.requestedCheckIn ? ` · in ${row.requestedCheckIn}` : ""}
        {row.requestedCheckOut ? ` · out ${row.requestedCheckOut}` : ""}
      </p>
      {row.decisionNote && <p className="note">Decision: {row.decisionNote}</p>}
    </div>
  );
}
