/**
 * Loads backend data into the shapes the portal already uses (VITE_API_URL mode only):
 * the directory into peopleLocal, leave requests into PortalState.leaveRequests, notifications into the
 * notification centre.
 */
import { getPerson, setApiPeople } from "../data/peopleLocal.ts";
import type { EmploymentStatus, PersonRecord, WorkArrangement } from "../data/peopleData.ts";
import { syncApiNotifications } from "../data/collabLocal.ts";
import { TIMEZ_COUNTRIES } from "../model.ts";
import type { LeaveCode, LeaveRequest, LeaveRow, RequestStatus } from "../model.ts";
import {
  api,
  type LeaveBalancesOut,
  type LeavePolicyOut,
  type LeaveRequestOut,
  type NotificationOut,
  type Page,
  type PersonOut,
} from "./client.ts";
import { approvalProgressText, type WithApproval } from "./approvalProgress.ts";

/* ───────── People ───────── */

const PAGE_SIZE = 200;

/** People whose personal details this user may reveal (API can_reveal). Mobile, personal email, DOB arrive masked. */
const apiRevealIds = new Set<string>();

export function apiCanReveal(personId: string): boolean {
  return apiRevealIds.has(personId);
}

export type RevealField = "mobile" | "personal_email" | "date_of_birth" | "address_line" | "address_postcode" | "emergency_phone";

/** One full personal detail from the API (audited for HR / admin). */
export async function revealPersonDetail(personId: string, field: RevealField): Promise<string | null> {
  const res = await api.get<{ field: string; value: string | null }>(`/people/${encodeURIComponent(personId)}/reveal`, { field });
  return res.value;
}

function toPerson(p: PersonOut): PersonRecord {
  const country = TIMEZ_COUNTRIES.find((c) => c.code === p.country_code);
  const full = p.view === "full" ? p : null;
  // The server says "Exited" once the last working day has passed; the portal calls a leaver "Terminated".
  // Basic card: only whether they have started (a pre-boarding joiner is "Onboarding", not a colleague yet).
  const raw = full?.employment_status ?? (p.view === "basic" && p.started === false ? "Onboarding" : "Active");
  const status = (raw === "Exited" ? "Terminated" : raw) as EmploymentStatus;
  const lastWorkingDay = full?.last_working_day ?? undefined;
  return {
    ...(lastWorkingDay ? { lastWorkingDay, ...(raw === "Exited" ? { exitDate: lastWorkingDay } : {}) } : {}),
    ...(full?.tax_regime === "old" || full?.tax_regime === "new" ? { taxRegime: full.tax_regime } : {}),
    id: p.id,
    employeeCode: full?.employee_code ?? "",
    fullName: p.full_name,
    email: p.email,
    personalEmail: full?.personal_email ?? "",
    mobile: full?.mobile ?? "",
    photo: p.photo || "/profile.svg",
    gender: full?.gender ?? "",
    dateOfJoining: full?.joining_date ?? (p.view === "basic" ? (p.joining_date ?? "") : ""),
    employmentType: full?.employment_type ?? "",
    employmentStatus: status,
    designation: p.job_title,
    jobFamily: full?.job_family ?? "",
    jobProfileId: "",
    positionId: full?.position_id ?? "",
    grade: full?.grade ?? "",
    department: p.department,
    division: full?.division ?? "",
    businessUnit: full?.business_unit ?? "",
    costCenter: full?.cost_centre ?? "",
    location: p.location,
    countryCode: p.country_code,
    countryName: country?.name ?? p.country_code,
    legalEntity: full?.legal_entity ?? "",
    managerId: p.manager_id ?? "",
    managerName: p.manager_name ?? "",
    availability: status === "On Leave" ? "On Leave" : "",
    timeZone: full?.time_zone ?? country?.timeZone ?? "",
    currency: full?.currency ?? country?.currency ?? "",
    // Street line and postcode arrive masked ("••••"); city and country are shown.
    address: [full?.address_line, full?.address_city, full?.address_postcode, full?.address_country].filter(Boolean).join(", "),
    // Set (even if blank) so the portal doesn't invent personal details for real people.
    firstName: full?.first_name ?? "",
    middleName: full?.middle_name ?? "",
    lastName: full?.last_name ?? "",
    preferredName: p.preferred_name ?? "",
    dateOfBirth: full?.date_of_birth ?? "",
    nationality: full?.nationality ?? "",
    workArrangement: (full?.work_arrangement ?? "") as WorkArrangement,
    education: full?.education ?? [],
    experience: full?.experience ?? [],
    dependents: [],
    preferredLanguage: full?.preferred_language ?? "",
    spokenLanguages: full?.languages ?? [],
    careerGoals: full?.career_goals ?? "",
    company: p.company || "TimeZ",
    holidayCalendar: full?.holiday_calendar ?? "",
    leavePolicy: full?.leave_policy_name ?? "",
    payrollStatus: full?.payroll_status ?? "",
    aiProfileStatus: full?.ai_profile_status ?? "",
    addressLine: full?.address_line ?? "",
    addressCity: full?.address_city ?? "",
    addressPostcode: full?.address_postcode ?? "",
    addressCountry: full?.address_country ?? "",
    emergencyName: full?.emergency_name ?? "",
    emergencyRelationship: full?.emergency_relationship ?? "",
    emergencyPhone: full?.emergency_phone ?? "",
  };
}

