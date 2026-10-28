import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { appendAuditEntries, diffForAudit } from "./data/auditTrail.ts";
import { getTickets, isOpenTicket } from "./data/ticketStore.ts";
import { compOffCreditsFor, getShiftState, subscribeShifts } from "./features/workforce/shiftsStore.ts";
import { claimLimitsFor, declarableTaxYears, money, payRulesFor, receiptThresholdFor } from "./countryPay.ts";
import type { ReactNode } from "react";
import { createContext, useContext } from "react";
import {
  actionCounts,
  leaveRows,
  projectHours,
  toPayslipView,
  todayISO,
  uid,
  validateEncashment,
  validateExpense,
  validateLeave,
  safeTaskUrl,
  TASK_TYPES,
  backdatedPermissionFor,
  needsBackdatedPermission,
  addDaysISO,
  formatLongDate,
  hoursFromEntries,
  validateTimesheet,
  workingDays,
  holidaySet,
  PASSWORD_STALE_DAYS,
  daysSinceLogin,
  passwordPolicyFromChangedAt,
} from "./model.ts";
import type {
  Approval,
  AssetRequest,
  BackdatedLeavePermission,
  CabBooking,
  CashAdvance,
  DecisionInfo,
  Employee,
  Encashment,
  Expense,
  DocumentGroup,
  EmployeeDocument,
  LeaveCode,
  LeaveInput,
  LeaveRequest,
  LoginNotice,
  PasswordPolicyStatus,
  PortalState,
  RequestStatus,
  SoftwareRequest,
  InvestmentProof,
  Reimbursement,
  Task,
  TaskPriority,
  TaskStatus,
  TaskLink,
  TaskType,
  OrgTimesheetStatus,
  TimeEntry,
  TimesheetStatus,
} from "./model.ts";
import { scheduleForEmployee } from "./data/workSchedule.ts";
import {
  DEMO_ACCOUNTS as TIMEZ_DEMOS,
  demoPasswordFor,
  findDemoByCode,
  findDemoByEmailOrCode,
  findDemoById,
  managementChain,
  type DemoAccount, RETIRED_ACCOUNT_IDS, RETIRED_SIGN_IN_IDS, mentionsRetiredAccount, setDirectoryChainSource, setNavOverrideSource } from "./demoAccounts.ts";
import { canApproveTeam, holidaysForPerson, setEarnedLeaveSource, setHolidayContext } from "./model.ts";
import { getOptionalHolidayState, subscribeOptionalHolidays } from "./features/workforce/optionalHolidaysStore.ts";
import { getPerson, isAccountActive, managerChainIds } from "./data/peopleLocal.ts";
import { delegatedAuthority, noteLeaves, type DelegationScope } from "./data/delegations.ts";
import { cachedPayslips, generatePayslips } from "./data/payslipGenerator.ts";
import { getTaxRegime } from "./data/taxRegime.ts";
import { getExitState, subscribeExits } from "./features/lifecycle/exitStore.ts";
import { getNavOverrides } from "./data/platformLocal.ts";
import { createSeed, DEMO_PASSWORD, EMPLOYEE, findAccountByCode, findAccountById } from "./seed.ts";
import { taskPersonById } from "./data/taskTeam.ts";
import { pushManagerTaskAlert, pushPersonTaskAlert } from "./data/collabLocal.ts";
import { resolveWorkflow } from "./data/approvalWorkflows.ts";
import { canPayExpenses, currentStepOf, isWaitingOn } from "./data/expenseFlow.ts";
import { taskProgress } from "./data/taskHelpers.ts";
import { isTaskAutoMode } from "./data/taskAutoMode.ts";

const STORAGE_KEY = "kastech.ess.state.v1";
const SESSION_KEY = "kastech.ess.session";
const USER_KEY = "kastech.ess.user";
const PHOTO_RESET_KEY = "kastech.ess.photo-reset";
const LAST_LOGIN_KEY = "kastech.ess.last-login";
const LAST_LOGIN_SEEDED_KEY = "kastech.ess.last-login-seeded";
const PASSWORD_KEY = "kastech.ess.password";
const PASSWORD_CHANGED_AT_KEY = "kastech.ess.password-changed-at";
const REMEMBER_KEY = "timez.demo.remember-email";

function passwordStorageKey(employeeCode: string): string {
  return `${PASSWORD_KEY}.${employeeCode.toUpperCase()}`;
}

function storedPassword(employeeCode: string = EMPLOYEE.employeeCode): string {
  return (
    localStorage.getItem(passwordStorageKey(employeeCode)) ??
    demoPasswordFor(employeeCode) ??
    localStorage.getItem(PASSWORD_KEY) ??
    DEMO_PASSWORD
  );
}

const MUST_CHANGE_KEY = "kastech.ess.must-change-password";
const LOCK_KEY = "kastech.ess.login-lock";
const LAST_ACTIVE_KEY = "kastech.ess.last-active";
const MAX_LOGIN_ATTEMPTS = 5;
const LOCK_MINUTES = 5;

/** Per-person keys: password age, last login and the forced-change flag belong to one account, not the device. */
function userKey(base: string, employeeCode: string): string {
  return `${base}.${employeeCode.toUpperCase()}`;
}

function passwordChangedAtIso(employeeCode: string): string | null {
  return localStorage.getItem(userKey(PASSWORD_CHANGED_AT_KEY, employeeCode));
}

function notePasswordChanged(employeeCode: string) {
  localStorage.setItem(userKey(PASSWORD_CHANGED_AT_KEY, employeeCode), new Date().toISOString());
  localStorage.removeItem(userKey(MUST_CHANGE_KEY, employeeCode));
}

/** Session lives in localStorage with "Remember me", otherwise only until the browser closes. */
function readSession(): boolean {
  // A session saved for a retired sign-in account (Compensation, Hiring Manager, the Country Managers) is signed out.
  const savedUser = localStorage.getItem(USER_KEY);
  if (savedUser && RETIRED_SIGN_IN_IDS.has(savedUser)) {
    localStorage.setItem(SESSION_KEY, "out");
    sessionStorage.removeItem(SESSION_KEY);
    return false;
  }
  return localStorage.getItem(SESSION_KEY) === "in" || sessionStorage.getItem(SESSION_KEY) === "in";
}

function readLock(employeeCode: string): { fails: number; until: number } {
  try {
    const raw = localStorage.getItem(userKey(LOCK_KEY, employeeCode));
    return raw ? (JSON.parse(raw) as { fails: number; until: number }) : { fails: 0, until: 0 };
  } catch {
    return { fails: 0, until: 0 };
  }
}

function savePassword(employeeCode: string, next: string) {
  localStorage.setItem(passwordStorageKey(employeeCode), next);
  notePasswordChanged(employeeCode);
}

/** First time we see an account, start its password-age clock (only once — not on every render). */
function ensureDemoPasswordChangedAt(employeeCode?: string) {
  const code = employeeCode ?? EMPLOYEE.employeeCode;
  if (passwordChangedAtIso(code)) return;
  localStorage.setItem(userKey(PASSWORD_CHANGED_AT_KEY, code), new Date().toISOString());
}

function ensureDemoLastLogin() {
  ensureDemoPasswordChangedAt();
  if (localStorage.getItem(LAST_LOGIN_SEEDED_KEY) === "1") return;
  const previous = new Date();
  previous.setDate(previous.getDate() - 1);
  previous.setHours(9, 42, 18, 0);
  if (!localStorage.getItem(LAST_LOGIN_KEY)) {
    localStorage.setItem(LAST_LOGIN_KEY, previous.toISOString());
  }
  localStorage.setItem(LAST_LOGIN_SEEDED_KEY, "1");
}

function loadState(): PortalState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createSeed();
    const parsed = JSON.parse(raw) as PortalState;
    if (!parsed || parsed.version !== 25 || !Array.isArray(parsed.leaveRequests) || !Array.isArray(parsed.projects)) {
      return createSeed();
    }
    const seed = createSeed();
    if (!Array.isArray(parsed.colleagues)) parsed.colleagues = seed.colleagues;
    if (!Array.isArray(parsed.approvals)) parsed.approvals = seed.approvals;
    if (!Array.isArray(parsed.chatThreads)) parsed.chatThreads = seed.chatThreads;
    if (!Array.isArray(parsed.policies)) parsed.policies = seed.policies;
    if (!Array.isArray(parsed.documents)) parsed.documents = seed.documents;
    if (!Array.isArray(parsed.backdatedPermissions)) parsed.backdatedPermissions = [];
    if (localStorage.getItem(PHOTO_RESET_KEY) !== "1") {
      if (parsed.profilePhoto) {
        delete parsed.profilePhoto;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
      }
      localStorage.setItem(PHOTO_RESET_KEY, "1");
    }
    if (!parsed.profiles || typeof parsed.profiles !== "object") parsed.profiles = {};
    // Retired sign-in accounts (the Compensation persona): drop saved records that still point at them.
    let retiredDropped = false;
    for (const id of RETIRED_ACCOUNT_IDS) {
      if (id in parsed.profiles) {
        delete parsed.profiles[id];
        retiredDropped = true;
      }
    }
    for (const [key, value] of Object.entries(parsed) as [string, unknown][]) {
      if (!Array.isArray(value)) continue;
      const kept = value.filter((row) => !mentionsRetiredAccount(row));
      if (kept.length !== value.length) {
        (parsed as unknown as Record<string, unknown>)[key] = kept;
        retiredDropped = true;
      }
    }
    if (retiredDropped) localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
    if (parsed.profile) {
      const { fullName, mobile, email, address } = parsed.profile;
      parsed.profiles[EMPLOYEE.id] ??= { fullName, mobile, email, address, photo: parsed.profilePhoto };
      delete parsed.profile;
      delete parsed.profilePhoto;
    }
    let renamed = false;
    // The sample WFH request used to fall on the Dussehra holiday (20 Oct), which leave rules forbid.
    const holidayWfh = parsed.leaveRequests.find(
      (req) => req.id === "lv-oct-wfh" && req.from === "2026-10-20" && req.to === "2026-10-20",
    );
    if (holidayWfh) {
      holidayWfh.from = "2026-10-22";
      holidayWfh.to = "2026-10-22";
      renamed = true;
    }
    const babuProfile = parsed.profiles[EMPLOYEE.id];
    if (babuProfile?.fullName === "Mahesh Babu") {
      parsed.profiles[EMPLOYEE.id] = { ...babuProfile, fullName: "Babu" };
      renamed = true;
    }
    if (Array.isArray(parsed.documents)) {
      parsed.documents = parsed.documents.map((document) => {
        const uploadedBy = document.uploadedBy === "Mahesh Babu" ? "Babu" : document.uploadedBy;
        const body = String(document.body ?? "").replaceAll("Mahesh Babu", "Babu");
        if (uploadedBy !== document.uploadedBy || body !== document.body) renamed = true;
        return uploadedBy === document.uploadedBy && body === document.body ? document : { ...document, uploadedBy, body };
      });
    }
    // Sample requests left waiting after their dates have passed are replaced with current ones.
    for (const sample of seed.leaveRequests.filter((r) => ["lv-oct-wfh", "lv-priya-pto", "lv-anu-sick"].includes(r.id))) {
      const saved = parsed.leaveRequests.find((r) => r.id === sample.id);
      if (saved && saved.status === "pending" && saved.from < todayISO()) {
        Object.assign(saved, sample);
        renamed = true;
      }
    }
    // Leave policies gained accrual / carry-forward and comp-off became earned-only.
    if (!parsed.leavePolicies.some((p) => p.byCountry)) {
      parsed.leavePolicies = seed.leavePolicies;
      renamed = true;
    }
    // Holidays used to be one Indian list for everyone; they are now tagged by country.
    if (!Array.isArray(parsed.holidays) || parsed.holidays.some((h) => !h.countryCode)) {
      parsed.holidays = seed.holidays;
      renamed = true;
    }
    // Payslips used to be Indian for everyone; they now follow each person's country.
    if (!Array.isArray(parsed.payslips) || parsed.payslips.some((slip) => !slip.currency)) {
      parsed.payslips = seed.payslips;
      renamed = true;
    }
    if (!parsed.policies.some((policy) => policy.id === "pol-handbook")) {
      parsed.policies = seed.policies;
      renamed = true;
    }
    if (renamed) localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
    return parsed;
  } catch {
    return createSeed();
  }
}

function patchById<T extends { id: string }>(items: T[], id: string, patch: Partial<T>): T[] {
  return items.map((item) => (item.id === id ? { ...item, ...patch } : item));
}

