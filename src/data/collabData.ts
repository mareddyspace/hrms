import { findDemoById } from "../demoAccounts.ts";
/** TimeZ collaboration & workflow — fictional demo data only. */

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
  /** Backend mode: readers must acknowledge it; HR sees read receipts. */
  mustAcknowledge?: boolean;
  acknowledged?: boolean;
  serverCanManage?: boolean;
  receipts?: { audience: number; read: number; acknowledged: number };
}

export type NotifCategory =
  | "Approvals"
  | "Leave"
  | "Tasks"
  | "Tickets"
  | "Mail"
  | "Messages"
  | "Attendance"
  | "Holidays"
  | "Pay"
  | "Recruiting"
  | "System";

/** Who should see this notification in the Notification Center. */
export type NotifAudience = "employee" | "manager" | "all";

export type NotifActionKind = "link" | "approve" | "reject" | "detail";

export interface NotifAction {
  id: string;
  label: string;
  kind?: NotifActionKind;
  href?: string;
}

/**
 * The record a notification is about. Used to show it as "Done" once that record no longer needs the
 * reader (leave decided, ticket closed, chat read, ...).
 */
export type NotifRefKind = "leave" | "timesheet" | "timesheetSubmit" | "inbox" | "chat" | "ticket" | "task";

export interface NotifRef {
  kind: NotifRefKind;
  id: string;
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
  /** Deep link to the exact item. */
  href?: string;
  /** What to do, e.g. "Review" or "Open ticket". */
  actionLabel?: string;
  /** Older saved rows only; the page uses href + actionLabel. */
  actions?: NotifAction[];
  /** Older saved rows only (collab inbox task). Prefer ref. */
  inboxTaskId?: string;
  detail?: string;
  ref?: NotifRef;
  /** User ids who deleted this notification from their own list. */
  hiddenFor?: string[];
}

export interface NotifPrefs {
  approvals: boolean;
  leave: boolean;
  tasks: boolean;
  tickets: boolean;
  mail: boolean;
  messages: boolean;
  attendance: boolean;
  holidays: boolean;
  pay: boolean;
  recruiting: boolean;
  system: boolean;
  /** Daily email summary of unread notifications. */
  emailDigest: boolean;
}

export type NotifCategoryPrefKey = Exclude<keyof NotifPrefs, "emailDigest">;

export const NOTIF_CATEGORIES: NotifCategory[] = [
  "Approvals",
  "Leave",
  "Tasks",
  "Tickets",
  "Mail",
  "Messages",
  "Attendance",
  "Holidays",
  "Pay",
  "Recruiting",
  "System",
];

export function notifPrefKey(category: NotifCategory): NotifCategoryPrefKey {
  return category.toLowerCase() as NotifCategoryPrefKey;
}

