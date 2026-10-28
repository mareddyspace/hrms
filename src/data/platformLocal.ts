import type { NavAccessId } from "../demoAccounts.ts";
import { pushPersonTaskAlert } from "./collabLocal.ts";
import {
  AUDIT_LOG_SEED,
  ROLE_PERMISSION_CATALOG,
  INTEGRATION_SEED,
  NOTIFICATION_PREF_SEED,
  SYNC_SCHEDULES,
  SYNC_SCHEDULE_DEFAULT,
  type AuditLogRow,
  type IntegrationCard,
  type NotificationPref,
  type SyncRun,
  type SyncSchedule,
} from "./platformData.ts";
import { API_ENABLED, createApiMirror, errorText } from "../api/syncOps.ts";
import {
  apiDismissQuarantine,
  apiFixQuarantine,
  apiRetryQuarantine,
  apiRunConnector,
  apiRunJobs,
  apiSetSchedule,
  loadApiIntegrations,
  type ApiIntegrationData,
  type ConnectorOut,
  type QuarantineOut,
} from "../api/syncOpsAdmin.ts";
import { apiEmailSwitches, setApiEmailSwitch, subscribeEmailOutbox } from "./emailOutbox.ts";
import { findDemoById } from "../demoAccounts.ts";

const INT_KEY = "timez.platform.integrations.v2";
const AUDIT_KEY = "timez.platform.audit.v2";
const NOTIF_KEY = "timez.platform.notifications.v1";
const ROLE_KEY = "timez.platform.roleEdits.v2";

type Listener = () => void;
const listeners = new Set<Listener>();
let platformVersion = 0;

function notify() {
  platformVersion += 1;
  for (const l of listeners) l();
}

/** Bumps when platform localStorage overlays change — used by useSyncExternalStore. */
export function getPlatformVersion() {
  return platformVersion;
}

export function subscribePlatform(listener: Listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  localStorage.setItem(key, JSON.stringify(value));
  notify();
}

/* —— Backend mode (VITE_API_URL): connectors, runs and quarantine live on the server (admins) —— */

const intMirror = createApiMirror<ApiIntegrationData | null>(
  () => null,
  () => loadApiIntegrations().catch(() => ({ connectors: [], runs: {}, quarantine: {} })),
);
if (API_ENABLED) {
  intMirror.subscribe(notify);
  subscribeEmailOutbox(notify); // email switches load with the outbox
}

/** "2026-10-28T09:31:00Z" → local "2026-10-28 15:01" (the card's last-run format). */
function localStamp(iso: string | null): string {
  if (!iso) return "Never";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : syncStamp(d);
}

const runner = (id: string | null, trigger: string) => (id ? (findDemoById(id)?.fullName ?? id) : trigger === "schedule" ? "Scheduler" : trigger);

let apiCards: { api: ApiIntegrationData | null; out: IntegrationCard[] } | null = null;

function toCard(c: ConnectorOut, api: ApiIntegrationData): IntegrationCard {
  const seed = INTEGRATION_SEED.find((s) => s.id === c.id);
  const runs = (api.runs[c.id] ?? []).map(
    (r): SyncRun => ({ at: r.started_at, processed: r.processed, succeeded: r.succeeded, failed: r.failed, by: runner(r.run_by, r.trigger) }),
  );
  const logs: IntegrationCard["logs"] = runs.slice(0, 8).map((r) => ({
    at: new Date(r.at).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }),
    level: r.failed ? "warn" : "info",
    message: r.failed ? `Sync by ${r.by}: ${r.succeeded} of ${r.processed} records passed, ${r.failed} quarantined` : `Sync by ${r.by}: ${r.processed} records passed`,
  }));
  return {
    id: c.id,
    name: c.name,
    category: c.category,
    description: seed?.description ?? "",
    status: c.status as IntegrationCard["status"],
    lastSync: localStamp(c.last_sync_at),
    recordsProcessed: c.records_processed,
    errorCount: c.open_quarantine,
    logs,
    schedule: (SYNC_SCHEDULES.some((s) => s.id === c.schedule) ? c.schedule : "hourly") as SyncSchedule,
    runs,
    successCount: c.success_count,
    failedCount: c.failed_count,
  };
}

