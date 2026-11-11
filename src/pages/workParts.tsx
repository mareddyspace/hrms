/** Pieces shared by the Tasks and Tickets pages: the switch between them, avatars, chips and the detail drawer. */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { NavLink } from "react-router-dom";
import "../styles/tasks-tickets.css";

/** Tasks = work you or your team do; Tickets = requests raised to a team and tracked to resolution. */
export function WorkSwitch() {
  return (
    <nav className="wk-switch" aria-label="Tasks or tickets">
      <NavLink to="/tasks" className={({ isActive }) => (isActive ? "on" : undefined)}>
        <strong>Tasks</strong>
        <span>To-dos and assigned work</span>
      </NavLink>
      <NavLink to="/tickets" className={({ isActive }) => (isActive ? "on" : undefined)}>
        <strong>Tickets</strong>
        <span>Requests and issues to a team</span>
      </NavLink>
    </nav>
  );
}

export function initials(name: string | undefined): string {
  if (!name) return "–";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "–";
}

export function Avatar({ name, none = false }: { name?: string; none?: boolean }) {
  return (
    <span className={none || !name ? "wk-av none" : "wk-av"} title={name} aria-hidden="true">
      {none || !name ? "?" : initials(name)}
    </span>
  );
}

export function PriorityChip({ priority }: { priority: string }) {
  return <span className={`wk-chip wk-prio ${priority}`}>{priority}</span>;
}

/** Days between two YYYY-MM-DD dates (positive when `to` is later). */
export function dayGap(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00`) - Date.parse(`${from}T00:00:00`)) / 86_400_000);
}

/** "Today", "Tomorrow", "In 3 days", "2 days late", or a short date for later. */
export function dueText(due: string, today: string, shortDate: (iso: string) => string): string {
  const d = dayGap(today, due);
  if (d === 0) return "Today";
  if (d === 1) return "Tomorrow";
  if (d === -1) return "1 day late";
  if (d < 0) return `${-d} days late`;
  if (d <= 6) return `In ${d} days`;
  return shortDate(due);
}

/** Right-hand panel with a header, a scrolling body and a fixed footer for actions. Escape or the backdrop closes it. */
export function Drawer({
  label,
  onClose,
  head,
  foot,
  children,
}: {
  label: string;
  onClose: () => void;
  head: ReactNode;
  foot?: ReactNode;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    panel.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="wk-drawer-root">
      <button type="button" className="wk-scrim" aria-label="Close" onClick={onClose} />
      <div className="wk-drawer" role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} ref={panel}>
        <header className="wk-dhead">{head}</header>
        <div className="wk-dbody">{children}</div>
        {foot && <footer className="wk-dfoot">{foot}</footer>}
      </div>
    </div>
  );
}

export interface WorkFile {
  id: string;
  name: string;
  size?: number;
  at?: string;
  by?: string;
  internal?: boolean;
}

const FILE_ACCEPT = "application/pdf,image/png,image/jpeg,image/webp,image/gif";

function sizeText(bytes?: number): string {
  if (!bytes) return "";
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Files on a task or ticket: open, remove (when allowed) and attach (PDF or image, up to 5 MB). */
export function FileList({
  files,
  canAdd,
  canRemove,
  onAdd,
  onOpen,
  onRemove,
  offlineNote,
  extra,
}: {
  files: WorkFile[];
  canAdd: boolean;
  canRemove: (f: WorkFile) => boolean;
  onAdd: (file: File) => Promise<string | null>;
  onOpen: (f: WorkFile) => void | Promise<void>;
  onRemove: (f: WorkFile) => Promise<string | null>;
  offlineNote?: string;
  /** Extra control shown next to the attach button (e.g. "internal" for tickets). */
  extra?: ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="wk-files">
      {files.length > 0 && (
        <ul>
          {files.map((f) => (
            <li key={f.id} className={f.internal ? "internal" : undefined}>
              <button type="button" className="link-btn" onClick={() => void onOpen(f)}>
                {f.name}
              </button>
              <span className="wk-file-meta">
                {[sizeText(f.size), f.by, f.internal ? "internal" : ""].filter(Boolean).join(" · ")}
              </span>
              {canRemove(f) && (
                <button
                  type="button"
                  className="wk-x"
                  aria-label={`Remove ${f.name}`}
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    await onRemove(f);
                    setBusy(false);
                  }}
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {files.length === 0 && !canAdd && <p className="wk-desc empty">{offlineNote ?? "No files."}</p>}
      {canAdd && (
        <div className="wk-inline">
          <input
            ref={input}
            type="file"
            accept={FILE_ACCEPT}
            hidden
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              setBusy(true);
              await onAdd(file);
              setBusy(false);
            }}
          />
          <button type="button" className="btn-ghost btn-tiny" disabled={busy} onClick={() => input.current?.click()}>
            {busy ? "Uploading…" : "Attach file"}
          </button>
          {extra}
          <span className="wk-file-meta">PDF or image, up to 5 MB</span>
        </div>
      )}
    </div>
  );
}
