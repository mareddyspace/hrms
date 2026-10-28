/** Payroll tab, backend mode: integration status per country and legal entity (no payroll processing). */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Banner, Card, DataTable, EmptyState, MetricCard, MetricGrid, StatusBadge } from "../../components/ui.tsx";
import { apiPayrollProviders, apiPayrollStatus, apiSavePayrollProviders, type PayrollStatusOut } from "../../api/syncPayroll.ts";
import { usePortal } from "../../store.tsx";

type Tone = "ok" | "warn" | "danger" | "neutral";

function tone(value: string): Tone {
  if (["Connected", "Active", "Healthy", "Configured"].includes(value)) return "ok";
  if (["Degraded", "Paused", "Warning", "Incomplete"].includes(value)) return "warn";
  if (["Disconnected", "Down"].includes(value)) return "danger";
  return "neutral";
}

function when(iso: string | null): string {
  if (!iso) return "Never";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** Admin: payroll provider per country (blank = "Not set"). */
function ProvidersCard({ onSaved }: { onSaved: () => void }) {
  const [countries, setCountries] = useState<string[]>([]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    apiPayrollProviders()
      .then((d) => {
        setCountries(d.countries);
        setDraft(d.providers);
      })
      .catch((e: unknown) => setMessage({ tone: "err", text: e instanceof Error ? e.message : "Could not load providers." }));
  }, []);

  async function save() {
    setSaving(true);
    try {
      const out = await apiSavePayrollProviders(draft);
      setDraft(out.providers);
      setMessage({ tone: "ok", text: "Providers saved." });
      onSaved();
    } catch (e) {
      setMessage({ tone: "err", text: e instanceof Error ? e.message : "Could not save." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card title="Payroll providers">
      <div className="form-grid">
        {countries.map((cc) => (
          <label key={cc} className="field">
            <span>{cc}</span>
            <input
              value={draft[cc] ?? ""}
              placeholder="Not set"
              maxLength={100}
              onChange={(e) => setDraft({ ...draft, [cc]: e.target.value })}
            />
          </label>
        ))}
      </div>
      <div className="form-actions">
        <button type="button" className="btn" onClick={() => void save()} disabled={saving}>
          Save providers
        </button>
      </div>
      <Banner message={message} />
    </Card>
  );
}

export function PayrollStatusPanel({ country }: { country?: string }) {
  const { demoProfile } = usePortal();
  const isAdmin = demoProfile.role === "admin" || demoProfile.role === "super_admin";
  const [data, setData] = useState<PayrollStatusOut | null>(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let alive = true;
    apiPayrollStatus()
      .then((d) => alive && setData(d))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : "Could not load payroll status."));
    return () => {
      alive = false;
    };
  }, [version]);

  if (error) return <EmptyState title="Payroll status unavailable" description={error} />;
  if (!data) return <p className="muted">Loading…</p>;
  const rows = data.rows.filter((r) => !country || r.country_code === country);
  const badge = (key: string, value: string) => <StatusBadge key={key} status={value} tone={tone(value)} literal />;

  return (
    <>
      <MetricGrid>
        <MetricCard label="Legal entities" value={rows.length} hint={`Period ${data.period_label}`} />
        <MetricCard label="Connected" value={rows.filter((r) => r.connection_status === "Connected").length} />
        <MetricCard label="Need attention" value={rows.filter((r) => r.integration_health !== "Healthy").length} />
        <MetricCard label="Employees" value={rows.reduce((n, r) => n + r.employees, 0)} />
      </MetricGrid>
      <Card title="Payroll integration by legal entity">
        <DataTable
          headers={["Country", "Legal entity", "Provider", "Connection", "Integration", "Last sync", "Period", "Health", "Configuration", "Employees"]}
          rows={rows.map((r) => {
            const k = `${r.country_code}-${r.legal_entity}`;
            return [
              r.country_name ?? r.country_code,
              r.legal_entity,
              r.provider,
              badge(`${k}-c`, r.connection_status),
              badge(`${k}-i`, r.integration_status),
              when(r.last_sync_at),
              r.payroll_period_label,
              badge(`${k}-h`, r.integration_health),
              badge(`${k}-g`, r.configuration_status),
              <span key={`${k}-e`} title={Object.entries(r.payroll_status_counts).map(([s, n]) => `${s}: ${n}`).join(", ")}>
                {r.employees}
                {Object.keys(r.payroll_status_counts).length > 0 && (
                  <span className="muted"> · {Object.entries(r.payroll_status_counts).map(([s, n]) => `${s} ${n}`).join(", ")}</span>
                )}
              </span>,
            ];
          })}
          empty={<p className="note">No employees in your scope.</p>}
        />
        <p className="note">
          Connector retries: <Link to="/integrations">Integrations</Link>
        </p>
      </Card>
      {isAdmin && <ProvidersCard onSaved={() => setVersion((v) => v + 1)} />}
    </>
  );
}
