import type { CountryCode, PayLine } from "./model.ts";

/**
 * Pay and tax rules per country. Figures are simplified flat rates for the sample company —
 * close enough to look right on a payslip, not a payroll engine.
 */

/** A section an employee can declare for tax savings, with its yearly cap in local currency. */
export interface TaxDeclarationSection {
  code: string;
  label: string;
  /** Yearly cap; omitted when there is no fixed limit. */
  cap?: number;
}

export interface CountryPayRules {
  code: CountryCode;
  currency: string;
  /** Locale used to format amounts, e.g. "en-IN" for lakh grouping. */
  locale: string;
  /** Name of the income tax shown on the payslip, e.g. "TDS" or "PAYE income tax". */
  incomeTaxName: string | null;
  /** Monthly earnings for an employee at scale 1. The bonus line is added per month. */
  earnings: PayLine[];
  /** Deductions for a month, from that month's earnings. */
  deductions: (earnings: PayLine[]) => PayLine[];
  /** Month (1–12) the tax year starts, and the day in that month. */
  taxYearStart: { month: number; day: number };
  /** Label for the tax year, e.g. "FY 2026-27" or "Tax year 2026". */
  taxYearLabel: (startYear: number) => string;
  /** Tax-saving declarations; empty when the country has no personal income tax. */
  declarations: TaxDeclarationSection[];
  /** One line explaining declarations in this country, shown on the declarations page. */
  declarationNote: string;
}

const pct = (amount: number, rate: number) => Math.round(amount * rate);
const total = (lines: PayLine[]) => lines.reduce((sum, line) => sum + line.amount, 0);
const line = (lines: PayLine[], name: string) => lines.find((item) => item.name === name)?.amount ?? 0;

const splitYear = (y: number) => `${y}-${String((y + 1) % 100).padStart(2, "0")}`;

