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
import { ActionButton, Banner, Card, DataTable, Dialog, EmptyState, Field, FilterBar, LoadingState, Page, StatusBadge, Tabs, notify } from "../components/ui.tsx";
import { allHolidaysForCountry, formatShortDate, localPolicy, TIMEZ_COUNTRIES, type CountryCode, type HolidayType } from "../model.ts";
import { usePortal } from "../store.tsx";
import { HOLIDAY_TYPES, HOLIDAY_TYPE_LABEL, OFFICES, appliesText, holidayKind, regionsOf } from "../data/holidayRules.ts";
import "../styles/leave-holidays.css";

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
const encashableOf = (p: LeavePolicyAdmin) => p.encashable ?? p.leave_code === "pto";
const accrualText = (p: LeavePolicyAdmin) => (p.accrual === "monthly" ? `Monthly (${Math.floor((p.quota / 12) * 2) / 2}/month)` : "Yearly");

/** Same limits as the server (backend/app/routers/leave_admin.py and schemas): a message, or null when fine. */
export function policyProblem(f: { name: string; quota: string; carry: string; service: string; max: string; notice: string }): string | null {
  const quota = Number(f.quota);
  const carry = Number(f.carry || 0);
  if (!f.name.trim()) return "Enter a name.";
  if (f.quota.trim() === "" || Number.isNaN(quota) || quota < 0 || quota > 365) return "Days a year must be between 0 and 365.";
  if (quota * 2 !== Math.round(quota * 2)) return "Use whole or half days a year.";
  if (Number.isNaN(carry) || carry < 0) return "Carry forward can't be negative.";
  if (carry > quota) return "Carry-forward can't be more than the yearly quota.";
  const whole = (v: string, label: string, max: number) => {
    if (v.trim() === "") return null;
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 && n <= max ? null : `${label} must be a whole number from 0 to ${max}.`;
  };
  const max = numOrNull(f.max);
  if (max != null && (Number.isNaN(max) || max <= 0 || max > 365)) return "Max days per request must be more than 0.";
  return whole(f.service, "Min service", 600) ?? whole(f.notice, "Notice", 365);
}

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
    encashable: encashableOf(policy),
  });
  const [msg, setMsg] = useState<Msg>(null);
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
      encashable: form.encashable,
    };
    const problem = policyProblem(form);
    if (problem) {
      setMsg({ tone: "err", text: problem });
      return false;
    }
    try {
      await leaveAdminApi.updatePolicy(policy.id, body);
    } catch (e) {
      setMsg({ tone: "err", text: errText(e) });
      return false;
    }
    onSaved();
    return true;
  };

  return (
    <Dialog
      open
      title={`Edit ${policy.name} · ${policy.country_code}`}
      onClose={onClose}
      actions={
        <>
          <button className="btn-ghost" type="button" onClick={onClose}>Cancel</button>
          <ActionButton className="btn" onAction={save} success={`${form.name.trim() || policy.name} policy saved.`}>Save</ActionButton>
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
        <label className="perm-item">
          <input type="checkbox" checked={form.encashable} onChange={(e) => set("encashable", e.target.checked)} />
          <span>Can be encashed</span>
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
  const [type, setType] = useState<HolidayType>((holiday?.holiday_type as HolidayType) ?? "national");
  const [regions, setRegions] = useState<string[]>(holiday?.regions ?? []);
  const [entity, setEntity] = useState(holiday?.legal_entity ?? "");
  const [msg, setMsg] = useState<Msg>(null);
  const choices = [...new Set([...regionsOf(country), ...(OFFICES[country] ?? []), ...regions])];
  const scoped = type !== "national";
  const save = async () => {
    if (!date || !name.trim()) {
      setMsg({ tone: "err", text: "Enter a date and a name." });
      return false;
    }
    if (type === "regional" && !regions.length) {
      setMsg({ tone: "err", text: "A regional holiday needs at least one state or location." });
      return false;
    }
    const typed = {
      holiday_type: type,
      regions: scoped && regions.length ? regions : null,
      legal_entity: scoped && entity.trim() ? entity.trim() : null,
    };
    try {
      if (holiday) await leaveAdminApi.updateHoliday(holiday.id, { date, name: name.trim(), calendar: calendar || null, ...typed });
      else await leaveAdminApi.createHoliday({ country_code: country, date, name: name.trim(), calendar: calendar || null, ...typed });
    } catch (e) {
      setMsg({ tone: "err", text: errText(e) });
      return false;
    }
    onSaved();
    return true;
  };
  return (
    <Dialog
      open
      title={holiday ? "Edit holiday" : "Add holiday"}
      onClose={onClose}
      actions={
        <>
          <button className="btn-ghost" type="button" onClick={onClose}>Cancel</button>
          <ActionButton className="btn" onAction={save} success={`Holiday saved: ${name.trim()}.`}>Save</ActionButton>
        </>
      }
    >
      <Banner message={msg} />
      <div className="form-grid-2">
        <Field label="Date"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Type">
          <select value={type} onChange={(e) => setType(e.target.value as HolidayType)}>
            {HOLIDAY_TYPES.map((t) => (
              <option key={t} value={t}>{HOLIDAY_TYPE_LABEL[t]}</option>
            ))}
          </select>
        </Field>
        <Field label="Holiday calendar">
          <select value={calendar} onChange={(e) => setCalendar(e.target.value)}>
            <option value="">Every calendar</option>
            {calendars.map((c) => (
              <option key={c.calendar} value={c.calendar}>{c.calendar}</option>
            ))}
          </select>
        </Field>
        {scoped && (
          <Field label="Legal entity"><input value={entity} onChange={(e) => setEntity(e.target.value)} placeholder="Every entity" /></Field>
        )}
      </div>
      {scoped && (
        <>
          <p className="note">States / offices{type === "regional" ? "" : " (none ticked = whole country)"}</p>
          <div className="lh-region-pick">
            {choices.map((r) => (
              <label key={r} className="perm-item">
                <input
                  type="checkbox"
                  checked={regions.includes(r)}
                  onChange={(e) => setRegions(e.target.checked ? [...regions, r] : regions.filter((x) => x !== r))}
                />
                <span>{r}</span>
              </label>
            ))}
          </div>
        </>
      )}
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
  const [holidayType, setHolidayType] = useState<HolidayType | "all">("all");
  const [msg, setMsg] = useState<Msg>(null);
  const kindOf = (h: HolidayAdmin) => (h.holiday_type ?? "national") as HolidayType;
  const shownHolidays = holidays.filter((h) => holidayType === "all" || kindOf(h) === holidayType);

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
    } catch (e) {
      setMsg({ tone: "err", text: errText(e) });
      return false;
    }
    setMsg({ tone: "ok", text: ok });
    notify(ok);
    await load();
    return true;
  };

  if (!policies) return <LoadingState />;

  return (
    <>
      <Banner message={msg} />
      {tab === "policies" && (
        <Card
          title={`Leave policies · ${country}`}
          action={
            <ActionButton
              className="btn-ghost btn-tiny"
              busyLabel="Running…"
              doneLabel="Done"
              onAction={() =>
                leaveAdminApi
                  .runCarryForward()
                  .then((out) => {
                    const text = `Carry-forward into ${out.year}: ${out.created} added.`;
                    setMsg({ tone: "ok", text });
                    notify(text);
                    return true;
                  })
                  .catch((e: unknown) => {
                    setMsg({ tone: "err", text: errText(e) });
                    return false;
                  })
              }
            >
              Run carry-forward
            </ActionButton>
          }
        >
          <DataTable
            headers={["Leave", "Days a year", "Accrual", "Carry forward", "Encashable", "Who can take it", "Status", ""]}
            rows={policies.map((p) => [
              p.name,
              p.quota,
              accrualText(p),
              p.carry_forward_max ? `Up to ${p.carry_forward_max}` : "None",
              encashableOf(p) ? "Yes" : "No",
              rulesText(p),
              <StatusBadge key="s" status={p.active ? "Active" : "Inactive"} tone={p.active ? "ok" : "neutral"} literal />,
              <span key="a">
                <button className="btn-ghost btn-tiny" type="button" onClick={() => setEditing(p)}>Edit</button>
                {p.active ? (
                  <ActionButton className="btn-ghost btn-tiny" busyLabel="Saving…" doneLabel="Saved" onAction={() => act(() => leaveAdminApi.deactivatePolicy(p.id), `${p.name} policy turned off.`)}>
                    Turn off
                  </ActionButton>
                ) : (
                  <ActionButton className="btn-ghost btn-tiny" busyLabel="Saving…" doneLabel="Saved" onAction={() => act(() => leaveAdminApi.updatePolicy(p.id, { active: true }), `${p.name} policy turned on.`)}>
                    Turn on
                  </ActionButton>
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
          <div className="lh-filters">
            <label className="lh-filter">
              <span>Type</span>
              <select value={holidayType} onChange={(e) => setHolidayType(e.target.value as HolidayType | "all")}>
                <option value="all">All types ({holidays.length})</option>
                {HOLIDAY_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {HOLIDAY_TYPE_LABEL[t]} ({holidays.filter((h) => kindOf(h) === t).length})
                  </option>
                ))}
              </select>
            </label>
            <span className="note">Calendars in use: {calendars.map((c) => `${c.calendar} (${c.employees})`).join(", ") || "none"}</span>
          </div>
          <DataTable
            headers={["Date", "Name", "Type", "Applies to", "Status", ""]}
            rows={shownHolidays.map((h) => [
              formatShortDate(h.date),
              h.name,
              <span key="t" className={`lh-tag lh-${kindOf(h)}`}>{HOLIDAY_TYPE_LABEL[kindOf(h)]}</span>,
              [h.regions?.length ? h.regions.join(", ") : "Whole country", h.legal_entity, h.calendar].filter(Boolean).join(" · "),
              <StatusBadge key="s" status={h.active ? "Active" : "Inactive"} tone={h.active ? "ok" : "neutral"} literal />,
              <span key="a">
                <button className="btn-ghost btn-tiny" type="button" onClick={() => setHolidayDialog({ holiday: h })}>Edit</button>
                {h.active && (
                  <ActionButton className="btn-ghost btn-tiny" onAction={() => act(() => leaveAdminApi.deactivateHoliday(h.id), `Holiday removed: ${h.name}.`)}>
                    Remove
                  </ActionButton>
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
              <ActionButton
                key="a"
                className="btn-ghost btn-tiny"
                busyLabel="Saving…"
                doneLabel="Saved"
                onAction={() => act(() => leaveAdminApi.updateType(t.code, { active: !t.active }), t.active ? `${t.name} turned off.` : `${t.name} turned on.`)}
              >
                {t.active ? "Turn off" : "Turn on"}
              </ActionButton>,
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
        <DataTable
          headers={["Date", "Name", "Type", "Applies to"]}
          rows={allHolidaysForCountry(state.holidays, country).map((h) => [
            formatShortDate(h.date),
            h.name,
            <span key="t" className={`lh-tag lh-${holidayKind(h)}`}>{HOLIDAY_TYPE_LABEL[holidayKind(h)]}</span>,
            appliesText(h),
          ])}
        />
      </Card>
    );
  }
  return (
    <Card title={`Leave policies · ${country}`}>
      <p className="note">Editing needs the server. This is the demo copy.</p>
      <DataTable
        headers={["Leave", "Days a year", "Accrual", "Carry forward", "Encashable"]}
        rows={state.leavePolicies
          .map((p) => localPolicy(p, country))
          .filter((p) => p.quota > 0)
          .map((p) => [p.name, p.quota, p.accrual === "monthly" ? "Monthly" : "Yearly", p.carryForwardMax ?? 0, p.code === "pto" ? "Yes" : "No"])}
      />
    </Card>
  );
}

export function LeavePoliciesAdminPage() {
  const [country, setCountry] = useState<CountryCode>("IN");
  const [tab, setTab] = useState("policies");
  return (
    <Page title="Leave policies">
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
