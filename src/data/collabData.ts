import { findDemoById } from "../demoAccounts.ts";
/** Infotech collaboration & workflow — fictional demo data only. */

import { DEMO_ACCOUNTS } from "../demoAccounts.ts";

/** Seed rows that start out "already read" are marked read for every demo persona. */
const SEEN_BY_ALL: string[] = DEMO_ACCOUNTS.map((a) => a.id);

export const COLLAB_DISCLAIMER =
  "Real-time messaging, email delivery and external integrations are not available.";

export type ApprovalKind =
  | "Leave"
  | "Timesheet"
  | "Attendance correction"
  | "Recruitment"
  | "Document";

export type InboxTab = "Pending" | "Approved" | "Rejected" | "Delegated";

export interface ApprovalEvent {
  at: string;
  actor: string;
  action: string;
  comment?: string;
  status: string;
}

export interface InboxTask {
  id: string;
  kind: ApprovalKind;
  title: string;
  requester: string;
  requesterId: string;
  summary: string;
  status: InboxTab;
  createdAt: string;
  due?: string;
  delegatedTo?: string;
  timeline: ApprovalEvent[];
  requiresReasonOnReject: boolean;
}

export type ChatAvailability = "Online" | "Away" | "Busy" | "Offline";

/** Soft channel tags — confidential threads stay limited to authorized participants. */
export type ChatChannelTag = "general" | "hr" | "compensation" | "recruiting" | "leadership";

export interface ChatPerson {
  id: string;
  name: string;
  title: string;
  department: string;
  roleLabel: string;
  availability: ChatAvailability;
  /** Used for directory privacy / who can open sensitive channels. */
  channelTags: ChatChannelTag[];
}

export interface ChatMessage {
  id: string;
  fromId: string;
  fromName: string;
  text: string;
  at: string;
  /** User ids who have read this message (the sender always counts as read). */
  readBy: string[];
  attachmentName?: string;
}

export interface Conversation {
  id: string;
  kind: "direct" | "group";
  title: string;
  participantIds: string[];
  participantNames: string[];
  messages: ChatMessage[];
  /** When set, only authorized roles among participants may view the thread. */
  restricted?: "compensation" | "hr_confidential";
}

export type AnnouncementScope = "Company" | "Country" | "Department" | "Team";
export type AnnouncementState = "Draft" | "Scheduled" | "Published";

export interface Announcement {
  id: string;
  title: string;
  body: string;
  scope: AnnouncementScope;
  audience: string;
  state: AnnouncementState;
  publishedAt?: string;
  scheduledFor?: string;
  author: string;
  /** Persona id of the author, when known (used for manager Team-scope publishing). */
  authorId?: string;
  /** User ids who have read this announcement. */
  readBy: string[];
}

export type NotifCategory =
  | "Leave"
  | "Timesheet"
  | "Attendance"
  | "Messages"
  | "Holidays"
  | "Learning"
  | "Performance"
  | "Announcements"
  | "Team";

/** Who should see this notification in the demo Notification Center. */
export type NotifAudience = "employee" | "manager" | "all";

export type NotifActionKind = "link" | "approve" | "reject" | "detail";

export interface NotifAction {
  id: string;
  label: string;
  kind?: NotifActionKind;
  href?: string;
}

export interface AppNotification {
  id: string;
  category: NotifCategory;
  title: string;
  body: string;
  at: string;
  /** User ids who have read this notification. */
  readBy: string[];
  audience: NotifAudience;
  /** When set, only this user sees the notification (audience is ignored). */
  recipientId?: string;
  /** When set, only people working in this country see it (e.g. a national holiday). */
  countryCode?: string;
  href?: string;
  /** Primary CTA label (shown when actions[] omitted). */
  actionLabel?: string;
  actions?: NotifAction[];
  /** Optional Approvals inbox task for Approve / Reject. */
  inboxTaskId?: string;
  /** Extra copy for the on-page detail panel. */
  detail?: string;
}

export interface NotifPrefs {
  leave: boolean;
  timesheet: boolean;
  attendance: boolean;
  messages: boolean;
  holidays: boolean;
  learning: boolean;
  performance: boolean;
  announcements: boolean;
  team: boolean;
}

export const NOTIF_CATEGORIES: NotifCategory[] = [
  "Leave",
  "Timesheet",
  "Attendance",
  "Messages",
  "Holidays",
  "Learning",
  "Performance",
  "Announcements",
  "Team",
];

