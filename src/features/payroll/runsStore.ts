/**
 * Monthly payroll runs: browser store (local mode) or the backend (/payroll/runs, VITE_API_URL mode).
 * Draft → Review → Locked: HR or an admin prepares and sends for review; a second person (finance, the executive,
 * another HR or an admin — never whoever prepared or sent it) approves, which locks it. Locked runs never change,
 * and the payslips for that month come from the run (setPayslipRunSource); other months are still generated.
 */
import { api, API_ENABLED, apiSessionMe } from "../../api/client.ts";
import { apiRun, createApiMirror } from "../../api/syncOps.ts";
import { legalEntityFor, payRulesFor } from "../../countryPay.ts";
import { DEMO_ACCOUNTS } from "../../demoAccounts.ts";
import { payslipAnnualBase } from "../../data/annualPay.ts";
import { extraDeductionLines, paydayFor, setPayslipRunSource, type GeneratedPayslip } from "../../data/payslipGenerator.ts";
import { getExitDetails, listPeople } from "../../data/peopleLocal.ts";
import { getTaxRegime } from "../../data/taxRegime.ts";
import { holidaySet, holidaysForPerson, todayISO, uid, workingDays, type CountryCode, type PortalState } from "../../model.ts";
import { createLocalStore } from "../payrequests/localStore.ts";
import { payoutMonth, perDayPay } from "../payrequests/rules.ts";
import { notify } from "../workforce/workforceShared.ts";
import { localPayableOvertime, markOvertimePaid, setOvertimeClosedMonthCheck } from "../overtime/overtimeStore.ts";
import {
  bankCsv,
  computeLine,
  monthEnd,
  registerCsv,
  totalsOf,
  type BankRow,
  type RunException,
  type RunLine,
  type RunPerson,
  type RunStatus,
  type RunTotals,
} from "./runCalc.ts";

export const PREPARE_ROLES = new Set(["hr_admin", "hr", "hrbp", "admin", "super_admin"]);
export const APPROVE_ROLES = new Set(["hr_admin", "hr", "hrbp", "admin", "super_admin", "finance", "executive"]);

export interface RunView {
  id: string;
  month: string;
  countryCode: string;
  legalEntity: string;
  currency: string;
  status: RunStatus;
  headcount: number;
  totals: Partial<RunTotals>;
  exceptions: RunException[];
  preparedBy?: string;
  preparedAt?: string;
  submittedBy?: string;
  submittedAt?: string;
  approvedBy?: string;
  approvedAt?: string;
  returnedNote?: string;
  payday?: string;
  canPrepare: boolean;
  canSubmit: boolean;
  canApprove: boolean;
  lines?: RunLine[];
}

export interface Entity {
  countryCode: string;
  legalEntity: string;
  currency: string;
}

type Actor = { id: string; fullName: string; role: string };

/* ───────────── Local runs ───────────── */

interface LocalRun extends Omit<RunView, "canPrepare" | "canSubmit" | "canApprove" | "preparedBy" | "submittedBy" | "approvedBy"> {
  preparedById?: string;
  submittedById?: string;
  approvedById?: string;
  lines: RunLine[];
}

const local = createLocalStore<{ runs: LocalRun[] }>("timez.payrollRuns.v1", () => ({ runs: [] }), (saved) =>
  saved && Array.isArray((saved as { runs?: unknown }).runs) ? (saved as { runs: LocalRun[] }) : null,
);

const nameOf = (id?: string) => (id ? (DEMO_ACCOUNTS.find((a) => a.id === id)?.fullName ?? id) : undefined);

