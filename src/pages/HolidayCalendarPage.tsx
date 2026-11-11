import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Link } from "react-router-dom";
import { ActionButton, Banner, Card, Dialog, EmptyState, Field, Page, SubmitButton, Tabs, notify, useAction } from "../components/ui.tsx";
import { OptionalHolidayDialog, OptionalHolidaysCard } from "../features/workforce/OptionalHolidaysPage.tsx";
import {
  getOptionalHolidayState,
  holidaysFor as optionalHolidaysFor,
  optionalRequestsFor,
  pickDeadline,
  requestOn,
  subscribeOptionalHolidays,
  type OptionalHoliday,
} from "../features/workforce/optionalHolidaysStore.ts";
import { isWeeklyOffDate, scheduleForEmployee } from "../data/workSchedule.ts";
import { buildHolidayIcs, canEditHolidays, downloadIcs, loadApiHolidays, removeHoliday, saveHoliday, type HolidayInput } from "../data/holidayAdmin.ts";
import {
  HOLIDAY_TYPES,
  HOLIDAY_TYPE_LABEL,
  OFFICES,
  appliesAt,
  appliesText,
  holidayKind,
  holidayRegions,
  regionOf,
  regionsOf,
} from "../data/holidayRules.ts";
import { API_ENABLED } from "../api/client.ts";
import {
  TIMEZ_COUNTRIES,
  formatShortDate,
  allHolidaysForCountry,
  monthCells,
  parseISODate,
  placeOfPerson,
  todayISO,
  type CountryCode,
  type Holiday,
  type HolidayType,
} from "../model.ts";
import { usePortal } from "../store.tsx";
import "./holidays.css";
import "../styles/pay-claims.css";
import "../styles/leave-holidays.css";

type View = "list" | "calendar";
type Kind = HolidayType | "weekly";
type Row = { id: string; date: string; name: string; kind: Kind; where: string; description?: string; pick?: string; applies: boolean };

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const KIND_LABEL: Record<Kind, string> = {
  national: "National holiday",
  regional: "Regional holiday",
  company: "Company holiday",
  optional: "Optional holiday",
  weekly: "Weekly off",
};
const countryName = (code: string) => TIMEZ_COUNTRIES.find((c) => c.code === code)?.name ?? code;
const longDate = (iso: string) => parseISODate(iso).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const weekdayShort = (iso: string) => parseISODate(iso).toLocaleDateString("en-GB", { weekday: "short" });

function whenText(iso: string, today: string): string {
  const n = Math.round((parseISODate(iso).getTime() - parseISODate(today).getTime()) / 86_400_000);
  if (n === 0) return "Today";
  if (n === 1) return "Tomorrow";
  if (n > 1 && n <= 30) return `In ${n} days`;
  return "";
}

function describe(row: Row, country: string): string {
  if (row.description) return row.description;
  if (row.kind === "national") return `National holiday in ${countryName(country)}. Offices are closed and it doesn't count as leave.`;
  if (row.kind === "company") return "Company holiday. Offices are closed and it doesn't count as leave.";
  if (row.kind === "regional") return `Holiday for ${row.where} only.`;
  if (row.kind === "optional") return "Optional holiday. Select it to take the day off; it counts against your yearly optional holiday limit.";
  return "Weekly day off under your work schedule.";
}

/** "mine" = the viewer's own office; "all" = every office in the country; otherwise one office (city). */
type Office = "mine" | "all" | string;

/** The viewer's holidays for a year (by office and type), as a list or a year calendar; optional holidays in their
 * own card. HR and admins edit holidays per country, with type and the states / offices they apply to. */
