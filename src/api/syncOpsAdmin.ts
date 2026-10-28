/**
 * Admin settings from the backend (VITE_API_URL mode only): data scope and page access per account,
 * AI settings, integrations (runs, quarantine), email switches, the email outbox and the job runner.
 * See backend/app/routers/platform_admin.py.
 */
import { api, apiRequest, apiSessionMe, isApiAdmin, isApiHr } from "./client.ts";

const apiPut = <T>(path: string, body: unknown) => apiRequest<T>(path, { method: "PUT", body });
const apiDelete = <T>(path: string) => apiRequest<T>(path, { method: "DELETE" });

const enc = encodeURIComponent;

/* ───────── Accounts: data scope and page access ───────── */

export interface DataScopeOut {
  account_id: string;
  scope: string;
  countries: string[];
  custom: boolean;
}

export interface PageAccessOut {
  account_id: string;
  grant: string[];
  revoke: string[];
  custom: boolean;
}

export interface AdminAccountOut {
  account_id: string;
  email: string;
  role: string;
  employee_id: string | null;
  full_name: string;
  data_scope: DataScopeOut;
  page_access: PageAccessOut;
}

export interface ApiAccessData {
  me: string;
  /** Admin only: every account. Others get an empty list. */
  accounts: AdminAccountOut[];
  /** The signed-in account's own page edits. */
  mine: PageAccessOut;
}

export async function loadApiAccess(accountId: string): Promise<ApiAccessData> {
  const me = await apiSessionMe();
  const isAdmin = isApiAdmin(me.role);
  const [mine, accounts] = await Promise.all([
    api.get<PageAccessOut>("/admin/page-access/me"),
    isAdmin ? api.get<AdminAccountOut[]>("/admin/accounts").catch(() => [] as AdminAccountOut[]) : Promise.resolve([] as AdminAccountOut[]),
  ]);
  return { me: me.account_id ?? accountId, accounts, mine };
}

export const apiPutDataScope = (accountId: string, scope: string, countries: string[]) =>
  apiPut<DataScopeOut>(`/admin/accounts/${enc(accountId)}/data-scope`, { scope, countries });
export const apiPutPageAccess = (accountId: string, grant: string[], revoke: string[]) =>
  apiPut<PageAccessOut>(`/admin/accounts/${enc(accountId)}/page-access`, { grant, revoke });
export const apiResetPageAccess = (accountId: string) => apiDelete<PageAccessOut>(`/admin/accounts/${enc(accountId)}/page-access`);

/* ───────── AI settings ───────── */

export interface AiSettingsOut {
  disabled_policies: string[];
  disabled_agents: string[];
  disabled_features: string[];
  features: string[];
}

export const loadApiAiSettings = () => api.get<AiSettingsOut>("/admin/ai-settings");
export const apiPutAiSettings = (body: Partial<Pick<AiSettingsOut, "disabled_policies" | "disabled_agents" | "disabled_features">>) =>
  apiPut<AiSettingsOut>("/admin/ai-settings", body);

/* ───────── Integrations ───────── */

export interface ConnectorOut {
  id: string;
  name: string;
  category: string;
  status: string;
  schedule: string;
  last_sync_at: string | null;
  run_count: number;
  records_processed: number;
  success_count: number;
  failed_count: number;
  open_quarantine: number;
  next_run_at: string | null;
}

export interface IntegrationRunOut {
  id: number;
  connector_id: string;
  started_at: string;
  trigger: string;
  processed: number;
  succeeded: number;
  failed: number;
  run_by: string | null;
}

export interface QuarantineOut {
  id: string;
  connector_id: string;
  run_id: number | null;
  record: string;
  field: string;
  value: string;
  reason: string;
  attempts: number;
  status: string;
  resolved_by: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  created_at: string;
}

export interface ApiIntegrationData {
  connectors: ConnectorOut[];
  runs: Record<string, IntegrationRunOut[]>;
  quarantine: Record<string, QuarantineOut[]>;
}

export async function loadApiIntegrations(): Promise<ApiIntegrationData> {
  // Admin and HR only (read); others get nothing instead of a 403.
  const me = await apiSessionMe();
  if (!isApiAdmin(me.role) && !isApiHr(me.role)) return { connectors: [], runs: {}, quarantine: {} };
  const connectors = await api.get<ConnectorOut[]>("/admin/integrations");
  const runs: Record<string, IntegrationRunOut[]> = {};
  const quarantine: Record<string, QuarantineOut[]> = {};
  await Promise.all(
    connectors.map(async (c) => {
      const [r, q] = await Promise.all([
        api.get<IntegrationRunOut[]>(`/admin/integrations/${enc(c.id)}/runs`, { limit: 20 }).catch(() => [] as IntegrationRunOut[]),
        api.get<QuarantineOut[]>(`/admin/integrations/${enc(c.id)}/quarantine`, { status: "open" }).catch(() => [] as QuarantineOut[]),
      ]);
      runs[c.id] = r;
      quarantine[c.id] = q;
    }),
  );
  return { connectors, runs, quarantine };
}

export const apiSetSchedule = (id: string, schedule: string) => apiPut<ConnectorOut>(`/admin/integrations/${enc(id)}/schedule`, { schedule });
export const apiRunConnector = (id: string) => api.post<IntegrationRunOut>(`/admin/integrations/${enc(id)}/run`);
export const apiRetryQuarantine = (connectorId: string, recordId: string) =>
  api.post(`/admin/integrations/${enc(connectorId)}/quarantine/${enc(recordId)}/retry`);
export const apiFixQuarantine = (connectorId: string, recordId: string, value: string) =>
  api.post(`/admin/integrations/${enc(connectorId)}/quarantine/${enc(recordId)}/fix`, { value: value.trim() });
export const apiDismissQuarantine = (connectorId: string, recordId: string, reason: string) =>
  api.post(`/admin/integrations/${enc(connectorId)}/quarantine/${enc(recordId)}/dismiss`, { reason: reason.trim() });

/** Runs the scheduled jobs once (retention, SLA escalations, reminders). Never includes connector syncs. */
export const apiRunJobs = () => api.post<{ results: Record<string, unknown> }>("/admin/jobs/run");

/* ───────── Email switches and outbox ───────── */

export interface EmailSwitchOut {
  channel: string;
  label: string;
  description: string;
  email: boolean;
}

export interface EmailOutboxOut {
  id: number;
  notification_id: number | null;
  recipient_id: string;
  to_email: string;
  subject: string;
  body: string;
  link: string | null;
  category: string;
  channel: string;
  status: string;
  created_at: string;
  sent_at: string | null;
}

export interface ApiEmailData {
  switches: EmailSwitchOut[];
  outbox: EmailOutboxOut[];
}

export async function loadApiEmail(): Promise<ApiEmailData> {
  if (!isApiAdmin((await apiSessionMe()).role)) return { switches: [], outbox: [] }; // admin only
  const [switches, outbox] = await Promise.all([
    api.get<EmailSwitchOut[]>("/admin/email-switches"),
    api.get<EmailOutboxOut[]>("/admin/email-outbox", { limit: 500 }),
  ]);
  return { switches, outbox };
}

export const apiSetEmailSwitch = (channel: string, email: boolean) =>
  apiPut<EmailSwitchOut>(`/admin/email-switches/${enc(channel)}`, { email });
export const apiMarkEmailsSent = (ids: number[] | "all") =>
  api.post<{ marked: number }>("/admin/email-outbox/mark-sent", ids === "all" ? { all_queued: true } : { ids });
