import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { COMPANY_NAME } from "../../brand.ts";
import { ProfileEditForm } from "../../components/ProfileEditForm.tsx";
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
import type { DemoAccount, NavAccessId } from "../../demoAccounts.ts";
import {
  attendanceOn,
  dayGreeting,
  daySubGreeting,
  formatLongDate,
  formatShortDate,
  maskAddress,
  maskEmail,
  maskInr,
  maskMobile,
  monthCells,
  monthLabel,
  todayISO,
} from "../../model.ts";
import { usePortal } from "../../store.tsx";
import {
  AuthShortcuts,
  DashGreeting,
  DateRangeFilter,
  MiniBars,
  PlaceholderPanel,
  ProgressBar,
  ScopeBanner,
  SoftTabs,
  useDateRange,
} from "./widgets.tsx";

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
  const { employee, leaveTable, counts, payslipViews, currentProjects, state, hoursFor } = usePortal();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(employee);
  const [photoFile, setPhotoFile] = useState("");
  const [checkedIn, setCheckedIn] = useState(false);
  const [checkInAt, setCheckInAt] = useState<string | null>(null);
  const [checkOutAt, setCheckOutAt] = useState<string | null>(null);
  const today = todayISO();
  const now = new Date();
  const [holidayCursor, setHolidayCursor] = useState({ year: now.getFullYear(), month: now.getMonth() });
  const holidayCells = monthCells(holidayCursor.year, holidayCursor.month);
  const holidaysByDate = useMemo(
    () => new Map(state.holidays.map((holiday) => [holiday.date, holiday])),
    [state.holidays],
  );
  const nextHoliday = state.holidays.find((holiday) => holiday.date >= today);
  const [pickedHoliday, setPickedHoliday] = useState<string | null>(null);
  const pto = leaveTable.find((row) => row.code === "pto");
  const wfh = leaveTable.find((row) => row.code === "wfh");
  const waiting = counts.tasks + counts.timesheet + counts.evaluation + counts.programs;
  const personalPending = state.leaveRequests.filter(
    (item) => item.employeeId === employee.id && item.status === "pending",
  );

  useEffect(() => {
    document.title = `Home · ${COMPANY_NAME}`;
  }, []);

  useEffect(() => {
    if (!editing) setDraft(employee);
  }, [employee, editing]);

  function readPhoto(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      const image = new Image();
      image.onload = () => {
        const size = 320;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const context = canvas.getContext("2d");
        if (!context) return;
        const scale = Math.max(size / image.width, size / image.height);
        const width = image.width * scale;
        const height = image.height * scale;
        context.drawImage(image, (size - width) / 2, (size - height) / 2, width, height);
        setPhotoFile(canvas.toDataURL("image/jpeg", 0.86));
      };
      image.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  }

  const todayAtt = attendanceOn(today, state.holidays, state.leaveRequests, [], employee.shiftHours, today, employee.id);

  return (
    <div className="stack">
      <DashGreeting title={dayGreeting(employee.fullName)} subtitle={daySubGreeting()} />
      <ScopeBanner scope="Personal self-service only" note="Team and org analytics are not included for this persona" />

      <MetricGrid>
        <MetricCard label="Profile completion" value={`${TZ_EMPLOYEE_DEFAULTS.profileCompletionPct}%`} hint="Update photo & contacts" />
        <MetricCard
          label="Today's attendance"
          value={todayAtt.kind === "leave" ? "On leave" : checkedIn ? "Checked in" : "Not checked in"}
          hint={checkInAt ? `In ${checkInAt}${checkOutAt ? ` · Out ${checkOutAt}` : ""}` : "Demo check-in"}
        />
        <MetricCard label="Pending requests" value={personalPending.length + waiting} hint="Leave, tasks, timesheet" />
        <MetricCard label="Timesheet" value="Draft" hint={TZ_EMPLOYEE_DEFAULTS.timesheetStatus} />
      </MetricGrid>

      <div className="mgr-home-grid">
        <Card title="Profile" action={!editing ? <button type="button" className="quiet-link" onClick={() => setEditing(true)}>Edit</button> : undefined}>
          {editing ? (
            <ProfileEditForm
              draft={draft}
              photoFile={photoFile}
              onChange={setDraft}
              onPhoto={(file) => file && readPhoto(file)}
              onSave={() => setEditing(false)}
              onCancel={() => {
                setDraft(employee);
                setEditing(false);
              }}
            />
          ) : (
            <div className="identity">
              <div className="identity-person">
                <img className="identity-photo" src={photoFile || employee.photo} alt="" />
                <div>
                  <h2 className="identity-name">{employee.fullName}</h2>
                  <p className="muted">
                    {employee.designation} · {employee.employeeCode}
                  </p>
                  <p className="muted">{maskEmail(employee.email)}</p>
                  <p className="muted">{maskMobile(employee.mobile)}</p>
                  <p className="muted">{maskAddress(employee.address)}</p>
                </div>
              </div>
              <ProgressBar value={TZ_EMPLOYEE_DEFAULTS.profileCompletionPct} label="Profile completion" />
            </div>
          )}
        </Card>

        <Card title="Check-in / Check-out (demo)">
          <p className="note">
            {formatLongDate(today)} · {employee.shiftHours}
          </p>
          <div className="row-gap" style={{ marginTop: 12 }}>
            <button
              type="button"
              className="btn primary"
              disabled={checkedIn && !checkOutAt}
              onClick={() => {
                setCheckedIn(true);
                setCheckInAt(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
                setCheckOutAt(null);
              }}
            >
              Check in
            </button>
            <button
              type="button"
              className="btn"
              disabled={!checkedIn || !!checkOutAt}
              onClick={() => {
                setCheckOutAt(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
              }}
            >
              Check out
            </button>
            <button
              type="button"
              className="btn quiet"
              onClick={() => {
                setCheckedIn(false);
                setCheckInAt(null);
                setCheckOutAt(null);
              }}
            >
              Reset demo
            </button>
          </div>
          <p className="note" style={{ marginTop: 10 }}>
            Frontend-only attendance demo — not persisted to a server.
          </p>
        </Card>

        <Card title="Leave balances" to="/leave">
          <LeaveTable rows={leaveTable} />
          <p className="note">
            PTO remaining: {pto?.remaining ?? "—"} · WFH remaining: {wfh?.remaining ?? "—"}
          </p>
        </Card>

        <Card title="Upcoming holidays">
          <div className="row-between" style={{ marginBottom: 8 }}>
            <button
              type="button"
              className="quiet-link"
              onClick={() =>
                setHolidayCursor((c) => {
                  const month = c.month - 1;
                  return month < 0 ? { year: c.year - 1, month: 11 } : { year: c.year, month };
                })
              }
            >
              Prev
            </button>
            <strong>{monthLabel(holidayCursor.year, holidayCursor.month)}</strong>
            <button
              type="button"
              className="quiet-link"
              onClick={() =>
                setHolidayCursor((c) => {
                  const month = c.month + 1;
                  return month > 11 ? { year: c.year + 1, month: 0 } : { year: c.year, month };
                })
              }
            >
              Next
            </button>
          </div>
          <div className="holiday-grid">
            {holidayCells.map((cell) => {
              const hol = cell.iso ? holidaysByDate.get(cell.iso) : undefined;
              return (
                <button
                  key={cell.key}
                  type="button"
                  className={`holiday-cell ${hol ? "is-holiday" : ""} ${pickedHoliday === cell.iso ? "is-picked" : ""}`}
                  disabled={!cell.iso}
                  onClick={() => cell.iso && setPickedHoliday(cell.iso)}
                >
                  {cell.day || ""}
                </button>
              );
            })}
          </div>
          <p className="note">
            Next: {nextHoliday ? `${nextHoliday.name} · ${formatShortDate(nextHoliday.date)}` : "None upcoming"}
            {pickedHoliday && holidaysByDate.get(pickedHoliday)
              ? ` · Selected: ${holidaysByDate.get(pickedHoliday)!.name}`
              : ""}
          </p>
        </Card>

        <Card title="Pending personal requests" to="/tasks">
          <ul className="todo">
            {personalPending.length === 0 && waiting === 0 ? (
              <li>No pending personal items</li>
            ) : (
              <>
                {personalPending.map((req) => (
                  <li key={req.id}>
                    Leave · {req.code.toUpperCase()} · {formatShortDate(req.from)} <StatusPill status={req.status} />
                  </li>
                ))}
                {counts.tasks > 0 && <li>{counts.tasks} open task(s)</li>}
                {counts.timesheet > 0 && <li>Timesheet needs attention</li>}
                {counts.evaluation > 0 && <li>{counts.evaluation} evaluation item(s)</li>}
              </>
            )}
          </ul>
        </Card>

        <Card title="Timesheet status" to="/timesheet">
          <p>
            <StatusBadge status="draft" tone="warn" /> {TZ_EMPLOYEE_DEFAULTS.timesheetStatus}
          </p>
          <p className="note">Hours this week (demo): {hoursFor?.(today) ?? "—"}</p>
          <Link to="/timesheet" className="btn" style={{ marginTop: 8, display: "inline-flex" }}>
            Open timesheet
          </Link>
        </Card>

        <Card title="Goals" to="/performance">
          {TZ_EMPLOYEE_DEFAULTS.goals.map((goal) => (
            <ProgressBar key={goal.name} value={goal.progress} label={goal.name} />
          ))}
        </Card>

        <Card title="Learning progress" to="/learning">
          {TZ_EMPLOYEE_DEFAULTS.learningProgress.map((course) => (
            <ProgressBar key={course.name} value={course.progress} label={course.name} />
          ))}
        </Card>

        <Card title="Recently accessed documents" to="/documents">
          <ul className="todo">
            {TZ_EMPLOYEE_DEFAULTS.recentDocs.map((doc) => (
              <li key={doc.name}>
                <Link to={doc.to}>{doc.name}</Link>
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Notifications" to="/inbox">
          <ul className="todo">
            <li>Payslip available · {payslipViews[0]?.period ?? "Sep 2026"}</li>
            <li>Policy acknowledgment due · Leave Policy</li>
            <li>
              Project focus: {currentProjects[0]?.name ?? "—"}
            </li>
          </ul>
        </Card>

        <Card title="AI Assistant" to="/copilot">
          <p className="note">Ask TimeZ Copilot about leave balances, policies, or timesheet tips.</p>
          <Link to="/copilot" className="btn primary" style={{ marginTop: 8, display: "inline-flex" }}>
            Open Copilot
          </Link>
          <PlaceholderPanel title="Suggested prompts" detail='"How many PTO days do I have left?" · "Show holiday calendar for October"' />
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
        subtitle={`${dayGreeting(employee.fullName)} · Team lead overview · ${formatLongDate(today)}`}
      />
      <ScopeBanner
        scope="Direct reports & team approvals only"
        note="Global org metrics and administration are outside this persona's authorization"
      />
      <DateRangeFilter value={range} onChange={setRange} />

      <MetricGrid>
        <MetricCard label="Team headcount" value={TZ_TEAM.managerTeamSize} hint="Authorized direct reports" />
        <MetricCard
          label="Team attendance"
          value={`${TZ_TEAM.attendancePct}%`}
          hint={`${TZ_TEAM.presentToday} present · ${TZ_TEAM.wfhToday} WFH · ${TZ_TEAM.onLeaveToday} leave`}
        />
        <MetricCard label="Pending approvals" value={pendingApprovals} hint="Leave, timesheet, expense" />
        <MetricCard label="Open positions (team)" value={2} hint="Hiring manager share not included" />
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
          <p className="note">Period filter: {range} (demo filter — queue uses live mock store)</p>
        </Card>

        <Card title="Goal progress" to="/performance">
          {TZ_TEAM.goals.map((g) => (
            <ProgressBar key={g.name} value={g.progress} label={g.name} />
          ))}
        </Card>

        <Card title="Performance review activities" to="/performance">
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

        <Card title="Quick links · authorized direct reports">
          <AuthShortcuts
            allowed={access}
            items={[
              { label: "Team directory", to: "/directory", access: "people" },
              { label: "Approvals", to: "/approvals", access: "workflows" },
              { label: "Attendance", to: "/attendance", access: "attendance" },
              { label: "Performance", to: "/performance", access: "performance" },
              { label: "Analytics", to: "/analytics", access: "analytics" },
            ]}
          />
          <p className="note">Links appear only when listed in this persona&apos;s navAccess mock config.</p>
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
      <ScopeBanner
        scope="Global HR configuration & workforce oversight"
        note="Payroll run execution and IT integrations require separate personas"
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
          <Card title="Performance cycle status" to="/performance">
            <p>
              {TZ_HR.performanceCycle.name} · due {TZ_HR.performanceCycle.due}
            </p>
            <ProgressBar value={TZ_HR.performanceCycle.completionPct} label="Completion" />
          </Card>
          <Card title="Learning completion" to="/learning">
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
            { label: "Administration", to: "/administration", access: "administration" },
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
      <ScopeBanner scope={scope.org} note={`${scope.employees} employees in scope — not full-company admin`} />
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

        <Card title="Performance cycle progress" to="/performance">
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
              { label: "Performance", to: "/performance", access: "performance" },
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
      <ScopeBanner scope="Recruiting & ATS modules" note="Compensation bands and payroll are not authorized" />
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
  const myReqs = TZ_RECRUITING.myOpenReqs.filter((r) => r.owner === "Daniel Ortiz" || r.id === "JOB-221");

  useEffect(() => {
    document.title = `Hiring Manager Home · ${COMPANY_NAME}`;
  }, []);

  return (
    <div className="stack">
      <DashGreeting title="Hiring Manager Home" subtitle={`${dayGreeting(employee.fullName)} · Your requisitions & interviews`} />
      <ScopeBanner
        scope="Requisitions you own + interview feedback"
        note="Full ATS admin and global headcount analytics are not included"
      />

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
      <DashGreeting title="Executive Home" subtitle={`${dayGreeting(employee.fullName)} · Authorized workforce analytics`} />
      <ScopeBanner
        scope="Strategic workforce analytics (read)"
        note="Title alone does not grant administration, payroll run, or unrestricted employee PII export"
      />
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
          <MiniBars items={TZ_HEADCOUNT.byBusinessUnit.map((b) => ({ label: b.name.replace("TimeZ ", ""), value: b.headcount }))} />
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
              { label: "Administration", to: "/administration", access: "administration" },
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
      <ScopeBanner
        scope="Approved strategic reports & company announcements"
        note="Platform administration and integration keys require Super Admin / IT Admin personas"
      />
      <DateRangeFilter value={range} onChange={setRange} />

      <MetricGrid>
        <MetricCard label="Global headcount" value={TZ_HEADCOUNT.global} />
        <MetricCard label="Business units" value={TZ_HEADCOUNT.byBusinessUnit.length} />
        <MetricCard label="Hiring progress" value={move.joiners} hint={`Joiners · ${move.label}`} />
        <MetricCard label="Org growth" value={`+${move.net}`} hint="Net movement" />
      </MetricGrid>

      <div className="mgr-home-grid">
        <Card title="Business-unit trends">
          <MiniBars items={TZ_HEADCOUNT.byBusinessUnit.map((b) => ({ label: b.name.replace("TimeZ ", ""), value: b.headcount }))} />
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
              { label: "Administration", to: "/administration", access: "administration" },
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
    { role: "HR Admin", users: 6, perms: "Global HR" },
    { role: "HRBP", users: 12, perms: "Org scope" },
    { role: "Recruiter", users: 9, perms: "ATS" },
    { role: "IT Admin", users: 4, perms: "Integrations" },
  ].filter((r) => roleFilter === "all" || r.role.toLowerCase().includes(roleFilter));

  return (
    <div className="stack">
      <DashGreeting title="Administration Home" subtitle={`${dayGreeting(employee.fullName)} · Platform configuration`} />
      <ScopeBanner
        scope="User, role, entity, and integration administration"
        note="Destructive production actions are simulated only in this prototype"
      />

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
              `TimeZ ${c.code}`,
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
            <li>Branding · TimeZ navy / indigo</li>
          </ul>
          <AuthShortcuts
            allowed={demoProfile.navAccess}
            items={[
              { label: "Administration module", to: "/administration", access: "administration" },
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
      <ScopeBanner scope="Learning catalog, assignments, and completion analytics" />
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
              { label: "Learning", to: "/learning", access: "learning" },
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
      <ScopeBanner scope="Performance cycles, templates, and calibration (authorized)" />
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
            { label: "Performance", to: "/performance", access: "performance" },
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
      <ScopeBanner scope="Compensation cycles & bands" note="Individual payslip PII limited by policy" />
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
      <ScopeBanner scope="Payroll readiness & expense oversight" note="Not a substitute for HR Admin workforce config" />
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
