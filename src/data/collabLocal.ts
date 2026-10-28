import {
  ANNOUNCEMENTS_SEED,
  CONVERSATIONS_SEED,
  DEFAULT_NOTIF_PREFS,
  HR_DESK_OWNERS,
  HR_REQUESTS_SEED,
  HR_REQUEST_SLA,
  INBOX_SEED,
  NOTIFICATIONS_SEED,
  canAccessRestrictedChat,
  canManageAnnouncement,
  defaultNotifActionLabel,
  hrDeskOwnerName,
  hrRequestDueAt,
  inferNotifCategory,
  isHrRole,
  normalizeNotifCategory,
  notifPrefKey,
  notifRefFromHref,
  notificationVisibleForRole,
  taskDeepLink,
  type Announcement,
  type AppNotification,
  type ChatMessage,
  type Conversation,
  type HrRequest,
  type HrRequestCategory,
  type HrRequestPriority,
  type InboxTab,
  type InboxTask,
  type NotifCategory,
  type NotifPrefs,
  type NotifRef,
} from "./collabData.ts";
import { queueEmailForNotification } from "./emailOutbox.ts";
import { DEMO_ACCOUNTS, RETIRED_ACCOUNT_IDS, RETIRED_ACCOUNT_NAMES, findDemoById, managementChain, mentionsRetiredAccount } from "../demoAccounts.ts";

const KEY = "timez.collab.state.v6";
/** v5: old notification categories and seed rows that pointed at records that don't exist. */
const PREVIOUS_KEY = "timez.collab.state.v5";
/** Older saved state: notifications without recipients and one shared preference set. */
const LEGACY_KEY = "timez.collab.state.v4";

type CollabState = {
  inbox: InboxTask[];
  conversations: Conversation[];
  announcements: Announcement[];
  notifications: AppNotification[];
  /** Notification preferences per user id. Users without an entry get DEFAULT_NOTIF_PREFS. */
  prefsByUser: Record<string, NotifPrefs>;
  hrRequests: HrRequest[];
};

function defaults(): CollabState {
  return {
    inbox: structuredClone(INBOX_SEED),
    conversations: structuredClone(CONVERSATIONS_SEED),
    announcements: structuredClone(ANNOUNCEMENTS_SEED),
    notifications: structuredClone(NOTIFICATIONS_SEED),
    prefsByUser: {},
    hrRequests: structuredClone(HR_REQUESTS_SEED),
  };
}

type Legacy<T> = T & { read?: boolean; readByMe?: boolean; unread?: number };

/** Older saved state used shared read flags; convert them to per-user readBy lists. */
function migrate(state: CollabState): CollabState {
  state.conversations.forEach((c) => {
    const conv = c as Legacy<Conversation>;
    delete conv.unread;
    conv.messages.forEach((m) => {
      const msg = m as Legacy<ChatMessage>;
      if (!Array.isArray(msg.readBy)) msg.readBy = msg.read ? [...conv.participantIds] : [msg.fromId];
      delete msg.read;
    });
  });
  state.notifications.forEach((n) => {
    const row = n as Legacy<AppNotification>;
    // A legacy shared "read" flag cannot be attributed to one user; keep it read for everyone.
    if (!Array.isArray(row.readBy)) row.readBy = row.read ? DEMO_ACCOUNTS.map((a) => a.id) : [];
    delete row.read;
  });
  state.announcements.forEach((ann) => {
    const row = ann as Legacy<Announcement>;
    if (!Array.isArray(row.readBy)) row.readBy = row.readByMe ? DEMO_ACCOUNTS.map((a) => a.id) : [];
    delete row.readByMe;
  });
  return state;
}

/** Seed rows are "nf-<n>" / "nf-m<n>"; anything else was created while using the app. */
const SEED_ID = /^nf-m?\d+$/;
/** Features that no longer exist (checked on title + link; bodies quote user text such as task subjects). */
const RETIRED_FEATURE = /\b(cafeteria|cabs?|convert(ed|s)?|e-?sign(ature|ed|ing)?)\b/i;
/** Placeholder wording that should never reach a real inbox. */
const PLACEHOLDER_TEXT = /\b(dummy|lorem ipsum|fake|demo (data|only|account)|sample data)\b/i;
/** Keep the newest notifications only, so saved state can't grow without bound. */
const MAX_STORED = 500;

/**
 * Older saves seeded notifications that pointed at records which don't exist (or at generic pages).
 * Replace seed rows with the current seed (keeping who read or deleted them), drop retired seed rows,
 * and add new seed rows.
 */
