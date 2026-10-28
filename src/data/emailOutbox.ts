import { useSyncExternalStore } from "react";
import { findDemoById } from "../demoAccounts.ts";
import type { NotifCategory } from "./collabData.ts";
import { getBasePeople } from "./peopleData.ts";
import type { NotificationPref } from "./platformData.ts";

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

export function subscribeEmailOutbox(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function listEmailOutbox(): EmailEvent[] {
  return read();
}

export function useEmailOutbox(): EmailEvent[] {
  return useSyncExternalStore(subscribeEmailOutbox, read, read);
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

export function clearSentEmails(): number {
  const rows = read();
  const kept = rows.filter((e) => e.status !== "Sent");
  if (kept.length !== rows.length) write(kept);
  return rows.length - kept.length;
}
