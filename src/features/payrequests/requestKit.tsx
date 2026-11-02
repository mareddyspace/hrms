/**
 * Building blocks shared by the self-service request pages (reimbursements, travel, cash advance, overtime,
 * leave encashment, documents): summary tiles, search / status / date filters, CSV export, a confirmation
 * dialog for withdraw / cancel, and the request thread (comments, more-information requests, files, audit trail).
 */
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { ActionButton, Dialog, Field, notify } from "../../components/ui.tsx";
import { formatShortDate } from "../../model.ts";
import {
  ATTACH_TYPES,
  addComment,
  addFile,
  loadThread,
  openFile,
  subscribeThreads,
  threadsVersion,
  type FilePurpose,
  type Thread,
  type ThreadContext,
  type ThreadEntity,
} from "./threadStore.ts";
import "./payrequests.css";

/* ───────────── Summary tiles ───────────── */

export interface Tile {
  label: string;
  value: ReactNode;
  tone?: "sky" | "lilac" | "";
  hint?: string;
}

export function SummaryTiles({ items, label }: { items: Tile[]; label: string }) {
  return (
    <section className="summary-row pr-tiles" aria-label={label}>
      {items.map((t) => (
        <div key={t.label} className={`summary${t.tone ? ` ${t.tone}` : ""}`} title={t.hint}>
          <span>{t.label}</span>
          <strong className={typeof t.value === "string" && t.value.length > 8 ? "summary-text" : undefined}>{t.value}</strong>
        </div>
      ))}
    </section>
  );
}

/* ───────────── Filters ───────────── */

export interface ListFilterState {
  q: string;
  status: string;
  from: string;
  to: string;
  category: string;
}

const EMPTY_FILTERS: ListFilterState = { q: "", status: "", from: "", to: "", category: "" };

export function useListFilters() {
  const [filters, setFilters] = useState<ListFilterState>(EMPTY_FILTERS);
  const set = (patch: Partial<ListFilterState>) => setFilters((f) => ({ ...f, ...patch }));
  const active = Object.values(filters).some(Boolean);
  return { filters, set, reset: () => setFilters(EMPTY_FILTERS), active };
}

/** Rows matching the filters. `text`: what the search looks in; `date`: the ISO date the range applies to. */
export function applyFilters<T>(
  rows: T[],
  f: ListFilterState,
  pick: { text: (r: T) => string; status: (r: T) => string; date: (r: T) => string; category?: (r: T) => string },
): T[] {
  const q = f.q.trim().toLowerCase();
  return rows.filter((r) => {
    if (q && !pick.text(r).toLowerCase().includes(q)) return false;
    if (f.status && pick.status(r) !== f.status) return false;
    const d = pick.date(r);
    if (f.from && d < f.from) return false;
    if (f.to && d > f.to) return false;
    if (f.category && pick.category && pick.category(r) !== f.category) return false;
    return true;
  });
}

