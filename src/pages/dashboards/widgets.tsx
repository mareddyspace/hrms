import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { dateRangeLabel, type DateRangeKey } from "../../data/dashboardMock.ts";
import type { NavAccessId } from "../../demoAccounts.ts";
import { BarList, useChartTip, type BarItem } from "./chartKit.tsx";

type BarListProps = Parameters<typeof BarList>[0];

export function DashGreeting({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <header className="home-greeting row-between" style={{ alignItems: "flex-start", gap: 12 }}>
      <div>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {action}
    </header>
  );
}

export function ScopeBanner({
  scope,
  note,
}: {
  scope: string;
  note?: string;
}) {
  return (
    <div className="scope-banner" role="status">
      <strong>Scope:</strong> {scope}
      {note ? <span className="muted"> — {note}</span> : null}
    </div>
  );
}

export function AuthShortcuts({
  items,
  allowed,
}: {
  items: { label: string; to: string; access: NavAccessId }[];
  allowed: readonly NavAccessId[];
}) {
  const links = items.filter(
    (item) => allowed.includes("*") || allowed.includes(item.access),
  );
  if (!links.length) {
    return (
      <p className="note">No shortcuts available.</p>
    );
  }
  return (
    <div className="auth-shortcut-row">
      {links.map((item) => (
        <Link key={item.to} to={item.to} className="auth-shortcut">
          {item.label}
        </Link>
      ))}
    </div>
  );
}

export function DateRangeFilter({
  value,
  onChange,
  extras,
}: {
  value: DateRangeKey;
  onChange: (v: DateRangeKey) => void;
  extras?: ReactNode;
}) {
  return (
    <div className="filter-bar">
      <label className="filter-label">
        Period
        <select value={value} onChange={(e) => onChange(e.target.value as DateRangeKey)}>
          {(["7d", "30d", "90d", "ytd"] as DateRangeKey[]).map((key) => (
            <option key={key} value={key}>
              {dateRangeLabel(key)}
            </option>
          ))}
        </select>
      </label>
      {extras}
    </div>
  );
}

export function useDateRange(initial: DateRangeKey = "30d") {
  return useState<DateRangeKey>(initial);
}

export function ProgressBar({ value, label }: { value: number; label?: string }) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  const tip = useChartTip();
  return (
    <div className="dash-progress chart-wrap" ref={tip.wrapRef}>
      {label && (
        <div className="dash-progress-meta">
          <span>{label}</span>
          <span>{pct}%</span>
        </div>
      )}
      <div
        className={`dash-progress-track${tip.activeKey ? " is-active" : ""}`}
        {...tip.bind("bar", { title: label ?? "Progress", value: `${pct}%` })}
        role="progressbar"
        aria-label={label ? `${label}: ${pct}%` : `${pct}%`}
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="dash-progress-fill" style={{ width: `${pct}%` }} />
      </div>
      {tip.tooltip}
    </div>
  );
}

/** Row bars (label · bar · value). Rows with `to` drill down; `onSelect` opens details; otherwise hover/tap shows the value. */
export function MiniBars({
  items,
  valueSuffix = "",
  ...rest
}: {
  items: BarItem[];
  valueSuffix?: string;
} & Omit<BarListProps, "items" | "valueSuffix" | "variant">) {
  return <BarList items={items} valueSuffix={valueSuffix} variant="mini" {...rest} />;
}

export function PlaceholderPanel({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="placeholder-panel">
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
  );
}

export function SoftTabs({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: string; label: string }[];
  active: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="soft-tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={active === tab.id}
          className={active === tab.id ? "soft-tab active" : "soft-tab"}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

/** Bar list with a count and its share of the total. */
export function ShareBars({
  items,
  ...rest
}: { items: (Omit<BarItem, "value"> & { count: number; pct: number })[] } & Omit<BarListProps, "items" | "variant" | "share">) {
  const total = items.reduce((n, i) => n + i.count, 0);
  return (
    <BarList
      variant="mini"
      share={total}
      rowStyle={{ gridTemplateColumns: "minmax(72px, 120px) 1fr auto" }}
      items={items.map(({ count, pct, ...item }) => ({
        ...item,
        value: count,
        display: (
          <span style={{ whiteSpace: "nowrap" }}>
            {count} <span className="muted">· {pct}%</span>
          </span>
        ),
      }))}
      {...rest}
    />
  );
}
