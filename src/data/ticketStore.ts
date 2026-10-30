/**
 * Work tickets. Local mode keeps them in this browser (timez.tickets.v1). With VITE_API_URL set they live on the
 * server (/tickets): the list below is an in-memory mirror of what the API lets this person see, and every change
 * is sent to the API (which applies the same rules, audits it and notifies people) before the mirror updates.
 */
import { useSyncExternalStore } from "react";
import { API_ENABLED, ApiError, api, apiRequest } from "../api/client.ts";
import { createApiMirror, errorText } from "../api/syncOps.ts";
import { DEMO_ACCOUNTS, managementChain } from "../demoAccounts.ts";
import { pushPersonTaskAlert } from "./collabLocal.ts";
import { taskPersonById } from "./taskTeam.ts";

export const TICKET_TYPES = ["IT support", "HR query", "Bug", "Client issue", "Access request"] as const;
export type TicketType = (typeof TICKET_TYPES)[number];
export const TICKET_PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];
export const TICKET_STATUSES = ["Open", "In progress", "Waiting", "Resolved", "Closed"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export interface TicketEvent {
  id: string;
  at: string;
  byId: string;
  kind: "created" | "assigned" | "status" | "comment" | "watcher" | "task";
  text: string;
}

export interface Ticket {
  id: string;
  title: string;
  description: string;
  type: TicketType;
  priority: TicketPriority;
  status: TicketStatus;
  projectId?: string;
  projectName?: string;
  requesterId: string;
  assigneeId?: string;
  /** Second person who helps the owner (assignee). */
  subOwnerId?: string;
  watcherIds: string[];
  due?: string;
  tasks?: TicketTask[];
  activity: TicketEvent[];
  createdAt: string;
  updatedAt: string;
  /** Backend mode: what the server says this person may do. */
  serverCanPlan?: boolean;
  serverNextStatuses?: TicketStatus[];
}

export interface TicketTask {
  id: string;
  title: string;
  ownerId?: string;
  due?: string;
  done: boolean;
}

export type TicketActor = { id: string; fullName: string; role: string };

const KEY = "timez.tickets.v1";
const BABU = "emp-mahesh";
const RAM = "emp-ram";
const PRIYA = "emp-priya";
const KABIR = "emp-kabir";
const ALEX = "demo-admin";
const FARHAN = "demo-hr-admin";

/** IT and access requests go to the IT desk; HR queries to HR. Others wait for a manager to assign. */
const QUEUE_OWNER: Partial<Record<TicketType, string>> = {
  "IT support": ALEX,
  "Access request": ALEX,
  "HR query": FARHAN,
};

function ev(id: string, at: string, byId: string, kind: TicketEvent["kind"], text: string): TicketEvent {
  return { id, at, byId, kind, text };
}

function seed(): Ticket[] {
  return [
    {
      id: "TCK-1042",
      title: "Maple portal logs users out after 5 minutes",
      description: "Clinic staff lose unsaved notes. Session timeout should be 30 minutes per the SOW.",
      type: "Bug",
      priority: "high",
      status: "Open",
      projectId: "p-maple",
      projectName: "Maple Clinic Portal",
      requesterId: KABIR,
      assigneeId: BABU,
      subOwnerId: PRIYA,
      watcherIds: [RAM],
      due: "2026-10-30",
      tasks: [
        { id: "tt-1042-1", title: "Reproduce the logout on staging", ownerId: BABU, due: "2026-10-27", done: true },
        { id: "tt-1042-2", title: "Set session timeout to 30 minutes", ownerId: BABU, due: "2026-10-29", done: false },
        { id: "tt-1042-3", title: "Test with clinic staff accounts", ownerId: PRIYA, due: "2026-10-30", done: false },
      ],
      activity: [
        ev("e1", "2026-10-26T10:12:00", KABIR, "created", "Raised the ticket."),
        ev("e2", "2026-10-26T11:05:00", RAM, "assigned", "Assigned to Babu Menon."),
      ],
      createdAt: "2026-10-26T10:12:00",
      updatedAt: "2026-10-26T11:05:00",
    },
    {
      id: "TCK-1041",
      title: "Monitor flickers on the docking station",
      description: "External monitor blinks every few seconds when the laptop is docked. Desk B-14.",
      type: "IT support",
      priority: "medium",
      status: "Open",
      requesterId: RAM,
      assigneeId: ALEX,
      watcherIds: [],
      due: "2026-10-29",
      activity: [ev("e1", "2026-10-23T09:40:00", RAM, "created", "Raised the ticket.")],
      createdAt: "2026-10-23T09:40:00",
      updatedAt: "2026-10-23T09:40:00",
    },
    {
      id: "TCK-1040",
      title: "Northwind sends duplicate payment reminders",
      description: "Customers on the monthly plan get two reminder emails. Started after the 15 Oct release.",
      type: "Client issue",
      priority: "urgent",
      status: "In progress",
      projectId: "p-north",
      projectName: "Northwind Billing",
      requesterId: RAM,
      assigneeId: KABIR,
      watcherIds: [BABU],
      due: "2026-10-28",
      activity: [
        ev("e1", "2026-10-21T14:20:00", RAM, "created", "Raised the ticket."),
        ev("e2", "2026-10-21T14:22:00", RAM, "assigned", "Assigned to Kabir Sharma."),
        ev("e3", "2026-10-22T10:05:00", KABIR, "status", "Open → In progress"),
        ev("e4", "2026-10-22T16:30:00", KABIR, "comment", "Reminder job runs twice after the cron change. Fix in review."),
      ],
      createdAt: "2026-10-21T14:20:00",
      updatedAt: "2026-10-22T16:30:00",
    },
    {
      id: "TCK-1039",
      title: "Invoice export drops the GST column",
      description: "CSV export from the Northwind invoice list has no GST column for multi-state invoices.",
      type: "Bug",
      priority: "high",
      status: "In progress",
      projectId: "p-north",
      projectName: "Northwind Billing",
      requesterId: PRIYA,
      assigneeId: BABU,
      watcherIds: [],
      due: "2026-10-29",
      activity: [
        ev("e1", "2026-10-19T11:00:00", PRIYA, "created", "Raised the ticket."),
        ev("e2", "2026-10-19T11:30:00", RAM, "assigned", "Assigned to Babu Menon."),
        ev("e3", "2026-10-20T09:45:00", BABU, "status", "Open → In progress"),
      ],
      createdAt: "2026-10-19T11:00:00",
      updatedAt: "2026-10-20T09:45:00",
    },
    {
      id: "TCK-1038",
      title: "VPN access for Maple staging",
      description: "Need VPN profile for the Maple staging network to reproduce client issues.",
      type: "Access request",
      priority: "medium",
      status: "Waiting",
      projectId: "p-maple",
      projectName: "Maple Clinic Portal",
      requesterId: KABIR,
      assigneeId: ALEX,
      watcherIds: [RAM],
      activity: [
        ev("e1", "2026-10-20T10:10:00", KABIR, "created", "Raised the ticket."),
        ev("e2", "2026-10-20T15:00:00", ALEX, "status", "Open → Waiting"),
        ev("e3", "2026-10-20T15:01:00", ALEX, "comment", "Waiting on manager approval for staging access."),
      ],
      createdAt: "2026-10-20T10:10:00",
      updatedAt: "2026-10-20T15:01:00",
    },
    {
      id: "TCK-1037",
      title: "Form 16 from previous employer",
      description: "How do I add last employer's Form 16 to this year's tax declaration?",
      type: "HR query",
      priority: "low",
      status: "Closed",
      requesterId: PRIYA,
      assigneeId: FARHAN,
      watcherIds: [],
      activity: [
        ev("e1", "2026-10-08T12:00:00", PRIYA, "created", "Raised the ticket."),
        ev("e2", "2026-10-09T10:00:00", FARHAN, "comment", "Upload it under Tax declarations → Previous employment."),
        ev("e3", "2026-10-09T10:01:00", FARHAN, "status", "Open → Resolved"),
        ev("e4", "2026-10-09T17:20:00", PRIYA, "status", "Resolved → Closed"),
      ],
      createdAt: "2026-10-08T12:00:00",
      updatedAt: "2026-10-09T17:20:00",
    },
    {
      id: "TCK-1036",
      title: "Laptop battery drains in two hours",
      description: "Battery health shows 61%. Need a replacement before the client visit.",
      type: "IT support",
      priority: "medium",
      status: "Resolved",
      requesterId: BABU,
      assigneeId: ALEX,
      watcherIds: [],
      activity: [
        ev("e1", "2026-10-12T09:15:00", BABU, "created", "Raised the ticket."),
        ev("e2", "2026-10-13T11:00:00", ALEX, "status", "Open → In progress"),
        ev("e3", "2026-10-15T16:40:00", ALEX, "comment", "Battery replaced. Please confirm and close."),
        ev("e4", "2026-10-15T16:41:00", ALEX, "status", "In progress → Resolved"),
      ],
      createdAt: "2026-10-12T09:15:00",
      updatedAt: "2026-10-15T16:41:00",
    },
    {
      id: "TCK-1035",
      title: "Billing report totals off by a rupee",
      description: "Monthly summary rounds each line before summing. Totals differ from the ledger by ₹1–₹3.",
      type: "Bug",
      priority: "low",
      status: "Waiting",
      projectId: "p-north",
      projectName: "Northwind Billing",
      requesterId: BABU,
      assigneeId: PRIYA,
      watcherIds: [RAM],
      due: "2026-11-04",
      activity: [
        ev("e1", "2026-10-14T13:30:00", BABU, "created", "Raised the ticket."),
        ev("e2", "2026-10-14T14:00:00", RAM, "assigned", "Assigned to Priya Nair."),
        ev("e3", "2026-10-16T10:20:00", PRIYA, "status", "Open → Waiting"),
        ev("e4", "2026-10-16T10:21:00", PRIYA, "comment", "Waiting on Northwind finance to confirm the rounding rule."),
      ],
      createdAt: "2026-10-14T13:30:00",
      updatedAt: "2026-10-16T10:21:00",
    },
  ];
}

let cache: Ticket[] | null = null;
const listeners = new Set<() => void>();

function read(): Ticket[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Ticket[];
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {
    /* fall back to seed */
  }
  return seed();
}

/* ───────────── Backend mirror ───────────── */

interface TicketOut {
  id: string;
  title: string;
  description: string;
  type: TicketType;
  priority: TicketPriority;
  status: TicketStatus;
  project_id: string | null;
  project_name: string | null;
  requester_id: string;
  assignee_id: string | null;
  sub_owner_id: string | null;
  watcher_ids: string[];
  due: string | null;
  tasks: { id: string; title: string; owner_id: string | null; due: string | null; done: boolean }[];
  activity: { id: string; at: string; by_id: string; kind: TicketEvent["kind"]; text: string }[];
  created_at: string;
  updated_at: string;
  names: Record<string, string>;
  can_plan: boolean;
  next_statuses: TicketStatus[];
}

/** Names the server sent for people the portal directory may not list. */
const apiNames = new Map<string, string>();

function fromApi(t: TicketOut): Ticket {
  for (const [id, name] of Object.entries(t.names ?? {})) apiNames.set(id, name);
  return {
    id: t.id,
    title: t.title,
    description: t.description,
    type: t.type,
    priority: t.priority,
    status: t.status,
    projectId: t.project_id ?? undefined,
    projectName: t.project_name ?? undefined,
    requesterId: t.requester_id,
    assigneeId: t.assignee_id ?? undefined,
    subOwnerId: t.sub_owner_id ?? undefined,
    watcherIds: t.watcher_ids,
    due: t.due ?? undefined,
    tasks: t.tasks.map((k) => ({ id: k.id, title: k.title, ownerId: k.owner_id ?? undefined, due: k.due ?? undefined, done: k.done })),
    activity: t.activity.map((e) => ({ id: e.id, at: e.at, byId: e.by_id, kind: e.kind, text: e.text })),
    createdAt: t.created_at,
    updatedAt: t.updated_at,
    serverCanPlan: t.can_plan,
    serverNextStatuses: t.next_statuses,
  };
}

const mirror = createApiMirror<Ticket[]>(
  () => [],
  async () => (await api.get<TicketOut[]>("/tickets")).map(fromApi),
);

/** Backend mode: load the list again (to pick up other people's changes). Does nothing in local mode. */
export function refreshTickets(): Promise<void> {
  return API_ENABLED ? mirror.reload() : Promise.resolve();
}

/** Sends one change; on success the returned ticket replaces the mirror's copy. Null, or the error message. */
async function send(path: string, method: "POST" | "PUT" | "DELETE", body?: unknown): Promise<string | null> {
  try {
    const out = await apiRequest<TicketOut>(`/tickets${path}`, method === "DELETE" ? { method } : { method, body: body ?? {} });
    const row = fromApi(out);
    const list = mirror.get();
    mirror.set(list.some((t) => t.id === row.id) ? list.map((t) => (t.id === row.id ? row : t)) : [row, ...list]);
    return null;
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) void mirror.reload();
    return errorText(e);
  }
}

