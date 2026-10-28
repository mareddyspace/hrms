import { useCallback, useEffect, useState } from "react";
import { API_ENABLED } from "../api/client.ts";
import {
  leaveAdminApi,
  type GenderRule,
  type HolidayAdmin,
  type HolidayCalendar,
  type LeavePolicyAdmin,
  type LeavePolicyEdit,
  type LeaveTypeAdmin,
} from "../api/syncLeaveAdmin.ts";
import { Banner, Card, DataTable, Dialog, EmptyState, Field, FilterBar, LoadingState, Page, StatusBadge, Tabs } from "../components/ui.tsx";
import { formatShortDate, holidaysForCountry, localPolicy, TIMEZ_COUNTRIES, type CountryCode } from "../model.ts";
import { usePortal } from "../store.tsx";

type Msg = { tone: "ok" | "err" | "warn" | "info"; text: string } | null;

const EMPLOYMENT_TYPES = ["Full-Time", "Part-Time", "Contract"];
const errText = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");

function rulesText(p: LeavePolicyAdmin): string {
  const parts: string[] = [];
  if (p.gender && p.gender !== "any") parts.push(p.gender === "female" ? "Women only" : "Men only");
  if (p.min_service_months) parts.push(`${p.min_service_months}+ months service`);
  if (p.employment_types?.length) parts.push(p.employment_types.join(", "));
  if (p.not_in_probation) parts.push("Not in probation");
  if (p.max_per_request) parts.push(`Max ${p.max_per_request} per request`);
  if (p.min_notice_days) parts.push(`${p.min_notice_days} days notice`);
  return parts.join(" · ") || "Everyone";
}

const numOrNull = (v: string) => (v.trim() === "" ? null : Number(v));

