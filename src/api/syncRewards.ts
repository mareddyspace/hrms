/**
 * Compensation, benefits, letters, documents and policy acknowledgements from the backend (VITE_API_URL mode
 * only). Loads API data into the shapes rewardLocal already uses, and sends changes to the API (rewardLocal
 * reloads afterwards).
 */
import type {
  ApiLetterInfo,
  BenefitEnrollment,
  BenefitPlan,
  BonusRecord,
  CompCycle,
  CompHistoryRow,
  Dependent,
  EnrollmentWindow,
  GradeBand,
  LetterRequest,
  LetterStatus,
  LetterType,
  LifeEvent,
} from "../data/rewardData.ts";
import type { CompProposal } from "../data/rewardLocal.ts";
import { TIMEZ_COUNTRIES, formatShortDate } from "../model.ts";
import { api, apiRequest, type MeOut } from "./client.ts";
import {
  attempt,
  authorizedFetch,
  countryCode,
  countryName,
  day,
  enc,
  fetchFile,
  fileType,
  money,
  nameOf,
  orElse,
  type Outcome,
} from "./syncRewardsShared.ts";

/* ───────── API shapes (backend/app/schemas/compensation.py, benefits.py) ───────── */

interface GradeBandOut {
  id: string;
  grade: string;
  country_code: string;
  currency: string;
  min_amount: number;
  mid_amount: number;
  max_amount: number;
}

export interface CompRecordOut {
  id: string;
  employee_id: string;
  effective_date: string;
  base_salary: number;
  currency: string;
  grade: string;
  reason: string;
  proposal_id: string | null;
  is_current: boolean;
}

export interface CompHistoryOut {
  employee_id: string;
  employee_name: string;
  current: CompRecordOut | null;
  records: CompRecordOut[];
}

interface CompBonusOut {
  id: string;
  employee_id: string;
  bonus_type: string;
  period: string;
  amount: number;
  currency: string;
  status: string;
}

interface CompCycleOut {
  id: string;
  name: string;
  effective_date: string;
  budget_pct: number;
  opens_on: string;
  closes_on: string;
  status: string;
  countries: string[] | null;
  accepting_proposals: boolean;
  budget_used_pct: number | null;
  proposals: number | null;
}

interface CompProposalOut {
  id: string;
  cycle_id: string;
  employee_id: string;
  employee_name: string | null;
  proposed_by: string;
  currency: string;
  current_grade: string;
  proposed_grade: string;
  increase_pct: number;
  current_base: number | null;
  proposed_base: number | null;
  bonus_amount: number | null;
  pay_visible: boolean;
  status: string;
  approval_instance_id: string | null;
  approval_status: string | null;
  current_step: number | null;
  decided_at: string | null;
  created_at: string;
}

export interface CompStatementOut {
  employee_id: string;
  year: number;
  currency: string;
  grade: string | null;
  base_salary: number;
  base_effective_date: string | null;
  bonus_total: number;
  bonuses: CompBonusOut[];
  benefits_employer_cost: number;
  benefits: { plan_id: string; plan_name: string; plan_type: string; employer_annual_cost: number; currency: string }[];
  total_rewards: number;
}

interface ApprovalInstanceOut {
  status: string;
  current_step: number;
  steps: { roles: string[]; skipped: boolean; groups: Record<string, string[]> }[];
  decisions: { step: number; approver_id: string; decision: string }[];
}

interface BenefitPlanOut {
  id: string;
  country_code: string;
  name: string;
  plan_type: string;
  provider: string;
  summary: string;
  employee_cost: string;
  covers_dependents: boolean;
  mandatory: boolean;
  auto_enrolled: boolean;
  eligibility: { exclude_employment_types?: string[]; min_service_months?: number; grades?: string[] };
  rules: string[];
}

interface EligibilityOut {
  plan_id: string;
  eligible: boolean;
  reason: string;
}

interface WindowOut {
  id: string;
  name: string;
  country_code: string | null;
  start_date: string;
  end_date: string;
  override: string | null;
  is_open: boolean;
}

interface ChangeWindowOut {
  open: boolean;
  text: string;
  life_event_id: string | null;
}

interface LifeEventOut {
  id: string;
  employee_id: string;
  event_type: string;
  event_date: string;
  window_ends: string;
  status: string;
  created_at: string;
}

interface DependentOut {
  id: string;
  employee_id: string;
  name: string;
  relationship: string;
  date_of_birth: string;
  gender: string | null;
  verification: string;
  verified_by: string | null;
  verified_at: string | null;
  covered_plan_ids: string[];
}

interface EnrollmentOut {
  id: string;
  employee_id: string;
  employee_name: string | null;
  plan_id: string;
  plan_name: string | null;
  status: string;
  effective_date: string | null;
  life_event_id: string | null;
  dependent_ids: string[];
  created_at: string;
}

