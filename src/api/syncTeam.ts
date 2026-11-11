/** Team overview today and approval reminders from the API (backend mode). See backend/app/routers/team.py. */
import { useEffect, useState } from "react";
import { api, API_ENABLED } from "./client.ts";

export interface TeamTodayOut {
  employee_id: string;
  full_name: string;
  direct: boolean;
  date: string;
  check_in: string | null;
  check_out: string | null;
  worked_minutes: number | null;
  work_mode: string | null;
  timesheet_hours: number;
  timesheet_status: string;
  leave_code: string | null;
  holiday: boolean;
  leave_left: { code: string; name: string; available: number }[];
}

/** Backend mode: today's attendance, timesheet and leave left for the caller's team (empty in local mode). */
export function useTeamToday(): { rows: Map<string, TeamTodayOut>; loaded: boolean } {
  const [rows, setRows] = useState<Map<string, TeamTodayOut>>(new Map());
  const [loaded, setLoaded] = useState(!API_ENABLED);
  useEffect(() => {
    if (!API_ENABLED) return;
    let live = true;
    api
      .get<TeamTodayOut[]>("/team/today")
      .then((list) => live && setRows(new Map(list.map((r) => [r.employee_id, r]))))
      .catch((e) => console.warn("Team today failed", e))
      .finally(() => live && setLoaded(true));
    return () => {
      live = false;
    };
  }, []);
  return { rows, loaded };
}

/** One day of a person's month in the manager's drill-in (GET /team/{id}/summary). */
export interface TeamDayOut {
  date: string;
  kind: string | null;
  leave_code: string | null;
  check_in: string | null;
  check_out: string | null;
  work_mode: string | null;
  worked_minutes: number;
  target_minutes: number;
  late_minutes: number;
  overtime_minutes: number;
  timesheet_hours: number;
  timesheet_status: string;
}

/** A report's today status, worked hours vs target, late days, overtime and open work (GET /team/summary). */
export interface TeamSummaryOut {
  employee_id: string;
  full_name: string;
  designation: string;
  department: string;
  direct: boolean;
  date: string;
  status: "checked_in" | "checked_out" | "remote" | "on_leave" | "holiday" | "weekly_off" | "not_in" | string;
  check_in: string | null;
  check_out: string | null;
  work_mode: string | null;
  leave_code: string | null;
  today_minutes: number;
  today_target_minutes: number;
  week_minutes: number;
  week_target_minutes: number;
  month_minutes: number;
  month_target_minutes: number;
  late_days_month: number;
  overtime_minutes_month: number;
  approved_overtime_hours_month: number;
  timesheet_submitted: number;
  timesheet_missing_days: number;
  pending_approvals: number;
  open_tasks: number;
  overdue_tasks: number;
  open_tickets: number;
  overdue_tickets: number;
  days: TeamDayOut[];
}

/** Backend mode: the team summary (empty map in local mode; callers build it from local stores). */
export function useTeamSummary(): { rows: Map<string, TeamSummaryOut>; loaded: boolean; error: string } {
  const [rows, setRows] = useState<Map<string, TeamSummaryOut>>(new Map());
  const [loaded, setLoaded] = useState(!API_ENABLED);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!API_ENABLED) return;
    let live = true;
    api
      .get<TeamSummaryOut[]>("/team/summary")
      .then((list) => live && setRows(new Map(list.map((r) => [r.employee_id, r]))))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : "Could not load the team."))
      .finally(() => live && setLoaded(true));
    return () => {
      live = false;
    };
  }, []);
  return { rows, loaded, error };
}

/** Backend mode: one person with each day of the month so far. */
export function loadPersonSummary(employeeId: string): Promise<TeamSummaryOut> {
  return api.get<TeamSummaryOut>(`/team/${encodeURIComponent(employeeId)}/summary`);
}

/** Backend mode: notify the approver (once a day per request). Returns an error message or null. */
export async function apiRemindApprover(input: {
  approverId: string;
  requesterId: string;
  kind: string;
  summary: string;
  requestId: string;
}): Promise<string | null> {
  try {
    await api.post("/approvals/remind", {
      approver_id: input.approverId,
      requester_id: input.requesterId,
      kind: input.kind,
      summary: input.summary.slice(0, 300),
      request_id: input.requestId.slice(0, 120),
    });
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : "Could not send the reminder.";
  }
}
