import type { PersonRecord } from "../../data/peopleData.ts";
import type { PortalState } from "../../model.ts";
import { isCompensationColumn, isValidISODate } from "./shared.ts";

export type SourceId = "people" | "leave" | "timesheets" | "expenses";
export type ColumnDef = { id: string; label: string; numeric?: boolean };

export interface ReportRow {
  personId: string;
  country: string;
  department: string;
  status: string;
  date: string;
  cells: Record<string, string | number>;
}

export interface ReportFilters {
  country: string;
  department: string;
  status: string;
  from: string;
  to: string;
}

export interface ReportDefinition {
  source: SourceId;
  columns: string[];
  filters: ReportFilters;
  sortBy: string;
  sortDir: "asc" | "desc";
  groupBy: string;
}

const PERSON_COLUMNS: ColumnDef[] = [
  { id: "employeeCode", label: "Employee code" },
  { id: "fullName", label: "Name" },
  { id: "department", label: "Department" },
  { id: "countryName", label: "Country" },
];

export const SOURCES: Record<SourceId, { label: string; dateLabel: string; columns: ColumnDef[]; defaultColumns: string[] }> = {
  people: {
    label: "People",
    dateLabel: "Joining date",
    columns: [
      ...PERSON_COLUMNS,
      { id: "email", label: "Work email" },
      { id: "designation", label: "Designation" },
      { id: "location", label: "Location" },
      { id: "legalEntity", label: "Legal entity" },
      { id: "managerName", label: "Manager" },
      { id: "dateOfJoining", label: "Joining date" },
      { id: "employmentType", label: "Employment type" },
      { id: "employmentStatus", label: "Status" },
    ],
    defaultColumns: ["employeeCode", "fullName", "department", "countryName", "employmentStatus"],
  },
  leave: {
    label: "Leave requests",
    dateLabel: "Leave start",
    columns: [
      ...PERSON_COLUMNS,
      { id: "leaveType", label: "Leave type" },
      { id: "from", label: "From" },
      { id: "to", label: "To" },
      { id: "days", label: "Days", numeric: true },
      { id: "status", label: "Status" },
      { id: "appliedOn", label: "Applied on" },
    ],
    defaultColumns: ["fullName", "leaveType", "from", "to", "days", "status"],
  },
  timesheets: {
    label: "Timesheets",
    dateLabel: "Week start",
    columns: [
      ...PERSON_COLUMNS,
      { id: "weekStart", label: "Week start" },
      { id: "hours", label: "Hours", numeric: true },
      { id: "status", label: "Status" },
    ],
    defaultColumns: ["fullName", "weekStart", "hours", "status"],
  },
  expenses: {
    label: "Expenses",
    dateLabel: "Expense date",
    columns: [
      ...PERSON_COLUMNS,
      { id: "date", label: "Date" },
      { id: "category", label: "Category" },
      { id: "amount", label: "Amount", numeric: true },
      { id: "description", label: "Description" },
      { id: "status", label: "Status" },
    ],
    defaultColumns: ["fullName", "date", "category", "amount", "status"],
  },
};

export const SOURCE_IDS = Object.keys(SOURCES) as SourceId[];

export function columnLabel(source: SourceId, id: string): string {
  return SOURCES[source].columns.find((c) => c.id === id)?.label ?? id;
}

export function emptyFilters(): ReportFilters {
  return { country: "", department: "", status: "", from: "", to: "" };
}

export function defaultDefinition(source: SourceId = "people"): ReportDefinition {
  return { source, columns: [...SOURCES[source].defaultColumns], filters: emptyFilters(), sortBy: "", sortDir: "asc", groupBy: "" };
}

/** Rule check shared by the builder and the store. */
export function validateDefinition(def: ReportDefinition): string | null {
  const source = SOURCES[def.source];
  if (!source) return "Choose a data source.";
  const known = new Set(source.columns.map((c) => c.id));
  if (!def.columns.length) return "Pick at least one column.";
  if (def.columns.some((c) => !known.has(c) || isCompensationColumn(c))) return "One of the selected columns is not available for this source.";
  if (def.sortBy && !known.has(def.sortBy)) return "Sort column is not available for this source.";
  if (def.groupBy && !known.has(def.groupBy)) return "Group-by column is not available for this source.";
  if (def.groupBy && SOURCES[def.source].columns.find((c) => c.id === def.groupBy)?.numeric) return "Group by a text column, not a number.";
  if (def.filters.from && !isValidISODate(def.filters.from)) return "From date must be YYYY-MM-DD.";
  if (def.filters.to && !isValidISODate(def.filters.to)) return "To date must be YYYY-MM-DD.";
  if (def.filters.from && def.filters.to && def.filters.from > def.filters.to) return "From date must be on or before the to date.";
  return null;
}