function localView(run: LocalRun, actor: Actor, withLines: boolean): RunView {
  const { preparedById, submittedById, approvedById, lines, ...rest } = run;
  const canPrep = PREPARE_ROLES.has(actor.role);
  return {
    ...rest,
    preparedBy: nameOf(preparedById),
    submittedBy: nameOf(submittedById),
    approvedBy: nameOf(approvedById),
    canPrepare: run.status === "draft" && canPrep,
    canSubmit: run.status === "draft" && canPrep && run.headcount > 0,
    canApprove: run.status === "review" && APPROVE_ROLES.has(actor.role) && actor.id !== preparedById && actor.id !== submittedById,
    ...(withLines ? { lines } : {}),
  };
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Local sample bank details: everyone except about one in 37 (never a sign-in person). */
function localBank(employeeId: string, name: string, employeeCode: string, country: string): BankRow | null {
  const persona = DEMO_ACCOUNTS.some((a) => a.id === employeeId);
  if (!persona && hash(employeeId) % 37 === 0) return null;
  const digits = String(hash(`${employeeId}:acct`)).padStart(10, "0") + String(hash(`${employeeId}:b`)).slice(0, 4);
  const banks: Record<string, [string, string]> = {
    IN: ["HDFC Bank", "HDFC0001234"], US: ["Chase", "021000021"], GB: ["Barclays", "20-00-00"], AU: ["Commonwealth Bank", "062-000"],
    CA: ["RBC Royal Bank", "00003-003"], AE: ["Emirates NBD", "EBILAEAD"], SA: ["Al Rajhi Bank", "RJHISARI"], DE: ["Deutsche Bank", "DEUTDEFF"],
  };
  const [bankName, bankCode] = banks[country] ?? banks.IN;
  return { employeeCode, name, accountName: name, accountNumber: digits.slice(0, 14), bankCode, bankName };
}

/** Local mode: the people on a payroll and their inputs, from this browser's directory and requests. */
function localInputs(state: PortalState, country: string, entity: string, month: string): RunPerson[] {
  const start = `${month}-01`;
  const end = monthEnd(month);
  const days = Number(end.slice(8, 10));
  return listPeople()
    .filter((p) => p.countryCode === country && (p.legalEntity || legalEntityFor(p.countryCode as CountryCode)) === entity)
    .map((p) => ({ p, lwd: p.lastWorkingDay ?? getExitDetails(p).exitDate }))
    .filter(({ p, lwd }) => p.dateOfJoining && p.dateOfJoining <= end && !(lwd && lwd < start) && !(p.employmentStatus === "Terminated" && !lwd))
    .sort((a, b) => a.p.employeeCode.localeCompare(b.p.employeeCode))
    .map(({ p, lwd }) => {
      const role = DEMO_ACCOUNTS.find((a) => a.id === p.id)?.role ?? "employee";
      const dates = holidaySet(holidaysForPerson(state.holidays, p.id));
      const from = p.dateOfJoining > start ? p.dateOfJoining : start;
      const to = lwd && lwd < end ? lwd : end;
      const lwpDays = state.leaveRequests
        .filter((r) => r.employeeId === p.id && r.code === "unpaid" && r.status === "approved" && r.from <= to && r.to >= from)
        .reduce((s, r) => s + workingDays(r.from > from ? r.from : from, r.to < to ? r.to : to, dates, [0, 6], r.from === r.to ? r.half : undefined), 0);
      const currency = payRulesFor(p.countryCode as CountryCode).currency;
      const claims = state.expenses.filter((e) => e.employeeId === p.id && e.status === "approved" && e.date <= end && (e.currency ?? "INR") === currency);
      const enc = state.encashments.filter((e) => e.employeeId === p.id && e.status === "approved" && payoutMonth(e.decidedOn ?? e.appliedOn) === month);
      const perDay = perDayPay(p.countryCode, role);
      const ot = localPayableOvertime(p.id, month);
      const bank = localBank(p.id, p.fullName, p.employeeCode, p.countryCode);
      return {
        employeeId: p.id,
        employeeCode: p.employeeCode,
        name: p.fullName,
        role,
        countryCode: p.countryCode,
        legalEntity: entity,
        location: p.location,
        nationality: p.nationality,
        employmentStatus: p.employmentStatus,
        joiningDate: p.dateOfJoining,
        lastWorkingDay: lwd && lwd <= end ? lwd : undefined,
        taxRegime: getTaxRegime(p.id),
        currency,
        annualBase: payslipAnnualBase(p.id, p.countryCode as CountryCode),
        daysInMonth: days,
        lwpDays,
        reimbursements: Math.round(claims.reduce((s, e) => s + e.amount, 0) * 100) / 100,
        reimbursementCount: claims.length,
        cashRecovery: extraDeductionLines(p.id, month),
        encashment: Math.round(enc.reduce((s, e) => s + e.days * perDay, 0) * 100) / 100,
        encashmentDays: enc.reduce((s, e) => s + e.days, 0),
        overtimeHours: ot.hours,
        overtimePay: ot.amount,
        overtimeIds: ot.ids,
        bankOk: Boolean(bank),
        bankMasked: bank ? `•••• ${bank.accountNumber.slice(-4)}` : undefined,
        newJoiner: p.dateOfJoining >= start && p.dateOfJoining <= end,
        leaver: Boolean(lwd && lwd >= start && lwd <= end),
      } satisfies RunPerson;
    });
}

function localEntities(): Entity[] {
  const seen = new Map<string, Entity>();
  for (const p of listPeople()) {
    const legalEntity = p.legalEntity || legalEntityFor(p.countryCode as CountryCode);
    const key = `${p.countryCode}|${legalEntity}`;
    if (!seen.has(key)) seen.set(key, { countryCode: String(p.countryCode), legalEntity, currency: payRulesFor(p.countryCode as CountryCode).currency });
  }
  return [...seen.values()].sort((a, b) => a.countryCode.localeCompare(b.countryCode) || a.legalEntity.localeCompare(b.legalEntity));
}

function mutate(id: string, fn: (run: LocalRun) => string | null): string | null {
  const state = local.get();
  const index = state.runs.findIndex((r) => r.id === id);
  if (index < 0) return "Run not found.";
  const run = structuredClone(state.runs[index]);
  const error = fn(run);
  if (error) return error;
  const runs = state.runs.slice();
  runs[index] = run;
  return local.set({ runs });
}

/* ───────────── Backend ───────────── */

interface RunOut {
  id: string;
  month: string;
  country_code: string;
  legal_entity: string;
  currency: string;
  status: RunStatus;
  headcount: number;
  totals: Partial<RunTotals>;
  exceptions: RunException[];
  prepared_by: string | null;
  prepared_at: string | null;
  submitted_by: string | null;
  submitted_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
  returned_note: string | null;
  payday: string | null;
  can_prepare: boolean;
  can_submit: boolean;
  can_approve: boolean;
  lines?: LineOut[] | null;
}

interface LineOut {
  employee_id: string;
  employee_name: string;
  employee_code: string;
  days_in_month: number;
  paid_days: number;
  lwp_days: number;
  gross: number;
  deductions_total: number;
  net: number;
  earnings: { name: string; amount: number }[];
  deductions: { name: string; amount: number }[];
  employer: { name: string; amount: number }[];
  reimbursements: number;
  cash_recovery: number;
  encashment: number;
  overtime_hours: number;
  overtime_pay: number;
  bank_ok: boolean;
  flags: RunLine["flags"];
}

interface PersonOut {
  employee_id: string;
  employee_code: string;
  name: string;
  role: string;
  country_code: string;
  legal_entity: string;
  location: string | null;
  nationality: string | null;
  employment_status: string | null;
  joining_date: string;
  last_working_day: string | null;
  tax_regime: string;
  currency: string;
  annual_base: number | null;
  days_in_month: number;
  lwp_days: number;
  reimbursements: number;
  reimbursement_count: number;
  cash_recovery: { name: string; amount: number }[];
  encashment: number;
  encashment_days: number;
  overtime_hours: number;
  overtime_pay: number;
  bank_ok: boolean;
  bank_masked: string | null;
  new_joiner: boolean;
  leaver: boolean;
}

const opt = <T>(v: T | null | undefined) => (v === null ? undefined : v);

function fromApi(r: RunOut): RunView {
  return {
    id: r.id,
    month: r.month,
    countryCode: r.country_code,
    legalEntity: r.legal_entity,
    currency: r.currency,
    status: r.status,
    headcount: r.headcount,
    totals: r.totals,
    exceptions: r.exceptions,
    preparedBy: opt(r.prepared_by),
    preparedAt: opt(r.prepared_at),
    submittedBy: opt(r.submitted_by),
    submittedAt: opt(r.submitted_at),
    approvedBy: opt(r.approved_by),
    approvedAt: opt(r.approved_at),
    returnedNote: opt(r.returned_note),
    payday: opt(r.payday),
    canPrepare: r.can_prepare,
    canSubmit: r.can_submit,
    canApprove: r.can_approve,
    ...(r.lines
      ? {
          lines: r.lines.map((l) => ({
            employeeId: l.employee_id,
            employeeName: l.employee_name,
            employeeCode: l.employee_code,
            daysInMonth: l.days_in_month,
            paidDays: l.paid_days,
            lwpDays: l.lwp_days,
            gross: l.gross,
            deductionsTotal: l.deductions_total,
            net: l.net,
            earnings: l.earnings,
            deductions: l.deductions,
            employer: l.employer,
            reimbursements: l.reimbursements,
            cashRecovery: l.cash_recovery,
            encashment: l.encashment,
            overtimeHours: l.overtime_hours,
            overtimePay: l.overtime_pay,
            bankOk: l.bank_ok,
            flags: l.flags,
          })),
        }
      : {}),
  };
}

function personFromApi(p: PersonOut): RunPerson {
  return {
    employeeId: p.employee_id,
    employeeCode: p.employee_code,
    name: p.name,
    role: p.role,
    countryCode: p.country_code,
    legalEntity: p.legal_entity,
    location: opt(p.location),
    nationality: opt(p.nationality),
    employmentStatus: opt(p.employment_status),
    joiningDate: p.joining_date,
    lastWorkingDay: opt(p.last_working_day),
    taxRegime: p.tax_regime === "old" ? "old" : "new",
    currency: p.currency,
    annualBase: opt(p.annual_base),
    daysInMonth: p.days_in_month,
    lwpDays: p.lwp_days,
    reimbursements: p.reimbursements,
    reimbursementCount: p.reimbursement_count,
    cashRecovery: p.cash_recovery,
    encashment: p.encashment,
    encashmentDays: p.encashment_days,
    overtimeHours: p.overtime_hours,
    overtimePay: p.overtime_pay,
    bankOk: p.bank_ok,
    bankMasked: opt(p.bank_masked),
    newJoiner: p.new_joiner,
    leaver: p.leaver,
  };
}

const VIEW_ROLES = new Set([...PREPARE_ROLES, ...APPROVE_ROLES]);

export const runsMirror = createApiMirror<{ runs: RunView[]; entities: Entity[] }>(
  () => ({ runs: [], entities: [] }),
  async () => {
    const role = (await apiSessionMe().catch(() => null))?.role ?? "";
    if (!VIEW_ROLES.has(role)) return { runs: [], entities: [] };
    const [runs, entities] = await Promise.all([
      api.get<RunOut[]>("/payroll/runs"),
      api.get<{ country_code: string; legal_entity: string; currency: string }[]>("/payroll/entities"),
    ]);
    return {
      runs: runs.map(fromApi),
      entities: entities.map((e) => ({ countryCode: e.country_code, legalEntity: e.legal_entity, currency: e.currency })),
    };
  },
);

/** My payslips from locked runs (everyone), for the payslip pages. */
const mySlipsMirror = createApiMirror<{ slips: { month: string; runId: string; slip: GeneratedPayslip | null }[] }>(
  () => ({ slips: [] }),
  async () => ({
    slips: (await api.get<{ run_id: string; month: string; slip: GeneratedPayslip | null }[]>("/payroll/my-slips")).map((s) => ({
      month: s.month,
      runId: s.run_id,
      slip: s.slip,
    })),
  }),
);

/* ───────────── Reading ───────────── */

export function subscribeRuns(listener: () => void): () => void {
  return API_ENABLED ? runsMirror.subscribe(listener) : local.subscribe(listener);
}

export function getRunsSnapshot(): object {
  return API_ENABLED ? runsMirror.get() : local.get();
}

export function runViews(actor: Actor): RunView[] {
  if (API_ENABLED) return runsMirror.get().runs;
  return local.get().runs.map((r) => localView(r, actor, false)).sort((a, b) => b.month.localeCompare(a.month) || a.countryCode.localeCompare(b.countryCode));
}

export function entities(): Entity[] {
  return API_ENABLED ? runsMirror.get().entities : localEntities();
}

export function runsLoaded(): boolean {
  return !API_ENABLED || runsMirror.loaded();
}

/** The run with its lines. */
export async function loadRun(actor: Actor, id: string): Promise<RunView | null> {
  if (API_ENABLED) return fromApi(await api.get<RunOut>(`/payroll/runs/${encodeURIComponent(id)}`));
  const run = local.get().runs.find((r) => r.id === id);
  return run ? localView(run, actor, true) : null;
}

/* ───────────── Changes ───────────── */

function checkMonth(month: string): string | null {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return "Choose a month.";
  if (month > todayISO().slice(0, 7)) return "You can't run payroll for a future month.";
  return null;
}

/** Builds the input pack and each person's payslip, then saves a draft (or replaces the draft's lines). */
export async function prepareRun(actor: Actor, state: PortalState, month: string, country: string, entity: string): Promise<{ error: string | null; id?: string }> {
  const problem = checkMonth(month);
  if (problem) return { error: problem };
  if (!PREPARE_ROLES.has(actor.role)) return { error: "Only HR or an admin can prepare payroll." };
  const ctx = { investmentProofs: state.investmentProofs, timesheets: state.timesheets, orgTimesheets: state.orgTimesheets };
  if (API_ENABLED) {
    let id: string | undefined;
    const error = await apiRun(async () => {
      const people = (await api.get<PersonOut[]>("/payroll/runs/inputs", { month, country, entity })).map(personFromApi);
      if (!people.length) throw new Error("Nobody is on the payroll for this country and entity in that month.");
      const lines = people.map((p) => computeLine(p, month, ctx));
      const out = await api.post<RunOut>("/payroll/runs/prepare", {
        month,
        country_code: country,
        legal_entity: entity,
        lines: lines.map((l) => ({
          employee_id: l.employeeId,
          paid_days: l.paidDays,
          lwp_days: l.lwpDays,
          earnings: l.earnings,
          deductions: l.deductions,
          employer: l.employer,
          slip: l.slip ?? null,
        })),
      });
      id = out.id;
    }, runsMirror);
    return { error, id };
  }
  const existing = local.get().runs.find((r) => r.month === month && r.countryCode === country && r.legalEntity === entity);
  if (existing && existing.status !== "draft") return { error: `This run is already ${existing.status === "locked" ? "locked" : "in review"}; it can't change.` };
  const people = localInputs(state, country, entity, month);
  if (!people.length) return { error: "Nobody is on the payroll for this country and entity in that month." };
  const lines = people.map((p) => computeLine(p, month, ctx));
  const { totals, exceptions } = totalsOf(lines);
  const run: LocalRun = {
    id: existing?.id ?? uid("pr"),
    month,
    countryCode: country,
    legalEntity: entity,
    currency: payRulesFor(country as CountryCode).currency,
    status: "draft",
    headcount: lines.length,
    totals,
    exceptions,
    preparedById: actor.id,
    preparedAt: new Date().toISOString(),
    payday: paydayFor(month, country),
    lines,
  };
  const error = local.set({ runs: [run, ...local.get().runs.filter((r) => r.id !== run.id)] });
  return { error, id: run.id };
}

const APPROVER_IDS = () => DEMO_ACCOUNTS.filter((a) => APPROVE_ROLES.has(a.role) && a.role !== "admin" && a.role !== "super_admin").map((a) => a.id);
const monthTitle = (month: string) => new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" });

export async function submitRun(actor: Actor, id: string): Promise<string | null> {
  if (API_ENABLED) return apiRun(() => api.post(`/payroll/runs/${encodeURIComponent(id)}/submit`), runsMirror);
  let label = "";
  const error = mutate(id, (run) => {
    if (run.status !== "draft") return `This run is already ${run.status === "locked" ? "locked" : "in review"}.`;
    if (!PREPARE_ROLES.has(actor.role)) return "Only HR or an admin can send payroll for review.";
    run.status = "review";
    run.submittedById = actor.id;
    run.submittedAt = new Date().toISOString();
    label = `${monthTitle(run.month)} · ${run.legalEntity}`;
    return null;
  });
  if (!error) {
    const run = local.get().runs.find((r) => r.id === id);
    for (const rid of APPROVER_IDS()) if (rid !== actor.id && rid !== run?.preparedById) notify(rid, `Approve payroll · ${label}`, `${run?.headcount ?? 0} people.`, "/payroll");
  }
  return error;
}

export async function approveRun(actor: Actor, id: string): Promise<string | null> {
  if (API_ENABLED) return apiRun(() => api.post(`/payroll/runs/${encodeURIComponent(id)}/approve`), runsMirror, mySlipsMirror);
  let paid: { ids: string[]; employees: string[]; month: string } | null = null;
  const error = mutate(id, (run) => {
    if (run.status === "locked") return "This run is already locked.";
    if (run.status !== "review") return "Send the run for review first.";
    if (!APPROVE_ROLES.has(actor.role)) return "Only HR, finance and the executive can approve payroll.";
    if (actor.id === run.preparedById || actor.id === run.submittedById) return "A second person approves the run; you prepared or sent it.";
    run.status = "locked";
    run.approvedById = actor.id;
    run.approvedAt = new Date().toISOString();
    for (const l of run.lines) if (l.slip) l.slip = { ...l.slip, runId: run.id };
    paid = { ids: run.lines.flatMap((l) => l.overtimeIds ?? []), employees: run.lines.map((l) => l.employeeId), month: run.month };
    return null;
  });
  const done = paid as { ids: string[]; employees: string[]; month: string } | null;
  if (!error && done) {
    markOvertimePaid(done.ids, id);
    for (const emp of done.employees.filter((e) => DEMO_ACCOUNTS.some((a) => a.id === e))) {
      notify(emp, `Payslip for ${monthTitle(done.month)}`, "Your payslip is ready.", "/payslips");
    }
  }
  return error;
}

export async function sendBackRun(actor: Actor, id: string, note: string): Promise<string | null> {
  if (!note.trim()) return "Add a note saying what to fix.";
  if (API_ENABLED) return apiRun(() => api.post(`/payroll/runs/${encodeURIComponent(id)}/send-back`, { note: note.trim() }), runsMirror);
  return mutate(id, (run) => {
    if (run.status !== "review") return run.status === "locked" ? "This run is already locked." : "Only a run in review can be sent back.";
    if (actor.id === run.preparedById || actor.id === run.submittedById) return "A second person reviews the run; you prepared or sent it.";
    run.status = "draft";
    run.returnedNote = note.trim();
    if (run.preparedById) notify(run.preparedById, `Payroll sent back · ${monthTitle(run.month)}`, note.trim(), "/payroll");
    return null;
  });
}

/** The payroll register or the bank transfer file as CSV text (saved by the page). */
export async function exportRun(actor: Actor, id: string, kind: "register" | "bank"): Promise<{ filename: string; csv: string; rows: number } | string> {
  if (API_ENABLED) {
    try {
      return await api.get<{ filename: string; csv: string; rows: number }>(`/payroll/runs/${encodeURIComponent(id)}/export`, { kind });
    } catch (e) {
      return e instanceof Error ? e.message : "Could not export.";
    }
  }
  const run = local.get().runs.find((r) => r.id === id);
  if (!run) return "Run not found.";
  if (kind === "bank" && run.status !== "locked") return "The bank file is ready once the run is approved and locked.";
  if (kind === "register") {
    return { filename: `payroll-register-${run.countryCode}-${run.month}.csv`, csv: registerCsv(run.lines, run.currency), rows: run.lines.length };
  }
  const banks = new Map<string, BankRow>();
  for (const l of run.lines) {
    const b = localBank(l.employeeId, l.employeeName, l.employeeCode, run.countryCode);
    if (b) banks.set(l.employeeId, b);
  }
  const csv = bankCsv(run.lines, banks, run.currency, run.payday ?? paydayFor(run.month, run.countryCode), run.month);
  void actor;
  return { filename: `bank-transfer-${run.countryCode}-${run.month}.csv`, csv, rows: csv.trim().split("\n").length - 1 };
}

/* ───────────── Payslips from locked runs; overtime pay month ───────────── */

function lockedSlip(employeeId: string, month: string): GeneratedPayslip | null {
  if (API_ENABLED) {
    const hit = mySlipsMirror.get().slips.find((s) => s.month === month && s.slip && s.slip.employeeId === employeeId);
    return hit?.slip ? { ...hit.slip, runId: hit.runId } : null;
  }
  for (const run of local.get().runs) {
    if (run.status !== "locked" || run.month !== month) continue;
    const line = run.lines.find((l) => l.employeeId === employeeId);
    if (line?.slip) return { ...line.slip, runId: run.id };
  }
  return null;
}

setPayslipRunSource({
  slip: lockedSlip,
  months(employeeId) {
    if (API_ENABLED) return mySlipsMirror.get().slips.filter((s) => s.slip?.employeeId === employeeId).map((s) => s.month);
    return local
      .get()
      .runs.filter((r) => r.status === "locked" && r.lines.some((l) => l.employeeId === employeeId))
      .map((r) => r.month);
  },
  version: () => (API_ENABLED ? mySlipsMirror.get().slips.map((s) => s.runId).join(",") : String(local.version())),
});

/** Re-render payslip pages when locked-run slips load or change. */
export function subscribeRunSlips(listener: () => void): () => void {
  return API_ENABLED ? mySlipsMirror.subscribe(listener) : local.subscribe(listener);
}
export function getRunSlipsSnapshot(): object {
  return API_ENABLED ? mySlipsMirror.get() : local.get();
}

setOvertimeClosedMonthCheck((employeeId, month) => {
  const person = listPeople().find((p) => p.id === employeeId);
  if (!person) return false;
  const entity = person.legalEntity || legalEntityFor(person.countryCode as CountryCode);
  return local.get().runs.some((r) => r.month === month && r.countryCode === person.countryCode && r.legalEntity === entity && r.status !== "draft");
});
