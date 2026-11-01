import { useState, useSyncExternalStore } from "react";
import { Link } from "react-router-dom";
import { ActionButton, Banner, Card, DataTable, Dialog, EmptyState, Field, MetricCard, MetricGrid, Page, StatusBadge, SubmitButton, Tabs, notify, useAction } from "../../components/ui.tsx";
import { usePortal } from "../../store.tsx";
import { monthCells, todayISO, TIMEZ_COUNTRIES, type LeaveCode, type LeaveRequest } from "../../model.ts";
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
  pickClosedReason,
  pickDeadline,
  removeOptionalHoliday,
  requestOn,
  subscribeOptionalHolidays,
  type OptionalHoliday,
} from "./optionalHolidaysStore.ts";
import { fmt, isHrRole, shortDay, type WorkforceActor } from "./workforceShared.ts";
import "./workforce.css";
import "./optionalHolidays.css";
import "../../pages/holidays.css";

type Msg = { tone: "ok" | "err" | "warn" | "info"; text: string } | null;

function useOptional() {
  return useSyncExternalStore(subscribeOptionalHolidays, getOptionalHolidayState, getOptionalHolidayState);
}

const currentYear = () => Number(todayISO().slice(0, 4));

const STATUS: Record<string, [string, "ok" | "warn" | "danger" | "neutral"]> = {
  pending: ["Waiting for approval", "warn"],
  approved: ["Selected", "ok"],
  rejected: ["Declined", "danger"],
  withdrawn: ["Cancelled", "neutral"],
};

function PickStatus({ request, past }: { request?: LeaveRequest; past: boolean }) {
  if (!request || request.status === "withdrawn") return past ? <StatusBadge status="Passed" tone="neutral" literal /> : null;
  const [text, tone] = request.status === "approved" && past ? ["Taken", "ok" as const] : (STATUS[request.status] ?? [request.status, "neutral" as const]);
  return <StatusBadge status={text} tone={tone} literal />;
}

const longDate = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

/** Picks, limit and actions for the signed-in person's optional holidays in a year. */
export function useOptionalPicks(year = currentYear()) {
  const { demoProfile, state, leaveTable, applyLeave, setLeaveStatus } = usePortal();
  const data = useOptional();
  const country = countryOf(demoProfile.id);
  const list = holidaysFor(country, year, data);
  const requests = optionalRequestsFor(state.leaveRequests, demoProfile.id, year);
  const balance = leaveTable.find((r) => r.code === OPTIONAL_CODE);
  const limit = balance?.quota ?? 0;
  const used = requests.filter((r) => r.status === "pending" || r.status === "approved").length;
  const left = Math.max(0, balance ? balance.available : limit - used);
  const manager = managementChain(demoProfile.id)[0]?.fullName;

  async function select(h: OptionalHoliday): Promise<string | null> {
    const closed = pickClosedReason(h);
    if (closed) return closed;
    const open = requestOn(requests, h.date);
    if (open && (open.status === "pending" || open.status === "approved")) return `You have already selected ${h.name}.`;
    if (left <= 0) return `You have used all ${limit} optional holidays for ${year}.`;
    const error = await applyLeave({ code: OPTIONAL_CODE as LeaveCode, from: h.date, to: h.date, reason: `Optional holiday: ${h.name}` });
    if (!error && API_ENABLED) refreshApiOptional();
    return error;
  }

  async function cancel(r: LeaveRequest): Promise<string | null> {
    if (r.from <= todayISO()) return "A holiday that has started can't be cancelled.";
    const error = await setLeaveStatus(r.id, "withdrawn");
    if (!error && API_ENABLED) refreshApiOptional();
    return error;
  }

  return { country, list, requests, limit, used, left, manager, select, cancel, year };
}

