/**
 * Projects people work on: details, milestones, tasks, updates / comments, documents and activity.
 *
 * Backend mode (VITE_API_URL): everything comes from /projects (backend/app/routers/projects.py) and is shared by the
 * whole team; hours logged / approved are summed on the server from everyone's timesheets.
 * Local mode: the same data lives in this browser (seeded from projectCatalog.ts); hours are the viewer's own
 * timesheet blocks plus the rest of the team's sample hours.
 *
 * Members see a project; its manager (and HR / admin) edit it. A task's assignee moves its status along.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { addDaysISO, todayISO } from "../model.ts";
import { API_ENABLED, api } from "../api/client.ts";
import { apiDelete, apiPut, createMirror, downloadBlob, errorText, uploadRaw } from "../api/syncShared.ts";
import { notify as notifyPerson, newId, personName } from "../features/workforce/workforceShared.ts";
import { CATALOG_FOR_STORE } from "./projectCatalog.ts";

export type TaskStatus = "todo" | "in_progress" | "in_review" | "done";
export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
};

export type TaskPriority = "low" | "medium" | "high" | "urgent";
export const TASK_PRIORITIES: TaskPriority[] = ["urgent", "high", "medium", "low"];
export type ProjectStatus = "planned" | "active" | "on_hold" | "completed" | "cancelled";
export const PROJECT_STATUS_LABEL: Record<ProjectStatus, string> = {
  planned: "Planned",
  active: "Active",
  on_hold: "On hold",
  completed: "Completed",
  cancelled: "Cancelled",
};
export type HealthCall = "on_track" | "at_risk" | "off_track";
export const HEALTH_CALL_LABEL: Record<HealthCall, ProjectHealth> = { on_track: "On track", at_risk: "At risk", off_track: "Delayed" };

export interface PMilestone {
  id: string;
  name: string;
  description?: string | null;
  due: string;
  completedOn?: string | null;
}

/** Progress of a milestone from its tasks (estimated hours done, else the count done); 100 once completed. */
export function milestoneProgress(p: Pick<ProjectInfo, "tasks">, m: PMilestone): { pct: number; done: number; total: number } {
  const tasks = p.tasks.filter((t) => t.milestoneId === m.id);
  const done = tasks.filter((t) => t.status === "done");
  if (m.completedOn) return { pct: 100, done: done.length, total: tasks.length };
  if (!tasks.length) return { pct: 0, done: 0, total: 0 };
  const est = tasks.reduce((a, t) => a + (t.estimate || 0), 0);
  const pct = est > 0 ? (done.reduce((a, t) => a + (t.estimate || 0), 0) / est) * 100 : (done.length / tasks.length) * 100;
  return { pct: Math.round(pct), done: done.length, total: tasks.length };
}

export interface PTask {
  id: string;
  code: string;
  title: string;
  description?: string | null;
  assigneeId?: string | null;
  assigneeName?: string | null;
  milestoneId?: string | null;
  due?: string | null;
  estimate: number;
  status: TaskStatus;
  loggedHours: number;
  priority?: TaskPriority;
}

export interface PMember {
  employeeId: string;
  name: string;
  jobTitle: string;
  role: string;
  title?: string | null;
  responsibilities?: string | null;
  budgetHours?: number | null;
  loggedHours: number;
  /** Share of the person's week planned for this project (0-100). */
  allocationPct?: number | null;
}

export interface PPost {
  id: string;
  authorId: string;
  authorName: string;
  kind: "update" | "comment";
  body: string;
  at: string;
}

export interface PDoc {
  id: string;
  title: string;
  url?: string | null;
  fileName?: string | null;
  contentType?: string | null;
  size?: number | null;
  /** Local mode only: the file itself (data URL). */
  dataUrl?: string;
  addedBy: string;
  addedByName: string;
  at: string;
}

export interface PActivity {
  id: string;
  who: string;
  text: string;
  on: string;
}

export interface ProjectInfo {
  id: string;
  code: string;
  name: string;
  client: string;
  active: boolean;
  description: string;
  start: string;
  end: string;
  budgetHours: number | null;
  managerId: string | null;
  managerName: string;
  status: ProjectStatus;
  /** The manager's health call; null = worked out from dates and hours (healthOf). */
  healthCall: HealthCall | null;
  canEdit: boolean;
  myTitle: string;
  myResponsibilities: string;
  myBudgetHours: number | null;
  loggedHours: number;
  approvedHours: number;
  myLoggedHours: number;
  myApprovedHours: number;
  members: PMember[];
  milestones: PMilestone[];
  tasks: PTask[];
  posts: PPost[];
  documents: PDoc[];
  activity: PActivity[];
  /** Posts, documents and activity are loaded (backend mode loads them when the project is opened). */
  full: boolean;
}

/* ───────── derived facts (both modes) ───────── */

export type ProjectHealth = "On track" | "At risk" | "Delayed" | "Completed";

/** Completion from the work itself: estimated hours of done tasks, else milestones done. Not hours spent. */
export function completionOf(p: Pick<ProjectInfo, "tasks" | "milestones" | "active">): { pct: number; basis: string } {
  const est = p.tasks.reduce((a, t) => a + (t.estimate || 0), 0);
  if (p.tasks.length && est > 0) {
    const done = p.tasks.filter((t) => t.status === "done").reduce((a, t) => a + (t.estimate || 0), 0);
    return {
      pct: Math.round((done / est) * 100),
      basis: `${p.tasks.filter((t) => t.status === "done").length} of ${p.tasks.length} tasks done (${round(done)} of ${round(est)} estimated h)`,
    };
  }
  if (p.milestones.length) {
    const done = p.milestones.filter((m) => m.completedOn).length;
    return { pct: Math.round((done / p.milestones.length) * 100), basis: `${done} of ${p.milestones.length} milestones done` };
  }
  return { pct: p.active ? 0 : 100, basis: p.active ? "No tasks or milestones yet" : "Project closed" };
}

