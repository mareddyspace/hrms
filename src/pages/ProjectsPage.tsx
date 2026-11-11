import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ActionButton, Banner, Card, Dialog, EmptyState, Field, FilterBar, MetricCard, MetricGrid, Page, StatusBadge, Tabs } from "../components/ui.tsx";
import { formatHoursAmount, formatShortDate, todayISO } from "../model.ts";
import { usePortal } from "../store.tsx";
import { ticketsAssignedTo, useTickets } from "../data/ticketStore.ts";
import { useProjectContext } from "./projectContext.ts";
import {
  HEALTH_CALL_LABEL,
  PROJECT_STATUS_LABEL,
  TASK_PRIORITIES,
  TASK_STATUS_LABEL,
  addLink,
  addMember,
  addPost,
  completionOf,
  exportProjectCsv,
  milestoneProgress,
  removeMember,
  deadlineAlerts,
  deleteDocument,
  deleteMilestone,
  deletePost,
  deleteTask,
  healthOf,
  nextMilestone,
  openDocument,
  refreshProjects,
  saveMember,
  saveMilestone,
  saveProject,
  saveTask,
  setTaskStatus,
  uploadDocument,
  useProject,
  useProjectReport,
  useProjects,
  type HealthCall,
  type LocalContext,
  type PMember,
  type PMilestone,
  type PTask,
  type ProjectHealth,
  type ProjectInfo,
  type ProjectStatus,
  type TaskPriority,
  type TaskStatus,
} from "../data/projectStore.ts";
import { usePeopleList } from "../data/peopleLocal.ts";
import { BarChart, HBarChart, LineChart } from "./dashboards/charts.tsx";
import "./projects.css";
import "../styles/workspace.css";
import "../styles/projects.css";

const HEALTH_TONE: Record<ProjectHealth, "ok" | "warn" | "danger" | "neutral"> = {
  "On track": "ok",
  "At risk": "warn",
  Delayed: "danger",
  Completed: "neutral",
};
const STATUS_TONE: Record<TaskStatus, "ok" | "warn" | "info" | "neutral"> = { todo: "neutral", in_progress: "info", in_review: "warn", done: "ok" };
type Msg = { tone: "ok" | "err" | "warn" | "info"; text: string } | null;
type SortKey = "status" | "progress" | "deadline" | "name";
type DetailTab = "overview" | "tasks" | "team" | "hours" | "updates";
const PRIORITY_RANK: Record<TaskPriority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

