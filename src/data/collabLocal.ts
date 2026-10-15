import {
  ANNOUNCEMENTS_SEED,
  CONVERSATIONS_SEED,
  DEFAULT_NOTIF_PREFS,
  HR_REQUESTS_SEED,
  INBOX_SEED,
  NOTIFICATIONS_SEED,
  canAccessRestrictedChat,
  notificationVisibleForRole,
  type Announcement,
  type AppNotification,
  type Conversation,
  type HrRequest,
  type HrRequestCategory,
  type InboxTab,
  type InboxTask,
  type NotifPrefs,
} from "./collabData.ts";

const KEY = "timez.collab.state.v3";

type CollabState = {
  inbox: InboxTask[];
  conversations: Conversation[];
  announcements: Announcement[];
  notifications: AppNotification[];
  prefs: NotifPrefs;
  hrRequests: HrRequest[];
};

function defaults(): CollabState {
  return {
    inbox: structuredClone(INBOX_SEED),
    conversations: structuredClone(CONVERSATIONS_SEED),
    announcements: structuredClone(ANNOUNCEMENTS_SEED),
    notifications: structuredClone(NOTIFICATIONS_SEED),
    prefs: { ...DEFAULT_NOTIF_PREFS },
    hrRequests: structuredClone(HR_REQUESTS_SEED),
  };
}

function read(): CollabState {
  const base = defaults();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw) as Partial<CollabState>;
    return {
      inbox: Array.isArray(parsed.inbox) ? parsed.inbox : base.inbox,
      conversations: Array.isArray(parsed.conversations) ? parsed.conversations : base.conversations,
      announcements: Array.isArray(parsed.announcements) ? parsed.announcements : base.announcements,
      notifications: Array.isArray(parsed.notifications) ? parsed.notifications : base.notifications,
      prefs: parsed.prefs && typeof parsed.prefs === "object" ? { ...base.prefs, ...parsed.prefs } : base.prefs,
      hrRequests: Array.isArray(parsed.hrRequests) ? parsed.hrRequests : base.hrRequests,
    };
  } catch {
    return base;
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

export function decideInboxTask(
  id: string,
  decision: "Approved" | "Rejected",
  actor: string,
  reason?: string,
) {
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
    s.notifications.unshift({
      id: `nf-local-${Date.now()}`,
      category,
      title: `${row.kind} ${decision.toLowerCase()}`,
      body: `${row.title} · ${row.requester}`,
      at: new Date().toISOString(),
      read: false,
      audience: "employee",
      href: row.kind === "Attendance correction" ? "/attendance" : row.kind === "Timesheet" ? "/timesheet" : "/leave",
      actionLabel: "Open",
      actions: [
        {
          id: "open",
          label: "Open",
          kind: "link",
          href: row.kind === "Attendance correction" ? "/attendance" : row.kind === "Timesheet" ? "/timesheet" : "/leave",
        },
      ],
    });
  });
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

export function sendChatMessage(
  conversationId: string,
  fromId: string,
  fromName: string,
  text: string,
  attachmentName?: string,
) {
  updateCollab((s) => {
    const conv = s.conversations.find((c) => c.id === conversationId);
    if (!conv) return;
    conv.messages.push({
      id: `msg-${Date.now()}`,
      fromId,
      fromName,
      text,
      at: new Date().toISOString(),
      read: true,
      attachmentName,
    });
    conv.unread = 0;
  });
}

export function markConversationRead(conversationId: string) {
  const current = getCollabState().conversations.find((c) => c.id === conversationId);
  if (!current) return;
  if (current.unread === 0 && current.messages.every((m) => m.read)) return;
  updateCollab((s) => {
    const conv = s.conversations.find((c) => c.id === conversationId);
    if (!conv) return;
    conv.unread = 0;
    conv.messages.forEach((m) => {
      m.read = true;
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
      unread: 0,
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
      unread: 0,
      messages: [
        {
          id: `msg-${Date.now()}`,
          fromId: input.selfId,
          fromName: input.selfName,
          text: `Created group “${title}” (demo).`,
          at: new Date().toISOString(),
          read: true,
        },
      ],
    });
  });
  return createdId;
}