const enc = encodeURIComponent;

/* ───────────── Reading ───────────── */

export function getTickets(): Ticket[] {
  if (API_ENABLED) return mirror.get();
  if (!cache) cache = read();
  return cache;
}

export function subscribeTickets(listener: () => void) {
  if (API_ENABLED) return mirror.subscribe(listener);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function write(next: Ticket[]) {
  cache = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage full or blocked: keep in memory */
  }
  listeners.forEach((fn) => fn());
}

export function useTickets(): Ticket[] {
  return useSyncExternalStore(subscribeTickets, getTickets, getTickets);
}

export function personName(id: string | undefined): string {
  if (!id) return "Unassigned";
  return DEMO_ACCOUNTS.find((a) => a.id === id)?.fullName ?? taskPersonById(id)?.fullName ?? apiNames.get(id) ?? id;
}

const isAdmin = (role: string) => ["admin", "super_admin", "it_admin"].includes(role);
const managesPerson = (managerId: string, personId: string | undefined) =>
  !!personId && managementChain(personId).some((m) => m.id === managerId);

export function canViewTicket(t: Ticket, actor: TicketActor): boolean {
  if (API_ENABLED) return true; // the server only sends tickets this person may see
  return (
    t.requesterId === actor.id ||
    t.assigneeId === actor.id ||
    t.subOwnerId === actor.id ||
    !!t.tasks?.some((k) => k.ownerId === actor.id) ||
    t.watcherIds.includes(actor.id) ||
    managesPerson(actor.id, t.requesterId) ||
    managesPerson(actor.id, t.assigneeId) ||
    isAdmin(actor.role)
  );
}

