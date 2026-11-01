import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Link } from "react-router-dom";
import { ActionButton, Banner, Card, DataTable, Dialog, EmptyState, Field, Page, StatusBadge, SubmitButton, Tabs, notify, useAction } from "../components/ui.tsx";
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
import { isPrimaryWeeklyOffLabel, isWeeklyOffDate, scheduleForEmployee } from "../data/workSchedule.ts";
import { buildHolidayIcs, canEditHolidays, downloadIcs, loadApiHolidays, removeHoliday, saveHoliday } from "../data/holidayAdmin.ts";
import { API_ENABLED } from "../api/client.ts";
import {
  TIMEZ_COUNTRIES,
  formatShortDate,
  holidaysForCountry,
  holidaysForPerson,
  monthCells,
  monthLabel,
  parseISODate,
  todayISO,
  type CountryCode,
  type Holiday,
} from "../model.ts";
import { usePortal } from "../store.tsx";
import "./holidays.css";

type View = "month" | "list" | "year";
type Kind = "public" | "regional" | "optional" | "weekly";
type Row = { id: string; date: string; name: string; kind: Kind; region?: string; description?: string; pick?: string };

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const KIND_LABEL: Record<Kind, string> = { public: "Public holiday", regional: "Regional holiday", optional: "Optional holiday", weekly: "Weekly off" };
const countryName = (code: string) => TIMEZ_COUNTRIES.find((c) => c.code === code)?.name ?? code;
const longDate = (iso: string) => parseISODate(iso).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

function describe(row: Row, country: string): string {
  if (row.description) return row.description;
  if (row.kind === "public") return `Public holiday in ${countryName(country)}. Offices are closed and it doesn't count as leave.`;
  if (row.kind === "regional") return `Holiday for the ${row.region} region of ${countryName(country)} only.`;
  if (row.kind === "optional") return "Optional holiday. Select it to take the day off; it counts against your yearly optional holiday limit.";
  return "Weekly day off under your work schedule.";
}

