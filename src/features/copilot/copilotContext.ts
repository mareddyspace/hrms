import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { CopilotContext } from "../../data/platformData.ts";
import { getAttendanceState } from "../../data/attendanceLocal.ts";
import { compReviewStatus } from "../../data/homeInsights.ts";
import { listPeople, subscribePeople } from "../../data/peopleLocal.ts";
import { canViewReport } from "../../data/rbac.ts";
import { getRewardState } from "../../data/rewardLocal.ts";
import { getTalentState } from "../../data/talentLocal.ts";
import { TASK_TEAM } from "../../data/taskTeam.ts";
import { scheduleForEmployee } from "../../data/workSchedule.ts";
import { teamBelow } from "../../data/workforceStats.ts";
import { getShiftState, publishedShiftsFor, shiftById, shiftLabel } from "../workforce/shiftsStore.ts";
import { todayISO } from "../../model.ts";
import { countWaitingOnMe } from "../../pages/ApprovalsCenter.tsx";
import { usePortal } from "../../store.tsx";
import { buildCopilotContext } from "./buildContext.ts";
import { summarisePersonFor } from "./personSummary.ts";

/**
 * Returns a builder for Copilot's context: the viewer's own data plus people below them in the
 * reporting line (company-wide numbers only when the viewer's access allows). Read fresh on every
 * question. Use as `answerCopilot(question, buildContext())`.
 */
export function useCopilotContext(): () => CopilotContext {
  const { employee, demoProfile, demoAccounts, state, leaveTable, payslipViews, canDecideFor, canVerifyProofs } = usePortal();
  const people = useSyncExternalStore(subscribePeople, listPeople, listPeople);
  const team = useMemo(
    () => teamBelow(employee.id, people, canDecideFor, TASK_TEAM.map((p) => p.id)),
    [employee.id, people, canDecideFor],
  );

  return useCallback((): CopilotContext => {
    const today = todayISO();
    const orgWide = canViewReport(demoProfile, "company") || canViewReport(demoProfile, "hr");
    const shifts = getShiftState();
    const rostered = publishedShiftsFor(employee.id, shifts).find((a) => a.date === today);
    const rosteredShift = rostered ? shiftById(rostered.shiftId, shifts) : undefined;
    // Company-wide pay figures: Compensation only (everyone else sees just their own payslips).
    const canSeeComp = demoProfile.role === "compensation_admin" || demoProfile.role === "super_admin";
    const comp = canSeeComp ? compReviewStatus(getRewardState().reviews) : undefined;
    return buildCopilotContext({
      today,
      viewer: demoProfile,
      employee,
      accounts: demoAccounts,
      state,
      leaveTable,
      payslips: payslipViews,
      people,
      team,
      canDecideFor,
      canVerifyProofs,
      approvalsCount: countWaitingOnMe(state, employee.id, canDecideFor, canVerifyProofs),
      weeklyOffDays: scheduleForEmployee({ shiftName: employee.shiftName, shiftHours: employee.shiftHours, countryCode: employee.countryCode }).weeklyOffDays,
      orgWide,
      talent: getTalentState(),
      corrections: getAttendanceState().corrections,
      swaps: shifts.swaps,
      todayShift: rosteredShift ? shiftLabel(rosteredShift) : undefined,
      compReview: comp ?? undefined,
      summarisePerson: (query: string) => summarisePersonFor(demoProfile, query),
    });
  }, [team, state, people, demoProfile, employee, demoAccounts, leaveTable, payslipViews, canDecideFor, canVerifyProofs]);
}