export function markAnnouncementRead(id: string) {
  updateCollab((s) => {
    const row = s.announcements.find((a) => a.id === id);
    if (row) row.readByMe = true;
  });
}

export function setAnnouncementState(id: string, state: Announcement["state"]) {
  updateCollab((s) => {
    const row = s.announcements.find((a) => a.id === id);
    if (!row) return;
    row.state = state;
    if (state === "Published") {
      row.publishedAt = new Date().toISOString();
      row.scheduledFor = undefined;
    }
  });
}

export function markNotificationRead(id: string) {
  updateCollab((s) => {
    const row = s.notifications.find((n) => n.id === id);
    if (row) row.read = true;
  });
}

export function markAllNotificationsRead(role?: string) {
  updateCollab((s) => {
    s.notifications.forEach((n) => {
      if (role && !notificationVisibleForRole(n, role)) return;
      n.read = true;
    });
  });
}

export function setNotifPrefs(prefs: NotifPrefs) {
  updateCollab((s) => {
    s.prefs = { ...prefs };
  });
}

export function createHrRequest(input: {
  category: HrRequestCategory;
  subject: string;
  description: string;
  author: string;
}) {
  updateCollab((s) => {
    const now = new Date().toISOString();
    s.hrRequests.unshift({
      id: `hr-local-${Date.now()}`,
      category: input.category,
      subject: input.subject.trim(),
      description: input.description.trim(),
      status: "Open",
      createdAt: now.slice(0, 10),
      updatedAt: now.slice(0, 10),
      comments: [{ at: now, author: input.author, text: input.description.trim() }],
    });
  });
}

export function addHrComment(id: string, author: string, text: string) {
  updateCollab((s) => {
    const row = s.hrRequests.find((r) => r.id === id);
    if (!row) return;
    row.comments.push({ at: new Date().toISOString(), author, text });
    row.updatedAt = new Date().toISOString().slice(0, 10);
    if (row.status === "Open") row.status = "In progress";
  });
}

export function setHrRequestStatus(id: string, status: HrRequest["status"]) {
  updateCollab((s) => {
    const row = s.hrRequests.find((r) => r.id === id);
    if (row) {
      row.status = status;
      row.updatedAt = new Date().toISOString().slice(0, 10);
    }
  });
}

export function countPendingInbox(): number {
  return getCollabState().inbox.filter((t) => t.status === "Pending").length;
}

export function countUnreadMessages(userId?: string, role?: string): number {
  const list =
    userId && role
      ? listConversationsForUser(userId, role)
      : getCollabState().conversations;
  return list.reduce((sum, c) => sum + c.unread, 0);
}

export function listNotificationsForRole(role: string): AppNotification[] {
  return getCollabState().notifications.filter((n) => notificationVisibleForRole(n, role));
}

export function countUnreadNotifications(role?: string): number {
  const list = role ? listNotificationsForRole(role) : getCollabState().notifications;
  return list.filter((n) => !n.read).length;
}

/** Simulated manager alert when an employee blocks a task or requests help. */
export function pushManagerTaskAlert(input: {
  title: string;
  body: string;
  href?: string;
}) {
  updateCollab((s) => {
    s.notifications.unshift({
      id: `nf-task-${Date.now()}`,
      category: "Team",
      title: input.title,
      body: input.body,
      at: new Date().toISOString(),
      read: false,
      audience: "manager",
      href: input.href ?? "/tasks",
      actionLabel: "Review",
      actions: [{ id: "open", label: "Review", kind: "link", href: input.href ?? "/tasks" }],
    });
  });
}

export type { InboxTab };
