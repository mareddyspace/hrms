import { annualPayFor, money, monthlyPay, payBases, payRulesFor, taxYearStartFor } from "../countryPay.ts";
import type { IndiaRegime } from "../countryPay.ts";
import type { CountryCode, InvestmentProof, OrgTimesheetRecord, PayLine, Payslip, PayslipView, Timesheet, UserRole } from "../model.ts";
import { approvedMonthHours, payBasisFor, type PayBasisKind } from "./payBasis.ts";

/** Seniority multiplier on the country's base pay. */
export function payScaleFor(role: UserRole | string): number {
  if (role === "employee") return 1;
  if (role === "manager") return 1.35;
  if (role === "hr_admin" || role === "hr") return 1.4;
  if (role === "executive") return 2.1;
  if (role === "admin" || role === "super_admin") return 1.25;
  return 1.15;
}

/** Hourly rate in local currency: the monthly package over 2,080 working hours a year. */
export function hourlyRateFor(countryCode: CountryCode | undefined, role: UserRole | string): number {
  const rules = payRulesFor(countryCode);
  const monthly = rules.earnings.reduce((sum, line) => sum + line.amount, 0) * payScaleFor(role);
  const rate = (monthly * 12) / 2080;
  return rate >= 100 ? Math.round(rate / 5) * 5 : Math.round(rate);
}

/** Months of payslips kept online. */
const HISTORY_MONTHS = 12;
/** Annual performance bonus is paid with September salary, as a share of basic. */
const BONUS_MONTH = "09";
const BONUS_RATE = 0.066;

function monthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function daysInMonth(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(y, m, 0).getDate();
}

export interface PayslipInput {
  employeeId: string;
  role: UserRole | string;
  countryCode: CountryCode | undefined;
  /** First day of work (ISO). Payslips start from this month. */
  joiningDate?: string;
  /** Last working day when the person is leaving or has left (ISO). */
  lastWorkingDay?: string;
  /** Unused privilege leave paid out in the final settlement. */
  unusedLeaveDays?: number;
  today: string;
  /** Work location (US state tax). */
  location?: string;
  nationality?: string;
  /** Directory employment status; contractors are paid hourly. */
  employmentStatus?: string;
  /**
   * Annual base pay on the person's compensation record (src/data/annualPay.ts), in the country's currency.
   * When set, the monthly package is scaled to it so payslips match Compensation; otherwise the country's
   * standard package for the role is used.
   */
  annualBase?: number;
  /** India: the employee's chosen regime (new by default). */
  regime?: IndiaRegime;
  /** All declarations; only this person's verified ones for the slip's tax year count. */
  investmentProofs?: InvestmentProof[];
  timesheets?: Timesheet[];
  orgTimesheets?: OrgTimesheetRecord[];
}

export interface TaxComputation {
  taxYear: string;
  annualGross: number;
  annualTaxable: number;
  basis: string;
  reliefs: PayLine[];
  components: PayLine[];
  annualTax: number;
  monthTax: number;
}

export interface PayslipExtras {
  basis: PayBasisKind;
  hourlyRate?: number;
  hours?: { regular: number; overtime: number };
  employerContributions: PayLine[];
  tax: TaxComputation;
  /** Year-to-date totals in the slip's tax year, from the payslips held online. */
  ytd: { taxYear: string; gross: number; tax: number; net: number; fromMonth: string };
  /** Set when the slip comes from a locked payroll run (src/features/payroll). */
  runId?: string;
  /** Unpaid leave days taken off the month's pay (payroll runs). */
  unpaidDays?: number;
}

/**
 * Extra inputs a payroll run adds to a month's slip: unpaid leave, taxable one-offs (approved overtime, leave
 * encashment payouts), untaxed additions (approved reimbursements) and after-tax deductions (cash advance recovery,
 * replacing the registered deduction source).
 */
export interface RunExtras {
  unpaidDays?: number;
  earnings?: PayLine[];
  untaxed?: PayLine[];
  deductions?: PayLine[];
}

export type GeneratedPayslip = Payslip & PayslipExtras;
export type PayslipDetailView = PayslipView & PayslipExtras;

/** Payslip views carry the extras at runtime; this narrows the store's type. */
export function asDetailView(view: PayslipView): PayslipDetailView | null {
  return "tax" in view && "ytd" in view ? (view as PayslipDetailView) : null;
}

