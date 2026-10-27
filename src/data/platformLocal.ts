import type { NavAccessId } from "../demoAccounts.ts";
import {
  AUDIT_LOG_SEED,
  ROLE_PERMISSION_CATALOG,
  INTEGRATION_SEED,
  NOTIFICATION_PREF_SEED,
  type AuditLogRow,
  type IntegrationCard,
  type NotificationPref,
} from "./platformData.ts";

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

export function listIntegrations(): IntegrationCard[] {
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

export function retryIntegration(id: string, actorName: string): RetryOutcome | null {
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
    item.lastSync = now.toISOString().slice(0, 16).replace("T", " ");
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
  return readJson(NOTIF_KEY, NOTIFICATION_PREF_SEED);
}

export function updateNotificationPref(id: string, patch: Partial<NotificationPref>, actorName: string) {
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
