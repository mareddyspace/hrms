import type { CountryCode, PayLine } from "./model.ts";

/**
 * Pay and tax rules per country. Tax is worked out on annualised income with simplified 2026
 * brackets, allowances and contribution ceilings — realistic on a payslip, not a payroll engine.
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
  /** Deductions for a month, from that month's earnings (annualised with default options). */
  deductions: (earnings: PayLine[]) => PayLine[];
  /** Weekly hours above which hourly staff earn overtime, and the overtime multiplier. */
  overtime: { weeklyHours: number; factor: number };
  /** Month (1–12) the tax year starts, and the day in that month. */
  taxYearStart: { month: number; day: number };
  /** Label for the tax year, e.g. "FY 2026-27" or "Tax year 2026". */
  taxYearLabel: (startYear: number) => string;
  /** Tax-saving declarations; empty when the country has no personal income tax. */
  declarations: TaxDeclarationSection[];
  /** One line explaining declarations in this country, shown on the declarations page. */
  declarationNote: string;
}

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
    deductions: (e) => statutoryMonthly("IN", e),
    overtime: { weeklyHours: 48, factor: 2 },
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
    deductions: (e) => statutoryMonthly("US", e),
    overtime: { weeklyHours: 40, factor: 1.5 },
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
    deductions: (e) => statutoryMonthly("GB", e),
    overtime: { weeklyHours: 48, factor: 1 },
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
    deductions: (e) => statutoryMonthly("AU", e),
    overtime: { weeklyHours: 38, factor: 1.5 },
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
    deductions: (e) => statutoryMonthly("CA", e),
    overtime: { weeklyHours: 44, factor: 1.5 },
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
    deductions: (e) => statutoryMonthly("AE", e),
    overtime: { weeklyHours: 48, factor: 1.5 },
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
    // GOSI applies to Saudi nationals only (9.75% of basic + housing).
    deductions: (e) => statutoryMonthly("SA", e),
    overtime: { weeklyHours: 48, factor: 1.5 },
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
    deductions: (e) => statutoryMonthly("DE", e),
    overtime: { weeklyHours: 40, factor: 1.5 },
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
  IN: "TimeZ India Pvt Ltd",
  US: "TimeZ Inc",
  GB: "TimeZ UK Ltd",
  AU: "TimeZ Australia Pty",
  CA: "TimeZ Canada Inc",
  AE: "TimeZ Middle East FZ",
  SA: "TimeZ Saudi LLC",
  DE: "TimeZ Germany GmbH",
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

/* ───────────────────────── Annual tax engine ───────────────────────── */

export type IndiaRegime = "new" | "old";

export interface TaxOptions {
  /** India only; defaults to the new regime. */
  regime?: IndiaRegime;
  /** Verified declarations for the tax year (same tax year as the payslip). */
  declarations?: { section: string; amount: number }[];
  /** Work location — picks the US state. */
  location?: string;
  nationality?: string;
  /** Annual basic pay (India PF, Saudi GOSI). Defaults to half of gross. */
  basicAnnual?: number;
  /** Annual housing allowance / HRA. */
  housingAnnual?: number;
}

export interface AnnualPay {
  /** Employee deductions for the year, in payslip order. */
  deductions: PayLine[];
  /** Employer contributions for the year (paid on top, not deducted). */
  employer: PayLine[];
  /** Names of the deduction lines that are income tax. */
  taxLines: string[];
  /** Income the tax is charged on, after allowances and reliefs. */
  taxable: number;
  /** Regime or allowance used, e.g. "New regime" or "Personal allowance £12,570". */
  basis: string;
  /** Allowances, pre-tax contributions and declarations taken off before tax. */
  reliefs: PayLine[];
  /** How the annual income tax adds up, e.g. tax + cess. */
  components: PayLine[];
}

type Band = [upTo: number, rate: number];

function progressive(income: number, bands: Band[]): number {
  let tax = 0;
  let prev = 0;
  for (const [upTo, rate] of bands) {
    if (income <= prev) break;
    tax += (Math.min(income, upTo) - prev) * rate;
    prev = upTo;
  }
  return tax;
}

