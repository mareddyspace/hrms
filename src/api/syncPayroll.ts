/** Payroll tab (integration status only) from GET /payroll/status — backend mode only. */
import { api, apiRequest } from "./client.ts";

export interface PayrollEntityStatusOut {
  country_code: string;
  country_name: string | null;
  legal_entity: string;
  provider: string;
  connection_status: string;
  integration_status: string;
  last_sync_at: string | null;
  payroll_period: string;
  payroll_period_label: string;
  integration_health: string;
  configuration_status: string;
  employees: number;
  payroll_status_counts: Record<string, number>;
}

export interface PayrollStatusOut {
  period: string;
  period_label: string;
  connector_status: string;
  rows: PayrollEntityStatusOut[];
  totals: Record<string, number>;
}

export function apiPayrollStatus(): Promise<PayrollStatusOut> {
  return api.get<PayrollStatusOut>("/payroll/status");
}

export interface PayrollProvidersOut {
  providers: Record<string, string>;
  countries: string[];
}

export function apiPayrollProviders(): Promise<PayrollProvidersOut> {
  return api.get<PayrollProvidersOut>("/payroll/providers");
}

/** Admin only. A blank name clears the country ("Not set"). */
export function apiSavePayrollProviders(providers: Record<string, string>): Promise<PayrollProvidersOut> {
  return apiRequest<PayrollProvidersOut>("/payroll/providers", { method: "PUT", body: { providers } });
}