export function notifPrefKey(category: NotifCategory): keyof NotifPrefs {
  switch (category) {
    case "Leave":
      return "leave";
    case "Timesheet":
      return "timesheet";
    case "Attendance":
      return "attendance";
    case "Messages":
      return "messages";
    case "Holidays":
      return "holidays";
    case "Learning":
      return "learning";
    case "Performance":
      return "performance";
    case "Announcements":
      return "announcements";
    case "Team":
      return "team";
  }
}

/** Manager / hiring-manager personas see team-scoped manager notifications. */
export function isManagerNotifRole(role: string): boolean {
  return role === "manager" || role === "hiring_manager";
}

export function notificationVisibleForRole(n: AppNotification, role: string, userId?: string): boolean {
  if (n.recipientId) return n.recipientId === userId;
  if (n.countryCode && userId) {
    const country = findDemoById(userId)?.countryCode ?? (userId.startsWith("emp-") ? "IN" : undefined);
    if (country && country !== n.countryCode) return false;
  }
  if (n.audience === "all") return true;
  if (n.audience === "manager") return isManagerNotifRole(role);
  return !isManagerNotifRole(role);
}

export type HrRequestCategory =
  | "Payroll provider"
  | "Benefits"
  | "Documents"
  | "Leave"
  | "Profile correction"
  | "Other";

export interface HrRequestComment {
  at: string;
  author: string;
  text: string;
}

export interface HrRequest {
  id: string;
  category: HrRequestCategory;
  subject: string;
  description: string;
  status: "Open" | "In progress" | "Waiting on you" | "Resolved" | "Closed";
  /** Who raised the ticket. Older saved tickets lack this and are visible to HR only. */
  requesterId?: string;
  requesterName?: string;
  createdAt: string;
  updatedAt: string;
  comments: HrRequestComment[];
}

export interface FaqItem {
  id: string;
  question: string;
  answer: string;
  topic: string;
  policyLink?: string;
}

export const CHAT_PEOPLE: ChatPerson[] = [
  {
    id: "emp-mahesh",
    name: "Babu Menon",
    title: "Software Engineer",
    department: "Engineering",
    roleLabel: "Employee",
    availability: "Online",
    channelTags: ["general"],
  },
  {
    id: "emp-ram",
    name: "Ram Krishnan",
    title: "Engineering Manager",
    department: "Engineering",
    roleLabel: "Manager",
    availability: "Online",
    channelTags: ["general", "leadership"],
  },
  {
    id: "demo-hr-admin",
    name: "Farhan Ali",
    title: "HR Director",
    department: "People",
    roleLabel: "HR",
    availability: "Away",
    channelTags: ["general", "hr"],
  },
  {
    id: "demo-recruiter",
    name: "Sophie Clark",
    title: "Senior Recruiter",
    department: "People",
    roleLabel: "Recruiter",
    availability: "Busy",
    channelTags: ["general", "recruiting"],
  },
  {
    id: "demo-hiring-manager",
    name: "Daniel Ortiz",
    title: "Director of Product",
    department: "Product",
    roleLabel: "Hiring Manager",
    availability: "Online",
    channelTags: ["general", "recruiting", "leadership"],
  },
  {
    id: "demo-ceo",
    name: "Jordan Blake",
    title: "Chief Executive Officer",
    department: "Executive",
    roleLabel: "Executive",
    availability: "Busy",
    channelTags: ["general", "leadership"],
  },
  {
    id: "demo-compensation",
    name: "Helen Brooks",
    title: "Compensation & Benefits Manager",
    department: "Total Rewards",
    roleLabel: "Compensation",
    availability: "Away",
    channelTags: ["general", "compensation", "hr"],
  },
  {
    id: "demo-admin",
    name: "Alex Morgan",
    title: "Platform Administrator",
    department: "IT",
    roleLabel: "Admin",
    availability: "Online",
    channelTags: ["general"],
  },
  {
    id: "emp-priya",
    name: "Priya Nair",
    title: "Software Engineer",
    department: "Engineering",
    roleLabel: "Colleague",
    availability: "Online",
    channelTags: ["general"],
  },
  {
    id: "emp-anu",
    name: "Anu Rao",
    title: "Performance Mgr",
    department: "Engineering",
    roleLabel: "Colleague",
    availability: "Offline",
    channelTags: ["general"],
  },
  {
    id: "emp-kabir",
    name: "Kabir Sharma",
    title: "Senior Engineer",
    department: "Engineering",
    roleLabel: "Colleague",
    availability: "Online",
    channelTags: ["general"],
  },
];