interface NomineeOut {
  id: number;
  nomination_for: string;
  name: string;
  relationship: string;
  share_pct: number;
  date_of_birth: string | null;
}

/* ───────── Portal-side extras ───────── */

export interface Nominee {
  nominationFor: string;
  name: string;
  relationship: string;
  sharePct: number;
  dateOfBirth?: string;
}

export interface ApiBenefitsExtra {
  plans: BenefitPlan[];
  /** Plan id → your eligibility. */
  eligibility: Record<string, { eligible: boolean; reason: string }>;
  rules: Record<string, string[]>;
  changeWindow: { open: boolean; text: string; lifeEventId?: string };
  windowId: string | null;
  nominees: Nominee[];
  /** Enrollment ids HR (or the line manager) can decide; dependent ids they can verify. */
  decidableEnrollments: string[];
  verifiableDependents: string[];
}

export interface ApiCompData {
  cycles: CompCycle[];
  bands: GradeBand[];
  reviews: CompProposal[];
  history: CompHistoryRow[];
  bonuses: BonusRecord[];
  payRole: boolean;
}

export interface ApiBenefitsData {
  enrollments: BenefitEnrollment[];
  dependents: Dependent[];
  lifeEvents: LifeEvent[];
  openEnrollment: EnrollmentWindow;
  extra: ApiBenefitsExtra;
}

const PAY_ROLES = new Set(["hr", "hr_admin", "hrbp", "compensation"]);
const HR_ROLES = new Set(["hr", "hr_admin", "hrbp"]);

let meCache: { accountId: string; me: MeOut } | null = null;

/** The signed-in API account (cached per session). */
export async function apiMe(accountId: string): Promise<MeOut> {
  if (meCache?.accountId === accountId) return meCache.me;
  const me = await api.get<MeOut>("/auth/me");
  meCache = { accountId, me };
  return me;
}

export function forgetApiMe() {
  meCache = null;
}

/* ───────── Compensation ───────── */

const CYCLE_STATUS: Record<string, CompCycle["status"]> = { planning: "Planning", open: "Open", closed: "Closed" };

function toCycle(c: CompCycleOut): CompCycle {
  return {
    id: c.id,
    name: c.name,
    status: CYCLE_STATUS[c.status] ?? "Planning",
    window: `${formatShortDate(c.opens_on)} – ${formatShortDate(c.closes_on)}`,
    countries: (c.countries ?? TIMEZ_COUNTRIES.map((x) => x.code)).map(countryName),
    effectiveDate: c.effective_date,
    budgetPct: c.budget_pct,
    opensOn: c.opens_on,
    closesOn: c.closes_on,
    acceptingProposals: c.accepting_proposals,
    budgetUsedPct: c.budget_used_pct ?? undefined,
    proposalCount: c.proposals ?? undefined,
  };
}

function toBand(b: GradeBandOut): GradeBand {
  return {
    id: b.id,
    grade: b.grade,
    family: "All",
    country: countryName(b.country_code),
    currency: b.currency,
    min: money(b.min_amount, b.currency),
    mid: money(b.mid_amount, b.currency),
    max: money(b.max_amount, b.currency),
  };
}

export function toHistoryRows(h: CompHistoryOut): CompHistoryRow[] {
  return h.records.map((r) => ({
    id: r.id,
    employeeId: r.employee_id,
    employeeName: h.employee_name,
    effective: r.effective_date,
    event: r.reason,
    grade: r.grade,
    base: money(r.base_salary, r.currency),
    currency: r.currency,
  }));
}

const BONUS_STATUS: Record<string, BonusRecord["status"]> = { accrued: "Accrued", paid: "Paid", forfeited: "Forfeited" };

function toBonus(b: CompBonusOut): BonusRecord {
  return {
    id: b.id,
    employeeId: b.employee_id,
    employeeName: nameOf(b.employee_id),
    type: b.bonus_type,
    period: b.period,
    amount: money(b.amount, b.currency),
    currency: b.currency,
    status: BONUS_STATUS[b.status] ?? "Accrued",
  };
}

const ROLE_LABEL: Record<string, string> = {
  hr: "HR",
  hr_admin: "HR",
  hrbp: "HRBP",
  finance: "Finance",
  admin: "Admin",
  executive: "Executive",
  manager: "Manager",
  line_manager: "Line manager",
  compensation: "Compensation",
};

function approvalText(inst: ApprovalInstanceOut): string {
  const parts: string[] = [];
  inst.steps.forEach((step, index) => {
    if (step.skipped) return;
    const label = step.roles.map((r) => ROLE_LABEL[r] ?? r).join(" or ");
    const done = inst.decisions.filter((d) => d.step === index);
    const names = done.map((d) => nameOf(d.approver_id)).join(", ");
    if (done.some((d) => d.decision === "rejected" || d.decision === "reject")) parts.push(`${label} ✗ ${names}`);
    else if (inst.status === "pending" && index === inst.current_step) parts.push(`${label} (waiting${names ? `; ✓ ${names}` : ""})`);
    else if (done.length) parts.push(`${label} ✓ ${names}`);
    else parts.push(label);
  });
  return parts.join(" · ") || "—";
}

