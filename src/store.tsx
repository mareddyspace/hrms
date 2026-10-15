import { useEffect, useMemo, useState } from "react";
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
  CabBooking,
  CashAdvance,
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
  type DemoAccount,
} from "./demoAccounts.ts";
import { canApproveTeam } from "./model.ts";
import { createSeed, DEMO_PASSWORD, EMPLOYEE, findAccountByCode, findAccountById } from "./seed.ts";
import { taskPersonById } from "./data/taskTeam.ts";
import { pushManagerTaskAlert } from "./data/collabLocal.ts";
import { taskProgress } from "./data/taskHelpers.ts";

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

function passwordChangedAtIso(): string | null {
  return localStorage.getItem(PASSWORD_CHANGED_AT_KEY);
}

function notePasswordChanged(employeeCode?: string) {
  localStorage.setItem(PASSWORD_CHANGED_AT_KEY, new Date().toISOString());
  if (employeeCode) {
    // keep shared stamp; per-user passwords are stored separately
  }
}

function savePassword(employeeCode: string, next: string) {
  localStorage.setItem(passwordStorageKey(employeeCode), next);
  localStorage.setItem(PASSWORD_KEY, next);
  notePasswordChanged(employeeCode);
}

function ensureDemoPasswordChangedAt(employeeCode?: string) {
  // Prototype demo passwords should not force the stale-password gate.
  const code = employeeCode ?? EMPLOYEE.employeeCode;
  const baseline = demoPasswordFor(code);
  const stillBaseline = storedPassword(code) === baseline;
  if (stillBaseline) {
    localStorage.setItem(PASSWORD_CHANGED_AT_KEY, new Date().toISOString());
    return;
  }
  if (localStorage.getItem(PASSWORD_CHANGED_AT_KEY)) return;
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
    if (localStorage.getItem(PHOTO_RESET_KEY) !== "1") {
      if (parsed.profilePhoto) {
        delete parsed.profilePhoto;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
      }
      localStorage.setItem(PHOTO_RESET_KEY, "1");
    }
    let renamed = false;
    if (parsed.profile?.fullName === "Mahesh Babu") {
      parsed.profile = { ...parsed.profile, fullName: "Babu" };
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
  setLeaveStatus: (id: string, status: RequestStatus) => Promise<string | null>;
  applyEncashment: (code: LeaveCode, days: number) => string | null;
  setEncashmentStatus: (id: string, status: RequestStatus) => string | null;
  saveTimesheet: (projectId: string, weekStart: string, hours: Record<string, number>, status: TimesheetStatus) => string | null;
  addTimeEntry: (
    projectId: string,
    weekStart: string,
    input: Omit<TimeEntry, "id">,
  ) => string | null;
  removeTimeEntry: (projectId: string, weekStart: string, entryId: string) => string | null;
  submitWeekTimesheets: (weekStart: string) => string | null;
  setTimesheetStatus: (id: string, status: TimesheetStatus) => void;
  setOrgTimesheetStatus: (id: string, status: OrgTimesheetStatus) => string | null;
  addExpense: (input: Omit<Expense, "id" | "employeeId" | "status">) => string | null;
  setExpenseStatus: (id: string, status: Expense["status"]) => void;
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
  }) => string | null;
  taskAction: (
    taskId: string,
    action: "accept" | "start" | "progress" | "block" | "unblock" | "help" | "review" | "complete",
    payload?: { progressPct?: number; blockedReason?: string; dependsOn?: string; comment?: string },
  ) => string | null;
  toggleTaskSubtask: (taskId: string, subtaskId: string) => string | null;
  addTaskComment: (taskId: string, text: string) => string | null;
  addReimbursement: (input: Omit<Reimbursement, "id" | "employeeId" | "status">) => string | null;
  setReimbursementStatus: (id: string, status: Reimbursement["status"]) => void;
  addInvestmentProof: (input: Omit<InvestmentProof, "id" | "employeeId" | "status" | "submittedOn">) => string | null;
  continueProgram: (id: string) => string | null;
  completeProgram: (id: string) => string | null;
  setApproval: (id: string, status: Approval["status"]) => void;
  sendMessage: (threadId: string, text: string) => string | null;
  addAssetRequest: (item: string, reason: string) => string | null;
  setAssetStatus: (id: string, status: RequestStatus) => void;
  addCash: (input: { amount: number; category: string; purpose: string; requiredBy: string }) => string | null;
  setCashStatus: (id: string, status: RequestStatus) => void;
  addSoftware: (software: string, justification: string) => string | null;
  setSoftwareStatus: (id: string, status: RequestStatus) => void;
  addCab: (booking: Omit<CabBooking, "id" | "employeeId" | "status">) => string | null;
  setCabStatus: (id: string, status: RequestStatus) => void;
  orderMeal: (menuItemId: string) => string | null;
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