const sum = (lines: PayLine[]) => lines.reduce((acc, line) => acc + line.amount, 0);
const hoursText = (h: number) => (Number.isInteger(h) ? `${h}` : h.toFixed(2).replace(/0$/, ""));

type SlipContext = {
  rules: ReturnType<typeof payRulesFor>;
  scale: number;
  basis: PayBasisKind;
  rate?: number;
};

type YtdRunning = Map<string, { gross: number; tax: number; net: number; fromMonth: string }>;

function contextFor(input: PayslipInput): SlipContext {
  const basis = payBasisFor(input.employeeId, input.employmentStatus);
  const rules = payRulesFor(input.countryCode);
  const standardAnnual = rules.earnings.reduce((acc, line) => acc + line.amount, 0) * 12;
  return {
    rules,
    scale: input.annualBase && input.annualBase > 0 && standardAnnual > 0 ? input.annualBase / standardAnnual : payScaleFor(input.role),
    basis,
    rate: basis === "hourly" ? hourlyRateFor(input.countryCode, input.role) : undefined,
  };
}

/**
 * One month's pay for days startDay..endDay (calendar days, pro-rated on the month's length).
 * `isFinal`: the leaver's last month (leave encashment, no bonus). `withOneOffs`: bonus / encashment included.
 * `to`: last date of approved hours counted for hourly staff.
 */