export function chatPersonById(id: string): ChatPerson | undefined {
  return CHAT_PEOPLE.find((p) => p.id === id);
}

/** Whether a viewer may open / keep a restricted conversation. */
export function canAccessRestrictedChat(
  restricted: Conversation["restricted"],
  role: string,
): boolean {
  if (!restricted) return true;
  if (restricted === "compensation") {
    return (
      role === "compensation_admin" ||
      role === "hr_admin" ||
      role === "hr" ||
      role === "finance" ||
      role === "super_admin"
    );
  }
  if (restricted === "hr_confidential") {
    return (
      role === "hr_admin" ||
      role === "hr" ||
      role === "hrbp" ||
      role === "super_admin"
    );
  }
  return true;
}

export const HR_ROLES = ["hr", "hr_admin", "hrbp"];
export const ADMIN_ROLES = ["admin", "super_admin", "it_admin"];

export function isHrRole(role: string): boolean {
  return HR_ROLES.includes(role);
}

/**
 * HR / admin may publish or unpublish any announcement; managers may only manage
 * Team-scope posts they authored themselves.
 */
export function canManageAnnouncement(
  a: Pick<Announcement, "scope" | "author" | "authorId">,
  user: { id: string; fullName: string; role: string },
): boolean {
  if (isHrRole(user.role) || ADMIN_ROLES.includes(user.role)) return true;
  if (!isManagerNotifRole(user.role)) return false;
  const authored = a.authorId ? a.authorId === user.id : a.author === user.fullName;
  return a.scope === "Team" && authored;
}

export const INBOX_SEED: InboxTask[] = [
  {
    id: "ib-1",
    kind: "Leave",
    title: "PTO · 16–17 Oct",
    requester: "Diya Patel",
    requesterId: "wf-1",
    summary: "Privilege leave · 2 working days",
    status: "Pending",
    createdAt: "2026-10-12T09:20:00",
    due: "2026-10-15",
    requiresReasonOnReject: true,
    timeline: [
      { at: "2026-10-12T09:20:00", actor: "Diya Patel", action: "Submitted", status: "Pending" },
      { at: "2026-10-12T09:21:00", actor: "System", action: "Routed to manager", status: "Pending" },
    ],
  },
  {
    id: "ib-2",
    kind: "Timesheet",
    title: "Timesheet week of 6 Oct",
    requester: "Kabir Sharma",
    requesterId: "wf-2",
    summary: "40h submitted · Project Maple Health",
    status: "Pending",
    createdAt: "2026-10-13T18:05:00",
    requiresReasonOnReject: true,
    timeline: [
      { at: "2026-10-13T18:05:00", actor: "Kabir Sharma", action: "Submitted", status: "Pending" },
    ],
  },
  {
    id: "ib-3",
    kind: "Attendance correction",
    title: "Missed check-out · 10 Oct",
    requester: "Babu Menon",
    requesterId: "emp-mahesh",
    summary: "Forgot to check out · request 18:32",
    status: "Pending",
    createdAt: "2026-10-11T08:00:00",
    requiresReasonOnReject: true,
    timeline: [
      { at: "2026-10-11T08:00:00", actor: "Babu Menon", action: "Requested correction", status: "Pending" },
    ],
  },
  {
    id: "ib-4",
    kind: "Recruitment",
    title: "Offer pack · Lucas Meyer",
    requester: "Sophie Clark",
    requesterId: "demo-recruiter",
    summary: "HRBP London · grade L5 · human approval required",
    status: "Pending",
    createdAt: "2026-10-10T14:30:00",
    requiresReasonOnReject: true,
    timeline: [
      { at: "2026-10-10T14:30:00", actor: "Sophie Clark", action: "Submitted for HM approval", status: "Pending" },
    ],
  },
  {
    id: "ib-5",
    kind: "Document",
    title: "Salary revision letter · Babu Menon",
    requester: "Ram Krishnan",
    requesterId: "emp-ram",
    summary: "Letter pending HR approval",
    status: "Pending",
    createdAt: "2026-10-08T11:00:00",
    requiresReasonOnReject: true,
    timeline: [
      { at: "2026-10-08T11:00:00", actor: "Ram Krishnan", action: "Requested letter", status: "Draft" },
      { at: "2026-10-08T11:05:00", actor: "System", action: "Moved to Pending approval", status: "Pending" },
    ],
  },
  {
    id: "ib-6",
    kind: "Leave",
    title: "WFH · 3 Oct",
    requester: "Priya Nair",
    requesterId: "emp-priya",
    summary: "Approved earlier this month",
    status: "Approved",
    createdAt: "2026-10-01T10:00:00",
    requiresReasonOnReject: true,
    timeline: [
      { at: "2026-10-01T10:00:00", actor: "Priya Nair", action: "Submitted", status: "Pending" },
      { at: "2026-10-01T16:40:00", actor: "Ram Krishnan", action: "Approved", comment: "OK for delivery week", status: "Approved" },
    ],
  },
  {
    id: "ib-7",
    kind: "Timesheet",
    title: "Timesheet week of 22 Sep",
    requester: "Anu Rao",
    requesterId: "emp-anu",
    summary: "Rejected — missing project codes",
    status: "Rejected",
    createdAt: "2026-09-26T17:00:00",
    requiresReasonOnReject: true,
    timeline: [
      { at: "2026-09-26T17:00:00", actor: "Anu Rao", action: "Submitted", status: "Pending" },
      { at: "2026-09-27T09:15:00", actor: "Ram Krishnan", action: "Rejected", comment: "Please tag Maple Health hours", status: "Rejected" },
    ],
  },
  {
    id: "ib-8",
    kind: "Leave",
    title: "Emergency leave · 20 Oct",
    requester: "Riya Kapoor",
    requesterId: "ob-1",
    summary: "Delegated to Farhan Ali while Ram is OOO",
    status: "Delegated",
    createdAt: "2026-10-13T12:00:00",
    delegatedTo: "Farhan Ali",
    requiresReasonOnReject: true,
    timeline: [
      { at: "2026-10-13T12:00:00", actor: "Riya Kapoor", action: "Submitted", status: "Pending" },
      { at: "2026-10-13T12:30:00", actor: "Ram Krishnan", action: "Delegated", comment: "Covering while OOO", status: "Delegated" },
    ],
  },
];