function Progress({ value, label, tone }: { value: number; label: string; tone?: "warn" | "danger" }) {
  return (
    <div className={`progress${tone ? ` ${tone}` : ""}`} role="img" aria-label={label}>
      <i style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

const h = (n: number) => formatHoursAmount(Math.round(n * 100) / 100);

const AVATAR_HUES = [196, 160, 262, 24, 330, 210, 120, 280];
function initialsOf(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}
function hueOf(id: string) {
  let n = 0;
  for (const ch of id) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_HUES[n % AVATAR_HUES.length];
}

/** Initials avatar with a stable colour per person. */
function PersonAvatar({ id, name, size = 28 }: { id: string; name: string; size?: number }) {
  return (
    <span className="ws-avatar" style={{ width: size, height: size, fontSize: Math.round(size * 0.38), ["--hue" as string]: hueOf(id) }} title={name} aria-hidden="true">
      {initialsOf(name)}
    </span>
  );
}

/** Overlapping avatars, then "+n". */
function AvatarStack({ members, max = 5 }: { members: PMember[]; max?: number }) {
  const shown = members.slice(0, max);
  return (
    <span className="ws-avatar-stack" aria-label={`${members.length} team ${members.length === 1 ? "member" : "members"}: ${members.map((m) => m.name).join(", ")}`}>
      {shown.map((m) => (
        <PersonAvatar key={m.employeeId} id={m.employeeId} name={m.name} size={26} />
      ))}
      {members.length > max && <span className="ws-avatar ws-avatar-more">+{members.length - max}</span>}
    </span>
  );
}

/** Milestones as dots on a line: done, overdue, upcoming. */
function MilestoneTrack({ milestones, today }: { milestones: PMilestone[]; today: string }) {
  if (milestones.length === 0) return <span className="muted ws-track-empty">No milestones yet</span>;
  const sorted = [...milestones].sort((a, b) => a.due.localeCompare(b.due));
  const done = sorted.filter((m) => m.completedOn).length;
  return (
    <span className="ws-track" aria-label={`${done} of ${sorted.length} milestones done`}>
      <span className="ws-track-line" aria-hidden="true">
        {sorted.map((m) => {
          const state = m.completedOn ? "done" : m.due < today ? "late" : "todo";
          return <i key={m.id} className={state} title={`${m.name} · ${formatShortDate(m.due)}${state === "late" ? " · overdue" : state === "done" ? " · done" : ""}`} />;
        })}
      </span>
      <span className="ws-track-label">
        {done}/{sorted.length} milestones
      </span>
    </span>
  );
}

function usedPct(p: ProjectInfo) {
  return p.budgetHours ? Math.round((p.loggedHours / p.budgetHours) * 100) : 0;
}

export function ProjectsPage() {
  const ctx = useProjectContext();
  const projects = useProjects(ctx);
  // Shared data: fetch the latest whenever the page opens (others may have changed milestones or tasks).
  useEffect(() => {
    void refreshProjects();
  }, []);
  const [params, setParams] = useSearchParams();
  const mode = params.get("list") === "previous" ? "previous" : "current";
  const openId = params.get("id");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("deadline");
  const today = todayISO();

  const listParams = (extra: Record<string, string> = {}) => ({ ...(mode === "previous" ? { list: "previous" } : {}), ...extra });
  if (openId) return <ProjectDetailView id={openId} ctx={ctx} onBack={() => setParams(listParams())} />;

  const current = projects.filter((p) => p.active);
  const previous = projects.filter((p) => !p.active);
  const needle = query.trim().toLowerCase();
  const healthRank: Record<ProjectHealth, number> = { Delayed: 0, "At risk": 1, "On track": 2, Completed: 3 };
  const deadline = (p: ProjectInfo) => nextMilestone(p)?.due ?? p.end ?? "9999";
  const list = (mode === "current" ? current : previous)
    .filter((p) => !needle || [p.name, p.code, p.client, p.myTitle, p.managerName].some((v) => v?.toLowerCase().includes(needle)))
    .sort((a, b) =>
      sort === "status"
        ? healthRank[healthOf(a, today)] - healthRank[healthOf(b, today)] || a.name.localeCompare(b.name)
        : sort === "progress"
          ? completionOf(b).pct - completionOf(a).pct
          : sort === "deadline"
            ? (deadline(a) || "9999").localeCompare(deadline(b) || "9999")
            : a.name.localeCompare(b.name),
    );

  return (
    <Page title="My projects">
      <Tabs
        tabs={[
          { id: "current", label: `Current (${current.length})` },
          { id: "previous", label: `Previous (${previous.length})` },
        ]}
        value={mode}
        onChange={(id) => setParams(id === "previous" ? { list: "previous" } : {})}
      />
      <FilterBar>
        <input type="search" aria-label="Search projects" placeholder="Search by name, code, client or role" value={query} onChange={(e) => setQuery(e.target.value)} />
        <label className="project-sort">
          <span className="muted">Sort by</span>
          <select aria-label="Sort projects" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
            <option value="deadline">Next deadline</option>
            <option value="status">Status (needs attention first)</option>
            <option value="progress">Completion</option>
            <option value="name">Name</option>
          </select>
        </label>
      </FilterBar>
      {mode === "current" && current.length > 0 && (
        <div className="ws-proj-summary">
          <span>
            <strong>{current.length}</strong> active
          </span>
          <span>
            <strong>{current.filter((x) => { const hh = healthOf(x, today); return hh === "At risk" || hh === "Delayed"; }).length}</strong> need attention
          </span>
          <span>
            <strong>{h(current.reduce((sum, x) => sum + x.myLoggedHours, 0))}</strong> logged by me
          </span>
          <span>
            <strong>{current.reduce((sum, x) => sum + x.tasks.filter((t) => t.assigneeId === ctx.viewerId && t.status !== "done").length, 0)}</strong> open tasks for me
          </span>
        </div>
      )}
      {list.length === 0 ? (
        <EmptyState title={needle ? "No project matches your search" : "No projects in this list"} />
      ) : (
        <div className="project-cards ws-proj-grid">
          {list.map((project) => (
            <ProjectCard key={project.id} project={project} viewerId={ctx.viewerId} onOpen={() => setParams(listParams({ id: project.id }))} />
          ))}
        </div>
      )}
    </Page>
  );
}

function ProjectCard({ project: p, viewerId, onOpen }: { project: ProjectInfo; viewerId: string; onOpen: () => void }) {
  const today = todayISO();
  const health = healthOf(p, today);
  const done = completionOf(p);
  const next = nextMilestone(p);
  const used = usedPct(p);
  const myOpen = p.tasks.filter((t) => t.assigneeId === viewerId && t.status !== "done").length;
  const late = !!next && next.due < today;
  return (
    <button type="button" className={`ws-proj-card health-${health.replace(/\s+/g, "-").toLowerCase()}`} onClick={onOpen} aria-label={`Open ${p.name}`}>
      <span className="ws-proj-top">
        <span className="ws-proj-id">
          <span className="ws-proj-code">{p.code}</span>
          <StatusBadge status={health} tone={HEALTH_TONE[health]} literal />
          {p.status !== "active" && p.status !== "completed" && <StatusBadge status={PROJECT_STATUS_LABEL[p.status]} tone="neutral" literal />}
        </span>
        <strong className="ws-proj-name">{p.name}</strong>
        <span className="ws-proj-client">{p.client || "Internal"}</span>
      </span>

      <span className="ws-proj-progress">
        <span className="project-card-metric">
          <span>Progress</span>
          <strong>{done.pct}%</strong>
        </span>
        <Progress value={done.pct} label={`${done.pct}% complete`} />
      </span>

      <MilestoneTrack milestones={p.milestones} today={today} />

      <span className="ws-proj-facts">
        <span>
          <em>My role</em>
          <b>{p.myTitle || "Member"}</b>
        </span>
        <span>
          <em>My hours</em>
          <b>
            {h(p.myLoggedHours)}
            {p.myBudgetHours ? ` / ${p.myBudgetHours} h` : ""}
          </b>
        </span>
        <span>
          <em>Team hours</em>
          <b className={used > 100 ? "over" : undefined}>{p.budgetHours ? `${used}% of ${p.budgetHours} h` : h(p.loggedHours)}</b>
        </span>
        <span>
          <em>My open tasks</em>
          <b>{myOpen}</b>
        </span>
      </span>

      <span className="ws-proj-foot">
        <AvatarStack members={p.members} />
        <span className={late ? "ws-proj-next late" : "ws-proj-next"}>
          {next ? `${late ? "Overdue" : "Next"}: ${next.name} · ${formatShortDate(next.due)}` : p.end ? `Ends ${formatShortDate(p.end)}` : "No deadline"}
        </span>
      </span>
    </button>
  );
}

function ProjectDetailView({ id, ctx, onBack }: { id: string; ctx: LocalContext; onBack: () => void }) {
  const { project, loading } = useProject(id, ctx);
  if (!project) {
    return (
      <Page title="Project" action={<button type="button" className="btn-ghost" onClick={onBack}>All projects</button>}>
        {loading ? <p className="muted">Loading…</p> : <EmptyState title="This project isn't in your list" description="You may not be a member of it any more." />}
      </Page>
    );
  }
  return <ProjectDetail p={project} ctx={ctx} onBack={onBack} />;
}

function ProjectDetail({ p, ctx, onBack }: { p: ProjectInfo; ctx: LocalContext; onBack: () => void }) {
  const { employee } = usePortal();
  const tickets = useTickets();
  const navigate = useNavigate();
  const actor = { id: employee.id, name: employee.fullName };
  const today = todayISO();
  const [msg, setMsg] = useState<Msg>(null);
  const [openMilestone, setOpenMilestone] = useState<PMilestone | "new" | null>(null);
  const [openTask, setOpenTask] = useState<PTask | "new" | null>(null);
  const [openMember, setOpenMember] = useState<PMember | null>(null);
  const [editAbout, setEditAbout] = useState(false);
  const [adding, setAdding] = useState(false);
  const [taskFilter, setTaskFilter] = useState<"mine" | "all" | "open">("mine");
  const [tab, setTab] = useState<DetailTab>("overview");

  const health = healthOf(p, today);
  const done = completionOf(p);
  const used = usedPct(p);
  const remaining = p.budgetHours != null ? p.budgetHours - p.loggedHours : null;
  const next = nextMilestone(p);
  const alerts = deadlineAlerts(p, ctx.viewerId, today);
  const myTickets = ticketsAssignedTo(employee.id, tickets).filter((t) => t.projectId === p.id || t.projectName === p.name);
  const tasks = p.tasks
    .filter((t) => (taskFilter === "mine" ? t.assigneeId === ctx.viewerId : taskFilter === "open" ? t.status !== "done" : true))
    .sort((a, b) => Number(a.status === "done") - Number(b.status === "done") || PRIORITY_RANK[a.priority ?? "medium"] - PRIORITY_RANK[b.priority ?? "medium"] || (a.due ?? "9999").localeCompare(b.due ?? "9999"));
  const allocated = p.members.reduce((a, m) => a + (m.allocationPct ?? 0), 0);
  const logTime = (taskId?: string) => navigate(`/timesheet?project=${encodeURIComponent(p.id)}${taskId ? `&ptask=${encodeURIComponent(taskId)}` : ""}`);
  const result = (error: string | null, ok: string) => {
    setMsg(error ? { tone: "err", text: error } : { tone: "ok", text: ok });
    return error;
  };

  return (
    <Page
      title={p.name}
      subtitle={[p.code, p.client].filter(Boolean).join(" · ")}
      action={
        <div className="row-gap">
          {p.active && (
            <button type="button" className="btn" onClick={() => logTime()}>
              Log time
            </button>
          )}
          <button type="button" className="btn-ghost" onClick={onBack}>
            All projects
          </button>
        </div>
      }
    >
      {alerts.length > 0 && (
        <ul className="project-alerts" aria-label="Deadline alerts">
          {alerts.map((a) => (
            <li key={a.text} className={a.tone}>
              {a.text}
            </li>
          ))}
        </ul>
      )}
      <Banner message={msg} />
      <div className="ws-proj-hero">
        <div className="ws-proj-hero-main">
          <span className="row-gap">
            <StatusBadge status={health} tone={HEALTH_TONE[health]} literal />
            {p.status !== "active" && <StatusBadge status={PROJECT_STATUS_LABEL[p.status]} tone="neutral" literal />}
            <span className="muted">{p.start ? `${formatShortDate(p.start)} – ${p.end ? formatShortDate(p.end) : "ongoing"}` : p.end ? `Ends ${formatShortDate(p.end)}` : "Ongoing"}</span>
          </span>
          <div className="ws-proj-hero-progress">
            <Progress value={done.pct} label={`${done.pct}% complete`} />
            <strong>{done.pct}%</strong>
          </div>
          <MilestoneTrack milestones={p.milestones} today={today} />
        </div>
        <dl className="ws-proj-hero-facts">
          <div>
            <dt>My role</dt>
            <dd>{p.myTitle || "Member"}</dd>
          </div>
          <div>
            <dt>My hours</dt>
            <dd>
              {h(p.myLoggedHours)}
              {p.myBudgetHours ? ` of ${p.myBudgetHours} h` : ""}
            </dd>
          </div>
          <div>
            <dt>Manager</dt>
            <dd>{p.managerName || "—"}</dd>
          </div>
          <div>
            <dt>Team</dt>
            <dd>
              <AvatarStack members={p.members} max={7} />
            </dd>
          </div>
        </dl>
      </div>
      <MetricGrid>
        <MetricCard label="Completion" value={`${done.pct}%`} hint={done.basis} />
        <MetricCard label="Hours used" value={h(p.loggedHours)} hint={p.budgetHours ? `${used}% of the ${p.budgetHours} h budget · mine ${h(p.myLoggedHours)}` : `Mine ${h(p.myLoggedHours)}`} />
        <MetricCard label="Approved hours" value={h(p.approvedHours)} hint={`Mine ${h(p.myApprovedHours)}`} />
        <MetricCard label="Budget left" value={remaining == null ? "No budget" : remaining < 0 ? `−${h(-remaining)}` : h(remaining)} hint={remaining != null && remaining < 0 ? "Over budget" : undefined} />
        <MetricCard label="Next milestone" value={next ? formatShortDate(next.due) : "—"} hint={next?.name ?? "All milestones done"} />
      </MetricGrid>

      <Tabs
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "tasks", label: `Tasks (${p.tasks.filter((t) => t.status !== "done").length})` },
          { id: "team", label: `Team (${p.members.length})` },
          { id: "hours", label: "Hours and reports" },
          { id: "updates", label: "Updates and files" },
        ]}
        value={tab}
        onChange={(id) => setTab(id as DetailTab)}
      />

      {tab === "overview" && (
      <>
      <div className="split">
        <Card
          title="About"
          className="ws-proj-about"
          action={
            p.canEdit ? (
              <button type="button" className="btn-ghost btn-tiny" onClick={() => setEditAbout(true)}>
                Edit
              </button>
            ) : undefined
          }
        >
          {p.description ? <p style={{ marginTop: 0 }}>{p.description}</p> : <p className="muted">No description yet.</p>}
          <dl className="meta">
            <dt>Client</dt>
            <dd>{p.client || "—"}</dd>
            <dt>Status</dt>
            <dd>{PROJECT_STATUS_LABEL[p.status]}</dd>
            <dt>Health</dt>
            <dd>
              <StatusBadge status={health} tone={HEALTH_TONE[health]} literal />
              {p.healthCall ? <span className="muted"> · set by the manager</span> : null}
            </dd>
            <dt>Hours budget</dt>
            <dd>{p.budgetHours != null ? `${p.budgetHours} h` : "—"}</dd>
            <dt>Start</dt>
            <dd>{p.start ? formatShortDate(p.start) : "—"}</dd>
            <dt>End</dt>
            <dd>{p.end ? formatShortDate(p.end) : "Ongoing"}</dd>
            <dt>Manager</dt>
            <dd>{p.managerName || "—"}</dd>
            <dt>My role</dt>
            <dd>{p.myTitle || "Member"}</dd>
            {p.myResponsibilities && (
              <>
                <dt>I look after</dt>
                <dd>{p.myResponsibilities}</dd>
              </>
            )}
          </dl>
        </Card>

        <Card title="Completion and hours">
          <div className="project-twin">
            <div>
              <span className="project-card-metric">
                <span>Completion (work done)</span>
                <strong>{done.pct}%</strong>
              </span>
              <Progress value={done.pct} label={`${done.pct}% complete`} />
              <p className="muted">{done.basis}</p>
            </div>
            <div>
              <span className="project-card-metric">
                <span>Hours used vs budget</span>
                <strong>{p.budgetHours ? `${used}%` : "No budget"}</strong>
              </span>
              {p.budgetHours ? <Progress value={used} label={`${used}% of the hours budget used`} tone={used > 100 ? "danger" : used > done.pct + 20 ? "warn" : undefined} /> : null}
              <p className="muted">
                {h(p.loggedHours)} logged{p.budgetHours ? ` of ${p.budgetHours} h` : ""} · {h(p.approvedHours)} approved
                {used > done.pct + 20 && p.budgetHours ? " · hours are running ahead of the work done" : ""}
              </p>
            </div>
            {p.myBudgetHours ? (
              <div>
                <span className="project-card-metric">
                  <span>My hours vs my budget</span>
                  <strong>
                    {h(p.myLoggedHours)} of {p.myBudgetHours} h
                  </strong>
                </span>
                <Progress value={Math.round((p.myLoggedHours / p.myBudgetHours) * 100)} label="My hours used" />
              </div>
            ) : null}
          </div>
        </Card>
      </div>

      <div className="split">
        <Card
          title="Milestones"
          action={
            p.canEdit ? (
              <button type="button" className="btn-ghost btn-tiny" onClick={() => setOpenMilestone("new")}>
                Add milestone
              </button>
            ) : undefined
          }
        >
          {p.milestones.length === 0 ? (
            <p className="muted">No milestones.</p>
          ) : (
            <ul className="project-milestones">
              {p.milestones.map((m) => {
                const late = !m.completedOn && m.due < today;
                const prog = milestoneProgress(p, m);
                return (
                  <li key={m.id} className={m.completedOn ? "done" : late ? "late" : undefined}>
                    <span aria-hidden>{m.completedOn ? "✓" : "○"}</span>
                    <button type="button" className="link-btn" onClick={() => setOpenMilestone(m)}>
                      {m.name}
                    </button>
                    <span className="muted">
                      {formatShortDate(m.due)}
                      {late ? " · overdue" : m.completedOn ? " · done" : ""}
                    </span>
                    <span className="pj-ms-progress">
                      <Progress value={prog.pct} label={`${prog.pct}% of its tasks done`} tone={late ? "danger" : undefined} />
                      <span className="muted">{prog.total ? `${prog.done}/${prog.total} tasks · ${prog.pct}%` : m.completedOn ? "100%" : "No tasks"}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card title="Recent activity">
          {p.activity.length === 0 ? (
            <p className="muted">No activity yet.</p>
          ) : (
            <ul className="project-activity">
              {p.activity.slice(0, 10).map((a) => (
                <li key={a.id}>
                  <span className="muted">{formatShortDate(a.on)}</span>
                  <span>
                    <strong>{a.who}</strong> {a.text}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      </>
      )}

      {tab === "team" && (
        <Card
          title={`Team · ${p.members.length}`}
          action={
            p.canEdit ? (
              <button type="button" className="btn-ghost btn-tiny" onClick={() => setAdding(true)}>
                Add member
              </button>
            ) : undefined
          }
        >
          {p.members.length === 0 ? (
            <p className="muted">No team listed.</p>
          ) : (
            <div className="table-scroll">
              <table className="data pj-team-table">
                <thead>
                  <tr>
                    <th>Person</th>
                    <th>Role</th>
                    <th>Allocation</th>
                    <th>Hours</th>
                    <th>Open tasks</th>
                  </tr>
                </thead>
                <tbody>
                  {p.members.map((m) => {
                    const over = !!m.budgetHours && m.loggedHours > m.budgetHours;
                    return (
                      <tr key={m.employeeId}>
                        <td>
                          <span className="pj-person">
                            <PersonAvatar id={m.employeeId} name={m.name} size={28} />
                            <button type="button" className="link-btn" onClick={() => setOpenMember(m)}>
                              {m.name}
                              {m.employeeId === ctx.viewerId ? " (you)" : ""}
                            </button>
                          </span>
                        </td>
                        <td>
                          {m.title || (m.role === "lead" ? "Lead" : "Member")}
                          {m.employeeId === p.managerId && !/manager/i.test(m.title ?? "") ? <span className="muted"> · manager</span> : null}
                        </td>
                        <td>{m.allocationPct != null ? `${m.allocationPct}%` : "—"}</td>
                        <td className={over ? "pj-over" : undefined}>
                          {h(m.loggedHours)}
                          {m.budgetHours ? ` / ${m.budgetHours} h` : ""}
                        </td>
                        <td>{p.tasks.filter((t) => t.assigneeId === m.employeeId && t.status !== "done").length}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {allocated > 0 && <p className="muted pj-foot">Planned capacity: {Math.round((allocated / 100) * 40)} h a week ({allocated}% across the team, 40 h weeks).</p>}
        </Card>
      )}

      {tab === "hours" && <ReportPanel p={p} onDone={result} />}

      {tab === "tasks" && (
      <Card
        title="Tasks"
        action={
          <div className="row-gap">
            <select aria-label="Which tasks" value={taskFilter} onChange={(e) => setTaskFilter(e.target.value as typeof taskFilter)}>
              <option value="mine">Assigned to me</option>
              <option value="open">All open</option>
              <option value="all">All</option>
            </select>
            {p.canEdit && (
              <button type="button" className="btn-ghost btn-tiny" onClick={() => setOpenTask("new")}>
                Add task
              </button>
            )}
          </div>
        }
      >
        {tasks.length + (taskFilter === "mine" ? myTickets.length : 0) === 0 ? (
          <p className="muted">{taskFilter === "mine" ? "Nothing assigned to you on this project." : "No tasks."}</p>
        ) : (
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Priority</th>
                  <th>Assignee</th>
                  <th>Due</th>
                  <th>Estimate</th>
                  <th>Logged</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <button type="button" className="link-btn" onClick={() => setOpenTask(t)}>
                        {t.code} {t.title}
                      </button>
                    </td>
                    <td>
                      <span className={`pj-prio ${t.priority ?? "medium"}`}>{t.priority ?? "medium"}</span>
                    </td>
                    <td>{t.assigneeName ?? "—"}</td>
                    <td>
                      {t.due ? formatShortDate(t.due) : "—"}
                      {t.status !== "done" && t.due && t.due < today ? <span className="project-overdue"> · overdue</span> : null}
                    </td>
                    <td>{t.estimate} h</td>
                    <td>{h(t.loggedHours)}</td>
                    <td>
                      <StatusBadge status={TASK_STATUS_LABEL[t.status]} tone={STATUS_TONE[t.status]} literal />
                    </td>
                  </tr>
                ))}
                {taskFilter === "mine" &&
                  myTickets.map((t) => (
                    <tr key={t.id}>
                      <td>
                        <Link to={`/tickets?id=${t.id}`}>
                          {t.id} {t.title}
                        </Link>
                      </td>
                      <td>
                        <span className={`pj-prio ${t.priority}`}>{t.priority}</span>
                      </td>
                      <td>You (ticket)</td>
                      <td>{t.due ? formatShortDate(t.due) : "—"}</td>
                      <td>—</td>
                      <td>—</td>
                      <td>
                        <StatusBadge status={t.status} literal />
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      )}

      {tab === "updates" && (
        <div className="split">
          <PostsCard p={p} actorId={actor.id} onDone={result} actor={actor} />
          <DocumentsCard p={p} actor={actor} onDone={result} />
        </div>
      )}

      {editAbout && <AboutDialog p={p} actor={actor} onClose={() => setEditAbout(false)} onDone={result} />}
      {openMilestone && <MilestoneDialog p={p} actor={actor} milestone={openMilestone === "new" ? null : openMilestone} onClose={() => setOpenMilestone(null)} onDone={result} />}
      {openTask && (
        <TaskDialog
          p={p}
          actor={actor}
          task={openTask === "new" ? null : p.tasks.find((t) => t.id === openTask.id) ?? openTask}
          onClose={() => setOpenTask(null)}
          onDone={result}
          onLogTime={(taskId) => logTime(taskId)}
        />
      )}
      {openMember && <MemberDialog p={p} actor={actor} member={openMember} onClose={() => setOpenMember(null)} onDone={result} />}
      {adding && <AddMemberDialog p={p} actor={actor} onClose={() => setAdding(false)} onDone={result} />}
    </Page>
  );
}

type Done = (error: string | null, ok: string) => string | null;
type Actor = { id: string; name: string };

function AboutDialog({ p, actor, onClose, onDone }: { p: ProjectInfo; actor: Actor; onClose: () => void; onDone: Done }) {
  const [form, setForm] = useState({
    description: p.description,
    client: p.client === "Internal" ? "" : p.client,
    start: p.start,
    end: p.end,
    budget: p.budgetHours == null ? "" : String(p.budgetHours),
    status: p.status,
    health: (p.healthCall ?? "") as HealthCall | "",
  });
  const [err, setErr] = useState<string | null>(null);
  return (
    <Dialog
      open
      title={`Edit ${p.name}`}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <ActionButton
            className="btn"
            success="Project saved."
            onAction={async () => {
              const error = await saveProject(p, actor, {
                description: form.description,
                start: form.start,
                end: form.end,
                budgetHours: form.budget === "" ? null : Number(form.budget),
                client: form.client,
                status: form.status,
                healthCall: form.health || null,
              });
              setErr(error);
              if (!error) {
                onDone(null, "Project details saved.");
                onClose();
              }
              return error;
            }}
          >
            Save
          </ActionButton>
        </>
      }
    >
      <div className="stack">
        <Field label="Description">
          <textarea rows={3} value={form.description} maxLength={4000} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </Field>
        <div className="form-grid-2">
          <Field label="Start">
            <input type="date" value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} />
          </Field>
          <Field label="End (deadline)">
            <input type="date" value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} />
          </Field>
          <Field label="Hours budget">
            <input type="number" min={0} step={1} value={form.budget} onChange={(e) => setForm({ ...form, budget: e.target.value })} />
          </Field>
          <Field label="Client">
            <input value={form.client} maxLength={200} placeholder="Internal" onChange={(e) => setForm({ ...form, client: e.target.value })} />
          </Field>
          <Field label="Status">
            <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as ProjectStatus })}>
              {(Object.keys(PROJECT_STATUS_LABEL) as ProjectStatus[]).map((st) => (
                <option key={st} value={st}>
                  {PROJECT_STATUS_LABEL[st]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Health">
            <select value={form.health} onChange={(e) => setForm({ ...form, health: e.target.value as HealthCall | "" })}>
              <option value="">Automatic (dates and hours)</option>
              {(Object.keys(HEALTH_CALL_LABEL) as HealthCall[]).map((hc) => (
                <option key={hc} value={hc}>
                  {HEALTH_CALL_LABEL[hc]}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {err && <p className="note warn">{err}</p>}
      </div>
    </Dialog>
  );
}

function MilestoneDialog({ p, actor, milestone, onClose, onDone }: { p: ProjectInfo; actor: Actor; milestone: PMilestone | null; onClose: () => void; onDone: Done }) {
  const today = todayISO();
  const [editing, setEditing] = useState(milestone === null);
  const [form, setForm] = useState({ name: milestone?.name ?? "", description: milestone?.description ?? "", due: milestone?.due ?? "", completed: !!milestone?.completedOn });
  const [err, setErr] = useState<string | null>(null);
  const linked = milestone ? p.tasks.filter((t) => t.milestoneId === milestone.id) : [];
  const daysLeft = milestone ? Math.round((Date.parse(milestone.due) - Date.parse(today)) / 86_400_000) : 0;
  const save = async (completed = form.completed) => {
    const error = await saveMilestone(p, actor, milestone?.id ?? null, { ...form, completed });
    setErr(error);
    if (!error) {
      onDone(null, milestone ? (completed && !milestone.completedOn ? `“${form.name}” marked complete.` : "Milestone saved.") : "Milestone added.");
      onClose();
    }
    return error;
  };
  return (
    <Dialog
      open
      title={milestone ? milestone.name : "Add milestone"}
      onClose={onClose}
      actions={
        p.canEdit ? (
          editing ? (
            <>
              <button type="button" className="btn-ghost" onClick={milestone ? () => setEditing(false) : onClose}>
                Cancel
              </button>
              <ActionButton className="btn" success={milestone ? "Milestone saved." : "Milestone added."} onAction={() => save()}>
                {milestone ? "Save" : "Add milestone"}
              </ActionButton>
            </>
          ) : (
            <>
              <ActionButton
                className="btn-ghost"
                success="Milestone removed."
                onAction={async () => {
                  if (!milestone || !window.confirm(`Remove the milestone “${milestone.name}”?`)) return false;
                  const error = await deleteMilestone(p, actor, milestone.id);
                  setErr(error);
                  if (!error) {
                    onDone(null, "Milestone removed.");
                    onClose();
                  }
                  return error;
                }}
              >
                Remove
              </ActionButton>
              <button type="button" className="btn-ghost" onClick={() => setEditing(true)}>
                Edit
              </button>
              <ActionButton className="btn" success={milestone?.completedOn ? "Milestone reopened." : "Milestone completed."} onAction={() => save(!milestone?.completedOn)}>
                {milestone?.completedOn ? "Reopen" : "Mark complete"}
              </ActionButton>
            </>
          )
        ) : (
          <button type="button" className="btn-ghost" onClick={onClose}>
            Close
          </button>
        )
      }
    >
      {editing ? (
        <div className="stack">
          <Field label="Name">
            <input value={form.name} maxLength={200} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Details">
            <textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </Field>
          <Field label="Due date">
            <input type="date" value={form.due} onChange={(e) => setForm({ ...form, due: e.target.value })} />
          </Field>
          <label className="check-row">
            <input type="checkbox" checked={form.completed} onChange={(e) => setForm({ ...form, completed: e.target.checked })} /> Completed
          </label>
        </div>
      ) : milestone ? (
        <dl className="meta">
          <dt>Details</dt>
          <dd>{milestone.description || "—"}</dd>
          <dt>Due</dt>
          <dd>{formatShortDate(milestone.due)}</dd>
          <dt>Completion</dt>
          <dd>
            {milestone.completedOn ? (
              <StatusBadge status={`Done ${formatShortDate(milestone.completedOn)}`} tone="ok" literal keepCase />
            ) : daysLeft < 0 ? (
              <StatusBadge status={`Overdue by ${-daysLeft} days`} tone="danger" literal keepCase />
            ) : (
              <StatusBadge status={daysLeft === 0 ? "Due today" : `${daysLeft} days left`} tone={daysLeft <= 7 ? "warn" : "info"} literal keepCase />
            )}
          </dd>
          <dt>Progress</dt>
          <dd>{milestoneProgress(p, milestone).pct}% from its tasks</dd>
          <dt>Tasks</dt>
          <dd>{linked.length ? linked.map((t) => `${t.code} (${TASK_STATUS_LABEL[t.status]})`).join(", ") : "None linked"}</dd>
        </dl>
      ) : null}
      {err && <p className="note warn">{err}</p>}
    </Dialog>
  );
}

function TaskDialog({
  p,
  actor,
  task,
  onClose,
  onDone,
  onLogTime,
}: {
  p: ProjectInfo;
  actor: Actor;
  task: PTask | null;
  onClose: () => void;
  onDone: Done;
  onLogTime: (taskId: string) => void;
}) {
  const [editing, setEditing] = useState(task === null);
  const [form, setForm] = useState({
    title: task?.title ?? "",
    description: task?.description ?? "",
    assigneeId: task?.assigneeId ?? "",
    milestoneId: task?.milestoneId ?? "",
    due: task?.due ?? "",
    estimate: String(task?.estimate ?? 0),
    status: (task?.status ?? "todo") as TaskStatus,
    priority: (task?.priority ?? "medium") as TaskPriority,
  });
  const [status, setStatus] = useState<TaskStatus>(task?.status ?? "todo");
  const [err, setErr] = useState<string | null>(null);
  const mineToMove = !!task && (task.assigneeId === actor.id || p.canEdit);
  const realMembers = p.members.filter((m) => !m.employeeId.startsWith("name:"));
  const today = todayISO();
  const finish = (error: string | null, ok: string) => {
    setErr(error);
    if (!error) {
      onDone(null, ok);
      onClose();
    }
    return error;
  };
  return (
    <Dialog
      open
      title={task ? `${task.code} ${task.title}` : "Add task"}
      onClose={onClose}
      actions={
        editing ? (
          <>
            <button type="button" className="btn-ghost" onClick={task ? () => setEditing(false) : onClose}>
              Cancel
            </button>
            <ActionButton
              className="btn"
              success={task ? "Task saved." : "Task added."}
              onAction={async () =>
                finish(await saveTask(p, actor, task?.id ?? null, { ...form, estimate: Number(form.estimate) }), task ? "Task saved." : "Task added.")
              }
            >
              {task ? "Save" : "Add task"}
            </ActionButton>
          </>
        ) : (
          <>
            {p.canEdit && task && (
              <>
                <ActionButton
                  className="btn-ghost"
                  success="Task removed."
                  onAction={async () => {
                    if (!window.confirm(`Remove ${task.code}?`)) return false;
                    return finish(await deleteTask(p, actor, task.id), "Task removed.");
                  }}
                >
                  Remove
                </ActionButton>
                <button type="button" className="btn-ghost" onClick={() => setEditing(true)}>
                  Edit
                </button>
              </>
            )}
            {task && p.active && task.status !== "done" && task.assigneeId === actor.id && (
              <button type="button" className="btn-ghost" onClick={() => onLogTime(task.id)}>
                Log time
              </button>
            )}
            {mineToMove && (
              <ActionButton
                className="btn"
                disabled={status === task?.status}
                success="Status updated."
                onAction={async () => finish(await setTaskStatus(p, actor, task!.id, status), `${task!.code} is now ${TASK_STATUS_LABEL[status].toLowerCase()}.`)}
              >
                Update status
              </ActionButton>
            )}
            {!mineToMove && (
              <button type="button" className="btn-ghost" onClick={onClose}>
                Close
              </button>
            )}
          </>
        )
      }
    >
      {editing ? (
        <div className="stack">
          <Field label="Title">
            <input value={form.title} maxLength={200} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </Field>
          <Field label="Description">
            <textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </Field>
          <div className="form-grid-2">
            <Field label="Assignee">
              <select value={form.assigneeId} onChange={(e) => setForm({ ...form, assigneeId: e.target.value })}>
                <option value="">Unassigned</option>
                {realMembers.map((m) => (
                  <option key={m.employeeId} value={m.employeeId}>
                    {m.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Milestone">
              <select value={form.milestoneId} onChange={(e) => setForm({ ...form, milestoneId: e.target.value })}>
                <option value="">None</option>
                {p.milestones.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Deadline">
              <input type="date" value={form.due} onChange={(e) => setForm({ ...form, due: e.target.value })} />
            </Field>
            <Field label="Estimated hours">
              <input type="number" min={0} step={0.5} value={form.estimate} onChange={(e) => setForm({ ...form, estimate: e.target.value })} />
            </Field>
            <Field label="Priority">
              <select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value as TaskPriority })}>
                {TASK_PRIORITIES.map((pr) => (
                  <option key={pr} value={pr}>
                    {pr[0].toUpperCase() + pr.slice(1)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Status">
              <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as TaskStatus })}>
                {(Object.keys(TASK_STATUS_LABEL) as TaskStatus[]).map((s) => (
                  <option key={s} value={s}>
                    {TASK_STATUS_LABEL[s]}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </div>
      ) : task ? (
        <div className="stack">
          <p style={{ margin: 0 }}>{task.description || <span className="muted">No description.</span>}</p>
          <dl className="meta">
            <dt>Assignee</dt>
            <dd>{task.assigneeName ?? "Unassigned"}</dd>
            <dt>Priority</dt>
            <dd>
              <span className={`pj-prio ${task.priority ?? "medium"}`}>{task.priority ?? "medium"}</span>
            </dd>
            <dt>Deadline</dt>
            <dd>
              {task.due ? formatShortDate(task.due) : "—"}
              {task.due && task.status !== "done" && task.due < today ? <span className="project-overdue"> · overdue</span> : null}
            </dd>
            <dt>Estimated</dt>
            <dd>{task.estimate} h</dd>
            <dt>Logged</dt>
            <dd>{h(task.loggedHours)}</dd>
            <dt>Milestone</dt>
            <dd>{p.milestones.find((m) => m.id === task.milestoneId)?.name ?? "—"}</dd>
            <dt>Status</dt>
            <dd>
              {mineToMove ? (
                <select aria-label="Task status" value={status} onChange={(e) => setStatus(e.target.value as TaskStatus)}>
                  {(Object.keys(TASK_STATUS_LABEL) as TaskStatus[]).map((s) => (
                    <option key={s} value={s}>
                      {TASK_STATUS_LABEL[s]}
                    </option>
                  ))}
                </select>
              ) : (
                <StatusBadge status={TASK_STATUS_LABEL[task.status]} tone={STATUS_TONE[task.status]} literal />
              )}
            </dd>
          </dl>
          {!mineToMove && <p className="muted">Only {task.assigneeName ?? "the assignee"} or the project manager can change this task.</p>}
        </div>
      ) : null}
      {err && <p className="note warn">{err}</p>}
    </Dialog>
  );
}

function MemberDialog({ p, actor, member, onClose, onDone }: { p: ProjectInfo; actor: Actor; member: PMember; onClose: () => void; onDone: Done }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    title: member.title ?? "",
    responsibilities: member.responsibilities ?? "",
    budget: member.budgetHours == null ? "" : String(member.budgetHours),
    allocation: member.allocationPct == null ? "" : String(member.allocationPct),
    role: (member.role === "lead" ? "lead" : "member") as "member" | "lead",
  });
  const [err, setErr] = useState<string | null>(null);
  const theirTasks = p.tasks.filter((t) => t.assigneeId === member.employeeId);
  const editable = p.canEdit && !member.employeeId.startsWith("name:");
  return (
    <Dialog
      open
      title={member.name}
      onClose={onClose}
      actions={
        editing ? (
          <>
            <button type="button" className="btn-ghost" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <ActionButton
              className="btn"
              success="Role saved."
              onAction={async () => {
                const error = await saveMember(p, actor, member.employeeId, {
                  title: form.title,
                  responsibilities: form.responsibilities,
                  budgetHours: form.budget === "" ? null : Number(form.budget),
                  allocationPct: form.allocation === "" ? null : Number(form.allocation),
                  role: form.role,
                });
                setErr(error);
                if (!error) {
                  onDone(null, `${member.name}'s role saved.`);
                  onClose();
                }
                return error;
              }}
            >
              Save
            </ActionButton>
          </>
        ) : (
          <>
            {editable && member.employeeId !== p.managerId && (
              <ActionButton
                className="btn-ghost"
                success="Removed from the project."
                onAction={async () => {
                  const open = theirTasks.filter((t) => t.status !== "done").length;
                  if (!window.confirm(`Remove ${member.name} from ${p.name}?${open ? ` Their ${open} open task(s) become unassigned.` : ""}`)) return false;
                  const error = await removeMember(p, actor, member.employeeId);
                  setErr(error);
                  if (!error) {
                    onDone(null, `${member.name} removed from the project.`);
                    onClose();
                  }
                  return error;
                }}
              >
                Remove
              </ActionButton>
            )}
            {editable && (
              <button type="button" className="btn-ghost" onClick={() => setEditing(true)}>
                Edit role
              </button>
            )}
            <button type="button" className="btn-ghost" onClick={onClose}>
              Close
            </button>
          </>
        )
      }
    >
      {editing ? (
        <div className="stack">
          <Field label="Role on the project">
            <input value={form.title} maxLength={100} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </Field>
          <Field label="Responsibilities">
            <textarea rows={3} value={form.responsibilities} onChange={(e) => setForm({ ...form, responsibilities: e.target.value })} />
          </Field>
          <div className="form-grid-2">
            <Field label="Hours budget">
              <input type="number" min={0} value={form.budget} onChange={(e) => setForm({ ...form, budget: e.target.value })} />
            </Field>
            <Field label="Allocation (% of the week)">
              <input type="number" min={0} max={100} step={5} value={form.allocation} onChange={(e) => setForm({ ...form, allocation: e.target.value })} />
            </Field>
            {member.employeeId !== p.managerId && (
              <Field label="Access">
                <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as "member" | "lead" })}>
                  <option value="member">Member</option>
                  <option value="lead">Lead (can edit the project)</option>
                </select>
              </Field>
            )}
          </div>
        </div>
      ) : (
        <dl className="meta">
          <dt>Role</dt>
          <dd>{member.title || (member.role === "lead" ? "Project lead" : "Member")}</dd>
          <dt>Allocation</dt>
          <dd>{member.allocationPct != null ? `${member.allocationPct}% of the week` : "—"}</dd>
          <dt>Job title</dt>
          <dd>{member.jobTitle || "—"}</dd>
          <dt>Responsibilities</dt>
          <dd>{member.responsibilities || "—"}</dd>
          <dt>Hours</dt>
          <dd>
            {h(member.loggedHours)} logged{member.budgetHours ? ` of ${member.budgetHours} h budget` : ""}
          </dd>
          <dt>Tasks</dt>
          <dd>{theirTasks.length ? theirTasks.map((t) => `${t.code} (${TASK_STATUS_LABEL[t.status]})`).join(", ") : "None"}</dd>
        </dl>
      )}
      {err && <p className="note warn">{err}</p>}
    </Dialog>
  );
}

function PostsCard({ p, actor, onDone }: { p: ProjectInfo; actor: Actor; actorId: string; onDone: Done }) {
  const [kind, setKind] = useState<"comment" | "update">("comment");
  const [body, setBody] = useState("");
  return (
    <Card title="Updates and comments">
      <div className="stack">
        <textarea aria-label="Write an update or comment" rows={2} maxLength={4000} placeholder={kind === "update" ? "Status update for the team" : "Add a comment"} value={body} onChange={(e) => setBody(e.target.value)} />
        <div className="row-gap">
          {p.canEdit && (
            <select aria-label="Post type" value={kind} onChange={(e) => setKind(e.target.value as "comment" | "update")}>
              <option value="comment">Comment</option>
              <option value="update">Status update (tells the team)</option>
            </select>
          )}
          <ActionButton
            className="btn btn-tiny"
            disabled={!body.trim()}
            success={kind === "update" ? "Update posted. The team was notified." : "Comment posted."}
            onAction={async () => {
              const error = await addPost(p, actor, kind, body);
              onDone(error, kind === "update" ? "Update posted." : "Comment posted.");
              if (!error) setBody("");
              return error;
            }}
          >
            Post
          </ActionButton>
        </div>
        {p.posts.length === 0 ? (
          <p className="muted">No updates yet.</p>
        ) : (
          <ul className="project-posts">
            {p.posts.slice(0, 20).map((post) => (
              <li key={post.id} className={post.kind}>
                <div className="row-between">
                  <span>
                    <strong>{post.authorName}</strong> <span className="muted">{post.kind === "update" ? "status update" : "comment"} · {formatShortDate(post.at.slice(0, 10))}</span>
                  </span>
                  {(post.authorId === actor.id || p.canEdit) && (
                    <ActionButton
                      className="btn-ghost btn-tiny"
                      success="Removed."
                      onAction={async () => {
                        if (!window.confirm("Delete this post?")) return false;
                        const error = await deletePost(p, actor, post.id);
                        onDone(error, "Post deleted.");
                        return error;
                      }}
                    >
                      Delete
                    </ActionButton>
                  )}
                </div>
                <p>{post.body}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

function DocumentsCard({ p, actor, onDone }: { p: ProjectInfo; actor: Actor; onDone: Done }) {
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [fileKey, setFileKey] = useState(0);
  const size = (n?: number | null) => (n ? (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`) : "");
  let row: ReactNode = null;
  if (p.documents.length) {
    row = (
      <ul className="project-docs">
        {p.documents.map((d) => (
          <li key={d.id}>
            <span>
              <button
                type="button"
                className="link-btn"
                onClick={async () => {
                  const error = await openDocument(p, d);
                  if (error) onDone(error, "");
                }}
              >
                {d.title}
              </button>
              <span className="muted">
                {" "}
                {d.url ? "link" : [d.fileName, size(d.size)].filter(Boolean).join(" · ")} · {d.addedByName} · {formatShortDate(d.at.slice(0, 10))}
              </span>
            </span>
            {(d.addedBy === actor.id || p.canEdit) && (
              <ActionButton
                className="btn-ghost btn-tiny"
                success="Document removed."
                onAction={async () => {
                  if (!window.confirm(`Remove “${d.title}”?`)) return false;
                  const error = await deleteDocument(p, actor, d.id);
                  onDone(error, "Document removed.");
                  return error;
                }}
              >
                Remove
              </ActionButton>
            )}
          </li>
        ))}
      </ul>
    );
  }
  return (
    <Card title={`Documents · ${p.documents.length}`}>
      <div className="stack">
        {row ?? <p className="muted">No documents yet.</p>}
        <div className="form-grid-2">
          <Field label="Title">
            <input value={title} maxLength={200} placeholder="e.g. Release plan" onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="Link (or choose a file)">
            <input value={url} maxLength={500} placeholder="https://…" onChange={(e) => setUrl(e.target.value)} />
          </Field>
        </div>
        <div className="row-gap">
          <input key={fileKey} type="file" aria-label="Choose a file" accept="application/pdf,image/png,image/jpeg,image/webp,image/gif" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <ActionButton
            className="btn btn-tiny"
            disabled={!file && !url.trim()}
            success="Document added."
            onAction={async () => {
              const error = file ? await uploadDocument(p, actor, file, title) : await addLink(p, actor, title, url);
              onDone(error, "Document added.");
              if (!error) {
                setTitle("");
                setUrl("");
                setFile(null);
                setFileKey((k) => k + 1);
              }
              return error;
            }}
          >
            {file ? "Upload" : "Add link"}
          </ActionButton>
        </div>
      </div>
    </Card>
  );
}

function AddMemberDialog({ p, actor, onClose, onDone }: { p: ProjectInfo; actor: Actor; onClose: () => void; onDone: Done }) {
  const people = usePeopleList();
  const onProject = new Set(p.members.map((m) => m.employeeId));
  const pool = people
    .filter((x) => !onProject.has(x.id) && x.employmentStatus !== "Terminated")
    .sort((a, b) => a.fullName.localeCompare(b.fullName));
  const [form, setForm] = useState({ id: "", title: "", allocation: "", budget: "", role: "member" as "member" | "lead" });
  const [err, setErr] = useState<string | null>(null);
  const person = pool.find((x) => x.id === form.id);
  return (
    <Dialog
      open
      title={`Add to ${p.name}`}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <ActionButton
            className="btn"
            disabled={!person}
            success="Added."
            onAction={async () => {
              if (!person) return "Pick someone to add.";
              const error = await addMember(p, actor, { id: person.id, name: person.fullName, jobTitle: person.designation }, {
                title: form.title,
                responsibilities: "",
                budgetHours: form.budget === "" ? null : Number(form.budget),
                allocationPct: form.allocation === "" ? null : Number(form.allocation),
                role: form.role,
              });
              setErr(error);
              if (!error) {
                onDone(null, `${person.fullName} added to the project.`);
                onClose();
              }
              return error;
            }}
          >
            Add member
          </ActionButton>
        </>
      }
    >
      <div className="stack">
        <Field label="Person">
          <select value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })}>
            <option value="">Pick someone…</option>
            {pool.map((x) => (
              <option key={x.id} value={x.id}>
                {x.fullName}
                {x.designation ? ` · ${x.designation}` : ""}
              </option>
            ))}
          </select>
        </Field>
        <div className="form-grid-2">
          <Field label="Role on the project">
            <input value={form.title} maxLength={100} placeholder="e.g. QA engineer" onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </Field>
          <Field label="Allocation (% of the week)">
            <input type="number" min={0} max={100} step={5} value={form.allocation} onChange={(e) => setForm({ ...form, allocation: e.target.value })} />
          </Field>
          <Field label="Hours budget">
            <input type="number" min={0} value={form.budget} onChange={(e) => setForm({ ...form, budget: e.target.value })} />
          </Field>
          <Field label="Access">
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as "member" | "lead" })}>
              <option value="member">Member</option>
              <option value="lead">Lead (can edit the project)</option>
            </select>
          </Field>
        </div>
        {err && <p className="note warn">{err}</p>}
      </div>
    </Dialog>
  );
}

/** Hours from timesheets: weekly bars, burn-down against the budget, hours by member and the task summary. */
function ReportPanel({ p, onDone }: { p: ProjectInfo; onDone: Done }) {
  const { report, error, loading } = useProjectReport(p);
  if (loading) return <p className="muted">Loading the report…</p>;
  if (error || !report) return <EmptyState title="The report could not load" description={error ?? undefined} />;
  const weeks = report.weeks.slice(-26);
  const recent = report.weeks.slice(-8);
  const label = (iso: string) => formatShortDate(iso).replace(/\s\d{4}$/, "");
  const budget = report.budgetHours;
  const usedPctNow = budget ? Math.round((report.logged / budget) * 100) : null;
  const statusLabels: Record<string, string> = TASK_STATUS_LABEL;
  return (
    <div className="stack">
      <div className="pj-report-head">
        <MetricGrid>
          <MetricCard label="Logged" value={h(report.logged)} hint={budget ? `${usedPctNow}% of ${budget} h` : "No budget set"} />
          <MetricCard label="Approved" value={h(report.approved)} hint={report.logged ? `${Math.round((report.approved / report.logged) * 100)}% of logged` : undefined} />
          <MetricCard label="Billable" value={h(report.billable)} />
          <MetricCard label="Work done" value={`${report.progressPct}%`} hint={`${report.tasks.byStatus.done ?? 0} of ${report.tasks.total} tasks`} />
        </MetricGrid>
        <ActionButton
          className="btn-ghost"
          success="Report downloaded."
          onAction={async () => {
            const err = await exportProjectCsv(p, report);
            if (err) onDone(err, "");
            return err;
          }}
        >
          Export CSV
        </ActionButton>
      </div>
      <div className="split">
        <Card title="Hours by week">
          {recent.length ? (
            <BarChart
              ariaLabel="Hours logged each week"
              unit=" h"
              data={recent.map((w) => ({ label: label(w.weekStart), title: `Week of ${formatShortDate(w.weekStart)}`, value: w.hours, note: `${h(w.approved)} approved` }))}
            />
          ) : (
            <p className="muted">Weekly hours appear here once time is logged (connected to the server).</p>
          )}
        </Card>
        <Card title="Burn-down" className="pj-burn">
          {budget && weeks.length ? (
            <LineChart
              ariaLabel="Budget hours left against plan"
              labels={weeks.map((w) => label(w.weekStart))}
              labelEvery={Math.max(1, Math.ceil(weeks.length / 6))}
              series={[
                { name: "Hours left", values: weeks.map((w) => Math.max(0, w.remaining ?? 0)) },
                ...(weeks.some((w) => w.idealRemaining != null) ? [{ name: "Plan", values: weeks.map((w) => Math.max(0, w.idealRemaining ?? 0)), dashed: true }] : []),
              ]}
            />
          ) : (
            <p className="muted">{budget ? "No hours logged yet." : "Set an hours budget to see the burn-down."}</p>
          )}
        </Card>
      </div>
      <div className="split">
        <Card title={report.fullTeam ? "Hours by member" : "My hours"}>
          {report.members.length ? (
            <HBarChart ariaLabel="Hours by member" unit=" h" data={report.members.map((m) => ({ label: m.name, value: m.hours, note: m.budgetHours ? `budget ${m.budgetHours} h` : undefined }))} />
          ) : (
            <p className="muted">No hours logged.</p>
          )}
          {report.fullTeam && report.members.length > 0 && (
            <div className="table-scroll">
              <table className="data pj-hours-table">
                <thead>
                  <tr>
                    <th>Member</th>
                    <th>Allocation</th>
                    <th>Logged</th>
                    <th>Approved</th>
                    <th>Budget</th>
                  </tr>
                </thead>
                <tbody>
                  {report.members.map((m) => (
                    <tr key={m.employeeId}>
                      <td>{m.name}</td>
                      <td>{m.allocationPct != null ? `${m.allocationPct}%` : "—"}</td>
                      <td className={m.budgetHours && m.hours > m.budgetHours ? "pj-over" : undefined}>{h(m.hours)}</td>
                      <td>{h(m.approved)}</td>
                      <td>{m.budgetHours != null ? `${m.budgetHours} h` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card title="Tasks">
          <HBarChart
            ariaLabel="Tasks by status"
            max={Math.max(1, report.tasks.total)}
            data={Object.entries(report.tasks.byStatus).map(([k, v]) => ({ label: statusLabels[k] ?? k, value: v }))}
          />
          <dl className="meta">
            <dt>Overdue</dt>
            <dd className={report.tasks.overdue ? "pj-over" : undefined}>{report.tasks.overdue}</dd>
            <dt>Estimated</dt>
            <dd>{h(report.tasks.estimate)}</dd>
            <dt>Logged on tasks</dt>
            <dd>{h(report.tasks.loggedOnTasks)}</dd>
          </dl>
        </Card>
      </div>
    </div>
  );
}
