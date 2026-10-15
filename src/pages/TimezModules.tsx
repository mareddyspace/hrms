import { useMemo } from "react";
import { Link } from "react-router-dom";
import { PRODUCT_NAME } from "../brand.ts";
import {
  Card,
  DataTable,
  EmptyState,
  FilterBar,
  MetricCard,
  MetricGrid,
  Page,
  StatusBadge,
  StatusPill,
  Tabs,
} from "../components/ui.tsx";
import { TIMEZ_COUNTRIES } from "../model.ts";
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

export function MyTeamPage() {
  const { employee, isManager, state } = usePortal();
  const team = useMemo(() => {
    if (!isManager) return [];
    return state.colleagues
      .filter(
        (person) =>
          person.managerName.includes(employee.fullName.split(" ")[0]) ||
          person.department === (employee.department ?? "Engineering"),
      )
      .slice(0, 12);
  }, [employee, isManager, state.colleagues]);

  if (!isManager) {
    return (
      <Page title="My Team" subtitle="Team visibility for managers and HR">
        <EmptyState
          title="Not authorized"
          description="Switch to a manager, HR, admin, or executive persona to view My Team."
        />
      </Page>
    );
  }

  return (
    <Page title="My Team" subtitle="Direct reports and team snapshot">
      <MetricGrid>
        <MetricCard label="Team in view" value={team.length} hint="Sample from workforce directory" />
        <MetricCard
          label="Pending leave"
          value={state.leaveRequests.filter((item) => item.status === "pending").length}
        />
        <MetricCard
          label="Open tasks"
          value={state.tasks.filter((item) => item.status === "open" || item.status === "progress").length}
        />
        <MetricCard label="Countries" value={TIMEZ_COUNTRIES.length} />
      </MetricGrid>
      <Card title="Team members">
        <DataTable
          headers={["Name", "Code", "Role", "Country", "Availability"]}
          rows={team.map((person) => [
            person.name,
            person.employeeCode,
            person.designation,
            person.workingCountry,
            person.availability,
          ])}
          empty={<EmptyState title="No team members" description="No matching reports in the sample directory." />}
        />
      </Card>
    </Page>
  );
}

export function WorkflowsPage() {
  const { state } = usePortal();
  const rows = [
    ...state.leaveRequests
      .filter((item) => item.status === "pending")
      .map((item) => ["Leave", item.id, item.employeeId, item.from, item.status]),
    ...state.expenses
      .filter((item) => item.status === "submitted")
      .map((item) => ["Expense", item.id, item.employeeId, item.date, item.status]),
  ].slice(0, 20);

  return (
    <Page title="Workflows & Approvals" subtitle="Configurable approval queues and SLA tracking (frontend foundation)">
      <Tabs
        tabs={[
          { id: "queue", label: "Active queue" },
          { id: "defs", label: "Workflow definitions" },
        ]}
        value="queue"
        onChange={() => undefined}
      />
      <FilterBar>
        <input placeholder="Filter by type…" aria-label="Filter workflows" />
        <select aria-label="Status" defaultValue="open">
          <option value="open">Open</option>
          <option value="all">All</option>
        </select>
      </FilterBar>
      <DataTable
        headers={["Type", "Reference", "Employee", "Date", "Status"]}
        rows={rows.map((row) =>
          row.map((cell, index) => (index === 4 ? <StatusBadge key={String(cell)} status={String(cell)} /> : cell)),
        )}
        empty={<EmptyState title="Queue clear" description="No open workflow items right now." />}
      />
      <Card title="Definitions (placeholder)">
        <p className="note">
          Leave, expense, cash, asset, and timesheet workflows are enforced in the current portal store. A dedicated
          workflow designer will land in a later phase.
        </p>
      </Card>
    </Page>
  );
}

export function RoadmapPage() {
  const phases = [
    { name: "Phase 0 – Discovery", status: "Done" },
    { name: "Phase 1 – Platform foundation", status: "In progress" },
    { name: "Phase 2 – Core workforce", status: "In progress" },
    { name: "Phase 3 – Talent", status: "Scaffolded" },
    { name: "Phase 4 – Compensation & benefits", status: "Scaffolded" },
    { name: "Phase 5 – AI platform", status: "Scaffolded" },
    { name: "Phase 6 – Global enterprise", status: "Planned" },
  ];
  return (
    <Page title="Product roadmap" subtitle={`${PRODUCT_NAME} delivery phases from the HCM blueprint`}>
      <Card title="Roadmap">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Phase</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {phases.map((phase) => (
                <tr key={phase.name}>
                  <td>{phase.name}</td>
                  <td>
                    <StatusPill
                      status={
                        phase.status === "Done"
                          ? "approved"
                          : phase.status === "In progress"
                            ? "pending"
                            : "withdrawn"
                      }
                    />{" "}
                    {phase.status}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="note" style={{ marginTop: 12 }}>
          Explore <Link to="/ai/copilot">AI Copilot</Link> and <Link to="/integrations">Integrations</Link> for
          scaffolded modules.
        </p>
      </Card>
    </Page>
  );
}