export const CONVERSATIONS_SEED: Conversation[] = [
  {
    id: "cv-1",
    kind: "direct",
    title: "Ram Krishnan",
    participantIds: ["emp-mahesh", "emp-ram"],
    participantNames: ["Babu Menon", "Ram Krishnan"],
    messages: [
      {
        id: "m1",
        fromId: "emp-ram",
        fromName: "Ram Krishnan",
        text: "Can you update the timesheet before Friday standup?",
        at: "2026-10-13T16:02:00",
        readBy: ["emp-ram"],
      },
      {
        id: "m2",
        fromId: "emp-mahesh",
        fromName: "Babu Menon",
        text: "Will do — drafting now.",
        at: "2026-10-13T16:10:00",
        readBy: ["emp-mahesh", "emp-ram"],
      },
    ],
  },
  {
    id: "cv-2",
    kind: "direct",
    title: "Farhan Ali",
    participantIds: ["emp-mahesh", "demo-hr-admin"],
    participantNames: ["Babu Menon", "Farhan Ali"],
    messages: [
      {
        id: "m3",
        fromId: "demo-hr-admin",
        fromName: "Farhan Ali",
        text: "Your policy acknowledgement is still open — ping me if the link fails.",
        at: "2026-10-10T11:20:00",
        readBy: ["emp-mahesh", "demo-hr-admin"],
      },
    ],
  },
  {
    id: "cv-3",
    kind: "group",
    title: "Engineering Bengaluru",
    participantIds: ["emp-mahesh", "emp-ram", "emp-priya"],
    participantNames: ["Babu Menon", "Ram Krishnan", "Priya Nair"],
    messages: [
      {
        id: "m4",
        fromId: "emp-ram",
        fromName: "Ram Krishnan",
        text: "Sprint demo moved to Thursday 4pm IST.",
        at: "2026-10-14T08:15:00",
        readBy: ["emp-ram"],
      },
      {
        id: "m5",
        fromId: "emp-priya",
        fromName: "Priya Nair",
        text: "Secure coding module due end of month — please enroll.",
        at: "2026-10-14T09:00:00",
        readBy: ["emp-priya"],
        attachmentName: "secure-coding-outline.txt",
      },
    ],
  },
  {
    id: "cv-comp-1",
    kind: "direct",
    title: "Helen Brooks · Compensation case",
    participantIds: ["demo-compensation", "demo-hr-admin"],
    participantNames: ["Helen Brooks", "Farhan Ali"],
    restricted: "compensation",
    messages: [
      {
        id: "m-comp-1",
        fromId: "demo-hr-admin",
        fromName: "Farhan Ali",
        text: "Please review the band exception draft for L5 London (confidential).",
        at: "2026-10-12T15:00:00",
        readBy: ["demo-compensation", "demo-hr-admin"],
      },
      {
        id: "m-comp-2",
        fromId: "demo-compensation",
        fromName: "Helen Brooks",
        text: "Received — I'll mark the case in Comp review. Do not forward outside Comp/HR.",
        at: "2026-10-12T15:40:00",
        readBy: ["demo-compensation", "demo-hr-admin"],
      },
    ],
  },
  {
    id: "cv-hr-1",
    kind: "direct",
    title: "Farhan Ali · Employee relations",
    participantIds: ["demo-hr-admin", "demo-recruiter"],
    participantNames: ["Farhan Ali", "Sophie Clark"],
    restricted: "hr_confidential",
    messages: [
      {
        id: "m-hr-1",
        fromId: "demo-recruiter",
        fromName: "Sophie Clark",
        text: "ER intake logged for case #ER-204 — keep this thread HR-only.",
        at: "2026-10-11T10:00:00",
        readBy: ["demo-hr-admin", "demo-recruiter"],
      },
    ],
  },
];