export function nextMilestone(p: Pick<ProjectInfo, "milestones">): PMilestone | undefined {
  return [...p.milestones].filter((m) => !m.completedOn).sort((a, b) => a.due.localeCompare(b.due))[0];
}

/** Health from real dates and hours: closed → Completed; an open milestone past due → Delayed; hours used running
 * well ahead of completion, or the next milestone due within a week with open tasks → At risk. */
export function healthOf(p: ProjectInfo, today = todayISO()): ProjectHealth {
  if (p.status === "completed" || p.status === "cancelled") return "Completed";
  if (p.healthCall) return HEALTH_CALL_LABEL[p.healthCall];
  const done = completionOf(p).pct;
  if (!p.active || (done === 100 && p.milestones.every((m) => m.completedOn))) return "Completed";
  if (p.milestones.some((m) => !m.completedOn && m.due < today)) return "Delayed";
  const used = p.budgetHours ? (p.loggedHours / p.budgetHours) * 100 : 0;
  const next = nextMilestone(p);
  const soon = next && next.due <= addDaysISO(today, 7) && p.tasks.some((t) => t.milestoneId === next.id && t.status !== "done");
  return used > done + 20 || soon ? "At risk" : "On track";
}

export interface DeadlineAlert {
  tone: "danger" | "warn" | "info";
  text: string;
}

/** Overdue / due-soon milestones and tasks, and the project end date. */
export function deadlineAlerts(p: ProjectInfo, viewerId: string, today = todayISO()): DeadlineAlert[] {
  const out: DeadlineAlert[] = [];
  const soon = addDaysISO(today, 7);
  for (const m of p.milestones) {
    if (m.completedOn) continue;
    if (m.due < today) out.push({ tone: "danger", text: `Milestone “${m.name}” is overdue (due ${m.due}).` });
    else if (m.due <= soon) out.push({ tone: "warn", text: `Milestone “${m.name}” is due ${m.due}.` });
  }
  for (const t of p.tasks) {
    if (t.status === "done" || !t.due || t.assigneeId !== viewerId) continue;
    if (t.due < today) out.push({ tone: "danger", text: `Your task ${t.code} “${t.title}” is overdue (due ${t.due}).` });
    else if (t.due <= soon) out.push({ tone: "warn", text: `Your task ${t.code} “${t.title}” is due ${t.due}.` });
  }
  if (p.active && p.end && p.end >= today && p.end <= addDaysISO(today, 30)) out.push({ tone: "info", text: `The project ends on ${p.end}.` });
  if (p.budgetHours && p.loggedHours > p.budgetHours) out.push({ tone: "danger", text: `Hours used (${round(p.loggedHours)} h) are over the ${p.budgetHours} h budget.` });
  return out;
}

const round = (n: number) => Math.round(n * 100) / 100;

/* ───────── backend mode ───────── */

interface ProjectOutApi {
  id: string;
  code: string;
  name: string;
  client: string | null;
  active: boolean;
  description: string | null;
  start_date: string | null;
  end_date: string | null;
  budget_hours: number | null;
  manager_id: string | null;
  manager_name: string | null;
  status?: ProjectStatus;
  health?: HealthCall | null;
  can_edit: boolean;
  my_title: string | null;
  my_responsibilities: string | null;
  my_budget_hours: number | null;
  logged_hours: number;
  approved_hours: number;
  my_logged_hours: number;
  my_approved_hours: number;
  members: { employee_id: string; name: string; job_title: string; role: string; title: string | null; responsibilities: string | null; budget_hours: number | null; logged_hours: number; allocation_pct?: number | null }[];
  milestones: { id: string; name: string; description: string | null; due_date: string; completed_on: string | null }[];
  tasks: { id: string; code: string; title: string; description: string | null; assignee_id: string | null; assignee_name: string | null; milestone_id: string | null; due_date: string | null; estimate_hours: number; status: string; logged_hours: number; priority?: TaskPriority }[];
  posts: { id: string; author_id: string; author_name: string; kind: string; body: string; created_at: string }[];
  documents: { id: string; title: string; url: string | null; file_name: string | null; content_type: string | null; size_bytes: number | null; added_by: string; added_by_name: string; created_at: string }[];
  activity: { id: string; actor_name: string; text: string; on: string }[];
}

function fromApi(p: ProjectOutApi, full: boolean): ProjectInfo {
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    client: p.client ?? "Internal",
    active: p.active,
    description: p.description ?? "",
    start: p.start_date ?? "",
    end: p.end_date ?? "",
    budgetHours: p.budget_hours,
    managerId: p.manager_id,
    managerName: p.manager_name ?? "",
    status: p.status ?? (p.active ? "active" : "completed"),
    healthCall: p.health ?? null,
    canEdit: p.can_edit,
    myTitle: p.my_title ?? "",
    myResponsibilities: p.my_responsibilities ?? "",
    myBudgetHours: p.my_budget_hours,
    loggedHours: p.logged_hours,
    approvedHours: p.approved_hours,
    myLoggedHours: p.my_logged_hours,
    myApprovedHours: p.my_approved_hours,
    members: p.members.map((m) => ({
      employeeId: m.employee_id,
      name: m.name,
      jobTitle: m.job_title,
      role: m.role,
      title: m.title,
      responsibilities: m.responsibilities,
      budgetHours: m.budget_hours,
      loggedHours: m.logged_hours,
      allocationPct: m.allocation_pct ?? null,
    })),
    milestones: p.milestones.map((m) => ({ id: m.id, name: m.name, description: m.description, due: m.due_date, completedOn: m.completed_on })),
    tasks: p.tasks.map((t) => ({
      id: t.id,
      code: t.code,
      title: t.title,
      description: t.description,
      assigneeId: t.assignee_id,
      assigneeName: t.assignee_name,
      milestoneId: t.milestone_id,
      due: t.due_date,
      estimate: t.estimate_hours,
      status: (t.status as TaskStatus) ?? "todo",
      loggedHours: t.logged_hours,
      priority: t.priority ?? "medium",
    })),
    posts: p.posts.map((x) => ({ id: x.id, authorId: x.author_id, authorName: x.author_name, kind: x.kind === "update" ? "update" : "comment", body: x.body, at: x.created_at })),
    documents: p.documents.map((d) => ({
      id: d.id,
      title: d.title,
      url: d.url,
      fileName: d.file_name,
      contentType: d.content_type,
      size: d.size_bytes,
      addedBy: d.added_by,
      addedByName: d.added_by_name,
      at: d.created_at,
    })),
    activity: p.activity.map((a) => ({ id: a.id, who: a.actor_name, text: a.text, on: a.on })),
    full,
  };
}

