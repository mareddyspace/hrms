import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { dateRangeLabel, type DateRangeKey } from "../../data/dashboardMock.ts";
import type { NavAccessId } from "../../demoAccounts.ts";

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
  return (
    <div className="dash-progress">
      {label && (
        <div className="dash-progress-meta">
          <span>{label}</span>
          <span>{pct}%</span>
        </div>
      )}
      <div className="dash-progress-track" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} role="progressbar">
        <div className="dash-progress-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function MiniBars({
  items,
  valueSuffix = "",
}: {
  items: { label: string; value: number }[];
  valueSuffix?: string;
}) {
  const max = Math.max(...items.map((i) => i.value), 1);
  return (
    <ul className="mini-bars">
      {items.map((item) => (
        <li key={item.label}>
          <span className="mini-bars-label">{item.label}</span>
          <div className="mini-bars-track">
            <div className="mini-bars-fill" style={{ width: `${(item.value / max) * 100}%` }} />
          </div>
          <span className="mini-bars-value">
            {item.value}
            {valueSuffix}
          </span>
        </li>
      ))}
    </ul>
  );
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
