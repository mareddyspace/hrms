import * as XLSX from "xlsx";
import { DEMO_ACCOUNTS, managementChain, type DemoAccount } from "../../demoAccounts.ts";
import type { PersonRecord } from "../../data/peopleData.ts";
import type { UserRole } from "../../model.ts";

/** Who performs a data-tools action — the signed-in persona. */
export type DataToolsActor = Pick<DemoAccount, "id" | "fullName" | "role">;
/** null when the change was applied, otherwise the reason it was refused. */
export type DataToolsResult = string | null;

export const HR_ROLES: readonly UserRole[] = ["hr", "hr_admin", "hrbp"];
export const ADMIN_ROLES: readonly UserRole[] = ["admin", "super_admin"];

/** Bulk import / mass update and org-wide reports: HR and admin only. */
export function isHrOrAdmin(role: UserRole): boolean {
  return HR_ROLES.includes(role) || ADMIN_ROLES.includes(role);
}

/** Roles whose report builder covers the whole organisation (compensation columns are always stripped). */
export function hasOrgWideReports(role: UserRole): boolean {
  return isHrOrAdmin(role) || role === "executive" || role === "compensation_admin";
}

/** Scheduled report files may only go to company mailboxes. */
export const INTERNAL_EMAIL_DOMAIN = "@infotech.com";

export function isInternalEmail(value: string): boolean {
  return value.toLowerCase().endsWith(INTERNAL_EMAIL_DOMAIN);
}

export const EMAIL_PATTERN = /^[^\s@<>()[\]\\,;:"']+@[^\s@<>()[\]\\,;:"']+\.[A-Za-z]{2,}$/;

export function isValidEmail(value: string): boolean {
  return value.length <= 120 && EMAIL_PATTERN.test(value);
}

/** Strict YYYY-MM-DD that is also a real calendar date. */
export function isValidISODate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d && y >= 1900;
}

/** Strip control characters and collapse whitespace from untrusted text. */
export function cleanText(value: unknown): string {
  return String(value ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Text that a spreadsheet could run as a formula. */
export function looksLikeFormula(value: string): boolean {
  return /^[=+\-@]/.test(value);
}

/** Make a cell safe for CSV/XLSX export: text that starts like a formula is prefixed with '. */
export function safeCell(value: unknown): string | number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = value == null ? "" : String(value);
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

function csvEscape(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: unknown[][]): string {
  return rows.map((row) => row.map((cell) => csvEscape(safeCell(cell))).join(",")).join("\r\n");
}

export function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadCsv(filename: string, rows: unknown[][]) {
  // BOM so Excel opens UTF-8 names correctly.
  downloadBlob(filename, new Blob(["﻿" + toCsv(rows)], { type: "text/csv;charset=utf-8" }));
}

export function downloadXlsx(filename: string, sheets: { name: string; rows: unknown[][] }[]) {
  const book = XLSX.utils.book_new();
  for (const sheet of sheets) {
    const safe = sheet.rows.map((row) => row.map((cell) => safeCell(cell)));
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(safe), sheet.name.slice(0, 31));
  }
  XLSX.writeFile(book, filename);
}

/** A file-name-safe slug. */
export function fileSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "export";
}

export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Everyone whose directory or demo reporting chain runs up to `managerId` (excludes the manager). */
export function reportingLineIds(managerId: string, people: readonly PersonRecord[]): Set<string> {
  const byId = new Map(people.map((p) => [p.id, p]));
  const result = new Set<string>();
  for (const person of people) {
    if (person.id === managerId) continue;
    const seen = new Set<string>([person.id]);
    let current = byId.get(person.managerId);
    let reaches = person.managerId === managerId;
    while (!reaches && current && !seen.has(current.id)) {
      seen.add(current.id);
      if (current.managerId === managerId) reaches = true;
      current = byId.get(current.managerId);
    }
    if (!reaches && managementChain(person.id, DEMO_ACCOUNTS).some((m) => m.id === managerId)) reaches = true;
    if (reaches) result.add(person.id);
  }
  return result;
}

/** Column ids that must never appear in exports, whatever a saved definition says. */
export function isCompensationColumn(id: string): boolean {
  return /salary|compensation|ctc|bonus|payslip|pay_?grade|base_?pay|variable|wage|stipend/i.test(id);
}
