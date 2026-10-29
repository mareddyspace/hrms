import { useState, useSyncExternalStore } from "react";
import { ActionButton, Banner, Card, DataTable, EmptyState, Field, MetricCard, MetricGrid, Page, StatusBadge, SubmitButton, Tabs, notify, useAction } from "../../components/ui.tsx";
import { usePortal } from "../../store.tsx";
import { todayISO, TIMEZ_COUNTRIES } from "../../model.ts";
import { taskTeamFor } from "../../data/taskTeam.ts";
import {
  addOptionalHoliday,
  CANCEL_CUTOFF_DAYS,
  cancelDeadline,
  cancelOptionalPick,
  countryName,
  countryOf,
  getOptionalHolidayState,
  holidaysFor,
  limitFor,
  MAX_LIMIT,
  pickOptionalHoliday,
  picksFor,
  removeOptionalHoliday,
  setYearlyLimit,
  subscribeOptionalHolidays,
  teamPicks,
} from "./optionalHolidaysStore.ts";
import { fmt, isHrRole, shortDay, type WorkforceActor } from "./workforceShared.ts";
import "./workforce.css";

type Msg = { tone: "ok" | "err" | "warn" | "info"; text: string } | null;

function useOptional() {
  return useSyncExternalStore(subscribeOptionalHolidays, getOptionalHolidayState, getOptionalHolidayState);
}

function result(error: string | null, ok: string): Msg {
  return error ? { tone: "err", text: error } : { tone: "ok", text: ok };
}

const currentYear = () => Number(todayISO().slice(0, 4));

