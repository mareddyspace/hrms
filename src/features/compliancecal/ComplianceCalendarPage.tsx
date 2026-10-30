import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Banner, Card, DataTable, EmptyState, Page, StatusBadge, SubmitButton, Tabs, useAction } from "../../components/ui.tsx";
import {
  KIND_LABEL,
  WINDOWS,
  loadDueDates,
  saveDueDate,
  useComplianceItems,
  type ComplianceItem,
  type ComplianceKind,
  type DueDate,
  type DueDateInput,
  type Frequency,
} from "./complianceStore.ts";
import "../celebrations/celebrations.css";

const COUNTRIES = ["IN", "GB", "US", "AU", "CA", "AE", "SA", "DE"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const dayMonth = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

function tone(days: number): "danger" | "warn" | "neutral" {
  return days <= 7 ? "danger" : days <= 30 ? "warn" : "neutral";
}

function monthTitle(iso: string): string {
  return new Date(`${iso.slice(0, 7)}-01T00:00:00`).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
}

function ItemRow({ item }: { item: ComplianceItem }) {
  return (
    <li className="cel-row">
      <span className="cel-when">{dayMonth(item.date)}</span>
      <span className="cel-main">
        <Link to={item.href}>{item.employeeName ? `${item.title} · ${item.employeeName}` : item.title}</Link>
        <small>
          {KIND_LABEL[item.kind]} · {item.countryCode}
          {item.sample ? " · sample date" : ""}
        </small>
      </span>
      <span className="cel-actions">
        <StatusBadge status={item.daysLeft === 0 ? "Today" : item.daysLeft === 1 ? "Tomorrow" : `${item.daysLeft} days`} tone={tone(item.daysLeft)} literal keepCase />
      </span>
    </li>
  );
}

const BLANK: DueDateInput = { countryCode: "IN", name: "", frequency: "monthly", day: 15, months: [], href: "/payroll", active: true };

function DueDateForm({ editing, onSaved, onCancel }: { editing: DueDate | null; onSaved: () => void; onCancel: () => void }) {
  const [form, setForm] = useState<DueDateInput>(editing ? { ...editing } : BLANK);
  const [error, setError] = useState<string | null>(null);
  const act = useAction();
  const toggleMonth = (m: number) =>
    setForm((f) => ({ ...f, months: f.frequency === "annual" ? [m] : f.months.includes(m) ? f.months.filter((x) => x !== m) : [...f.months, m] }));
  return (
    <form
      className="stack"
      onSubmit={act.submit(async () => {
        const problem = await saveDueDate(editing?.id ?? null, form);
        setError(problem);
        return problem;
      }, { success: editing ? "Due date saved." : "Due date added.", onSuccess: onSaved })}
    >
      <div className="cel-form">
        <label className="field">
          <span>Name</span>
          <input value={form.name} maxLength={200} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </label>
        <label className="field">
          <span>Country</span>
          <select value={form.countryCode} onChange={(e) => setForm({ ...form, countryCode: e.target.value })}>
            {COUNTRIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Repeats</span>
          <select value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value as Frequency, months: [] })}>
            <option value="monthly">Monthly</option>
            <option value="quarterly">Quarterly</option>
            <option value="annual">Yearly</option>
          </select>
        </label>
        <label className="field">
          <span>Day</span>
          <input type="number" min={1} max={31} value={form.day} onChange={(e) => setForm({ ...form, day: Number(e.target.value) })} />
        </label>
      </div>
      {form.frequency !== "monthly" && (
        <div className="cel-filters" role="group" aria-label="Months">
          {MONTHS.map((label, i) => (
            <label key={label} className="cel-check">
              <input aria-label={label} type={form.frequency === "annual" ? "radio" : "checkbox"} name="due-month" checked={form.months.includes(i + 1)} onChange={() => toggleMonth(i + 1)} />
              {label}
            </label>
          ))}
        </div>
      )}
      <label className="cel-check">
        <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
        Active
      </label>
      {error && <p className="note err">{error}</p>}
      <span className="cel-actions" style={{ marginLeft: 0 }}>
        <SubmitButton action={act} className="btn">
          {editing ? "Save" : "Add"}
        </SubmitButton>
        <button type="button" className="btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </span>
    </form>
  );
}

