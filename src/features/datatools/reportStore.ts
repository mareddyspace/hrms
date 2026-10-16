import { isHrOrAdmin, isValidEmail, newId, cleanText, looksLikeFormula, type DataToolsActor, type DataToolsResult } from "./shared.ts";
import { sanitizeDefinition, validateDefinition, type ReportDefinition } from "./reportSources.ts";

const KEY = "kastech.reports.v1";
const MAX_RUNS = 200;
export const MAX_RECIPIENTS = 10;
export const MAX_REPORTS_PER_USER = 50;

export type Frequency = "daily" | "weekly" | "monthly";
export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export interface SavedReport {
  id: string;
  ownerId: string;
  ownerName: string;
  name: string;
  definition: ReportDefinition;
  createdAt: string;
  updatedAt: string;
}

export interface ReportSchedule {
  id: string;
  reportId: string;
  ownerId: string;
  ownerName: string;
  frequency: Frequency;
  /** 0–6 (Sunday first), weekly only. */
  dayOfWeek: number;
  /** 1–28, monthly only. */
  dayOfMonth: number;
  /** 24-hour HH:MM. */
  time: string;
  format: "csv" | "xlsx";
  recipients: string[];
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
}

export interface ReportRun {
  id: string;
  reportId: string;
  reportName: string;
  scheduleId?: string;
  at: string;
  actorId: string;
  actorName: string;
  rowCount: number;
  fileName: string;
  recipients: string[];
  trigger: "manual" | "schedule";
}

export interface ReportState {
  reports: SavedReport[];
  schedules: ReportSchedule[];
  runs: ReportRun[];
}

function defaults(): ReportState {
  return { reports: [], schedules: [], runs: [] };
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

function read(): ReportState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    const parsed = JSON.parse(raw) as Partial<Record<keyof ReportState, unknown>>;
    const reports: SavedReport[] = [];
    for (const r of Array.isArray(parsed?.reports) ? (parsed.reports as Partial<SavedReport>[]) : []) {
      const definition = sanitizeDefinition(r?.definition);
      if (!r || !definition || !str(r.id) || !str(r.ownerId) || !str(r.name)) continue;
      reports.push({ id: str(r.id), ownerId: str(r.ownerId), ownerName: str(r.ownerName), name: str(r.name), definition, createdAt: str(r.createdAt), updatedAt: str(r.updatedAt) });
    }
    const reportIds = new Set(reports.map((r) => r.id));
    const schedules = (Array.isArray(parsed?.schedules) ? (parsed.schedules as ReportSchedule[]) : []).filter(
      (s) =>
        s &&
        typeof s.id === "string" &&
        reportIds.has(s.reportId) &&
        (s.frequency === "daily" || s.frequency === "weekly" || s.frequency === "monthly") &&
        /^\d{2}:\d{2}$/.test(str(s.time)) &&
        Array.isArray(s.recipients),
    ).map((s) => ({ ...s, format: s.format === "csv" ? ("csv" as const) : ("xlsx" as const), recipients: s.recipients.filter((e) => typeof e === "string") }));
    const runs = (Array.isArray(parsed?.runs) ? (parsed.runs as ReportRun[]) : []).filter(
      (r) => r && typeof r.id === "string" && typeof r.at === "string" && typeof r.reportName === "string",
    ).map((r) => ({ ...r, recipients: Array.isArray(r.recipients) ? r.recipients : [] }));
    return { reports, schedules, runs };
  } catch {
    return defaults();
  }
}

let cache: ReportState | null = null;
const listeners = new Set<() => void>();

function write(state: ReportState): DataToolsResult {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    return "Browser storage is full, so this change was not saved.";
  }
  cache = state;
  listeners.forEach((fn) => fn());
  return null;
}

