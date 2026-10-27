import {
  ANNOUNCEMENTS_SEED,
  CONVERSATIONS_SEED,
  DEFAULT_NOTIF_PREFS,
  HR_REQUESTS_SEED,
  INBOX_SEED,
  NOTIFICATIONS_SEED,
  canAccessRestrictedChat,
  canManageAnnouncement,
  isHrRole,
  notifPrefKey,
  notificationVisibleForRole,
  type Announcement,
  type AppNotification,
  type ChatMessage,
  type Conversation,
  type HrRequest,
  type HrRequestCategory,
  type InboxTab,
  type InboxTask,
  type NotifPrefs,
} from "./collabData.ts";
import { DEMO_ACCOUNTS, managementChain } from "../demoAccounts.ts";

const KEY = "timez.collab.state.v5";
/** Older saved state: notifications without recipients and one shared preference set. Migrated into v4 on first read. */
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

/**
 * v3 seeded notifications had no recipient, so personal items (e.g. Babu's WFH approval) showed to everyone.
 * Replace each seeded row with the current seed (keeping who has read it) and drop decide actions.
 */
function fixLegacyNotifications(rows: AppNotification[]): AppNotification[] {
  const seedById = new Map(NOTIFICATIONS_SEED.map((n) => [n.id, n]));
  return rows.map((row) => {
    const seed = seedById.get(row.id);
    const fixed = seed ? { ...structuredClone(seed), readBy: Array.isArray(row.readBy) ? row.readBy : seed.readBy } : row;
    if (fixed.actions) fixed.actions = fixed.actions.filter((a) => a.kind !== "approve" && a.kind !== "reject");
    return fixed;
  });
}