/** Category for a notification from its link (and a few titles that always need a decision). */
export function inferNotifCategory(href = "", title = ""): NotifCategory {
  if (/^(Approve |Shift swap request|Contract extension request)/i.test(title)) return "Approvals";
  const path = href.split(/[?#]/)[0];
  const starts = (...prefixes: string[]) => prefixes.some((p) => path === p || path.startsWith(`${p}/`));
  if (starts("/approvals")) return "Approvals";
  if (starts("/leave")) return "Leave";
  if (starts("/tasks")) return "Tasks";
  if (starts("/tickets")) return "Tickets";
  if (starts("/mail")) return "Mail";
  if (starts("/chat")) return "Messages";
  if (starts("/attendance", "/timesheet", "/workforce/shifts")) return "Attendance";
  if (starts("/holidays", "/calendar", "/workforce/optional-holidays")) return "Holidays";
  if (starts("/payslips", "/pay-preview", "/expenses", "/benefits", "/compensation", "/tax")) return "Pay";
  if (starts("/internal-jobs", "/recruiting", "/candidates", "/jobs", "/referrals")) return "Recruiting";
  return "System";
}

const LEGACY_CATEGORY: Record<string, NotifCategory> = {
  Timesheet: "Attendance",
  Learning: "System",
  Performance: "System",
  Announcements: "System",
};

/** Maps older saved categories (Timesheet, Team, ...) onto the current set. */
export function normalizeNotifCategory(raw: string, href?: string, title?: string): NotifCategory {
  if ((NOTIF_CATEGORIES as string[]).includes(raw)) return raw as NotifCategory;
  if (raw === "Team") return inferNotifCategory(href, title);
  return LEGACY_CATEGORY[raw] ?? inferNotifCategory(href, title);
}

/** The record behind a deep link, when the link names one. */
export function notifRefFromHref(href = "", title = ""): NotifRef | undefined {
  const [path, query = ""] = href.split("?");
  const params = new URLSearchParams(query);
  const ticket = params.get("id");
  const task = params.get("task");
  const chat = params.get("c");
  if (path === "/tickets" && ticket && /^Ticket assigned/i.test(title)) return { kind: "ticket", id: ticket };
  if (path === "/tasks" && task) return { kind: "task", id: task };
  if (path === "/chat" && chat) return { kind: "chat", id: chat };
  return undefined;
}

/** Task alerts carry the task code in the title ("New task · TSK-1042"); link straight to that task. */
export function taskDeepLink(title: string, href?: string): string | undefined {
  if (href && href !== "/tasks") return href;
  const code = title.match(/\b(TSK-\d+)\b/)?.[1];
  return code ? `/tasks?task=${code}` : href;
}

/** Default button text: says what to do. */
export function defaultNotifActionLabel(category: NotifCategory): string {
  switch (category) {
    case "Approvals":
      return "Review";
    case "Tasks":
      return "Open task";
    case "Tickets":
      return "Open ticket";
    case "Mail":
      return "Read mail";
    case "Messages":
      return "Reply";
    case "Leave":
      return "View leave";
    case "Holidays":
      return "View holidays";
    default:
      return "Open";
  }
}

/** Manager personas see team-scoped manager notifications. */
export function isManagerNotifRole(role: string): boolean {
  return role === "manager";
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
  | "IT access"
  | "Leave"
  | "Profile correction"
  | "Other";

export const HR_REQUEST_CATEGORIES: HrRequestCategory[] = [
  "Payroll provider",
  "Benefits",
  "Documents",
  "IT access",
  "Leave",
  "Profile correction",
  "Other",
];

export type HrRequestPriority = "Low" | "Normal" | "High" | "Urgent";
export const HR_REQUEST_PRIORITIES: HrRequestPriority[] = ["Low", "Normal", "High", "Urgent"];

/** People who work the HR service desk (assignable owners). */
export const HR_DESK_OWNERS: { id: string; name: string }[] = [
  { id: "demo-hr-admin", name: "Farhan Ali" },
  { id: "demo-admin", name: "Alex Morgan" },
];

/**
 * Service levels per category: who picks the request up first and how many working days
 * (Mon–Fri) HR has to resolve it. Edit this table to change routing or targets.
 */
export const HR_REQUEST_SLA: Record<HrRequestCategory, { ownerId: string; workingDays: number }> = {
  "Payroll provider": { ownerId: "demo-hr-admin", workingDays: 2 },
  Benefits: { ownerId: "demo-hr-admin", workingDays: 3 },
  Documents: { ownerId: "demo-hr-admin", workingDays: 3 },
  "IT access": { ownerId: "demo-admin", workingDays: 1 },
  Leave: { ownerId: "demo-hr-admin", workingDays: 2 },
  "Profile correction": { ownerId: "demo-hr-admin", workingDays: 2 },
  Other: { ownerId: "demo-hr-admin", workingDays: 3 },
};

export function hrDeskOwnerName(id: string | undefined): string {
  if (!id) return "Unassigned";
  return HR_DESK_OWNERS.find((o) => o.id === id)?.name ?? findDemoById(id)?.fullName ?? id;
}

/** Adds working days (skipping Saturday and Sunday) to a timestamp, keeping the time of day. */
export function addWorkingDays(fromIso: string, days: number): string {
  const d = new Date(fromIso);
  if (Number.isNaN(d.getTime())) return fromIso;
  let left = days;
  while (left > 0) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) left -= 1;
  }
  return d.toISOString();
}

export function hrRequestDueAt(category: HrRequestCategory, submittedAt: string): string {
  return addWorkingDays(submittedAt, (HR_REQUEST_SLA[category] ?? HR_REQUEST_SLA.Other).workingDays);
}

/** Statuses where the SLA clock runs. "Waiting on you" pauses it until the employee replies. */
export function hrRequestClockRunning(r: Pick<HrRequest, "status">): boolean {
  return r.status === "Open" || r.status === "In progress";
}

export function hrRequestOverdue(r: HrRequest, now = Date.now()): boolean {
  if (!hrRequestClockRunning(r) || !r.dueAt) return false;
  const due = Date.parse(r.dueAt);
  return !Number.isNaN(due) && due < now;
}

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
  /** Full timestamp of submission (createdAt is the date only). */
  submittedAt?: string;
  /** HR owner working the request; "" when unassigned. */
  assigneeId?: string;
  priority?: HrRequestPriority;
  /** Resolution target from the category SLA. */
  dueAt?: string;
  /** When HR first replied or changed the status. */
  firstResponseAt?: string;
  /** Requester's rating (1–5) once resolved; backend mode only. */
  satisfaction?: number;
  satisfactionComment?: string;
  /** Backend mode only: escalation, the server's overdue flag and attached files. */
  escalatedAt?: string;
  overdue?: boolean;
  files?: { id: string; name: string; contentType: string; size: number; at: string }[];
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
    id: "demo-ceo",
    name: "Jordan Blake",
    title: "Chief Executive Officer",
    department: "Executive",
    roleLabel: "Executive",
    availability: "Busy",
    channelTags: ["general", "leadership"],
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
    title: "Performance Manager",
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
    audience: "All TimeZ",
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
    author: "Farhan Ali",
    authorId: "demo-hr-admin",
    readBy: [],
  },
];

