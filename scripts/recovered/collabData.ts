/** TimeZ collaboration & workflow — fictional demo data only. */

export const COLLAB_DISCLAIMER =
  "Demo collaboration only. Real-time messaging, email delivery, and external integrations are not operational without a backend.";

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

export interface ChatPerson {
  id: string;
  name: string;
  title: string;
  department: string;
}

export interface ChatMessage {
  id: string;
  fromId: string;
  fromName: string;
  text: string;
  at: string;
  read: boolean;
  attachmentName?: string;
}

export interface Conversation {
  id: string;
  kind: "direct" | "group";
  title: string;
  participantIds: string[];
  participantNames: string[];
  unread: number;
  messages: ChatMessage[];
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
  readByMe: boolean;
}

export type NotifCategory =
  | "Leave"
  | "Timesheet"
  | "Messages"
  | "Holidays"
  | "Learning"
  | "Performance"
  | "Announcements";

export interface AppNotification {
  id: string;
  category: NotifCategory;
  title: string;
  body: string;
  at: string;
  read: boolean;
  href?: string;
}

export interface NotifPrefs {
  leave: boolean;
  timesheet: boolean;
  messages: boolean;
  holidays: boolean;
  learning: boolean;
  performance: boolean;
  announcements: boolean;
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
  { id: "emp-ram", name: "Ram Krishnan", title: "Engineering Manager", department: "Engineering" },
  { id: "demo-hr-admin", name: "Farhan Ali", title: "HR Director", department: "People" },
  { id: "demo-hrbp", name: "Meera Iyer", title: "HR Business Partner", department: "People" },
  { id: "demo-recruiter", name: "Sophie Clark", title: "Senior Recruiter", department: "People" },
  { id: "demo-learning", name: "Priya Nair", title: "L&D Lead", department: "Learning" },
  { id: "emp-mahesh", name: "Babu Menon", title: "Software Engineer", department: "Engineering" },
];

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
    summary: "Demo letter pending HR approve",
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
    requesterId: "demo-learning",
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
    requesterId: "demo-performance",
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
    requester: "Isha Reddy",
    requesterId: "ob-1",
    summary: "Delegated to Farhan Ali while Ram is OOO",
    status: "Delegated",
    createdAt: "2026-10-13T12:00:00",
    delegatedTo: "Farhan Ali",
    requiresReasonOnReject: true,
    timeline: [
      { at: "2026-10-13T12:00:00", actor: "Isha Reddy", action: "Submitted", status: "Pending" },
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
    unread: 1,
    messages: [
      {
        id: "m1",
        fromId: "emp-ram",
        fromName: "Ram Krishnan",
        text: "Can you update the timesheet before Friday standup?",
        at: "2026-10-13T16:02:00",
        read: false,
      },
      {
        id: "m2",
        fromId: "emp-mahesh",
        fromName: "Babu Menon",
        text: "Will do — drafting now.",
        at: "2026-10-13T16:10:00",
        read: true,
      },
    ],
  },
  {
    id: "cv-2",
    kind: "direct",
    title: "Meera Iyer",
    participantIds: ["emp-mahesh", "demo-hrbp"],
    participantNames: ["Babu Menon", "Meera Iyer"],
    unread: 0,
    messages: [
      {
        id: "m3",
        fromId: "demo-hrbp",
        fromName: "Meera Iyer",
        text: "Your policy acknowledgement is still open — ping me if the link fails.",
        at: "2026-10-10T11:20:00",
        read: true,
      },
    ],
  },
  {
    id: "cv-3",
    kind: "group",
    title: "Engineering Bengaluru",
    participantIds: ["emp-mahesh", "emp-ram", "demo-learning"],
    participantNames: ["Babu Menon", "Ram Krishnan", "Priya Nair"],
    unread: 2,
    messages: [
      {
        id: "m4",
        fromId: "emp-ram",
        fromName: "Ram Krishnan",
        text: "Sprint demo moved to Thursday 4pm IST.",
        at: "2026-10-14T08:15:00",
        read: false,
      },
      {
        id: "m5",
        fromId: "demo-learning",
        fromName: "Priya Nair",
        text: "Secure coding module due end of month — please enroll.",
        at: "2026-10-14T09:00:00",
        read: false,
        attachmentName: "secure-coding-outline-demo.txt",
      },
    ],
  },
];

