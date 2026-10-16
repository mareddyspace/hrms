import { addDaysISO, todayISO, TIMEZ_COUNTRIES, type Holiday } from "../../model.ts";
import { findDemoById, managementChain } from "../../demoAccounts.ts";
import { taskTeamFor } from "../../data/taskTeam.ts";
import {
  createStore,
  fmt,
  isHrRole,
  isISODate,
  isWeekend,
  keepArrays,
  newId,
  notify,
  personName,
  type WorkforceActor,
  type WorkforceResult,
} from "./workforceShared.ts";

const KEY = "kastech.optionalHolidays.v1";
const ROUTE = "/workforce/optional-holidays";
/** A pick can be cancelled until this many days before the holiday. */
export const CANCEL_CUTOFF_DAYS = 3;
export const MAX_LIMIT = 5;

export interface OptionalHoliday {
  id: string;
  countryCode: string;
  date: string;
  name: string;
}

export interface OptionalPick {
  id: string;
  employeeId: string;
  holidayId: string;
  pickedOn: string;
  status: "picked" | "cancelled";
  cancelledOn?: string;
}

interface OptionalHolidayState {
  holidays: OptionalHoliday[];
  /** Picks allowed per calendar year, by country code. */
  limits: Record<string, number>;
  picks: OptionalPick[];
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
    limits: { IN: 2, US: 1 },
    picks: [
      { id: "op-babu-onam", employeeId: "emp-mahesh", holidayId: "oh-in-onam", pickedOn: "2026-08-03", status: "picked" },
      { id: "op-priya-karva", employeeId: "emp-priya", holidayId: "oh-in-karva", pickedOn: "2026-10-01", status: "picked" },
      { id: "op-kabir-nye", employeeId: "emp-kabir", holidayId: "oh-in-nye", pickedOn: "2026-10-09", status: "picked" },
    ],
  };
}

const store = createStore<OptionalHolidayState>(KEY, defaults, keepArrays);

export const subscribeOptionalHolidays = store.subscribe;
/** Stable snapshot for useSyncExternalStore. */
export const getOptionalHolidayState = store.getState;

const TEAMMATE_COUNTRY = "IN";

/** Country whose optional holidays apply to this person. */
export function countryOf(personId: string): string {
  return findDemoById(personId)?.countryCode ?? TEAMMATE_COUNTRY;
}

export function countryName(code: string): string {
  return TIMEZ_COUNTRIES.find((c) => c.code === code)?.name ?? code;
}

export function limitFor(countryCode: string, state: OptionalHolidayState = getOptionalHolidayState()): number {
  return state.limits[countryCode] ?? 0;
}