export const ANNOUNCEMENTS_SEED: Announcement[] = [
  {
    id: "an-1",
    title: "Q4 All-hands",
    body: "Join the global all-hands on 22 Oct. Agenda covers roadmap, hiring, and wellbeing resources.",
    scope: "Company",
    audience: "All Infotech",
    state: "Published",
    publishedAt: "2026-10-08T10:00:00",
    author: "Internal Comms",
    readBy: [],
  },
  {
    id: "an-2",
    title: "India Dussehra holiday calendar",
    body: "Bengaluru and Hyderabad offices follow the published holiday calendar. Confirm WFH coverage with your manager.",
    scope: "Country",
    audience: "India",
    state: "Published",
    publishedAt: "2026-10-01T09:00:00",
    author: "People Ops IN",
    readBy: SEEN_BY_ALL,
  },
  {
    id: "an-3",
    title: "Engineering on-call rotation update",
    body: "New rotation starts 20 Oct. Managers: update the wiki before Friday.",
    scope: "Department",
    audience: "Engineering",
    state: "Published",
    publishedAt: "2026-10-11T12:00:00",
    author: "Ram Krishnan",
    authorId: "emp-ram",
    readBy: [],
  },
  {
    id: "an-4",
    title: "Team lunch · Platform squad",
    body: "Optional team lunch Thursday — RSVP in the channel.",
    scope: "Team",
    audience: "Platform squad",
    state: "Scheduled",
    scheduledFor: "2026-10-16T08:00:00",
    author: "Ram Krishnan",
    authorId: "emp-ram",
    readBy: [],
  },
  {
    id: "an-5",
    title: "Benefits open enrollment (US) — draft",
    body: "Draft copy for US open enrollment. Not published.",
    scope: "Country",
    audience: "United States",
    state: "Draft",
    author: "Helen Brooks",
    readBy: [],
  },
];

