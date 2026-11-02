/**
 * Shared chart interaction: tooltip on hover (mouse), tap (touch) and focus (keyboard), highlight of the
 * active mark, and one consistent action per mark.
 *
 *   mouse     hover shows the tooltip · click runs the action
 *   touch     first tap shows the tooltip · tapping the same mark again runs the action
 *   keyboard  Tab focuses a mark (tooltip shows) · Enter / Space runs the action · Escape hides
 *
 * Marks without an action show the tooltip only and keep the default cursor (no dead clicks).
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from "react";
import { Link, useNavigate } from "react-router-dom";
import "./charts.css";

export interface TipInfo {
  title: string;
  /** Formatted value, e.g. "12 people". */
  value: string;
  /** Share of the whole, in %. */
  share?: number;
  /** Extra line, e.g. "Avg of 3 hires". */
  note?: string;
  /** What clicking does, e.g. "Open in directory". */
  action?: string;
}

type Via = "mouse" | "touch" | "focus";

interface Active {
  key: string;
  el: Element;
  info: TipInfo;
  via: Via;
  /** Anchor, in viewport coordinates (the tooltip is position: fixed so tables and scroll areas cannot clip it). */
  x: number;
  top: number;
  bottom: number;
}

export function tipAria(info: TipInfo): string {
  return [
    `${info.title}: ${info.value}${info.share !== undefined ? `, ${info.share}% of total` : ""}`,
    info.note,
    info.action,
  ]
    .filter(Boolean)
    .join(". ");
}

export const sharePct = (value: number, total: number) => (total > 0 ? Math.round((value / total) * 1000) / 10 : 0);

/** Tooltip state for one chart. Spread `bind(...)` on each mark and render `tooltip` inside `wrapRef`. */
export function useChartTip() {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [active, setActive] = useState<Active | null>(null);
  // Pointer type of the press in progress (cleared after its click); stale presses are ignored.
  const pressing = useRef<{ type: string; at: number } | null>(null);
  const pressType = () => (pressing.current && Date.now() - pressing.current.at < 1500 ? pressing.current.type : null);

  // A tap outside the chart closes a tooltip opened by touch.
  useEffect(() => {
    if (!active || active.via !== "touch") return;
    const onDown = (e: globalThis.PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setActive(null);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [active]);

  // The tooltip is fixed to the viewport, so it closes when the page scrolls under it.
  const shown = active !== null;
  useEffect(() => {
    if (!shown) return;
    // Mouse tooltips close; tap / focus tooltips follow their mark (focusing a mark may scroll it into view).
    const onScroll = () =>
      setActive((a) => {
        if (!a || a.via === "mouse" || !a.el.isConnected) return null;
        const r = a.el.getBoundingClientRect();
        if (r.bottom < 0 || r.top > window.innerHeight) return null;
        return { ...a, x: r.left + r.width / 2, top: r.top, bottom: r.bottom };
      });
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("resize", onScroll);
    };
  }, [shown]);

  function anchor(el: Element, via: Via, clientX?: number, clientY?: number) {
    if (via === "mouse" && clientX !== undefined && clientY !== undefined) {
      return { x: clientX, top: clientY - 6, bottom: clientY + 18 };
    }
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, top: r.top, bottom: r.bottom };
  }

  function bind(key: string, info: TipInfo, act?: () => void, opts: { focusable?: boolean } = {}) {
    const isActive = active?.key === key;
    const show = (el: Element, via: Via, cx?: number, cy?: number) => setActive({ key, el, info, via, ...anchor(el, via, cx, cy) });
    return {
      tabIndex: opts.focusable === false ? -1 : 0,
      role: act ? "button" : "img",
      "aria-label": tipAria(info),
      "data-active": isActive ? "true" : undefined,
      onPointerDown: (e: PointerEvent<Element>) => {
        pressing.current = { type: e.pointerType || "mouse", at: Date.now() };
      },
      onPointerEnter: (e: PointerEvent<Element>) => {
        if (e.pointerType === "mouse") show(e.currentTarget, "mouse", e.clientX, e.clientY);
      },
      onPointerMove: (e: PointerEvent<Element>) => {
        if (e.pointerType === "mouse" && (!active || active.via === "mouse")) show(e.currentTarget, "mouse", e.clientX, e.clientY);
      },
      onPointerLeave: (e: PointerEvent<Element>) => {
        if (e.pointerType === "mouse") setActive((a) => (a && a.key === key && a.via === "mouse" ? null : a));
      },
      onFocus: (e: { currentTarget: Element }) => {
        // Focus that comes from a press is handled by the click.
        if (pressType()) return;
        show(e.currentTarget, "focus");
      },
      onBlur: () => setActive((a) => (a && a.key === key && a.via !== "mouse" ? null : a)),
      onClick: (e: { currentTarget: Element; preventDefault: () => void }) => {
        const kind = pressType() ?? "mouse";
        pressing.current = null;
        if (kind === "mouse") {
          if (act) act();
          return;
        }
        // Touch / pen: first tap explains, second tap acts.
        if (isActive && active?.via === "touch" && act) {
          // The tooltip described the action just taken; the next tap explains again.
          setActive(null);
          act();
          return;
        }
        show(e.currentTarget, "touch");
      },
      onKeyDown: (e: KeyboardEvent<Element>) => {
        if ((e.key === "Enter" || e.key === " ") && act) {
          e.preventDefault();
          act();
        } else if (e.key === "Escape") {
          setActive(null);
        }
      },
    };
  }

  const tooltip = active ? <TipBox active={active} wrap={wrapRef} /> : null;
  return { wrapRef, activeKey: active?.key ?? null, bind, tooltip, clear: () => setActive(null) };
}

