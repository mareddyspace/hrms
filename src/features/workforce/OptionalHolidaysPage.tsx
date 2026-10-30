import { useState, useSyncExternalStore } from "react";
import { Link } from "react-router-dom";
import { ActionButton, Banner, Card, DataTable, EmptyState, Field, MetricCard, MetricGrid, Page, StatusBadge, SubmitButton, Tabs, notify, useAction } from "../../components/ui.tsx";
import { usePortal } from "../../store.tsx";
import { todayISO, TIMEZ_COUNTRIES, type LeaveCode, type LeaveRequest } from "../../model.ts";
import { taskTeamFor } from "../../data/taskTeam.ts";
import { managementChain } from "../../demoAccounts.ts";
import { API_ENABLED } from "../../api/client.ts";
import { refreshApiOptional } from "../../api/syncOptionalHolidays.ts";
import {
  addOptionalHoliday,
  countryName,
  countryOf,
  getOptionalHolidayState,
  holidaysFor,
  localPickCount,
  OPTIONAL_CODE,
  optionalRequestsFor,
  removeOptionalHoliday,
  requestOn,
  subscribeOptionalHolidays,
  type OptionalHoliday,
} from "./optionalHolidaysStore.ts";
import { fmt, isHrRole, shortDay, type WorkforceActor } from "./workforceShared.ts";
import "./workforce.css";

type Msg = { tone: "ok" | "err" | "warn" | "info"; text: string } | null;

function useOptional() {
  return useSyncExternalStore(subscribeOptionalHolidays, getOptionalHolidayState, getOptionalHolidayState);
}

const currentYear = () => Number(todayISO().slice(0, 4));

const STATUS: Record<string, [string, "ok" | "warn" | "danger" | "neutral"]> = {
  pending: ["Waiting for approval", "warn"],
  approved: ["Approved", "ok"],
  rejected: ["Declined", "danger"],
  withdrawn: ["Withdrawn", "neutral"],
};

function PickStatus({ request, past }: { request?: LeaveRequest; past: boolean }) {
  if (!request || request.status === "withdrawn") return past ? <StatusBadge status="Passed" tone="neutral" literal /> : null;
  const [text, tone] = request.status === "approved" && past ? ["Taken", "ok" as const] : (STATUS[request.status] ?? [request.status, "neutral" as const]);
  return <StatusBadge status={text} tone={tone} literal />;
}