export const COUNTRY_PAY: Record<CountryCode, CountryPayRules> = {
  IN: {
    code: "IN",
    currency: "INR",
    locale: "en-IN",
    incomeTaxName: "TDS",
    earnings: [
      { name: "Basic", amount: 38000 },
      { name: "HRA", amount: 15200 },
      { name: "Conveyance", amount: 1600 },
    ],
    deductions: (e) => [
      { name: "Provident Fund", amount: Math.min(pct(line(e, "Basic"), 0.12), 1800) },
      { name: "Professional Tax", amount: 200 },
      { name: "TDS", amount: pct(total(e), 0.06) },
    ],
    taxYearStart: { month: 4, day: 1 },
    taxYearLabel: (y) => splitYear(y),
    declarations: [
      { code: "80C", label: "80C — PPF, ELSS, life insurance", cap: 150000 },
      { code: "80CCD(1B)", label: "80CCD(1B) — NPS", cap: 50000 },
      { code: "80D", label: "80D — health insurance (self, spouse, children)", cap: 25000 },
      { code: "80D-parents", label: "80D — health insurance for senior-citizen parents", cap: 50000 },
      { code: "80E", label: "80E — education loan interest" },
      { code: "24(b)", label: "24(b) — home loan interest", cap: 200000 },
      { code: "HRA", label: "HRA — rent receipts" },
    ],
    declarationNote: "Proofs are verified by Finance before they reduce your TDS.",
  },
  US: {
    code: "US",
    currency: "USD",
    locale: "en-US",
    incomeTaxName: "Federal income tax",
    earnings: [{ name: "Base salary", amount: 7000 }],
    deductions: (e) => {
      const gross = total(e);
      const k401 = pct(gross, 0.05);
      return [
        { name: "Federal income tax", amount: pct(gross - k401, 0.12) },
        { name: "State income tax", amount: pct(gross - k401, 0.055) },
        { name: "Social Security", amount: pct(gross, 0.062) },
        { name: "Medicare", amount: pct(gross, 0.0145) },
        { name: "401(k)", amount: k401 },
      ];
    },
    taxYearStart: { month: 1, day: 1 },
    taxYearLabel: (y) => `Tax year ${y}`,
    declarations: [
      { code: "401(k)", label: "401(k) — extra pre-tax contribution", cap: 24500 },
      { code: "HSA", label: "HSA — health savings account", cap: 4400 },
      { code: "DCFSA", label: "Dependent care FSA", cap: 7500 },
      { code: "W-4", label: "W-4 — extra withholding or credits" },
    ],
    declarationNote: "Pre-tax elections and W-4 changes apply from the next payroll run.",
  },
  GB: {
    code: "GB",
    currency: "GBP",
    locale: "en-GB",
    incomeTaxName: "Income tax (PAYE)",
    earnings: [{ name: "Basic salary", amount: 4500 }],
    deductions: (e) => {
      const gross = total(e);
      const allowance = 12570 / 12;
      const pension = pct(gross, 0.05);
      return [
        { name: "Income tax (PAYE)", amount: pct(Math.max(0, gross - pension - allowance), 0.2) },
        { name: "National Insurance", amount: pct(Math.max(0, gross - allowance), 0.08) },
        { name: "Workplace pension", amount: pension },
      ];
    },
    taxYearStart: { month: 4, day: 6 },
    taxYearLabel: (y) => `Tax year ${y}/${String((y + 1) % 100).padStart(2, "0")}`,
    declarations: [
      { code: "Pension", label: "Extra pension contribution", cap: 60000 },
      { code: "Gift Aid", label: "Gift Aid donations" },
      { code: "Cycle to Work", label: "Cycle to Work scheme" },
    ],
    declarationNote: "Tax code changes come from HMRC; declare salary-sacrifice items here.",
  },
  AU: {
    code: "AU",
    currency: "AUD",
    locale: "en-AU",
    incomeTaxName: "PAYG withholding",
    earnings: [{ name: "Base salary", amount: 8500 }],
    deductions: (e) => {
      const gross = total(e);
      return [
        { name: "PAYG withholding", amount: pct(gross, 0.22) },
        { name: "Medicare levy", amount: pct(gross, 0.02) },
      ];
    },
    taxYearStart: { month: 7, day: 1 },
    taxYearLabel: (y) => splitYear(y),
    declarations: [
      { code: "Super", label: "Salary-sacrifice super", cap: 30000 },
      { code: "Work expenses", label: "Work-related expenses" },
      { code: "Donations", label: "Donations to registered charities" },
    ],
    declarationNote: "Superannuation (12%) is paid by the company on top of salary.",
  },
  CA: {
    code: "CA",
    currency: "CAD",
    locale: "en-CA",
    incomeTaxName: "Federal income tax",
    earnings: [{ name: "Base salary", amount: 7500 }],
    deductions: (e) => {
      const gross = total(e);
      return [
        { name: "Federal income tax", amount: pct(gross, 0.15) },
        { name: "Provincial tax", amount: pct(gross, 0.0505) },
        { name: "CPP", amount: pct(gross, 0.0595) },
        { name: "EI", amount: pct(gross, 0.0164) },
      ];
    },
    taxYearStart: { month: 1, day: 1 },
    taxYearLabel: (y) => `Tax year ${y}`,
    declarations: [
      { code: "RRSP", label: "RRSP contributions", cap: 32490 },
      { code: "FHSA", label: "First Home Savings Account", cap: 8000 },
      { code: "TD1", label: "TD1 — personal tax credits" },
    ],
    declarationNote: "RRSP room is shown on your CRA notice of assessment.",
  },
  AE: {
    code: "AE",
    currency: "AED",
    locale: "en-AE",
    incomeTaxName: null,
    earnings: [
      { name: "Basic salary", amount: 18000 },
      { name: "Housing allowance", amount: 7000 },
      { name: "Transport allowance", amount: 2000 },
    ],
    deductions: () => [],
    taxYearStart: { month: 1, day: 1 },
    taxYearLabel: (y) => `${y}`,
    declarations: [],
    declarationNote: "No personal income tax in the UAE.",
  },
  SA: {
    code: "SA",
    currency: "SAR",
    locale: "en-SA",
    incomeTaxName: null,
    earnings: [
      { name: "Basic salary", amount: 15000 },
      { name: "Housing allowance", amount: 3750 },
      { name: "Transport allowance", amount: 1500 },
    ],
    // GOSI applies to Saudi nationals (9.75% of basic + housing); the sample staff are expatriates.
    deductions: () => [],
    taxYearStart: { month: 1, day: 1 },
    taxYearLabel: (y) => `${y}`,
    declarations: [],
    declarationNote: "No personal income tax in Saudi Arabia.",
  },
  DE: {
    code: "DE",
    currency: "EUR",
    locale: "de-DE",
    incomeTaxName: "Lohnsteuer",
    earnings: [{ name: "Grundgehalt", amount: 5200 }],
    deductions: (e) => {
      const gross = total(e);
      return [
        { name: "Lohnsteuer", amount: pct(gross, 0.19) },
        { name: "Rentenversicherung", amount: pct(gross, 0.093) },
        { name: "Krankenversicherung", amount: pct(gross, 0.0855) },
        { name: "Pflegeversicherung", amount: pct(gross, 0.018) },
        { name: "Arbeitslosenversicherung", amount: pct(gross, 0.013) },
      ];
    },
    taxYearStart: { month: 1, day: 1 },
    taxYearLabel: (y) => `Steuerjahr ${y}`,
    declarations: [
      { code: "Werbungskosten", label: "Werbungskosten — work expenses" },
      { code: "Riester", label: "Riester pension", cap: 2100 },
      { code: "Freibetrag", label: "Lohnsteuer-Freibetrag" },
    ],
    declarationNote: "Allowances (Freibeträge) are registered with the Finanzamt and flow into ELStAM.",
  },
};

