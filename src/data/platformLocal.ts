import {
  AUDIT_LOG_SEED,
  INTEGRATION_SEED,
  NOTIFICATION_PREF_SEED,
  type AuditLogRow,
  type IntegrationCard,
  type NotificationPref,
} from "./platformData.ts";

const INT_KEY = "timez.platform.integrations.v1";
const AUDIT_KEY = "timez.platform.audit.v1";
const NOTIF_KEY = "timez.platform.notifications.v1";
const ROLE_KEY = "timez.platform.roleEdits.v1";

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

export function retryIntegration(id: string): IntegrationCard | null {
  const list = listIntegrations().map((item) => ({ ...item, logs: [...item.logs] }));
  const idx = list.findIndex((i) => i.id === id);
  if (idx < 0) return null;
  const now = new Date();
  const stamp = now.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  const item = list[idx];
  item.lastSync = `${now.toISOString().slice(0, 16).replace("T", " ")} (local demo)`;
  item.status = item.status === "Not configured" ? "Not configured" : "Connected";
  item.errorCount = Math.max(0, item.errorCount - 1);
  item.recordsProcessed += item.status === "Not configured" ? 0 : 25;
  item.logs = (
    [
      { at: stamp, level: "info" as const, message: "Manual retry requested" },
      ...item.logs,
    ] as IntegrationCard["logs"]
  ).slice(0, 8);
  list[idx] = item;
  writeJson(INT_KEY, list);
  appendAudit({
    actor: "current-demo-user",
    action: "Retry integration sync",
    target: item.name,
    outcome: "Simulated",
  });
  return item;
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

export function updateNotificationPref(id: string, patch: Partial<NotificationPref>) {
  const list = listNotificationPrefs().map((p) => (p.id === id ? { ...p, ...patch, id: p.id } : p));
  writeJson(NOTIF_KEY, list);
  appendAudit({
    actor: "current-demo-user",
    action: "Updated notification preference",
    target: id,
    outcome: "Simulated",
  });
}

/** Demo role permission overlays — does not mutate DEMO_ACCOUNTS identity. */
export type RoleEditMap = Record<string, string[]>;

export function getRoleEdits(): RoleEditMap {
  return readJson(ROLE_KEY, {});
}

/** Only platform admins may change role permissions — and never on their own account. */
export function canEditRolePermissions(actorRole: string): boolean {
  return actorRole === "admin" || actorRole === "super_admin";
}

/** Returns an error message, or null when saved. */
export function saveRoleEdit(
  accountId: string,
  permissions: string[],
  actor: { id: string; email: string; role: string },
): string | null {
  if (!canEditRolePermissions(actor.role)) return "Only Admin or Super Admin can edit role permissions.";
  if (accountId === actor.id) return "You cannot change permissions on your own account.";
  const map = { ...getRoleEdits(), [accountId]: permissions };
  writeJson(ROLE_KEY, map);
  appendAudit({
    actor: actor.email,
    action: "Edited demo role permissions (authorized review simulated)",
    target: accountId,
    outcome: "Simulated",
  });
  return null;
}

export function effectiveNavIds(accountId: string, baseline: readonly string[]): string[] {
  const edits = getRoleEdits()[accountId];
  return edits ?? [...baseline];
}