const IN_NEW: Band[] = [[400000, 0], [800000, 0.05], [1200000, 0.1], [1600000, 0.15], [2000000, 0.2], [2400000, 0.25], [Infinity, 0.3]];
const IN_OLD: Band[] = [[250000, 0], [500000, 0.05], [1000000, 0.2], [Infinity, 0.3]];
const US_FED: Band[] = [[12400, 0.1], [50400, 0.12], [105700, 0.22], [201775, 0.24], [256225, 0.32], [640600, 0.35], [Infinity, 0.37]];
const AU_RES: Band[] = [[18200, 0], [45000, 0.16], [135000, 0.3], [190000, 0.37], [Infinity, 0.45]];
const CA_FED: Band[] = [[57375, 0.145], [114750, 0.205], [177882, 0.26], [253414, 0.29], [Infinity, 0.33]];
const CA_ON: Band[] = [[53891, 0.0505], [107785, 0.0915], [150000, 0.1116], [220000, 0.1216], [Infinity, 0.1316]];
const US_STATE: Record<string, { code: string; rate: number }> = {
  "San Francisco": { code: "CA", rate: 0.06 },
  "New York": { code: "NY", rate: 0.055 },
  Austin: { code: "TX", rate: 0 },
};

const r0 = (n: number) => Math.round(n);
const sumLines = (lines: PayLine[]) => lines.reduce((acc, l) => acc + l.amount, 0);

/** Verified declarations per section, each capped at its yearly limit. */
function declared(code: CountryCode, options: TaxOptions, sections: string[], capOverride: Record<string, number> = {}): PayLine[] {
  const rules = COUNTRY_PAY[code];
  return sections
    .map((section) => {
      const sum = (options.declarations ?? []).filter((d) => d.section === section).reduce((acc, d) => acc + d.amount, 0);
      const cap = capOverride[section] ?? rules.declarations.find((d) => d.code === section)?.cap ?? Infinity;
      return { name: section, amount: r0(Math.min(sum, cap)) };
    })
    .filter((item) => item.amount > 0);
}

function annualIndia(gross: number, o: TaxOptions): AnnualPay {
  const basic = o.basicAnnual ?? gross * 0.5;
  const pf = r0(Math.min(basic * 0.12, 1800 * 12));
  const pt = gross > 0 ? 2400 : 0;
  const regime = o.regime ?? "new";
  let reliefs: PayLine[];
  let taxable: number;
  let tax: number;
  if (regime === "new") {
    reliefs = [{ name: "Standard deduction", amount: Math.min(75000, gross) }];
    taxable = Math.max(0, gross - 75000);
    tax = progressive(taxable, IN_NEW);
    // Section 87A rebate: no tax up to 12L taxable, with marginal relief just above it.
    tax = taxable <= 1200000 ? 0 : Math.min(tax, taxable - 1200000);
  } else {
    const decl = declared("IN", o, ["80C", "80CCD(1B)", "80D", "80D-parents", "80E", "24(b)", "HRA"], { HRA: o.housingAnnual ?? 0 });
    const c80 = decl.find((d) => d.name === "80C")?.amount ?? 0;
    reliefs = [
      { name: "Standard deduction", amount: Math.min(50000, gross) },
      { name: "Professional Tax", amount: pt },
      { name: "80C (incl. PF)", amount: Math.min(150000, c80 + pf) },
      ...decl.filter((d) => d.name !== "80C"),
    ].filter((item) => item.amount > 0);
    taxable = Math.max(0, gross - sumLines(reliefs));
    tax = progressive(taxable, IN_OLD);
    tax = taxable <= 500000 ? 0 : tax;
  }
  const cess = tax * 0.04;
  return {
    deductions: [
      { name: "Provident Fund", amount: pf },
      { name: "Professional Tax", amount: pt },
      { name: "TDS", amount: r0(tax + cess) },
    ],
    employer: [{ name: "Employer PF", amount: pf }],
    taxLines: ["TDS"],
    taxable: r0(taxable),
    basis: regime === "new" ? "New regime" : "Old regime",
    reliefs,
    components: [
      { name: "Income tax", amount: r0(tax) },
      { name: "Health & education cess (4%)", amount: r0(cess) },
    ],
  };
}

function annualUS(gross: number, o: TaxOptions): AnnualPay {
  const extra = declared("US", o, ["401(k)", "HSA"]);
  const k401 = r0(Math.min(24500, gross * 0.05 + (extra.find((d) => d.name === "401(k)")?.amount ?? 0)));
  const hsa = extra.find((d) => d.name === "HSA")?.amount ?? 0;
  const wages = Math.max(0, gross - k401 - hsa);
  const taxable = Math.max(0, wages - 16100);
  const fed = progressive(taxable, US_FED);
  const state = US_STATE[o.location ?? ""] ?? { code: "NY", rate: 0.055 };
  const stateTax = wages * state.rate;
  const stateName = `State income tax (${state.code})`;
  return {
    deductions: [
      { name: "Federal income tax", amount: r0(fed) },
      ...(state.rate > 0 ? [{ name: stateName, amount: r0(stateTax) }] : []),
      { name: "Social Security", amount: r0(Math.min(gross, 184500) * 0.062) },
      { name: "Medicare", amount: r0(gross * 0.0145 + Math.max(0, gross - 200000) * 0.009) },
      { name: "401(k)", amount: k401 },
      ...(hsa > 0 ? [{ name: "HSA", amount: hsa }] : []),
    ],
    employer: [],
    taxLines: ["Federal income tax", stateName],
    taxable: r0(taxable),
    basis: `Single · standard deduction $16,100 · ${state.code} ${(state.rate * 100).toFixed(1)}%`,
    reliefs: [
      { name: "401(k) pre-tax", amount: k401 },
      ...(hsa > 0 ? [{ name: "HSA pre-tax", amount: hsa }] : []),
      { name: "Standard deduction", amount: Math.min(16100, wages) },
    ],
    components: [
      { name: "Federal", amount: r0(fed) },
      { name: `State (${state.code})`, amount: r0(stateTax) },
    ],
  };
}