/** Drop-in card for the Holiday calendar: the signed-in person's optional holidays and picks. */
export function OptionalHolidaysCard({ title = "Optional holidays" }: { title?: string }) {
  const { demoProfile } = usePortal();
  const actor: WorkforceActor = demoProfile;
  const data = useOptional();
  const [msg, setMsg] = useState<Msg>(null);
  const year = currentYear();
  const today = todayISO();
  const country = countryOf(actor.id);
  const limit = limitFor(country, data);
  const list = holidaysFor(country, year, data);
  const picks = picksFor(actor.id, year, data);
  const left = Math.max(0, limit - picks.length);
  /** Shows the result in the card banner; false tells the button it failed. */
  const show = (error: string | null, ok: string) => {
    setMsg(result(error, ok));
    return error ? false : true;
  };

  return (
    <Card title={title} action={<span className="muted">{`${picks.length} of ${limit} picked`}</span>}>
      <div className="stack">
        <Banner message={msg} />
        {list.length === 0 || limit === 0 ? (
          <EmptyState title="No optional holidays" description={`None set for ${countryName(country)} in ${year}.`} />
        ) : (
          <ul className="approval-list">
            {list.map((h) => {
              const pick = picks.find((p) => p.holiday.id === h.id)?.pick;
              const past = h.date <= today;
              const canCancel = pick && today <= cancelDeadline(h.date);
              return (
                <li key={h.id} className="approval-item">
                  <div className="row-between wf-wrap">
                    <strong>{h.name}</strong>
                    {pick ? (
                      <StatusBadge status={past ? "Taken" : "Picked"} tone="ok" literal />
                    ) : past ? (
                      <StatusBadge status="Passed" tone="neutral" literal />
                    ) : null}
                  </div>
                  <span className="muted">{shortDay(h.date)}</span>
                  {!past && (
                    <div className="approval-actions">
                      {pick ? (
                        canCancel ? (
                          <ActionButton
                            className="btn-ghost btn-tiny"
                            success={`${h.name} pick cancelled.`}
                            onAction={() => show(cancelOptionalPick(actor, pick.id), `${h.name} cancelled.`)}
                          >
                            Cancel pick
                          </ActionButton>
                        ) : (
                          <span className="muted">Can't cancel within {CANCEL_CUTOFF_DAYS} days</span>
                        )
                      ) : (
                        <ActionButton
                          className="btn btn-tiny"
                          disabled={left === 0}
                          busyLabel="Picking…"
                          doneLabel="Picked"
                          success={`${h.name} added to your holidays.`}
                          onAction={() => show(pickOptionalHoliday(actor, h.id), `${h.name} added to your holidays.`)}
                        >
                          Pick
                        </ActionButton>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Card>
  );
}

export function OptionalHolidaysPage() {
  const { demoProfile } = usePortal();
  const actor: WorkforceActor = demoProfile;
  const team = taskTeamFor(actor.id);
  const hr = isHrRole(actor.role);
  const tabs = [
    { id: "mine", label: "My picks" },
    ...(team.length ? [{ id: "team", label: "Team picks" }] : []),
    ...(hr ? [{ id: "setup", label: "Setup" }] : []),
  ];
  const [tab, setTab] = useState("mine");
  const active = tabs.some((t) => t.id === tab) ? tab : "mine";

  return (
    <Page title="Optional holidays">
      {tabs.length > 1 && <Tabs tabs={tabs} value={active} onChange={setTab} />}
      {active === "mine" && <OptionalHolidaysCard title={`Your picks · ${currentYear()}`} />}
      {active === "team" && <TeamPicks actor={actor} />}
      {active === "setup" && <Setup actor={actor} />}
    </Page>
  );
}

function TeamPicks({ actor }: { actor: WorkforceActor }) {
  const data = useOptional();
  const year = currentYear();
  const today = todayISO();
  const rows = teamPicks(actor.id, year, data).sort((a, b) => a.holiday.date.localeCompare(b.holiday.date));
  const upcoming = rows.filter((r) => r.holiday.date > today);

  return (
    <>
      <MetricGrid>
        <MetricCard label="Upcoming team picks" value={upcoming.length} />
        <MetricCard label="Next" value={upcoming[0] ? fmt(upcoming[0].holiday.date) : "—"} hint={upcoming[0]?.personName} />
      </MetricGrid>
      <Card title={`Team picks · ${year}`}>
        <DataTable
          headers={["Person", "Holiday", "Date", "Picked on"]}
          rows={rows.map((r) => [r.personName, r.holiday.name, shortDay(r.holiday.date), fmt(r.pick.pickedOn)])}
          empty={<EmptyState title="No picks yet" />}
        />
      </Card>
    </>
  );
}

function Setup({ actor }: { actor: WorkforceActor }) {
  const data = useOptional();
  const { state } = usePortal();
  const year = currentYear();
  const [country, setCountry] = useState<string>("IN");
  const [msg, setMsg] = useState<Msg>(null);
  const [limitInput, setLimitInput] = useState<string>("");
  const [date, setDate] = useState("");
  const [name, setName] = useState("");
  const limit = limitFor(country, data);
  const list = holidaysFor(country, year, data).concat(holidaysFor(country, year + 1, data));
  const pickCount = (id: string) => data.picks.filter((p) => p.holidayId === id && p.status === "picked").length;

  const limitAction = useAction();
  const addAction = useAction();

  function saveLimit(): boolean {
    const raw = limitInput.trim();
    const value = raw === "" ? NaN : Number(raw);
    const error = setYearlyLimit(actor, country, value);
    setMsg(result(error, `Yearly limit for ${countryName(country)} set to ${value}.`));
    if (error) return false;
    setLimitInput("");
    notify(`Yearly limit for ${countryName(country)} set to ${value}.`);
    return true;
  }

  function add(): boolean {
    const error = addOptionalHoliday(actor, { countryCode: country, date, name }, state.holidays);
    setMsg(result(error, `${name.trim()} added.`));
    if (error) return false;
    notify(`${name.trim()} added as an optional holiday.`);
    setDate("");
    setName("");
    return true;
  }

  return (
    <>
      <Banner message={msg} />
      <Card title="Country">
        <div className="form-grid-2">
          <Field label="Country">
            <select value={country} onChange={(e) => { setCountry(e.target.value); setMsg(null); }}>
              {TIMEZ_COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <form className="wf-inline-form" onSubmit={limitAction.submit(saveLimit)}>
            <Field label={`Picks per year (now ${limit})`}>
              <input type="number" min={0} max={MAX_LIMIT} step={1} placeholder={String(limit)} value={limitInput} onChange={(e) => setLimitInput(e.target.value)} />
            </Field>
            <SubmitButton action={limitAction} className="btn-ghost">Save limit</SubmitButton>
          </form>
        </div>
      </Card>
      <Card title={`Optional holidays · ${countryName(country)}`}>
        <DataTable
          headers={["Holiday", "Date", "Picked by", ""]}
          rows={list.map((h) => [
            h.name,
            shortDay(h.date),
            pickCount(h.id),
            <ActionButton
              key="r"
              className="btn-ghost btn-tiny"
              success={`${h.name} removed.`}
              onAction={() => {
                const error = removeOptionalHoliday(actor, h.id);
                setMsg(result(error, `${h.name} removed.`));
                return error ? false : true;
              }}
            >
              Remove
            </ActionButton>,
          ])}
          empty={<EmptyState title="No optional holidays yet" />}
        />
      </Card>
      <Card title="Add an optional holiday">
        <form className="stack" onSubmit={addAction.submit(add)}>
          <div className="form-grid-2">
            <Field label="Name">
              <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Date">
              <input type="date" value={date} min={todayISO()} onChange={(e) => setDate(e.target.value)} />
            </Field>
          </div>
          <div className="row-gap">
            <SubmitButton action={addAction} className="btn">Add holiday</SubmitButton>
          </div>
        </form>
      </Card>
    </>
  );
}
