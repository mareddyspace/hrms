import { useSyncExternalStore } from "react";
import { mentionsRetiredAccount } from "../demoAccounts.ts";
import { API_ENABLED, api, apiRequest, apiSessionAccount } from "../api/client.ts";
import { createApiMirror, errorText } from "../api/syncOps.ts";
import { keepFresh } from "../api/syncShare.ts";

/**
 * Internal mail between a person and their reporting line / HR. Local mode keeps it in this browser
 * (kastech.mail.v1); with VITE_API_URL set it lives on the server (/mail) so recipients see it on their own sign-in.
 */
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
const LATER_MAIL = new Set(["ml-seed-5", "ml-seed-6", "ml-seed-7"]);

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
    {
      id: "ml-seed-5",
      threadId: "th-seed-priya-leave",
      fromId: "emp-priya",
      fromName: "Priya Nair",
      toIds: ["emp-ram"],
      ccIds: [],
      subject: "Two days off next week",
      body:
        "Hi Ram,\n\nI've applied for two days of privilege leave next week for a family function. Kabir will cover code reviews on Northwind and I'll hand over the self-service design notes before I go.\n\nThanks,\nPriya",
      sentAt: "2026-10-27T05:05:00.000Z",
      readBy: ["emp-priya"],
      category: "Leave",
    },
    {
      id: "ml-seed-6",
      threadId: "th-seed-oliver-expense",
      fromId: "emp-oliver",
      fromName: "Oliver Hughes",
      toIds: ["emp-ram"],
      ccIds: [],
      subject: "Train fare to Reading",
      body:
        "Hi Ram,\n\nI've submitted a claim for £86.40 for the return train to the Acme office in Reading for the UAT session. The receipt is attached to the claim.\n\nThanks,\nOliver",
      sentAt: "2026-10-01T16:20:00.000Z",
      readBy: ["emp-oliver", "emp-ram"],
      category: "Pay",
    },
    {
      id: "ml-seed-7",
      threadId: "th-seed-oliver-expense",
      fromId: "emp-ram",
      fromName: "Ram Krishnan",
      toIds: ["emp-oliver"],
      ccIds: [],
      subject: "Re: Train fare to Reading",
      body: "Hi Oliver,\n\nThanks — I'll approve it this week.\n\nRegards,\nRam",
      sentAt: "2026-10-02T08:10:00.000Z",
      readBy: ["emp-ram"],
      category: "Pay",
    },
  ];
}

/* ───────── Backend mirror ───────── */

interface MailOut {
  id: string;
  thread_id: string;
  from_id: string;
  from_name: string;
  to_ids: string[];
  cc_ids: string[];
  subject: string;
  body: string;
  category: MailCategory | null;
  sent_at: string;
  read_by: string[];
}

const utc = (iso: string) => (/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);

function fromApi(m: MailOut): MailMessage {
  return {
    id: m.id,
    threadId: m.thread_id,
    fromId: m.from_id,
    fromName: m.from_name,
    toIds: m.to_ids,
    ccIds: m.cc_ids,
    subject: m.subject,
    body: m.body,
    sentAt: utc(m.sent_at),
    readBy: m.read_by,
    category: m.category ?? undefined,
  };
}

const mirror = createApiMirror<MailMessage[]>(() => [], async () => (await api.get<MailOut[]>("/mail")).map(fromApi));
keepFresh(() => mirror.reload(), 30_000);

