import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Card, EmptyState, MetricCard, MetricGrid, Page, StatusBadge, Tabs } from "../components/ui.tsx";
import { formatHoursAmount, formatShortDate, todayISO } from "../model.ts";
import type { Project } from "../model.ts";
import { usePortal } from "../store.tsx";
import { ticketsAssignedTo, useTickets } from "../data/ticketStore.ts";
import { projectDetail, type ProjectHealth } from "../data/projectCatalog.ts";
import { dayStatusOf } from "../data/timesheetDays.ts";
import "./projects.css";

const HEALTH_TONE: Record<ProjectHealth, "ok" | "warn" | "danger" | "neutral"> = {
  "On track": "ok",
  "At risk": "warn",
  Delayed: "danger",
  Completed: "neutral",
};

function Progress({ value }: { value: number }) {
  return (
    <div className="progress" aria-label={`${value}% done`}>
      <i style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

export function ProjectsPage() {
  const { currentProjects, previousProjects } = usePortal();
  const [params, setParams] = useSearchParams();
  const mode = params.get("list") === "previous" ? "previous" : "current";
  const list = mode === "current" ? currentProjects : previousProjects;
  const openId = params.get("id");
  const selected = [...currentProjects, ...previousProjects].find((p) => p.id === openId);

  if (selected) {
    return <ProjectDetailView project={selected} onBack={() => setParams(mode === "previous" ? { list: "previous" } : {})} />;
  }

  return (
    <Page title="My projects" subtitle={`${currentProjects.length} current · ${previousProjects.length} previous`}>
      <Tabs
        tabs={[
          { id: "current", label: "Current" },
          { id: "previous", label: "Previous" },
        ]}
        value={mode}
        onChange={(id) => setParams(id === "previous" ? { list: "previous" } : {})}
      />
      {list.length === 0 ? (
        <EmptyState title="No projects in this list" />
      ) : (
        <div className="project-cards">
          {list.map((project) => (
            <ProjectCard key={project.id} project={project} onOpen={() => setParams({ ...(mode === "previous" ? { list: "previous" } : {}), id: project.id })} />
          ))}
        </div>
      )}
    </Page>
  );
}

function ProjectCard({ project, onOpen }: { project: Project; onOpen: () => void }) {
  const { hoursFor, employee } = usePortal();
  const d = projectDetail(project, employee.role);
  const hours = hoursFor(project.id);
  return (
    <button type="button" className="project-card" onClick={onOpen}>
      <span className="project-card-head">
        <strong>{project.name}</strong>
        <StatusBadge status={d.health} tone={HEALTH_TONE[d.health]} literal />
      </span>
      <span className="muted">
        {d.client || project.client} · {d.myRole}
      </span>
      <Progress value={d.progress} />
      <span className="muted project-card-foot">
        <span>{d.progress}% done</span>
        <span>
          {formatHoursAmount(hours)}
          {d.myBudgetHours ? ` of ${d.myBudgetHours} h` : ""}
        </span>
      </span>
    </button>
  );
}

function ProjectDetailView({ project, onBack }: { project: Project; onBack: () => void }) {
  const { state, employee, hoursFor } = usePortal();
  const tickets = useTickets();
  const d = projectDetail(project, employee.role);
  const today = todayISO();
  const logged = hoursFor(project.id);
  const mySheets = state.timesheets.filter((s) => s.employeeId === employee.id && s.projectId === project.id);
  // Approved: hours in an approved week, or on a day whose daily timesheet was approved.
  const approved = mySheets.reduce(
    (a, s) =>
      a +
      s.entries
        .filter((e) => s.status === "approved" || dayStatusOf(employee.id, e.date) === "approved")
        .reduce((x, e) => x + e.hours, 0),
    0,
  );
  const left = Math.max(0, d.myBudgetHours - logged);
  const usedPct = d.myBudgetHours ? Math.round((logged / d.myBudgetHours) * 100) : 0;

  const myTickets = useMemo(
    () => ticketsAssignedTo(employee.id, tickets).filter((t) => t.projectId === project.id || t.projectName === project.name),
    [employee.id, project.id, project.name, tickets],
  );
  const myPortalTasks = state.tasks.filter(
    (t) => t.employeeId === employee.id && t.status !== "done" && !!t.client && t.client.toLowerCase() === (d.client || project.client).toLowerCase(),
  );

  const activity = useMemo(() => {
    const mine = mySheets
      .flatMap((s) => s.entries.map((e) => ({ date: e.date, who: "You", text: `Logged ${formatHoursAmount(e.hours)}${e.note ? ` · ${e.note}` : ""}` })))
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 4);
    return [...mine, ...d.activity].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8);
  }, [d.activity, mySheets]);

  const nextMilestone = d.milestones.find((m) => !m.done);

  return (
    <Page
      title={project.name}
      subtitle={[project.code, d.client || project.client].filter(Boolean).join(" · ")}
      action={
        <button type="button" className="btn-ghost" onClick={onBack}>
          All projects
        </button>
      }
    >
      <MetricGrid>
        <MetricCard label="Progress" value={`${d.progress}%`} hint={d.health} />
        <MetricCard label="My hours" value={formatHoursAmount(logged)} hint={d.myBudgetHours ? `${usedPct}% of ${d.myBudgetHours} h budget` : undefined} />
        <MetricCard label="Approved hours" value={formatHoursAmount(approved)} />
        <MetricCard
          label="Next milestone"
          value={nextMilestone ? formatShortDate(nextMilestone.due) : "—"}
          hint={nextMilestone?.name ?? "All done"}
        />
      </MetricGrid>

      <div className="split">
        <Card title="About">
          {d.description && <p style={{ marginTop: 0 }}>{d.description}</p>}
          <dl className="meta">
            <dt>Client</dt>
            <dd>{d.client || project.client || "—"}</dd>
            <dt>Status</dt>
            <dd>
              <StatusBadge status={d.health} tone={HEALTH_TONE[d.health]} literal />
            </dd>
            <dt>Start</dt>
            <dd>{d.start ? formatShortDate(d.start) : "—"}</dd>
            <dt>End</dt>
            <dd>{d.end ? formatShortDate(d.end) : "Ongoing"}</dd>
            <dt>My role</dt>
            <dd>{d.myRole}</dd>
            {d.manager && (
              <>
                <dt>Manager</dt>
                <dd>{d.manager}</dd>
              </>
            )}
          </dl>
          <Progress value={d.progress} />
        </Card>

        <Card title="My hours vs budget">
          {d.myBudgetHours ? (
            <>
              <Progress value={usedPct} />
              <dl className="meta">
                <dt>Budget</dt>
                <dd>{d.myBudgetHours} h</dd>
                <dt>Logged</dt>
                <dd>{formatHoursAmount(logged)}</dd>
                <dt>Approved</dt>
                <dd>{formatHoursAmount(approved)}</dd>
                <dt>Left</dt>
                <dd>{formatHoursAmount(left)}</dd>
              </dl>
              {usedPct > 100 && <p className="note warn">Over budget by {formatHoursAmount(logged - d.myBudgetHours)}.</p>}
            </>
          ) : (
            <p className="muted">No budget set. Logged {formatHoursAmount(logged)}.</p>
          )}
          {project.status === "current" && (
            <Link className="btn-ghost btn-tiny" to="/timesheet">
              Log time
            </Link>
          )}
        </Card>
      </div>

      <div className="split">
        <Card title="Milestones">
          {d.milestones.length === 0 ? (
            <p className="muted">No milestones.</p>
          ) : (
            <ul className="project-milestones">
              {d.milestones.map((m) => {
                const late = !m.done && m.due < today;
                return (
                  <li key={m.name} className={m.done ? "done" : late ? "late" : undefined}>
                    <span aria-hidden>{m.done ? "✓" : "○"}</span>
                    <span>{m.name}</span>
                    <span className="muted">
                      {formatShortDate(m.due)}
                      {late ? " · overdue" : ""}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card title="Team">
          {d.team.length === 0 ? (
            <p className="muted">No team listed.</p>
          ) : (
            <ul className="project-team">
              <li>
                <strong>{employee.fullName}</strong>
                <span className="muted">{d.myRole} (you)</span>
              </li>
              {d.team
                .filter((m) => m.name !== employee.fullName)
                .map((m) => (
                  <li key={m.name}>
                    <strong>{m.name}</strong>
                    <span className="muted">{m.role}</span>
                  </li>
                ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="Assigned to me">
        {d.tasks.length + myTickets.length + myPortalTasks.length === 0 ? (
          <p className="muted">Nothing assigned to you on this project.</p>
        ) : (
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Due</th>
                  <th>Estimate</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {myTickets.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <Link to={`/tickets?id=${t.id}`}>
                        {t.id} {t.title}
                      </Link>
                    </td>
                    <td>{t.due ? formatShortDate(t.due) : "—"}</td>
                    <td>—</td>
                    <td>
                      <StatusBadge status={t.status} literal />
                    </td>
                  </tr>
                ))}
                {myPortalTasks.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <Link to="/tasks">{t.subject}</Link>
                    </td>
                    <td>—</td>
                    <td>{t.estimatedHours ? `${t.estimatedHours} h` : "—"}</td>
                    <td>
                      <StatusBadge status={t.status === "progress" ? "In progress" : "Open"} literal />
                    </td>
                  </tr>
                ))}
                {d.tasks.map((t) => (
                  <tr key={t.id}>
                    <td>
                      {t.id} {t.title}
                    </td>
                    <td>
                      {formatShortDate(t.due)}
                      {t.status !== "Done" && t.due < today ? <span className="muted"> · overdue</span> : null}
                    </td>
                    <td>{t.estimate} h</td>
                    <td>
                      <StatusBadge status={t.status} tone={t.status === "Done" ? "ok" : t.status === "To do" ? "neutral" : "info"} literal />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Recent activity">
        {activity.length === 0 ? (
          <p className="muted">No activity yet.</p>
        ) : (
          <ul className="project-activity">
            {activity.map((a, i) => (
              <li key={`${a.date}-${i}`}>
                <span className="muted">{formatShortDate(a.date)}</span>
                <span>
                  <strong>{a.who}</strong> {a.text}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </Page>
  );
}
