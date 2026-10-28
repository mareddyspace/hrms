/**
 * Onboarding analytics: Analytics page tab and a small HR home card.
 * Backend mode reads GET /onboarding/analytics (scoped on the server); demo mode works it out from talent data.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { Link } from "react-router-dom";
import { Card, DataTable, EmptyState, MetricCard, MetricGrid } from "../../components/ui.tsx";
import { API_ENABLED } from "../../api/client.ts";
import { apiOnboardingAnalytics, countryCode, countryName, type OnboardingAnalyticsOut } from "../../api/syncTalent.ts";
import { getTalentState, subscribeTalent } from "../../data/talentLocal.ts";
import type { OnboardingJoiner, OnboardingTask } from "../../data/talentData.ts";
import { todayISO } from "../../model.ts";

const OWNER_LABEL: Record<string, string> = { hr: "HR", it: "IT", manager: "Manager", employee: "Employee" };
const STATUS_API: Record<OnboardingJoiner["overallStatus"], string> = {
  "Pre-boarding": "pre_boarding",
  "Day 1 ready": "day1_ready",
  "In progress": "in_progress",
  Completed: "completed",
};

/** Same numbers as the backend, from the local talent data (demo mode). */
export function onboardingAnalyticsLocal(
  joiners: OnboardingJoiner[],
  tasks: OnboardingTask[],
  today: string,
  country?: string,
): OnboardingAnalyticsOut {
  const js = joiners.filter((j) => !country || countryCode(j.country) === country || j.country === country);
  const ids = new Set(js.map((j) => j.id));
  const ts = tasks.filter((t) => ids.has(t.joinerId));
  const count = <K extends string>(keys: K[]) => keys.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map<K, number>());
  const byMonth = count(js.map((j) => j.startDate.slice(0, 7)));
  const byCountry = count(js.map((j) => countryCode(j.country) ?? j.country));
  const completed = new Set(js.filter((j) => j.overallStatus === "Completed").map((j) => j.id));
  const overdue = count(ts.filter((t) => t.status !== "Done" && t.due < today && !completed.has(t.joinerId)).map((t) => t.owner.toLowerCase()));
  const status: Record<string, number> = { pre_boarding: 0, day1_ready: 0, in_progress: 0, completed: 0 };
  js.forEach((j) => (status[STATUS_API[j.overallStatus]] += 1));
  const done = ts.filter((t) => t.status === "Done").length;
  return {
    total_joiners: js.length,
    joiners_by_month: [...byMonth].sort(([a], [b]) => a.localeCompare(b)).map(([month, n]) => ({ month, count: n })),
    joiners_by_country: [...byCountry].sort((a, b) => b[1] - a[1]).map(([country_code, n]) => ({ country_code, count: n })),
    tasks_total: ts.length,
    tasks_done: done,
    completion_pct: ts.length ? Math.round((100 * done) / ts.length) : 0,
    overdue_by_owner: [...overdue].sort((a, b) => b[1] - a[1]).map(([owner_role, n]) => ({ owner_role, count: n })),
    overdue_total: [...overdue.values()].reduce((a, b) => a + b, 0),
    avg_days_to_complete: null,
    preboarding_count: status.pre_boarding + status.day1_ready,
    onboarding_count: status.in_progress,
    completed_count: status.completed,
    status_counts: status,
  };
}

/** Onboarding analytics for the signed-in user (null while loading; error text when the server refused). */
export function useOnboardingAnalytics(country?: string): { data: OnboardingAnalyticsOut | null; error: string } {
  const talent = useSyncExternalStore(subscribeTalent, getTalentState, getTalentState);
  const [remote, setRemote] = useState<{ key: string; data: OnboardingAnalyticsOut | null; error: string }>({ key: "", data: null, error: "" });
  const key = country ?? "ALL";
  useEffect(() => {
    if (!API_ENABLED) return;
    let alive = true;
    apiOnboardingAnalytics(country)
      .then((data) => alive && setRemote({ key, data, error: "" }))
      .catch((e: unknown) => alive && setRemote({ key, data: null, error: e instanceof Error ? e.message : "Could not load." }));
    return () => {
      alive = false;
    };
  }, [country, key, talent.joiners.length]);
  if (!API_ENABLED) return { data: onboardingAnalyticsLocal(talent.joiners, talent.tasks, todayISO(), country), error: "" };
  return remote.key === key ? { data: remote.data, error: remote.error } : { data: null, error: "" };
}

function Bars({ items }: { items: { label: string; value: number }[] }) {
  const peak = Math.max(1, ...items.map((i) => i.value));
  return (
    <ul className="tz-bars" aria-label="Chart">
      {items.map((item) => (
        <li key={item.label}>
          <span className="tz-bar-label">{item.label}</span>
          <span className="tz-bar-track">
            <span className="tz-bar-fill" style={{ width: `${Math.min(100, (item.value / peak) * 100)}%` }} />
          </span>
          <span className="tz-bar-value">{item.value}</span>
        </li>
      ))}
    </ul>
  );
}

function monthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

/** Analytics page → Onboarding tab. */
export function OnboardingAnalyticsPanel({ country }: { country?: string }) {
  const { data, error } = useOnboardingAnalytics(country);
  if (error) return <EmptyState title="Onboarding analytics unavailable" description={error} />;
  if (!data) return <p className="muted">Loading…</p>;
  if (!data.total_joiners) return <EmptyState title="No joiners" description="No joiners in this scope yet." />;
  return (
    <div className="stack">
      <MetricGrid>
        <MetricCard label="Pre-boarding" value={data.preboarding_count} hint="Before day one" />
        <MetricCard label="Onboarding" value={data.onboarding_count} hint="Started, checklist open" />
        <MetricCard label="Checklist done" value={`${data.completion_pct}%`} hint={`${data.tasks_done} of ${data.tasks_total} tasks`} />
        <MetricCard label="Overdue tasks" value={data.overdue_total} />
        <MetricCard label="Avg days to complete" value={data.avg_days_to_complete ?? "—"} hint={`${data.completed_count} completed`} />
      </MetricGrid>
      <div className="grid-2">
        <Card title="Joiners by start month">
          <Bars items={data.joiners_by_month.map((m) => ({ label: monthLabel(m.month), value: m.count }))} />
        </Card>
        <Card title="Joiners by country">
          <Bars items={data.joiners_by_country.map((c) => ({ label: countryName(c.country_code), value: c.count }))} />
        </Card>
        <Card title="Overdue tasks by owner">
          <DataTable
            headers={["Owner", "Overdue"]}
            rows={data.overdue_by_owner.map((o) => [OWNER_LABEL[o.owner_role] ?? o.owner_role, o.count])}
            empty={<p className="note">Nothing overdue.</p>}
          />
          <p className="note" style={{ marginTop: 8 }}>
            <Link to="/onboarding">Open onboarding</Link>
          </p>
        </Card>
      </div>
    </div>
  );
}

/** HR home: small onboarding summary. */
export function OnboardingHomeCard() {
  const { data } = useOnboardingAnalytics();
  return (
    <Card title="Onboarding" action={<Link to="/onboarding" className="quiet-link">Open</Link>}>
      {!data ? (
        <p className="muted">Loading…</p>
      ) : (
        <MetricGrid>
          <MetricCard label="Pre-boarding" value={data.preboarding_count} />
          <MetricCard label="Onboarding" value={data.onboarding_count} />
          <MetricCard label="Checklist done" value={`${data.completion_pct}%`} />
          <MetricCard label="Overdue tasks" value={data.overdue_total} />
        </MetricGrid>
      )}
    </Card>
  );
}