function buildSlip(
  input: PayslipInput,
  ctx: SlipContext,
  month: string,
  startDay: number,
  endDay: number,
  isFinal: boolean,
  withOneOffs: boolean,
  ytd: YtdRunning,
  to?: string,
  extras?: RunExtras,
): GeneratedPayslip {
  const { rules, scale, basis, rate } = ctx;
  const total = daysInMonth(month);
  const employedDays = Math.max(0, endDay - startDay + 1);
  const unpaidDays = basis === "hourly" ? 0 : Math.min(employedDays, Math.max(0, extras?.unpaidDays ?? 0));
  const paidDays = employedDays - unpaidDays;
  const share = paidDays / total;
  const full = monthlyPay(rules, scale, 0);
  const fullRegular = sum(full.earnings);
  const bases = payBases(full.earnings);

  let regularEarnings: PayLine[];
  const oneOffs: PayLine[] = [];
  let hours: { regular: number; overtime: number } | undefined;
  let dailyRate: number;
  if (basis === "hourly" && rate) {
    hours = approvedMonthHours({
      personId: input.employeeId,
      month,
      weeklyThreshold: rules.overtime.weeklyHours,
      timesheets: input.timesheets ?? [],
      orgTimesheets: input.orgTimesheets ?? [],
      from: input.joiningDate,
      to,
    });
    const { factor } = rules.overtime;
    regularEarnings = [{ name: `Regular hours (${hoursText(hours.regular)} h × ${money(rate, rules.currency)})`, amount: Math.round(hours.regular * rate) }];
    if (hours.overtime > 0) {
      regularEarnings.push({
        name: `Overtime (${hoursText(hours.overtime)} h × ${money(rate, rules.currency)} × ${factor})`,
        amount: Math.round(hours.overtime * rate * factor),
      });
    }
    dailyRate = rate * 8;
  } else {
    regularEarnings = full.earnings.map((line) => ({ name: line.name, amount: Math.round(line.amount * share) }));
    if (withOneOffs && month.endsWith(`-${BONUS_MONTH}`) && !isFinal) {
      oneOffs.push({ name: "Performance bonus", amount: Math.round((full.earnings[0]?.amount ?? 0) * BONUS_RATE) });
    }
    // Daily rate on the first (basic) line, over ~22 working days a month.
    dailyRate = (full.earnings[0]?.amount ?? 0) / 22;
  }
  if (withOneOffs && isFinal && input.unusedLeaveDays && input.unusedLeaveDays > 0) {
    oneOffs.push({ name: `Leave encashment (${input.unusedLeaveDays} days)`, amount: Math.round(dailyRate * input.unusedLeaveDays) });
  }
  if (extras?.earnings) oneOffs.push(...extras.earnings.filter((l) => l.amount));
  const earnings = [...regularEarnings, ...oneOffs, ...(extras?.untaxed ?? []).filter((l) => l.amount)];
  const regular = sum(regularEarnings);
  const oneOff = sum(oneOffs);

  // Annualise the regular pay; the month pays its share of the annual figure plus one-offs in full.
  const annualBase = basis === "hourly" ? regular * 12 : fullRegular * 12;
  const ratio = basis === "hourly" ? (regular > 0 ? 1 : 0) : fullRegular > 0 ? regular / fullRegular : 0;
  const yearStart = taxYearStartFor(rules, `${month}-${String(total).padStart(2, "0")}`);
  const taxYear = rules.taxYearLabel(yearStart);
  const declarations = (input.investmentProofs ?? [])
    .filter((p) => p.employeeId === input.employeeId && p.status === "verified" && p.financialYear === taxYear)
    .map((p) => ({ section: p.section, amount: p.amount }));
  const basicShare = basis === "hourly" ? 0.5 : fullRegular > 0 ? bases.basic / fullRegular : 0.5;
  const housingShare = basis === "hourly" ? 0 : fullRegular > 0 ? bases.housing / fullRegular : 0;
  const options = {
    regime: input.regime,
    declarations,
    location: input.location,
    nationality: input.nationality,
    basicAnnual: annualBase * basicShare,
    housingAnnual: annualBase * housingShare,
  };
  const base = annualPayFor(rules.code, annualBase, options);
  const withExtras = oneOff > 0 ? annualPayFor(rules.code, annualBase + oneOff, options) : base;
  const monthly = (lines: (a: typeof base) => PayLine[]) =>
    lines(withExtras)
      .map((item) => {
        const baseAmount = lines(base).find((l) => l.name === item.name)?.amount ?? 0;
        return { name: item.name, amount: Math.round((baseAmount / 12) * ratio + (item.amount - baseAmount)) };
      })
      .filter((item) => item.amount > 0 || withExtras.taxLines.includes(item.name));
  const deductions = regular + oneOff > 0 ? monthly((a) => a.deductions) : [];
  // Other modules' after-tax lines (e.g. cash advance recovery), only on real payslips.
  if (extras?.deductions) deductions.push(...extras.deductions.filter((l) => l.amount));
  else if (withOneOffs && regular + oneOff > 0) deductions.push(...extraDeductions(input.employeeId, month));
  const employerContributions = regular + oneOff > 0 ? monthly((a) => a.employer) : [];
  const monthTax = sum(deductions.filter((l) => withExtras.taxLines.includes(l.name)));
  const gross = sum(earnings);
  const net = gross - sum(deductions);

  const running = ytd.get(taxYear) ?? { gross: 0, tax: 0, net: 0, fromMonth: month };
  const updated = { gross: running.gross + gross, tax: running.tax + monthTax, net: running.net + net, fromMonth: running.fromMonth };
  ytd.set(taxYear, updated);

  return {
    id: `pay-${input.employeeId}-${month}`,
    employeeId: input.employeeId,
    month,
    currency: rules.currency,
    earnings,
    deductions,
    ...(basis === "monthly" && paidDays < total ? { paidDays, totalDays: total } : {}),
    ...(unpaidDays > 0 ? { unpaidDays } : {}),
    ...(isFinal ? { finalSettlement: true } : {}),
    basis,
    ...(rate ? { hourlyRate: rate, hours } : {}),
    employerContributions,
    tax: {
      taxYear,
      annualGross: annualBase + oneOff,
      annualTaxable: withExtras.taxable,
      basis: withExtras.basis,
      reliefs: withExtras.reliefs,
      components: withExtras.components,
      annualTax: sum(withExtras.deductions.filter((l) => withExtras.taxLines.includes(l.name))),
      monthTax,
    },
    ytd: { taxYear, ...updated },
  };
}

/**
 * Payslips from joining (at most the last 12 months) up to the last completed month before today.
 * Salaried staff are pro-rated in joining/leaving months by calendar days; hourly staff are paid approved
 * timesheet hours. A leaver's final month (1st to the last working day) is paid once that day has come, with
 * unused leave encashed, and nothing after it. Tax is worked out on annualised pay and one-twelfth taken each
 * month; one-offs (bonus, leave encashment) are taxed in full in the month paid.
 */