const PortalContext = createContext<PortalApi | null>(null);

export function PortalProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<PortalState>(() => {
    ensureDemoLastLogin();
    return loadState();
  });
  const [signedIn, setSignedIn] = useState(() => localStorage.getItem(SESSION_KEY) === "in");
  const [userId, setUserId] = useState(() => localStorage.getItem(USER_KEY) ?? EMPLOYEE.id);
  const [loginNotice, setLoginNotice] = useState<LoginNotice | null>(null);
  const [profileOtp, setProfileOtp] = useState<{ code: string; expiresAt: number } | null>(null);
  const [resetOtp, setResetOtp] = useState<{ code: string; expiresAt: number; employeeCode: string } | null>(null);
  const [passwordRevision, setPasswordRevision] = useState(0);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state]);

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
    
    const leaveTable = leaveRows(
      state.leavePolicies,
      state.leaveRequests,
      state.encashments,
      state.holidays,
      active.id,
      activeOffs,
    );
    const currentProjects = mine(state.projects).filter((project) => project.status === "current");
    const previousProjects = mine(state.projects).filter((project) => project.status === "previous");

    function colleagueName(colleagueId: string) {
      return state.colleagues.find((person) => person.id === colleagueId)?.name ?? "Employee";
    }

    function projectName(projectId: string) {
      return state.projects.find((project) => project.id === projectId)?.name ?? "Project";
    }

    function activateSession(account: DemoAccount, options?: { silent?: boolean }) {
      const previousIso = localStorage.getItem(LAST_LOGIN_KEY);
      const requirePasswordChange = previousIso ? daysSinceLogin(previousIso) > PASSWORD_STALE_DAYS : false;
      localStorage.setItem(LAST_LOGIN_KEY, new Date().toISOString());
      localStorage.setItem(SESSION_KEY, "in");
      localStorage.setItem(USER_KEY, account.id);
      setUserId(account.id);
      if (!options?.silent) {
        setLoginNotice({ previousIso, timeZone: account.timeZone, requirePasswordChange });
      }
      setSignedIn(true);
    }

    return {
      employee: {
        ...active,
        ...(active.id === EMPLOYEE.id ? state.profile : null),
        photo: active.id === EMPLOYEE.id ? state.profilePhoto || active.photo : active.photo,
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
      passwordPolicy: passwordPolicyFromChangedAt(passwordChangedAtIso()),
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
        const profile = account.id === EMPLOYEE.id ? { ...account, ...state.profile } : account;
        const sentTo = channel === "email" ? profile.email.trim() : profile.mobile.trim();
        if (!sentTo) {
          return { error: channel === "email" ? "No email is registered on this account." : "No mobile is registered on this account." };
        }
        const code = String(100000 + Math.floor(Math.random() * 900000));
        setResetOtp({ code, expiresAt: Date.now() + 5 * 60 * 1000, employeeCode: account.employeeCode });
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
        if (otp.trim() !== resetOtp.code) return "That verification code is not correct.";
        const next = newPassword.trim();
        if (next.length < 6) return "Use at least 6 characters.";
        if (next !== confirm.trim()) return "Confirmation does not match.";
        if (next === storedPassword(account.employeeCode)) return "Choose a password different from your current one.";
        savePassword(account.employeeCode, next);
        setPasswordRevision((value) => value + 1);
        setResetOtp(null);
        return null;
      },
      state,
      leaveTable,
      counts: actionCounts(state, active.id),
      payslipViews: mine(state.payslips)
        .map(toPayslipView)
        .sort((a, b) => (a.month < b.month ? 1 : -1)),
      currentProjects,
      previousProjects,
      hoursFor: (projectId: string) => projectHours(mine(state.timesheets), projectId),
      colleagueName,
      projectName,
      menuItem: (menuItemId: string) => state.menu.find((item) => item.id === menuItemId),
      signIn: async (emailOrCode, password, remember = false) => {
        const account = findDemoByEmailOrCode(emailOrCode);
        if (!account) return "No prototype account matches that work email or employee ID.";
        if (!password.trim()) return "Enter your password.";
        if (password !== storedPassword(account.employeeCode)) return "The password does not match this account.";
        if (remember) localStorage.setItem(REMEMBER_KEY, account.email);
        else localStorage.removeItem(REMEMBER_KEY);
        activateSession(account);
        return null;
      },
      switchDemoPersona: (accountId) => {
        const account = findDemoById(accountId);
        if (!account) return "That demo persona was not found.";
        activateSession(account, { silent: true });
        return null;
      },
      signOut: () => {
        localStorage.setItem(SESSION_KEY, "out");
        setSignedIn(false);
        setLoginNotice(null);
      },
      updateProfile: (input) => {
        if (!input.fullName.trim()) return "Enter a name.";
        setState((prev) => ({
          ...prev,
          profile: {
            fullName: input.fullName.trim(),
            designation: input.designation.trim(),
            mobile: input.mobile.trim(),
            email: input.email.trim(),
            address: input.address.trim(),
            shiftName: input.shiftName.trim(),
            shiftHours: input.shiftHours.trim(),
          },
          profilePhoto: input.photo ?? prev.profilePhoto,
        }));
        return null;
      },
      requestProfileOtp: () => {
        const code = String(100000 + Math.floor(Math.random() * 900000));
        setProfileOtp({ code, expiresAt: Date.now() + 5 * 60 * 1000 });
        return code;
      },
      updateProfileWithOtp: (input, otp) => {
        if (!profileOtp) return "Send a verification code first.";
        if (Date.now() > profileOtp.expiresAt) {
          setProfileOtp(null);
          return "That code has expired. Send a new one.";
        }
        if (otp.trim() !== profileOtp.code) return "That verification code is not correct.";
        if (!input.fullName.trim()) return "Enter a name.";
        setState((prev) => ({
          ...prev,
          profile: {
            fullName: input.fullName.trim(),
            designation: input.designation.trim(),
            mobile: input.mobile.trim(),
            email: input.email.trim(),
            address: input.address.trim(),
            shiftName: input.shiftName.trim(),
            shiftHours: input.shiftHours.trim(),
          },
          profilePhoto: input.photo ?? prev.profilePhoto,
        }));
        setProfileOtp(null);
        return null;
      },
      resetDemo: () => setState(createSeed()),
      applyLeave: async (input) => {
        const error = validateLeave(state, active.id, input, activeOffs);
        if (error) return error;
        const request: LeaveRequest = {
          id: uid("lv"),
          employeeId: active.id,
          ...input,
          reason: input.reason.trim(),
          status: "pending",
          appliedOn: todayISO(),
        };
        setState((prev) => ({ ...prev, leaveRequests: [request, ...prev.leaveRequests] }));
        return null;
      },
      setLeaveStatus: async (leaveId, status) => {
        const request = state.leaveRequests.find((item) => item.id === leaveId);
        if (!request) return "Leave request not found.";
        const isOwn = request.employeeId === active.id;
        if (!isOwn && !canApproveTeam(active.role)) return "Only managers or HR can approve team leave.";
        if (isOwn && (status === "approved" || status === "rejected")) {
          return "Employees cannot approve or reject their own leave.";
        }
        if (status === "approved") {
          const ownerRows = leaveRows(state.leavePolicies, state.leaveRequests, state.encashments, state.holidays, request.employeeId);
          const row = ownerRows.find((item) => item.code === request.code);
          const days = workingDays(request.from, request.to, holidaySet(state.holidays));
          if (!row || days > row.available) return "Approving this would go past that employee's quota.";
        }
        setState((prev) => ({ ...prev, leaveRequests: patchById(prev.leaveRequests, leaveId, { status }) }));
        return null;
      },
      applyEncashment: (code, days) => {
        const error = validateEncashment(state, active.id, code, days);
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
      setEncashmentStatus: (encashmentId, status) => {
        const item = state.encashments.find((entry) => entry.id === encashmentId);
        if (!item) return "Encashment request not found.";
        const isOwn = item.employeeId === active.id;
        if (!isOwn && !canApproveTeam(active.role)) return "Only managers can approve encashment.";
        if (isOwn && (status === "approved" || status === "rejected")) {
          return "Employees cannot approve their own encashment.";
        }
        if (status === "approved") {
          const ownerRows = leaveRows(state.leavePolicies, state.leaveRequests, state.encashments, state.holidays, item.employeeId);
          const row = ownerRows.find((entry) => entry.code === item.code);
          if (!row || item.days > row.available) return "Approving this would go past that employee's quota.";
        }
        setState((prev) => ({ ...prev, encashments: patchById(prev.encashments, encashmentId, { status }) }));
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
                status: current.status === "submitted" ? current.status : ("draft" as TimesheetStatus),
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
          return { ...prev, timesheets };
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
            return { ...sheet, entries, hours: hoursFromEntries(entries) };
          }),
        }));
        return null;
      },
      submitWeekTimesheets: (weekStart) => {
        const mine = state.timesheets.filter((sheet) => sheet.employeeId === active.id && sheet.weekStart === weekStart);
        if (mine.length === 0) return "Log some time before submitting.";
        if (mine.every((sheet) => sheet.status === "approved")) return "This week is already approved.";
        const hours = mine.reduce((sum, sheet) => sum + Object.values(sheet.hours).reduce((a, b) => a + b, 0), 0);
        setState((prev) => ({
          ...prev,
          timesheets: prev.timesheets.map((sheet) =>
            sheet.employeeId === active.id && sheet.weekStart === weekStart && sheet.status !== "approved"
              ? { ...sheet, status: "submitted" }
              : sheet,
          ),
          orgTimesheets: prev.orgTimesheets.map((row) =>
            row.personId === active.id && row.weekStart === weekStart
              ? { ...row, status: "submitted", hours }
              : row,
          ),
        }));
        return null;
      },
      setTimesheetStatus: (sheetId, status) => {
        setState((prev) => ({
          ...prev,
          timesheets: prev.timesheets.map((sheet) =>
            sheet.id === sheetId && sheet.status !== "approved" ? { ...sheet, status } : sheet,
          ),
        }));
      },
      setOrgTimesheetStatus: (recordId, status) => {
        if (!canApproveTeam(active.role)) return "Only managers can update company timesheets.";
        const row = state.orgTimesheets.find((item) => item.id === recordId);
        if (!row) return "Timesheet record not found.";
        if (row.status === "missing") return "Missing timesheets must be filled by the employee first.";
        if (row.status === "approved" && status !== "approved") return "Approved timesheets stay locked in this demo.";
        setState((prev) => ({
          ...prev,
          orgTimesheets: patchById(prev.orgTimesheets, recordId, { status }),
        }));
        return null;
      },
      addExpense: (input) => {
        const error = validateExpense(input);
        if (error) return error;
        const expense: Expense = {
          id: uid("ex"),
          employeeId: active.id,
          ...input,
          description: input.description.trim(),
          status: "submitted",
        };
        setState((prev) => ({ ...prev, expenses: [expense, ...prev.expenses] }));
        return null;
      },
      setExpenseStatus: (expenseId, status) => {
        const expense = state.expenses.find((item) => item.id === expenseId);
        if (!expense) return;
        const isOwn = expense.employeeId === active.id;
        if (!isOwn && !canApproveTeam(active.role)) return;
        if (isOwn && (status === "approved" || status === "rejected")) return;
        setState((prev) => ({ ...prev, expenses: patchById(prev.expenses, expenseId, { status }) }));
      },
      acceptTask: (taskId) => {
        const task = state.tasks.find((item) => item.id === taskId);
        if (!task) return "Task not found.";
        const canAct = task.employeeId === active.id || canApproveTeam(active.role);
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
        const canAct = task.employeeId === active.id || canApproveTeam(active.role);
        if (!canAct) return;
        if (task.status === "scheduled" && status !== "open" && !canApproveTeam(active.role)) return;
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
        if (!canApproveTeam(active.role)) return "Only managers can reassign tasks.";
        const task = state.tasks.find((item) => item.id === taskId);
        if (!task) return "Task not found.";
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
        const subject = input.subject.trim();
        if (!subject) return "Enter a subject.";
        const person = taskPersonById(input.ownerId);
        if (!person) return "Pick an owner from your team.";
        const due = (input.due || "").trim();
        if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) return "Use a valid due date (YYYY-MM-DD).";
        const now = new Date().toISOString();
        const codeNum = 1100 + state.tasks.length;
        const peopleIds = (input.peopleIds ?? []).filter((id) => id !== person.id && taskPersonById(id));
        const assigner = active.fullName.split(" ")[0] || "Manager";
        const task: Task = {
          id: uid("task"),
          code: `TSK-${codeNum}`,
          employeeId: person.id,
          subject,
          priority: input.priority,
          status: input.status ?? "open",
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
          estimatedHours: Math.max(0.25, input.estimatedHours ?? 1),
          hoursSpent: 0,
          score: 70,
          lastActivityAt: now,
          due: due || todayISO(),
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
        return null;
      },
      taskAction: (taskId, action, payload = {}) => {
        const task = state.tasks.find((item) => item.id === taskId);
        if (!task) return "Task not found.";
        const canAct = task.employeeId === active.id || canApproveTeam(active.role);
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
          });
          return null;
        }
        if (action === "complete") {
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
        const canAct = task.employeeId === active.id || canApproveTeam(active.role);
        if (!canAct) return "You can only update your own tasks.";
        if (task.status === "done" || task.status === "scheduled") return "This task cannot be edited right now.";
        const subtasks = (task.subtasks ?? []).map((s) => (s.id === subtaskId ? { ...s, done: !s.done } : s));
        const doneCount = subtasks.filter((s) => s.done).length;
        const progressPct =
          subtasks.length > 0 ? Math.round((doneCount / subtasks.length) * 100) : taskProgress(task);
        const now = new Date().toISOString();
        const actor = active.fullName.split(" ")[0] || "User";
        const flipped = subtasks.find((s) => s.id === subtaskId);
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
        const canAct = task.employeeId === active.id || canApproveTeam(active.role);
        if (!canAct) return "You can only comment on your own tasks.";
        const trimmed = text.trim();
        if (!trimmed) return "Enter a comment.";
        const now = new Date().toISOString();
        const actor = active.fullName.split(" ")[0] || "User";
        setState((prev) => ({
          ...prev,
          tasks: patchById(prev.tasks, taskId, {
            comments: [...(task.comments ?? []), { id: uid("tc"), author: actor, text: trimmed, at: now }],
            lastActivityAt: now,
            activity: [
              ...(task.activity ?? []),
              { id: uid("tact"), at: now, actor, action: "Commented", detail: trimmed },
            ],
          }),
        }));
        return null;
      },
      addReimbursement: (input) => {
        if (!input.description.trim()) return "Enter a description.";
        if (!Number.isFinite(input.amount) || input.amount <= 0) return "Enter a valid amount.";
        const item: Reimbursement = {
          id: uid("rb"),
          employeeId: active.id,
          date: input.date,
          category: input.category.trim(),
          amount: input.amount,
          description: input.description.trim(),
          status: "submitted",
        };
        setState((prev) => ({ ...prev, reimbursements: [item, ...prev.reimbursements] }));
        return null;
      },
      setReimbursementStatus: (requestId, status) => {
        const item = state.reimbursements.find((entry) => entry.id === requestId);
        if (!item) return;
        const isOwn = item.employeeId === active.id;
        if (!isOwn && !canApproveTeam(active.role)) return;
        if (isOwn && (status === "approved" || status === "rejected")) return;
        setState((prev) => ({ ...prev, reimbursements: patchById(prev.reimbursements, requestId, { status }) }));
      },
      addInvestmentProof: (input) => {
        if (!input.title.trim()) return "Enter the investment title.";
        if (!Number.isFinite(input.amount) || input.amount <= 0) return "Enter a valid amount.";
        const item: InvestmentProof = {
          id: uid("poi"),
          employeeId: active.id,
          section: input.section.trim(),
          title: input.title.trim(),
          amount: input.amount,
          financialYear: input.financialYear.trim(),
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
        const request: AssetRequest = {
          id: uid("ar"),
          employeeId: active.id,
          item: item.trim(),
          reason: reason.trim(),
          status: "pending",
          date: todayISO(),
        };
        setState((prev) => ({ ...prev, assetRequests: [request, ...prev.assetRequests] }));
        return null;
      },
      setAssetStatus: (requestId, status) => {
        const item = state.assetRequests.find((entry) => entry.id === requestId);
        if (!item) return;
        const isOwn = item.employeeId === active.id;
        if (!isOwn && !canApproveTeam(active.role)) return;
        if (isOwn && (status === "approved" || status === "rejected")) return;
        setState((prev) => ({ ...prev, assetRequests: patchById(prev.assetRequests, requestId, { status }) }));
      },
      addCash: (input) => {
        if (!input.category.trim()) return "Select an expense category.";
        if (!input.purpose.trim()) return "Enter the business purpose.";
        if (!input.requiredBy) return "Select the required-by date.";
        if (!Number.isFinite(input.amount) || input.amount <= 0) return "Enter an amount greater than zero.";
        const request: CashAdvance = {
          id: uid("ca"),
          employeeId: active.id,
          amount: input.amount,
          category: input.category.trim(),
          purpose: input.purpose.trim(),
          requiredBy: input.requiredBy,
          status: "pending",
          date: todayISO(),
        };
        setState((prev) => ({ ...prev, cashAdvances: [request, ...prev.cashAdvances] }));
        return null;
      },
      setCashStatus: (requestId, status) => {
        const item = state.cashAdvances.find((entry) => entry.id === requestId);
        if (!item) return;
        const isOwn = item.employeeId === active.id;
        if (!isOwn && !canApproveTeam(active.role)) return;
        if (isOwn && (status === "approved" || status === "rejected")) return;
        setState((prev) => ({ ...prev, cashAdvances: patchById(prev.cashAdvances, requestId, { status }) }));
      },
      addSoftware: (software, justification) => {
        if (!software.trim() || !justification.trim()) return "Enter the software and why you need it.";
        const request: SoftwareRequest = {
          id: uid("sw"),
          employeeId: active.id,
          software: software.trim(),
          justification: justification.trim(),
          status: "pending",
          date: todayISO(),
        };
        setState((prev) => ({ ...prev, softwareRequests: [request, ...prev.softwareRequests] }));
        return null;
      },
      setSoftwareStatus: (requestId, status) => {
        const item = state.softwareRequests.find((entry) => entry.id === requestId);
        if (!item) return;
        const isOwn = item.employeeId === active.id;
        if (!isOwn && !canApproveTeam(active.role)) return;
        if (isOwn && (status === "approved" || status === "rejected")) return;
        setState((prev) => ({ ...prev, softwareRequests: patchById(prev.softwareRequests, requestId, { status }) }));
      },
      addCab: (booking) => {
        if (!booking.date || !booking.time || !booking.from.trim() || !booking.to.trim()) {
          return "Date, time, pickup, and drop are required.";
        }
        const request: CabBooking = {
          id: uid("cab"),
          employeeId: active.id,
          ...booking,
          from: booking.from.trim(),
          to: booking.to.trim(),
          status: "pending",
        };
        setState((prev) => ({ ...prev, cabBookings: [request, ...prev.cabBookings] }));
        return null;
      },
      setCabStatus: (requestId, status) => {
        const item = state.cabBookings.find((entry) => entry.id === requestId);
        if (!item) return;
        const isOwn = item.employeeId === active.id;
        if (!isOwn && !canApproveTeam(active.role)) return;
        if (isOwn && (status === "approved" || status === "rejected")) return;
        setState((prev) => ({ ...prev, cabBookings: patchById(prev.cabBookings, requestId, { status }) }));
      },
      orderMeal: (menuItemId) => {
        if (!state.menu.some((item) => item.id === menuItemId)) return "That item is not on the menu.";
        setState((prev) => ({
          ...prev,
          cafeteriaOrders: [
            { id: uid("cafe"), employeeId: active.id, menuItemId, date: todayISO(), status: "placed" },
            ...prev.cafeteriaOrders,
          ],
        }));
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
  }, [signedIn, userId, state, loginNotice, profileOtp, resetOtp, passwordRevision]);

  return <PortalContext.Provider value={api}>{children}</PortalContext.Provider>;
}

export function usePortal(): PortalApi {
  const value = useContext(PortalContext);
  if (!value) throw new Error("usePortal must be used inside PortalProvider");
  return value;
}
