/**
 * Today's check-in / check-out in one line, for the timesheet and the home timesheet card.
 * Same attendance store and API as the Attendance page (src/data/attendanceLocal.ts), so both always agree.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Link } from "react-router-dom";
import { ActionButton } from "./ui.tsx";
import { attendanceContextFor, nonWorkingReason } from "../data/attendanceData.ts";
import {
  attendanceActionAsync,
  attendedMinutes,
  getAttendanceState,
  getCurrentSession,
  subscribeAttendance,
} from "../data/attendanceLocal.ts";
import { todayISO } from "../model.ts";
import { usePortal } from "../store.tsx";
import "../pages/timesheetDays.css";

/** "9:32 am" */
export function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).toLowerCase();
}

/** "9 h 05 m", "40 m" */
export function durationText(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  return h ? `${h} h ${String(m % 60).padStart(2, "0")} m` : `${m % 60} m`;
}

/** Today's attendance for the signed-in person, ticking every 30 s while checked in. */
export function useTodayAttendance() {
  const { employee, state } = usePortal();
  const attState = useSyncExternalStore(subscribeAttendance, getAttendanceState, getAttendanceState);
  const session = getCurrentSession(employee.id, attState);
  const open = session.phase === "checked_in" || session.phase === "on_break";
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [open]);
  const dayContext = useMemo(
    () => attendanceContextFor(employee, state.holidays, state.leaveRequests),
    [employee, state.holidays, state.leaveRequests],
  );
  const offToday = session.phase === "not_started" ? nonWorkingReason(employee.id, todayISO(), dayContext) : null;
  return {
    session,
    open,
    checkedOut: session.phase === "checked_out" && !!session.checkOut && session.date === todayISO(),
    minutes: attendedMinutes(session, now),
    offToday,
    punch: (action: "check_in" | "end_break" | "check_out") => attendanceActionAsync(employee.id, action, dayContext),
  };
}

/** One line: Check in → "Checked in 9:32 am · 3 h 10 m so far" → Check out → "Worked 9 h 05 m (9:32 am – 6:37 pm)". */
export function AttendanceStrip({ main = true, compact = false }: { main?: boolean; compact?: boolean }) {
  const { session, minutes, offToday, punch } = useTodayAttendance();
  const button = `${main ? "btn" : "btn-ghost"} btn-tiny`;
  let text: string;
  if (session.phase === "not_started") text = offToday ? `${offToday} No check-in needed.` : "Not checked in yet.";
  else if (session.phase === "checked_out" && session.checkIn && session.checkOut)
    text = `Worked ${durationText(minutes)} (${clockTime(session.checkIn)} – ${clockTime(session.checkOut)})`;
  else
    text = `Checked in ${session.checkIn ? clockTime(session.checkIn) : ""} · ${durationText(minutes)} so far${session.phase === "on_break" ? " · on a break" : ""}`;
  return (
    <div className={`ts-att-strip${compact ? " compact" : ""} ${session.phase}`} aria-label="Today's attendance">
      <span className="ts-att-text">
        {!compact && <span className="muted">Attendance · </span>}
        {text}
      </span>
      <span className="ts-att-actions">
        {session.phase === "not_started" && !offToday && (
          <ActionButton className={button} busyLabel="Checking in…" doneLabel="Checked in" success="Checked in." toastError onAction={() => punch("check_in")}>
            Check in
          </ActionButton>
        )}
        {session.phase === "checked_in" && (
          <ActionButton className={button} busyLabel="Checking out…" doneLabel="Checked out" success="Checked out." toastError onAction={() => punch("check_out")}>
            Check out
          </ActionButton>
        )}
        {session.phase === "on_break" && (
          <ActionButton className={button} busyLabel="Ending…" doneLabel="Break ended" success="Break ended." toastError onAction={() => punch("end_break")}>
            End break
          </ActionButton>
        )}
        {!compact && (
          <Link className="ts-att-link" to="/attendance">
            Attendance
          </Link>
        )}
      </span>
    </div>
  );
}