const listMirror = createMirror<ProjectOutApi[], ProjectInfo[]>(
  () => [],
  () => api.get<ProjectOutApi[]>("/projects"),
  (raw) => raw.map((p) => fromApi(p, false)),
);

const details = new Map<string, ProjectInfo>();
const detailListeners = new Set<() => void>();
const emitDetails = () => detailListeners.forEach((fn) => fn());

async function apiProjectCall(run: () => Promise<ProjectOutApi>): Promise<string | null> {
  try {
    const out = await run();
    details.set(out.id, fromApi(out, true));
    emitDetails();
    void listMirror.reload();
    return null;
  } catch (error) {
    return errorText(error);
  }
}

export async function loadProjectDetail(id: string): Promise<string | null> {
  if (!API_ENABLED) return null;
  return apiProjectCall(() => api.get<ProjectOutApi>(`/projects/${encodeURIComponent(id)}`));
}

/* ───────── local mode ───────── */

export interface LocalProject {
  id: string;
  code: string;
  description: string;
  start: string;
  end: string;
  budgetHours: number | null;
  managerId: string | null;
  managerName: string;
  status?: ProjectStatus;
  healthCall?: HealthCall | null;
  client?: string;
  /** Hours the rest of the team logged (sample); the viewer's own blocks are added on top. */
  teamHours: number;
  teamApprovedHours: number;
  members: Omit<PMember, "loggedHours">[];
  milestones: PMilestone[];
  tasks: Omit<PTask, "loggedHours">[];
  posts: PPost[];
  documents: PDoc[];
  activity: PActivity[];
}

const KEY = "timez.projects.v1";
const localListeners = new Set<() => void>();
let localCache: Record<string, LocalProject> | null = null;

function readLocal(): Record<string, LocalProject> {
  if (localCache) return localCache;
  let saved: Record<string, LocalProject> = {};
  try {
    saved = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, LocalProject>;
  } catch {
    saved = {};
  }
  localCache = { ...CATALOG_FOR_STORE(), ...saved };
  return localCache;
}

function writeLocal(next: Record<string, LocalProject>): string | null {
  localCache = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    return "This browser could not save the change (storage is full or blocked).";
  }
  localListeners.forEach((fn) => fn());
  return null;
}

function blankLocal(id: string): LocalProject {
  return {
    id,
    code: id.toUpperCase(),
    description: "",
    start: "",
    end: "",
    budgetHours: null,
    managerId: null,
    managerName: "",
    teamHours: 0,
    teamApprovedHours: 0,
    members: [],
    milestones: [],
    tasks: [],
    posts: [],
    documents: [],
    activity: [],
  };
}

/** What a local-mode project needs from the portal: the project record and the viewer's own hours. */
export interface LocalContext {
  viewerId: string;
  viewerName: string;
  viewerRole: string;
  viewerTitle: string;
  projects: { id: string; name: string; code?: string; client: string; startDate: string; endDate: string; status: string }[];
  /** The viewer's own blocks: project, hours, whether the day is approved, and the task id when logged to a task. */
  entries: { projectId: string; hours: number; approved: boolean; taskId?: string }[];
}

function localInfo(base: { id: string; name: string; code?: string; client: string; startDate: string; endDate: string; status: string }, ctx: LocalContext): ProjectInfo {
  const p = readLocal()[base.id] ?? blankLocal(base.id);
  const mine = ctx.entries.filter((e) => e.projectId === base.id);
  const myLogged = round(mine.reduce((a, e) => a + e.hours, 0));
  const myApproved = round(mine.filter((e) => e.approved).reduce((a, e) => a + e.hours, 0));
  const byTask = new Map<string, number>();
  for (const e of mine) if (e.taskId) byTask.set(e.taskId, (byTask.get(e.taskId) ?? 0) + e.hours);
  const members: PMember[] = p.members.map((m) => ({ ...m, loggedHours: m.employeeId === ctx.viewerId ? myLogged : 0 }));
  const me = members.find((m) => m.employeeId === ctx.viewerId);
  const canEdit = p.managerId === ctx.viewerId || ctx.viewerRole === "hr_admin" || ctx.viewerRole === "admin";
  if (!me) members.push({ employeeId: ctx.viewerId, name: ctx.viewerName, jobTitle: ctx.viewerTitle, role: canEdit ? "lead" : "member", title: canEdit ? "Project manager" : "Member", loggedHours: myLogged });
  return {
    id: base.id,
    code: base.code ?? p.code,
    name: base.name,
    client: p.client || base.client,
    active: p.status ? p.status !== "completed" && p.status !== "cancelled" : base.status !== "previous",
    status: p.status ?? (base.status !== "previous" ? "active" : "completed"),
    healthCall: p.healthCall ?? null,
    description: p.description,
    start: p.start || base.startDate,
    end: p.end || base.endDate,
    budgetHours: p.budgetHours,
    managerId: p.managerId,
    managerName: p.managerName,
    canEdit,
    myTitle: me?.title ?? (canEdit ? "Project manager" : "Member"),
    myResponsibilities: me?.responsibilities ?? "",
    myBudgetHours: me?.budgetHours ?? null,
    loggedHours: round(p.teamHours + myLogged),
    approvedHours: round(p.teamApprovedHours + myApproved),
    myLoggedHours: myLogged,
    myApprovedHours: myApproved,
    members,
    milestones: [...p.milestones].sort((a, b) => a.due.localeCompare(b.due)),
    tasks: p.tasks.map((t) => ({ ...t, loggedHours: round(byTask.get(t.id) ?? 0) })),
    posts: [...p.posts].sort((a, b) => b.at.localeCompare(a.at)),
    documents: p.documents,
    activity: [...p.activity].sort((a, b) => b.on.localeCompare(a.on)),
    full: true,
  };
}

