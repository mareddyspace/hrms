/** Pieces shared by the Tasks and Tickets pages: the switch between them, avatars, chips and the detail drawer. */
import { useEffect, useRef, type ReactNode } from "react";
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
