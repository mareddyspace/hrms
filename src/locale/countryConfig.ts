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
    legalEntity: "Infotech India Pvt Ltd",
    languages: ["en", "hi"],
    holidays: [
      { date: "2026-01-26", name: "Republic Day (sample)" },
      { date: "2026-03-14", name: "Holi (sample)" },
      { date: "2026-08-15", name: "Independence Day (sample)" },
      { date: "2026-10-20", name: "Dussehra (sample)" },
      { date: "2026-11-08", name: "Diwali (sample)" },
    ],
    leavePolicy: {
      name: "India leave sample",
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
      { id: "in-med", name: "Group Medical (sample)", category: "Medical", summary: "Demo floater plan" },
      { id: "in-pf", name: "Provident Fund (sample)", category: "Retirement", summary: "Demo statutory illustration" },
    ],
    documents: [
      { id: "in-pan", name: "PAN (sample)", required: true, note: "Demo onboarding checklist item" },
      { id: "in-aadhaar", name: "Aadhaar (sample)", required: false, note: "Optional demo metadata only" },
    ],
  },
  US: {
    currencyLocale: "en-US",
    legalEntity: "Infotech Inc",
    languages: ["en"],
    holidays: [
      { date: "2026-01-01", name: "New Year's Day (sample)" },
      { date: "2026-07-04", name: "Independence Day (sample)" },
      { date: "2026-11-26", name: "Thanksgiving (sample)" },
      { date: "2026-12-25", name: "Christmas Day (sample)" },
    ],
    leavePolicy: {
      name: "US PTO sample",
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
      { id: "us-med", name: "Medical PPO (sample)", category: "Medical", summary: "Demo open enrollment" },
      { id: "us-401", name: "401(k) (sample)", category: "Retirement", summary: "Demo match illustration" },
    ],
    documents: [
      { id: "us-i9", name: "I-9 worksheet (sample)", required: true, note: "Demo form metadata" },
      { id: "us-w4", name: "W-4 (sample)", required: true, note: "Demo tax form placeholder" },
    ],
  },
  GB: {
    currencyLocale: "en-GB",
    legalEntity: "Infotech UK Ltd",
    languages: ["en"],
    holidays: [
      { date: "2026-01-01", name: "New Year's Day (sample)" },
      { date: "2026-04-03", name: "Good Friday (sample)" },
      { date: "2026-12-25", name: "Christmas Day (sample)" },
      { date: "2026-12-28", name: "Boxing Day (sample)" },
    ],
    leavePolicy: {
      name: "UK annual leave sample",
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
      { id: "uk-pmi", name: "Private Medical (sample)", category: "Medical", summary: "Demo PMI" },
      { id: "uk-pen", name: "Workplace pension (sample)", category: "Retirement", summary: "Demo pension illustration" },
    ],
    documents: [
      { id: "uk-rtw", name: "Right to work check (sample)", required: true, note: "Demo checklist" },
      { id: "uk-p45", name: "P45/P60 (sample)", required: false, note: "Demo payroll document type" },
    ],
  },
  AU: {
    currencyLocale: "en-AU",
    legalEntity: "Infotech Australia Pty",
    languages: ["en"],
    holidays: [
      { date: "2026-01-26", name: "Australia Day (sample)" },
      { date: "2026-04-25", name: "ANZAC Day (sample)" },
      { date: "2026-12-25", name: "Christmas Day (sample)" },
    ],
    leavePolicy: {
      name: "Australia annual leave sample",
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
      { id: "au-super", name: "Superannuation (sample)", category: "Retirement", summary: "Demo super illustration" },
    ],
    documents: [{ id: "au-tfn", name: "TFN declaration (sample)", required: true, note: "Demo onboarding item" }],
  },
  CA: {
    currencyLocale: "en-CA",
    legalEntity: "Infotech Canada Inc",
    languages: ["en"],
    holidays: [
      { date: "2026-07-01", name: "Canada Day (sample)" },
      { date: "2026-09-07", name: "Labour Day (sample)" },
      { date: "2026-12-25", name: "Christmas Day (sample)" },
    ],
    leavePolicy: {
      name: "Canada vacation sample",
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
      { id: "ca-health", name: "Extended health (sample)", category: "Medical", summary: "Demo benefits booklet" },
    ],
    documents: [{ id: "ca-td1", name: "TD1 (sample)", required: true, note: "Demo tax form placeholder" }],
  },
  AE: {
    currencyLocale: "en-AE",
    legalEntity: "Infotech Middle East FZ",
    languages: ["en", "ar"],
    holidays: [
      { date: "2026-01-01", name: "New Year's Day (sample)" },
      { date: "2026-12-02", name: "National Day (sample)" },
    ],
    leavePolicy: {
      name: "UAE annual leave sample",
      annualDays: 22,
      carryForwardDays: 0,
      note: "",
    },
    workingTime: {
      weekStart: "Sunday",
      standardHours: "09:00–18:00 GST",
      workDays: "Sun–Thu (sample)",
      note: "",
    },
    benefits: [
      { id: "ae-med", name: "DHA Medical (sample)", category: "Medical", summary: "Demo medical cover" },
    ],
    documents: [{ id: "ae-visa", name: "Work visa copy (sample)", required: true, note: "Demo immigration checklist" }],
  },
  SA: {
    currencyLocale: "ar-SA",
    legalEntity: "Infotech Saudi LLC",
    languages: ["en", "ar"],
    holidays: [
      { date: "2026-02-20", name: "Founding Day (sample)" },
      { date: "2026-09-23", name: "National Day (sample)" },
    ],
    leavePolicy: {
      name: "Saudi annual leave sample",
      annualDays: 21,
      carryForwardDays: 0,
      note: "",
    },
    workingTime: {
      weekStart: "Sunday",
      standardHours: "09:00–18:00 AST",
      workDays: "Sun–Thu (sample)",
      note: "",
    },
    benefits: [
      { id: "sa-med", name: "Medical insurance (sample)", category: "Medical", summary: "Demo cover" },
    ],
    documents: [{ id: "sa-iqama", name: "Iqama (sample)", required: true, note: "Demo checklist item" }],
  },
  DE: {
    currencyLocale: "de-DE",
    legalEntity: "Infotech Germany GmbH",
    languages: ["en", "de"],
    holidays: [
      { date: "2026-01-01", name: "Neujahr (sample)" },
      { date: "2026-05-01", name: "Tag der Arbeit (sample)" },
      { date: "2026-10-03", name: "Tag der Deutschen Einheit (sample)" },
      { date: "2026-12-25", name: "Weihnachten (sample)" },
    ],
    leavePolicy: {
      name: "Germany Urlaub sample",
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
      { id: "de-health", name: "Health insurance note (sample)", category: "Medical", summary: "Demo illustration only" },
    ],
    documents: [{ id: "de-tax", name: "Tax ID (sample)", required: true, note: "Demo onboarding item" }],
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
