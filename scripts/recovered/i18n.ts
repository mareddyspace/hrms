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
  | "locale.disclaimer"
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
  "app.name": "TimeZ",
  "nav.home": "Home",
  "nav.people": "People",
  "nav.settings": "Locale settings",
  "locale.region": "Demo region",
  "locale.language": "Language",
  "locale.currency": "Currency",
  "locale.timezone": "Time zone",
  "locale.disclaimer":
    "Region filters demo data only. They do not change your signed-in identity or permissions.",
  "locale.viewOnly": "View context",
  "common.search": "Search",
  "common.filter": "Filter",
  "common.save": "Save",
  "common.cancel": "Cancel",
  "country.all": "All countries",
  "holidays.title": "Holiday calendar",
  "leave.policy": "Leave policy (sample)",
  "working.time": "Working time (sample)",
  "benefits.country": "Country benefits",
  "documents.country": "Country documents",
  "admin.countries": "Country configuration",
};

/** Hindi — limited reliable UI strings only */
const HI: Partial<Record<I18nKey, string>> = {
  "app.name": "TimeZ",
  "nav.home": "होम",
  "nav.people": "लोग",
  "nav.settings": "स्थानीय सेटिंग्स",
  "locale.region": "डेमो क्षेत्र",
  "locale.language": "भाषा",
  "locale.currency": "मुद्रा",
  "locale.timezone": "समय क्षेत्र",
  "locale.disclaimer":
    "क्षेत्र फ़िल्टर केवल डेमो डेटा बदलते हैं। आपकी पहचान या अनुमतियाँ नहीं बदलतीं।",
  "locale.viewOnly": "दृश्य संदर्भ",
  "common.search": "खोजें",
  "common.filter": "फ़िल्टर",
  "common.save": "सहेजें",
  "common.cancel": "रद्द करें",
  "country.all": "सभी देश",
  "holidays.title": "अवकाश कैलेंडर",
  "leave.policy": "छुट्टी नीति (नमूना)",
  "working.time": "कार्य समय (नमूना)",
  "benefits.country": "देश लाभ",
  "documents.country": "देश दस्तावेज़",
  "admin.countries": "देश विन्यास",
};

/** German — limited reliable UI strings only */
const DE: Partial<Record<I18nKey, string>> = {
  "app.name": "TimeZ",
  "nav.home": "Startseite",
  "nav.people": "Personen",
  "nav.settings": "Gebietseinstellungen",
  "locale.region": "Demo-Region",
  "locale.language": "Sprache",
  "locale.currency": "Währung",
  "locale.timezone": "Zeitzone",
  "locale.disclaimer":
    "Regionsfilter betreffen nur Demodaten. Identität und Berechtigungen bleiben unverändert.",
  "locale.viewOnly": "Ansichtskontext",
  "common.search": "Suchen",
  "common.filter": "Filter",
  "common.save": "Speichern",
  "common.cancel": "Abbrechen",
  "country.all": "Alle Länder",
  "holidays.title": "Feiertagskalender",
  "leave.policy": "Urlaubsrichtlinie (Beispiel)",
  "working.time": "Arbeitszeit (Beispiel)",
  "benefits.country": "Ländervorteile",
  "documents.country": "Länderdokumente",
  "admin.countries": "Länderkonfiguration",
};

/** Arabic — limited reliable UI strings only */
const AR: Partial<Record<I18nKey, string>> = {
  "app.name": "TimeZ",
  "nav.home": "الرئيسية",
  "nav.people": "الأشخاص",
  "nav.settings": "إعدادات المنطقة",
  "locale.region": "منطقة العرض التجريبية",
  "locale.language": "اللغة",
  "locale.currency": "العملة",
  "locale.timezone": "المنطقة الزمنية",
  "locale.disclaimer":
    " عوامل تصفية المنطقة تؤثر على بيانات العرض التجريبية فقط ولا تغيّر هويتك أو صلاحياتك.",
  "locale.viewOnly": "سياق العرض",
  "common.search": "بحث",
  "common.filter": "تصفية",
  "common.save": "حفظ",
  "common.cancel": "إلغاء",
  "country.all": "كل البلدان",
  "holidays.title": "تقويم العطل",
  "leave.policy": "سياسة الإجازات (عينة)",
  "working.time": "وقت العمل (عينة)",
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

export const LANGUAGE_LABELS: Record<AppLanguage, string> = {
  en: "English",
  hi: "हिन्दी (limited)",
  de: "Deutsch (limited)",
  ar: "العربية (limited)",
};

export function translate(lang: AppLanguage, key: I18nKey): string {
  return TABLES[lang][key] ?? EN[key] ?? key;
}

export function isRtl(lang: AppLanguage): boolean {
  return lang === "ar";
}