function refreshSeedNotifications(rows: AppNotification[]): AppNotification[] {
  const seedById = new Map(NOTIFICATIONS_SEED.map((n) => [n.id, n]));
  const kept = rows
    .filter((row) => !SEED_ID.test(row.id) || seedById.has(row.id))
    .map((row) => {
      const seed = seedById.get(row.id);
      if (!seed) return row;
      return {
        ...structuredClone(seed),
        readBy: Array.isArray(row.readBy) ? Array.from(new Set([...row.readBy, ...seed.readBy])) : seed.readBy,
        hiddenFor: Array.isArray(row.hiddenFor) ? row.hiddenFor : [],
      };
    });
  const present = new Set(kept.map((n) => n.id));
  return [...kept, ...structuredClone(NOTIFICATIONS_SEED.filter((n) => !present.has(n.id)))];
}

/**
 * Brings any saved notification up to date: current categories, deep links to the exact task,
 * the record it is about, an action label that says what to do. Returns null for rows to drop.
 */
function normalizeNotification(row: AppNotification): AppNotification | null {
  if (!row || typeof row.id !== "string" || typeof row.title !== "string") return null;
  const body = typeof row.body === "string" ? row.body : "";
  if (RETIRED_FEATURE.test(`${row.title} ${row.href ?? ""}`) || PLACEHOLDER_TEXT.test(`${row.title} ${body}`)) return null;
  const rawCategory = String(row.category ?? "");
  const href = rawCategory === "Team" || rawCategory === "Tasks" || row.href === "/tasks" ? taskDeepLink(row.title, row.href) : row.href;
  const category = normalizeNotifCategory(rawCategory, href, row.title);
  const legacyRef: NotifRef | undefined = row.inboxTaskId ? { kind: "inbox", id: row.inboxTaskId } : undefined;
  return {
    ...row,
    body,
    category,
    href,
    at: typeof row.at === "string" ? row.at : new Date(0).toISOString(),
    readBy: Array.isArray(row.readBy) ? row.readBy : [],
    hiddenFor: Array.isArray(row.hiddenFor) ? row.hiddenFor : [],
    ref: row.ref ?? legacyRef ?? notifRefFromHref(href, row.title),
    actionLabel: row.actionLabel && row.actionLabel !== "Open" ? row.actionLabel : defaultNotifActionLabel(category),
    // Decisions happen on the request itself, never from a notification.
    actions: undefined,
  };
}

function normalizeNotifications(rows: AppNotification[]): AppNotification[] {
  return rows
    .map(normalizeNotification)
    .filter((n): n is AppNotification => n !== null)
    .slice(0, MAX_STORED);
}

/**
 * Saved data from before the Compensation persona was retired: drop chats, tasks, notifications and requests that
 * involve that account, and hand their announcements to HR. Returns true when anything changed.
 */
function dropRetiredAccounts(state: CollabState): boolean {
  let changed = false;
  const keep = <T,>(rows: T[]): T[] => {
    const kept = rows.filter((row) => !mentionsRetiredAccount(row));
    if (kept.length !== rows.length) changed = true;
    return kept;
  };
  state.inbox = keep(state.inbox);
  state.conversations = keep(state.conversations);
  state.notifications = keep(state.notifications);
  state.hrRequests = keep(state.hrRequests);
  state.announcements = state.announcements.map((a) => {
    if (!RETIRED_ACCOUNT_NAMES.has(a.author) && !(a.authorId && RETIRED_ACCOUNT_IDS.has(a.authorId))) return a;
    changed = true;
    return { ...a, author: "Farhan Ali", authorId: "demo-hr-admin" };
  });
  for (const id of RETIRED_ACCOUNT_IDS) {
    if (id in state.prefsByUser) {
      delete state.prefsByUser[id];
      changed = true;
    }
  }
  return changed;
}

function read(): CollabState {
  const state = readStored();
  state.hrRequests = state.hrRequests.map(withHrDesk);
  return state;
}

/**
 * Fills service-desk fields on tickets saved before routing existed: owner from the category,
 * normal priority, due time from the SLA and the first HR reply from the comments.
 */
function withHrDesk(r: HrRequest): HrRequest {
  if (r.submittedAt && r.dueAt && r.priority && typeof r.assigneeId === "string") return r;
  const submittedAt = r.submittedAt ?? r.comments[0]?.at ?? `${r.createdAt}T09:00:00`;
  const firstReply = r.comments.find((c, i) => i > 0 && c.author !== r.requesterName);
  return {
    ...r,
    submittedAt,
    priority: r.priority ?? "Normal",
    assigneeId: typeof r.assigneeId === "string" ? r.assigneeId : (HR_REQUEST_SLA[r.category] ?? HR_REQUEST_SLA.Other).ownerId,
    dueAt: r.dueAt ?? hrRequestDueAt(r.category, submittedAt),
    firstResponseAt: r.firstResponseAt ?? firstReply?.at,
  };
}