function apiIntegrationCards(): IntegrationCard[] {
  const api = intMirror.get();
  if (apiCards?.api === api) return apiCards.out;
  apiCards = { api, out: api ? api.connectors.map((c) => toCard(c, api)) : [] };
  return apiCards.out;
}

function toQuarantine(q: QuarantineOut): QuarantineRecord {
  return {
    id: q.id,
    connectorId: q.connector_id,
    record: q.record,
    field: q.field as QuarantineField,
    value: q.value,
    reason: q.reason,
    at: new Date(q.created_at).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }),
    attempts: q.attempts,
  };
}

async function apiOutcome(run: () => Promise<{ ok: boolean; record: QuarantineOut } | unknown>): Promise<RecordOutcome> {
  try {
    const out = (await run()) as { ok: boolean; record: QuarantineOut };
    return { ok: out.ok, record: toQuarantine(out.record) };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  } finally {
    await intMirror.reload();
  }
}

/**
 * Backend mode: runs the scheduled jobs once (approval reminders, SLA escalation, case retention).
 * Connector syncs are never included from here.
 */
export async function runScheduledJobsNow(): Promise<{ results: Record<string, unknown> } | { error: string }> {
  try {
    return await apiRunJobs();
  } catch (e) {
    return { error: errorText(e) };
  }
}

export function listIntegrations(): IntegrationCard[] {
  if (API_ENABLED) return apiIntegrationCards();
  return readJson(INT_KEY, INTEGRATION_SEED);
}

/** Deterministic per integration and attempt: some connectors keep failing until fixed at the source. */
function retrySucceeds(item: IntegrationCard, attempt: number): boolean {
  if (item.status === "Disconnected") return false;
  let h = attempt;
  for (const ch of item.id) h = (h * 31 + ch.charCodeAt(0)) | 0;
  const roll = Math.abs(h) % 100;
  // Degraded connectors recover about half the time; healthy ones almost always.
  return item.status === "Degraded" ? roll < 50 : roll < 90;
}

export type RetryOutcome = { item: IntegrationCard; ok: boolean };

export function retryIntegration(id: string, actorName: string): RetryOutcome | null | Promise<RetryOutcome | null> {
  if (API_ENABLED) {
    return runIntegrationSyncApi(id).then((r) => (r && "item" in r ? { item: r.item, ok: r.failed.length === 0 } : null));
  }
  const list = listIntegrations().map((item) => ({ ...item, logs: [...item.logs] }));
  const idx = list.findIndex((i) => i.id === id);
  if (idx < 0) return null;
  const item = list[idx];
  if (item.status === "Not configured") return null;
  const now = new Date();
  const stamp = now.toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  const attempt = item.logs.filter((l) => l.message.startsWith("Manual retry")).length + 1;
  const ok = retrySucceeds(item, attempt);
  if (ok) {
    item.lastSync = syncStamp(now);
    item.status = "Connected";
    item.errorCount = Math.max(0, item.errorCount - 1);
    item.recordsProcessed += 25;
  } else {
    item.status = item.status === "Connected" ? "Degraded" : item.status;
    item.errorCount += 1;
  }
  item.logs = (
    [
      ok
        ? { at: stamp, level: "info" as const, message: `Manual retry by ${actorName} succeeded` }
        : { at: stamp, level: "error" as const, message: `Manual retry by ${actorName} failed — provider did not respond` },
      ...item.logs,
    ] as IntegrationCard["logs"]
  ).slice(0, 8);
  list[idx] = item;
  writeJson(INT_KEY, list);
  appendAudit({
    actor: actorName,
    action: "Retry integration sync",
    target: item.name,
    outcome: ok ? "Success" : "Failed",
  });
  return { item, ok };
}

export function listAuditLog(): AuditLogRow[] {
  return readJson(AUDIT_KEY, AUDIT_LOG_SEED);
}

export function appendAudit(partial: Omit<AuditLogRow, "id" | "at"> & { at?: string }) {
  const list = listAuditLog();
  const row: AuditLogRow = {
    id: `aud-${Date.now()}`,
    at: partial.at ?? new Date().toISOString().slice(0, 16).replace("T", " "),
    actor: partial.actor,
    action: partial.action,
    target: partial.target,
    outcome: partial.outcome,
  };
  writeJson(AUDIT_KEY, [row, ...list].slice(0, 40));
}

