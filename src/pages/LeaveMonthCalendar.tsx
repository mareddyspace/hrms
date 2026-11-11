import { useMemo, useState } from "react";
import { Card } from "../components/ui.tsx";
import { HOLIDAY_TYPES, HOLIDAY_TYPE_LABEL, appliesAt, holidayKind } from "../data/holidayRules.ts";
import { isWeeklyOffDate } from "../data/workSchedule.ts";
import { formatShortDate, monthCells, type Holiday, type HolidayType, type LeaveCode, type LeaveRequest } from "../model.ts";
import type { Place } from "../data/holidayRules.ts";
import "../styles/leave-holidays.css";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
type Who = "me" | "team" | "both";
type Ev = { key: string; text: string; title: string; cls: string };

/**
 * Month view of leave and holidays on the Leave page: the viewer's own leave, their team's (managers), and the
 * holidays of the viewer's office, with filters for people, leave type, status and holiday type.
 */
export function LeaveMonthCalendar({
  meId,
  requests,
  isTeam,
  holidays,
  place,
  weeklyOffDays,
  today,
  nameOf,
  leaveName,
  leaveCodes,
}: {
  meId: string;
  requests: LeaveRequest[];
  /** Requests of people the viewer manages (or may see in full). */
  isTeam: (request: LeaveRequest) => boolean;
  /** The viewer's country's holidays (all offices; filtered here by `place`). */
  holidays: Holiday[];
  place: Place;
  weeklyOffDays: number[];
  today: string;
  nameOf: (employeeId: string) => string;
  leaveName: (code: LeaveCode, employeeId?: string) => string;
  leaveCodes: LeaveCode[];
}) {
  const [cursor, setCursor] = useState(() => ({ y: Number(today.slice(0, 4)), m: Number(today.slice(5, 7)) - 1 }));
  const hasTeam = useMemo(() => requests.some((r) => r.employeeId !== meId && isTeam(r)), [requests, meId, isTeam]);
  const [who, setWho] = useState<Who>("me");
  const [code, setCode] = useState<LeaveCode | "all">("all");
  const [showPending, setShowPending] = useState(true);
  const [types, setTypes] = useState<Set<HolidayType>>(() => new Set(["national", "company", "regional"]));

  const cells = monthCells(cursor.y, cursor.m);
  const first = `${cursor.y}-${String(cursor.m + 1).padStart(2, "0")}-01`;
  const last = cells.filter(Boolean).slice(-1)[0] ?? first;
  const scopeWho: Who = hasTeam ? who : "me";

  const leaves = requests.filter(
    (r) =>
      (r.status === "approved" || (showPending && r.status === "pending")) &&
      r.from <= last &&
      r.to >= first &&
      (code === "all" || r.code === code) &&
      (r.employeeId === meId ? scopeWho !== "team" : scopeWho !== "me" && isTeam(r)),
  );
  const holidayRows = holidays.filter(
    (h) => h.date >= first && h.date <= last && types.has(holidayKind(h)) && appliesAt(h, place, true),
  );

  const eventsOn = (date: string): Ev[] => {
    const out: Ev[] = holidayRows
      .filter((h) => h.date === date)
      .map((h) => ({ key: h.id, text: h.name, title: `${h.name} · ${HOLIDAY_TYPE_LABEL[holidayKind(h)]} holiday`, cls: `lh-${holidayKind(h)}` }));
    for (const r of leaves) {
      if (r.from > date || r.to < date) continue;
      const mine = r.employeeId === meId;
      const label = mine ? leaveName(r.code) : `${nameOf(r.employeeId).split(" ")[0]} · ${leaveName(r.code, r.employeeId)}`;
      const half = r.half ? ` (${r.half} half)` : "";
      out.push({
        key: `${r.id}-${date}`,
        text: label + half,
        title: `${mine ? "You" : nameOf(r.employeeId)}: ${leaveName(r.code, r.employeeId)}${half}, ${formatShortDate(r.from)} – ${formatShortDate(r.to)} (${r.status})`,
        cls: r.status === "pending" ? "lh-pending" : "lh-leave",
      });
    }
    return out;
  };

  const move = (step: number) =>
    setCursor(({ y, m }) => {
      const n = m + step;
      return { y: y + Math.floor(n / 12), m: ((n % 12) + 12) % 12 };
    });
  const toggleType = (t: HolidayType) =>
    setTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });

  return (
    <Card title="Leave calendar">
      <div className="lh-month-head">
        <span className="lh-month-nav">
          <button type="button" className="btn-ghost btn-tiny" onClick={() => move(-1)} aria-label="Previous month">
            ‹
          </button>
          <strong>
            {MONTHS[cursor.m]} {cursor.y}
          </strong>
          <button type="button" className="btn-ghost btn-tiny" onClick={() => move(1)} aria-label="Next month">
            ›
          </button>
          <button
            type="button"
            className="btn-ghost btn-tiny"
            onClick={() => setCursor({ y: Number(today.slice(0, 4)), m: Number(today.slice(5, 7)) - 1 })}
          >
            Today
          </button>
        </span>
        <div className="lh-filters">
          {hasTeam && (
            <label className="lh-filter">
              <span>People</span>
              <select value={who} onChange={(e) => setWho(e.target.value as Who)}>
                <option value="me">Me</option>
                <option value="team">My team</option>
                <option value="both">Me and my team</option>
              </select>
            </label>
          )}
          <label className="lh-filter">
            <span>Leave type</span>
            <select value={code} onChange={(e) => setCode(e.target.value as LeaveCode | "all")}>
              <option value="all">All types</option>
              {leaveCodes.map((c) => (
                <option key={c} value={c}>
                  {leaveName(c)}
                </option>
              ))}
            </select>
          </label>
          <div className="lh-chips" role="group" aria-label="Show">
            <button type="button" className={`lh-chip lh-chip-pending${showPending ? " is-on" : ""}`} aria-pressed={showPending} onClick={() => setShowPending(!showPending)}>
              Pending
            </button>
            {HOLIDAY_TYPES.map((t) => (
              <button key={t} type="button" className={`lh-chip lh-chip-${t}${types.has(t) ? " is-on" : ""}`} aria-pressed={types.has(t)} onClick={() => toggleType(t)}>
                {HOLIDAY_TYPE_LABEL[t]}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="lh-month" role="grid" aria-label={`${MONTHS[cursor.m]} ${cursor.y}`}>
        {WEEKDAYS.map((d) => (
          <div key={d} className="lh-month-dow" role="columnheader">
            {d}
          </div>
        ))}
        {cells.map((date, i) => {
          if (!date) return <div key={`b-${i}`} className="lh-cell is-blank" />;
          const events = eventsOn(date);
          const off = isWeeklyOffDate(date, weeklyOffDays);
          return (
            <div key={date} role="gridcell" className={`lh-cell${off ? " is-off" : ""}${date === today ? " is-today" : ""}`}>
              <span className="lh-cell-day">{Number(date.slice(-2))}</span>
              {events.slice(0, 3).map((e) => (
                <span key={e.key} className={`lh-ev ${e.cls}`} title={e.title}>
                  {e.text}
                </span>
              ))}
              {events.length > 3 && <span className="lh-more" title={events.slice(3).map((e) => e.title).join("\n")}>+{events.length - 3} more</span>}
            </div>
          );
        })}
      </div>
      <p className="muted holiday-legend lh-legend">
        <span className="lh-legend-item">
          <span className="lh-swatch lh-leave" /> Approved leave
        </span>
        <span className="lh-legend-item">
          <span className="lh-swatch lh-pending" /> Pending
        </span>
        {HOLIDAY_TYPES.map((t) => (
          <span key={t} className="lh-legend-item">
            <span className={`lh-swatch lh-${t}`} /> {HOLIDAY_TYPE_LABEL[t]}
          </span>
        ))}
      </p>
    </Card>
  );
}