/** Drop anything unknown or compensation-related from a definition read back from storage. */
export function sanitizeDefinition(value: unknown): ReportDefinition | null {
  const raw = value as Partial<ReportDefinition> | null;
  if (!raw || typeof raw !== "object" || !raw.source || !(raw.source in SOURCES)) return null;
  const source = raw.source as SourceId;
  const known = new Set(SOURCES[source].columns.map((c) => c.id));
  const f = (raw.filters ?? {}) as Partial<ReportFilters>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const columns = Array.isArray(raw.columns) ? raw.columns.filter((c): c is string => typeof c === "string" && known.has(c) && !isCompensationColumn(c)) : [];
  return {
    source,
    columns: columns.length ? [...new Set(columns)] : [...SOURCES[source].defaultColumns],
    filters: { country: str(f.country), department: str(f.department), status: str(f.status), from: str(f.from), to: str(f.to) },
    sortBy: known.has(str(raw.sortBy)) ? str(raw.sortBy) : "",
    sortDir: raw.sortDir === "desc" ? "desc" : "asc",
    groupBy: known.has(str(raw.groupBy)) ? str(raw.groupBy) : "",
  };
}

function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return 0;
  return Math.round((b - a) / 86400000) + 1;
}

function personCells(person: PersonRecord | undefined, fallbackName: string) {
  return {
    employeeCode: person?.employeeCode ?? "",
    fullName: person?.fullName ?? fallbackName,
    department: person?.department ?? "",
    countryName: person?.countryName ?? "",
  };
}

const TIMESHEET_RANK: Record<string, number> = { missing: 0, draft: 1, submitted: 2, approved: 3 };

/** Flatten one data source into report rows. Only whitelisted, non-compensation fields are copied. */
export function buildRows(source: SourceId, state: PortalState, people: readonly PersonRecord[]): ReportRow[] {
  const byId = new Map(people.map((p) => [p.id, p]));
  const base = (person: PersonRecord | undefined, personId: string, status: string, date: string, cells: Record<string, string | number>): ReportRow => ({
    personId,
    country: person?.countryName ?? "",
    department: person?.department ?? "",
    status,
    date,
    cells,
  });

  if (source === "people") {
    return people.map((p) =>
      base(p, p.id, p.employmentStatus, p.dateOfJoining, {
        ...personCells(p, p.fullName),
        email: p.email,
        designation: p.designation,
        location: p.location,
        legalEntity: p.legalEntity,
        managerName: p.managerName,
        dateOfJoining: p.dateOfJoining,
        employmentType: p.employmentType,
        employmentStatus: p.employmentStatus,
      }),
    );
  }

  if (source === "leave") {
    const names = new Map((state.leavePolicies ?? []).map((p) => [p.code, p.name]));
    return (state.leaveRequests ?? []).map((r) => {
      const person = byId.get(r.employeeId);
      return base(person, r.employeeId, r.status, r.from, {
        ...personCells(person, r.employeeId),
        leaveType: names.get(r.code) ?? r.code,
        from: r.from,
        to: r.to,
        days: daysBetween(r.from, r.to),
        status: r.status,
        appliedOn: r.appliedOn,
      });
    });
  }

  if (source === "timesheets") {
    const weeks = new Map<string, { personId: string; weekStart: string; hours: number; status: string; name: string }>();
    for (const sheet of state.timesheets ?? []) {
      const key = `${sheet.employeeId}|${sheet.weekStart}`;
      const hours = Object.values(sheet.hours ?? {}).reduce((sum, h) => sum + (Number(h) || 0), 0);
      const prev = weeks.get(key);
      if (prev) {
        prev.hours += hours;
        if ((TIMESHEET_RANK[sheet.status] ?? 0) < (TIMESHEET_RANK[prev.status] ?? 0)) prev.status = sheet.status;
      } else weeks.set(key, { personId: sheet.employeeId, weekStart: sheet.weekStart, hours, status: sheet.status, name: sheet.employeeId });
    }
    for (const row of state.orgTimesheets ?? []) {
      const key = `${row.personId}|${row.weekStart}`;
      if (!weeks.has(key)) weeks.set(key, { personId: row.personId, weekStart: row.weekStart, hours: row.hours, status: row.status, name: row.name });
    }
    return [...weeks.values()].map((w) => {
      const person = byId.get(w.personId);
      return base(person, w.personId, w.status, w.weekStart, {
        ...personCells(person, w.name),
        weekStart: w.weekStart,
        hours: Math.round(w.hours * 100) / 100,
        status: w.status,
      });
    });
  }

  return (state.expenses ?? []).map((e) => {
    const person = byId.get(e.employeeId);
    return base(person, e.employeeId, e.status, e.date, {
      ...personCells(person, e.employeeId),
      date: e.date,
      category: e.category,
      amount: Number(e.amount) || 0,
      description: e.description,
      status: e.status,
    });
  });
}

