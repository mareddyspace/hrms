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