interface PortalApi {
  employee: Employee;
  demoProfile: DemoAccount;
  isManager: boolean;
  demoAccounts: DemoAccount[];
  signedIn: boolean;
  loginNotice: LoginNotice | null;
  dismissLoginNotice: () => void;
  changePasswordAfterStaleLogin: (newPassword: string, confirm: string) => string | null;
  passwordPolicy: PasswordPolicyStatus;
  changePassword: (currentPassword: string, newPassword: string, confirm: string) => string | null;
  requestPasswordResetOtp: (
    employeeCode: string,
    channel: "email" | "mobile",
  ) => { code: string; sentTo: string; channel: "email" | "mobile" } | { error: string };
  resetPasswordWithOtp: (employeeCode: string, otp: string, newPassword: string, confirm: string) => string | null;
  /** Accepts work email or employee ID. */
  signIn: (emailOrCode: string, password: string, remember?: boolean) => Promise<string | null>;
  /** Prototype-only persona switch — not production authorization. */
  switchDemoPersona: (accountId: string) => string | null;
  rememberedEmail: string | null;
  clearRememberedEmail: () => void;
  signOut: () => void;
  updateProfile: (
    input: Pick<Employee, "fullName" | "designation" | "mobile" | "email" | "address" | "shiftName" | "shiftHours"> & {
      photo?: string;
    },
  ) => string | null;
  requestProfileOtp: () => string;
  updateProfileWithOtp: (
    input: Pick<Employee, "fullName" | "designation" | "mobile" | "email" | "address" | "shiftName" | "shiftHours"> & {
      photo?: string;
    },
    otp: string,
  ) => string | null;
  resetDemo: () => void;
  state: PortalState;
  leaveTable: ReturnType<typeof leaveRows>;
  counts: ReturnType<typeof actionCounts>;
  payslipViews: ReturnType<typeof toPayslipView>[];
  currentProjects: PortalState["projects"];
  previousProjects: PortalState["projects"];
  hoursFor: (projectId: string) => number;
  applyLeave: (input: LeaveInput) => Promise<string | null>;
  setLeaveStatus: (id: string, status: RequestStatus, note?: string) => Promise<string | null>;
  /** Ask the reporting line for permission to apply for leave on past dates. */
  requestBackdatedPermission: (input: LeaveInput) => string | null;
  withdrawBackdatedPermission: (id: string) => string | null;
  decideBackdatedPermission: (id: string, decision: "approved" | "rejected", note?: string) => string | null;
  /** Manager-or-HR visibility check (who may see and manage this person's records). */
  canApproveLeaveFor: (employeeId: string) => boolean;
  /**
   * Whether the signed-in user decides this person's requests — someone above them in the reporting line.
   * Pass a request type to also count an active approval delegation (§25) that covers it.
   */
  canDecideFor: (employeeId: string, scope?: DelegationScope) => boolean;
  /** False for people at the top of the organisation: their requests are approved automatically. */
  hasApprover: boolean;
  applyEncashment: (code: LeaveCode, days: number) => string | null;
  setEncashmentStatus: (id: string, status: RequestStatus, note?: string) => string | null;
  saveTimesheet: (projectId: string, weekStart: string, hours: Record<string, number>, status: TimesheetStatus) => string | null;
  addTimeEntry: (
    projectId: string,
    weekStart: string,
    input: Omit<TimeEntry, "id">,
  ) => string | null;
  removeTimeEntry: (projectId: string, weekStart: string, entryId: string) => string | null;
  submitWeekTimesheets: (weekStart: string) => string | null;
  setOrgTimesheetStatus: (id: string, status: OrgTimesheetStatus) => string | null;
  /** Whether the signed-in user may verify tax-saving proofs (payroll/HR). */
  canVerifyProofs: boolean;
  addExpense: (input: Omit<Expense, "id" | "employeeId" | "status">) => string | null;
  setExpenseStatus: (id: string, status: Expense["status"], note?: string) => string | null;
  /** Whether the signed-in user decides the open approval step of this claim. */
  canDecideExpense: (expense: Expense) => boolean;
  /** Whether the signed-in user records payment on this approved claim (finance or admin). */
  canPayExpense: (expense: Expense) => boolean;
  markExpensePaid: (id: string, paidOn: string, reference: string) => string | null;
  acceptTask: (id: string) => string | null;
  moveTask: (id: string, status: TaskStatus) => void;
  /** Manager: set primary owner / reassign task. */
  reassignTask: (taskId: string, personId: string) => string | null;
  /** Manager: add a collaborator (not primary owner). */
  addTaskPerson: (taskId: string, personId: string) => string | null;
  /** Manager: remove a collaborator (cannot remove primary owner this way). */
  removeTaskPerson: (taskId: string, personId: string) => string | null;
  /** Manager: create a new task for a team member. */
  createTask: (input: {
    subject: string;
    ownerId: string;
    priority: TaskPriority;
    status?: TaskStatus;
    client?: string;
    notes?: string;
    due?: string;
    estimatedHours?: number;
    peopleIds?: string[];
    taskType?: TaskType;
    links?: TaskLink[];
    referenceTaskId?: string;
    ccIds?: string[];
  }) => string | null;
  taskAction: (
    taskId: string,
    action: "accept" | "start" | "progress" | "block" | "unblock" | "help" | "review" | "complete",
    payload?: { progressPct?: number; blockedReason?: string; dependsOn?: string; comment?: string },
  ) => string | null;
  toggleTaskSubtask: (taskId: string, subtaskId: string) => string | null;
  addTaskComment: (taskId: string, text: string) => string | null;
  /** Automatic mode: append system activity entries (e.g. reminders sent). */
  recordTaskAutoEvents: (events: { taskId: string; action: string; detail?: string }[]) => void;
  addReimbursement: (input: Omit<Reimbursement, "id" | "employeeId" | "status">) => string | null;
  setReimbursementStatus: (id: string, status: Reimbursement["status"], note?: string) => string | null;
  /** Payroll/HR verify or reject a tax-saving proof; the employee may withdraw while it is submitted. */
  setInvestmentProofStatus: (id: string, status: InvestmentProof["status"], note?: string) => string | null;
  addInvestmentProof: (input: Omit<InvestmentProof, "id" | "employeeId" | "status" | "submittedOn">) => string | null;
  continueProgram: (id: string) => string | null;
  completeProgram: (id: string) => string | null;
  setApproval: (id: string, status: Approval["status"]) => void;
  sendMessage: (threadId: string, text: string) => string | null;
  addAssetRequest: (item: string, reason: string) => string | null;
  setAssetStatus: (id: string, status: RequestStatus, note?: string) => string | null;
  addCash: (input: { amount: number; category: string; purpose: string; requiredBy: string }) => string | null;
  setCashStatus: (id: string, status: RequestStatus, note?: string) => string | null;
  addSoftware: (software: string, justification: string) => string | null;
  setSoftwareStatus: (id: string, status: RequestStatus, note?: string) => string | null;
  addCab: (booking: Omit<CabBooking, "id" | "employeeId" | "status">) => string | null;
  setCabStatus: (id: string, status: RequestStatus, note?: string) => string | null;
  orderMeal: (menuItemId: string) => string | null;
  cancelMeal: (orderId: string) => string | null;
  addSignature: (documentName: string, dataUrl: string) => string | null;
  addDocument: (input: {
    name: string;
    category: DocumentGroup;
    docType: string;
    expires: string;
    body: string;
  }) => string | null;
  updateDocument: (
    documentId: string,
    input: { name: string; category: DocumentGroup; docType: string; expires: string; body: string },
  ) => string | null;
  setDocumentShared: (documentId: string, shared: boolean) => void;
  colleagueName: (colleagueId: string) => string;
  projectName: (projectId: string) => string;
  menuItem: (menuItemId: string) => PortalState["menu"][number] | undefined;
}

/** Yearly caps for common Indian tax-saving sections (income tax old regime). */
const MAX_MEAL_ORDERS_PER_DAY = 3;

/** Editing a week's time after submitting it takes it back out of the manager's queue. */
function backToDraft(rows: PortalState["orgTimesheets"], weekStart: string, personId: string): PortalState["orgTimesheets"] {
  return rows.map((row) =>
    row.weekStart === weekStart && row.personId === personId && row.status === "submitted"
      ? { ...row, status: "draft" as const }
      : row,
  );
}

const MAX_OTP_ATTEMPTS = 5;

function withoutPhoto<T extends { photo?: string }>(override: T | undefined): Omit<T, "photo"> | null {
  if (!override) return null;
  const { photo: _photo, ...rest } = override;
  return rest;
}

const PortalContext = createContext<PortalApi | null>(null);

// Reporting lines come from the directory, so approvals follow the same chain as the org chart.
setDirectoryChainSource((employeeId) => {
  if (!getPerson(employeeId)) return null;
  return managerChainIds(employeeId).map((id) => ({ id, fullName: getPerson(id)?.fullName ?? findDemoById(id)?.fullName ?? id }));
});

// Admin role-editor changes take effect on menus and page access.
setNavOverrideSource((accountId) => getNavOverrides(accountId));

// Holidays follow each person's country; optional holidays they picked count as days off too.
setHolidayContext(
  (employeeId) => findDemoById(employeeId)?.countryCode ?? (employeeId.startsWith("emp-") ? "IN" : undefined),
  (employeeId) =>
    getOptionalHolidayState()
      .picks.filter((pick) => pick.employeeId === employeeId && pick.status === "picked")
      .map((pick) => getOptionalHolidayState().holidays.find((h) => h.id === pick.holidayId))
      .filter((h): h is NonNullable<typeof h> => Boolean(h))
      .map((h) => ({ id: h.id, date: h.date, name: `${h.name} (optional)` })),
);
// Comp-off days granted for working weekends or holidays add to the comp-off balance.
// Latest leave requests, so comp-off credits used before they expired stay counted.
let latestLeaveRequests: LeaveRequest[] = [];
function compOffDaysTaken(employeeId: string): string[] {
  return latestLeaveRequests
    .filter((r) => r.employeeId === employeeId && r.code === "comp_off" && (r.status === "approved" || r.status === "pending"))
    .flatMap((r) => {
      const days: string[] = [];
      for (let d = r.from; d <= r.to; d = addDaysISO(d, 1)) days.push(d);
      return days;
    });
}
setEarnedLeaveSource((employeeId, code, year) =>
  code === "comp_off" ? compOffCreditsFor(employeeId, year, compOffDaysTaken(employeeId)) : 0,
);

