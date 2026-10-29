import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { countUnreadNotificationsFor } from "../../data/notificationFeed.ts";
import { Link } from "react-router-dom";
import { COMPANY_NAME } from "../../brand.ts";
import { ActionButton, Card, DataTable, LeaveTable, MetricCard, MetricGrid, StatusBadge, StatusPill } from "../../components/ui.tsx";
import { DEMO_ACCOUNTS, accountHasNavAccess, type DemoAccount } from "../../demoAccounts.ts";
import { COURSES } from "../../data/talentData.ts";
import { getTalentState, requisitionApprovers, subscribeTalent } from "../../data/talentLocal.ts";
import { useProfileCorrections } from "../../data/profileCorrections.ts";
import { canDecide as canDecideLifecycle, getLifecycleActions, subscribeLifecycleActions } from "../../features/lifecycle/lifecycleActionsStore.ts";
import { listPeople, subscribePeople, getExitDetails } from "../../data/peopleLocal.ts";
import { TASK_TEAM } from "../../data/taskTeam.ts";
import { inHeadcount } from "../../data/peopleData.ts";
import { getPlatformVersion, listAuditLog, listIntegrations, subscribePlatform } from "../../data/platformLocal.ts";
import {
  dayStatus,
  personName,
  rangeLabel,
  rangeStart,
  teamBelow,
  tenureLabel,
  upcomingHolidays,
  waitingItems,
  workforceInsights,
  workforceStats,
  type DayStatus,
  type RangeKey,
  type TeamMember,
} from "../../data/workforceStats.ts";
import {
  attendanceTrend,
  compReviewStatus,
  criticalSkillGaps,
  currentCycle,
  goalProgressFor,
  learningCompletion,
  leaveTrend,
  pipelineFunnel,
  reviewStatusFor,
  skillCoverage,
  weightedProgress,
} from "../../data/homeInsights.ts";
import { useHomeLayout } from "../../data/preferences.ts";
import { getRewardState, subscribeReward } from "../../data/rewardLocal.ts";
import { canApproveCompReviews } from "../../data/rbac.ts";
import { attendanceContextFor, formatHm, nonWorkingReason, phaseLabel } from "../../data/attendanceData.ts";
import {
  attendanceActionAsync,
  getAttendanceState,
  getCurrentSession,
  missingCheckOutSessions,
  subscribeAttendance,
} from "../../data/attendanceLocal.ts";
import {
  getCollabState,
  listNotificationsForRole,
  notifPrefsFor,
  subscribeCollab,
} from "../../data/collabLocal.ts";
import { notifPrefKey } from "../../data/collabData.ts";
import { getExitState, subscribeExits } from "../../features/lifecycle/exitStore.ts";
import { getProbationState, subscribeProbation, trackedProbations } from "../../features/lifecycle/probationStore.ts";
import { getBgvState, overallResult, subscribeBgv } from "../../features/compliance/bgvStore.ts";
import { docStatus, getImmigrationState, subscribeImmigration } from "../../features/compliance/immigrationStore.ts";
import {
  TIMEZ_COUNTRIES,
  addDaysISO,
  attendanceOn,
  dayGreeting,
  formatLongDate,
  formatShortDate,
  mondayOf,
  todayISO,
  type CountryCode,
} from "../../model.ts";
import { RegionalFilter } from "../../locale/RegionalFilter.tsx";
import { useLocale } from "../../locale/LocaleContext.tsx";
import { usePortal } from "../../store.tsx";
import { countWaitingOnMe } from "../ApprovalsCenter.tsx";
import { AuthShortcuts, DashGreeting, DateRangeFilter, MiniBars, ProgressBar, useDateRange } from "./widgets.tsx";
import {
  CoverageRisksCard,
  HeadcountAnalysisCard,
  LateArrivalsCard,
  NewHiringCard,
  OfferAcceptanceCard,
  TeamCoverCard,
  TimeToHireCard,
  WhereTeamWorksCard,
} from "./HrInsightCards.tsx";
import { attendanceSample, lateArrivals, teamAbsence, teamWorkplace } from "../../data/hrAnalytics.ts";
import { BarChart, ChartEmpty, DonutChart, HBarChart, LineChart, paletteColor } from "./charts.tsx";
import { countInto, dailyCounts, monthlyMovement } from "../../data/adminCharts.ts";
import { useAuditTrail } from "../../data/auditTrail.ts";
import { TICKET_STATUSES, useTickets } from "../../data/ticketStore.ts";
import { TodaySummaryCard, employeeSummary, hrSummary, managerSummary } from "../../features/copilot/homeSummary.tsx";
import { OnboardingHomeCard } from "../../features/onboarding/OnboardingAnalytics.tsx";

/** Map dashboard shortcut labels to real routes. */
const R = {
  performance: "/evaluations",
  learning: "/programs",
  skills: "/skills",
  admin: "/admin",
  approvals: "/approvals",
  notifications: "/notifications",
  payslips: "/payslips",
  leave: "/leave",
  attendance: "/attendance",
  timesheet: "/timesheet",
  documents: "/documents",
  benefits: "/benefits",
  expenses: "/expenses",
  profile: "/info",
  tasks: "/tasks",
  help: "/help",
  directory: "/directory",
  holidays: "/holidays",
  messages: "/chat",
  copilot: "/ai/copilot",
  onboarding: "/onboarding",
  exits: "/people/exits",
  bgv: "/talent/background-checks",
  recruiting: "/recruiting",
  probation: "/team/probation",
} as const;

const DAY_TONE: Record<DayStatus, "ok" | "info" | "warn" | "neutral"> = {
  Working: "ok",
  WFH: "info",
  "On leave": "warn",
  Holiday: "neutral",
  "Weekly off": "neutral",
};

const VISA_TYPES = new Set(["Visa", "Work permit", "Residence ID/Iqama", "Emirates ID", "BRP/UK right-to-work", "Aufenthaltstitel"]);

/* ───────────────────────────── shared building blocks ── */

type Section = { id: string; label: string; node: ReactNode };

/**
 * Renders sections in the person's chosen order. useHomeLayout memoises on ids/labels only,
 * so we map its order back onto this render's fresh nodes to keep the content live.
 */
function HomeSections({ userId, sections }: { userId: string; sections: Section[] }) {
  const ordered = useHomeLayout(userId, sections);
  const byId = new Map(sections.map((s) => [s.id, s]));
  return (
    <div className="mgr-home-grid">
      {ordered.map((s) => {
        const fresh = byId.get(s.id);
        return fresh ? <div key={fresh.id} style={{ display: "contents" }}>{fresh.node}</div> : null;
      })}
    </div>
  );
}

function useTitle(title: string) {
  useEffect(() => {
    document.title = `${title} · ${COMPANY_NAME}`;
  }, [title]);
}

/** Live data every home needs: people below me, what waits on me, my country's holidays. */
function useHomeData() {
  const { employee, state, canDecideFor, canVerifyProofs } = usePortal();
  const people = useSyncExternalStore(subscribePeople, listPeople, listPeople);
  const talent = useSyncExternalStore(subscribeTalent, getTalentState, getTalentState);
  const attState = useSyncExternalStore(subscribeAttendance, getAttendanceState, getAttendanceState);
  const today = todayISO();
  const team = useMemo(
    () => teamBelow(employee.id, people, canDecideFor, TASK_TEAM.map((p) => p.id)),
    [employee.id, people, canDecideFor],
  );
  const statuses = team.map((m) => ({ member: m, status: dayStatus(state, m.id, m.countryCode, today) }));
  const waitingCount = countWaitingOnMe(state, employee.id, canDecideFor, canVerifyProofs);
  const waiting = waitingItems(state, employee.id, canDecideFor, canVerifyProofs);
  const holidays = upcomingHolidays(state.holidays, employee.countryCode, today, 3);
  const teamNames = new Set([employee.fullName, ...team.map((m) => m.name)]);
  const openReqs = talent.requisitions.filter((r) => r.approvalStatus === "Approved" && r.stageSummary !== "Hired" && r.stageSummary !== "Filled");
  const teamReqs = openReqs.filter((r) => teamNames.has(r.hiringManager));
  return { people, talent, attState, today, team, statuses, waitingCount, waiting, holidays, openReqs, teamReqs };
}

function MyApprovalsCard({ waiting, count, people }: { waiting: ReturnType<typeof waitingItems>; count: number; people: ReturnType<typeof listPeople> }) {
  const byKind = [...waiting.reduce((m, w) => m.set(w.kind, (m.get(w.kind) ?? 0) + 1), new Map<string, number>())];
  return (
    <Card title={`My approvals · ${count}`} to={R.approvals}>
      {count === 0 ? (
        <p className="note">Nothing is waiting on you.</p>
      ) : (
        <>
          <ul className="todo">
            {byKind.map(([kind, n]) => (
              <li key={kind}>
                {kind} <StatusBadge status={String(n)} tone="warn" literal />
              </li>
            ))}
          </ul>
          <DataTable
            headers={["Person", "Type", "Date"]}
            rows={waiting.slice(0, 4).map((w) => [personName(w.employeeId, people), `${w.kind} · ${w.detail}`, w.date ? formatShortDate(w.date) : "—"])}
          />
        </>
      )}
      <Link to={R.approvals} className="quiet-link">
        Open Approvals
      </Link>
    </Card>
  );
}

/** Self-service strip for people whose home is mostly about others. */
function MyDayCard() {
  const { employee, leaveTable, state } = usePortal();
  const attState = useSyncExternalStore(subscribeAttendance, getAttendanceState, getAttendanceState);
  const today = todayISO();
  const session = getCurrentSession(employee.id, attState);
  const status = dayStatus(state, employee.id, employee.countryCode ?? "IN", today);
  const next = upcomingHolidays(state.holidays, employee.countryCode, today, 1)[0];
  const rows = leaveTable.filter((r) => r.code !== "unpaid" && r.quota > 0).slice(0, 3);
  return (
    <Card title="My day">
      <p>
        {session.phase !== "not_started" ? phaseLabel(session.phase) : status === "Working" ? "Not checked in" : status}
        {session.checkIn ? ` · in ${formatHm(session.checkIn)}` : ""} · {employee.shiftHours}
      </p>
      <ul className="todo">
        {rows.map((r) => (
          <li key={r.code}>
            {r.name}: <strong>{r.available}</strong> days available
          </li>
        ))}
        <li>Next holiday: {next ? `${next.name} · ${formatShortDate(next.date)}` : "None this year"}</li>
      </ul>
      <div className="row-gap" style={{ marginTop: 10 }}>
        <Link className="btn" to={R.attendance}>
          {session.phase === "not_started" ? "Check in" : "Attendance"}
        </Link>
        <Link className="btn-ghost" to={R.leave}>
          Apply for leave
        </Link>
      </div>
    </Card>
  );
}