/** Managers assign within their team; the queue owner (IT, HR) can hand their own ticket to their team too. */
export function canAssignTo(actor: TicketActor, assigneeId: string): boolean {
  return managesPerson(actor.id, assigneeId);
}

export function isOpenTicket(t: Ticket): boolean {
  return t.status !== "Resolved" && t.status !== "Closed";
}

/** Status moves allowed for this person on this ticket. */
export function nextStatuses(t: Ticket, actor: TicketActor): TicketStatus[] {
  if (t.serverNextStatuses) return t.serverNextStatuses;
  const out: TicketStatus[] = [];
  if (t.assigneeId === actor.id) {
    if (t.status === "Open") out.push("In progress", "Waiting", "Resolved");
    if (t.status === "In progress") out.push("Waiting", "Resolved");
    if (t.status === "Waiting") out.push("In progress", "Resolved");
  }
  if (t.requesterId === actor.id && t.status === "Resolved") out.push("Closed", "In progress");
  return [...new Set(out)];
}

function nextId(list: Ticket[]): string {
  const max = list.reduce((m, t) => Math.max(m, Number(t.id.replace(/\D/g, "")) || 0), 1000);
  return `TCK-${max + 1}`;
}

const stamp = () => new Date().toISOString();
const evId = () => `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const href = (id: string) => `/tickets?id=${id}`;

export async function createTicket(
  input: {
    title: string;
    description: string;
    type: TicketType;
    priority: TicketPriority;
    projectId?: string;
    projectName?: string;
    assigneeId?: string;
    due?: string;
  },
  actor: TicketActor,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const title = input.title.trim();
  if (title.length < 4) return { ok: false, error: "Add a short title." };
  if (input.due && input.due < new Date().toISOString().slice(0, 10)) return { ok: false, error: "Due date is in the past." };
  let assigneeId = input.assigneeId || undefined;
  if (assigneeId && assigneeId !== actor.id && !canAssignTo(actor, assigneeId)) {
    return { ok: false, error: "You can only assign to your team." };
  }
  if (API_ENABLED) {
    try {
      const out = await api.post<TicketOut>("/tickets", {
        title,
        description: input.description.trim(),
        type: input.type,
        priority: input.priority,
        project_id: input.projectId || null,
        project_name: input.projectId ? (input.projectName ?? null) : null,
        assignee_id: assigneeId ?? null,
        due: input.due || null,
      });
      mirror.set([fromApi(out), ...mirror.get()]);
      return { ok: true, id: out.id };
    } catch (e) {
      return { ok: false, error: errorText(e) };
    }
  }
  if (!assigneeId) assigneeId = QUEUE_OWNER[input.type];
  const list = getTickets();
  const id = nextId(list);
  const at = stamp();
  const activity = [ev(evId(), at, actor.id, "created", "Raised the ticket.")];
  if (assigneeId) activity.push(ev(evId(), at, actor.id, "assigned", `Assigned to ${personName(assigneeId)}.`));
  const ticket: Ticket = {
    id,
    title,
    description: input.description.trim(),
    type: input.type,
    priority: input.priority,
    status: "Open",
    projectId: input.projectId || undefined,
    projectName: input.projectId ? input.projectName : undefined,
    requesterId: actor.id,
    assigneeId,
    watcherIds: [],
    due: input.due || undefined,
    activity,
    createdAt: at,
    updatedAt: at,
  };
  write([ticket, ...list]);
  if (assigneeId && assigneeId !== actor.id) {
    pushPersonTaskAlert({
      recipientId: assigneeId,
      title: `Ticket assigned: ${id}`,
      body: `${title} — from ${actor.fullName}. Log time from your timesheet.`,
      href: href(id),
    });
  }
  return { ok: true, id };
}

function patch(id: string, fn: (t: Ticket) => Ticket) {
  write(getTickets().map((t) => (t.id === id ? fn(t) : t)));
}

export async function assignTicket(id: string, assigneeId: string, actor: TicketActor): Promise<string | null> {
  const t = getTickets().find((x) => x.id === id);
  if (!t) return "Ticket not found.";
  if (!isOpenTicket(t)) return "This ticket is already resolved.";
  if (t.assigneeId === assigneeId) return "Already assigned to that person.";
  if (!canAssignTo(actor, assigneeId)) return "You can only assign to your team.";
  if (API_ENABLED) return send(`/${enc(id)}/assign`, "POST", { assignee_id: assigneeId });
  patch(id, (x) => ({
    ...x,
    assigneeId,
    updatedAt: stamp(),
    activity: [...x.activity, ev(evId(), stamp(), actor.id, "assigned", `Assigned to ${personName(assigneeId)}.`)],
  }));
  pushPersonTaskAlert({
    recipientId: assigneeId,
    title: `Ticket assigned: ${id}`,
    body: `${t.title} — from ${actor.fullName}. Log time from your timesheet.`,
    href: href(id),
  });
  return null;
}

export async function setTicketStatus(id: string, status: TicketStatus, actor: TicketActor, note = ""): Promise<string | null> {
  const t = getTickets().find((x) => x.id === id);
  if (!t) return "Ticket not found.";
  if (!nextStatuses(t, actor).includes(status)) return "You can't make that change.";
  if (status === "Resolved" && !note.trim()) return "Add a short resolution note.";
  if (API_ENABLED) return send(`/${enc(id)}/status`, "POST", { status, note: note.trim() });
  const at = stamp();
  patch(id, (x) => ({
    ...x,
    status,
    updatedAt: at,
    activity: [
      ...x.activity,
      ev(evId(), at, actor.id, "status", `${x.status} → ${status}`),
      ...(note.trim() ? [ev(evId(), at, actor.id, "comment", note.trim())] : []),
    ],
  }));
  // Requester hears about every change; the assignee hears when the requester closes or reopens.
  const recipient = actor.id === t.requesterId ? t.assigneeId : t.requesterId;
  if (recipient && recipient !== actor.id) {
    pushPersonTaskAlert({
      recipientId: recipient,
      title: `${id} is now ${status}`,
      body: `${t.title}${note.trim() ? ` — ${note.trim()}` : ""}`,
      href: href(id),
    });
  }
  return null;
}

export async function commentOnTicket(id: string, text: string, actor: TicketActor): Promise<string | null> {
  const t = getTickets().find((x) => x.id === id);
  if (!t) return "Ticket not found.";
  if (!canViewTicket(t, actor)) return "You can't comment on this ticket.";
  if (!text.trim()) return "Write a comment first.";
  if (API_ENABLED) return send(`/${enc(id)}/comments`, "POST", { text: text.trim() });
  const at = stamp();
  patch(id, (x) => ({ ...x, updatedAt: at, activity: [...x.activity, ev(evId(), at, actor.id, "comment", text.trim())] }));
  return null;
}

export async function toggleWatch(id: string, personId: string, actor: TicketActor): Promise<string | null> {
  const t = getTickets().find((x) => x.id === id);
  if (!t) return "Ticket not found.";
  if (!canViewTicket(t, actor)) return "You can't change watchers here.";
  if (API_ENABLED) return send(`/${enc(id)}/watch`, "POST", { person_id: personId });
  const on = t.watcherIds.includes(personId);
  patch(id, (x) => ({
    ...x,
    watcherIds: on ? x.watcherIds.filter((w) => w !== personId) : [...x.watcherIds, personId],
    activity: [
      ...x.activity,
      ev(evId(), stamp(), actor.id, "watcher", `${on ? "Removed" : "Added"} watcher ${personName(personId)}.`),
    ],
  }));
  return null;
}

/** Open tickets assigned to this person: what they can log time against. */
export function ticketsAssignedTo(personId: string, list: Ticket[] = getTickets()): Ticket[] {
  return list.filter((t) => t.assigneeId === personId && isOpenTicket(t));
}

/** The counts on the Tickets page tabs (Assigned to me, My tickets, Team) — the sidebar badge uses the same numbers. */
export function ticketViewCounts(
  actor: TicketActor,
  list: Ticket[] = getTickets(),
  teamIds: ReadonlySet<string> = new Set(),
): { assigned: number; mine: number; team: number } {
  const visible = list.filter((t) => canViewTicket(t, actor));
  return {
    assigned: visible.filter((t) => t.assigneeId === actor.id && isOpenTicket(t)).length,
    mine: visible.filter((t) => t.requesterId === actor.id && t.status !== "Closed").length,
    team: visible.filter((t) => (teamIds.has(t.requesterId) || (!!t.assigneeId && teamIds.has(t.assigneeId))) && isOpenTicket(t)).length,
  };
}

/** Sidebar badge: what the Tickets page shows as "Assigned to me" (open tickets on me). */
export function ticketBadgeCount(actor: TicketActor, list: Ticket[] = getTickets()): number {
  return ticketViewCounts(actor, list).assigned;
}

/** Owner, sub-owner, requester and the owner's managers can change who works on it, the deadline and its tasks. */
export function canPlanTicket(t: Ticket, actor: TicketActor): boolean {
  if (!isOpenTicket(t)) return false;
  if (t.serverCanPlan !== undefined) return t.serverCanPlan;
  return (
    t.assigneeId === actor.id ||
    t.subOwnerId === actor.id ||
    t.requesterId === actor.id ||
    (!!t.assigneeId && managesPerson(actor.id, t.assigneeId))
  );
}

function plan(id: string, actor: TicketActor, text: string, fn: (t: Ticket) => Ticket): string | null {
  const t = getTickets().find((x) => x.id === id);
  if (!t) return "Ticket not found.";
  if (!canPlanTicket(t, actor)) return "Only the owner, sub-owner, requester or their manager can change this.";
  patch(id, (x) => ({ ...fn(x), updatedAt: stamp(), activity: [...x.activity, ev(evId(), stamp(), actor.id, "task", text)] }));
  return null;
}

export async function setTicketSubOwner(id: string, personId: string, actor: TicketActor): Promise<string | null> {
  const t = getTickets().find((x) => x.id === id);
  if (t && personId && personId === t.assigneeId) return "The owner can't also be the sub-owner.";
  if (API_ENABLED) return send(`/${enc(id)}/sub-owner`, "PUT", { person_id: personId || null });
  const error = plan(id, actor, personId ? `Sub-owner set to ${personName(personId)}.` : "Sub-owner removed.", (x) => ({
    ...x,
    subOwnerId: personId || undefined,
  }));
  if (!error && personId && personId !== actor.id && t) {
    pushPersonTaskAlert({ recipientId: personId, title: `Sub-owner on ${id}`, body: `${t.title} — from ${actor.fullName}.`, href: href(id) });
  }
  return error;
}

export async function setTicketDue(id: string, due: string, actor: TicketActor): Promise<string | null> {
  if (API_ENABLED) return send(`/${enc(id)}/due`, "PUT", { due: due || null });
  return plan(id, actor, due ? `Deadline set to ${due}.` : "Deadline removed.", (x) => ({ ...x, due: due || undefined }));
}

export async function addTicketTask(
  id: string,
  input: { title: string; ownerId?: string; due?: string },
  actor: TicketActor,
): Promise<string | null> {
  const title = input.title.trim();
  if (!title) return "Enter the task.";
  const t = getTickets().find((x) => x.id === id);
  if (t?.due && input.due && input.due > t.due) return "A task can't be due after the ticket's deadline.";
  if (API_ENABLED) return send(`/${enc(id)}/tasks`, "POST", { title, owner_id: input.ownerId || null, due: input.due || null });
  const task: TicketTask = { id: `tt-${evId()}`, title, ownerId: input.ownerId || undefined, due: input.due || undefined, done: false };
  const error = plan(id, actor, `Added task: ${title}.`, (x) => ({ ...x, tasks: [...(x.tasks ?? []), task] }));
  if (!error && task.ownerId && task.ownerId !== actor.id) {
    pushPersonTaskAlert({ recipientId: task.ownerId, title: `Task on ${id}`, body: `${title} — from ${actor.fullName}.`, href: href(id) });
  }
  return error;
}

export async function toggleTicketTask(id: string, taskId: string, actor: TicketActor): Promise<string | null> {
  const t = getTickets().find((x) => x.id === id);
  const task = t?.tasks?.find((k) => k.id === taskId);
  if (!t || !task) return "Task not found.";
  if (task.ownerId !== actor.id && !canPlanTicket(t, actor)) return "Only the task owner can tick this off.";
  if (!isOpenTicket(t)) return "This ticket is already resolved.";
  if (API_ENABLED) return send(`/${enc(id)}/tasks/${enc(taskId)}/toggle`, "POST");
  patch(id, (x) => ({
    ...x,
    updatedAt: stamp(),
    tasks: (x.tasks ?? []).map((k) => (k.id === taskId ? { ...k, done: !k.done } : k)),
    activity: [...x.activity, ev(evId(), stamp(), actor.id, "task", `${task.done ? "Reopened" : "Completed"} task: ${task.title}.`)],
  }));
  return null;
}

export async function removeTicketTask(id: string, taskId: string, actor: TicketActor): Promise<string | null> {
  const task = getTickets().find((x) => x.id === id)?.tasks?.find((k) => k.id === taskId);
  if (!task) return "Task not found.";
  if (API_ENABLED) return send(`/${enc(id)}/tasks/${enc(taskId)}`, "DELETE");
  return plan(id, actor, `Removed task: ${task.title}.`, (x) => ({ ...x, tasks: (x.tasks ?? []).filter((k) => k.id !== taskId) }));
}

/** "3 days left", "due today", "2 days overdue". */
export function deadlineLabel(due: string, today: string): string {
  const days = Math.round((Date.parse(`${due}T00:00:00`) - Date.parse(`${today}T00:00:00`)) / 86_400_000);
  if (days === 0) return "due today";
  if (days > 0) return `${days} day${days === 1 ? "" : "s"} left`;
  return `${-days} day${days === -1 ? "" : "s"} overdue`;
}

