import { useSyncExternalStore } from "react";
import { mentionsRetiredAccount } from "../demoAccounts.ts";

/** Internal mail between a person and their reporting line / HR. */
export type MailCategory = "Leave" | "Attendance" | "Work from home" | "Pay" | "General";

export const MAIL_CATEGORIES: MailCategory[] = ["Leave", "Attendance", "Work from home", "Pay", "General"];

export interface MailMessage {
  id: string;
  threadId: string;
  fromId: string;
  fromName: string;
  toIds: string[];
  ccIds: string[];
  subject: string;
  body: string;
  /** ISO timestamp, UTC. */
  sentAt: string;
  /** People who have opened this message (the sender counts as having read it). */
  readBy: string[];
  category?: MailCategory;
}

export interface MailThread {
  threadId: string;
  subject: string;
  category?: MailCategory;
  messages: MailMessage[];
  latest: MailMessage;
  unread: number;
}

const KEY = "kastech.mail.v1";
const listeners = new Set<() => void>();
let cache: MailMessage[] | null = null;

function seed(): MailMessage[] {
  return [
    {
      id: "ml-seed-1",
      threadId: "th-seed-wfh",
      fromId: "emp-mahesh",
      fromName: "Babu Menon",
      toIds: ["emp-ram"],
      ccIds: [],
      subject: "Work from home request – 3 and 4 November",
      body:
        "Hi Ram,\n\nI'd like to work from home on 3 and 4 November. We have a plumber and electrician scheduled at home both days. I'll be online for the sprint review and will keep my status on Teams updated.\n\nCould we discuss if that works for the team?\n\nThanks,\nBabu",
      sentAt: "2026-10-21T04:12:00.000Z",
      readBy: ["emp-mahesh", "emp-ram"],
      category: "Work from home",
    },
    {
      id: "ml-seed-2",
      threadId: "th-seed-wfh",
      fromId: "emp-ram",
      fromName: "Ram Krishnan",
      toIds: ["emp-mahesh"],
      ccIds: [],
      subject: "Re: Work from home request – 3 and 4 November",
      body:
        "Hi Babu,\n\nThat's fine. Please join the sprint review on video and make sure the release checklist is updated before Monday. Raise the WFH request in the portal so it's on record.\n\nRegards,\nRam",
      sentAt: "2026-10-21T09:40:00.000Z",
      readBy: ["emp-ram"],
      category: "Work from home",
    },
    {
      id: "ml-seed-3",
      threadId: "th-seed-payslip",
      fromId: "demo-recruiter",
      fromName: "Sophie Clark",
      toIds: ["demo-hr-admin"],
      ccIds: [],
      subject: "Question about my October payslip",
      body:
        "Hi Farhan,\n\nMy October payslip doesn't show the referral bonus for the September hire. Could you check whether it moves to the November run?\n\nThanks,\nSophie",
      sentAt: "2026-10-24T14:05:00.000Z",
      readBy: ["demo-recruiter"],
      category: "Pay",
    },
    {
      id: "ml-seed-4",
      threadId: "th-seed-attendance",
      fromId: "emp-mahesh",
      fromName: "Babu Menon",
      toIds: ["emp-ram"],
      ccIds: [],
      subject: "Missed punch on 23 October",
      body:
        "Hi Ram,\n\nThe biometric reader at the main gate was down on 23 October so my check-in wasn't recorded. I was in office from 9:30 to 18:15. I've raised a regularisation request; please approve when you get a chance.\n\nThanks,\nBabu",
      sentAt: "2026-10-26T05:30:00.000Z",
      readBy: ["emp-mahesh"],
      category: "Attendance",
    },
  ];
}

function read(): MailMessage[] {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    const saved = raw ? (JSON.parse(raw) as MailMessage[]) : null;
    // Mail to or from a retired sign-in account (the Compensation persona) is dropped.
    const kept = saved?.filter((m) => !mentionsRetiredAccount(m)) ?? null;
    if (saved && kept && kept.length !== saved.length) localStorage.setItem(KEY, JSON.stringify(kept));
    cache = kept ?? seed();
  } catch {
    cache = seed();
  }
  return cache;
}

