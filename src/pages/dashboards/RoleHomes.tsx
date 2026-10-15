import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { COMPANY_NAME } from "../../brand.ts";
import {
  Card,
  DataTable,
  LeaveTable,
  MetricCard,
  MetricGrid,
  StatusBadge,
  StatusPill,
} from "../../components/ui.tsx";
import {
  TZ_ADMIN,
  TZ_EMPLOYEE_DEFAULTS,
  TZ_EXEC,
  TZ_HEADCOUNT,
  TZ_HR,
  TZ_MOVEMENT,
  TZ_RECRUITING,
  TZ_TEAM,
  type DateRangeKey,
} from "../../data/dashboardMock.ts";
import type { DemoAccount } from "../../demoAccounts.ts";
import {
  attendanceOn,
  dayGreeting,
  formatLongDate,
  formatShortDate,
  todayISO,
} from "../../model.ts";
import { useLocale } from "../../locale/LocaleContext.tsx";
import { usePortal } from "../../store.tsx";
import {
  AuthShortcuts,
  DashGreeting,
  DateRangeFilter,
  MiniBars,
  PlaceholderPanel,
  ProgressBar,
  SoftTabs,
  useDateRange,
} from "./widgets.tsx";

/** Map dashboard shortcut labels to real prototype routes. */
const R = {
  copilot: "/ai/copilot",
  performance: "/evaluations",
  learning: "/programs",
  skills: "/skills",
  admin: "/admin",
  inbox: "/approvals",
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
} as const;

function movementForRange(range: DateRangeKey) {
  if (range === "7d") {
    return { joiners: 4, exits: 1, net: 3, label: "Last 7 days" };
  }
  if (range === "90d") {
    return { joiners: 48, exits: 19, net: 29, label: "Last 90 days" };
  }
  if (range === "ytd") {
    return {
      joiners: TZ_MOVEMENT.joinersYtd,
      exits: TZ_MOVEMENT.exitsYtd,
      net: TZ_MOVEMENT.joinersYtd - TZ_MOVEMENT.exitsYtd,
      label: "Year to date",
    };
  }
  return {
    joiners: TZ_MOVEMENT.joiners30d,
    exits: TZ_MOVEMENT.exits30d,
    net: TZ_MOVEMENT.netGrowth30d,
    label: "Last 30 days",
  };
}

/* ───────────────────────────────────────────── A. EMPLOYEE ── */