function TeamTodayCard({
  statuses,
  title = "Team today",
  checkedIn,
}: {
  statuses: { member: TeamMember; status: DayStatus }[];
  title?: string;
  checkedIn?: Set<string>;
}) {
  const shown = statuses.slice(0, 10);
  const count = (s: DayStatus) => statuses.filter((x) => x.status === s).length;
  const expected = statuses.filter((x) => x.status === "Working" || x.status === "WFH");
  return (
    <Card title={title} to="/team">
      {statuses.length > 0 && (
        <p className="muted">
          {count("Working")} in office · {count("WFH")} WFH · {count("On leave")} on leave
          {checkedIn ? ` · ${expected.filter((x) => checkedIn.has(x.member.id)).length} of ${expected.length} checked in` : ""}
        </p>
      )}
      <DataTable
        headers={["Name", "Role", "Today"]}
        rows={shown.map(({ member, status }) => [
          <Link key={member.id} to={`/people/${member.id}`}>
            {member.name}
          </Link>,
          member.designation,
          <StatusBadge
            key={`${member.id}-s`}
            status={checkedIn?.has(member.id) && (status === "Working" || status === "WFH") ? `${status} · in` : status}
            tone={DAY_TONE[status]}
            literal
          />,
        ])}
        empty={<p className="note">Nobody reports to you.</p>}
      />
      {statuses.length > shown.length && <p className="note">Showing {shown.length} of {statuses.length}.</p>}
    </Card>
  );
}

function HolidaysCard({ holidays, countryName }: { holidays: { id: string; date: string; name: string }[]; countryName?: string }) {
  return (
    <Card title={`Upcoming holidays${countryName ? ` · ${countryName}` : ""}`} to={R.holidays}>
      <ul className="todo">
        {holidays.length ? holidays.map((h) => <li key={h.id}>{h.name} · {formatShortDate(h.date)}</li>) : <li>None this year</li>}
      </ul>
    </Card>
  );
}

function teamMetrics(team: TeamMember[], statuses: { status: DayStatus }[]) {
  const working = statuses.filter((s) => s.status === "Working" || s.status === "WFH").length;
  const onLeave = statuses.filter((s) => s.status === "On leave").length;
  const wfh = statuses.filter((s) => s.status === "WFH").length;
  return { direct: team.filter((m) => m.direct).length, working, onLeave, wfh };
}

/** Country filter for org-wide homes: the shared top-bar region. */
function useRegionFilter(): CountryCode | "ALL" {
  const { regionCode } = useLocale();
  return regionCode === "ALL" ? "ALL" : (regionCode as CountryCode);
}

function countryNameOf(code: string | undefined): string | undefined {
  return TIMEZ_COUNTRIES.find((c) => c.code === code)?.name;
}

/* ───────────────────────────────────────────── EMPLOYEE ── */

type OwnRequest = { id: string; type: string; detail: string; date: string; to: string };