function annualUK(gross: number, o: TaxOptions): AnnualPay {
  const extra = declared("GB", o, ["Pension"]);
  const pension = r0(gross * 0.05 + (extra[0]?.amount ?? 0));
  const adjusted = Math.max(0, gross - pension);
  // Personal allowance tapers by 1 for every 2 earned over 100k.
  const allowance = Math.max(0, 12570 - Math.max(0, adjusted - 100000) / 2);
  const taxable = Math.max(0, adjusted - allowance);
  const tax = progressive(taxable, [[37700, 0.2], [125140, 0.4], [Infinity, 0.45]]);
  const ni = Math.max(0, Math.min(adjusted, 50270) - 12570) * 0.08 + Math.max(0, adjusted - 50270) * 0.02;
  return {
    deductions: [
      { name: "Income tax (PAYE)", amount: r0(tax) },
      { name: "National Insurance", amount: r0(ni) },
      { name: "Pension (salary sacrifice)", amount: pension },
    ],
    employer: [],
    taxLines: ["Income tax (PAYE)"],
    taxable: r0(taxable),
    basis: `Personal allowance ${money(r0(allowance), "GBP")}`,
    reliefs: [
      { name: "Pension (salary sacrifice)", amount: pension },
      { name: "Personal allowance", amount: r0(Math.min(allowance, adjusted)) },
    ],
    components: [{ name: "Income tax", amount: r0(tax) }],
  };
}

function annualAU(gross: number, o: TaxOptions): AnnualPay {
  const sacrifice = declared("AU", o, ["Super"])[0]?.amount ?? 0;
  const taxable = Math.max(0, gross - sacrifice);
  const tax = progressive(taxable, AU_RES);
  const medicare = taxable * 0.02;
  return {
    deductions: [
      { name: "PAYG withholding", amount: r0(tax) },
      { name: "Medicare levy", amount: r0(medicare) },
      ...(sacrifice > 0 ? [{ name: "Salary-sacrifice super", amount: sacrifice }] : []),
    ],
    employer: [{ name: "Superannuation (12%)", amount: r0(gross * 0.12) }],
    taxLines: ["PAYG withholding", "Medicare levy"],
    taxable: r0(taxable),
    basis: "Resident rates · tax-free threshold A$18,200",
    reliefs: sacrifice > 0 ? [{ name: "Salary-sacrifice super", amount: sacrifice }] : [],
    components: [
      { name: "Income tax", amount: r0(tax) },
      { name: "Medicare levy (2%)", amount: r0(medicare) },
    ],
  };
}

function annualCA(gross: number, o: TaxOptions): AnnualPay {
  const decl = declared("CA", o, ["RRSP", "FHSA"]);
  const taxable = Math.max(0, gross - sumLines(decl));
  // Basic personal amounts are credits at the lowest rate.
  const fed = Math.max(0, progressive(taxable, CA_FED) - 16452 * 0.145);
  const prov = Math.max(0, progressive(taxable, CA_ON) - 12747 * 0.0505);
  const cpp = Math.max(0, Math.min(gross, 74600) - 3500) * 0.0595;
  const ei = Math.min(gross, 65700) * 0.0164;
  return {
    deductions: [
      { name: "Federal income tax", amount: r0(fed) },
      { name: "Provincial tax (ON)", amount: r0(prov) },
      { name: "CPP", amount: r0(cpp) },
      { name: "EI", amount: r0(ei) },
    ],
    employer: [],
    taxLines: ["Federal income tax", "Provincial tax (ON)"],
    taxable: r0(taxable),
    basis: "Ontario · basic personal amounts",
    reliefs: decl,
    components: [
      { name: "Federal", amount: r0(fed) },
      { name: "Ontario", amount: r0(prov) },
    ],
  };
}