export function PortalProvider({ children }: { children: ReactNode }) {
  const shiftState = useSyncExternalStore(subscribeShifts, getShiftState);
  const optionalHolidayState = useSyncExternalStore(subscribeOptionalHolidays, getOptionalHolidayState);
  const exitState = useSyncExternalStore(subscribeExits, getExitState);
  const [state, setState] = useState<PortalState>(() => {
    ensureDemoLastLogin();
    return loadState();
  });
  latestLeaveRequests = state.leaveRequests;
  const [signedIn, setSignedIn] = useState(readSession);
  const [userId, setUserId] = useState(() => {
    const saved = localStorage.getItem(USER_KEY);
    // A session saved for a retired account is signed out (readSession) and falls back to the default persona.
    if (saved && RETIRED_SIGN_IN_IDS.has(saved)) {
      localStorage.removeItem(USER_KEY);
      return EMPLOYEE.id;
    }
    return saved ?? EMPLOYEE.id;
  });
  // A forced password change survives a page refresh until the password is actually changed.
  const [loginNotice, setLoginNotice] = useState<LoginNotice | null>(() => {
    const account = findDemoById(localStorage.getItem(USER_KEY) ?? EMPLOYEE.id);
    if (!readSession() || !account || localStorage.getItem(userKey(MUST_CHANGE_KEY, account.employeeCode)) !== "1") return null;
    return { previousIso: null, timeZone: account.timeZone, requirePasswordChange: true };
  });
  const [profileOtp, setProfileOtp] = useState<{ code: string; expiresAt: number; attempts: number } | null>(null);
  const [resetOtp, setResetOtp] = useState<{ code: string; expiresAt: number; employeeCode: string; attempts: number } | null>(null);
  const [passwordRevision, setPasswordRevision] = useState(0);

  // Audit trail: every change to a business record is written down with who made it and what changed.
  const auditedState = useRef(state);
  useEffect(() => {
    const previous = auditedState.current;
    auditedState.current = state;
    if (previous === state) return;
    const actor = findDemoById(userId);
    appendAuditEntries(
      diffForAudit(previous as unknown as Record<string, unknown>, state as unknown as Record<string, unknown>, {
        id: userId,
        name: actor?.fullName ?? userId,
      }),
    );
  }, [state, userId]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (error) {
      // Storage full (e.g. many large signatures): keep working in memory rather than crash the app.
      console.error("Could not save portal data to browser storage", error);
    }
  }, [state]);

  // Idle sign-out: 30 minutes without any activity ends the session (also checked when the page reopens).
  useEffect(() => {
    if (!signedIn) return;
    const IDLE_MS = 30 * 60 * 1000;
    const stamp = () => {
      try {
        localStorage.setItem(LAST_ACTIVE_KEY, String(Date.now()));
      } catch {
        /* storage blocked */
      }
    };
    const expired = () => Date.now() - Number(localStorage.getItem(LAST_ACTIVE_KEY) ?? Date.now()) > IDLE_MS;
    const endSession = () => {
      localStorage.setItem(SESSION_KEY, "out");
      sessionStorage.removeItem(SESSION_KEY);
      setSignedIn(false);
      setLoginNotice(null);
    };
    if (expired()) {
      endSession();
      return;
    }
    stamp();
    let last = 0;
    const onActivity = () => {
      if (Date.now() - last < 15000) return;
      last = Date.now();
      stamp();
    };
    const events = ["pointerdown", "keydown", "scroll", "pointermove"] as const;
    events.forEach((name) => window.addEventListener(name, onActivity, { passive: true }));
    const timer = window.setInterval(() => {
      // Someone who has left the company is signed out too.
      if (expired() || !isAccountActive(userId)) endSession();
    }, 60000);
    return () => {
      events.forEach((name) => window.removeEventListener(name, onActivity));
      window.clearInterval(timer);
    };
  }, [signedIn, userId]);

  useEffect(() => {
    const active = findAccountById(userId) ?? EMPLOYEE;
    ensureDemoPasswordChangedAt(active.employeeCode);
    setPasswordRevision((value) => value + 1);
  }, [userId]);

  const api = useMemo<PortalApi>(() => {
    const activeDemo = findDemoById(userId) ?? findDemoByCode((findAccountById(userId) ?? EMPLOYEE).employeeCode) ?? TIMEZ_DEMOS[0]!;
    const active = activeDemo;
    ensureDemoPasswordChangedAt(active.employeeCode);
    const mine = <T extends { employeeId: string }>(items: T[]) => items.filter((item) => item.employeeId === active.id);
    const activeOffs = scheduleForEmployee({
      shiftName: active.shiftName,
      shiftHours: active.shiftHours,
      countryCode: active.countryCode,
    }).weeklyOffDays;
    const offsFor = (employeeId: string) => {
      const person = TIMEZ_DEMOS.find((a) => a.id === employeeId) ?? active;
      return scheduleForEmployee({
        shiftName: person.shiftName,
        shiftHours: person.shiftHours,
        countryCode: person.countryCode,
      }).weeklyOffDays;
    };
    const leaveTable = leaveRows(
      state.leavePolicies,
      state.leaveRequests,
      state.encashments,
      state.holidays,
      active.id,
      activeOffs,
      Number(todayISO().slice(0, 4)),
    );
    const currentProjects = mine(state.projects).filter((project) => project.status === "current");
    const previousProjects = mine(state.projects).filter((project) => project.status === "previous");

    function colleagueName(colleagueId: string) {
      return state.colleagues.find((person) => person.id === colleagueId)?.name ?? "Employee";
    }

    function projectName(projectId: string) {
      return state.projects.find((project) => project.id === projectId)?.name ?? "Project";
    }

    /** Saves the signed-in person's own contact details. Job title and shift are HR-owned and ignored here. */
    function saveOwnProfile(input: { fullName: string; mobile: string; email: string; address: string; photo?: string }): string | null {
      // Legal name and work email are HR-owned: the employee's own edits never change them.
      const current = { ...active, ...withoutPhoto(state.profiles?.[active.id]) };
      const fullName = current.fullName;
      const email = current.email;
      const mobile = input.mobile.trim();
      if (!/^\+?[\d\s]{8,18}$/.test(mobile) || mobile.replace(/\D/g, "").length < 8 || mobile.replace(/\D/g, "").length > 15) {
        return "Enter a valid mobile number (8–15 digits).";
      }
      setState((prev) => ({
        ...prev,
        profiles: {
          ...prev.profiles,
          [active.id]: {
            fullName,
            mobile,
            email,
            address: input.address.trim(),
            photo: input.photo ?? prev.profiles?.[active.id]?.photo,
          },
        },
      }));
      return null;
    }

    /**
     * Approvals follow the reporting line: only someone above the person decides their requests — or a colleague
     * they delegated to (§25) while the delegation is active and covers this request type. Never one's own request.
     * `scope` "any" (internal decision checks) accepts any active delegation; "none" ignores delegation.
     */
    function canDecideFor(employeeId: string, scope: DelegationScope | "any" | "none" = "any"): boolean {
      if (employeeId === active.id) return false;
      // Personas follow their own reporting line; everyone else follows the directory's manager chain.
      if (
        managementChain(employeeId, TIMEZ_DEMOS).some((manager) => manager.id === active.id) ||
        managerChainIds(employeeId).includes(active.id)
      ) {
        return true;
      }
      if (scope === "none") return false;
      noteLeaves(state.leaveRequests);
      return delegatedAuthority(active.id, employeeId, scope) !== null;
    }

    /** People at the top of the organisation have no one to approve their requests. */
    const activeHasApprover = managementChain(active.id, TIMEZ_DEMOS).length > 0;

    /** Requests from someone with no one above them are approved as soon as they're raised. */
    function withAutoApproval<T extends { status: string }>(item: T, approvedStatus: T["status"]): T {
      if (activeHasApprover) return item;
      return {
        ...item,
        status: approvedStatus,
        decidedById: active.id,
        decidedByName: active.fullName,
        decidedOn: todayISO(),
        decisionNote: "Approved automatically — no one above you in the reporting line",
      };
    }

    function canApproveFor(employeeId: string): boolean {
      if (employeeId === active.id) return false;
      if (["hr", "hr_admin", "hrbp"].includes(active.role)) return true;
      return managementChain(employeeId, TIMEZ_DEMOS).some((manager) => manager.id === active.id);
    }

    const canVerifyProofs = ["hr", "hr_admin", "hrbp", "finance"].includes(active.role);

    /**
     * One rule for every request type: approvers (above the person in their reporting line) move an open request to
     * approved/rejected; the requester may withdraw it while it is still open. Nobody decides their own.
     */
    function decisionError(
      employeeId: string,
      current: string,
      next: string,
      openStatuses: string[] = ["pending", "submitted"],
    ): string | null {
      const isOwn = employeeId === active.id;
      if (next === "withdrawn") {
        if (!isOwn) return "Only the person who raised this request can withdraw it.";
        if (!openStatuses.includes(current)) return "Only open requests can be withdrawn.";
        return null;
      }
      if (next === "approved" || next === "rejected" || next === "verified") {
        if (isOwn) return "You cannot decide your own request.";
        if (!canDecideFor(employeeId)) return "Only someone above this person in their reporting line can decide this.";
        if (!openStatuses.includes(current)) return "This request has already been decided.";
        return null;
      }
      return "That status change isn't allowed.";
    }

    function decision(status: string, note?: string): DecisionInfo {
      // Withdrawing clears any earlier decision so it never reads "Withdrawn · by <approver>".
      if (status === "withdrawn") return { decidedById: undefined, decidedByName: undefined, decidedOn: undefined, decisionNote: undefined };
      return { decidedById: active.id, decidedByName: active.fullName, decidedOn: todayISO(), decisionNote: note?.trim() || undefined };
    }

    function activateSession(account: DemoAccount, options?: { silent?: boolean; remember?: boolean }) {
      // A fresh sign-in starts the idle clock again (an old stamp from an earlier visit must not sign them out).
      localStorage.setItem(LAST_ACTIVE_KEY, String(Date.now()));
      const lastLoginKey = userKey(LAST_LOGIN_KEY, account.employeeCode);
      // Older versions kept one device-wide stamp; fall back to it once.
      const previousIso = localStorage.getItem(lastLoginKey) ?? localStorage.getItem(LAST_LOGIN_KEY);
      const requirePasswordChange =
        localStorage.getItem(userKey(MUST_CHANGE_KEY, account.employeeCode)) === "1" ||
        (previousIso ? daysSinceLogin(previousIso) > PASSWORD_STALE_DAYS : false);
      if (requirePasswordChange) localStorage.setItem(userKey(MUST_CHANGE_KEY, account.employeeCode), "1");
      localStorage.setItem(lastLoginKey, new Date().toISOString());
      if (options?.remember ?? localStorage.getItem(SESSION_KEY) === "in") {
        localStorage.setItem(SESSION_KEY, "in");
        sessionStorage.removeItem(SESSION_KEY);
      } else {
        sessionStorage.setItem(SESSION_KEY, "in");
        localStorage.removeItem(SESSION_KEY);
      }
      localStorage.setItem(USER_KEY, account.id);
      setUserId(account.id);
      if (!options?.silent || requirePasswordChange) {
        setLoginNotice({ previousIso, timeZone: account.timeZone, requirePasswordChange });
      }
      setSignedIn(true);
    }

    return {
      employee: {
        ...active,
        ...withoutPhoto(state.profiles?.[active.id]),
        photo: state.profiles?.[active.id]?.photo || active.photo,
      },
      demoProfile: active,
      isManager: canApproveTeam(active.role),
      demoAccounts: TIMEZ_DEMOS,
      signedIn,
      rememberedEmail: localStorage.getItem(REMEMBER_KEY),
      clearRememberedEmail: () => localStorage.removeItem(REMEMBER_KEY),
      loginNotice,
      dismissLoginNotice: () => {
        setLoginNotice((notice) => (notice?.requirePasswordChange ? notice : null));
      },
      changePasswordAfterStaleLogin: (newPassword, confirm) => {
        const next = newPassword.trim();
        if (next.length < 6) return "Use at least 6 characters.";
        if (next !== confirm.trim()) return "Confirmation does not match.";
        if (next === storedPassword(active.employeeCode)) return "Choose a password different from your current one.";
        savePassword(active.employeeCode, next);
        setPasswordRevision((value) => value + 1);
        setLoginNotice(null);
        return null;
      },
      passwordPolicy: passwordPolicyFromChangedAt(passwordChangedAtIso(active.employeeCode)),
      changePassword: (currentPassword, newPassword, confirm) => {
        if (currentPassword !== storedPassword(active.employeeCode)) return "Current password is not correct.";
        const next = newPassword.trim();
        if (next.length < 6) return "Use at least 6 characters.";
        if (next !== confirm.trim()) return "Confirmation does not match.";
        if (next === storedPassword(active.employeeCode)) return "Choose a password different from your current one.";
        savePassword(active.employeeCode, next);
        setPasswordRevision((value) => value + 1);
        return null;
      },
      requestPasswordResetOtp: (employeeCode, channel) => {
        const account = findDemoByEmailOrCode(employeeCode) ?? findAccountByCode(employeeCode);
        if (!account) return { error: "That work email or employee ID was not found." };
        const profile = { ...account, ...withoutPhoto(state.profiles?.[account.id]) };
        const sentTo = channel === "email" ? profile.email.trim() : profile.mobile.trim();
        if (!sentTo) {
          return { error: channel === "email" ? "No email is registered on this account." : "No mobile is registered on this account." };
        }
        const code = String(100000 + Math.floor(Math.random() * 900000));
        setResetOtp({ code, expiresAt: Date.now() + 5 * 60 * 1000, employeeCode: account.employeeCode, attempts: 0 });
        return { code, sentTo, channel };
      },
      resetPasswordWithOtp: (employeeCode, otp, newPassword, confirm) => {
        const account = findDemoByEmailOrCode(employeeCode) ?? findAccountByCode(employeeCode);
        if (!account) return "That work email or employee ID was not found.";
        if (!resetOtp || resetOtp.employeeCode.toUpperCase() !== account.employeeCode.toUpperCase()) {
          return "Send a verification code first.";
        }
        if (Date.now() > resetOtp.expiresAt) {
          setResetOtp(null);
          return "That code has expired. Send a new one.";
        }
        if (otp.trim() !== resetOtp.code) {
          const attempts = resetOtp.attempts + 1;
          if (attempts >= MAX_OTP_ATTEMPTS) {
            setResetOtp(null);
            return "Too many wrong codes. Send a new code and try again.";
          }
          setResetOtp({ ...resetOtp, attempts });
          return `That verification code is not correct. ${MAX_OTP_ATTEMPTS - attempts} tries left.`;
        }
        const next = newPassword.trim();
        if (next.length < 6) return "Use at least 6 characters.";
        if (next !== confirm.trim()) return "Confirmation does not match.";
        if (next === storedPassword(account.employeeCode)) return "Choose a password different from your current one.";
        savePassword(account.employeeCode, next);
        localStorage.removeItem(userKey(LOCK_KEY, account.employeeCode));
        setPasswordRevision((value) => value + 1);
        setResetOtp(null);
        return null;
      },
      state,
      leaveTable,
      counts: actionCounts(state, active.id),
      // Payslips run from joining (last 12 months) to the last completed month; a leaver's final
      // month is pro-rated and settles unused privilege leave. Tax follows the country's rules, the
      // India regime choice and verified declarations; hourly staff are paid approved timesheet hours.
      // A getter so a regime change shows on the next read (cached per state + inputs).
      get payslipViews() {
        const exit = getExitState().cases.find(
          (c) => c.employeeId === active.id && (c.status === "Accepted" || c.status === "Completed"),
        );
        const person = getPerson(active.id);
        const regime = getTaxRegime(active.id);
        const unusedLeaveDays = Math.max(0, leaveTable.find((row) => row.code === "pto")?.balance ?? 0);
        const today = todayISO();
        return cachedPayslips(state, [active.id, regime, exit?.lastWorkingDay ?? "", unusedLeaveDays, today].join("|"), () =>
          generatePayslips({
            employeeId: active.id,
            role: active.role,
            countryCode: active.countryCode,
            joiningDate: person?.dateOfJoining,
            lastWorkingDay: exit?.lastWorkingDay,
            unusedLeaveDays,
            today,
            location: active.location ?? person?.location,
            nationality: person?.nationality,
            employmentStatus: person?.employmentStatus,
            regime,
            investmentProofs: state.investmentProofs,
            timesheets: state.timesheets,
            orgTimesheets: state.orgTimesheets,
          }).map((slip) => ({ ...slip, ...toPayslipView(slip) })),
        );
      },
      currentProjects,
      previousProjects,
      hoursFor: (projectId: string) => projectHours(mine(state.timesheets), projectId),
      colleagueName,
      projectName,
      menuItem: (menuItemId: string) => state.menu.find((item) => item.id === menuItemId),
      signIn: async (emailOrCode, password, remember = false) => {
        const account = findDemoByEmailOrCode(emailOrCode);
        if (!account) return "That email/ID and password don't match.";
        if (!password.trim()) return "Enter your password.";
        // People who have left can't sign in.
        if (!isAccountActive(account.id)) return "This account is no longer active. Contact HR.";
        const lock = readLock(account.employeeCode);
        if (lock.until > Date.now()) {
          const minutes = Math.ceil((lock.until - Date.now()) / 60000);
          return `Too many wrong passwords. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}, or reset your password.`;
        }
        if (password !== storedPassword(account.employeeCode)) {
          const fails = (lock.until > 0 ? 0 : lock.fails) + 1;
          const locked = fails >= MAX_LOGIN_ATTEMPTS;
          localStorage.setItem(
            userKey(LOCK_KEY, account.employeeCode),
            JSON.stringify({ fails: locked ? 0 : fails, until: locked ? Date.now() + LOCK_MINUTES * 60000 : 0 }),
          );
          return locked
            ? `Too many wrong passwords. Sign-in is locked for ${LOCK_MINUTES} minutes.`
            : `That email/ID and password don't match. ${MAX_LOGIN_ATTEMPTS - fails} tries left.`;
        }
        localStorage.removeItem(userKey(LOCK_KEY, account.employeeCode));
        if (remember) localStorage.setItem(REMEMBER_KEY, account.email);
        else localStorage.removeItem(REMEMBER_KEY);
        activateSession(account, { remember });
        return null;
      },
      switchDemoPersona: (accountId) => {
        const account = findDemoById(accountId);
        if (!account) return "That account was not found.";
        activateSession(account, { silent: true });
        return null;
      },
      signOut: () => {
        localStorage.setItem(SESSION_KEY, "out");
        sessionStorage.removeItem(SESSION_KEY);
        setSignedIn(false);
        setLoginNotice(null);
      },
      updateProfile: (input) => saveOwnProfile(input),
      requestProfileOtp: () => {
        const code = String(100000 + Math.floor(Math.random() * 900000));
        setProfileOtp({ code, expiresAt: Date.now() + 5 * 60 * 1000, attempts: 0 });
        return code;
      },
      updateProfileWithOtp: (input, otp) => {
        if (!profileOtp) return "Send a verification code first.";
        if (Date.now() > profileOtp.expiresAt) {
          setProfileOtp(null);
          return "That code has expired. Send a new one.";
        }
        if (otp.trim() !== profileOtp.code) {
          const attempts = profileOtp.attempts + 1;
          if (attempts >= MAX_OTP_ATTEMPTS) {
            setProfileOtp(null);
            return "Too many wrong codes. Send a new code and try again.";
          }
          setProfileOtp({ ...profileOtp, attempts });
          return `That verification code is not correct. ${MAX_OTP_ATTEMPTS - attempts} tries left.`;
        }
        const error = saveOwnProfile(input);
        if (!error) setProfileOtp(null);
        return error;
      },
      resetDemo: () => setState(createSeed()),
      applyLeave: async (input) => {
        const error = validateLeave(state, active.id, input, activeOffs, todayISO(), { needsApprover: activeHasApprover });
        if (error) return error;
        const { half, ...rest } = input;
        const request: LeaveRequest = {
          id: uid("lv"),
          employeeId: active.id,
          ...rest,
          ...(half && input.from === input.to ? { half } : {}),
          reason: input.reason.trim(),
          status: "pending",
          appliedOn: todayISO(),
        };
        // A backdated application uses up the permission that allowed it.
        const permission = activeHasApprover && needsBackdatedPermission(input.code, input.from)
          ? backdatedPermissionFor(state, active.id, input.from, input.to, input.code)
          : undefined;
        setState((prev) => ({
          ...prev,
          leaveRequests: [withAutoApproval(request, "approved"), ...prev.leaveRequests],
          backdatedPermissions: permission
            ? patchById(prev.backdatedPermissions, permission.id, { status: "used" as const })
            : prev.backdatedPermissions,
        }));
        if (activeHasApprover) {
          // The direct manager in the reporting line decides; tell them once, after the request is saved.
          const approverId = managementChain(active.id, TIMEZ_DEMOS)[0]?.id ?? managerChainIds(active.id)[0];
          if (approverId) {
            const leaveName = state.leavePolicies.find((p) => p.code === request.code)?.name ?? "Leave";
            const dates = request.from === request.to ? formatLongDate(request.from) : `${formatLongDate(request.from)} – ${formatLongDate(request.to)}`;
            pushPersonTaskAlert({
              recipientId: approverId,
              title: "Leave request",
              body: `${active.fullName} applied for ${leaveName} · ${dates}.`,
              href: "/leave",
            });
          }
        }
        return null;
      },
      requestBackdatedPermission: (input) => {
        const today = todayISO();
        if (!input.from || !input.to) return "Choose the from and to dates.";
        if (input.to < input.from) return "The end date is before the start date.";
        if (!needsBackdatedPermission(input.code, input.from, today)) {
          return "These dates don't need permission — apply for leave directly.";
        }
        if (input.from < `${today.slice(0, 4)}-01-01`) return "Permission can only be requested for dates in this leave year.";
        if (input.to >= today) return "The whole range must be in the past. Apply separately for today and future dates.";
        if (!input.reason.trim()) return "Explain why the leave is being applied late.";
        if (workingDays(input.from, input.to, holidaySet(holidaysForPerson(state.holidays, active.id)), activeOffs) <= 0) {
          return "That range has no working days (weekly offs and holidays are skipped).";
        }
        const overlapsLeave = state.leaveRequests.some(
          (r) =>
            r.employeeId === active.id &&
            r.status !== "rejected" &&
            r.status !== "withdrawn" &&
            r.from <= input.to &&
            input.from <= r.to,
        );
        if (overlapsLeave) return "Those dates overlap an existing leave request.";
        if (!activeHasApprover) return "You don't need permission — there's no one above you. Apply for the leave directly.";
        const clash = state.backdatedPermissions.some(
          (p) =>
            p.employeeId === active.id &&
            (p.status === "pending" || p.status === "approved") &&
            p.from <= input.to &&
            input.from <= p.to,
        );
        if (clash) return "You already have a permission request for these dates.";
        const permission: BackdatedLeavePermission = {
          id: uid("bdp"),
          employeeId: active.id,
          employeeName: active.fullName,
          code: input.code,
          from: input.from,
          to: input.to,
          reason: input.reason.trim(),
          status: "pending",
          requestedOn: today,
        };
        setState((prev) => ({ ...prev, backdatedPermissions: [permission, ...prev.backdatedPermissions] }));
        return null;
      },
      withdrawBackdatedPermission: (permissionId) => {
        const permission = state.backdatedPermissions.find((p) => p.id === permissionId);
        if (!permission || permission.employeeId !== active.id) return "Permission request not found.";
        if (permission.status !== "pending") return "Only pending requests can be withdrawn.";
        setState((prev) => ({
          ...prev,
          backdatedPermissions: patchById(prev.backdatedPermissions, permissionId, { status: "withdrawn" as const }),
        }));
        return null;
      },
      decideBackdatedPermission: (permissionId, decision, note) => {
        const permission = state.backdatedPermissions.find((p) => p.id === permissionId);
        if (!permission) return "Permission request not found.";
        if (permission.employeeId === active.id) return "You cannot approve your own request.";
        if (!canDecideFor(permission.employeeId)) return "Only someone above this person in their reporting line can decide this.";
        if (permission.status !== "pending") return "This request has already been decided.";
        setState((prev) => ({
          ...prev,
          backdatedPermissions: patchById(prev.backdatedPermissions, permissionId, {
            status: decision,
            decidedById: active.id,
            decidedByName: active.fullName,
            decidedOn: todayISO(),
            decisionNote: note?.trim() || undefined,
          }),
        }));
        return null;
      },
      canApproveLeaveFor: (employeeId) => canApproveFor(employeeId),
      canDecideFor: (employeeId, scope) => canDecideFor(employeeId, scope ?? "none"),
      hasApprover: activeHasApprover,
      canVerifyProofs,
      setLeaveStatus: async (leaveId, status, note) => {
        const request = state.leaveRequests.find((item) => item.id === leaveId);
        if (!request) return "Leave request not found.";
        // Approved leave that hasn't started yet can still be cancelled by the employee.
        const cancellingUpcoming =
          status === "withdrawn" && request.employeeId === active.id && request.status === "approved" && request.from > todayISO();
        const error = cancellingUpcoming ? null : decisionError(request.employeeId, request.status, status, ["pending"]);
        if (error) return error;
        if (status === "approved") {
          // Count days with the requester's own weekly offs, not the approver's.
          const ownerOffs = offsFor(request.employeeId);
          // Leave this request out of "pending" so its own days aren't counted twice.
          const ownerRows = leaveRows(
            state.leavePolicies,
            state.leaveRequests.filter((item) => item.id !== leaveId),
            state.encashments,
            state.holidays,
            request.employeeId,
            ownerOffs,
            Number(request.from.slice(0, 4)),
          );
          const row = ownerRows.find((item) => item.code === request.code);
          const days = workingDays(
            request.from,
            request.to,
            holidaySet(holidaysForPerson(state.holidays, request.employeeId)),
            ownerOffs,
            request.half,
          );
          if (!row || days > row.available) return "Approving this would go past that employee's quota.";
          // Hours logged while the request was waiting would clash with the leave days.
          if (request.code !== "wfh" && request.code !== "emergency_wfh") {
            // A half day still leaves room for up to 4.5 hours of work that day.
            const allowed = request.half ? 4.5 : 0;
            const byDate = new Map<string, number>();
            for (const sheet of state.timesheets) {
              if (sheet.employeeId !== request.employeeId) continue;
              for (const [date, hours] of Object.entries(sheet.hours)) byDate.set(date, (byDate.get(date) ?? 0) + hours);
            }
            const worked = [...byDate].find(([date, hours]) => hours > allowed && request.from <= date && date <= request.to);
            if (worked) {
              return request.half
                ? `They logged ${worked[1]} hours on ${formatLongDate(worked[0])} — a half day allows at most ${allowed}.`
                : `They logged work on ${formatLongDate(worked[0])}. Ask them to remove those hours first.`;
            }
          }
        }
        setState((prev) => ({
          ...prev,
          leaveRequests: patchById(prev.leaveRequests, leaveId, { status, ...decision(status, note) }),
        }));
        if ((status === "approved" || status === "rejected") && request.employeeId !== active.id) {
          const dates = request.from === request.to ? formatLongDate(request.from) : `${formatLongDate(request.from)} – ${formatLongDate(request.to)}`;
          pushPersonTaskAlert({
            recipientId: request.employeeId,
            title: status === "approved" ? "Leave approved" : "Leave rejected",
            body: `${active.fullName} ${status} your leave · ${dates}.${note?.trim() ? ` Note: ${note.trim()}` : ""}`,
            href: "/leave",
          });
        }
        return null;
      },
      applyEncashment: (code, days) => {
        const error = validateEncashment(state, active.id, code, days, activeOffs);
        if (error) return error;
        const item: Encashment = {
          id: uid("enc"),
          employeeId: active.id,
          code,
          days,
          status: "pending",
          appliedOn: todayISO(),
        };
        setState((prev) => ({ ...prev, encashments: [item, ...prev.encashments] }));
        return null;
      },
      setEncashmentStatus: (encashmentId, status, note) => {
        const item = state.encashments.find((entry) => entry.id === encashmentId);
        if (!item) return "Encashment request not found.";
        // Encashment is a payout: someone with no one above them (the CEO) is decided by HR instead — never by themselves.
        const compensationDecides =
          managementChain(item.employeeId, TIMEZ_DEMOS).length === 0 &&
          (active.role === "hr" || active.role === "hr_admin") &&
          item.employeeId !== active.id &&
          (status === "approved" || status === "rejected");
        const error = compensationDecides
          ? item.status === "pending"
            ? null
            : "This request has already been decided."
          : decisionError(item.employeeId, item.status, status, ["pending"]);
        if (error) return error;
        if (status === "approved") {
          const ownerRows = leaveRows(
            state.leavePolicies,
            state.leaveRequests,
            state.encashments.filter((entry) => entry.id !== encashmentId),
            state.holidays,
            item.employeeId,
            offsFor(item.employeeId),
            Number(item.appliedOn.slice(0, 4)),
          );
          const row = ownerRows.find((entry) => entry.code === item.code);
          if (!row || item.days > row.available) return "Approving this would go past that employee's quota.";
        }
        setState((prev) => ({
          ...prev,
          encashments: patchById(prev.encashments, encashmentId, { status, ...decision(status, note) }),
        }));
        return null;
      },
      saveTimesheet: (projectId, weekStart, hours, status) => {
        const project = state.projects.find((item) => item.id === projectId && item.employeeId === active.id);
        if (!project) return "Choose a project.";
        const cleaned: Record<string, number> = {};
        for (const [date, value] of Object.entries(hours)) {
          if (value > 0) cleaned[date] = value;
        }
        const error = validateTimesheet(state, active.id, project, cleaned);
        if (error) return error;
        setState((prev) => {
          const existing = prev.timesheets.find(
            (sheet) => sheet.employeeId === active.id && sheet.projectId === projectId && sheet.weekStart === weekStart,
          );
          if (existing?.status === "approved") return prev;
          const entries =
            existing?.entries ??
            Object.entries(cleaned).map(([date, value], index) => ({
              id: uid(`te${index}`),
              date,
              startHour: 9.5,
              hours: value,
              note: project.name,
              billable: true,
            }));
          const next: PortalState["timesheets"][number] = existing
            ? { ...existing, hours: cleaned, status, entries: existing.entries ?? entries }
            : { id: uid("ts"), employeeId: active.id, projectId, weekStart, hours: cleaned, entries, status };
          const timesheets = existing ? prev.timesheets.map((sheet) => (sheet.id === existing.id ? next : sheet)) : [next, ...prev.timesheets];
          return { ...prev, timesheets };
        });
        return null;
      },
      addTimeEntry: (projectId, weekStart, input) => {
        const project = state.projects.find((item) => item.id === projectId && item.employeeId === active.id);
        if (!project) return "Choose a project.";
        if (!input.date) return "Choose a date.";
        if (!input.note.trim()) return "Enter a short note for the block.";
        if (!Number.isFinite(input.hours) || input.hours <= 0) return "Enter hours greater than zero.";
        if (input.startHour < 0 || input.startHour >= 24) return "Enter a valid start time.";
        if (input.startHour + input.hours > 24) return "A block can't run past midnight.";
        if (input.date < weekStart || input.date > addDaysISO(weekStart, 6)) return "That date isn't in this week.";
        // Ticket/task time only against open work assigned to you (tasks must be accepted).
        if (input.workType === "ticket") {
          const ticket = getTickets().find((t) => t.id === input.workId);
          if (!ticket || ticket.assigneeId !== active.id) return "Pick a ticket assigned to you.";
          if (!isOpenTicket(ticket)) return "That ticket is already resolved.";
        } else if (input.workType === "task") {
          const task = state.tasks.find((t) => t.id === input.workId);
          if (!task || task.employeeId !== active.id) return "Pick a task assigned to you.";
          if (!task.accepted) return "Accept the task before logging time.";
          if (task.status === "done" || task.status === "scheduled") return "That task isn't open.";
        }
        const overlapping = state.timesheets
          .filter((sheet) => sheet.employeeId === active.id)
          .flatMap((sheet) => sheet.entries ?? [])
          .some(
            (entry) =>
              entry.date === input.date &&
              input.startHour < entry.startHour + entry.hours &&
              entry.startHour < input.startHour + input.hours,
          );
        if (overlapping) return "That block overlaps time you've already logged.";
        const existing = state.timesheets.find(
          (sheet) => sheet.employeeId === active.id && sheet.projectId === projectId && sheet.weekStart === weekStart,
        );
        if (existing?.status === "approved") return "This week is already approved.";
        const entry: TimeEntry = { ...input, id: uid("te"), note: input.note.trim() };
        const entries = [...(existing?.entries ?? []), entry];
        const hours = hoursFromEntries(entries);
        const error = validateTimesheet(state, active.id, project, hours);
        if (error) return error;
        setState((prev) => {
          const current = prev.timesheets.find(
            (sheet) => sheet.employeeId === active.id && sheet.projectId === projectId && sheet.weekStart === weekStart,
          );
          const next = current
            ? {
                ...current,
                entries,
                hours,
                status: "draft" as TimesheetStatus,
              }
            : {
                id: uid("ts"),
                employeeId: active.id,
                projectId,
                weekStart,
                hours,
                entries,
                status: "draft" as TimesheetStatus,
              };
          const timesheets = current
            ? prev.timesheets.map((sheet) => (sheet.id === current.id ? next : sheet))
            : [next, ...prev.timesheets];
          return { ...prev, timesheets, orgTimesheets: backToDraft(prev.orgTimesheets, weekStart, active.id) };
        });
        return null;
      },
      removeTimeEntry: (projectId, weekStart, entryId) => {
        const existing = state.timesheets.find(
          (sheet) => sheet.employeeId === active.id && sheet.projectId === projectId && sheet.weekStart === weekStart,
        );
        if (!existing) return "Entry not found.";
        if (existing.status === "approved") return "This week is already approved.";
        setState((prev) => ({
          ...prev,
          timesheets: prev.timesheets.map((sheet) => {
            if (sheet.id !== existing.id) return sheet;
            const entries = sheet.entries.filter((entry) => entry.id !== entryId);
            return { ...sheet, entries, hours: hoursFromEntries(entries), status: "draft" as TimesheetStatus };
          }),
          orgTimesheets: backToDraft(prev.orgTimesheets, weekStart, active.id),
        }));
        return null;
      },
      submitWeekTimesheets: (weekStart) => {
        const mine = state.timesheets.filter((sheet) => sheet.employeeId === active.id && sheet.weekStart === weekStart);
        if (mine.length === 0) return "Log some time before submitting.";
        if (mine.every((sheet) => sheet.status === "approved")) return "This week is already approved.";
        if (weekStart > todayISO()) return "You can't submit a week that hasn't started yet.";
        const hours = mine.reduce((sum, sheet) => sum + Object.values(sheet.hours).reduce((a, b) => a + b, 0), 0);
        const projectSummary = mine
          .map((sheet) => state.projects.find((p) => p.id === sheet.projectId)?.name)
          .filter(Boolean)
          .join(", ");
        setState((prev) => {
          const hasRow = prev.orgTimesheets.some((row) => row.personId === active.id && row.weekStart === weekStart);
          const orgTimesheets = hasRow
            ? prev.orgTimesheets.map((row) =>
                row.personId === active.id && row.weekStart === weekStart
                  ? { ...row, status: activeHasApprover ? ("submitted" as const) : ("approved" as const), hours }
                  : row,
              )
            : [
                {
                  id: uid("org-ts"),
                  personId: active.id,
                  name: active.fullName,
                  employeeCode: active.employeeCode,
                  department: active.department ?? "",
                  weekStart,
                  hours,
                  status: activeHasApprover ? ("submitted" as const) : ("approved" as const),
                  projectSummary,
                },
                ...prev.orgTimesheets,
              ];
          return {
            ...prev,
            timesheets: prev.timesheets.map((sheet) =>
              sheet.employeeId === active.id && sheet.weekStart === weekStart && sheet.status !== "approved"
                ? { ...sheet, status: activeHasApprover ? "submitted" : "approved" }
                : sheet,
            ),
            orgTimesheets,
          };
        });
        return null;
      },
      setOrgTimesheetStatus: (recordId, status) => {
        const row = state.orgTimesheets.find((item) => item.id === recordId);
        if (!row) return "Timesheet record not found.";
        if (row.personId === active.id) return "You cannot approve your own timesheet.";
        if (!canDecideFor(row.personId)) return "Only someone above this person in their reporting line can decide this.";
        if (row.status === "missing") return "Missing timesheets must be filled by the employee first.";
        if (row.status !== "submitted") return "Only submitted timesheets can be approved or sent back.";
        if (status !== "approved" && status !== "draft") return "That status change isn't allowed.";
        // "draft" = sent back to the employee for changes.
        setState((prev) => ({
          ...prev,
          orgTimesheets: patchById(prev.orgTimesheets, recordId, { status }),
          timesheets: prev.timesheets.map((sheet) =>
            sheet.employeeId === row.personId && sheet.weekStart === row.weekStart && sheet.status === "submitted"
              ? { ...sheet, status: status === "approved" ? "approved" : "draft" }
              : sheet,
          ),
        }));
        return null;
      },
      addExpense: (input) => {
        const error = validateExpense(input, claimLimitsFor(active.countryCode).maxClaim, payRulesFor(active.countryCode).currency);
        if (error) return error;
        if (input.amount > receiptThresholdFor(active.countryCode) && !input.receipt && !/Receipt:/i.test(input.description)) {
          return "Attach the receipt for this amount.";
        }
        if (!currentProjects.some((project) => project.id === input.projectId)) return "Choose one of your current projects.";
        const duplicate = state.expenses.some(
          (item) =>
            item.employeeId === active.id &&
            item.status !== "rejected" &&
            item.status !== "withdrawn" &&
            item.date === input.date &&
            item.category === input.category &&
            item.amount === input.amount,
        );
        if (duplicate) return "You've already claimed this expense (same date, category and amount).";
        const currency = payRulesFor(active.countryCode).currency;
        const steps = resolveWorkflow("expense", active.id, input.amount).map(({ role, label, approverIds }) => ({
          role,
          label,
          approverIds,
        }));
        const base: Expense = {
          id: uid("ex"),
          employeeId: active.id,
          ...input,
          currency,
          description: input.description.trim(),
          status: "submitted",
          submittedOn: todayISO(),
          steps,
          currentStep: 0,
          stepDecisions: [],
        };
        // No step anyone can decide: the claim is approved as soon as it's filed.
        const expense: Expense =
          steps.length === 0
            ? {
                ...base,
                status: "approved",
                decidedById: active.id,
                decidedByName: active.fullName,
                decidedOn: todayISO(),
                decisionNote: "Approved automatically — no approver for this claim",
              }
            : base;
        setState((prev) => ({ ...prev, expenses: [expense, ...prev.expenses] }));
        const amountText = money(input.amount, currency);
        if (steps[0]) {
          for (const recipientId of steps[0].approverIds) {
            pushPersonTaskAlert({
              recipientId,
              title: "Expense claim to review",
              body: `${active.fullName} · ${input.category} · ${amountText} · ${steps[0].label}`,
              href: "/expenses",
            });
          }
        }
        return null;
      },
      setExpenseStatus: (expenseId, status, note) => {
        const expense = state.expenses.find((item) => item.id === expenseId);
        if (!expense) return "Expense not found.";
        const step = currentStepOf(expense);
        // Older claims (no steps) and withdrawals keep the one-step rule.
        if (status === "withdrawn" || !step || !expense.steps) {
          const error = decisionError(expense.employeeId, expense.status, status);
          if (error) return error;
          setState((prev) => ({ ...prev, expenses: patchById(prev.expenses, expenseId, { status, ...decision(status, note) }) }));
          if (status === "approved" || status === "rejected") {
            pushPersonTaskAlert({
              recipientId: expense.employeeId,
              title: status === "approved" ? "Expense claim approved" : "Expense claim declined",
              body: `${expense.category} · ${money(expense.amount, expense.currency)} · by ${active.fullName}`,
              href: "/expenses",
            });
          }
          return null;
        }
        if (status !== "approved" && status !== "rejected") return "That status change isn't allowed.";
        if (expense.employeeId === active.id) return "You cannot decide your own request.";
        if (expense.status !== "submitted") return "This request has already been decided.";
        if (!isWaitingOn(expense, active.id, (id) => canDecideFor(id, "expenses"))) {
          return `This claim is waiting for ${step.label.toLowerCase()}.`;
        }
        const stepIndex = expense.currentStep ?? 0;
        const today = todayISO();
        const entry = {
          step: stepIndex,
          label: step.label,
          decision: status,
          byId: active.id,
          byName: active.fullName,
          on: today,
          note: note?.trim() || undefined,
        } as const;
        const next = status === "approved" ? expense.steps[stepIndex + 1] : undefined;
        const patch: Partial<Expense> = {
          stepDecisions: [...(expense.stepDecisions ?? []), entry],
          ...(next ? { currentStep: stepIndex + 1 } : { status, ...decision(status, note) }),
        };
        setState((prev) => ({ ...prev, expenses: patchById(prev.expenses, expenseId, patch) }));
        const amountText = money(expense.amount, expense.currency);
        if (next) {
          for (const recipientId of next.approverIds) {
            pushPersonTaskAlert({
              recipientId,
              title: "Expense claim to review",
              body: `${expense.category} · ${amountText} · ${next.label}`,
              href: "/expenses",
            });
          }
          pushPersonTaskAlert({
            recipientId: expense.employeeId,
            title: "Expense claim moved on",
            body: `${step.label} done by ${active.fullName}. Now with ${next.label.toLowerCase()}.`,
            href: "/expenses",
          });
        } else {
          pushPersonTaskAlert({
            recipientId: expense.employeeId,
            title: status === "approved" ? "Expense claim approved" : "Expense claim declined",
            body: `${expense.category} · ${amountText} · by ${active.fullName}${note?.trim() ? ` · “${note.trim()}”` : ""}`,
            href: "/expenses",
          });
        }
        return null;
      },
      canDecideExpense: (expense) => isWaitingOn(expense, active.id, (id) => canDecideFor(id, "expenses")),
      canPayExpense: (expense) => expense.status === "approved" && canPayExpenses(active.role, active.id, expense.employeeId),
      markExpensePaid: (expenseId, paidOn, reference) => {
        const expense = state.expenses.find((item) => item.id === expenseId);
        if (!expense) return "Expense not found.";
        if (expense.status !== "approved") return "Only approved claims can be marked paid.";
        if (!canPayExpenses(active.role, active.id, expense.employeeId)) return "Only finance or admin can record payments.";
        if (!paidOn) return "Enter the payment date.";
        if (paidOn > todayISO()) return "Payment date can't be in the future.";
        if (expense.decidedOn && paidOn < expense.decidedOn) return "Payment date can't be before the approval.";
        const ref = reference.trim();
        if (!ref) return "Enter the payment reference.";
        setState((prev) => ({
          ...prev,
          expenses: patchById(prev.expenses, expenseId, {
            status: "paid",
            paidOn,
            paymentRef: ref,
            paidById: active.id,
            paidByName: active.fullName,
          }),
        }));
        pushPersonTaskAlert({
          recipientId: expense.employeeId,
          title: "Expense claim paid",
          body: `${expense.category} · ${money(expense.amount, expense.currency)} · ref ${ref}`,
          href: "/expenses",
        });
        return null;
      },
      acceptTask: (taskId) => {
        const task = state.tasks.find((item) => item.id === taskId);
        if (!task) return "Task not found.";
        const canAct = task.employeeId === active.id || canApproveFor(task.employeeId);
        if (!canAct) return "You can only complete your own tasks.";
        if (task.status === "done") return "This task is already complete.";
        if (task.status === "scheduled") return "This task is not open yet.";
        const now = new Date().toISOString();
        const actor = active.fullName.split(" ")[0] || "User";
        setState((prev) => ({
          ...prev,
          tasks: patchById(prev.tasks, taskId, {
            status: "done",
            progressPct: 100,
            inReview: false,
            blocked: "",
            accepted: true,
            lastActivityAt: now,
            automationNote: "Marked complete",
            hoursSpent: Math.max(task.hoursSpent, task.estimatedHours * 0.8),
            score: Math.min(100, Math.max(task.score, 85)),
            activity: [
              ...(task.activity ?? []),
              { id: uid("tact"), at: now, actor, action: "Completed" },
            ],
          }),
        }));
        return null;
      },
      moveTask: (taskId, status) => {
        const task = state.tasks.find((item) => item.id === taskId);
        if (!task) return;
        const canAct = task.employeeId === active.id || canApproveFor(task.employeeId);
        if (!canAct) return;
        if (task.status === "scheduled" && status !== "open" && !canApproveFor(task.employeeId)) return;
        const now = new Date().toISOString();
        const actor = active.fullName.split(" ")[0] || "User";
        setState((prev) => ({
          ...prev,
          tasks: patchById(prev.tasks, taskId, {
            status,
            lastActivityAt: now,
            automationNote: status === "open" ? "Released from scheduled" : `Status → ${status}`,
            activity: [
              ...(task.activity ?? []),
              {
                id: uid("tact"),
                at: now,
                actor,
                action: status === "open" ? "Released" : `Moved to ${status}`,
              },
            ],
          }),
        }));
      },
      reassignTask: (taskId, personId) => {
        const task = state.tasks.find((item) => item.id === taskId);
        if (!task) return "Task not found.";
        if (!canApproveFor(task.employeeId)) return "Only the owner's manager can reassign this task.";
        if (!canApproveFor(personId)) return "You can only assign tasks to people who report to you.";
        if (task.status === "done") return "Closed tasks cannot be reassigned.";
        const person = taskPersonById(personId);
        if (!person) return "Pick someone from your team.";
        const now = new Date().toISOString();
        const prevPeople = (task.peopleIds ?? []).filter((id) => id !== personId);
        // Keep previous owner as collaborator when ownership moves.
        if (task.employeeId !== personId && !prevPeople.includes(task.employeeId)) {
          prevPeople.push(task.employeeId);
        }
        setState((prev) => ({
          ...prev,
          tasks: patchById(prev.tasks, taskId, {
            employeeId: person.id,
            owner: person.shortName,
            department: person.department,
            role: person.role,
            peopleIds: prevPeople,
            lastActivityAt: now,
            automationNote: `Reassigned to ${person.shortName} by ${active.fullName.split(" ")[0]}`,
          }),
        }));
        return null;
      },
      addTaskPerson: (taskId, personId) => {
        if (!canApproveTeam(active.role)) return "Only managers can add people to tasks.";
        if (!canApproveFor(personId)) return "You can only add people who report to you.";
        const task = state.tasks.find((item) => item.id === taskId);
        if (!task) return "Task not found.";
        if (task.status === "done") return "Closed tasks cannot be edited.";
        const person = taskPersonById(personId);
        if (!person) return "Pick someone from your team.";
        if (personId === task.employeeId) return "That person is already the owner.";
        const people = task.peopleIds ?? [];
        if (people.includes(personId)) return "That person is already on this task.";
        const now = new Date().toISOString();
        setState((prev) => ({
          ...prev,
          tasks: patchById(prev.tasks, taskId, {
            peopleIds: [...people, personId],
            lastActivityAt: now,
            automationNote: `Added ${person.shortName} by ${active.fullName.split(" ")[0]}`,
          }),
        }));
        return null;
      },
      removeTaskPerson: (taskId, personId) => {
        if (!canApproveTeam(active.role)) return "Only managers can remove people from tasks.";
        const task = state.tasks.find((item) => item.id === taskId);
        if (!task) return "Task not found.";
        if (task.status === "done") return "Closed tasks cannot be edited.";
        if (personId === task.employeeId) return "Change the owner instead of removing them.";
        const people = (task.peopleIds ?? []).filter((id) => id !== personId);
        const person = taskPersonById(personId);
        const now = new Date().toISOString();
        setState((prev) => ({
          ...prev,
          tasks: patchById(prev.tasks, taskId, {
            peopleIds: people,
            lastActivityAt: now,
            automationNote: person
              ? `Removed ${person.shortName} by ${active.fullName.split(" ")[0]}`
              : `Person removed by ${active.fullName.split(" ")[0]}`,
          }),
        }));
        return null;
      },
      createTask: (input) => {
        if (!canApproveTeam(active.role)) return "Only managers can create team tasks.";
        if (!canApproveFor(input.ownerId)) return "You can only assign tasks to people who report to you.";
        const subject = input.subject.trim().replace(/\s+/g, " ");
        if (subject.length < 3) return "Enter a task name (at least 3 characters).";
        if (subject.length > 120) return "Keep the task name under 120 characters.";
        const person = taskPersonById(input.ownerId);
        if (!person) return "Pick an owner from your team.";
        if (!input.taskType || !TASK_TYPES.includes(input.taskType)) return "Choose a task type.";
        const status = input.status ?? "open";
        if (status !== "open" && status !== "scheduled") return "A new task starts as To do or Scheduled.";
        const due = (input.due || "").trim();
        if (!due) return "Choose a due date.";
        if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return "Use a valid due date (YYYY-MM-DD).";
        if (due < todayISO()) return "The due date can't be in the past.";
        const estimate = input.estimatedHours ?? 1;
        if (!Number.isFinite(estimate) || estimate < 0.5 || estimate > 200) return "Estimate between 0.5 and 200 hours.";
        const duplicate = state.tasks.some(
          (t) => t.employeeId === person.id && t.status !== "done" && t.subject.trim().toLowerCase() === subject.toLowerCase(),
        );
        if (duplicate) return `${person.shortName} already has an open task with this name.`;
        const links: TaskLink[] = [];
        for (const link of input.links ?? []) {
          if (!link.url.trim() && !link.label.trim()) continue;
          const url = safeTaskUrl(link.url);
          if (!url) return `"${link.url || link.label}" isn't a valid web link (use https://…).`;
          links.push({ label: link.label.trim().slice(0, 60) || new URL(url).hostname, url });
        }
        if (links.length > 10) return "Add at most 10 links.";
        if (input.referenceTaskId && !state.tasks.some((t) => t.id === input.referenceTaskId)) return "The related task no longer exists.";
        const peopleIds = [...new Set(input.peopleIds ?? [])].filter((id) => id !== person.id);
        if (peopleIds.some((id) => !taskPersonById(id) || !canApproveFor(id))) {
          return "Collaborators must be people who report to you.";
        }
        const ccIds = [...new Set(input.ccIds ?? [])].filter((id) => id !== person.id && id !== active.id && !peopleIds.includes(id));
        if (ccIds.some((id) => !TIMEZ_DEMOS.some((a) => a.id === id) && !taskPersonById(id))) return "Someone on CC wasn't found.";
        if (ccIds.length > 10) return "CC at most 10 people.";
        const now = new Date().toISOString();
        // Next code after the highest existing one, so codes never repeat.
        const codeNum = Math.max(1099, ...state.tasks.map((t) => Number(t.code.replace(/\D/g, "")) || 0)) + 1;
        const assigner = active.fullName.split(" ")[0] || "Manager";
        const task: Task = {
          id: uid("task"),
          code: `TSK-${codeNum}`,
          employeeId: person.id,
          subject,
          priority: input.priority,
          status,
          taskType: input.taskType,
          links,
          referenceTaskId: input.referenceTaskId || undefined,
          ccIds,
          assignedBy: assigner,
          owner: person.shortName,
          department: person.department,
          role: person.role,
          managerName: assigner,
          client: (input.client || "Internal").trim() || "Internal",
          projectName: (input.client || "Internal").trim() || "Internal",
          notes: (input.notes || "").trim(),
          blocked: "",
          automationNote: `Created by ${assigner}`,
          createdAt: now,
          estimatedHours: estimate,
          hoursSpent: 0,
          score: 70,
          lastActivityAt: now,
          due,
          peopleIds,
          progressPct: 0,
          accepted: false,
          inReview: false,
          subtasks: [],
          attachments: [],
          comments: [],
          activity: [{ id: uid("tact"), at: now, actor: assigner, action: "Assigned", detail: `Assigned to ${person.shortName}` }],
        };
        setState((prev) => ({ ...prev, tasks: [task, ...prev.tasks] }));
        pushPersonTaskAlert({
          recipientId: person.id,
          title: `New task · ${task.code}`,
          body: `${active.fullName} assigned you “${subject}” (due ${due}).`,
        });
        for (const id of ccIds) {
          pushPersonTaskAlert({
            recipientId: id,
            title: `You were CC'd · ${task.code}`,
            body: `${active.fullName} assigned “${subject}” to ${person.fullName}.`,
          });
        }
        return null;
      },
      taskAction: (taskId, action, payload = {}) => {
        const task = state.tasks.find((item) => item.id === taskId);
        if (!task) return "Task not found.";
        const canAct = task.employeeId === active.id || canApproveFor(task.employeeId);
        if (!canAct) return "You can only update your own tasks.";
        if (task.status === "scheduled" && action !== "accept") return "This task is not open yet.";
        if (task.status === "done") return "This task is already complete.";
        const now = new Date().toISOString();
        const actor = active.fullName.split(" ")[0] || "User";
        const pushActivity = (label: string, detail?: string, patch: Partial<Task> = {}) => {
          setState((prev) => ({
            ...prev,
            tasks: patchById(prev.tasks, taskId, {
              ...patch,
              lastActivityAt: now,
              activity: [
                ...(task.activity ?? []),
                { id: uid("tact"), at: now, actor, action: label, detail },
              ],
            }),
          }));
        };

        if (action === "accept") {
          if (task.accepted) return "Task already accepted.";
          pushActivity("Accepted", undefined, { accepted: true, automationNote: "Accepted by assignee" });
          return null;
        }
        if (action === "start") {
          pushActivity("Started", undefined, {
            accepted: true,
            status: "progress",
            progressPct: Math.max(taskProgress(task), 10),
            blocked: "",
            inReview: false,
            automationNote: "In progress",
          });
          return null;
        }
        if (action === "progress") {
          const next = Math.max(0, Math.min(99, Math.round(payload.progressPct ?? taskProgress(task) + 10)));
          pushActivity("Progress updated", `${next}%`, {
            accepted: true,
            status: "progress",
            progressPct: next,
            inReview: false,
            automationNote: `Progress ${next}%`,
            hoursSpent: Math.max(task.hoursSpent, (task.estimatedHours * next) / 100),
          });
          return null;
        }
        if (action === "block") {
          const reason = (payload.blockedReason || "").trim();
          if (!reason) return "Enter a blocker reason.";
          const dependsOn = (payload.dependsOn || "").trim();
          if (task.status === "open" && !task.accepted) return "Accept the task before marking it blocked.";
          pushActivity(task.blocked ? "Updated blocker" : "Marked blocked", reason, {
            status: task.status === "scheduled" ? task.status : "progress",
            accepted: true,
            blocked: reason,
            dependsOn,
            inReview: false,
            automationNote: `Blocked: ${reason}`,
          });
          pushManagerTaskAlert({
            title: `Task blocked · ${task.code}`,
            body: `${actor} blocked “${task.subject}”: ${reason}${dependsOn ? ` · depends on ${dependsOn}` : ""}`,
            href: "/tasks",
            employeeId: task.employeeId,
          });
          return null;
        }
        if (action === "unblock") {
          pushActivity("Cleared blocker", undefined, {
            blocked: "",
            dependsOn: "",
            automationNote: "Blocker cleared",
          });
          return null;
        }
        if (action === "help") {
          const note = (payload.comment || "Needs manager help").trim();
          pushActivity("Requested help", note, {
            automationNote: "Help requested",
            comments: [...(task.comments ?? []), { id: uid("tc"), author: actor, text: note, at: now }],
          });
          pushManagerTaskAlert({
            title: `Help requested · ${task.code}`,
            body: `${actor} asked for help on “${task.subject}”: ${note}`,
            href: "/tasks",
            employeeId: task.employeeId,
          });
          return null;
        }
        if (action === "review") {
          pushActivity("Submitted for review", undefined, {
            inReview: true,
            blocked: "",
            progressPct: Math.max(taskProgress(task), 90),
            status: "progress",
            automationNote: "Submitted for review",
          });
          pushManagerTaskAlert({
            title: `Review requested · ${task.code}`,
            body: `${actor} submitted “${task.subject}” for review.`,
            href: "/tasks",
            employeeId: task.employeeId,
          });
          return null;
        }
        if (action === "complete") {
          if (task.blocked) return "Unblock the task before completing it.";
          if (task.employeeId === active.id && managementChain(active.id, TIMEZ_DEMOS).length > 0) {
            return "Submit it for review — your manager marks it complete.";
          }
          pushActivity("Completed", undefined, {
            status: "done",
            progressPct: 100,
            inReview: false,
            blocked: "",
            accepted: true,
            automationNote: "Marked complete",
            hoursSpent: Math.max(task.hoursSpent, task.estimatedHours * 0.8),
            score: Math.min(100, Math.max(task.score, 85)),
          });
          return null;
        }
        return "Unknown action.";
      },
      toggleTaskSubtask: (taskId, subtaskId) => {
        const task = state.tasks.find((item) => item.id === taskId);
        if (!task) return "Task not found.";
        const canAct = task.employeeId === active.id || canApproveFor(task.employeeId);
        if (!canAct) return "You can only update your own tasks.";
        if (task.status === "done" || task.status === "scheduled") return "This task cannot be edited right now.";
        const subtasks = (task.subtasks ?? []).map((s) => (s.id === subtaskId ? { ...s, done: !s.done } : s));
        const doneCount = subtasks.filter((s) => s.done).length;
        const progressPct =
          subtasks.length > 0 ? Math.round((doneCount / subtasks.length) * 100) : taskProgress(task);
        const now = new Date().toISOString();
        const actor = active.fullName.split(" ")[0] || "User";
        const flipped = subtasks.find((s) => s.id === subtaskId);
        if (isTaskAutoMode(task.employeeId)) {
          // Automatic mode: only moves forward, only on accepted, unblocked tasks.
          const accepted = task.accepted ?? task.status !== "open";
          const checklistEntry = {
            id: uid("tact"),
            at: now,
            actor,
            action: flipped?.done ? "Checklist item done" : "Checklist item reopened",
            detail: flipped?.title,
          };
          const autoEntries: { id: string; at: string; actor: string; action: string }[] = [];
          const autoEntry = (action: string) => autoEntries.push({ id: uid("tact"), at: now, actor: "Auto", action });
          const patch: Partial<Task> = {
            subtasks,
            progressPct: Math.min(99, progressPct),
            lastActivityAt: now,
            automationNote: flipped?.done ? `Checklist: ${flipped.title}` : "Checklist updated",
          };
          let sendReview = false;
          if (accepted && !task.blocked && flipped?.done) {
            if (task.status === "open") {
              patch.status = "progress";
              autoEntry("Moved to In progress automatically (subtask ticked)");
            }
            if (subtasks.length > 0 && doneCount === subtasks.length) {
              const needsReview = task.employeeId === active.id && managementChain(task.employeeId, TIMEZ_DEMOS).length > 0;
              if (needsReview) {
                if (!task.inReview) {
                  Object.assign(patch, { status: "progress", inReview: true, automationNote: "Ready for review" });
                  autoEntry("Moved to Ready for review automatically (all subtasks done)");
                  sendReview = true;
                }
              } else {
                Object.assign(patch, {
                  status: "done",
                  progressPct: 100,
                  inReview: false,
                  automationNote: "Completed automatically",
                  hoursSpent: Math.max(task.hoursSpent, task.estimatedHours * 0.8),
                  score: Math.min(100, Math.max(task.score, 85)),
                });
                autoEntry("Moved to Done automatically (all subtasks done)");
              }
            }
          }
          setState((prev) => ({
            ...prev,
            tasks: patchById(prev.tasks, taskId, {
              ...patch,
              activity: [...(task.activity ?? []), checklistEntry, ...autoEntries],
            }),
          }));
          if (sendReview) {
            pushManagerTaskAlert({
              title: `Ready for review · ${task.code}`,
              body: `All checklist items on “${task.subject}” are done.`,
              href: "/tasks",
              employeeId: task.employeeId,
            });
          }
          return null;
        }
        setState((prev) => ({
          ...prev,
          tasks: patchById(prev.tasks, taskId, {
            subtasks,
            progressPct: task.status === "done" ? 100 : Math.min(99, progressPct),
            status: task.status === "open" ? "progress" : task.status,
            accepted: true,
            lastActivityAt: now,
            automationNote: flipped?.done ? `Checklist: ${flipped.title}` : "Checklist updated",
            activity: [
              ...(task.activity ?? []),
              {
                id: uid("tact"),
                at: now,
                actor,
                action: flipped?.done ? "Checklist item done" : "Checklist item reopened",
                detail: flipped?.title,
              },
            ],
          }),
        }));
        return null;
      },
      addTaskComment: (taskId, text) => {
        const task = state.tasks.find((item) => item.id === taskId);
        if (!task) return "Task not found.";
        const canAct = task.employeeId === active.id || canApproveFor(task.employeeId);
        if (!canAct) return "You can only comment on your own tasks.";
        const trimmed = text.trim();
        if (!trimmed) return "Enter a comment.";
        const now = new Date().toISOString();
        const actor = active.fullName.split(" ")[0] || "User";
        // Automatic mode: the owner's work note on an accepted To-do task starts it.
        const autoStart =
          isTaskAutoMode(task.employeeId) &&
          task.employeeId === active.id &&
          task.status === "open" &&
          (task.accepted ?? false) &&
          !task.blocked;
        setState((prev) => ({
          ...prev,
          tasks: patchById(prev.tasks, taskId, {
            comments: [...(task.comments ?? []), { id: uid("tc"), author: actor, text: trimmed, at: now }],
            lastActivityAt: now,
            ...(autoStart
              ? { status: "progress" as TaskStatus, progressPct: Math.max(taskProgress(task), 10), automationNote: "In progress" }
              : {}),
            activity: [
              ...(task.activity ?? []),
              { id: uid("tact"), at: now, actor, action: "Commented", detail: trimmed },
              ...(autoStart
                ? [{ id: uid("tact"), at: now, actor: "Auto", action: "Moved to In progress automatically (work note added)" }]
                : []),
            ],
          }),
        }));
        return null;
      },
      recordTaskAutoEvents: (events) => {
        if (events.length === 0) return;
        const now = new Date().toISOString();
        setState((prev) => ({
          ...prev,
          tasks: prev.tasks.map((t) => {
            const mine = events.filter((e) => e.taskId === t.id);
            if (mine.length === 0) return t;
            return {
              ...t,
              activity: [
                ...(t.activity ?? []),
                ...mine.map((e) => ({ id: uid("tact"), at: now, actor: "Auto", action: e.action, detail: e.detail })),
              ],
            };
          }),
        }));
      },
      addReimbursement: (input) => {
        const error = validateExpense(
          { ...input, category: input.category.trim() },
          claimLimitsFor(active.countryCode).maxClaim,
          payRulesFor(active.countryCode).currency,
        );
        if (error) return error;
        if (input.amount > receiptThresholdFor(active.countryCode) && !/Receipt:/i.test(input.description)) {
          return "Attach the receipt for this amount.";
        }
        const duplicate = state.reimbursements.some(
          (item) =>
            item.employeeId === active.id &&
            item.status !== "rejected" &&
            item.status !== "withdrawn" &&
            item.date === input.date &&
            item.category === input.category.trim() &&
            item.amount === input.amount,
        );
        if (duplicate) return "You've already claimed this (same date, category and amount).";
        const item: Reimbursement = {
          id: uid("rb"),
          employeeId: active.id,
          date: input.date,
          category: input.category.trim(),
          amount: input.amount,
          currency: payRulesFor(active.countryCode).currency,
          description: input.description.trim(),
          status: "submitted",
        };
        setState((prev) => ({ ...prev, reimbursements: [withAutoApproval(item, "approved"), ...prev.reimbursements] }));
        return null;
      },
      setReimbursementStatus: (requestId, status, note) => {
        const item = state.reimbursements.find((entry) => entry.id === requestId);
        if (!item) return "Claim not found.";
        const error = decisionError(item.employeeId, item.status, status);
        if (error) return error;
        setState((prev) => ({
          ...prev,
          reimbursements: patchById(prev.reimbursements, requestId, { status, ...decision(status, note) }),
        }));
        return null;
      },
      setInvestmentProofStatus: (proofId, status, note) => {
        const item = state.investmentProofs.find((entry) => entry.id === proofId);
        if (!item) return "Proof not found.";
        if (status === "withdrawn") {
          if (item.employeeId !== active.id) return "Only the employee can withdraw their proof.";
          if (item.status !== "submitted") return "Only submitted proofs can be withdrawn.";
        } else {
          if (item.employeeId === active.id) return "You cannot verify your own proof.";
          if (!canVerifyProofs) return "Only payroll or HR can verify tax-saving proofs.";
          if (item.status !== "submitted") return "This proof has already been reviewed.";
        }
        setState((prev) => ({
          ...prev,
          investmentProofs: patchById(prev.investmentProofs, proofId, { status, ...decision(status, note) }),
        }));
        return null;
      },
      addInvestmentProof: (input) => {
        const rules = payRulesFor(active.countryCode);
        if (rules.declarations.length === 0) return rules.declarationNote;
        if (!input.title.trim()) return "Enter a title.";
        if (!Number.isFinite(input.amount) || input.amount <= 0) return "Enter a valid amount.";
        if (!Number.isInteger(input.amount)) return `Enter the amount in whole ${rules.currency}.`;
        const fy = input.financialYear.trim();
        const allowedFys = declarableTaxYears(rules, todayISO());
        if (!allowedFys.includes(fy)) return `Choose a tax year: ${allowedFys.join(" or ")}.`;
        const section = input.section.trim().toUpperCase();
        const sectionRule = rules.declarations.find((item) => item.code.toUpperCase() === section);
        if (!sectionRule) return "Choose a section from the list.";
        const cap = sectionRule.cap;
        if (cap != null) {
          const used = state.investmentProofs
            .filter(
              (p) =>
                p.employeeId === active.id &&
                p.financialYear === fy &&
                p.section.toUpperCase() === section &&
                p.status !== "rejected" &&
                p.status !== "withdrawn",
            )
            .reduce((total, p) => total + p.amount, 0);
          if (used + input.amount > cap) {
            return `${sectionRule.code} allows up to ${money(cap, rules.currency)} a year — you've already declared ${money(used, rules.currency)}.`;
          }
        }
        const duplicate = state.investmentProofs.some(
          (p) =>
            p.employeeId === active.id &&
            p.financialYear === fy &&
            p.section.toUpperCase() === section &&
            p.title.trim().toLowerCase() === input.title.trim().toLowerCase() &&
            p.status !== "rejected" &&
            p.status !== "withdrawn",
        );
        if (duplicate) return "You've already submitted this proof for that year.";
        const item: InvestmentProof = {
          id: uid("poi"),
          employeeId: active.id,
          section: input.section.trim(),
          title: input.title.trim(),
          amount: input.amount,
          financialYear: input.financialYear.trim(),
          currency: rules.currency,
          status: "submitted",
          submittedOn: todayISO(),
        };
        setState((prev) => ({ ...prev, investmentProofs: [item, ...prev.investmentProofs] }));
        return null;
      },
      continueProgram: (programId) => {
        const program = state.programs.find((item) => item.id === programId && item.employeeId === active.id);
        if (!program) return "Program not found.";
        if (program.status === "completed") return "This program is already complete.";
        const modulesDone = Math.min(program.modulesTotal, program.modulesDone + 1);
        const progress = Math.round((modulesDone / program.modulesTotal) * 100);
        const status = modulesDone >= program.modulesTotal ? "completed" : "in_progress";
        setState((prev) => ({
          ...prev,
          programs: patchById(prev.programs, programId, { modulesDone, progress, status }),
        }));
        return null;
      },
      completeProgram: (programId) => {
        const program = state.programs.find((item) => item.id === programId && item.employeeId === active.id);
        if (!program) return "Program not found.";
        if (program.status === "completed") return "This program is already complete.";
        setState((prev) => ({
          ...prev,
          programs: patchById(prev.programs, programId, {
            modulesDone: program.modulesTotal,
            progress: 100,
            status: "completed",
          }),
        }));
        return null;
      },
      setApproval: (approvalId, status) => {
        setState((prev) => ({ ...prev, approvals: patchById(prev.approvals, approvalId, { status }) }));
      },
      sendMessage: (threadId, text) => {
        const trimmed = text.trim();
        if (!trimmed) return "Enter a message.";
        const thread = state.chatThreads.find((item) => item.id === threadId);
        if (!thread) return "Conversation not found.";
        const message = { id: uid("m"), from: "me" as const, text: trimmed, at: new Date().toISOString() };
        setState((prev) => ({
          ...prev,
          chatThreads: prev.chatThreads.map((item) =>
            item.id === threadId ? { ...item, messages: [...item.messages, message] } : item,
          ),
        }));
        return null;
      },
      addAssetRequest: (item, reason) => {
        if (!item.trim() || !reason.trim()) return "Enter the asset and the reason.";
        const wanted = item.trim().toLowerCase();
        if (state.assets.some((a) => a.employeeId === active.id && a.name.toLowerCase() === wanted)) {
          return `You already have a ${item.trim()} assigned.`;
        }
        if (state.assetRequests.some((r) => r.employeeId === active.id && r.status === "pending" && r.item.toLowerCase() === wanted)) {
          return "You already have a pending request for this asset.";
        }
        const request: AssetRequest = {
          id: uid("ar"),
          employeeId: active.id,
          item: item.trim(),
          reason: reason.trim(),
          status: "pending",
          date: todayISO(),
        };
        setState((prev) => ({ ...prev, assetRequests: [withAutoApproval(request, "approved"), ...prev.assetRequests] }));
        return null;
      },
      setAssetStatus: (requestId, status, note) => {
        const item = state.assetRequests.find((entry) => entry.id === requestId);
        if (!item) return "Request not found.";
        const error = decisionError(item.employeeId, item.status, status);
        if (error) return error;
        setState((prev) => ({ ...prev, assetRequests: patchById(prev.assetRequests, requestId, { status, ...decision(status, note) }) }));
        return null;
      },
      addCash: (input) => {
        if (!input.category.trim()) return "Select an expense category.";
        if (!input.purpose.trim()) return "Enter the business purpose.";
        if (!input.requiredBy) return "Select the required-by date.";
        if (input.requiredBy < todayISO()) return "The required-by date can't be in the past.";
        if (!Number.isFinite(input.amount) || input.amount <= 0) return "Enter an amount greater than zero.";
        const cashCurrency = payRulesFor(active.countryCode).currency;
        if (!Number.isInteger(input.amount)) return `Enter the amount in whole ${cashCurrency}.`;
        const maxCash = claimLimitsFor(active.countryCode).maxCashAdvance;
        if (input.amount > maxCash) return `A cash advance can't be more than ${money(maxCash, cashCurrency)}.`;
        if (state.cashAdvances.some((c) => c.employeeId === active.id && c.status === "pending")) {
          return "You already have a cash advance waiting for approval.";
        }
        const request: CashAdvance = {
          id: uid("ca"),
          employeeId: active.id,
          amount: input.amount,
          currency: cashCurrency,
          category: input.category.trim(),
          purpose: input.purpose.trim(),
          requiredBy: input.requiredBy,
          status: "pending",
          date: todayISO(),
        };
        setState((prev) => ({ ...prev, cashAdvances: [withAutoApproval(request, "approved"), ...prev.cashAdvances] }));
        return null;
      },
      setCashStatus: (requestId, status, note) => {
        const item = state.cashAdvances.find((entry) => entry.id === requestId);
        if (!item) return "Request not found.";
        const error = decisionError(item.employeeId, item.status, status);
        if (error) return error;
        setState((prev) => ({ ...prev, cashAdvances: patchById(prev.cashAdvances, requestId, { status, ...decision(status, note) }) }));
        return null;
      },
      addSoftware: (software, justification) => {
        if (!software.trim() || !justification.trim()) return "Enter the software and why you need it.";
        const wanted = software.trim().toLowerCase();
        if (
          state.softwareRequests.some(
            (r) => r.employeeId === active.id && (r.status === "pending" || r.status === "approved") && r.software.toLowerCase() === wanted,
          )
        ) {
          return "You already have a pending or approved request for this software.";
        }
        const request: SoftwareRequest = {
          id: uid("sw"),
          employeeId: active.id,
          software: software.trim(),
          justification: justification.trim(),
          status: "pending",
          date: todayISO(),
        };
        setState((prev) => ({ ...prev, softwareRequests: [withAutoApproval(request, "approved"), ...prev.softwareRequests] }));
        return null;
      },
      setSoftwareStatus: (requestId, status, note) => {
        const item = state.softwareRequests.find((entry) => entry.id === requestId);
        if (!item) return "Request not found.";
        const error = decisionError(item.employeeId, item.status, status);
        if (error) return error;
        setState((prev) => ({
          ...prev,
          softwareRequests: patchById(prev.softwareRequests, requestId, { status, ...decision(status, note) }),
        }));
        return null;
      },
      addCab: (booking) => {
        if (!booking.date || !booking.time || !booking.from.trim() || !booking.to.trim()) {
          return "Date, time, pickup, and drop are required.";
        }
        const now = new Date();
        const nowTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
        if (booking.date < todayISO() || (booking.date === todayISO() && booking.time <= nowTime)) {
          return "Pick a pickup time in the future.";
        }
        if (booking.from.trim().toLowerCase() === booking.to.trim().toLowerCase()) return "Pickup and drop can't be the same place.";
        const toMinutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
        const clash = state.cabBookings.some(
          (c) =>
            c.employeeId === active.id &&
            (c.status === "pending" || c.status === "approved") &&
            c.date === booking.date &&
            Math.abs(toMinutes(c.time) - toMinutes(booking.time)) < 30,
        );
        if (clash) return "You already have a cab within 30 minutes of that time.";
        const request: CabBooking = {
          id: uid("cab"),
          employeeId: active.id,
          ...booking,
          from: booking.from.trim(),
          to: booking.to.trim(),
          status: "pending",
        };
        setState((prev) => ({ ...prev, cabBookings: [withAutoApproval(request, "approved"), ...prev.cabBookings] }));
        return null;
      },
      setCabStatus: (requestId, status, note) => {
        const item = state.cabBookings.find((entry) => entry.id === requestId);
        if (!item) return "Booking not found.";
        // A booked cab can be cancelled until the trip date.
        const cancellingBooked =
          status === "withdrawn" && item.employeeId === active.id && item.status === "approved" && item.date >= todayISO();
        const error = cancellingBooked ? null : decisionError(item.employeeId, item.status, status);
        if (error) return error;
        setState((prev) => ({ ...prev, cabBookings: patchById(prev.cabBookings, requestId, { status, ...decision(status, note) }) }));
        return null;
      },
      orderMeal: (menuItemId) => {
        const menuItem = state.menu.find((item) => item.id === menuItemId);
        if (!menuItem) return "That item is not on the menu.";
        const today = todayISO();
        const ordersToday = state.cafeteriaOrders.filter(
          (order) => order.employeeId === active.id && order.date === today && order.status !== "cancelled",
        ).length;
        if (ordersToday >= MAX_MEAL_ORDERS_PER_DAY) return `You can place up to ${MAX_MEAL_ORDERS_PER_DAY} orders a day.`;
        setState((prev) => ({
          ...prev,
          cafeteriaOrders: [
            {
              id: uid("cafe"),
              employeeId: active.id,
              menuItemId,
              date: today,
              status: "placed",
              itemName: menuItem.name,
              unitPrice: menuItem.price,
            },
            ...prev.cafeteriaOrders,
          ],
        }));
        return null;
      },
      cancelMeal: (orderId) => {
        const order = state.cafeteriaOrders.find((item) => item.id === orderId);
        if (!order || order.employeeId !== active.id) return "Order not found.";
        if (order.status === "cancelled") return "This order is already cancelled.";
        if (order.date !== todayISO()) return "Only today's orders can be cancelled.";
        setState((prev) => ({ ...prev, cafeteriaOrders: patchById(prev.cafeteriaOrders, orderId, { status: "cancelled" as const }) }));
        return null;
      },
      addDocument: (input) => {
        if (!input.name.trim() || !input.docType.trim()) return "Enter a name and a type.";
        const document: EmployeeDocument = {
          id: uid("doc"),
          employeeId: active.id,
          name: input.name.trim(),
          category: input.category,
          docType: input.docType.trim(),
          expires: input.expires,
          uploadedBy: active.fullName,
          uploadedAt: new Date().toISOString(),
          body: input.body.trim() || "No note added.",
          shared: false,
        };
        setState((prev) => ({ ...prev, documents: [document, ...prev.documents] }));
        return null;
      },
      updateDocument: (documentId, input) => {
        if (!input.name.trim() || !input.docType.trim()) return "Enter a name and a type.";
        const existing = state.documents.find((item) => item.id === documentId && item.employeeId === active.id);
        if (!existing) return "Document not found.";
        setState((prev) => ({
          ...prev,
          documents: patchById(prev.documents, documentId, {
            name: input.name.trim(),
            category: input.category,
            docType: input.docType.trim(),
            expires: input.expires,
            body: input.body.trim() || "No note added.",
          }),
        }));
        return null;
      },
      setDocumentShared: (documentId, shared) => {
        setState((prev) => ({ ...prev, documents: patchById(prev.documents, documentId, { shared }) }));
      },
      addSignature: (documentName, dataUrl) => {
        if (!documentName.trim()) return "Name the document you are signing.";
        if (!dataUrl) return "Draw a signature first.";
        setState((prev) => ({
          ...prev,
          signatures: [
            {
              id: uid("sig"),
              employeeId: active.id,
              documentName: documentName.trim(),
              signedAt: new Date().toISOString(),
              dataUrl,
            },
            ...prev.signatures,
          ],
        }));
        return null;
      },
    };
  }, [signedIn, userId, state, loginNotice, profileOtp, resetOtp, passwordRevision, shiftState, optionalHolidayState, exitState]);

  return <PortalContext.Provider value={api}>{children}</PortalContext.Provider>;
}

export function usePortal(): PortalApi {
  const value = useContext(PortalContext);
  if (!value) throw new Error("usePortal must be used inside PortalProvider");
  return value;
}
