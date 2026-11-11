import { useCallback, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ActionButton, Banner, Card, EmptyState, Page, notify } from "../components/ui.tsx";
import {
  ensureTaskExtras,
  isTaskBlocked,
  isTaskOverdue,
  nextTaskActionHint,
  taskProgress,
  taskStatusLabel,
} from "../data/taskHelpers.ts";
import { TASK_TEAM, taskPersonById, taskTeamFor, type TaskTeamPerson } from "../data/taskTeam.ts";
import {
  formatShortDate,
  formatStamp,
  toISO,
  todayISO,
  TASK_TYPES,
  type Task,
  type TaskLink,
  type TaskPriority,
  type TaskStatus,
  type TaskType,
} from "../model.ts";
import { managementChain } from "../demoAccounts.ts";
import { usePortal } from "../store.tsx";
import { useTaskAutoMode } from "../data/taskAutoMode.ts";
import { useTaskAutoReminders } from "../data/taskAutoReminders.ts";
import { useProjects } from "../data/projectStore.ts";
import { useProjectContext } from "./projectContext.ts";
import { Avatar, Drawer, FileList, PriorityChip, WorkSwitch, dayGap, dueText } from "./workParts.tsx";
import { API_ENABLED } from "../api/client.ts";
import { openWorkFile, removeTaskFile, taskFilePath, uploadTaskFile } from "../api/syncTasks.ts";

type View = "mine" | "byme" | "team" | "following" | "insights";
type StatusSet = "active" | "scheduled" | "done" | "all";
type Focus = "" | "late" | "today" | "week" | "progress" | "blocked";
type Layout = "list" | "board" | "calendar";
type SortKey = "due" | "priority" | "recent";
type Column = "todo" | "progress" | "review" | "blocked" | "done";
type Action = "accept" | "decline" | "start" | "progress" | "block" | "unblock" | "help" | "review" | "complete";

const PRIORITIES: TaskPriority[] = ["urgent", "high", "medium", "low"];
const PRIORITY_RANK: Record<TaskPriority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
const WIDE_ROLES = ["hr", "hr_admin", "hrbp", "admin", "super_admin"];

/** Which board column a task sits in. */
function columnOf(t: Task): Column | "scheduled" {
  if (t.status === "done") return "done";
  if (t.status === "scheduled") return "scheduled";
  if (isTaskBlocked(t)) return "blocked";
  if (t.inReview) return "review";
  if (t.status === "progress") return "progress";
  return "todo";
}

const DOT: Record<Column | "scheduled", string> = {
  todo: "s-todo",
  progress: "s-progress",
  review: "s-review",
  blocked: "s-blocked",
  done: "s-done",
  scheduled: "s-scheduled",
};

function dueClass(t: Task, today: string): string {
  if (!t.due || t.status === "done" || t.status === "scheduled") return "";
  const d = dayGap(today, t.due);
  return d < 0 ? "late" : d <= 1 ? "soon" : "";
}

function bucketOf(t: Task, today: string): string {
  if (t.status === "done") return "Done";
  if (!t.due) return "No due date";
  const d = dayGap(today, t.due);
  if (d < 0 && t.status !== "scheduled") return "Overdue";
  if (d <= 0) return "Today";
  if (d <= 7) return "Next 7 days";
  return "Later";
}
const BUCKETS = ["Overdue", "Today", "Next 7 days", "Later", "No due date", "Done"];

