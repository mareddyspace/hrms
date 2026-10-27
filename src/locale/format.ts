import type { CountrySettings } from "./countryConfig.ts";

/** Format a numeric amount using the active country's currency (demo). */
export function formatCurrencyAmount(
  amount: number,
  settings: Pick<CountrySettings, "currency" | "currencyLocale">,
): string {
  try {
    return new Intl.NumberFormat(settings.currencyLocale, {
      style: "currency",
      currency: settings.currency,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${settings.currency} ${amount.toLocaleString()}`;
  }
}

/** Format ISO date/time in a specific IANA time zone. */
export function formatInTimeZone(
  isoOrDate: string | Date,
  timeZone: string,
  options: Intl.DateTimeFormatOptions = {
    dateStyle: "medium",
    timeStyle: "short",
  },
): string {
  const date = typeof isoOrDate === "string" ? new Date(isoOrDate) : isoOrDate;
  if (Number.isNaN(date.getTime())) return String(isoOrDate);
  try {
    return new Intl.DateTimeFormat("en-GB", { ...options, timeZone }).format(date);
  } catch {
    return date.toLocaleString();
  }
}

export function formatDateInTimeZone(iso: string, timeZone: string): string {
  return formatInTimeZone(iso, timeZone, { dateStyle: "medium" });
}

/** @deprecated No screen shows a sample salary any more. */
export function demoSampleSalary(settings: CountrySettings): string {
  const samples: Record<string, number> = {
    INR: 1850000,
    USD: 95000,
    GBP: 72000,
    AUD: 110000,
    CAD: 98000,
    AED: 220000,
    SAR: 210000,
    EUR: 78000,
  };
  return formatCurrencyAmount(samples[settings.currency] ?? 50000, settings);
}
