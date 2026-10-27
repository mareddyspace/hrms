import type { AppLanguage } from "./countryConfig.ts";

/** Reusable translation keys — only keys with reliable copy are translated. */
export type I18nKey =
  | "app.name"
  | "nav.home"
  | "nav.people"
  | "nav.settings"
  | "locale.region"
  | "locale.language"
  | "locale.currency"
  | "locale.timezone"
  | "locale.viewOnly"
  | "common.search"
  | "common.filter"
  | "common.save"
  | "common.cancel"
  | "country.all"
  | "holidays.title"
  | "leave.policy"
  | "working.time"
  | "benefits.country"
  | "documents.country"
  | "admin.countries";

const EN: Record<I18nKey, string> = {
  "app.name": "Info Tech",
  "nav.home": "Home",
  "nav.people": "People",
  "nav.settings": "Locale settings",
  "locale.region": "Region",
  "locale.language": "Language",
  "locale.currency": "Currency",
  "locale.timezone": "Time zone",
  "locale.viewOnly": "View context",
  "common.search": "Search",
  "common.filter": "Filter",
  "common.save": "Save",
  "common.cancel": "Cancel",
  "country.all": "All countries",
  "holidays.title": "Holiday calendar",
  "leave.policy": "Leave policy",
  "working.time": "Working time",
  "benefits.country": "Country benefits",
  "documents.country": "Country documents",
  "admin.countries": "Country configuration",
};

/** Hindi — limited reliable UI strings only */
const HI: Partial<Record<I18nKey, string>> = {
  "app.name": "Info Tech",
  "nav.home": "होम",
  "nav.people": "लोग",
  "nav.settings": "स्थानीय सेटिंग्स",
  "locale.region": "क्षेत्र",
  "locale.language": "भाषा",
  "locale.currency": "मुद्रा",
  "locale.timezone": "समय क्षेत्र",
  "locale.viewOnly": "दृश्य संदर्भ",
  "common.search": "खोजें",
  "common.filter": "फ़िल्टर",
  "common.save": "सहेजें",
  "common.cancel": "रद्द करें",
  "country.all": "सभी देश",
  "holidays.title": "अवकाश कैलेंडर",
  "leave.policy": "छुट्टी नीति",
  "working.time": "कार्य समय",
  "benefits.country": "देश लाभ",
  "documents.country": "देश दस्तावेज़",
  "admin.countries": "देश विन्यास",
};

/** German — limited reliable UI strings only */
const DE: Partial<Record<I18nKey, string>> = {
  "app.name": "Info Tech",
  "nav.home": "Startseite",
  "nav.people": "Personen",
  "nav.settings": "Gebietseinstellungen",
  "locale.region": "Region",
  "locale.language": "Sprache",
  "locale.currency": "Währung",
  "locale.timezone": "Zeitzone",
  "locale.viewOnly": "Ansichtskontext",
  "common.search": "Suchen",
  "common.filter": "Filter",
  "common.save": "Speichern",
  "common.cancel": "Abbrechen",
  "country.all": "Alle Länder",
  "holidays.title": "Feiertagskalender",
  "leave.policy": "Urlaubsrichtlinie",
  "working.time": "Arbeitszeit",
  "benefits.country": "Ländervorteile",
  "documents.country": "Länderdokumente",
  "admin.countries": "Länderkonfiguration",
};

/** Arabic — limited reliable UI strings only */
const AR: Partial<Record<I18nKey, string>> = {
  "app.name": "Info Tech",
  "nav.home": "الرئيسية",
  "nav.people": "الأشخاص",
  "nav.settings": "إعدادات المنطقة",
  "locale.region": "المنطقة",
  "locale.language": "اللغة",
  "locale.currency": "العملة",
  "locale.timezone": "المنطقة الزمنية",
  "locale.viewOnly": "سياق العرض",
  "common.search": "بحث",
  "common.filter": "تصفية",
  "common.save": "حفظ",
  "common.cancel": "إلغاء",
  "country.all": "كل البلدان",
  "holidays.title": "تقويم العطل",
  "leave.policy": "سياسة الإجازات",
  "working.time": "وقت العمل",
  "benefits.country": "مزايا البلد",
  "documents.country": "وثائق البلد",
  "admin.countries": "إعدادات البلدان",
};

const TABLES: Record<AppLanguage, Partial<Record<I18nKey, string>>> = {
  en: EN,
  hi: HI,
  de: DE,
  ar: AR,
};

/**
 * Only English is complete. The others translate a handful of labels, so they are marked Preview;
 * most screens stay in English.
 */
export const LANGUAGE_LABELS: Record<AppLanguage, string> = {
  en: "English",
  hi: "हिन्दी (Preview)",
  de: "Deutsch (Preview)",
  ar: "العربية (Preview)",
};

/** Languages whose UI is fully translated. Right-to-left layout is only used for these. */
const FULLY_TRANSLATED: readonly AppLanguage[] = ["en"];

export function translate(lang: AppLanguage, key: I18nKey): string {
  return TABLES[lang][key] ?? EN[key] ?? key;
}

/** Arabic previews keep left-to-right layout: almost all text is still English. */
export function isRtl(lang: AppLanguage): boolean {
  return lang === "ar" && FULLY_TRANSLATED.includes(lang);
}
