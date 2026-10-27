import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { CopilotContext } from "../../data/platformData.ts";
import { listPeople, subscribePeople } from "../../data/peopleLocal.ts";
import { canViewReport } from "../../data/rbac.ts";
import { TASK_TEAM } from "../../data/taskTeam.ts";
import { personName, teamBelow, upcomingHolidays, waitingItems, workforceStats } from "../../data/workforceStats.ts";
import { holidaySet, holidaysForPerson, todayISO, workingDays } from "../../model.ts";
import { countWaitingOnMe } from "../../pages/ApprovalsCenter.tsx";
import { usePortal } from "../../store.tsx";
import { summarisePersonFor } from "./personSummary.ts";

/**
 * Returns a builder for Copilot's context: the viewer's own data plus people below them in the
 * reporting line. Use as `answerCopilot(question, buildContext())`.
 */
export function useCopilotContext(): () => CopilotContext {
  const { employee, demoProfile, demoAccounts, state, leaveTable, canDecideFor, canVerifyProofs } = usePortal();
  const people = useSyncExternalStore(subscribePeople, listPeople, listPeople);
  const team = useMemo(
    () => teamBelow(employee.id, people, canDecideFor, TASK_TEAM.map((p) => p.id)),
    [employee.id, people, canDecideFor],
  );

  return useCallback((): CopilotContext => {
    const today = todayISO();
    const year = today.slice(0, 4);
    const teamIds = new Set(team.map((m) => m.id));
    const leaveDays = new Map<string, number>();
    for (const r of state.leaveRequests) {
      if (r.status !== "approved" || !teamIds.has(r.employeeId) || !r.from.startsWith(year)) continue;
      const days = workingDays(r.from, r.to, holidaySet(holidaysForPerson(state.holidays, r.employeeId)), [0, 6]);
      leaveDays.set(r.employeeId, (leaveDays.get(r.employeeId) ?? 0) + days);
    }
    const orgWide = canViewReport(demoProfile, "company") || canViewReport(demoProfile, "hr");
    const ytd = orgWide ? workforceStats(people, { country: "ALL", range: "ytd", today }) : undefined;
    return {
      viewer: demoProfile,
      firstName: employee.fullName.split(" ")[0],
      countryName: employee.countryName ?? "your country",
      timeZone: employee.timeZone,
      shiftHours: employee.shiftHours,
      managerName: demoAccounts.find((a) => a.id === demoProfile.reportsToId)?.fullName,
      leaveRows: leaveTable.map((r) => ({ name: r.name, code: r.code, available: r.available, pending: r.pending })),
      holidays: upcomingHolidays(state.holidays, employee.countryCode, today, 5),
      approvals: waitingItems(state, employee.id, canDecideFor, canVerifyProofs).map((w) => ({
        who: personName(w.employeeId, people),
        kind: w.kind,
        detail: w.detail,
        date: w.date,
      })),
      approvalsCount: countWaitingOnMe(state, employee.id, canDecideFor, canVerifyProofs),
      teamSize: team.length,
      teamLeave: [...leaveDays.entries()]
        .map(([id, days]) => ({ name: personName(id, people), days }))
        .sort((a, b) => b.days - a.days),
      orgWide,
      workforce: ytd && { headcount: ytd.headcount, joiners: ytd.joiners, exits: ytd.exits, attritionPct: ytd.attritionPct },
      summarisePerson: (query: string) => summarisePersonFor(demoProfile, query),
    };
  }, [team, state, people, demoProfile, employee, demoAccounts, leaveTable, canDecideFor, canVerifyProofs]);
}
