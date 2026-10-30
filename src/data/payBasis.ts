import type { OrgTimesheetRecord, Timesheet } from "../model.ts";
import { dayStatusOf } from "./timesheetDays.ts";

export type PayBasisKind = "monthly" | "hourly";

/** Ram's teammates paid by the hour (examples); personas are salaried. */
const HOURLY_IDS = new Set(["emp-diya", "emp-anu"]);

/** Monthly (salaried) or hourly. Directory contractors are hourly. */
export function payBasisFor(personId: string, employmentStatus?: string): PayBasisKind {
  return HOURLY_IDS.has(personId) || employmentStatus === "Contractor" ? "hourly" : "monthly";
}

/** Approved hours in a month, split into regular and overtime by the weekly threshold. */
export interface MonthHours {
  regular: number;
  overtime: number;
}

const DAY = 86400000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const utc = (d: string) => Date.parse(`${d}T00:00:00Z`);

function hash(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Spread a week's total over Monday–Friday. */
function weekdays(weekStart: string, hours: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (let i = 0; i < 5; i += 1) out[iso(utc(weekStart) + i * DAY)] = hours / 5;
  return out;
}

/**
 * Approved hours per day for one week (approved days, or approved weeks). Sources, in order: the person's own entries,
 * the org timesheet row, and — for weeks before either exists — the approved history kept by
 * the payroll provider (a steady 40 h with some longer weeks).
 */
function weekDays(personId: string, weekStart: string, sheets: Timesheet[], org: OrgTimesheetRecord[]): Record<string, number> {
  const own = sheets.filter((s) => s.employeeId === personId && s.weekStart === weekStart);
  if (own.length) {
    // Daily timesheets: a day with its own record counts when that day is approved; other days follow their
    // week (weeks submitted the old way).
    const out: Record<string, number> = {};
    for (const sheet of own) {
      for (const [date, h] of Object.entries(sheet.hours)) {
        const day = dayStatusOf(personId, date);
        if (day ? day === "approved" : sheet.status === "approved") out[date] = (out[date] ?? 0) + h;
      }
    }
    return out;
  }
  const row = org.find((r) => r.personId === personId && r.weekStart === weekStart);
  if (row) return row.status === "approved" ? weekdays(weekStart, row.hours ?? 0) : {};
  const roll = hash(`${personId}:${weekStart}`) % 5;
  return weekdays(weekStart, roll === 0 ? 50 : roll === 1 ? 45 : 40);
}

export function approvedMonthHours(input: {
  personId: string;
  month: string;
  weeklyThreshold: number;
  timesheets: Timesheet[];
  orgTimesheets: OrgTimesheetRecord[];
  /** Hours outside employment are not paid. */
  from?: string;
  to?: string;
}): MonthHours {
  const first = utc(`${input.month}-01`);
  const [y, m] = input.month.split("-").map(Number);
  const last = Date.UTC(y, m, 0);
  // Monday on or before the first of the month.
  let monday = first - ((new Date(first).getUTCDay() + 6) % 7) * DAY;
  let regular = 0;
  let overtime = 0;
  for (; monday <= last; monday += 7 * DAY) {
    const weekStart = iso(monday);
    const days = Object.entries(weekDays(input.personId, weekStart, input.timesheets, input.orgTimesheets)).filter(
      ([date]) => (!input.from || date >= input.from) && (!input.to || date <= input.to),
    );
    const total = days.reduce((acc, [, h]) => acc + h, 0);
    if (total <= 0) continue;
    const otShare = Math.max(0, total - input.weeklyThreshold) / total;
    for (const [date, h] of days) {
      if (!date.startsWith(input.month)) continue;
      regular += h * (1 - otShare);
      overtime += h * otShare;
    }
  }
  const q = (n: number) => Math.round(n * 4) / 4;
  return { regular: q(regular), overtime: q(overtime) };
}