function TipBox({ active, wrap }: { active: Active; wrap: RefObject<HTMLDivElement | null> }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const w = wrap.current;
    if (!el || !w) return;
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    // Keep inside the card (and the screen): clamp sideways, flip below the mark when there is no room above.
    const card = (w.closest(".card") ?? w).getBoundingClientRect();
    const minX = Math.max(card.left, 0) + 4;
    const maxX = Math.min(card.right, window.innerWidth) - 4;
    const left = Math.max(minX, Math.min(active.x - width / 2, maxX - width));
    let top = active.top - height - 6;
    if (top < Math.max(card.top, 0) + 2) top = active.bottom + 6;
    setPos({ left, top });
  }, [active.x, active.top, active.bottom, active.key, active.via, wrap]);
  const { info } = active;
  const verb = active.via === "touch" ? "Tap again" : active.via === "focus" ? "Enter" : "Click";
  return (
    <div
      ref={ref}
      className="chart-tip"
      aria-hidden="true"
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? "visible" : "hidden" }}
    >
      <strong className="chart-tip-title">{info.title}</strong>
      <span className="chart-tip-value">
        {info.value}
        {info.share !== undefined && <span className="muted"> · {info.share}%</span>}
      </span>
      {info.note && <span className="chart-tip-note">{info.note}</span>}
      {info.action && (
        <span className="chart-tip-action">
          {verb} · {info.action}
        </span>
      )}
    </div>
  );
}

/* ───────────── Row bar list (label · track · value) ───────────── */

export interface BarItem {
  label: string;
  value: number;
  /** Longer name for the tooltip. */
  title?: string;
  /** Route to open on click. */
  to?: string;
  /** Overrides the list's action label for this row. */
  action?: string;
  note?: string;
  /** Text shown in the value column (defaults to value + suffix). */
  display?: ReactNode;
}

/**
 * Horizontal bar rows. `variant` keeps each page's existing look ("mini" = .mini-bars, "tz" = .tz-bars).
 * Rows with `to` navigate; with `onSelect` they call back (e.g. open a detail panel); otherwise tooltip only.
 */