function toProposal(p: CompProposalOut, canDecide: boolean, approval?: ApprovalInstanceOut): CompProposal {
  const status: CompProposal["status"] =
    p.status === "approved" ? "Approved" : p.status === "rejected" || p.status === "withdrawn" ? "Rejected" : "Pending approval";
  const decidedBy = approval?.decisions.length ? approval.decisions[approval.decisions.length - 1]!.approver_id : null;
  return {
    id: p.id,
    cycleId: p.cycle_id,
    employeeId: p.employee_id,
    employeeName: p.employee_name ?? nameOf(p.employee_id),
    managerId: p.proposed_by,
    managerName: nameOf(p.proposed_by),
    currentGrade: p.current_grade,
    proposedGrade: p.proposed_grade,
    currentBase: money(p.current_base, p.currency),
    proposedBase: money(p.proposed_base, p.currency),
    proposedIncreasePct: p.increase_pct,
    currency: p.currency,
    status,
    bonusProposal: money(p.bonus_amount, p.currency),
    approver: p.status === "pending" || !decidedBy ? undefined : nameOf(decidedBy),
    decidedOn: p.decided_at ? day(p.decided_at) : undefined,
    payVisible: p.pay_visible,
    canDecide,
    statusLabel: p.status === "withdrawn" ? "Withdrawn" : undefined,
    approvalText: approval ? approvalText(approval) : p.approval_status ?? "—",
  };
}

