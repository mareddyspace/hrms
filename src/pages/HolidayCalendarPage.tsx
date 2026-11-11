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
import { buildHolidayIcs, canEditHolidays, downloadIcs, loadApiHolidays, removeHoliday, saveHoliday } from "../data/holidayAdmin.ts";
import { API_ENABLED } from "../api/client.ts";
import {
  TIMEZ_COUNTRIES,
  formatShortDate,
  holidaysForCountry,
  holidaysForPerson,
  monthCells,
  parseISODate,
  todayISO,
  type CountryCode,
  type Holiday,
} from "../model.ts";
import { usePortal } from "../store.tsx";
import "./holidays.css";
import "../styles/pay-claims.css";

type View = "list" | "calendar";
type Kind = "public" | "regional" | "optional" | "weekly";
type Row = { id: string; date: string; name: string; kind: Kind; region?: string; description?: string; pick?: string };

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const KIND_LABEL: Record<Kind, string> = { public: "Public holiday", regional: "Regional holiday", optional: "Optional holiday", weekly: "Weekly off" };
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
  if (row.kind === "public") return `Public holiday in ${countryName(country)}. Offices are closed and it doesn't count as leave.`;
  if (row.kind === "regional") return `Holiday for the ${row.region} region of ${countryName(country)} only.`;
  if (row.kind === "optional") return "Optional holiday. Select it to take the day off; it counts against your yearly optional holiday limit.";
  return "Weekly day off under your work schedule.";
}