export function generatePayslips(input: PayslipInput): GeneratedPayslip[] {
  const ctx = contextFor(input);
  const todayMonth = input.today.slice(0, 7);
  const exitMonth = input.lastWorkingDay?.slice(0, 7);
  const exitReached = Boolean(input.lastWorkingDay && input.lastWorkingDay <= input.today);

  // The final month is paid once the last working day has passed, even if the month hasn't ended.
  const lastMonth = exitReached && exitMonth ? exitMonth : monthKey(new Date(Number(todayMonth.slice(0, 4)), Number(todayMonth.slice(5, 7)) - 2, 1));
  const firstAllowed = monthKey(new Date(Number(lastMonth.slice(0, 4)), Number(lastMonth.slice(5, 7)) - HISTORY_MONTHS, 1));
  const joinMonth = input.joiningDate?.slice(0, 7);
  const firstMonth = joinMonth && joinMonth > firstAllowed ? joinMonth : firstAllowed;

  const slips: GeneratedPayslip[] = [];
  const ytd: YtdRunning = new Map();
  for (let d = new Date(Number(firstMonth.slice(0, 4)), Number(firstMonth.slice(5, 7)) - 1, 1); monthKey(d) <= lastMonth; d.setMonth(d.getMonth() + 1)) {
    const month = monthKey(d);
    const total = daysInMonth(month);
    const startDay = month === joinMonth && input.joiningDate ? Number(input.joiningDate.slice(8, 10)) : 1;
    const isFinal = exitReached && month === exitMonth;
    const endDay = isFinal && input.lastWorkingDay ? Number(input.lastWorkingDay.slice(8, 10)) : total;
    const fromRun = runSource?.slip(input.employeeId, month);
    if (fromRun) {
      slips.push(fromRun);
      ytd.set(fromRun.ytd.taxYear, { gross: fromRun.ytd.gross, tax: fromRun.ytd.tax, net: fromRun.ytd.net, fromMonth: fromRun.ytd.fromMonth });
      continue;
    }
    slips.push(buildSlip(input, ctx, month, startDay, endDay, isFinal, true, ytd, exitReached ? input.lastWorkingDay : undefined));
  }
  // A month paid by a locked payroll run shows as soon as the run is locked, even before the month ends.
  for (const month of runSource?.months(input.employeeId) ?? []) {
    if (month > lastMonth && month <= todayMonth && !slips.some((s) => s.month === month)) {
      const fromRun = runSource?.slip(input.employeeId, month);
      if (fromRun) slips.push(fromRun);
    }
  }
  return slips.sort((a, b) => b.month.localeCompare(a.month));
}

/* Payslips from locked payroll runs (src/features/payroll/runsStore.ts); other months are generated. */
type RunSource = {
  slip: (employeeId: string, month: string) => GeneratedPayslip | null;
  months: (employeeId: string) => string[];
  version: () => string;
};
let runSource: RunSource | null = null;

export function setPayslipRunSource(source: RunSource | null): void {
  runSource = source;
}

/**
 * One month's payslip for a payroll run: worked out exactly as the payslips are (pro-rated for joiners and
 * leavers, statutory deductions from the country's rules) with the run's extras added. Year-to-date figures
 * follow the payslips before it.
 */
export function buildRunSlip(input: PayslipInput, month: string, extras: RunExtras): GeneratedPayslip {
  const ctx = contextFor(input);
  const total = daysInMonth(month);
  const joinMonth = input.joiningDate?.slice(0, 7);
  const startDay = joinMonth === month && input.joiningDate ? Number(input.joiningDate.slice(8, 10)) : 1;
  const lwd = input.lastWorkingDay;
  const isFinal = Boolean(lwd && lwd.slice(0, 7) === month);
  const endDay = isFinal && lwd ? Number(lwd.slice(8, 10)) : total;
  const ytd: YtdRunning = new Map();
  // Earlier slips this tax year (generated, or from locked runs) give the running totals.
  const earlier = joinMonth && joinMonth >= month ? [] : generatePayslips({ ...input, today: `${month}-01`, lastWorkingDay: isFinal ? undefined : lwd });
  for (const slip of [...earlier].reverse()) ytd.set(slip.ytd.taxYear, { gross: slip.ytd.gross, tax: slip.ytd.tax, net: slip.ytd.net, fromMonth: slip.ytd.fromMonth });
  return buildSlip(input, ctx, month, startDay, endDay, isFinal, true, ytd, isFinal ? lwd : undefined, extras);
}

/** Weekly days off by country (0 = Sunday … 6 = Saturday). */
function weekendFor(countryCode: CountryCode | string | undefined): number[] {
  return countryCode === "SA" ? [5, 6] : [0, 6];
}

/** Payday: the last working day of the month (no country sets its own payday yet). */
export function paydayFor(month: string, countryCode: CountryCode | string | undefined): string {
  const [y, m] = month.split("-").map(Number);
  const off = weekendFor(countryCode);
  const day = new Date(y, m, 0);
  while (off.includes(day.getDay())) day.setDate(day.getDate() - 1);
  return `${month}-${String(day.getDate()).padStart(2, "0")}`;
}