/** Details of one optional holiday with Select (after a confirmation step) or Cancel. */
export function OptionalHolidayDialog({ holiday, onClose }: { holiday: OptionalHoliday; onClose: () => void }) {
  const picks = useOptionalPicks(Number(holiday.date.slice(0, 4)));
  const [confirming, setConfirming] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const request = requestOn(picks.requests, holiday.date);
  const active = request && (request.status === "pending" || request.status === "approved");
  const closed = pickClosedReason(holiday);
  const today = todayISO();
  return (
    <Dialog open title={holiday.name} onClose={onClose}>
      <div className="stack oh-detail">
        <Banner message={msg} />
        <dl className="oh-facts">
          <div>
            <dt>Date</dt>
            <dd>{longDate(holiday.date)}</dd>
          </div>
          <div>
            <dt>Type</dt>
            <dd>Optional holiday</dd>
          </div>
          <div>
            <dt>Country</dt>
            <dd>
              {countryName(holiday.countryCode)}
              {holiday.region ? ` · ${holiday.region}` : ""}
              {holiday.legalEntity ? ` · ${holiday.legalEntity}` : ""}
            </dd>
          </div>
          <div>
            <dt>Select by</dt>
            <dd>{fmt(pickDeadline(holiday))}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>{request ? <PickStatus request={request} past={holiday.date < today} /> : closed ? "Closed" : "Open"}</dd>
          </div>
          <div>
            <dt>Your picks</dt>
            <dd>
              {picks.used} of {picks.limit} used · {picks.left} left
            </dd>
          </div>
        </dl>
        <p>{holiday.description || "An optional holiday you can choose to take off. It counts against your yearly optional holiday limit."}</p>
        {request?.status === "rejected" && request.decisionNote && <p className="note">Declined: “{request.decisionNote}”</p>}
        {confirming && !active ? (
          <div className="oh-confirm" role="alertdialog" aria-label="Confirm selection">
            <p>
              Select <strong>{holiday.name}</strong> on {fmt(holiday.date)}? This uses 1 of your {picks.limit} optional holidays
              {picks.manager ? ` and goes to ${picks.manager} for approval` : ""}.
            </p>
            <div className="form-actions">
              <ActionButton
                className="btn"
                busyLabel="Saving…"
                doneLabel="Selected"
                success={picks.manager ? `${holiday.name} sent to ${picks.manager} for approval.` : `${holiday.name} selected.`}
                onError={(e) => setMsg({ tone: "err", text: e })}
                onSuccess={() => {
                  setConfirming(false);
                  setMsg({ tone: "ok", text: picks.manager ? "Selected. Waiting for approval." : "Selected." });
                }}
                onAction={() => picks.select(holiday)}
              >
                Confirm
              </ActionButton>
              <button type="button" className="btn-ghost" onClick={() => setConfirming(false)}>
                Back
              </button>
            </div>
          </div>
        ) : (
          <div className="form-actions">
            {active ? (
              holiday.date > today ? (
                <ActionButton
                  className="btn-ghost"
                  success={`${holiday.name} ${request.status === "pending" ? "withdrawn" : "cancelled"}.`}
                  onError={(e) => setMsg({ tone: "err", text: e })}
                  onSuccess={() => setMsg({ tone: "ok", text: "Cancelled. You can select another holiday." })}
                  onAction={() => picks.cancel(request)}
                >
                  {request.status === "pending" ? "Withdraw" : "Cancel selection"}
                </ActionButton>
              ) : null
            ) : closed ? (
              <p className="muted">{closed}</p>
            ) : picks.left <= 0 ? (
              <p className="muted">
                You have used all {picks.limit} optional holidays this year. Cancel one to change it.
              </p>
            ) : picks.limit === 0 ? (
              <p className="muted">Optional holidays are not part of your leave policy.</p>
            ) : (
              <button type="button" className="btn" onClick={() => setConfirming(true)}>
                Select holiday
              </button>
            )}
            <button type="button" className="btn-ghost" onClick={onClose}>
              Close
            </button>
          </div>
        )}
        {active && holiday.date > today && <p className="muted">To change, cancel this one and select another.</p>}
      </div>
    </Dialog>
  );
}

