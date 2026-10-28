/**
 * "Today's summary" on the employee, manager and HR homes: 3–5 short lines written from the person's
 * own live data (rule-based, no chat). Each builder takes numbers the home already computed.
 */
import { Link } from "react-router-dom";
import { Card } from "../../components/ui.tsx";
import { useAiSettings } from "../../data/aiSettings.ts";
import { parseISODate } from "../../model.ts";

export type SummaryLine = { text: string; to?: string };

const MAX_LINES = 5;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const day = (iso: string) => parseISODate(iso.slice(0, 10)).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
const names = (list: string[], max = 3) => (list.length <= max ? list.join(", ") : `${list.slice(0, max).join(", ")} and ${list.length - max} more`);

export function TodaySummaryCard({ lines }: { lines: SummaryLine[] }) {
  const settings = useAiSettings();
  if (settings.disabledFeatures.includes("homeSummaries") || !lines.length) return null;
  return (
    <Card title="Today's summary">
      <ul className="todo">
        {lines.slice(0, MAX_LINES).map((l) => (
          <li key={l.text}>{l.to ? <Link to={l.to}>{l.text}</Link> : l.text}</li>
        ))}
      </ul>
    </Card>
  );
}

/* ───────────── employee ───────────── */

export function employeeSummary(input: {
  today: string;
  attendanceLabel: string;
  checkIn?: string;
  checkOut?: string;
  shiftHours: string;
  offToday: string | null;
  missingCheckOut: string[];
  pendingRequests: { type: string }[];
  waitingOnMe: number;
  myUpcomingLeave?: { type: string; from: string; to: string };
  available?: { name: string; days: number };
  nextHoliday?: { name: string; date: string };
  overdueTasks: number;
  dueSoonTask?: { subject: string; due: string };
  course?: { title: string; due?: string; overdue: boolean };
  interview?: { candidate: string; role: string; when: string };
  feedbackDue: number;
  timesheet: { status: string; hours: number; olderDrafts: number; weekEnding: boolean };
}): SummaryLine[] {
  const lines: SummaryLine[] = [];
  const t = input.today;

  // Attendance.
  if (input.missingCheckOut.length) lines.push({ text: `Check-out is missing on ${names(input.missingCheckOut.map(day))} — request a correction.`, to: "/attendance" });
  else if (input.checkIn && input.checkOut) lines.push({ text: `You checked in at ${input.checkIn} and out at ${input.checkOut}.`, to: "/attendance" });
  else if (input.checkIn) lines.push({ text: `${input.attendanceLabel} since ${input.checkIn}. Shift ${input.shiftHours}.`, to: "/attendance" });
  else if (input.offToday) lines.push({ text: input.offToday });
  else if (input.attendanceLabel === "Not checked in") lines.push({ text: `You haven't checked in yet. Shift ${input.shiftHours}.`, to: "/attendance" });

  // Interviews and deadlines first — they have a time on them.
  if (input.interview) lines.push({ text: `Interview with ${input.interview.candidate} (${input.interview.role}) ${input.interview.when.slice(0, 10) === t ? "today" : `on ${day(input.interview.when)}`} at ${input.interview.when.slice(11, 16)}.`, to: "/recruiting" });
  if (input.feedbackDue) lines.push({ text: `Interview feedback is due for ${plural(input.feedbackDue, "candidate")}.`, to: "/recruiting" });
  if (input.overdueTasks) lines.push({ text: `${plural(input.overdueTasks, "task is", "tasks are")} overdue.`, to: "/tasks" });
  else if (input.dueSoonTask) lines.push({ text: `"${input.dueSoonTask.subject}" is due ${input.dueSoonTask.due === t ? "today" : day(input.dueSoonTask.due)}.`, to: "/tasks" });
  if (input.course) {
    lines.push({
      text: input.course.overdue
        ? `${input.course.title} is overdue${input.course.due ? ` (was due ${day(input.course.due)})` : ""}.`
        : `${input.course.title} is due ${input.course.due ? day(input.course.due) : "soon"}.`,
      to: "/programs",
    });
  }
  if (input.timesheet.olderDrafts) lines.push({ text: `${plural(input.timesheet.olderDrafts, "earlier timesheet week is", "earlier timesheet weeks are")} still in draft.`, to: "/timesheet" });
  else if (input.timesheet.weekEnding && input.timesheet.status !== "Submitted" && input.timesheet.status !== "Approved") {
    lines.push({ text: `This week's timesheet is ${input.timesheet.status.toLowerCase()} (${input.timesheet.hours} h) — submit it before the week ends.`, to: "/timesheet" });
  }

  // Pending items.
  if (input.waitingOnMe) lines.push({ text: `${plural(input.waitingOnMe, "item waits", "items wait")} on your approval.`, to: "/approvals" });
  if (input.pendingRequests.length) {
    const kinds = [...new Set(input.pendingRequests.map((r) => r.type.toLowerCase()))];
    lines.push({ text: `${plural(input.pendingRequests.length, "request is", "requests are")} waiting for a decision (${names(kinds)}).`, to: "/approvals?tab=mine" });
  }

  // Leave and holidays.
  if (input.myUpcomingLeave) {
    const l = input.myUpcomingLeave;
    lines.push({ text: `Your ${l.type} ${l.from <= t ? "runs" : "starts"} ${l.from <= t ? `until ${day(l.to)}` : day(l.from)}${l.from > t && l.to !== l.from ? ` to ${day(l.to)}` : ""}.`, to: "/leave" });
  } else if (input.nextHoliday && input.nextHoliday.date <= addDays(t, 14)) {
    lines.push({ text: `${input.nextHoliday.name} is ${input.nextHoliday.date === t ? "today" : `on ${day(input.nextHoliday.date)}`}.`, to: "/holidays" });
  } else if (input.available) {
    lines.push({ text: `You have ${plural(input.available.days, "day")} of ${input.available.name} available.`, to: "/leave" });
  }

  if (!lines.length) lines.push({ text: "Nothing needs your attention today." });
  return lines.slice(0, MAX_LINES);
}