export function EmployeeHome() {
  const { employee, leaveTable, counts, payslipViews, currentProjects, state } = usePortal();
  const { activeCountry } = useLocale();
  const [checkedIn, setCheckedIn] = useState(false);
  const [checkInAt, setCheckInAt] = useState<string | null>(null);
  const [checkOutAt, setCheckOutAt] = useState<string | null>(null);
  const today = todayISO();
  const pto = leaveTable.find((row) => row.code === "pto");
  const wfh = leaveTable.find((row) => row.code === "wfh");
  const nextHoliday = state.holidays.find((holiday) => holiday.date >= today);
  const personalPending = state.leaveRequests.filter(
    (item) => item.employeeId === employee.id && item.status === "pending",
  );
  const myOpenTasks = state.tasks.filter(
    (task) => task.employeeId === employee.id && (task.status === "open" || task.status === "progress"),
  );
  const urgentTask = myOpenTasks.find((t) => t.priority === "urgent" || t.priority === "high") ?? myOpenTasks[0];
  const timesheetNeedsAction = counts.timesheet > 0;
  const todayAtt = attendanceOn(today, state.holidays, state.leaveRequests, [], employee.shiftHours, today, employee.id);
  const attendanceLabel =
    todayAtt.kind === "leave" ? "On leave" : checkedIn ? (checkOutAt ? "Checked out" : "Checked in") : "Not checked in";
  const actionItems = [
    ...personalPending.map((req) => ({
      id: req.id,
      label: `Leave · ${req.code.toUpperCase()} · ${formatShortDate(req.from)}`,
      status: "Pending",
      next: "Awaiting manager approval",
      to: R.leave,
    })),
    ...myOpenTasks.slice(0, 3).map((task) => ({
      id: task.id,
      label: `${task.code} · ${task.subject}`,
      status: task.blocked ? "Action Required" : task.status === "progress" ? "In progress" : "Open",
      next: task.due ? `Due ${formatShortDate(task.due)}` : "Open task",
      to: R.tasks,
    })),
    ...(timesheetNeedsAction
      ? [
          {
            id: "ts-action",
            label: TZ_EMPLOYEE_DEFAULTS.timesheetStatus,
            status: "Action Required",
            next: "Submit or correct this week’s timesheet",
            to: R.timesheet,
          },
        ]
      : []),
    ...(counts.programs > 0
      ? [
          {
            id: "learn-action",
            label: `${counts.programs} learning item(s) due`,
            status: "Action Required",
            next: "Complete assigned courses",
            to: R.learning,
          },
        ]
      : []),
  ];
  const caughtUp = actionItems.length === 0 && !timesheetNeedsAction && todayAtt.kind !== "leave";

  useEffect(() => {
    document.title = `Home · ${COMPANY_NAME}`;
  }, []);

  return (
    <div className="stack">
      <DashGreeting
        title={dayGreeting(employee.fullName)}
        subtitle={`${employee.designation} · ${formatLongDate(today)} · ${employee.timeZone} · ${activeCountry.name}`}
      />

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
            label="Today’s attendance"
            value={attendanceLabel}
            hint={
              checkInAt
                ? `In ${checkInAt}${checkOutAt ? ` · Out ${checkOutAt}` : ""} · ${employee.shiftHours}`
                : `${employee.shiftHours} · ${activeCountry.name}`
            }
          />
        </Link>
        <Link to={R.leave} className="metric-card-link">
          <MetricCard
            label="Leave balance"
            value={pto?.balance ?? "—"}
            hint={`PTO available · WFH ${wfh?.balance ?? "—"}`}
          />
        </Link>
        <Link to={urgentTask ? R.tasks : R.tasks} className="metric-card-link">
          <MetricCard
            label="Urgent tasks"
            value={myOpenTasks.length}
            hint={urgentTask ? urgentTask.subject : "You're all caught up"}
          />
        </Link>
        <Link to={R.timesheet} className="metric-card-link">
          <MetricCard
            label="Timesheet"
            value={timesheetNeedsAction ? "Action Required" : "Draft"}
            hint={TZ_EMPLOYEE_DEFAULTS.timesheetStatus}
          />
        </Link>
      </MetricGrid>

      <div className="mgr-home-grid">
        <Card title="Today · prioritize">
          {caughtUp ? (
            <div className="empty-state">
              <strong>You're all caught up</strong>
              <p>No pending leave, urgent tasks, or timesheet actions for today.</p>
            </div>
          ) : (
            <ul className="todo emp-action-list">
              {actionItems.map((item) => (
                <li key={item.id}>
                  <Link to={item.to} className="emp-action-row">
                    <span>
                      <strong>{item.label}</strong>
                      <span className="muted">{item.next}</span>
                    </span>
                    <StatusBadge status={item.status} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <div className="row-gap" style={{ marginTop: 12 }}>
            {!checkedIn && todayAtt.kind !== "leave" && (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setCheckedIn(true);
                  setCheckInAt(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
                  setCheckOutAt(null);
                }}
              >
                Check in
              </button>
            )}
            {checkedIn && !checkOutAt && (
              <button
                type="button"
                className="btn"
                onClick={() => setCheckOutAt(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))}
              >
                Check out
              </button>
            )}
            <Link className="btn-ghost" to={R.attendance}>
              Attendance history
            </Link>
          </div>
        </Card>

        <Card title="Leave & holidays" to={R.leave}>
          <LeaveTable rows={leaveTable} />
          <p className="muted" style={{ marginTop: 10 }}>
            Next holiday:{" "}
            {nextHoliday ? (
              <Link to={R.holidays}>
                {nextHoliday.name} · {formatShortDate(nextHoliday.date)}
              </Link>
            ) : (
              "None upcoming in your calendar"
            )}
          </p>
        </Card>

        <Card title="My timesheet" to={R.timesheet}>
          <p>
            <StatusBadge status={timesheetNeedsAction ? "Action Required" : "Draft"} />{" "}
            {TZ_EMPLOYEE_DEFAULTS.timesheetStatus}
          </p>
          <p className="muted">Project: {currentProjects[0]?.name ?? "No active assignment"}</p>
          <Link to={R.timesheet} className="btn" style={{ marginTop: 10, display: "inline-flex" }}>
            Open timesheet
          </Link>
        </Card>

        <Card title="Pay & benefits" to={R.payslips}>
          <ul className="todo">
            <li>
              <Link to={R.payslips}>
                Latest payslip · {payslipViews[0]?.label ?? "—"} <StatusBadge status="Approved" tone="ok" />
              </Link>
            </li>
            <li>
              <Link to={R.benefits}>Benefits enrollment</Link>
            </li>
            <li>
              <Link to={R.expenses}>Reimbursement claims</Link>
            </li>
          </ul>
        </Card>

        <Card title="Documents & letters" to={R.documents}>
          <ul className="todo">
            {TZ_EMPLOYEE_DEFAULTS.recentDocs.map((doc) => (
              <li key={doc.name}>
                <Link to={doc.to}>{doc.name}</Link>
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Performance & learning" to={R.performance}>
          <ul className="todo">
            {TZ_EMPLOYEE_DEFAULTS.goals.map((g) => (
              <li key={g.name}>
                <Link to={R.performance}>
                  {g.name} · {g.progress}%
                </Link>
              </li>
            ))}
            {TZ_EMPLOYEE_DEFAULTS.learningProgress.map((c) => (
              <li key={c.name}>
                <Link to={R.learning}>
                  {c.name} · {c.progress}%
                </Link>
              </li>
            ))}
            <li>
              <Link to={R.skills}>Skills & career plan</Link>
            </li>
          </ul>
        </Card>

        <Card title="People & organization" to={R.directory}>
          <p className="muted">
            {employee.department} · Manager on file · {employee.location}, {employee.countryName}
          </p>
          <div className="row-gap" style={{ marginTop: 10 }}>
            <Link className="btn-ghost" to={R.directory}>
              Directory
            </Link>
            <Link className="btn-ghost" to="/org-chart">
              Org chart
            </Link>
            <Link className="btn-ghost" to={R.profile}>
              My profile
            </Link>
          </div>
        </Card>

        <Card title="Messages & helpdesk" to={R.notifications}>
          <ul className="todo">
            <li>
              <Link to={R.notifications}>
                Notification Center <StatusBadge status="Action Required" />
              </Link>
            </li>
            <li>
              <Link to={R.messages}>Messages</Link>
            </li>
            <li>
              <Link to={R.help}>Helpdesk & HR requests</Link>
            </li>
          </ul>
        </Card>
      </div>
    </div>
  );
}

/* ───────────────────────────────────────────── B. MANAGER ── */

export function ManagerHome() {
  const { employee, state, demoProfile } = usePortal();
  const [range, setRange] = useDateRange("30d");
  const today = todayISO();
  const access = demoProfile.navAccess;

  const leavePending = state.leaveRequests.filter((item) => item.status === "pending" && item.employeeId !== employee.id);
  const timesheetPending = state.orgTimesheets.filter((item) => item.status === "submitted");
  const expensePending = state.expenses.filter((item) => item.status === "submitted" && item.employeeId !== employee.id);
  const pendingApprovals = leavePending.length + timesheetPending.length + expensePending.length;

  useEffect(() => {
    document.title = `Manager Home · ${COMPANY_NAME}`;
  }, []);

  return (
    <div className="stack">
      <DashGreeting
        title="Manager Home"
        subtitle={`${dayGreeting(employee.fullName)} · ${employee.designation} · ${formatLongDate(today)}`}
      />
      <DateRangeFilter value={range} onChange={setRange} />

      <MetricGrid>
        <MetricCard label="Team headcount" value={TZ_TEAM.managerTeamSize} hint="Direct reports" />
        <MetricCard
          label="Team attendance"
          value={`${TZ_TEAM.attendancePct}%`}
          hint={`${TZ_TEAM.presentToday} present · ${TZ_TEAM.wfhToday} WFH · ${TZ_TEAM.onLeaveToday} leave`}
        />
        <MetricCard label="Pending approvals" value={pendingApprovals} hint="Leave, timesheet, expense" />
        <MetricCard label="Open positions (team)" value={2} hint="Open roles on your team" />
      </MetricGrid>

      <div className="mgr-home-grid">
        <Card title="Team attendance today">
          <DataTable
            headers={["Name", "Code", "Role", "Status"]}
            rows={TZ_TEAM.directReports.map((r) => [
              r.name,
              r.code,
              r.role,
              <StatusBadge key={r.code} status={r.status} tone={r.status === "Leave" ? "warn" : "ok"} />,
            ])}
          />
        </Card>

        <Card title="Pending approvals" to="/approvals">
          <ul className="todo">
            <li>
              Leave requests <StatusBadge status={`${leavePending.length}`} tone="warn" />
            </li>
            <li>
              Timesheet approvals <StatusBadge status={`${timesheetPending.length}`} tone="warn" />
            </li>
            <li>
              Expense claims <StatusBadge status={`${expensePending.length}`} tone="info" />
            </li>
          </ul>
          <Link to="/approvals" className="quiet-link">
            Open approval queue
          </Link>
        </Card>

        <Card title="Leave requests" to="/leave">
          <DataTable
            headers={["Employee", "Type", "From", "Status"]}
            rows={leavePending.slice(0, 5).map((req) => [
              req.employeeId,
              req.code.toUpperCase(),
              formatShortDate(req.from),
              <StatusPill key={req.id} status={req.status} />,
            ])}
            empty={<p className="note">No pending leave from your team</p>}
          />
        </Card>

        <Card title="Timesheet approvals" to="/timesheet">
          <p>
            Submitted awaiting review: <strong>{timesheetPending.length}</strong>
          </p>
        </Card>

        <Card title="Goal progress" to={R.performance}>
          {TZ_TEAM.goals.map((g) => (
            <ProgressBar key={g.name} value={g.progress} label={g.name} />
          ))}
        </Card>

        <Card title="Performance review activities" to={R.performance}>
          <ul className="todo">
            <li>Priya · Mid-year check-in · 18 Oct</li>
            <li>Babu · Strong rating · follow-up goals · Done</li>
            <li>Anu · Skills feedback due · 22 Oct</li>
          </ul>
        </Card>

        <Card title="Team skills" to="/skills">
          <DataTable
            headers={["Skill", "Coverage", "Gap"]}
            rows={TZ_TEAM.skills.map((s) => [s.name, String(s.cover), s.gap])}
          />
        </Card>

        <Card title="New joiners">
          <ul className="todo">
            {TZ_TEAM.newJoiners.map((j) => (
              <li key={j.name}>
                {j.name} · {j.role} · {j.start}
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Open positions" to="/jobs">
          <ul className="todo">
            <li>Senior Frontend Engineer · Engineering · 1 opening</li>
            <li>QA Analyst · Quality · 1 opening</li>
          </ul>
        </Card>

        <Card title="Team alerts">
          <ul className="todo">
            <li className="warn">1 team member on leave today</li>
            <li className="info">Dussehra holiday calendar published</li>
            <li className="ok">No critical compliance overdue items</li>
          </ul>
        </Card>

        <Card title="Quick links">
          <AuthShortcuts
            allowed={access}
            items={[
              { label: "Team directory", to: "/directory", access: "people" },
              { label: "Approvals", to: "/approvals", access: "workflows" },
              { label: "Attendance", to: "/attendance", access: "attendance" },
              { label: "Performance", to: R.performance, access: "performance" },
              { label: "Analytics", to: "/analytics", access: "analytics" },
            ]}
          />
        </Card>
      </div>
    </div>
  );
}

/* ───────────────────────────────────────────── C. HR ADMIN ── */

export function HrAdminHome() {
  const { employee, demoProfile } = usePortal();
  const [range, setRange] = useDateRange("30d");
  const [tab, setTab] = useState("workforce");
  const move = movementForRange(range);

  useEffect(() => {
    document.title = `HR Admin Home · ${COMPANY_NAME}`;
  }, []);

  return (
    <div className="stack">
      <DashGreeting
        title="HR Admin Home"
        subtitle={`${dayGreeting(employee.fullName)} · Global people operations`}
      />
      <DateRangeFilter
        value={range}
        onChange={setRange}
        extras={
          <label className="filter-label">
            Country
            <select defaultValue="ALL">
              <option value="ALL">All countries</option>
              {TZ_HEADCOUNT.byCountry.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        }
      />

      <MetricGrid>
        <MetricCard label="Global headcount" value={TZ_HEADCOUNT.global} hint="All legal entities" />
        <MetricCard label={`Joiners (${move.label})`} value={move.joiners} hint={`Net +${move.net}`} />
        <MetricCard label={`Exits (${move.label})`} value={move.exits} />
        <MetricCard label="Open positions" value={TZ_RECRUITING.openRequisitions} hint={`${TZ_RECRUITING.candidates} candidates`} />
      </MetricGrid>

      <SoftTabs
        tabs={[
          { id: "workforce", label: "Workforce" },
          { id: "pipeline", label: "Recruitment" },
          { id: "cycles", label: "Cycles" },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === "workforce" && (
        <div className="mgr-home-grid">
          <Card title="Headcount by country">
            <MiniBars items={TZ_HEADCOUNT.byCountry.map((c) => ({ label: c.code, value: c.headcount }))} />
          </Card>
          <Card title="Pending HR actions" to="/workflows">
            <MetricCard label="Actions in queue" value={TZ_HR.pendingHrActions} hint="Cases, acknowledgments, onboarding" />
            <p className="note">Policy acknowledgments pending: {TZ_HR.policyAckPending}</p>
          </Card>
          <Card title="Leave trend">
            <MiniBars items={TZ_HR.leaveTrend.map((r) => ({ label: r.label, value: r.days }))} valueSuffix="d" />
          </Card>
          <Card title="Attendance trend">
            <MiniBars items={TZ_HR.attendanceTrend.map((r) => ({ label: r.label, value: r.pct }))} valueSuffix="%" />
          </Card>
        </div>
      )}

      {tab === "pipeline" && (
        <div className="mgr-home-grid">
          <Card title="Recruitment pipeline" to="/recruiting">
            <MiniBars items={TZ_RECRUITING.byStage.map((s) => ({ label: s.stage, value: s.count }))} />
          </Card>
          <Card title="Open requisitions">
            <DataTable
              headers={["ID", "Title", "Openings", "Stage"]}
              rows={TZ_RECRUITING.myOpenReqs.map((j) => [j.id, j.title, String(j.openings), j.stage])}
            />
          </Card>
        </div>
      )}

      {tab === "cycles" && (
        <div className="mgr-home-grid">
          <Card title="Performance cycle status" to={R.performance}>
            <p>
              {TZ_HR.performanceCycle.name} · due {TZ_HR.performanceCycle.due}
            </p>
            <ProgressBar value={TZ_HR.performanceCycle.completionPct} label="Completion" />
          </Card>
          <Card title="Learning completion" to={R.learning}>
            <ProgressBar value={TZ_HR.learningCompletionPct} label="Mandatory learning (global)" />
          </Card>
          <Card title="Workforce insights" to="/analytics">
            <ul className="todo">
              <li>YTD attrition {TZ_MOVEMENT.attritionYtdPct}%</li>
              <li>YTD hiring {TZ_MOVEMENT.hiringYtd}</li>
              <li>Capacity utilization {TZ_EXEC.capacity.utilizedPct}%</li>
            </ul>
          </Card>
        </div>
      )}

      <Card title="Employee directory shortcuts">
        <AuthShortcuts
          allowed={demoProfile.navAccess}
          items={[
            { label: "People directory", to: "/directory", access: "people" },
            { label: "Organization", to: "/organization", access: "organization" },
            { label: "Onboarding", to: "/onboarding", access: "onboarding" },
            { label: "Administration", to: R.admin, access: "administration" },
            { label: "Analytics", to: "/analytics", access: "analytics" },
          ]}
        />
      </Card>
    </div>
  );
}

/* ───────────────────────────────────────────── D. HRBP ── */

export function HrbpHome() {
  const { employee, demoProfile } = usePortal();
  const [range, setRange] = useDateRange("30d");
  const scope = TZ_HR.hrbpScope;

  useEffect(() => {
    document.title = `HRBP Home · ${COMPANY_NAME}`;
  }, []);

  return (
    <div className="stack">
      <DashGreeting title="HR Business Partner Home" subtitle={`${dayGreeting(employee.fullName)} · Assigned organization support`} />
      <DateRangeFilter value={range} onChange={setRange} />

      <MetricGrid>
        <MetricCard label="Org headcount" value={scope.employees} hint={scope.org} />
        <MetricCard label="Open HR cases" value={scope.cases} hint="Assigned to you" />
        <MetricCard label="Pending actions" value={11} hint="Lifecycle & policy" />
        <MetricCard
          label="Perf cycle progress"
          value={`${TZ_HR.performanceCycle.completionPct}%`}
          hint={TZ_HR.performanceCycle.name}
        />
      </MetricGrid>

      <div className="mgr-home-grid">
        <Card title="HR cases & pending actions" to="/workflows">
          <ul className="todo">
            <li>Case · Performance improvement plan · Kabir Sharma</li>
            <li>Action · Contract renewal · Diya Patel</li>
            <li>Case · Location transfer request · Ravi Menon</li>
            <li>Action · Policy ack chase · Engineering IN</li>
          </ul>
        </Card>

        <Card title="Workforce movement">
          <DataTable
            headers={["Type", "Employee", "Detail", "Date"]}
            rows={scope.movements.map((m) => [m.type, m.who, m.detail, m.date])}
          />
          <p className="note">Showing movements for filter: {range}</p>
        </Card>

        <Card title="Performance cycle progress" to={R.performance}>
          <ProgressBar value={TZ_HR.performanceCycle.completionPct} label={scope.org} />
          <p className="note">Org completion trails global average by ~4 pts (demo).</p>
        </Card>

        <Card title="Organization headcount mix">
          <MiniBars
            items={[
              { label: "Eng", value: 52 },
              { label: "QA", value: 18 },
              { label: "PM", value: 10 },
              { label: "Other", value: 6 },
            ]}
          />
        </Card>

        <Card title="Policy & lifecycle shortcuts">
          <AuthShortcuts
            allowed={demoProfile.navAccess}
            items={[
              { label: "Policies", to: "/policies", access: "documents" },
              { label: "Onboarding", to: "/onboarding", access: "onboarding" },
              { label: "People", to: "/directory", access: "people" },
              { label: "Performance", to: R.performance, access: "performance" },
              { label: "Leave", to: "/leave", access: "leave" },
            ]}
          />
        </Card>
      </div>
    </div>
  );
}

/* ───────────────────────────────────────────── E. RECRUITER ── */

export function RecruiterHome() {
  const { employee, demoProfile } = usePortal();
  const [range, setRange] = useDateRange("30d");
  const [query, setQuery] = useState("");
  const candidates = TZ_RECRUITING.candidatesAwaitingFeedback.filter(
    (c) => !query || c.name.toLowerCase().includes(query.toLowerCase()) || c.role.toLowerCase().includes(query.toLowerCase()),
  );

  useEffect(() => {
    document.title = `Recruiter Home · ${COMPANY_NAME}`;
  }, []);

  return (
    <div className="stack">
      <DashGreeting title="Recruiter Home" subtitle={`${dayGreeting(employee.fullName)} · Talent acquisition pipeline`} />
      <DateRangeFilter
        value={range}
        onChange={setRange}
        extras={
          <label className="filter-label">
            Candidate search
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name or role" />
          </label>
        }
      />

      <MetricGrid>
        <MetricCard label="Open requisitions" value={TZ_RECRUITING.openRequisitions} />
        <MetricCard label="Active candidates" value={TZ_RECRUITING.candidates} />
        <MetricCard label="Interviews this week" value={TZ_RECRUITING.interviewsThisWeek} />
        <MetricCard label="Avg time-to-hire" value={`${TZ_RECRUITING.avgTimeToHireDays}d`} hint={`Period: ${range}`} />
      </MetricGrid>

      <div className="mgr-home-grid">
        <Card title="Candidates by stage" to="/recruiting">
          <MiniBars items={TZ_RECRUITING.byStage.map((s) => ({ label: s.stage, value: s.count }))} />
        </Card>

        <Card title="Interview schedule">
          <DataTable
            headers={["When", "Candidate", "Role", "Panel"]}
            rows={TZ_RECRUITING.upcomingInterviews.map((i) => [i.when, i.candidate, i.role, i.panel])}
          />
        </Card>

        <Card title="Pending feedback">
          <DataTable
            headers={["Candidate", "Role", "Stage", "Due"]}
            rows={candidates.map((c) => [c.name, c.role, c.stage, c.due])}
            empty={<p className="note">No matches for “{query}”</p>}
          />
        </Card>

        <Card title="Offer status">
          <MetricGrid>
            <MetricCard label="Offers out" value={TZ_RECRUITING.offersOut} />
            <MetricCard label="Accepted" value={TZ_RECRUITING.offersAccepted} />
          </MetricGrid>
          <PlaceholderPanel title="Offer letters" detail="Document generation is a placeholder in this frontend prototype." />
        </Card>

        <Card title="Time-to-hire trend (demo chart)">
          <MiniBars
            items={[
              { label: "Jul", value: 38 },
              { label: "Aug", value: 36 },
              { label: "Sep", value: 35 },
              { label: "Oct", value: TZ_RECRUITING.avgTimeToHireDays },
            ]}
            valueSuffix="d"
          />
        </Card>

        <Card title="Recruiting shortcuts">
          <AuthShortcuts
            allowed={demoProfile.navAccess}
            items={[
              { label: "Recruiting hub", to: "/recruiting", access: "recruiting" },
              { label: "Jobs", to: "/jobs", access: "jobs" },
              { label: "Onboarding", to: "/onboarding", access: "onboarding" },
              { label: "People", to: "/directory", access: "people" },
            ]}
          />
        </Card>
      </div>
    </div>
  );
}

/* ───────────────────────────────────────────── F. HIRING MANAGER ── */

export function HiringManagerHome() {
  const { employee, demoProfile } = usePortal();
  const myReqs = TZ_RECRUITING.myOpenReqs.filter(
    (r) => r.owner === "Daniel Ortiz" || r.title.includes("React") || r.title.includes("Product"),
  );

  useEffect(() => {
    document.title = `Hiring Manager Home · ${COMPANY_NAME}`;
  }, []);

  return (
    <div className="stack">
      <DashGreeting title="Hiring Manager Home" subtitle={`${dayGreeting(employee.fullName)} · Your requisitions & interviews`} />

      <MetricGrid>
        <MetricCard label="My open requisitions" value={myReqs.length} />
        <MetricCard label="Awaiting my feedback" value={TZ_RECRUITING.pendingFeedback} />
        <MetricCard label="Upcoming interviews" value={TZ_RECRUITING.upcomingInterviews.length} />
        <MetricCard label="Hiring approvals" value={3} hint="Offer / grade approvals" />
      </MetricGrid>

      <div className="mgr-home-grid">
        <Card title="My open requisitions" to="/jobs">
          <DataTable
            headers={["ID", "Title", "Openings", "Stage"]}
            rows={TZ_RECRUITING.myOpenReqs
              .filter((j) => j.owner.includes("Daniel") || j.title.includes("React") || j.title.includes("Product"))
              .map((j) => [j.id, j.title, String(j.openings), j.stage])}
          />
        </Card>

        <Card title="Candidates awaiting feedback">
          <DataTable
            headers={["Candidate", "Role", "Stage", "Due"]}
            rows={TZ_RECRUITING.candidatesAwaitingFeedback.map((c) => [
              c.name,
              c.role,
              c.stage,
              c.due,
            ])}
          />
        </Card>

        <Card title="Upcoming interviews">
          <DataTable
            headers={["When", "Candidate", "Role"]}
            rows={TZ_RECRUITING.upcomingInterviews.map((i) => [i.when, i.candidate, i.role])}
          />
        </Card>

        <Card title="Interview evaluation forms">
          <ul className="todo">
            <li>
              <Link to="/recruiting">Technical scorecard · Aisha Khan</Link>
            </li>
            <li>
              <Link to="/recruiting">HM interview form · Lucas Meyer</Link>
            </li>
            <li>
              <Link to="/recruiting">Culture fit · Mei Lin</Link>
            </li>
          </ul>
          <PlaceholderPanel title="Scorecard submit" detail="Forms open in Recruiting module (prototype navigation)." />
        </Card>

        <Card title="Hiring approvals" to="/approvals">
          <ul className="todo">
            <li>Offer approval · Senior React Engineer · Grade L5</li>
            <li>Headcount confirmation · JOB-221</li>
            <li>Interview panel change · Finance Analyst</li>
          </ul>
        </Card>

        <Card title="Authorized links">
          <AuthShortcuts
            allowed={demoProfile.navAccess}
            items={[
              { label: "Recruiting", to: "/recruiting", access: "recruiting" },
              { label: "Jobs", to: "/jobs", access: "jobs" },
              { label: "Team", to: "/directory", access: "team" },
              { label: "Approvals", to: "/approvals", access: "workflows" },
            ]}
          />
        </Card>
      </div>
    </div>
  );
}

/* ───────────────────────────────────────────── G. CEO / EXEC ── */

export function ExecutiveHome() {
  const { employee, demoProfile } = usePortal();
  const [range, setRange] = useDateRange("ytd");
  const move = movementForRange(range);

  useEffect(() => {
    document.title = `Executive Home · ${COMPANY_NAME}`;
  }, []);

  return (
    <div className="stack">
      <DashGreeting title="Executive Home" subtitle={`${dayGreeting(employee.fullName)} · Workforce analytics`} />
      <DateRangeFilter value={range} onChange={setRange} />

      <MetricGrid>
        <MetricCard label="Global headcount" value={TZ_HEADCOUNT.global} />
        <MetricCard label="Net growth" value={`+${move.net}`} hint={move.label} />
        <MetricCard label="Attrition YTD" value={`${TZ_MOVEMENT.attritionYtdPct}%`} />
        <MetricCard label="Open requisitions" value={TZ_RECRUITING.openRequisitions} />
      </MetricGrid>

      <div className="mgr-home-grid">
        <Card title="Country distribution">
          <MiniBars items={TZ_HEADCOUNT.byCountry.map((c) => ({ label: c.code, value: c.headcount }))} />
        </Card>

        <Card title="Hiring & attrition trends">
          <MiniBars
            items={[
              { label: "Hire", value: move.joiners },
              { label: "Exit", value: move.exits },
            ]}
          />
          <p className="note">Hiring YTD {TZ_MOVEMENT.hiringYtd} · Exits YTD {TZ_MOVEMENT.exitsYtd}</p>
        </Card>

        <Card title="Workforce growth">
          <MiniBars items={TZ_HEADCOUNT.byBusinessUnit.map((b) => ({ label: b.name.replace("Infotech ", ""), value: b.headcount }))} />
        </Card>

        <Card title="Department overview">
          <MiniBars items={TZ_HEADCOUNT.byDepartment.map((d) => ({ label: d.name.slice(0, 8), value: d.headcount }))} />
        </Card>

        <Card title="Critical skill gaps" to="/skills">
          <DataTable
            headers={["Skill", "Gap", "Countries"]}
            rows={TZ_EXEC.criticalSkillGaps.map((s) => [s.skill, s.gap, s.countries])}
          />
        </Card>

        <Card title="Workforce capacity">
          <ProgressBar value={TZ_EXEC.capacity.utilizedPct} label="Utilized" />
          <p className="note">
            Bench {TZ_EXEC.capacity.benchPct}% · Hiring pressure: {TZ_EXEC.capacity.hiringPressure}
          </p>
        </Card>

        <Card title="Strategic alerts">
          <ul className="todo">
            {TZ_EXEC.strategicAlerts.map((a) => (
              <li key={a.text} className={a.tone}>
                {a.text}
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Authorized analytics">
          <AuthShortcuts
            allowed={demoProfile.navAccess}
            items={[
              { label: "Analytics", to: "/analytics", access: "analytics" },
              { label: "Organization", to: "/organization", access: "organization" },
              { label: "People", to: "/directory", access: "people" },
              { label: "Compensation", to: "/compensation", access: "compensation" },
              { label: "Administration", to: R.admin, access: "administration" },
            ]}
          />
        </Card>
      </div>
    </div>
  );
}

/* ───────────────────────────────────────────── H. FOUNDER ── */

export function FounderHome({ variant = "founder" }: { variant?: "founder" | "cofounder" }) {
  const { employee, demoProfile } = usePortal();
  const [range, setRange] = useDateRange("ytd");
  const move = movementForRange(range);
  const title = variant === "cofounder" ? "Co-founder Home" : "Founder Home";

  useEffect(() => {
    document.title = `${title} · ${COMPANY_NAME}`;
  }, [title]);

  return (
    <div className="stack">
      <DashGreeting title={title} subtitle={`${dayGreeting(employee.fullName)} · Executive workforce overview`} />
      <DateRangeFilter value={range} onChange={setRange} />

      <MetricGrid>
        <MetricCard label="Global headcount" value={TZ_HEADCOUNT.global} />
        <MetricCard label="Business units" value={TZ_HEADCOUNT.byBusinessUnit.length} />
        <MetricCard label="Hiring progress" value={move.joiners} hint={`Joiners · ${move.label}`} />
        <MetricCard label="Org growth" value={`+${move.net}`} hint="Net movement" />
      </MetricGrid>

      <div className="mgr-home-grid">
        <Card title="Business-unit trends">
          <MiniBars items={TZ_HEADCOUNT.byBusinessUnit.map((b) => ({ label: b.name.replace("Infotech ", ""), value: b.headcount }))} />
        </Card>

        <Card title="Country trends">
          <MiniBars items={TZ_HEADCOUNT.byCountry.map((c) => ({ label: c.code, value: c.headcount }))} />
        </Card>

        <Card title="Hiring progress" to="/recruiting">
          <ProgressBar value={Math.round((TZ_RECRUITING.offersAccepted / Math.max(TZ_RECRUITING.offersOut, 1)) * 100)} label="Offer acceptance" />
          <p className="note">
            {TZ_RECRUITING.openRequisitions} open reqs · avg TTH {TZ_RECRUITING.avgTimeToHireDays} days
          </p>
        </Card>

        <Card title="Organization growth">
          <ul className="todo">
            <li>YTD joiners {TZ_MOVEMENT.joinersYtd}</li>
            <li>YTD exits {TZ_MOVEMENT.exitsYtd}</li>
            <li>Attrition {TZ_MOVEMENT.attritionYtdPct}%</li>
          </ul>
        </Card>

        <Card title="Approved strategic reports" to="/analytics">
          <ul className="todo">
            <li>
              <Link to="/analytics">Workforce capacity board (authorized)</Link>
            </li>
            <li>
              <Link to="/analytics">Country headcount pack Q3</Link>
            </li>
            <li>
              <Link to="/analytics">Attrition deep-dive EMEA</Link>
            </li>
          </ul>
        </Card>

        <Card title="Company announcements">
          <DataTable
            headers={["Announcement", "When", "Audience"]}
            rows={TZ_EXEC.announcements.map((a) => [a.title, a.when, a.audience])}
          />
        </Card>

        <Card title="Shortcuts · explicitly authorized functions">
          <AuthShortcuts
            allowed={demoProfile.navAccess}
            items={[
              { label: "Analytics", to: "/analytics", access: "analytics" },
              { label: "Organization", to: "/organization", access: "organization" },
              { label: "People", to: "/directory", access: "people" },
              { label: "Recruiting", to: "/recruiting", access: "recruiting" },
              { label: "Workflows", to: "/workflows", access: "workflows" },
              { label: "Administration", to: R.admin, access: "administration" },
            ]}
          />
        </Card>
      </div>
    </div>
  );
}

/* ───────────────────────────────────────────── I. ADMINISTRATION ── */

export function AdministrationHome() {
  const { employee, demoProfile } = usePortal();
  const [tab, setTab] = useState("users");
  const [roleFilter, setRoleFilter] = useState("all");

  useEffect(() => {
    document.title = `Administration Home · ${COMPANY_NAME}`;
  }, []);

  const roleRows = [
    { role: "Employee", users: 412, perms: "Self-service" },
    { role: "Manager", users: 48, perms: "Team approvals" },
    { role: "HR", users: 8, perms: "People ops" },
    { role: "Recruiter", users: 9, perms: "ATS" },
    { role: "Hiring Manager", users: 22, perms: "Requisitions" },
    { role: "Executive", users: 5, perms: "Analytics overview" },
    { role: "Compensation", users: 3, perms: "Pay & benefits" },
    { role: "Admin", users: 4, perms: "Platform" },
  ].filter((r) => roleFilter === "all" || r.role.toLowerCase().includes(roleFilter));

  return (
    <div className="stack">
      <DashGreeting title="Administration Home" subtitle={`${dayGreeting(employee.fullName)} · Platform configuration`} />

      <MetricGrid>
        <MetricCard label="Users" value={TZ_ADMIN.users} />
        <MetricCard label="Active roles" value={TZ_ADMIN.activeRoles} />
        <MetricCard label="Legal entities" value={TZ_ADMIN.legalEntities} />
        <MetricCard
          label="Integration health"
          value={TZ_ADMIN.integrations.filter((i) => i.status === "Healthy").length}
          hint={`of ${TZ_ADMIN.integrations.length} connectors`}
        />
      </MetricGrid>

      <SoftTabs
        tabs={[
          { id: "users", label: "Users & roles" },
          { id: "perms", label: "Permissions" },
          { id: "entities", label: "Countries & entities" },
          { id: "integrations", label: "Integrations" },
          { id: "audit", label: "Audit log" },
          { id: "platform", label: "Platform" },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === "users" && (
        <Card title="User and role management">
          <div className="filter-bar">
            <label className="filter-label">
              Filter roles
              <input value={roleFilter === "all" ? "" : roleFilter} onChange={(e) => setRoleFilter(e.target.value || "all")} placeholder="e.g. manager" />
            </label>
          </div>
          <DataTable
            headers={["Role", "Users", "Permission summary"]}
            rows={roleRows.map((r) => [r.role, String(r.users), r.perms])}
          />
          <PlaceholderPanel title="Create user" detail="User provisioning UI placeholder — no backend write." />
        </Card>
      )}

      {tab === "perms" && (
        <Card title="Permission configuration">
          <DataTable
            headers={["Capability", "Employee", "Manager", "HR Admin", "Executive"]}
            rows={[
              ["Self profile", "Yes", "Yes", "Yes", "Yes"],
              ["Team approvals", "No", "Yes", "Yes", "No*"],
              ["Global HR config", "No", "No", "Yes", "No"],
              ["Workforce analytics", "No", "Limited", "Yes", "Yes"],
              ["Administration", "No", "No", "Limited", "No"],
            ]}
          />
          <p className="note">* Executives do not receive approval rights from title alone — grant via role binding.</p>
        </Card>
      )}

      {tab === "entities" && (
        <Card title="Country and legal entity settings">
          <DataTable
            headers={["Country", "Headcount", "Currency", "Legal entity (demo)"]}
            rows={TZ_HEADCOUNT.byCountry.map((c) => [
              c.name,
              String(c.headcount),
              c.currency,
              `Infotech ${c.code}`,
            ])}
          />
        </Card>
      )}

      {tab === "integrations" && (
        <Card title="Integration health">
          <DataTable
            headers={["Integration", "Status"]}
            rows={TZ_ADMIN.integrations.map((i) => [
              i.name,
              <StatusBadge key={i.name} status={i.status} tone={i.status === "Healthy" ? "ok" : "warn"} />,
            ])}
          />
          <PlaceholderPanel title="Reconnect" detail="Connector diagnostics are placeholders in the frontend prototype." />
        </Card>
      )}

      {tab === "audit" && (
        <Card title="Audit log viewer">
          <DataTable
            headers={["When", "Actor", "Action", "Target"]}
            rows={TZ_ADMIN.auditEvents.map((e) => [e.at, e.actor, e.action, e.target])}
          />
        </Card>
      )}

      {tab === "platform" && (
        <Card title="Platform configuration">
          <ul className="todo">
            <li>Session timeout · 8 hours (demo)</li>
            <li>Password policy · 90-day rotation</li>
            <li>Feature flags · Copilot enabled · Agents beta</li>
            <li>Branding · Infotech navy / indigo</li>
          </ul>
          <AuthShortcuts
            allowed={demoProfile.navAccess}
            items={[
              { label: "Administration module", to: R.admin, access: "administration" },
              { label: "Integrations", to: "/integrations", access: "integrations" },
              { label: "Workflows", to: "/workflows", access: "workflows" },
            ]}
          />
        </Card>
      )}
    </div>
  );
}

/* Learning / Performance / Comp / Finance specialized homes */

export function LearningAdminHome() {
  const { employee, demoProfile } = usePortal();
  useEffect(() => {
    document.title = `Learning Admin Home · ${COMPANY_NAME}`;
  }, []);
  return (
    <div className="stack">
      <DashGreeting title="Learning Administrator Home" subtitle={dayGreeting(employee.fullName)} />
      <MetricGrid>
        <MetricCard label="Global completion" value={`${TZ_HR.learningCompletionPct}%`} />
        <MetricCard label="Active learners" value={TZ_HEADCOUNT.global} hint="Assigned catalog" />
        <MetricCard label="Overdue courses" value={86} />
        <MetricCard label="New programs" value={4} hint="This quarter" />
      </MetricGrid>
      <div className="mgr-home-grid">
        <Card title="Completion by country">
          <MiniBars
            items={TZ_HEADCOUNT.byCountry.slice(0, 5).map((c) => ({
              label: c.code,
              value: 60 + (c.headcount % 30),
            }))}
            valueSuffix="%"
          />
        </Card>
        <Card title="Shortcuts">
          <AuthShortcuts
            allowed={demoProfile.navAccess}
            items={[
              { label: "Learning", to: R.learning, access: "learning" },
              { label: "Skills", to: "/skills", access: "skills" },
              { label: "Analytics", to: "/analytics", access: "analytics" },
            ]}
          />
        </Card>
      </div>
    </div>
  );
}

export function PerformanceAdminHome() {
  const { employee, demoProfile } = usePortal();
  useEffect(() => {
    document.title = `Performance Admin Home · ${COMPANY_NAME}`;
  }, []);
  return (
    <div className="stack">
      <DashGreeting title="Performance Administrator Home" subtitle={dayGreeting(employee.fullName)} />
      <MetricGrid>
        <MetricCard label="Cycle completion" value={`${TZ_HR.performanceCycle.completionPct}%`} hint={TZ_HR.performanceCycle.name} />
        <MetricCard label="Reviews overdue" value={37} />
        <MetricCard label="Calibration sessions" value={5} hint="Scheduled" />
        <MetricCard label="Goal templates" value={14} />
      </MetricGrid>
      <Card title="Authorized links">
        <AuthShortcuts
          allowed={demoProfile.navAccess}
          items={[
            { label: "Performance", to: R.performance, access: "performance" },
            { label: "People", to: "/directory", access: "people" },
            { label: "Analytics", to: "/analytics", access: "analytics" },
          ]}
        />
      </Card>
    </div>
  );
}

export function CompensationAdminHome() {
  const { employee, demoProfile } = usePortal();
  useEffect(() => {
    document.title = `Compensation Admin Home · ${COMPANY_NAME}`;
  }, []);
  return (
    <div className="stack">
      <DashGreeting title="Compensation Administrator Home" subtitle={dayGreeting(employee.fullName)} />
      <MetricGrid>
        <MetricCard label="Countries in cycle" value={TZ_HEADCOUNT.byCountry.length} />
        <MetricCard label="Budgets locked" value={3} hint="of 8 entities" />
        <MetricCard label="Pending approvals" value={22} />
        <MetricCard label="Band exceptions" value={9} />
      </MetricGrid>
      <Card title="Shortcuts">
        <AuthShortcuts
          allowed={demoProfile.navAccess}
          items={[
            { label: "Compensation", to: "/compensation", access: "compensation" },
            { label: "Benefits", to: "/benefits", access: "benefits" },
            { label: "Analytics", to: "/analytics", access: "analytics" },
          ]}
        />
      </Card>
    </div>
  );
}

export function FinanceHome() {
  const { employee, demoProfile } = usePortal();
  useEffect(() => {
    document.title = `Finance Home · ${COMPANY_NAME}`;
  }, []);
  return (
    <div className="stack">
      <DashGreeting title="Finance Home" subtitle={dayGreeting(employee.fullName)} />
      <MetricGrid>
        <MetricCard label="Expense queue" value={41} />
        <MetricCard label="Payroll entities ready" value={6} hint="of 8" />
        <MetricCard label="Cash advances" value={12} />
        <MetricCard label="Reimbursements" value={28} />
      </MetricGrid>
      <Card title="Shortcuts">
        <AuthShortcuts
          allowed={demoProfile.navAccess}
          items={[
            { label: "Payroll", to: "/payroll", access: "payroll" },
            { label: "Approvals", to: "/approvals", access: "workflows" },
            { label: "Analytics", to: "/analytics", access: "analytics" },
          ]}
        />
      </Card>
    </div>
  );
}

export function RoleHomeRouter({ profile }: { profile: DemoAccount }) {
  switch (profile.role) {
    case "employee":
      return <EmployeeHome />;
    case "manager":
      return <ManagerHome />;
    case "hr_admin":
    case "hr":
      return <HrAdminHome />;
    case "hrbp":
      return <HrbpHome />;
    case "recruiter":
      return <RecruiterHome />;
    case "hiring_manager":
      return <HiringManagerHome />;
    case "executive":
      return <ExecutiveHome />;
    case "founder":
      return <FounderHome variant="founder" />;
    case "cofounder":
      return <FounderHome variant="cofounder" />;
    case "learning_admin":
      return <LearningAdminHome />;
    case "performance_admin":
      return <PerformanceAdminHome />;
    case "compensation_admin":
      return <CompensationAdminHome />;
    case "finance":
      return <FinanceHome />;
    case "it_admin":
    case "admin":
    case "super_admin":
    case "compliance":
      return <AdministrationHome />;
    default:
      return <EmployeeHome />;
  }
}