export function EmployeeHome() {
  const { employee, leaveTable, counts, payslipViews, currentProjects, state, demoProfile } = usePortal();
  const data = useHomeData();
  const { talent, attState, today } = data;
  useSyncExternalStore(subscribeCollab, getCollabState, getCollabState);
  const [punchError, setPunchError] = useState<string | null>(null);
  const pto = leaveTable.find((row) => row.code === "pto");
  const wfh = leaveTable.find((row) => row.code === "wfh");
  const dayContext = useMemo(
    () => attendanceContextFor(employee, state.holidays, state.leaveRequests),
    [employee, state.holidays, state.leaveRequests],
  );
  const session = getCurrentSession(employee.id, attState);
  const missingOut = missingCheckOutSessions(employee.id, attState);
  const offToday = session.phase === "not_started" ? nonWorkingReason(employee.id, today, dayContext) : null;
  const myOpenTasks = state.tasks.filter(
    (task) => task.employeeId === employee.id && (task.status === "open" || task.status === "progress"),
  );
  const urgentTask = myOpenTasks.find((t) => t.priority === "urgent" || t.priority === "high") ?? myOpenTasks[0];
  const me = data.people.find((p) => p.id === employee.id);
  const managerId = demoProfile.reportsToId || me?.managerId;
  const managerName = managerId ? personName(managerId, data.people) : undefined;
  const balanceRows = leaveTable.filter((row) => row.code !== "unpaid");
  const todayAtt = attendanceOn(today, dayContext.holidays, state.leaveRequests, [], employee.shiftHours, today, employee.id, dayContext.weeklyOffDays);
  const attendanceLabel =
    session.phase !== "not_started"
      ? phaseLabel(session.phase)
      : todayAtt.kind === "leave"
        ? "On leave"
        : todayAtt.kind === "holiday"
          ? "Holiday"
          : todayAtt.kind === "weekend"
            ? "Weekly off"
            : "Not checked in";

  // Own open requests across every self-service flow.
  const mine = <T extends { employeeId: string }>(list: T[]) => list.filter((x) => x.employeeId === employee.id);
  const requests: OwnRequest[] = [
    ...mine(state.leaveRequests)
      .filter((r) => r.status === "pending")
      .map((r) => ({ id: r.id, type: "Leave", detail: `${r.code.toUpperCase()} · ${formatShortDate(r.from)}${r.to !== r.from ? ` → ${formatShortDate(r.to)}` : ""}`, date: r.appliedOn, to: R.leave })),
    ...mine(state.backdatedPermissions)
      .filter((r) => r.status === "pending")
      .map((r) => ({ id: r.id, type: "Past-date leave", detail: "Permission request", date: (r as { from?: string }).from ?? "", to: R.leave })),
    ...mine(state.encashments)
      .filter((r) => r.status === "pending")
      .map((r) => ({ id: r.id, type: "Encashment", detail: `${r.days} days`, date: r.appliedOn, to: R.leave })),
    ...mine(state.expenses)
      .filter((r) => r.status === "submitted")
      .map((r) => ({ id: r.id, type: "Expense", detail: r.category, date: r.date, to: R.expenses })),
    ...mine(state.reimbursements)
      .filter((r) => r.status === "submitted")
      .map((r) => ({ id: r.id, type: "Reimbursement", detail: r.category, date: r.date, to: "/reimbursement" })),
    ...mine(state.cashAdvances)
      .filter((r) => r.status === "pending")
      .map((r) => ({ id: r.id, type: "Cash advance", detail: r.category, date: r.date, to: R.expenses })),
    ...mine(state.assetRequests)
      .filter((r) => r.status === "pending")
      .map((r) => ({ id: r.id, type: "Asset", detail: r.item, date: r.date, to: R.help })),
    ...mine(state.softwareRequests)
      .filter((r) => r.status === "pending")
      .map((r) => ({ id: r.id, type: "Software", detail: r.software, date: r.date, to: R.help })),
    ...mine(state.cabBookings)
      .filter((r) => r.status === "pending")
      .map((r) => ({ id: r.id, type: "Cab", detail: r.to, date: r.date, to: R.help })),
    ...mine(state.investmentProofs)
      .filter((r) => r.status === "submitted")
      .map((r) => ({ id: r.id, type: "Tax proof", detail: r.section, date: r.submittedOn, to: "/investment" })),
  ].sort((a, b) => b.date.localeCompare(a.date));

  // This week's timesheet.
  const week = mondayOf(today);
  const weekSheets = state.timesheets.filter((t) => t.employeeId === employee.id && t.weekStart === week);
  const weekHours = weekSheets.reduce((n, t) => n + Object.values(t.hours).reduce((a, b) => a + b, 0), 0);
  const weekStatus = !weekSheets.length
    ? "Not started"
    : weekSheets.some((t) => t.status === "draft")
      ? "Draft"
      : weekSheets.every((t) => t.status === "approved")
        ? "Approved"
        : "Submitted";
  const olderDrafts = state.timesheets.filter((t) => t.employeeId === employee.id && t.weekStart < week && t.status === "draft").length;

  // Goals and learning.
  const cycle = currentCycle(talent);
  const myGoals = talent.goals.filter((g) => g.ownerId === employee.id && g.cycleId === cycle.id);
  const myEnrollments = talent.enrollments.filter((e) => e.employeeId === employee.id);
  const openCourses = myEnrollments
    .filter((e) => e.status !== "Completed")
    .sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999"));
  const learning = learningCompletion(myEnrollments, undefined, today);

  // Documents and notifications.
  const myDocs = state.documents
    .filter((d) => d.employeeId === employee.id)
    .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt))
    .slice(0, 4);
  const prefs = notifPrefsFor(employee.id);
  const myNotes = listNotificationsForRole(demoProfile.role, employee.id)
    .filter((n) => prefs[notifPrefKey(n.category)] !== false)
    .sort((a, b) => b.at.localeCompare(a.at));
  const unread = countUnreadNotificationsFor(employee.id, state, demoProfile.role);

  function punch(action: "check_in" | "end_break" | "check_out") {
    return attendanceActionAsync(employee.id, action, dayContext).then((error) => {
      setPunchError(error);
      return error;
    });
  }

  // Today's summary — short lines from the same data as the cards below.
  const soon = addDaysISO(today, 14);
  const myNextLeave = state.leaveRequests
    .filter((r) => r.employeeId === employee.id && r.status === "approved" && r.to >= today && r.from <= soon)
    .sort((a, b) => a.from.localeCompare(b.from))[0];
  const myInterviews = talent.interviews.filter((i) => i.panel.includes(employee.fullName));
  const nextInterview = myInterviews
    .filter((i) => i.when.slice(0, 10) >= today && i.when.slice(0, 10) <= addDaysISO(today, 2))
    .sort((a, b) => a.when.localeCompare(b.when))[0];
  const dueCourse = openCourses.find((e) => e.due && e.due <= soon);
  const dueTask = myOpenTasks
    .filter((t) => t.due && t.due >= today && t.due <= addDaysISO(today, 3))
    .sort((a, b) => (a.due ?? "").localeCompare(b.due ?? ""))[0];
  const summaryLines = employeeSummary({
    today,
    attendanceLabel,
    checkIn: session.checkIn ? formatHm(session.checkIn) : undefined,
    checkOut: session.checkOut ? formatHm(session.checkOut) : undefined,
    shiftHours: employee.shiftHours,
    offToday,
    missingCheckOut: missingOut.map((s) => s.date),
    pendingRequests: requests,
    waitingOnMe: data.waitingCount,
    myUpcomingLeave: myNextLeave
      ? { type: leaveTable.find((l) => l.code === myNextLeave.code)?.name ?? myNextLeave.code.toUpperCase(), from: myNextLeave.from, to: myNextLeave.to }
      : undefined,
    available: pto ? { name: pto.name, days: pto.available } : undefined,
    nextHoliday: data.holidays[0] ? { name: data.holidays[0].name, date: data.holidays[0].date } : undefined,
    overdueTasks: myOpenTasks.filter((t) => t.due && t.due < today).length,
    dueSoonTask: dueTask?.due ? { subject: dueTask.subject, due: dueTask.due } : undefined,
    course: dueCourse
      ? { title: COURSES.find((c) => c.id === dueCourse.courseId)?.title ?? "A course", due: dueCourse.due, overdue: Boolean(dueCourse.due && dueCourse.due < today) }
      : undefined,
    interview: nextInterview ? { candidate: nextInterview.candidateName, role: nextInterview.role, when: nextInterview.when } : undefined,
    feedbackDue: myInterviews.filter((i) => i.when.slice(0, 10) < today && i.feedbackStatus === "Pending").length,
    timesheet: { status: weekStatus, hours: weekHours, olderDrafts, weekEnding: [4, 5].includes(new Date().getDay()) },
  });

  useTitle("Home");

  const sections: Section[] = [
    ...(data.team.length > 0 || data.waitingCount > 0
      ? [{ id: "approvals", label: "My approvals", node: <MyApprovalsCard waiting={data.waiting} count={data.waitingCount} people={data.people} /> }]
      : []),
    {
      id: "profile",
      label: "My profile",
      node: (
        <Card title="My profile" to={R.profile}>
          <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
            <img src={employee.photo} alt="" width={56} height={56} className="avatar" style={{ objectFit: "cover", flexShrink: 0 }} />
            <div style={{ minWidth: 0 }}>
              <strong>{employee.fullName}</strong>
              <p className="muted">
                {employee.designation}
                {employee.department ? ` · ${employee.department}` : ""}
              </p>
              <p className="muted">
                {employee.employeeCode} · {employee.location ? `${employee.location}, ` : ""}
                {employee.countryName}
              </p>
            </div>
          </div>
          <ul className="todo" style={{ marginTop: 10 }}>
            <li>Manager: {managerId && managerName ? <Link to={`/people/${managerId}`}>{managerName}</Link> : "—"}</li>
            <li>Joined: {me?.dateOfJoining ? `${formatShortDate(me.dateOfJoining)} · ${tenureLabel(me.dateOfJoining, today)}` : "—"}</li>
          </ul>
          <Link className="btn-ghost" to={R.profile} style={{ marginTop: 8, display: "inline-flex" }}>
            View profile
          </Link>
        </Card>
      ),
    },
    {
      id: "attendance",
      label: "Today's attendance",
      node: (
        <Card title="Today's attendance" to={R.attendance}>
          <p>
            <StatusBadge status={attendanceLabel} tone={session.phase === "checked_in" ? "ok" : session.phase === "on_break" ? "warn" : undefined} literal />
          </p>
          <p className="muted">
            {session.checkIn ? `In ${formatHm(session.checkIn)}` : "No check-in yet"}
            {session.checkOut ? ` · Out ${formatHm(session.checkOut)}` : ""} · Shift {employee.shiftHours}
          </p>
          {missingOut.length > 0 && (
            <p className="note warn" style={{ marginTop: 8 }}>
              Missing check-out on {missingOut.map((s) => formatShortDate(s.date)).join(", ")} — <Link to={R.attendance}>request a correction</Link>.
            </p>
          )}
          {offToday && <p className="note" style={{ marginTop: 8 }}>{offToday}</p>}
          {punchError && (
            <p className="note err" role="alert">
              {punchError}
            </p>
          )}
          <div className="row-gap" style={{ marginTop: 10 }}>
            {session.phase === "not_started" && !offToday && (
              <ActionButton className="btn" success="Checked in." onAction={() => punch("check_in")}>
                Check in
              </ActionButton>
            )}
            {session.phase === "on_break" && (
              <ActionButton className="btn" success="Break ended." busyLabel="Ending break…" doneLabel="Back to work" onAction={() => punch("end_break")}>
                End break
              </ActionButton>
            )}
            {session.phase === "checked_in" && (
              <ActionButton className="btn" success="Checked out." onAction={() => punch("check_out")}>
                Check out
              </ActionButton>
            )}
            <Link className="btn-ghost" to={R.attendance}>
              History
            </Link>
          </div>
        </Card>
      ),
    },
    {
      id: "leave",
      label: "Leave balance",
      node: (
        <Card title="Leave balance" to={R.leave}>
          <LeaveTable rows={balanceRows} />
          <Link className="btn-ghost" to={R.leave} style={{ marginTop: 10, display: "inline-flex" }}>
            Apply for leave
          </Link>
        </Card>
      ),
    },
    { id: "holidays", label: "Upcoming holidays", node: <HolidaysCard holidays={data.holidays} countryName={employee.countryName} /> },
    {
      id: "requests",
      label: "Pending requests",
      node: (
        <Card title={`Pending requests · ${requests.length}`}>
          <DataTable
            headers={["Type", "Detail", "Date"]}
            rows={requests.slice(0, 5).map((r) => [
              <Link key={r.id} to={r.to}>
                {r.type}
              </Link>,
              r.detail,
              r.date ? formatShortDate(r.date.slice(0, 10)) : "—",
            ])}
            empty={<p className="note">You have no open requests.</p>}
          />
          {requests.length > 5 && <p className="note">Showing 5 of {requests.length}.</p>}
        </Card>
      ),
    },
    {
      id: "tasks",
      label: "My tasks",
      node: (
        <Card title={`My tasks · ${myOpenTasks.length}`} to={R.tasks}>
          <ul className="todo">
            {myOpenTasks.length ? (
              myOpenTasks.slice(0, 4).map((t) => (
                <li key={t.id}>
                  <Link to={R.tasks}>
                    {t.code} · {t.subject}
                  </Link>{" "}
                  {t.due && t.due < today ? <StatusBadge status="Overdue" tone="danger" literal /> : null}
                </li>
              ))
            ) : (
              <li>No open tasks</li>
            )}
          </ul>
        </Card>
      ),
    },
    {
      id: "timesheet",
      label: "Timesheet",
      node: (
        <Card title="Timesheet" to={R.timesheet}>
          <p>
            Week of {formatShortDate(week)} · <strong>{weekHours} h</strong> <StatusBadge status={weekStatus} literal />
          </p>
          <p className="muted">Project: {currentProjects[0]?.name ?? "No active assignment"}</p>
          {olderDrafts > 0 && <p className="note warn">{olderDrafts} earlier week{olderDrafts === 1 ? "" : "s"} still in draft.</p>}
          <Link to={R.timesheet} className="btn" style={{ marginTop: 10, display: "inline-flex" }}>
            Open timesheet
          </Link>
        </Card>
      ),
    },
    {
      id: "goals",
      label: "Goals",
      node: (
        <Card title={`Goals · ${cycle.name}`} to={R.performance}>
          {myGoals.length ? (
            <>
              <ProgressBar value={weightedProgress(myGoals)} label="Overall (weighted)" />
              {myGoals.map((g) => (
                <ProgressBar key={g.id} value={g.progress} label={`${g.title} · ${g.weight}%`} />
              ))}
            </>
          ) : (
            <p className="note">No goals set for this cycle.</p>
          )}
        </Card>
      ),
    },
    {
      id: "learning",
      label: "Learning",
      node: (
        <Card title="Learning" to={R.learning}>
          {learning.total ? (
            <>
              <ProgressBar value={learning.pct} label={`${learning.completed} of ${learning.total} completed`} />
              <ul className="todo">
                {openCourses.slice(0, 3).map((e) => (
                  <li key={e.id}>
                    <Link to={R.learning}>
                      {COURSES.find((c) => c.id === e.courseId)?.title ?? "Course"} · {e.progress}%
                    </Link>
                    {e.due ? ` · due ${formatShortDate(e.due)}` : ""} {e.due && e.due < today ? <StatusBadge status="Overdue" tone="danger" literal /> : null}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="note">No courses assigned.</p>
          )}
        </Card>
      ),
    },
    {
      id: "documents",
      label: "Documents",
      node: (
        <Card title="Documents & letters" to={R.documents}>
          <DataTable
            headers={["Document", "Type", "Added"]}
            rows={myDocs.map((d) => [
              <Link key={d.id} to={R.documents}>
                {d.name}
              </Link>,
              d.docType || d.category,
              formatShortDate(d.uploadedAt.slice(0, 10)),
            ])}
            empty={<p className="note">No documents yet.</p>}
          />
        </Card>
      ),
    },
    {
      id: "notifications",
      label: "Notifications",
      node: (
        <Card title={`Notifications · ${unread} unread`} to={R.notifications}>
          <ul className="todo">
            {myNotes.length ? (
              myNotes.slice(0, 3).map((n) => (
                <li key={n.id}>
                  <Link to={n.href || R.notifications}>
                    {n.readBy.includes(employee.id) ? n.title : <strong>{n.title}</strong>}
                  </Link>
                  <span className="muted"> · {formatShortDate(n.at.slice(0, 10))}</span>
                </li>
              ))
            ) : (
              <li>No notifications</li>
            )}
          </ul>
        </Card>
      ),
    },
    {
      id: "pay",
      label: "Pay & benefits",
      node: (
        <Card title="Pay & benefits" to={R.payslips}>
          <ul className="todo">
            <li>
              <Link to={R.payslips}>Latest payslip · {payslipViews[0]?.label ?? "—"}</Link>
            </li>
            <li>
              <Link to={R.benefits}>Benefits enrollment</Link>
            </li>
            <li>
              <Link to={R.expenses}>Reimbursement claims</Link>
            </li>
          </ul>
        </Card>
      ),
    },
  ];

  return (
    <div className="stack">
      <DashGreeting
        title={dayGreeting(employee.fullName)}
        subtitle={`${employee.designation} · ${formatLongDate(today)} · ${employee.timeZone} · ${employee.countryName ?? ""}`}
      />

      <TodaySummaryCard lines={summaryLines} />

      <div className="emp-quick-actions" aria-label="Quick actions">
        <Link className="btn" to={R.leave}>
          Apply for leave
        </Link>
        <Link className="btn" to={R.timesheet}>
          Submit timesheet
        </Link>
        <Link className="btn-ghost" to={R.attendance}>
          Correct attendance
        </Link>
        <Link className="btn-ghost" to={R.payslips}>
          Open payslip
        </Link>
      </div>

      <MetricGrid>
        <Link to={R.attendance} className="metric-card-link">
          <MetricCard
            label="Today's attendance"
            value={attendanceLabel}
            hint={
              session.checkIn
                ? `In ${formatHm(session.checkIn)}${session.checkOut ? ` · Out ${formatHm(session.checkOut)}` : ""} · ${employee.shiftHours}`
                : employee.shiftHours
            }
          />
        </Link>
        <Link to={R.leave} className="metric-card-link">
          <MetricCard label="Leave balance" value={pto?.available ?? "—"} hint={`${pto?.name ?? "Leave"} available · WFH ${wfh?.available ?? "—"}`} />
        </Link>
        <Link to={R.tasks} className="metric-card-link">
          <MetricCard label="Open tasks" value={myOpenTasks.length} hint={urgentTask ? urgentTask.subject : "You're all caught up"} />
        </Link>
        <Link to={R.timesheet} className="metric-card-link">
          <MetricCard label="Timesheet" value={counts.timesheet > 0 ? "Action needed" : "Up to date"} hint={`This week · ${weekHours} h`} />
        </Link>
      </MetricGrid>

      <HomeSections userId={employee.id} sections={sections} />
    </div>
  );
}

/* ───────────────────────────────────────────── MANAGER ── */

export function ManagerHome() {
  const { employee, state, demoProfile } = usePortal();
  const data = useHomeData();
  const { talent, attState, today } = data;
  const probation = useSyncExternalStore(subscribeProbation, getProbationState, getProbationState);
  const immigration = useSyncExternalStore(subscribeImmigration, getImmigrationState, getImmigrationState);
  const m = teamMetrics(data.team, data.statuses);
  const teamIds = useMemo(() => new Set(data.team.map((t) => t.id)), [data.team]);
  const peopleById = useMemo(() => new Map(data.people.map((p) => [p.id, p])), [data.people]);
  const checkedIn = new Set(
    attState.sessions.filter((s) => s.date === today && s.phase !== "not_started" && teamIds.has(s.employeeId)).map((s) => s.employeeId),
  );
  const workplace = teamWorkplace(
    data.statuses.map((x) => ({ id: x.member.id, name: x.member.name, status: x.status })),
    peopleById,
    checkedIn,
  );
  const leaveQueue = state.leaveRequests.filter((r) => r.status === "pending" && data.waiting.some((w) => w.id === r.id));
  const timesheetQueue = data.waiting.filter((w) => w.kind === "Timesheet");
  const upcomingLeave = state.leaveRequests
    .filter((r) => teamIds.has(r.employeeId) && r.status === "approved" && r.to >= today)
    .sort((a, b) => a.from.localeCompare(b.from))
    .slice(0, 5);
  const openings = data.teamReqs.reduce((n, r) => n + r.openings, 0);

  const cycle = currentCycle(talent);
  const goals = goalProgressFor(talent.goals, teamIds, cycle, today);
  const reviews = reviewStatusFor(talent.reviews, teamIds, cycle.id);
  const skills = useMemo(() => skillCoverage(talent, data.team), [talent, data.team]);
  const joinedFrom = addDaysISO(today, -90);
  const joiners = data.team
    .map((t) => ({ member: t, doj: peopleById.get(t.id)?.dateOfJoining ?? "" }))
    .filter((x) => x.doj >= joinedFrom && x.doj <= today)
    .sort((a, b) => b.doj.localeCompare(a.doj));

  // Team alerts.
  const threeDaysAgo = addDaysISO(today, -3);
  const appliedOn = new Map(state.leaveRequests.map((r) => [r.id, r.appliedOn]));
  const overdue = data.waiting.filter((w) => {
    const since = (appliedOn.get(w.id) ?? w.date).slice(0, 10);
    return Boolean(since) && since < threeDaysAgo;
  });
  const teamPeople = data.team.map((t) => peopleById.get(t.id)).filter((p): p is NonNullable<typeof p> => Boolean(p));
  const probationDue = useMemo(
    () => trackedProbations(teamPeople, today).filter((v) => v.due && v.status === "In probation"),
    // probation snapshot changes when reviews are saved
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [teamPeople.length, data.people, probation, today],
  );
  const alerts: { id: string; text: string; to: string; tone: "warn" | "danger" }[] = [
    ...data.team.flatMap((t) =>
      missingCheckOutSessions(t.id, attState).map((s) => ({
        id: `mo-${t.id}-${s.date}`,
        text: `${t.name} · missing check-out on ${formatShortDate(s.date)}`,
        to: R.attendance,
        tone: "warn" as const,
      })),
    ),
    ...(overdue.length
      ? [{ id: "overdue", text: `${overdue.length} approval${overdue.length === 1 ? "" : "s"} waiting more than 3 days`, to: R.approvals, tone: "danger" as const }]
      : []),
    ...probationDue.map((v) => ({
      id: `pb-${v.person.id}`,
      text: `${v.person.fullName} · probation ${v.overdue ? "ended" : "ends"} ${formatShortDate(v.endDate)}`,
      to: R.probation,
      tone: v.overdue ? ("danger" as const) : ("warn" as const),
    })),
    ...immigration.documents
      .filter((d) => teamIds.has(d.personId) && VISA_TYPES.has(d.type))
      .map((d) => ({ d, status: docStatus(d, today) }))
      .filter((x) => x.status === "Expiring" || x.status === "Expired")
      .map(({ d, status }) => ({
        id: `visa-${d.id}`,
        text: `${personName(d.personId, data.people)} · ${d.type} ${status === "Expired" ? "expired" : "expires"} ${formatShortDate(d.expiryDate)}`,
        to: `/people/${d.personId}`,
        tone: status === "Expired" ? ("danger" as const) : ("warn" as const),
      })),
  ];

  const teamCover = useMemo(
    () => teamAbsence(data.people, data.people.filter((p) => teamIds.has(p.id)), state, today),
    // state slices used: holidays, leaveRequests
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.people, teamIds, state.holidays, state.leaveRequests, today],
  );
  const summaryLines = managerSummary({
    teamSize: data.team.length,
    outToday: data.statuses.filter((s) => s.status === "On leave").map((s) => s.member.name),
    wfhToday: m.wfh,
    notCheckedIn: data.statuses.filter((s) => s.status === "Working" && !checkedIn.has(s.member.id)).length,
    waiting: data.waitingCount,
    overdueApprovals: overdue.length,
    alerts: alerts.filter((a) => a.id !== "overdue").map((a) => ({ text: a.text, to: a.to })),
    coverage: teamCover.risks,
    upcomingLeave: upcomingLeave.filter((r) => r.from > today).map((r) => ({ name: personName(r.employeeId, data.people), from: r.from })),
  });

  useTitle("Manager home");

  const sections: Section[] = [
    { id: "approvals", label: "My approvals", node: <MyApprovalsCard waiting={data.waiting} count={data.waitingCount} people={data.people} /> },
    { id: "myday", label: "My day", node: <MyDayCard /> },
    { id: "team", label: "Team attendance today", node: <TeamTodayCard statuses={data.statuses} title="Team attendance today" checkedIn={checkedIn} /> },
    { id: "team-workplace", label: "Where the team works", node: <WhereTeamWorksCard members={workplace} /> },
    {
      id: "alerts",
      label: "Team alerts",
      node: (
        <Card title={`Team alerts · ${alerts.length}`}>
          <ul className="todo">
            {alerts.length ? (
              alerts.slice(0, 8).map((a) => (
                <li key={a.id}>
                  <Link to={a.to}>{a.text}</Link> <StatusBadge status={a.tone === "danger" ? "Overdue" : "Check"} tone={a.tone} literal />
                </li>
              ))
            ) : (
              <li>No alerts for your team</li>
            )}
          </ul>
        </Card>
      ),
    },
    {
      id: "leave",
      label: "Leave requests",
      node: (
        <Card title={`Leave requests · ${leaveQueue.length}`} to={R.approvals}>
          <DataTable
            headers={["Person", "Type", "From", "Status"]}
            rows={leaveQueue.slice(0, 5).map((req) => [
              personName(req.employeeId, data.people),
              req.code.toUpperCase(),
              formatShortDate(req.from),
              <StatusPill key={req.id} status={req.status} />,
            ])}
            empty={<p className="note">No leave waiting on you.</p>}
          />
        </Card>
      ),
    },
    {
      id: "timesheets",
      label: "Timesheet approvals",
      node: (
        <Card title={`Timesheet approvals · ${timesheetQueue.length}`} to={R.approvals}>
          <DataTable
            headers={["Person", "Week of", "Hours"]}
            rows={timesheetQueue.slice(0, 5).map((w) => [personName(w.employeeId, data.people), formatShortDate(w.date), w.detail])}
            empty={<p className="note">No timesheets waiting on you.</p>}
          />
        </Card>
      ),
    },
    {
      id: "goals",
      label: "Team goal progress",
      node: (
        <Card title="Team goal progress" to={R.performance}>
          {goals.people.length ? (
            <>
              <ProgressBar value={goals.avg} label={`Average · ${goals.people.length} people with goals`} />
              <p className="muted">
                {cycle.name} is {goals.elapsed}% through · {goals.behind.length} behind
              </p>
              <ul className="todo">
                {goals.behind.slice(0, 4).map((p) => (
                  <li key={p.id}>
                    {p.name} · {p.progress}% <StatusBadge status="Behind" tone="warn" literal />
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="note">No team goals in {cycle.name}.</p>
          )}
        </Card>
      ),
    },
    {
      id: "performance",
      label: "Performance activities",
      node: (
        <Card title={`Performance · ${cycle.name}`} to={R.performance}>
          {reviews.total ? (
            <>
              <ProgressBar value={reviews.total ? (reviews.selfDone / reviews.total) * 100 : 0} label={`Self reviews · ${reviews.selfDone} of ${reviews.total}`} />
              <ProgressBar value={reviews.total ? (reviews.managerDone / reviews.total) * 100 : 0} label={`Manager reviews · ${reviews.managerDone} of ${reviews.total}`} />
              <DataTable
                headers={["Person", "Self", "Manager"]}
                rows={reviews.awaitingManager.slice(0, 4).map((r) => [r.employeeName, r.selfStatus, r.managerStatus])}
                empty={<p className="note">All manager reviews are in.</p>}
              />
            </>
          ) : (
            <p className="note">No team reviews · {cycle.status}</p>
          )}
        </Card>
      ),
    },
    {
      id: "skills",
      label: "Team skills",
      node: (
        <Card title="Team skills" to={R.skills}>
          <DataTable
            headers={["Top skill", "People", "Avg level"]}
            rows={skills.top.map((s) => [s.name, String(s.people), `${s.avgLevel} / 5`])}
            empty={<p className="note">No skill profiles yet.</p>}
          />
          {skills.gaps.length > 0 && (
            <p className="muted" style={{ marginTop: 8 }}>
              Gaps: {skills.gaps.slice(0, 3).map((g) => `${g.name} (${g.gaps} below target)`).join(" · ")}
            </p>
          )}
        </Card>
      ),
    },
    {
      id: "joiners",
      label: "New joiners",
      node: (
        <Card title={`New joiners · ${joiners.length}`}>
          <DataTable
            headers={["Name", "Role", "Joined"]}
            rows={joiners.slice(0, 5).map(({ member, doj }) => [
              <Link key={member.id} to={`/people/${member.id}`}>
                {member.name}
              </Link>,
              member.designation,
              formatShortDate(doj),
            ])}
            empty={<p className="note">No joiners in 90 days.</p>}
          />
        </Card>
      ),
    },
    {
      id: "positions",
      label: "Open positions",
      node: (
        <Card title={`Open positions · ${openings}`} to="/jobs">
          <ul className="todo">
            {data.teamReqs.length ? (
              data.teamReqs.map((r) => (
                <li key={r.id}>
                  {r.title} · {r.openings} opening{r.openings === 1 ? "" : "s"} · {r.stageSummary}
                </li>
              ))
            ) : (
              <li>No open positions in your team</li>
            )}
          </ul>
        </Card>
      ),
    },
    {
      id: "upcoming-leave",
      label: "Upcoming team leave",
      node: (
        <Card title="Upcoming team leave" to={R.leave}>
          <ul className="todo">
            {upcomingLeave.length ? (
              upcomingLeave.map((r) => (
                <li key={r.id}>
                  {personName(r.employeeId, data.people)} · {r.code.toUpperCase()} · {formatShortDate(r.from)}
                  {r.to !== r.from ? ` → ${formatShortDate(r.to)}` : ""}
                </li>
              ))
            ) : (
              <li>No approved leave coming up</li>
            )}
          </ul>
        </Card>
      ),
    },
    { id: "holidays", label: "Upcoming holidays", node: <HolidaysCard holidays={data.holidays} countryName={employee.countryName} /> },
    {
      id: "links",
      label: "Quick links",
      node: (
        <Card title="Quick links">
          <AuthShortcuts
            allowed={demoProfile.navAccess}
            items={[
              { label: "Team", to: "/team", access: "team" },
              { label: "Approvals", to: R.approvals, access: "inbox" },
              { label: "Attendance", to: R.attendance, access: "attendance" },
              { label: "Performance", to: R.performance, access: "performance" },
              { label: "Analytics", to: "/analytics", access: "analytics" },
            ]}
          />
        </Card>
      ),
    },
  ];

  return (
    <div className="stack">
      <DashGreeting title="Manager home" subtitle={`${dayGreeting(employee.fullName)} · ${employee.designation} · ${formatLongDate(today)}`} />
      <TodaySummaryCard lines={summaryLines} />
      <MetricGrid>
        <MetricCard label="Team headcount" value={data.team.length} hint={`${m.direct} direct reports`} />
        <MetricCard label="Working today" value={m.working} hint={`${checkedIn.size} checked in · ${m.wfh} WFH · ${m.onLeave} on leave`} />
        <MetricCard label="Pending approvals" value={data.waitingCount} hint={overdue.length ? `${overdue.length} older than 3 days` : "Waiting on you"} />
        <MetricCard label="Team goal progress" value={`${goals.avg}%`} hint={`${goals.behind.length} behind · ${cycle.name}`} />
      </MetricGrid>
      <HomeSections userId={employee.id} sections={sections} />
    </div>
  );
}

/* ───────────────────────────────────────────── HR ── */

type HrAction = { id: string; kind: string; who: string; detail: string; date: string; to: string };

/** HR home. HRBPs get the same home scoped to their own country. */
export function HrAdminHome({ hrbp = false }: { hrbp?: boolean } = {}) {
  const { employee, demoProfile, state } = usePortal();
  const data = useHomeData();
  const { talent, attState, today } = data;
  const exitState = useSyncExternalStore(subscribeExits, getExitState, getExitState);
  const bgv = useSyncExternalStore(subscribeBgv, getBgvState, getBgvState);
  const reward = useSyncExternalStore(subscribeReward, getRewardState, getRewardState);
  const comp = compReviewStatus(reward.reviews);
  const showComp = !hrbp && canApproveCompReviews(demoProfile);
  const region = useRegionFilter();
  const country: CountryCode | "ALL" = hrbp ? ((employee.countryCode ?? "IN") as CountryCode) : region;
  const scopeName = country === "ALL" ? undefined : countryNameOf(country);
  const [range, setRange] = useDateRange("30d");
  const stats = useMemo(
    () => workforceStats(data.people, { country, range: range as RangeKey, today }),
    [data.people, country, range, today],
  );
  const global = useMemo(() => workforceStats(data.people, { country: "ALL", range: range as RangeKey, today }), [data.people, range, today]);
  const peopleById = useMemo(() => new Map(data.people.map((p) => [p.id, p])), [data.people]);
  const countryOf = (id: string) =>
    String(peopleById.get(id)?.countryCode ?? DEMO_ACCOUNTS.find((a) => a.id === id)?.countryCode ?? "IN");
  const inScope = (id: string) => country === "ALL" || countryOf(id) === country;
  const scopePeople = useMemo(
    () => data.people.filter((p) => inHeadcount(p) && (country === "ALL" || p.countryCode === country)),
    [data.people, country],
  );
  const reqs = data.openReqs.filter((r) => !scopeName || r.country === scopeName);
  const from = rangeStart(range as RangeKey, today);
  const joiners = scopePeople.filter((p) => p.dateOfJoining >= from && p.dateOfJoining <= today).sort((a, b) => b.dateOfJoining.localeCompare(a.dateOfJoining));
  const leavers = data.people
    .filter((p) => p.employmentStatus === "Terminated" && (country === "ALL" || p.countryCode === country))
    .map((p) => ({ p, ...getExitDetails(p) }))
    .filter((x) => x.exitDate && x.exitDate >= from && x.exitDate <= today)
    .sort((a, b) => (b.exitDate ?? "").localeCompare(a.exitDate ?? ""));
  const openExits = exitState.cases.filter((c) => (c.status === "Submitted" || c.status === "Accepted") && inScope(c.employeeId));
  const funnel = pipelineFunnel(talent.candidates, scopeName);

  const lifecycle = useSyncExternalStore(subscribeLifecycleActions, getLifecycleActions, getLifecycleActions);
  const corrections = useProfileCorrections();
  // Pending HR actions from the real queues.
  const hrActions: HrAction[] = [
    ...talent.tasks
      .filter((t) => t.owner === "HR" && t.status !== "Done")
      .map((t) => ({ t, j: talent.joiners.find((j) => j.id === t.joinerId) }))
      .filter(({ j }) => !scopeName || j?.country === scopeName)
      .map(({ t, j }) => ({ id: t.id, kind: "Onboarding", who: j?.name ?? "Joiner", detail: t.title, date: t.due, to: R.onboarding })),
    ...state.investmentProofs
      .filter((p) => p.status === "submitted" && inScope(p.employeeId))
      .map((p) => ({ id: p.id, kind: "Tax proof", who: personName(p.employeeId, data.people), detail: p.section, date: p.submittedOn, to: R.approvals })),
    ...exitState.cases
      .filter((c) => c.status === "Accepted" && inScope(c.employeeId))
      .map((c) => ({ c, open: c.clearance.filter((i) => i.owner === "hr" && !i.done).length }))
      .filter(({ c, open }) => open > 0 || c.settlement !== "Paid")
      .map(({ c, open }) => ({
        id: c.id,
        kind: "Exit clearance",
        who: c.employeeName,
        detail: open ? `${open} HR item${open === 1 ? "" : "s"} open` : `Settlement ${c.settlement.toLowerCase()}`,
        date: c.lastWorkingDay,
        to: R.exits,
      })),
    ...lifecycle
      .filter((a) => canDecideLifecycle(demoProfile, a) && inScope(a.employeeId))
      .map((a) => ({ id: a.id, kind: "Lifecycle action", who: a.employeeName, detail: a.type, date: a.effectiveDate, to: "/lifecycle/actions" })),
    ...corrections
      .filter((c) => c.status === "Pending" && c.personId !== employee.id && inScope(c.personId))
      .map((c) => ({ id: c.id, kind: "Profile correction", who: c.personName, detail: c.field, date: addDaysISO(c.requestedOn.slice(0, 10), 3), to: `/people/${c.personId}` })),
    ...talent.requisitions
      .filter((r) => r.approvalStatus !== "Approved" && r.approvalStatus !== "Rejected" && requisitionApprovers(r).some((a) => a.id === employee.id))
      .map((r) => ({ id: r.id, kind: "Requisition", who: r.hiringManager, detail: `${r.id} · ${r.title}`, date: addDaysISO(r.created.slice(0, 10), 3), to: "/recruiting" })),
    ...bgv.records
      .map((r) => ({ r, result: overallResult(r) }))
      .filter(({ result }) => result !== "Clear")
      .filter(({ r }) => {
        if (!scopeName) return true;
        if (r.subjectKind === "employee") return inScope(r.subjectId);
        return talent.joiners.find((j) => j.id === r.subjectId)?.country === scopeName;
      })
      .map(({ r, result }) => ({ id: r.id, kind: "Background check", who: r.subjectName, detail: result, date: r.createdOn, to: R.bgv })),
  ].sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999"));
  const actionKinds = [...hrActions.reduce((mm, a) => mm.set(a.kind, (mm.get(a.kind) ?? 0) + 1), new Map<string, number>())];

  const leaveSeries = useMemo(
    () => leaveTrend(state.leaveRequests, state.holidays, countryOf, country, today, 6),
    // countryOf reads peopleById
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.leaveRequests, state.holidays, peopleById, country, today],
  );
  const onLeaveNow = scopePeople.filter((p) => p.employmentStatus === "On Leave").length;
  const attendanceSeries = useMemo(
    () => attendanceTrend(scopePeople, state, attState, today, 6),
    // state slices used: holidays, leaveRequests, absences
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scopePeople, state.holidays, state.leaveRequests, state.absences, attState, today],
  );
  const cycle = currentCycle(talent);
  const scopeIds = useMemo(() => (country === "ALL" ? null : new Set(scopePeople.map((p) => p.id))), [country, scopePeople]);
  const reviews = reviewStatusFor(talent.reviews, scopeIds, cycle.id);
  const learning = learningCompletion(talent.enrollments, scopeIds ?? undefined, today);
  const insights = useMemo(() => workforceInsights(data.people, country, today), [data.people, country, today]);
  const countryPeople = useMemo(
    () => (country === "ALL" ? data.people : data.people.filter((p) => p.countryCode === country)),
    [data.people, country],
  );
  const late = useMemo(
    () => lateArrivals(attendanceSample(data.people, country), state, attState, today),
    // state slices used: holidays, leaveRequests, absences
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.people, country, state.holidays, state.leaveRequests, state.absences, attState, today],
  );
  const cover = useMemo(
    () => teamAbsence(data.people, scopePeople, state, today),
    // state slices used: holidays, leaveRequests
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.people, scopePeople, state.holidays, state.leaveRequests, today],
  );

  const weekAgo = addDaysISO(today, -6);
  const summaryLines = hrSummary({
    scopeName,
    joinedThisWeek: data.people
      .filter((p) => p.employmentStatus !== "Terminated" && (country === "ALL" || p.countryCode === country) && p.dateOfJoining >= weekAgo && p.dateOfJoining <= today)
      .map((p) => p.fullName),
    startingSoon: talent.joiners.filter((j) => j.startDate > today && j.startDate <= addDaysISO(today, 7) && (!scopeName || j.country === scopeName)).length,
    leavingSoon: exitState.cases
      .filter((c) => c.status === "Accepted" && c.lastWorkingDay >= today && c.lastWorkingDay <= addDaysISO(today, 14) && inScope(c.employeeId))
      .sort((a, b) => a.lastWorkingDay.localeCompare(b.lastWorkingDay))
      .map((c) => ({ name: c.employeeName, date: c.lastWorkingDay })),
    resignationsOpen: openExits.length,
    overdueActions: hrActions.filter((a) => a.date && a.date.slice(0, 10) < today),
    openActions: hrActions.length,
    waiting: data.waitingCount,
    highRisks: cover.risks.filter((r) => r.severity === "High").length,
  });

  const title = hrbp ? "HRBP home" : "HR home";
  useTitle(title);

  const sections: Section[] = [
    { id: "approvals", label: "My approvals", node: <MyApprovalsCard waiting={data.waiting} count={data.waitingCount} people={data.people} /> },
    { id: "myday", label: "My day", node: <MyDayCard /> },
    {
      id: "hr-actions",
      label: "Pending HR actions",
      node: (
        <Card title={`Pending HR actions · ${hrActions.length}`}>
          {actionKinds.length > 0 && (
            <p className="muted">{actionKinds.map(([k, n]) => `${k} ${n}`).join(" · ")}</p>
          )}
          <DataTable
            headers={["Action", "Person", "Detail", "Date"]}
            rows={hrActions.slice(0, 6).map((a) => [
              <Link key={a.id} to={a.to}>
                {a.kind}
              </Link>,
              a.who,
              a.detail,
              a.date ? formatShortDate(a.date.slice(0, 10)) : "—",
            ])}
            empty={<p className="note">No HR actions pending.</p>}
          />
        </Card>
      ),
    },
    {
      id: "countries",
      label: "Country headcount",
      node: (
        <Card title="Country headcount">
          <MiniBars items={(hrbp ? stats : global).byCountry.map((c) => ({ label: c.code, value: c.count }))} />
        </Card>
      ),
    },
    {
      id: "departments",
      label: "Headcount by department",
      node: (
        <Card title="Headcount by department">
          <MiniBars items={stats.byDepartment.slice(0, 8).map((d) => ({ label: d.name.slice(0, 10), value: d.count }))} />
        </Card>
      ),
    },
    { id: "headcount-analysis", label: "Headcount analysis", node: <HeadcountAnalysisCard scopePeople={scopePeople} allPeople={data.people} today={today} /> },
    { id: "new-hiring", label: "New hiring", node: <NewHiringCard people={countryPeople} today={today} /> },
    { id: "time-to-hire", label: "Time to hire", node: <TimeToHireCard offers={talent.offers} requisitions={talent.requisitions} countryName={scopeName} /> },
    { id: "offer-acceptance", label: "Offer acceptance", node: <OfferAcceptanceCard offers={talent.offers} requisitions={talent.requisitions} countryName={scopeName} /> },
    { id: "late-arrivals", label: "Late arrivals", node: <LateArrivalsCard data={late} /> },
    { id: "team-cover", label: "Team absence & cover", node: <TeamCoverCard data={cover} /> },
    { id: "coverage-risks", label: "Coverage risks", node: <CoverageRisksCard risks={cover.risks} /> },
    {
      id: "joiners",
      label: "New joiners",
      node: (
        <Card title={`New joiners · ${joiners.length}`} to={R.onboarding}>
          <DataTable
            headers={["Name", "Department", "Country", "Joined"]}
            rows={joiners.slice(0, 5).map((p) => [
              <Link key={p.id} to={`/people/${p.id}`}>
                {p.fullName}
              </Link>,
              p.department,
              String(p.countryCode),
              formatShortDate(p.dateOfJoining),
            ])}
            empty={<p className="note">No joiners in this period.</p>}
          />
        </Card>
      ),
    },
    {
      id: "exits",
      label: "Exits",
      node: (
        <Card title={`Exits · ${leavers.length}`} to={R.exits}>
          <DataTable
            headers={["Name", "Department", "Exit date", "Reason"]}
            rows={leavers.slice(0, 5).map((x) => [x.p.fullName, x.p.department, formatShortDate(x.exitDate ?? ""), x.exitReason ?? "—"])}
            empty={<p className="note">No exits in this period.</p>}
          />
          {openExits.length > 0 && (
            <p className="muted" style={{ marginTop: 8 }}>
              {openExits.length} resignation{openExits.length === 1 ? "" : "s"} in progress
            </p>
          )}
        </Card>
      ),
    },
    {
      id: "requisitions",
      label: "Open positions",
      node: (
        <Card title={`Open positions · ${reqs.reduce((n, r) => n + r.openings, 0)}`} to={R.recruiting}>
          <DataTable
            headers={["Title", "Country", "Openings", "Stage"]}
            rows={reqs.map((r) => [r.title, r.country, String(r.openings), r.stageSummary])}
            empty={<p className="note">No open requisitions.</p>}
          />
        </Card>
      ),
    },
    {
      id: "pipeline",
      label: "Recruitment pipeline",
      node: (
        <Card title={`Recruitment pipeline · ${funnel.reduce((n, s) => n + s.count, 0)}`} to={R.recruiting}>
          <MiniBars items={funnel.map((s) => ({ label: s.stage, value: s.count }))} />
        </Card>
      ),
    },
    {
      id: "leave-trend",
      label: "Leave trends",
      node: (
        <Card title="Leave trends · days">
          <MiniBars items={leaveSeries.map((s) => ({ label: s.label, value: s.days }))} />
          {onLeaveNow > 0 && <p className="note">{onLeaveNow} on leave today</p>}
        </Card>
      ),
    },
    {
      id: "attendance-trend",
      label: "Attendance trends",
      node: (
        <Card title="Attendance trends · weekly">
          <MiniBars items={attendanceSeries.map((s) => ({ label: s.label, value: s.pct }))} valueSuffix="%" />
        </Card>
      ),
    },
    {
      id: "cycles",
      label: "Performance cycle",
      node: (
        <Card title={`${cycle.name} · ${cycle.status}`} to={R.performance}>
          <ProgressBar value={reviews.completionPct} label="Assessments submitted" />
          <ProgressBar value={reviews.total ? (reviews.selfDone / reviews.total) * 100 : 0} label={`Self · ${reviews.selfDone} of ${reviews.total}`} />
          <ProgressBar value={reviews.total ? (reviews.managerDone / reviews.total) * 100 : 0} label={`Manager · ${reviews.managerDone} of ${reviews.total}`} />
          <p className="note">
            Ends {formatShortDate(cycle.end)} · {reviews.calibrated} rated · {reviews.released} released
          </p>
        </Card>
      ),
    },
    {
      id: "learning",
      label: "Learning completion",
      node: (
        <Card title="Learning completion" to={R.learning}>
          <ProgressBar value={learning.pct} label={`All courses · ${learning.completed} of ${learning.total}`} />
          <ProgressBar value={learning.mandatoryPct} label={`Mandatory · ${learning.mandatoryDone} of ${learning.mandatoryTotal}`} />
          {learning.overdue > 0 && <p className="note warn">{learning.overdue} enrollment{learning.overdue === 1 ? "" : "s"} overdue</p>}
        </Card>
      ),
    },
    {
      id: "insights",
      label: "Workforce insights",
      node: (
        <Card title="Workforce insights" to="/analytics">
          <ul className="todo">
            {insights.length ? insights.map((i) => <li key={i.id}>{i.text}</li>) : <li>No people in this scope.</li>}
          </ul>
        </Card>
      ),
    },
    { id: "onboarding-stats", label: "Onboarding", node: <OnboardingHomeCard /> },
    // HR owns compensation & benefits: the pay review cycle sits on the HR home.
    ...(comp && showComp
      ? [
          {
            id: "comp-cycle",
            label: "Compensation review",
            node: (
              <Card title={`${comp.cycle} · ${comp.status}`} to="/compensation">
                {comp.total ? (
                  <>
                    <ProgressBar value={comp.submittedPct} label={`Submitted · ${comp.total} proposals`} />
                    <ProgressBar value={(comp.approved / comp.total) * 100} label={`Approved · ${comp.approved}`} />
                    <p className="note">
                      {comp.awaiting} awaiting approval · {comp.pendingManagers} managers still to submit
                    </p>
                  </>
                ) : (
                  <p className="note">No proposals yet.</p>
                )}
              </Card>
            ),
          },
        ]
      : []),
    { id: "holidays", label: "Upcoming holidays", node: <HolidaysCard holidays={data.holidays} countryName={employee.countryName} /> },
    {
      id: "links",
      label: "Shortcuts",
      node: (
        <Card title="Shortcuts">
          <AuthShortcuts
            allowed={demoProfile.navAccess}
            items={[
              { label: "People directory", to: R.directory, access: "people" },
              { label: "Compensation", to: "/compensation", access: "compensation" },
              { label: "Benefits", to: R.benefits, access: "benefits" },
              { label: "Pay preview", to: "/payroll/preview", access: "paypreview" },
              { label: "Organization", to: "/organization", access: "organization" },
              { label: "Onboarding", to: R.onboarding, access: "onboarding" },
              { label: "Bulk updates", to: "/data-tools/bulk", access: "bulkdata" },
              { label: "Analytics", to: "/analytics", access: "analytics" },
            ]}
          />
        </Card>
      ),
    },
  ];

  return (
    <div className="stack">
      <DashGreeting title={title} subtitle={`${dayGreeting(employee.fullName)} · ${hrbp ? `People partner · ${scopeName ?? ""}` : "People operations"}`} />
      <TodaySummaryCard lines={summaryLines} />
      <DateRangeFilter value={range} onChange={setRange} extras={hrbp ? undefined : <RegionalFilter label="Country" />} />
      <MetricGrid>
        <MetricCard label="Global headcount" value={global.headcount} hint={`${global.byCountry.filter((c) => c.count > 0).length} countries`} />
        <MetricCard label={scopeName ? `${scopeName} headcount` : "Joiners"} value={scopeName ? stats.headcount : stats.joiners} hint={scopeName ? `${stats.joiners} joiners · ${rangeLabel(range as RangeKey)}` : rangeLabel(range as RangeKey)} />
        <MetricCard label="Exits" value={stats.exits} hint={`${stats.attritionPct}% · ${rangeLabel(range as RangeKey)}`} />
        <MetricCard label="Open positions" value={reqs.reduce((n, r) => n + r.openings, 0)} hint={`${reqs.length} requisitions`} />
      </MetricGrid>
      <HomeSections userId={employee.id} sections={sections} />
    </div>
  );
}

