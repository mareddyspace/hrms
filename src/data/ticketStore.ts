import { useSyncExternalStore } from "react";
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
  kind: "created" | "assigned" | "status" | "comment" | "watcher";
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
  watcherIds: string[];
  due?: string;
  activity: TicketEvent[];
  createdAt: string;
  updatedAt: string;
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
      watcherIds: [RAM],
      due: "2026-10-30",
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

export function getTickets(): Ticket[] {
  if (!cache) cache = read();
  return cache;
}

export function subscribeTickets(listener: () => void) {
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
  return DEMO_ACCOUNTS.find((a) => a.id === id)?.fullName ?? taskPersonById(id)?.fullName ?? id;
}

const isAdmin = (role: string) => ["admin", "super_admin", "it_admin"].includes(role);
const managesPerson = (managerId: string, personId: string | undefined) =>
  !!personId && managementChain(personId).some((m) => m.id === managerId);

export function canViewTicket(t: Ticket, actor: TicketActor): boolean {
  return (
    t.requesterId === actor.id ||
    t.assigneeId === actor.id ||
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

export function createTicket(
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
): { ok: true; id: string } | { ok: false; error: string } {
  const title = input.title.trim();
  if (title.length < 4) return { ok: false, error: "Add a short title." };
  if (input.due && input.due < new Date().toISOString().slice(0, 10)) return { ok: false, error: "Due date is in the past." };
  let assigneeId = input.assigneeId || undefined;
  if (assigneeId && assigneeId !== actor.id && !canAssignTo(actor, assigneeId)) {
    return { ok: false, error: "You can only assign to your team." };
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

export function assignTicket(id: string, assigneeId: string, actor: TicketActor): string | null {
  const t = getTickets().find((x) => x.id === id);
  if (!t) return "Ticket not found.";
  if (!isOpenTicket(t)) return "This ticket is already resolved.";
  if (t.assigneeId === assigneeId) return "Already assigned to that person.";
  if (!canAssignTo(actor, assigneeId)) return "You can only assign to your team.";
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

export function setTicketStatus(id: string, status: TicketStatus, actor: TicketActor, note = ""): string | null {
  const t = getTickets().find((x) => x.id === id);
  if (!t) return "Ticket not found.";
  if (!nextStatuses(t, actor).includes(status)) return "You can't make that change.";
  if (status === "Resolved" && !note.trim()) return "Add a short resolution note.";
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

export function commentOnTicket(id: string, text: string, actor: TicketActor): string | null {
  const t = getTickets().find((x) => x.id === id);
  if (!t) return "Ticket not found.";
  if (!canViewTicket(t, actor)) return "You can't comment on this ticket.";
  if (!text.trim()) return "Write a comment first.";
  const at = stamp();
  patch(id, (x) => ({ ...x, updatedAt: at, activity: [...x.activity, ev(evId(), at, actor.id, "comment", text.trim())] }));
  return null;
}

export function toggleWatch(id: string, personId: string, actor: TicketActor): string | null {
  const t = getTickets().find((x) => x.id === id);
  if (!t) return "Ticket not found.";
  if (!canViewTicket(t, actor)) return "You can't change watchers here.";
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

/** Sidebar badge: open tickets on me plus my resolved tickets waiting for me to close. */
export function ticketBadgeCount(personId: string, list: Ticket[] = getTickets()): number {
  return (
    ticketsAssignedTo(personId, list).length +
    list.filter((t) => t.requesterId === personId && t.status === "Resolved").length
  );
}
