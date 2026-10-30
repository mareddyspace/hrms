import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ActionButton, Banner, Card, DataTable, Dialog, EmptyState, Field, Page, StatusBadge, SubmitButton, Tabs, useAction } from "../components/ui.tsx";
import { OptionalHolidaysCard } from "../features/workforce/OptionalHolidaysPage.tsx";
import {
  getOptionalHolidayState,
  holidaysFor as optionalHolidaysFor,
  optionalRequestsFor,
  requestOn,
  subscribeOptionalHolidays,
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
type Row = { id: string; date: string; name: string; optional: boolean; pick?: string };

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const countryName = (code: string) => TIMEZ_COUNTRIES.find((c) => c.code === code)?.name ?? code;

/** Holidays by month, as a list or the whole year; HR picks a country and edits its holidays. */
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
    return pick?.status === "approved" ? "Picked" : pick?.status === "pending" ? "Waiting" : undefined;
  };
  const yearRows: Row[] = [
    ...holidays.filter((h) => h.date.startsWith(`${cursor.year}-`)).map((h) => ({ id: h.id, date: h.date, name: h.name, optional: false })),
    ...optional.filter((h) => !byDate.has(h.date)).map((h) => ({ id: h.id, date: h.date, name: h.name, optional: true, pick: pickText(h.date) })),
  ].sort((a, b) => a.date.localeCompare(b.date));
  const editable = new Set(holidaysForCountry(state.holidays, country as CountryCode).map((h) => h.id));
  const publicCount = yearRows.filter((r) => !r.optional).length;

  function move(delta: number) {
    if (view === "month") {
      const next = new Date(cursor.year, cursor.month + delta, 1);
      setCursor({ year: next.getFullYear(), month: next.getMonth() });
    } else {
      setCursor({ year: cursor.year + delta, month: cursor.month });
    }
  }

  function exportIcs() {
    // Public holidays, plus optional ones you picked (all optional ones when viewing another country).
    const events = yearRows.filter((r) => !r.optional || !viewingOwn || r.pick === "Picked");
    if (!events.length) return "No holidays to add for this year.";
    const text = buildHolidayIcs(events, `Holidays ${countryName(country)} ${cursor.year}`);
    downloadIcs(`holidays-${country}-${cursor.year}.ics`, text);
    return null;
  }

  const actor = { id: demoProfile.id, fullName: demoProfile.fullName, role: demoProfile.role };

  const dayCell = (date: string, compact = false) => {
    const holiday = byDate.get(date);
    const opt = holiday ? undefined : optionalByDate.get(date);
    const pick = opt ? pickText(date) : undefined;
    const weeklyOff = isWeeklyOffDate(date, schedule.weeklyOffDays);
    const cls = `day${holiday || pick === "Picked" ? " holiday" : opt ? " optional" : weeklyOff ? " weekend" : ""}${date === today ? " today" : ""}`;
    const title = holiday ? holiday.name : opt ? `${opt.name} (optional)` : weeklyOff ? "Weekly off" : undefined;
    if (compact) {
      return (
        <div key={date} className={cls} title={title ? `${formatShortDate(date)} · ${title}` : formatShortDate(date)}>
          {Number(date.slice(-2))}
        </div>
      );
    }
    const showOff = !holiday && !opt && weeklyOff && isPrimaryWeeklyOffLabel(date, schedule.weeklyOffDays);
    return (
      <div key={date} className={cls} title={title}>
        <strong>{Number(date.slice(-2))}</strong>
        {date === today && <span className="day-today-tag">Today</span>}
        {holiday ? holiday.name : opt ? `${opt.name} (optional${pick ? ` · ${pick.toLowerCase()}` : ""})` : showOff ? "Weekly off" : ""}
      </div>
    );
  };

  const heading = view === "month" ? monthLabel(cursor.year, cursor.month) : String(cursor.year);

  return (
    <Page title="Holiday calendar">
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
            <ActionButton className="btn-ghost" onAction={exportIcs} toastError doneLabel="Downloaded" busyLabel="Preparing…" success={`Holidays ${cursor.year} downloaded.`}>
              Add to my calendar
            </ActionButton>
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
            {editor && !viewingOwn && <span className="muted"> · {countryName(country)}</span>}
          </h2>
          <span className="form-actions" style={{ marginTop: 0 }}>
            <button className="btn-ghost" type="button" onClick={() => move(-1)}>
              Previous
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
          <DataTable
            headers={["Date", "Day", "Holiday", "Type", ...(editor ? [""] : [])]}
            rows={yearRows.map((r) => [
              formatShortDate(r.date),
              parseISODate(r.date).toLocaleDateString("en-US", { weekday: "short" }),
              r.name,
              r.optional ? (
                <StatusBadge key="t" status={r.pick ? `Optional · ${r.pick.toLowerCase()}` : "Optional"} tone="info" literal keepCase />
              ) : (
                <StatusBadge key="t" status="Public" tone="ok" literal keepCase />
              ),
              ...(editor
                ? [
                    !r.optional && editable.has(r.id) ? (
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
            empty={<EmptyState title="No holidays" description={`Nothing listed for ${cursor.year}.`} />}
          />
        )}

        {view === "year" && (
          <div className="holiday-year">
            {Array.from({ length: 12 }, (_, m) => (
              <section key={m} className="holiday-mini">
                <button type="button" className="link-btn holiday-mini-title" onClick={() => (setCursor({ year: cursor.year, month: m }), setView("month"))}>
                  {new Date(cursor.year, m, 1).toLocaleDateString("en-US", { month: "long" })}
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
          <span className="hol-swatch is-holiday" /> Holiday <span className="hol-swatch is-optional" /> Optional
        </p>
      </Card>
      {viewingOwn && <OptionalHolidaysCard />}
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
  onSave: (input: { id?: string; countryCode: string; date: string; name: string }) => Promise<string | null>;
}) {
  const [date, setDate] = useState(holiday?.date ?? defaultDate);
  const [name, setName] = useState(holiday?.name ?? "");
  const [msg, setMsg] = useState<{ tone: "err"; text: string } | null>(null);
  const act = useAction();
  return (
    <Dialog open title={holiday ? "Edit holiday" : `Add holiday · ${countryName(country)}`} onClose={onClose}>
      <form
        onSubmit={act.submit(
          async () => {
            const error = await onSave({ id: holiday?.id, countryCode: holiday?.countryCode ?? country, date, name });
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