/* ───────────────────────────────────────────── RECRUITER ── */

export function RecruiterHome() {
  const { employee, demoProfile } = usePortal();
  const data = useHomeData();
  const { talent } = data;
  const [query, setQuery] = useState("");
  const mine = talent.requisitions.filter((r) => r.recruiter === employee.fullName && r.approvalStatus === "Approved");
  const active = talent.candidates.filter((c) => !["Hired", "Rejected", "Withdrawn"].includes(c.stage));
  const shown = active.filter(
    (c) => !query || c.name.toLowerCase().includes(query.toLowerCase()) || c.role.toLowerCase().includes(query.toLowerCase()),
  );
  const pendingFeedback = talent.interviews.filter((i) => i.feedbackStatus === "Pending");
  const upcoming = talent.interviews.filter((i) => i.when.slice(0, 10) >= data.today);
  const byStage = [...active.reduce((m, c) => m.set(c.stage, (m.get(c.stage) ?? 0) + 1), new Map<string, number>())];

  useTitle("Recruiter home");

  const sections: Section[] = [
    ...(data.waitingCount > 0 || data.team.length > 0
      ? [{ id: "approvals", label: "My approvals", node: <MyApprovalsCard waiting={data.waiting} count={data.waitingCount} people={data.people} /> }]
      : []),
    { id: "myday", label: "My day", node: <MyDayCard /> },
    {
      id: "stages",
      label: "Candidates by stage",
      node: (
        <Card title="Candidates by stage" to="/recruiting">
          <MiniBars items={byStage.map(([stage, n]) => ({ label: stage, value: n }))} />
        </Card>
      ),
    },
    {
      id: "candidates",
      label: "Active candidates",
      node: (
        <Card title="Active candidates">
          <label className="filter-label">
            Search
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name or role" />
          </label>
          <DataTable
            headers={["Candidate", "Role", "Stage"]}
            rows={shown.slice(0, 8).map((c) => [c.name, c.role, c.stage])}
            empty={<p className="note">No matches.</p>}
          />
        </Card>
      ),
    },
    {
      id: "feedback",
      label: "Pending feedback",
      node: (
        <Card title="Pending interview feedback" to="/recruiting">
          <DataTable
            headers={["Candidate", "Role", "Interview"]}
            rows={pendingFeedback.map((i) => [i.candidateName, i.role, i.when])}
            empty={<p className="note">All feedback is in.</p>}
          />
        </Card>
      ),
    },
    {
      id: "links",
      label: "Shortcuts",
      node: (
        <Card title="Shortcuts">
          <AuthShortcuts
            allowed={demoProfile.navAccess}
            items={[
              { label: "Recruiting", to: "/recruiting", access: "recruiting" },
              { label: "Jobs & positions", to: "/jobs", access: "jobs" },
              { label: "Onboarding", to: "/onboarding", access: "onboarding" },
              { label: "People", to: R.directory, access: "people" },
            ]}
          />
        </Card>
      ),
    },
  ];

  return (
    <div className="stack">
      <DashGreeting title="Recruiter home" subtitle={`${dayGreeting(employee.fullName)} · Talent acquisition`} />
      <MetricGrid>
        <MetricCard label="My requisitions" value={mine.length} hint={`${mine.reduce((n, r) => n + r.openings, 0)} openings`} />
        <MetricCard label="Active candidates" value={active.length} />
        <MetricCard label="Upcoming interviews" value={upcoming.length} />
        <MetricCard label="Feedback pending" value={pendingFeedback.length} />
      </MetricGrid>
      <HomeSections userId={employee.id} sections={sections} />
    </div>
  );
}

