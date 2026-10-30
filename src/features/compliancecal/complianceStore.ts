/**
 * HR compliance calendar: statutory due dates (sample dates, configurable) plus visa / permit and document expiry,
 * probation end and contract end within 30 / 60 / 90 days.
 * Backend mode: /compliance-calendar (backend/app/services/compliance_calendar.py). Local mode: the same sample list
 * saved in this browser, people from the local directory and visas from Visas & permits.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { API_ENABLED, api, apiRequest } from "../../api/client.ts";
import { pushPersonTaskAlert } from "../../data/collabLocal.ts";
import { listPeople, subscribePeople } from "../../data/peopleLocal.ts";
import { addDaysISO, todayISO } from "../../model.ts";
import { getImmigrationState, subscribeImmigration } from "../compliance/immigrationStore.ts";
import { baseProbationEnd } from "../lifecycle/lifecycleShared.ts";
import { DEMO_ACCOUNTS } from "../../demoAccounts.ts";

export type ComplianceKind = "statutory" | "visa" | "document" | "probation" | "contract";
export type Frequency = "monthly" | "quarterly" | "annual";

export const KIND_LABEL: Record<ComplianceKind, string> = {
  statutory: "Statutory",
  visa: "Visa / permit",
  document: "Document",
  probation: "Probation",
  contract: "Contract",
};

export const WINDOWS = [30, 60, 90] as const;
export const ALERT_DAYS = 7;
export const COMPLIANCE_ROLES = new Set(["hr", "hr_admin", "hrbp", "admin", "super_admin"]);

export interface DueDate {
  id: string;
  countryCode: string;
  name: string;
  frequency: Frequency;
  day: number;
  months: number[];
  href?: string;
  sample: boolean;
  active: boolean;
}

export interface ComplianceItem {
  id: string;
  kind: ComplianceKind;
  title: string;
  date: string;
  countryCode: string;
  daysLeft: number;
  href: string;
  employeeId?: string;
  employeeName?: string;
  sample: boolean;
}

/** Same sample list as the backend (SAMPLE_DUE_DATES). Not legal advice. */
export const SAMPLE_DUE_DATES: DueDate[] = (
  [
    ["cd-in-pf", "IN", "PF contribution (EPF ECR)", "monthly", 15, []],
    ["cd-in-esi", "IN", "ESI contribution", "monthly", 15, []],
    ["cd-in-tds", "IN", "TDS deposit (salary)", "monthly", 7, []],
    ["cd-in-pt", "IN", "Professional tax (Karnataka)", "monthly", 20, []],
    ["cd-in-24q", "IN", "TDS return (Form 24Q)", "quarterly", 31, [1, 5, 7, 10]],
    ["cd-gb-paye", "GB", "PAYE and NI payment to HMRC", "monthly", 22, []],
    ["cd-gb-p60", "GB", "P60 to employees", "annual", 31, [5]],
    ["cd-us-941", "US", "Form 941 (quarterly federal return)", "quarterly", 31, [1, 4, 7, 10]],
    ["cd-us-w2", "US", "W-2 to employees and SSA", "annual", 31, [1]],
    ["cd-au-stp", "AU", "PAYG withholding (BAS)", "quarterly", 28, [1, 4, 7, 10]],
    ["cd-ae-wps", "AE", "WPS salary transfer", "monthly", 10, []],
    ["cd-sa-gosi", "SA", "GOSI contribution", "monthly", 15, []],
    ["cd-de-lst", "DE", "Lohnsteuer-Anmeldung", "monthly", 10, []],
    ["cd-ca-rem", "CA", "Source deductions remittance", "monthly", 15, []],
  ] as const
).map(([id, countryCode, name, frequency, day, months]) => ({
  id,
  countryCode,
  name,
  frequency,
  day,
  months: [...months],
  href: "/payroll",
  sample: true,
  active: true,
}));

const VISA_TYPES = new Set(["Visa", "Work permit", "Residence ID/Iqama", "Emirates ID", "BRP/UK right-to-work", "Aufenthaltstitel"]);

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

