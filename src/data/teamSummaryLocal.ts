/**
 * Local mode version of GET /team/summary (backend/app/services/team_summary.py): the same figures from this
 * browser's attendance sessions, leave, holidays, timesheets, tasks and tickets. Backend mode uses the API.
 */
import type { TeamDayOut, TeamSummaryOut } from "../api/syncTeam.ts";
import { addDaysISO, blockingLeave, halfDayLeave, holidaysForPerson, parseISODate, type PortalState } from "../model.ts";
import { SAMPLE_SHIFT, type TodaySession } from "./attendanceData.ts";
import { attendedMinutes } from "./attendanceLocal.ts";
import type { PersonRecord } from "./peopleData.ts";
import { dayTargetFor, type DayRecord } from "./timesheetDays.ts";
import { isOpenTicket, type Ticket } from "./ticketStore.ts";

const WFH_CODES = new Set(["wfh", "emergency_wfh"]);

function hm(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function minutesOf(value: string): number {
  const [h, m] = value.split(":").map(Number);
  return h * 60 + m;
}

export function localTeamSummary(input: {
  state: PortalState;
  people: PersonRecord[];
  managerId: string;
  sessions: TodaySession[];
  records: DayRecord[];
  tickets: Ticket[];
  pendingBy: Map<string, number>;
  today: string;
  withDays?: boolean;
}): TeamSummaryOut[] {
  const { state, people, managerId, sessions, records, tickets, pendingBy, today, withDays = false } = input;
  const todayDate = parseISODate(today);
  const weekStart = addDaysISO(today, -((todayDate.getDay() + 6) % 7));
  const monthStart = `${today.slice(0, 8)}01`;
  const start = weekStart < monthStart ? weekStart : monthStart;
  const shiftStart = minutesOf(SAMPLE_SHIFT.start);

  return people.map((person) => {
    const full = Math.round(dayTargetFor({ countryCode: String(person.countryCode), employmentType: person.employmentType }) * 60);
    const holidays = new Set(holidaysForPerson(state.holidays, person.id).map((h) => h.date));
    const row: TeamSummaryOut = {
      employee_id: person.id,
      full_name: person.fullName,
      designation: person.designation,
      department: person.department,
      direct: person.managerId === managerId,
      date: today,
      status: "not_in",
      check_in: null,
      check_out: null,
      work_mode: null,
      leave_code: null,
      today_minutes: 0,
      today_target_minutes: 0,
      week_minutes: 0,
      week_target_minutes: 0,
      month_minutes: 0,
      month_target_minutes: 0,
      late_days_month: 0,
      overtime_minutes_month: 0,
      approved_overtime_hours_month: 0,
      timesheet_submitted: records.filter((r) => r.personId === person.id && r.status === "submitted").length,
      timesheet_missing_days: 0,
      pending_approvals: pendingBy.get(person.id) ?? 0,
      open_tasks: 0,
      overdue_tasks: 0,
      open_tickets: 0,
      overdue_tickets: 0,
      days: [],
    };
    for (let day = start; day <= today; day = addDaysISO(day, 1)) {
      const weekday = parseISODate(day).getDay();
      const leave = state.leaveRequests.find(
        (r) => r.employeeId === person.id && r.status === "approved" && r.from <= day && r.to >= day,
      );
      const working = leave && WFH_CODES.has(leave.code);
      let kind: string | null = null;
      let target = full;
      if (SAMPLE_SHIFT.weeklyOffDays.includes(weekday)) [kind, target] = ["weekend", 0];
      else if (holidays.has(day)) [kind, target] = ["holiday", 0];
      else if (blockingLeave(state.leaveRequests, person.id, day)) [kind, target] = ["leave", 0];
      else if (halfDayLeave(state.leaveRequests, person.id, day)) [kind, target] = ["half-day leave", Math.floor(full / 2)];
      const s = sessions.find((x) => x.employeeId === person.id && x.date === day && x.checkIn);
      const worked = s ? attendedMinutes(s) : 0;
      const closed = Boolean(s?.checkOut);
      const overtime = s && closed ? (target ? Math.max(0, worked - target) : worked) : 0;
      const late = s?.checkIn ? Math.max(0, minutesOf(hm(s.checkIn)) - shiftStart) : 0;
      const rec = records.find((r) => r.personId === person.id && r.date === day);
      if (day >= weekStart) {
        row.week_minutes += worked;
        row.week_target_minutes += target;
        if (day < today && target && !(rec && (rec.status === "submitted" || rec.status === "approved"))) row.timesheet_missing_days += 1;
      }
      if (day >= monthStart) {
        row.month_minutes += worked;
        row.month_target_minutes += target;
        row.late_days_month += late > 0 ? 1 : 0;
        row.overtime_minutes_month += overtime;
        if (withDays) {
          let hours = 0;
          for (const sheet of state.timesheets) {
            if (sheet.employeeId !== person.id) continue;
            for (const e of sheet.entries ?? []) if (e.date === day) hours += e.hours;
          }
          const d: TeamDayOut = {
            date: day,
            kind,
            leave_code: leave?.code ?? null,
            check_in: s?.checkIn ?? null,
            check_out: s?.checkOut ?? null,
            work_mode: working ? "wfh" : s ? "office" : null,
            worked_minutes: worked,
            target_minutes: target,
            late_minutes: late,
            overtime_minutes: overtime,
            timesheet_hours: Math.round(hours * 100) / 100,
            timesheet_status: rec?.status ?? "draft",
          };
          row.days.push(d);
        }
      }
      if (day === today) {
        row.today_minutes = worked;
        row.today_target_minutes = target;
        row.leave_code = leave?.code ?? null;
        row.check_in = s?.checkIn ?? null;
        row.check_out = s?.checkOut ?? null;
        if (s) row.status = closed ? "checked_out" : working ? "remote" : "checked_in";
        else if (kind === "leave" || kind === "half-day leave") row.status = "on_leave";
        else if (working) row.status = "remote";
        else if (kind === "holiday") row.status = "holiday";
        else if (kind === "weekend") row.status = "weekly_off";
      }
    }
    for (const t of state.tasks) {
      if (t.employeeId !== person.id || t.status === "done" || t.status === "scheduled") continue;
      row.open_tasks += 1;
      if (t.due && t.due < today) row.overdue_tasks += 1;
    }
    for (const t of tickets) {
      if (t.assigneeId !== person.id || !isOpenTicket(t)) continue;
      row.open_tickets += 1;
      if (t.due && t.due < today) row.overdue_tickets += 1;
    }
    return row;
  });
}