function read(): MailMessage[] {
  if (API_ENABLED) return mirror.get();
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    const saved = raw ? (JSON.parse(raw) as MailMessage[]) : null;
    // Mail to or from a retired sign-in account (the Compensation persona) is dropped.
    const kept = saved?.filter((m) => !mentionsRetiredAccount(m)) ?? null;
    if (saved && kept && kept.length !== saved.length) localStorage.setItem(KEY, JSON.stringify(kept));
    // Mail for sign-in accounts added later (Priya, Oliver) is added to saved mailboxes from before them.
    cache = kept ? [...kept, ...seed().filter((m) => LATER_MAIL.has(m.id) && !kept.some((k) => k.id === m.id))] : seed();
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
  if (API_ENABLED) return mirror.subscribe(listener);
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
  if (API_ENABLED) {
    const me = apiSessionAccount() ?? userId;
    const list = mirror.get();
    if (!list.some((m) => m.threadId === threadId && isRecipient(m, me) && !m.readBy.includes(me))) return;
    mirror.set(list.map((m) => (m.threadId === threadId && isRecipient(m, me) && !m.readBy.includes(me) ? { ...m, readBy: [...m.readBy, me] } : m)));
    void api.post(`/mail/threads/${encodeURIComponent(threadId)}/read`).catch((e) => console.warn("Could not mark mail read", e));
    return;
  }
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

/**
 * Sends mail in either mode: the server in backend mode (it also notifies the recipients), this browser otherwise.
 * Resolves to the sent message or an error message.
 */
export async function sendMailShared(input: Parameters<typeof sendMail>[0]): Promise<MailMessage | string> {
  if (!API_ENABLED) return sendMail(input);
  try {
    const out = fromApi(
      await api.post<MailOut>("/mail", {
        to_ids: input.toIds,
        cc_ids: input.ccIds ?? [],
        subject: input.subject.trim(),
        body: input.body.trim(),
        category: input.category ?? null,
        thread_id: input.threadId ?? null,
      }),
    );
    mirror.set([...mirror.get(), out]);
    return out;
  } catch (e) {
    return errorText(e);
  }
}

/** A mailto: link for the user's own mail app. Only addresses plus what the user typed. */
export function mailtoHref(toEmails: string[], ccEmails: string[], subject: string, body: string): string {
  const params: string[] = [];
  if (ccEmails.length) params.push(`cc=${encodeURIComponent(ccEmails.join(","))}`);
  if (subject) params.push(`subject=${encodeURIComponent(subject)}`);
  if (body) params.push(`body=${encodeURIComponent(body)}`);
  return `mailto:${toEmails.join(",")}${params.length ? `?${params.join("&")}` : ""}`;
}

/* ───────── Drafts ───────── */

export interface MailDraft {
  id: string;
  ownerId: string;
  toIds: string[];
  ccIds: string[];
  subject: string;
  body: string;
  category?: MailCategory;
  threadId?: string;
  updatedAt: string;
}

interface DraftOut {
  id: string;
  to_ids: string[];
  cc_ids: string[];
  subject: string;
  body: string;
  category: MailCategory | null;
  thread_id: string | null;
  updated_at: string;
}

const DRAFTS_KEY = "kastech.mail.drafts.v1";
const draftListeners = new Set<() => void>();
let draftCache: MailDraft[] | null = null;

const draftFromApi = (d: DraftOut): MailDraft => ({
  id: d.id,
  ownerId: apiSessionAccount() ?? "",
  toIds: d.to_ids,
  ccIds: d.cc_ids,
  subject: d.subject,
  body: d.body,
  category: d.category ?? undefined,
  threadId: d.thread_id ?? undefined,
  updatedAt: utc(d.updated_at),
});

const draftsMirror = createApiMirror<MailDraft[]>(() => [], async () => (await api.get<DraftOut[]>("/mail/drafts")).map(draftFromApi));

function readDrafts(): MailDraft[] {
  if (API_ENABLED) return draftsMirror.get();
  if (draftCache) return draftCache;
  try {
    const raw = localStorage.getItem(DRAFTS_KEY);
    draftCache = raw ? (JSON.parse(raw) as MailDraft[]) : [];
  } catch {
    draftCache = [];
  }
  return draftCache;
}

function writeDrafts(next: MailDraft[]) {
  draftCache = next;
  try {
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(next));
  } catch {
    /* keep in memory */
  }
  draftListeners.forEach((fn) => fn());
}

function subscribeDrafts(listener: () => void): () => void {
  if (API_ENABLED) return draftsMirror.subscribe(listener);
  draftListeners.add(listener);
  return () => {
    draftListeners.delete(listener);
  };
}

/** This person's unsent drafts, newest first. */
export function useDrafts(userId: string): MailDraft[] {
  const all = useSyncExternalStore(subscribeDrafts, readDrafts, readDrafts);
  return API_ENABLED ? all : all.filter((d) => d.ownerId === userId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export type DraftInput = Omit<MailDraft, "updatedAt" | "id"> & { id?: string };

/** Creates or updates a draft. Resolves to the saved draft or an error message. */
export async function saveDraft(input: DraftInput): Promise<MailDraft | string> {
  if (!input.subject.trim() && !input.body.trim() && input.toIds.length === 0) return "Nothing to save yet.";
  if (API_ENABLED) {
    const body = {
      to_ids: input.toIds,
      cc_ids: input.ccIds,
      subject: input.subject,
      body: input.body,
      category: input.category ?? null,
      thread_id: input.threadId ?? null,
    };
    try {
      const out = draftFromApi(
        input.id
          ? await apiRequest<DraftOut>(`/mail/drafts/${encodeURIComponent(input.id)}`, { method: "PUT", body })
          : await api.post<DraftOut>("/mail/drafts", body),
      );
      draftsMirror.set([out, ...draftsMirror.get().filter((d) => d.id !== out.id)]);
      return out;
    } catch (e) {
      return errorText(e);
    }
  }
  const draft: MailDraft = {
    ...input,
    id: input.id ?? `dr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    updatedAt: new Date().toISOString(),
  };
  writeDrafts([draft, ...readDrafts().filter((d) => d.id !== draft.id)]);
  return draft;
}

export async function deleteDraft(id: string): Promise<string | null> {
  if (API_ENABLED) {
    try {
      await apiRequest(`/mail/drafts/${encodeURIComponent(id)}`, { method: "DELETE" });
      draftsMirror.set(draftsMirror.get().filter((d) => d.id !== id));
      return null;
    } catch (e) {
      return errorText(e);
    }
  }
  writeDrafts(readDrafts().filter((d) => d.id !== id));
  return null;
}