function write(next: MailMessage[]) {
  cache = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* keep in memory */
  }
  listeners.forEach((fn) => fn());
}

export function subscribeMail(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getMailSnapshot(): MailMessage[] {
  return read();
}

export function useMail(): MailMessage[] {
  return useSyncExternalStore(subscribeMail, read, read);
}

export function isRecipient(message: MailMessage, userId: string): boolean {
  return message.toIds.includes(userId) || message.ccIds.includes(userId);
}

export function countUnreadMail(userId: string, messages: MailMessage[] = read()): number {
  return messages.filter((m) => m.fromId !== userId && isRecipient(m, userId) && !m.readBy.includes(userId)).length;
}

function groupThreads(messages: MailMessage[], userId: string): MailThread[] {
  const byThread = new Map<string, MailMessage[]>();
  for (const m of messages) {
    if (m.fromId !== userId && !isRecipient(m, userId)) continue;
    const list = byThread.get(m.threadId) ?? [];
    list.push(m);
    byThread.set(m.threadId, list);
  }
  return [...byThread.entries()]
    .map(([threadId, list]) => {
      const sorted = [...list].sort((a, b) => a.sentAt.localeCompare(b.sentAt));
      const latest = sorted[sorted.length - 1];
      return {
        threadId,
        subject: sorted[0].subject,
        category: sorted[0].category,
        messages: sorted,
        latest,
        unread: countUnreadMail(userId, sorted),
      };
    })
    .sort((a, b) => b.latest.sentAt.localeCompare(a.latest.sentAt));
}

/** Threads where someone wrote to this person. */
export function inboxThreads(messages: MailMessage[], userId: string): MailThread[] {
  return groupThreads(messages, userId).filter((t) => t.messages.some((m) => m.fromId !== userId && isRecipient(m, userId)));
}

/** Threads this person has written in. */
export function sentThreads(messages: MailMessage[], userId: string): MailThread[] {
  return groupThreads(messages, userId).filter((t) => t.messages.some((m) => m.fromId === userId));
}

export function threadFor(messages: MailMessage[], userId: string, threadId: string): MailThread | undefined {
  return groupThreads(messages, userId).find((t) => t.threadId === threadId);
}

export function markThreadRead(threadId: string, userId: string): void {
  const current = read();
  let changed = false;
  const next = current.map((m) => {
    if (m.threadId !== threadId || !isRecipient(m, userId) || m.readBy.includes(userId)) return m;
    changed = true;
    return { ...m, readBy: [...m.readBy, userId] };
  });
  if (changed) write(next);
}

export function sendMail(input: {
  fromId: string;
  fromName: string;
  toIds: string[];
  ccIds?: string[];
  subject: string;
  body: string;
  category?: MailCategory;
  threadId?: string;
}): MailMessage {
  const stamp = Date.now().toString(36);
  const toIds = [...new Set(input.toIds)].filter((id) => id && id !== input.fromId);
  const ccIds = [...new Set(input.ccIds ?? [])].filter((id) => id && id !== input.fromId && !toIds.includes(id));
  const message: MailMessage = {
    id: `ml-${stamp}-${Math.random().toString(36).slice(2, 6)}`,
    threadId: input.threadId ?? `th-${stamp}`,
    fromId: input.fromId,
    fromName: input.fromName,
    toIds,
    ccIds,
    subject: input.subject.trim(),
    body: input.body.trim(),
    sentAt: new Date().toISOString(),
    readBy: [input.fromId],
    category: input.category,
  };
  write([...read(), message]);
  return message;
}

/** A mailto: link for the user's own mail app. Only addresses plus what the user typed. */
export function mailtoHref(toEmails: string[], ccEmails: string[], subject: string, body: string): string {
  const params: string[] = [];
  if (ccEmails.length) params.push(`cc=${encodeURIComponent(ccEmails.join(","))}`);
  if (subject) params.push(`subject=${encodeURIComponent(subject)}`);
  if (body) params.push(`body=${encodeURIComponent(body)}`);
  return `mailto:${toEmails.join(",")}${params.length ? `?${params.join("&")}` : ""}`;
}