/** The signed-in person's optional holidays: pick (sent to the manager), withdraw, and what's left this year. */
export function OptionalHolidaysCard({ title = "Optional holidays" }: { title?: string }) {
  const { demoProfile, state, leaveTable, applyLeave, setLeaveStatus } = usePortal();
  const actor: WorkforceActor = demoProfile;
  useOptional();
  const [msg, setMsg] = useState<Msg>(null);
  const year = currentYear();
  const today = todayISO();
  const country = countryOf(actor.id);
  const balance = leaveTable.find((r) => r.code === OPTIONAL_CODE);
  const limit = balance?.quota ?? 0;
  const left = balance?.available ?? 0;
  const list = holidaysFor(country, year);
  const requests = optionalRequestsFor(state.leaveRequests, actor.id, year);
  const open = requests.filter((r) => r.status === "pending" || r.status === "approved").length;
  const manager = managementChain(actor.id)[0]?.fullName;

  async function pick(h: OptionalHoliday) {
    const error = await applyLeave({ code: OPTIONAL_CODE as LeaveCode, from: h.date, to: h.date, reason: `Optional holiday: ${h.name}` });
    setMsg(error ? { tone: "err", text: error } : null);
    if (!error && API_ENABLED) refreshApiOptional();
    return error;
  }

  async function withdraw(r: LeaveRequest, name: string) {
    const error = await setLeaveStatus(r.id, "withdrawn");
    setMsg(error ? { tone: "err", text: error } : null);
    if (!error && API_ENABLED) refreshApiOptional();
    return error ?? (notify(`${name} ${r.status === "pending" ? "withdrawn" : "cancelled"}.`), null);
  }

  return (
    <Card title={title} action={limit ? <span className="muted">{`${open} of ${limit} used · ${left} left`}</span> : undefined}>
      <div className="stack">
        <Banner message={msg} />
        {list.length === 0 || limit === 0 ? (
          <EmptyState title="No optional holidays" description={`None set for ${countryName(country)} in ${year}.`} />
        ) : (
          <ul className="approval-list">
            {list.map((h) => {
              const request = requestOn(requests, h.date);
              const active = request && (request.status === "pending" || request.status === "approved");
              const past = h.date < today;
              return (
                <li key={h.id} className="approval-item">
                  <div className="row-between wf-wrap">
                    <strong>{h.name}</strong>
                    <PickStatus request={request} past={past} />
                  </div>
                  <span className="muted">
                    {shortDay(h.date)}
                    {request?.status === "rejected" && request.decisionNote ? ` · “${request.decisionNote}”` : ""}
                  </span>
                  {!past && (
                    <div className="approval-actions">
                      {active ? (
                        <ActionButton key="withdraw" className="btn-ghost btn-tiny" onAction={() => withdraw(request, h.name)}>
                          {request.status === "pending" ? "Withdraw" : "Cancel"}
                        </ActionButton>
                      ) : (
                        <ActionButton
                          key="pick"
                          className="btn btn-tiny"
                          disabled={left <= 0}
                          busyLabel="Sending…"
                          doneLabel="Sent"
                          success={manager ? `${h.name} sent to ${manager} for approval.` : `${h.name} added to your holidays.`}
                          onAction={() => pick(h)}
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
  const { state } = usePortal();
  useOptional();
  const year = currentYear();
  const today = todayISO();
  const team = taskTeamFor(actor.id);
  const rows = team
    .flatMap((person) =>
      optionalRequestsFor(state.leaveRequests, person.id, year)
        .filter((r) => r.status !== "withdrawn")
        .map((r) => ({ person, r, name: holidaysFor(countryOf(person.id), year).find((h) => h.date === r.from)?.name ?? r.reason.replace(/^Optional holiday:\s*/, "") })),
    )
    .sort((a, b) => a.r.from.localeCompare(b.r.from));
  const upcoming = rows.filter((x) => x.r.from > today && x.r.status === "approved");
  const waiting = rows.filter((x) => x.r.status === "pending").length;

  return (
    <>
      <MetricGrid>
        <MetricCard label="Waiting for you" value={waiting} />
        <MetricCard label="Upcoming" value={upcoming.length} />
        <MetricCard label="Next" value={upcoming[0] ? fmt(upcoming[0].r.from) : "—"} hint={upcoming[0]?.person.fullName} />
      </MetricGrid>
      <Card title={`Team picks · ${year}`} action={waiting ? <Link to="/approvals">Review</Link> : undefined}>
        <DataTable
          headers={["Person", "Holiday", "Date", "Status"]}
          rows={rows.map((x) => [
            x.person.fullName,
            x.name,
            shortDay(x.r.from),
            <PickStatus key="s" request={x.r} past={x.r.from <= today} />,
          ])}
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
  const [date, setDate] = useState("");
  const [name, setName] = useState("");
  const list = holidaysFor(country, year, data, false).concat(holidaysFor(country, year + 1, data, false));
  const quota = state.leavePolicies.find((p) => p.code === OPTIONAL_CODE);
  const limit = API_ENABLED ? undefined : (quota?.byCountry?.[country as keyof NonNullable<typeof quota.byCountry>]?.quota ?? quota?.quota ?? 0);
  const pickCount = (h: OptionalHoliday) => (API_ENABLED ? (h.pickedBy ?? 0) : localPickCount(state.leaveRequests, h));
  const addAction = useAction();

  async function add() {
    const error = await addOptionalHoliday(actor, { countryCode: country, date, name }, state.holidays);
    setMsg(error ? { tone: "err", text: error } : null);
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
          <div>
            <span className="muted">{limit !== undefined ? `Picks per year: ${limit}` : "Picks per year are set in leave policies."}</span>
            <div>
              <Link className="btn-ghost btn-tiny" to="/admin/leave-policies">
                Change in leave policies
              </Link>
            </div>
          </div>
        </div>
      </Card>
      <Card title={`Optional holidays · ${countryName(country)}`}>
        <DataTable
          headers={["Holiday", "Date", "Picked by", ""]}
          rows={list.map((h) => [
            h.name,
            shortDay(h.date),
            pickCount(h),
            <ActionButton
              key="r"
              className="btn-ghost btn-tiny"
              success={`${h.name} removed.`}
              onError={(m) => setMsg({ tone: "err", text: m })}
              onAction={() => removeOptionalHoliday(actor, h, pickCount(h))}
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