export interface MonthSoFar {
  month: string;
  /** First and last day counted (ISO). */
  from: string;
  to: string;
  daysCounted: number;
  totalDays: number;
  currency: string;
  earnings: PayLine[];
  deductions: PayLine[];
  gross: number;
  deductionTotal: number;
  net: number;
  payday: string;
  /** The last working day falls later this month: the final pay will also settle unused leave. */
  leavingThisMonth: boolean;
}

/**
 * Estimate of this month's pay so far: from the 1st (or the joining date) up to today. Null before joining,
 * after leaving, or once this month's final payslip is out (the last working day has come). Regular pay only
 * (no bonus or encashment), worked out the same way as the payslips.
 */
export function estimateMonthSoFar(input: PayslipInput): MonthSoFar | null {
  const today = input.today;
  const month = today.slice(0, 7);
  const lwd = input.lastWorkingDay;
  if (lwd && lwd <= today) return null; // left, or the final payslip for this month is already out
  if (input.joiningDate && input.joiningDate > today) return null;
  if (runSource?.slip(input.employeeId, month)) return null; // this month's payslip is out (locked payroll run)
  const startDay = input.joiningDate && input.joiningDate.slice(0, 7) === month ? Number(input.joiningDate.slice(8, 10)) : 1;
  const endDay = Number(today.slice(8, 10));
  const ctx = contextFor(input);
  const slip = buildSlip(input, ctx, month, startDay, endDay, false, false, new Map(), today);
  const gross = sum(slip.earnings);
  const deductionTotal = sum(slip.deductions);
  return {
    month,
    from: `${month}-${String(startDay).padStart(2, "0")}`,
    to: today,
    daysCounted: Math.max(0, endDay - startDay + 1),
    totalDays: daysInMonth(month),
    currency: slip.currency ?? ctx.rules.currency,
    earnings: slip.earnings,
    deductions: slip.deductions,
    gross,
    deductionTotal,
    net: gross - deductionTotal,
    payday: paydayFor(month, input.countryCode),
    leavingThisMonth: Boolean(lwd && lwd.slice(0, 7) === month),
  };
}

export interface FinalSettlementSummary {
  month: string;
  lastWorkingDay: string;
  paidDays: number;
  totalDays: number;
  encashmentDays: number;
  encashment: number;
  gross: number;
  deductionTotal: number;
  net: number;
  currency: string;
  /** The last working day is still ahead: the figures are a projection. */
  estimate: boolean;
}

/** A leaver's final payslip (1st to the last working day, plus leave encashment), worked out as the payslips are. */
export function finalSettlementFor(input: PayslipInput): FinalSettlementSummary | null {
  const lwd = input.lastWorkingDay;
  if (!lwd) return null;
  const today = input.today > lwd ? input.today : lwd;
  const slip = generatePayslips({ ...input, today }).find((s) => s.finalSettlement);
  if (!slip) return null;
  const gross = sum(slip.earnings);
  const deductionTotal = sum(slip.deductions);
  const total = daysInMonth(slip.month);
  return {
    month: slip.month,
    lastWorkingDay: lwd,
    paidDays: slip.paidDays ?? total,
    totalDays: slip.totalDays ?? total,
    encashmentDays: input.unusedLeaveDays ?? 0,
    encashment: slip.earnings.find((l) => l.name.startsWith("Leave encashment"))?.amount ?? 0,
    gross,
    deductionTotal,
    net: gross - deductionTotal,
    currency: slip.currency ?? payRulesFor(input.countryCode).currency,
    estimate: lwd > input.today,
  };
}

export interface TaxYearSummary {
  taxYear: string;
  currency: string;
  /** Regime or allowance used, e.g. "New regime". */
  basis: string;
  /** False in the UAE and Saudi Arabia (no personal income tax). */
  hasIncomeTax: boolean;
  ytdGross: number;
  ytdTax: number;
  /** Tax for a full month at today's pay. */
  monthTax: number;
  /** Months still to be paid in this tax year, this month included. */
  monthsLeft: number;
  /** Tax paid so far plus the months still to come. */
  projectedTax: number;
}

