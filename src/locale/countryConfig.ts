import { TIMEZ_COUNTRIES, type CountryCode } from "../model.ts";

export type AppLanguage = "en" | "hi" | "de" | "ar";

export interface CountryHoliday {
  date: string;
  name: string;
}

export interface LeavePolicySample {
  name: string;
  annualDays: number;
  carryForwardDays: number;
  note: string;
}

export interface WorkingTimeSample {
  weekStart: "Sunday" | "Monday";
  standardHours: string;
  workDays: string;
  note: string;
}

export interface CountryBenefitSample {
  id: string;
  name: string;
  category: string;
  summary: string;
}

export interface CountryDocumentSample {
  id: string;
  name: string;
  required: boolean;
  note: string;
}

export interface CountrySettings {
  code: CountryCode;
  name: string;
  currency: string;
  currencyLocale: string;
  timeZone: string;
  legalEntity: string;
  languages: AppLanguage[];
  holidays: CountryHoliday[];
  leavePolicy: LeavePolicySample;
  workingTime: WorkingTimeSample;
  benefits: CountryBenefitSample[];
  documents: CountryDocumentSample[];
}

const BASE: Record<CountryCode, Omit<CountrySettings, "code" | "name" | "currency" | "timeZone">> = {
  IN: {
    currencyLocale: "en-IN",
    legalEntity: "TimeZ India Pvt Ltd",
    languages: ["en", "hi"],
    holidays: [
      { date: "2026-01-26", name: "Republic Day" },
      { date: "2026-08-15", name: "Independence Day" },
      { date: "2026-10-20", name: "Dussehra" },
      { date: "2026-11-08", name: "Diwali" },
    ],
    leavePolicy: {
      name: "India leave policy",
      annualDays: 18,
      carryForwardDays: 5,
      note: "",
    },
    workingTime: {
      weekStart: "Monday",
      standardHours: "09:30–18:30 IST",
      workDays: "Mon–Fri",
      note: "",
    },
    benefits: [
      { id: "in-med", name: "Group Medical", category: "Medical", summary: "Floater plan" },
      { id: "in-pf", name: "Provident Fund", category: "Retirement", summary: "Statutory illustration" },
    ],
    documents: [
      { id: "in-pan", name: "PAN", required: true, note: "Onboarding checklist item" },
      { id: "in-aadhaar", name: "Aadhaar", required: false, note: "Optional" },
    ],
  },
  US: {
    currencyLocale: "en-US",
    legalEntity: "TimeZ Inc",
    languages: ["en"],
    holidays: [
      { date: "2026-01-01", name: "New Year's Day" },
      { date: "2026-07-04", name: "Independence Day" },
      { date: "2026-11-26", name: "Thanksgiving" },
      { date: "2026-12-25", name: "Christmas Day" },
    ],
    leavePolicy: {
      name: "US PTO policy",
      annualDays: 15,
      carryForwardDays: 0,
      note: "",
    },
    workingTime: {
      weekStart: "Sunday",
      standardHours: "09:00–17:00 local",
      workDays: "Mon–Fri",
      note: "",
    },
    benefits: [
      { id: "us-med", name: "Medical PPO", category: "Medical", summary: "Open enrollment" },
      { id: "us-401", name: "401(k)", category: "Retirement", summary: "Match illustration" },
    ],
    documents: [
      { id: "us-i9", name: "I-9 worksheet", required: true, note: "Employment eligibility" },
      { id: "us-w4", name: "W-4", required: true, note: "Tax form" },
    ],
  },
  GB: {
    currencyLocale: "en-GB",
    legalEntity: "TimeZ UK Ltd",
    languages: ["en"],
    holidays: [
      { date: "2026-01-01", name: "New Year's Day" },
      { date: "2026-04-03", name: "Good Friday" },
      { date: "2026-12-25", name: "Christmas Day" },
      { date: "2026-12-28", name: "Boxing Day" },
    ],
    leavePolicy: {
      name: "UK annual leave policy",
      annualDays: 25,
      carryForwardDays: 5,
      note: "",
    },
    workingTime: {
      weekStart: "Monday",
      standardHours: "09:00–17:30 GMT/BST",
      workDays: "Mon–Fri",
      note: "",
    },
    benefits: [
      { id: "uk-pmi", name: "Private Medical", category: "Medical", summary: "PMI" },
      { id: "uk-pen", name: "Workplace pension", category: "Retirement", summary: "Pension illustration" },
    ],
    documents: [
      { id: "uk-rtw", name: "Right to work check", required: true, note: "Checklist" },
      { id: "uk-p45", name: "P45/P60", required: false, note: "Payroll document" },
    ],
  },
  AU: {
    currencyLocale: "en-AU",
    legalEntity: "TimeZ Australia Pty",
    languages: ["en"],
    holidays: [
      { date: "2026-01-26", name: "Australia Day" },
      { date: "2026-04-25", name: "ANZAC Day" },
      { date: "2026-12-25", name: "Christmas Day" },
    ],
    leavePolicy: {
      name: "Australia annual leave policy",
      annualDays: 20,
      carryForwardDays: 10,
      note: "",
    },
    workingTime: {
      weekStart: "Monday",
      standardHours: "09:00–17:00 AEST",
      workDays: "Mon–Fri",
      note: "",
    },
    benefits: [
      { id: "au-super", name: "Superannuation", category: "Retirement", summary: "Super illustration" },
    ],
    documents: [{ id: "au-tfn", name: "TFN declaration", required: true, note: "Onboarding item" }],
  },
  CA: {
    currencyLocale: "en-CA",
    legalEntity: "TimeZ Canada Inc",
    languages: ["en"],
    holidays: [
      { date: "2026-07-01", name: "Canada Day" },
      { date: "2026-09-07", name: "Labour Day" },
      { date: "2026-12-25", name: "Christmas Day" },
    ],
    leavePolicy: {
      name: "Canada vacation policy",
      annualDays: 15,
      carryForwardDays: 5,
      note: "",
    },
    workingTime: {
      weekStart: "Sunday",
      standardHours: "09:00–17:00 local",
      workDays: "Mon–Fri",
      note: "",
    },
    benefits: [
      { id: "ca-health", name: "Extended health", category: "Medical", summary: "Benefits booklet" },
    ],
    documents: [{ id: "ca-td1", name: "TD1", required: true, note: "Tax form" }],
  },
  AE: {
    currencyLocale: "en-AE",
    legalEntity: "TimeZ Middle East FZ",
    languages: ["en", "ar"],
    holidays: [
      { date: "2026-01-01", name: "New Year's Day" },
      { date: "2026-12-02", name: "National Day" },
    ],
    leavePolicy: {
      name: "UAE annual leave policy",
      annualDays: 22,
      carryForwardDays: 0,
      note: "",
    },
    workingTime: {
      weekStart: "Sunday",
      standardHours: "09:00–18:00 GST",
      workDays: "Sun–Thu",
      note: "",
    },
    benefits: [
      { id: "ae-med", name: "DHA Medical", category: "Medical", summary: "Medical cover" },
    ],
    documents: [{ id: "ae-visa", name: "Work visa copy", required: true, note: "Immigration checklist" }],
  },
  SA: {
    currencyLocale: "ar-SA",
    legalEntity: "TimeZ Saudi LLC",
    languages: ["en", "ar"],
    holidays: [
      { date: "2026-02-20", name: "Founding Day" },
      { date: "2026-09-23", name: "National Day" },
    ],
    leavePolicy: {
      name: "Saudi annual leave policy",
      annualDays: 21,
      carryForwardDays: 0,
      note: "",
    },
    workingTime: {
      weekStart: "Sunday",
      standardHours: "09:00–18:00 AST",
      workDays: "Sun–Thu",
      note: "",
    },
    benefits: [
      { id: "sa-med", name: "Medical insurance", category: "Medical", summary: "Cover" },
    ],
    documents: [{ id: "sa-iqama", name: "Iqama", required: true, note: "Checklist item" }],
  },
  DE: {
    currencyLocale: "de-DE",
    legalEntity: "TimeZ Germany GmbH",
    languages: ["en", "de"],
    holidays: [
      { date: "2026-01-01", name: "Neujahr" },
      { date: "2026-05-01", name: "Tag der Arbeit" },
      { date: "2026-10-03", name: "Tag der Deutschen Einheit" },
      { date: "2026-12-25", name: "Weihnachten" },
    ],
    leavePolicy: {
      name: "Germany Urlaub policy",
      annualDays: 26,
      carryForwardDays: 5,
      note: "",
    },
    workingTime: {
      weekStart: "Monday",
      standardHours: "09:00–17:30 CET",
      workDays: "Mon–Fri",
      note: "",
    },
    benefits: [
      { id: "de-health", name: "Health insurance note", category: "Medical", summary: "Statutory cover" },
    ],
    documents: [{ id: "de-tax", name: "Tax ID", required: true, note: "Onboarding item" }],
  },
};

export function buildDefaultCountrySettings(): CountrySettings[] {
  return TIMEZ_COUNTRIES.map((c) => ({
    code: c.code,
    name: c.name,
    currency: c.currency,
    timeZone: c.timeZone,
    ...BASE[c.code],
  }));
}

export function countryByCode(code: string, list: CountrySettings[]): CountrySettings | undefined {
  return list.find((c) => c.code === code);
}
