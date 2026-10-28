import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
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
import { listPeople, subscribePeople } from "../data/peopleLocal.ts";
import { TASK_TEAM } from "../data/taskTeam.ts";
import { getTalentState, subscribeTalent } from "../data/talentLocal.ts";
import { getAttendanceState, subscribeAttendance } from "../data/attendanceLocal.ts";
import { getRewardState, subscribeReward } from "../data/rewardLocal.ts";
import {
  attendanceAnalytics,
  compReviewStatus,
  criticalSkillGaps,
  currentCycle,
  learningCompletion,
  learningDetail,
  leaveTrend,
  pipelineFunnel,
  reviewStatusFor,
  skillCoverage,
} from "../data/homeInsights.ts";
import {
  dayStatus,
  personName,
  rangeLabel,
  teamBelow,
  upcomingHolidays,
  waitingItems,
  workforceStats,
  type DayStatus,
} from "../data/workforceStats.ts";
import { countWaitingOnMe } from "./ApprovalsCenter.tsx";
import { useAskCopilot } from "../features/copilot/askCopilot.ts";
import { agentEnabled } from "../data/aiSettings.ts";
import { CopilotSources } from "../features/copilot/CopilotSources.tsx";
import { CopilotExtras } from "../features/copilot/CopilotExtras.tsx";
import { getCompensationAccess, hasModuleAccess } from "../data/peoplePermissions.ts";
import { canManageLetters, canViewReport } from "../data/rbac.ts";
import {
  ADMIN_LOCATIONS,
  ADMIN_ORG_SETTINGS,
  AI_AGENTS,
  ANALYTICS_RANGES,
  COPILOT_SUGGESTIONS,
  PAYROLL_PROVIDERS,
  PAYROLL_STATUS,
  ROLE_PERMISSION_CATALOG,
  SYNC_SCHEDULES,
  copilotPersonaFromRole,
  type AnalyticsRange,
  type CopilotAnswer,
  type SyncSchedule,
} from "../data/platformData.ts";
import {
  COST_CENTRES,
  QUARANTINE_FIELD_LABEL,
  canEditRolePermissions,
  dismissQuarantined,
  effectiveCatalogIds,
  fixAndRetryQuarantined,
  getPlatformVersion,
  integrationRuns,
  integrationSchedule,
  integrationTotals,
  listAuditLog,
  listIntegrations,
  listNotificationPrefs,
  listQuarantine,
  nextRunAt,
  retryAllQuarantined,
  retryIntegration,
  retryQuarantined,
  runIntegrationSync,
  saveRoleEdit,
  setIntegrationSchedule,
  subscribePlatform,
  updateNotificationPref,
  type QuarantineField,
  type QuarantineRecord,
} from "../data/platformLocal.ts";
import { RegionalFilter } from "../locale/RegionalFilter.tsx";
import { useLocale } from "../locale/LocaleContext.tsx";
import { formatShortDate, todayISO, type CountryCode } from "../model.ts";
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

/* ───────────────── Analytics ───────────────── */

const DAY_TONE: Record<DayStatus, "ok" | "info" | "warn" | "neutral"> = {
  Working: "ok",
  WFH: "info",
  "On leave": "warn",
  Holiday: "neutral",
  "Weekly off": "neutral",
};

/** People below the signed-in user in the reporting line, from the live directory. */
function useMyTeam() {
  const { employee, canDecideFor } = usePortal();
  const people = useSyncExternalStore(subscribePeople, listPeople, listPeople);
  const team = useMemo(
    () => teamBelow(employee.id, people, canDecideFor, TASK_TEAM.map((p) => p.id)),
    [employee.id, people, canDecideFor],
  );
  return { team, people };
}