async function loadProposals(payRole: boolean): Promise<CompProposal[]> {
  const [mine, toDecide, all] = await Promise.all([
    orElse(api.get<CompProposalOut[]>("/compensation/proposals", { view: "mine" }), []),
    orElse(api.get<CompProposalOut[]>("/compensation/proposals", { view: "to_decide" }), []),
    payRole ? orElse(api.get<CompProposalOut[]>("/compensation/proposals", { view: "all" }), []) : Promise.resolve([]),
  ]);
  const byId = new Map<string, CompProposalOut>();
  [...all, ...mine, ...toDecide].forEach((p) => byId.set(p.id, p));
  const waiting = new Set(toDecide.map((p) => p.id));
  const rows = [...byId.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const approvals = await Promise.all(
    rows.slice(0, 40).map((p) =>
      p.approval_instance_id ? orElse(api.get<ApprovalInstanceOut>(`/approvals/${enc(p.approval_instance_id)}`), undefined) : Promise.resolve(undefined),
    ),
  );
  return rows.map((p, i) => toProposal(p, waiting.has(p.id), approvals[i]));
}

/** Everything on the Compensation page for this account. */
export async function loadApiComp(accountId: string): Promise<ApiCompData> {
  const me = await apiMe(accountId);
  const payRole = PAY_ROLES.has(me.role);
  const [cycles, bands, mine, myBonuses, current, reviews] = await Promise.all([
    orElse(api.get<CompCycleOut[]>("/compensation/cycles"), []),
    orElse(api.get<GradeBandOut[]>("/compensation/grade-bands"), []),
    orElse(api.get<CompHistoryOut | null>("/compensation/records"), null),
    orElse(api.get<CompBonusOut[]>("/compensation/bonuses"), []),
    payRole ? orElse(api.get<CompRecordOut[]>("/compensation/records/current", { limit: 200 }), []) : Promise.resolve([]),
    loadProposals(payRole),
  ]);
  const history: CompHistoryRow[] = mine ? toHistoryRows(mine) : [];
  const bonuses: BonusRecord[] = myBonuses.map(toBonus);
  // HR / compensation: everyone in scope (history and bonuses per person; capped to keep the load small).
  const others = [...new Set(current.map((r) => r.employee_id))].filter((id) => id !== me.employee_id).slice(0, 40);
  const extra = await Promise.all(
    others.map(async (id) => {
      const [h, b] = await Promise.all([
        orElse(api.get<CompHistoryOut | null>("/compensation/records", { employee_id: id }), null),
        orElse(api.get<CompBonusOut[]>("/compensation/bonuses", { employee_id: id }), []),
      ]);
      return { h, b };
    }),
  );
  for (const { h, b } of extra) {
    if (h) history.push(...toHistoryRows(h));
    bonuses.push(...b.map(toBonus));
  }
  return {
    cycles: cycles.map(toCycle),
    bands: bands.map(toBand),
    reviews,
    history: history.sort((a, b) => b.effective.localeCompare(a.effective)),
    bonuses,
    payRole,
  };
}

/** One person's pay history, or "Not available" when you can't see it. */
export async function fetchPayHistory(employeeId?: string): Promise<{ data: CompHistoryOut | null; error: string | null }> {
  try {
    const data = await api.get<CompHistoryOut>("/compensation/records", employeeId ? { employee_id: employeeId } : undefined);
    return { data, error: null };
  } catch (error) {
    const status = (error as { status?: number }).status;
    return { data: null, error: status === 403 || status === 404 ? "Not available" : (error as Error).message };
  }
}

export async function fetchStatement(year?: number): Promise<CompStatementOut | null> {
  return orElse(api.get<CompStatementOut>("/compensation/statement", year ? { year } : undefined), null);
}

export function apiCreateCycle(input: { name: string; effectiveDate: string; budgetPct: number; opensOn: string; closesOn: string; countries: string[] }): Promise<Outcome> {
  return attempt(() =>
    api.post("/compensation/cycles", {
      name: input.name.trim(),
      effective_date: input.effectiveDate,
      budget_pct: input.budgetPct,
      opens_on: input.opensOn,
      closes_on: input.closesOn,
      countries: input.countries.map(countryCode),
      status: "open",
    }),
  );
}

export function apiSetCycleStatus(id: string, status: "Open" | "Closed"): Promise<Outcome> {
  return attempt(() => api.post(`/compensation/cycles/${enc(id)}/status`, { status: status.toLowerCase() }));
}

export function apiCreateProposal(input: { cycleId: string; employeeId: string; increasePct: number; proposedGrade?: string; bonus?: number; justification?: string }): Promise<Outcome> {
  return attempt(() =>
    api.post("/compensation/proposals", {
      cycle_id: input.cycleId,
      employee_id: input.employeeId,
      increase_pct: input.increasePct,
      proposed_grade: input.proposedGrade?.trim() || null,
      bonus_amount: input.bonus || null,
      justification: input.justification?.trim() || null,
    }),
  );
}

export function apiDecideProposal(id: string, decision: "approve" | "reject"): Promise<Outcome> {
  return attempt(() => api.post(`/compensation/proposals/${enc(id)}/decision`, { decision }));
}

export function apiWithdrawProposal(id: string): Promise<Outcome> {
  return attempt(() => api.post(`/compensation/proposals/${enc(id)}/withdraw`));
}

export function apiUpdateBand(id: string, input: { min: number; mid: number; max: number }): Promise<Outcome> {
  return attempt(() =>
    apiRequest(`/compensation/grade-bands/${enc(id)}`, { method: "PUT", body: { min_amount: input.min, mid_amount: input.mid, max_amount: input.max } }),
  );
}

export function apiAddBonus(input: { employeeId: string; type: string; period: string; amount: number }): Promise<Outcome> {
  return attempt(() =>
    api.post("/compensation/bonuses", { employee_id: input.employeeId, bonus_type: input.type.trim(), period: input.period.trim(), amount: input.amount }),
  );
}

export function apiSetBonusStatus(id: string, status: "Paid" | "Forfeited"): Promise<Outcome> {
  return attempt(() => api.post(`/compensation/bonuses/${enc(id)}/status`, { status: status.toLowerCase() }));
}

/* ───────── Benefits ───────── */

function toPlan(p: BenefitPlanOut): BenefitPlan {
  return {
    id: p.id,
    country: countryName(p.country_code),
    name: p.name,
    category: p.plan_type,
    provider: p.provider,
    summary: p.summary,
    employeeCost: p.employee_cost,
    documents: [],
    mandatory: p.mandatory,
    autoEnrolled: p.auto_enrolled,
    coversDependents: p.covers_dependents,
    eligibility: {
      excludeEmploymentTypes: p.eligibility.exclude_employment_types,
      minServiceMonths: p.eligibility.min_service_months,
      grades: p.eligibility.grades,
    },
  };
}

const ENROLL_STATUS: Record<string, BenefitEnrollment["status"]> = { requested: "Pending", approved: "Enrolled", waived: "Waived" };
const VERIFICATION: Record<string, Dependent["verification"]> = { pending: "Pending", verified: "Verified", rejected: "Rejected" };

export async function loadApiBenefits(accountId: string): Promise<ApiBenefitsData> {
  const me = await apiMe(accountId);
  const hr = HR_ROLES.has(me.role);
  const ownCode = me.country_code ?? "";
  const planCountries = hr ? TIMEZ_COUNTRIES.map((c) => c.code) : [ownCode];
  const [planLists, windows, changeWindow, lifeEvents, myDeps, queue, mine, toDecide, all, nominees] = await Promise.all([
    Promise.all(planCountries.map((code) => orElse(api.get<BenefitPlanOut[]>("/benefits/plans", hr ? { country: code } : undefined), []))),
    orElse(api.get<WindowOut[]>("/benefits/windows"), []),
    orElse(api.get<ChangeWindowOut>("/benefits/change-window"), { open: false, text: "", life_event_id: null }),
    orElse(api.get<LifeEventOut[]>("/benefits/life-events"), []),
    orElse(api.get<DependentOut[]>("/benefits/dependents"), []),
    orElse(api.get<DependentOut[]>("/benefits/dependents", { verification: "pending" }), []),
    orElse(api.get<EnrollmentOut[]>("/benefits/enrollments", { view: "mine" }), []),
    orElse(api.get<EnrollmentOut[]>("/benefits/enrollments", { view: "to_decide" }), []),
    hr ? orElse(api.get<EnrollmentOut[]>("/benefits/enrollments", { view: "all" }), []) : Promise.resolve([]),
    orElse(api.get<NomineeOut[]>("/benefits/beneficiaries"), []),
  ]);
  const planOuts = planLists.flat();
  const plans = planOuts.map(toPlan);
  const planName = new Map(planOuts.map((p) => [p.id, p.name]));
  const planCountry = new Map(planOuts.map((p) => [p.id, countryName(p.country_code)]));
  const ownPlans = planOuts.filter((p) => p.country_code === ownCode);
  const checks = await Promise.all(ownPlans.map((p) => orElse(api.get<EligibilityOut>(`/benefits/plans/${enc(p.id)}/eligibility`), null)));

  const eligibility: ApiBenefitsExtra["eligibility"] = {};
  checks.forEach((c) => {
    if (c) eligibility[c.plan_id] = { eligible: c.eligible, reason: c.reason };
  });
  const rules: ApiBenefitsExtra["rules"] = {};
  planOuts.forEach((p) => {
    rules[p.id] = p.rules;
  });

  const enrollById = new Map<string, EnrollmentOut>();
  [...all, ...mine, ...toDecide].forEach((e) => enrollById.set(e.id, e));
  const enrollments: BenefitEnrollment[] = [...enrollById.values()].map((e) => ({
    id: e.id,
    employeeId: e.employee_id,
    employeeName: e.employee_name ?? nameOf(e.employee_id),
    planId: e.plan_id,
    planName: e.plan_name ?? planName.get(e.plan_id) ?? e.plan_id,
    country: planCountry.get(e.plan_id) ?? countryName(ownCode),
    status: ENROLL_STATUS[e.status] ?? "Eligible",
    effective: e.effective_date ?? day(e.created_at),
    lifeEventId: e.life_event_id ?? undefined,
  }));

  const depById = new Map<string, DependentOut>();
  [...queue, ...myDeps].forEach((d) => depById.set(d.id, d));
  const dependents: Dependent[] = [...depById.values()].map((d) => ({
    id: d.id,
    employeeId: d.employee_id,
    name: d.name,
    relationship: d.relationship,
    dateOfBirth: d.date_of_birth,
    gender: d.gender ?? undefined,
    coveredPlans: d.covered_plan_ids.map((id) => planName.get(id) ?? id),
    verification: VERIFICATION[d.verification] ?? "Pending",
    verifiedBy: d.verified_by ? nameOf(d.verified_by) : undefined,
    verifiedOn: d.verified_at ? day(d.verified_at) : undefined,
  }));

  const win = windows.find((w) => w.is_open && (!w.country_code || w.country_code === ownCode)) ?? windows.find((w) => !w.country_code || w.country_code === ownCode) ?? windows[0];
  const openEnrollment: EnrollmentWindow = win
    ? {
        year: Number(win.end_date.slice(0, 4)) + (Number(win.end_date.slice(5, 7)) >= 10 ? 1 : 0),
        start: win.start_date,
        end: win.end_date,
        override: win.override === "open" || win.override === "closed" ? win.override : undefined,
      }
    : { year: new Date().getFullYear(), start: "", end: "" };

  return {
    enrollments,
    dependents,
    lifeEvents: lifeEvents.map((e) => ({
      id: e.id,
      employeeId: e.employee_id,
      employeeName: nameOf(e.employee_id),
      type: e.event_type,
      eventDate: e.event_date,
      raisedOn: day(e.created_at),
      windowEnds: e.window_ends,
      status: e.status === "open" ? "Open" : "Closed",
    })),
    openEnrollment,
    extra: {
      plans,
      eligibility,
      rules,
      changeWindow: { open: changeWindow.open, text: changeWindow.text, lifeEventId: changeWindow.life_event_id ?? undefined },
      windowId: win?.id ?? null,
      nominees: nominees.map((n) => ({
        nominationFor: n.nomination_for,
        name: n.name,
        relationship: n.relationship,
        sharePct: n.share_pct,
        dateOfBirth: n.date_of_birth ?? undefined,
      })),
      decidableEnrollments: toDecide.map((e) => e.id),
      verifiableDependents: hr ? queue.map((d) => d.id) : [],
    },
  };
}

export function apiSetWindowDates(windowId: string | null, start: string, end: string): Promise<Outcome> {
  if (!windowId) return attempt(() => api.post("/benefits/windows", { name: `Open enrollment ${end.slice(0, 4)}`, start_date: start, end_date: end }));
  return attempt(() => apiRequest(`/benefits/windows/${enc(windowId)}`, { method: "PATCH", body: { start_date: start, end_date: end, override: "dates" } }));
}

export function apiSetWindowOverride(windowId: string | null, override: "open" | "closed" | null): Promise<Outcome> {
  if (!windowId) return Promise.resolve("No enrollment window is set up yet.");
  return attempt(() => apiRequest(`/benefits/windows/${enc(windowId)}`, { method: "PATCH", body: { override: override ?? "dates" } }));
}

export function apiRaiseLifeEvent(type: string, eventDate: string): Promise<Outcome> {
  return attempt(() => api.post("/benefits/life-events", { event_type: type, event_date: eventDate }));
}

export function apiCloseLifeEvent(id: string): Promise<Outcome> {
  return attempt(() => api.post(`/benefits/life-events/${enc(id)}/close`));
}

type DependentBody = { name: string; relationship: string; dateOfBirth: string; gender?: string };
const depBody = (d: DependentBody) => ({ name: d.name.trim(), relationship: d.relationship, date_of_birth: d.dateOfBirth, gender: d.gender || null });

export function apiAddDependent(input: DependentBody): Promise<Outcome> {
  return attempt(() => api.post("/benefits/dependents", depBody(input)));
}

export function apiUpdateDependent(id: string, input: DependentBody): Promise<Outcome> {
  return attempt(() => apiRequest(`/benefits/dependents/${enc(id)}`, { method: "PUT", body: depBody(input) }));
}

export function apiRemoveDependent(id: string): Promise<Outcome> {
  return attempt(() => apiRequest(`/benefits/dependents/${enc(id)}`, { method: "DELETE" }));
}

export function apiVerifyDependent(id: string, status: "Verified" | "Rejected"): Promise<Outcome> {
  return attempt(() => api.post(`/benefits/dependents/${enc(id)}/verification`, { status: status.toLowerCase() }));
}

export function apiSetCoverage(enrollmentId: string, dependentIds: string[]): Promise<Outcome> {
  return attempt(() => apiRequest(`/benefits/enrollments/${enc(enrollmentId)}/dependents`, { method: "PUT", body: { dependent_ids: dependentIds } }));
}

export function apiRequestEnrollment(planId: string, dependentIds: string[] = []): Promise<Outcome> {
  return attempt(() => api.post("/benefits/enrollments", { plan_id: planId, dependent_ids: dependentIds }));
}

export function apiDecideEnrollment(id: string, decision: "approve" | "waive"): Promise<Outcome> {
  return attempt(() => api.post(`/benefits/enrollments/${enc(id)}/decision`, { decision }));
}

export function apiSetNominees(nominationFor: string, nominees: Nominee[]): Promise<Outcome> {
  return attempt(() =>
    apiRequest("/benefits/beneficiaries", {
      method: "PUT",
      body: {
        nomination_for: nominationFor.trim() || "General",
        nominees: nominees.map((n) => ({
          name: n.name.trim(),
          relationship: n.relationship.trim(),
          share_pct: n.sharePct,
          date_of_birth: n.dateOfBirth || null,
        })),
      },
    }),
  );
}

/* ───────── Letters (backend/app/routers/documents.py letters_router) ───────── */

interface LetterIssueOut {
  id: string;
  version: number;
  reference_no: string;
  document_version_id: string;
  approved_by: string | null;
  created_at: string;
}

interface LetterRequestOut {
  id: string;
  employee_id: string;
  employee_name: string | null;
  letter_type: string;
  status: string;
  requested_by: string;
  note: string;
  details: string | null;
  effective_date: string | null;
  approval_instance_id: string | null;
  approval_status: string | null;
  document_id: string | null;
  issue_error: string | null;
  issued_at: string | null;
  created_at: string;
  issues: LetterIssueOut[];
}

export interface LetterPreviewOut {
  letter_type: string;
  fields: Record<string, string>;
  missing: string[];
  title: string;
  paragraphs: string[];
}

const LETTER_STATUS: Record<string, LetterStatus> = {
  pending: "Pending approval",
  approved: "Approved",
  issued: "Issued",
  rejected: "Rejected",
  cancelled: "Cancelled",
};

function toLetter(r: LetterRequestOut, me: MeOut, waiting: Set<string>): LetterRequest {
  const status = LETTER_STATUS[r.status] ?? "Pending approval";
  const last = r.issues[r.issues.length - 1];
  const info: ApiLetterInfo = {
    issues: r.issues.map((i) => ({ version: i.version, referenceNo: i.reference_no, on: day(i.created_at) })),
    canDecide: waiting.has(r.id) && r.status === "pending",
    canIssue: HR_ROLES.has(me.role) && r.employee_id !== me.employee_id && (r.status === "approved" || r.status === "issued"),
    canCancel: r.requested_by === me.employee_id && r.status === "pending",
    issueError: r.issue_error ?? undefined,
  };
  return {
    id: r.id,
    employeeId: r.employee_id,
    employeeName: r.employee_name ?? nameOf(r.employee_id),
    type: r.letter_type as LetterType,
    status,
    requestedBy: nameOf(r.requested_by),
    requestedById: r.requested_by,
    requestedOn: day(r.created_at),
    approver: last?.approved_by ? nameOf(last.approved_by) : undefined,
    decidedOn: r.issued_at ? day(r.issued_at) : undefined,
    note: r.note,
    previewBody: "",
    details: r.details ?? undefined,
    effectiveDate: r.effective_date ?? undefined,
    api: info,
  };
}

/** Letter requests this account can see: about or by them, waiting on them, and (HR) everyone in scope. */
export async function loadApiLetters(accountId: string): Promise<LetterRequest[]> {
  const me = await apiMe(accountId);
  const hr = HR_ROLES.has(me.role);
  const [mine, toDecide, all] = await Promise.all([
    orElse(api.get<LetterRequestOut[]>("/letters/requests", { view: "mine" }), []),
    orElse(api.get<LetterRequestOut[]>("/letters/requests", { view: "to_decide" }), []),
    hr ? orElse(api.get<LetterRequestOut[]>("/letters/requests", { view: "all" }), []) : Promise.resolve([]),
  ]);
  const byId = new Map<string, LetterRequestOut>();
  [...all, ...mine, ...toDecide].forEach((r) => byId.set(r.id, r));
  const waiting = new Set(toDecide.map((r) => r.id));
  return [...byId.values()].sort((a, b) => b.created_at.localeCompare(a.created_at)).map((r) => toLetter(r, me, waiting));
}

export function apiRequestLetter(input: { employeeId: string; type: string; note: string; details?: string; effectiveDate?: string }): Promise<Outcome> {
  return attempt(() =>
    api.post("/letters/requests", {
      employee_id: input.employeeId,
      letter_type: input.type,
      note: input.note.trim(),
      details: input.details?.trim() || null,
      effective_date: input.effectiveDate || null,
    }),
  );
}

export function apiDecideLetter(id: string, decision: "approve" | "reject", note?: string): Promise<Outcome> {
  return attempt(() => api.post(`/letters/requests/${enc(id)}/decision`, { decision, note: note?.trim() || null }));
}

export function apiIssueLetter(id: string): Promise<Outcome> {
  return attempt(() => api.post(`/letters/requests/${enc(id)}/issue`));
}

export function apiCancelLetter(id: string): Promise<Outcome> {
  return attempt(() => api.post(`/letters/requests/${enc(id)}/cancel`));
}

export async function fetchLetterPreview(id: string): Promise<{ data: LetterPreviewOut | null; error: string | null }> {
  try {
    return { data: await api.get<LetterPreviewOut>(`/letters/requests/${enc(id)}/preview`), error: null };
  } catch (error) {
    return { data: null, error: (error as Error).message || "Preview not available." };
  }
}

/** Saves (or opens) the issued PDF; the latest version unless one is given. */
export function downloadLetterPdf(id: string, fileName: string, version?: number, mode: "save" | "open" = "save"): Promise<Outcome> {
  return fetchFile(`/letters/requests/${enc(id)}/download${version ? `?version=${version}` : ""}`, fileName, mode);
}

/* ───────── Document repository (/documents) ───────── */

export interface DocVersion {
  id: string;
  version: number;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  uploadedBy: string;
  on: string;
}

export interface RepoDocument {
  id: string;
  employeeId: string;
  employeeName: string;
  category: string;
  title: string;
  currentVersion: number;
  expiryDate?: string;
  daysToExpiry?: number;
  letterRequestId?: string;
  uploadedBy: string;
  updatedOn: string;
  versions: DocVersion[];
}

export interface DocRules {
  categories: string[];
  managerCategories: string[];
  maxBytes: number;
  contentTypes: string[];
}

interface DocVersionOut {
  id: string;
  version: number;
  file_name: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  uploaded_by: string | null;
  created_at: string;
}

interface EmployeeDocumentOut {
  id: string;
  employee_id: string;
  employee_name: string | null;
  category: string;
  title: string;
  current_version: number;
  expiry_date: string | null;
  letter_request_id: string | null;
  uploaded_by: string | null;
  created_at: string;
  updated_at: string;
  days_to_expiry: number | null;
  versions: DocVersionOut[];
}

function toDocument(d: EmployeeDocumentOut): RepoDocument {
  return {
    id: d.id,
    employeeId: d.employee_id,
    employeeName: d.employee_name ?? nameOf(d.employee_id),
    category: d.category,
    title: d.title,
    currentVersion: d.current_version,
    expiryDate: d.expiry_date ?? undefined,
    daysToExpiry: d.days_to_expiry ?? undefined,
    letterRequestId: d.letter_request_id ?? undefined,
    uploadedBy: nameOf(d.uploaded_by),
    updatedOn: day(d.updated_at),
    versions: (d.versions ?? []).map((v) => ({
      id: v.id,
      version: v.version,
      fileName: v.file_name,
      contentType: v.content_type,
      sizeBytes: v.size_bytes,
      uploadedBy: nameOf(v.uploaded_by),
      on: day(v.created_at),
    })),
  };
}

const FALLBACK_RULES: DocRules = {
  categories: ["Identity", "Education", "Employment", "Certifications", "Compliance", "Medical", "Payroll", "Letters", "Other"],
  managerCategories: [],
  maxBytes: 10 * 1024 * 1024,
  contentTypes: ["application/pdf", "image/png", "image/jpeg", "image/webp", "image/gif"],
};

export async function fetchDocRules(): Promise<DocRules> {
  const out = await orElse(
    api.get<{ categories: string[]; manager_categories: string[]; max_bytes: number; content_types: string[] }>("/documents/rules"),
    null,
  );
  return out ? { categories: out.categories, managerCategories: out.manager_categories, maxBytes: out.max_bytes, contentTypes: out.content_types } : FALLBACK_RULES;
}

/** One person's documents (yourself by default). */
export async function fetchDocuments(employeeId?: string): Promise<{ data: RepoDocument[]; error: string | null }> {
  try {
    const rows = await api.get<EmployeeDocumentOut[]>("/documents", employeeId ? { employee_id: employeeId } : undefined);
    return { data: rows.map(toDocument), error: null };
  } catch (error) {
    return { data: [], error: (error as Error).message || "Documents not available." };
  }
}

/** Full document with every version. */
export async function fetchDocument(id: string): Promise<RepoDocument | null> {
  return orElse(api.get<EmployeeDocumentOut>(`/documents/${enc(id)}`).then(toDocument), null);
}

/** Documents expiring within `days` (and already expired) that you may see. */
export async function fetchExpiringDocuments(days = 60): Promise<RepoDocument[]> {
  return (await orElse(api.get<EmployeeDocumentOut[]>("/documents/expiring", { days }), [])).map(toDocument);
}

export function checkDocFile(file: File, rules: DocRules): string | null {
  if (file.size > rules.maxBytes) return `The file is larger than ${Math.round(rules.maxBytes / (1024 * 1024))} MB.`;
  if (!rules.contentTypes.includes(fileType(file))) return "Upload a PDF, Word (.docx) or image file.";
  return null;
}

function uploadQuery(params: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v) q.set(k, v);
  });
  const text = q.toString();
  return text ? `?${text}` : "";
}

