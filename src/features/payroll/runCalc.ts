/**
 * Payroll run maths shared by both modes: one person's input pack → that month's payslip, worked out by the
 * payslip generator itself (src/data/payslipGenerator.ts), so the run and the payslips can't disagree.
 * The backend checks the lines it gets against its own inputs (backend/app/services/payroll_runs.py).
 */
import { buildRunSlip, type GeneratedPayslip, type PayslipInput } from "../../data/payslipGenerator.ts";
import type { IndiaRegime } from "../../countryPay.ts";
import type { CountryCode, InvestmentProof, OrgTimesheetRecord, PayLine, Timesheet } from "../../model.ts";

export type RunStatus = "draft" | "review" | "locked";
export type RunFlag = "missing_bank" | "negative_net" | "new_joiner" | "leaver";

export const FLAG_TEXT: Record<RunFlag, string> = {
  missing_bank: "No bank details: pay is held",
  negative_net: "Net pay below zero",
  new_joiner: "New joiner",
  leaver: "Leaver",
};

/** Line-name prefixes the backend checks (keep in step with payroll_runs.py). */
export const OVERTIME_LINE = "Overtime pay";
export const REIMBURSEMENT_LINE = "Reimbursements";
export const ENCASHMENT_LINE = "Leave encashment payout";

export interface RunPerson {
  employeeId: string;
  employeeCode: string;
  name: string;
  role: string;
  countryCode: string;
  legalEntity: string;
  location?: string;
  nationality?: string;
  employmentStatus?: string;
  joiningDate: string;
  lastWorkingDay?: string;
  taxRegime: IndiaRegime;
  currency: string;
  annualBase?: number;
  daysInMonth: number;
  lwpDays: number;
  reimbursements: number;
  reimbursementCount: number;
  cashRecovery: PayLine[];
  encashment: number;
  encashmentDays: number;
  overtimeHours: number;
  overtimePay: number;
  bankOk: boolean;
  bankMasked?: string;
  newJoiner: boolean;
  leaver: boolean;
  /** Local mode: the overtime requests this line pays (marked paid when the run locks). */
  overtimeIds?: string[];
}

export interface RunLine {
  employeeId: string;
  employeeName: string;
  employeeCode: string;
  daysInMonth: number;
  paidDays: number;
  lwpDays: number;
  gross: number;
  deductionsTotal: number;
  net: number;
  earnings: PayLine[];
  deductions: PayLine[];
  employer: PayLine[];
  reimbursements: number;
  cashRecovery: number;
  encashment: number;
  overtimeHours: number;
  overtimePay: number;
  bankOk: boolean;
  flags: RunFlag[];
  slip?: GeneratedPayslip;
  overtimeIds?: string[];
}

export interface RunTotals {
  gross: number;
  deductions: number;
  net: number;
  employer: number;
  reimbursements: number;
  overtime: number;
  cash_recovery: number;
  encashment: number;
  bank_total: number;
  held: number;
}

export interface RunException {
  employee_id: string;
  name: string;
  kind: RunFlag;
  text: string;
}

const sum = (lines: PayLine[]) => Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
const hoursText = (h: number) => (Number.isInteger(h) ? `${h}` : h.toFixed(1));

export function monthEnd(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
}

export interface CalcContext {
  investmentProofs?: InvestmentProof[];
  timesheets?: Timesheet[];
  orgTimesheets?: OrgTimesheetRecord[];
}

/** One person's line: the payslip from the generator with the run's extras. */
export function computeLine(p: RunPerson, month: string, ctx: CalcContext): RunLine {
  const input: PayslipInput = {
    employeeId: p.employeeId,
    role: p.role,
    countryCode: p.countryCode as CountryCode,
    joiningDate: p.joiningDate,
    lastWorkingDay: p.lastWorkingDay,
    today: monthEnd(month),
    location: p.location,
    nationality: p.nationality,
    employmentStatus: p.employmentStatus,
    annualBase: p.annualBase,
    regime: p.taxRegime,
    investmentProofs: ctx.investmentProofs,
    timesheets: ctx.timesheets,
    orgTimesheets: ctx.orgTimesheets,
  };
  const earnings: PayLine[] = [];
  if (p.overtimePay > 0) earnings.push({ name: `${OVERTIME_LINE} (approved, ${hoursText(p.overtimeHours)} h)`, amount: p.overtimePay });
  if (p.encashment > 0) earnings.push({ name: `${ENCASHMENT_LINE} (${p.encashmentDays} days)`, amount: p.encashment });
  const untaxed: PayLine[] =
    p.reimbursements > 0
      ? [{ name: `${REIMBURSEMENT_LINE} (${p.reimbursementCount} ${p.reimbursementCount === 1 ? "claim" : "claims"}, not taxed)`, amount: p.reimbursements }]
      : [];
  const slip = buildRunSlip(input, month, { unpaidDays: p.lwpDays, earnings, untaxed, deductions: p.cashRecovery });
  const gross = sum(slip.earnings);
  const deductionsTotal = sum(slip.deductions);
  const net = Math.round((gross - deductionsTotal) * 100) / 100;
  const flags: RunFlag[] = [];
  if (!p.bankOk) flags.push("missing_bank");
  if (net < 0) flags.push("negative_net");
  if (p.newJoiner) flags.push("new_joiner");
  if (p.leaver) flags.push("leaver");
  return {
    employeeId: p.employeeId,
    employeeName: p.name,
    employeeCode: p.employeeCode,
    daysInMonth: p.daysInMonth,
    paidDays: slip.paidDays ?? p.daysInMonth,
    lwpDays: p.lwpDays,
    gross,
    deductionsTotal,
    net,
    earnings: slip.earnings,
    deductions: slip.deductions,
    employer: slip.employerContributions,
    reimbursements: p.reimbursements,
    cashRecovery: sum(p.cashRecovery),
    encashment: p.encashment,
    overtimeHours: p.overtimeHours,
    overtimePay: p.overtimePay,
    bankOk: p.bankOk,
    flags,
    slip,
    ...(p.overtimeIds?.length ? { overtimeIds: p.overtimeIds } : {}),
  };
}

