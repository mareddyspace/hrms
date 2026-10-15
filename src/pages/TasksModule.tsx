import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Banner,
  Card,
  EmptyState,
  FilterBar,
  MetricCard,
  MetricGrid,
  Page,
  StatusBadge,
  StatusPill,
} from "../components/ui.tsx";
import {
  ensureTaskExtras,
  isTaskBlocked,
  isTaskDueSoon,
  isTaskOverdue,
  nextTaskActionHint,
  taskProgress,
  taskStatusLabel,
} from "../data/taskHelpers.ts";
import { TASK_TEAM, taskPersonLabel } from "../data/taskTeam.ts";
import { ProgressBar } from "./dashboards/widgets.tsx";
import {
  formatShortDate,
  formatStamp,
  parseISODate,
  toISO,
  todayISO,
  type Task,
  type TaskPriority,
  type TaskStatus,
} from "../model.ts";
import { DEMO_ACCOUNTS } from "../seed.ts";
import { usePortal } from "../store.tsx";

type TaskTab = "dashboard" | "open" | "mine" | "scheduled" | "closed" | "report" | "people" | "history";
type ViewMode = "list" | "board" | "calendar";
type SortKey = "due" | "priority" | "status" | "updated" | "code";

const PRIORITY_RANK: Record<TaskPriority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

function monthMatrix(year: number, monthIndex: number): { day: number | null; date: string | null }[] {
  const first = new Date(year, monthIndex, 1);
  const pad = first.getDay();
  const days = new Date(year, monthIndex + 1, 0).getDate();
  const cells: { day: number | null; date: string | null }[] = Array.from({ length: pad }, () => ({
    day: null,
    date: null,
  }));
  for (let day = 1; day <= days; day += 1) {
    cells.push({ day, date: toISO(new Date(year, monthIndex, day)) });
  }
  while (cells.length % 7 !== 0) cells.push({ day: null, date: null });
  return cells;
}

function daysBetween(fromIso: string, toIso: string): number {
  const from = parseISODate(fromIso).getTime();
  const to = parseISODate(toIso).getTime();
  return Math.round((to - from) / 86400000);
}

function matchesQuery(task: Task, q: string): boolean {
  if (!q) return true;
  const hay = `${task.code} ${task.subject} ${task.owner} ${task.client} ${task.blocked} ${task.notes} ${task.projectName ?? ""}`.toLowerCase();
  return hay.includes(q);
}

