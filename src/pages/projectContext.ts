import { useMemo } from "react";
import { usePortal } from "../store.tsx";
import { dayStatusOf } from "../data/timesheetDays.ts";
import type { LocalContext } from "../data/projectStore.ts";

/** What the project store needs from the portal in browser-only mode (backend mode ignores the hours). */
export function useProjectContext(): LocalContext {
  const { currentProjects, previousProjects, state, employee } = usePortal();
  return useMemo(() => {
    const entries = state.timesheets
      .filter((s) => s.employeeId === employee.id)
      .flatMap((s) =>
        (s.entries ?? []).map((e) => ({
          projectId: s.projectId,
          hours: e.hours,
          approved: s.status === "approved" || dayStatusOf(employee.id, e.date) === "approved",
          taskId: e.workType === "task" ? e.workId : undefined,
        })),
      );
    return {
      viewerId: employee.id,
      viewerName: employee.fullName,
      viewerRole: employee.role ?? "employee",
      viewerTitle: employee.designation ?? "",
      projects: [...currentProjects, ...previousProjects],
      entries,
    };
  }, [currentProjects, previousProjects, state.timesheets, employee]);
}