export function holidaysFor(countryCode: string, year: number, state: OptionalHolidayState = getOptionalHolidayState()): OptionalHoliday[] {
  return state.holidays
    .filter((h) => h.countryCode === countryCode && Number(h.date.slice(0, 4)) === year)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Active picks for a person in a year, joined to their holiday. */
export function picksFor(employeeId: string, year: number, state: OptionalHolidayState = getOptionalHolidayState()) {
  return state.picks
    .filter((p) => p.employeeId === employeeId && p.status === "picked")
    .map((p) => ({ pick: p, holiday: state.holidays.find((h) => h.id === p.holidayId) }))
    .filter((x): x is { pick: OptionalPick; holiday: OptionalHoliday } => !!x.holiday && Number(x.holiday.date.slice(0, 4)) === year)
    .sort((a, b) => a.holiday.date.localeCompare(b.holiday.date));
}

export function cancelDeadline(holidayDate: string): string {
  return addDaysISO(holidayDate, -CANCEL_CUTOFF_DAYS);
}

// ---------- HR configuration ----------

export function addOptionalHoliday(
  actor: WorkforceActor,
  input: { countryCode: string; date: string; name: string },
  companyHolidays: Holiday[],
): WorkforceResult {
  if (!isHrRole(actor.role)) return "Only HR can manage optional holidays.";
  const name = input.name.trim();
  if (!TIMEZ_COUNTRIES.some((c) => c.code === input.countryCode)) return "Pick a country.";
  if (name.length < 2) return "Enter the holiday name.";
  if (name.length > 60) return "Holiday name must be 60 characters or fewer.";
  if (!isISODate(input.date)) return "Pick a valid date.";
  if (input.date < todayISO()) return "Pick a date that hasn't passed.";
  if (isWeekend(input.date)) return `${fmt(input.date)} is a weekend — pick a working day.`;
  // The portal's fixed calendar is the India calendar.
  if (input.countryCode === "IN") {
    const clash = companyHolidays.find((h) => h.date === input.date);
    if (clash) return `${fmt(input.date)} is already a company holiday (${clash.name}).`;
  }
  return store.mutate((s) => {
    if (s.holidays.some((h) => h.countryCode === input.countryCode && h.date === input.date)) {
      return `There's already an optional holiday on ${fmt(input.date)} for ${countryName(input.countryCode)}.`;
    }
    s.holidays.push({ id: newId("oh"), countryCode: input.countryCode, date: input.date, name });
    return null;
  });
}

export function removeOptionalHoliday(actor: WorkforceActor, id: string): WorkforceResult {
  if (!isHrRole(actor.role)) return "Only HR can manage optional holidays.";
  return store.mutate((s) => {
    const holiday = s.holidays.find((h) => h.id === id);
    if (!holiday) return "That holiday no longer exists.";
    const picked = s.picks.filter((p) => p.holidayId === id && p.status === "picked").length;
    if (picked) return `${picked} ${picked === 1 ? "person has" : "people have"} picked ${holiday.name} — it can't be removed.`;
    s.holidays = s.holidays.filter((h) => h.id !== id);
    s.picks = s.picks.filter((p) => p.holidayId !== id);
    return null;
  });
}

export function setYearlyLimit(actor: WorkforceActor, countryCode: string, limit: number): WorkforceResult {
  if (!isHrRole(actor.role)) return "Only HR can change the yearly limit.";
  if (!TIMEZ_COUNTRIES.some((c) => c.code === countryCode)) return "Pick a country.";
  if (!Number.isInteger(limit) || limit < 0 || limit > MAX_LIMIT) return `Limit must be a whole number from 0 to ${MAX_LIMIT}.`;
  return store.mutate((s) => {
    const year = Number(todayISO().slice(0, 4));
    const over = [...new Set(s.picks.filter((p) => p.status === "picked").map((p) => p.employeeId))].filter(
      (id) => countryOf(id) === countryCode && picksFor(id, year, s).length > limit,
    );
    if (over.length) return `${personName(over[0])} already has more than ${limit} picks this year — lower it later.`;
    s.limits = { ...s.limits, [countryCode]: limit };
    return null;
  });
}

// ---------- employee picks ----------

export function pickOptionalHoliday(actor: WorkforceActor, holidayId: string): WorkforceResult {
  return store.mutate((s) => {
    const holiday = s.holidays.find((h) => h.id === holidayId);
    if (!holiday) return "That holiday no longer exists.";
    const country = countryOf(actor.id);
    if (holiday.countryCode !== country) return `${holiday.name} isn't an optional holiday for ${countryName(country)}.`;
    if (holiday.date <= todayISO()) return "You can only pick upcoming holidays.";
    if (s.picks.some((p) => p.employeeId === actor.id && p.holidayId === holidayId && p.status === "picked")) {
      return `You've already picked ${holiday.name}.`;
    }
    const year = Number(holiday.date.slice(0, 4));
    const limit = limitFor(country, s);
    if (picksFor(actor.id, year, s).length >= limit) {
      if (limit === 0) return `${countryName(country)} has no optional holidays to pick in ${year}.`;
      return limit === 1
        ? `You've already used your optional holiday for ${year}.`
        : `You've used all ${limit} optional holidays for ${year}.`;
    }
    s.picks.unshift({ id: newId("op"), employeeId: actor.id, holidayId, pickedOn: todayISO(), status: "picked" });
    const manager = managementChain(actor.id)[0];
    if (manager) notify(manager.id, "Optional holiday picked", `${actor.fullName} picked ${holiday.name} (${fmt(holiday.date)}).`, ROUTE);
    return null;
  });
}

export function cancelOptionalPick(actor: WorkforceActor, pickId: string): WorkforceResult {
  return store.mutate((s) => {
    const pick = s.picks.find((p) => p.id === pickId);
    if (!pick || pick.status !== "picked") return "That pick is no longer active.";
    if (pick.employeeId !== actor.id) return "You can only cancel your own picks.";
    const holiday = s.holidays.find((h) => h.id === pick.holidayId);
    if (!holiday) return "That holiday no longer exists.";
    if (todayISO() > cancelDeadline(holiday.date)) {
      return `Picks can be cancelled until ${CANCEL_CUTOFF_DAYS} days before — the last day was ${fmt(cancelDeadline(holiday.date))}.`;
    }
    pick.status = "cancelled";
    pick.cancelledOn = todayISO();
    return null;
  });
}

/** Active picks for everyone in this manager's team for a year. */
export function teamPicks(managerId: string, year: number, state: OptionalHolidayState = getOptionalHolidayState()) {
  return taskTeamFor(managerId).flatMap((person) =>
    picksFor(person.id, year, state).map((row) => ({ ...row, personId: person.id, personName: person.fullName })),
  );
}
