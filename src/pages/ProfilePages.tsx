import { usePortal } from "../store.tsx";
import { PersonProfilePage } from "./PersonProfilePage.tsx";

export { AttendancePage } from "./AttendanceModule.tsx";

/** My profile — the same profile page colleagues see, plus edit and the full record for you. */
export function MyInfo() {
  const { employee } = usePortal();
  return <PersonProfilePage personId={employee.id} />;
}

export { ProjectsPage } from "./ProjectsPage.tsx";

/** Holiday calendar: Month / List / Year, .ics export, and HR's editor per country. */
export { HolidaysPage } from "./HolidayCalendarPage.tsx";
