import { useEffect, useId, useRef, useState } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { COMPANY_NAME } from "../brand.ts";
import type { LeaveRow, Project } from "../model.ts";
import { parseISODate, partyName } from "../model.ts";
import { breadcrumbsFor } from "../nav.ts";

export function Card({
  title,
  to,
  action,
  children,
  className = "",
}: {
  title?: string;
  to?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${className}`.trim()}>
      {(title || action) && (
        <div className="card-head">
          {title &&
            (to ? (
              <Link to={to} className="card-title">
                {title}
              </Link>
            ) : (
              <h2 className="card-title">{title}</h2>
            ))}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Breadcrumbs({ pathname }: { pathname: string }) {
  const crumbs = breadcrumbsFor(pathname);
  return (
    <ol className="breadcrumbs" aria-label="Breadcrumb">
      {crumbs.map((crumb, index) => (
        <li key={`${crumb.label}-${index}`}>
          {crumb.to && index < crumbs.length - 1 ? <Link to={crumb.to}>{crumb.label}</Link> : <span>{crumb.label}</span>}
        </li>
      ))}
    </ol>
  );
}

export function Page({
  title,
  subtitle,
  action,
  children,
  breadcrumbsPath,
  hideBreadcrumbs = false,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
  breadcrumbsPath?: string;
  hideBreadcrumbs?: boolean;
}) {
  const location = useLocation();
  const path = breadcrumbsPath ?? location.pathname;

  useEffect(() => {
    document.title = `${title} · ${COMPANY_NAME}`;
  }, [title]);

  return (
    <section>
      <div className="page-chrome">
        {!hideBreadcrumbs && <Breadcrumbs pathname={path} />}
        <header className="page-head row-between">
          <div>
            <h1>{title}</h1>
            {subtitle && <p>{subtitle}</p>}
          </div>
          {action}
        </header>
      </div>
      <div className="stack">{children}</div>
    </section>
  );
}

export function MetricCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <article className="metric-card">
      <p className="metric-label">{label}</p>
      <p className="metric-value">{value}</p>
      {hint && <p className="metric-hint">{hint}</p>}
    </article>
  );
}

export function MetricGrid({ children }: { children: ReactNode }) {
  return <div className="metric-grid">{children}</div>;
}

export function DataTable({
  headers,
  rows,
  empty,
}: {
  headers: string[];
  rows: ReactNode[][];
  empty?: ReactNode;
}) {
  if (!rows.length) {
    return <>{empty ?? <EmptyState title="No records" description="Nothing to show yet." />}</>;
  }
  return (
    <div className="data-table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            {headers.map((header) => (
              <th key={header}>{header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {row.map((cell, cellIndex) => (
                <td key={cellIndex}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function FilterBar({ children }: { children: ReactNode }) {
  return <div className="filter-bar">{children}</div>;
}

function normalizeStatusLabel(status: string): string {
  const key = status.trim().toLowerCase().replace(/[_-]+/g, " ");
  if (key === "pending" || key === "submitted") return "Pending";
  if (key === "approved" || key === "done" || key === "completed") return "Approved";
  if (key === "rejected" || key === "withdrawn") return "Rejected";
  if (key === "draft") return "Draft";
  if (key === "action required" || key === "actionrequired" || key === "returned") return "Action Required";
  if (key === "progress" || key === "in progress") return "In progress";
  if (key === "open") return "Open";
  if (key === "scheduled") return "Scheduled";
  return status;
}

export function StatusBadge({
  status,
  tone,
  literal = false,
}: {
  status: string;
  tone?: "ok" | "warn" | "danger" | "info" | "neutral";
  /** Show the status as written instead of mapping it to approval wording (e.g. "Completed" → "Approved"). */
  literal?: boolean;
}) {
  const label = literal ? status : normalizeStatusLabel(status);
  const key = label.toLowerCase();
  const resolved =
    tone ??
    (key === "approved" || key === "open" || key === "completed" || key === "done"
      ? "ok"
      : key === "pending" || key === "draft" || key === "action required" || key === "in progress" || key === "scheduled" || key === "interviewing"
        ? "warn"
        : key === "rejected" || key === "withdrawn" || key === "missing"
          ? "danger"
          : "neutral");
  return <span className={`status-badge ${resolved === "neutral" ? "" : resolved}`.trim()}>{label}</span>;
}

export function Tabs({
  tabs,
  value,
  onChange,
}: {
  tabs: { id: string; label: string }[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={tab.id === value}
          className={tab.id === value ? "tab-btn active" : "tab-btn"}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function Dialog({
  open,
  title,
  children,
  onClose,
  actions,
  wide = false,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
  actions?: ReactNode;
  /** Wider panel for previews such as certificates. */
  wide?: boolean;
}) {
  if (!open) return null;
  return (
    <div className="dialog-root" role="presentation">
      <button className="dialog-scrim" type="button" aria-label="Close dialog" onClick={onClose} />
      <div className={`dialog-panel${wide ? " wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby="dialog-title">
        <h2 id="dialog-title">{title}</h2>
        <div className="dialog-body">{children}</div>
        {actions && <div className="dialog-actions">{actions}</div>}
      </div>
    </div>
  );
}

export function Drawer({
  open,
  title,
  children,
  onClose,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <div className="drawer-root" role="presentation">
      <button className="drawer-scrim" type="button" aria-label="Close drawer" onClick={onClose} />
      <aside className="drawer-panel" aria-label={title}>
        <header className="row-between" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>{title}</h2>
          <button className="btn-ghost" type="button" onClick={onClose}>
            Close
          </button>
        </header>
        {children}
      </aside>
    </div>
  );
}

export function Dropdown({
  label,
  items,
}: {
  label: ReactNode;
  items: { id: string; label: string; onSelect?: () => void; to?: string }[];
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    function onDoc(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  return (
    <div className="dropdown" ref={rootRef}>
      <button
        type="button"
        className="btn-ghost"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((value) => !value)}
      >
        {label}
      </button>
      {open && (
        <div className="dropdown-menu" role="menu" id={menuId}>
          {items.map((item) =>
            item.to ? (
              <Link key={item.id} to={item.to} className="dropdown-item" role="menuitem" onClick={() => setOpen(false)}>
                {item.label}
              </Link>
            ) : (
              <button
                key={item.id}
                type="button"
                className="dropdown-item"
                role="menuitem"
                onClick={() => {
                  item.onSelect?.();
                  setOpen(false);
                }}
              >
                {item.label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <strong style={{ display: "block", color: "var(--ink)", marginBottom: 4 }}>{title}</strong>
      {description && <p style={{ margin: "0 0 12px" }}>{description}</p>}
      {action}
    </div>
  );
}

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="loading-state" role="status" aria-live="polite">
      <span className="spinner" aria-hidden />
      <span>{label}</span>
    </div>
  );
}

export function LeaveTable({ rows, showPending = false }: { rows: LeaveRow[]; showPending?: boolean }) {
  return (
    <table className="leave">
      <thead>
        <tr>
          <th>Leave type</th>
          <th>Allowed</th>
          <th>Used</th>
          {showPending && <th>Pending</th>}
          <th>Left</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.code}>
            <td>{row.name}</td>
            <td>{row.quota}</td>
            <td>{row.utilized}</td>
            {showPending && <td>{row.pending}</td>}
            <td>{row.balance}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ProjectFacts({ project, hours }: { project: Project; hours?: number }) {
  return (
    <div>
      <strong>{project.name}</strong>
      <dl className="meta">
        <dt>Vendor</dt>
        <dd>{partyName(project.vendor, "—")}</dd>
        <dt>Client</dt>
        <dd>{partyName(project.client, "—")}</dd>
        <dt>Start</dt>
        <dd>{parseISODate(project.startDate).toLocaleDateString("en-IN")}</dd>
        {hours != null && (
          <>
            <dt>Hours logged</dt>
            <dd>{hours}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

/** @deprecated Use ProjectFacts */
export const ProjectMeta = ProjectFacts;

/** @deprecated Prefer StatusBadge for new UI; kept for existing pages */
export function StatusPill({ status }: { status: string }) {
  return <StatusBadge status={status} />;
}

export function Banner({ message }: { message: { tone: "ok" | "err" | "warn" | "info"; text: string } | null }) {
  if (!message) return null;
  return <p className={`note ${message.tone}`}>{message.text}</p>;
}

export function Field({
  label,
  children,
  wide = false,
}: {
  label: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <label className={wide ? "field wide" : "field"}>
      <span>{label}</span>
      {children}
    </label>
  );
}

export function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

export function IconButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} className={`top-icon-btn ${props.className ?? ""}`.trim()} />;
}