export const NOTIFICATIONS_SEED: AppNotification[] = [
  /* ── Employee / self alerts ── */
  {
    id: "nf-1",
    category: "Leave",
    title: "Leave approved",
    body: "Your WFH on 3 Oct was approved by Ram Krishnan.",
    at: "2026-10-01T16:41:00",
    readBy: [],
    audience: "employee",
    recipientId: "emp-mahesh",
    href: "/leave",
    actionLabel: "View Calendar",
    actions: [{ id: "open", label: "View Calendar", kind: "link", href: "/leave" }],
  },
  {
    id: "nf-2",
    category: "Timesheet",
    title: "Timesheet reminder",
    body: "Submit timesheet for week of 13 Oct.",
    at: "2026-10-14T08:00:00",
    readBy: [],
    audience: "employee",
    recipientId: "emp-mahesh",
    href: "/timesheet",
    actionLabel: "Open Timesheet",
    actions: [{ id: "open", label: "Open Timesheet", kind: "link", href: "/timesheet" }],
  },
  {
    id: "nf-3",
    category: "Messages",
    title: "New message from Ram Krishnan",
    body: "Can you update the timesheet before Friday standup?",
    at: "2026-10-13T16:02:00",
    readBy: [],
    audience: "employee",
    recipientId: "emp-mahesh",
    href: "/chat",
    actionLabel: "Open Message",
    actions: [{ id: "open", label: "Open Message", kind: "link", href: "/chat" }],
  },
  {
    id: "nf-4",
    category: "Holidays",
    title: "Upcoming holiday",
    body: "Dussehra holiday appears on your calendar next week.",
    at: "2026-10-12T07:00:00",
    readBy: SEEN_BY_ALL,
    audience: "all",
    countryCode: "IN",
    href: "/calendar",
    actionLabel: "View Calendar",
    actions: [
      { id: "cal", label: "View Calendar", kind: "link", href: "/calendar" },
      { id: "hol", label: "Holidays", kind: "link", href: "/holidays" },
    ],
  },
  {
    id: "nf-5",
    category: "Learning",
    title: "Learning deadline",
    body: "Secure coding fundamentals due 31 Oct.",
    at: "2026-10-10T09:00:00",
    readBy: [],
    audience: "employee",
    recipientId: "emp-mahesh",
    href: "/programs",
    actionLabel: "Review",
    actions: [{ id: "open", label: "Review", kind: "link", href: "/programs" }],
  },
  {
    id: "nf-6",
    category: "Performance",
    title: "Performance review reminder",
    body: "H2 mid-year self-assessment still in Draft.",
    at: "2026-10-09T10:00:00",
    readBy: [],
    audience: "employee",
    recipientId: "emp-mahesh",
    href: "/evaluations",
    actionLabel: "Review",
    actions: [{ id: "open", label: "Review", kind: "link", href: "/evaluations" }],
  },
  {
    id: "nf-7",
    category: "Announcements",
    title: "HR announcement",
    body: "Q4 All-hands published — open Announcements to read.",
    at: "2026-10-08T10:05:00",
    readBy: [],
    audience: "all",
    href: "/announcements",
    actionLabel: "Open",
    actions: [{ id: "open", label: "Open", kind: "link", href: "/announcements" }],
  },

  /* ── Manager · team-scoped (no payslip / salary content) ── */
  {
    id: "nf-m1",
    category: "Leave",
    title: "Leave approval · Diya Patel",
    body: "PTO 16–17 Oct (2 working days) waiting on your approval.",
    at: "2026-10-14T09:20:00",
    readBy: [],
    audience: "manager",
    recipientId: "emp-ram",
    href: "/approvals",
    inboxTaskId: "ib-1",
    actionLabel: "Review",
    detail:
      "Diya Patel · Privilege leave · 16–17 Oct 2026 · Project coverage noted as Babu Menon. Decide it in Approvals.",
    actions: [
      { id: "review", label: "Review", kind: "detail" },
      { id: "inbox", label: "Open Approvals", kind: "link", href: "/approvals" },
    ],
  },
  {
    id: "nf-m2",
    category: "Leave",
    title: "Leave request · Kabir Sharma",
    body: "PTO 14–16 Oct — currently on leave; confirm sprint coverage.",
    at: "2026-10-13T11:05:00",
    readBy: [],
    audience: "manager",
    recipientId: "emp-ram",
    href: "/leave",
    actionLabel: "View Calendar",
    detail: "Kabir Sharma (TZ0042) · Senior Engineer · Leave overlaps Maple Health sprint checkpoint. Coverage: Diya + Babu.",
    actions: [
      { id: "cal", label: "View Calendar", kind: "link", href: "/leave" },
      { id: "team", label: "Team overview", kind: "link", href: "/team" },
    ],
  },
  {
    id: "nf-m3",
    category: "Timesheet",
    title: "Timesheet submitted · Kabir Sharma",
    body: "Week of 6 Oct · 40h on Project Maple Health awaiting review.",
    at: "2026-10-13T18:10:00",
    readBy: [],
    audience: "manager",
    recipientId: "emp-ram",
    href: "/timesheet",
    inboxTaskId: "ib-2",
    actionLabel: "Open Timesheet",
    detail: "Kabir Sharma · 40h submitted · no overtime flagged. Approve from Approvals or open Timesheet.",
    actions: [
      { id: "ts", label: "Open Timesheet", kind: "link", href: "/timesheet" },
      { id: "inbox", label: "Open Approvals", kind: "link", href: "/approvals" },
    ],
  },
  {
    id: "nf-m4",
    category: "Timesheet",
    title: "Timesheet submitted · Anu Rao",
    body: "Week of 6 Oct · performance cycle hours need your sign-off.",
    at: "2026-10-13T17:40:00",
    readBy: [],
    audience: "manager",
    recipientId: "emp-ram",
    href: "/timesheet",
    actionLabel: "Open Timesheet",
    actions: [
      { id: "ts", label: "Open Timesheet", kind: "link", href: "/timesheet" },
      { id: "inbox", label: "Review", kind: "link", href: "/approvals" },
    ],
  },
  {
    id: "nf-m5",
    category: "Attendance",
    title: "Attendance correction · Babu Menon",
    body: "Missed check-out on 10 Oct · requested correction to 18:32.",
    at: "2026-10-11T08:05:00",
    readBy: [],
    audience: "manager",
    recipientId: "emp-ram",
    href: "/attendance",
    inboxTaskId: "ib-3",
    actionLabel: "View Attendance",
    detail: "Babu Menon · Forgot to check out · proposed out-time 18:32.",
    actions: [
      { id: "att", label: "View Attendance", kind: "link", href: "/attendance" },
      { id: "inbox", label: "Open Approvals", kind: "link", href: "/approvals" },
    ],
  },
  {
    id: "nf-m6",
    category: "Attendance",
    title: "Missing check-in · Diya Patel",
    body: "No clock-in recorded this morning (office expected). Follow up or mark exception.",
    at: "2026-10-14T10:15:00",
    readBy: [],
    audience: "manager",
    recipientId: "emp-ram",
    href: "/attendance",
    actionLabel: "View Attendance",
    detail: "Diya Patel · Expected In Office · no check-in by 10:15 IST. Confirm WFH or leave if applicable.",
    actions: [
      { id: "att", label: "View Attendance", kind: "link", href: "/attendance" },
      { id: "detail", label: "Review", kind: "detail" },
    ],
  },
  {
    id: "nf-m7",
    category: "Messages",
    title: "New message · Babu Menon",
    body: "Asked about sprint scope for Maple Health UAT this week.",
    at: "2026-10-14T08:42:00",
    readBy: [],
    audience: "manager",
    recipientId: "emp-ram",
    href: "/chat",
    actionLabel: "Open Message",
    actions: [{ id: "msg", label: "Open Message", kind: "link", href: "/chat" }],
  },
  {
    id: "nf-m8",
    category: "Messages",
    title: "New message · Priya Nair",
    body: "Shared L&D session notes and asked for mid-year check-in slot.",
    at: "2026-10-13T15:20:00",
    readBy: SEEN_BY_ALL,
    audience: "manager",
    recipientId: "emp-ram",
    href: "/chat",
    actionLabel: "Open Message",
    actions: [{ id: "msg", label: "Open Message", kind: "link", href: "/chat" }],
  },
  {
    id: "nf-m9",
    category: "Announcements",
    title: "HR announcement · Q4 All-hands",
    body: "All-hands on 22 Oct — share with your reports and block calendars.",
    at: "2026-10-08T10:05:00",
    readBy: [],
    audience: "manager",
    href: "/announcements",
    actionLabel: "Open",
    actions: [{ id: "open", label: "Open", kind: "link", href: "/announcements" }],
  },
  {
    id: "nf-m10",
    category: "Holidays",
    title: "Upcoming holiday · Dussehra",
    body: "20 Oct public holiday (India). Plan sprint capacity for your team.",
    at: "2026-10-12T07:00:00",
    readBy: [],
    audience: "manager",
    recipientId: "emp-ram",
    href: "/calendar",
    actionLabel: "View Calendar",
    actions: [
      { id: "cal", label: "View Calendar", kind: "link", href: "/calendar" },
      { id: "leave", label: "Leave calendar", kind: "link", href: "/leave" },
    ],
  },
  {
    id: "nf-m11",
    category: "Performance",
    title: "Review due · Priya Nair",
    body: "Mid-year check-in scheduled 18 Oct — prepare feedback notes.",
    at: "2026-10-12T09:00:00",
    readBy: [],
    audience: "manager",
    recipientId: "emp-ram",
    href: "/evaluations",
    actionLabel: "Review",
    detail: "Priya Nair · Mid-year check-in · due 18 Oct — prepare qualitative feedback notes.",
    actions: [
      { id: "rev", label: "Review", kind: "link", href: "/evaluations" },
      { id: "detail", label: "Details", kind: "detail" },
    ],
  },
  {
    id: "nf-m12",
    category: "Learning",
    title: "Learning deadline · team mandatory",
    body: "2 direct reports still pending Secure coding fundamentals (due 31 Oct).",
    at: "2026-10-10T09:30:00",
    readBy: [],
    audience: "manager",
    recipientId: "emp-ram",
    href: "/programs",
    actionLabel: "Review",
    actions: [
      { id: "learn", label: "Review", kind: "link", href: "/programs" },
      { id: "team", label: "Team overview", kind: "link", href: "/team" },
    ],
  },
  {
    id: "nf-m13",
    category: "Team",
    title: "New joiner · Riya Kapoor",
    body: "Engineer started 06 Oct — schedule 30-day check-in and buddy intro.",
    at: "2026-10-06T09:00:00",
    readBy: SEEN_BY_ALL,
    audience: "manager",
    recipientId: "emp-ram",
    href: "/team",
    actionLabel: "Open",
    actions: [
      { id: "team", label: "Team overview", kind: "link", href: "/team" },
      { id: "org", label: "Org chart", kind: "link", href: "/org-chart" },
    ],
  },
  {
    id: "nf-m14",
    category: "Team",
    title: "Coverage risk · leave today",
    body: "1 report on leave today (Kabir). Confirm Maple Health ownership before standup.",
    at: "2026-10-14T07:30:00",
    readBy: [],
    audience: "manager",
    recipientId: "emp-ram",
    href: "/team",
    actionLabel: "Review",
    detail: "Kabir Sharma on leave · Diya + Babu covering Maple Health for today.",
    actions: [
      { id: "team", label: "Team overview", kind: "link", href: "/team" },
      { id: "detail", label: "Review", kind: "detail" },
      { id: "att", label: "View Attendance", kind: "link", href: "/attendance" },
    ],
  },
];