export function HolidaysPage() {
  const today = todayISO();
  const currentYear = Number(today.slice(0, 4));
  const { state, employee, demoProfile, replaceHolidays } = usePortal();
  const editor = canEditHolidays(demoProfile.role);
  const myCountry = String(employee.countryCode ?? "IN");
  const myPlace = placeOfPerson(employee.id);
  const [country, setCountry] = useState(myCountry);
  const viewingOwn = country === myCountry;
  const [office, setOffice] = useState<Office>("mine");
  const [types, setTypes] = useState<Set<HolidayType>>(() => new Set(HOLIDAY_TYPES));
  const [view, setView] = useState<View>("list");
  const [year, setYear] = useState(currentYear);
  const [showPast, setShowPast] = useState(true);
  const [editing, setEditing] = useState<Holiday | "new" | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [icsOpen, setIcsOpen] = useState(false);
  const effectiveOffice: Office = !viewingOwn && office === "mine" ? "all" : office;

  // Backend mode: the year's list from the server, into portal state (so leave counts and other pages agree).
  useEffect(() => {
    if (!API_ENABLED) return;
    let live = true;
    void loadApiHolidays(replaceHolidays, country, year, editor).then((e) => live && setLoadError(e));
    return () => {
      live = false;
    };
    // replaceHolidays is rebuilt with state; reload only when the country or year changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [country, year, editor]);

  const countryHolidays = useMemo(() => allHolidaysForCountry(state.holidays, country as CountryCode), [state.holidays, country]);
  const offices = OFFICES[country] ?? [];
  const placeFor = (o: Office) => (o === "mine" ? myPlace : o === "all" ? null : { location: o });
  const appliesHere = (h: Holiday, o: Office = effectiveOffice) => {
    const place = placeFor(o);
    return place === null || appliesAt(h, place);
  };
  const holidays = useMemo(
    () => countryHolidays.filter((h) => holidayKind(h) !== "optional" && appliesHere(h)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [countryHolidays, effectiveOffice, myPlace.location, myPlace.legalEntity],
  );
  const optionalState = useSyncExternalStore(subscribeOptionalHolidays, getOptionalHolidayState, getOptionalHolidayState);
  const optional = optionalHolidaysFor(country, year, optionalState, viewingOwn);
  const optionalByDate = new Map(optional.map((h) => [h.date, h]));
  const myOptional = viewingOwn ? optionalRequestsFor(state.leaveRequests, employee.id, year) : [];
  const schedule = useMemo(
    () =>
      viewingOwn
        ? scheduleForEmployee({ shiftName: employee.shiftName, shiftHours: employee.shiftHours, countryCode: employee.countryCode })
        : scheduleForEmployee({ countryCode: country }),
    [viewingOwn, employee.shiftName, employee.shiftHours, employee.countryCode, country],
  );

  const pickText = (date: string) => {
    const pick = requestOn(myOptional, date);
    return pick?.status === "approved" ? "Selected" : pick?.status === "pending" ? "Waiting" : undefined;
  };
  const yearRows: Row[] = holidays
    .filter((h) => h.date.startsWith(`${year}-`))
    .map((h) => ({
      id: h.id,
      date: h.date,
      name: h.name,
      kind: holidayKind(h) as Kind,
      where: appliesText(h),
      description: h.description,
      applies: !viewingOwn || appliesAt(h, myPlace),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const dayOffDates = new Set(yearRows.map((r) => r.date));
  const optionalRows: Row[] = optional
    .filter((h) => !dayOffDates.has(h.date))
    .map((h) => ({
      id: h.id,
      date: h.date,
      name: h.name,
      kind: "optional" as Kind,
      where: h.region ?? "Whole country",
      description: h.description,
      pick: pickText(h.date),
      applies: true,
    }));
  const publicRows = yearRows.filter((r) => types.has(r.kind as HolidayType));
  const shownOptional = types.has("optional") ? optionalRows : [];
  const byDate = new Map<string, Row>();
  for (const r of [...publicRows, ...shownOptional]) if (!byDate.has(r.date)) byDate.set(r.date, r);
  const icsRows = [...publicRows, ...shownOptional].sort((a, b) => a.date.localeCompare(b.date));
  const thisYear = year === currentYear;
  const upcoming = yearRows.filter((r) => r.date >= today);
  const next = upcoming[0];
  const listedAll = [...publicRows, ...shownOptional].sort((a, b) => a.date.localeCompare(b.date));
  const passed = thisYear ? listedAll.filter((r) => r.date < today).length : 0;
  const listed = thisYear && !showPast ? listedAll.filter((r) => r.date >= today) : listedAll;
  const groups = MONTHS.map((label, m) => ({ label, m, rows: listed.filter((r) => Number(r.date.slice(5, 7)) - 1 === m) })).filter((g) => g.rows.length);
  const editable = new Set(countryHolidays.map((h) => h.id));
  const actor = { id: demoProfile.id, fullName: demoProfile.fullName, role: demoProfile.role };
  const countBy = (kind: Kind) => yearRows.filter((r) => r.kind === kind).length;
  const officeLabel =
    effectiveOffice === "mine"
      ? [myPlace.location, regionOf(myPlace.location)].filter(Boolean).join(", ") || countryName(country)
      : effectiveOffice === "all"
        ? `All offices · ${countryName(country)}`
        : [effectiveOffice, regionOf(effectiveOffice)].filter(Boolean).join(", ");
  const officeSummary = editor
    ? offices.map((city) => ({
        city,
        region: regionOf(city),
        daysOff: countryHolidays.filter((h) => h.date.startsWith(`${year}-`) && holidayKind(h) !== "optional" && appliesAt(h, { location: city })).length,
      }))
    : [];

  const toggleType = (t: HolidayType) =>
    setTypes((prev) => {
      const nextSet = new Set(prev);
      if (nextSet.has(t)) nextSet.delete(t);
      else nextSet.add(t);
      return nextSet.size ? nextSet : new Set(HOLIDAY_TYPES);
    });

  const rowOn = (date: string): Row | undefined => byDate.get(date);

  const dayCell = (date: string) => {
    const row = rowOn(date);
    const cls = [
      "day",
      "hol-day",
      row && row.kind !== "optional" ? `holiday lh-${row.kind}` : "",
      row?.kind === "optional" ? (row.pick === "Selected" ? "optional picked" : "optional") : "",
      !row && isWeeklyOffDate(date, schedule.weeklyOffDays) ? "weekend" : "",
      date === today ? "today" : "",
    ]
      .filter(Boolean)
      .join(" ");
    if (!row) {
      return (
        <div key={date} className={cls}>
          {Number(date.slice(-2))}
        </div>
      );
    }
    const title = `${formatShortDate(date)} · ${row.name} (${KIND_LABEL[row.kind].toLowerCase()})`;
    return (
      <button key={date} type="button" className={cls} title={title} aria-label={title} onClick={() => setDetail(date)}>
        {Number(date.slice(-2))}
      </button>
    );
  };

  const detailRow = detail ? rowOn(detail) : undefined;
  const detailOptional: OptionalHoliday | undefined = detail && viewingOwn && detailRow?.kind === "optional" ? optionalByDate.get(detail) : undefined;
  const editHoliday = (id: string) => countryHolidays.find((h) => h.id === id) ?? null;

  return (
    <Page title="Holiday calendar" action={<Link className="btn-ghost" to="/workforce/optional-holidays">Optional holidays</Link>}>
      <Card>
        <div className="pc-hol-bar">
          <div className="pc-hol-year" role="group" aria-label="Year">
            <button type="button" className="btn-ghost btn-tiny" onClick={() => setYear(year - 1)} aria-label="Previous year">
              ‹
            </button>
            <strong>{year}</strong>
            <button type="button" className="btn-ghost btn-tiny" onClick={() => setYear(year + 1)} aria-label="Next year">
              ›
            </button>
            {!thisYear && (
              <button type="button" className="btn-ghost btn-tiny" onClick={() => setYear(currentYear)}>
                This year
              </button>
            )}
          </div>
          <Tabs
            tabs={[
              { id: "list", label: "List" },
              { id: "calendar", label: "Calendar" },
            ]}
            value={view}
            onChange={(v) => setView(v as View)}
          />
          <span className="form-actions pc-hol-tools">
            <button type="button" className="btn-ghost" onClick={() => setIcsOpen(true)}>
              Add to my calendar
            </button>
            {editor && (
              <button type="button" className="btn" onClick={() => setEditing("new")}>
                Add holiday
              </button>
            )}
          </span>
        </div>

        <div className="lh-filters">
          {editor && (
            <label className="lh-filter">
              <span>Country</span>
              <select
                value={country}
                onChange={(e) => {
                  setCountry(e.target.value);
                  setOffice(e.target.value === myCountry ? "mine" : "all");
                }}
              >
                {TIMEZ_COUNTRIES.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="lh-filter">
            <span>Location</span>
            <select value={effectiveOffice} onChange={(e) => setOffice(e.target.value)}>
              {viewingOwn && <option value="mine">My office{myPlace.location ? ` (${myPlace.location})` : ""}</option>}
              <option value="all">All offices</option>
              {offices.map((city) => (
                <option key={city} value={city}>
                  {city}
                  {regionOf(city) && regionOf(city) !== city ? ` · ${regionOf(city)}` : ""}
                </option>
              ))}
            </select>
          </label>
          <div className="lh-chips" role="group" aria-label="Holiday type">
            {HOLIDAY_TYPES.map((t) => (
              <button
                key={t}
                type="button"
                className={`lh-chip lh-chip-${t}${types.has(t) ? " is-on" : ""}`}
                aria-pressed={types.has(t)}
                onClick={() => toggleType(t)}
              >
                {HOLIDAY_TYPE_LABEL[t]}
              </button>
            ))}
          </div>
        </div>

        <div className="pc-hol-stats">
          <div>
            <span className="muted">Days off · {officeLabel}</span>
            <strong>{yearRows.length}</strong>
          </div>
          <div className="lh-stat-split">
            <span className="muted">By type</span>
            <span>
              {(["national", "company", "regional"] as Kind[]).map((k) => (
                <span key={k} className={`lh-dot lh-${k}`}>
                  {countBy(k)} {HOLIDAY_TYPE_LABEL[k as HolidayType].toLowerCase()}
                </span>
              ))}
              <span className="lh-dot lh-optional">{optionalRows.length} optional</span>
            </span>
          </div>
          {next && (
            <div className="pc-hol-next">
              <span className="muted">Next holiday</span>
              <strong>{next.name}</strong>
              <span className="muted">
                {longDate(next.date)}
                {whenText(next.date, today) ? ` · ${whenText(next.date, today)}` : ""}
              </span>
            </div>
          )}
        </div>
        <Banner message={loadError ? { tone: "err", text: loadError } : null} />

        {view === "list" &&
          (listedAll.length === 0 ? (
            <EmptyState title="No holidays listed" description={`Nothing for ${officeLabel} in ${year} with these filters.`} />
          ) : (
            <>
              {groups.length === 0 && <EmptyState title="No more holidays this year" description={`All ${listedAll.length} have passed.`} />}
              <div className="pc-hol-months">
                {groups.map((g) => (
                  <section key={g.m} className="pc-hol-month">
                    <h3>
                      {g.label} <span className="muted">· {g.rows.length}</span>
                    </h3>
                    <ul>
                      {g.rows.map((r) => {
                        const when = whenText(r.date, today);
                        return (
                          <li
                            key={`${r.kind}-${r.id}`}
                            className={`pc-hol-row lh-row-${r.kind}${r.date < today ? " is-past" : ""}${r.date === today ? " is-today" : ""}`}
                          >
                            <button type="button" className="pc-hol-open" onClick={() => setDetail(r.date)}>
                              <span className="pc-hol-date">
                                <strong>{Number(r.date.slice(-2))}</strong>
                                <span>{weekdayShort(r.date)}</span>
                              </span>
                              <span className="pc-hol-name">
                                <strong>{r.name}</strong>
                                <span className="muted">
                                  <span className={`lh-tag lh-${r.kind}`}>{KIND_LABEL[r.kind]}</span>
                                  {r.kind === "regional" || r.where !== "Whole country" ? ` ${r.where}` : ""}
                                  {r.pick ? ` · ${r.pick.toLowerCase()}` : ""}
                                  {viewingOwn && effectiveOffice !== "mine" && !r.applies ? " · not your office" : ""}
                                </span>
                              </span>
                              {when && <span className="pc-hol-when">{when}</span>}
                            </button>
                            {editor && r.kind !== "optional" && editable.has(r.id) && (
                              <span className="pc-hol-actions">
                                <button type="button" className="btn-ghost btn-tiny" onClick={() => setEditing(editHoliday(r.id))}>
                                  Edit
                                </button>
                                <ActionButton
                                  className="btn-ghost btn-tiny"
                                  toastError
                                  success={`Removed ${r.name}.`}
                                  onAction={() => removeHoliday(replaceHolidays, state.holidays, actor, r.id)}
                                >
                                  Remove
                                </ActionButton>
                              </span>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                ))}
              </div>
              {passed > 0 && (
                <button type="button" className="link-btn pc-hol-past" onClick={() => setShowPast(!showPast)}>
                  {showPast ? "Hide past holidays" : `Show ${passed} past ${passed === 1 ? "holiday" : "holidays"}`}
                </button>
              )}
            </>
          ))}

        {view === "calendar" && (
          <div className="holiday-year">
            {Array.from({ length: 12 }, (_, m) => (
              <section key={m} className="holiday-mini">
                <div className="holiday-mini-title">{MONTHS[m]}</div>
                <div className="cal cal-mini">
                  {WEEKDAYS.map((label) => (
                    <div key={label} className="cal-head">
                      {label[0]}
                    </div>
                  ))}
                  {monthCells(year, m).map((date, i) => (date ? dayCell(date) : <div key={`b-${i}`} />))}
                </div>
              </section>
            ))}
          </div>
        )}
        <p className="muted holiday-legend lh-legend">
          {(["national", "company", "regional"] as Kind[]).map((k) => (
            <span key={k} className="lh-legend-item">
              <span className={`lh-swatch lh-${k}`} /> {HOLIDAY_TYPE_LABEL[k as HolidayType]}
            </span>
          ))}
          <span className="lh-legend-item">
            <span className="hol-swatch is-optional" /> Optional
          </span>
          <span className="lh-legend-item">
            <span className="hol-swatch is-weekly" /> Weekly off
          </span>
        </p>
      </Card>

      {editor && officeSummary.length > 0 && (
        <Card title={`Days off by office · ${countryName(country)} ${year}`}>
          <ul className="lh-offices">
            {officeSummary.map((o) => (
              <li key={o.city}>
                <button type="button" className={`lh-office${effectiveOffice === o.city ? " is-on" : ""}`} onClick={() => setOffice(o.city)}>
                  <strong>{o.city}</strong>
                  <span className="muted">{o.region ?? "—"}</span>
                  <span className="lh-office-count">{o.daysOff}</span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {viewingOwn ? (
        <OptionalHolidaysCard />
      ) : (
        optionalRows.length > 0 && (
          <Card title={`Optional holidays · ${countryName(country)}`}>
            <ul className="pc-hol-optlist">
              {optionalRows.map((r) => (
                <li key={r.id}>
                  <strong>{r.name}</strong>
                  <span className="muted">
                    {formatShortDate(r.date)} · select by {formatShortDate(pickDeadline(optionalByDate.get(r.date)!))}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        )
      )}

      {detail && detailOptional && <OptionalHolidayDialog holiday={detailOptional} onClose={() => setDetail(null)} />}
      {detail && !detailOptional && (
        <HolidayDetail
          date={detail}
          row={detailRow}
          country={country}
          optionalDeadline={detailRow?.kind === "optional" && optionalByDate.get(detail) ? pickDeadline(optionalByDate.get(detail)!) : undefined}
          onClose={() => setDetail(null)}
          onEdit={
            editor && detailRow && detailRow.kind !== "optional" && editable.has(detailRow.id)
              ? () => {
                  setEditing(editHoliday(detailRow.id));
                  setDetail(null);
                }
              : undefined
          }
        />
      )}
      {icsOpen && <IcsPicker rows={icsRows} year={year} country={country} viewingOwn={viewingOwn} onClose={() => setIcsOpen(false)} />}
      {editing && (
        <HolidayEditor
          holiday={editing === "new" ? undefined : editing}
          country={country}
          defaultDate={thisYear ? today : `${year}-01-01`}
          onClose={() => setEditing(null)}
          onSave={(input) => saveHoliday(replaceHolidays, state.holidays, actor, input)}
        />
      )}
    </Page>
  );
}

function HolidayDetail({
  date,
  row,
  country,
  optionalDeadline,
  onClose,
  onEdit,
}: {
  date: string;
  row?: Row;
  country: string;
  optionalDeadline?: string;
  onClose: () => void;
  onEdit?: () => void;
}) {
  function addOne() {
    if (!row || row.kind === "weekly") return "Nothing to add.";
    downloadIcs(`${row.name.replace(/[^\w]+/g, "-").toLowerCase()}-${date}.ics`, buildHolidayIcs([{ ...row, optional: row.kind === "optional" }], row.name));
    return null;
  }
  return (
    <Dialog open title={row && row.kind !== "weekly" ? row.name : formatShortDate(date)} onClose={onClose}>
      <div className="stack">
        <dl className="hol-facts">
          <div>
            <dt>Date</dt>
            <dd>{longDate(date)}</dd>
          </div>
          <div>
            <dt>Type</dt>
            <dd>{row ? KIND_LABEL[row.kind] : "Working day"}</dd>
          </div>
          <div>
            <dt>Country</dt>
            <dd>{countryName(country)}</dd>
          </div>
          <div>
            <dt>Applies to</dt>
            <dd>{row && row.kind !== "weekly" ? row.where : "Whole country"}</dd>
          </div>
          {optionalDeadline && (
            <div>
              <dt>Select by</dt>
              <dd>{formatShortDate(optionalDeadline)}</dd>
            </div>
          )}
        </dl>
        <p>{row ? describe(row, country) : "No holiday on this date. It's a normal working day."}</p>
        <div className="form-actions">
          {row && row.kind !== "weekly" && (
            <ActionButton className="btn" onAction={addOne} toastError success={`${row.name} downloaded.`} doneLabel="Downloaded">
              Add to my calendar
            </ActionButton>
          )}
          {onEdit && (
            <button type="button" className="btn-ghost" onClick={onEdit}>
              Edit
            </button>
          )}
          <button type="button" className="btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/** Choose which holidays go into the .ics file (public ones and your selected optional ones are ticked). */
function IcsPicker({ rows, year, country, viewingOwn, onClose }: { rows: Row[]; year: number; country: string; viewingOwn: boolean; onClose: () => void }) {
  const [chosen, setChosen] = useState<Set<string>>(
    () => new Set(rows.filter((r) => r.kind !== "optional" || !viewingOwn || r.pick === "Selected").map((r) => r.id)),
  );
  const [upcomingOnly, setUpcomingOnly] = useState(true);
  const today = todayISO();
  const shown = rows.filter((r) => !upcomingOnly || r.date >= today);
  const toggle = (id: string) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const picked = shown.filter((r) => chosen.has(r.id));
  function download() {
    if (!picked.length) return "Choose at least one holiday.";
    downloadIcs(
      `holidays-${country}-${year}.ics`,
      buildHolidayIcs(
        picked.map((r) => ({ id: r.id, date: r.date, name: r.name, optional: r.kind === "optional" })),
        `Holidays ${countryName(country)} ${year}`,
      ),
    );
    notify(`${picked.length} ${picked.length === 1 ? "holiday" : "holidays"} saved to an .ics file. Open it to add them to your calendar.`);
    onClose();
    return null;
  }
  return (
    <Dialog open title={`Add to my calendar · ${year}`} onClose={onClose}>
      <div className="stack">
        <div className="row-gap hol-ics-tools">
          <label className="hol-check">
            <input type="checkbox" checked={upcomingOnly} onChange={(e) => setUpcomingOnly(e.target.checked)} /> Upcoming only
          </label>
          <button type="button" className="btn-ghost btn-tiny" onClick={() => setChosen(new Set(rows.map((r) => r.id)))}>
            Select all
          </button>
          <button type="button" className="btn-ghost btn-tiny" onClick={() => setChosen(new Set())}>
            Clear
          </button>
        </div>
        {shown.length === 0 ? (
          <EmptyState title="No holidays" description="Nothing left this year." />
        ) : (
          <ul className="hol-ics-list">
            {shown.map((r) => (
              <li key={r.id}>
                <label className="hol-check">
                  <input type="checkbox" checked={chosen.has(r.id)} onChange={() => toggle(r.id)} />
                  <span>
                    <strong>{r.name}</strong>
                    <span className="muted">
                      {" "}
                      · {formatShortDate(r.date)} · {KIND_LABEL[r.kind]}
                      {r.pick ? ` · ${r.pick.toLowerCase()}` : ""}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
        <div className="form-actions">
          <ActionButton className="btn" onAction={download} toastError disabled={!picked.length}>
            {`Download ${picked.length || ""} .ics`.replace("  ", " ")}
          </ActionButton>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function HolidayEditor({
  holiday,
  country,
  defaultDate,
  onClose,
  onSave,
}: {
  holiday?: Holiday;
  country: string;
  defaultDate: string;
  onClose: () => void;
  onSave: (input: HolidayInput) => Promise<string | null>;
}) {
  const [date, setDate] = useState(holiday?.date ?? defaultDate);
  const [name, setName] = useState(holiday?.name ?? "");
  const [description, setDescription] = useState(holiday?.description ?? "");
  const [type, setType] = useState<HolidayType>(holiday ? holidayKind(holiday) : "national");
  const [regions, setRegions] = useState<string[]>(holiday ? holidayRegions(holiday) : []);
  const [extra, setExtra] = useState("");
  const [legalEntity, setLegalEntity] = useState(holiday?.legalEntity ?? "");
  const [msg, setMsg] = useState<{ tone: "err"; text: string } | null>(null);
  const act = useAction();
  const homeCountry = holiday?.countryCode ?? country;
  const choices = [...new Set([...regionsOf(homeCountry), ...(OFFICES[homeCountry] ?? []), ...regions])];
  const toggle = (r: string) => setRegions((prev) => (prev.includes(r) ? prev.filter((x) => x !== r) : [...prev, r]));
  const scoped = type !== "national";
  return (
    <Dialog open title={holiday ? "Edit holiday" : `Add holiday · ${countryName(country)}`} onClose={onClose}>
      <form
        onSubmit={act.submit(
          async () => {
            const typed = extra
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
            const error = await onSave({
              id: holiday?.id,
              countryCode: homeCountry,
              date,
              name,
              description,
              holidayType: type,
              regions: scoped ? [...regions, ...typed] : [],
              legalEntity: scoped ? legalEntity : "",
            });
            setMsg(error ? { tone: "err", text: error } : null);
            return error;
          },
          { success: holiday ? `Saved ${name.trim()}.` : `Added ${name.trim()}.`, onSuccess: onClose },
        )}
      >
        <Banner message={msg} />
        <div className="form-grid">
          <Field label="Date">
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </Field>
          <Field label="Name">
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} required />
          </Field>
          <Field label="Type">
            <select value={type} onChange={(e) => setType(e.target.value as HolidayType)}>
              {HOLIDAY_TYPES.map((t) => (
                <option key={t} value={t}>
                  {KIND_LABEL[t]}
                </option>
              ))}
            </select>
          </Field>
          {scoped && (
            <Field label="Legal entity">
              <input value={legalEntity} onChange={(e) => setLegalEntity(e.target.value)} maxLength={200} placeholder="Every entity" />
            </Field>
          )}
          {scoped && (
            <Field label={type === "regional" ? "States / offices" : "Only for (optional)"} wide>
              <div className="lh-region-pick">
                {choices.map((r) => (
                  <label key={r} className="hol-check">
                    <input type="checkbox" checked={regions.includes(r)} onChange={() => toggle(r)} /> {r}
                  </label>
                ))}
                <input value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="Other states, comma separated" maxLength={300} />
              </div>
            </Field>
          )}
          <Field label="Description" wide>
            <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} />
          </Field>
        </div>
        <div className="form-actions">
          <SubmitButton action={act} className="btn">{holiday ? "Save" : "Add holiday"}</SubmitButton>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}
