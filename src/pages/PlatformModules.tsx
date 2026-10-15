import { useMemo, useState, useSyncExternalStore } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { PRODUCT_NAME } from "../brand.ts";
import {
  Banner,
  Card,
  DataTable,
  Dialog,
  EmptyState,
  Field,
  FilterBar,
  MetricCard,
  MetricGrid,
  Page,
  StatusBadge,
  Tabs,
} from "../components/ui.tsx";
import { OrgChart } from "../components/OrgChart.tsx";
import { DEMO_ACCOUNTS } from "../demoAccounts.ts";
import { TZ_TEAM } from "../data/dashboardMock.ts";
import { getCompensationAccess, hasModuleAccess } from "../data/peoplePermissions.ts";
import { canViewReport, getReportScopes } from "../data/rbac.ts";
import {
  ADMIN_LOCATIONS,
  ADMIN_ORG_SETTINGS,
  AI_AGENTS,
  ANALYTICS_DEPARTMENTS,
  ANALYTICS_RANGES,
  COMP_REVIEW_STATUS,
  COPILOT_SUGGESTIONS,
  DEMO_ONLY,
  LEARNING_METRICS,
  PAYROLL_STATUS,
  PERFORMANCE_CYCLE,
  PIPELINE_BY_COUNTRY,
  ROLE_PERMISSION_CATALOG,
  SKILLS_CAPACITY,
  answerCopilot,
  attendanceSeries,
  copilotPersonaFromRole,
  leaveSeries,
  overtimeSeries,
  type AnalyticsRange,
  type CopilotAnswer,
  workforceMetrics,
} from "../data/platformData.ts";
import { ProgressBar } from "./dashboards/widgets.tsx";
import {
  effectiveNavIds,
  getPlatformVersion,
  listAuditLog,
  listIntegrations,
  listNotificationPrefs,
  retryIntegration,
  saveRoleEdit,
  subscribePlatform,
  updateNotificationPref,
} from "../data/platformLocal.ts";
import { RegionalFilter } from "../locale/RegionalFilter.tsx";
import { useLocale } from "../locale/LocaleContext.tsx";
import type { CountryCode } from "../model.ts";
import { roleLabel } from "../nav.ts";
import { usePortal } from "../store.tsx";

function usePlatformTick() {
  return useSyncExternalStore(subscribePlatform, getPlatformVersion, getPlatformVersion);
}

function BarRows({
  items,
  max,
  format = (n) => String(n),
}: {
  items: { label: string; value: number }[];
  max?: number;
  format?: (n: number) => string;
}) {
  const peak = max ?? Math.max(1, ...items.map((i) => i.value));
  return (
    <ul className="tz-bars" aria-label="Chart">
      {items.map((item) => (
        <li key={item.label}>
          <span className="tz-bar-label">{item.label}</span>
          <span className="tz-bar-track">
            <span className="tz-bar-fill" style={{ width: `${Math.min(100, (item.value / peak) * 100)}%` }} />
          </span>
          <span className="tz-bar-value">{format(item.value)}</span>
        </li>
      ))}
    </ul>
  );
}

function DemoBanner({ text = DEMO_ONLY }: { text?: string }) {
  return <Banner message={{ tone: "info", text }} />;
}

/* ───────────────── Analytics ───────────────── */

