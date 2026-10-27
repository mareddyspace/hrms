/**
 * Series for the Administration home charts — all computed from live stores, nothing hard-coded.
 */
import { addDaysISO } from "../model.ts";
import type { PersonRecord } from "./peopleData.ts";
import { getExitDetails } from "./peopleLocal.ts";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export interface MonthlyMovement {
  labels: string[];
  /** Full month names for hover text, e.g. "Oct 2026". */
  titles: string[];
  joiners: number[];
  exits: number[];
}

/** Joiners (by date of joining) and exits (terminated, by exit date) for the last `months` months, oldest first. */
export function monthlyMovement(people: readonly PersonRecord[], today: string, months = 12): MonthlyMovement {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7)) - 1;
  const keys: string[] = [];
  for (let i = months - 1; i >= 0; i -= 1) {
    const d = new Date(y, m - i, 1);
    keys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  const index = new Map(keys.map((k, i) => [k, i]));
  const joiners = keys.map(() => 0);
  const exits = keys.map(() => 0);
  for (const p of people) {
    const j = p.dateOfJoining ? index.get(p.dateOfJoining.slice(0, 7)) : undefined;
    if (j !== undefined && p.dateOfJoining <= today) joiners[j] += 1;
    if (p.employmentStatus === "Terminated") {
      const date = getExitDetails(p).exitDate;
      const e = date ? index.get(date.slice(0, 7)) : undefined;
      if (e !== undefined && date && date <= today) exits[e] += 1;
    }
  }
  return {
    labels: keys.map((k) => MONTHS[Number(k.slice(5, 7)) - 1]),
    titles: keys.map((k) => `${MONTHS[Number(k.slice(5, 7)) - 1]} ${k.slice(0, 4)}`),
    joiners,
    exits,
  };
}

/** Event counts per day for the last `days` days (oldest first), from any list of timestamps ("YYYY-MM-DD…"). */
export function dailyCounts(stamps: readonly string[], today: string, days = 14): { dates: string[]; counts: number[] } {
  const dates: string[] = [];
  for (let i = days - 1; i >= 0; i -= 1) dates.push(addDaysISO(today, -i));
  const index = new Map(dates.map((d, i) => [d, i]));
  const counts = dates.map(() => 0);
  for (const s of stamps) {
    const i = index.get(String(s).slice(0, 10));
    if (i !== undefined) counts[i] += 1;
  }
  return { dates, counts };
}

/** Count items into a fixed list of buckets, keeping the bucket order. */
export function countInto<T extends string>(buckets: readonly T[], values: readonly string[]): { label: T; value: number }[] {
  return buckets.map((label) => ({ label, value: values.filter((v) => v === label).length }));
}