/* ───────── hooks ───────── */

// One counter for every change (list, a project's details, the browser copy), bumped before React is told.
let changes = 0;
const bump = () => {
  changes += 1;
};
listMirror.subscribe(bump);
detailListeners.add(bump);
localListeners.add(bump);
const subscribe = (fn: () => void) => {
  const off = listMirror.subscribe(fn);
  detailListeners.add(fn);
  localListeners.add(fn);
  return () => {
    off();
    detailListeners.delete(fn);
    localListeners.delete(fn);
  };
};
const version = () => changes;

/** Every project the viewer is on (backend: from the API; local: the portal's projects with their details). */
export function useProjects(ctx: LocalContext): ProjectInfo[] {
  useSyncExternalStore(subscribe, version, version);
  if (API_ENABLED) return listMirror.get().map((p) => details.get(p.id) ?? p);
  return ctx.projects.map((p) => localInfo(p, ctx));
}

/** One project with posts, documents and activity (loads them in backend mode). */
export function useProject(id: string | null, ctx: LocalContext): { project: ProjectInfo | undefined; loading: boolean } {
  useSyncExternalStore(subscribe, version, version);
  useEffect(() => {
    if (API_ENABLED && id) void loadProjectDetail(id);
  }, [id]);
  if (!id) return { project: undefined, loading: false };
  if (API_ENABLED) {
    const project = details.get(id) ?? listMirror.get().find((p) => p.id === id);
    return { project, loading: !details.has(id) };
  }
  const base = ctx.projects.find((p) => p.id === id);
  return { project: base ? localInfo(base, ctx) : undefined, loading: false };
}

export const refreshProjects = () => (API_ENABLED ? listMirror.reload() : Promise.resolve());

/* ───────── changes ───────── */

type Actor = { id: string; name: string };
const enc = encodeURIComponent;

function localChange(id: string, actor: Actor, activity: string | null, change: (p: LocalProject) => string | null | void): string | null {
  const all = readLocal();
  const current = all[id] ?? blankLocal(id);
  const copy: LocalProject = JSON.parse(JSON.stringify(current)) as LocalProject;
  const error = change(copy);
  if (error) return error;
  if (activity) copy.activity.unshift({ id: newId("pa"), who: actor.name, text: activity, on: todayISO() });
  return writeLocal({ ...all, [id]: copy });
}

function tellMembers(p: LocalProject, actor: Actor, title: string, body: string) {
  const ids = new Set([...p.members.map((m) => m.employeeId), p.managerId ?? ""]);
  for (const id of ids) if (id && id !== actor.id && !id.startsWith("name:")) notifyPerson(id, title, body, `/projects?id=${p.id}`);
}

export interface ProjectEdit {
  description: string;
  start: string;
  end: string;
  budgetHours: number | null;
  client?: string;
  status?: ProjectStatus;
  healthCall?: HealthCall | null;
}

export function saveProject(p: ProjectInfo, actor: Actor, edit: ProjectEdit): Promise<string | null> {
  if (!p.canEdit) return Promise.resolve("Only the project manager can change this.");
  if (edit.start && edit.end && edit.end < edit.start) return Promise.resolve("The end date must be on or after the start date.");
  if (edit.budgetHours != null && (!Number.isFinite(edit.budgetHours) || edit.budgetHours < 0)) return Promise.resolve("Enter a budget of 0 hours or more.");
  if (API_ENABLED)
    return apiProjectCall(() =>
      apiPut(`/projects/${enc(p.id)}`, {
        description: edit.description,
        start_date: edit.start || null,
        end_date: edit.end || null,
        budget_hours: edit.budgetHours,
        ...(edit.client !== undefined ? { client: edit.client } : {}),
        ...(edit.status ? { status: edit.status } : {}),
        ...(edit.healthCall !== undefined ? { health: edit.healthCall } : {}),
      }),
    );
  return Promise.resolve(
    localChange(p.id, actor, "Updated the project details", (x) => {
      if (x.end !== edit.end) tellMembers(x, actor, `${p.name}: deadline changed`, edit.end ? `The project now ends on ${edit.end}.` : "No end date now.");
      Object.assign(x, {
        description: edit.description.trim(),
        start: edit.start,
        end: edit.end,
        budgetHours: edit.budgetHours,
        ...(edit.client !== undefined ? { client: edit.client.trim() } : {}),
        ...(edit.status ? { status: edit.status } : {}),
        ...(edit.healthCall !== undefined ? { healthCall: edit.healthCall } : {}),
      });
    }),
  );
}

