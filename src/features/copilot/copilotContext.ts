import { useCallback, useMemo, useSyncExternalStore } from "react";
import { copilotPersonaFromRole, type CopilotContext } from "../../data/platformData.ts";
import { buildAssist } from "./assist.ts";
import { getAttendanceState } from "../../data/attendanceLocal.ts";
import { compReviewStatus } from "../../data/homeInsights.ts";
import { listPeople, subscribePeople } from "../../data/peopleLocal.ts";
import { canApproveCompReviews, canViewReport } from "../../data/rbac.ts";
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
    // Company-wide pay figures: HR (compensation & benefits) only — everyone else sees just their own payslips.
    const canSeeComp = canApproveCompReviews(demoProfile) || demoProfile.role === "super_admin";
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
      assist: buildAssist({
        analytics: () => ({
          today,
          // Company-wide numbers: HR, executives and admins. Managers get their reporting line only.
          scope: orgWide || ["hr", "executive", "admin"].includes(copilotPersonaFromRole(demoProfile.role)) ? "org" : team.length ? "team" : "none",
          viewerId: employee.id,
          people,
          teamIds: new Set(team.map((m) => m.id)),
          state,
          attendance: getAttendanceState(),
          enrollments: getTalentState().enrollments,
        }),
        letters: () => ({ viewer: demoProfile, today, people, history: getRewardState().history }),
        actions: () => ({
          today,
          currentAddress: employee.address ?? "",
          currentMobile: employee.mobile ?? "",
          leaveRows: leaveTable.filter((r) => r.quota > 0 || r.code === "unpaid").map((r) => ({ code: r.code, name: r.name, available: r.available })),
          isPersonName: (word: string) =>
            word !== employee.fullName.split(" ")[0].toLowerCase() && people.some((p) => p.fullName.toLowerCase().split(" ")[0] === word),
        }),
      }),
    });
  }, [team, state, people, demoProfile, employee, demoAccounts, leaveTable, payslipViews, canDecideFor, canVerifyProofs]);
}