export interface ReportResult {
  rows: ReportRow[];
  groups: { key: string; count: number; totals: Record<string, number> }[];
}

/** Apply scope, filters, sort and grouping. `scope` null = everyone. */
export function runReport(def: ReportDefinition, all: ReportRow[], scope: Set<string> | null): ReportResult {
  const f = def.filters;
  const rows = all.filter(
    (r) =>
      (!scope || scope.has(r.personId)) &&
      (!f.country || r.country === f.country) &&
      (!f.department || r.department === f.department) &&
      (!f.status || r.status === f.status) &&
      (!f.from || (r.date && r.date >= f.from)) &&
      (!f.to || (r.date && r.date <= f.to)),
  );
  if (def.sortBy) {
    const dir = def.sortDir === "desc" ? -1 : 1;
    rows.sort((a, b) => {
      const x = a.cells[def.sortBy];
      const y = b.cells[def.sortBy];
      if (typeof x === "number" && typeof y === "number") return (x - y) * dir;
      return String(x ?? "").localeCompare(String(y ?? ""), undefined, { numeric: true }) * dir;
    });
  }
  const groups: ReportResult["groups"] = [];
  if (def.groupBy) {
    const numeric = SOURCES[def.source].columns.filter((c) => c.numeric).map((c) => c.id);
    const map = new Map<string, ReportResult["groups"][number]>();
    for (const row of rows) {
      const key = String(row.cells[def.groupBy] ?? "") || "(blank)";
      let group = map.get(key);
      if (!group) {
        group = { key, count: 0, totals: Object.fromEntries(numeric.map((n) => [n, 0])) };
        map.set(key, group);
      }
      group.count += 1;
      for (const n of numeric) group.totals[n] += Number(row.cells[n]) || 0;
    }
    groups.push(...[...map.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)));
    for (const g of groups) for (const n of Object.keys(g.totals)) g.totals[n] = Math.round(g.totals[n] * 100) / 100;
  }
  return { rows, groups };
}

/** Sheet data for export: the detail rows, plus a summary sheet when grouped. */
export function exportSheets(def: ReportDefinition, result: ReportResult): { name: string; rows: unknown[][] }[] {
  const columns = def.columns.filter((c) => !isCompensationColumn(c));
  const detail: unknown[][] = [columns.map((c) => columnLabel(def.source, c)), ...result.rows.map((r) => columns.map((c) => r.cells[c] ?? ""))];
  const sheets = [{ name: "Report", rows: detail }];
  if (def.groupBy) {
    const numeric = SOURCES[def.source].columns.filter((c) => c.numeric).map((c) => c.id);
    sheets.push({
      name: "Summary",
      rows: [
        [columnLabel(def.source, def.groupBy), "Count", ...numeric.map((n) => `Total ${columnLabel(def.source, n).toLowerCase()}`)],
        ...result.groups.map((g) => [g.key, g.count, ...numeric.map((n) => g.totals[n])]),
      ],
    });
  }
  return sheets;
}
