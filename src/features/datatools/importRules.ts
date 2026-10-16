import * as XLSX from "xlsx";
import { FILTER_OPTIONS, type EmploymentStatus, type PersonRecord } from "../../data/peopleData.ts";
import type { LocalPersonRecord } from "../../data/peopleLocal.ts";
import { TIMEZ_COUNTRIES } from "../../model.ts";
import { cleanText, isValidEmail, isValidISODate, looksLikeFormula } from "./shared.ts";

export const IMPORT_COLUMNS = [
  "employeeCode",
  "fullName",
  "email",
  "department",
  "designation",
  "countryName",
  "location",
  "managerEmployeeCode",
  "dateOfJoining",
  "employmentType",
  "employmentStatus",
] as const;
export type ImportColumn = (typeof IMPORT_COLUMNS)[number];
export type ImportValues = Record<ImportColumn, string>;

export const EMPLOYMENT_TYPES = ["Full Time", "Part Time", "Contract", "Intern"] as const;
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 1000;

export type RawImportRow = { rowNumber: number; values: ImportValues };
export type ImportAction = "create" | "update" | "unchanged" | "error";

export interface ValidatedRow {
  rowNumber: number;
  values: ImportValues;
  action: ImportAction;
  errors: string[];
  warnings: string[];
  /** Directory id the row writes to (existing id for updates, a new id for creates). */
  targetId: string;
  existingId?: string;
}

export type ParsedImport = { ok: true; rows: RawImportRow[]; ignoredColumns: string[] } | { ok: false; error: string };

function canonical(options: readonly string[], value: string): string | undefined {
  const key = value.trim().toLowerCase();
  return options.find((option) => option.toLowerCase() === key);
}

/** Excel stores dates as day serials counted from 1899-12-30. */
function serialToISO(serial: number): string {
  const ms = Date.UTC(1899, 11, 30) + Math.round(serial) * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

function cellToText(column: string, cell: unknown): string {
  if (typeof cell === "number") {
    if (column === "dateOfJoining" && cell > 1 && cell < 100000) return serialToISO(cell);
    return String(cell);
  }
  if (cell instanceof Date) return Number.isNaN(cell.getTime()) ? "" : cell.toISOString().slice(0, 10);
  return cleanText(cell).slice(0, 200);
}

/** Read an uploaded CSV/XLSX into raw rows. Never evaluates formulas; every cell is treated as text. */
export async function parseImportFile(file: File): Promise<ParsedImport> {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (extension !== "csv" && extension !== "xlsx") return { ok: false, error: "Upload a .csv or .xlsx file." };
  if (file.size === 0) return { ok: false, error: "That file is empty." };
  if (file.size > MAX_IMPORT_BYTES) return { ok: false, error: "That file is larger than 2 MB. Split it into smaller files." };

  let grid: unknown[][];
  try {
    const book =
      extension === "csv"
        ? XLSX.read(await file.text(), { type: "string", raw: true, cellFormula: false, cellHTML: false })
        : XLSX.read(await file.arrayBuffer(), { type: "array", cellFormula: false, cellHTML: false, cellDates: false });
    const sheetName = book.SheetNames.find((name) => name.toLowerCase() === "employees") ?? book.SheetNames[0];
    if (!sheetName) return { ok: false, error: "That workbook has no sheets." };
    grid = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[sheetName], { header: 1, raw: true, defval: "" });
  } catch {
    return { ok: false, error: "That file could not be read. Check it is a valid CSV or Excel workbook." };
  }

  const nonEmpty = grid.filter((row) => Array.isArray(row) && row.some((cell) => cleanText(cell) !== ""));
  if (nonEmpty.length === 0) return { ok: false, error: "That file has no rows." };
  const header = (nonEmpty[0] as unknown[]).map((cell) => cleanText(cell).replace(/^﻿/, ""));
  const index = new Map<ImportColumn, number>();
  const ignored: string[] = [];
  for (let i = 0; i < header.length; i += 1) {
    const name = header[i];
    if (!name) continue;
    const column = IMPORT_COLUMNS.find((c) => c.toLowerCase() === name.toLowerCase());
    if (!column) {
      ignored.push(name.slice(0, 40));
      continue;
    }
    if (index.has(column)) return { ok: false, error: `The column "${column}" appears more than once.` };
    index.set(column, i);
  }
  const missing = IMPORT_COLUMNS.filter((c) => !index.has(c));
  if (missing.length) return { ok: false, error: `Missing required columns: ${missing.join(", ")}. Download the template to see the layout.` };

  const dataRows = grid.slice(grid.indexOf(nonEmpty[0]) + 1);
  const rows: RawImportRow[] = [];
  dataRows.forEach((row, offset) => {
    if (!Array.isArray(row) || !row.some((cell) => cleanText(cell) !== "")) return;
    const values = {} as ImportValues;
    for (const column of IMPORT_COLUMNS) values[column] = cellToText(column, row[index.get(column)!]);
    // Header is spreadsheet row 1 at minimum; report the row number the user sees.
    rows.push({ rowNumber: grid.indexOf(nonEmpty[0]) + offset + 2, values });
  });
  if (rows.length === 0) return { ok: false, error: "That file has a header but no employee rows." };
  if (rows.length > MAX_IMPORT_ROWS) return { ok: false, error: `That file has ${rows.length} rows. The limit is ${MAX_IMPORT_ROWS} per import.` };
  return { ok: true, rows, ignoredColumns: ignored };
}

