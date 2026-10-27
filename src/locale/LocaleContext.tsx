import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { TIMEZ_COUNTRIES, type CountryCode } from "../model.ts";
import { usePortal } from "../store.tsx";
import {
  buildDefaultCountrySettings,
  countryByCode,
  type AppLanguage,
  type CountrySettings,
} from "./countryConfig.ts";
import { formatCurrencyAmount, formatDateInTimeZone, formatInTimeZone } from "./format.ts";
import { isRtl, LANGUAGE_LABELS, translate, type I18nKey } from "./i18n.ts";

const REGION_KEY = "timez.locale.region";
const LANG_KEY = "timez.locale.language";
const SETTINGS_KEY = "timez.locale.countrySettings.v2";

type LocaleContextValue = {
  /** Region filter for data views — does NOT change signed-in identity, permissions or the user's time zone. */
  regionCode: CountryCode | "ALL";
  setRegionCode: (code: CountryCode | "ALL") => void;
  language: AppLanguage;
  setLanguage: (lang: AppLanguage) => void;
  countries: CountrySettings[];
  activeCountry: CountrySettings;
  t: (key: I18nKey) => string;
  formatMoney: (amount: number, currencyCode?: string) => string;
  /** Formats in the signed-in user's own time zone unless one is given. */
  formatDateTime: (iso: string, timeZone?: string) => string;
  formatDate: (iso: string, timeZone?: string) => string;
  /** The signed-in user's configured IANA time zone. */
  userTimeZone: string;
  updateCountrySettings: (code: CountryCode, patch: Partial<CountrySettings>) => void;
  resetCountrySettings: () => void;
  matchesRegion: (countryCode?: string, countryName?: string) => boolean;
  languageLabels: typeof LANGUAGE_LABELS;
};

const LocaleContext = createContext<LocaleContextValue | null>(null);

function readSettings(): CountrySettings[] {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return buildDefaultCountrySettings();
    const parsed = JSON.parse(raw) as CountrySettings[];
    if (!Array.isArray(parsed) || parsed.length < 8) return buildDefaultCountrySettings();
    return parsed;
  } catch {
    return buildDefaultCountrySettings();
  }
}

/** HR, leadership, pay and platform roles look across countries by default. */
const ALL_REGION_ROLES = ["hr", "hr_admin", "hrbp", "executive", "founder", "cofounder", "admin", "super_admin", "it_admin"];

function regionKey(accountId: string) {
  return `${REGION_KEY}.${accountId}`;
}

function readRegion(accountId: string, role: string, home: CountryCode): CountryCode | "ALL" {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(regionKey(accountId));
  } catch {
    stored = null;
  }
  if (stored === "ALL") return "ALL";
  if (TIMEZ_COUNTRIES.some((c) => c.code === stored)) return stored as CountryCode;
  return ALL_REGION_ROLES.includes(role) ? "ALL" : home;
}

function homeCode(code?: string): CountryCode {
  const found = TIMEZ_COUNTRIES.find((c) => c.code === code);
  return found?.code ?? "IN";
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const { employee, demoProfile } = usePortal();
  const home = homeCode(demoProfile.countryCode ?? employee.countryCode);

  // Each person keeps their own region choice; nothing leaks from the previous sign-in.
  const [regionCode, setRegionCodeState] = useState<CountryCode | "ALL">(() =>
    readRegion(demoProfile.id, demoProfile.role, home),
  );

  const [language, setLanguageState] = useState<AppLanguage>(() => {
    const stored = localStorage.getItem(LANG_KEY) as AppLanguage | null;
    if (stored && ["en", "hi", "de", "ar"].includes(stored)) return stored;
    return "en";
  });

  const [countries, setCountries] = useState<CountrySettings[]>(readSettings);

  useEffect(() => {
    setRegionCodeState(readRegion(demoProfile.id, demoProfile.role, home));
  }, [demoProfile.id, demoProfile.role, home]);

  useEffect(() => {
    document.documentElement.lang = language === "hi" ? "hi" : language === "de" ? "de" : language === "ar" ? "ar" : "en";
    document.documentElement.dir = isRtl(language) ? "rtl" : "ltr";
  }, [language]);

  const setRegionCode = useCallback(
    (code: CountryCode | "ALL") => {
      setRegionCodeState(code);
      try {
        localStorage.setItem(regionKey(demoProfile.id), code);
      } catch {
        /* storage blocked: keep for this session */
      }
    },
    [demoProfile.id],
  );

  const setLanguage = useCallback((lang: AppLanguage) => {
    setLanguageState(lang);
    localStorage.setItem(LANG_KEY, lang);
  }, []);

  const activeCountry = useMemo(() => {
    const code = regionCode === "ALL" ? home : regionCode;
    return countryByCode(code, countries) ?? countries[0];
  }, [regionCode, home, countries]);

  const t = useCallback((key: I18nKey) => translate(language, key), [language]);

  const formatMoney = useCallback(
    (amount: number, currencyCode?: string) => {
      if (currencyCode) {
        const match = countries.find((c) => c.currency === currencyCode);
        if (match) return formatCurrencyAmount(amount, match);
        return formatCurrencyAmount(amount, { currency: currencyCode, currencyLocale: "en" });
      }
      return formatCurrencyAmount(amount, activeCountry);
    },
    [activeCountry, countries],
  );

  // Times follow the person's own configured zone, never the region filter.
  const userTimeZone = employee.timeZone || (countryByCode(home, countries)?.timeZone ?? "UTC");

  const formatDateTime = useCallback(
    (iso: string, timeZone?: string) => formatInTimeZone(iso, timeZone ?? userTimeZone),
    [userTimeZone],
  );

  const formatDate = useCallback(
    (iso: string, timeZone?: string) => formatDateInTimeZone(iso, timeZone ?? userTimeZone),
    [userTimeZone],
  );

  const updateCountrySettings = useCallback((code: CountryCode, patch: Partial<CountrySettings>) => {
    setCountries((prev) => {
      const next = prev.map((c) => (c.code === code ? { ...c, ...patch, code: c.code } : c));
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const resetCountrySettings = useCallback(() => {
    const next = buildDefaultCountrySettings();
    localStorage.removeItem(SETTINGS_KEY);
    setCountries(next);
  }, []);

  const matchesRegion = useCallback(
    (countryCode?: string, countryName?: string) => {
      if (regionCode === "ALL") return true;
      if (countryCode && countryCode === regionCode) return true;
      const settings = countryByCode(regionCode, countries);
      if (countryName && settings && countryName === settings.name) return true;
      return false;
    },
    [regionCode, countries],
  );

  const value = useMemo<LocaleContextValue>(
    () => ({
      regionCode,
      setRegionCode,
      language,
      setLanguage,
      countries,
      activeCountry,
      t,
      formatMoney,
      formatDateTime,
      formatDate,
      userTimeZone,
      updateCountrySettings,
      resetCountrySettings,
      matchesRegion,
      languageLabels: LANGUAGE_LABELS,
    }),
    [
      regionCode,
      setRegionCode,
      language,
      setLanguage,
      countries,
      activeCountry,
      t,
      formatMoney,
      formatDateTime,
      formatDate,
      userTimeZone,
      updateCountrySettings,
      resetCountrySettings,
      matchesRegion,
    ],
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale() {
  const ctx = useContext(LocaleContext);
  if (!ctx) throw new Error("useLocale must be used within LocaleProvider");
  return ctx;
}

/** Optional hook when provider may be outside (tests) */
export function useLocaleOptional() {
  return useContext(LocaleContext);
}