export function listNotificationPrefs(): NotificationPref[] {
  const local = readJson(NOTIF_KEY, NOTIFICATION_PREF_SEED);
  const server = API_ENABLED ? apiEmailSwitches() : null;
  if (!server) return local;
  // Backend mode: the email switch comes from the server; in-app and digest stay in this browser.
  return local.map((p) => {
    const s = server.find((x) => x.channel === p.id);
    return s ? { ...p, email: s.email } : p;
  });
}

let prefError: string | null = null;

/** Backend mode: the last email-switch save error, or null. */
export function notificationPrefError(): string | null {
  return prefError;
}

export function updateNotificationPref(id: string, patch: Partial<NotificationPref>, actorName: string) {
  if (API_ENABLED && patch.email !== undefined && apiEmailSwitches()?.some((s) => s.channel === id)) {
    void setApiEmailSwitch(id, patch.email).then((error) => {
      prefError = error;
      notify();
    });
    const { email: _email, ...rest } = patch;
    if (!Object.keys(rest).length) return;
    patch = rest;
  }
  const list = listNotificationPrefs().map((p) => (p.id === id ? { ...p, ...patch, id: p.id } : p));
  writeJson(NOTIF_KEY, list);
  appendAudit({
    actor: actorName,
    action: "Updated notification preference",
    target: id,
    outcome: "Success",
  });
}

/**
 * Permission changes made in Administration → Roles & permissions.
 * Only the modules in ROLE_PERMISSION_CATALOG can be granted or removed; everything else keeps the baseline.
 */
export type NavOverride = { grant: NavAccessId[]; revoke: NavAccessId[] };
export type RoleEditMap = Record<string, NavOverride>;

const EDITABLE_IDS = new Set(ROLE_PERMISSION_CATALOG.map((p) => p.id));
/** Pay data can only be handed out by someone who already holds it. */
const PAY_IDS: readonly string[] = ["compensation", "payslips"];

export function getRoleEdits(): RoleEditMap {
  const raw = readJson<Record<string, unknown>>(ROLE_KEY, {});
  const out: RoleEditMap = {};
  for (const [id, value] of Object.entries(raw)) {
    const v = value as Partial<NavOverride>;
    const clean = (list: unknown) =>
      (Array.isArray(list) ? list : []).filter((x): x is NavAccessId => typeof x === "string" && EDITABLE_IDS.has(x));
    out[id] = { grant: clean(v?.grant), revoke: clean(v?.revoke) };
  }
  return out;
}

/** Overrides the lead merges into accountHasNavAccess: revoke wins over baseline, grant adds. */
export function getNavOverrides(accountId: string): NavOverride | null {
  return getRoleEdits()[accountId] ?? null;
}

/** Only platform admins may change role permissions — and never on their own account. */
export function canEditRolePermissions(actorRole: string): boolean {
  return actorRole === "admin" || actorRole === "super_admin";
}

function holds(navAccess: readonly string[], id: string): boolean {
  return navAccess.includes("*") || navAccess.includes(id);
}

/** Returns an error message, or null when saved. `permissions` is the desired set of catalog modules. */
export function saveRoleEdit(
  account: { id: string; navAccess: readonly string[] },
  permissions: string[],
  actor: { id: string; fullName: string; role: string; navAccess: readonly string[] },
): string | null {
  if (!canEditRolePermissions(actor.role)) return "Only Admin can edit role permissions.";
  if (account.id === actor.id) return "You cannot change permissions on your own account.";
  const wanted = new Set(permissions.filter((id) => EDITABLE_IDS.has(id)));
  const grant: NavAccessId[] = [];
  const revoke: NavAccessId[] = [];
  for (const id of EDITABLE_IDS) {
    const base = holds(account.navAccess, id);
    if (wanted.has(id) && !base) grant.push(id as NavAccessId);
    if (!wanted.has(id) && base) revoke.push(id as NavAccessId);
  }
  const blocked = grant.filter((id) => PAY_IDS.includes(id) && !holds(actor.navAccess, id));
  if (blocked.length) return "You can't grant pay access you don't hold yourself.";
  const map = { ...getRoleEdits() };
  if (grant.length || revoke.length) map[account.id] = { grant, revoke };
  else delete map[account.id];
  writeJson(ROLE_KEY, map);
  appendAudit({
    actor: actor.fullName,
    action: `Changed permissions${grant.length ? ` · added ${grant.join(", ")}` : ""}${revoke.length ? ` · removed ${revoke.join(", ")}` : ""}`,
    target: account.id,
    outcome: "Success",
  });
  return null;
}

