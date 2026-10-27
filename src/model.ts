export type LeaveCode = "comp_off" | "pto" | "wfh" | "emergency_wfh" | "sick" | "casual" | "unpaid" | "bereavement";
export type RequestStatus = "pending" | "approved" | "rejected" | "withdrawn";

/** Who decided a request, when, and what they said — shown to the requester. */
export interface DecisionInfo {
  decidedById?: string;
  decidedByName?: string;
  decidedOn?: string;
  decisionNote?: string;
}
export type TimesheetStatus = "draft" | "submitted" | "approved";
export type OrgTimesheetStatus = "missing" | "draft" | "submitted" | "approved";

export interface OrgTimesheetRecord {
  id: string;
  personId: string;
  name: string;
  employeeCode: string;
  department: string;
  weekStart: string;
  hours: number;
  status: OrgTimesheetStatus;
  projectSummary: string;
}
export type TaskStatus = "open" | "progress" | "done" | "scheduled";
export type TaskPriority = "low" | "medium" | "high" | "urgent";

export type UserRole =
  | "employee"
  | "manager"
  | "hr"
  | "hr_admin"
  | "hrbp"
  | "recruiter"
  | "executive"
  | "founder"
  | "cofounder"
  | "learning_admin"
  | "performance_admin"
  | "compensation_admin"
  | "finance"
  | "it_admin"
  | "admin"
  | "compliance"
  | "super_admin";

export const TIMEZ_COUNTRIES = [
  { code: "IN", name: "India", currency: "INR", timeZone: "Asia/Kolkata", headcount: 200 },
  { code: "US", name: "United States", currency: "USD", timeZone: "America/New_York", headcount: 100 },
  { code: "GB", name: "United Kingdom", currency: "GBP", timeZone: "Europe/London", headcount: 60 },
  { code: "AU", name: "Australia", currency: "AUD", timeZone: "Australia/Sydney", headcount: 40 },
  { code: "CA", name: "Canada", currency: "CAD", timeZone: "America/Toronto", headcount: 35 },
  { code: "AE", name: "United Arab Emirates", currency: "AED", timeZone: "Asia/Dubai", headcount: 25 },
  { code: "SA", name: "Saudi Arabia", currency: "SAR", timeZone: "Asia/Riyadh", headcount: 20 },
  { code: "DE", name: "Germany", currency: "EUR", timeZone: "Europe/Berlin", headcount: 20 },
] as const;

export type CountryCode = (typeof TIMEZ_COUNTRIES)[number]["code"];

export interface Employee {
  id: string;
  employeeCode: string;
  fullName: string;
  employmentType: string;
  designation: string;
  mobile: string;
  email: string;
  address: string;
  shiftName: string;
  shiftHours: string;
  photo: string;
  /** IANA time zone used for login history and schedule display */
  timeZone: string;
  role: UserRole;
  countryCode?: CountryCode;
  countryName?: string;
  legalEntity?: string;
  location?: string;
  department?: string;
  currency?: string;
}

/** Team approval rights — granted by role binding, not executive title alone. */
export function canApproveTeam(role: UserRole): boolean {
  return (
    role === "manager" ||
    role === "hr" ||
    role === "hr_admin" ||
    role === "hrbp" ||
    role === "admin" ||
    role === "it_admin" ||
    role === "super_admin"
  );
}

export function isLeadership(role: UserRole): boolean {
  return canApproveTeam(role) || role === "recruiter" || role === "finance";
}

export const PASSWORD_STALE_DAYS = 90;
export const PASSWORD_WARN_DAYS_BEFORE = 14;

export function dayGreetingPart(now: Date = new Date()): "Good morning" | "Good afternoon" | "Good evening" {
  const hour = now.getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

export function dayGreeting(name: string, now: Date = new Date()): string {
  return `${dayGreetingPart(now)}, ${name.split(" ")[0]}`;
}

export function daySubGreeting(now: Date = new Date()): string {
  const hour = now.getHours();
  if (hour < 12) return "Have a nice day";
  if (hour < 17) return "Hope your day is going well";
  return "Have a pleasant evening";
}

export interface PasswordPolicyStatus {
  due: boolean;
  warn: boolean;
  daysSinceChange: number;
  daysRemaining: number;
}

export function passwordPolicyFromChangedAt(changedAtIso: string | null, now: Date = new Date()): PasswordPolicyStatus {
  const daysSinceChange = changedAtIso ? daysSinceLogin(changedAtIso, now) : PASSWORD_STALE_DAYS + 1;
  const daysRemaining = Math.max(0, PASSWORD_STALE_DAYS - daysSinceChange);
  return {
    due: daysSinceChange >= PASSWORD_STALE_DAYS,
    warn: daysSinceChange >= PASSWORD_STALE_DAYS - PASSWORD_WARN_DAYS_BEFORE,
    daysSinceChange,
    daysRemaining,
  };
}

export interface LoginNotice {
  previousIso: string | null;
  timeZone: string;
  requirePasswordChange: boolean;
}

export function daysSinceLogin(iso: string, now: Date = new Date()): number {
  const then = new Date(iso);
  return Math.floor((now.getTime() - then.getTime()) / (1000 * 60 * 60 * 24));
}

export function formatLoginStamp(iso: string, timeZone: string): { date: string; time: string; zone: string } {
  const at = new Date(iso);
  const date = new Intl.DateTimeFormat("en-IN", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(at);
  const time = new Intl.DateTimeFormat("en-IN", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }).format(at);
  const zoneName =
    new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "long" })
      .formatToParts(at)
      .find((part) => part.type === "timeZoneName")?.value ?? timeZone;
  return { date, time, zone: `${timeZone.replaceAll("_", " ")} · ${zoneName}` };
}