export interface MilestoneEdit {
  name: string;
  description: string;
  due: string;
  completed: boolean;
}

export function saveMilestone(p: ProjectInfo, actor: Actor, milestoneId: string | null, edit: MilestoneEdit): Promise<string | null> {
  if (!p.canEdit) return Promise.resolve("Only the project manager can change milestones.");
  if (!edit.name.trim()) return Promise.resolve("Enter the milestone name.");
  if (!edit.due) return Promise.resolve("Pick the due date.");
  const body = { name: edit.name.trim(), description: edit.description.trim() || null, due_date: edit.due, completed: edit.completed };
  if (API_ENABLED)
    return apiProjectCall(() =>
      milestoneId ? apiPut(`/projects/${enc(p.id)}/milestones/${enc(milestoneId)}`, body) : api.post(`/projects/${enc(p.id)}/milestones`, body),
    );
  return Promise.resolve(
    localChange(p.id, actor, null, (x) => {
      const today = todayISO();
      if (!milestoneId) {
        x.milestones.push({ id: newId("pm"), name: body.name, description: body.description, due: edit.due, completedOn: edit.completed ? today : null });
        x.activity.unshift({ id: newId("pa"), who: actor.name, text: `Added milestone “${body.name}” due ${edit.due}`, on: today });
        tellMembers(x, actor, `${p.name}: new milestone`, `${body.name}, due ${edit.due}.`);
        return;
      }
      const m = x.milestones.find((y) => y.id === milestoneId);
      if (!m) return "That milestone was removed. Reload the page.";
      if (edit.completed && !m.completedOn) {
        x.activity.unshift({ id: newId("pa"), who: actor.name, text: `Completed milestone “${body.name}”`, on: today });
        tellMembers(x, actor, `${p.name}: milestone completed`, `“${body.name}” is done.`);
      }
      if (m.due !== edit.due) tellMembers(x, actor, `${p.name}: milestone moved`, `“${body.name}” is now due ${edit.due} (was ${m.due}).`);
      Object.assign(m, { name: body.name, description: body.description, due: edit.due, completedOn: edit.completed ? m.completedOn ?? today : null });
    }),
  );
}

export function deleteMilestone(p: ProjectInfo, actor: Actor, milestoneId: string): Promise<string | null> {
  if (!p.canEdit) return Promise.resolve("Only the project manager can remove milestones.");
  if (API_ENABLED) return apiProjectCall(() => apiDelete(`/projects/${enc(p.id)}/milestones/${enc(milestoneId)}`));
  const name = p.milestones.find((m) => m.id === milestoneId)?.name ?? "milestone";
  return Promise.resolve(
    localChange(p.id, actor, `Removed milestone “${name}”`, (x) => {
      x.milestones = x.milestones.filter((m) => m.id !== milestoneId);
      x.tasks = x.tasks.map((t) => (t.milestoneId === milestoneId ? { ...t, milestoneId: null } : t));
    }),
  );
}

export interface TaskEdit {
  title: string;
  description: string;
  assigneeId: string;
  milestoneId: string;
  due: string;
  estimate: number;
  status: TaskStatus;
  priority?: TaskPriority;
}

export function saveTask(p: ProjectInfo, actor: Actor, taskId: string | null, edit: TaskEdit): Promise<string | null> {
  if (!p.canEdit) return Promise.resolve("Only the project manager can add or edit tasks.");
  if (!edit.title.trim()) return Promise.resolve("Enter the task title.");
  if (!Number.isFinite(edit.estimate) || edit.estimate < 0) return Promise.resolve("Enter the estimate in hours (0 or more).");
  const body = {
    title: edit.title.trim(),
    description: edit.description.trim() || null,
    assignee_id: edit.assigneeId || null,
    milestone_id: edit.milestoneId || null,
    due_date: edit.due || null,
    estimate_hours: edit.estimate,
    status: edit.status,
    priority: edit.priority ?? "medium",
  };
  if (API_ENABLED)
    return apiProjectCall(() => (taskId ? apiPut(`/projects/${enc(p.id)}/tasks/${enc(taskId)}`, body) : api.post(`/projects/${enc(p.id)}/tasks`, body)));
  return Promise.resolve(
    localChange(p.id, actor, null, (x) => {
      const assigneeName = p.members.find((m) => m.employeeId === edit.assigneeId)?.name ?? null;
      const fields = { title: body.title, description: body.description, assigneeId: body.assignee_id, assigneeName, milestoneId: body.milestone_id, due: body.due_date, estimate: edit.estimate, status: edit.status, priority: body.priority };
      if (!taskId) {
        const prefix = (x.code.split("-")[0] || "PRJ").slice(0, 6).toUpperCase();
        let n = 100 + x.tasks.length + 1;
        while (x.tasks.some((t) => t.code === `${prefix}-${n}`)) n += 1;
        const code = `${prefix}-${n}`;
        x.tasks.push({ id: newId("pt"), code, ...fields });
        x.activity.unshift({ id: newId("pa"), who: actor.name, text: `Added task ${code} “${body.title}”`, on: todayISO() });
        if (body.assignee_id && body.assignee_id !== actor.id) notifyPerson(body.assignee_id, `${p.name}: task assigned to you`, `${code} ${body.title}`, `/projects?id=${p.id}`);
        return;
      }
      const t = x.tasks.find((y) => y.id === taskId);
      if (!t) return "That task was removed. Reload the page.";
      if (body.assignee_id && body.assignee_id !== t.assigneeId && body.assignee_id !== actor.id)
        notifyPerson(body.assignee_id, `${p.name}: task assigned to you`, `${t.code} ${body.title}`, `/projects?id=${p.id}`);
      Object.assign(t, fields);
      x.activity.unshift({ id: newId("pa"), who: actor.name, text: `Updated task ${t.code}`, on: todayISO() });
    }),
  );
}