export function AnalyticsPage() {
  usePlatformTick();
  const { demoProfile, employee, state, canDecideFor, canVerifyProofs } = usePortal();
  const { regionCode, activeCountry, t } = useLocale();
  const { team, people } = useMyTeam();
  const talent = useSyncExternalStore(subscribeTalent, getTalentState, getTalentState);
  const [range, setRange] = useState<AnalyticsRange>("30d");
  const [dept, setDept] = useState<string>("All departments");
  const [tab, setTab] = useState("team");
  const today = todayISO();

  const countryFilter: CountryCode | "ALL" = regionCode === "ALL" ? "ALL" : (regionCode as CountryCode);
  const stats = useMemo(
    () => workforceStats(people, { country: countryFilter, department: dept, range, today }),
    [people, countryFilter, dept, range, today],
  );
  const attState = useSyncExternalStore(subscribeAttendance, getAttendanceState, getAttendanceState);
  const reward = useSyncExternalStore(subscribeReward, getRewardState, getRewardState);
  const scopeName = countryFilter === "ALL" ? undefined : activeCountry.name;
  // Everyone in the selected country and department (active only).
  const scopePeople = useMemo(
    () =>
      people.filter(
        (p) =>
          p.employmentStatus !== "Terminated" &&
          (countryFilter === "ALL" || p.countryCode === countryFilter) &&
          (dept === "All departments" || p.department === dept),
      ),
    [people, countryFilter, dept],
  );
  const scopeIds = useMemo(() => new Set(scopePeople.map((p) => p.id)), [scopePeople]);
  const pipeline = pipelineFunnel(talent.candidates, scopeName);
  const needsAttendance = tab === "attendance";
  const weeks = range === "7d" ? 1 : range === "30d" ? 5 : 13;
  const attendance = useMemo(
    () => (needsAttendance ? attendanceAnalytics(scopePeople, state, attState, today, weeks) : { trend: [], overtime: [] }),
    // state slices used: holidays, leaveRequests, absences
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [needsAttendance, scopePeople, state.holidays, state.leaveRequests, state.absences, attState, today, weeks],
  );
  const leave = useMemo(
    () =>
      leaveTrend(
        state.leaveRequests.filter((r) => scopeIds.has(r.employeeId)),
        state.holidays,
        (id) => String(people.find((p) => p.id === id)?.countryCode ?? "IN"),
        "ALL",
        today,
        range === "ytd" ? Number(today.slice(5, 7)) : 3,
      ),
    [state.leaveRequests, state.holidays, scopeIds, people, today, range],
  );
  const cycle = currentCycle(talent);
  const reviews = reviewStatusFor(talent.reviews, scopeIds, cycle.id);
  const learning = learningCompletion(talent.enrollments, scopeIds, today);
  const learningMore = learningDetail(talent.enrollments, talent.certifications, scopeIds, today);
  const skillMembers = useMemo(() => scopePeople.map((p) => ({ id: p.id, countryCode: String(p.countryCode) })), [scopePeople]);
  const skillGaps = useMemo(() => criticalSkillGaps(talent, skillMembers), [talent, skillMembers]);
  const skillTop = useMemo(() => skillCoverage(talent, skillMembers).top, [talent, skillMembers]);
  const comp = compReviewStatus(reward.reviews, countryFilter === "ALL" && dept === "All departments" ? undefined : scopeIds);
  const canCompany = canViewReport(demoProfile, "company") || canViewReport(demoProfile, "hr");
  const canTeam = team.length > 0;
  const canRecruiting = canViewReport(demoProfile, "recruiting") || canViewReport(demoProfile, "hiring") || canCompany;
  const canCompReport = canViewReport(demoProfile, "compensation");
  const canSystem = canViewReport(demoProfile, "system");
  const compAccess = getCompensationAccess(demoProfile);
  const canCompTab = canCompReport && compAccess.othersAmounts !== "hidden";

  const waiting = waitingItems(state, employee.id, canDecideFor, canVerifyProofs);
  const pendingApprovals = countWaitingOnMe(state, employee.id, canDecideFor, canVerifyProofs);
  const teamIds = new Set(team.map((m) => m.id));
  const teamNames = new Set([employee.fullName, ...team.map((m) => m.name)]);
  const openReqs = talent.requisitions.filter((r) => r.approvalStatus === "Approved" && r.stageSummary !== "Hired" && r.stageSummary !== "Filled");
  const teamOpenings = openReqs.filter((r) => teamNames.has(r.hiringManager)).reduce((n, r) => n + r.openings, 0);
  const statuses = team.map((m) => ({ member: m, status: dayStatus(state, m.id, m.countryCode, today) }));
  const workingToday = statuses.filter((s) => s.status === "Working" || s.status === "WFH").length;
  const onLeaveToday = statuses.filter((s) => s.status === "On leave").length;
  const upcomingTeamLeave = state.leaveRequests
    .filter((r) => teamIds.has(r.employeeId) && (r.status === "approved" || r.status === "pending") && r.to >= today)
    .sort((a, b) => a.from.localeCompare(b.from))
    .slice(0, 6);
  const myHolidays = upcomingHolidays(state.holidays, employee.countryCode, today, 4);
  const byKind = [...waiting.reduce((m, w) => m.set(w.kind, (m.get(w.kind) ?? 0) + 1), new Map<string, number>())];

  if (!hasModuleAccess(demoProfile, "analytics") && !canSystem) {
    return (
      <Page title="Analytics" subtitle="Workforce intelligence">
        <EmptyState title="Not authorized" description="You don't have access to Analytics." />
      </Page>
    );
  }

  const analyticsTabs = [
    ...(canTeam ? [{ id: "team", label: "My team" }] : []),
    ...(canCompany ? [{ id: "workforce", label: "Workforce" }] : []),
    ...(canRecruiting ? [{ id: "recruiting", label: "Recruiting" }] : []),
    ...(canCompany ? [{ id: "attendance", label: "Attendance & leave" }] : []),
    ...(canCompany ? [{ id: "talent", label: "Performance & learning" }] : []),
    ...(canCompany ? [{ id: "skills", label: "Skills & capacity" }] : []),
    ...(canCompTab ? [{ id: "comp", label: "Compensation" }] : []),
    ...(canSystem ? [{ id: "system", label: "System status" }] : []),
  ];

  if (!analyticsTabs.length) {
    return (
      <Page title="Analytics" subtitle="Workforce intelligence">
        <EmptyState title="Nothing to show" description="No reports available." />
      </Page>
    );
  }

  const activeTab = analyticsTabs.some((item) => item.id === tab) ? tab : analyticsTabs[0].id;
  const showFilters = canCompany && activeTab !== "team" && activeTab !== "system";
  const integrations = listIntegrations();
  const audit = listAuditLog();

  return (
    <Page
      title="Analytics"
      subtitle={
        activeTab === "team"
          ? `My team · ${team.length}`
          : `${rangeLabel(range)} · ${countryFilter === "ALL" ? t("country.all") : activeCountry.name}`
      }
    >
      {activeTab !== "system" && (
        <FilterBar>
          {showFilters && <RegionalFilter label={t("locale.region")} />}
          {showFilters && (
            <label className="field">
              <span className="sr-only">Department</span>
              <select value={dept} onChange={(e) => setDept(e.target.value)} aria-label="Department">
                {["All departments", ...stats.departments].map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </label>
          )}
          {activeTab !== "team" && (
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
          )}
        </FilterBar>
      )}

      {activeTab === "team" && (
        <MetricGrid>
          <MetricCard label="Team size" value={team.length} hint={`${team.filter((m) => m.direct).length} direct reports`} />
          <MetricCard label="Working today" value={workingToday} hint={`${onLeaveToday} on leave`} />
          <MetricCard label="Approvals due" value={pendingApprovals} hint="Waiting on you" />
          <MetricCard label="Open positions" value={teamOpenings} hint="Approved openings in your team" />
        </MetricGrid>
      )}

      {canCompany && activeTab !== "team" && activeTab !== "system" && (
        <MetricGrid>
          <MetricCard label="Headcount" value={stats.headcount} hint="Active people" />
          <MetricCard label="Joiners" value={stats.joiners} hint={rangeLabel(range)} />
          <MetricCard label="Exits" value={stats.exits} hint={rangeLabel(range)} />
          <MetricCard label="Attrition" value={`${stats.attritionPct}%`} hint={rangeLabel(range)} />
        </MetricGrid>
      )}

      {analyticsTabs.length > 1 && <Tabs tabs={analyticsTabs} value={activeTab} onChange={setTab} />}

      {activeTab === "team" && (
        <div className="stack">
          <div className="grid-2">
            <Card title="Who's in today">
              <DataTable
                headers={["Name", "Role", "Status"]}
                rows={statuses.slice(0, 15).map(({ member, status }) => [
                  member.name,
                  member.designation,
                  <StatusBadge key={member.id} status={status} tone={DAY_TONE[status]} literal />,
                ])}
              />
              {team.length > 15 && <p className="note">Showing 15 of {team.length}. Direct reports first.</p>}
              <p className="note" style={{ marginTop: 8 }}>
                <Link to="/team">Team overview</Link> · <Link to="/org-chart">Org chart</Link>
              </p>
            </Card>

            <Card title="Waiting on you">
              {byKind.length ? (
                <MetricGrid>
                  {byKind.map(([kind, n]) => (
                    <MetricCard key={kind} label={kind} value={n} />
                  ))}
                </MetricGrid>
              ) : (
                <p className="note">Nothing waiting on you.</p>
              )}
              <p className="note" style={{ marginTop: 8 }}>
                <Link to="/approvals">Open approvals</Link>
              </p>
            </Card>
          </div>

          <div className="grid-2">
            <Card title="Upcoming team leave">
              <DataTable
                headers={["Person", "Type", "Dates", "Status"]}
                rows={upcomingTeamLeave.map((r) => [
                  personName(r.employeeId, people),
                  r.code.toUpperCase(),
                  `${formatShortDate(r.from)} → ${formatShortDate(r.to)}`,
                  <StatusBadge key={r.id} status={r.status === "approved" ? "Approved" : "Pending"} tone={r.status === "approved" ? "ok" : "warn"} literal />,
                ])}
                empty={<p className="note">No upcoming leave in your team.</p>}
              />
            </Card>

            <Card title={`Upcoming holidays · ${employee.countryName ?? ""}`}>
              <DataTable
                headers={["Date", "Holiday"]}
                rows={myHolidays.map((h) => [formatShortDate(h.date), h.name])}
                empty={<p className="note">No more holidays this year.</p>}
              />
            </Card>
          </div>
        </div>
      )}

      {activeTab === "workforce" && canCompany && (
        <div className="grid-2">
          <Card title="Country distribution">
            <BarRows items={stats.byCountry.map((c) => ({ label: c.name, value: c.count }))} />
          </Card>
          <Card title="Department distribution">
            <BarRows items={stats.byDepartment.map((d) => ({ label: d.name, value: d.count }))} />
          </Card>
          <Card title="Business units">
            <BarRows items={stats.byBusinessUnit.map((b) => ({ label: b.name, value: b.count }))} />
          </Card>
        </div>
      )}

      {activeTab === "recruiting" && (
        <div className="grid-2">
          <Card title="Recruitment pipeline">
            <BarRows items={pipeline.map((s) => ({ label: s.stage, value: s.count }))} />
          </Card>
          <Card title="Requisitions">
            <MetricGrid>
              <MetricCard label="Open requisitions" value={openReqs.length} />
              <MetricCard label="Openings" value={openReqs.reduce((n, r) => n + r.openings, 0)} />
              <MetricCard label="Awaiting approval" value={talent.requisitions.filter((r) => r.approvalStatus === "Pending approval").length} />
            </MetricGrid>
          </Card>
        </div>
      )}

      {activeTab === "attendance" && (
        <div className="grid-2">
          <Card title="Attendance · weekly">
            {attendance.trend.length ? (
              <BarRows items={attendance.trend.map((r) => ({ label: r.label, value: r.pct }))} max={100} format={(n) => `${n}%`} />
            ) : (
              <p className="note">No attendance records.</p>
            )}
          </Card>
          <Card title="Leave days · approved">
            <BarRows items={leave.map((r) => ({ label: r.label, value: r.days }))} />
          </Card>
          <Card title="Overtime by department (hours)">
            {attendance.overtime.length ? (
              <BarRows items={attendance.overtime.map((r) => ({ label: r.label, value: r.hours }))} />
            ) : (
              <p className="note">No overtime recorded.</p>
            )}
          </Card>
        </div>
      )}

      {activeTab === "talent" && (
        <div className="grid-2">
          <Card title={`Performance · ${cycle.name}`}>
            <p>
              {cycle.status} · completion <strong>{reviews.completionPct}%</strong> · ends {formatShortDate(cycle.end)}
            </p>
            {reviews.total ? (
              <BarRows
                items={[
                  { label: "Self review", value: Math.round((reviews.selfDone / reviews.total) * 100) },
                  { label: "Manager review", value: Math.round((reviews.managerDone / reviews.total) * 100) },
                  { label: "Rated", value: Math.round((reviews.calibrated / reviews.total) * 100) },
                  { label: "Released", value: Math.round((reviews.released / reviews.total) * 100) },
                ]}
                max={100}
                format={(n) => `${n}%`}
              />
            ) : (
              <p className="note">No reviews in scope.</p>
            )}
          </Card>
          <Card title="Learning & certifications">
            <MetricGrid>
              <MetricCard label="Completion" value={`${learning.pct}%`} hint={`${learning.completed} of ${learning.total}`} />
              <MetricCard label="Certifications YTD" value={learningMore.certificationsYtd} />
              <MetricCard label="Mandatory pending" value={learningMore.mandatoryPending} />
            </MetricGrid>
            <BarRows items={learningMore.topCourses.map((c) => ({ label: c.name, value: c.completionPct }))} max={100} format={(n) => `${n}%`} />
          </Card>
        </div>
      )}

      {activeTab === "skills" && (
        <div className="grid-2">
          <Card title="Skill coverage">
            <BarRows items={skillTop.map((s) => ({ label: s.name, value: s.people }))} />
          </Card>
          <Card title="Critical skill gaps">
            <DataTable
              headers={["Skill", "Gap", "Below target", "Countries"]}
              rows={skillGaps.map((s) => [s.skill, s.gap, String(s.people), s.countries])}
              empty={<p className="note">No skill gaps.</p>}
            />
          </Card>
        </div>
      )}

      {activeTab === "comp" && canCompTab && (
        <Card title={comp ? `${comp.cycle} · ${comp.status}` : "Compensation review"}>
          {comp && comp.total ? (
            <MetricGrid>
              <MetricCard label="Submitted" value={`${comp.submittedPct}%`} hint={`${comp.total} proposals`} />
              <MetricCard label="Managers pending" value={comp.pendingManagers} />
              <MetricCard label="Awaiting approval" value={comp.awaiting} />
              <MetricCard label="Avg increase" value={`${comp.avgIncreasePct}%`} hint={`${comp.approved} approved`} />
            </MetricGrid>
          ) : (
            <p className="note">No proposals in scope.</p>
          )}
        </Card>
      )}

      {activeTab === "system" && canSystem && (
        <div className="stack">
          <MetricGrid>
            <MetricCard label="Connectors" value={integrations.length} />
            <MetricCard label="Connected" value={integrations.filter((i) => i.status === "Connected").length} />
            <MetricCard label="Need attention" value={integrations.filter((i) => i.status === "Degraded" || i.status === "Disconnected").length} />
            <MetricCard label="Errors" value={integrations.reduce((n, i) => n + i.errorCount, 0)} />
          </MetricGrid>
          <div className="grid-2">
            <Card title="Integration health">
              <DataTable
                headers={["Connector", "Status", "Last sync"]}
                rows={integrations.map((i) => [
                  i.name,
                  <StatusBadge key={i.id} status={i.status} tone={integrationTone(i.status)} literal />,
                  i.lastSync,
                ])}
              />
              <p className="note">
                <Link to="/integrations">Integrations</Link>
              </p>
            </Card>
            <Card title="Recent audit events">
              <DataTable
                headers={["When", "Who", "Action"]}
                rows={audit.slice(0, 6).map((r) => [r.at, r.actor, `${r.action} · ${r.target}`])}
              />
              <p className="note">
                <Link to="/admin">Administration</Link>
              </p>
            </Card>
          </div>
        </div>
      )}
    </Page>
  );
}

function integrationTone(status: string): "ok" | "warn" | "danger" | "neutral" {
  return status === "Connected" ? "ok" : status === "Degraded" ? "warn" : status === "Disconnected" ? "danger" : "neutral";
}

/* ───────────────── AI Copilot ───────────────── */

type ChatTurn = { id: string; role: "user" | "assistant"; text: string; answer?: CopilotAnswer };

export function AiCopilotPage() {
  const { employee, demoProfile } = usePortal();
  const askCopilot = useAskCopilot();
  const persona = copilotPersonaFromRole(demoProfile.role);
  const suggestions = COPILOT_SUGGESTIONS[persona];
  const [prompt, setPrompt] = useState("");
  const [history, setHistory] = useState<ChatTurn[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  function ask(question: string) {
    const q = question.trim();
    if (!q) return;
    const answer = askCopilot(q);
    const stamp = Date.now();
    const userTurn: ChatTurn = { id: `u-${stamp}`, role: "user", text: q };
    const botTurn: ChatTurn = { id: `a-${stamp}`, role: "assistant", text: answer.summary, answer };
    setHistory((prev) => [...prev, userTurn, botTurn]);
    setActiveId(botTurn.id);
    setPrompt("");
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    ask(prompt);
  }

  const [askParams, setAskParams] = useSearchParams();
  useEffect(() => {
    const linked = askParams.get("ask");
    if (!linked) return;
    ask(linked);
    setAskParams({}, { replace: true });
    // ask is stable enough for a one-off linked question
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askParams]);

  const conversations = useMemo(() => {
    const starts: { id: string; title: string }[] = [];
    for (let i = 0; i < history.length; i += 2) {
      const turn = history[i];
      if (turn?.role === "user") starts.push({ id: turn.id, title: turn.text.slice(0, 48) });
    }
    return starts.reverse();
  }, [history]);

  return (
    <Page title="AI Copilot">
      <div className="copilot-layout">
        <aside className="copilot-history card">
          <h2 className="card-title">Conversation history</h2>
          {conversations.length === 0 ? (
            <p className="note">Ask a question to get started.</p>
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
          <Card title="Suggested">
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
                  Hi {employee.fullName.split(" ")[0]} — ask about your leave, holidays, approvals or working hours.
                </p>
              )}
              {history.map((turn) => (
                <div key={turn.id} className={`copilot-bubble ${turn.role}`}>
                  <p className="copilot-role">{turn.role === "user" ? "You" : `${PRODUCT_NAME} Copilot`}</p>
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
                  placeholder="e.g. What is my leave balance?"
                />
              </Field>
              <button className="btn" type="submit">
                Send
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
      <CopilotExtras answer={answer} />
      <CopilotSources sources={answer.sources} />
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

/** Questions each agent can start with; they open in the Copilot. */
const AGENT_STARTERS: Record<string, string[]> = {
  employee: ["How many leave days do I have?", "Apply leave next Friday", "I moved to a new address"],
  manager: ["Who is on leave this week?", "What approvals are waiting for me?", "Overtime by person this month"],
  hr: ["Headcount by country", "Who hasn't finished mandatory training?", "Prepare a promotion letter for Babu"],
  recruiter: ["Joiners this quarter by department", "Attrition by department", "Headcount by location"],
  knowledge: ["What is the leave policy?", "What is the remote work policy?", "What is the travel policy?"],
  analytics: ["Headcount by country", "Leave taken by department this month", "Late arrivals by location this month"],
  document: ["Prepare an employment letter for me", "Prepare an experience letter for Babu", "Prepare a promotion letter for Babu"],
};

/** Starters for people who can only request their own letters. */
const SELF_DOCUMENT_STARTERS = ["Prepare an employment letter for me", "Prepare an address proof letter for me", "Prepare a visa letter for me"];

/** Who each agent is for; agents not listed are for everyone. */
const AGENT_ROLES: Record<string, readonly string[]> = {
  manager: ["manager", "executive"],
  hr: ["hr_admin", "super_admin"],
  recruiter: ["recruiter", "hr_admin", "super_admin"],
  analytics: ["manager", "hr_admin", "executive", "super_admin"],
};

export function AiAgentsPage() {
  const { demoProfile } = usePortal();
  if (!hasModuleAccess(demoProfile, "agents")) {
    return (
      <Page title="AI Agents" subtitle="Autonomous assistants">
        <EmptyState title="Not authorized" description="You don't have access to AI Agents." />
      </Page>
    );
  }

  const agents = AI_AGENTS.filter((agent) => agentEnabled(agent.id) && (!AGENT_ROLES[agent.id] || AGENT_ROLES[agent.id].includes(demoProfile.role)));
  const hrLetters = canManageLetters(demoProfile);
  const startersFor = (id: string) => (id === "document" && !hrLetters ? SELF_DOCUMENT_STARTERS : (AGENT_STARTERS[id] ?? []));
  return (
    <Page title="AI Agents">
      {agents.length === 0 && <EmptyState title="No agents switched on" description="An admin can switch agents on in AI settings." />}
      <div className="agent-grid">
        {agents.map((agent) => (
          <Card key={agent.id} title={agent.name} className="agent-card">
            <p className="note">{agent.audience}</p>
            <p>{agent.purpose}</p>
            <dl className="info-grid">
              <div className="info-fact">
                <dt>Availability</dt>
                <dd>{agent.availability}</dd>
              </div>
              <div className="info-fact">
                <dt>Status</dt>
                <dd>
                  <StatusBadge
                    status={agent.demoStatus === "Demo ready" ? "Ready" : agent.demoStatus === "Demo beta" ? "Beta" : "Planned"}
                    tone={agent.demoStatus === "Demo ready" ? "ok" : agent.demoStatus === "Demo beta" ? "warn" : "info"}
                    literal
                  />
                </dd>
              </div>
            </dl>
            <div className="agent-starters">
              {startersFor(agent.id).map((q) => (
                <Link key={q} className="btn-ghost btn-tiny" to={`/ai/copilot?ask=${encodeURIComponent(q)}`}>
                  {q}
                </Link>
              ))}
            </div>
          </Card>
        ))}
      </div>
    </Page>
  );
}

/* ───────────────── Integration Center ───────────────── */

function runTime(value: Date | string | null): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

function scheduleLabel(id: SyncSchedule): string {
  return SYNC_SCHEDULES.find((s) => s.id === id)?.label ?? id;
}

export function IntegrationsPage() {
  usePlatformTick();
  const { demoProfile, employee } = usePortal();
  const [searchParams] = useSearchParams();
  const integrations = listIntegrations();
  const linked = searchParams.get("connector");
  const [selected, setSelected] = useState(integrations.find((i) => i.id === linked)?.id ?? integrations[0]?.id ?? "sso");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [pendingRetry, setPendingRetry] = useState<string | null>(null);
  const [toast, setToast] = useState<{ tone: "ok" | "err" | "warn"; text: string } | null>(null);

  const active = integrations.find((i) => i.id === selected) ?? integrations[0];
  const actor = { id: employee.id, name: employee.fullName };

  if (!hasModuleAccess(demoProfile, "integrations") && !hasModuleAccess(demoProfile, "*")) {
    return (
      <Page title="Integrations" subtitle="Connectors and sync status">
        <EmptyState title="Not authorized" description="Only admins manage integrations." />
      </Page>
    );
  }

  function requestRetry(id: string) {
    setPendingRetry(id);
    setReviewOpen(true);
  }

  function confirmRetry() {
    if (!pendingRetry) return;
    const result = retryIntegration(pendingRetry, employee.fullName);
    setReviewOpen(false);
    setPendingRetry(null);
    if (!result) setToast({ tone: "err", text: "This connector can't be retried." });
    else if (result.ok) setToast({ tone: "ok", text: `${result.item.name} synced.` });
    else setToast({ tone: "err", text: `${result.item.name} retry failed. Check the logs.` });
  }

  function runSync(id: string) {
    const result = runIntegrationSync(id, actor);
    if (!result) setToast({ tone: "err", text: "This connector isn't set up." });
    else if (result.failed.length)
      setToast({ tone: "warn", text: `${result.item.name}: ${result.passed} of ${result.processed} records synced, ${result.failed.length} moved to quarantine.` });
    else setToast({ tone: "ok", text: `${result.item.name}: all ${result.processed} records synced.` });
  }

  return (
    <Page title="Integrations">
      {toast && <Banner message={toast} />}
      <div className="grid-2">
        {integrations.map((item) => {
          const held = listQuarantine(item.id).length;
          const totals = integrationTotals(item);
          const schedule = integrationSchedule(item);
          const next = nextRunAt(item);
          return (
            <button
              key={item.id}
              type="button"
              className={`card integration-card ${item.id === selected ? "selected" : ""}`}
              onClick={() => setSelected(item.id)}
            >
              <div className="row-between">
                <h2 className="card-title">{item.name}</h2>
                <span className="chip-row">
                  {held > 0 && <StatusBadge status={`${held} quarantined`} tone="warn" literal />}
                  <StatusBadge status={item.status} tone={integrationTone(item.status)} />
                </span>
              </div>
              <p className="note">{item.category}</p>
              <p>{item.description}</p>
              <dl className="info-grid">
                <div className="info-fact">
                  <dt>Last run</dt>
                  <dd>{item.lastSync}</dd>
                </div>
                <div className="info-fact">
                  <dt>Next run</dt>
                  <dd>
                    {next ? runTime(next) : item.status === "Not configured" ? "—" : schedule === "manual" ? "Manual only" : "Paused"}
                    {next && <small className="note"> · {scheduleLabel(schedule)}</small>}
                  </dd>
                </div>
                <div className="info-fact">
                  <dt>Succeeded</dt>
                  <dd>{totals.succeeded.toLocaleString()}</dd>
                </div>
                <div className="info-fact">
                  <dt>Failed</dt>
                  <dd>{totals.failed.toLocaleString()}</dd>
                </div>
              </dl>
            </button>
          );
        })}
      </div>

      {active && (
        <Card
          title={`${active.name} · logs`}
          action={
            <span className="chip-row">
              <button className="btn" type="button" onClick={() => runSync(active.id)} disabled={active.status === "Not configured"}>
                Run sync
              </button>
              <button className="btn-ghost" type="button" onClick={() => requestRetry(active.id)} disabled={active.status === "Not configured"}>
                Retry sync
              </button>
            </span>
          }
        >
          <DataTable
            headers={["When", "Level", "Message"]}
            rows={active.logs.map((l, i) => [
              l.at,
              <StatusBadge key={`${i}-${l.at}`} status={l.level} tone={l.level === "error" ? "danger" : l.level === "warn" ? "warn" : "info"} />,
              l.message,
            ])}
          />
        </Card>
      )}

      {active && (
        <Card
          title={`${active.name} · runs`}
          action={
            <label className="filter-label">
              Schedule
              <select
                value={integrationSchedule(active)}
                disabled={active.status === "Not configured"}
                onChange={(e) => {
                  setIntegrationSchedule(active.id, e.target.value as SyncSchedule, employee.fullName);
                  setToast({ tone: "ok", text: `${active.name} now syncs: ${scheduleLabel(e.target.value as SyncSchedule).toLowerCase()}.` });
                }}
              >
                {SYNC_SCHEDULES.map((s) => (
                  <option key={s.id} value={s.id}>{s.label}</option>
                ))}
              </select>
            </label>
          }
        >
          <DataTable
            headers={["Time", "Processed", "Succeeded", "Failed", "By"]}
            empty={<p className="note">No runs yet.</p>}
            rows={integrationRuns(active).map((r) => [
              runTime(r.at),
              r.processed,
              r.succeeded,
              r.failed ? <StatusBadge key="f" status={String(r.failed)} tone="danger" literal /> : 0,
              r.by,
            ])}
          />
        </Card>
      )}

      {active && active.status !== "Not configured" && <QuarantineCard connectorId={active.id} actor={actor} onResult={setToast} />}

      <Dialog
        open={reviewOpen}
        title="Retry sync"
        onClose={() => { setReviewOpen(false); setPendingRetry(null); }}
        actions={
          <>
            <button className="btn-ghost" type="button" onClick={() => { setReviewOpen(false); setPendingRetry(null); }}>
              Cancel
            </button>
            <button className="btn" type="button" onClick={confirmRetry}>
              Retry now
            </button>
          </>
        }
      >
        <p>
          Retry the last sync for this connector?
        </p>
      </Dialog>
    </Page>
  );
}

/** Records that failed a sync, with retry, fix & retry and dismiss. */
function QuarantineCard({
  connectorId,
  actor,
  onResult,
}: {
  connectorId: string;
  actor: { id: string; name: string };
  onResult: (msg: { tone: "ok" | "err" | "warn"; text: string }) => void;
}) {
  const records = listQuarantine(connectorId);
  const [editing, setEditing] = useState<{ id: string; mode: "fix" | "dismiss"; value: string; error?: string } | null>(null);

  function retry(r: QuarantineRecord) {
    const out = retryQuarantined(connectorId, r.id, actor);
    if (out.error) onResult({ tone: "err", text: out.error });
    else onResult(out.ok ? { tone: "ok", text: `${r.record} synced.` } : { tone: "warn", text: `${r.record} failed again: ${r.reason}.` });
  }

  function submitEdit(r: QuarantineRecord) {
    if (!editing) return;
    const out =
      editing.mode === "fix"
        ? fixAndRetryQuarantined(connectorId, r.id, editing.value, actor)
        : dismissQuarantined(connectorId, r.id, editing.value, actor);
    if (!out.ok) {
      setEditing({ ...editing, error: out.error });
      return;
    }
    setEditing(null);
    onResult({ tone: "ok", text: editing.mode === "fix" ? `${r.record} fixed and synced.` : `${r.record} dismissed.` });
  }

  function retryAll() {
    const out = retryAllQuarantined(connectorId, actor);
    onResult(
      out.failed
        ? { tone: "warn", text: `${out.passed} synced, ${out.failed} still in quarantine.` }
        : { tone: "ok", text: `All ${out.passed} records synced.` },
    );
  }

  return (
    <Card
      title={`Quarantine (${records.length})`}
      action={
        records.length > 0 && (
          <button className="btn-ghost" type="button" onClick={retryAll}>
            Retry all
          </button>
        )
      }
    >
      <DataTable
        headers={["Record", "Reason", "Time", "Actions"]}
        empty={<p className="note">No failed records. Records that fail a sync are held here.</p>}
        rows={records.map((r) => {
          const open = editing?.id === r.id ? editing : null;
          return [
            r.record,
            <span key="reason">
              {r.reason}
              <br />
              <small className="note">
                {QUARANTINE_FIELD_LABEL[r.field]}: {r.value || "blank"}
                {r.attempts ? ` · ${r.attempts} ${r.attempts === 1 ? "retry" : "retries"}` : ""}
              </small>
            </span>,
            r.at,
            open ? (
              <form
                key="edit"
                className="stack-tight"
                onSubmit={(e) => {
                  e.preventDefault();
                  submitEdit(r);
                }}
              >
                <input
                  aria-label={open.mode === "fix" ? QUARANTINE_FIELD_LABEL[r.field] : "Reason to dismiss"}
                  value={open.value}
                  autoFocus
                  placeholder={open.mode === "fix" ? fixHint(r.field) : "Reason"}
                  onChange={(e) => setEditing({ ...open, value: e.target.value, error: undefined })}
                />
                {open.error && <small className="note err">{open.error}</small>}
                <span className="chip-row">
                  <button className="btn btn-tiny" type="submit">
                    {open.mode === "fix" ? "Save & retry" : "Dismiss"}
                  </button>
                  <button className="btn-ghost btn-tiny" type="button" onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                </span>
              </form>
            ) : (
              <span key="actions" className="chip-row">
                <button className="btn-ghost btn-tiny" type="button" onClick={() => retry(r)}>
                  Retry
                </button>
                <button className="btn-ghost btn-tiny" type="button" onClick={() => setEditing({ id: r.id, mode: "fix", value: r.value })}>
                  Fix & retry
                </button>
                <button className="btn-ghost btn-tiny" type="button" onClick={() => setEditing({ id: r.id, mode: "dismiss", value: "" })}>
                  Dismiss
                </button>
              </span>
            ),
          ];
        })}
      />
    </Card>
  );
}

function fixHint(field: QuarantineField): string {
  if (field === "bankAccount") return "9–18 digits";
  if (field === "taxId") return "e.g. ABCDE1234F";
  if (field === "costCentre") return COST_CENTRES.join(", ");
  return "name@company.com";
}

/* ───────────────── Payroll ───────────────── */

export function PayrollPage() {
  const { demoProfile } = usePortal();
  const { countries, regionCode, matchesRegion } = useLocale();
  usePlatformTick();

  if (!hasModuleAccess(demoProfile, "payroll") && !hasModuleAccess(demoProfile, "*")) {
    return (
      <Page title="Payroll" subtitle="Payroll providers">
        <EmptyState title="Not authorized" description="You don't have access to Payroll." />
      </Page>
    );
  }

  const rows = PAYROLL_PROVIDERS.filter((p) => regionCode === "ALL" || matchesRegion(p.country));

  return (
    <Page title="Payroll" subtitle="Provider handoff by country">
      <Banner message={{ tone: "warn", text: "Payroll is run by external providers." }} />
      <FilterBar>
        <RegionalFilter />
      </FilterBar>
      <MetricGrid>
        <MetricCard label="Providers" value={rows.length} />
        <MetricCard label="Connected" value={rows.filter((r) => r.status === "Connected").length} />
        <MetricCard label="Need attention" value={rows.filter((r) => r.status === "Degraded" || r.status === "Disconnected").length} />
        <MetricCard label="Not set up" value={rows.filter((r) => r.status === "Not configured").length} />
      </MetricGrid>
      <Card title="Providers by legal entity">
        <DataTable
          headers={["Country", "Legal entity", "Provider", "Status", "Last handoff", "Note"]}
          rows={rows.map((r) => {
            const c = countries.find((x) => x.code === r.country);
            return [
              c?.name ?? r.country,
              c?.legalEntity ?? "—",
              r.provider,
              <StatusBadge key={r.country} status={r.status} tone={integrationTone(r.status)} literal />,
              r.lastHandoff,
              r.note,
            ];
          })}
        />
        <p className="note">
          Connector retries: <Link to="/integrations">Integrations</Link>
        </p>
      </Card>
      <Card title="Not done in this app">
        <ul className="stack">
          {PAYROLL_STATUS.notImplemented.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </Card>
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
  const [saveError, setSaveError] = useState("");
  const prefs = listNotificationPrefs();
  const audit = listAuditLog();
  // HR can open the console but only platform admins change permissions / settings.
  const canEdit = canEditRolePermissions(demoProfile.role);

  if (!hasModuleAccess(demoProfile, "administration") && !hasModuleAccess(demoProfile, "*")) {
    return (
      <Page title="Administration" subtitle="Platform configuration">
        <EmptyState title="Not authorized" description="You don't have access to Administration." />
      </Page>
    );
  }

  const editing = DEMO_ACCOUNTS.find((a) => a.id === editId);

  function openEditor(accountId: string) {
    const acc = DEMO_ACCOUNTS.find((a) => a.id === accountId);
    if (!acc) return;
    setSaveError("");
    setEditId(accountId);
    setDraftPerms(effectiveCatalogIds(acc));
  }

  const editingSelf = editId === employee.id;
  const editable = canEdit && !editingSelf;

  function togglePerm(id: string) {
    if (!editable) return;
    setDraftPerms((prev) => (prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]));
  }

  function requestSave() {
    if (!editable) return;
    setReviewOpen(true);
  }

  function confirmSave() {
    if (!editId) return;
    const target = DEMO_ACCOUNTS.find((a) => a.id === editId);
    if (!target) return;
    const error = saveRoleEdit(target, draftPerms, {
      id: employee.id,
      fullName: employee.fullName,
      role: demoProfile.role,
      navAccess: demoProfile.navAccess,
    });
    setReviewOpen(false);
    if (error) {
      setSaveError(error);
      return;
    }
    setSaveError("");
    setEditId(null);
  }

  return (
    <Page title="Administration">
      <Tabs
        tabs={[
          { id: "users", label: "Users" },
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
        <Card title="Org chart">
          <OrgChart />
        </Card>
      )}

      {tab === "roles" && (
        <Card
          title="Role & permission editor"
          action={
            editing && editable ? (
              <button className="btn" type="button" onClick={requestSave}>
                Save changes
              </button>
            ) : undefined
          }
        >
          <FilterBar>
            <select
              aria-label="Select user"
              value={editId ?? ""}
              onChange={(e) => (e.target.value ? openEditor(e.target.value) : setEditId(null))}
            >
              <option value="">Select a user…</option>
              {DEMO_ACCOUNTS.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.personaLabel} — {a.fullName}
                </option>
              ))}
            </select>
          </FilterBar>
          {!canEdit && (
            <Banner message={{ tone: "err", text: "Only admins can change permissions." }} />
          )}
          {canEdit && editingSelf && (
            <Banner message={{ tone: "err", text: "You cannot change permissions on your own account." }} />
          )}
          {saveError && <Banner message={{ tone: "err", text: saveError }} />}
          {!editing && (
            <EmptyState
              title="Select a user"
              description={canEdit ? "Grant or remove module access." : "View module access."}
            />
          )}
          {editing && (
            <>
              <p>
                Editing <strong>{editing.fullName}</strong> · role {roleLabel(editing.role)}. Pay access can only be granted by someone who holds it.
              </p>
              <ul className="perm-grid">
                {ROLE_PERMISSION_CATALOG.map((p) => (
                  <li key={p.id}>
                    <label className="perm-item">
                      <input
                        type="checkbox"
                        checked={draftPerms.includes(p.id)}
                        disabled={!editable}
                        onChange={() => togglePerm(p.id)}
                      />
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
            Holiday, leave, working-time, benefits and document reference:{" "}
            <Link to="/admin/countries">Country configuration</Link>. Region and language:{" "}
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
              <StatusBadge key={r.id} status={r.outcome} tone={r.outcome === "Failed" ? "danger" : "ok"} literal />,
            ])}
          />
        </Card>
      )}

      {tab === "notifications" && (
        <Card title="Notification preferences">
          <DataTable
            headers={["Channel", "Description", "Email", "In-app", "Digests"]}
            rows={prefs.map((p) => [
              p.channel,
              p.description,
              <PrefToggle key={`${p.id}-e`} disabled={!canEdit} checked={p.email} onChange={(v) => updateNotificationPref(p.id, { email: v }, employee.fullName)} />,
              <PrefToggle key={`${p.id}-i`} disabled={!canEdit} checked={p.inApp} onChange={(v) => updateNotificationPref(p.id, { inApp: v }, employee.fullName)} />,
              <PrefToggle key={`${p.id}-d`} disabled={!canEdit} checked={p.digests} onChange={(v) => updateNotificationPref(p.id, { digests: v }, employee.fullName)} />,
            ])}
          />
        </Card>
      )}

      <Dialog
        open={reviewOpen}
        title="Confirm permission change"
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
          Save the new module access for <strong>{editing?.fullName}</strong>?
        </p>
      </Dialog>
    </Page>
  );
}

function PrefToggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
      aria-label="Toggle preference"
    />
  );
}
