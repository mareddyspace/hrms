import { Link } from "react-router-dom";
import { useMemo, useState, useSyncExternalStore } from "react";
import { Card, Page } from "../components/ui.tsx";
import { findDemoById, managementChain } from "../demoAccounts.ts";
import {
  TIMEZ_COUNTRIES,
  formatShortDate,
  holidaysForCountry,
  holidaysForPerson,
  mondayOf,
  monthLabel,
  parseISODate,
  toISO,
  todayISO,
  weekDates,
  type CountryCode,
  type Holiday,
  type LeaveCode,
  type LeaveRequest,
} from "../model.ts";
import { usePortal } from "../store.tsx";
import { scheduleForEmployee } from "../data/workSchedule.ts";
import { isTerminated, listPeople, managerChainIds, subscribePeople } from "../data/peopleLocal.ts";
import "./TeamLeaveCalendar.css";

/** One colour per leave type (bars use it as fill, pending requests as a dashed outline). */
const LEAVE_COLOURS: Record<LeaveCode, string> = {
  pto: "#2563eb",
  casual: "#d97706",
  sick: "#dc2626",
  comp_off: "#7c3aed",
  bereavement: "#0f766e",
  unpaid: "#64748b",
  wfh: "#0891b2",
  emergency_wfh: "#db2777",
  optional: "#ca8a04",
};
/** Colour for teammates' leave when the viewer may only see that they're away. */
const AWAY_COLOUR = "#64748b";
/** Working from home is shown but doesn't count as "off". */
const WORKING_CODES: LeaveCode[] = ["wfh", "emergency_wfh"];
/** Warn when more than this share of a team is off on one day. */
const TEAM_OFF_LIMIT = 0.3;
const HR_ROLES = ["hr", "hr_admin", "hrbp"];

interface RosterPerson {
  id: string;
  name: string;
  country: CountryCode;
  managerId?: string;
  managerName?: string;
}

interface DayInfo {
  kind: "work" | "off" | "holiday";
  holidayName?: string;
  leave?: LeaveRequest;
}

type Mode = "country" | "reports" | "team";

function monthDates(year: number, month: number): string[] {
  const days = new Date(year, month + 1, 0).getDate();
  return Array.from({ length: days }, (_, i) => toISO(new Date(year, month, i + 1)));
}

function halfText(leave: LeaveRequest): string {
  return leave.half === "first" ? " (first half)" : leave.half === "second" ? " (second half)" : "";
}