/** Catalog modules this account has once overrides are applied. */
export function effectiveCatalogIds(account: { id: string; navAccess: readonly string[] }): string[] {
  const o = getNavOverrides(account.id);
  return [...EDITABLE_IDS].filter((id) => {
    if (o?.revoke.includes(id as NavAccessId)) return false;
    if (o?.grant.includes(id as NavAccessId)) return true;
    return holds(account.navAccess, id);
  });
}

/* —— Sync schedule and run history —— */

export function integrationSchedule(item: IntegrationCard): SyncSchedule {
  return item.schedule ?? SYNC_SCHEDULE_DEFAULT[item.id] ?? "hourly";
}

function scheduleMinutes(schedule: SyncSchedule): number {
  return SYNC_SCHEDULES.find((s) => s.id === schedule)?.minutes ?? 0;
}

/** Reads "2026-10-14 08:40 IST" / "2026-10-14 08:40" as a local time. */
function parseSyncStamp(value: string): Date | null {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/.exec(value);
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2]}:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** A believable history for connectors that haven't run here yet: three scheduled runs up to the last sync. */
function seededRuns(item: IntegrationCard): SyncRun[] {
  if (item.status === "Not configured") return [];
  const last = parseSyncStamp(item.lastSync);
  if (!last) return [];
  const step = (scheduleMinutes(integrationSchedule(item)) || 60) * 60_000;
  const size = BATCH_SIZE[item.id] ?? 12;
  return [0, 1, 2].map((i) => {
    const failed = i === 0 ? Math.min(item.errorCount, 2) : hash(item.id, "seed", i) % 100 < 20 ? 1 : 0;
    return { at: new Date(last.getTime() - i * step).toISOString(), processed: size, succeeded: size - failed, failed, by: "Scheduler" };
  });
}

/** Last 10 runs, newest first. */
export function integrationRuns(item: IntegrationCard): SyncRun[] {
  return item.runs ?? seededRuns(item);
}

/** Records that passed and failed across all runs. */
export function integrationTotals(item: IntegrationCard): { succeeded: number; failed: number } {
  if (item.successCount !== undefined && item.failedCount !== undefined) return { succeeded: item.successCount, failed: item.failedCount };
  const runs = integrationRuns(item);
  return {
    succeeded: item.successCount ?? runs.reduce((n, r) => n + r.succeeded, 0),
    failed: item.failedCount ?? runs.reduce((n, r) => n + r.failed, 0),
  };
}

/** When the next scheduled run is due, or null for manual-only / not set up. */
export function nextRunAt(item: IntegrationCard, now: Date = new Date()): Date | null {
  if (item.status === "Not configured" || item.status === "Disconnected") return null;
  if (API_ENABLED) {
    const next = intMirror.get()?.connectors.find((c) => c.id === item.id)?.next_run_at;
    return next ? new Date(next) : null;
  }
  const minutes = scheduleMinutes(integrationSchedule(item));
  if (!minutes) return null;
  const runs = integrationRuns(item);
  const last = runs[0] ? new Date(runs[0].at) : parseSyncStamp(item.lastSync);
  const step = minutes * 60_000;
  if (!last || Number.isNaN(last.getTime())) return new Date(Math.ceil(now.getTime() / step) * step);
  let next = last.getTime() + step;
  if (next <= now.getTime()) next += Math.ceil((now.getTime() - next) / step) * step;
  if (next <= now.getTime()) next += step;
  return new Date(next);
}

