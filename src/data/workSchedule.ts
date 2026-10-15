import { parseISODate, toISO, type CountryCode } from "../model.ts";
import { buildDefaultCountrySettings, countryByCode } from "../locale/countryConfig.ts";

const COUNTRY_LIST = buildDefaultCountrySettings();

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const DAY_ALIAS: Record<string, number> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

export type WorkSchedule = {
  shiftName: string;
  hoursLabel: string;
  /** JS getDay() indexes that are weekly offs (0 = Sunday). */
  weeklyOffDays: number[];
  weeklyOffLabels: string[];
  workDaysLabel: string;
  note: string;
};

function parseDayToken(token: string): number | null {
  const key = token.trim().toLowerCase().replace(/\.$/, "");
  return key in DAY_ALIAS ? DAY_ALIAS[key] : null;
}

/** Parse samples like "Mon–Fri", "Sun–Thu (sample)", "Monday-Friday". */
export function workDayIndexesFromLabel(workDays: string): number[] {
  const cleaned = workDays.replace(/\(.*?\)/g, "").trim();
  const range = cleaned.split(/[–—-]/).map((p) => p.trim()).filter(Boolean);
  if (range.length >= 2) {
    const start = parseDayToken(range[0]);
    const end = parseDayToken(range[1]);
    if (start != null && end != null) {
      const days: number[] = [];
      let cur = start;
      for (let i = 0; i < 7; i += 1) {
        days.push(cur);
        if (cur === end) break;
        cur = (cur + 1) % 7;
      }
      return days;
    }
  }
  // Fallback Mon–Fri
  return [1, 2, 3, 4, 5];
}

export function weeklyOffIndexesFromWorkDays(workDays: string): number[] {
  const work = new Set(workDayIndexesFromLabel(workDays));
  return [0, 1, 2, 3, 4, 5, 6].filter((d) => !work.has(d));
}

export function isWeeklyOffDate(isoDate: string, weeklyOffDays: number[]): boolean {
  const day = parseISODate(isoDate).getDay();
  return weeklyOffDays.includes(day);
}

/** Start of the display week for a country schedule (Monday or Sunday). */
export function weekStartOf(isoDate: string, weekStartName = "Monday"): string {
  const want = parseDayToken(weekStartName) ?? 1;
  const date = parseISODate(isoDate);
  const day = date.getDay();
  let diff = day - want;
  if (diff < 0) diff += 7;
  date.setDate(date.getDate() - diff);
  return toISO(date);
}

export function workDatesInWeek(weekStartIso: string, weeklyOffDays: number[]): string[] {
  const start = parseISODate(weekStartIso);
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return toISO(date);
  }).filter((iso) => !isWeeklyOffDate(iso, weeklyOffDays));
}

/** First weekly-off day in the Mon–Sun week gets a small label; the rest stay style-only. */
export function isPrimaryWeeklyOffLabel(isoDate: string, weeklyOffDays: number[]): boolean {
  if (!isWeeklyOffDate(isoDate, weeklyOffDays)) return false;
  const d = parseISODate(isoDate);
  const dow = d.getDay();
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  const weekStart = new Date(d);
  weekStart.setDate(d.getDate() + mondayOffset);
  weekStart.setHours(0, 0, 0, 0);
  const prev = new Date(d);
  prev.setDate(d.getDate() - 1);
  prev.setHours(0, 0, 0, 0);
  if (prev < weekStart) return true;
  return !isWeeklyOffDate(toISO(prev), weeklyOffDays);
}

export function scheduleForEmployee(input: {
  shiftName?: string;
  shiftHours?: string;
  countryCode?: CountryCode | string;
}): WorkSchedule {
  const code = (input.countryCode || "IN") as CountryCode;
  const country = countryByCode(code, COUNTRY_LIST) ?? COUNTRY_LIST[0];
  const workDaysLabel = country.workingTime.workDays;
  const weeklyOffDays = weeklyOffIndexesFromWorkDays(workDaysLabel);
  return {
    shiftName: input.shiftName?.trim() || "General shift",
    hoursLabel: input.shiftHours?.trim() || country.workingTime.standardHours,
    weeklyOffDays,
    weeklyOffLabels: weeklyOffDays.map((d) => DAY_NAMES[d]),
    workDaysLabel,
    note: country.workingTime.note,
  };
}

export function shortHolidayName(name: string, max = 14): string {
  const cleaned = name.replace(/\s*\(sample\)\s*/i, "").trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max - 1)}…`;
}