const NAME_PATTERN = /^[\p{L}][\p{L}\p{M} .'-]*$/u;
const PLACE_PATTERN = /^[\p{L}][\p{L}\p{M}0-9 .,'()-]*$/u;
const CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{1,19}$/;

function checkText(label: string, value: string, min: number, max: number, errors: string[]) {
  if (!value) errors.push(`${label} is required.`);
  else if (looksLikeFormula(value)) errors.push(`${label} cannot start with =, +, - or @.`);
  else if (value.length < min || value.length > max) errors.push(`${label} must be ${min}–${max} characters.`);
}

function newIdFor(code: string, taken: Set<string>): string {
  const base = `emp-imp-${code.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  let id = base;
  let n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  taken.add(id);
  return id;
}

/**
 * Validate every row against the field rules, the rest of the file and the current directory.
 * Existing employeeCode = update, new code = create.
 */
export function validateImport(rows: RawImportRow[], people: readonly PersonRecord[], today: string): ValidatedRow[] {
  const byCode = new Map(people.map((p) => [p.employeeCode.trim().toUpperCase(), p]));
  const byEmail = new Map(people.map((p) => [p.email.trim().toLowerCase(), p]));
  const takenIds = new Set(people.map((p) => p.id));

  const result: ValidatedRow[] = rows.map((raw) => {
    const errors: string[] = [];
    const warnings: string[] = [];
    const v = { ...raw.values };

    v.employeeCode = v.employeeCode.toUpperCase();
    if (!v.employeeCode) errors.push("employeeCode is required.");
    else if (!CODE_PATTERN.test(v.employeeCode)) errors.push("employeeCode must be 2–20 letters, digits or hyphens.");

    checkText("fullName", v.fullName, 2, 80, errors);
    if (v.fullName && !looksLikeFormula(v.fullName) && !NAME_PATTERN.test(v.fullName)) errors.push("fullName can only contain letters, spaces, . ' and -.");

    v.email = v.email.toLowerCase();
    if (!v.email) errors.push("email is required.");
    else if (!isValidEmail(v.email)) errors.push("email is not a valid address.");

    if (!v.department) errors.push("department is required.");
    else {
      const dept = canonical(FILTER_OPTIONS.departments, v.department);
      if (dept) v.department = dept;
      else errors.push(`department "${v.department}" is not an allowed department.`);
    }

    checkText("designation", v.designation, 2, 80, errors);

    if (!v.countryName) errors.push("countryName is required.");
    else {
      const country = canonical(FILTER_OPTIONS.countries, v.countryName);
      if (country) v.countryName = country;
      else errors.push(`countryName "${v.countryName}" is not an allowed country.`);
    }

    checkText("location", v.location, 2, 60, errors);
    if (v.location && !looksLikeFormula(v.location) && !PLACE_PATTERN.test(v.location)) errors.push("location contains characters that are not allowed.");

    v.managerEmployeeCode = v.managerEmployeeCode.toUpperCase();
    if (!v.managerEmployeeCode) errors.push("managerEmployeeCode is required.");
    else if (v.employeeCode && v.managerEmployeeCode === v.employeeCode) errors.push("An employee cannot be their own manager.");

    if (!v.dateOfJoining) errors.push("dateOfJoining is required.");
    else if (!isValidISODate(v.dateOfJoining)) errors.push("dateOfJoining must be a real date in YYYY-MM-DD format.");
    else if (v.dateOfJoining > today) errors.push("dateOfJoining cannot be in the future.");

    if (!v.employmentType) errors.push("employmentType is required.");
    else {
      const type = canonical(EMPLOYMENT_TYPES, v.employmentType);
      if (type) v.employmentType = type;
      else errors.push(`employmentType must be one of: ${EMPLOYMENT_TYPES.join(", ")}.`);
    }

    if (!v.employmentStatus) errors.push("employmentStatus is required.");
    else {
      const status = canonical(FILTER_OPTIONS.employmentStatuses, v.employmentStatus);
      if (status) v.employmentStatus = status;
      else errors.push(`employmentStatus must be one of: ${FILTER_OPTIONS.employmentStatuses.join(", ")}.`);
    }

    const existing = v.employeeCode ? byCode.get(v.employeeCode) : undefined;
    if (existing) v.employeeCode = existing.employeeCode;
    if (v.employmentStatus === "Terminated" && existing?.employmentStatus !== "Terminated") {
      errors.push("Terminating needs an exit date and reason. Use mass update instead.");
    }
    if (existing?.employmentStatus === "Terminated" && v.employmentStatus && v.employmentStatus !== "Terminated") {
      warnings.push("Reactivates a terminated employee.");
    }
    if (v.email && isValidEmail(v.email)) {
      const owner = byEmail.get(v.email);
      if (owner && owner.id !== existing?.id) errors.push(`email is already used by ${owner.fullName} (${owner.employeeCode}).`);
    }

    return {
      rowNumber: raw.rowNumber,
      values: v,
      action: existing ? "update" : "create",
      errors,
      warnings,
      targetId: existing ? existing.id : "",
      existingId: existing?.id,
    };
  });

  // Duplicates inside the file: flag every occurrence, since it is unclear which one is meant.
  const codeCount = new Map<string, number>();
  const emailCount = new Map<string, number>();
  for (const row of result) {
    if (row.values.employeeCode) codeCount.set(row.values.employeeCode.toUpperCase(), (codeCount.get(row.values.employeeCode.toUpperCase()) ?? 0) + 1);
    if (row.values.email) emailCount.set(row.values.email, (emailCount.get(row.values.email) ?? 0) + 1);
  }
  for (const row of result) {
    if ((codeCount.get(row.values.employeeCode.toUpperCase()) ?? 0) > 1) row.errors.push("employeeCode appears more than once in this file.");
    if ((emailCount.get(row.values.email) ?? 0) > 1) row.errors.push("email appears more than once in this file.");
  }

  for (const row of result) if (!row.existingId) row.targetId = newIdFor(row.values.employeeCode || `row-${row.rowNumber}`, takenIds);

  const fileByCode = new Map<string, ValidatedRow>();
  for (const row of result) if ((codeCount.get(row.values.employeeCode.toUpperCase()) ?? 0) === 1) fileByCode.set(row.values.employeeCode.toUpperCase(), row);

  // Manager must exist (in the file or the directory) and be employed.
  for (const row of result) {
    const code = row.values.managerEmployeeCode;
    if (!code || code === row.values.employeeCode.toUpperCase()) continue;
    const inFile = fileByCode.get(code);
    const inDirectory = byCode.get(code);
    if (!inFile && !inDirectory) {
      row.errors.push(`Manager ${code} is not in this file or the directory.`);
      continue;
    }
    const managerStatus = inFile && !inFile.errors.length ? inFile.values.employmentStatus : inDirectory?.employmentStatus ?? inFile?.values.employmentStatus;
    if (managerStatus === "Terminated") row.errors.push(`Manager ${code} is terminated.`);
  }

  // Rows that depend on a new manager row that has errors cannot be imported either; repeat until stable.
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of result) {
      if (row.errors.length) continue;
      const code = row.values.managerEmployeeCode;
      const inFile = fileByCode.get(code);
      if (inFile && inFile.errors.length && !byCode.has(code)) {
        row.errors.push(`Manager ${code} (row ${inFile.rowNumber}) has errors and will not be created.`);
        changed = true;
      }
    }
  }

  // Reporting loops in the directory as it would look after the import.
  changed = true;
  while (changed) {
    changed = false;
    const managerOf = new Map(people.map((p) => [p.id, p.managerId]));
    const idForCode = (code: string) => {
      const fileRow = fileByCode.get(code);
      if (fileRow && !fileRow.errors.length) return fileRow.targetId;
      return byCode.get(code)?.id;
    };
    for (const row of result) {
      if (row.errors.length) continue;
      const managerId = idForCode(row.values.managerEmployeeCode);
      if (managerId) managerOf.set(row.targetId, managerId);
    }
    for (const row of result) {
      if (row.errors.length) continue;
      const seen = new Set<string>();
      let cursor = managerOf.get(row.targetId);
      while (cursor && !seen.has(cursor)) {
        if (cursor === row.targetId) {
          row.errors.push("This manager change would create a reporting loop.");
          changed = true;
          break;
        }
        seen.add(cursor);
        cursor = managerOf.get(cursor);
      }
    }
  }

  const peopleById = new Map(people.map((p) => [p.id, p]));
  for (const row of result) {
    if (row.errors.length) {
      row.action = "error";
      continue;
    }
    if (row.existingId) {
      const existing = peopleById.get(row.existingId)!;
      const manager = byCode.get(row.values.managerEmployeeCode) ?? undefined;
      const managerId = fileByCode.get(row.values.managerEmployeeCode)?.targetId ?? manager?.id;
      const same =
        existing.fullName === row.values.fullName &&
        existing.email.toLowerCase() === row.values.email &&
        existing.department === row.values.department &&
        existing.designation === row.values.designation &&
        existing.countryName === row.values.countryName &&
        existing.location === row.values.location &&
        existing.managerId === managerId &&
        existing.dateOfJoining === row.values.dateOfJoining &&
        existing.employmentType === row.values.employmentType &&
        existing.employmentStatus === row.values.employmentStatus;
      row.action = same ? "unchanged" : "update";
    }
  }
  return result;
}

/**
 * Turn importable rows into directory records. Also refreshes `managerName` on anyone who reports to
 * a person whose name changes, so the directory stays consistent.
 */
export function buildImportRecords(rows: ValidatedRow[], people: readonly PersonRecord[]): LocalPersonRecord[] {
  const importable = rows.filter((r) => r.action === "create" || r.action === "update");
  const byCode = new Map(people.map((p) => [p.employeeCode.trim().toUpperCase(), p]));
  const byId = new Map(people.map((p) => [p.id, p as LocalPersonRecord]));
  const fileByCode = new Map(importable.map((r) => [r.values.employeeCode.toUpperCase(), r]));
  const out = new Map<string, LocalPersonRecord>();

  for (const row of importable) {
    const v = row.values;
    const managerRow = fileByCode.get(v.managerEmployeeCode);
    const manager = byCode.get(v.managerEmployeeCode);
    const managerId = managerRow?.targetId ?? manager?.id ?? "";
    const managerName = managerRow?.values.fullName ?? manager?.fullName ?? "";
    const country = TIMEZ_COUNTRIES.find((c) => c.name === v.countryName) ?? TIMEZ_COUNTRIES[0];
    const legalEntity = people.find((p) => p.countryCode === country.code)?.legalEntity ?? "Infotech";
    const status = v.employmentStatus as EmploymentStatus;
    const existing = row.existingId ? byId.get(row.existingId) : undefined;

    if (existing) {
      const countryChanged = existing.countryName !== v.countryName;
      out.set(existing.id, {
        ...existing,
        fullName: v.fullName,
        email: v.email,
        department: v.department,
        designation: v.designation,
        countryName: v.countryName,
        countryCode: countryChanged ? country.code : existing.countryCode,
        timeZone: countryChanged ? country.timeZone : existing.timeZone,
        currency: countryChanged ? country.currency : existing.currency,
        legalEntity: countryChanged ? legalEntity : existing.legalEntity,
        location: v.location,
        managerId,
        managerName,
        dateOfJoining: v.dateOfJoining,
        employmentType: v.employmentType,
        employmentStatus: status,
        exitDate: status === "Terminated" ? existing.exitDate : undefined,
        exitReason: status === "Terminated" ? existing.exitReason : undefined,
      });
    } else {
      out.set(row.targetId, {
        id: row.targetId,
        employeeCode: v.employeeCode,
        fullName: v.fullName,
        email: v.email,
        personalEmail: "",
        mobile: "",
        photo: "/profile.svg",
        gender: "Unspecified",
        dateOfJoining: v.dateOfJoining,
        employmentType: v.employmentType,
        employmentStatus: status,
        designation: v.designation,
        jobFamily: FILTER_OPTIONS.jobFamilies.includes(v.department) ? v.department : "Operations",
        jobProfileId: "JP-IMPORT",
        positionId: "POS-IMPORT",
        grade: "L4",
        department: v.department,
        division: `${v.department} Delivery`,
        businessUnit: `Infotech ${country.name}`,
        costCenter: `CC-${country.code}-1`,
        location: v.location,
        countryCode: country.code,
        countryName: country.name,
        legalEntity,
        managerId,
        managerName,
        availability: "In Office",
        timeZone: country.timeZone,
        currency: country.currency,
        address: `${v.location}, ${country.name}`,
      });
    }
  }

  // Keep managerName in step for direct reports of renamed people.
  for (const person of people) {
    if (out.has(person.id)) continue;
    const renamed = out.get(person.managerId);
    if (renamed && renamed.fullName !== person.managerName) out.set(person.id, { ...(person as LocalPersonRecord), managerName: renamed.fullName });
  }
  return [...out.values()];
}

/** Template workbook: an empty import sheet, an example row and the allowed values. */
export function templateSheets(exampleManagerCode: string): { name: string; rows: unknown[][] }[] {
  const allowed: unknown[][] = [["department", "countryName", "employmentType", "employmentStatus"]];
  const longest = Math.max(FILTER_OPTIONS.departments.length, FILTER_OPTIONS.countries.length, EMPLOYMENT_TYPES.length, FILTER_OPTIONS.employmentStatuses.length);
  for (let i = 0; i < longest; i += 1) {
    allowed.push([
      FILTER_OPTIONS.departments[i] ?? "",
      FILTER_OPTIONS.countries[i] ?? "",
      EMPLOYMENT_TYPES[i] ?? "",
      FILTER_OPTIONS.employmentStatuses[i] ?? "",
    ]);
  }
  return [
    { name: "Employees", rows: [[...IMPORT_COLUMNS]] },
    {
      name: "Example",
      rows: [
        [...IMPORT_COLUMNS],
        ["TZ9001", "Priya Nair", "priya.nair@infotech.com", FILTER_OPTIONS.departments[0] ?? "Engineering", "Software engineer", "India", "Bengaluru", exampleManagerCode, "2026-09-01", "Full Time", "Active"],
      ],
    },
    { name: "Allowed values", rows: allowed },
  ];
}
