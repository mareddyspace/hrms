/**
 * A leaver's final settlement for HR (and the leaver): days paid in the last month, leave encashment and net,
 * worked out exactly as the payslips are (src/data/payslipGenerator.ts).
 */
import { API_ENABLED } from "../api/client.ts";
import { findDemoById } from "../demoAccounts.ts";
import type { ExitCase } from "../features/lifecycle/exitStore.ts";
import { leaveRows, todayISO, type CountryCode, type PortalState } from "../model.ts";
import { finalSettlementFor, type FinalSettlementSummary } from "./payslipGenerator.ts";
import { getPerson } from "./peopleLocal.ts";
import { getTaxRegime } from "./taxRegime.ts";

/** Unused privilege leave: from the server in backend mode, else the browser's leave records. */
export function unusedLeaveFor(row: ExitCase, state?: Pick<PortalState, "leavePolicies" | "leaveRequests" | "encashments" | "holidays">): number {
  if (API_ENABLED) return Math.max(0, row.api?.unusedLeaveDays ?? 0);
  if (!state) return 0;
  const rows = leaveRows(state.leavePolicies, state.leaveRequests, state.encashments, state.holidays, row.employeeId, [0, 6], Number(todayISO().slice(0, 4)));
  return Math.max(0, rows.find((r) => r.code === "pto")?.balance ?? 0);
}

export function finalSettlementForCase(
  row: ExitCase,
  state?: Pick<PortalState, "leavePolicies" | "leaveRequests" | "encashments" | "holidays" | "investmentProofs" | "timesheets" | "orgTimesheets">,
): FinalSettlementSummary | null {
  if (row.status !== "Accepted" && row.status !== "Completed") return null;
  const person = getPerson(row.employeeId);
  const demo = findDemoById(row.employeeId);
  return finalSettlementFor({
    employeeId: row.employeeId,
    role: demo?.role ?? "employee",
    countryCode: (person?.countryCode ?? demo?.countryCode ?? "IN") as CountryCode,
    joiningDate: person?.dateOfJoining,
    lastWorkingDay: row.lastWorkingDay,
    unusedLeaveDays: unusedLeaveFor(row, state),
    today: todayISO(),
    location: person?.location ?? demo?.location,
    nationality: person?.nationality,
    employmentStatus: person?.employmentStatus,
    regime: getTaxRegime(row.employeeId),
    investmentProofs: state?.investmentProofs,
    timesheets: state?.timesheets,
    orgTimesheets: state?.orgTimesheets,
  });
}
