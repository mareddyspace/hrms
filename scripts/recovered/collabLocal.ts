import {
  ANNOUNCEMENTS_SEED,
  CONVERSATIONS_SEED,
  DEFAULT_NOTIF_PREFS,
  HR_REQUESTS_SEED,
  INBOX_SEED,
  NOTIFICATIONS_SEED,
  type Announcement,
  type AppNotification,
  type Conversation,
  type HrRequest,
  type HrRequestCategory,
  type InboxTab,
  type InboxTask,
  type NotifPrefs,
} from "./collabData.ts";

const KEY = "timez.collab.state.v1";

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
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    return { ...defaults(), ...JSON.parse(raw) };
  } catch {
    return defaults();
  }
}

function write(state: CollabState) {
  localStorage.setItem(KEY, JSON.stringify(state));
  listeners.forEach((fn) => fn());
}

const listeners = new Set<() => void>();

export function subscribeCollab(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getCollabState(): CollabState {
  return read();
}

export function updateCollab(mutator: (state: CollabState) => void) {
  const state = read();
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
    s.notifications.unshift({
      id: `nf-local-${Date.now()}`,
      category: row.kind === "Leave" ? "Leave" : row.kind === "Timesheet" ? "Timesheet" : "Announcements",
      title: `${row.kind} ${decision.toLowerCase()}`,
      body: `${row.title} · ${row.requester}`,
      at: new Date().toISOString(),
      read: false,
      href: "/approvals",
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
  updateCollab((s) => {
    const conv = s.conversations.find((c) => c.id === conversationId);
    if (!conv) return;
    conv.unread = 0;
    conv.messages.forEach((m) => {
      m.read = true;
    });
  });
}

export function startDirectChat(personId: string, personName: string, selfId: string, selfName: string) {
  let createdId = "";
  updateCollab((s) => {
    const existing = s.conversations.find(
      (c) => c.kind === "direct" && c.participantIds.includes(personId) && c.participantIds.includes(selfId),
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

export function markAllNotificationsRead() {
  updateCollab((s) => {
    s.notifications.forEach((n) => {
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
  return read().inbox.filter((t) => t.status === "Pending").length;
}

export function countUnreadMessages(): number {
  return read().conversations.reduce((sum, c) => sum + c.unread, 0);
}

export function countUnreadNotifications(): number {
  return read().notifications.filter((n) => !n.read).length;
}

export type { InboxTab };