/** Seed times relative to page load so the Today / Yesterday groups have something in them. */
function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 3_600_000).toISOString();
}

/**
 * Seed notifications. Each one points at a real seeded record (leave, timesheet, chat, holiday,
 * announcement) so its link opens that item and it turns "Done" once the item is handled.
 */
export const NOTIFICATIONS_SEED: AppNotification[] = [
  /* ── Babu Menon (employee) ── */
  {
    id: "nf-1",
    category: "Leave",
    title: "WFH on 22 Oct approved",
    body: "Approved by Ram Krishnan.",
    at: "2026-10-09T10:00:00",
    readBy: SEEN_BY_ALL,
    audience: "employee",
    recipientId: "emp-mahesh",
    href: "/leave",
    actionLabel: "View leave",
  },
  {
    id: "nf-2",
    category: "Attendance",
    title: "Submit timesheet · week of 12 Oct",
    body: "27 h logged, still in draft.",
    at: hoursAgo(3),
    readBy: [],
    audience: "employee",
    recipientId: "emp-mahesh",
    href: "/timesheet",
    actionLabel: "Submit timesheet",
    ref: { kind: "timesheetSubmit", id: "org-ts-babu" },
  },
  {
    id: "nf-3",
    category: "Messages",
    title: "New messages in Engineering Bengaluru",
    body: "Ram Krishnan: Sprint demo moved to Thursday 4pm IST.",
    at: hoursAgo(27),
    readBy: [],
    audience: "employee",
    recipientId: "emp-mahesh",
    href: "/chat?c=cv-3",
    actionLabel: "Reply",
    ref: { kind: "chat", id: "cv-3" },
  },

  /* ── Everyone ── */
  {
    id: "nf-4",
    category: "Holidays",
    title: "Diwali holidays · 8–11 Nov",
    body: "Plan cover and leave around the break.",
    at: hoursAgo(50),
    readBy: [],
    audience: "all",
    countryCode: "IN",
    href: "/holidays",
    actionLabel: "View holidays",
  },
  {
    id: "nf-7",
    category: "System",
    title: "New announcement · Q4 All-hands",
    body: "Roadmap, hiring and wellbeing.",
    at: "2026-10-08T10:05:00",
    readBy: SEEN_BY_ALL,
    audience: "all",
    href: "/announcements",
    actionLabel: "Read",
  },

  /* ── Ram Krishnan (manager) ── */
  {
    id: "nf-m1",
    category: "Approvals",
    title: "Approve leave for Priya Nair",
    body: "PTO · 1 day · waiting on you.",
    at: hoursAgo(20),
    readBy: [],
    audience: "manager",
    recipientId: "emp-ram",
    href: "/approvals",
    actionLabel: "Review",
    ref: { kind: "leave", id: "lv-priya-pto" },
  },
  {
    id: "nf-m3",
    category: "Approvals",
    title: "Approve timesheet for Priya Nair",
    body: "Week of 12 Oct · 30 h.",
    at: hoursAgo(30),
    readBy: [],
    audience: "manager",
    recipientId: "emp-ram",
    href: "/approvals",
    actionLabel: "Review",
    ref: { kind: "timesheet", id: "org-ts-priya" },
  },
  {
    id: "nf-m7",
    category: "Messages",
    title: "New message in Engineering Bengaluru",
    body: "Priya Nair: Secure coding module due end of month — please enroll.",
    at: hoursAgo(5),
    readBy: [],
    audience: "manager",
    recipientId: "emp-ram",
    href: "/chat?c=cv-3",
    actionLabel: "Reply",
    ref: { kind: "chat", id: "cv-3" },
  },
];

export const DEFAULT_NOTIF_PREFS: NotifPrefs = {
  approvals: true,
  leave: true,
  tasks: true,
  tickets: true,
  mail: true,
  messages: true,
  attendance: true,
  holidays: true,
  pay: true,
  recruiting: true,
  system: true,
  emailDigest: false,
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
