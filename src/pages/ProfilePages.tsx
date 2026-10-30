import { useMemo, useState, useSyncExternalStore } from "react";
import { holidaysForPerson } from "../model.ts";
import { OptionalHolidaysCard } from "../features/workforce/OptionalHolidaysPage.tsx";
import {
  countryOf,
  getOptionalHolidayState,
  holidaysFor as optionalHolidaysFor,
  optionalRequestsFor,
  requestOn,
  subscribeOptionalHolidays,
} from "../features/workforce/optionalHolidaysStore.ts";
import { Card, Page } from "../components/ui.tsx";
import {
  isPrimaryWeeklyOffLabel,
  isWeeklyOffDate,
  scheduleForEmployee,
} from "../data/workSchedule.ts";
import { monthCells, monthLabel, todayISO } from "../model.ts";
import { usePortal } from "../store.tsx";
import { PersonProfilePage } from "./PersonProfilePage.tsx";

export { AttendancePage } from "./AttendanceModule.tsx";

/** My profile — the same profile page colleagues see, plus edit and the full record for you. */
export function MyInfo() {
  const { employee } = usePortal();
  return <PersonProfilePage personId={employee.id} />;
}

export { ProjectsPage } from "./ProjectsPage.tsx";

export function HolidaysPage() {
  const today = todayISO();
  const { state, employee } = usePortal();
  const holidays = useMemo(() => holidaysForPerson(state.holidays, employee.id), [state.holidays, employee.id]);
  const initial = new Date();
  const [cursor, setCursor] = useState({ year: initial.getFullYear(), month: initial.getMonth() });
  const cells = monthCells(cursor.year, cursor.month);
  const byDate = useMemo(() => new Map(holidays.map((holiday) => [holiday.date, holiday])), [holidays]);
  const optionalState = useSyncExternalStore(subscribeOptionalHolidays, getOptionalHolidayState, getOptionalHolidayState);
  const optionalByDate = new Map(optionalHolidaysFor(countryOf(employee.id), cursor.year, optionalState).map((h) => [h.date, h]));
  const myOptional = optionalRequestsFor(state.leaveRequests, employee.id, cursor.year);
  const schedule = useMemo(
    () =>
      scheduleForEmployee({
        shiftName: employee.shiftName,
        shiftHours: employee.shiftHours,
        countryCode: employee.countryCode,
      }),
    [employee.shiftName, employee.shiftHours, employee.countryCode],
  );

  function move(delta: number) {
    const next = new Date(cursor.year, cursor.month + delta, 1);
    setCursor({ year: next.getFullYear(), month: next.getMonth() });
  }

  return (
    <Page title="Holiday calendar">
      <Card>
        <div className="row-between" style={{ marginBottom: 12 }}>
          <h2 className="card-title" style={{ margin: 0 }}>
            {monthLabel(cursor.year, cursor.month)}
          </h2>
          <span className="form-actions">
            <button className="btn-ghost" type="button" onClick={() => move(-1)}>
              Previous
            </button>
            <button className="btn-ghost" type="button" onClick={() => move(1)}>
              Next
            </button>
          </span>
        </div>
        <div className="cal">
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((label) => (
            <div key={label} className="cal-head">
              {label}
            </div>
          ))}
          {cells.map((date, index) => {
            if (!date) return <div key={`blank-${index}`} />;
            const holiday = byDate.get(date);
            const optional = holiday ? undefined : optionalByDate.get(date);
            const pick = optional ? requestOn(myOptional, date) : undefined;
            const pickText = pick?.status === "approved" ? " · picked" : pick?.status === "pending" ? " · waiting" : "";
            const weeklyOff = isWeeklyOffDate(date, schedule.weeklyOffDays);
            const showOff =
              !holiday && weeklyOff && isPrimaryWeeklyOffLabel(date, schedule.weeklyOffDays);
            return (
              <div
                key={date}
                className={`day ${holiday || pick?.status === "approved" ? "holiday" : weeklyOff ? "weekend" : ""} ${date === today ? "today" : ""}`}
                title={holiday ? holiday.name : optional ? `${optional.name} (optional)` : weeklyOff ? "Weekly off" : undefined}
              >
                <strong>{Number(date.slice(-2))}</strong>
                {date === today && <span className="day-today-tag">Today</span>}
                {holiday ? holiday.name : optional ? `${optional.name} (optional${pickText})` : showOff ? "Weekly off" : ""}
              </div>
            );
          })}
        </div>
      </Card>
      <OptionalHolidaysCard />
    </Page>
  );
}