export interface LeavePolicy {
  code: LeaveCode;
  name: string;
  /** Days a year. */
  quota: number;
  /** "monthly": the yearly quota builds up month by month instead of all on 1 January. */
  accrual?: "monthly";
  /** Unused days that roll over into the next year, at most. */
  carryForwardMax?: number;
  /** Country rules that replace the default name, days a year or carry-over (0 days = not offered there). */
  byCountry?: Partial<Record<CountryCode, { quota: number; name?: string; carryForwardMax?: number }>>;
}

/** The leave policy as it applies in one country. */
export function localPolicy(policy: LeavePolicy, country: CountryCode | undefined): LeavePolicy {
  const local = policy.byCountry?.[country ?? "IN"];
  if (!local) return policy;
  return {
    ...policy,
    name: local.name ?? policy.name,
    quota: local.quota,
    carryForwardMax: local.carryForwardMax ?? policy.carryForwardMax,
  };
}

/** Days of a monthly-accruing quota earned by `today` in `year` (whole year for past years). */
export function accruedQuota(quota: number, year: number, today: string = todayISO()): number {
  const thisYear = Number(today.slice(0, 4));
  if (year < thisYear) return quota;
  if (year > thisYear) return Math.floor((quota / 12) * 2) / 2;
  const month = Number(today.slice(5, 7));
  return Math.floor(((quota * month) / 12) * 2) / 2;
}

export interface LeaveRequest extends DecisionInfo {
  id: string;
  employeeId: string;
  code: LeaveCode;
  from: string;
  to: string;
  reason: string;
  status: RequestStatus;
  appliedOn: string;
  /** Half-day leave (only when from === to): counts as 0.5 day. */
  half?: LeaveHalf;
}

/** Which half of the day a half-day leave covers. */
export type LeaveHalf = "first" | "second";

/**
 * Permission to apply for leave on past dates. Raised by the employee, decided by someone above them
 * in the reporting line; once approved, the employee can apply for leave on those dates.
 */
export interface BackdatedLeavePermission {
  id: string;
  employeeId: string;
  employeeName: string;
  code: LeaveCode;
  from: string;
  to: string;
  reason: string;
  status: "pending" | "approved" | "rejected" | "withdrawn" | "used";
  requestedOn: string;
  decidedById?: string;
  decidedByName?: string;
  decidedOn?: string;
  decisionNote?: string;
}

export interface Encashment extends DecisionInfo {
  id: string;
  employeeId: string;
  code: LeaveCode;
  days: number;
  status: RequestStatus;
  appliedOn: string;
}

export interface Holiday {
  id: string;
  date: string;
  name: string;
  /** Country the holiday applies to; untagged entries are treated as India (older saved data). */
  countryCode?: CountryCode;
}

let personCountry: (employeeId: string) => CountryCode | undefined = () => undefined;
let personExtraHolidays: (employeeId: string) => Holiday[] = () => [];

/** Wires up who works where, and personal extra days off (optional holidays they picked). */
export function setHolidayContext(
  countryOf: (employeeId: string) => CountryCode | undefined,
  extra: (employeeId: string) => Holiday[],
): void {
  personCountry = countryOf;
  personExtraHolidays = extra;
}