export function TeamLeaveCalendarPage() {
  const { state, employee, demoAccounts, canDecideFor } = usePortal();
  const people = useSyncExternalStore(subscribePeople, listPeople, listPeople);
  const today = todayISO();
  const [cursor, setCursor] = useState(() => ({ year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) - 1 }));
  const [country, setCountry] = useState<CountryCode>((employee.countryCode ?? "IN") as CountryCode);

  // Everyone we know of: the people directory plus sign-in personas that aren't in it.
  const roster = useMemo<RosterPerson[]>(() => {
    const list: RosterPerson[] = people
      .filter((p) => !isTerminated(p))
      .map((p) => ({
        id: p.id,
        name: p.fullName,
        country: (p.countryCode || "IN") as CountryCode,
        managerId: p.managerId || undefined,
        managerName: p.managerName || undefined,
      }));
    const known = new Set(list.map((p) => p.id));
    for (const a of demoAccounts) {
      if (known.has(a.id)) continue;
      const manager = managementChain(a.id, demoAccounts)[0];
      list.push({
        id: a.id,
        name: a.fullName,
        country: (a.countryCode ?? "IN") as CountryCode,
        managerId: manager?.id,
        managerName: manager?.fullName,
      });
    }
    return list.sort((a, b) => a.name.localeCompare(b.name));
  }, [people, demoAccounts]);

  const isHr = HR_ROLES.includes(employee.role);
  const myReports = useMemo(() => roster.filter((p) => canDecideFor(p.id)), [roster, canDecideFor]);
  const mode: Mode = isHr ? "country" : myReports.length > 0 ? "reports" : "team";
  const myManagerId = managementChain(employee.id, demoAccounts)[0]?.id ?? managerChainIds(employee.id)[0];

  const visible = useMemo<RosterPerson[]>(() => {
    const me = roster.find((p) => p.id === employee.id) ?? {
      id: employee.id,
      name: employee.fullName,
      country: (employee.countryCode ?? "IN") as CountryCode,
      managerId: myManagerId,
    };
    if (mode === "country") return roster.filter((p) => p.country === country);
    if (mode === "reports") return [me, ...myReports.filter((p) => p.id !== me.id)];
    // Employees: their own team, i.e. everyone with the same manager.
    if (!myManagerId) return [me];
    const mates = roster.filter((p) => p.id !== me.id && p.managerId === myManagerId);
    return [me, ...mates];
  }, [roster, mode, country, myReports, employee, myManagerId]);

  /** Full detail (type, pending) for HR, managers and the viewer's own row; teammates only see that someone is away. */
  const seesDetail = (personId: string) => mode !== "team" || personId === employee.id;

  const dates = monthDates(cursor.year, cursor.month);
  const week = weekDates(mondayOf(today));
  const policyName = (code: LeaveCode) => state.leavePolicies.find((p) => p.code === code)?.name ?? code;

  // Per person: holidays, weekly offs and leave for each date in view (month + this week).
  const calendar = useMemo(() => {
    const span = [...new Set([...dates, ...week])];
    const byPerson = new Map<string, Map<string, DayInfo>>();
    const visibleIds = new Set(visible.map((p) => p.id));
    const leaves = state.leaveRequests.filter(
      (r) => visibleIds.has(r.employeeId) && (r.status === "approved" || r.status === "pending"),
    );
    for (const person of visible) {
      // Directory people outside India aren't known to the holiday context, so use their country's list.
      const holidays: Holiday[] =
        findDemoById(person.id) || person.country === "IN"
          ? holidaysForPerson(state.holidays, person.id)
          : holidaysForCountry(state.holidays, person.country);
      const holidayByDate = new Map(holidays.map((h) => [h.date, h.name]));
      const offs = scheduleForEmployee({ countryCode: person.country }).weeklyOffDays;
      const mine = leaves.filter((r) => r.employeeId === person.id && (r.status === "approved" || seesDetail(person.id)));
      const days = new Map<string, DayInfo>();
      for (const date of span) {
        const holidayName = holidayByDate.get(date);
        const kind: DayInfo["kind"] = holidayName ? "holiday" : offs.includes(parseISODate(date).getDay()) ? "off" : "work";
        // Approved wins over pending when both touch a day (e.g. two halves).
        const onDay = mine.filter((r) => r.from <= date && date <= r.to);
        const leave = kind === "work" ? (onDay.find((r) => r.status === "approved") ?? onDay[0]) : undefined;
        days.set(date, { kind, holidayName, leave });
      }
      byPerson.set(person.id, days);
    }
    return byPerson;
    // seesDetail depends only on mode and employee.id.
  }, [visible, state.leaveRequests, state.holidays, dates.join(), week.join(), mode, employee.id]);

  /** Off-day weight for one person on one date: 1, 0.5 for a half day, 0 when working (incl. WFH). */
  function offWeight(personId: string, date: string, includePending: boolean): number {
    const leave = calendar.get(personId)?.get(date)?.leave;
    if (!leave || WORKING_CODES.includes(leave.code)) return 0;
    if (leave.status === "pending" && !includePending) return 0;
    let weight = leave.half ? 0.5 : 1;
    // Two different approved halves on one day make a full day.
    if (leave.half) {
      const other = state.leaveRequests.find(
        (r) =>
          r.id !== leave.id &&
          r.employeeId === personId &&
          r.from === date &&
          r.to === date &&
          r.half &&
          r.half !== leave.half &&
          !WORKING_CODES.includes(r.code) &&
          (r.status === "approved" || (includePending && r.status === "pending" && seesDetail(personId))),
      );
      if (other) weight = 1;
    }
    return weight;
  }

  // Teams = people grouped by their manager. The warning fires when > 30% of any team is off (approved + pending).
  const teams = useMemo(() => {
    const groups = new Map<string, RosterPerson[]>();
    for (const p of visible) {
      const key = mode === "team" ? "mine" : (p.managerId ?? "none");
      groups.set(key, [...(groups.get(key) ?? []), p]);
    }
    return [...groups.entries()]
      .filter(([, members]) => members.length >= 2)
      .map(([managerId, members]) => ({
        managerId,
        label:
          mode === "team"
            ? "Your team"
            : `${members[0]?.managerName ?? roster.find((r) => r.id === managerId)?.name ?? "Unassigned"}'s team`,
        members,
      }));
  }, [visible, mode, roster]);

  function dayStats(date: string) {
    const approved = visible.reduce((n, p) => n + offWeight(p.id, date, false), 0);
    const planned = visible.reduce((n, p) => n + offWeight(p.id, date, true), 0);
    const overLimit = teams
      .map((team) => ({ team, off: team.members.reduce((n, p) => n + offWeight(p.id, date, true), 0) }))
      .filter(({ team, off }) => off / team.members.length > TEAM_OFF_LIMIT);
    return { approved, planned, overLimit };
  }

  const stats = new Map(dates.map((d) => [d, dayStats(d)]));
  const warningDays = dates.filter((d) => (stats.get(d)?.overLimit.length ?? 0) > 0);

  function offList(range: string[]) {
    const rows: { person: RosterPerson; leave: LeaveRequest }[] = [];
    for (const person of visible) {
      const seen = new Set<string>();
      for (const date of range) {
        const leave = calendar.get(person.id)?.get(date)?.leave;
        if (!leave || seen.has(leave.id) || WORKING_CODES.includes(leave.code)) continue;
        seen.add(leave.id);
        rows.push({ person, leave });
      }
    }
    return rows;
  }
  const offToday = offList([today]);
  const offThisWeek = offList(week);

  function describe(person: RosterPerson, leave: LeaveRequest): string {
    const range = leave.from === leave.to ? formatShortDate(leave.from) : `${formatShortDate(leave.from)} – ${formatShortDate(leave.to)}`;
    if (!seesDetail(person.id)) return `${range}${halfText(leave)}`;
    return `${policyName(leave.code)} · ${range}${halfText(leave)}${leave.status === "pending" ? " · pending" : ""}`;
  }

  function moveMonth(step: number) {
    setCursor((c) => {
      const d = new Date(c.year, c.month + step, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });
  }

  const scopeText =
    mode === "country"
      ? `Everyone in ${TIMEZ_COUNTRIES.find((c) => c.code === country)?.name ?? country}`
      : mode === "reports"
        ? "You and the people below you in the reporting line"
        : "You and your teammates (same manager) — dates only";
  const usedCodes = [...new Set(state.leaveRequests.map((r) => r.code))];

  return (
    <Page
      title="Team leave calendar"
      subtitle={scopeText}
      action={
        <Link className="btn-ghost" to="/leave">
          Back to leave
        </Link>
      }
    >
      <div className="tlc-summary">
        <Card title={`Off today (${offToday.length})`}>
          {offToday.length === 0 ? (
            <p className="muted">Everyone is in today.</p>
          ) : (
            <ul>
              {offToday.map(({ person, leave }) => (
                <li key={leave.id}>
                  <strong>{person.name}</strong> <span className="muted">· {describe(person, leave)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title={`Off this week (${offThisWeek.length})`}>
          {offThisWeek.length === 0 ? (
            <p className="muted">No leave this week.</p>
          ) : (
            <ul>
              {offThisWeek.map(({ person, leave }) => (
                <li key={leave.id}>
                  <strong>{person.name}</strong> <span className="muted">· {describe(person, leave)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Coverage warnings">
          {warningDays.length === 0 ? (
            <p className="muted">No day this month has more than {TEAM_OFF_LIMIT * 100}% of a team off.</p>
          ) : (
            <ul>
              {warningDays.map((d) => (
                <li key={d} className="tlc-warn">
                  {formatShortDate(d)}:{" "}
                  {stats
                    .get(d)!
                    .overLimit.map(({ team, off }) => `${team.label} ${off}/${team.members.length} off`)
                    .join(", ")}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card>
        <div className="tlc-toolbar">
          <button type="button" className="btn-ghost" onClick={() => moveMonth(-1)} aria-label="Previous month">
            ‹
          </button>
          <h2>{monthLabel(cursor.year, cursor.month)}</h2>
          <button type="button" className="btn-ghost" onClick={() => moveMonth(1)} aria-label="Next month">
            ›
          </button>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => setCursor({ year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) - 1 })}
          >
            Today
          </button>
          {mode === "country" && (
            <select value={country} onChange={(e) => setCountry(e.target.value as CountryCode)} aria-label="Country">
              {TIMEZ_COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
          <span className="muted">{visible.length} people</span>
        </div>
        <div className="tlc-legend" style={{ margin: "10px 0" }}>
          {mode === "team" ? (
            <span>
              <i className="tlc-swatch" style={{ background: AWAY_COLOUR }} /> Teammate away
            </span>
          ) : null}
          {usedCodes.map((code) => (
            <span key={code}>
              <i className="tlc-swatch" style={{ background: LEAVE_COLOURS[code] }} /> {policyName(code)}
            </span>
          ))}
          <span style={{ color: LEAVE_COLOURS.pto }}>
            <i className="tlc-swatch pending" /> <span className="muted">Pending</span>
          </span>
          <span>
            <i className="tlc-swatch holiday" /> Holiday
          </span>
          <span>
            <i className="tlc-swatch off" /> Weekly off
          </span>
          <span>Half cell = half day</span>
        </div>
        <div className="tlc-scroll">
          <table className="tlc-grid">
            <thead>
              <tr>
                <th className="tlc-name">Person</th>
                {dates.map((d) => {
                  const day = parseISODate(d);
                  return (
                    <th key={d} className={d === today ? "today" : undefined} title={formatShortDate(d)}>
                      {day.toLocaleDateString("en-US", { weekday: "narrow" })}
                      <br />
                      {day.getDate()}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 && (
                <tr>
                  <td className="tlc-name muted" colSpan={dates.length + 1}>
                    No one to show.
                  </td>
                </tr>
              )}
              {visible.map((person) => {
                const days = calendar.get(person.id);
                const detail = seesDetail(person.id);
                return (
                  <tr key={person.id}>
                    <th className="tlc-name" scope="row" title={person.name}>
                      {person.name}
                      {person.id === employee.id && <small>You</small>}
                    </th>
                    {dates.map((d) => {
                      const info = days?.get(d);
                      const leave = info?.leave;
                      const classes = ["tlc-cell", info?.kind === "holiday" ? "holiday" : info?.kind === "off" ? "off" : "", d === today ? "today" : ""]
                        .filter(Boolean)
                        .join(" ");
                      const colour = leave ? (detail ? LEAVE_COLOURS[leave.code] : AWAY_COLOUR) : undefined;
                      const title = info?.holidayName
                        ? `${formatShortDate(d)} · ${info.holidayName}`
                        : info?.kind === "off"
                          ? `${formatShortDate(d)} · Weekly off`
                          : leave
                            ? `${person.name} · ${detail ? policyName(leave.code) : "Away"}${halfText(leave)}${
                                leave.status === "pending" ? " · pending" : ""
                              }`
                            : undefined;
                      return (
                        <td key={d} className={classes} title={title}>
                          {leave && (
                            <span
                              className={["tlc-bar", leave.half ?? "", leave.status === "pending" ? "pending" : ""].filter(Boolean).join(" ")}
                              style={leave.status === "pending" ? { borderColor: colour } : { background: colour }}
                            />
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="tlc-count">
                <th className="tlc-name" scope="row">
                  Off (approved +pending)
                </th>
                {dates.map((d) => {
                  const s = stats.get(d)!;
                  const pending = s.planned - s.approved;
                  const warn = s.overLimit.length > 0;
                  return (
                    <td
                      key={d}
                      className={warn ? "warn" : undefined}
                      title={
                        warn
                          ? `More than ${TEAM_OFF_LIMIT * 100}% off: ${s.overLimit.map((o) => o.team.label).join(", ")}`
                          : `${s.approved} approved, ${pending} pending`
                      }
                    >
                      {s.planned > 0 ? (
                        <>
                          {s.approved || ""}
                          {pending > 0 ? <small>+{pending}</small> : null}
                        </>
                      ) : (
                        ""
                      )}
                    </td>
                  );
                })}
              </tr>
            </tfoot>
          </table>
        </div>
      </Card>
    </Page>
  );
}
