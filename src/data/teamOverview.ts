/**
 * Team overview helpers: today per person (attendance, timesheet, leave left) from local stores, and the
 * "Remind" action on open requests (local mode: an in-app alert; backend mode: POST /approvals/remind).
 */
import { API_ENABLED } from "../api/client.ts";
import { apiRemindApprover, type TeamTodayOut } from "../api/syncTeam.ts";
import { leaveRows, type PortalState } from "../model.ts";
import { getAttendanceState, sessionHours } from "./attendanceLocal.ts";
import { appendAuditEntries } from "./auditTrail.ts";
import { pushPersonTaskAlert } from "./collabLocal.ts";
import { DAY_TARGET, dayRecordFor, getLocalDays } from "./timesheetDays.ts";

export interface PersonToday {
  checkIn?: string;
  checkOut?: string;
  hoursWorked: number;
  timesheetHours: number;
  timesheetStatus: string;
  leaveLeft: { code: string; name: string; available: number }[];
}

const hm = (iso?: string | null) => {
  if (!iso) return undefined;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

const SKIP_LEAVE = new Set(["unpaid", "lop", "comp_off", "wfh", "emergency_wfh", "optional"]);

/** Today for one person: from the API row in backend mode, otherwise this browser's attendance, timesheets and leave. */
export function personToday(state: PortalState, personId: string, today: string, apiRow?: TeamTodayOut): PersonToday {
  if (API_ENABLED) {
    return {
      checkIn: hm(apiRow?.check_in),
      checkOut: hm(apiRow?.check_out),
      hoursWorked: apiRow?.worked_minutes != null ? Math.round((apiRow.worked_minutes / 60) * 10) / 10 : apiRow?.check_in ? Math.round(((Date.now() - new Date(apiRow.check_in).getTime()) / 3_600_000) * 10) / 10 : 0,
      timesheetHours: apiRow?.timesheet_hours ?? 0,
      timesheetStatus: apiRow?.timesheet_status ?? "draft",
      leaveLeft: apiRow?.leave_left ?? [],
    };
  }
  const session = getAttendanceState().sessions.find((s) => s.employeeId === personId && s.date === today);
  let timesheetHours = 0;
  for (const sheet of state.timesheets) {
    if (sheet.employeeId !== personId) continue;
    for (const e of sheet.entries ?? []) if (e.date === today) timesheetHours += e.hours;
  }
  const leaveLeft = leaveRows(state.leavePolicies, state.leaveRequests, state.encashments, state.holidays, personId, undefined, Number(today.slice(0, 4)))
    .filter((r) => r.quota > 0 && !SKIP_LEAVE.has(r.code))
    .map((r) => ({ code: r.code, name: r.name, available: Math.round(r.available * 10) / 10 }));
  return {
    checkIn: hm(session?.checkIn),
    checkOut: hm(session?.checkOut),
    hoursWorked: session ? sessionHours(session).hoursWorked : 0,
    timesheetHours: Math.round(timesheetHours * 100) / 100,
    timesheetStatus: dayRecordFor(getLocalDays(), personId, today)?.status ?? "draft",
    leaveLeft,
  };
}

export const TIMESHEET_TARGET = DAY_TARGET;

const SENT_KEY = "timez.manualReminders.v1";

function sentToday(key: string, today: string): boolean {
  try {
    const log = JSON.parse(localStorage.getItem(SENT_KEY) ?? "{}") as Record<string, string>;
    return log[key] === today;
  } catch {
    return false;
  }
}

function markSent(key: string, today: string) {
  try {
    const log = JSON.parse(localStorage.getItem(SENT_KEY) ?? "{}") as Record<string, string>;
    const kept = Object.fromEntries(Object.entries(log).filter(([, d]) => d === today));
    kept[key] = today;
    localStorage.setItem(SENT_KEY, JSON.stringify(kept));
  } catch {
    /* storage blocked: the reminder may be sent again */
  }
}

/** Tell the person a request waits with that it's still open — once a day per request. Returns an error or null. */
export async function remindApprover(input: {
  actor: { id: string; fullName: string };
  approverId: string;
  approverName: string;
  requesterId: string;
  requesterName: string;
  kind: string;
  summary: string;
  requestId: string;
  today: string;
}): Promise<string | null> {
  if (input.approverId === input.actor.id) return "This request is waiting with you.";
  const key = `${input.requestId}:${input.approverId}`;
  if (sentToday(key, input.today)) return `${input.approverName} was already reminded today.`;
  if (API_ENABLED) {
    const error = await apiRemindApprover(input);
    if (error) return error;
  } else {
    pushPersonTaskAlert({
      recipientId: input.approverId,
      title: `Reminder: ${input.kind} from ${input.requesterName} is waiting for you`,
      body: input.summary,
      href: "/approvals",
    });
    appendAuditEntries([
      {
        at: new Date().toISOString(),
        actorId: input.actor.id,
        actorName: input.actor.fullName,
        entity: "Approval reminder",
        entityId: input.requestId,
        subjectId: input.requesterId,
        action: "Created",
        changes: [{ field: "Sent to", before: "", after: input.approverName }],
      },
    ]);
  }
  markSent(key, input.today);
  return null;
}