function read(): CollabState {
  const base = defaults();
  try {
    let raw = localStorage.getItem(KEY);
    let legacy = false;
    if (!raw) {
      raw = localStorage.getItem(LEGACY_KEY);
      legacy = !!raw;
    }
    if (!raw) return base;
    const parsed = JSON.parse(raw) as Partial<CollabState>;
    const notifications = Array.isArray(parsed.notifications) ? parsed.notifications : base.notifications;
    const state = migrate({
      inbox: Array.isArray(parsed.inbox) ? parsed.inbox : base.inbox,
      conversations: Array.isArray(parsed.conversations) ? parsed.conversations : base.conversations,
      announcements: Array.isArray(parsed.announcements) ? parsed.announcements : base.announcements,
      notifications: legacy ? fixLegacyNotifications(notifications) : notifications,
      // A legacy shared preference set can't be attributed to one person, so everyone starts from the defaults.
      prefsByUser:
        !legacy && parsed.prefsByUser && typeof parsed.prefsByUser === "object" ? parsed.prefsByUser : base.prefsByUser,
      hrRequests: Array.isArray(parsed.hrRequests) ? parsed.hrRequests : base.hrRequests,
    });
    if (legacy) {
      localStorage.setItem(KEY, JSON.stringify(state));
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
    const category =
      row.kind === "Leave"
        ? "Leave"
        : row.kind === "Timesheet"
          ? "Timesheet"
          : row.kind === "Attendance correction"
            ? "Attendance"
            : "Announcements";
    const href = row.kind === "Attendance correction" ? "/attendance" : row.kind === "Timesheet" ? "/timesheet" : "/leave";
    s.notifications.unshift({
      id: `nf-local-${Date.now()}`,
      category,
      title: `${row.kind} ${decision.toLowerCase()}`,
      body: `${row.title} · ${row.requester}`,
      at: new Date().toISOString(),
      readBy: [],
      audience: "employee",
      // Only the requester hears about the decision on their own request.
      recipientId: row.requesterId,
      href,
      actionLabel: "Open",
      actions: [{ id: "open", label: "Open", kind: "link", href }],
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

export function markNotificationRead(id: string, userId = currentCollabUserId()) {
  if (!userId) return;
  const current = getCollabState().notifications.find((n) => n.id === id);
  if (!current || current.readBy.includes(userId)) return;
  updateCollab((s) => {
    const row = s.notifications.find((n) => n.id === id);
    if (row && !row.readBy.includes(userId)) row.readBy.push(userId);
  });
}

export function markAllNotificationsRead(role?: string, userId = currentCollabUserId()) {
  if (!userId) return;
  updateCollab((s) => {
    s.notifications.forEach((n) => {
      if (role && !notificationVisibleForRole(n, role, userId)) return;
      if (!n.readBy.includes(userId)) n.readBy.push(userId);
    });
  });
}

/** One user's notification preferences (defaults when they haven't changed any). */
export function notifPrefsFor(userId: string | undefined, state: CollabState = getCollabState()): NotifPrefs {
  return { ...DEFAULT_NOTIF_PREFS, ...(userId ? state.prefsByUser[userId] : undefined) };
}

export function setNotifPrefs(prefs: NotifPrefs, userId = currentCollabUserId()) {
  if (!userId) return;
  updateCollab((s) => {
    s.prefsByUser = { ...s.prefsByUser, [userId]: { ...prefs } };
  });
}

/* ── HR requests ── */

export function createHrRequest(input: {
  category: HrRequestCategory;
  subject: string;
  description: string;
  author: string;
  requesterId: string;
}) {
  updateCollab((s) => {
    const now = new Date().toISOString();
    s.hrRequests.unshift({
      id: `hr-local-${Date.now()}`,
      category: input.category,
      subject: input.subject.trim(),
      description: input.description.trim(),
      status: "Open",
      requesterId: input.requesterId,
      requesterName: input.author,
      createdAt: now.slice(0, 10),
      updatedAt: now.slice(0, 10),
      comments: [{ at: now, author: input.author, text: input.description.trim() }],
    });
  });
}

/** Own tickets for everyone; HR sees all (including legacy tickets with no requester). */
export function hrRequestVisibleTo(r: HrRequest, userId: string, role: string): boolean {
  if (isHrRole(role)) return true;
  return !!r.requesterId && r.requesterId === userId;
}

/** Statuses the viewer may move this ticket to (excluding its current one). */
export function allowedHrStatuses(r: HrRequest, userId: string, role: string): HrRequest["status"][] {
  // HR works other people's tickets. On a ticket they raised themselves they are the requester and another
  // HR member has to resolve it.
  if (isHrRole(role) && r.requesterId !== userId) {
    return (["In progress", "Waiting on you", "Resolved", "Closed"] as const).filter((s) => s !== r.status);
  }
  if (r.requesterId !== userId) return [];
  // Requester: close a resolved ticket, or reopen it.
  if (r.status === "Resolved") return ["Closed", "In progress"];
  if (r.status === "Closed") return ["In progress"];
  return [];
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
  const byHr = isHrRole(actor.role) && current.requesterId !== actor.id;
  updateCollab((s) => {
    const row = s.hrRequests.find((r) => r.id === id);
    if (!row) return;
    row.comments.push({ at: new Date().toISOString(), author, text: body });
    row.updatedAt = new Date().toISOString().slice(0, 10);
    if (row.status === "Open" && byHr) row.status = "In progress";
    // The employee answered HR's question — back into HR's queue.
    if (row.status === "Waiting on you" && !byHr) row.status = "In progress";
  });
  return null;
}

/** Returns an error message, or null when the status changed. */
export function setHrRequestStatus(
  id: string,
  status: HrRequest["status"],
  actor: { id: string; role: string },
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
  updateCollab((s) => {
    const row = s.hrRequests.find((r) => r.id === id);
    if (row) {
      row.status = status;
      row.updatedAt = new Date().toISOString().slice(0, 10);
    }
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

export function listNotificationsForRole(role: string, userId = currentCollabUserId()): AppNotification[] {
  return getCollabState().notifications.filter((n) => notificationVisibleForRole(n, role, userId));
}

/** Same visibility and preference filtering as the Notification Center list. */
export function countUnreadNotifications(role?: string, userId = currentCollabUserId()): number {
  if (!userId) return 0;
  const state = getCollabState();
  const { notifications } = state;
  const prefs = notifPrefsFor(userId, state);
  return notifications.filter(
    (n) =>
      (role ? notificationVisibleForRole(n, role, userId) : !n.recipientId || n.recipientId === userId) &&
      prefs[notifPrefKey(n.category)] !== false &&
      !n.readBy.includes(userId),
  ).length;
}

/**
 * Simulated alert to the employee's direct manager when they block a task, ask for help
 * or submit for review. Without employeeId it falls back to the signed-in user.
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
  updateCollab((s) => {
    s.notifications.unshift({
      id: `nf-task-${Date.now()}`,
      category: "Team",
      title: input.title,
      body: input.body,
      at: new Date().toISOString(),
      readBy: [],
      audience: "manager",
      recipientId: manager.id,
      href: input.href ?? "/tasks",
      actionLabel: "Review",
      actions: [{ id: "open", label: "Review", kind: "link", href: input.href ?? "/tasks" }],
    });
  });
}

/** Notification for one specific person (e.g. a task owner or someone CC'd). */
export function pushPersonTaskAlert(input: { recipientId: string; title: string; body: string; href?: string }) {
  updateCollab((s) => {
    s.notifications.unshift({
      id: `nf-task-${Date.now()}-${input.recipientId}`,
      category: "Team",
      title: input.title,
      body: input.body,
      at: new Date().toISOString(),
      readBy: [],
      audience: "employee",
      recipientId: input.recipientId,
      href: input.href ?? "/tasks",
      actionLabel: "Open",
      actions: [{ id: "open", label: "Open", kind: "link", href: input.href ?? "/tasks" }],
    });
  });
}

export type { InboxTab };