export function TasksPage() {
  const {
    state,
    employee,
    isManager,
    moveTask,
    reassignTask,
    addTaskPerson,
    removeTaskPerson,
    createTask,
    taskAction,
    toggleTaskSubtask,
    addTaskComment,
    colleagueName,
  } = usePortal();
  const today = todayISO();
  const scopeTasks = useMemo(
    () =>
      (isManager ? state.tasks : state.tasks.filter((task) => task.employeeId === employee.id)).map(ensureTaskExtras),
    [state.tasks, isManager, employee.id],
  );

  const [tab, setTab] = useState<TaskTab>(isManager ? "dashboard" : "mine");
  const [view, setView] = useState<ViewMode>("list");
  const [selectedId, setSelectedId] = useState(scopeTasks.find((task) => task.status !== "done")?.id ?? scopeTasks[0]?.id ?? "");
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [calCursor, setCalCursor] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });
  const [historyPerson, setHistoryPerson] = useState(employee.id);
  const [addPersonId, setAddPersonId] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [query, setQuery] = useState("");
  const [filterPriority, setFilterPriority] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [filterDue, setFilterDue] = useState<"all" | "overdue" | "soon" | "none">("all");
  const [filterBlocked, setFilterBlocked] = useState<"all" | "blocked" | "clear">("all");
  const [sortKey, setSortKey] = useState<SortKey>("due");
  const [progressDraft, setProgressDraft] = useState(50);
  const [blockReason, setBlockReason] = useState("");
  const [blockDepends, setBlockDepends] = useState("");
  const [showBlockForm, setShowBlockForm] = useState(false);
  const [showHelpForm, setShowHelpForm] = useState(false);
  const [commentDraft, setCommentDraft] = useState("");
  const [helpDraft, setHelpDraft] = useState("");
  const [draft, setDraft] = useState({
    subject: "",
    ownerId: TASK_TEAM[0]?.id ?? "",
    priority: "medium" as TaskPriority,
    status: "open" as TaskStatus,
    client: "Internal",
    notes: "",
    due: today,
    estimatedHours: 1,
    peopleIds: [] as string[],
  });

  const selected = scopeTasks.find((task) => task.id === selectedId) ?? null;
  const selectedPeople = selected?.peopleIds ?? [];
  const addablePeople = TASK_TEAM.filter(
    (p) => selected && p.id !== selected.employeeId && !selectedPeople.includes(p.id),
  );

  useEffect(() => {
    if (!selected) return;
    setProgressDraft(taskProgress(selected));
    setShowBlockForm(false);
    setShowHelpForm(false);
  }, [selected?.id]);

  useEffect(() => {
    if (selectedId && scopeTasks.some((t) => t.id === selectedId)) return;
    const fallback =
      scopeTasks.find((t) => t.status !== "done" && t.status !== "scheduled") ?? scopeTasks[0];
    setSelectedId(fallback?.id ?? "");
  }, [scopeTasks, selectedId]);

  const summary = useMemo(() => {
    const total = scopeTasks.length;
    const todo = scopeTasks.filter((t) => t.status === "open" && !t.blocked).length;
    const inProgress = scopeTasks.filter((t) => t.status === "progress" && !t.blocked).length;
    const blocked = scopeTasks.filter((t) => isTaskBlocked(t)).length;
    const dueSoon = scopeTasks.filter((t) => isTaskDueSoon(t, today)).length;
    const overdue = scopeTasks.filter((t) => isTaskOverdue(t, today)).length;
    const completed = scopeTasks.filter((t) => t.status === "done").length;
    return { total, todo, inProgress, blocked, dueSoon, overdue, completed };
  }, [scopeTasks, today]);

  const tabFiltered = scopeTasks.filter((task) => {
    if (tab === "mine") {
      return (
        task.employeeId === employee.id &&
        (task.status === "open" || task.status === "progress")
      );
    }
    if (tab === "open") return task.status === "open" || task.status === "progress";
    if (tab === "scheduled") return task.status === "scheduled";
    if (tab === "closed") return task.status === "done";
    return true;
  });

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let rows = tabFiltered.filter((task) => {
      if (!matchesQuery(task, q)) return false;
      if (filterPriority && task.priority !== filterPriority) return false;
      if (filterStatus) {
        const label = taskStatusLabel(task).toLowerCase();
        if (filterStatus === "todo" && label !== "to do") return false;
        if (filterStatus === "progress" && label !== "in progress") return false;
        if (filterStatus === "blocked" && label !== "blocked") return false;
        if (filterStatus === "done" && task.status !== "done") return false;
        if (filterStatus === "scheduled" && task.status !== "scheduled") return false;
        if (filterStatus === "review" && !task.inReview) return false;
      }
      if (filterDue === "overdue" && !isTaskOverdue(task, today)) return false;
      if (filterDue === "soon" && !isTaskDueSoon(task, today)) return false;
      if (filterDue === "none" && task.due) return false;
      if (filterBlocked === "blocked" && !isTaskBlocked(task)) return false;
      if (filterBlocked === "clear" && isTaskBlocked(task)) return false;
      return true;
    });
    rows = rows.slice().sort((a, b) => {
      if (sortKey === "priority") return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
      if (sortKey === "status") return taskStatusLabel(a).localeCompare(taskStatusLabel(b));
      if (sortKey === "updated") return a.lastActivityAt < b.lastActivityAt ? 1 : -1;
      if (sortKey === "code") return a.code.localeCompare(b.code);
      const overdueBoost = (t: Task) => (isTaskOverdue(t, today) ? 0 : 1);
      if (sortKey === "due") {
        const byOverdue = overdueBoost(a) - overdueBoost(b);
        if (byOverdue !== 0) return byOverdue;
      }
      return (a.due || "9999").localeCompare(b.due || "9999");
    });
    return rows;
  }, [tabFiltered, query, filterPriority, filterStatus, filterDue, filterBlocked, sortKey, today]);

  function selectTask(id: string) {
    setSelectedId(id);
    setMessage(null);
  }

  function applySummaryFocus(focus: "todo" | "progress" | "blocked" | "soon" | "overdue" | "done" | "all") {
    setFilterPriority("");
    setFilterDue("all");
    setFilterBlocked("all");
    setFilterStatus("");
    if (focus === "all") return;
    if (focus === "todo") {
      setTab(isManager ? "open" : "mine");
      setFilterStatus("todo");
      setFilterBlocked("clear");
      return;
    }
    if (focus === "progress") {
      setTab(isManager ? "open" : "mine");
      setFilterStatus("progress");
      setFilterBlocked("clear");
      return;
    }
    if (focus === "blocked") {
      setTab(isManager ? "open" : "mine");
      setFilterBlocked("blocked");
      return;
    }
    if (focus === "soon") {
      setTab(isManager ? "open" : "mine");
      setFilterDue("soon");
      return;
    }
    if (focus === "overdue") {
      setTab(isManager ? "open" : "mine");
      setFilterDue("overdue");
      return;
    }
    if (focus === "done") {
      setTab("closed");
      setFilterStatus("done");
    }
  }

  const openCount = scopeTasks.filter((t) => t.status === "open").length;
  const progressCount = scopeTasks.filter((t) => t.status === "progress").length;
  const scheduledCount = scopeTasks.filter((t) => t.status === "scheduled").length;
  const closedCount = scopeTasks.filter((t) => t.status === "done").length;
  const overdueCount = summary.overdue;

  const monthLabel = new Date(calCursor.year, calCursor.month, 1).toLocaleString(undefined, {
    month: "long",
    year: "numeric",
  });
  const cells = monthMatrix(calCursor.year, calCursor.month);
  const dueOnDay = (date: string) => scopeTasks.filter((task) => task.due === date);

  const peopleRows = useMemo(() => {
    const map = new Map<
      string,
      {
        id: string;
        name: string;
        department: string;
        role: string;
        managerName: string;
        assigned: number;
        completed: number;
        open: number;
        overdue: number;
        onTime: number;
        hours: number;
        score: number;
      }
    >();
    for (const task of scopeTasks) {
      const row =
        map.get(task.employeeId) ??
        {
          id: task.employeeId,
          name: task.owner,
          department: task.department,
          role: task.role,
          managerName: task.managerName,
          assigned: 0,
          completed: 0,
          open: 0,
          overdue: 0,
          onTime: 0,
          hours: 0,
          score: task.score,
        };
      row.assigned += 1;
      row.hours += task.hoursSpent;
      row.score = Math.max(row.score, task.score);
      if (task.status === "done") {
        row.completed += 1;
        if (task.due && task.lastActivityAt.slice(0, 10) <= task.due) row.onTime += 1;
      } else {
        row.open += 1;
        if (task.due && task.due < today) row.overdue += 1;
      }
      map.set(task.employeeId, row);
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [scopeTasks, today]);

  const historyTasks = scopeTasks
    .filter((task) => (isManager ? task.employeeId === historyPerson : true))
    .slice()
    .sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : -1));

  const historyChats = state.chatThreads.filter((thread) => {
    if (!isManager) return thread.employeeId === employee.id;
    return thread.employeeId === historyPerson || thread.colleagueId === historyPerson || thread.memberIds?.includes(historyPerson);
  });

  const tabs: Array<[TaskTab, string]> = isManager
    ? [
        ["dashboard", "Dashboard"],
        ["open", "Open"],
        ["mine", "My tasks"],
        ["scheduled", "Scheduled"],
        ["closed", "Closed / resolved"],
        ["report", "Report"],
        ["people", "By person"],
        ["history", "History"],
      ]
    : [
        ["mine", "My tasks"],
        ["open", "Open"],
        ["scheduled", "Scheduled"],
        ["closed", "Closed / resolved"],
        ["history", "History"],
      ];

  function shiftMonth(delta: number) {
    setCalCursor((prev) => {
      const d = new Date(prev.year, prev.month + delta, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });
  }

  function runAction(
    action: "accept" | "start" | "progress" | "block" | "unblock" | "help" | "review" | "complete",
    payload?: { progressPct?: number; blockedReason?: string; dependsOn?: string; comment?: string },
  ) {
    if (!selected) return;
    const error = taskAction(selected.id, action, payload);
    if (error) {
      setMessage({ tone: "err", text: error });
      return;
    }
    const labels: Record<typeof action, string> = {
      accept: "Task accepted.",
      start: "Task started.",
      progress: "Progress updated.",
      block: "Task marked blocked — manager notified.",
      unblock: "Blocker cleared.",
      help: "Help request sent to your manager.",
      review: "Submitted for review — manager notified.",
      complete: "Task marked complete.",
    };
    setMessage({ tone: "ok", text: labels[action] });
    setShowBlockForm(false);
    setShowHelpForm(false);
    setBlockReason("");
    setBlockDepends("");
    setHelpDraft("");
    if (action === "complete") setTab("closed");
  }

  const canActOnSelected =
    !!selected && (selected.employeeId === employee.id || isManager) && selected.status !== "done";
  const selectedBlocked = selected ? isTaskBlocked(selected) : false;
  const selectedInReview = Boolean(selected?.inReview);
  const nextHint = selected ? nextTaskActionHint(selected) : "";

  return (
    <Page
      title={isManager ? "Task command center" : "My tasks"}
      subtitle={
        isManager
          ? "Assign work, track deadlines, and review team progress."
          : "Focus on what is due today, clear blockers, and complete work on time."
      }
      action={
        isManager ? (
          <button type="button" className="btn" onClick={() => setShowCreate((v) => !v)}>
            {showCreate ? "Cancel" : "Add task"}
          </button>
        ) : undefined
      }
    >
      <MetricGrid>
        <button type="button" className="metric-as-btn" onClick={() => applySummaryFocus("all")}>
          <MetricCard label="Total" value={summary.total} />
        </button>
        <button type="button" className="metric-as-btn" onClick={() => applySummaryFocus("todo")}>
          <MetricCard label="To do" value={summary.todo} hint="Open & unblocked" />
        </button>
        <button type="button" className="metric-as-btn" onClick={() => applySummaryFocus("progress")}>
          <MetricCard label="In progress" value={summary.inProgress} />
        </button>
        <button type="button" className="metric-as-btn" onClick={() => applySummaryFocus("blocked")}>
          <MetricCard label="Blocked" value={summary.blocked} hint={summary.blocked ? "Needs unblock" : "None"} />
        </button>
        <button type="button" className="metric-as-btn" onClick={() => applySummaryFocus("soon")}>
          <MetricCard label="Due soon" value={summary.dueSoon} hint="Next 3 days" />
        </button>
        <button type="button" className="metric-as-btn" onClick={() => applySummaryFocus("overdue")}>
          <MetricCard label="Overdue" value={summary.overdue} hint={summary.overdue ? "Needs attention" : "None"} />
        </button>
        <button type="button" className="metric-as-btn" onClick={() => applySummaryFocus("done")}>
          <MetricCard label="Completed" value={summary.completed} />
        </button>
      </MetricGrid>

      {!isManager && (
        <p className="note">
          Today: <strong>{summary.overdue}</strong> overdue · <strong>{summary.dueSoon}</strong> due soon ·{" "}
          <strong>{summary.blocked}</strong> blocked. Select a task on the left — actions appear in the detail panel.
        </p>
      )}

      {message && <Banner message={message} />}

      {isManager && showCreate && (
        <Card title="Add task">
          <div className="form-grid-2">
            <label className="field">
              Subject
              <input
                value={draft.subject}
                onChange={(e) => setDraft((d) => ({ ...d, subject: e.target.value }))}
                placeholder="What needs to be done?"
              />
            </label>
            <label className="field">
              Owner
              <select value={draft.ownerId} onChange={(e) => setDraft((d) => ({ ...d, ownerId: e.target.value }))}>
                {TASK_TEAM.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.fullName} · {p.role}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Priority
              <select
                value={draft.priority}
                onChange={(e) => setDraft((d) => ({ ...d, priority: e.target.value as TaskPriority }))}
              >
                <option value="urgent">Urgent</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </label>
            <label className="field">
              Due
              <input type="date" value={draft.due} onChange={(e) => setDraft((d) => ({ ...d, due: e.target.value }))} />
            </label>
            <label className="field">
              Client / project
              <input value={draft.client} onChange={(e) => setDraft((d) => ({ ...d, client: e.target.value }))} />
            </label>
            <label className="field" style={{ gridColumn: "1 / -1" }}>
              Notes
              <input value={draft.notes} onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))} />
            </label>
          </div>
          <div className="form-actions">
            <button
              type="button"
              className="btn"
              onClick={() => {
                const error = createTask(draft);
                if (error) {
                  setMessage({ tone: "err", text: error });
                  return;
                }
                setMessage({ tone: "ok", text: "Task created and assigned." });
                setShowCreate(false);
                setTab("open");
              }}
            >
              Create task
            </button>
          </div>
        </Card>
      )}

      <div className="year-bar" role="tablist" aria-label="Task views">
        {tabs.map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            className={tab === value ? "year-chip active" : "year-chip"}
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "dashboard" && isManager && (
        <>
          <section className="summary-row" aria-label="Task totals">
            <div className="summary">
              <span>People</span>
              <strong>{peopleRows.length}</strong>
            </div>
            <div className="summary sky">
              <span>Open</span>
              <strong>{openCount}</strong>
            </div>
            <div className="summary lilac">
              <span>In progress</span>
              <strong>{progressCount}</strong>
            </div>
            <div className="summary">
              <span>Scheduled</span>
              <strong>{scheduledCount}</strong>
            </div>
            <div className="summary rose">
              <span>Overdue</span>
              <strong>{overdueCount}</strong>
            </div>
            <div className="summary">
              <span>Closed</span>
              <strong>{closedCount}</strong>
            </div>
          </section>

          <div className="task-dash-grid">
            <Card
              title="Deadline calendar"
              action={
                <div className="cal-nav">
                  <button type="button" className="btn-ghost" onClick={() => shiftMonth(-1)}>
                    ← Prev
                  </button>
                  <strong>{monthLabel}</strong>
                  <button type="button" className="btn-ghost" onClick={() => shiftMonth(1)}>
                    Next →
                  </button>
                </div>
              }
            >
              <div className="task-cal">
                {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
                  <div key={d} className="task-cal-head">
                    {d}
                  </div>
                ))}
                {cells.map((cell, index) => {
                  const dues = cell.date ? dueOnDay(cell.date) : [];
                  const isToday = cell.date === today;
                  return (
                    <div
                      key={cell.date ?? `pad-${index}`}
                      className={`task-cal-cell${isToday ? " today" : ""}${dues.length ? " has-due" : ""}`}
                    >
                      {cell.day != null && <span className="task-cal-day">{cell.day}</span>}
                      {dues.slice(0, 2).map((task) => (
                        <button
                          key={task.id}
                          type="button"
                          className={`task-cal-chip ${task.priority}`}
                          onClick={() => {
                            setSelectedId(task.id);
                            setTab(task.status === "done" ? "closed" : task.status === "scheduled" ? "scheduled" : "open");
                            setView("list");
                          }}
                        >
                          {task.code}
                        </button>
                      ))}
                      {dues.length > 2 && <span className="muted">+{dues.length - 2}</span>}
                    </div>
                  );
                })}
              </div>
            </Card>

            <Card title="Priority · deadline by person">
              <div className="table-scroll">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Person</th>
                      <th>Open</th>
                      <th>Overdue</th>
                      <th>Urgent/High</th>
                      <th>Next due</th>
                    </tr>
                  </thead>
                  <tbody>
                    {peopleRows.map((person) => {
                      const theirs = scopeTasks.filter((t) => t.employeeId === person.id && t.status !== "done");
                      const hot = theirs.filter((t) => t.priority === "urgent" || t.priority === "high").length;
                      const next = theirs.filter((t) => t.due).sort((a, b) => a.due.localeCompare(b.due))[0];
                      return (
                        <tr key={person.id}>
                          <td>{person.name}</td>
                          <td>{person.open}</td>
                          <td>{person.overdue}</td>
                          <td>{hot}</td>
                          <td>{next ? `${formatShortDate(next.due)} · ${next.code}` : "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>
        </>
      )}

      {(tab === "open" || tab === "mine" || tab === "scheduled" || tab === "closed") && (
        <>
          <FilterBar>
            <label className="filter-label">
              Search
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Title, ID, client, blocker…"
              />
            </label>
            <label className="filter-label">
              Status
              <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
                <option value="">All</option>
                <option value="todo">To Do</option>
                <option value="progress">In progress</option>
                <option value="blocked">Blocked</option>
                <option value="review">Action Required</option>
                <option value="scheduled">Scheduled</option>
                <option value="done">Completed</option>
              </select>
            </label>
            <label className="filter-label">
              Priority
              <select value={filterPriority} onChange={(e) => setFilterPriority(e.target.value)}>
                <option value="">All</option>
                <option value="urgent">Urgent</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </label>
            <label className="filter-label">
              Due
              <select value={filterDue} onChange={(e) => setFilterDue(e.target.value as typeof filterDue)}>
                <option value="all">All dates</option>
                <option value="overdue">Overdue</option>
                <option value="soon">Due soon</option>
                <option value="none">No due date</option>
              </select>
            </label>
            <label className="filter-label">
              Blocker
              <select value={filterBlocked} onChange={(e) => setFilterBlocked(e.target.value as typeof filterBlocked)}>
                <option value="all">All</option>
                <option value="blocked">Blocked only</option>
                <option value="clear">Not blocked</option>
              </select>
            </label>
            <label className="filter-label">
              Sort
              <select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)}>
                <option value="due">Due date</option>
                <option value="priority">Priority</option>
                <option value="status">Status</option>
                <option value="updated">Last activity</option>
                <option value="code">Task ID</option>
              </select>
            </label>
            <div className="year-bar" style={{ margin: 0 }} role="tablist" aria-label="Display mode">
              {(["list", "board", "calendar"] as ViewMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={view === mode ? "year-chip active" : "year-chip"}
                  onClick={() => setView(mode)}
                >
                  {mode === "list" ? "List" : mode === "board" ? "Board" : "Calendar"}
                </button>
              ))}
            </div>
          </FilterBar>

          {view === "list" && (
            <div className="task-workbench">
              <Card
                title={
                  tab === "mine"
                    ? "My active tasks"
                    : tab === "open"
                      ? "Open queue"
                      : tab === "scheduled"
                        ? "Scheduled"
                        : "Closed / resolved"
                }
                action={<span className="muted">{filtered.length} shown</span>}
              >
                {filtered.length === 0 ? (
                  <EmptyState title="No tasks match" description="Adjust filters or switch tabs to find work." />
                ) : (
                  <ul className="task-list">
                    {filtered.map((task) => {
                      const pct = taskProgress(task);
                      const overdue = isTaskOverdue(task, today);
                      const soon = isTaskDueSoon(task, today);
                      return (
                        <li key={task.id}>
                          <button
                            type="button"
                            className={task.id === selected?.id ? "task-list-item active" : "task-list-item"}
                            onClick={() => selectTask(task.id)}
                          >
                            <div className="task-list-top">
                              <span className="task-code">{task.code}</span>
                              <StatusPill status={task.priority} />
                              <StatusBadge status={taskStatusLabel(task)} />
                            </div>
                            <strong className="task-list-title">{task.subject}</strong>
                            <div className="task-list-meta">
                              <span className={overdue ? "task-overdue" : undefined}>
                                Due {task.due ? formatShortDate(task.due) : "—"}
                                {overdue ? " · Overdue" : soon ? " · Due soon" : ""}
                              </span>
                              <span>Mgr {task.managerName}</span>
                              <span>{pct}%</span>
                            </div>
                            <div className="task-list-progress" aria-hidden>
                              <span style={{ width: `${pct}%` }} />
                            </div>
                            {isTaskBlocked(task) && (
                              <p className="task-list-block">Blocked: {task.blocked}</p>
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Card>

              <aside className="task-detail-panel">
                {!selected ? (
                  <Card>
                    <EmptyState
                      title="Select a task"
                      description="Choose a row to see description, checklist, and the next action."
                    />
                  </Card>
                ) : (
                  <Card
                    title={selected.code}
                    action={<StatusBadge status={taskStatusLabel(selected)} />}
                  >
                    <div className="task-next-action">
                      <span className="muted">Next action</span>
                      <strong>{nextHint}</strong>
                    </div>

                    <h3 className="task-section-title">{selected.subject}</h3>
                    <div className="task-detail-grid compact">
                      <div>
                        <span className="muted">Priority</span>
                        <StatusPill status={selected.priority} />
                      </div>
                      <div>
                        <span className="muted">Due</span>
                        <strong className={isTaskOverdue(selected, today) ? "task-overdue" : undefined}>
                          {selected.due ? formatShortDate(selected.due) : "—"}
                          {isTaskOverdue(selected, today)
                            ? " · Overdue"
                            : isTaskDueSoon(selected, today)
                              ? " · Due soon"
                              : ""}
                        </strong>
                      </div>
                      <div>
                        <span className="muted">Assignee</span>
                        <strong>{selected.owner}</strong>
                      </div>
                      <div>
                        <span className="muted">Manager</span>
                        <strong>{selected.managerName}</strong>
                      </div>
                      <div>
                        <span className="muted">Assigned by</span>
                        <strong>{selected.assignedBy}</strong>
                      </div>
                      <div>
                        <span className="muted">Project</span>
                        <strong>{selected.projectName || selected.client}</strong>
                      </div>
                      <div>
                        <span className="muted">Estimate / spent</span>
                        <strong>
                          {selected.estimatedHours}h / {selected.hoursSpent}h
                        </strong>
                      </div>
                      <div>
                        <span className="muted">Dependency</span>
                        <strong>{selected.dependsOn || "—"}</strong>
                      </div>
                    </div>

                    <section className="task-section">
                      <h4 className="task-section-title">Description</h4>
                      <p>{selected.notes || "No description provided."}</p>
                      {selectedBlocked && <p className="note err">Blocked: {selected.blocked}</p>}
                    </section>

                    <section className="task-section">
                      <h4 className="task-section-title">Progress · {taskProgress(selected)}%</h4>
                      <ProgressBar value={taskProgress(selected)} label="Completion" />
                      {(selected.subtasks?.length ?? 0) > 0 && (
                        <>
                          <h4 className="task-section-title" style={{ marginTop: 12 }}>
                            Checklist
                          </h4>
                          <ul className="task-checklist">
                            {selected.subtasks!.map((item) => (
                              <li key={item.id}>
                                <label>
                                  <input
                                    type="checkbox"
                                    checked={item.done}
                                    disabled={!canActOnSelected || selected.status === "scheduled"}
                                    onChange={() => {
                                      const error = toggleTaskSubtask(selected.id, item.id);
                                      setMessage(
                                        error
                                          ? { tone: "err", text: error }
                                          : { tone: "ok", text: "Checklist updated." },
                                      );
                                    }}
                                  />
                                  <span className={item.done ? "muted" : undefined}>{item.title}</span>
                                </label>
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
                    </section>

                    <section className="task-section task-section-split">
                      <div>
                        <h4 className="task-section-title">Attachments</h4>
                        {(selected.attachments?.length ?? 0) === 0 ? (
                          <p className="muted">None</p>
                        ) : (
                          <ul className="todo">
                            {selected.attachments!.map((file) => (
                              <li key={file.id}>
                                {file.name}
                                <div className="muted">{formatStamp(file.at)}</div>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                      <div>
                        <h4 className="task-section-title">Comments</h4>
                        {(selected.comments?.length ?? 0) === 0 ? (
                          <p className="muted">No comments yet.</p>
                        ) : (
                          <ul className="todo">
                            {selected.comments!.map((c) => (
                              <li key={c.id}>
                                <strong>{c.author}</strong> · {c.text}
                                <div className="muted">{formatStamp(c.at)}</div>
                              </li>
                            ))}
                          </ul>
                        )}
                        {canActOnSelected && (
                          <div className="row-gap" style={{ marginTop: 8 }}>
                            <input
                              value={commentDraft}
                              onChange={(e) => setCommentDraft(e.target.value)}
                              placeholder="Add a comment…"
                              style={{ flex: 1 }}
                            />
                            <button
                              type="button"
                              className="btn-ghost"
                              onClick={() => {
                                const error = addTaskComment(selected.id, commentDraft);
                                setMessage(
                                  error ? { tone: "err", text: error } : { tone: "ok", text: "Comment added." },
                                );
                                if (!error) setCommentDraft("");
                              }}
                            >
                              Post
                            </button>
                          </div>
                        )}
                      </div>
                    </section>

                    <section className="task-section">
                      <h4 className="task-section-title">Activity</h4>
                      <ul className="task-timeline">
                        {[...(selected.activity ?? [])]
                          .slice()
                          .reverse()
                          .map((ev) => (
                            <li key={ev.id}>
                              <strong>{ev.action}</strong> · {ev.actor}
                              {ev.detail ? ` — ${ev.detail}` : ""}
                              <div className="muted">{formatStamp(ev.at)}</div>
                            </li>
                          ))}
                      </ul>
                    </section>

                    {isManager && selected.status !== "done" && (
                      <section className="task-section">
                        <h4 className="task-section-title">People on this task</h4>
                        <div className="row-gap" style={{ flexWrap: "wrap" }}>
                          <span className="year-chip active" style={{ cursor: "default" }}>
                            {selected.owner} · Owner
                          </span>
                          {selectedPeople.map((pid) => (
                            <span
                              key={pid}
                              className="year-chip"
                              style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
                            >
                              {taskPersonLabel(pid)}
                              <button
                                type="button"
                                className="btn-ghost"
                                style={{ padding: "0 4px", minHeight: 0, fontSize: 12 }}
                                onClick={() => {
                                  const error = removeTaskPerson(selected.id, pid);
                                  setMessage(
                                    error
                                      ? { tone: "err", text: error }
                                      : { tone: "ok", text: "Person removed." },
                                  );
                                }}
                              >
                                Remove
                              </button>
                            </span>
                          ))}
                        </div>
                        <div className="form-grid-2" style={{ marginTop: 10 }}>
                          <label className="field">
                            Change owner
                            <select
                              value={selected.employeeId}
                              onChange={(e) => {
                                const error = reassignTask(selected.id, e.target.value);
                                setMessage(
                                  error ? { tone: "err", text: error } : { tone: "ok", text: "Owner updated." },
                                );
                              }}
                            >
                              {TASK_TEAM.map((p) => (
                                <option key={p.id} value={p.id}>
                                  {p.fullName}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="field">
                            Add person
                            <div className="row-gap">
                              <select
                                value={addPersonId}
                                onChange={(e) => setAddPersonId(e.target.value)}
                                style={{ flex: 1 }}
                              >
                                <option value="">Select teammate…</option>
                                {addablePeople.map((p) => (
                                  <option key={p.id} value={p.id}>
                                    {p.fullName}
                                  </option>
                                ))}
                              </select>
                              <button
                                type="button"
                                className="btn-ghost"
                                disabled={!addPersonId}
                                onClick={() => {
                                  const error = addTaskPerson(selected.id, addPersonId);
                                  setMessage(
                                    error ? { tone: "err", text: error } : { tone: "ok", text: "Person added." },
                                  );
                                  if (!error) setAddPersonId("");
                                }}
                              >
                                Add
                              </button>
                            </div>
                          </label>
                        </div>
                      </section>
                    )}

                    <section className="task-section task-actions">
                      <h4 className="task-section-title">Actions</h4>
                      <div className="form-actions" style={{ marginTop: 0 }}>
                        {canActOnSelected &&
                          selected.status === "open" &&
                          !selected.accepted &&
                          !selectedBlocked && (
                            <button type="button" className="btn" onClick={() => runAction("accept")}>
                              Accept task
                            </button>
                          )}
                        {canActOnSelected &&
                          selected.status === "open" &&
                          selected.accepted &&
                          !selectedBlocked && (
                            <button type="button" className="btn" onClick={() => runAction("start")}>
                              Start task
                            </button>
                          )}
                        {canActOnSelected &&
                          selected.status === "progress" &&
                          !selectedBlocked &&
                          !selectedInReview && (
                            <>
                              <label className="field" style={{ minWidth: 120 }}>
                                Progress %
                                <input
                                  type="number"
                                  min={0}
                                  max={99}
                                  value={progressDraft}
                                  onChange={(e) => setProgressDraft(Number(e.target.value))}
                                />
                              </label>
                              <button
                                type="button"
                                className="btn-ghost"
                                onClick={() => runAction("progress", { progressPct: progressDraft })}
                              >
                                Update progress
                              </button>
                              <button
                                type="button"
                                className="btn-ghost"
                                onClick={() => {
                                  setShowBlockForm(true);
                                  setShowHelpForm(false);
                                }}
                              >
                                Mark as blocked
                              </button>
                              <button
                                type="button"
                                className="btn-ghost"
                                onClick={() => {
                                  setShowHelpForm(true);
                                  setShowBlockForm(false);
                                }}
                              >
                                Request help
                              </button>
                              <button type="button" className="btn-ghost" onClick={() => runAction("review")}>
                                Submit for review
                              </button>
                              <button type="button" className="btn" onClick={() => runAction("complete")}>
                                Mark complete
                              </button>
                            </>
                          )}
                        {canActOnSelected && selectedInReview && !selectedBlocked && (
                          <>
                            <button type="button" className="btn" onClick={() => runAction("complete")}>
                              Mark complete
                            </button>
                            <button
                              type="button"
                              className="btn-ghost"
                              onClick={() => runAction("progress", { progressPct: Math.min(progressDraft, 89) })}
                            >
                              Return to in progress
                            </button>
                          </>
                        )}
                        {canActOnSelected && selectedBlocked && (
                          <>
                            <button type="button" className="btn" onClick={() => runAction("unblock")}>
                              Clear blocker
                            </button>
                            <button
                              type="button"
                              className="btn-ghost"
                              onClick={() => {
                                setShowHelpForm(true);
                                setShowBlockForm(false);
                              }}
                            >
                              Request help
                            </button>
                            <button
                              type="button"
                              className="btn-ghost"
                              onClick={() => {
                                setShowBlockForm(true);
                                setShowHelpForm(false);
                              }}
                            >
                              Update blocker
                            </button>
                          </>
                        )}
                        {selected.status === "scheduled" && isManager && (
                          <button type="button" className="btn" onClick={() => moveTask(selected.id, "open")}>
                            Release to open
                          </button>
                        )}
                        {selected.status === "scheduled" && !isManager && (
                          <p className="note">Scheduled — your manager will release this when ready.</p>
                        )}
                        {selected.status === "done" && (
                          <p className="note">Completed — kept in Closed / History for reference.</p>
                        )}
                      </div>

                      {showBlockForm && canActOnSelected && (
                        <div className="form-grid-2" style={{ marginTop: 12 }}>
                          <label className="field" style={{ gridColumn: "1 / -1" }}>
                            Blocker reason
                            <input
                              value={blockReason}
                              onChange={(e) => setBlockReason(e.target.value)}
                              placeholder="What is blocking you?"
                            />
                          </label>
                          <label className="field" style={{ gridColumn: "1 / -1" }}>
                            Required dependency
                            <input
                              value={blockDepends}
                              onChange={(e) => setBlockDepends(e.target.value)}
                              placeholder="e.g. TSK-1080 or IT env refresh"
                            />
                          </label>
                          <button
                            type="button"
                            className="btn"
                            onClick={() =>
                              runAction("block", { blockedReason: blockReason, dependsOn: blockDepends })
                            }
                          >
                            Save blocker & notify manager
                          </button>
                          <button type="button" className="btn-ghost" onClick={() => setShowBlockForm(false)}>
                            Cancel
                          </button>
                        </div>
                      )}

                      {showHelpForm && canActOnSelected && (
                        <label className="field" style={{ marginTop: 12 }}>
                          Help note
                          <div className="row-gap">
                            <input
                              value={helpDraft}
                              onChange={(e) => setHelpDraft(e.target.value)}
                              placeholder="What do you need from your manager?"
                              style={{ flex: 1 }}
                            />
                            <button
                              type="button"
                              className="btn"
                              onClick={() =>
                                runAction("help", {
                                  comment: helpDraft || "Need guidance to unblock this work.",
                                })
                              }
                            >
                              Send help request
                            </button>
                            <button type="button" className="btn-ghost" onClick={() => setShowHelpForm(false)}>
                              Cancel
                            </button>
                          </div>
                        </label>
                      )}
                    </section>
                  </Card>
                )}
              </aside>
            </div>
          )}

          {view === "board" && (
            <div className="task-board-wrap">
              <div className="task-board">
                {(
                  [
                    ["todo", "To Do", (t: Task) => t.status === "open" && !t.blocked],
                    ["progress", "In progress", (t: Task) => t.status === "progress" && !t.blocked],
                    ["blocked", "Blocked", (t: Task) => isTaskBlocked(t)],
                    ["done", "Completed", (t: Task) => t.status === "done"],
                  ] as const
                ).map(([key, label, pred]) => (
                  <Card key={key} title={`${label} · ${filtered.filter(pred).length}`}>
                    <ul className="task-board-list">
                      {filtered.filter(pred).map((task) => (
                        <li key={task.id}>
                          <button
                            type="button"
                            className={
                              task.id === selected?.id ? "task-board-card active" : "task-board-card"
                            }
                            onClick={() => selectTask(task.id)}
                          >
                            <strong>{task.code}</strong>
                            <span>{task.subject}</span>
                            <span className="muted">
                              {task.owner} · {task.due ? formatShortDate(task.due) : "No due"} ·{" "}
                              {taskProgress(task)}%
                            </span>
                            <StatusPill status={task.priority} />
                          </button>
                        </li>
                      ))}
                      {filtered.filter(pred).length === 0 && <li className="muted">No cards</li>}
                    </ul>
                  </Card>
                ))}
              </div>
              {selected && (
                <p className="note">
                  Selected <strong>{selected.code}</strong> — switch to List view for the full detail panel, or use
                  actions after opening List.
                  <button type="button" className="btn-ghost" style={{ marginLeft: 8 }} onClick={() => setView("list")}>
                    Open in list
                  </button>
                </p>
              )}
            </div>
          )}

          {view === "calendar" && (
            <Card
              title="Task calendar"
              action={
                <div className="cal-nav">
                  <button type="button" className="btn-ghost" onClick={() => shiftMonth(-1)}>
                    ← Prev
                  </button>
                  <strong>{monthLabel}</strong>
                  <button type="button" className="btn-ghost" onClick={() => shiftMonth(1)}>
                    Next →
                  </button>
                </div>
              }
            >
              <div className="task-cal">
                {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
                  <div key={d} className="task-cal-head">
                    {d}
                  </div>
                ))}
                {cells.map((cell, index) => {
                  const dues = cell.date ? filtered.filter((task) => task.due === cell.date) : [];
                  const isToday = cell.date === today;
                  return (
                    <div
                      key={cell.date ?? `pad-${index}`}
                      className={`task-cal-cell${isToday ? " today" : ""}${dues.length ? " has-due" : ""}`}
                    >
                      {cell.day != null && <span className="task-cal-day">{cell.day}</span>}
                      {dues.slice(0, 3).map((task) => (
                        <button
                          key={task.id}
                          type="button"
                          className={`task-cal-chip ${task.priority}${task.id === selected?.id ? " selected" : ""}`}
                          onClick={() => {
                            selectTask(task.id);
                            setView("list");
                          }}
                        >
                          {task.code}
                        </button>
                      ))}
                    </div>
                  );
                })}
              </div>
            </Card>
          )}
        </>
      )}


      {tab === "report" && isManager && (
        <Card title="Full task report">
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Subject</th>
                  <th>Status</th>
                  <th>Priority</th>
                  <th>Client</th>
                  <th>Owner</th>
                  <th>Assigned by</th>
                  <th>Due</th>
                  <th>Progress</th>
                  <th>Est.</th>
                  <th>Spent</th>
                  <th>Lag (days)</th>
                </tr>
              </thead>
              <tbody>
                {scopeTasks.map((task) => {
                  const lag = task.due ? daysBetween(today, task.due) * -1 : 0;
                  return (
                    <tr
                      key={task.id}
                      onClick={() => {
                        setSelectedId(task.id);
                        setTab(task.status === "done" ? "closed" : "open");
                      }}
                    >
                      <td>{task.code}</td>
                      <td>{task.subject}</td>
                      <td>
                        <StatusBadge status={taskStatusLabel(task)} />
                      </td>
                      <td>
                        <StatusPill status={task.priority} />
                      </td>
                      <td>{task.client}</td>
                      <td>{task.owner}</td>
                      <td>{task.assignedBy}</td>
                      <td>{task.due ? formatShortDate(task.due) : "—"}</td>
                      <td>{taskProgress(task)}%</td>
                      <td>{task.estimatedHours}h</td>
                      <td>{task.hoursSpent}h</td>
                      <td>{task.status === "done" ? "—" : lag > 0 ? `+${lag}` : lag}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {tab === "people" && isManager && (
        <Card title="People · assigned / completed / open / overdue">
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Department</th>
                  <th>Role</th>
                  <th>Manager</th>
                  <th>Assigned</th>
                  <th>Completed</th>
                  <th>Open</th>
                  <th>Overdue</th>
                  <th>On time</th>
                  <th>Hours</th>
                  <th>Score</th>
                </tr>
              </thead>
              <tbody>
                {peopleRows.map((person) => (
                  <tr key={person.id}>
                    <td>{person.name}</td>
                    <td>{person.department}</td>
                    <td>{person.role}</td>
                    <td>{person.managerName}</td>
                    <td>{person.assigned}</td>
                    <td>{person.completed}</td>
                    <td>{person.open}</td>
                    <td>{person.overdue}</td>
                    <td>{person.onTime}</td>
                    <td>{person.hours}h</td>
                    <td>
                      <strong>{person.score}</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {tab === "history" && (
        <div className="task-history-grid">
          <Card
            title="Activity history"
            action={
              isManager ? (
                <select value={historyPerson} onChange={(event) => setHistoryPerson(event.target.value)} aria-label="Person">
                  {DEMO_ACCOUNTS.filter((a) => a.role === "employee" || a.id === employee.id).map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.fullName}
                    </option>
                  ))}
                </select>
              ) : undefined
            }
          >
            <div className="table-scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>ID</th>
                    <th>Subject</th>
                    <th>Status</th>
                    <th>Automation</th>
                  </tr>
                </thead>
                <tbody>
                  {historyTasks.map((task) => (
                    <tr key={task.id}>
                      <td>{formatStamp(task.lastActivityAt)}</td>
                      <td>{task.code}</td>
                      <td>{task.subject}</td>
                      <td>
                        <StatusBadge status={taskStatusLabel(task)} />
                      </td>
                      <td>{task.automationNote || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card title="Chat history">
            {historyChats.length === 0 ? (
              <p className="empty">No chat threads for this person in the demo.</p>
            ) : (
              historyChats.map((thread) => (
                <details key={thread.id} className="history-chat">
                  <summary>
                    {thread.kind === "group" ? thread.title || "Group" : colleagueName(thread.colleagueId)} ·{" "}
                    {thread.messages.length} messages
                  </summary>
                  <div className="bubbles">
                    {thread.messages.map((item) => (
                      <div key={item.id} className={item.from === "me" ? "bubble me" : "bubble"}>
                        {item.text}
                        <small>{formatStamp(item.at)}</small>
                      </div>
                    ))}
                  </div>
                  <Link to="/chat" className="quiet-link">
                    Open in Messages
                  </Link>
                </details>
              ))
            )}
          </Card>
        </div>
      )}
    </Page>
  );
}