export function setIntegrationSchedule(connectorId: string, schedule: SyncSchedule, actorName: string): void | Promise<string | null> {
  if (API_ENABLED) {
    return apiSetSchedule(connectorId, schedule).then(
      () => intMirror.reload().then(() => null),
      (e) => intMirror.reload().then(() => errorText(e)),
    );
  }
  const list = listIntegrations();
  const item = list.find((i) => i.id === connectorId);
  if (!item) return;
  const before = integrationSchedule(item);
  if (before === schedule) return;
  // Keep the seeded history so counts don't jump when the schedule changes.
  const runs = integrationRuns(item);
  const totals = integrationTotals(item);
  writeJson(
    INT_KEY,
    list.map((i) => (i.id === connectorId ? { ...i, schedule, runs, successCount: totals.succeeded, failedCount: totals.failed } : i)),
  );
  const label = (id: SyncSchedule) => SYNC_SCHEDULES.find((s) => s.id === id)?.label ?? id;
  appendAudit({ actor: actorName, action: `Changed sync schedule · ${label(before)} → ${label(schedule)}`, target: item.name, outcome: "Success" });
}

/* —— Sync runs and quarantine —— */

const QUAR_KEY = "timez.platform.quarantine.v1";

export type QuarantineField = "bankAccount" | "taxId" | "costCentre" | "workEmail";

export interface QuarantineRecord {
  id: string;
  connectorId: string;
  /** e.g. "EMP-1042 · Priya Nair". */
  record: string;
  field: QuarantineField;
  value: string;
  reason: string;
  at: string;
  attempts: number;
}

type QuarantineState = { runs: Record<string, number>; items: Record<string, QuarantineRecord[]> };

export const QUARANTINE_FIELD_LABEL: Record<QuarantineField, string> = {
  bankAccount: "Bank account",
  taxId: "Tax ID",
  costCentre: "Cost centre",
  workEmail: "Work email",
};

export const COST_CENTRES = ["CC-100", "CC-200", "CC-300", "CC-400", "CC-500"];

/** Fields each connector checks before a record is accepted. */
const CONNECTOR_FIELDS: Record<string, QuarantineField[]> = {
  payroll: ["bankAccount", "taxId", "costCentre"],
  benefits: ["taxId", "costCentre"],
  attendance: ["costCentre"],
  learning: ["workEmail", "costCentre"],
  sso: ["workEmail"],
  email: ["workEmail"],
  teams: ["workEmail"],
  slack: ["workEmail"],
};

/** Connectors whose failures HR also hears about (payroll and HR records). */
const HR_CONNECTORS = new Set(["payroll", "benefits", "attendance"]);

const BATCH_SIZE: Record<string, number> = { payroll: 24, benefits: 16, attendance: 40, learning: 20 };

const FIRST = ["Priya", "Arjun", "Meera", "Kabir", "Ananya", "Rohan", "Sara", "Vikram", "Diya", "Farah", "Oliver", "Emma", "Liam", "Noah", "Aisha", "Omar", "Lena", "Jonas", "Chloe", "Ethan"];
const LAST = ["Nair", "Sharma", "Iyer", "Mehta", "Rao", "Khan", "Patel", "Singh", "Das", "Ali", "Smith", "Brown", "Wilson", "Taylor", "Hassan", "Fischer", "Martin", "Clark", "Lee", "Walker"];

function hash(...parts: (string | number)[]): number {
  let h = 7;
  for (const ch of parts.join("|")) h = (h * 31 + ch.charCodeAt(0)) | 0;
  // Mix the bits so neighbouring rows don't fail together.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Null when the value is accepted, else the reason it's rejected. */
export function validateQuarantineValue(field: QuarantineField, value: string): string | null {
  const v = value.trim();
  if (field === "bankAccount") return /^\d{9,18}$/.test(v) ? null : v ? "Invalid bank account number" : "Missing bank account";
  if (field === "taxId") return /^[A-Z]{5}\d{4}[A-Z]$/.test(v.toUpperCase()) ? null : "Invalid tax ID";
  if (field === "costCentre") return COST_CENTRES.includes(v.toUpperCase()) ? null : `Unknown cost centre ${v || "(blank)"}`;
  return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v) ? null : "Missing work email";
}

