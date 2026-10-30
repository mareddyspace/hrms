/**
 * Overtime and comp-off rules per country — the one place to change them. The backend keeps the same table in
 * backend/app/services/overtime.py (RULES), so local and backend modes agree.
 *
 * - A past date only, up to MAX_DAYS_BACK days ago; 0.5 to maxHours hours in half hours; one request per date.
 * - Paid: hourly rate = annual pay / (weeklyHours × 52), times the multiplier; paid with that month's payroll run.
 * - Comp-off: one day per dayHours of overtime, in half days; adds to the comp-off leave balance.
 */
import { payRulesFor } from "../../countryPay.ts";
import { payslipAnnualBase } from "../../data/annualPay.ts";
import { payScaleFor } from "../../data/payslipGenerator.ts";
import type { CountryCode } from "../../model.ts";

export interface OvertimeRules {
  weeklyHours: number;
  dayHours: number;
  multiplier: number;
  maxHours: number;
  compOff: boolean;
}

export const OVERTIME_RULES: Record<string, OvertimeRules> = {
  IN: { weeklyHours: 48, dayHours: 8, multiplier: 1.5, maxHours: 12, compOff: true },
  US: { weeklyHours: 40, dayHours: 8, multiplier: 1.5, maxHours: 12, compOff: false },
  GB: { weeklyHours: 40, dayHours: 8, multiplier: 1.5, maxHours: 12, compOff: true },
  AU: { weeklyHours: 38, dayHours: 7.6, multiplier: 1.5, maxHours: 12, compOff: true },
  CA: { weeklyHours: 40, dayHours: 8, multiplier: 1.5, maxHours: 12, compOff: true },
  AE: { weeklyHours: 48, dayHours: 8, multiplier: 1.5, maxHours: 10, compOff: true },
  SA: { weeklyHours: 48, dayHours: 8, multiplier: 1.5, maxHours: 12, compOff: true },
  DE: { weeklyHours: 40, dayHours: 8, multiplier: 1.5, maxHours: 10, compOff: true },
};

export const MAX_DAYS_BACK = 30;

export function overtimeRulesFor(country: string | undefined): OvertimeRules {
  return OVERTIME_RULES[country ?? "IN"] ?? OVERTIME_RULES.IN;
}

/** Annual pay: the compensation record, else the country's standard package for the role (as the payslips). */
export function annualPayFor(employeeId: string, country: string | undefined, role: string): number {
  const fromRecord = payslipAnnualBase(employeeId, country as CountryCode);
  if (fromRecord) return fromRecord;
  const monthly = payRulesFor(country as CountryCode).earnings.reduce((s, l) => s + l.amount, 0);
  return monthly * payScaleFor(role) * 12;
}

export function hourlyRate(employeeId: string, country: string | undefined, role: string): number {
  return Math.round((annualPayFor(employeeId, country, role) / (overtimeRulesFor(country).weeklyHours * 52)) * 100) / 100;
}

export function compOffDays(hours: number, country: string | undefined): number {
  const half = overtimeRulesFor(country).dayHours / 2;
  return Math.floor(hours / half + 1e-9) * 0.5;
}

export function overtimePay(hours: number, rate: number, country: string | undefined): number {
  return Math.round(hours * rate * overtimeRulesFor(country).multiplier);
}

/** Why the request can't be sent, or null. */
export function overtimeProblem(input: { date: string; hours: number; outcome: "pay" | "comp_off"; reason: string }, country: string | undefined, today: string): string | null {
  const rules = overtimeRulesFor(country);
  if (!input.date) return "Choose the date.";
  if (input.date >= today) return "Choose a past date.";
  const back = (Date.parse(today) - Date.parse(input.date)) / 86_400_000;
  if (back > MAX_DAYS_BACK) return `Overtime can be claimed up to ${MAX_DAYS_BACK} days back.`;
  if (!Number.isFinite(input.hours) || input.hours < 0.5 || input.hours > rules.maxHours) return `Enter 0.5 to ${rules.maxHours} hours.`;
  if (Math.round(input.hours * 2) !== input.hours * 2) return "Use half hours, e.g. 2 or 2.5.";
  if (input.outcome === "comp_off" && !rules.compOff) return "Comp-off isn't offered in your country; overtime is paid.";
  if (input.outcome === "comp_off" && compOffDays(input.hours, country) <= 0) return `Comp-off needs at least ${rules.dayHours / 2} hours.`;
  if (!input.reason.trim()) return "Enter a reason.";
  return null;
}