/** Loads the whole directory (all pages) into the portal's people list. */
export async function loadApiPeople(): Promise<number> {
  const items: PersonOut[] = [];
  let page = 1;
  for (;;) {
    const res = await api.get<Page<PersonOut>>("/people", { page, page_size: PAGE_SIZE });
    items.push(...res.items);
    if (res.items.length < PAGE_SIZE || items.length >= res.total) break;
    page += 1;
  }
  apiRevealIds.clear();
  for (const p of items) if (p.view === "full" && p.can_reveal) apiRevealIds.add(p.id);
  setApiPeople(
    items.map(toPerson),
    items.filter((p) => p.view === "basic").map((p) => p.id),
  );
  return items.length;
}

export function clearApiPeople() {
  apiRevealIds.clear();
  setApiPeople(null);
}

/* ───────── Leave ───────── */

/** Extra facts the API knows about each request (days, names, whether this user decides it). */
export interface ApiLeaveMeta {
  days: number;
  employeeName: string;
  canDecide: boolean;
}

export const apiLeaveMeta = new Map<string, ApiLeaveMeta>();

export interface ApiLeaveData {
  requests: LeaveRequest[];
  balances: LeaveRow[];
  policies: LeavePolicyOut[];
}

function toStatus(status: string): RequestStatus {
  if (status === "approved" || status === "rejected" || status === "pending") return status;
  return "withdrawn"; // withdrawn, cancelled
}

function toLeaveRequest(r: LeaveRequestOut & WithApproval, nameOf: (id: string) => string | undefined): LeaveRequest {
  const progress = approvalProgressText(r.approval);
  return {
    id: r.id,
    employeeId: r.employee_id,
    code: r.leave_code as LeaveCode,
    from: r.from,
    to: r.to,
    reason: r.reason,
    status: toStatus(r.status),
    appliedOn: r.created_at.slice(0, 10),
    ...(r.half === "first" || r.half === "second" ? { half: r.half } : {}),
    decidedById: r.decided_by ?? undefined,
    decidedByName: r.decided_by ? (nameOf(r.decided_by) ?? r.decided_by) : undefined,
    decidedOn: r.decided_at ? r.decided_at.slice(0, 10) : undefined,
    decisionNote: r.decision_note ?? undefined,
    ...(progress ? { approvalProgress: progress } : {}),
  };
}

const HR_ROLES = new Set(["hr", "hr_admin", "hrbp"]);

/** Requests this user can see, their balances and policies. */
export async function loadApiLeave(
  user: { id: string; role: string },
  nameOf: (id: string) => string | undefined,
): Promise<ApiLeaveData> {
  const [all, team, balances, policies] = await Promise.all([
    api.get<(LeaveRequestOut & WithApproval)[]>("/leave/requests", { view: "all", limit: 500 }),
    api.get<LeaveRequestOut[]>("/leave/requests", { view: "team", status: "pending", limit: 500 }),
    api.get<LeaveBalancesOut>("/leave/balances"),
    api.get<LeavePolicyOut[]>("/leave/policies"),
  ]);
  const teamIds = new Set(team.map((r) => r.id));
  const isHr = HR_ROLES.has(user.role);
  apiLeaveMeta.clear();
  for (const r of all) {
    apiLeaveMeta.set(r.id, {
      days: r.days,
      employeeName: r.employee_name ?? nameOf(r.employee_id) ?? r.employee_id,
      // In an approval chain: the current step waits on this user (or on someone they cover for), or HR steps in.
      // A skip-level manager doesn't decide over the line manager's head.
      canDecide:
        r.status === "pending" &&
        r.employee_id !== user.id &&
        (isHr ||
          (r.approval
            ? Boolean(r.approval.waiting_on_me)
            : // Outside a chain only the line manager decides (the team view also lists skip-level reports).
              teamIds.has(r.id) && (getPerson(r.employee_id)?.managerId ?? user.id) === user.id)),
    });
  }
  return {
    requests: all.map((r) => toLeaveRequest(r, nameOf)),
    balances: balances.balances.map((b) => ({
      code: b.code as LeaveCode,
      name: b.name,
      quota: b.quota,
      carriedOver: b.carried_over,
      utilized: b.used,
      pending: b.pending,
      balance: b.left,
      available: b.available,
    })),
    policies,
  };
}

export async function apiApplyLeave(input: { code: string; from: string; to: string; half?: string; reason: string }) {
  await api.post<LeaveRequestOut>("/leave/requests", {
    leave_code: input.code,
    from: input.from,
    to: input.to,
    half: input.half ?? "none",
    reason: input.reason,
  });
}

export async function apiDecideLeave(id: string, decision: "approve" | "reject", note?: string) {
  await api.post<LeaveRequestOut>(`/leave/requests/${encodeURIComponent(id)}/decision`, {
    decision,
    note: note?.trim() || null,
  });
}

export async function apiCancelLeave(id: string) {
  await api.post<LeaveRequestOut>(`/leave/requests/${encodeURIComponent(id)}/cancel`);
}

/* ───────── Notifications ───────── */

export async function loadApiNotifications(userId: string) {
  const items = await api.get<NotificationOut[]>("/notifications", { limit: 100 });
  syncApiNotifications(
    userId,
    items.map((n) => ({ id: n.id, title: n.title, body: n.body, href: n.href, readAt: n.read_at, createdAt: n.created_at })),
  );
}

export async function markApiNotificationsRead(ids: number[]) {
  await Promise.all(ids.map((id) => api.post(`/notifications/${id}/read`).catch(() => undefined)));
}