export const DEFAULT_NOTIF_PREFS: NotifPrefs = {
  leave: true,
  timesheet: true,
  attendance: true,
  messages: true,
  holidays: true,
  learning: true,
  performance: true,
  announcements: true,
  team: true,
};

export const HR_REQUESTS_SEED: HrRequest[] = [
  {
    id: "hr-1",
    category: "Documents",
    subject: "Employment letter for bank KYC",
    description: "Need employment particulars letter for account opening.",
    status: "Resolved",
    requesterId: "emp-mahesh",
    requesterName: "Babu Menon",
    createdAt: "2026-09-01",
    updatedAt: "2026-09-03",
    comments: [
      { at: "2026-09-01T11:00:00", author: "Babu Menon", text: "Requested via Help." },
      { at: "2026-09-03T14:20:00", author: "Farhan Ali", text: "Issued letter — see Documents." },
    ],
  },
  {
    id: "hr-2",
    category: "Benefits",
    subject: "Add dependent to medical plan",
    description: "Please add spouse to Group Medical (India).",
    status: "In progress",
    requesterId: "emp-mahesh",
    requesterName: "Babu Menon",
    createdAt: "2026-10-05",
    updatedAt: "2026-10-12",
    comments: [
      { at: "2026-10-05T09:30:00", author: "Babu Menon", text: "Submitted dependent details." },
      { at: "2026-10-12T10:00:00", author: "HR Ops", text: "Waiting on insurer confirmation." },
    ],
  },
];

export const FAQ_ITEMS: FaqItem[] = [
  {
    id: "faq-1",
    question: "How do I request leave?",
    answer: "Open Leave & Absence, create a request, and submit for manager approval.",
    topic: "Leave",
    policyLink: "/policies",
  },
  {
    id: "faq-2",
    question: "Where are payslips?",
    answer: "Use Payslips under Pay. Payroll is processed by external providers.",
    topic: "Payroll",
    policyLink: "/payslips",
  },
  {
    id: "faq-3",
    question: "How do benefits enrollments work?",
    answer: "Open Benefits, select your country plan, and update your enrollment status.",
    topic: "Benefits",
    policyLink: "/benefits",
  },
  {
    id: "faq-4",
    question: "Who approves document letters?",
    answer: "HR Admin / HRBP can move letter requests from Draft to Issued in Documents & Letters.",
    topic: "Documents",
    policyLink: "/documents",
  },
  {
    id: "faq-5",
    question: "Is messaging real-time?",
    answer: "No. Messages are not delivered by email or push.",
    topic: "Messages",
  },
];
