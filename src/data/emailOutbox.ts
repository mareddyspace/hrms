import { useSyncExternalStore } from "react";
import { findDemoById } from "../demoAccounts.ts";
import type { NotifCategory } from "./collabData.ts";
import { getBasePeople } from "./peopleData.ts";
import { getPerson, listPeople } from "./peopleLocal.ts";
import type { NotificationPref } from "./platformData.ts";
import { API_ENABLED, apiRun, createApiMirror, errorText } from "../api/syncOps.ts";
import { apiMarkEmailsSent, apiSetEmailSwitch, loadApiEmail, type ApiEmailData, type EmailSwitchOut } from "../api/syncOpsAdmin.ts";

/**
 * Email events queued alongside in-app notifications. Nothing is sent from the browser:
 * rows wait as "Queued" until an admin marks them sent (or a mail relay picks them up).
 */
export type EmailStatus = "Queued" | "Sent";

export interface EmailEvent {
  id: string;
  to: string;
  recipientId: string;
  recipientName: string;
  subject: string;
  body: string;
  /** Absolute link back into the portal. */
  link?: string;
  /** Admin notification channel the email belongs to (approvals, announcements, ...). */
  channel: string;
  category: NotifCategory;
  createdAt: string;
  status: EmailStatus;
  sentAt?: string;
}

const KEY = "timez.email.outbox.v1";
/** Same key the admin notification preferences are saved under (platformLocal). */
const ADMIN_PREFS_KEY = "timez.platform.notifications.v1";
const MAX_STORED = 500;
/** Email switches as shipped (NOTIFICATION_PREF_SEED), used until an admin saves their own. */
const DEFAULT_EMAIL_SWITCHES: Pick<NotificationPref, "id" | "email">[] = [
  { id: "approvals", email: true },
  { id: "announcements", email: true },
  { id: "learning", email: false },
  { id: "integrations", email: true },
];

const listeners = new Set<() => void>();
let cache: EmailEvent[] | null = null;

function read(): EmailEvent[] {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as EmailEvent[]) : [];
    cache = Array.isArray(parsed) ? parsed.filter((e) => e && typeof e.id === "string") : [];
  } catch {
    cache = [];
  }
  return cache;
}

function write(rows: EmailEvent[]) {
  cache = rows.slice(0, MAX_STORED);
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* storage full or blocked: keep the in-memory copy */
  }
  listeners.forEach((fn) => fn());
}

/* ── Backend mode (VITE_API_URL): the server queues emails for its own notifications and keeps the switches ── */

const API_EMAIL_PREFIX = "api-em-";

/** Admins only (the API refuses others); empty until loaded. */
const emailMirror = createApiMirror<ApiEmailData | null>(
  () => null,
  () => loadApiEmail().catch(() => ({ switches: [], outbox: [] })),
);
if (API_ENABLED) emailMirror.subscribe(() => listeners.forEach((fn) => fn()));

let composedRows: { api: ApiEmailData | null; local: EmailEvent[]; people: unknown; out: EmailEvent[] } | null = null;

function apiRows(): EmailEvent[] {
  const api = emailMirror.get();
  const local = read();
  const people = listPeople(); // names for recipients who don't sign in
  if (composedRows?.api === api && composedRows.local === local && composedRows.people === people) return composedRows.out;
  const fromApi: EmailEvent[] = (api?.outbox ?? []).map((e) => ({
    id: `${API_EMAIL_PREFIX}${e.id}`,
    to: e.to_email,
    recipientId: e.recipient_id,
    recipientName: findDemoById(e.recipient_id)?.fullName ?? getPerson(e.recipient_id)?.fullName ?? e.recipient_id,
    subject: e.subject,
    body: e.body,
    link: e.link ? absoluteLink(e.link) : undefined,
    channel: e.channel,
    category: e.category as NotifCategory,
    createdAt: e.created_at,
    status: e.status === "Sent" ? "Sent" : "Queued",
    sentAt: e.sent_at ?? undefined,
  }));
  // Emails this browser queued for its own (local-only) notifications stay listed after the server's.
  const out = [...fromApi, ...local].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  composedRows = { api, local, people, out };
  return out;
}

/** Backend mode: the server's email switches (admins), or null before they load. */
export function apiEmailSwitches(): EmailSwitchOut[] | null {
  const api = emailMirror.get();
  return api && api.switches.length ? api.switches : null;
}

/** Backend mode: turns email on or off for a channel on the server. */
export function setApiEmailSwitch(channel: string, email: boolean): Promise<string | null> {
  return apiRun(() => apiSetEmailSwitch(channel, email), emailMirror);
}