/* ───────────────────────────────────────────── EXECUTIVE ── */

export function ExecutiveHome() {
  const { employee, demoProfile } = usePortal();
  const data = useHomeData();
  const country = useRegionFilter();
  const [range, setRange] = useDateRange("ytd");
  const stats = useMemo(
    () => workforceStats(data.people, { country, range: range as RangeKey, today: data.today }),
    [data.people, country, range, data.today],
  );
  const direct = data.statuses.filter((s) => s.member.direct);
  const skillGaps = useMemo(
    () =>
      criticalSkillGaps(
        data.talent,
        data.people
          .filter((p) => p.employmentStatus !== "Terminated" && (country === "ALL" || p.countryCode === country))
          .map((p) => ({ id: p.id, countryCode: String(p.countryCode) })),
      ),
    [data.talent, data.people, country],
  );

  useTitle("Executive home");

  const sections: Section[] = [
    { id: "approvals", label: "My approvals", node: <MyApprovalsCard waiting={data.waiting} count={data.waitingCount} people={data.people} /> },
    { id: "myday", label: "My day", node: <MyDayCard /> },
    { id: "direct", label: "Direct reports", node: <TeamTodayCard statuses={direct} title="Direct reports today" /> },
    {
      id: "countries",
      label: "Country distribution",
      node: (
        <Card title="Country distribution">
          <MiniBars items={stats.byCountry.map((c) => ({ label: c.code, value: c.count }))} />
        </Card>
      ),
    },
    {
      id: "units",
      label: "Business units",
      node: (
        <Card title="Business units">
          <MiniBars items={stats.byBusinessUnit.map((b) => ({ label: b.name.replace("TimeZ ", ""), value: b.count }))} />
        </Card>
      ),
    },
    {
      id: "departments",
      label: "Departments",
      node: (
        <Card title="Departments">
          <MiniBars items={stats.byDepartment.slice(0, 8).map((d) => ({ label: d.name.slice(0, 10), value: d.count }))} />
        </Card>
      ),
    },
    {
      id: "skills",
      label: "Critical skill gaps",
      node: (
        <Card title="Critical skill gaps" to={R.skills}>
          <DataTable
            headers={["Skill", "Gap", "Below target", "Countries"]}
            rows={skillGaps.map((s) => [s.skill, s.gap, String(s.people), s.countries])}
            empty={<p className="note">No skill gaps recorded.</p>}
          />
        </Card>
      ),
    },
    {
      id: "links",
      label: "Shortcuts",
      node: (
        <Card title="Shortcuts">
          <AuthShortcuts
            allowed={demoProfile.navAccess}
            items={[
              { label: "Analytics", to: "/analytics", access: "analytics" },
              { label: "Organization", to: "/organization", access: "organization" },
              { label: "People", to: R.directory, access: "people" },
              { label: "Compensation", to: "/compensation", access: "compensation" },
            ]}
          />
        </Card>
      ),
    },
  ];

  return (
    <div className="stack">
      <DashGreeting title="Executive home" subtitle={`${dayGreeting(employee.fullName)} · Workforce overview`} />
      <DateRangeFilter value={range} onChange={setRange} extras={<RegionalFilter label="Country" />} />
      <MetricGrid>
        <MetricCard label="Headcount" value={stats.headcount} hint={country === "ALL" ? "All countries" : stats.byCountry[0]?.name} />
        <MetricCard label="Net growth" value={`${stats.joiners - stats.exits >= 0 ? "+" : ""}${stats.joiners - stats.exits}`} hint={rangeLabel(range as RangeKey)} />
        <MetricCard label="Attrition" value={`${stats.attritionPct}%`} hint={rangeLabel(range as RangeKey)} />
        <MetricCard label="Pending approvals" value={data.waitingCount} hint="Waiting on you" />
      </MetricGrid>
      <HomeSections userId={employee.id} sections={sections} />
    </div>
  );
}