function PolicyDialog({ policy, onClose, onSaved }: { policy: LeavePolicyAdmin; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    name: policy.name,
    quota: String(policy.quota),
    carry: String(policy.carry_forward_max),
    accrual: policy.accrual,
    gender: (policy.gender ?? "any") as GenderRule,
    service: policy.min_service_months == null ? "" : String(policy.min_service_months),
    types: policy.employment_types ?? [],
    probation: policy.not_in_probation,
    max: policy.max_per_request == null ? "" : String(policy.max_per_request),
    notice: policy.min_notice_days == null ? "" : String(policy.min_notice_days),
  });
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    const body: LeavePolicyEdit = {
      name: form.name.trim(),
      quota: Number(form.quota),
      carry_forward_max: Number(form.carry || 0),
      accrual: form.accrual,
      gender: form.gender,
      min_service_months: numOrNull(form.service),
      employment_types: form.types,
      not_in_probation: form.probation,
      max_per_request: numOrNull(form.max),
      min_notice_days: numOrNull(form.notice),
    };
    if (!body.name || Number.isNaN(body.quota)) return setMsg({ tone: "err", text: "Enter a name and days a year." });
    setBusy(true);
    try {
      await leaveAdminApi.updatePolicy(policy.id, body);
      onSaved();
    } catch (e) {
      setMsg({ tone: "err", text: errText(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={`Edit ${policy.name} · ${policy.country_code}`}
      onClose={onClose}
      actions={
        <>
          <button className="btn-ghost" type="button" onClick={onClose}>Cancel</button>
          <button className="btn" type="button" disabled={busy} onClick={save}>Save</button>
        </>
      }
    >
      <Banner message={msg} />
      <div className="form-grid-2">
        <Field label="Name"><input value={form.name} onChange={(e) => set("name", e.target.value)} /></Field>
        <Field label="Days a year"><input type="number" min={0} value={form.quota} onChange={(e) => set("quota", e.target.value)} /></Field>
        <Field label="Carry forward (max days)"><input type="number" min={0} value={form.carry} onChange={(e) => set("carry", e.target.value)} /></Field>
        <Field label="Accrual">
          <select value={form.accrual} onChange={(e) => set("accrual", e.target.value as "annual" | "monthly")}>
            <option value="annual">Yearly</option>
            <option value="monthly">Monthly</option>
          </select>
        </Field>
        <Field label="Gender">
          <select value={form.gender} onChange={(e) => set("gender", e.target.value as GenderRule)}>
            <option value="any">Any</option>
            <option value="female">Female</option>
            <option value="male">Male</option>
          </select>
        </Field>
        <Field label="Min service (months)"><input type="number" min={0} value={form.service} onChange={(e) => set("service", e.target.value)} /></Field>
        <Field label="Max days per request"><input type="number" min={0} value={form.max} onChange={(e) => set("max", e.target.value)} /></Field>
        <Field label="Notice (days)"><input type="number" min={0} value={form.notice} onChange={(e) => set("notice", e.target.value)} /></Field>
      </div>
      <p className="note">Employment types (none ticked = all)</p>
      <div className="form-grid-2">
        {EMPLOYMENT_TYPES.map((t) => (
          <label key={t} className="perm-item">
            <input
              type="checkbox"
              checked={form.types.includes(t)}
              onChange={(e) => set("types", e.target.checked ? [...form.types, t] : form.types.filter((x) => x !== t))}
            />
            <span>{t}</span>
          </label>
        ))}
        <label className="perm-item">
          <input type="checkbox" checked={form.probation} onChange={(e) => set("probation", e.target.checked)} />
          <span>Not during probation</span>
        </label>
      </div>
    </Dialog>
  );
}

function HolidayDialog({
  country,
  calendars,
  holiday,
  onClose,
  onSaved,
}: {
  country: string;
  calendars: HolidayCalendar[];
  holiday: HolidayAdmin | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [date, setDate] = useState(holiday?.date ?? "");
  const [name, setName] = useState(holiday?.name ?? "");
  const [calendar, setCalendar] = useState(holiday?.calendar ?? "");
  const [msg, setMsg] = useState<Msg>(null);
  const save = async () => {
    if (!date || !name.trim()) return setMsg({ tone: "err", text: "Enter a date and a name." });
    try {
      if (holiday) await leaveAdminApi.updateHoliday(holiday.id, { date, name: name.trim(), calendar: calendar || null });
      else await leaveAdminApi.createHoliday({ country_code: country, date, name: name.trim(), calendar: calendar || null });
      onSaved();
    } catch (e) {
      setMsg({ tone: "err", text: errText(e) });
    }
  };
  return (
    <Dialog
      open
      title={holiday ? "Edit holiday" : "Add holiday"}
      onClose={onClose}
      actions={
        <>
          <button className="btn-ghost" type="button" onClick={onClose}>Cancel</button>
          <button className="btn" type="button" onClick={save}>Save</button>
        </>
      }
    >
      <Banner message={msg} />
      <div className="form-grid-2">
        <Field label="Date"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Holiday calendar">
          <select value={calendar} onChange={(e) => setCalendar(e.target.value)}>
            <option value="">Whole country</option>
            {calendars.map((c) => (
              <option key={c.calendar} value={c.calendar}>{c.calendar}</option>
            ))}
          </select>
        </Field>
      </div>
    </Dialog>
  );
}

function ServerLeaveAdmin({ country, tab }: { country: CountryCode; tab: string }) {
  const year = new Date().getFullYear();
  const [policies, setPolicies] = useState<LeavePolicyAdmin[] | null>(null);
  const [types, setTypes] = useState<LeaveTypeAdmin[]>([]);
  const [holidays, setHolidays] = useState<HolidayAdmin[]>([]);
  const [calendars, setCalendars] = useState<HolidayCalendar[]>([]);
  const [editing, setEditing] = useState<LeavePolicyAdmin | null>(null);
  const [holidayDialog, setHolidayDialog] = useState<{ holiday: HolidayAdmin | null } | null>(null);
  const [msg, setMsg] = useState<Msg>(null);

  const load = useCallback(async () => {
    try {
      const [p, t, h, c] = await Promise.all([
        leaveAdminApi.policies(country),
        leaveAdminApi.types(),
        leaveAdminApi.holidays(country, year),
        leaveAdminApi.calendars(country),
      ]);
      setPolicies(p);
      setTypes(t);
      setHolidays(h);
      setCalendars(c);
    } catch (e) {
      setPolicies([]);
      setMsg({ tone: "err", text: errText(e) });
    }
  }, [country, year]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      setMsg({ tone: "ok", text: ok });
      await load();
    } catch (e) {
      setMsg({ tone: "err", text: errText(e) });
    }
  };

  if (!policies) return <LoadingState />;

  return (
    <>
      <Banner message={msg} />
      {tab === "policies" && (
        <Card
          title={`Leave policies · ${country}`}
          action={
            <button
              className="btn-ghost btn-tiny"
              type="button"
              onClick={() =>
                leaveAdminApi
                  .runCarryForward()
                  .then((out) => setMsg({ tone: "ok", text: `Carry-forward into ${out.year}: ${out.created} added.` }))
                  .catch((e: unknown) => setMsg({ tone: "err", text: errText(e) }))
              }
            >
              Run carry-forward
            </button>
          }
        >
          <DataTable
            headers={["Leave", "Days a year", "Carry forward", "Who can take it", "Status", ""]}
            rows={policies.map((p) => [
              p.name,
              p.quota,
              p.carry_forward_max,
              rulesText(p),
              <StatusBadge key="s" status={p.active ? "Active" : "Inactive"} tone={p.active ? "ok" : "neutral"} literal />,
              <span key="a">
                <button className="btn-ghost btn-tiny" type="button" onClick={() => setEditing(p)}>Edit</button>
                {p.active ? (
                  <button className="btn-ghost btn-tiny" type="button" onClick={() => act(() => leaveAdminApi.deactivatePolicy(p.id), "Policy turned off.")}>
                    Turn off
                  </button>
                ) : (
                  <button className="btn-ghost btn-tiny" type="button" onClick={() => act(() => leaveAdminApi.updatePolicy(p.id, { active: true }), "Policy turned on.")}>
                    Turn on
                  </button>
                )}
              </span>,
            ])}
            empty={<EmptyState title="No policies for this country" />}
          />
        </Card>
      )}

      {tab === "holidays" && (
        <Card
          title={`Holidays ${year} · ${country}`}
          action={<button className="btn btn-tiny" type="button" onClick={() => setHolidayDialog({ holiday: null })}>Add holiday</button>}
        >
          <p className="note">
            Calendars in use: {calendars.map((c) => `${c.calendar} (${c.employees})`).join(", ") || "none"}
          </p>
          <DataTable
            headers={["Date", "Name", "Calendar", "Status", ""]}
            rows={holidays.map((h) => [
              formatShortDate(h.date),
              h.name,
              h.calendar ?? "Whole country",
              <StatusBadge key="s" status={h.active ? "Active" : "Inactive"} tone={h.active ? "ok" : "neutral"} literal />,
              <span key="a">
                <button className="btn-ghost btn-tiny" type="button" onClick={() => setHolidayDialog({ holiday: h })}>Edit</button>
                {h.active && (
                  <button className="btn-ghost btn-tiny" type="button" onClick={() => act(() => leaveAdminApi.deactivateHoliday(h.id), "Holiday removed.")}>
                    Remove
                  </button>
                )}
              </span>,
            ])}
            empty={<EmptyState title="No holidays this year" />}
          />
        </Card>
      )}

      {tab === "types" && (
        <Card title="Leave types">
          <DataTable
            headers={["Code", "Name", "Half days", "Status", ""]}
            rows={types.map((t) => [
              t.code,
              t.name,
              t.half_day_allowed ? "Yes" : "No",
              <StatusBadge key="s" status={t.active ? "Active" : "Inactive"} tone={t.active ? "ok" : "neutral"} literal />,
              <button
                key="a"
                className="btn-ghost btn-tiny"
                type="button"
                onClick={() => act(() => leaveAdminApi.updateType(t.code, { active: !t.active }), t.active ? "Type turned off." : "Type turned on.")}
              >
                {t.active ? "Turn off" : "Turn on"}
              </button>,
            ])}
          />
        </Card>
      )}

      {editing && (
        <PolicyDialog
          policy={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setMsg({ tone: "ok", text: "Policy saved." });
            void load();
          }}
        />
      )}
      {holidayDialog && (
        <HolidayDialog
          country={country}
          calendars={calendars}
          holiday={holidayDialog.holiday}
          onClose={() => setHolidayDialog(null)}
          onSaved={() => {
            setHolidayDialog(null);
            setMsg({ tone: "ok", text: "Holiday saved." });
            void load();
          }}
        />
      )}
    </>
  );
}

function LocalLeaveReference({ country, tab }: { country: CountryCode; tab: string }) {
  const { state } = usePortal();
  if (tab === "holidays") {
    return (
      <Card title={`Holidays · ${country}`}>
        <DataTable headers={["Date", "Name"]} rows={holidaysForCountry(state.holidays, country).map((h) => [formatShortDate(h.date), h.name])} />
      </Card>
    );
  }
  return (
    <Card title={`Leave policies · ${country}`}>
      <p className="note">Editing needs the server. This is the demo copy.</p>
      <DataTable
        headers={["Leave", "Days a year", "Carry forward"]}
        rows={state.leavePolicies
          .map((p) => localPolicy(p, country))
          .filter((p) => p.quota > 0)
          .map((p) => [p.name, p.quota, p.carryForwardMax ?? 0])}
      />
    </Card>
  );
}

export function LeavePoliciesAdminPage() {
  const [country, setCountry] = useState<CountryCode>("IN");
  const [tab, setTab] = useState("policies");
  return (
    <Page title="Leave policies" subtitle="Leave rules and holidays by country">
      <FilterBar>
        <label className="filter-label">
          Country
          <select value={country} onChange={(e) => setCountry(e.target.value as CountryCode)}>
            {TIMEZ_COUNTRIES.map((c) => (
              <option key={c.code} value={c.code}>{c.name}</option>
            ))}
          </select>
        </label>
      </FilterBar>
      <Tabs
        tabs={[
          { id: "policies", label: "Policies" },
          { id: "holidays", label: "Holidays" },
          ...(API_ENABLED ? [{ id: "types", label: "Leave types" }] : []),
        ]}
        value={tab}
        onChange={setTab}
      />
      {API_ENABLED ? <ServerLeaveAdmin country={country} tab={tab} /> : <LocalLeaveReference country={country} tab={tab} />}
    </Page>
  );
}