/** The holidays that apply to one person: their country's list plus optional holidays they picked. */
export function holidaysForPerson(holidays: Holiday[], employeeId: string): Holiday[] {
  const country = personCountry(employeeId) ?? "IN";
  const byDate = new Map<string, Holiday>();
  for (const h of holidays) if ((h.countryCode ?? "IN") === country) byDate.set(h.date, h);
  for (const h of personExtraHolidays(employeeId)) if (!byDate.has(h.date)) byDate.set(h.date, h);
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** Holidays for everyone in one country (no personal picks). */
export function holidaysForCountry(holidays: Holiday[], country: CountryCode | undefined): Holiday[] {
  return holidays.filter((h) => (h.countryCode ?? "IN") === (country ?? "IN")).sort((a, b) => a.date.localeCompare(b.date));
}

export interface Project {
  id: string;
  name: string;
  vendor: string;
  client: string;
  startDate: string;
  endDate: string;
  timesheetType: "Weekly" | "Daily";
  maxHours: number | null;
  status: "current" | "previous";
  employeeId: string;
}

export interface TimeEntry {
  id: string;
  date: string;
  startHour: number;
  hours: number;
  note: string;
  billable: boolean;
  /** What the time was spent on. Missing = plain project time. Hours still roll up to the sheet's project. */
  workType?: "project" | "ticket" | "task";
  /** Ticket id (e.g. TCK-1042) or task id when workType is ticket/task. */
  workId?: string;
  /** Short label kept with the entry, e.g. "TCK-1042 Login timeout". */
  workLabel?: string;
}

export interface Timesheet {
  id: string;
  employeeId: string;
  projectId: string;
  weekStart: string;
  hours: Record<string, number>;
  entries: TimeEntry[];
  status: TimesheetStatus;
}

export function hoursFromEntries(entries: TimeEntry[]): Record<string, number> {
  const hours: Record<string, number> = {};
  for (const entry of entries) {
    hours[entry.date] = (hours[entry.date] ?? 0) + entry.hours;
  }
  return hours;
}

export function formatHourLabel(hour: number): string {
  const h = Math.floor(hour);
  const m = Math.round((hour - h) * 60);
  const suffix = h >= 12 ? "pm" : "am";
  const display = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${display} ${suffix}` : `${display}:${String(m).padStart(2, "0")} ${suffix}`;
}

export function formatHourCompact(hour: number): string {
  const h = Math.floor(hour);
  const m = Math.round((hour - h) * 60);
  const suffix = h >= 12 ? "pm" : "am";
  const display = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${display}:00 ${suffix}` : `${display}:${String(m).padStart(2, "0")} ${suffix}`;
}

export function formatHoursAmount(hours: number): string {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export interface PayLine {
  name: string;
  amount: number;
}

export interface Payslip {
  id: string;
  employeeId: string;
  month: string;
  /** ISO currency of the amounts; older saved payslips have none and are INR. */
  currency?: string;
  earnings: PayLine[];
  deductions: PayLine[];
  /** Set when only part of the month was worked (joining or leaving month). */
  paidDays?: number;
  totalDays?: number;
  /** The last payslip for someone who has left, including leave settlement. */
  finalSettlement?: boolean;
}

export interface Expense extends DecisionInfo {
  id: string;
  employeeId: string;
  date: string;
  category: string;
  amount: number;
  /** ISO currency of the amount; INR when missing (older saved data). */
  currency?: string;
  description: string;
  projectId: string;
  status: "submitted" | "approved" | "rejected" | "withdrawn";
}

export interface TaskSubtask {
  id: string;
  title: string;
  done: boolean;
}

export interface TaskAttachment {
  id: string;
  name: string;
  at: string;
}

export interface TaskComment {
  id: string;
  author: string;
  text: string;
  at: string;
}

export interface TaskActivity {
  id: string;
  at: string;
  actor: string;
  action: string;
  detail?: string;
}

export const TASK_TYPES = ["Feature", "Bug", "Improvement", "Research", "Support", "Admin"] as const;
export type TaskType = (typeof TASK_TYPES)[number];

/** A reference link on a task (spec, ticket, design, doc). */
export interface TaskLink {
  label: string;
  url: string;
}

/** Only plain web links are allowed — never javascript:, data: or file: URLs. */
export function safeTaskUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!url.hostname.includes(".")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export interface Task {
  id: string;
  code: string;
  employeeId: string;
  subject: string;
  priority: TaskPriority;
  status: TaskStatus;
  assignedBy: string;
  owner: string;
  department: string;
  role: string;
  managerName: string;
  client: string;
  notes: string;
  blocked: string;
  automationNote: string;
  createdAt: string;
  estimatedHours: number;
  hoursSpent: number;
  score: number;
  lastActivityAt: string;
  due: string;
  /** Extra people on the task (not the primary owner). Managers can add/remove. */
  peopleIds?: string[];
  /** 0–100 completion. Derived when omitted. */
  progressPct?: number;
  /** Employee acknowledged assignment before starting work. */
  accepted?: boolean;
  /** Submitted for manager review (still open until complete). */
  inReview?: boolean;
  dependsOn?: string;
  projectName?: string;
  taskType?: TaskType;
  /** Reference links: specs, tickets, designs, source documents. */
  links?: TaskLink[];
  /** Another task this one relates to. */
  referenceTaskId?: string;
  /** People kept informed. They can view the task but not change it. */
  ccIds?: string[];
  subtasks?: TaskSubtask[];
  attachments?: TaskAttachment[];
  comments?: TaskComment[];
  activity?: TaskActivity[];
}

export interface Evaluation {
  id: string;
  employeeId: string;
  cycle: string;
  status: "pending" | "completed";
  rating: string;
  summary: string;
}

export type ProgramKind = "mandatory" | "optional";
export type ProgramStatus = "enrolled" | "in_progress" | "completed";

export interface Program {
  id: string;
  employeeId: string;
  name: string;
  kind: ProgramKind;
  status: ProgramStatus;
  progress: number;
  modulesDone: number;
  modulesTotal: number;
  durationHours: number;
  dueDate: string;
  assignedBy: string;
  description: string;
}

export const DOCUMENT_GROUPS = ["Onboarding", "Employment", "Immigration", "IT documents"] as const;
export type DocumentGroup = (typeof DOCUMENT_GROUPS)[number];

export interface EmployeeDocument {
  id: string;
  employeeId: string;
  name: string;
  category: DocumentGroup;
  docType: string;
  expires: string;
  uploadedBy: string;
  uploadedAt: string;
  body: string;
  shared: boolean;
}

export interface Policy {
  id: string;
  title: string;
  kind: string;
  fileType: string;
  updatedBy: string;
  updated: string;
  body: string;
}

export interface FileRecord {
  id: string;
  name: string;
  folder: string;
  updated: string;
  note: string;
}

export interface FormTemplate {
  id: string;
  name: string;
  category: string;
  body: string;
}

export type Availability = "In Office" | "Work From Home" | "On Leave" | "Remote";

export interface Colleague {
  id: string;
  name: string;
  employeeCode: string;
  designation: string;
  department: string;
  email: string;
  personalEmail: string;
  mobile: string;
  managerName: string;
  availability: Availability;
  companyCode: string;
  businessUnit: string;
  practice: string;
  subPractice: string;
  gender: string;
  dateOfJoining: string;
  workingCountry: string;
  photo: string;
}

export interface Approval {
  id: string;
  reviewerId: string;
  colleagueId: string;
  type: string;
  summary: string;
  status: "pending" | "approved" | "rejected";
  date: string;
}

export interface AssetAssignment {
  id: string;
  employeeId: string;
  name: string;
  tag: string;
  assignedOn: string;
  condition: string;
}

export interface AssetRequest extends DecisionInfo {
  id: string;
  employeeId: string;
  item: string;
  reason: string;
  status: RequestStatus;
  date: string;
}

export interface CashAdvance extends DecisionInfo {
  id: string;
  employeeId: string;
  amount: number;
  /** ISO currency of the amount; INR when missing (older saved data). */
  currency?: string;
  category: string;
  purpose: string;
  requiredBy: string;
  status: RequestStatus;
  date: string;
}

export interface SoftwareRequest extends DecisionInfo {
  id: string;
  employeeId: string;
  software: string;
  justification: string;
  status: RequestStatus;
  date: string;
}

export interface CabBooking extends DecisionInfo {
  id: string;
  employeeId: string;
  date: string;
  time: string;
  from: string;
  to: string;
  status: RequestStatus;
}

export interface MenuItem {
  id: string;
  name: string;
  category: string;
  price: number;
}

export interface CafeteriaOrder {
  id: string;
  employeeId: string;
  menuItemId: string;
  date: string;
  status: "placed" | "cancelled";
  /** Name and price at the time of ordering, so later menu changes don't rewrite history. */
  itemName?: string;
  unitPrice?: number;
}

export interface ChatMessage {
  id: string;
  from: "me" | "them";
  text: string;
  at: string;
}

export interface ChatThread {
  id: string;
  employeeId: string;
  kind: "direct" | "group";
  title: string;
  colleagueId: string;
  memberIds: string[];
  messages: ChatMessage[];
}

export interface Reimbursement extends DecisionInfo {
  id: string;
  employeeId: string;
  date: string;
  category: string;
  amount: number;
  /** ISO currency of the amount; INR when missing (older saved data). */
  currency?: string;
  description: string;
  status: "submitted" | "approved" | "rejected" | "withdrawn";
}

export interface InvestmentProof extends DecisionInfo {
  id: string;
  employeeId: string;
  section: string;
  title: string;
  amount: number;
  financialYear: string;
  /** ISO currency of the amount; INR when missing. */
  currency?: string;
  status: "submitted" | "verified" | "rejected" | "withdrawn";
  submittedOn: string;
}

export interface SignatureRecord {
  id: string;
  employeeId: string;
  documentName: string;
  signedAt: string;
  dataUrl: string;
}

export interface PortalState {
  version: 25;
  /** @deprecated single shared slot from older versions — migrated into `profiles` on load. */
  profilePhoto?: string;
  /** @deprecated see `profiles`. */
  profile?: Pick<Employee, "fullName" | "designation" | "mobile" | "email" | "address" | "shiftName" | "shiftHours">;
  /** Each person's own edits to their contact details and photo, keyed by employee id. */
  profiles?: Record<string, ProfileOverride>;
  leavePolicies: LeavePolicy[];
  leaveRequests: LeaveRequest[];
  encashments: Encashment[];
  holidays: Holiday[];
  projects: Project[];
  timesheets: Timesheet[];
  orgTimesheets: OrgTimesheetRecord[];
  payslips: Payslip[];
  expenses: Expense[];
  tasks: Task[];
  evaluations: Evaluation[];
  programs: Program[];
  documents: EmployeeDocument[];
  policies: Policy[];
  files: FileRecord[];
  forms: FormTemplate[];
  approvals: Approval[];
  colleagues: Colleague[];
  assets: AssetAssignment[];
  assetRequests: AssetRequest[];
  cashAdvances: CashAdvance[];
  softwareRequests: SoftwareRequest[];
  cabBookings: CabBooking[];
  menu: MenuItem[];
  cafeteriaOrders: CafeteriaOrder[];
  chatThreads: ChatThread[];
  signatures: SignatureRecord[];
  absences: string[];
  reimbursements: Reimbursement[];
  investmentProofs: InvestmentProof[];
  backdatedPermissions: BackdatedLeavePermission[];
}

/** What employees may change about themselves. Job title and shift are HR-owned. */
export interface ProfileOverride {
  fullName: string;
  mobile: string;
  email: string;
  address: string;
  photo?: string;
}

export interface LeaveRow {
  code: LeaveCode;
  name: string;
  quota: number;
  /** Days brought over from last year (included in quota). */
  carriedOver?: number;
  utilized: number;
  pending: number;
  balance: number;
  available: number;
}

export interface PayslipView extends Payslip {
  label: string;
  gross: number;
  deductionTotal: number;
  net: number;
}

export interface LeaveInput {
  code: LeaveCode;
  from: string;
  to: string;
  reason: string;
  /** Half-day leave; only valid for a single day and not for WFH types. */
  half?: LeaveHalf;
}

export const EXPENSE_CATEGORIES = ["Travel", "Food", "Lodging", "Supplies", "Other"] as const;

export function uid(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

export function parseISODate(iso: string): Date {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year, (month ?? 1) - 1, day ?? 1);
}

export function toISO(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function todayISO(): string {
  return toISO(new Date());
}

export function formatLongDate(iso: string): string {
  return parseISODate(iso).toLocaleDateString("en-GB", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

/** "1 day", "3 days" — pass the plural form for irregular words. */
export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}

export function formatShortDate(iso: string): string {
  return parseISODate(iso).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/** Mask mobile for on-screen display; full value stays in profile edit only. */
export function maskMobile(mobile: string): string {
  const trimmed = mobile.trim();
  if (!trimmed) return "—";
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 4) return "••••";
  const last4 = digits.slice(-4);
  const country = trimmed.match(/^\+\d{1,3}/)?.[0];
  if (country) return `${country} ••••• •${last4}`;
  return `••••• •${last4}`;
}

/** Mask email for display, e.g. m••••@example.com */
export function maskEmail(email: string): string {
  const trimmed = email.trim();
  if (!trimmed) return "—";
  const at = trimmed.indexOf("@");
  if (at <= 0) return "••••@••••";
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  const visible = local.slice(0, 1);
  return `${visible}${"•".repeat(Math.max(3, local.length - 1))}@${domain}`;
}

/** Mask address for display; keep city/area hint when possible. */
export function maskAddress(address: string): string {
  const trimmed = address.trim();
  if (!trimmed) return "—";
  const parts = trimmed.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const city = parts[parts.length - 1];
    return `••••••••, ${city}`;
  }
  if (trimmed.length <= 6) return "••••••";
  return `${"•".repeat(Math.min(10, trimmed.length - 4))}${trimmed.slice(-4)}`;
}

export function formatStamp(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function payslipLabel(month: string): string {
  const name = parseISODate(`${month}-01`).toLocaleDateString("en-US", { month: "long" });
  const year = month.slice(0, 4);
  return `Payslip ${name}-${year}`;
}

export function inr(amount: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(amount);
}

/** Mask currency for on-screen display; fixed width so columns stay aligned. */
export function maskInr(_amount?: number): string {
  return "₹••••";
}

export function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

export function partyName(value: string, emptyLabel: string): string {
  return value.trim() ? value : emptyLabel;
}

export function workingDays(
  from: string,
  to: string,
  holidayDates: Set<string>,
  /** JS getDay() indexes that are weekly offs; defaults to Sat/Sun. */
  weeklyOffDays: number[] = [0, 6],
  /** Half-day leave: a single working day counts as 0.5. */
  half?: LeaveHalf,
): number {
  if (!from || !to || to < from) return 0;
  if (half && from === to) {
    const day = parseISODate(from).getDay();
    return weeklyOffDays.includes(day) || holidayDates.has(from) ? 0 : 0.5;
  }
  const cursor = parseISODate(from);
  const end = parseISODate(to);
  let count = 0;
  while (cursor <= end) {
    const iso = toISO(cursor);
    const day = cursor.getDay();
    if (!weeklyOffDays.includes(day) && !holidayDates.has(iso)) count += 1;
    cursor.setDate(cursor.getDate() + 1);
  }
  return count;
}

export function holidaySet(holidays: Holiday[]): Set<string> {
  return new Set(holidays.map((holiday) => holiday.date));
}

export function mondayOf(iso: string): string {
  const date = parseISODate(iso);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  return toISO(date);
}

export function shiftWeek(weekStart: string, weeks: number): string {
  const date = parseISODate(weekStart);
  date.setDate(date.getDate() + weeks * 7);
  return toISO(date);
}

export function weekDates(weekStart: string): string[] {
  const start = parseISODate(weekStart);
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return toISO(date);
  });
}

export function dayHeading(iso: string): string {
  const date = parseISODate(iso);
  const name = date.toLocaleDateString("en-US", { weekday: "short" });
  return `${name} ${date.getDate()}`;
}

export function monthLabel(year: number, monthIndex: number): string {
  return new Date(year, monthIndex, 1).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
}

export function monthCells(year: number, monthIndex: number): (string | null)[] {
  const first = new Date(year, monthIndex, 1);
  const pad = (first.getDay() + 6) % 7;
  const days = new Date(year, monthIndex + 1, 0).getDate();
  const cells: (string | null)[] = Array.from({ length: pad }, () => null);
  for (let day = 1; day <= days; day += 1) cells.push(toISO(new Date(year, monthIndex, day)));
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

/** Leave earned on top of the yearly quota, such as comp-off for working a holiday. */
let earnedLeave: (employeeId: string, code: LeaveCode, year: number) => number = () => 0;

export function setEarnedLeaveSource(source: (employeeId: string, code: LeaveCode, year: number) => number): void {
  earnedLeave = source;
}

export function leaveRows(
  policies: LeavePolicy[],
  requests: LeaveRequest[],
  encashments: Encashment[],
  holidays: Holiday[],
  employeeId: string,
  weeklyOffDays: number[] = [0, 6],
  /** Leave year to count; quotas reset each calendar year. Omit to count every year. */
  year?: number,
  /** Internal: whether to add last year's carried-over days (off when computing last year itself). */
  withCarryOver = true,
): LeaveRow[] {
  const dates = holidaySet(holidaysForPerson(holidays, employeeId));
  const country = personCountry(employeeId) ?? "IN";
  const lastYear =
    year != null && withCarryOver && policies.some((p) => p.carryForwardMax || p.byCountry)
      ? leaveRows(policies, requests, encashments, holidays, employeeId, weeklyOffDays, year - 1, false)
      : [];
  const inYear = (iso: string) => year == null || iso.startsWith(String(year));
  const rows = policies.map((basePolicy) => {
    const policy = localPolicy(basePolicy, country);
    const mine = requests.filter(
      (request) => request.employeeId === employeeId && request.code === policy.code && inYear(request.from),
    );
    const encashed = encashments.filter(
      (item) => item.employeeId === employeeId && item.code === policy.code && inYear(item.appliedOn),
    );
    const utilized =
      sum(
        mine
          .filter((request) => request.status === "approved")
          .map((request) => workingDays(request.from, request.to, dates, weeklyOffDays, request.half)),
      ) + sum(encashed.filter((item) => item.status === "approved").map((item) => item.days));
    const pending =
      sum(
        mine
          .filter((request) => request.status === "pending")
          .map((request) => workingDays(request.from, request.to, dates, weeklyOffDays, request.half)),
      ) + sum(encashed.filter((item) => item.status === "pending").map((item) => item.days));
    const yearly = year != null && policy.accrual === "monthly" ? accruedQuota(policy.quota, year) : policy.quota;
    const carried = policy.carryForwardMax
      ? Math.min(policy.carryForwardMax, Math.max(0, lastYear.find((row) => row.code === policy.code)?.balance ?? 0))
      : 0;
    const quota = yearly + carried + (year == null ? 0 : earnedLeave(employeeId, policy.code, year));
    const balance = quota - utilized;
    return {
      code: policy.code,
      name: policy.name,
      quota,
      carriedOver: carried,
      utilized,
      pending,
      balance,
      available: balance - pending,
    };
  });
  // Leave types not offered in the person's country (0 days, never used) are left out.
  return rows.filter((row) => row.quota > 0 || row.utilized > 0 || row.pending > 0 || row.code === "comp_off");
}

/** An approved, unused permission that covers the whole requested range, if there is one. */
export function backdatedPermissionFor(
  state: PortalState,
  employeeId: string,
  from: string,
  to: string,
  code?: LeaveCode,
  today: string = todayISO(),
): BackdatedLeavePermission | undefined {
  return (state.backdatedPermissions ?? []).find(
    (p) =>
      p.employeeId === employeeId &&
      p.status === "approved" &&
      (code == null || p.code === code) &&
      p.from <= from &&
      to <= p.to &&
      (!p.decidedOn || addDaysISO(p.decidedOn, BACKDATED_PERMISSION_VALID_DAYS) >= today),
  );
}

/** Approved backdated-leave permissions must be used within this many days. */
export const BACKDATED_PERMISSION_VALID_DAYS = 30;
/** Sick leave may be applied this many days after the fact without separate permission. */
export const SICK_LEAVE_GRACE_DAYS = 7;
/** Most hours that can be logged on a day with a half-day leave. */
export const HALF_DAY_MAX_HOURS = 4.5;
/** Leave types that do not block logging work (you still work, just from elsewhere). */
const WORKING_LEAVE: LeaveCode[] = ["wfh", "emergency_wfh"];

export function addDaysISO(iso: string, days: number): string {
  const date = parseISODate(iso);
  date.setDate(date.getDate() + days);
  return toISO(date);
}

/** Past dates need manager permission, except recent sick leave (people apply for that after being ill). */
export function needsBackdatedPermission(code: LeaveCode, from: string, today: string = todayISO()): boolean {
  if (from >= today) return false;
  if (code === "sick" && from >= addDaysISO(today, -SICK_LEAVE_GRACE_DAYS)) return false;
  return true;
}

export function validateLeave(
  state: PortalState,
  employeeId: string,
  input: LeaveInput,
  weeklyOffDays: number[] = [0, 6],
  today: string = todayISO(),
  options: { needsApprover?: boolean } = {},
): string | null {
  if (!input.reason.trim()) return "Enter a reason.";
  if (!input.from || !input.to) return "Choose the from and to dates.";
  if (input.to < input.from) return "The end date is before the start date.";
  if (input.from.slice(0, 4) !== input.to.slice(0, 4)) {
    return "Leave can't cross into the next year — split it into two requests.";
  }
  if (input.half) {
    if (input.half !== "first" && input.half !== "second") return "Choose first half or second half.";
    if (input.from !== input.to) return "A half day must start and end on the same date.";
    if (WORKING_LEAVE.includes(input.code)) return "Work from home can't be taken as a half day.";
  }
  if (input.code === "sick" && input.from > today) return "Sick leave can't be booked in advance.";
  if (
    options.needsApprover !== false &&
    needsBackdatedPermission(input.code, input.from, today) &&
    !backdatedPermissionFor(state, employeeId, input.from, input.to, input.code, today)
  ) {
    return input.code === "sick"
      ? `Sick leave older than ${SICK_LEAVE_GRACE_DAYS} days needs your manager's permission first. Request permission for these dates.`
      : "Leave for past dates needs approval from your manager first. Request permission for these dates.";
  }
  if (!WORKING_LEAVE.includes(input.code)) {
    const worked = state.timesheets
      .filter((sheet) => sheet.employeeId === employeeId)
      .flatMap((sheet) => Object.entries(sheet.hours))
      .reduce((byDate, [date, hours]) => byDate.set(date, (byDate.get(date) ?? 0) + hours), new Map<string, number>());
    // A half day still leaves half the daily limit for work.
    const allowed = input.half ? HALF_DAY_MAX_HOURS : 0;
    const clash = [...worked].find(([date, hours]) => hours > allowed && input.from <= date && date <= input.to);
    if (clash) {
      return input.half
        ? `You logged ${clash[1]} hours on ${formatLongDate(clash[0])} — a half day allows at most ${HALF_DAY_MAX_HOURS}.`
        : `You logged work on ${formatLongDate(clash[0])}. Remove those hours before applying leave.`;
    }
  }
  const days = workingDays(
    input.from,
    input.to,
    holidaySet(holidaysForPerson(state.holidays, employeeId)),
    weeklyOffDays,
    input.half,
  );
  if (days <= 0) return "That range has no working days (weekly offs and holidays are skipped).";
  const row = leaveRows(
    state.leavePolicies,
    state.leaveRequests,
    state.encashments,
    state.holidays,
    employeeId,
    weeklyOffDays,
    Number(input.from.slice(0, 4)),
  ).find((item) => item.code === input.code);
  if (!row) return "Choose a leave type.";
  if (days > row.available) return `Only ${plural(row.available, "day")} ${row.available === 1 ? "is" : "are"} available for ${row.name}.`;
  const overlap = state.leaveRequests.some(
    (request) =>
      request.employeeId === employeeId &&
      request.status !== "rejected" &&
      request.status !== "withdrawn" &&
      request.from <= input.to &&
      input.from <= request.to &&
      // Two different halves of the same day don't clash.
      !(request.half && input.half && request.half !== input.half && request.from === request.to && input.from === input.to),
  );
  if (overlap) return "Those dates overlap an existing leave request.";
  return null;
}

export function validateEncashment(
  state: PortalState,
  employeeId: string,
  code: LeaveCode,
  days: number,
  weeklyOffDays: number[] = [0, 6],
): string | null {
  if (code !== "pto") return "Only privilege leave can be encashed.";
  if (!Number.isInteger(days) || days <= 0) return "Enter whole days greater than zero.";
  const row = leaveRows(
    state.leavePolicies,
    state.leaveRequests,
    state.encashments,
    state.holidays,
    employeeId,
    weeklyOffDays,
    Number(todayISO().slice(0, 4)),
  ).find((item) => item.code === code);
  if (!row) return "Privilege leave is not available.";
  if (days > row.available) return `Only ${plural(row.available, "privilege leave day")} can be encashed.`;
  return null;
}

/** True when approved leave covers the whole day (a half day still leaves the other half for work). */
export function blockingLeave(requests: LeaveRequest[], employeeId: string, date: string): boolean {
  return requests.some(
    (request) =>
      request.employeeId === employeeId &&
      request.status === "approved" &&
      !WORKING_LEAVE.includes(request.code) &&
      !request.half &&
      request.from <= date &&
      date <= request.to,
  );
}

/** Approved half-day leave on this date, if any. */
export function halfDayLeave(requests: LeaveRequest[], employeeId: string, date: string): LeaveRequest | undefined {
  return requests.find(
    (request) =>
      request.employeeId === employeeId &&
      request.status === "approved" &&
      !WORKING_LEAVE.includes(request.code) &&
      Boolean(request.half) &&
      request.from === date,
  );
}

/** Most hours one person can log in a day across all projects. */
export const MAX_DAILY_HOURS = 9;

export function validateTimesheet(
  state: PortalState,
  employeeId: string,
  project: Project,
  hours: Record<string, number>,
  weeklyOffDays: number[] = [0, 6],
): string | null {
  const dates = holidaySet(holidaysForPerson(state.holidays, employeeId));
  const today = todayISO();
  let total = 0;
  for (const [date, value] of Object.entries(hours)) {
    if (!Number.isFinite(value) || value < 0) return "Hours cannot be negative.";
    if (value > 0 && date > today) return `${formatLongDate(date)} is in the future — log time after you've worked it.`;
    const otherProjects = state.timesheets
      .filter((sheet) => sheet.employeeId === employeeId && sheet.projectId !== project.id)
      .reduce((sum, sheet) => sum + (sheet.hours[date] ?? 0), 0);
    if (value + otherProjects > MAX_DAILY_HOURS) {
      return `${formatLongDate(date)} would total ${value + otherProjects} hours across projects — the daily limit is ${MAX_DAILY_HOURS}.`;
    }
    const day = parseISODate(date).getDay();
    if (weeklyOffDays.includes(day) && value > 0) {
      return `${formatLongDate(date)} is a weekly off on your schedule.`;
    }
    if (dates.has(date) && value > 0) return `${formatLongDate(date)} is a holiday.`;
    if (blockingLeave(state.leaveRequests, employeeId, date) && value > 0) {
      return `${formatLongDate(date)} is approved leave.`;
    }
    if (halfDayLeave(state.leaveRequests, employeeId, date) && value + otherProjects > HALF_DAY_MAX_HOURS) {
      return `${formatLongDate(date)} is a half day of leave — at most ${HALF_DAY_MAX_HOURS} hours.`;
    }
    if (state.absences.includes(date) && value > 0) return `${formatLongDate(date)} is marked absent.`;
    total += value;
  }
  if (project.maxHours != null && total > project.maxHours) {
    return `${project.name} allows ${project.maxHours} hours in a week.`;
  }
  return null;
}

export function validateExpense(
  input: {
    date: string;
    category: string;
    amount: number;
    description: string;
  },
  /** Largest single claim in the claimant's own currency. */
  maxClaim: number = MAX_CLAIM_AMOUNT,
  currency = "INR",
): string | null {
  if (!input.date) return "Choose a date.";
  const today = todayISO();
  if (input.date > today) return "The expense date can't be in the future.";
  if (input.date < addDaysISO(today, -EXPENSE_CLAIM_WINDOW_DAYS)) {
    return `Expenses must be claimed within ${EXPENSE_CLAIM_WINDOW_DAYS} days.`;
  }
  if (!input.category) return "Choose a category.";
  if (!input.description.trim()) return "Enter a description.";
  if (!Number.isFinite(input.amount) || input.amount <= 0) return "Enter an amount greater than zero.";
  if (input.amount > maxClaim) {
    const limit = new Intl.NumberFormat("en", { style: "currency", currency, maximumFractionDigits: 0 }).format(maxClaim);
    return `A single claim can't be more than ${limit}. Split it or contact Finance.`;
  }
  return null;
}

/** Claims older than this are rejected (typical reimbursement policy). */
export const EXPENSE_CLAIM_WINDOW_DAYS = 90;
/** Largest single expense / reimbursement claim accepted without Finance. */
export const MAX_CLAIM_AMOUNT = 200000;

export function toPayslipView(payslip: Payslip): PayslipView {
  const gross = sum(payslip.earnings.map((line) => line.amount));
  const deductionTotal = sum(payslip.deductions.map((line) => line.amount));
  return {
    ...payslip,
    label: payslipLabel(payslip.month),
    gross,
    deductionTotal,
    net: gross - deductionTotal,
  };
}

export interface AttendanceCell {
  date: string;
  kind: "present" | "weekend" | "holiday" | "leave" | "wfh" | "absent" | "upcoming";
  detail: string;
}

export function attendanceOn(
  date: string,
  holidays: Holiday[],
  requests: LeaveRequest[],
  absences: string[],
  shiftHours: string,
  today: string,
  employeeId: string,
  /** JS weekday indexes that are weekly offs; defaults to Sat/Sun when omitted. */
  weeklyOffDays: number[] = [0, 6],
): AttendanceCell {
  const holiday = holidaysForPerson(holidays, employeeId).find((item) => item.date === date);
  if (holiday) return { date, kind: "holiday", detail: holiday.name };
  const leave = requests.find(
    (request) => request.employeeId === employeeId && request.status === "approved" && request.from <= date && date <= request.to,
  );
  if (leave?.code === "wfh") return { date, kind: "wfh", detail: "WFH" };
  if (leave?.code === "emergency_wfh") return { date, kind: "wfh", detail: "Emergency WFH" };
  if (leave?.half) return { date, kind: "leave", detail: `Half-day leave (${leave.half} half)` };
  if (leave) return { date, kind: "leave", detail: "On leave" };
  const day = parseISODate(date).getDay();
  if (weeklyOffDays.includes(day)) return { date, kind: "weekend", detail: "Weekly off" };
  if (absences.includes(date)) return { date, kind: "absent", detail: "Absent" };
  if (date > today) return { date, kind: "upcoming", detail: "" };
  return { date, kind: "present", detail: shiftHours };
}

export function projectHours(timesheets: Timesheet[], projectId: string): number {
  return sum(
    timesheets
      .filter((sheet) => sheet.projectId === projectId)
      .map((sheet) => sum(Object.values(sheet.hours))),
  );
}

export interface ActionCounts {
  tasks: number;
  timesheet: number;
  evaluation: number;
  programs: number;
}

export function actionCounts(state: PortalState, employeeId: string): ActionCounts {
  return {
    tasks: state.tasks.filter((task) => task.employeeId === employeeId && task.status !== "done" && task.status !== "scheduled").length,
    timesheet: state.timesheets.filter(
      (sheet) => sheet.employeeId === employeeId && (sheet.status === "draft" || sheet.status === "submitted"),
    ).length,
    evaluation: state.evaluations.filter((item) => item.employeeId === employeeId && item.status === "pending").length,
    programs: state.programs.filter((item) => item.employeeId === employeeId && item.status !== "completed").length,
  };
}

export function payslipText(view: PayslipView, employee: Employee): string {
  const earn = view.earnings.map((line) => `${line.name}: ${line.amount}`).join("\n");
  const deduct = view.deductions.length
    ? view.deductions.map((line) => `${line.name}: ${line.amount}`).join("\n")
    : "None";
  return [
    view.label,
    employee.fullName,
    employee.employeeCode,
    `Currency: ${view.currency ?? "INR"}`,
    "",
    "Earnings",
    earn,
    `Gross: ${view.gross}`,
    "",
    "Deductions",
    deduct,
    `Deductions: ${view.deductionTotal}`,
    "",
    `Net pay: ${view.net}`,
  ].join("\n");
}