/** The bad value a failing record arrives with. */
function badValue(field: QuarantineField, seed: number): string {
  if (field === "taxId") return ["ABCD1234", "PAN-PENDING", "AB12C3456D"][seed % 3];
  if (field === "costCentre") return ["CC-999", "CC-710", "SALES-EU"][seed % 3];
  return "";
}

function readQuarantine(): QuarantineState {
  const raw = readJson<Partial<QuarantineState>>(QUAR_KEY, {});
  return { runs: { ...raw.runs }, items: { ...raw.items } };
}

let quarantineCache: { api: ApiIntegrationData | null; byId: Map<string, QuarantineRecord[]> } | null = null;

export function listQuarantine(connectorId: string): QuarantineRecord[] {
  if (API_ENABLED) {
    const api = intMirror.get();
    if (quarantineCache?.api !== api) quarantineCache = { api, byId: new Map() };
    let rows = quarantineCache.byId.get(connectorId);
    if (!rows) {
      rows = (api?.quarantine[connectorId] ?? []).map(toQuarantine);
      quarantineCache.byId.set(connectorId, rows);
    }
    return rows;
  }
  return readQuarantine().items[connectorId] ?? [];
}

const nowStamp = () => new Date().toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
/** Local "YYYY-MM-DD HH:mm" — parseSyncStamp reads it back as local time. */
function syncStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

type Actor = { id: string; name: string };
const GONE = "That record is no longer in quarantine.";

/** Saves quarantine and connector together. The connector's error count is its open quarantine. */
function save(state: QuarantineState, connectorId: string, patch: (item: IntegrationCard) => void, log: IntegrationCard["logs"][number]) {
  const list = listIntegrations().map((i) => (i.id === connectorId ? { ...i, logs: [...i.logs] } : i));
  const item = list.find((i) => i.id === connectorId);
  if (item) {
    patch(item);
    const open = state.items[connectorId]?.length ?? 0;
    item.errorCount = open;
    if (open === 0 && item.status === "Degraded") item.status = "Connected";
    if (open > 0 && item.status === "Connected") item.status = "Degraded";
    item.logs = [log, ...item.logs].slice(0, 8);
  }
  try {
    localStorage.setItem(QUAR_KEY, JSON.stringify(state));
  } catch {
    /* keep going */
  }
  writeJson(INT_KEY, list);
  return item;
}

export type SyncRunResult = { item: IntegrationCard; processed: number; passed: number; failed: QuarantineRecord[] };

/** Runs one batch of records for a connector. A few fail validation and go to quarantine. */
/** Backend mode: one connector run on the server; the result has the records it quarantined. */
async function runIntegrationSyncApi(connectorId: string): Promise<SyncRunResult | { error: string } | null> {
  const current = listIntegrations().find((i) => i.id === connectorId);
  if (!current || current.status === "Not configured") return null;
  try {
    const run = await apiRunConnector(connectorId);
    await intMirror.reload();
    const item = listIntegrations().find((i) => i.id === connectorId) ?? current;
    const failed = (intMirror.get()?.quarantine[connectorId] ?? []).filter((q) => q.run_id === run.id).map(toQuarantine);
    return { item, processed: run.processed, passed: run.succeeded, failed };
  } catch (e) {
    await intMirror.reload();
    return { error: errorText(e) };
  }
}