export function subscribeEmailOutbox(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const snapshot = (): EmailEvent[] => (API_ENABLED ? apiRows() : read());

export function listEmailOutbox(): EmailEvent[] {
  return snapshot();
}

export function useEmailOutbox(): EmailEvent[] {
  return useSyncExternalStore(subscribeEmailOutbox, snapshot, snapshot);
}

/** Admin notification channel for a notification category; null when no channel covers it. */
export function emailChannelFor(category: NotifCategory): string | null {
  switch (category) {
    case "Approvals":
    case "Leave":
    case "Attendance":
      return "approvals";
    case "Holidays":
      return "announcements";
    case "System":
      return "integrations";
    default:
      return null;
  }
}

function adminPrefs(): Pick<NotificationPref, "id" | "email">[] {
  try {
    const raw = localStorage.getItem(ADMIN_PREFS_KEY);
    const parsed = raw ? (JSON.parse(raw) as NotificationPref[]) : null;
    return Array.isArray(parsed) ? parsed : DEFAULT_EMAIL_SWITCHES;
  } catch {
    return DEFAULT_EMAIL_SWITCHES;
  }
}

/** Whether admins allow email for this channel. Categories without a channel are always allowed. */
export function emailAllowedFor(category: NotifCategory): boolean {
  const channel = emailChannelFor(category);
  if (!channel) return true;
  const server = API_ENABLED ? apiEmailSwitches() : null;
  if (server) return server.find((s) => s.channel === channel)?.email !== false;
  const pref = adminPrefs().find((p) => p.id === channel);
  return pref ? pref.email !== false : true;
}

function addressFor(recipientId: string): { email: string; name: string } | null {
  const account = findDemoById(recipientId);
  if (account?.email) return { email: account.email, name: account.fullName };
  try {
    const person = getBasePeople().find((p) => p.id === recipientId);
    if (person?.email) return { email: person.email, name: person.fullName };
  } catch {
    /* directory not available */
  }
  return null;
}

function absoluteLink(href?: string): string | undefined {
  if (!href) return undefined;
  if (/^https?:\/\//i.test(href)) return href;
  try {
    return new URL(href, window.location.origin).toString();
  } catch {
    return href;
  }
}

let seq = 0;

/**
 * Queues an email for a person-targeted notification. Skipped when admins turned email off for the
 * channel or the person has no address in the directory. Returns the event, or null when skipped.
 */
export function queueEmailForNotification(input: {
  recipientId: string;
  category: NotifCategory;
  title: string;
  body: string;
  href?: string;
}): EmailEvent | null {
  // "System" covers integration alerts and plain task alerts; only connector alerts belong to Integration alerts.
  const isIntegration = input.category === "System" && (input.href ?? "").startsWith("/integrations");
  const channel = input.category === "System" && !isIntegration ? "general" : (emailChannelFor(input.category) ?? "general");
  if (channel !== "general" && !emailAllowedFor(input.category)) return null;
  const to = addressFor(input.recipientId);
  if (!to) return null;
  seq += 1;
  const event: EmailEvent = {
    id: `em-${Date.now().toString(36)}-${seq}`,
    to: to.email,
    recipientId: input.recipientId,
    recipientName: to.name,
    subject: input.title.trim(),
    body: input.body.trim(),
    link: absoluteLink(input.href),
    channel,
    category: input.category,
    createdAt: new Date().toISOString(),
    status: "Queued",
  };
  write([event, ...read()]);
  return event;
}

export function markEmailsSent(ids: string[]): number {
  const wanted = new Set(ids);
  const now = new Date().toISOString();
  let count = 0;
  const rows = read().map((e) => {
    if (!wanted.has(e.id) || e.status === "Sent") return e;
    count += 1;
    return { ...e, status: "Sent" as const, sentAt: now };
  });
  if (count > 0) write(rows);
  return count;
}

export function sendAllQueuedEmails(): number {
  return markEmailsSent(read().filter((e) => e.status === "Queued").map((e) => e.id));
}

/**
 * Marks emails sent: the server's rows through the API, this browser's own rows here.
 * Resolves to how many were marked, or an error message.
 */
export async function markEmailsSentAnywhere(ids: string[] | "all"): Promise<{ count: number } | { error: string }> {
  const rows = snapshot();
  const wanted = ids === "all" ? rows.filter((e) => e.status === "Queued").map((e) => e.id) : ids;
  const apiIds = wanted.filter((id) => id.startsWith(API_EMAIL_PREFIX)).map((id) => Number(id.slice(API_EMAIL_PREFIX.length)));
  const localCount = markEmailsSent(wanted.filter((id) => !id.startsWith(API_EMAIL_PREFIX)));
  if (!API_ENABLED || !apiIds.length) return { count: localCount };
  try {
    const out = await apiMarkEmailsSent(ids === "all" ? "all" : apiIds);
    return { count: localCount + out.marked };
  } catch (e) {
    return { error: errorText(e) };
  } finally {
    await emailMirror.reload();
  }
}

export function clearSentEmails(): number {
  const rows = read();
  const kept = rows.filter((e) => e.status !== "Sent");
  if (kept.length !== rows.length) write(kept);
  return rows.length - kept.length;
}