/** The viewer's public holidays for a year, grouped by month (or as a year calendar); optional holidays in their own card. HR edits per country. */
export function HolidaysPage() {
  const today = todayISO();
  const currentYear = Number(today.slice(0, 4));
  const { state, employee, demoProfile, replaceHolidays } = usePortal();
  const editor = canEditHolidays(demoProfile.role);
  const myCountry = String(employee.countryCode ?? "IN");
  const [country, setCountry] = useState(myCountry);
  const viewingOwn = country === myCountry;
  const [view, setView] = useState<View>("list");
  const [year, setYear] = useState(currentYear);
  const [showPast, setShowPast] = useState(true);
  const [editing, setEditing] = useState<Holiday | "new" | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [icsOpen, setIcsOpen] = useState(false);

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

  const holidays = useMemo(
    () => (viewingOwn ? holidaysForPerson(state.holidays, employee.id) : holidaysForCountry(state.holidays, country as CountryCode)),
    [state.holidays, employee.id, country, viewingOwn],
  );
  const byDate = useMemo(() => new Map(holidays.map((h) => [h.date, h])), [holidays]);
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
  const publicRows: Row[] = holidays
    .filter((h) => h.date.startsWith(`${year}-`))
    .map((h) => ({ id: h.id, date: h.date, name: h.name, kind: (h.region ? "regional" : "public") as Kind, region: h.region, description: h.description }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const optionalRows: Row[] = optional
    .filter((h) => !byDate.has(h.date))
    .map((h) => ({ id: h.id, date: h.date, name: h.name, kind: "optional" as Kind, region: h.region, description: h.description, pick: pickText(h.date) }));
  const icsRows = [...publicRows, ...optionalRows].sort((a, b) => a.date.localeCompare(b.date));
  const thisYear = year === currentYear;
  const upcoming = publicRows.filter((r) => r.date >= today);
  const next = upcoming[0];
  const passed = thisYear ? publicRows.length - upcoming.length : 0;
  const listed = thisYear && !showPast ? upcoming : publicRows;
  const groups = MONTHS.map((label, m) => ({ label, m, rows: listed.filter((r) => Number(r.date.slice(5, 7)) - 1 === m) })).filter((g) => g.rows.length);
  const editable = new Set(holidaysForCountry(state.holidays, country as CountryCode).map((h) => h.id));
  const actor = { id: demoProfile.id, fullName: demoProfile.fullName, role: demoProfile.role };

  const rowOn = (date: string): Row | undefined => {
    const holiday = byDate.get(date);
    if (holiday) {
      return (
        publicRows.find((r) => r.id === holiday.id) ?? {
          id: holiday.id,
          date,
          name: holiday.name,
          kind: holiday.region ? "regional" : "public",
          region: holiday.region,
          description: holiday.description,
        }
      );
    }
    const opt = optionalByDate.get(date);
    if (opt) return { id: opt.id, date, name: opt.name, kind: "optional", region: opt.region, description: opt.description, pick: pickText(date) };
    return undefined;
  };

  const dayCell = (date: string) => {
    const row = rowOn(date);
    const cls = [
      "day",
      "hol-day",
      row?.kind === "public" || row?.kind === "regional" ? "holiday" : "",
      row?.kind === "regional" ? "regional" : "",
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
            {editor && (
              <select aria-label="Country" value={country} onChange={(e) => setCountry(e.target.value)}>
                {TIMEZ_COUNTRIES.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
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

        <div className="pc-hol-stats">
          <div>
            <span className="muted">Public holidays · {countryName(country)}</span>
            <strong>{publicRows.length}</strong>
          </div>
          {thisYear && (
            <div>
              <span className="muted">Still to come</span>
              <strong>{upcoming.length}</strong>
            </div>
          )}
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
          (publicRows.length === 0 ? (
            <EmptyState title="No holidays listed" description={`Nothing for ${countryName(country)} in ${year} yet.`} />
          ) : (
            <>
              {groups.length === 0 && <EmptyState title="No more holidays this year" description={`All ${publicRows.length} have passed.`} />}
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
                          <li key={r.id} className={`pc-hol-row${r.date < today ? " is-past" : ""}${r.date === today ? " is-today" : ""}`}>
                            <button type="button" className="pc-hol-open" onClick={() => setDetail(r.date)}>
                              <span className="pc-hol-date">
                                <strong>{Number(r.date.slice(-2))}</strong>
                                <span>{weekdayShort(r.date)}</span>
                              </span>
                              <span className="pc-hol-name">
                                <strong>{r.name}</strong>
                                {r.region && <span className="muted">{r.region} only</span>}
                              </span>
                              {when && <span className="pc-hol-when">{when}</span>}
                            </button>
                            {editor && editable.has(r.id) && (
                              <span className="pc-hol-actions">
                                <button type="button" className="btn-ghost btn-tiny" onClick={() => setEditing(holidays.find((h) => h.id === r.id) ?? null)}>
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
          <>
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
            <p className="muted holiday-legend">
              <span className="hol-swatch is-holiday" /> Public holiday
              {optionalRows.length > 0 && (
                <>
                  <span className="hol-swatch is-optional" /> Optional
                </>
              )}
              <span className="hol-swatch is-weekly" /> Weekly off
            </p>
          </>
        )}
      </Card>

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
            editor && detailRow && editable.has(detailRow.id)
              ? () => {
                  setEditing(holidays.find((h) => h.id === detailRow.id) ?? null);
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
            <dt>Region</dt>
            <dd>{row?.region ?? "Whole country"}</dd>
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
  onSave: (input: { id?: string; countryCode: string; date: string; name: string; description?: string }) => Promise<string | null>;
}) {
  const [date, setDate] = useState(holiday?.date ?? defaultDate);
  const [name, setName] = useState(holiday?.name ?? "");
  const [description, setDescription] = useState(holiday?.description ?? "");
  const [msg, setMsg] = useState<{ tone: "err"; text: string } | null>(null);
  const act = useAction();
  return (
    <Dialog open title={holiday ? "Edit holiday" : `Add holiday · ${countryName(country)}`} onClose={onClose}>
      <form
        onSubmit={act.submit(
          async () => {
            const error = await onSave({ id: holiday?.id, countryCode: holiday?.countryCode ?? country, date, name, description });
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