function DueDatesCard() {
  const [rows, setRows] = useState<DueDate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<DueDate | "new" | null>(null);
  const reload = () =>
    loadDueDates()
      .then((r) => {
        setRows(r);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Could not load."));
  useEffect(() => {
    void reload();
  }, []);
  return (
    <Card
      title="Statutory dates"
      action={
        editing ? undefined : (
          <button type="button" className="btn-ghost btn-tiny" onClick={() => setEditing("new")}>
            Add
          </button>
        )
      }
    >
      <Banner message={error ? { tone: "err", text: error } : null} />
      {editing && (
        <DueDateForm
          key={editing === "new" ? "new" : editing.id}
          editing={editing === "new" ? null : editing}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void reload();
          }}
        />
      )}
      {rows && (
        <DataTable
          headers={["Country", "Name", "Due", ""]}
          rows={rows.map((r) => [
            r.countryCode,
            <span key="n">
              {r.name}
              {r.sample ? <small className="muted"> · sample</small> : null}
              {!r.active ? <small className="muted"> · off</small> : null}
            </span>,
            r.frequency === "monthly" ? `${r.day} each month` : `${r.day} ${r.months.map((m) => MONTHS[m - 1]).join(", ")}`,
            <button key="e" type="button" className="btn-ghost btn-tiny" onClick={() => setEditing(r)}>
              Edit
            </button>,
          ])}
        />
      )}
    </Card>
  );
}

export function ComplianceCalendarPage() {
  const [tab, setTab] = useState("calendar");
  const [days, setDays] = useState<number>(90);
  const [country, setCountry] = useState("all");
  const [kind, setKind] = useState<ComplianceKind | "all">("all");
  const { rows, loading, error } = useComplianceItems(days);
  const shown = rows.filter((r) => (country === "all" || r.countryCode === country) && (kind === "all" || r.kind === kind));
  const months = useMemo(() => {
    const out = new Map<string, ComplianceItem[]>();
    for (const r of shown) out.set(r.date.slice(0, 7), [...(out.get(r.date.slice(0, 7)) ?? []), r]);
    return [...out.entries()];
  }, [shown]);
  const countries = [...new Set(rows.map((r) => r.countryCode))].sort();
  return (
    <Page title="Compliance calendar">
      <Tabs
        tabs={[
          { id: "calendar", label: "Calendar" },
          { id: "dates", label: "Statutory dates" },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === "dates" ? (
        <DueDatesCard />
      ) : (
        <>
          <div className="cel-filters">
            <select aria-label="Window" value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {WINDOWS.map((w) => (
                <option key={w} value={w}>
                  Next {w} days
                </option>
              ))}
            </select>
            <select aria-label="Country" value={country} onChange={(e) => setCountry(e.target.value)}>
              <option value="all">All countries</option>
              {countries.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
            <select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value as ComplianceKind | "all")}>
              <option value="all">All kinds</option>
              {(Object.keys(KIND_LABEL) as ComplianceKind[]).map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </div>
          <Banner message={error ? { tone: "err", text: error } : null} />
          <Card title={`${shown.length} due`}>
            {loading ? (
              <p className="empty">Loading…</p>
            ) : months.length ? (
              months.map(([month, items]) => (
                <section key={month}>
                  <h3 className="cel-month">{monthTitle(`${month}-01`)}</h3>
                  <ul className="cel-list">
                    {items.map((i) => (
                      <ItemRow key={i.id} item={i} />
                    ))}
                  </ul>
                </section>
              ))
            ) : (
              <EmptyState title="Nothing due" description="" />
            )}
          </Card>
        </>
      )}
    </Page>
  );
}

/** HR Home: the next 5 items. */
export function ComplianceHomeCard() {
  const { rows, loading } = useComplianceItems(90);
  const next = rows.slice(0, 5);
  return (
    <Card title="Compliance due" to="/compliance-calendar">
      {loading ? (
        <p className="empty">Loading…</p>
      ) : next.length ? (
        <ul className="cel-list">
          {next.map((i) => (
            <ItemRow key={i.id} item={i} />
          ))}
        </ul>
      ) : (
        <p className="empty">Nothing due in 90 days</p>
      )}
    </Card>
  );
}
