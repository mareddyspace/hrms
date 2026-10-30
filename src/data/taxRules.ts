import type { CountryCode, PayLine } from "../model.ts";
import { COUNTRY_PAY, money, payRulesFor } from "../countryPay.ts";

/**
 * Income tax and payroll contributions for the 8 countries, on a year's gross pay.
 * Simplified but realistic: single filer, no other income, the main allowances and contribution ceilings.
 * Payslips take one-twelfth of the annual figure on annualised pay (src/data/payslipGenerator.ts).
 * Each country notes the year its rates come from.
 */

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

/* ── India · FY 2026-27 · Finance Act 2025 slabs (new regime default, 87A rebate to ₹12L), old regime unchanged ── */
const IN_NEW: Band[] = [[400000, 0], [800000, 0.05], [1200000, 0.1], [1600000, 0.15], [2000000, 0.2], [2400000, 0.25], [Infinity, 0.3]];
const IN_OLD: Band[] = [[250000, 0], [500000, 0.05], [1000000, 0.2], [Infinity, 0.3]];
/** PF: 12% of basic from the employee, matched by the employer (on full basic, as TimeZ does). */
const IN_PF_RATE = 0.12;
/** Professional tax (Karnataka): ₹200 a month. */
const IN_PT_YEAR = 2400;