export function subscribeReports(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Stable snapshot for useSyncExternalStore — same reference until data changes. */
export function getReportState(): ReportState {
  if (!cache) cache = read();
  return cache;
}

/** Report owners always; HR and admins may manage any schedule. */
export function canManageSchedule(actor: DataToolsActor, schedule: Pick<ReportSchedule, "ownerId">): boolean {
  return schedule.ownerId === actor.id || isHrOrAdmin(actor.role);
}

function cleanName(name: string): string | { error: string } {
  const value = cleanText(name);
  if (value.length < 3 || value.length > 60) return { error: "Report name must be 3–60 characters." };
  if (looksLikeFormula(value)) return { error: "Report name cannot start with =, +, - or @." };
  return value;
}

/** Save a new report or overwrite one of your own (by id). Name must be unique among your reports. */
/* Callers find a new report again by owner + name, which is unique. */
export function saveReport(actor: DataToolsActor, input: { id?: string; name: string; definition: ReportDefinition }): DataToolsResult {
  const name = cleanName(input.name);
  if (typeof name !== "string") return name.error;
  const definition = sanitizeDefinition(input.definition);
  if (!definition) return "Choose a data source.";
  const invalid = validateDefinition(definition);
  if (invalid) return invalid;
  const state = getReportState();
  const mine = state.reports.filter((r) => r.ownerId === actor.id);
  const clash = mine.find((r) => r.name.toLowerCase() === name.toLowerCase() && r.id !== input.id);
  if (clash) return `You already have a report called "${clash.name}".`;
  const now = new Date().toISOString();
  if (input.id) {
    const existing = state.reports.find((r) => r.id === input.id);
    if (!existing) return "That report no longer exists.";
    if (existing.ownerId !== actor.id) return "Only the owner can change this report.";
    return write({ ...state, reports: state.reports.map((r) => (r.id === input.id ? { ...r, name, definition, updatedAt: now } : r)) });
  }
  if (mine.length >= MAX_REPORTS_PER_USER) return `You can keep up to ${MAX_REPORTS_PER_USER} saved reports. Delete one first.`;
  const report: SavedReport = { id: newId("rpt"), ownerId: actor.id, ownerName: actor.fullName, name, definition, createdAt: now, updatedAt: now };
  return write({ ...state, reports: [report, ...state.reports] });
}

export function deleteReport(actor: DataToolsActor, reportId: string): DataToolsResult {
  const state = getReportState();
  const report = state.reports.find((r) => r.id === reportId);
  if (!report) return "That report no longer exists.";
  if (report.ownerId !== actor.id && !isHrOrAdmin(actor.role)) return "Only the owner can delete this report.";
  return write({ ...state, reports: state.reports.filter((r) => r.id !== reportId), schedules: state.schedules.filter((s) => s.reportId !== reportId) });
}

export interface ScheduleInput {
  id?: string;
  reportId: string;
  frequency: Frequency;
  dayOfWeek: number;
  dayOfMonth: number;
  time: string;
  format: "csv" | "xlsx";
  recipientsText: string;
}

export function parseRecipients(text: string): { emails: string[] } | { error: string } {
  const parts = text.split(/[\s,;]+/).map((p) => p.trim().toLowerCase()).filter(Boolean);
  if (!parts.length) return { error: "Add at least one recipient email." };
  const bad = parts.filter((p) => !isValidEmail(p));
  if (bad.length) return { error: `Not a valid email: ${bad.slice(0, 3).join(", ")}${bad.length > 3 ? "…" : ""}` };
  const emails = [...new Set(parts)];
  if (emails.length > MAX_RECIPIENTS) return { error: `Up to ${MAX_RECIPIENTS} recipients per schedule.` };
  return { emails };
}

export function saveSchedule(actor: DataToolsActor, input: ScheduleInput): DataToolsResult {
  const state = getReportState();
  const report = state.reports.find((r) => r.id === input.reportId);
  if (!report) return "Choose a saved report.";
  if (!["daily", "weekly", "monthly"].includes(input.frequency)) return "Choose how often it runs.";
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time)) return "Time must be HH:MM in 24-hour format.";
  if (input.frequency === "weekly" && !(Number.isInteger(input.dayOfWeek) && input.dayOfWeek >= 0 && input.dayOfWeek <= 6)) return "Choose a weekday.";
  if (input.frequency === "monthly" && !(Number.isInteger(input.dayOfMonth) && input.dayOfMonth >= 1 && input.dayOfMonth <= 28)) return "Day of month must be between 1 and 28.";
  if (input.format !== "csv" && input.format !== "xlsx") return "Choose CSV or Excel.";
  const recipients = parseRecipients(input.recipientsText);
  if ("error" in recipients) return recipients.error;
  const now = new Date().toISOString();
  const fields = {
    reportId: report.id,
    frequency: input.frequency,
    dayOfWeek: input.frequency === "weekly" ? input.dayOfWeek : 1,
    dayOfMonth: input.frequency === "monthly" ? input.dayOfMonth : 1,
    time: input.time,
    format: input.format,
    recipients: recipients.emails,
    updatedAt: now,
  };
  if (input.id) {
    const existing = state.schedules.find((s) => s.id === input.id);
    if (!existing) return "That schedule no longer exists.";
    if (!canManageSchedule(actor, existing)) return "Only the schedule owner, HR or an admin can change this schedule.";
    if (existing.reportId !== report.id) return "A schedule cannot move to a different report.";
    return write({ ...state, schedules: state.schedules.map((s) => (s.id === existing.id ? { ...s, ...fields } : s)) });
  }
  if (report.ownerId !== actor.id) return "You can only schedule your own reports.";
  if (state.schedules.some((s) => s.reportId === report.id)) return "This report already has a schedule. Edit it instead.";
  const schedule: ReportSchedule = { id: newId("sch"), ownerId: actor.id, ownerName: actor.fullName, createdAt: now, ...fields };
  return write({ ...state, schedules: [schedule, ...state.schedules] });
}