/* ───────────────────────────────────────────── ADMINISTRATION ── */

const ROLE_LABELS: Partial<Record<DemoAccount["role"], string>> = {
  employee: "Employee",
  manager: "Manager",
  hr_admin: "HR",
  recruiter: "Recruiter",
  executive: "Executive",
  admin: "Admin",
};

/** Modules shown in the admin permissions table, read from each account's access pack. */
const PERMISSION_ROWS: [string, string][] = [
  ["team", "Team"],
  ["inbox", "Approvals"],
  ["people", "Directory"],
  ["organization", "Organization"],
  ["recruiting", "Recruiting"],
  ["onboarding", "Onboarding"],
  ["performance", "Performance"],
  ["compensation", "Compensation"],
  ["payroll", "Payroll"],
  ["analytics", "Analytics"],
  ["exitsadmin", "Exits"],
  ["bgv", "Background checks"],
  ["bulkdata", "Bulk updates"],
  ["administration", "Administration"],
  ["integrations", "Integrations"],
  ["auditlog", "Audit log"],
];

export function AdministrationHome() {
  const { employee, demoProfile } = usePortal();
  const data = useHomeData();
  const { countries } = useLocale();
  useSyncExternalStore(subscribePlatform, getPlatformVersion, getPlatformVersion);
  const integrations = listIntegrations();
  const audit = listAuditLog();
  const country = useRegionFilter();
  const stats = useMemo(
    () => workforceStats(data.people, { country, range: "ytd", today: data.today }),
    [data.people, country, data.today],
  );
  const roleRows = Object.entries(
    DEMO_ACCOUNTS.reduce<Record<string, number>>((acc, a) => {
      const label = ROLE_LABELS[a.role] ?? a.role;
      acc[label] = (acc[label] ?? 0) + 1;
      return acc;
    }, {}),
  );
  const auditTrail = useAuditTrail();
  const tickets = useTickets();
  const movement = useMemo(() => monthlyMovement(data.people, data.today), [data.people, data.today]);
  const activity = dailyCounts([...auditTrail.map((e) => e.at), ...audit.map((e) => e.at)], data.today, 14);
  const countryData = stats.byCountry.map((c, i) => ({ label: c.code, title: c.name, value: c.count, color: paletteColor(i) }));
  const accessData = DEMO_ACCOUNTS.map((a) => ({
    label: ROLE_LABELS[a.role] ?? a.personaLabel,
    title: `${a.personaLabel} (${a.fullName})`,
    value: PERMISSION_ROWS.filter(([id]) => accountHasNavAccess(a, id)).length,
  }));
  const INTEGRATION_STATES = ["Connected", "Degraded", "Disconnected", "Not configured"] as const;
  const integrationData = countInto(INTEGRATION_STATES, integrations.map((i) => i.status))
    .filter((d) => d.label !== "Not configured" || d.value > 0)
    .map((d) => ({
      ...d,
      color: d.label === "Connected" ? "var(--ok)" : d.label === "Degraded" ? "var(--warn)" : d.label === "Disconnected" ? "var(--danger)" : "var(--muted)",
    }));
  const ticketData = countInto(TICKET_STATUSES, tickets.map((t) => t.status));

  useTitle("Admin home");

  const sections: Section[] = [
    { id: "myday", label: "My day", node: <MyDayCard /> },
    {
      id: "chart-country",
      label: "Headcount by country",
      node: (
        <Card title="Headcount by country" to={R.directory}>
          {stats.headcount ? (
            <BarChart
              data={countryData.map(({ label, title, value }) => ({ label, title, value }))}
              ariaLabel={`Headcount by country: ${stats.byCountry.map((c) => `${c.name} ${c.count}`).join(", ")}.`}
            />
          ) : (
            <ChartEmpty>No active people in this scope.</ChartEmpty>
          )}
        </Card>
      ),
    },
    {
      id: "entities",
      label: "Countries & entities",
      node: (
        <Card title="Country distribution">
          <DonutChart
            data={countryData}
            centerLabel="people"
            ariaLabel={`Workforce share by country: ${stats.byCountry
              .map((c) => `${c.name} ${stats.headcount ? Math.round((c.count / stats.headcount) * 100) : 0}%`)
              .join(", ")}.`}
          />
          <div className="chart-table-wrap">
            <DataTable
              headers={["Country", "Legal entity", "Currency", "Time zone", "People"]}
              rows={stats.byCountry.map((c) => {
                const cfg = countries.find((x) => x.code === c.code);
                return [c.name, cfg?.legalEntity ?? "—", cfg?.currency ?? "—", cfg?.timeZone ?? "—", String(c.count)];
              })}
            />
          </div>
        </Card>
      ),
    },
    {
      id: "chart-access",
      label: "Access by role",
      node: (
        <Card title="Admin modules by role" to={R.admin}>
          <HBarChart
            data={accessData}
            max={PERMISSION_ROWS.length}
            ariaLabel={`Admin modules each role can open, out of ${PERMISSION_ROWS.length}: ${accessData.map((d) => `${d.label} ${d.value}`).join(", ")}.`}
          />
          <p className="chart-note muted">
            {DEMO_ACCOUNTS.length} sign-in accounts · out of {PERMISSION_ROWS.length} modules
          </p>
        </Card>
      ),
    },
    {
      id: "chart-movement",
      label: "Joiners vs exits",
      node: (
        <Card title="Joiners vs exits · 12 months">
          <LineChart
            labels={movement.labels}
            titles={movement.titles}
            labelEvery={2}
            series={[
              { name: "Joiners", values: movement.joiners, color: "var(--accent)" },
              { name: "Exits", values: movement.exits, color: "var(--warn)", dashed: true },
            ]}
            ariaLabel={`Joiners and exits per month, ${movement.titles[0]} to ${movement.titles[movement.titles.length - 1]}: ${movement.joiners.reduce((a, b) => a + b, 0)} joiners, ${movement.exits.reduce((a, b) => a + b, 0)} exits.`}
          />
        </Card>
      ),
    },
    {
      id: "chart-activity",
      label: "System activity",
      node: (
        <Card title="System activity · 14 days" to={R.admin}>
          <LineChart
            labels={activity.dates.map((d) => d.slice(8, 10))}
            titles={activity.dates.map(formatShortDate)}
            labelEvery={3}
            series={[{ name: "Audit events", values: activity.counts, color: "var(--accent)" }]}
            ariaLabel={`Audit events per day over the last 14 days: ${activity.counts.reduce((a, b) => a + b, 0)} in total, most in a day ${Math.max(0, ...activity.counts)}.`}
          />
          <p className="chart-note muted">{activity.counts.reduce((a, b) => a + b, 0)} audit events in 14 days</p>
        </Card>
      ),
    },
    {
      id: "chart-integrations",
      label: "Integration status",
      node: (
        <Card title="Integration status" to="/integrations">
          {integrations.length ? (
            <DonutChart
              data={integrationData}
              centerLabel="integrations"
              ariaLabel={`Integration status: ${integrationData.map((d) => `${d.label} ${d.value}`).join(", ")}.`}
            />
          ) : (
            <ChartEmpty>No integrations set up.</ChartEmpty>
          )}
        </Card>
      ),
    },
    {
      id: "chart-tickets",
      label: "Tickets by status",
      node: (
        <Card title="Tickets by status" to="/tickets">
          {tickets.length ? (
            <BarChart
              data={ticketData.map((d) => ({ label: d.label === "In progress" ? "Doing" : d.label, title: d.label, value: d.value }))}
              ariaLabel={`Tickets by status: ${ticketData.map((d) => `${d.label} ${d.value}`).join(", ")}.`}
            />
          ) : (
            <ChartEmpty>No tickets yet.</ChartEmpty>
          )}
        </Card>
      ),
    },
    {
      id: "roles",
      label: "Sign-in roles",
      node: (
        <Card title="Sign-in roles" to={R.admin}>
          <DataTable headers={["Role", "Accounts"]} rows={roleRows.map(([role, n]) => [role, String(n)])} />
        </Card>
      ),
    },
    {
      id: "permissions",
      label: "Permissions",
      node: (
        <Card title="Who can do what" to={R.admin}>
          <DataTable
            headers={["Module", ...DEMO_ACCOUNTS.map((a) => a.personaLabel)]}
            rows={PERMISSION_ROWS.map(([id, label]) => [label, ...DEMO_ACCOUNTS.map((a) => (accountHasNavAccess(a, id) ? "Yes" : "—"))])}
          />
        </Card>
      ),
    },
    {
      id: "integrations",
      label: "Integration health",
      node: (
        <Card title="Integration health" to="/integrations">
          <DataTable
            headers={["Integration", "Status"]}
            rows={integrations.map((i) => [
              i.name,
              <StatusBadge
                key={i.id}
                status={i.status}
                tone={i.status === "Connected" ? "ok" : i.status === "Degraded" ? "warn" : i.status === "Disconnected" ? "danger" : "neutral"}
                literal
              />,
            ])}
          />
        </Card>
      ),
    },
    {
      id: "audit",
      label: "Audit log",
      node: (
        <Card title="Recent audit events" to={R.admin}>
          <DataTable headers={["When", "Who", "Action", "Target"]} rows={audit.slice(0, 6).map((e) => [e.at, e.actor, e.action, e.target])} />
        </Card>
      ),
    },
    {
      id: "platform",
      label: "Platform",
      node: (
        <Card title="Platform">
          <ul className="todo">
            <li>Idle sign-out · 30 min</li>
          </ul>
          <AuthShortcuts
            allowed={demoProfile.navAccess}
            items={[
              { label: "Administration", to: R.admin, access: "administration" },
              { label: "Integrations", to: "/integrations", access: "integrations" },
              { label: "Bulk updates", to: "/data-tools/bulk", access: "bulkdata" },
            ]}
          />
        </Card>
      ),
    },
  ];

  return (
    <div className="stack">
      <DashGreeting title="Admin home" subtitle={`${dayGreeting(employee.fullName)} · Platform`} />
      <MetricGrid>
        <MetricCard label="People" value={stats.headcount} hint={country === "ALL" ? "All countries" : stats.byCountry[0]?.name} />
        <MetricCard label="Sign-in accounts" value={DEMO_ACCOUNTS.length} />
        <MetricCard label="Legal entities" value={countries.length} />
        <MetricCard
          label="Integrations connected"
          value={integrations.filter((i) => i.status === "Connected").length}
          hint={`of ${integrations.length}`}
        />
      </MetricGrid>
      <HomeSections userId={employee.id} sections={sections} />
    </div>
  );
}

export function RoleHomeRouter({ profile }: { profile: DemoAccount }) {
  switch (profile.role) {
    case "manager":
      return <ManagerHome />;
    case "hr_admin":
    case "hr":
      return <HrAdminHome />;
    case "hrbp":
      return <HrAdminHome hrbp />;
    case "recruiter":
      return <RecruiterHome />;
    case "executive":
    case "founder":
    case "cofounder":
      return <ExecutiveHome />;
    case "it_admin":
    case "admin":
    case "super_admin":
    case "compliance":
      return <AdministrationHome />;
    default:
      return <EmployeeHome />;
  }
}