function addDays(iso: string, n: number): string {
  const d = parseISODate(iso);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/* ───────────── manager ───────────── */

export function managerSummary(input: {
  teamSize: number;
  outToday: string[];
  wfhToday: number;
  notCheckedIn: number;
  waiting: number;
  overdueApprovals: number;
  alerts: string[];
  coverage: { severity: string; text: string }[];
  upcomingLeave: { name: string; from: string }[];
}): SummaryLine[] {
  const lines: SummaryLine[] = [];
  if (!input.teamSize) return [];
  lines.push({
    text: input.outToday.length
      ? `Off today: ${names(input.outToday)}.${input.wfhToday ? ` ${input.wfhToday} working from home.` : ""}`
      : `Nobody in your team is off today${input.wfhToday ? ` (${input.wfhToday} from home)` : ""}.`,
    to: "/team",
  });
  if (input.waiting) {
    lines.push({
      text: `${plural(input.waiting, "approval waits", "approvals wait")} on you${input.overdueApprovals ? ` — ${input.overdueApprovals} older than 3 days` : ""}.`,
      to: "/approvals",
    });
  } else lines.push({ text: "No approvals are waiting on you." });
  if (input.alerts.length) lines.push({ text: `${plural(input.alerts.length, "item needs", "items need")} follow-up: ${input.alerts[0]}${input.alerts.length > 1 ? ` and ${input.alerts.length - 1} more` : ""}.` });
  const risk = input.coverage.find((c) => c.severity === "High") ?? input.coverage[0];
  if (risk) lines.push({ text: `Coverage gap: ${risk.text}` });
  else if (input.upcomingLeave.length) lines.push({ text: `Next team leave: ${input.upcomingLeave[0].name} from ${day(input.upcomingLeave[0].from)}.`, to: "/leave" });
  if (input.notCheckedIn > 0 && lines.length < MAX_LINES) lines.push({ text: `${plural(input.notCheckedIn, "person hasn't", "people haven't")} checked in yet.`, to: "/attendance" });
  return lines.slice(0, MAX_LINES);
}

/* ───────────── HR ───────────── */

export function hrSummary(input: {
  scopeName?: string;
  joinedThisWeek: string[];
  startingSoon: number;
  leavingSoon: { name: string; date: string }[];
  resignationsOpen: number;
  overdueActions: { kind: string }[];
  openActions: number;
  waiting: number;
  highRisks: number;
}): SummaryLine[] {
  const lines: SummaryLine[] = [];
  const where = input.scopeName ? ` in ${input.scopeName}` : "";
  if (input.joinedThisWeek.length || input.startingSoon) {
    lines.push({
      text: `${input.joinedThisWeek.length ? `${plural(input.joinedThisWeek.length, "person", "people")} joined${where} this week (${names(input.joinedThisWeek)})` : `No joiners${where} this week`}${input.startingSoon ? `; ${input.startingSoon} more start in the next 7 days` : ""}.`,
      to: "/onboarding",
    });
  }
  if (input.leavingSoon.length) {
    const first = input.leavingSoon[0];
    lines.push({
      text: `${plural(input.leavingSoon.length, "person leaves", "people leave")} in the next 2 weeks — first ${first.name} on ${day(first.date)}.`,
      to: "/people/exits",
    });
  } else if (input.resignationsOpen) lines.push({ text: `${plural(input.resignationsOpen, "resignation is", "resignations are")} in progress.`, to: "/people/exits" });
  if (input.overdueActions.length) {
    const kinds = [...input.overdueActions.reduce((m, a) => m.set(a.kind, (m.get(a.kind) ?? 0) + 1), new Map<string, number>())].map(([k, n]) => `${k.toLowerCase()} ${n}`);
    lines.push({ text: `${plural(input.overdueActions.length, "HR action is", "HR actions are")} past due (${names(kinds)}).` });
  } else if (input.openActions) lines.push({ text: `${plural(input.openActions, "HR action is", "HR actions are")} open, none past due.` });
  lines.push({ text: input.waiting ? `${plural(input.waiting, "approval waits", "approvals wait")} on you.` : "No approvals are waiting on you.", to: input.waiting ? "/approvals" : undefined });
  if (input.highRisks) lines.push({ text: `${plural(input.highRisks, "team has", "teams have")} a high coverage risk this week.` });
  return lines.slice(0, MAX_LINES);
}
