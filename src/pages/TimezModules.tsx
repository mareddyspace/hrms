import { useMemo, useState, useSyncExternalStore } from "react";
import { Link } from "react-router-dom";
import {
  Card,
  DataTable,
  EmptyState,
  MetricCard,
  MetricGrid,
  Page,
  StatusBadge,
  Tabs,
} from "../components/ui.tsx";
import { allReportIds, directReportIds, getPerson, listPeople, managerChainIds, subscribePeople } from "../data/peopleLocal.ts";
import { managementChain } from "../demoAccounts.ts";
import { parseISODate, plural, todayISO } from "../model.ts";
import { usePortal } from "../store.tsx";

export {
  AdminPage,
  AiAgentsPage,
  AiCopilotPage,
  AnalyticsPage,
  IntegrationsPage,
  PayrollPage,
} from "./PlatformModules.tsx";

export { RecruitingPage, OnboardingPage, SkillsCareerPage } from "./TalentModules.tsx";

/** Days from an ISO date to today (0 for today or future dates). */
function ageInDays(fromISO: string, today = todayISO()): number {
  const ms = parseISODate(today).getTime() - parseISODate(fromISO.slice(0, 10)).getTime();
  return Math.max(0, Math.round(ms / 86_400_000));
}

function nameOf(id: string): string {
  return getPerson(id)?.fullName ?? "Unknown";
}

/** The first person above someone in the reporting line — the one who decides their requests. */
function approverOf(employeeId: string): string | undefined {
  return managementChain(employeeId)[0]?.id ?? managerChainIds(employeeId)[0];
}

export function MyTeamPage() {
  const { employee, state } = usePortal();
  const people = useSyncExternalStore(subscribePeople, listPeople, listPeople);
  const [view, setView] = useState("direct");
  const { direct, everyone } = useMemo(() => {
    const directIds = new Set(directReportIds(employee.id));
    const all = allReportIds(employee.id);
    const byId = new Map(people.map((p) => [p.id, p]));
    const rows = all.map((id) => byId.get(id)).filter((p): p is NonNullable<typeof p> => Boolean(p));
    return { direct: rows.filter((p) => directIds.has(p.id)), everyone: rows };
  }, [employee.id, people]);

  const teamIds = useMemo(() => new Set(everyone.map((p) => p.id)), [everyone]);
  const pendingLeave = state.leaveRequests.filter((l) => l.status === "pending" && teamIds.has(l.employeeId)).length;
  const openTasks = state.tasks.filter((t) => (t.status === "open" || t.status === "progress") && teamIds.has(t.employeeId)).length;
  const onLeave = everyone.filter((p) => p.availability === "On Leave" || p.employmentStatus === "On Leave").length;

  if (everyone.length === 0) {
    return (
      <Page title="Team overview">
        <EmptyState title="No team" description="No one reports to you." />
      </Page>
    );
  }

  const rows = view === "direct" ? direct : everyone;

  return (
    <Page title="Team overview">
      <MetricGrid>
        <MetricCard label="Direct reports" value={direct.length} />
        <MetricCard label="Whole team" value={everyone.length} hint="Direct and indirect" />
        <MetricCard label="Pending leave" value={pendingLeave} />
        <MetricCard label="Open tasks" value={openTasks} hint={onLeave ? `${onLeave} on leave` : undefined} />
      </MetricGrid>
      <Card title="Team members">
        <Tabs
          tabs={[
            { id: "direct", label: `Direct (${direct.length})` },
            { id: "all", label: `Everyone (${everyone.length})` },
          ]}
          value={view}
          onChange={setView}
        />
        <DataTable
          headers={["Name", "Title", "Department", "Country", "Reports to", "Availability"]}
          rows={rows.slice(0, 200).map((person) => [
            <Link key={person.id} to={`/people/${person.id}`}>{person.fullName}</Link>,
            person.designation,
            person.department,
            person.countryName,
            person.managerName,
            person.availability,
          ])}
          empty={<EmptyState title="No team members" description="No one in this view." />}
        />
        {rows.length > 200 && <p className="muted">Showing 200 of {rows.length}.</p>}
      </Card>
    </Page>
  );
}

type TrackedRequest = {
  id: string;
  type: string;
  employeeId: string;
  detail: string;
  submittedOn: string;
};

/** Read-only tracker of open requests: your own, and the ones waiting for your decision. */
export function WorkflowsPage() {
  const { employee, state, canDecideFor } = usePortal();
  const [view, setView] = useState("mine-to-decide");
  const today = todayISO();

  const open: TrackedRequest[] = [
    ...state.leaveRequests
      .filter((r) => r.status === "pending")
      .map((r) => ({ id: r.id, type: "Leave", employeeId: r.employeeId, detail: `${r.code} · ${r.from}${r.to !== r.from ? ` to ${r.to}` : ""}`, submittedOn: r.appliedOn })),
    ...state.expenses
      .filter((r) => r.status === "submitted")
      .map((r) => ({ id: r.id, type: "Expense", employeeId: r.employeeId, detail: `${r.category} · ${r.description}`, submittedOn: r.date })),
    ...state.encashments
      .filter((r) => r.status === "pending")
      .map((r) => ({ id: r.id, type: "Leave encashment", employeeId: r.employeeId, detail: `${plural(r.days, "day")} of ${r.code}`, submittedOn: r.appliedOn })),
    ...state.backdatedPermissions
      .filter((r) => r.status === "pending")
      .map((r) => ({ id: r.id, type: "Past-dated leave", employeeId: r.employeeId, detail: `${r.code} · ${r.from}`, submittedOn: r.requestedOn })),
  ];

  const toDecide = open.filter((r) => r.employeeId !== employee.id && canDecideFor(r.employeeId));
  const mine = open.filter((r) => r.employeeId === employee.id);
  const rows = (view === "mine-to-decide" ? toDecide : mine)
    .map((r) => ({ ...r, age: ageInDays(r.submittedOn, today), approverId: approverOf(r.employeeId) }))
    .sort((a, b) => b.age - a.age);
  const overdue = (list: TrackedRequest[]) => list.filter((r) => ageInDays(r.submittedOn, today) > 3).length;

  return (
    <Page title="Workflows">
      <MetricGrid>
        <MetricCard label="Waiting for you" value={toDecide.length} />
        <MetricCard label="Overdue (over 3 days)" value={overdue(toDecide)} />
        <MetricCard label="Your open requests" value={mine.length} />
      </MetricGrid>
      <Tabs
        tabs={[
          { id: "mine-to-decide", label: `To decide (${toDecide.length})` },
          { id: "mine", label: `My requests (${mine.length})` },
        ]}
        value={view}
        onChange={setView}
      />
      <DataTable
        headers={["Type", "Requested by", "Details", "Waiting with", "Age", ""]}
        rows={rows.map((r) => [
          r.type,
          nameOf(r.employeeId),
          r.detail,
          r.approverId ? nameOf(r.approverId) : "No approver needed",
          `${r.age} day${r.age === 1 ? "" : "s"}`,
          r.age > 3 ? <StatusBadge key={r.id} status="Overdue" tone="danger" literal /> : "",
        ])}
        empty={<EmptyState title="Nothing open" description={view === "mine" ? "You have no open requests." : "Nothing is waiting for you."} />}
      />
      <p className="muted">
        Decide requests in <Link to="/approvals">Approvals</Link>.
      </p>
    </Page>
  );
}
