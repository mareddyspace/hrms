/**
 * Optional (restricted) holidays: a per-country list people pick from. A pick is a leave request with code
 * "optional" for that date, so it goes to the manager like any leave and counts against the "Optional holiday"
 * balance (2 a year in India, 1 in the US). The list is local in local mode and from the API in backend mode.
 */
import { todayISO, TIMEZ_COUNTRIES, type Holiday, type LeaveRequest } from "../../model.ts";
import { findDemoById } from "../../demoAccounts.ts";
import { API_ENABLED } from "../../api/client.ts";
import {
  apiAddOptional,
  apiOptionalList,
  apiOptionalVersion,
  apiRemoveOptional,
  subscribeApiOptional,
} from "../../api/syncOptionalHolidays.ts";
import { createStore, fmt, isHrRole, isISODate, isWeekend, keepArrays, newId, type WorkforceActor, type WorkforceResult } from "./workforceShared.ts";

const KEY = "kastech.optionalHolidays.v1";
export const OPTIONAL_CODE = "optional";

export interface OptionalHoliday {
  id: string;
  countryCode: string;
  date: string;
  name: string;
  /** Backend mode, HR only: open picks for this holiday. */
  pickedBy?: number;
}

interface OptionalHolidayState {
  holidays: OptionalHoliday[];
}

function defaults(): OptionalHolidayState {
  return {
    holidays: [
      { id: "oh-in-mahavir", countryCode: "IN", date: "2026-03-31", name: "Mahavir Jayanti" },
      { id: "oh-in-onam", countryCode: "IN", date: "2026-08-26", name: "Onam" },
      { id: "oh-in-rakhi", countryCode: "IN", date: "2026-08-27", name: "Raksha Bandhan" },
      { id: "oh-in-karva", countryCode: "IN", date: "2026-10-29", name: "Karva Chauth" },
      { id: "oh-in-chhath", countryCode: "IN", date: "2026-11-16", name: "Chhath Puja" },
      { id: "oh-in-xmas-eve", countryCode: "IN", date: "2026-12-24", name: "Christmas Eve" },
      { id: "oh-in-nye", countryCode: "IN", date: "2026-12-31", name: "New Year's Eve" },
      { id: "oh-us-thanks", countryCode: "US", date: "2026-11-27", name: "Day after Thanksgiving" },
      { id: "oh-us-xmas-eve", countryCode: "US", date: "2026-12-24", name: "Christmas Eve" },
    ],
  };
}

const store = createStore<OptionalHolidayState>(KEY, defaults, keepArrays);

let composed: { v: number; local: OptionalHolidayState; out: OptionalHolidayState & { v: number } } | null = null;

/** Re-renders on local edits, and on API loads in backend mode. */
export const subscribeOptionalHolidays = API_ENABLED
  ? (listener: () => void) => {
      const a = store.subscribe(listener);
      const b = subscribeApiOptional(listener);
      return () => {
        a();
        b();
      };
    }
  : store.subscribe;

/** Stable snapshot for useSyncExternalStore. */
export function getOptionalHolidayState(): OptionalHolidayState {
  const local = store.getState();
  if (!API_ENABLED) return local;
  const v = apiOptionalVersion();
  if (!composed || composed.v !== v || composed.local !== local) composed = { v, local, out: { ...local, v } };
  return composed.out;
}

const TEAMMATE_COUNTRY = "IN";

/** Country whose optional holidays apply to this person. */
export function countryOf(personId: string): string {
  return findDemoById(personId)?.countryCode ?? TEAMMATE_COUNTRY;
}

export function countryName(code: string): string {
  return TIMEZ_COUNTRIES.find((c) => c.code === code)?.name ?? code;
}

/**
 * Optional holidays for a country and year. Backend mode: `mine` true reads the signed-in person's country
 * (anyone may), false asks for that country (HR only).
 */