export function ListFilters({
  state,
  onChange,
  onReset,
  statuses,
  categories,
  categoryLabel = "Category",
  searchPlaceholder = "Search",
  dateLabel = "Date",
  extra,
}: {
  state: ListFilterState;
  onChange: (patch: Partial<ListFilterState>) => void;
  onReset: () => void;
  statuses: string[];
  categories?: string[];
  categoryLabel?: string;
  searchPlaceholder?: string;
  dateLabel?: string;
  extra?: ReactNode;
}) {
  const active = Object.values(state).some(Boolean);
  return (
    <div className="pr-filters" role="search">
      <label className="filter-label">
        Search
        <input type="search" value={state.q} placeholder={searchPlaceholder} onChange={(e) => onChange({ q: e.target.value })} />
      </label>
      <label className="filter-label">
        Status
        <select value={state.status} onChange={(e) => onChange({ status: e.target.value })}>
          <option value="">All</option>
          {statuses.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      {categories && (
        <label className="filter-label">
          {categoryLabel}
          <select value={state.category} onChange={(e) => onChange({ category: e.target.value })}>
            <option value="">All</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="filter-label">
        {dateLabel} from
        <input type="date" value={state.from} max={state.to || undefined} onChange={(e) => onChange({ from: e.target.value })} />
      </label>
      <label className="filter-label">
        to
        <input type="date" value={state.to} min={state.from || undefined} onChange={(e) => onChange({ to: e.target.value })} />
      </label>
      {extra}
      {active && (
        <button type="button" className="btn-ghost btn-tiny" onClick={onReset}>
          Clear filters
        </button>
      )}
    </div>
  );
}

/* ───────────── CSV ───────────── */

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  // Spreadsheet formula injection: a leading = + - @ is made plain text.
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function csvText(headers: string[], rows: unknown[][]): string {
  return [headers, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
}

/** Saves a CSV file (UTF-8 with BOM so spreadsheet apps keep accents). Returns the blob for checks. */
export function downloadCsv(filename: string, headers: string[], rows: unknown[][]): Blob {
  const blob = new Blob(["﻿", csvText(headers, rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return blob;
}

export function CsvButton({ filename, headers, rows, label = "Download CSV" }: { filename: string; headers: string[]; rows: () => unknown[][]; label?: string }) {
  return (
    <button
      type="button"
      className="btn-ghost btn-tiny"
      onClick={() => {
        const data = rows();
        if (!data.length) {
          notify("Nothing to export with these filters.");
          return;
        }
        downloadCsv(filename, headers, data);
        notify(`Downloaded ${data.length} ${data.length === 1 ? "row" : "rows"}.`);
      }}
    >
      {label}
    </button>
  );
}

/* ───────────── Confirmation ───────────── */

/** A button that asks first (withdraw, cancel), then runs the action and shows its result. */
export function ConfirmButton({
  children,
  title,
  message,
  confirmLabel,
  onConfirm,
  className = "btn-ghost btn-tiny",
  success,
}: {
  children: ReactNode;
  title: string;
  message: ReactNode;
  confirmLabel: string;
  /** Resolves to an error message, or null when it worked. */
  onConfirm: () => Promise<string | null>;
  className?: string;
  success?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>
        {children}
      </button>
      <Dialog
        open={open}
        title={title}
        onClose={() => setOpen(false)}
        actions={
          <>
            <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>
              Keep it
            </button>
            <ActionButton
              className="btn btn-danger"
              toastError
              success={success}
              busyLabel="Working…"
              onAction={async () => {
                const error = await onConfirm();
                if (!error) setOpen(false);
                return error ?? true;
              }}
            >
              {confirmLabel}
            </ActionButton>
          </>
        }
      >
        <div className="pr-confirm">{message}</div>
      </Dialog>
    </>
  );
}

/* ───────────── Facts ───────────── */

export function Facts({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="info-grid pr-facts">
      {items
        .filter(([, v]) => v !== undefined && v !== null && v !== "")
        .map(([k, v]) => (
          <div key={k} className="info-fact">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
    </dl>
  );
}

/* ───────────── Thread ───────────── */

const ACTION_TEXT: Record<string, string> = {
  submitted: "Submitted",
  withdrawn: "Withdrawn",
  approved: "Approved",
  rejected: "Declined",
  paid: "Marked paid",
  edited: "Edited",
  comment: "Commented",
  info_request: "Asked for more information",
  info_reply: "Answered",
  file_added: "Added a file",
  file_downloaded: "Opened a file",
  booking_saved: "Saved the booking",
  settlement_submitted: "Submitted the settlement",
  settlement_verified: "Verified the settlement",
  settlement_rejected: "Sent the settlement back",
  uploaded: "Uploaded",
  version_added: "Uploaded a new version",
  verified: "Verified",
  approval_decided: "Decided a step",
  approval_started: "Sent for approval",
  approval_cancelled: "Approval cancelled",
};

export function auditText(action: string): string {
  const tail = action.replace(/^(expense|travel|cash_advance|encashment|overtime|document|approval|receipt)_/, "");
  return ACTION_TEXT[tail] ?? ACTION_TEXT[action] ?? tail.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${formatShortDate(iso.slice(0, 10))} ${d.toTimeString().slice(0, 5)}`;
};

const sizeText = (b: number) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

/** Comments, more-information requests, files and the audit trail of one request. */
export function RequestThread({
  type,
  id,
  ctx,
  filePurposes = ["supporting"],
  onChanged,
  showAudit = true,
  showFiles = true,
  refreshKey,
}: {
  showFiles?: boolean;
  /** Reload when this changes (e.g. the request's status after a decision elsewhere on the page). */
  refreshKey?: unknown;
  type: ThreadEntity;
  id: string;
  ctx: ThreadContext;
  filePurposes?: FilePurpose[];
  onChanged?: () => void;
  showAudit?: boolean;
}) {
  const localVersion = useSyncExternalStore(subscribeThreads, threadsVersion, threadsVersion);
  const [thread, setThread] = useState<Thread | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [tick, setTick] = useState(0);
  const [purpose, setPurpose] = useState<FilePurpose>(filePurposes[0] ?? "supporting");
  const [fileKey, setFileKey] = useState(0);
  const ctxKey = `${ctx.actorId}|${ctx.canDecide}|${ctx.reviewer}`;

  useEffect(() => {
    let live = true;
    loadThread(type, id, ctx)
      .then((t) => {
        if (!live) return;
        setThread(t);
        setError(null);
      })
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : "Couldn't load the history."));
    return () => {
      live = false;
    };
    // ctx is rebuilt each render; ctxKey carries what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, id, tick, localVersion, ctxKey, refreshKey]);

  const refresh = () => {
    setTick((n) => n + 1);
    onChanged?.();
  };

  if (error)
    return (
      <div className="pr-thread">
        <p className="muted">{error}</p>
        <button type="button" className="btn-ghost btn-tiny" onClick={() => setTick((n) => n + 1)}>
          Try again
        </button>
      </div>
    );
  if (!thread) return <p className="muted">Loading history…</p>;
  const isOwner = ctx.actorId === ctx.ownerId;

  return (
    <div className="pr-thread">
      {thread.infoOpen && (
        <p className="pr-note warn" style={{ margin: 0 }}>
          {isOwner ? "More information was asked for. Reply below; the approver is told." : "Waiting for the requester to answer the question below."}
        </p>
      )}
      <section>
        <h4>Comments</h4>
        {thread.comments.length === 0 ? (
          <p className="muted">No comments yet.</p>
        ) : (
          <ul className="pr-comments">
            {thread.comments.map((c) => (
              <li key={c.id} className={c.kind}>
                <strong>{c.authorName}</strong>
                <span className="muted">
                  {" "}
                  · {c.kind === "info_request" ? "asked for more information" : c.kind === "info_reply" ? "answered" : "commented"} · {when(c.at)}
                </span>
                <p>{c.body}</p>
              </li>
            ))}
          </ul>
        )}
        {thread.canComment && (
          <div className="pr-form">
            <Field label={thread.infoOpen && isOwner ? "Your answer" : "Comment"}>
              <textarea rows={2} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} />
            </Field>
            <div className="pr-actions">
              <ActionButton
                className="btn btn-tiny"
                toastError
                busyLabel="Sending…"
                success={thread.infoOpen && isOwner ? "Answer sent." : "Comment added."}
                onAction={async () => {
                  const err = await addComment(type, id, ctx, text, false);
                  if (!err) {
                    setText("");
                    refresh();
                  }
                  return err ?? true;
                }}
              >
                {thread.infoOpen && isOwner ? "Send answer" : "Add comment"}
              </ActionButton>
              {thread.canRequestInfo && (
                <ActionButton
                  className="btn-ghost btn-tiny"
                  toastError
                  busyLabel="Sending…"
                  success="Asked for more information."
                  onAction={async () => {
                    const err = await addComment(type, id, ctx, text, true);
                    if (!err) {
                      setText("");
                      refresh();
                    }
                    return err ?? true;
                  }}
                >
                  Request more info
                </ActionButton>
              )}
            </div>
          </div>
        )}
      </section>
      {showFiles && (
      <section>
        <h4>Files</h4>
        {thread.files.length === 0 ? (
          <p className="muted">No files.</p>
        ) : (
          <ul className="pr-files">
            {thread.files.map((f) => (
              <li key={f.id}>
                <span>
                  {f.name} <span className="muted">· {sizeText(f.size)}{f.purpose !== "supporting" ? ` · ${f.purpose}` : ""}{f.by ? ` · ${f.by}` : ""} · {when(f.at)}</span>
                </span>
                <span className="pr-actions">
                  <button
                    type="button"
                    className="btn-ghost btn-tiny"
                    onClick={async () => {
                      const err = await openFile(f, false);
                      if (err) notify(err);
                    }}
                  >
                    View
                  </button>
                  <button
                    type="button"
                    className="btn-ghost btn-tiny"
                    onClick={async () => {
                      const err = await openFile(f, true);
                      if (err) notify(err);
                    }}
                  >
                    Download
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
        {thread.canAttach && (
          <div className="pr-actions">
            {filePurposes.length > 1 && (
              <select value={purpose} onChange={(e) => setPurpose(e.target.value as FilePurpose)} aria-label="File type">
                {filePurposes.map((p) => (
                  <option key={p} value={p}>
                    {p === "settlement" ? "Settlement receipt" : p === "booking" ? "Booking / ticket" : "Supporting document"}
                  </option>
                ))}
              </select>
            )}
            <label className="btn-ghost btn-tiny pr-file-btn">
              Add file (PDF or image)
              <input
                key={fileKey}
                type="file"
                accept={ATTACH_TYPES}
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  setFileKey((k) => k + 1);
                  if (!file) return;
                  const err = await addFile(type, id, ctx, file, purpose);
                  if (err) notify(err);
                  else {
                    notify(`${file.name} added.`);
                    refresh();
                  }
                }}
              />
            </label>
          </div>
        )}
      </section>
      )}
      {showAudit && thread.audit.length > 0 && (
        <section>
          <h4>Audit trail</h4>
          <ul className="pr-audit">
            {thread.audit.map((a, i) => (
              <li key={`${a.at}-${i}`}>
                <span>{auditText(a.action)}</span>
                <span className="muted">
                  {a.actor} · {when(a.at)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** Opens a request from ?open=<id> once the rows have loaded (links in notifications). */
export function useOpenFromQuery(ids: string[], open: (id: string) => void): void {
  const wanted = useMemo(() => (typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("open")), []);
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (done || !wanted || !ids.includes(wanted)) return;
    setDone(true);
    open(wanted);
  }, [done, wanted, ids, open]);
}

/* ───────────── Server values (policies) ───────────── */

/**
 * Loads a value from the server and keeps the last good one while it reloads. Unlike a plain effect with
 * `.catch(() => undefined)`, a failure is shown (with Retry) instead of leaving the page on "Loading…", and a
 * reload triggered by `key` never discards a result that is still on its way.
 */
export function useServerValue<T>(load: (() => Promise<T>) | null, key: unknown): { value: T | null; error: string | null; retry: () => void } {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!load) return;
    let mounted = true;
    load()
      .then((v) => {
        if (!mounted) return;
        setValue(v);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!mounted) return;
        setError(e instanceof Error && e.message ? e.message : "Couldn't load from the server.");
      });
    return () => {
      mounted = false;
    };
    // `load` is a fresh closure each render; `key` and `tick` decide when to reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick, load === null]);
  return { value, error, retry: () => setTick((n) => n + 1) };
}

/** "Loading…" while waiting, or the error with a Retry button. */
export function LoadState({ error, onRetry, label = "Loading…" }: { error: string | null; onRetry: () => void; label?: string }) {
  if (!error) return <p className="muted">{label}</p>;
  return (
    <div className="pr-actions">
      <p className="pr-note err" style={{ margin: 0 }}>
        Couldn't load: {error}
      </p>
      <button type="button" className="btn-ghost btn-tiny" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}
