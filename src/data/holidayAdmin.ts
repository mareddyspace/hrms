/**
 * Holiday calendar: HR / admin edits per country (local mode: portal state + audit trail; backend mode:
 * /admin/leave/holidays, audited on the server), loading the API list into portal state so every page sees
 * changes, and the .ics export built in the browser.
 */
import { api, API_ENABLED } from "../api/client.ts";
import { leaveAdminApi } from "../api/syncLeaveAdmin.ts";
import type { CountryCode, Holiday } from "../model.ts";
import { appendAuditEntries } from "./auditTrail.ts";

export function canEditHolidays(role: string): boolean {
  return role === "hr" || role === "hr_admin" || role === "hrbp" || role === "admin" || role === "super_admin";
}

type Replace = (change: (holidays: Holiday[]) => Holiday[]) => void;
type Actor = { id: string; fullName: string; role: string };

const inYear = (h: Holiday, country: string, year: number) => (h.countryCode ?? "IN") === country && h.date.startsWith(`${year}-`);

/** Backend mode: the year's holidays for a country into portal state (HR reads any country; others their own). */
export async function loadApiHolidays(replace: Replace, country: string, year: number, asAdmin: boolean): Promise<string | null> {
  if (!API_ENABLED) return null;
  try {
    const rows = asAdmin
      ? (await leaveAdminApi.holidays(country, year)).filter((h) => h.active && !h.calendar)
      : await api.get<{ id: string; date: string; name: string; country_code: string }[]>("/leave/holidays", { year });
    const list: Holiday[] = rows.map((h) => ({ id: h.id, date: h.date, name: h.name, countryCode: h.country_code as CountryCode }));
    const code = asAdmin ? country : (list[0]?.countryCode ?? country);
    replace((all) => [...all.filter((h) => !inYear(h, code, year)), ...list].sort((a, b) => a.date.localeCompare(b.date)));
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : "Could not load holidays.";
  }
}

function validate(all: Holiday[], input: { id?: string; countryCode: string; date: string; name: string }): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) return "Choose a date.";
  const name = input.name.trim();
  if (name.length < 2) return "Enter the holiday name.";
  if (name.length > 200) return "Keep the name under 200 characters.";
  if (all.some((h) => h.id !== input.id && (h.countryCode ?? "IN") === input.countryCode && h.date === input.date)) {
    return "There is already a holiday on that date.";
  }
  return null;
}

/** Add or edit a holiday. Returns an error message or null. */
export async function saveHoliday(
  replace: Replace,
  current: Holiday[],
  actor: Actor,
  input: { id?: string; countryCode: string; date: string; name: string },
): Promise<string | null> {
  if (!canEditHolidays(actor.role)) return "Only HR or an administrator can change holidays.";
  const error = validate(current, input);
  if (error) return error;
  const name = input.name.trim();
  const year = Number(input.date.slice(0, 4));
  if (API_ENABLED) {
    try {
      if (input.id) await leaveAdminApi.updateHoliday(input.id, { date: input.date, name });
      else await leaveAdminApi.createHoliday({ country_code: input.countryCode, date: input.date, name, calendar: null });
    } catch (e) {
      return e instanceof Error ? e.message : "Could not save the holiday.";
    }
    const before = current.find((h) => h.id === input.id);
    if (before && before.date.slice(0, 4) !== input.date.slice(0, 4)) await loadApiHolidays(replace, input.countryCode, Number(before.date.slice(0, 4)), true);
    return loadApiHolidays(replace, input.countryCode, year, true);
  }
  const before = input.id ? current.find((h) => h.id === input.id) : undefined;
  const id = before?.id ?? `h-${input.countryCode.toLowerCase()}-${Date.now().toString(36)}`;
  const row: Holiday = { id, date: input.date, name, countryCode: input.countryCode as CountryCode };
  replace((all) => [...all.filter((h) => h.id !== id), row].sort((a, b) => a.date.localeCompare(b.date)));
  appendAuditEntries([
    {
      at: new Date().toISOString(),
      actorId: actor.id,
      actorName: actor.fullName,
      entity: "Holiday",
      entityId: id,
      action: before ? "Updated" : "Created",
      changes: [
        { field: "Country", before: before ? (before.countryCode ?? "IN") : "", after: input.countryCode },
        { field: "Date", before: before?.date ?? "", after: input.date },
        { field: "Name", before: before?.name ?? "", after: name },
      ],
    },
  ]);
  return null;
}

/** Remove a holiday (backend mode: deactivated on the server). */
export async function removeHoliday(replace: Replace, current: Holiday[], actor: Actor, id: string): Promise<string | null> {
  if (!canEditHolidays(actor.role)) return "Only HR or an administrator can change holidays.";
  const row = current.find((h) => h.id === id);
  if (!row) return "Holiday not found.";
  if (API_ENABLED) {
    try {
      await leaveAdminApi.deactivateHoliday(id);
    } catch (e) {
      return e instanceof Error ? e.message : "Could not remove the holiday.";
    }
    return loadApiHolidays(replace, row.countryCode ?? "IN", Number(row.date.slice(0, 4)), true);
  }
  replace((all) => all.filter((h) => h.id !== id));
  appendAuditEntries([
    {
      at: new Date().toISOString(),
      actorId: actor.id,
      actorName: actor.fullName,
      entity: "Holiday",
      entityId: id,
      action: "Removed",
      changes: [
        { field: "Country", before: row.countryCode ?? "IN", after: "" },
        { field: "Date", before: row.date, after: "" },
        { field: "Name", before: row.name, after: "" },
      ],
    },
  ]);
  return null;
}

/* ───────── .ics export (built in the browser, no external call) ───────── */

const icsText = (s: string) => s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/([,;])/g, "\\$1");

function nextDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return next.toISOString().slice(0, 10);
}

/** An iCalendar file of all-day events, one per holiday. */
export function buildHolidayIcs(
  events: { id: string; date: string; name: string; optional?: boolean }[],
  calendarName: string,
): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//TimeZ//Holiday calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsText(calendarName)}`,
  ];
  for (const e of [...events].sort((a, b) => a.date.localeCompare(b.date))) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${icsText(`${e.id}-${e.date}`)}@timez.holidays`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${e.date.replace(/-/g, "")}`,
      `DTEND;VALUE=DATE:${nextDay(e.date).replace(/-/g, "")}`,
      `SUMMARY:${icsText(e.optional ? `${e.name} (optional)` : e.name)}`,
      "TRANSP:TRANSPARENT",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return `${lines.join("\r\n")}\r\n`;
}

export function downloadIcs(filename: string, text: string): void {
  const blob = new Blob([text], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
