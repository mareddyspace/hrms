/**
 * Leave admin and country config from the backend (VITE_API_URL mode only): leave types, leave policies per
 * country with eligibility rules, holidays per country / holiday calendar, the carry-forward job, and country
 * config. See backend/app/routers/leave_admin.py.
 */
import { api, apiRequest } from "./client.ts";

const enc = encodeURIComponent;
const apiPut = <T>(path: string, body: unknown) => apiRequest<T>(path, { method: "PUT", body });
const apiDelete = <T>(path: string) => apiRequest<T>(path, { method: "DELETE" });

export type GenderRule = "any" | "female" | "male";

export interface LeaveTypeAdmin {
  code: string;
  name: string;
  half_day_allowed: boolean;
  active: boolean;
}

export interface LeavePolicyAdmin {
  id: string;
  leave_code: string;
  country_code: string;
  name: string;
  quota: number;
  carry_forward_max: number;
  accrual: "annual" | "monthly";
  effective_from: string;
  effective_to: string | null;
  gender: GenderRule | null;
  min_service_months: number | null;
  employment_types: string[] | null;
  not_in_probation: boolean;
  max_per_request: number | null;
  min_notice_days: number | null;
  active: boolean;
}

export type LeavePolicyEdit = Partial<Omit<LeavePolicyAdmin, "id" | "leave_code" | "country_code">>;
export type LeavePolicyNew = Omit<LeavePolicyAdmin, "id" | "active">;

export interface HolidayAdmin {
  id: string;
  country_code: string;
  date: string;
  name: string;
  calendar: string | null;
  active: boolean;
}

export interface HolidayCalendar {
  country_code: string;
  calendar: string;
  employees: number;
}

export interface CountryConfig {
  code: string;
  name: string;
  currency: string;
  time_zone: string;
  languages: string[] | null;
  work_week_days: string[] | null;
  standard_daily_hours: number | null;
  probation_months: number | null;
  notice_days: number | null;
  required_documents: string[] | null;
  workflow_notes: string | null;
}

export type CountryConfigEdit = Partial<Omit<CountryConfig, "code" | "name" | "currency" | "time_zone">>;

const L = "/admin/leave";

export const leaveAdminApi = {
  types: () => api.get<LeaveTypeAdmin[]>(`${L}/types`),
  createType: (body: { code: string; name: string; half_day_allowed: boolean }) => api.post<LeaveTypeAdmin>(`${L}/types`, body),
  updateType: (code: string, body: Partial<Omit<LeaveTypeAdmin, "code">>) => apiPut<LeaveTypeAdmin>(`${L}/types/${enc(code)}`, body),
  policies: (country?: string) => api.get<LeavePolicyAdmin[]>(`${L}/policies`, country ? { country } : undefined),
  createPolicy: (body: LeavePolicyNew) => api.post<LeavePolicyAdmin>(`${L}/policies`, body),
  updatePolicy: (id: string, body: LeavePolicyEdit) => apiPut<LeavePolicyAdmin>(`${L}/policies/${enc(id)}`, body),
  deactivatePolicy: (id: string) => apiDelete<LeavePolicyAdmin>(`${L}/policies/${enc(id)}`),
  holidays: (country: string, year: number) => api.get<HolidayAdmin[]>(`${L}/holidays`, { country, year }),
  calendars: (country: string) => api.get<HolidayCalendar[]>(`${L}/calendars`, { country }),
  createHoliday: (body: { country_code: string; date: string; name: string; calendar: string | null }) =>
    api.post<HolidayAdmin>(`${L}/holidays`, body),
  updateHoliday: (id: string, body: Partial<Omit<HolidayAdmin, "id" | "country_code">>) =>
    apiPut<HolidayAdmin>(`${L}/holidays/${enc(id)}`, body),
  deactivateHoliday: (id: string) => apiDelete<HolidayAdmin>(`${L}/holidays/${enc(id)}`),
  runCarryForward: (year?: number) =>
    apiRequest<{ year: number; created: number; skipped: number }>(`${L}/carry-forward/run`, {
      method: "POST",
      body: {},
      query: year ? { year } : undefined,
    }),
};

export const countryConfigApi = {
  list: () => api.get<CountryConfig[]>("/countries"),
  update: (code: string, body: CountryConfigEdit) => apiPut<CountryConfig>(`/countries/${enc(code)}`, body),
};