export const ANNOUNCEMENTS_SEED: Announcement[] = [
  {
    id: "an-1",
    title: "Q4 All-hands",
    body: "Join the global all-hands on 22 Oct. Agenda covers roadmap, hiring, and wellbeing resources. This is a demo announcement.",
    scope: "Company",
    audience: "All TimeZ",
    state: "Published",
    publishedAt: "2026-10-08T10:00:00",
    author: "Internal Comms",
    readByMe: false,
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
    readByMe: true,
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
    readByMe: false,
  },
  {
    id: "an-4",
    title: "Team lunch · Platform squad",
    body: "Optional team lunch Thursday — RSVP in the channel (demo).",
    scope: "Team",
    audience: "Platform squad",
    state: "Scheduled",
    scheduledFor: "2026-10-16T08:00:00",
    author: "Ram Krishnan",
    readByMe: false,
  },
  {
    id: "an-5",
    title: "Benefits open enrollment (US) — draft",
    body: "Draft copy for US open enrollment. Not published.",
    scope: "Country",
    audience: "United States",
    state: "Draft",
    author: "Helen Brooks",
    readByMe: false,
  },
];

export const NOTIFICATIONS_SEED: AppNotification[] = [
  {
    id: "nf-1",
    category: "Leave",
    title: "Leave approved",
    body: "Your WFH on 3 Oct was approved by Ram Krishnan.",
    at: "2026-10-01T16:41:00",
    read: false,
    href: "/leave",
  },
  {
    id: "nf-2",
    category: "Timesheet",
    title: "Timesheet reminder",
    body: "Submit timesheet for week of 13 Oct.",
    at: "2026-10-14T08:00:00",
    read: false,
    href: "/timesheet",
  },
  {
    id: "nf-3",
    category: "Messages",
    title: "New message from Ram Krishnan",
    body: "Can you update the timesheet before Friday standup?",
    at: "2026-10-13T16:02:00",
    read: false,
    href: "/chat",
  },
  {
    id: "nf-4",
    category: "Holidays",
    title: "Upcoming holiday",
    body: "Dussehra holiday appears on your calendar next week.",
    at: "2026-10-12T07:00:00",
    read: true,
    href: "/holidays",
  },
  {
    id: "nf-5",
    category: "Learning",
    title: "Learning deadline",
    body: "Secure coding fundamentals due 31 Oct.",
    at: "2026-10-10T09:00:00",
    read: false,
    href: "/programs",
  },
  {
    id: "nf-6",
    category: "Performance",
    title: "Performance review reminder",
    body: "H2 mid-year self-assessment still in Draft.",
    at: "2026-10-09T10:00:00",
    read: false,
    href: "/evaluations",
  },
  {
    id: "nf-7",
    category: "Announcements",
    title: "HR announcement",
    body: "Q4 All-hands published — open Announcements to read.",
    at: "2026-10-08T10:05:00",
    read: false,
    href: "/announcements",
  },
];

export const DEFAULT_NOTIF_PREFS: NotifPrefs = {
  leave: true,
  timesheet: true,
  messages: true,
  holidays: true,
  learning: true,
  performance: true,
  announcements: true,
};

export const HR_REQUESTS_SEED: HrRequest[] = [
  {
    id: "hr-1",
    category: "Documents",
    subject: "Employment letter for bank KYC",
    description: "Need employment particulars letter for account opening (demo).",
    status: "Resolved",
    createdAt: "2026-09-01",
    updatedAt: "2026-09-03",
    comments: [
      { at: "2026-09-01T11:00:00", author: "Babu Menon", text: "Requested via Help." },
      { at: "2026-09-03T14:20:00", author: "Farhan Ali", text: "Issued demo letter — see Documents." },
    ],
  },
  {
    id: "hr-2",
    category: "Benefits",
    subject: "Add dependent to medical plan",
    description: "Please add spouse to Group Medical (India).",
    status: "In progress",
    createdAt: "2026-10-05",
    updatedAt: "2026-10-12",
    comments: [
      { at: "2026-10-05T09:30:00", author: "Babu Menon", text: "Submitted dependent details." },
      { at: "2026-10-12T10:00:00", author: "HR Ops", text: "Waiting on insurer confirmation (demo)." },
    ],
  },
];

export const FAQ_ITEMS: FaqItem[] = [
  {
    id: "faq-1",
    question: "How do I request leave?",
    answer: "Open Leave & Absence, create a request, and submit for manager approval. This is a frontend demo.",
    topic: "Leave",
    policyLink: "/policies",
  },
  {
    id: "faq-2",
    question: "Where are payslips?",
    answer: "Use Payslips under Pay. Payroll processing itself is out of scope for this prototype.",
    topic: "Payroll",
    policyLink: "/payslips",
  },
  {
    id: "faq-3",
    question: "How do benefits enrollments work?",
    answer: "Open Benefits, select your country plan, and update enrollment status in the demo UI.",
    topic: "Benefits",
    policyLink: "/benefits",
  },
  {
    id: "faq-4",
    question: "Who approves document letters?",
    answer: "HR Admin / HRBP personas can move letter requests from Draft to Issued in Documents & Letters.",
    topic: "Documents",
    policyLink: "/documents",
  },
  {
    id: "faq-5",
    question: "Is messaging real-time?",
    answer: "No. Messages are stored in browser local demo state only — not delivered by email or push.",
    topic: "Messages",
  },
];
