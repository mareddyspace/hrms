import { useEffect, useId, useRef, useState } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { COMPANY_NAME } from "../brand.ts";
import type { LeaveRow, Project } from "../model.ts";
import { formatShortDate, partyName } from "../model.ts";
import { breadcrumbsFor } from "../nav.ts";
import { notify } from "./Toast.tsx";
export { notify, notifyError } from "./Toast.tsx";

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
      <p className="metric-value">{typeof value === "number" ? value.toLocaleString("en-GB") : value}</p>
      {hint && <p className="metric-hint">{hint}</p>}
    </article>
  );
}

export function MetricGrid({ children }: { children: ReactNode }) {
  return <div className="metric-grid">{children}</div>;
}

const NUMERIC_TEXT = /^[-+−]?(?:[A-Z]{2,3}\s|[^\d\sA-Za-z]{1,3}\s?)?[\d,]+(?:\.\d+)?\s?%?$/;

function isNumericCell(cell: ReactNode): boolean {
  if (typeof cell === "number") return true;
  return typeof cell === "string" && NUMERIC_TEXT.test(cell.trim());
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
    return <>{empty ?? <EmptyState title="Nothing here yet" />}</>;
  }
  // Columns whose filled cells are all numbers or amounts are right-aligned.
  const numericCols = headers.map((_, col) => {
    const cells = rows.map((row) => row[col]).filter((cell) => cell !== "" && cell != null && cell !== "—");
    return cells.length > 0 && cells.every(isNumericCell);
  });
  return (
    <div className="data-table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            {headers.map((header, col) => (
              <th key={`${header}-${col}`} className={numericCols[col] ? "num" : undefined}>{header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className={numericCols[cellIndex] ? "num" : undefined}>{cell}</td>
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
  if (key === "rejected") return "Rejected";
  if (key === "withdrawn") return "Withdrawn";
  if (key === "draft") return "Draft";
  if (key === "action required" || key === "actionrequired" || key === "returned") return "Action required";
  if (key === "progress" || key === "in progress") return "In progress";
  if (key === "open") return "Open";
  if (key === "scheduled") return "Scheduled";
  return status;
}

export function StatusBadge({
  status,
  tone,
  literal = false,
  keepCase = false,
}: {
  status: string;
  tone?: "ok" | "warn" | "danger" | "info" | "neutral";
  /** Show the status as written instead of mapping it to approval wording (e.g. "Completed" → "Approved"). */
  literal?: boolean;
  /** Keep the label's own capitals (sentence case, e.g. "Not checked in") instead of capitalising every word. */
  keepCase?: boolean;
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
  return (
    <span className={`status-badge ${resolved === "neutral" ? "" : resolved}`.trim()} style={keepCase ? { textTransform: "none" } : undefined}>
      {label}
    </span>
  );
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
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  if (!open) return null;
  return (
    <div className="dialog-root" role="presentation">
      <button className="dialog-scrim" type="button" aria-label="Close dialog" onClick={onClose} />
      <div className={`dialog-panel${wide ? " wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby="dialog-title">
        <button className="dialog-close" type="button" aria-label="Close" onClick={onClose}>
          ×
        </button>
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
    <div className="doc-table-wrap">
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
              <td>
                {row.quota}
                {row.carriedOver ? <span className="muted"> (incl. {row.carriedOver} carried over)</span> : null}
              </td>
              <td>{row.utilized}</td>
              {showPending && <td>{row.pending}</td>}
              <td>{row.balance}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ProjectFacts({ project, hours }: { project: Project; hours?: number }) {
  return (
    <div>
      <strong>{project.name}</strong>
      <dl className="meta">
        {project.code && (
          <>
            <dt>Code</dt>
            <dd>{project.code}</dd>
          </>
        )}
        {project.vendor && (
          <>
            <dt>Vendor</dt>
            <dd>{partyName(project.vendor, "—")}</dd>
          </>
        )}
        <dt>Client</dt>
        <dd>{partyName(project.client, "—")}</dd>
        {project.startDate && (
          <>
            <dt>Start</dt>
            <dd>{formatShortDate(project.startDate)}</dd>
          </>
        )}
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

/* ------------------------------------------------------------------ */
/* Action buttons: busy → done feedback for anything that sends data. */
/* ------------------------------------------------------------------ */

/**
 * What an action handler returns:
 * - a non-empty string: the error message (action failed)
 * - false: failed or stopped (e.g. a validation message is already shown)
 * - anything else (void, null, true, ""): success
 * Throwing also counts as a failure.
 */
export type ActionResult = string | null | undefined | void | boolean;
export type ActionHandler = () => ActionResult | Promise<ActionResult>;
export type ActionPhase = "idle" | "busy" | "done";

export type ActionOptions = {
  /** Toast shown on success, e.g. "Leave request sent to Ram Krishnan for approval." */
  success?: string | (() => string | undefined);
  /** Also toast the error message (default false: pages show errors in their own notice). */
  toastError?: boolean;
  /** Called after a successful run (reset the form here). */
  onSuccess?: () => void;
  /** Called with the error message after a failed run. */
  onError?: (message: string) => void;
};

export type Action = {
  phase: ActionPhase;
  busy: boolean;
  /** Runs the handler once (ignored while already busy). Resolves true on success. */
  run: (handler: ActionHandler, options?: ActionOptions) => Promise<boolean>;
  /** Form onSubmit helper: prevents default, then runs the handler. */
  submit: (handler: ActionHandler, options?: ActionOptions) => (event?: { preventDefault: () => void }) => void;
};

export function useAction({ doneMs = 2000, minBusyMs = 450 }: { doneMs?: number; minBusyMs?: number } = {}): Action {
  const [phase, setPhase] = useState<ActionPhase>("idle");
  const running = useRef(false);
  const mounted = useRef(true);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      window.clearTimeout(timer.current);
    };
  }, []);

  async function run(handler: ActionHandler, options: ActionOptions = {}): Promise<boolean> {
    if (running.current) return false;
    running.current = true;
    window.clearTimeout(timer.current);
    setPhase("busy");
    const started = Date.now();
    let error: string | null = null;
    let ok = true;
    try {
      // Let the busy state paint before a synchronous handler runs.
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      const result = await handler();
      if (result === false) ok = false;
      else if (typeof result === "string" && result.trim()) {
        ok = false;
        error = result;
      }
    } catch (caught) {
      ok = false;
      error = caught instanceof Error ? caught.message : "Something went wrong. Please try again.";
    }
    // Instant (local) actions still show "Saving…" briefly so the click visibly registers.
    const left = minBusyMs - (Date.now() - started);
    if (left > 0) await new Promise((resolve) => window.setTimeout(resolve, left));
    running.current = false;
    if (ok) {
      const text = typeof options.success === "function" ? options.success() : options.success;
      if (text) notify(text, "ok");
      options.onSuccess?.();
      if (mounted.current) {
        setPhase("done");
        timer.current = window.setTimeout(() => {
          if (mounted.current) setPhase("idle");
        }, doneMs);
      }
    } else {
      if (error) {
        if (options.toastError) notify(error, "err");
        options.onError?.(error);
      }
      if (mounted.current) setPhase("idle");
    }
    return ok;
  }

  return {
    phase,
    busy: phase === "busy",
    run,
    submit: (handler, options) => (event) => {
      event?.preventDefault();
      void run(handler, options);
    },
  };
}

const ACTION_VERBS: [RegExp, string, string][] = [
  [/^re-?submit/i, "Resubmitting…", "Resubmitted"],
  [/^submit/i, "Submitting…", "Submitted"],
  [/^save/i, "Saving…", "Saved"],
  [/^approve/i, "Approving…", "Approved"],
  [/^reject/i, "Rejecting…", "Rejected"],
  [/^decline/i, "Declining…", "Declined"],
  [/^send back/i, "Sending back…", "Sent back"],
  [/^send/i, "Sending…", "Sent"],
  [/^add/i, "Adding…", "Added"],
  [/^create/i, "Creating…", "Created"],
  [/^apply/i, "Applying…", "Applied"],
  [/^request/i, "Sending…", "Requested"],
  [/^raise/i, "Raising…", "Raised"],
  [/^upload/i, "Uploading…", "Uploaded"],
  [/^withdraw/i, "Withdrawing…", "Withdrawn"],
  [/^cancel/i, "Cancelling…", "Cancelled"],
  [/^delete|^remove/i, "Removing…", "Removed"],
  [/^publish/i, "Publishing…", "Published"],
  [/^confirm/i, "Confirming…", "Done"],
  [/^record/i, "Recording…", "Recorded"],
  [/^enrol/i, "Enrolling…", "Enrolled"],
  [/^update/i, "Updating…", "Updated"],
  [/^check in/i, "Checking in…", "Checked in"],
  [/^check out/i, "Checking out…", "Checked out"],
  [/^post/i, "Posting…", "Posted"],
  [/^assign/i, "Assigning…", "Assigned"],
  [/^invite/i, "Sending…", "Invited"],
  [/^schedule/i, "Scheduling…", "Scheduled"],
  [/^complete/i, "Completing…", "Completed"],
  [/^redeem/i, "Redeeming…", "Redeemed"],
  [/^give|^recogni/i, "Sending…", "Sent"],
  [/^move/i, "Moving…", "Moved"],
  [/^mark|^decide|^close|^resolve/i, "Updating…", "Done"],
];

function labelText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(labelText).join("");
  return "";
}

/** "Submit request" → { busy: "Submitting…", done: "Submitted" }. */
export function actionLabels(label: ReactNode): { busy: string; done: string } {
  const text = labelText(label).trim();
  const hit = ACTION_VERBS.find(([pattern]) => pattern.test(text));
  return hit ? { busy: hit[1], done: hit[2] } : { busy: "Working…", done: "Done" };
}

type ButtonBase = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "type" | "onError"> & {
  /** Label while running; default derived from the label ("Save" → "Saving…"). */
  busyLabel?: string;
  /** Label for ~2 s after success; default derived ("Save" → "Saved"), shown with a ✓. */
  doneLabel?: string;
};

function ActionButtonView({
  phase,
  busyLabel,
  doneLabel,
  children,
  className = "btn",
  disabled,
  ...rest
}: ButtonBase & { phase: ActionPhase; type: "button" | "submit"; onClick?: () => void }) {
  const derived = actionLabels(children);
  const busy = phase === "busy";
  const busyText = busyLabel ?? derived.busy;
  const doneText = doneLabel ?? derived.done;
  return (
    <button
      {...rest}
      className={`${className} action-btn${busy ? " is-busy" : ""}${phase === "done" ? " is-done" : ""}`}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
    >
      {busy ? (
        <>
          <span className="btn-spinner" aria-hidden />
          <span>{busyText}</span>
        </>
      ) : phase === "done" ? (
        <>
          <span className="btn-check" aria-hidden>
            ✓
          </span>
          <span>{doneText}</span>
        </>
      ) : (
        children
      )}
    </button>
  );
}

/** Form submit button driven by useAction(): <form onSubmit={act.submit(save, { success: "Saved." })}> … <SubmitButton action={act}>Save</SubmitButton>. */
export function SubmitButton({ action, ...props }: ButtonBase & { action: Action }) {
  return <ActionButtonView {...props} type="submit" phase={action.phase} />;
}

/** Stand-alone button with its own busy/done state: <ActionButton onAction={() => approve(id)} success="Approved.">Approve</ActionButton>. */
export function ActionButton({
  onAction,
  success,
  toastError,
  onSuccess,
  onError,
  action: shared,
  ...props
}: ButtonBase &
  ActionOptions & {
    onAction: ActionHandler;
    /** Optional shared state (otherwise each button keeps its own). */
    action?: Action;
  }) {
  const own = useAction();
  const action = shared ?? own;
  return (
    <ActionButtonView
      {...props}
      type="button"
      phase={action.phase}
      onClick={() => void action.run(onAction, { success, toastError, onSuccess, onError })}
    />
  );
}