/** The assignee (or the manager) moves a task along. */
export function setTaskStatus(p: ProjectInfo, actor: Actor, taskId: string, status: TaskStatus): Promise<string | null> {
  const task = p.tasks.find((t) => t.id === taskId);
  if (!task) return Promise.resolve("That task was removed. Reload the page.");
  if (task.assigneeId !== actor.id && !p.canEdit) return Promise.resolve("Only the person the task is assigned to, or the project manager, can change its status.");
  if (API_ENABLED) return apiProjectCall(() => api.post(`/projects/${enc(p.id)}/tasks/${enc(taskId)}/status`, { status }));
  return Promise.resolve(
    localChange(p.id, actor, `Moved ${task.code} to ${TASK_STATUS_LABEL[status].toLowerCase()}`, (x) => {
      const t = x.tasks.find((y) => y.id === taskId);
      if (!t) return "That task was removed. Reload the page.";
      t.status = status;
      if (x.managerId && x.managerId !== actor.id)
        notifyPerson(x.managerId, `${p.name}: ${t.code} is ${TASK_STATUS_LABEL[status].toLowerCase()}`, `${actor.name} moved “${t.title}”.`, `/projects?id=${p.id}`);
    }),
  );
}

export function deleteTask(p: ProjectInfo, actor: Actor, taskId: string): Promise<string | null> {
  if (!p.canEdit) return Promise.resolve("Only the project manager can remove tasks.");
  if (API_ENABLED) return apiProjectCall(() => apiDelete(`/projects/${enc(p.id)}/tasks/${enc(taskId)}`));
  const code = p.tasks.find((t) => t.id === taskId)?.code ?? "task";
  return Promise.resolve(localChange(p.id, actor, `Removed task ${code}`, (x) => void (x.tasks = x.tasks.filter((t) => t.id !== taskId))));
}

export interface MemberEdit {
  title: string;
  responsibilities: string;
  budgetHours: number | null;
  allocationPct?: number | null;
  role?: "member" | "lead";
}

function allocationError(pct: number | null | undefined): string | null {
  if (pct == null) return null;
  return Number.isInteger(pct) && pct >= 0 && pct <= 100 ? null : "Allocation is a whole number from 0 to 100%.";
}

export function saveMember(p: ProjectInfo, actor: Actor, employeeId: string, edit: MemberEdit): Promise<string | null> {
  if (!p.canEdit) return Promise.resolve("Only the project manager can change roles.");
  const bad = allocationError(edit.allocationPct);
  if (bad) return Promise.resolve(bad);
  if (API_ENABLED)
    return apiProjectCall(() =>
      apiPut(`/projects/${enc(p.id)}/members/${enc(employeeId)}`, {
        title: edit.title.trim() || null,
        responsibilities: edit.responsibilities.trim() || null,
        budget_hours: edit.budgetHours,
        allocation_pct: edit.allocationPct ?? null,
        ...(edit.role ? { role: edit.role } : {}),
      }),
    );
  const name = p.members.find((m) => m.employeeId === employeeId)?.name ?? personName(employeeId);
  return Promise.resolve(
    localChange(p.id, actor, `Updated ${name}'s role`, (x) => {
      let m = x.members.find((y) => y.employeeId === employeeId);
      if (!m) {
        const from = p.members.find((y) => y.employeeId === employeeId);
        if (!from) return "That person is not on the project.";
        m = { employeeId, name: from.name, jobTitle: from.jobTitle, role: from.role };
        x.members.push(m);
      }
      Object.assign(m, {
        title: edit.title.trim() || null,
        responsibilities: edit.responsibilities.trim() || null,
        budgetHours: edit.budgetHours,
        allocationPct: edit.allocationPct ?? null,
        ...(edit.role && employeeId !== x.managerId ? { role: edit.role } : {}),
      });
    }),
  );
}

/** The project manager (or HR / admin) adds someone to the project. */
export function addMember(p: ProjectInfo, actor: Actor, person: { id: string; name: string; jobTitle?: string }, edit: MemberEdit): Promise<string | null> {
  if (!p.canEdit) return Promise.resolve("Only the project manager can add people.");
  if (!person.id) return Promise.resolve("Pick someone to add.");
  if (p.members.some((m) => m.employeeId === person.id)) return Promise.resolve(`${person.name} is already on the project.`);
  const bad = allocationError(edit.allocationPct);
  if (bad) return Promise.resolve(bad);
  if (API_ENABLED)
    return apiProjectCall(() =>
      api.post(`/projects/${enc(p.id)}/members`, {
        employee_id: person.id,
        role: edit.role ?? "member",
        title: edit.title.trim() || null,
        responsibilities: edit.responsibilities.trim() || null,
        budget_hours: edit.budgetHours,
        allocation_pct: edit.allocationPct ?? null,
      }),
    );
  return Promise.resolve(
    localChange(p.id, actor, `Added ${person.name} to the project`, (x) => {
      x.members.push({
        employeeId: person.id,
        name: person.name,
        jobTitle: person.jobTitle ?? "",
        role: edit.role ?? "member",
        title: edit.title.trim() || null,
        responsibilities: edit.responsibilities.trim() || null,
        budgetHours: edit.budgetHours,
        allocationPct: edit.allocationPct ?? null,
      });
      if (person.id !== actor.id) notifyPerson(person.id, `Added to ${p.name}`, `Role: ${edit.title.trim() || edit.role || "member"}.`, `/projects?id=${p.id}`);
    }),
  );
}