export function runIntegrationSync(connectorId: string, actor: Actor): SyncRunResult | null | Promise<SyncRunResult | { error: string } | null> {
  if (API_ENABLED) return runIntegrationSyncApi(connectorId);
  const current = listIntegrations().find((i) => i.id === connectorId);
  if (!current || current.status === "Not configured") return null;
  const state = readQuarantine();
  const run = (state.runs[connectorId] ?? 0) + 1;
  state.runs[connectorId] = run;
  const fields = CONNECTOR_FIELDS[connectorId] ?? ["costCentre"];
  const size = BATCH_SIZE[connectorId] ?? 12;
  const at = nowStamp();
  const failed: QuarantineRecord[] = [];
  for (let i = 0; i < size; i++) {
    const roll = hash(connectorId, run, i);
    // About one record in ten fails, so most runs quarantine a few rows (the first run always has one).
    if (roll % 100 >= 10 && !(run === 1 && i === 3)) continue;
    const field = fields[(roll >>> 8) % fields.length];
    const code = 1000 + ((run * 37 + i * 13) % 900);
    const name = `${FIRST[(run + i) % FIRST.length]} ${LAST[(run * 3 + i * 7) % LAST.length]}`;
    const value = badValue(field, roll >>> 12);
    failed.push({
      id: `q-${connectorId}-${run}-${i}`,
      connectorId,
      record: `EMP-${code} · ${name}`,
      field,
      value,
      reason: validateQuarantineValue(field, value) ?? "Rejected by provider",
      at,
      attempts: 0,
    });
  }
  state.items[connectorId] = [...failed, ...(state.items[connectorId] ?? [])];
  const passed = size - failed.length;
  const item = save(
    state,
    connectorId,
    (it) => {
      const totals = integrationTotals(it);
      it.runs = [
        { at: new Date().toISOString(), processed: size, succeeded: passed, failed: failed.length, by: actor.name },
        ...integrationRuns(it),
      ].slice(0, 10);
      it.successCount = totals.succeeded + passed;
      it.failedCount = totals.failed + failed.length;
      it.recordsProcessed += passed;
      it.lastSync = syncStamp();
    },
    failed.length
      ? { at, level: "warn", message: `Sync by ${actor.name}: ${passed} of ${size} records passed, ${failed.length} quarantined` }
      : { at, level: "info", message: `Sync by ${actor.name}: ${size} records passed` },
  )!;
  appendAudit({
    actor: actor.name,
    action: `Run integration sync · ${passed}/${size} passed${failed.length ? ` · ${failed.length} quarantined` : ""}`,
    target: item.name,
    outcome: failed.length ? "Failed" : "Success",
  });
  if (failed.length) {
    const reasons = [...new Set(failed.map((f) => f.reason))].join(", ");
    const body = `${failed.length} of ${size} records failed and are in quarantine: ${reasons}.`;
    const href = `/integrations?connector=${connectorId}`;
    const recipients = ["demo-admin", ...(HR_CONNECTORS.has(connectorId) ? ["demo-hr-admin"] : [])];
    for (const recipientId of recipients) pushPersonTaskAlert({ recipientId, title: `${item.name}: sync failures`, body, href });
  }
  return { item, processed: size, passed, failed };
}

export type RecordOutcome = { ok: boolean; error?: string; record?: QuarantineRecord };

function settle(connectorId: string, recordId: string, ok: boolean, actor: Actor, action: string): RecordOutcome {
  const state = readQuarantine();
  const list = state.items[connectorId] ?? [];
  const rec = list.find((r) => r.id === recordId);
  if (!rec) return { ok: false, error: GONE };
  const at = nowStamp();
  state.items[connectorId] = ok ? list.filter((r) => r.id !== recordId) : list.map((r) => (r.id === recordId ? { ...r, attempts: r.attempts + 1, at } : r));
  const item = save(
    state,
    connectorId,
    (it) => {
      if (ok) it.recordsProcessed += 1;
    },
    { at, level: ok ? "info" : "warn", message: `${action} by ${actor.name}: ${rec.record} ${ok ? "passed" : "failed again"}` },
  );
  appendAudit({ actor: actor.name, action: `${action} · ${rec.record}`, target: item?.name ?? connectorId, outcome: ok ? "Success" : "Failed" });
  return { ok, record: rec };
}

/** Same rule for single and bulk retries: the source may have been corrected since, so a retry can pass. */
const retryPasses = (r: QuarantineRecord) => hash(r.id, r.attempts + 1) % 100 < 40;

/** Re-sends a quarantined record as it is. */
export function retryQuarantined(connectorId: string, recordId: string, actor: Actor): RecordOutcome | Promise<RecordOutcome> {
  if (API_ENABLED) return apiOutcome(() => apiRetryQuarantine(connectorId, recordId));
  const rec = listQuarantine(connectorId).find((r) => r.id === recordId);
  if (!rec) return { ok: false, error: GONE };
  return settle(connectorId, recordId, retryPasses(rec), actor, "Retry quarantined record");
}