export function payRulesFor(country: CountryCode | undefined): CountryPayRules {
  return COUNTRY_PAY[country ?? "IN"] ?? COUNTRY_PAY.IN;
}

/** Per-country caps on a single expense / reimbursement claim and on a cash advance, in local currency. */
const CLAIM_LIMITS: Record<CountryCode, { maxClaim: number; maxCashAdvance: number; receiptAbove: number }> = {
  IN: { maxClaim: 200000, maxCashAdvance: 100000, receiptAbove: 500 },
  US: { maxClaim: 2500, maxCashAdvance: 1500, receiptAbove: 25 },
  GB: { maxClaim: 2000, maxCashAdvance: 1200, receiptAbove: 20 },
  AU: { maxClaim: 3500, maxCashAdvance: 2000, receiptAbove: 40 },
  CA: { maxClaim: 3000, maxCashAdvance: 1800, receiptAbove: 30 },
  AE: { maxClaim: 9000, maxCashAdvance: 5000, receiptAbove: 100 },
  SA: { maxClaim: 9000, maxCashAdvance: 5000, receiptAbove: 100 },
  DE: { maxClaim: 2200, maxCashAdvance: 1300, receiptAbove: 25 },
};

/** Largest single claim and cash advance an employee in `country` can raise without Finance. */
export function claimLimitsFor(country: CountryCode | undefined): { maxClaim: number; maxCashAdvance: number } {
  const limits = CLAIM_LIMITS[country ?? "IN"] ?? CLAIM_LIMITS.IN;
  return { maxClaim: limits.maxClaim, maxCashAdvance: limits.maxCashAdvance };
}

/** Claims above this amount (local currency) need a receipt attached. */
export function receiptThresholdFor(country: CountryCode | undefined): number {
  return (CLAIM_LIMITS[country ?? "IN"] ?? CLAIM_LIMITS.IN).receiptAbove;
}

const LEGAL_ENTITY: Record<CountryCode, string> = {
  IN: "Infotech India Pvt Ltd",
  US: "Infotech Inc",
  GB: "Infotech UK Ltd",
  AU: "Infotech Australia Pty",
  CA: "Infotech Canada Inc",
  AE: "Infotech Middle East FZ",
  SA: "Infotech Saudi LLC",
  DE: "Infotech Germany GmbH",
};

/** The employing legal entity in a country — used when the employee record doesn't carry one. */
export function legalEntityFor(country: CountryCode | undefined): string {
  return LEGAL_ENTITY[country ?? "IN"] ?? LEGAL_ENTITY.IN;
}

/** Formats an amount in a country's currency with no decimals, e.g. "$7,000" or "₹38,000". */
export function money(amount: number, currency = "INR"): string {
  const rules = Object.values(COUNTRY_PAY).find((item) => item.currency === currency);
  return new Intl.NumberFormat(rules?.locale ?? "en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(amount);
}

/** Currency saved on a claim / advance record; older records without one were raised in INR. */
export function itemCurrency(item: object, fallback = "INR"): string {
  const value = (item as { currency?: unknown }).currency;
  return typeof value === "string" && value ? value : fallback;
}

/** Totals amounts per currency, e.g. "₹12,000 + $40". Items without a currency count as `fallback`. */
export function moneyTotals(items: { amount: number; currency?: string }[], fallback = "INR"): string {
  const totals = new Map<string, number>();
  for (const item of items) {
    const currency = item.currency ?? fallback;
    totals.set(currency, (totals.get(currency) ?? 0) + item.amount);
  }
  if (totals.size === 0) return money(0, fallback);
  return [...totals].map(([currency, amount]) => money(amount, currency)).join(" + ");
}

/** First year of the tax year that contains `iso`. */
export function taxYearStartFor(rules: CountryPayRules, iso: string): number {
  const [year, month, day] = iso.split("-").map(Number);
  const { month: m, day: d } = rules.taxYearStart;
  return month > m || (month === m && day >= d) ? year : year - 1;
}

/** The current and next tax year labels — what an employee can declare for. */
export function declarableTaxYears(rules: CountryPayRules, today: string): string[] {
  const start = taxYearStartFor(rules, today);
  return [rules.taxYearLabel(start), rules.taxYearLabel(start + 1)];
}

/** `bonusRate` is the month's bonus as a share of the first (basic) earnings line. */
export function monthlyPay(rules: CountryPayRules, scale: number, bonusRate: number): { earnings: PayLine[]; deductions: PayLine[] } {
  const earnings = rules.earnings.map((item) => ({ name: item.name, amount: Math.round(item.amount * scale) }));
  if (bonusRate > 0) earnings.push({ name: "Performance bonus", amount: Math.round(earnings[0].amount * bonusRate) });
  return { earnings, deductions: rules.deductions(earnings) };
}