export function BarList({
  items,
  variant = "mini",
  valueSuffix = "",
  format,
  max,
  share,
  onSelect,
  actionLabel,
  selected,
  ariaLabel = "Chart",
  empty = "Nothing to show yet.",
  rowStyle,
}: {
  items: BarItem[];
  variant?: "mini" | "tz";
  valueSuffix?: string;
  format?: (n: number) => string;
  /** Scale end (e.g. 100 for percentages); defaults to the largest value. */
  max?: number;
  /** Show each row's share of the whole: true = of the rows' sum, number = of that total. */
  share?: boolean | number;
  onSelect?: (item: BarItem, index: number) => void;
  actionLabel?: string | ((item: BarItem) => string | undefined);
  /** Label of the row whose details are open. */
  selected?: string | null;
  ariaLabel?: string;
  empty?: ReactNode;
  rowStyle?: CSSProperties;
}) {
  const navigate = useNavigate();
  const tip = useChartTip();
  const fmt = format ?? ((n: number) => `${n}${valueSuffix}`);
  const sum = items.reduce((n, i) => n + i.value, 0);
  const total = typeof share === "number" ? share : sum;
  const peak = max ?? Math.max(1, ...items.map((i) => i.value));
  if (!items.length || items.every((i) => !i.value)) {
    return <p className="note chart-empty-note">{empty}</p>;
  }
  const p = variant === "tz" ? "tz-bar" : "mini-bars";
  return (
    <div className={`chart-wrap${tip.activeKey ? " chart-has-active" : ""}`} ref={tip.wrapRef}>
      <ul className={variant === "tz" ? "tz-bars" : "mini-bars"} aria-label={ariaLabel}>
        {items.map((item, i) => {
          // A function actionLabel returning undefined marks a row with nothing to open (no pointer, no dead click).
          const custom = typeof actionLabel === "function" ? actionLabel(item) : actionLabel;
          const selectable = Boolean(onSelect) && !(typeof actionLabel === "function" && custom === undefined);
          const act = item.to ? () => navigate(item.to!) : selectable ? () => onSelect!(item, i) : undefined;
          const label = act ? (item.action ?? custom ?? (item.to ? "Open list" : "Show details")) : undefined;
          const key = `${i}:${item.label}`;
          const cls = [
            "chart-row",
            act ? "chart-clickable" : "",
            tip.activeKey === key ? "is-active" : "",
            selected === item.label ? "is-selected" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <li
              key={key}
              className={cls}
              style={rowStyle}
              {...tip.bind(
                key,
                {
                  title: item.title ?? item.label,
                  value: fmt(item.value),
                  share: share ? sharePct(item.value, total) : undefined,
                  note: item.note,
                  action: label,
                },
                act,
              )}
            >
              <span className={`${p}-label`}>{item.label}</span>
              <span className={`${p}-track`}>
                <span className={`${p}-fill`} style={{ display: "block", width: `${Math.min(100, Math.max(0, (item.value / peak) * 100))}%` }} />
              </span>
              <span className={`${p}-value`}>{item.display ?? fmt(item.value)}</span>
            </li>
          );
        })}
      </ul>
      {tip.tooltip}
    </div>
  );
}

/* ───────────── Detail panel (records behind a mark) ───────────── */

export interface DetailRow {
  id: string;
  /** Main text, linked when `to` is set. */
  primary: ReactNode;
  to?: string;
  secondary?: ReactNode;
}

export function ChartDetail({
  title,
  rows,
  onClose,
  more,
  empty = "No records.",
  limit = 8,
}: {
  title: string;
  rows: DetailRow[];
  onClose: () => void;
  /** Link to the full list. */
  more?: { to: string; label: string };
  empty?: ReactNode;
  limit?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
    ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [title]);
  return (
    <div
      className="chart-detail"
      ref={ref}
      tabIndex={-1}
      role="region"
      aria-label={title}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div className="chart-detail-head">
        <strong>{title}</strong>
        <button type="button" className="chart-detail-close" onClick={onClose} aria-label="Close details">
          ×
        </button>
      </div>
      {rows.length ? (
        <ul className="chart-detail-list">
          {rows.slice(0, limit).map((r) => (
            <li key={r.id}>
              <span className="chart-detail-primary">{r.to ? <Link to={r.to}>{r.primary}</Link> : r.primary}</span>
              {r.secondary !== undefined && <span className="chart-detail-secondary muted">{r.secondary}</span>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="note">{empty}</p>
      )}
      {(rows.length > limit || more) && (
        <p className="chart-detail-foot muted">
          {rows.length > limit && <span>+{rows.length - limit} more</span>}
          {rows.length > limit && more && " · "}
          {more && <Link to={more.to}>{more.label}</Link>}
        </p>
      )}
    </div>
  );
}

/** Selected label for a card's detail panel; selecting the same mark again closes it. */
export function useChartSelection<T extends string = string>() {
  const [selected, setSelected] = useState<T | null>(null);
  return {
    selected,
    toggle: (label: T) => setSelected((s) => (s === label ? null : label)),
    close: () => setSelected(null),
  };
}

/**
 * Chart + detail panel with its own selection state, for charts declared inline (e.g. in a sections list).
 * `chart` draws the chart given the selected label and a toggle; `detail` draws the panel for a selection.
 */
export function ChartWithDetail({
  chart,
  detail,
}: {
  chart: (selected: string | null, toggle: (label: string) => void) => ReactNode;
  detail: (selected: string, close: () => void) => ReactNode;
}) {
  const pick = useChartSelection();
  return (
    <>
      {chart(pick.selected, pick.toggle)}
      {pick.selected && detail(pick.selected, pick.close)}
    </>
  );
}