function readStored(): CollabState {
  const base = defaults();
  try {
    let raw = localStorage.getItem(KEY);
    let from: "current" | "previous" | "legacy" = "current";
    if (!raw) {
      raw = localStorage.getItem(PREVIOUS_KEY);
      from = "previous";
    }
    if (!raw) {
      raw = localStorage.getItem(LEGACY_KEY);
      from = "legacy";
    }
    if (!raw) {
      base.notifications = normalizeNotifications(base.notifications);
      return base;
    }
    const legacy = from === "legacy";
    const parsed = JSON.parse(raw) as Partial<CollabState>;
    const saved = Array.isArray(parsed.notifications) ? parsed.notifications : base.notifications;
    const state = migrate({
      inbox: Array.isArray(parsed.inbox) ? parsed.inbox : base.inbox,
      conversations: Array.isArray(parsed.conversations) ? parsed.conversations : base.conversations,
      announcements: Array.isArray(parsed.announcements) ? parsed.announcements : base.announcements,
      notifications: saved,
      // A legacy shared preference set can't be attributed to one person, so everyone starts from the defaults.
      prefsByUser:
        !legacy && parsed.prefsByUser && typeof parsed.prefsByUser === "object" ? parsed.prefsByUser : base.prefsByUser,
      hrRequests: Array.isArray(parsed.hrRequests) ? parsed.hrRequests : base.hrRequests,
    });
    state.notifications = normalizeNotifications(
      from === "current" ? state.notifications : refreshSeedNotifications(state.notifications),
    );
    const retiredDropped = dropRetiredAccounts(state);
    if (from !== "current" || retiredDropped) {
      localStorage.setItem(KEY, JSON.stringify(state));
      localStorage.removeItem(PREVIOUS_KEY);
      localStorage.removeItem(LEGACY_KEY);
    }
    return state;
  } catch {
    return base;
  }
}