/** Removes someone; their open tasks become unassigned. Logged hours stay on the project. */
export function removeMember(p: ProjectInfo, actor: Actor, employeeId: string): Promise<string | null> {
  if (!p.canEdit) return Promise.resolve("Only the project manager can remove people.");
  if (employeeId === p.managerId) return Promise.resolve("The project manager can't be removed from the project.");
  if (API_ENABLED) return apiProjectCall(() => apiDelete(`/projects/${enc(p.id)}/members/${enc(employeeId)}`));
  const name = p.members.find((m) => m.employeeId === employeeId)?.name ?? personName(employeeId);
  return Promise.resolve(
    localChange(p.id, actor, `Removed ${name} from the project`, (x) => {
      x.members = x.members.filter((m) => m.employeeId !== employeeId);
      x.tasks = x.tasks.map((t) => (t.assigneeId === employeeId && t.status !== "done" ? { ...t, assigneeId: null, assigneeName: null } : t));
    }),
  );
}

/* ───────── reporting (backend: hours from everyone's timesheets) ───────── */

export interface ReportWeek {
  weekStart: string;
  hours: number;
  approved: number;
  billable: number;
  cumulative: number;
  remaining: number | null;
  idealRemaining: number | null;
}

export interface ReportMember {
  employeeId: string;
  name: string;
  role: string;
  allocationPct: number | null;
  budgetHours: number | null;
  hours: number;
  approved: number;
  billable: number;
  weeks: Record<string, number>;
}

export interface ProjectReport {
  budgetHours: number | null;
  logged: number;
  approved: number;
  billable: number;
  progressPct: number;
  fullTeam: boolean;
  weeks: ReportWeek[];
  members: ReportMember[];
  tasks: { total: number; byStatus: Record<string, number>; overdue: number; estimate: number; loggedOnTasks: number };
}

interface ReportApi {
  budget_hours: number | null;
  logged_hours: number;
  approved_hours: number;
  billable_hours: number;
  progress_pct: number;
  full_team: boolean;
  weeks: { week_start: string; hours: number; approved_hours: number; billable_hours: number; cumulative_hours: number; remaining_budget: number | null; ideal_remaining: number | null }[];
  members: { employee_id: string; name: string; role: string; allocation_pct: number | null; budget_hours: number | null; hours: number; approved_hours: number; billable_hours: number; weeks: Record<string, number> }[];
  tasks: { total: number; by_status: Record<string, number>; overdue: number; estimate_hours: number; logged_on_tasks: number };
}

/** Local mode: totals from the project itself (weekly hours need the server). */
function localReport(p: ProjectInfo): ProjectReport {
  const byStatus: Record<string, number> = { todo: 0, in_progress: 0, in_review: 0, done: 0 };
  for (const t of p.tasks) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
  const today = todayISO();
  return {
    budgetHours: p.budgetHours,
    logged: p.loggedHours,
    approved: p.approvedHours,
    billable: p.loggedHours,
    progressPct: completionOf(p).pct,
    fullTeam: p.canEdit,
    weeks: [],
    members: p.members
      .filter((m) => p.canEdit || m.loggedHours > 0)
      .map((m) => ({ employeeId: m.employeeId, name: m.name, role: m.role, allocationPct: m.allocationPct ?? null, budgetHours: m.budgetHours ?? null, hours: m.loggedHours, approved: 0, billable: m.loggedHours, weeks: {} })),
    tasks: {
      total: p.tasks.length,
      byStatus,
      overdue: p.tasks.filter((t) => t.status !== "done" && t.due && t.due < today).length,
      estimate: round(p.tasks.reduce((a, t) => a + (t.estimate || 0), 0)),
      loggedOnTasks: round(p.tasks.reduce((a, t) => a + (t.loggedHours || 0), 0)),
    },
  };
}