export function holidaysFor(
  countryCode: string,
  year: number,
  state: OptionalHolidayState = getOptionalHolidayState(),
  mine = true,
): OptionalHoliday[] {
  if (API_ENABLED) {
    return apiOptionalList(mine ? null : countryCode, year).map((h) => ({
      id: h.id,
      countryCode: h.country_code,
      date: h.date,
      name: h.name,
      pickedBy: h.picked_by,
    }));
  }
  return state.holidays
    .filter((h) => h.countryCode === countryCode && Number(h.date.slice(0, 4)) === year)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** A person's optional-holiday leave requests in a year, newest status first per date. */
export function optionalRequestsFor(leaveRequests: LeaveRequest[], employeeId: string, year: number): LeaveRequest[] {
  return leaveRequests
    .filter((r) => r.employeeId === employeeId && r.code === OPTIONAL_CODE && Number(r.from.slice(0, 4)) === year)
    .sort((a, b) => a.from.localeCompare(b.from));
}

/** The open (pending or approved) request for a date, else the latest closed one. */
export function requestOn(requests: LeaveRequest[], date: string): LeaveRequest | undefined {
  const onDay = requests.filter((r) => r.from === date);
  return onDay.find((r) => r.status === "pending" || r.status === "approved") ?? onDay[onDay.length - 1];
}

/** Local mode: open picks per holiday date (from everyone's leave requests). */
export function localPickCount(leaveRequests: LeaveRequest[], holiday: OptionalHoliday): number {
  return leaveRequests.filter(
    (r) => r.code === OPTIONAL_CODE && r.from === holiday.date && (r.status === "pending" || r.status === "approved") && countryOf(r.employeeId) === holiday.countryCode,
  ).length;
}

// ---------- HR configuration ----------

export async function addOptionalHoliday(
  actor: WorkforceActor,
  input: { countryCode: string; date: string; name: string },
  companyHolidays: Holiday[],
): Promise<WorkforceResult> {
  if (!isHrRole(actor.role)) return "Only HR can manage optional holidays.";
  const name = input.name.trim();
  if (!TIMEZ_COUNTRIES.some((c) => c.code === input.countryCode)) return "Pick a country.";
  if (name.length < 2) return "Enter the holiday name.";
  if (name.length > 60) return "Holiday name must be 60 characters or fewer.";
  if (!isISODate(input.date)) return "Pick a valid date.";
  if (input.date < todayISO()) return "Pick a date that hasn't passed.";
  if (isWeekend(input.date)) return `${fmt(input.date)} is a weekend. Pick a working day.`;
  if (API_ENABLED) return apiAddOptional(input.countryCode, input.date, name);
  const clash = companyHolidays.find((h) => h.date === input.date && (h.countryCode ?? "IN") === input.countryCode);
  if (clash) return `${fmt(input.date)} is already a public holiday (${clash.name}).`;
  return store.mutate((s) => {
    if (s.holidays.some((h) => h.countryCode === input.countryCode && h.date === input.date)) {
      return `There's already an optional holiday on ${fmt(input.date)} for ${countryName(input.countryCode)}.`;
    }
    s.holidays.push({ id: newId("oh"), countryCode: input.countryCode, date: input.date, name });
    return null;
  });
}

export async function removeOptionalHoliday(actor: WorkforceActor, holiday: OptionalHoliday, openPicks: number): Promise<WorkforceResult> {
  if (!isHrRole(actor.role)) return "Only HR can manage optional holidays.";
  if (API_ENABLED) return apiRemoveOptional(holiday.id);
  if (openPicks) return `${openPicks} ${openPicks === 1 ? "person has" : "people have"} picked ${holiday.name}. It can't be removed.`;
  return store.mutate((s) => {
    if (!s.holidays.some((h) => h.id === holiday.id)) return "That holiday no longer exists.";
    s.holidays = s.holidays.filter((h) => h.id !== holiday.id);
    return null;
  });
}