/** Signed-in persona id (the key the portal store writes) — used when callers pass no user. */
const USER_KEY = "kastech.ess.user";
export function currentCollabUserId(): string | undefined {
  try {
    return localStorage.getItem(USER_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function write(state: CollabState) {
  cache = state;
  localStorage.setItem(KEY, JSON.stringify(state));
  listeners.forEach((fn) => fn());
}

const listeners = new Set<() => void>();
let cache: CollabState | null = null;

export function subscribeCollab(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Stable snapshot for useSyncExternalStore. */
export function getCollabState(): CollabState {
  if (!cache) cache = read();
  return cache;
}

export function updateCollab(mutator: (state: CollabState) => void) {
  const state = structuredClone(getCollabState());
  mutator(state);
  write(state);
}

export type DecideResult = { ok: true } | { ok: false; error: string };

/** Records a decision on a pending inbox item. Returns ok:false when nothing changed. */
export function decideInboxTask(
  id: string,
  decision: "Approved" | "Rejected",
  actor: string,
  reason?: string,
): DecideResult {
  const current = getCollabState().inbox.find((t) => t.id === id);
  if (!current) return { ok: false, error: "This request no longer exists." };
  if (current.status !== "Pending") {
    return { ok: false, error: `This request is already ${current.status.toLowerCase()}.` };
  }
  updateCollab((s) => {
    const row = s.inbox.find((t) => t.id === id);
    if (!row || row.status !== "Pending") return;
    row.status = decision;
    row.timeline.push({
      at: new Date().toISOString(),
      actor,
      action: decision,
      comment: reason,
      status: decision,
    });
    const category: NotifCategory =
      row.kind === "Leave" ? "Leave" : row.kind === "Timesheet" || row.kind === "Attendance correction" ? "Attendance" : "System";
    const href = row.kind === "Attendance correction" ? "/attendance" : row.kind === "Timesheet" ? "/timesheet" : "/leave";
    // Only the requester hears about the decision on their own request.
    deliverInto(s, {
      category,
      title: `${row.kind} ${decision.toLowerCase()}`,
      body: row.title,
      audience: "employee",
      recipientId: row.requesterId,
      href,
    });
  });
  return { ok: true };
}

export function delegateInboxTask(id: string, actor: string, delegateTo: string, comment: string) {
  updateCollab((s) => {
    const row = s.inbox.find((t) => t.id === id);
    if (!row || row.status !== "Pending") return;
    row.status = "Delegated";
    row.delegatedTo = delegateTo;
    row.timeline.push({
      at: new Date().toISOString(),
      actor,
      action: "Delegated",
      comment,
      status: "Delegated",
    });
  });
}

/* ── Messages ── */

export function isMessageUnreadFor(m: ChatMessage, userId: string): boolean {
  return m.fromId !== userId && !m.readBy.includes(userId);
}

export function conversationUnreadCount(conv: Conversation, userId: string): number {
  return conv.messages.filter((m) => isMessageUnreadFor(m, userId)).length;
}

/** Returns an error message, or null when sent. Only the sender is marked as having read it. */
export function sendChatMessage(
  conversationId: string,
  fromId: string,
  fromName: string,
  text: string,
  attachmentName?: string,
): string | null {
  const body = text.trim();
  if (!body) return "Message cannot be empty.";
  const conv = getCollabState().conversations.find((c) => c.id === conversationId);
  if (!conv) return "Conversation not found.";
  if (!conv.participantIds.includes(fromId)) return "You are not a participant in this conversation.";
  updateCollab((s) => {
    const row = s.conversations.find((c) => c.id === conversationId);
    if (!row) return;
    row.messages.push({
      id: `msg-${Date.now()}`,
      fromId,
      fromName,
      text: body,
      at: new Date().toISOString(),
      readBy: [fromId],
      attachmentName,
    });
  });
  return null;
}

export function markConversationRead(conversationId: string, userId: string) {
  const current = getCollabState().conversations.find((c) => c.id === conversationId);
  if (!current || conversationUnreadCount(current, userId) === 0) return;
  updateCollab((s) => {
    const conv = s.conversations.find((c) => c.id === conversationId);
    if (!conv) return;
    conv.messages.forEach((m) => {
      if (!m.readBy.includes(userId)) m.readBy.push(userId);
    });
  });
}

export function conversationVisibleToUser(conv: Conversation, userId: string, role: string): boolean {
  if (!conv.participantIds.includes(userId)) return false;
  return canAccessRestrictedChat(conv.restricted, role);
}

export function listConversationsForUser(userId: string, role: string): Conversation[] {
  return getCollabState().conversations.filter((c) => conversationVisibleToUser(c, userId, role));
}

export function startDirectChat(personId: string, personName: string, selfId: string, selfName: string) {
  let createdId = "";
  updateCollab((s) => {
    const existing = s.conversations.find(
      (c) =>
        c.kind === "direct" &&
        !c.restricted &&
        c.participantIds.includes(personId) &&
        c.participantIds.includes(selfId),
    );
    if (existing) {
      createdId = existing.id;
      return;
    }
    createdId = `cv-local-${Date.now()}`;
    s.conversations.unshift({
      id: createdId,
      kind: "direct",
      title: personName,
      participantIds: [selfId, personId],
      participantNames: [selfName, personName],
      messages: [],
    });
  });
  return createdId;
}

export function createGroupConversation(input: {
  title: string;
  selfId: string;
  selfName: string;
  memberIds: string[];
  memberNames: string[];
}): string {
  const title = input.title.trim() || "New group";
  const ids = Array.from(new Set([input.selfId, ...input.memberIds]));
  const names = Array.from(new Set([input.selfName, ...input.memberNames]));
  let createdId = "";
  updateCollab((s) => {
    createdId = `cv-group-${Date.now()}`;
    s.conversations.unshift({
      id: createdId,
      kind: "group",
      title,
      participantIds: ids,
      participantNames: names,
      messages: [
        {
          id: `msg-${Date.now()}`,
          fromId: input.selfId,
          fromName: input.selfName,
          text: `Created group “${title}”.`,
          at: new Date().toISOString(),
          readBy: [input.selfId],
        },
      ],
    });
  });
  return createdId;
}

/* ── Announcements ── */

export function markAnnouncementRead(id: string, userId: string) {
  const current = getCollabState().announcements.find((a) => a.id === id);
  if (!current || current.readBy.includes(userId)) return;
  updateCollab((s) => {
    const row = s.announcements.find((a) => a.id === id);
    if (row && !row.readBy.includes(userId)) row.readBy.push(userId);
  });
}

/** Returns an error message, or null when the state changed. */
export function setAnnouncementState(
  id: string,
  state: Announcement["state"],
  actor: { id: string; fullName: string; role: string },
): string | null {
  const current = getCollabState().announcements.find((a) => a.id === id);
  if (!current) return "Announcement not found.";
  if (!canManageAnnouncement(current, actor)) {
    return "Only HR or admins can publish this; managers may publish only their own Team posts.";
  }
  updateCollab((s) => {
    const row = s.announcements.find((a) => a.id === id);
    if (!row) return;
    row.state = state;
    if (state === "Published") {
      row.publishedAt = new Date().toISOString();
      row.scheduledFor = undefined;
    }
  });
  return null;
}

/* ── Notifications ── */

export function isNotificationReadBy(n: AppNotification, userId: string | undefined): boolean {
  return !!userId && n.readBy.includes(userId);
}

function roleOf(userId: string): string {
  return findDemoById(userId)?.role ?? "employee";
}

function atMs(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

/** Applies a per-user change to the given notifications; writes only when something changed. */
function patchNotifications(ids: string[], userId: string | undefined, change: (n: AppNotification, userId: string) => boolean) {
  if (!userId || ids.length === 0) return;
  const wanted = new Set(ids);
  const probe = structuredClone(getCollabState().notifications.filter((n) => wanted.has(n.id)));
  if (!probe.some((n) => change(n, userId))) return;
  updateCollab((s) => {
    s.notifications.forEach((n) => {
      if (wanted.has(n.id)) change(n, userId);
    });
  });
}

const addRead = (n: AppNotification, userId: string) => {
  if (n.readBy.includes(userId)) return false;
  n.readBy.push(userId);
  return true;
};

export function markNotificationsRead(ids: string[], userId = currentCollabUserId()) {
  patchNotifications(ids, userId, addRead);
}

export function markNotificationRead(id: string, userId = currentCollabUserId()) {
  markNotificationsRead([id], userId);
}

export function markNotificationsUnread(ids: string[], userId = currentCollabUserId()) {
  patchNotifications(ids, userId, (n, uid) => {
    if (!n.readBy.includes(uid)) return false;
    n.readBy = n.readBy.filter((id) => id !== uid);
    return true;
  });
}

/** Deletes notifications from this user's list only (shared notices stay for everyone else). */
export function deleteNotifications(ids: string[], userId = currentCollabUserId()) {
  patchNotifications(ids, userId, (n, uid) => {
    const hidden = n.hiddenFor ?? [];
    if (hidden.includes(uid)) return false;
    n.hiddenFor = [...hidden, uid];
    return true;
  });
}

export function markAllNotificationsRead(role?: string, userId = currentCollabUserId()) {
  if (!userId) return;
  markNotificationsRead(
    visibleNotificationsFor(userId, role ?? roleOf(userId)).map((n) => n.id),
    userId,
  );
}

/** One user's notification preferences (defaults when they haven't changed any). Ignores keys from older versions. */
export function notifPrefsFor(userId: string | undefined, state: CollabState = getCollabState()): NotifPrefs {
  const out: NotifPrefs = { ...DEFAULT_NOTIF_PREFS };
  const saved = (userId ? state.prefsByUser[userId] : undefined) as Record<string, unknown> | undefined;
  if (!saved) return out;
  (Object.keys(out) as (keyof NotifPrefs)[]).forEach((key) => {
    if (typeof saved[key] === "boolean") out[key] = saved[key] as boolean;
  });
  return out;
}

export function setNotifPrefs(prefs: NotifPrefs, userId = currentCollabUserId()) {
  if (!userId) return;
  updateCollab((s) => {
    s.prefsByUser = { ...s.prefsByUser, [userId]: { ...prefs } };
  });
}

/** Whether this user wants notifications of this category at all. */
export function wantsNotification(userId: string, category: NotifCategory, state: CollabState = getCollabState()): boolean {
  return notifPrefsFor(userId, state)[notifPrefKey(category)] !== false;
}

/** Notifications this user can see and hasn't muted or deleted, newest first. */
export function visibleNotificationsFor(
  userId: string,
  role: string = roleOf(userId),
  state: CollabState = getCollabState(),
): AppNotification[] {
  const prefs = notifPrefsFor(userId, state);
  return state.notifications
    .filter(
      (n) =>
        notificationVisibleForRole(n, role, userId) &&
        !(n.hiddenFor ?? []).includes(userId) &&
        prefs[notifPrefKey(n.category)] !== false,
    )
    .sort((a, b) => atMs(b.at) - atMs(a.at));
}

/** One row in the Notification Center: a notification, or several identical ones collapsed (×N). */
export interface NotifFeedItem {
  /** Id of the newest notification in the row. */
  key: string;
  head: AppNotification;
  ids: string[];
  count: number;
  /** Every notification in the row has been read by this user. */
  read: boolean;
  /** Unread and still needs attention (what the badges count). */
  unread: boolean;
  /** The item it points at no longer needs this user (decided, closed, read elsewhere). */
  done: boolean;
}

/** Same title + link within this window collapse into one row. */
export const COLLAPSE_WINDOW_MS = 30 * 60_000;

export type NotifDoneCheck = (n: AppNotification) => boolean;

/** Done checks that only need collab data (approvals inbox, chat threads). */
export function collabNotificationDone(n: AppNotification, userId: string, state: CollabState = getCollabState()): boolean {
  const ref = n.ref;
  if (!ref) return false;
  if (ref.kind === "inbox") {
    const task = state.inbox.find((t) => t.id === ref.id);
    return !task || task.status !== "Pending";
  }
  if (ref.kind === "chat") {
    const conv = state.conversations.find((c) => c.id === ref.id);
    return !!conv && conversationUnreadCount(conv, userId) === 0;
  }
  return false;
}

/**
 * The single source for the Notification Center list and every unread badge: visibility, preferences,
 * deletions, duplicate collapsing and done items. Pass isDone to add checks against other stores.
 */
export function notificationFeedFor(
  userId: string,
  role: string = roleOf(userId),
  isDone?: NotifDoneCheck,
  state: CollabState = getCollabState(),
): NotifFeedItem[] {
  const items: NotifFeedItem[] = [];
  const lastSeen = new Map<string, { item: NotifFeedItem; at: number }>();
  for (const n of visibleNotificationsFor(userId, role, state)) {
    const signature = `${n.title}\u0000${n.href ?? ""}`;
    const at = atMs(n.at);
    const unread = !n.readBy.includes(userId);
    const open = lastSeen.get(signature);
    if (open && open.at - at <= COLLAPSE_WINDOW_MS) {
      open.item.ids.push(n.id);
      open.item.count += 1;
      open.item.unread ||= unread;
      open.item.read &&= !unread;
      open.at = at;
      continue;
    }
    const item: NotifFeedItem = { key: n.id, head: n, ids: [n.id], count: 1, read: !unread, unread, done: false };
    items.push(item);
    lastSeen.set(signature, { item, at });
  }
  for (const item of items) {
    item.done = collabNotificationDone(item.head, userId, state) || (isDone?.(item.head) ?? false);
    if (item.done) item.unread = false;
  }
  return items;
}

/* ── HR requests ── */

const hrRequestLink = (id: string) => `/help?request=${encodeURIComponent(id)}`;

/** Whether this person works the HR service desk (HR roles, or a named desk owner). */
export function isHrDeskMember(userId: string, role: string): boolean {
  return isHrRole(role) || HR_DESK_OWNERS.some((o) => o.id === userId);
}

function formatDue(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** Routes the request to the category owner, sets its SLA due time and tells the owner. Returns the new id. */
export function createHrRequest(input: {
  category: HrRequestCategory;
  subject: string;
  description: string;
  author: string;
  requesterId: string;
  priority?: HrRequestPriority;
}): string {
  const id = `hr-local-${Date.now()}`;
  updateCollab((s) => {
    const now = new Date().toISOString();
    const route = HR_REQUEST_SLA[input.category] ?? HR_REQUEST_SLA.Other;
    // Nobody works their own ticket: if the routed owner raised it, leave it for HR to pick up.
    const assigneeId = route.ownerId === input.requesterId ? "" : route.ownerId;
    const subject = input.subject.trim();
    const dueAt = hrRequestDueAt(input.category, now);
    s.hrRequests.unshift({
      id,
      category: input.category,
      subject,
      description: input.description.trim(),
      status: "Open",
      requesterId: input.requesterId,
      requesterName: input.author,
      createdAt: now.slice(0, 10),
      updatedAt: now.slice(0, 10),
      comments: [{ at: now, author: input.author, text: input.description.trim() }],
      submittedAt: now,
      assigneeId,
      priority: input.priority ?? "Normal",
      dueAt,
    });
    if (assigneeId) {
      deliverInto(s, {
        category: "Tickets",
        title: `HR request assigned · ${subject}`,
        body: `${input.author} raised a ${input.category} request. Due ${formatDue(dueAt)}.`,
        audience: "employee",
        recipientId: assigneeId,
        href: hrRequestLink(id),
        actionLabel: "Open request",
      });
    }
  });
  return id;
}

/** Own tickets for everyone; HR sees all (including legacy tickets with no requester); owners see theirs. */
export function hrRequestVisibleTo(r: HrRequest, userId: string, role: string): boolean {
  if (isHrRole(role)) return true;
  if (!!r.assigneeId && r.assigneeId === userId) return true;
  return !!r.requesterId && r.requesterId === userId;
}

/** HR, or the owner the ticket is assigned to — never on a ticket they raised themselves. */
export function worksHrRequest(r: HrRequest, userId: string, role: string): boolean {
  if (r.requesterId === userId) return false;
  return isHrRole(role) || (!!r.assigneeId && r.assigneeId === userId);
}

/** Statuses the viewer may move this ticket to (excluding its current one). */
export function allowedHrStatuses(r: HrRequest, userId: string, role: string): HrRequest["status"][] {
  // HR works other people's tickets. On a ticket they raised themselves they are the requester and another
  // HR member has to resolve it.
  if (worksHrRequest(r, userId, role)) {
    return (["In progress", "Waiting on you", "Resolved", "Closed"] as const).filter((s) => s !== r.status);
  }
  if (r.requesterId !== userId) return [];
  // Requester: close a resolved ticket, or reopen it.
  if (r.status === "Resolved") return ["Closed", "In progress"];
  if (r.status === "Closed") return ["In progress"];
  return [];
}

/** HR may reassign any ticket they didn't raise. */
export function canReassignHrRequest(r: HrRequest, userId: string, role: string): boolean {
  return isHrRole(role) && r.requesterId !== userId;
}

/** Tells the requester (or, when the requester acted, the owner) that the status changed. */
function notifyHrStatusChange(s: CollabState, row: HrRequest, actorId: string, actorName: string) {
  const toRequester = !!row.requesterId && row.requesterId !== actorId;
  const recipientId = toRequester ? row.requesterId : row.assigneeId;
  if (!recipientId || recipientId === actorId) return;
  deliverInto(s, {
    category: "Tickets",
    title: `HR request ${row.status.toLowerCase()} · ${row.subject}`,
    body: toRequester
      ? `${actorName} set your request to ${row.status}.${row.status === "Waiting on you" ? " HR needs a reply from you." : ""}`
      : `${actorName} changed the request to ${row.status}.`,
    audience: "employee",
    recipientId,
    href: hrRequestLink(row.id),
    actionLabel: "Open request",
  });
}

/** Returns an error message, or null when the comment was added. */
export function addHrComment(
  id: string,
  author: string,
  text: string,
  actor: { id: string; role: string },
): string | null {
  const body = text.trim();
  if (!body) return "Comment cannot be empty.";
  const current = getCollabState().hrRequests.find((r) => r.id === id);
  if (!current || !hrRequestVisibleTo(current, actor.id, actor.role)) return "Request not found.";
  const byHr = worksHrRequest(current, actor.id, actor.role);
  updateCollab((s) => {
    const row = s.hrRequests.find((r) => r.id === id);
    if (!row) return;
    const now = new Date().toISOString();
    const before = row.status;
    row.comments.push({ at: now, author, text: body });
    row.updatedAt = now.slice(0, 10);
    if (byHr && !row.firstResponseAt) row.firstResponseAt = now;
    if (row.status === "Open" && byHr) row.status = "In progress";
    // The employee answered HR's question — back into HR's queue.
    if (row.status === "Waiting on you" && !byHr) row.status = "In progress";
    if (row.status !== before) notifyHrStatusChange(s, row, actor.id, author);
  });
  return null;
}

/** Returns an error message, or null when the status changed. */
export function setHrRequestStatus(
  id: string,
  status: HrRequest["status"],
  actor: { id: string; role: string; name?: string },
): string | null {
  const current = getCollabState().hrRequests.find((r) => r.id === id);
  if (!current || !hrRequestVisibleTo(current, actor.id, actor.role)) return "Request not found.";
  if (!allowedHrStatuses(current, actor.id, actor.role).includes(status)) {
    if (isHrRole(actor.role) && current.requesterId === actor.id) {
      return "You raised this request, so another HR team member has to resolve it. You can close it once it's resolved.";
    }
    return isHrRole(actor.role)
      ? "That status change is not allowed."
      : "Only HR can update this status. You can close a resolved request or reopen it.";
  }
  const byHr = worksHrRequest(current, actor.id, actor.role);
  const actorName = actor.name ?? findDemoById(actor.id)?.fullName ?? "HR";
  updateCollab((s) => {
    const row = s.hrRequests.find((r) => r.id === id);
    if (!row) return;
    const now = new Date().toISOString();
    row.status = status;
    row.updatedAt = now.slice(0, 10);
    if (byHr && !row.firstResponseAt) row.firstResponseAt = now;
    notifyHrStatusChange(s, row, actor.id, actorName);
  });
  return null;
}

/** Returns an error message, or null when the owner changed. Pass "" to unassign. */
export function assignHrRequest(
  id: string,
  assigneeId: string,
  actor: { id: string; role: string; name: string },
): string | null {
  const current = getCollabState().hrRequests.find((r) => r.id === id);
  if (!current) return "Request not found.";
  if (!canReassignHrRequest(current, actor.id, actor.role)) return "Only HR can reassign this request.";
  if (assigneeId && assigneeId === current.requesterId) return "The requester can't own their own request.";
  if ((current.assigneeId ?? "") === assigneeId) return null;
  updateCollab((s) => {
    const row = s.hrRequests.find((r) => r.id === id);
    if (!row) return;
    const now = new Date().toISOString();
    row.assigneeId = assigneeId;
    row.updatedAt = now.slice(0, 10);
    row.comments.push({
      at: now,
      author: actor.name,
      text: assigneeId ? `Assigned to ${hrDeskOwnerName(assigneeId)}.` : "Unassigned.",
    });
    if (assigneeId && assigneeId !== actor.id) {
      deliverInto(s, {
        category: "Tickets",
        title: `HR request assigned · ${row.subject}`,
        body: `${actor.name} assigned you a ${row.category} request from ${row.requesterName ?? "an employee"}.${
          row.dueAt ? ` Due ${formatDue(row.dueAt)}.` : ""
        }`,
        audience: "employee",
        recipientId: assigneeId,
        href: hrRequestLink(row.id),
        actionLabel: "Open request",
      });
    }
  });
  return null;
}

/** Returns an error message, or null when the priority changed. */
export function setHrRequestPriority(
  id: string,
  priority: HrRequestPriority,
  actor: { id: string; role: string },
): string | null {
  const current = getCollabState().hrRequests.find((r) => r.id === id);
  if (!current) return "Request not found.";
  if (!worksHrRequest(current, actor.id, actor.role)) return "Only HR can change the priority.";
  if (current.priority === priority) return null;
  updateCollab((s) => {
    const row = s.hrRequests.find((r) => r.id === id);
    if (row) row.priority = priority;
  });
  return null;
}

/* ── Counters ── */

export function countPendingInbox(): number {
  return getCollabState().inbox.filter((t) => t.status === "Pending").length;
}

/** Unread messages for one user across the conversations they can see. */
export function countUnreadMessages(userId = currentCollabUserId(), role?: string): number {
  if (!userId) return 0;
  const list = role
    ? listConversationsForUser(userId, role)
    : getCollabState().conversations.filter((c) => c.participantIds.includes(userId));
  return list.reduce((sum, c) => sum + conversationUnreadCount(c, userId), 0);
}

/** Visible notifications (not deleted or muted), newest first. Kept for older callers. */
export function listNotificationsForRole(role: string, userId = currentCollabUserId()): AppNotification[] {
  if (!userId) return [];
  return visibleNotificationsFor(userId, role);
}

/**
 * Unread rows as the Notification Center counts them, using collab data only. Badges that also have
 * portal state should use countUnreadNotificationsFor (notificationFeed.ts) so leave / task / ticket
 * items that are already handled don't count.
 */
export function countUnreadNotifications(role?: string, userId = currentCollabUserId()): number {
  if (!userId) return 0;
  return notificationFeedFor(userId, role ?? roleOf(userId)).filter((i) => i.unread).length;
}

let notifSeq = 0;
function newNotificationId(): string {
  notifSeq += 1;
  return `nf-${Date.now().toString(36)}-${notifSeq}-${Math.random().toString(36).slice(2, 6)}`;
}

type NotificationDraft = {
  title: string;
  body: string;
  audience: AppNotification["audience"];
  recipientId?: string;
  href?: string;
  category?: NotifCategory;
  actionLabel?: string;
  ref?: NotifRef;
};

/**
 * Adds a notification to a state draft. Skipped when the recipient has turned that category off
 * in their preferences. Links to tasks are made specific (/tasks?task=TSK-…).
 */
function deliverInto(s: CollabState, draft: NotificationDraft): boolean {
  const href = taskDeepLink(draft.title, draft.href);
  const category = draft.category ?? inferNotifCategory(href, draft.title);
  if (draft.recipientId && !wantsNotification(draft.recipientId, category, s)) return false;
  s.notifications.unshift({
    id: newNotificationId(),
    category,
    title: draft.title.trim(),
    body: draft.body.trim(),
    at: new Date().toISOString(),
    readBy: [],
    hiddenFor: [],
    audience: draft.audience,
    recipientId: draft.recipientId,
    href,
    actionLabel: draft.actionLabel ?? defaultNotifActionLabel(category),
    ref: draft.ref ?? notifRefFromHref(href, draft.title),
  });
  if (s.notifications.length > MAX_STORED) s.notifications.length = MAX_STORED;
  // Person-targeted notifications also go out by email (when admins allow email for that channel).
  if (draft.recipientId) {
    const head = s.notifications[0];
    queueEmailForNotification({ recipientId: draft.recipientId, category, title: head.title, body: head.body, href });
  }
  return true;
}

function deliver(draft: NotificationDraft) {
  if (draft.recipientId) {
    const href = taskDeepLink(draft.title, draft.href);
    const category = draft.category ?? inferNotifCategory(href, draft.title);
    // Check before writing so a muted category doesn't trigger a save and re-render.
    if (!wantsNotification(draft.recipientId, category)) return;
  }
  updateCollab((s) => {
    deliverInto(s, draft);
  });
}

/**
 * Alert to the employee's direct manager (task blocked, help or review requested, overdue).
 * Without employeeId it falls back to the signed-in user.
 */
export function pushManagerTaskAlert(input: {
  title: string;
  body: string;
  href?: string;
  employeeId?: string;
}) {
  const employeeId = input.employeeId ?? currentCollabUserId();
  const manager = employeeId ? managementChain(employeeId)[0] : undefined;
  if (!manager) return;
  deliver({
    title: input.title,
    body: input.body,
    audience: "manager",
    recipientId: manager.id,
    href: input.href ?? "/tasks",
  });
}

/**
 * Notification for one person (task owner, CC, ticket assignee, mail recipient, shift change, ...).
 * The category comes from the link; it isn't delivered if the person turned that category off.
 */
export function pushPersonTaskAlert(input: { recipientId: string; title: string; body: string; href?: string }) {
  deliver({
    title: input.title,
    body: input.body,
    audience: "employee",
    recipientId: input.recipientId,
    href: input.href ?? "/tasks",
  });
}

export type { InboxTab };