export function useProjectReport(p: ProjectInfo | undefined): { report: ProjectReport | null; error: string | null; loading: boolean } {
  const [state, setState] = useState<{ key: string; report: ProjectReport | null; error: string | null }>({ key: "", report: null, error: null });
  const key = p ? `${p.id}:${p.loggedHours}:${p.tasks.length}:${p.members.length}:${p.budgetHours}` : "";
  useEffect(() => {
    if (!p || !API_ENABLED) return;
    let live = true;
    api
      .get<ReportApi>(`/projects/${enc(p.id)}/report`)
      .then((r) => {
        if (!live) return;
        setState({
          key,
          error: null,
          report: {
            budgetHours: r.budget_hours,
            logged: r.logged_hours,
            approved: r.approved_hours,
            billable: r.billable_hours,
            progressPct: r.progress_pct,
            fullTeam: r.full_team,
            weeks: r.weeks.map((w) => ({ weekStart: w.week_start, hours: w.hours, approved: w.approved_hours, billable: w.billable_hours, cumulative: w.cumulative_hours, remaining: w.remaining_budget, idealRemaining: w.ideal_remaining })),
            members: r.members.map((m) => ({ employeeId: m.employee_id, name: m.name, role: m.role, allocationPct: m.allocation_pct, budgetHours: m.budget_hours, hours: m.hours, approved: m.approved_hours, billable: m.billable_hours, weeks: m.weeks })),
            tasks: { total: r.tasks.total, byStatus: r.tasks.by_status, overdue: r.tasks.overdue, estimate: r.tasks.estimate_hours, loggedOnTasks: r.tasks.logged_on_tasks },
          },
        });
      })
      .catch((e) => live && setState({ key, report: null, error: errorText(e) }));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!p) return { report: null, error: null, loading: false };
  if (!API_ENABLED) return { report: localReport(p), error: null, loading: false };
  return { report: state.key === key ? state.report : null, error: state.key === key ? state.error : null, loading: state.key !== key };
}

/** Downloads the hours report as CSV (members by week, then weeks with the burn-down). */
export async function exportProjectCsv(p: ProjectInfo, report: ProjectReport | null): Promise<string | null> {
  try {
    let blob: Blob;
    if (API_ENABLED) blob = await downloadBlob(`/projects/${enc(p.id)}/report.csv`);
    else {
      const lines = [["Project", "Member", "Role", "Allocation %", "Hours"].join(",")];
      for (const m of report?.members ?? []) lines.push([p.code, `"${m.name.replace(/"/g, '""')}"`, m.role, m.allocationPct ?? "", m.hours].join(","));
      blob = new Blob([lines.join("\n")], { type: "text/csv" });
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${p.code}-hours.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    return null;
  } catch (e) {
    return errorText(e, "Could not export the report.");
  }
}

export function addPost(p: ProjectInfo, actor: Actor, kind: "update" | "comment", body: string): Promise<string | null> {
  const text = body.trim();
  if (!text) return Promise.resolve(kind === "update" ? "Write the update first." : "Write a comment first.");
  if (kind === "update" && !p.canEdit) return Promise.resolve("Only the project manager posts status updates. Add a comment instead.");
  if (API_ENABLED) return apiProjectCall(() => api.post(`/projects/${enc(p.id)}/posts`, { kind, body: text }));
  return Promise.resolve(
    localChange(p.id, actor, kind === "update" ? "Posted a status update" : "Commented", (x) => {
      x.posts.unshift({ id: newId("pp"), authorId: actor.id, authorName: actor.name, kind, body: text, at: new Date().toISOString() });
      if (kind === "update") tellMembers(x, actor, `${p.name}: status update`, text.slice(0, 180));
      else if (x.managerId && x.managerId !== actor.id) notifyPerson(x.managerId, `${p.name}: new comment`, `${actor.name}: ${text.slice(0, 160)}`, `/projects?id=${p.id}`);
    }),
  );
}

export function deletePost(p: ProjectInfo, actor: Actor, postId: string): Promise<string | null> {
  const post = p.posts.find((x) => x.id === postId);
  if (post && post.authorId !== actor.id && !p.canEdit) return Promise.resolve("You can delete only your own posts.");
  if (API_ENABLED) return apiProjectCall(() => apiDelete(`/projects/${enc(p.id)}/posts/${enc(postId)}`));
  return Promise.resolve(localChange(p.id, actor, null, (x) => void (x.posts = x.posts.filter((y) => y.id !== postId))));
}

export function addLink(p: ProjectInfo, actor: Actor, title: string, url: string): Promise<string | null> {
  if (!title.trim()) return Promise.resolve("Enter a title for the document.");
  if (!/^https?:\/\/\S{3,}$/i.test(url.trim())) return Promise.resolve("Enter a full link starting with https://");
  if (API_ENABLED) return apiProjectCall(() => api.post(`/projects/${enc(p.id)}/documents/link`, { title: title.trim(), url: url.trim() }));
  return Promise.resolve(
    localChange(p.id, actor, `Added document “${title.trim()}”`, (x) => {
      x.documents.unshift({ id: newId("pd"), title: title.trim(), url: url.trim(), addedBy: actor.id, addedByName: actor.name, at: new Date().toISOString() });
    }),
  );
}

const MAX_FILE = 5 * 1024 * 1024;
const LOCAL_MAX_FILE = 1024 * 1024;
const FILE_TYPES = ["application/pdf", "image/png", "image/jpeg", "image/webp", "image/gif"];

export async function uploadDocument(p: ProjectInfo, actor: Actor, file: File, title: string): Promise<string | null> {
  if (!FILE_TYPES.includes(file.type)) return "Upload a PDF or an image (PNG, JPG, WebP, GIF).";
  if (file.size > (API_ENABLED ? MAX_FILE : LOCAL_MAX_FILE)) return API_ENABLED ? "The file is larger than 5 MB." : "In this browser-only mode files can be up to 1 MB.";
  const name = title.trim() || file.name;
  if (API_ENABLED)
    return apiProjectCall(() => uploadRaw<ProjectOutApi>(`/projects/${enc(p.id)}/documents?title=${enc(name)}`, file, file.type, file.name));
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  }).catch(() => "");
  if (!dataUrl) return "Could not read the file.";
  return localChange(p.id, actor, `Uploaded “${name}”`, (x) => {
    x.documents.unshift({ id: newId("pd"), title: name, fileName: file.name, contentType: file.type, size: file.size, dataUrl, addedBy: actor.id, addedByName: actor.name, at: new Date().toISOString() });
  });
}

/** Opens an uploaded file in a new tab (backend: fetched with the sign-in token). */
export async function openDocument(p: ProjectInfo, doc: PDoc): Promise<string | null> {
  if (doc.url) {
    window.open(doc.url, "_blank", "noopener,noreferrer");
    return null;
  }
  try {
    const blob = API_ENABLED
      ? await downloadBlob(`/projects/${enc(p.id)}/documents/${enc(doc.id)}/file`)
      : await (await fetch(doc.dataUrl ?? "")).blob();
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank", "noopener,noreferrer");
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return null;
  } catch (error) {
    return errorText(error, "Could not open the file.");
  }
}

export function deleteDocument(p: ProjectInfo, actor: Actor, docId: string): Promise<string | null> {
  const doc = p.documents.find((d) => d.id === docId);
  if (doc && doc.addedBy !== actor.id && !p.canEdit) return Promise.resolve("Only the person who added it, or the project manager, can remove a document.");
  if (API_ENABLED) return apiProjectCall(() => apiDelete(`/projects/${enc(p.id)}/documents/${enc(docId)}`));
  return Promise.resolve(
    localChange(p.id, actor, `Removed document “${doc?.title ?? "document"}”`, (x) => void (x.documents = x.documents.filter((d) => d.id !== docId))),
  );
}