function monthCells(year: number, month: number): (string | null)[] {
  const pad = (new Date(year, month, 1).getDay() + 6) % 7; // weeks start on Monday
  const days = new Date(year, month + 1, 0).getDate();
  const cells: (string | null)[] = Array.from({ length: pad }, () => null);
  for (let d = 1; d <= days; d += 1) cells.push(toISO(new Date(year, month, d)));
  while (cells.length % 7) cells.push(null);
  return cells;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function TasksPage() {
  const portal = usePortal();
  const { state, employee, createTask, taskAction } = portal;
  const today = todayISO();
  const me = employee.id;
  const myFirst = employee.fullName.split(" ")[0];
  const [autoMode, setAutoMode] = useTaskAutoMode(me);
  useTaskAutoReminders();

  const myTeam = useMemo(() => taskTeamFor(me), [me]);
  const teamIds = useMemo(() => new Set(myTeam.map((p) => p.id)), [myTeam]);
  const hasTeam = myTeam.length > 0;

  // People I can give work to: me, my reports, colleagues on my projects (not my managers); HR and admins: anyone.
  const projects = useProjects(useProjectContext());
  const assignable = useMemo(() => {
    const above = new Set(managementChain(me).map((m) => m.id));
    const wide = WIDE_ROLES.includes(employee.role);
    const colleagues = new Set<string>();
    for (const p of projects) {
      for (const m of p.members) colleagues.add(m.employeeId);
      if (p.managerId) colleagues.add(p.managerId);
    }
    const group = (p: TaskTeamPerson): string =>
      p.id === me ? "You" : teamIds.has(p.id) ? "Your team" : colleagues.has(p.id) && !above.has(p.id) ? "Project colleagues" : wide ? "Everyone" : "";
    return TASK_TEAM.map((p) => ({ person: p, group: group(p) })).filter((x) => x.group);
  }, [projects, me, teamIds, employee.role]);
  const allowedOwnerIds = useMemo(() => assignable.map((x) => x.person.id), [assignable]);

  const scope = useMemo(
    () =>
      state.tasks
        .filter(
          (t) =>
            t.employeeId === me ||
            teamIds.has(t.employeeId) ||
            t.createdById === me ||
            t.ccIds?.includes(me) ||
            t.peopleIds?.includes(me),
        )
        .map(ensureTaskExtras),
    [state.tasks, me, teamIds],
  );

  const inView = useCallback(
    (t: Task, v: View): boolean => {
      if (v === "mine") return t.employeeId === me;
      if (v === "byme") return t.employeeId !== me && (t.createdById === me || (!t.createdById && t.assignedBy === myFirst));
      if (v === "team") return teamIds.has(t.employeeId);
      if (v === "following") return t.employeeId !== me && (!!t.ccIds?.includes(me) || !!t.peopleIds?.includes(me));
      return false;
    },
    [me, myFirst, teamIds],
  );
  const openCount = (v: View) => scope.filter((t) => inView(t, v) && t.status !== "done").length;

  const [params, setParams] = useSearchParams();
  const selectedId = params.get("task") ?? "";
  const [view, setView] = useState<View>(() => (hasTeam && openCount("mine") === 0 ? "team" : "mine"));
  const [statusSet, setStatusSet] = useState<StatusSet>("active");
  const [focus, setFocus] = useState<Focus>("");
  const [layout, setLayout] = useState<Layout>("list");
  const [sort, setSort] = useState<SortKey>("due");
  const [query, setQuery] = useState("");
  const [priority, setPriority] = useState<"" | TaskPriority>("");
  const [project, setProject] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [dragOver, setDragOver] = useState<Column | "">("");
  const [cal, setCal] = useState(() => ({ y: new Date().getFullYear(), m: new Date().getMonth() }));

  const open = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) {
      const t = scope.find((x) => x.id === id || x.code === id);
      next.set("task", t?.id ?? id);
    } else next.delete("task");
    setParams(next, { replace: true });
  };
  const selected = scope.find((t) => t.id === selectedId || t.code === selectedId) ?? null;

  const viewTasks = scope.filter((t) => inView(t, view));
  const activeInView = viewTasks.filter((t) => t.status !== "done" && t.status !== "scheduled");
  const stats = {
    late: activeInView.filter((t) => isTaskOverdue(t, today)).length,
    today: activeInView.filter((t) => t.due === today).length,
    week: activeInView.filter((t) => t.due && t.due >= today && dayGap(today, t.due) <= 7).length,
    progress: activeInView.filter((t) => t.status === "progress" && !isTaskBlocked(t)).length,
    blocked: activeInView.filter((t) => isTaskBlocked(t)).length,
    done: viewTasks.filter((t) => t.status === "done").length,
  };
  const projectNames = [...new Set(viewTasks.map((t) => t.projectName || t.client).filter(Boolean))].sort();

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = viewTasks.filter((t) => {
      if (layout !== "board") {
        if (statusSet === "active" && (t.status === "done" || t.status === "scheduled")) return false;
        if (statusSet === "scheduled" && t.status !== "scheduled") return false;
        if (statusSet === "done" && t.status !== "done") return false;
      }
      if (focus === "late" && !isTaskOverdue(t, today)) return false;
      if (focus === "today" && (t.due !== today || t.status === "done")) return false;
      if (focus === "week" && (!t.due || t.due < today || dayGap(today, t.due) > 7 || t.status === "done")) return false;
      if (focus === "progress" && (t.status !== "progress" || isTaskBlocked(t))) return false;
      if (focus === "blocked" && !isTaskBlocked(t)) return false;
      if (priority && t.priority !== priority) return false;
      if (project && (t.projectName || t.client) !== project) return false;
      if (q && !`${t.code} ${t.subject} ${t.owner} ${t.projectName ?? t.client} ${t.notes}`.toLowerCase().includes(q)) return false;
      return true;
    });
    return list.sort((a, b) => {
      if (sort === "priority") return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || (a.due || "9").localeCompare(b.due || "9");
      if (sort === "recent") return b.lastActivityAt.localeCompare(a.lastActivityAt);
      return (a.due || "9999").localeCompare(b.due || "9999") || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    });
  }, [viewTasks, layout, statusSet, focus, priority, project, query, sort, today]);

  const filtersOn = !!(focus || priority || project || query);
  const clearFilters = () => {
    setFocus("");
    setPriority("");
    setProject("");
    setQuery("");
  };

  function run(task: Task, action: Action, payload?: { progressPct?: number; blockedReason?: string; dependsOn?: string; comment?: string }) {
    const error = taskAction(task.id, action, payload);
    if (error) {
      notify(error, "err");
      return error;
    }
    return null;
  }

  /** Board drag and drop: each column maps to the action that gets a task there. */
  function dropOn(col: Column, id: string) {
    const t = scope.find((x) => x.id === id);
    if (!t || columnOf(t) === col) return;
    let error: string | null = null;
    if (col === "progress") error = run(t, isTaskBlocked(t) ? "unblock" : t.inReview ? "progress" : "start", t.inReview ? { progressPct: 80 } : undefined);
    else if (col === "review") error = run(t, "review");
    else if (col === "done") error = run(t, "complete");
    else if (col === "blocked") {
      open(t.id);
      return;
    } else error = "A started task can't go back to To do.";
    if (error) notify(error, "err");
    else notify(`${t.code} moved.`);
  }

  // Quick add: a to-do for yourself.
  const [quick, setQuick] = useState({ subject: "", due: today, priority: "medium" as TaskPriority });
  function addQuick(e: FormEvent) {
    e.preventDefault();
    if (!quick.subject.trim()) return;
    const error = createTask({
      subject: quick.subject,
      ownerId: me,
      priority: quick.priority,
      due: quick.due || today,
      taskType: "Admin",
      estimatedHours: 1,
      client: "Internal",
      allowedOwnerIds,
    });
    if (error) {
      setMessage({ tone: "err", text: error });
      return;
    }
    setMessage(null);
    notify("Task added.");
    setQuick({ subject: "", due: today, priority: quick.priority });
  }

  const views: [View, string][] = [
    ["mine", "My tasks"],
    ["byme", "Assigned by me"],
    ...(hasTeam ? ([["team", "My team"]] as [View, string][]) : []),
    ["following", "Following"],
    ...(hasTeam ? ([["insights", "Workload"]] as [View, string][]) : []),
  ];

  return (
    <Page
      title="Tasks"
      action={
        <button type="button" className="btn" onClick={() => setShowNew(true)}>
          New task
        </button>
      }
    >
      <WorkSwitch />

      <div className="wk-tabs" role="tablist" aria-label="Task views">
        {views.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={view === id}
            className={view === id ? "on" : undefined}
            onClick={() => {
              setView(id);
              setFocus("");
            }}
          >
            {label}
            {id !== "insights" && <span className="wk-count">{openCount(id)}</span>}
          </button>
        ))}
      </div>

      <Banner message={message} />

      {view === "insights" ? (
        <Workload tasks={scope.filter((t) => teamIds.has(t.employeeId))} today={today} onOpen={(id) => open(id)} />
      ) : (
        <>
          <div className="wk-stats" role="group" aria-label="Task totals">
            {(
              [
                ["late", "Overdue", stats.late, "late"],
                ["today", "Due today", stats.today, "soon"],
                ["week", "Next 7 days", stats.week, ""],
                ["progress", "In progress", stats.progress, "active"],
                ["blocked", "Blocked", stats.blocked, "blocked"],
              ] as const
            ).map(([key, label, value, tone]) => (
              <button
                key={key}
                type="button"
                className={`wk-stat ${tone}${focus === key ? " on" : ""}`}
                aria-pressed={focus === key}
                onClick={() => {
                  setFocus(focus === key ? "" : key);
                  if (statusSet === "done") setStatusSet("active");
                }}
              >
                <b>{value}</b>
                <span>{label}</span>
              </button>
            ))}
            <button
              type="button"
              className={`wk-stat done${statusSet === "done" && !focus ? " on" : ""}`}
              aria-pressed={statusSet === "done" && !focus}
              onClick={() => {
                setFocus("");
                setStatusSet(statusSet === "done" ? "active" : "done");
                setLayout(layout === "board" ? "list" : layout);
              }}
            >
              <b>{stats.done}</b>
              <span>Done</span>
            </button>
          </div>

          {view === "mine" && (
            <form className="wk-quick" onSubmit={addQuick}>
              <input
                type="text"
                value={quick.subject}
                maxLength={120}
                onChange={(e) => setQuick({ ...quick, subject: e.target.value })}
                placeholder="Add a to-do for yourself and press Enter"
                aria-label="New to-do"
              />
              <input type="date" value={quick.due} min={today} onChange={(e) => setQuick({ ...quick, due: e.target.value })} aria-label="Due date" />
              <select value={quick.priority} onChange={(e) => setQuick({ ...quick, priority: e.target.value as TaskPriority })} aria-label="Priority">
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {p[0].toUpperCase() + p.slice(1)}
                  </option>
                ))}
              </select>
              <button type="submit" className="btn" disabled={!quick.subject.trim()}>
                Add
              </button>
            </form>
          )}

          <div className="wk-toolbar">
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search tasks" aria-label="Search tasks" />
            {layout !== "board" && (
              <select value={statusSet} onChange={(e) => setStatusSet(e.target.value as StatusSet)} aria-label="Status">
                <option value="active">Active</option>
                <option value="scheduled">Scheduled</option>
                <option value="done">Done</option>
                <option value="all">All</option>
              </select>
            )}
            <select value={priority} onChange={(e) => setPriority(e.target.value as "" | TaskPriority)} aria-label="Priority">
              <option value="">Any priority</option>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p[0].toUpperCase() + p.slice(1)}
                </option>
              ))}
            </select>
            {projectNames.length > 1 && (
              <select value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project">
                <option value="">All projects</option>
                {projectNames.map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            )}
            {layout === "list" && (
              <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort">
                <option value="due">By due date</option>
                <option value="priority">By priority</option>
                <option value="recent">Recently updated</option>
              </select>
            )}
            {filtersOn && (
              <button type="button" className="btn-ghost btn-tiny wk-clear" onClick={clearFilters}>
                Clear
              </button>
            )}
            <span className="wk-spacer" />
            <label className="wk-chip" title="Sends due-date reminders and moves tasks along when you log work">
              <input type="checkbox" role="switch" checked={autoMode} onChange={(e) => setAutoMode(e.target.checked)} />
              Auto
            </label>
            <div className="wk-seg" role="group" aria-label="Layout">
              {(["list", "board", "calendar"] as Layout[]).map((l) => (
                <button key={l} type="button" className={layout === l ? "on" : undefined} aria-pressed={layout === l} onClick={() => setLayout(l)}>
                  {l[0].toUpperCase() + l.slice(1)}
                </button>
              ))}
            </div>
          </div>

          {layout === "list" && (
            <TaskList
              rows={rows}
              grouped={sort === "due"}
              today={today}
              selectedId={selected?.id}
              showOwner={view !== "mine"}
              onOpen={open}
              empty={
                <EmptyState
                  title={filtersOn ? "No tasks match" : view === "mine" ? "Nothing on your list" : "No tasks here"}
                  action={
                    filtersOn ? (
                      <button type="button" className="btn-ghost" onClick={clearFilters}>
                        Clear filters
                      </button>
                    ) : (
                      <button type="button" className="btn-ghost" onClick={() => setShowNew(true)}>
                        New task
                      </button>
                    )
                  }
                />
              }
            />
          )}

          {layout === "board" && (
            <div className="wk-board">
              {(
                [
                  ["todo", "To do"],
                  ["progress", "In progress"],
                  ["review", "In review"],
                  ["blocked", "Blocked"],
                  ["done", "Done"],
                ] as [Column, string][]
              ).map(([col, label]) => {
                const cards = rows.filter((t) => columnOf(t) === col || (col === "todo" && t.status === "scheduled"));
                return (
                  <section
                    key={col}
                    className={dragOver === col ? "wk-col drop" : "wk-col"}
                    aria-label={label}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragOver(col);
                    }}
                    onDragLeave={() => setDragOver("")}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDragOver("");
                      dropOn(col, e.dataTransfer.getData("text/plain"));
                    }}
                  >
                    <div className="wk-col-head">
                      <span className={`wk-dot ${DOT[col]}`} aria-hidden="true" />
                      {label}
                      <span className="wk-count">{cards.length}</span>
                    </div>
                    {cards.map((t) => {
                      const dc = dueClass(t, today);
                      return (
                        <button
                          key={t.id}
                          type="button"
                          draggable={t.status !== "done"}
                          onDragStart={(e) => e.dataTransfer.setData("text/plain", t.id)}
                          className={`wk-card p-${t.priority}${t.id === selected?.id ? " on" : ""}`}
                          onClick={() => open(t.id)}
                        >
                          <span className="wk-meta">
                            <code>{t.code}</code>
                            {t.status === "scheduled" && <span>Scheduled</span>}
                            <span>{t.projectName || t.client}</span>
                          </span>
                          <span className="wk-card-title">{t.subject}</span>
                          <span className="wk-card-foot">
                            {t.due && <span className={`wk-chip ${dc}`}>{dueText(t.due, today, formatShortDate)}</span>}
                            <PriorityChip priority={t.priority} />
                            <Avatar name={taskPersonById(t.employeeId)?.fullName ?? t.owner} />
                          </span>
                        </button>
                      );
                    })}
                    {cards.length === 0 && <p className="wk-col-empty">Empty</p>}
                  </section>
                );
              })}
            </div>
          )}

          {layout === "calendar" && (
            <Card
              title={new Date(cal.y, cal.m, 1).toLocaleString("en-GB", { month: "long", year: "numeric" })}
              action={
                <div className="wk-seg">
                  <button type="button" onClick={() => setCal((c) => ({ y: c.m === 0 ? c.y - 1 : c.y, m: (c.m + 11) % 12 }))} aria-label="Previous month">
                    ‹
                  </button>
                  <button type="button" onClick={() => setCal({ y: new Date().getFullYear(), m: new Date().getMonth() })}>
                    Today
                  </button>
                  <button type="button" onClick={() => setCal((c) => ({ y: c.m === 11 ? c.y + 1 : c.y, m: (c.m + 1) % 12 }))} aria-label="Next month">
                    ›
                  </button>
                </div>
              }
            >
              <div className="task-cal">
                {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
                  <div key={d} className="task-cal-head">
                    {d}
                  </div>
                ))}
                {monthCells(cal.y, cal.m).map((date, i) => {
                  const due = date ? rows.filter((t) => t.due === date) : [];
                  return (
                    <div key={date ?? `pad-${i}`} className={`task-cal-cell${date === today ? " today" : ""}${due.length ? " has-due" : ""}`}>
                      {date && <span className="task-cal-day">{Number(date.slice(8))}</span>}
                      {due.slice(0, 3).map((t) => (
                        <button key={t.id} type="button" className={`task-cal-chip ${t.priority}`} title={t.subject} onClick={() => open(t.id)}>
                          {t.code}
                        </button>
                      ))}
                      {due.length > 3 && <span className="muted">+{due.length - 3}</span>}
                    </div>
                  );
                })}
              </div>
            </Card>
          )}
        </>
      )}

      {selected && <TaskDrawer key={selected.id} task={selected} scope={scope} assignable={assignable} onClose={() => open(null)} onOpen={open} />}

      {showNew && (
        <NewTaskDialog
          assignable={assignable}
          teamIds={teamIds}
          tasks={scope}
          projectOptions={[...new Set([...state.projects.map((p) => p.name), ...projects.map((p) => p.name)])]}
          onClose={() => setShowNew(false)}
          onCreated={(ownerId) => {
            setShowNew(false);
            setView(ownerId === me ? "mine" : "byme");
            setStatusSet("active");
          }}
        />
      )}
    </Page>
  );
}