/** Compact list for the Leave and Holiday calendar pages; click a holiday for details. */
export function OptionalHolidaysCard({ title = "Optional holidays" }: { title?: string }) {
  const picks = useOptionalPicks();
  const [open, setOpen] = useState<OptionalHoliday | null>(null);
  const today = todayISO();
  return (
    <Card
      title={title}
      action={picks.limit ? <span className="muted">{`${picks.used} of ${picks.limit} used · ${picks.left} left`}</span> : undefined}
    >
      {picks.list.length === 0 || picks.limit === 0 ? (
        <EmptyState
          title="No optional holidays"
          description={
            picks.limit === 0
              ? "Optional holidays are not part of your leave policy."
              : `None set for ${countryName(picks.country)} in ${picks.year}. HR adds them each year.`
          }
        />
      ) : (
        <ul className="oh-list">
          {picks.list.map((h) => {
            const request = requestOn(picks.requests, h.date);
            const closed = pickClosedReason(h, today);
            return (
              <li key={h.id}>
                <button type="button" className="oh-row" onClick={() => setOpen(h)} aria-label={`${h.name}, ${fmt(h.date)}. Open details`}>
                  <span className="oh-row-main">
                    <strong>{h.name}</strong>
                    <span className="muted">
                      {shortDay(h.date)}
                      {!request && !closed ? ` · select by ${fmt(pickDeadline(h))}` : ""}
                    </span>
                  </span>
                  {request ? <PickStatus request={request} past={h.date < today} /> : closed ? <StatusBadge status="Closed" tone="neutral" literal /> : <span className="oh-open">Select</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <p className="muted oh-more">
        <Link to="/workforce/optional-holidays">All optional holidays</Link>
      </p>
      {open && <OptionalHolidayDialog holiday={open} onClose={() => setOpen(null)} />}
    </Card>
  );
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** The person's own optional holidays: list or calendar, filters, selection history. */
function MyOptional() {
  const [year, setYear] = useState(currentYear());
  const picks = useOptionalPicks(year);
  const today = todayISO();
  const [view, setView] = useState<"list" | "calendar">("list");
  const [q, setQ] = useState("");
  const [month, setMonth] = useState("");
  const [status, setStatus] = useState("");
  const [open, setOpen] = useState<OptionalHoliday | null>(null);
  const statusOf = (h: OptionalHoliday) => {
    const r = requestOn(picks.requests, h.date);
    if (r && (r.status === "pending" || r.status === "approved")) return r.status === "pending" ? "pending" : "selected";
    return pickClosedReason(h, today) ? "closed" : "open";
  };
  const rows = picks.list.filter(
    (h) =>
      (!q.trim() || `${h.name} ${h.description ?? ""}`.toLowerCase().includes(q.trim().toLowerCase())) &&
      (!month || h.date.slice(5, 7) === month) &&
      (!status || statusOf(h) === status),
  );
  const nextDeadline = picks.list
    .filter((h) => statusOf(h) === "open")
    .map((h) => ({ h, by: pickDeadline(h) }))
    .sort((a, b) => a.by.localeCompare(b.by))[0];
  const history = [...picks.requests].sort((a, b) => b.appliedOn.localeCompare(a.appliedOn) || b.from.localeCompare(a.from));
  const nameOn = (date: string, r: LeaveRequest) => picks.list.find((h) => h.date === date)?.name ?? r.reason.replace(/^Optional holiday:\s*/, "");
  const months = [...new Set(rows.map((h) => Number(h.date.slice(5, 7)) - 1))];

  return (
    <>
      <MetricGrid>
        <MetricCard label="Allowed" value={picks.limit} hint={`${picks.year} · ${countryName(picks.country)}`} />
        <MetricCard label="Selected" value={picks.used} hint="Approved or waiting" />
        <MetricCard label="Left" value={picks.left} />
        <MetricCard label="Next deadline" value={nextDeadline ? fmt(nextDeadline.by) : "—"} hint={nextDeadline?.h.name} />
      </MetricGrid>
      <Card
        title={`Optional holidays · ${year}`}
        action={
          <span className="form-actions" style={{ marginTop: 0 }}>
            <button type="button" className="btn-ghost btn-tiny" onClick={() => setYear(year - 1)} aria-label="Previous year">
              ← {year - 1}
            </button>
            <button type="button" className="btn-ghost btn-tiny" onClick={() => setYear(year + 1)} aria-label="Next year">
              {year + 1} →
            </button>
          </span>
        }
      >
        <div className="oh-tools">
          <Tabs
            tabs={[
              { id: "list", label: "List" },
              { id: "calendar", label: "Calendar" },
            ]}
            value={view}
            onChange={(v) => setView(v as "list" | "calendar")}
          />
          <label className="filter-label">
            Search
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Holiday name…" />
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
            Status
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All</option>
              <option value="open">Open to select</option>
              <option value="selected">Selected</option>
              <option value="pending">Waiting for approval</option>
              <option value="closed">Closed</option>
            </select>
          </label>
        </div>
        {picks.list.length === 0 ? (
          <EmptyState
            title="No optional holidays"
            description={`HR hasn't set optional holidays for ${countryName(picks.country)} in ${year}. Public holidays are on the holiday calendar.`}
          />
        ) : rows.length === 0 ? (
          <EmptyState title="Nothing matches" description="Clear the search or filters." />
        ) : view === "list" ? (
          <DataTable
            headers={["Holiday", "Date", "Select by", "Status", ""]}
            rows={rows.map((h) => {
              const r = requestOn(picks.requests, h.date);
              const st = statusOf(h);
              return [
                <button key="n" type="button" className="link-btn" onClick={() => setOpen(h)}>
                  {h.name}
                </button>,
                shortDay(h.date),
                fmt(pickDeadline(h)),
                r && st !== "open" && st !== "closed" ? (
                  <PickStatus key="s" request={r} past={h.date < today} />
                ) : st === "closed" ? (
                  <StatusBadge key="s" status={h.date < today ? "Passed" : "Closed"} tone="neutral" literal />
                ) : (
                  <StatusBadge key="s" status="Open" tone="info" literal />
                ),
                <button key="d" type="button" className="btn-ghost btn-tiny" onClick={() => setOpen(h)}>
                  {st === "open" ? "Select" : "Details"}
                </button>,
              ];
            })}
          />
        ) : (
          <div className="oh-months">
            {months.map((m) => (
              <section key={m} className="oh-month">
                <h3>{MONTHS[m]}</h3>
                <div className="cal cal-mini">
                  {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
                    <div key={i} className="cal-head">
                      {d}
                    </div>
                  ))}
                  {monthCells(year, m).map((date, i) => {
                    if (!date) return <div key={`b-${i}`} />;
                    const h = rows.find((x) => x.date === date);
                    if (!h) return <div key={date} className={`day${date === today ? " today" : ""}`}>{Number(date.slice(-2))}</div>;
                    const st = statusOf(h);
                    return (
                      <button key={date} type="button" className={`day optional oh-day is-${st}`} title={`${h.name} · ${st}`} onClick={() => setOpen(h)}>
                        {Number(date.slice(-2))}
                      </button>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        )}
      </Card>
      <Card title="Selection history">
        <DataTable
          headers={["Holiday", "Date", "Requested", "Status", "Note"]}
          rows={history.map((r) => [
            nameOn(r.from, r),
            shortDay(r.from),
            fmt(r.appliedOn),
            <StatusBadge key="s" status={(STATUS[r.status] ?? [r.status])[0]} tone={(STATUS[r.status] ?? ["", "neutral"])[1] as "ok"} literal />,
            r.decisionNote || (r.decidedByName ? `By ${r.decidedByName}` : "—"),
          ])}
          empty={<EmptyState title="No selections yet" description="Select an optional holiday above." />}
        />
      </Card>
      {open && <OptionalHolidayDialog holiday={open} onClose={() => setOpen(null)} />}
    </>
  );
}

export function OptionalHolidaysPage() {
  const { demoProfile } = usePortal();
  const actor: WorkforceActor = demoProfile;
  const team = taskTeamFor(actor.id);
  const hr = isHrRole(actor.role);
  const tabs = [
    { id: "mine", label: "My holidays" },
    ...(team.length ? [{ id: "team", label: "Team picks" }] : []),
    ...(hr ? [{ id: "setup", label: "Setup" }] : []),
  ];
  const [tab, setTab] = useState("mine");
  const active = tabs.some((t) => t.id === tab) ? tab : "mine";

  return (
    <Page title="Optional holidays" action={<Link className="btn-ghost" to="/holidays">Holiday calendar</Link>}>
      {tabs.length > 1 && <Tabs tabs={tabs} value={active} onChange={setTab} />}
      {active === "mine" && <MyOptional />}
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
  const [description, setDescription] = useState("");
  const [region, setRegion] = useState("");
  const [selectBy, setSelectBy] = useState("");
  const list = holidaysFor(country, year, data, false).concat(holidaysFor(country, year + 1, data, false));
  const quota = state.leavePolicies.find((p) => p.code === OPTIONAL_CODE);
  const limit = API_ENABLED ? undefined : (quota?.byCountry?.[country as keyof NonNullable<typeof quota.byCountry>]?.quota ?? quota?.quota ?? 0);
  const pickCount = (h: OptionalHoliday) => (API_ENABLED ? (h.pickedBy ?? 0) : localPickCount(state.leaveRequests, h));
  const addAction = useAction();

  async function add() {
    const error = await addOptionalHoliday(actor, { countryCode: country, date, name, description, region, selectBy }, state.holidays);
    setMsg(error ? { tone: "err", text: error } : null);
    if (error) return false;
    notify(`${name.trim()} added as an optional holiday.`);
    setDate("");
    setName("");
    setDescription("");
    setRegion("");
    setSelectBy("");
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
          headers={["Holiday", "Date", "Select by", "Region", "Picked by", ""]}
          rows={list.map((h) => [
            h.name,
            shortDay(h.date),
            fmt(pickDeadline(h)),
            h.region || "All",
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
            <Field label="Select by (optional)">
              <input type="date" value={selectBy} min={todayISO()} max={date || undefined} onChange={(e) => setSelectBy(e.target.value)} />
            </Field>
            <Field label="Region (optional)">
              <input value={region} maxLength={100} placeholder="All regions" onChange={(e) => setRegion(e.target.value)} />
            </Field>
            <Field label="Description" wide>
              <input value={description} maxLength={1000} onChange={(e) => setDescription(e.target.value)} />
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