/** Months of the current tax year still to be paid: this month to the year end (or the last working day). */
function monthsLeftInTaxYear(input: PayslipInput, rules: ReturnType<typeof payRulesFor>): number {
  const lwd = input.lastWorkingDay;
  if (lwd && lwd <= input.today) return 0;
  const yearStart = taxYearStartFor(rules, input.today);
  let n = 0;
  for (let d = new Date(Number(input.today.slice(0, 4)), Number(input.today.slice(5, 7)) - 1, 1); n < 13; d.setMonth(d.getMonth() + 1)) {
    const month = monthKey(d);
    if (taxYearStartFor(rules, `${month}-28`) !== yearStart) break;
    if (lwd && month > lwd.slice(0, 7)) break;
    n += 1;
  }
  return n;
}

/** A full month at today's pay (regular pay only), worked out as the payslips are. */
function fullMonthSlip(input: PayslipInput): GeneratedPayslip {
  const month = input.today.slice(0, 7);
  const startDay = input.joiningDate && input.joiningDate.slice(0, 7) === month ? Number(input.joiningDate.slice(8, 10)) : 1;
  return buildSlip(input, contextFor(input), month, startDay, daysInMonth(month), false, false, new Map());
}

/** "Tax this year": paid so far (payslips in the current tax year) and projected to the year end. */
export function taxYearSummary(input: PayslipInput, slips: PayslipView[]): TaxYearSummary {
  const rules = payRulesFor(input.countryCode);
  const taxYear = rules.taxYearLabel(taxYearStartFor(rules, input.today));
  const inYear = slips.map(asDetailView).filter((s): s is PayslipDetailView => Boolean(s && s.tax.taxYear === taxYear));
  const ytdTax = inYear.reduce((acc, s) => acc + s.tax.monthTax, 0);
  const ytdGross = inYear.reduce((acc, s) => acc + s.gross, 0);
  const latest = slips.map(asDetailView).find(Boolean) ?? null;
  // Hourly staff: the last payslip's tax stands in for a month (this month's hours are not all in yet).
  const current = payBasisFor(input.employeeId, input.employmentStatus) === "hourly" ? null : fullMonthSlip(input);
  const monthTax = current ? current.tax.monthTax : (latest?.tax.monthTax ?? 0);
  const monthsLeft = monthsLeftInTaxYear(input, rules);
  return {
    taxYear,
    currency: rules.currency,
    basis: current?.tax.basis ?? latest?.tax.basis ?? "",
    hasIncomeTax: rules.incomeTaxName !== null,
    ytdGross,
    ytdTax,
    monthTax,
    monthsLeft,
    projectedTax: ytdTax + monthTax * monthsLeft,
  };
}

/** India: a full month's tax and the year's tax under each regime, at today's pay and verified declarations. */
export function compareRegimes(input: PayslipInput): Record<IndiaRegime, { monthTax: number; annualTax: number }> {
  const pick = (regime: IndiaRegime) => {
    const slip = fullMonthSlip({ ...input, regime });
    return { monthTax: slip.tax.monthTax, annualTax: slip.tax.annualTax };
  };
  return { new: pick("new"), old: pick("old") };
}

/** Payslips cached per portal state and inputs, so repeated reads don't recompute. */
const cache = new WeakMap<object, Map<string, PayslipView[]>>();

/* After-tax deduction lines from other modules (cash advance recovery: src/features/payrequests/cashStore.ts). */
type DeductionSource = { lines: (employeeId: string, month: string) => PayLine[]; version: () => string };
let deductionSource: DeductionSource | null = null;

function extraDeductions(employeeId: string, month: string): PayLine[] {
  return deductionSource?.lines(employeeId, month) ?? [];
}

/** The registered after-tax lines (cash advance recovery) for a month — payroll runs in local mode. */
export const extraDeductionLines = extraDeductions;

/** Registers extra deduction lines on payslips; `version` changes whenever the lines change (clears the cache key). */
export function setPayslipDeductionSource(source: DeductionSource | null): void {
  deductionSource = source;
}

export function cachedPayslips(owner: object, rawKey: string, build: () => PayslipView[]): PayslipView[] {
  const key = `${deductionSource ? `${rawKey}|${deductionSource.version()}` : rawKey}|${runSource?.version() ?? ""}`;
  let byKey = cache.get(owner);
  if (!byKey) {
    byKey = new Map();
    cache.set(owner, byKey);
  }
  const hit = byKey.get(key);
  if (hit) return hit;
  const views = build();
  byKey.set(key, views);
  return views;
}