export function deleteSchedule(actor: DataToolsActor, scheduleId: string): DataToolsResult {
  const state = getReportState();
  const schedule = state.schedules.find((s) => s.id === scheduleId);
  if (!schedule) return "That schedule no longer exists.";
  if (!canManageSchedule(actor, schedule)) return "Only the schedule owner, HR or an admin can delete this schedule.";
  return write({ ...state, schedules: state.schedules.filter((s) => s.id !== scheduleId) });
}

/** Log a generated file (manual export or a schedule's "Run now"). */
export function logRun(
  actor: DataToolsActor,
  input: { reportId: string; scheduleId?: string; rowCount: number; fileName: string },
): DataToolsResult {
  const state = getReportState();
  const report = state.reports.find((r) => r.id === input.reportId);
  if (!report) return "That report no longer exists.";
  const schedule = input.scheduleId ? state.schedules.find((s) => s.id === input.scheduleId) : undefined;
  if (input.scheduleId && !schedule) return "That schedule no longer exists.";
  if (schedule && !canManageSchedule(actor, schedule)) return "Only the schedule owner, HR or an admin can run this schedule.";
  if (!schedule && report.ownerId !== actor.id && !isHrOrAdmin(actor.role)) return "Only the owner can run this report.";
  const at = new Date().toISOString();
  const run: ReportRun = {
    id: newId("run"),
    reportId: report.id,
    reportName: report.name,
    scheduleId: schedule?.id,
    at,
    actorId: actor.id,
    actorName: actor.fullName,
    rowCount: input.rowCount,
    fileName: input.fileName.slice(0, 120),
    recipients: schedule?.recipients ?? [],
    trigger: schedule ? "schedule" : "manual",
  };
  return write({
    ...state,
    schedules: schedule ? state.schedules.map((s) => (s.id === schedule.id ? { ...s, lastRunAt: at } : s)) : state.schedules,
    runs: [run, ...state.runs].slice(0, MAX_RUNS),
  });
}

/** Next delivery after `now`, in the browser's local time. */
export function nextRun(schedule: Pick<ReportSchedule, "frequency" | "dayOfWeek" | "dayOfMonth" | "time">, now: Date = new Date()): Date {
  const [hh, mm] = schedule.time.split(":").map(Number);
  const at = (d: Date) => {
    const x = new Date(d);
    x.setHours(hh, mm, 0, 0);
    return x;
  };
  if (schedule.frequency === "daily") {
    const today = at(now);
    if (today > now) return today;
    today.setDate(today.getDate() + 1);
    return today;
  }
  if (schedule.frequency === "weekly") {
    const candidate = at(now);
    const delta = (schedule.dayOfWeek - candidate.getDay() + 7) % 7;
    candidate.setDate(candidate.getDate() + delta);
    if (candidate <= now) candidate.setDate(candidate.getDate() + 7);
    return candidate;
  }
  const candidate = at(new Date(now.getFullYear(), now.getMonth(), schedule.dayOfMonth));
  if (candidate > now) return candidate;
  return at(new Date(now.getFullYear(), now.getMonth() + 1, schedule.dayOfMonth));
}

export function describeSchedule(s: Pick<ReportSchedule, "frequency" | "dayOfWeek" | "dayOfMonth" | "time">): string {
  if (s.frequency === "daily") return `Daily at ${s.time}`;
  if (s.frequency === "weekly") return `Weekly on ${WEEKDAYS[s.dayOfWeek]} at ${s.time}`;
  return `Monthly on day ${s.dayOfMonth} at ${s.time}`;
}