/** Corrects the failing field and re-sends. Passes when the new value is valid. */
export function fixAndRetryQuarantined(connectorId: string, recordId: string, value: string, actor: Actor): RecordOutcome | Promise<RecordOutcome> {
  const rec = listQuarantine(connectorId).find((r) => r.id === recordId);
  if (!rec) return { ok: false, error: GONE };
  const error = validateQuarantineValue(rec.field, value);
  if (error) return { ok: false, error };
  if (API_ENABLED) return apiOutcome(() => apiFixQuarantine(connectorId, recordId, value));
  return settle(connectorId, recordId, true, actor, `Fix and retry record (${QUARANTINE_FIELD_LABEL[rec.field].toLowerCase()})`);
}

/** Removes a record from quarantine without sending it. */
export function dismissQuarantined(connectorId: string, recordId: string, reason: string, actor: Actor): RecordOutcome | Promise<RecordOutcome> {
  const why = reason.trim();
  if (!why) return { ok: false, error: "Add a reason to dismiss." };
  if (API_ENABLED) return apiOutcome(() => apiDismissQuarantine(connectorId, recordId, why));
  const state = readQuarantine();
  const list = state.items[connectorId] ?? [];
  const rec = list.find((r) => r.id === recordId);
  if (!rec) return { ok: false, error: GONE };
  state.items[connectorId] = list.filter((r) => r.id !== recordId);
  const item = save(state, connectorId, () => {}, { at: nowStamp(), level: "info", message: `${rec.record} dismissed by ${actor.name}: ${why}` });
  appendAudit({ actor: actor.name, action: `Dismissed quarantined record · ${rec.record} · ${why}`, target: item?.name ?? connectorId, outcome: "Recorded" });
  return { ok: true, record: rec };
}

/** Retries every quarantined record for a connector. */
export function retryAllQuarantined(connectorId: string, actor: Actor): { passed: number; failed: number } | Promise<{ passed: number; failed: number }> {
  if (API_ENABLED) {
    return (async () => {
      let passed = 0;
      let failed = 0;
      for (const r of listQuarantine(connectorId)) {
        try {
          const out = (await apiRetryQuarantine(connectorId, r.id)) as { ok: boolean };
          if (out.ok) passed += 1;
          else failed += 1;
        } catch {
          failed += 1;
        }
      }
      await intMirror.reload();
      return { passed, failed };
    })();
  }
  const state = readQuarantine();
  const list = state.items[connectorId] ?? [];
  if (!list.length) return { passed: 0, failed: 0 };
  const at = nowStamp();
  const passedIds = new Set(list.filter(retryPasses).map((r) => r.id));
  state.items[connectorId] = list.filter((r) => !passedIds.has(r.id)).map((r) => ({ ...r, attempts: r.attempts + 1, at }));
  const failed = list.length - passedIds.size;
  const item = save(
    state,
    connectorId,
    (it) => {
      it.recordsProcessed += passedIds.size;
    },
    { at, level: failed ? "warn" : "info", message: `Retry all by ${actor.name}: ${passedIds.size} passed, ${failed} still quarantined` },
  );
  appendAudit({
    actor: actor.name,
    action: `Retry all quarantined · ${passedIds.size} passed · ${failed} failed`,
    target: item?.name ?? connectorId,
    outcome: failed ? "Failed" : "Success",
  });
  return { passed: passedIds.size, failed };
}

/** Runs every connector whose scheduled time has passed since its last run. Returns how many ran. */
export function runDueSyncs(now: Date = new Date()): number {
  if (API_ENABLED) return 0; // the server runs connectors on their schedule
  let ran = 0;
  for (const item of listIntegrations()) {
    if (item.status === "Not configured" || item.status === "Disconnected") continue;
    const minutes = scheduleMinutes(integrationSchedule(item));
    if (!minutes) continue;
    const runs = integrationRuns(item);
    const last = runs[0] ? new Date(runs[0].at) : parseSyncStamp(item.lastSync);
    if (last && !Number.isNaN(last.getTime()) && last.getTime() + minutes * 60_000 > now.getTime()) continue;
    if (runIntegrationSync(item.id, { id: "system", name: "Scheduler" })) ran += 1;
  }
  return ran;
}