/** A new document (version 1). The file goes as the raw request body. */
export function apiUploadDocument(file: File, input: { category: string; title: string; employeeId?: string; expiryDate?: string }): Promise<Outcome> {
  return attempt(() =>
    authorizedFetch(
      `/documents${uploadQuery({ category: input.category, title: input.title.trim(), employee_id: input.employeeId, expiry_date: input.expiryDate, filename: file.name })}`,
      { method: "POST", headers: { "Content-Type": fileType(file), Accept: "application/json" }, body: file },
    ),
  );
}

export function apiUploadVersion(documentId: string, file: File, expiryDate?: string): Promise<Outcome> {
  return attempt(() =>
    authorizedFetch(`/documents/${enc(documentId)}/versions${uploadQuery({ expiry_date: expiryDate, filename: file.name })}`, {
      method: "POST",
      headers: { "Content-Type": fileType(file), Accept: "application/json" },
      body: file,
    }),
  );
}

export function apiSetDocumentExpiry(documentId: string, expiryDate: string | null): Promise<Outcome> {
  return attempt(() => apiRequest(`/documents/${enc(documentId)}`, { method: "PATCH", body: { expiry_date: expiryDate || null } }));
}

export function downloadDocument(documentId: string, fileName: string, version?: number, mode: "save" | "open" = "save"): Promise<Outcome> {
  return fetchFile(`/documents/${enc(documentId)}/download${version ? `?version=${version}` : ""}`, fileName, mode);
}

/* ───────── Policy acknowledgements (/documents/policy-acks) ───────── */

export interface PolicyAckOut {
  id: number;
  employee_id: string;
  policy_id: string;
  policy_version: string;
  acknowledged_at: string;
}

/** Your acknowledgements, or (HR) everyone's in scope for one policy. */
export function fetchPolicyAcks(policyId?: string): Promise<PolicyAckOut[]> {
  return orElse(api.get<PolicyAckOut[]>("/documents/policy-acks", policyId ? { policy_id: policyId } : undefined), []);
}

export function apiAcknowledgePolicy(policyId: string, version: string): Promise<Outcome> {
  return attempt(() => api.post("/documents/policy-acks", { policy_id: policyId, policy_version: version }));
}
