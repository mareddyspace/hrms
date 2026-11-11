/** The manager's team summary in either mode: GET /team/summary (backend) or the same figures from local stores. */
import { useMemo, useSyncExternalStore } from "react";
import { API_ENABLED } from "../../api/client.ts";
import { useTeamSummary, type TeamSummaryOut } from "../../api/syncTeam.ts";
import { getAttendanceState, subscribeAttendance } from "../../data/attendanceLocal.ts";
import type { PersonRecord } from "../../data/peopleData.ts";
import { localTeamSummary } from "../../data/teamSummaryLocal.ts";
import { useDayRecords } from "../../data/timesheetDays.ts";
import { useTickets } from "../../data/ticketStore.ts";
import { todayISO } from "../../model.ts";
import { usePortal } from "../../store.tsx";

/**
 * Rows for these people. pendingBy (from the approvals inbox) replaces the server's count so the number matches
 * what opens in Approvals.
 */
export function useTeamSummaryRows(people: PersonRecord[], pendingBy: Map<string, number>): {
  rows: TeamSummaryOut[];
  loaded: boolean;
  error: string;
} {
  const { state, employee } = usePortal();
  const api = useTeamSummary();
  const att = useSyncExternalStore(subscribeAttendance, getAttendanceState, getAttendanceState);
  const records = useDayRecords();
  const tickets = useTickets();
  const today = todayISO();
  const pendingKey = [...pendingBy].map(([k, v]) => `${k}:${v}`).join(",");
  const rows = useMemo(() => {
    const base = API_ENABLED
      ? people.map((p) => api.rows.get(p.id)).filter((r): r is TeamSummaryOut => Boolean(r))
      : localTeamSummary({ state, people, managerId: employee.id, sessions: att.sessions, records, tickets, pendingBy, today });
    return base.map((r) => ({ ...r, pending_approvals: pendingBy.get(r.employee_id) ?? (API_ENABLED ? r.pending_approvals : 0) }));
    // pendingKey stands for pendingBy
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [people, api.rows, state, employee.id, att.sessions, records, tickets, pendingKey, today]);
  return { rows, loaded: api.loaded, error: api.error };
}

export const STATUS_TEXT: Record<string, string> = {
  checked_in: "In",
  checked_out: "Checked out",
  remote: "Remote",
  on_leave: "On leave",
  holiday: "Holiday",
  weekly_off: "Weekly off",
  not_in: "Not checked in",
};

export const STATUS_TONE: Record<string, "ok" | "warn" | "danger" | "info" | "neutral"> = {
  checked_in: "ok",
  checked_out: "neutral",
  remote: "info",
  on_leave: "info",
  holiday: "info",
  weekly_off: "neutral",
  not_in: "warn",
};

/** "7.5 h" from minutes. */
export function hoursText(minutes: number): string {
  const h = Math.round((minutes / 60) * 10) / 10;
  return `${h} h`;
}

/** Local time "09:41" from an ISO time. */
export function clockText(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}