export function totalsOf(lines: RunLine[]): { totals: RunTotals; exceptions: RunException[] } {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const totals: RunTotals = { gross: 0, deductions: 0, net: 0, employer: 0, reimbursements: 0, overtime: 0, cash_recovery: 0, encashment: 0, bank_total: 0, held: 0 };
  const exceptions: RunException[] = [];
  for (const l of lines) {
    totals.gross += l.gross;
    totals.deductions += l.deductionsTotal;
    totals.net += l.net;
    totals.employer += sum(l.employer);
    totals.reimbursements += l.reimbursements;
    totals.overtime += l.overtimePay;
    totals.cash_recovery += l.cashRecovery;
    totals.encashment += l.encashment;
    if (l.bankOk && l.net > 0) totals.bank_total += l.net;
    if (!l.bankOk) totals.held += 1;
    for (const f of l.flags) exceptions.push({ employee_id: l.employeeId, name: l.employeeName, kind: f, text: FLAG_TEXT[f] });
  }
  for (const k of Object.keys(totals) as (keyof RunTotals)[]) if (k !== "held") totals[k] = r2(totals[k]);
  return { totals, exceptions };
}

/* ───────────── CSV files (local mode; the backend writes the same columns) ───────────── */

function csvRow(cells: (string | number)[]): string {
  return cells
    .map((c) => {
      const s = String(c);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    })
    .join(",");
}

export function registerCsv(lines: RunLine[], currency: string): string {
  const earn = [...new Set(lines.flatMap((l) => l.earnings.map((e) => e.name)))];
  const ded = [...new Set(lines.flatMap((l) => l.deductions.map((d) => d.name)))];
  const rows = [
    csvRow(["Employee code", "Name", "Days in month", "Paid days", "Unpaid leave days", ...earn, "Gross", ...ded, "Total deductions", "Net pay", "Overtime hours", "Currency", "Flags"]),
  ];
  for (const l of lines) {
    const e = new Map(l.earnings.map((x) => [x.name, x.amount]));
    const d = new Map(l.deductions.map((x) => [x.name, x.amount]));
    rows.push(
      csvRow([
        l.employeeCode, l.employeeName, l.daysInMonth, l.paidDays, l.lwpDays,
        ...earn.map((n) => e.get(n) ?? 0), l.gross, ...ded.map((n) => d.get(n) ?? 0), l.deductionsTotal, l.net,
        l.overtimeHours, currency, l.flags.map((f) => FLAG_TEXT[f]).join("; "),
      ]),
    );
  }
  return `${rows.join("\n")}\n`;
}

export interface BankRow {
  employeeCode: string;
  name: string;
  accountName: string;
  accountNumber: string;
  bankCode: string;
  bankName: string;
}

export function bankCsv(lines: RunLine[], banks: Map<string, BankRow>, currency: string, payday: string, month: string): string {
  const [y, m] = month.split("-").map(Number);
  const label = new Date(y, m - 1, 1).toLocaleDateString("en-GB", { month: "short", year: "numeric" }).toUpperCase();
  const rows = [csvRow(["Employee code", "Name", "Account name", "Account number", "Bank code", "Bank name", "Amount", "Currency", "Payment date", "Reference"])];
  for (const l of lines) {
    const b = banks.get(l.employeeId);
    if (!b || l.net <= 0) continue;
    rows.push(csvRow([l.employeeCode, l.employeeName, b.accountName, b.accountNumber, b.bankCode, b.bankName, l.net.toFixed(2), currency, payday, `SAL ${label} ${l.employeeCode}`]));
  }
  return `${rows.join("\n")}\n`;
}