function TaskList({
  rows,
  grouped,
  today,
  selectedId,
  showOwner,
  onOpen,
  empty,
}: {
  rows: Task[];
  grouped: boolean;
  today: string;
  selectedId?: string;
  showOwner: boolean;
  onOpen: (id: string) => void;
  empty: ReactNode;
}) {
  if (rows.length === 0) return <div className="wk-list">{empty}</div>;
  const groups = grouped
    ? BUCKETS.map((b) => [b, rows.filter((t) => bucketOf(t, today) === b)] as const).filter(([, list]) => list.length)
    : ([["", rows]] as const);
  return (
    <div className="wk-list">
      {groups.map(([name, list]) => (
        <div key={name || "all"}>
          {name && (
            <div className={name === "Overdue" ? "wk-group late" : "wk-group"}>
              {name} <span className="wk-count">{list.length}</span>
            </div>
          )}
          <ul className="wk-rows">
            {list.map((t) => {
              const col = columnOf(t);
              const dc = dueClass(t, today);
              const checks = t.subtasks ?? [];
              const ownerName = taskPersonById(t.employeeId)?.fullName ?? t.owner;
              return (
                <li key={t.id}>
                  <button
                    type="button"
                    className={`wk-row p-${t.priority}${t.id === selectedId ? " on" : ""}${t.status === "done" ? " is-done" : ""}`}
                    onClick={() => onOpen(t.id)}
                  >
                    <span className={`wk-dot ${DOT[col]}`} title={taskStatusLabel(t)} />
                    <span className="wk-main">
                      <span className="wk-title">{t.subject}</span>
                      <span className="wk-meta">
                        <code>{t.code}</code>
                        <span>{taskStatusLabel(t)}</span>
                        <span>{t.projectName || t.client}</span>
                        {checks.length > 0 && (
                          <span>
                            ☑ {checks.filter((c) => c.done).length}/{checks.length}
                          </span>
                        )}
                        {(t.comments?.length ?? 0) > 0 && <span>💬 {t.comments!.length}</span>}
                        {isTaskBlocked(t) && <span style={{ color: "var(--danger)" }}>Blocked</span>}
                      </span>
                    </span>
                    <span className="wk-who">
                      {showOwner ? (
                        <>
                          <Avatar name={ownerName} />
                          <span>{ownerName}</span>
                        </>
                      ) : (
                        <span className="muted">from {t.assignedBy}</span>
                      )}
                    </span>
                    <span className="wk-hide-sm">
                      {t.due ? <span className={`wk-chip ${dc}`}>{t.status === "done" ? formatShortDate(t.due) : dueText(t.due, today, formatShortDate)}</span> : <span className="muted">—</span>}
                    </span>
                    <span className="wk-cell-end">
                      <PriorityChip priority={t.priority} />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

function Workload({ tasks, today, onOpen }: { tasks: Task[]; today: string; onOpen: (id: string) => void }) {
  const people = [...new Set(tasks.map((t) => t.employeeId))]
    .map((id) => {
      const theirs = tasks.filter((t) => t.employeeId === id);
      const active = theirs.filter((t) => t.status !== "done" && t.status !== "scheduled");
      const done = theirs.filter((t) => t.status === "done");
      const next = active.filter((t) => t.due).sort((a, b) => a.due.localeCompare(b.due))[0];
      return {
        id,
        name: taskPersonById(id)?.fullName ?? theirs[0]?.owner ?? id,
        active: active.length,
        late: active.filter((t) => isTaskOverdue(t, today)).length,
        hot: active.filter((t) => t.priority === "urgent" || t.priority === "high").length,
        blocked: active.filter((t) => isTaskBlocked(t)).length,
        done: done.length,
        onTime: done.filter((t) => t.due && t.lastActivityAt.slice(0, 10) <= t.due).length,
        next,
      };
    })
    .sort((a, b) => b.late - a.late || b.active - a.active);
  if (people.length === 0) return <EmptyState title="No team tasks yet" />;
  return (
    <Card title={`Team workload · ${people.length} people`}>
      <div className="table-scroll">
        <table className="data">
          <thead>
            <tr>
              <th>Person</th>
              <th>Active</th>
              <th>Overdue</th>
              <th>Urgent / high</th>
              <th>Blocked</th>
              <th>Done</th>
              <th>On time</th>
              <th>Next due</th>
            </tr>
          </thead>
          <tbody>
            {people.map((p) => (
              <tr key={p.id}>
                <td>
                  <span className="wk-who">
                    <Avatar name={p.name} />
                    <span>{p.name}</span>
                  </span>
                </td>
                <td>{p.active}</td>
                <td style={p.late ? { color: "var(--danger)", fontWeight: 600 } : undefined}>{p.late}</td>
                <td>{p.hot}</td>
                <td>{p.blocked}</td>
                <td>{p.done}</td>
                <td>{p.done ? `${Math.round((p.onTime / p.done) * 100)}%` : "—"}</td>
                <td>
                  {p.next ? (
                    <button type="button" className="link-btn" onClick={() => onOpen(p.next!.id)}>
                      {formatShortDate(p.next.due)} · {p.next.code}
                    </button>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

type Assignable = { person: TaskTeamPerson; group: string }[];

function TaskDrawer({
  task: t,
  scope,
  assignable,
  onClose,
  onOpen,
}: {
  task: Task;
  scope: Task[];
  assignable: Assignable;
  onClose: () => void;
  onOpen: (id: string) => void;
}) {
  const {
    state,
    employee,
    taskAction,
    editTask,
    toggleTaskSubtask,
    addTaskSubtask,
    removeTaskSubtask,
    addTaskComment,
    reassignTask,
    addTaskPerson,
    removeTaskPerson,
    moveTask,
    canApproveLeaveFor,
  } = usePortal();
  const me = employee.id;
  const today = todayISO();
  const hasManager = managementChain(me).length > 0;
  const isOwn = t.employeeId === me;
  const isCreator = t.createdById === me;
  const managesOwner = !isOwn && canApproveLeaveFor(t.employeeId);
  const canAct = (isOwn || managesOwner) && t.status !== "done";
  const canEdit = (isCreator || managesOwner) && t.status !== "done";
  const canReview = (managesOwner || (isCreator && !isOwn)) && t.status !== "done";
  const follower = !isOwn && !managesOwner && !isCreator;
  const canComment = isOwn || managesOwner || isCreator || !!t.ccIds?.includes(me) || !!t.peopleIds?.includes(me);
  const blocked = isTaskBlocked(t);
  const col = columnOf(t);
  const pct = taskProgress(t);
  const late = isTaskOverdue(t, today);

  const [form, setForm] = useState<"" | "block" | "help" | "decline" | "edit" | "progress">("");
  const [text, setText] = useState("");
  const [depends, setDepends] = useState("");
  const [pctDraft, setPctDraft] = useState(Math.max(pct, 10));
  const [comment, setComment] = useState("");
  const [mentions, setMentions] = useState<string[]>([]);
  const [newCheck, setNewCheck] = useState("");
  const [addPerson, setAddPerson] = useState("");
  const [edit, setEdit] = useState({ subject: t.subject, notes: t.notes });

  function act(action: Action, payload?: { progressPct?: number; blockedReason?: string; dependsOn?: string; comment?: string }, ok?: string) {
    const error = taskAction(t.id, action, payload);
    if (error) return error;
    notify(ok ?? "Task updated.");
    setForm("");
    setText("");
    setDepends("");
    return null;
  }
  const result = (error: string | null, ok: string) => {
    if (error) notify(error, "err");
    else notify(ok);
    return error;
  };

  const ownerName = taskPersonById(t.employeeId)?.fullName ?? t.owner;
  const related = t.referenceTaskId ? state.tasks.find((x) => x.id === t.referenceTaskId) : undefined;
  const feed = [
    ...(t.comments ?? []).map((c) => ({ kind: "comment" as const, id: c.id, at: c.at, who: c.author, text: c.text })),
    ...(t.activity ?? [])
      .filter((a) => a.action !== "Commented")
      .map((a) => ({ kind: "event" as const, id: a.id, at: a.at, who: a.actor, text: `${a.action}${a.detail ? ` · ${a.detail}` : ""}` })),
  ].sort((a, b) => b.at.localeCompare(a.at));

  const statusName = taskStatusLabel(t);
  const canChecklist = (isOwn || isCreator || managesOwner) && t.status !== "done";
  const mentionPool = TASK_TEAM.filter((p) => p.id !== me && !mentions.includes(p.id));
  // Handing a task over or adding people stays within your own team (HR: anyone), as the store and server allow.
  const owners = assignable.filter((x) => x.group === "Your team" || x.group === "Everyone");

  const foot = (
    <>
      {t.status === "scheduled" && managesOwner && (
        <ActionButton
          className="btn"
          onAction={() => {
            moveTask(t.id, "open");
            notify("Task released.");
          }}
        >
          Release
        </ActionButton>
      )}
      {canAct && t.status === "open" && !t.accepted && !blocked && isOwn && (
        <>
          <ActionButton className="btn" onAction={() => act("accept", undefined, "Task accepted.")}>
            Accept
          </ActionButton>
          {!t.activity?.some((a) => a.action === "Declined") && (
            <button type="button" className="btn-ghost" onClick={() => setForm("decline")}>
              Decline
            </button>
          )}
        </>
      )}
      {canAct && t.status === "open" && (t.accepted || !isOwn) && !blocked && (
        <ActionButton className="btn" onAction={() => act("start", undefined, "Task started.")}>
          Start
        </ActionButton>
      )}
      {canAct && t.status === "progress" && !blocked && !t.inReview && (
        <>
          {isOwn && !isCreator && hasManager ? (
            <ActionButton className="btn" onAction={() => act("review", undefined, hasManager ? "Sent for review." : "Submitted.")}>
              Send for review
            </ActionButton>
          ) : (
            <ActionButton className="btn" onAction={() => act("complete", undefined, "Task done.")}>
              Mark done
            </ActionButton>
          )}
          <button type="button" className="btn-ghost" onClick={() => setForm("progress")}>
            Update progress
          </button>
        </>
      )}
      {t.inReview && canReview && !blocked && (
        <>
          <ActionButton className="btn" onAction={() => act("complete", undefined, "Task done.")}>
            Approve and close
          </ActionButton>
          <ActionButton className="btn-ghost" onAction={() => act("progress", { progressPct: Math.min(pct, 80) }, "Sent back.")}>
            Send back
          </ActionButton>
        </>
      )}
      {canAct && blocked && (
        <ActionButton className="btn" onAction={() => act("unblock", undefined, "Blocker cleared.")}>
          Clear blocker
        </ActionButton>
      )}
      {canAct && t.status !== "scheduled" && (t.accepted || !isOwn) && !t.inReview && (
        <button type="button" className="btn-ghost" onClick={() => setForm("block")}>
          {blocked ? "Update blocker" : "Blocked"}
        </button>
      )}
      {canAct && isOwn && hasManager && t.status !== "scheduled" && (
        <button type="button" className="btn-ghost" onClick={() => setForm("help")}>
          Ask for help
        </button>
      )}
      <span className="wk-spacer" />
      {isOwn && t.accepted && (t.status === "open" || t.status === "progress") && (
        <Link className="btn-ghost" to={`/timesheet?work=task:${encodeURIComponent(t.id)}`}>
          Log time
        </Link>
      )}
    </>
  );

  return (
    <Drawer
      label={`${t.code} ${t.subject}`}
      onClose={onClose}
      head={
        <>
          <div className="wk-dhead-top">
            <span className={`wk-dot ${DOT[col]}`} aria-hidden="true" />
            <span className="wk-status">{statusName}</span>
            <code>{t.code}</code>
            {canEdit && form !== "edit" && (
              <button type="button" className="btn-ghost btn-tiny" onClick={() => setForm("edit")}>
                Edit
              </button>
            )}
            <button type="button" className="wk-x" aria-label="Close" onClick={onClose}>
              ×
            </button>
          </div>
          <h2>{t.subject}</h2>
          <div className="wk-dhead-chips">
            <PriorityChip priority={t.priority} />
            {t.due && <span className={`wk-chip ${dueClass(t, today)}`}>Due {formatShortDate(t.due)}</span>}
            {t.taskType && <span className="wk-chip">{t.taskType}</span>}
            {(t.projectName || t.client) && <span className="wk-chip">{t.projectName || t.client}</span>}
          </div>
        </>
      }
      foot={canAct || canReview ? foot : undefined}
    >
      {form === "edit" && (
        <div className="wk-inline-form">
          <label className="field">
            Name
            <input value={edit.subject} maxLength={120} onChange={(e) => setEdit({ ...edit, subject: e.target.value })} />
          </label>
          <label className="field">
            Description
            <textarea rows={4} value={edit.notes} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} />
          </label>
          <div className="wk-compose-actions">
            <ActionButton
              className="btn btn-tiny"
              onAction={() => {
                const error = editTask(t.id, edit);
                if (!error) setForm("");
                return result(error, "Task saved.");
              }}
            >
              Save
            </ActionButton>
            <button type="button" className="btn-ghost btn-tiny" onClick={() => setForm("")}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {(form === "block" || form === "help" || form === "decline") && (
        <div className="wk-inline-form">
          <label className="field">
            {form === "block" ? "What is blocking it?" : form === "help" ? "What do you need?" : "Why are you declining?"}
            <input value={text} onChange={(e) => setText(e.target.value)} autoFocus />
          </label>
          {form === "block" && (
            <label className="field">
              Waiting on (optional)
              <input value={depends} onChange={(e) => setDepends(e.target.value)} placeholder="e.g. TSK-1080, access to staging" />
            </label>
          )}
          <div className="wk-compose-actions">
            <ActionButton
              className="btn btn-tiny"
              onAction={() =>
                form === "block"
                  ? act("block", { blockedReason: text, dependsOn: depends }, "Marked blocked.")
                  : form === "help"
                    ? act("help", { comment: text || "Need guidance on this task." }, "Help request sent.")
                    : act("decline", { comment: text }, "Task declined.")
              }
            >
              {form === "block" ? "Save blocker" : form === "help" ? "Send" : "Decline task"}
            </ActionButton>
            <button type="button" className="btn-ghost btn-tiny" onClick={() => setForm("")}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {form === "progress" && (
        <div className="wk-inline-form">
          <label className="field">
            Progress · {pctDraft}%
            <input type="range" min={0} max={99} step={5} value={pctDraft} onChange={(e) => setPctDraft(Number(e.target.value))} />
          </label>
          <div className="wk-compose-actions">
            <ActionButton className="btn btn-tiny" onAction={() => act("progress", { progressPct: pctDraft }, "Progress updated.")}>
              Save
            </ActionButton>
            <button type="button" className="btn-ghost btn-tiny" onClick={() => setForm("")}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {t.status !== "done" && !follower && (
        <div className={late || blocked ? "wk-next late" : "wk-next"}>
          <span>{blocked ? `Blocked: ${t.blocked}` : late ? `Overdue by ${-dayGap(today, t.due)} day(s)` : "Next step"}</span>
          {nextTaskActionHint(t)}
        </div>
      )}

      <dl className="wk-facts">
        <div className="wk-fact">
          <dt>Owner</dt>
          <dd>
            {managesOwner && t.status !== "done" ? (
              <select
                value={t.employeeId}
                aria-label="Owner"
                onChange={(e) => result(reassignTask(t.id, e.target.value), "Owner changed.")}
              >
                {!owners.some((x) => x.person.id === t.employeeId) && <option value={t.employeeId}>{ownerName}</option>}
                {owners.map((x) => (
                  <option key={x.person.id} value={x.person.id}>
                    {x.person.fullName}
                  </option>
                ))}
              </select>
            ) : (
              <>
                <Avatar name={ownerName} />
                {ownerName}
              </>
            )}
          </dd>
        </div>
        <div className="wk-fact">
          <dt>Assigned by</dt>
          <dd>{t.assignedBy}</dd>
        </div>
        <div className="wk-fact">
          <dt>Due</dt>
          <dd>
            {canEdit ? (
              <input type="date" value={t.due} aria-label="Due date" onChange={(e) => result(editTask(t.id, { due: e.target.value }), "Due date changed.")} />
            ) : (
              <span className={late ? "wk-chip late" : undefined}>{t.due ? formatShortDate(t.due) : "—"}</span>
            )}
          </dd>
        </div>
        <div className="wk-fact">
          <dt>Start</dt>
          <dd>
            {canEdit ? (
              <input
                type="date"
                value={t.startDate ?? ""}
                max={t.due || undefined}
                aria-label="Start date"
                onChange={(e) => result(editTask(t.id, { startDate: e.target.value }), "Start date changed.")}
              />
            ) : (
              <span>{t.startDate ? formatShortDate(t.startDate) : "—"}</span>
            )}
          </dd>
        </div>
        <div className="wk-fact">
          <dt>Priority</dt>
          <dd>
            {canEdit ? (
              <select value={t.priority} aria-label="Priority" onChange={(e) => result(editTask(t.id, { priority: e.target.value as TaskPriority }), "Priority changed.")}>
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {p[0].toUpperCase() + p.slice(1)}
                  </option>
                ))}
              </select>
            ) : (
              <PriorityChip priority={t.priority} />
            )}
          </dd>
        </div>
        <div className="wk-fact">
          <dt>Progress</dt>
          <dd>
            <span className="wk-mini-bar" aria-hidden="true">
              <i style={{ width: `${pct}%` }} />
            </span>
            {pct}%
          </dd>
        </div>
        <div className="wk-fact">
          <dt>Time</dt>
          <dd>
            {t.hoursSpent}h of {t.estimatedHours}h
          </dd>
        </div>
        {(related || t.dependsOn) && (
          <div className="wk-fact wide">
            <dt>{related ? "Related task" : "Waiting on"}</dt>
            <dd>
              {related &&
                (scope.some((x) => x.id === related.id) ? (
                  <button type="button" className="link-btn" onClick={() => onOpen(related.id)}>
                    {related.code} · {related.subject}
                  </button>
                ) : (
                  related.code
                ))}
              {t.dependsOn && <span>{related ? ` · waiting on ${t.dependsOn}` : t.dependsOn}</span>}
            </dd>
          </div>
        )}
      </dl>

      <section className="wk-sec">
        <h3>Description</h3>
        <p className={t.notes ? "wk-desc" : "wk-desc empty"}>{t.notes || "No description."}</p>
        {(t.links?.length ?? 0) > 0 && (
          <ul className="wk-links">
            {t.links!.map((link) => (
              <li key={link.url}>
                <a href={link.url} target="_blank" rel="noopener noreferrer">
                  {link.label}
                </a>
                <span> · {hostOf(link.url)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {((t.subtasks?.length ?? 0) > 0 || canChecklist) && (
        <section className="wk-sec">
          <h3>
            Checklist
            <span className="wk-count">
              {(t.subtasks ?? []).filter((s) => s.done).length}/{t.subtasks?.length ?? 0}
            </span>
          </h3>
          {(t.subtasks?.length ?? 0) > 0 && (
            <div className="wk-bar" aria-hidden="true">
              <i style={{ width: `${((t.subtasks ?? []).filter((s) => s.done).length / (t.subtasks?.length || 1)) * 100}%` }} />
            </div>
          )}
          <ul className="wk-check">
            {(t.subtasks ?? []).map((s) => (
              <li key={s.id} className={s.done ? "done" : undefined}>
                <input
                  type="checkbox"
                  checked={s.done}
                  disabled={!canAct || t.status === "scheduled"}
                  aria-label={s.title}
                  onChange={() => result(toggleTaskSubtask(t.id, s.id), "Checklist updated.")}
                />
                <span className="wk-check-title">{s.title}</span>
                <span />
                <span />
                {canChecklist ? (
                  <button type="button" className="wk-x" aria-label={`Remove ${s.title}`} onClick={() => result(removeTaskSubtask(t.id, s.id), "Checklist item removed.")}>
                    ×
                  </button>
                ) : (
                  <span />
                )}
              </li>
            ))}
          </ul>
          {canChecklist && (
            <form
              className="wk-inline"
              onSubmit={(e) => {
                e.preventDefault();
                if (!result(addTaskSubtask(t.id, newCheck), "Checklist item added.")) setNewCheck("");
              }}
            >
              <input value={newCheck} maxLength={160} onChange={(e) => setNewCheck(e.target.value)} placeholder="Add a checklist item" aria-label="New checklist item" />
              <button type="submit" className="btn-ghost btn-tiny" disabled={!newCheck.trim()}>
                Add
              </button>
            </form>
          )}
        </section>
      )}

      <section className="wk-sec">
        <h3>
          Attachments <span className="wk-count">{t.attachments?.length ?? 0}</span>
        </h3>
        <FileList
          files={(t.attachments ?? []).map((a) => ({ id: a.id, name: a.name, size: a.size, at: a.at, by: a.by ? taskPersonById(a.by)?.fullName : undefined }))}
          canAdd={canComment && API_ENABLED}
          offlineNote={API_ENABLED ? undefined : "Files can be attached when TimeZ is connected to the server."}
          canRemove={(f) => {
            const a = (t.attachments ?? []).find((x) => x.id === f.id);
            return !!a && (a.by === me || isOwn || isCreator || managesOwner);
          }}
          onAdd={async (file) => result(await uploadTaskFile(t.id, file), "File attached.")}
          onOpen={async (f) => {
            const error = await openWorkFile(taskFilePath(t.id, f.id));
            if (error) notify(error, "err");
          }}
          onRemove={async (f) => result(await removeTaskFile(t.id, f.id), "File removed.")}
        />
      </section>

      <section className="wk-sec">
        <h3>People</h3>
        <div className="wk-people">
          <span className="wk-person">
            <Avatar name={ownerName} />
            {ownerName} <em>owner</em>
          </span>
          {(t.peopleIds ?? []).map((id) => {
            const name = taskPersonById(id)?.fullName ?? id;
            return (
              <span key={id} className="wk-person">
                <Avatar name={name} />
                {name}
                {managesOwner && t.status !== "done" && (
                  <button type="button" aria-label={`Remove ${name}`} onClick={() => result(removeTaskPerson(t.id, id), `${name} removed.`)}>
                    ×
                  </button>
                )}
              </span>
            );
          })}
          {(t.ccIds ?? []).map((id) => {
            const name = taskPersonById(id)?.fullName ?? id;
            return (
              <span key={`cc-${id}`} className="wk-person">
                <Avatar name={name} />
                {name} <em>cc</em>
              </span>
            );
          })}
        </div>
        {managesOwner && t.status !== "done" && (
          <div className="wk-inline">
            <select value={addPerson} onChange={(e) => setAddPerson(e.target.value)} aria-label="Add a person">
              <option value="">Add a teammate…</option>
              {assignable
                .filter((x) => x.person.id !== t.employeeId && !(t.peopleIds ?? []).includes(x.person.id) && owners.includes(x))
                .map((x) => (
                  <option key={x.person.id} value={x.person.id}>
                    {x.person.fullName}
                  </option>
                ))}
            </select>
            <ActionButton
              className="btn-ghost btn-tiny"
              disabled={!addPerson}
              onAction={() => {
                const error = addTaskPerson(t.id, addPerson);
                if (!error) setAddPerson("");
                return result(error, "Person added.");
              }}
            >
              Add
            </ActionButton>
          </div>
        )}
      </section>

      <section className="wk-sec">
        <h3>
          Conversation <span className="wk-count">{t.comments?.length ?? 0}</span>
        </h3>
        {canComment && (
          <div className="wk-compose">
            <textarea value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Write a comment" aria-label="Comment" rows={2} />
            <div className="wk-compose-actions">
              {mentions.map((id) => (
                <span key={id} className="wk-mention">
                  @{taskPersonById(id)?.fullName ?? id}
                  <button type="button" aria-label="Remove mention" onClick={() => setMentions(mentions.filter((x) => x !== id))}>
                    ×
                  </button>
                </span>
              ))}
              <select
                value=""
                aria-label="Mention someone"
                className="wk-mention-pick"
                onChange={(e) => {
                  const id = e.target.value;
                  if (!id) return;
                  setMentions([...mentions, id]);
                  const name = taskPersonById(id)?.fullName ?? id;
                  if (!comment.includes(`@${name}`)) setComment(`${comment}${comment && !comment.endsWith(" ") ? " " : ""}@${name} `);
                }}
              >
                <option value="">@ Mention</option>
                {mentionPool.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.fullName}
                  </option>
                ))}
              </select>
              <ActionButton
                className="btn btn-tiny"
                disabled={!comment.trim()}
                onAction={() => {
                  const error = addTaskComment(t.id, comment, mentions);
                  if (!error) {
                    setComment("");
                    setMentions([]);
                  }
                  return result(error, mentions.length ? "Comment posted. Mentioned people were notified." : "Comment posted.");
                }}
              >
                Comment
              </ActionButton>
            </div>
          </div>
        )}
        <ul className="wk-feed">
          {feed.map((f) =>
            f.kind === "comment" ? (
              <li key={f.id}>
                <Avatar name={f.who} />
                <div className="wk-bubble">
                  <header>
                    <b>{f.who}</b>
                    <time>{formatStamp(f.at)}</time>
                  </header>
                  <p>{f.text}</p>
                </div>
              </li>
            ) : (
              <li key={f.id}>
                <span className="wk-tick" aria-hidden="true" />
                <div className="wk-ev">
                  <b>{f.who}</b> {f.text} · <time>{formatStamp(f.at)}</time>
                </div>
              </li>
            ),
          )}
        </ul>
      </section>
    </Drawer>
  );
}

function NewTaskDialog({
  assignable,
  teamIds,
  tasks,
  projectOptions,
  onClose,
  onCreated,
}: {
  assignable: Assignable;
  teamIds: Set<string>;
  tasks: Task[];
  projectOptions: string[];
  onClose: () => void;
  onCreated: (ownerId: string) => void;
}) {
  const { employee, createTask } = usePortal();
  const today = todayISO();
  const [d, setD] = useState({
    subject: "",
    ownerId: employee.id,
    taskType: "Feature" as TaskType,
    priority: "medium" as TaskPriority,
    status: "open" as TaskStatus,
    client: "",
    notes: "",
    due: toISO(new Date(Date.now() + 2 * 86_400_000)),
    startDate: "",
    checklist: "",
    estimatedHours: 4,
    peopleIds: [] as string[],
    ccIds: [] as string[],
    referenceTaskId: "",
    link: { label: "", url: "" } as TaskLink,
  });
  const [error, setError] = useState<string | null>(null);
  const groups = [...new Set(assignable.map((x) => x.group))];
  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const others = assignable.filter((x) => x.person.id !== d.ownerId && x.group !== "You");
  const ccPool = TASK_TEAM.filter((p) => p.id !== d.ownerId && p.id !== employee.id && !d.peopleIds.includes(p.id));

  function submit(e: FormEvent) {
    e.preventDefault();
    const result = createTask({
      ...d,
      checklist: d.checklist.split("\n"),
      client: d.client.trim() || "Internal",
      links: d.link.url.trim() ? [d.link] : [],
      allowedOwnerIds: assignable.map((x) => x.person.id),
    });
    if (result) {
      setError(result);
      return;
    }
    notify(d.ownerId === employee.id ? "Task added." : "Task assigned. The owner has been notified.");
    onCreated(d.ownerId);
  }

  return (
    <div className="modal-root" role="presentation">
      <button className="modal-scrim" type="button" aria-label="Close" onClick={onClose} />
      <div className="modal-card wk-modal" role="dialog" aria-modal="true" aria-labelledby="new-task-title">
        <h2 id="new-task-title">New task</h2>
        <form onSubmit={submit}>
          <div className="wk-form">
            <label className="wide">
              Title
              <input value={d.subject} maxLength={120} autoFocus onChange={(e) => setD({ ...d, subject: e.target.value })} placeholder="What needs doing?" />
            </label>
            <label>
              Owner
              <select
                value={d.ownerId}
                onChange={(e) =>
                  setD({
                    ...d,
                    ownerId: e.target.value,
                    status: teamIds.has(e.target.value) ? d.status : "open",
                    peopleIds: d.peopleIds.filter((x) => x !== e.target.value),
                    ccIds: d.ccIds.filter((x) => x !== e.target.value),
                  })
                }
              >
                {groups.map((g) => (
                  <optgroup key={g} label={g}>
                    {assignable
                      .filter((x) => x.group === g)
                      .map((x) => (
                        <option key={x.person.id} value={x.person.id}>
                          {x.person.id === employee.id ? `Me (${x.person.fullName})` : x.person.fullName}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </select>
            </label>
            <label>
              Start date
              <input type="date" min={today} max={d.due || undefined} value={d.startDate} onChange={(e) => setD({ ...d, startDate: e.target.value })} />
            </label>
            <label>
              Due date
              <input type="date" min={d.startDate || today} value={d.due} onChange={(e) => setD({ ...d, due: e.target.value })} />
            </label>
            <label>
              Priority
              <select value={d.priority} onChange={(e) => setD({ ...d, priority: e.target.value as TaskPriority })}>
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {p[0].toUpperCase() + p.slice(1)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Type
              <select value={d.taskType} onChange={(e) => setD({ ...d, taskType: e.target.value as TaskType })}>
                {TASK_TYPES.map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </label>
            <label>
              Project
              <input list="wk-projects" value={d.client} onChange={(e) => setD({ ...d, client: e.target.value })} placeholder="Internal" />
              <datalist id="wk-projects">
                {projectOptions.map((p) => (
                  <option key={p} value={p} />
                ))}
              </datalist>
            </label>
            <label>
              Estimate (hours)
              <input type="number" min={0.5} max={200} step={0.5} value={d.estimatedHours} onChange={(e) => setD({ ...d, estimatedHours: Number(e.target.value) })} />
            </label>
            {teamIds.has(d.ownerId) && (
              <label>
                Start
                <select value={d.status} onChange={(e) => setD({ ...d, status: e.target.value as TaskStatus })}>
                  <option value="open">Now</option>
                  <option value="scheduled">Later (I release it)</option>
                </select>
              </label>
            )}
            <label>
              Related task
              <select value={d.referenceTaskId} onChange={(e) => setD({ ...d, referenceTaskId: e.target.value })}>
                <option value="">None</option>
                {tasks
                  .filter((x) => x.status !== "done")
                  .map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.code} · {x.subject}
                    </option>
                  ))}
              </select>
            </label>
            <label className="wide">
              Description
              <textarea rows={3} value={d.notes} onChange={(e) => setD({ ...d, notes: e.target.value })} />
            </label>
            <label className="wide">
              Checklist (one item per line)
              <textarea rows={3} value={d.checklist} onChange={(e) => setD({ ...d, checklist: e.target.value })} placeholder={"Draft\nReview\nShare"} />
            </label>
            <label>
              Link title
              <input value={d.link.label} onChange={(e) => setD({ ...d, link: { ...d.link, label: e.target.value } })} placeholder="Spec" />
            </label>
            <label>
              Link address
              <input value={d.link.url} onChange={(e) => setD({ ...d, link: { ...d.link, url: e.target.value } })} placeholder="https://" />
            </label>
            {others.length > 0 && (
              <div className="wide">
                <p className="wk-hint">Working with</p>
                <div className="wk-picks">
                  {others.map((x) => (
                    <label key={x.person.id} className={d.peopleIds.includes(x.person.id) ? "wk-pick on" : "wk-pick"}>
                      <input
                        type="checkbox"
                        checked={d.peopleIds.includes(x.person.id)}
                        onChange={() => setD({ ...d, peopleIds: toggle(d.peopleIds, x.person.id), ccIds: d.ccIds.filter((id) => id !== x.person.id) })}
                      />
                      {x.person.fullName}
                    </label>
                  ))}
                </div>
              </div>
            )}
            <div className="wide">
              <p className="wk-hint">Keep informed (cc)</p>
              <div className="wk-picks">
                {ccPool.map((p) => (
                  <label key={p.id} className={d.ccIds.includes(p.id) ? "wk-pick on" : "wk-pick"}>
                    <input type="checkbox" checked={d.ccIds.includes(p.id)} onChange={() => setD({ ...d, ccIds: toggle(d.ccIds, p.id) })} />
                    {p.fullName}
                  </label>
                ))}
              </div>
            </div>
          </div>
          {error && <Banner message={{ tone: "err", text: error }} />}
          <div className="form-actions">
            <button type="button" className="btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn" disabled={!d.subject.trim()}>
              {d.ownerId === employee.id ? "Add task" : "Assign task"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
