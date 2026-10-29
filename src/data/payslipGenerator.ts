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
  return {
    rules: payRulesFor(input.countryCode),
    scale: payScaleFor(input.role),
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
): GeneratedPayslip {
  const { rules, scale, basis, rate } = ctx;
  const total = daysInMonth(month);
  const paidDays = Math.max(0, endDay - startDay + 1);
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
  const earnings = [...regularEarnings, ...oneOffs];
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
    slips.push(buildSlip(input, ctx, month, startDay, endDay, isFinal, true, ytd, exitReached ? input.lastWorkingDay : undefined));
  }
  return slips.reverse();
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

/** Payslips cached per portal state and inputs, so repeated reads don't recompute. */
const cache = new WeakMap<object, Map<string, PayslipView[]>>();

export function cachedPayslips(owner: object, key: string, build: () => PayslipView[]): PayslipView[] {
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