function on(year: number, month: number, day: number): string {
  const last = new Date(year, month, 0).getDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(Math.min(day, last)).padStart(2, "0")}`;
}

export function occurrences(row: Pick<DueDate, "frequency" | "day" | "months">, start: string, end: string): string[] {
  const out: string[] = [];
  let y = Number(start.slice(0, 4));
  let m = Number(start.slice(5, 7));
  while (`${y}-${String(m).padStart(2, "0")}-01` <= end) {
    if (row.frequency === "monthly" || row.months.includes(m)) {
      const d = on(y, m, row.day);
      if (d >= start && d <= end) out.push(d);
    }
    [y, m] = m === 12 ? [y + 1, 1] : [y, m + 1];
  }
  return out;
}

export function validateDueDate(input: Omit<DueDate, "id" | "sample">): string | null {
  if (!input.name.trim()) return "Enter a name.";
  if (!input.countryCode) return "Choose a country.";
  if (!Number.isInteger(input.day) || input.day < 1 || input.day > 31) return "Day must be 1 to 31.";
  if (input.frequency === "quarterly" && input.months.length !== 4) return "Pick the four months it is due in.";
  if (input.frequency === "annual" && input.months.length !== 1) return "Pick the month it is due in.";
  if (input.href && !input.href.startsWith("/")) return "Link must be a page in the portal, e.g. /payroll.";
  return null;
}

/* ───────────── Local due-date list ───────────── */

const KEY = "timez.complianceDueDates.v1";
const listeners = new Set<() => void>();
let cache: DueDate[] | null = null;
let version = 0;

function readLocal(): DueDate[] {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    cache = Array.isArray(parsed) ? (parsed as DueDate[]) : SAMPLE_DUE_DATES;
  } catch {
    cache = SAMPLE_DUE_DATES;
  }
  return cache;
}

function writeLocal(rows: DueDate[]): string | null {
  try {
    localStorage.setItem(KEY, JSON.stringify(rows));
  } catch {
    return "Could not save. Please try again.";
  }
  cache = rows;
  version += 1;
  listeners.forEach((fn) => fn());
  return null;
}

function localItems(today: string, days: number): ComplianceItem[] {
  const end = addDaysISO(today, days);
  const out: ComplianceItem[] = [];
  for (const row of readLocal().filter((r) => r.active)) {
    for (const d of occurrences(row, today, end)) {
      out.push({ id: `${row.id}:${d}`, kind: "statutory", title: row.name, date: d, countryCode: row.countryCode, daysLeft: daysBetween(today, d), href: row.href || "/payroll", sample: row.sample });
    }
  }
  const people = listPeople().filter((p) => p.employmentStatus !== "Terminated");
  const byId = new Map(people.map((p) => [p.id, p]));
  for (const doc of getImmigrationState().documents) {
    const p = byId.get(doc.personId);
    if (!p || doc.expiryDate < today || doc.expiryDate > end || doc.renewalInProgress) continue;
    const kind: ComplianceKind = VISA_TYPES.has(doc.type) ? "visa" : "document";
    out.push({ id: `doc:${doc.id}`, kind, title: `${doc.type} expires`, date: doc.expiryDate, countryCode: String(p.countryCode), daysLeft: daysBetween(today, doc.expiryDate), href: `/people/${p.id}`, employeeId: p.id, employeeName: p.fullName, sample: false });
  }
  for (const p of people) {
    if (p.dateOfJoining && p.dateOfJoining <= today && !p.confirmationDate) {
      const d = baseProbationEnd(p.dateOfJoining, String(p.countryCode));
      if (d >= today && d <= end) {
        out.push({ id: `probation:${p.id}`, kind: "probation", title: "Probation ends", date: d, countryCode: String(p.countryCode), daysLeft: daysBetween(today, d), href: `/people/${p.id}`, employeeId: p.id, employeeName: p.fullName, sample: false });
      }
    }
    if (p.contractEndDate && p.contractEndDate >= today && p.contractEndDate <= end) {
      out.push({ id: `contract:${p.id}`, kind: "contract", title: "Contract ends", date: p.contractEndDate, countryCode: String(p.countryCode), daysLeft: daysBetween(today, p.contractEndDate), href: `/people/${p.id}`, employeeId: p.id, employeeName: p.fullName, sample: false });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind) || a.title.localeCompare(b.title));
}

/** Local mode: tell HR about items due in 7 days, once per item (the backend does this in its scheduled jobs). */
const SENT_KEY = "timez.complianceAlerts.v1";
function sendLocalAlerts(items: ComplianceItem[]) {
  let sent: Record<string, true> = {};
  try {
    sent = JSON.parse(localStorage.getItem(SENT_KEY) ?? "{}") as Record<string, true>;
  } catch {
    sent = {};
  }
  const hr = DEMO_ACCOUNTS.filter((a) => a.role === "hr_admin" || a.role === "hr");
  let changed = false;
  for (const item of items.filter((i) => i.daysLeft === ALERT_DAYS)) {
    if (sent[item.id]) continue;
    for (const person of hr) {
      pushPersonTaskAlert({
        recipientId: person.id,
        title: `Due in 7 days: ${item.title}${item.employeeName ? ` · ${item.employeeName}` : ""}`,
        body: `${item.title} on ${item.date} (${item.countryCode}).`,
        href: item.href,
      });
    }
    sent[item.id] = true;
    changed = true;
  }
  if (changed) {
    try {
      localStorage.setItem(SENT_KEY, JSON.stringify(sent));
    } catch {
      // best effort
    }
  }
}

/* ───────────── API ───────────── */

interface ItemApi {
  id: string;
  kind: ComplianceKind;
  title: string;
  date: string;
  country_code: string;
  days_left: number;
  href: string;
  employee_id: string | null;
  employee_name: string | null;
  sample: boolean;
}

interface DueDateApi {
  id: string;
  country_code: string;
  name: string;
  frequency: Frequency;
  day: number;
  months: number[];
  href: string | null;
  note: string | null;
  active: boolean;
}

const itemFromApi = (i: ItemApi): ComplianceItem => ({
  id: i.id,
  kind: i.kind,
  title: i.title,
  date: i.date,
  countryCode: i.country_code,
  daysLeft: i.days_left,
  href: i.href,
  ...(i.employee_id ? { employeeId: i.employee_id, employeeName: i.employee_name ?? i.employee_id } : {}),
  sample: i.sample,
});

const dueFromApi = (r: DueDateApi): DueDate => ({
  id: r.id,
  countryCode: r.country_code,
  name: r.name,
  frequency: r.frequency,
  day: r.day,
  months: r.months,
  ...(r.href ? { href: r.href } : {}),
  sample: (r.note ?? "").toLowerCase().startsWith("sample"),
  active: r.active,
});

const noSubscribe = () => () => undefined;
function subscribeLocal(fn: () => void) {
  const bump = () => {
    version += 1;
    fn();
  };
  listeners.add(bump);
  const offs = [subscribePeople(bump), subscribeImmigration(bump)];
  return () => {
    listeners.delete(bump);
    offs.forEach((off) => off());
  };
}

/** Items from today to `days` ahead (soonest first). */
export function useComplianceItems(days: number) {
  useSyncExternalStore(API_ENABLED ? noSubscribe : subscribeLocal, () => (API_ENABLED ? 0 : version));
  const [apiRows, setApiRows] = useState<ComplianceItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!API_ENABLED) return;
    try {
      setApiRows((await api.get<ItemApi[]>("/compliance-calendar", { days })).map(itemFromApi));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the calendar.");
    }
  }, [days]);
  useEffect(() => {
    void load();
  }, [load]);
  const rows = API_ENABLED ? (apiRows ?? []) : localItems(todayISO(), days);
  useEffect(() => {
    if (!API_ENABLED) sendLocalAlerts(rows);
  }, [rows]);
  return { rows, loading: API_ENABLED && apiRows === null && !error, error, reload: load };
}

export async function loadDueDates(): Promise<DueDate[]> {
  if (API_ENABLED) return (await api.get<DueDateApi[]>("/compliance-calendar/due-dates")).map(dueFromApi);
  return [...readLocal()].sort((a, b) => a.countryCode.localeCompare(b.countryCode) || a.name.localeCompare(b.name));
}

export type DueDateInput = Omit<DueDate, "id" | "sample">;

/** Add (no id) or change a due date. */
export async function saveDueDate(id: string | null, input: DueDateInput): Promise<string | null> {
  const clean: DueDateInput = { ...input, name: input.name.trim().replace(/\s+/g, " "), months: input.frequency === "monthly" ? [] : [...input.months].sort((a, b) => a - b) };
  const problem = validateDueDate(clean);
  if (problem) return problem;
  if (API_ENABLED) {
    const body = { country_code: clean.countryCode, name: clean.name, frequency: clean.frequency, day: clean.day, months: clean.months, href: clean.href || null, active: clean.active };
    try {
      await apiRequest(id ? `/compliance-calendar/due-dates/${encodeURIComponent(id)}` : "/compliance-calendar/due-dates", { method: id ? "PUT" : "POST", body });
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : "Could not save.";
    }
  }
  const rows = readLocal();
  if (id) return writeLocal(rows.map((r) => (r.id === id ? { ...r, ...clean, sample: false } : r)));
  return writeLocal([...rows, { ...clean, id: `cd-${Math.random().toString(36).slice(2, 10)}`, sample: false }]);
}