/** Income tax tariff (§32a EStG, single), simplified. */
function lohnsteuer(zvE: number): number {
  const x = Math.floor(zvE);
  if (x <= 12096) return 0;
  if (x <= 17443) {
    const y = (x - 12096) / 10000;
    return (932.3 * y + 1400) * y;
  }
  if (x <= 68480) {
    const z = (x - 17443) / 10000;
    return (176.64 * z + 2397) * z + 1015.13;
  }
  if (x <= 277825) return 0.42 * x - 10911.92;
  return 0.45 * x - 19246.67;
}

function annualDE(gross: number, o: TaxOptions): AnnualPay {
  // Contribution ceilings: pension/unemployment 101,400; health/care 69,750 a year.
  const pensionBase = Math.min(gross, 101400);
  const healthBase = Math.min(gross, 69750);
  const rv = pensionBase * 0.093;
  const kv = healthBase * 0.0875;
  const pv = healthBase * 0.018;
  const av = pensionBase * 0.013;
  const decl = declared("DE", o, ["Werbungskosten", "Riester", "Freibetrag"]);
  const work = Math.max(1230, decl.find((d) => d.name === "Werbungskosten")?.amount ?? 0);
  const reliefs: PayLine[] = [
    { name: "Werbungskosten", amount: Math.min(work, gross) },
    { name: "Vorsorge (social insurance)", amount: r0(rv + kv + pv) },
    ...decl.filter((d) => d.name !== "Werbungskosten"),
  ];
  const taxable = Math.max(0, gross - sumLines(reliefs));
  const tax = lohnsteuer(taxable);
  const soli = tax <= 19950 ? 0 : Math.min(tax * 0.055, (tax - 19950) * 0.119);
  return {
    deductions: [
      { name: "Lohnsteuer", amount: r0(tax) },
      ...(soli > 0 ? [{ name: "Solidaritätszuschlag", amount: r0(soli) }] : []),
      { name: "Rentenversicherung", amount: r0(rv) },
      { name: "Krankenversicherung", amount: r0(kv) },
      { name: "Pflegeversicherung", amount: r0(pv) },
      { name: "Arbeitslosenversicherung", amount: r0(av) },
    ],
    employer: [],
    taxLines: ["Lohnsteuer", "Solidaritätszuschlag"],
    taxable: r0(taxable),
    basis: "Steuerklasse I · Grundfreibetrag €12,096",
    reliefs,
    components: [
      { name: "Lohnsteuer", amount: r0(tax) },
      { name: "Solidaritätszuschlag", amount: r0(soli) },
    ],
  };
}

function annualGulf(code: CountryCode, gross: number, o: TaxOptions): AnnualPay {
  // GOSI: Saudi nationals only, 9.75% of basic + housing (base capped at 45,000 a month).
  const national = code === "SA" && /saudi/i.test(o.nationality ?? "");
  const base = Math.min((o.basicAnnual ?? gross * 0.75) + (o.housingAnnual ?? 0), 45000 * 12);
  const gosi = national ? r0(base * 0.0975) : 0;
  return {
    deductions: gosi > 0 ? [{ name: "GOSI", amount: gosi }] : [],
    employer: [],
    taxLines: [],
    taxable: 0,
    basis: national ? "No income tax · GOSI 9.75%" : "No personal income tax",
    reliefs: [],
    components: [],
  };
}

/** Employee deductions, employer contributions and the income tax working for a year's gross pay. */
export function annualPayFor(country: CountryCode | undefined, gross: number, options: TaxOptions = {}): AnnualPay {
  const code = payRulesFor(country).code;
  switch (code) {
    case "IN":
      return annualIndia(gross, options);
    case "US":
      return annualUS(gross, options);
    case "GB":
      return annualUK(gross, options);
    case "AU":
      return annualAU(gross, options);
    case "CA":
      return annualCA(gross, options);
    case "DE":
      return annualDE(gross, options);
    default:
      return annualGulf(code, gross, options);
  }
}

/** Basic and housing lines of a month's earnings — the bases for PF / HRA / GOSI. */
export function payBases(earnings: PayLine[]): { basic: number; housing: number } {
  return {
    basic: earnings[0]?.amount ?? 0,
    housing: line(earnings, "HRA") || line(earnings, "Housing allowance"),
  };
}

/** A month's deductions from that month's earnings, annualised with default options (seed payslips). */
function statutoryMonthly(code: CountryCode, earnings: PayLine[]): PayLine[] {
  const bases = payBases(earnings);
  const annual = annualPayFor(code, total(earnings) * 12, { basicAnnual: bases.basic * 12, housingAnnual: bases.housing * 12 });
  return annual.deductions.map((item) => ({ name: item.name, amount: Math.round(item.amount / 12) }));
}