function annualIndia(gross: number, o: TaxOptions): AnnualPay {
  const basic = o.basicAnnual ?? gross * 0.5;
  const pf = r0(basic * IN_PF_RATE);
  const pt = gross > 0 ? IN_PT_YEAR : 0;
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

/* ── USA · tax year 2026 · IRS Rev. Proc. 2025-32 (single), SSA wage base $184,500 ── */
const US_FED: Band[] = [[12400, 0.1], [50400, 0.12], [105700, 0.22], [201775, 0.24], [256225, 0.32], [640600, 0.35], [Infinity, 0.37]];
const US_STANDARD = 16100;
const US_STATE: Record<string, { code: string; rate: number }> = {
  "San Francisco": { code: "CA", rate: 0.06 },
  "New York": { code: "NY", rate: 0.055 },
  Austin: { code: "TX", rate: 0 },
};

function annualUS(gross: number, o: TaxOptions): AnnualPay {
  const extra = declared("US", o, ["401(k)", "HSA"]);
  const k401 = r0(Math.min(24500, gross * 0.05 + (extra.find((d) => d.name === "401(k)")?.amount ?? 0)));
  const hsa = extra.find((d) => d.name === "HSA")?.amount ?? 0;
  const wages = Math.max(0, gross - k401 - hsa);
  const taxable = Math.max(0, wages - US_STANDARD);
  const fed = progressive(taxable, US_FED);
  const state = US_STATE[o.location ?? ""] ?? { code: "NY", rate: 0.055 };
  const stateTax = wages * state.rate;
  const stateName = `State income tax (${state.code})`;
  // FICA 7.65%: Social Security 6.2% to the wage base, Medicare 1.45% (+0.9% over $200k). Employer matches.
  const ss = r0(Math.min(gross, 184500) * 0.062);
  const medicare = r0(gross * 0.0145 + Math.max(0, gross - 200000) * 0.009);
  return {
    deductions: [
      { name: "Federal income tax", amount: r0(fed) },
      ...(state.rate > 0 ? [{ name: stateName, amount: r0(stateTax) }] : []),
      { name: "Social Security", amount: ss },
      { name: "Medicare", amount: medicare },
      { name: "401(k)", amount: k401 },
      ...(hsa > 0 ? [{ name: "HSA", amount: hsa }] : []),
    ],
    employer: [
      { name: "401(k) match (4%)", amount: r0(Math.min(k401, gross * 0.04)) },
      { name: "Employer FICA", amount: r0(Math.min(gross, 184500) * 0.062 + gross * 0.0145) },
    ],
    taxLines: ["Federal income tax", stateName],
    taxable: r0(taxable),
    basis: `Single · standard deduction $16,100 · ${state.code} ${(state.rate * 100).toFixed(1)}%`,
    reliefs: [
      { name: "401(k) pre-tax", amount: k401 },
      ...(hsa > 0 ? [{ name: "HSA pre-tax", amount: hsa }] : []),
      { name: "Standard deduction", amount: Math.min(US_STANDARD, wages) },
    ],
    components: [
      { name: "Federal", amount: r0(fed) },
      { name: `State (${state.code})`, amount: r0(stateTax) },
    ],
  };
}

/* ── UK · tax year 2026/27 · England bands (allowances frozen), Class 1 NI 8% / 2% ── */
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
    // Auto-enrolment: 3% employer pension; employer NI 15% above £5,000 (from April 2025).
    employer: [
      { name: "Employer pension (3%)", amount: r0(gross * 0.03) },
      { name: "Employer NI", amount: r0(Math.max(0, adjusted - 5000) * 0.15) },
    ],
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

/* ── Australia · 2026-27 · resident rates (15% band from 1 July 2026), Medicare levy 2%, super guarantee 12% ── */
const AU_RES: Band[] = [[18200, 0], [45000, 0.15], [135000, 0.3], [190000, 0.37], [Infinity, 0.45]];

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

/* ── Canada · tax year 2026 · federal (lowest rate 14%), Ontario, CPP 5.95% to $74,600, EI 1.63% to $68,900 ── */
const CA_FED: Band[] = [[58523, 0.14], [117045, 0.205], [181440, 0.26], [258482, 0.29], [Infinity, 0.33]];
const CA_ON: Band[] = [[53891, 0.0505], [107785, 0.0915], [150000, 0.1116], [220000, 0.1216], [Infinity, 0.1316]];

function annualCA(gross: number, o: TaxOptions): AnnualPay {
  const decl = declared("CA", o, ["RRSP", "FHSA"]);
  const taxable = Math.max(0, gross - sumLines(decl));
  // Basic personal amounts are credits at the lowest rate.
  const fed = Math.max(0, progressive(taxable, CA_FED) - 16452 * 0.14);
  const prov = Math.max(0, progressive(taxable, CA_ON) - 12747 * 0.0505);
  const cpp = Math.max(0, Math.min(gross, 74600) - 3500) * 0.0595;
  const ei = Math.min(gross, 68900) * 0.0163;
  return {
    deductions: [
      { name: "Federal income tax", amount: r0(fed) },
      { name: "Provincial tax (ON)", amount: r0(prov) },
      { name: "CPP", amount: r0(cpp) },
      { name: "EI", amount: r0(ei) },
    ],
    // Employer matches CPP and pays EI at 1.4 times the employee rate.
    employer: [{ name: "Employer CPP / EI", amount: r0(cpp + ei * 1.4) }],
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

/* ── Germany · 2026 · §32a EStG tariff (Grundfreibetrag €12,348), Soli over €20,350 tax, 2026 contribution ceilings ── */
function lohnsteuer(zvE: number): number {
  const x = Math.floor(zvE);
  if (x <= 12348) return 0;
  if (x <= 17799) {
    const y = (x - 12348) / 10000;
    return (914.51 * y + 1400) * y;
  }
  if (x <= 69878) {
    const z = (x - 17799) / 10000;
    return (173.1 * z + 2397) * z + 1034.87;
  }
  if (x <= 277825) return 0.42 * x - 11135.63;
  return 0.45 * x - 19470.38;
}

function annualDE(gross: number, o: TaxOptions): AnnualPay {
  // Contribution ceilings: pension/unemployment 101,400; health/care 69,750 a year.
  const pensionBase = Math.min(gross, 101400);
  const healthBase = Math.min(gross, 69750);
  const rv = pensionBase * 0.093;
  const kv = healthBase * 0.0875; // 7.3% + half the average 2.9% extra contribution
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
  const soli = tax <= 20350 ? 0 : Math.min(tax * 0.055, (tax - 20350) * 0.119);
  return {
    deductions: [
      { name: "Lohnsteuer", amount: r0(tax) },
      ...(soli > 0 ? [{ name: "Solidaritätszuschlag", amount: r0(soli) }] : []),
      { name: "Rentenversicherung", amount: r0(rv) },
      { name: "Krankenversicherung", amount: r0(kv) },
      { name: "Pflegeversicherung", amount: r0(pv) },
      { name: "Arbeitslosenversicherung", amount: r0(av) },
    ],
    // Employer pays the same shares (care insurance 1.8%, no childless surcharge).
    employer: [{ name: "Employer social insurance", amount: r0(rv + kv + pv + av) }],
    taxLines: ["Lohnsteuer", "Solidaritätszuschlag"],
    taxable: r0(taxable),
    basis: "Steuerklasse I · Grundfreibetrag €12,348",
    reliefs,
    components: [
      { name: "Lohnsteuer", amount: r0(tax) },
      { name: "Solidaritätszuschlag", amount: r0(soli) },
    ],
  };
}

/* ── UAE / Saudi Arabia · 2026 · no personal income tax; Saudi GOSI (Social Insurance Law 2024 rates) ── */
function annualGulf(code: CountryCode, gross: number, o: TaxOptions): AnnualPay {
  // GOSI on basic + housing (base capped at 45,000 a month). Saudi nationals: 9.75% employee
  // (9% pension + 0.75% SANED), 11.75% employer. Others: 2% occupational hazards, employer only.
  const saudi = code === "SA";
  const national = saudi && /saudi/i.test(o.nationality ?? "");
  const base = Math.min((o.basicAnnual ?? gross * 0.75) + (o.housingAnnual ?? 0), 45000 * 12);
  const gosi = national ? r0(base * 0.0975) : 0;
  const employerGosi = saudi ? r0(base * (national ? 0.1175 : 0.02)) : 0;
  return {
    deductions: gosi > 0 ? [{ name: "GOSI", amount: gosi }] : [],
    employer: employerGosi > 0 ? [{ name: national ? "Employer GOSI (11.75%)" : "GOSI hazards (2%)", amount: employerGosi }] : [],
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

/**
 * Benefit plans that show up on the payslip: the employee deduction and employer contribution lines
 * for each plan id (plan ids are the same in the built-in catalogue and the server seed).
 */
export const PLAN_PAY_LINES: Record<string, { employee: string[]; employer: string[] }> = {
  "bp-in-pf": { employee: ["Provident Fund"], employer: ["Employer PF"] },
  "bp-us-401": { employee: ["401(k)"], employer: ["401(k) match (4%)"] },
  "bp-uk-pen": { employee: ["Pension (salary sacrifice)"], employer: ["Employer pension (3%)"] },
  "bp-au-super": { employee: ["Salary-sacrifice super"], employer: ["Superannuation (12%)"] },
};
