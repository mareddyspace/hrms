/** Leadership insights from the API (backend mode): director dashboard, drill-down, contractors and contract
 * extensions, server-side report builder. See backend/app/routers/insights.py. */
import { api, apiRequest } from "./client.ts";

export type RangeKey = "30d" | "90d" | "ytd" | "12m";

export interface GroupRow {
  key: string;
  name?: string;
  headcount: number;
  joiners: number;
  exits: number;
  attrition_pct: number;
}

export interface LeadershipOut {
  as_of: string;
  range: RangeKey;
  from: string;
  scope: "organisation" | "team";
  headcount: number;
  joiners: number;
  exits: number;
  net_growth: number;
  attrition_pct: number;
  by_country: GroupRow[];
  by_department: GroupRow[];
  contractors: { active: number; ending_soon: number; expired: number };
  hiring: {
    open_requisitions: number;
    awaiting_approval: number;
    open_positions: number;
    active_candidates: number;
    by_stage: { stage: string; count: number }[];
    offers_awaiting_approval: number;
    offers_out: number;
    hires_in_range: number;
  };
  performance: {
    cycle: string;
    status: string;
    reviews: number;
    self_done: number;
    manager_done: number;
    released: number;
    distribution: { rating: string; count: number }[];
    distribution_cycle: string;
    includes_unreleased: boolean;
  } | null;
  learning: {
    assigned: number;
    completed: number;
    overdue: number;
    compliance_pct: number | null;
    courses: { course_id: string; title: string; assigned: number; completed: number; overdue: number }[];
  };
  cost: {
    annual_base: { currency: string; amount: number }[];
    by_department: { department: string; currency: string; amount: number }[];
    without_record: number;
  } | null;
  cost_visible: boolean;
  countries: string[];
  departments: string[];
}

export type DrillMetric = "headcount" | "joiners" | "exits" | "contractors" | "contracts_ending" | "learning_overdue";

export interface DrillRow {
  id: string;
  name: string;
  job_title: string;
  department: string;
  country: string;
  joining_date: string;
  employment_type: string;
  detail?: string;
}

export interface Filters {
  country?: string;
  department?: string;
  range: RangeKey;
}

export const getLeadership = (f: Filters) => api.get<LeadershipOut>("/insights/leadership", { ...f });
export const getDrill = (metric: DrillMetric, f: Filters) => api.get<DrillRow[]>("/insights/leadership/drill", { metric, ...f });

/* ───────── contractors ───────── */

export interface ExtensionOut {
  id: string;
  employee_id: string;
  employee_name: string;
  requested_by_name: string;
  current_end: string | null;
  new_end: string;
  reason: string;
  status: "pending" | "approved" | "rejected";
  decided_by_name: string | null;
  decision_comment: string | null;
  created_at: string;
  can_decide: boolean;
}

export interface ContractorOut {
  id: string;
  name: string;
  job_title: string;
  department: string;
  country_code: string;
  manager: string | null;
  contract_end_date: string | null;
  days_left: number | null;
  alert: "expired" | "ending_30" | "ending_60" | "no_end_date" | "ok";
  pending_extension: ExtensionOut | null;
}

export const getContractors = () => api.get<ContractorOut[]>("/insights/contractors");
export const getExtensions = (status?: string) => api.get<ExtensionOut[]>("/insights/contract-extensions", { status });
export const requestExtension = (employeeId: string, newEnd: string, reason: string) =>
  api.post<ExtensionOut>(`/insights/contractors/${encodeURIComponent(employeeId)}/extensions`, { new_end: newEnd, reason });
export const decideExtension = (id: string, decision: "approve" | "reject", comment: string) =>
  api.post<ExtensionOut>(`/insights/contract-extensions/${encodeURIComponent(id)}/decision`, { decision, comment });

/* ───────── report builder ───────── */

export interface ReportColumn {
  key: string;
  label: string;
  kind: "text" | "number" | "date" | "bool";
}

export interface ReportSource {
  key: string;
  label: string;
  columns: ReportColumn[];
}

export type FilterValue = string | { from?: string; to?: string };

export interface ReportDefinition {
  source: string;
  columns: string[];
  filters: Record<string, FilterValue>;
  group_by: string | null;
}

export interface ReportResult {
  columns: ReportColumn[];
  rows: Record<string, string | number | boolean | null>[];
  total: number;
  truncated: boolean;
  groups: { value: string; count: number; sums: Record<string, number> }[] | null;
}

export interface SavedReportOut extends ReportDefinition {
  id: string;
  name: string;
  shared: boolean;
  mine: boolean;
  updated_at: string;
}

export const getReportSources = () => api.get<ReportSource[]>("/insights/reports/sources");
export const runServerReport = (def: ReportDefinition, search?: string) =>
  api.post<ReportResult>("/insights/reports/run", { ...def, search: search || null });
export const exportServerReport = (def: ReportDefinition, search?: string) =>
  api.post<{ filename: string; content: string }>("/insights/reports/export", { ...def, search: search || null });
export const listSavedReports = () => api.get<SavedReportOut[]>("/insights/reports/saved");
export const saveServerReport = (def: ReportDefinition & { name: string; shared: boolean }, id?: string) =>
  id
    ? apiRequest<SavedReportOut>(`/insights/reports/saved/${encodeURIComponent(id)}`, { method: "PUT", body: def })
    : api.post<SavedReportOut>("/insights/reports/saved", def);
export const deleteSavedReport = (id: string) =>
  apiRequest<null>(`/insights/reports/saved/${encodeURIComponent(id)}`, { method: "DELETE" });