export function AnalyticsPage() {
  const { demoProfile, employee, state } = usePortal();
  const { regionCode, activeCountry, t, formatMoney } = useLocale();
  const [range, setRange] = useState<AnalyticsRange>("30d");
  const [dept, setDept] = useState<string>("All departments");
  const [tab, setTab] = useState("team");

  const countryFilter: CountryCode | "ALL" = regionCode === "ALL" ? "ALL" : (regionCode as CountryCode);
  const metrics = useMemo(() => workforceMetrics(range, countryFilter, dept), [range, countryFilter, dept]);
  const pipeline = PIPELINE_BY_COUNTRY[countryFilter] ?? PIPELINE_BY_COUNTRY.ALL;
  const att = attendanceSeries(range);
  const leave = leaveSeries(range);
  const ot = overtimeSeries(range);
  const reportScopes = getReportScopes(demoProfile);
  const teamOnly = canViewReport(demoProfile, "team") && !canViewReport(demoProfile, "company") && !canViewReport(demoProfile, "hr");
  const canCompany = canViewReport(demoProfile, "company") || canViewReport(demoProfile, "hr");
  const canTeam = canViewReport(demoProfile, "team");
  const canRecruiting = canViewReport(demoProfile, "recruiting") || canViewReport(demoProfile, "hiring") || canCompany;
  const canCompReport = canViewReport(demoProfile, "compensation");
  const canSystem = canViewReport(demoProfile, "system");
  const compAccess = getCompensationAccess(demoProfile);
  const canCompTab = canCompReport && compAccess.othersAmounts !== "hidden";

  const leavePending = state.leaveRequests.filter((item) => item.status === "pending" && item.employeeId !== employee.id);
  const timesheetPending = state.orgTimesheets.filter((item) => item.status === "submitted");
  const expensePending = state.expenses.filter((item) => item.status === "submitted" && item.employeeId !== employee.id);
  const pendingApprovals = leavePending.length + timesheetPending.length + expensePending.length;

  if (!hasModuleAccess(demoProfile, "analytics") && !canSystem) {
    return (
      <Page title="Analytics" subtitle="Workforce intelligence">
        <EmptyState title="Not authorized" description="Switch to a persona with Analytics access." />
      </Page>
    );
  }

  // Managers (team-only) stay on My team — company-wide tabs are for HR / exec / company scopes.
  const analyticsTabs = [
    ...(canTeam ? [{ id: "team", label: "My team" }] : []),
    ...(!teamOnly && (canCompany || canViewReport(demoProfile, "hr")) ? [{ id: "workforce", label: "Workforce" }] : []),
    ...(canRecruiting ? [{ id: "recruiting", label: "Recruiting" }] : []),
    ...(!teamOnly && (canCompany || canViewReport(demoProfile, "hr")) ? [{ id: "attendance", label: "Attendance & leave" }] : []),
    ...(!teamOnly && (canCompany || canViewReport(demoProfile, "hr")) ? [{ id: "talent", label: "Performance & learning" }] : []),
    ...(!teamOnly && (canCompany || canViewReport(demoProfile, "hr")) ? [{ id: "skills", label: "Skills & capacity" }] : []),
    ...(canCompTab ? [{ id: "comp", label: "Compensation" }] : []),
    ...(canSystem ? [{ id: "system", label: "System status" }] : []),
  ];

  const activeTab = analyticsTabs.some((item) => item.id === tab) ? tab : analyticsTabs[0]?.id ?? "team";

  return (
    <Page
      title="Analytics"
      subtitle={
        teamOnly
          ? `My team · ${employee.fullName.split(" ")[0]}'s reports · ${range.toUpperCase()}`
          : `Report scopes: ${reportScopes.join(", ")} · ${range.toUpperCase()} · ${countryFilter === "ALL" ? "All countries" : activeCountry.name}`
      }
    >
      <FilterBar>
        {!teamOnly && <RegionalFilter label={t("locale.region")} />}
        {!teamOnly && (
          <label className="field">
            <span className="sr-only">Department</span>
            <select value={dept} onChange={(e) => setDept(e.target.value)} aria-label="Department">
              {ANALYTICS_DEPARTMENTS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          <span className="sr-only">Date range</span>
          <select value={range} onChange={(e) => setRange(e.target.value as AnalyticsRange)} aria-label="Date range">
            {ANALYTICS_RANGES.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
      </FilterBar>

      {canTeam && (teamOnly || activeTab === "team") && (
        <MetricGrid>
          <MetricCard label="Team size" value={TZ_TEAM.managerTeamSize} hint="Direct reports in scope" />
          <MetricCard
            label="In today"
            value={`${TZ_TEAM.attendancePct}%`}
            hint={`${TZ_TEAM.presentToday} office · ${TZ_TEAM.wfhToday} WFH · ${TZ_TEAM.onLeaveToday} leave`}
          />
          <MetricCard label="Approvals due" value={pendingApprovals} hint="Leave · timesheet · expense" />
          <MetricCard label="Utilization" value={`${TZ_TEAM.utilizationPct}%`} hint={`${TZ_TEAM.openRoles} open roles · ${TZ_TEAM.attritionRiskCount} attrition watch`} />
        </MetricGrid>
      )}

      {!teamOnly && canCompany && activeTab !== "team" && (
        <MetricGrid>
          <MetricCard label="Headcount" value={metrics.headcount} hint="Filtered mock workforce" />
          <MetricCard label="Hiring" value={metrics.hiring} hint="Scaled to date range" />
          <MetricCard label="Exits" value={metrics.exits} hint="Scaled to date range" />
          <MetricCard label="Attrition" value={`${metrics.attritionPct}%`} hint="Annualized sample" />
        </MetricGrid>
      )}

      {analyticsTabs.length > 1 && <Tabs tabs={analyticsTabs} value={activeTab} onChange={setTab} />}

      {activeTab === "team" && canTeam && (
        <div className="stack">
          <div className="grid-2">
            <Card title="Who's in today">
              <DataTable
                headers={["Name", "Code", "Role", "Status"]}
                rows={TZ_TEAM.directReports.map((r) => [
                  r.name,
                  r.code,
                  r.role,
                  <StatusBadge key={r.code} status={r.status} tone={r.status === "Leave" ? "warn" : r.status === "WFH" ? "info" : "ok"} />,
                ])}
              />
              <p className="note" style={{ marginTop: 8 }}>
                <Link to="/team">Team overview</Link> · <Link to="/org-chart">Org chart</Link>
              </p>
            </Card>

            <Card title="Action queue · clear these first">
              <MetricGrid>
                <MetricCard label="Leave" value={leavePending.length || 2} />
                <MetricCard label="Timesheets" value={timesheetPending.length || 2} />
                <MetricCard label="Expenses" value={expensePending.length} />
                <MetricCard label="1:1s due" value={TZ_TEAM.oneOnOnesDue} hint="This week" />
              </MetricGrid>
              <ul className="todo" style={{ marginTop: 12 }}>
                <li>
                  <Link to="/approvals">Approvals inbox</Link> — leave, timesheet, expense
                </li>
                <li>
                  <Link to="/leave">Leave calendar</Link> — coverage before holidays
                </li>
                <li>
                  <Link to="/timesheet">Timesheets</Link> — {TZ_TEAM.timesheetCompliancePct}% team compliance
                </li>
              </ul>
            </Card>
          </div>

          <div className="grid-2">
            <Card title="Upcoming leave & coverage">
              <DataTable
                headers={["Employee", "Type", "Dates", "Coverage"]}
                rows={TZ_TEAM.upcomingLeave.map((row) => [row.name, row.type, `${row.from} → ${row.to}`, row.coverage])}
              />
              <p className="note" style={{ marginTop: 8 }}>
                Pending approvals:{" "}
                {leavePending.length > 0
                  ? leavePending
                      .slice(0, 3)
                      .map((req) => `${req.employeeId} (${req.code.toUpperCase()})`)
                      .join(" · ")
                  : "Kabir Sharma (PTO) · Diya Patel (WFH)"}
              </p>
            </Card>

            <Card title="Capacity & overtime risk">
              <MetricGrid>
                <MetricCard label="OT hours" value={TZ_TEAM.overtimeHours} hint={range.toUpperCase()} />
                <MetricCard label="Timesheet OK" value={`${TZ_TEAM.timesheetCompliancePct}%`} />
                <MetricCard label="Engagement" value={TZ_TEAM.engagementScore} hint="/ 10 pulse" />
                <MetricCard label="Open roles" value={TZ_TEAM.openRoles} />
              </MetricGrid>
              <BarRows items={TZ_TEAM.capacityByWeek.map((r) => ({ label: r.label, value: r.pct }))} max={100} format={(n) => `${n}%`} />
              <DataTable
                headers={["Name", "OT hrs", "Note"]}
                rows={TZ_TEAM.overtimeRisk.map((r) => [r.name, String(r.hours), r.note])}
              />
            </Card>
          </div>

          <div className="grid-2">
            <Card title="Goals & delivery">
              {TZ_TEAM.goals.map((g) => (
                <ProgressBar key={g.name} value={g.progress} label={g.name} />
              ))}
              <p className="note" style={{ marginTop: 8 }}>
                <Link to="/evaluations">Performance / evaluations</Link>
              </p>
            </Card>

            <Card title="Reviews & 1:1 cadence">
              <DataTable
                headers={["Person", "Item", "Due", "Status"]}
                rows={TZ_TEAM.reviewDeadlines.map((r) => [
                  r.name,
                  r.item,
                  r.due,
                  <StatusBadge
                    key={`${r.name}-${r.item}`}
                    status={r.status}
                    tone={r.status === "Due soon" ? "warn" : r.status === "On track" ? "ok" : "info"}
                  />,
                ])}
              />
              <h3 className="card-title" style={{ fontSize: 14, margin: "14px 0 8px" }}>
                1:1 schedule
              </h3>
              <DataTable
                headers={["Person", "Last", "Next", "Status"]}
                rows={TZ_TEAM.oneOnOnes.map((r) => [
                  r.name,
                  r.last,
                  r.next,
                  <StatusBadge key={r.name} status={r.status} tone={r.status === "Needs slot" ? "warn" : "ok"} />,
                ])}
              />
            </Card>
          </div>

          <div className="grid-2">
            <Card title="Skills & hiring for your team">
              <DataTable
                headers={["Skill", "Covered", "Gap"]}
                rows={TZ_TEAM.skills.map((s) => [s.name, String(s.cover), s.gap])}
              />
              <h3 className="card-title" style={{ fontSize: 14, margin: "14px 0 8px" }}>
                Joiners & open roles
              </h3>
              <ul className="todo">
                {TZ_TEAM.newJoiners.map((j) => (
                  <li key={j.name}>
                    New · {j.name} · {j.role} · {j.start}
                  </li>
                ))}
                <li>Open · Senior Frontend Engineer · 1 seat</li>
                <li>Open · QA Analyst · 1 seat</li>
              </ul>
              <p className="note">
                <Link to="/skills">Skills</Link> · <Link to="/jobs">Jobs</Link> · <Link to="/recruiting">Recruiting</Link>
              </p>
            </Card>

            <Card title="Risks & alerts">
              <ul className="todo">
                {TZ_TEAM.attritionSignals.map((a) => (
                  <li key={a.name}>
                    <StatusBadge status={a.risk} tone="warn" /> {a.name} — {a.signal}
                  </li>
                ))}
                <li>
                  <StatusBadge status="warn" tone="warn" /> {TZ_TEAM.onLeaveToday} on leave today — confirm coverage
                </li>
                <li>
                  <StatusBadge status="info" tone="info" /> {timesheetPending.length || 2} timesheet(s) waiting on you
                </li>
                <li>
                  <StatusBadge status="warn" tone="warn" /> QA automation stretch — hire or upskill
                </li>
                <li>
                  <StatusBadge status="info" tone="info" /> Dussehra (20 Oct) — protect sprint capacity
                </li>
                <li>
                  <StatusBadge status="ok" tone="ok" /> No critical policy acknowledgements overdue
                </li>
              </ul>
            </Card>
          </div>
        </div>
      )}

      {activeTab === "workforce" && !teamOnly && (
        <div className="grid-2">
          <Card title="Country distribution">
            <BarRows items={metrics.countries.map((c) => ({ label: c.name, value: c.headcount }))} />
          </Card>
          <Card title="Department distribution">
            <BarRows items={metrics.departments.map((d) => ({ label: d.name, value: d.headcount }))} />
          </Card>
        </div>
      )}

      {activeTab === "recruiting" && (
        <div className="grid-2">
          <Card title="Recruitment pipeline">
            <BarRows items={pipeline.map((s) => ({ label: s.stage, value: s.count }))} />
          </Card>
          <Card title="Time-to-hire">
            <MetricGrid>
              <MetricCard label="Avg days" value={34} hint="Shared recruiting mock" />
              <MetricCard label="Offers out" value={8} />
              <MetricCard label="Open reqs" value={24} />
            </MetricGrid>
            <p className="note">Pipeline counts respond to the active demo region filter.</p>
          </Card>
        </div>
      )}

      {activeTab === "attendance" && (
        <div className="grid-2">
          <Card title="Attendance trend">
            <BarRows items={att.map((r) => ({ label: r.label, value: r.pct }))} max={100} format={(n) => `${n}%`} />
          </Card>
          <Card title="Leave days">
            <BarRows items={leave.map((r) => ({ label: r.label, value: r.days }))} />
          </Card>
          <Card title="Overtime by department (sample hours)">
            <BarRows items={ot.map((r) => ({ label: r.label, value: r.hours }))} />
          </Card>
        </div>
      )}

      {activeTab === "talent" && (
        <div className="grid-2">
          <Card title={`Performance · ${PERFORMANCE_CYCLE.name}`}>
            <p>
              Cycle completion: <strong>{PERFORMANCE_CYCLE.completionPct}%</strong> · due {PERFORMANCE_CYCLE.due}
            </p>
            <BarRows items={PERFORMANCE_CYCLE.byStage.map((s) => ({ label: s.stage, value: s.pct }))} max={100} format={(n) => `${n}%`} />
          </Card>
          <Card title="Learning & certifications">
            <MetricGrid>
              <MetricCard label="Completion" value={`${LEARNING_METRICS.completionPct}%`} />
              <MetricCard label="Certifications YTD" value={LEARNING_METRICS.certificationsYtd} />
              <MetricCard label="Mandatory pending" value={LEARNING_METRICS.mandatoryPending} />
            </MetricGrid>
            <BarRows
              items={LEARNING_METRICS.topCourses.map((c) => ({ label: c.name, value: c.completionPct }))}
              max={100}
              format={(n) => `${n}%`}
            />
          </Card>
        </div>
      )}

      {activeTab === "skills" && (
        <div className="grid-2">
          <Card title="Workforce capacity">
            <MetricGrid>
              <MetricCard label="Utilized" value={`${SKILLS_CAPACITY.utilizedPct}%`} />
              <MetricCard label="Bench" value={`${SKILLS_CAPACITY.benchPct}%`} />
              <MetricCard label="Hiring pressure" value={SKILLS_CAPACITY.hiringPressure} />
            </MetricGrid>
            <BarRows items={SKILLS_CAPACITY.benchByCountry.map((b) => ({ label: b.country, value: b.bench }))} />
          </Card>
          <Card title="Critical skill gaps">
            <DataTable
              headers={["Skill", "Gap", "Countries"]}
              rows={SKILLS_CAPACITY.skills.map((s) => [s.skill, s.gap, s.countries])}
            />
          </Card>
        </div>
      )}

      {activeTab === "comp" && canCompTab && (
        <Card title="Compensation review status">
          <Banner message={{ tone: "warn", text: COMP_REVIEW_STATUS.note }} />
          <p className="note">Authorized via Compensation nav — not granted by executive title alone.</p>
          <MetricGrid>
            <MetricCard label="Submitted" value={`${COMP_REVIEW_STATUS.submittedPct}%`} />
            <MetricCard label="Pending managers" value={COMP_REVIEW_STATUS.pendingManagers} />
            <MetricCard label="Budget used" value={`${COMP_REVIEW_STATUS.budgetUsedPct}%`} />
            <MetricCard label="Sample award" value={formatMoney(12500)} hint={activeCountry.currency} />
          </MetricGrid>
          <p className="note">{COMP_REVIEW_STATUS.cycle}</p>
        </Card>
      )}
    </Page>
  );
}

/* ───────────────── AI Copilot ───────────────── */

type ChatTurn = { id: string; role: "user" | "assistant"; text: string; answer?: CopilotAnswer };

export function AiCopilotPage() {
  const { employee, demoProfile } = usePortal();
  const persona = copilotPersonaFromRole(demoProfile.role);
  const suggestions = COPILOT_SUGGESTIONS[persona];
  const [prompt, setPrompt] = useState("");
  const [history, setHistory] = useState<ChatTurn[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  function ask(question: string) {
    const q = question.trim();
    if (!q) return;
    const answer = answerCopilot(q);
    const stamp = Date.now();
    const userTurn: ChatTurn = { id: `u-${stamp}`, role: "user", text: q };
    const botTurn: ChatTurn = {
      id: `a-${stamp}`,
      role: "assistant",
      text: answer.summary?.trim() || "Here is what I found in the demo data.",
      answer,
    };
    setHistory((prev) => [...prev, userTurn, botTurn]);
    setActiveId(botTurn.id);
    setPrompt("");
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    ask(prompt);
  }

  const conversations = useMemo(() => {
    const starts: { id: string; title: string }[] = [];
    for (let i = 0; i < history.length; i += 2) {
      const turn = history[i];
      if (turn?.role === "user") starts.push({ id: turn.id, title: turn.text.slice(0, 48) });
    }
    return starts.reverse();
  }, [history]);

  return (
    <Page title="AI Copilot" subtitle={`${PRODUCT_NAME} contextual assistant · ${demoProfile.personaLabel}`}>
      <DemoBanner text="Simulated Copilot — answers are rule-based mock responses. Not connected to an AI model or gateway." />
      <div className="copilot-layout">
        <aside className="copilot-history card">
          <h2 className="card-title">Conversation history</h2>
          {conversations.length === 0 ? (
            <p className="note">Ask a question to start a demo thread.</p>
          ) : (
            <ul className="stack-tight">
              {conversations.map((c) => (
                <li key={c.id}>
                  <button type="button" className="btn-ghost copilot-hist-btn" onClick={() => setActiveId(c.id)}>
                    {c.title}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button type="button" className="btn-ghost" onClick={() => { setHistory([]); setActiveId(null); }}>
            Clear history
          </button>
        </aside>

        <div className="copilot-main stack">
          <Card title={`Suggested for ${demoProfile.personaLabel}`}>
            <div className="chip-row">
              {suggestions.map((s) => (
                <button key={s} type="button" className="chip-btn" onClick={() => ask(s)}>
                  {s}
                </button>
              ))}
            </div>
          </Card>

          <Card title="Chat">
            <div className="copilot-thread" aria-live="polite">
              {history.length === 0 && (
                <p className="note">
                  Hi {employee.fullName.split(" ")[0]} — ask about leave, policy, approvals, team skills, or workforce trends.
                </p>
              )}
              {history.map((turn) => (
                <div key={turn.id} className={`copilot-bubble ${turn.role}`}>
                  <p className="copilot-role">{turn.role === "user" ? "You" : `${PRODUCT_NAME} Copilot (simulated)`}</p>
                  <p>{turn.text || turn.answer?.summary || "—"}</p>
                  {turn.answer && <CopilotAnswerCard answer={turn.answer} highlight={turn.id === activeId || turn.id === `a-${activeId?.replace(/^u-/, "")}`} />}
                </div>
              ))}
            </div>
            <form onSubmit={onSubmit} className="copilot-compose">
              <Field label="Message" wide>
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  rows={2}
                  placeholder="e.g. How do I apply for leave? Summarize attrition…"
                />
              </Field>
              <button className="btn" type="submit">
                Send (demo)
              </button>
            </form>
          </Card>
        </div>
      </div>
    </Page>
  );
}

function CopilotAnswerCard({ answer, highlight }: { answer: CopilotAnswer; highlight?: boolean }) {
  return (
    <div className={`copilot-answer ${highlight ? "highlight" : ""}`}>
      {answer.metrics && (
        <div className="metric-grid compact">
          {answer.metrics.map((m) => (
            <article key={m.label} className="metric-card">
              <p className="metric-label">{m.label}</p>
              <p className="metric-value">{m.value}</p>
            </article>
          ))}
        </div>
      )}
      {answer.table && (
        <DataTable
          headers={answer.table.headers}
          rows={answer.table.rows.map((r) => r.map((c) => c))}
        />
      )}
      {answer.links && (
        <p className="chip-row">
          {answer.links.map((l) => (
            <Link key={l.to} className="auth-shortcut" to={l.to}>
              {l.label}
            </Link>
          ))}
        </p>
      )}
    </div>
  );
}

/* ───────────────── AI Agents ───────────────── */

export function AiAgentsPage() {
  const { demoProfile } = usePortal();
  if (!hasModuleAccess(demoProfile, "agents") && !hasModuleAccess(demoProfile, "*") && !hasModuleAccess(demoProfile, "copilot")) {
    return (
      <Page title="AI Agents" subtitle="Autonomous assistants (demo catalog)">
        <EmptyState title="Not authorized" description="Switch to a persona with AI Agents access." />
      </Page>
    );
  }

  return (
    <Page title="AI Agents" subtitle="Overview of planned Infotech agents — demo catalog only">
      <DemoBanner text="These agents are not connected to actual AI services. Status reflects frontend prototype readiness only." />
      <div className="agent-grid">
        {AI_AGENTS.map((agent) => (
          <Card key={agent.id} title={agent.name} className="agent-card">
            <p className="note">{agent.audience}</p>
            <p>{agent.purpose}</p>
            <dl className="info-grid">
              <div className="info-fact">
                <dt>Availability</dt>
                <dd>{agent.availability}</dd>
              </div>
              <div className="info-fact">
                <dt>Demo status</dt>
                <dd>
                  <StatusBadge
                    status={agent.demoStatus}
                    tone={agent.demoStatus === "Demo ready" ? "ok" : agent.demoStatus === "Demo beta" ? "warn" : "info"}
                  />
                </dd>
              </div>
            </dl>
          </Card>
        ))}
      </div>
      <p className="note">
        Try suggested prompts in <Link to="/ai/copilot">AI Copilot</Link> — same mock data, no live models.
      </p>
    </Page>
  );
}

/* ───────────────── Integration Center ───────────────── */

export function IntegrationsPage() {
  usePlatformTick();
  const { demoProfile, employee } = usePortal();
  const integrations = listIntegrations();
  const [selected, setSelected] = useState(integrations[0]?.id ?? "sso");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [pendingRetry, setPendingRetry] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const active = integrations.find((i) => i.id === selected) ?? integrations[0];

  if (!hasModuleAccess(demoProfile, "integrations") && !hasModuleAccess(demoProfile, "*")) {
    return (
      <Page title="Integration Center" subtitle="Connectors and sync status">
        <EmptyState title="Not authorized" description="Switch to the Admin demo persona to manage integrations." />
      </Page>
    );
  }

  function requestRetry(id: string) {
    setPendingRetry(id);
    setReviewOpen(true);
  }

  function confirmRetry() {
    if (!pendingRetry) return;
    const result = retryIntegration(pendingRetry);
    setReviewOpen(false);
    setPendingRetry(null);
    setToast(result ? `Retry simulated for ${result.name}. Last sync updated locally.` : "Integration not found.");
  }

  return (
    <Page title="Integration Center" subtitle="SSO, collaboration, workforce and payroll connectors (demo)">
      <DemoBanner />
      {toast && <Banner message={{ tone: "ok", text: toast }} />}
      <div className="grid-2">
        {integrations.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`card integration-card ${item.id === selected ? "selected" : ""}`}
            onClick={() => setSelected(item.id)}
          >
            <div className="row-between">
              <h2 className="card-title">{item.name}</h2>
              <StatusBadge
                status={item.status}
                tone={
                  item.status === "Connected"
                    ? "ok"
                    : item.status === "Degraded"
                      ? "warn"
                      : item.status === "Disconnected"
                        ? "danger"
                        : "neutral"
                }
              />
            </div>
            <p className="note">{item.category}</p>
            <p>{item.description}</p>
            <dl className="info-grid">
              <div className="info-fact">
                <dt>Last sync</dt>
                <dd>{item.lastSync}</dd>
              </div>
              <div className="info-fact">
                <dt>Records</dt>
                <dd>{item.recordsProcessed.toLocaleString()}</dd>
              </div>
              <div className="info-fact">
                <dt>Errors</dt>
                <dd>{item.errorCount}</dd>
              </div>
            </dl>
          </button>
        ))}
      </div>

      {active && (
        <Card
          title={`${active.name} · logs`}
          action={
            <button className="btn" type="button" onClick={() => requestRetry(active.id)} disabled={active.status === "Not configured"}>
              Retry sync (demo)
            </button>
          }
        >
          <DataTable
            headers={["When", "Level", "Message"]}
            rows={active.logs.map((l) => [
              l.at,
              <StatusBadge key={l.at + l.message} status={l.level} tone={l.level === "error" ? "danger" : l.level === "warn" ? "warn" : "info"} />,
              l.message,
            ])}
          />
        </Card>
      )}

      <Dialog
        open={reviewOpen}
        title="Authorized review required (simulated)"
        onClose={() => { setReviewOpen(false); setPendingRetry(null); }}
        actions={
          <>
            <button className="btn-ghost" type="button" onClick={() => { setReviewOpen(false); setPendingRetry(null); }}>
              Cancel
            </button>
            <button className="btn" type="button" onClick={confirmRetry}>
              Confirm retry as {employee.fullName.split(" ")[0]}
            </button>
          </>
        }
      >
        <p>
          Retrying a connector updates mock last-sync and logs in localStorage only. No external system is contacted.
        </p>
        <p className="note">Sensitive platform actions require this simulated authorized review step.</p>
      </Dialog>
    </Page>
  );
}

/* ───────────────── Payroll ───────────────── */

export function PayrollPage() {
  const { demoProfile } = usePortal();
  const { activeCountry, regionCode } = useLocale();
  usePlatformTick();
  const payrollConn = listIntegrations().find((i) => i.id === "payroll");

  if (!hasModuleAccess(demoProfile, "payroll") && !hasModuleAccess(demoProfile, "*")) {
    return (
      <Page title="Payroll" subtitle="External payroll integration placeholder">
        <EmptyState title="Not authorized" description="Switch to Compensation or Admin to view Payroll." />
      </Page>
    );
  }

  return (
    <Page title="Payroll" subtitle="Integration status only — processing is out of scope">
      <Banner
        message={{
          tone: "err",
          text: "Payroll processing, tax calculation, payslip generation, and payment processing are not implemented in Infotech. This screen shows external-provider integration placeholders only.",
        }}
      />
      <MetricGrid>
        <MetricCard label="Provider" value="External adapter" hint={PAYROLL_STATUS.provider} />
        <MetricCard
          label="Country"
          value={regionCode === "ALL" ? "Multi" : activeCountry.name}
          hint={activeCountry.code}
        />
        <MetricCard label="Legal entity" value={activeCountry.legalEntity} />
        <MetricCard label="Period" value={PAYROLL_STATUS.period} />
      </MetricGrid>
      <div className="grid-2">
        <Card title="Integration status">
          <dl className="info-grid">
            <div className="info-fact">
              <dt>Status</dt>
              <dd>
                <StatusBadge status={payrollConn?.status ?? PAYROLL_STATUS.integrationStatus} tone="ok" />
              </dd>
            </div>
            <div className="info-fact">
              <dt>Last sync</dt>
              <dd>{payrollConn?.lastSync ?? PAYROLL_STATUS.lastSync}</dd>
            </div>
            <div className="info-fact">
              <dt>Records (demo)</dt>
              <dd>{payrollConn?.recordsProcessed ?? 500}</dd>
            </div>
          </dl>
          <p className="note">
            Manage connector retries in <Link to="/integrations">Integration Center</Link>. Employee-facing{" "}
            <Link to="/payslips">payslips</Link> use seed data, not a payroll engine.
          </p>
        </Card>
        <Card title="Not in this product scope">
          <ul className="stack">
            {PAYROLL_STATUS.notImplemented.map((item) => (
              <li key={item}>
                <StatusBadge status="Not implemented" tone="neutral" /> {item}
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </Page>
  );
}

/* ───────────────── Administration ───────────────── */

export function AdminPage() {
  usePlatformTick();
  const { demoProfile, employee } = usePortal();
  const [tab, setTab] = useState("users");
  const [editId, setEditId] = useState<string | null>(null);
  const [draftPerms, setDraftPerms] = useState<string[]>([]);
  const [reviewOpen, setReviewOpen] = useState(false);
  const prefs = listNotificationPrefs();
  const audit = listAuditLog();

  if (!hasModuleAccess(demoProfile, "administration") && !hasModuleAccess(demoProfile, "*")) {
    return (
      <Page title="Administration" subtitle="Platform configuration">
        <EmptyState title="Not authorized" description="Switch to the Admin or HR demo persona." />
      </Page>
    );
  }

  const editing = DEMO_ACCOUNTS.find((a) => a.id === editId);

  function openEditor(accountId: string) {
    const acc = DEMO_ACCOUNTS.find((a) => a.id === accountId);
    if (!acc) return;
    setEditId(accountId);
    setDraftPerms(effectiveNavIds(accountId, acc.navAccess.filter((x) => x !== "*") as string[]));
  }

  function togglePerm(id: string) {
    setDraftPerms((prev) => (prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]));
  }

  function requestSave() {
    setReviewOpen(true);
  }

  function confirmSave() {
    if (!editId) return;
    saveRoleEdit(editId, draftPerms, employee.email);
    setReviewOpen(false);
    setEditId(null);
  }

  return (
    <Page title="Administration" subtitle="Demo users, roles, countries, org settings, audit & notifications">
      <DemoBanner text="Administration edits are stored in browser localStorage for this prototype. They do not change signed-in identity mid-session unless you re-apply role overlays in a later build." />
      <Tabs
        tabs={[
          { id: "users", label: "Demo users" },
          { id: "roles", label: "Roles & permissions" },
          { id: "country", label: "Country & legal entity" },
          { id: "org", label: "Organization & locations" },
          { id: "audit", label: "Audit log" },
          { id: "notifications", label: "Notification preferences" },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === "users" && (
        <Card title="Demo org chart">
          <p className="note" style={{ marginTop: 0 }}>
            Same chart every role sees under <Link to="/org-chart">Me → Org chart</Link>. Reporting ≠ permissions —
            Sophie/Helen/Alex/Jordan access still comes from their roles.
          </p>
          <OrgChart />
          <p className="note">Passwords are listed on the login demo panel. Use the profile menu role switcher to change persona.</p>
        </Card>
      )}

      {tab === "roles" && (
        <Card
          title="Role & permission editor"
          action={
            editing ? (
              <button className="btn" type="button" onClick={requestSave}>
                Save with review…
              </button>
            ) : undefined
          }
        >
          <FilterBar>
            <select
              aria-label="Select demo user"
              value={editId ?? ""}
              onChange={(e) => (e.target.value ? openEditor(e.target.value) : setEditId(null))}
            >
              <option value="">Select demo user…</option>
              {DEMO_ACCOUNTS.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.personaLabel} — {a.fullName}
                </option>
              ))}
            </select>
          </FilterBar>
          {!editing && <EmptyState title="Select a user" description="Edit a subset of module permissions for demo overlays." />}
          {editing && (
            <>
              <p>
                Editing <strong>{editing.personaLabel}</strong> ({editing.email}) · baseline role {roleLabel(editing.role)}
              </p>
              <p className="note">Changes are demo overlays only. They do not elevate the currently signed-in session automatically.</p>
              <ul className="perm-grid">
                {ROLE_PERMISSION_CATALOG.map((p) => (
                  <li key={p.id}>
                    <label className="perm-item">
                      <input type="checkbox" checked={draftPerms.includes(p.id)} onChange={() => togglePerm(p.id)} />
                      <span>
                        <strong>{p.label}</strong>
                        <span className="note">{p.description}</span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>
      )}

      {tab === "country" && (
        <Card title="Country & legal entity configuration">
          <p>
            Full mock holiday, leave, working-time, benefits, and document settings live under{" "}
            <Link to="/admin/countries">Country configuration</Link>. Locale / demo region:{" "}
            <Link to="/settings/locale">Locale settings</Link>.
          </p>
          <DataTable
            headers={["Code", "Country", "Currency", "Time zone"]}
            rows={[
              ["IN", "India", "INR", "Asia/Kolkata"],
              ["US", "United States", "USD", "America/New_York"],
              ["GB", "United Kingdom", "GBP", "Europe/London"],
              ["AU", "Australia", "AUD", "Australia/Sydney"],
              ["CA", "Canada", "CAD", "America/Toronto"],
              ["AE", "United Arab Emirates", "AED", "Asia/Dubai"],
              ["SA", "Saudi Arabia", "SAR", "Asia/Riyadh"],
              ["DE", "Germany", "EUR", "Europe/Berlin"],
            ]}
          />
        </Card>
      )}

      {tab === "org" && (
        <div className="grid-2">
          <Card title="Organization settings">
            <dl className="info-grid">
              <div className="info-fact">
                <dt>Company</dt>
                <dd>{ADMIN_ORG_SETTINGS.company}</dd>
              </div>
              <div className="info-fact">
                <dt>Fiscal year start</dt>
                <dd>{ADMIN_ORG_SETTINGS.fiscalYearStart}</dd>
              </div>
              <div className="info-fact">
                <dt>Default week start</dt>
                <dd>{ADMIN_ORG_SETTINGS.weekStartDefault}</dd>
              </div>
              <div className="info-fact">
                <dt>Legal entities</dt>
                <dd>{ADMIN_ORG_SETTINGS.legalEntities}</dd>
              </div>
            </dl>
            <p className="note">
              Hierarchy explorer: <Link to="/organization">Organization</Link>
            </p>
          </Card>
          <Card title="Locations">
            <DataTable
              headers={["Location", "Country", "Type"]}
              rows={ADMIN_LOCATIONS.map((l) => [l.name, l.country, l.type])}
            />
          </Card>
        </div>
      )}

      {tab === "audit" && (
        <Card title="Audit log">
          <DataTable
            headers={["When", "Actor", "Action", "Target", "Outcome"]}
            rows={audit.map((r) => [
              r.at,
              r.actor,
              r.action,
              r.target,
              <StatusBadge key={r.id} status={r.outcome} tone={r.outcome === "Simulated" ? "warn" : "ok"} />,
            ])}
          />
        </Card>
      )}

      {tab === "notifications" && (
        <Card title="Notification preferences (demo)">
          <DataTable
            headers={["Channel", "Description", "Email", "In-app", "Digests"]}
            rows={prefs.map((p) => [
              p.channel,
              p.description,
              <PrefToggle key={`${p.id}-e`} checked={p.email} onChange={(v) => updateNotificationPref(p.id, { email: v })} />,
              <PrefToggle key={`${p.id}-i`} checked={p.inApp} onChange={(v) => updateNotificationPref(p.id, { inApp: v })} />,
              <PrefToggle key={`${p.id}-d`} checked={p.digests} onChange={(v) => updateNotificationPref(p.id, { digests: v })} />,
            ])}
          />
          <p className="note">Toggles persist in localStorage and append a simulated audit row.</p>
        </Card>
      )}

      <Dialog
        open={reviewOpen}
        title="Authorized review required (simulated)"
        onClose={() => setReviewOpen(false)}
        actions={
          <>
            <button className="btn-ghost" type="button" onClick={() => setReviewOpen(false)}>
              Cancel
            </button>
            <button className="btn" type="button" onClick={confirmSave}>
              Confirm permission change
            </button>
          </>
        }
      >
        <p>
          You are about to save a demo permission overlay for <strong>{editing?.fullName}</strong>. This does not call a backend and
          does not elevate the currently signed-in session automatically.
        </p>
        <p className="note">Sensitive administration actions require this simulated authorized review.</p>
      </Dialog>
    </Page>
  );
}

function PrefToggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <input
      type="checkbox"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      aria-label="Toggle preference"
    />
  );
}