/** Holidays by month, as a list or the whole year; details on click; .ics export of chosen holidays. HR edits per country. */
export function HolidaysPage() {
  const today = todayISO();
  const { state, employee, demoProfile, replaceHolidays } = usePortal();
  const editor = canEditHolidays(demoProfile.role);
  const myCountry = String(employee.countryCode ?? "IN");
  const [country, setCountry] = useState(myCountry);
  const viewingOwn = country === myCountry;
  const [view, setView] = useState<View>("month");
  const now = new Date();
  const [cursor, setCursor] = useState({ year: now.getFullYear(), month: now.getMonth() });
  const [editing, setEditing] = useState<Holiday | "new" | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [icsOpen, setIcsOpen] = useState(false);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<"" | Kind>("");
  const [month, setMonth] = useState("");
  const [region, setRegion] = useState("");

  // Backend mode: the year's list from the server, into portal state (so leave counts and other pages agree).
  useEffect(() => {
    if (!API_ENABLED) return;
    let live = true;
    void loadApiHolidays(replaceHolidays, country, cursor.year, editor).then((e) => live && setLoadError(e));
    return () => {
      live = false;
    };
    // replaceHolidays is rebuilt with state; reload only when the country or year changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [country, cursor.year, editor]);

  const holidays = useMemo(
    () => (viewingOwn ? holidaysForPerson(state.holidays, employee.id) : holidaysForCountry(state.holidays, country as CountryCode)),
    [state.holidays, employee.id, country, viewingOwn],
  );
  const byDate = useMemo(() => new Map(holidays.map((h) => [h.date, h])), [holidays]);
  const optionalState = useSyncExternalStore(subscribeOptionalHolidays, getOptionalHolidayState, getOptionalHolidayState);
  const optional = optionalHolidaysFor(country, cursor.year, optionalState, viewingOwn);
  const optionalByDate = new Map(optional.map((h) => [h.date, h]));
  const myOptional = viewingOwn ? optionalRequestsFor(state.leaveRequests, employee.id, cursor.year) : [];
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
  const yearRows: Row[] = [
    ...holidays
      .filter((h) => h.date.startsWith(`${cursor.year}-`))
      .map((h) => ({
        id: h.id,
        date: h.date,
        name: h.name,
        kind: (h.region ? "regional" : "public") as Kind,
        region: h.region,
        description: h.description,
      })),
    ...optional
      .filter((h) => !byDate.has(h.date))
      .map((h) => ({ id: h.id, date: h.date, name: h.name, kind: "optional" as Kind, region: h.region, description: h.description, pick: pickText(h.date) })),
  ].sort((a, b) => a.date.localeCompare(b.date));
  const regions = [...new Set(yearRows.map((r) => r.region).filter(Boolean) as string[])];
  const weeklyRows: Row[] = useMemo(() => {
    if (kind !== "weekly") return [];
    const out: Row[] = [];
    for (let d = new Date(cursor.year, 0, 1); d.getFullYear() === cursor.year; d.setDate(d.getDate() + 1)) {
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      if (schedule.weeklyOffDays.includes(d.getDay())) out.push({ id: `wo-${iso}`, date: iso, name: "Weekly off", kind: "weekly" });
    }
    return out;
  }, [kind, cursor.year, schedule.weeklyOffDays]);
  const listRows = (kind === "weekly" ? weeklyRows : yearRows).filter(
    (r) =>
      (!kind || r.kind === kind) &&
      (!month || r.date.slice(5, 7) === month) &&
      (!region || (region === "national" ? !r.region : r.region === region)) &&
      (!q.trim() || `${r.name} ${r.description ?? ""} ${r.region ?? ""}`.toLowerCase().includes(q.trim().toLowerCase())),
  );
  const editable = new Set(holidaysForCountry(state.holidays, country as CountryCode).map((h) => h.id));
  const publicCount = yearRows.filter((r) => r.kind !== "optional").length;
  const upcoming = yearRows.find((r) => r.date >= today && r.kind !== "optional");

  function move(delta: number) {
    if (view === "month") {
      const next = new Date(cursor.year, cursor.month + delta, 1);
      setCursor({ year: next.getFullYear(), month: next.getMonth() });
    } else {
      setCursor({ year: cursor.year + delta, month: cursor.month });
    }
  }

  function goToday() {
    setCursor({ year: now.getFullYear(), month: now.getMonth() });
    if (view === "list") setMonth(String(now.getMonth() + 1).padStart(2, "0"));
  }

  const actor = { id: demoProfile.id, fullName: demoProfile.fullName, role: demoProfile.role };

  const rowOn = (date: string): Row | undefined => {
    const holiday = byDate.get(date);
    if (holiday) return yearRows.find((r) => r.id === holiday.id) ?? { id: holiday.id, date, name: holiday.name, kind: holiday.region ? "regional" : "public", region: holiday.region, description: holiday.description };
    const opt = optionalByDate.get(date);
    if (opt) return { id: opt.id, date, name: opt.name, kind: "optional", region: opt.region, description: opt.description, pick: pickText(date) };
    if (isWeeklyOffDate(date, schedule.weeklyOffDays)) return { id: `wo-${date}`, date, name: "Weekly off", kind: "weekly" };
    return undefined;
  };

  const dayCell = (date: string, compact = false) => {
    const row = rowOn(date);
    const cls = [
      "day",
      "hol-day",
      row?.kind === "public" || row?.kind === "regional" ? "holiday" : "",
      row?.kind === "regional" ? "regional" : "",
      row?.kind === "optional" ? (row.pick === "Selected" ? "optional picked" : "optional") : "",
      row?.kind === "weekly" ? "weekend" : "",
      date === today ? "today" : "",
      date === detail ? "selected" : "",
    ]
      .filter(Boolean)
      .join(" ");
    const title = row ? `${formatShortDate(date)} · ${row.kind === "weekly" ? "Weekly off" : `${row.name} (${KIND_LABEL[row.kind].toLowerCase()})`}` : formatShortDate(date);
    if (compact) {
      return (
        <button key={date} type="button" className={cls} title={title} aria-label={title} onClick={() => setDetail(date)}>
          {Number(date.slice(-2))}
        </button>
      );
    }
    const showOff = row?.kind === "weekly" && isPrimaryWeeklyOffLabel(date, schedule.weeklyOffDays);
    return (
      <button key={date} type="button" className={cls} title={title} aria-label={title} onClick={() => setDetail(date)}>
        <strong>{Number(date.slice(-2))}</strong>
        {date === today && <span className="day-today-tag">Today</span>}
        {row && row.kind !== "weekly" ? (
          <span className="hol-day-name">
            {row.name}
            {row.kind === "optional" ? ` (optional${row.pick ? ` · ${row.pick.toLowerCase()}` : ""})` : row.kind === "regional" ? " (regional)" : ""}
          </span>
        ) : showOff ? (
          <span className="hol-day-name">Weekly off</span>
        ) : null}
      </button>
    );
  };

  const heading = view === "month" ? monthLabel(cursor.year, cursor.month) : String(cursor.year);
  const detailRow = detail ? rowOn(detail) : undefined;
  const detailOptional: OptionalHoliday | undefined = detail && viewingOwn && detailRow?.kind === "optional" ? optionalByDate.get(detail) : undefined;

  return (
    <Page title="Holiday calendar" action={<Link className="btn-ghost" to="/workforce/optional-holidays">Optional holidays</Link>}>
      {upcoming && (
        <p className="note hol-next">
          Next holiday: <strong>{upcoming.name}</strong> · {longDate(upcoming.date)}
        </p>
      )}
      <Card>
        <div className="holiday-toolbar">
          <Tabs
            tabs={[
              { id: "month", label: "Month" },
              { id: "list", label: "List" },
              { id: "year", label: "Year" },
            ]}
            value={view}
            onChange={(v) => setView(v as View)}
          />
          <span className="form-actions holiday-tools">
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
        <div className="row-between holiday-nav">
          <h2 className="card-title" style={{ margin: 0 }}>
            {heading}
            <span className="muted"> · {countryName(country)}</span>
          </h2>
          <span className="form-actions" style={{ marginTop: 0 }}>
            <button className="btn-ghost" type="button" onClick={() => move(-1)}>
              Previous
            </button>
            <button className="btn-ghost" type="button" onClick={goToday}>
              Today
            </button>
            <button className="btn-ghost" type="button" onClick={() => move(1)}>
              Next
            </button>
          </span>
        </div>
        <Banner message={loadError ? { tone: "err", text: loadError } : null} />

        {view === "month" && (
          <div className="cal">
            {WEEKDAYS.map((label) => (
              <div key={label} className="cal-head">
                {label}
              </div>
            ))}
            {monthCells(cursor.year, cursor.month).map((date, index) => (date ? dayCell(date) : <div key={`blank-${index}`} />))}
          </div>
        )}

        {view === "list" && (
          <>
            <div className="hol-filters">
              <label className="filter-label">
                Search
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Holiday name…" />
              </label>
              <label className="filter-label">
                Type
                <select value={kind} onChange={(e) => setKind(e.target.value as "" | Kind)}>
                  <option value="">All holidays</option>
                  <option value="public">Public</option>
                  <option value="regional">Regional</option>
                  <option value="optional">Optional</option>
                  <option value="weekly">Weekly offs</option>
                </select>
              </label>
              <label className="filter-label">
                Month
                <select value={month} onChange={(e) => setMonth(e.target.value)}>
                  <option value="">All</option>
                  {MONTHS.map((m, i) => (
                    <option key={m} value={String(i + 1).padStart(2, "0")}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>
              <label className="filter-label">
                Year
                <select value={cursor.year} onChange={(e) => setCursor({ ...cursor, year: Number(e.target.value) })}>
                  {[cursor.year - 1, cursor.year, cursor.year + 1].map((y) => (
                    <option key={y} value={y}>
                      {y}
                    </option>
                  ))}
                </select>
              </label>
              <label className="filter-label">
                Region
                <select value={region} onChange={(e) => setRegion(e.target.value)}>
                  <option value="">All</option>
                  <option value="national">Whole country</option>
                  {regions.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </label>
              {(q || kind || month || region) && (
                <button type="button" className="btn-ghost btn-tiny" onClick={() => (setQ(""), setKind(""), setMonth(""), setRegion(""))}>
                  Clear
                </button>
              )}
            </div>
            <DataTable
              headers={["Date", "Day", "Holiday", "Type", ...(editor ? [""] : [])]}
              rows={listRows.map((r) => [
                formatShortDate(r.date),
                parseISODate(r.date).toLocaleDateString("en-US", { weekday: "short" }),
                <button key="n" type="button" className="link-btn" onClick={() => setDetail(r.date)}>
                  {r.name}
                </button>,
                r.kind === "optional" ? (
                  <StatusBadge key="t" status={r.pick ? `Optional · ${r.pick.toLowerCase()}` : "Optional"} tone="info" literal keepCase />
                ) : r.kind === "weekly" ? (
                  <StatusBadge key="t" status="Weekly off" tone="neutral" literal keepCase />
                ) : (
                  <StatusBadge key="t" status={r.kind === "regional" ? `Regional · ${r.region}` : "Public"} tone="ok" literal keepCase />
                ),
                ...(editor
                  ? [
                      (r.kind === "public" || r.kind === "regional") && editable.has(r.id) ? (
                        <span key="a" className="form-actions" style={{ marginTop: 0 }}>
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
                      ) : (
                        ""
                      ),
                    ]
                  : []),
              ])}
              empty={<EmptyState title="No holidays" description={q || kind || month || region ? "Nothing matches the filters." : `Nothing listed for ${cursor.year}.`} />}
            />
          </>
        )}

        {view === "year" && (
          <div className="holiday-year">
            {Array.from({ length: 12 }, (_, m) => (
              <section key={m} className="holiday-mini">
                <button type="button" className="link-btn holiday-mini-title" onClick={() => (setCursor({ year: cursor.year, month: m }), setView("month"))}>
                  {MONTHS[m]}
                </button>
                <div className="cal cal-mini">
                  {WEEKDAYS.map((label) => (
                    <div key={label} className="cal-head">
                      {label[0]}
                    </div>
                  ))}
                  {monthCells(cursor.year, m).map((date, i) => (date ? dayCell(date, true) : <div key={`b-${i}`} />))}
                </div>
              </section>
            ))}
          </div>
        )}

        <p className="muted holiday-legend">
          {publicCount} public · {yearRows.length - publicCount} optional in {cursor.year}
          <span className="hol-swatch is-holiday" /> Public
          {regions.length > 0 && (
            <>
              <span className="hol-swatch is-regional" /> Regional
            </>
          )}
          <span className="hol-swatch is-optional" /> Optional
          <span className="hol-swatch is-picked" /> Selected
          <span className="hol-swatch is-weekly" /> Weekly off
        </p>
      </Card>
      {viewingOwn && <OptionalHolidaysCard />}

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
      {icsOpen && (
        <IcsPicker
          rows={yearRows}
          year={cursor.year}
          country={country}
          viewingOwn={viewingOwn}
          onClose={() => setIcsOpen(false)}
        />
      )}
      {editing && (
        <HolidayEditor
          holiday={editing === "new" ? undefined : editing}
          country={country}
          defaultDate={view === "month" ? `${cursor.year}-${String(cursor.month + 1).padStart(2, "0")}-01` : `${cursor.year}-01-01`}
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
        <p className="muted">Pick the holidays to add. You get an .ics file for Google, Outlook or Apple Calendar.</p>
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
