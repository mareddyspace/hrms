/**
 * Small dependency-free SVG charts for dashboards. Colours come from theme CSS variables
 * (see charts.css), so they follow light and night themes. Hover, tap or focus a mark for its exact
 * value; marks with `to` (or an `onSelect` handler) act on click — see chartKit.tsx.
 */
import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { sharePct, useChartTip } from "./chartKit.tsx";
import "./charts.css";

export interface ChartDatum {
  label: string;
  value: number;
  /** Longer name for hover text, when the label is abbreviated. */
  title?: string;
  /** CSS colour, e.g. "var(--ok)". Defaults to the categorical palette (donut) or accent (bars). */
  color?: string;
  /** Route opened when the mark is clicked. */
  to?: string;
  /** What clicking does, shown in the tooltip (defaults to the chart's actionLabel). */
  action?: string;
  /** Extra tooltip line. */
  note?: string;
}

type SelectProps = {
  /** Called when a mark without `to` is clicked (e.g. to open a detail panel). */
  onSelect?: (d: ChartDatum, index: number) => void;
  actionLabel?: string;
  /** Label of the mark whose details are open. */
  selected?: string | null;
  emptyText?: ReactNode;
};

function useMarkAction(onSelect: SelectProps["onSelect"], actionLabel: string | undefined) {
  const navigate = useNavigate();
  return (d: ChartDatum, i: number): { act?: () => void; label?: string } => {
    const act = d.to ? () => navigate(d.to!) : onSelect ? () => onSelect(d, i) : undefined;
    return { act, label: act ? (d.action ?? actionLabel ?? (d.to ? "Open list" : "Show details")) : undefined };
  };
}

/** Round up to a tidy axis maximum (1, 2, 2.5, 5 × 10^n). */
function niceMax(max: number): number {
  if (max <= 4) return Math.max(1, Math.ceil(max));
  const pow = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 2.5, 5, 10]) if (max <= step * pow) return step * pow;
  return 10 * pow;
}

function ticks(max: number, count = 4): number[] {
  const top = niceMax(max);
  const out: number[] = [];
  for (let i = 0; i <= count; i += 1) out.push(Math.round(((top * i) / count) * 10) / 10);
  return [...new Set(out)];
}

export function paletteColor(i: number): string {
  return `var(--chart-${(i % 8) + 1})`;
}

export function ChartEmpty({ children }: { children: ReactNode }) {
  return <p className="chart-empty muted">{children}</p>;
}

/* ───────────── Vertical bar chart ───────────── */

export function BarChart({
  data,
  ariaLabel,
  unit = "",
  height = 180,
  showShare = false,
  onSelect,
  actionLabel,
  selected,
  emptyText = "Nothing to show yet.",
}: {
  data: ChartDatum[];
  ariaLabel: string;
  unit?: string;
  height?: number;
  /** Tooltip shows each bar's share of the total (parts of a whole). */
  showShare?: boolean;
} & SelectProps) {
  const tip = useChartTip();
  const actionFor = useMarkAction(onSelect, actionLabel);
  if (!data.length || data.every((d) => !d.value)) return <ChartEmpty>{emptyText}</ChartEmpty>;
  const W = 320;
  const H = height;
  const pad = { top: 16, right: 6, bottom: 22, left: 30 };
  const innerW = W - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;
  const max = Math.max(0, ...data.map((d) => d.value));
  const total = data.reduce((n, d) => n + d.value, 0);
  const t = ticks(max);
  const top = t[t.length - 1] || 1;
  const slot = innerW / Math.max(1, data.length);
  const barW = Math.min(34, slot * 0.62);
  const y = (v: number) => pad.top + innerH - (v / top) * innerH;
  return (
    <div className={`chart-wrap${tip.activeKey ? " chart-has-active" : ""}`} ref={tip.wrapRef}>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="group" aria-label={ariaLabel}>
        {t.map((v) => (
          <g key={v} aria-hidden="true">
            <line className="chart-grid" x1={pad.left} x2={W - pad.right} y1={y(v)} y2={y(v)} />
            <text className="chart-axis" x={pad.left - 5} y={y(v) + 3} textAnchor="end">
              {v}
            </text>
          </g>
        ))}
        {data.map((d, i) => {
          const x = pad.left + slot * i + (slot - barW) / 2;
          const h = (d.value / top) * innerH;
          const { act, label } = actionFor(d, i);
          const key = `${i}:${d.label}`;
          return (
            <g
              key={key}
              className={markClass(Boolean(act), tip.activeKey === key, selected === d.label)}
              {...tip.bind(
                key,
                { title: d.title ?? d.label, value: `${d.value}${unit}`, share: showShare ? sharePct(d.value, total) : undefined, note: d.note, action: label },
                act,
              )}
            >
              <rect x={pad.left + slot * i} y={pad.top} width={slot} height={innerH + pad.bottom} fill="transparent" />
              <rect
                className="chart-bar"
                x={x}
                y={y(d.value)}
                width={barW}
                height={Math.max(0, h)}
                rx={3}
                style={d.color && tip.activeKey !== key && selected !== d.label ? { fill: d.color } : undefined}
              />
              <text className="chart-value" x={x + barW / 2} y={y(d.value) - 4} textAnchor="middle">
                {d.value}
              </text>
              <text className="chart-axis" x={x + barW / 2} y={H - 7} textAnchor="middle">
                {d.label}
              </text>
            </g>
          );
        })}
      </svg>
      {tip.tooltip}
    </div>
  );
}

function markClass(clickable: boolean, active: boolean, selected: boolean, base = "chart-mark") {
  return [base, clickable ? "chart-clickable" : "", active ? "is-active" : "", selected ? "is-selected" : ""].filter(Boolean).join(" ");
}

/* ───────────── Horizontal bar chart (long labels) ───────────── */

export function HBarChart({
  data,
  ariaLabel,
  max: fixedMax,
  unit = "",
  onSelect,
  actionLabel,
  selected,
  emptyText = "Nothing to show yet.",
}: {
  data: ChartDatum[];
  ariaLabel: string;
  /** Scale end, e.g. the total possible; defaults to the largest value. */
  max?: number;
  unit?: string;
} & SelectProps) {
  const tip = useChartTip();
  const actionFor = useMarkAction(onSelect, actionLabel);
  if (!data.length) return <ChartEmpty>{emptyText}</ChartEmpty>;
  const W = 320;
  const row = 22;
  const labelW = 104;
  const valueW = 34;
  const H = data.length * row + 4;
  const top = Math.max(1, fixedMax ?? Math.max(0, ...data.map((d) => d.value)));
  const trackW = W - labelW - valueW;
  return (
    <div className={`chart-wrap${tip.activeKey ? " chart-has-active" : ""}`} ref={tip.wrapRef}>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="group" aria-label={ariaLabel}>
        {data.map((d, i) => {
          const yy = i * row + 2;
          const { act, label } = actionFor(d, i);
          const key = `${i}:${d.label}`;
          return (
            <g
              key={key}
              className={markClass(Boolean(act), tip.activeKey === key, selected === d.label)}
              {...tip.bind(
                key,
                {
                  title: d.title ?? d.label,
                  value: `${d.value}${unit}${fixedMax !== undefined ? ` of ${fixedMax}` : ""}`,
                  share: fixedMax !== undefined ? sharePct(d.value, fixedMax) : undefined,
                  note: d.note,
                  action: label,
                },
                act,
              )}
            >
              <rect x={0} y={yy} width={W} height={row - 2} fill="transparent" />
              <text className="chart-axis chart-axis-strong" x={0} y={yy + 14}>
                {d.label}
              </text>
              <rect className="chart-track" x={labelW} y={yy + 4} width={trackW} height={12} rx={3} />
              <rect
                className="chart-bar"
                x={labelW}
                y={yy + 4}
                width={Math.max(0, (d.value / top) * trackW)}
                height={12}
                rx={3}
                style={d.color && tip.activeKey !== key && selected !== d.label ? { fill: d.color } : undefined}
              />
              <text className="chart-value" x={W} y={yy + 14} textAnchor="end">
                {d.value}
                {unit}
              </text>
            </g>
          );
        })}
      </svg>
      {tip.tooltip}
    </div>
  );
}

/* ───────────── Donut ───────────── */

export function DonutChart({
  data,
  ariaLabel,
  centerValue,
  centerLabel,
  showPct = true,
  onSelect,
  actionLabel,
  selected,
  emptyText = "Nothing to show yet.",
}: {
  data: ChartDatum[];
  ariaLabel: string;
  centerValue?: ReactNode;
  centerLabel?: string;
  showPct?: boolean;
} & SelectProps) {
  const tip = useChartTip();
  const actionFor = useMarkAction(onSelect, actionLabel);
  const total = data.reduce((n, d) => n + d.value, 0);
  if (!total) return <ChartEmpty>{emptyText}</ChartEmpty>;
  const r = 42;
  const c = 2 * Math.PI * r;
  let offset = 0;
  const pct = (v: number) => sharePct(v, total);
  const infoFor = (d: ChartDatum, label?: string) => ({
    title: d.title ?? d.label,
    value: String(d.value),
    share: pct(d.value),
    note: d.note,
    action: label,
  });
  return (
    <div className={`chart-wrap chart-donut${tip.activeKey ? " chart-has-active" : ""}`} ref={tip.wrapRef}>
      <svg className="chart chart-donut-svg" viewBox="0 0 120 120" role="group" aria-label={ariaLabel}>
        <circle className="chart-track-ring" cx={60} cy={60} r={r} />
        {data.map((d, i) => {
          if (!d.value) return null;
          const len = (d.value / total) * c;
          const { act, label } = actionFor(d, i);
          const key = `${i}:${d.label}`;
          const seg = (
            <circle
              key={key}
              className={markClass(Boolean(act), tip.activeKey === key || selected === d.label, false, "chart-seg")}
              cx={60}
              cy={60}
              r={r}
              style={{ stroke: d.color ?? paletteColor(i) }}
              strokeDasharray={`${len} ${c - len}`}
              strokeDashoffset={-offset}
              transform="rotate(-90 60 60)"
              {...tip.bind(key, infoFor(d, label), act, { focusable: false })}
            />
          );
          offset += len;
          return seg;
        })}
        <text className="chart-center-value" x={60} y={centerLabel ? 62 : 65} textAnchor="middle" aria-hidden="true">
          {centerValue ?? total}
        </text>
        {centerLabel && (
          <text className="chart-axis" x={60} y={76} textAnchor="middle" aria-hidden="true">
            {centerLabel}
          </text>
        )}
      </svg>
      <ul className="chart-legend">
        {data.map((d, i) => {
          const { act, label } = actionFor(d, i);
          const key = `${i}:${d.label}`;
          return (
            <li key={key} className={markClass(Boolean(act), tip.activeKey === key || selected === d.label, false, "")} {...tip.bind(key, infoFor(d, label), act)}>
              <span className="chart-swatch" style={{ background: d.color ?? paletteColor(i) }} />
              <span className="chart-legend-label">{d.label}</span>
              <span className="chart-legend-value">
                {d.value}
                {showPct && <span className="muted"> · {pct(d.value)}%</span>}
              </span>
            </li>
          );
        })}
      </ul>
      {tip.tooltip}
    </div>
  );
}

/* ───────────── Line chart ───────────── */

export interface LineSeries {
  name: string;
  values: number[];
  color?: string;
  dashed?: boolean;
}

export function LineChart({
  labels,
  titles,
  series,
  ariaLabel,
  height = 170,
  labelEvery = 1,
  onSelectIndex,
  actionLabel = "Show details",
  selectedIndex,
  emptyText = "Nothing recorded in this period.",
}: {
  labels: string[];
  /** Hover text per x position (defaults to labels). */
  titles?: string[];
  series: LineSeries[];
  ariaLabel: string;
  height?: number;
  /** Show every nth x label to avoid crowding. */
  labelEvery?: number;
  /** Called when an x position is clicked (e.g. to list that month's records). */
  onSelectIndex?: (index: number) => void;
  actionLabel?: string;
  selectedIndex?: number | null;
  emptyText?: ReactNode;
}) {
  const tip = useChartTip();
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const n = labels.length;
  if (!n || series.every((s) => s.values.every((v) => !v))) return <ChartEmpty>{emptyText}</ChartEmpty>;
  const shown = series.filter((s) => !hidden.has(s.name));
  const W = 320;
  const H = height;
  const pad = { top: 12, right: 10, bottom: 22, left: 30 };
  const innerW = W - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;
  const max = Math.max(0, ...shown.flatMap((s) => s.values));
  const t = ticks(max);
  const top = t[t.length - 1] || 1;
  const x = (i: number) => pad.left + (n <= 1 ? innerW / 2 : (innerW * i) / (n - 1));
  const y = (v: number) => pad.top + innerH - (v / top) * innerH;
  // Legend toggles series; the last visible series stays on.
  const toggle = (name: string) =>
    setHidden((h) => {
      const next = new Set(h);
      if (next.has(name)) next.delete(name);
      else if (series.length - next.size > 1) next.add(name);
      return next;
    });
  const activeIndex = tip.activeKey !== null ? Number(tip.activeKey) : (selectedIndex ?? null);
  return (
    <div>
      <div className="chart-wrap" ref={tip.wrapRef}>
        <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="group" aria-label={ariaLabel}>
          {t.map((v) => (
            <g key={v} aria-hidden="true">
              <line className="chart-grid" x1={pad.left} x2={W - pad.right} y1={y(v)} y2={y(v)} />
              <text className="chart-axis" x={pad.left - 5} y={y(v) + 3} textAnchor="end">
                {v}
              </text>
            </g>
          ))}
          {labels.map((l, i) =>
            i % labelEvery === 0 || i === n - 1 ? (
              <text key={`x${i}`} className="chart-axis" x={x(i)} y={H - 7} textAnchor="middle" aria-hidden="true">
                {l}
              </text>
            ) : null,
          )}
          {activeIndex !== null && (
            <line className="chart-grid" x1={x(activeIndex)} x2={x(activeIndex)} y1={pad.top} y2={pad.top + innerH} strokeDasharray="3 3" aria-hidden="true" />
          )}
          {shown.map((s) => {
            const si = series.indexOf(s);
            const color = s.color ?? paletteColor(si);
            const d = s.values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
            return (
              <g key={s.name} aria-hidden="true">
                <path className="chart-line" d={d} style={{ stroke: color }} strokeDasharray={s.dashed ? "5 4" : undefined} />
                {s.values.map((v, i) => (
                  <circle key={i} className={activeIndex === i ? "chart-dot is-active" : "chart-dot"} cx={x(i)} cy={y(v)} r={2.6} style={{ fill: color }} />
                ))}
              </g>
            );
          })}
          {labels.map((_, i) => {
            const half = n <= 1 ? innerW / 2 : innerW / (n - 1) / 2;
            const act = onSelectIndex ? () => onSelectIndex(i) : undefined;
            return (
              <rect
                key={`h${i}`}
                className={markClass(Boolean(act), activeIndex === i, false, "chart-hover")}
                x={x(i) - half}
                y={pad.top}
                width={half * 2}
                height={innerH}
                {...tip.bind(
                  String(i),
                  {
                    title: titles?.[i] ?? labels[i],
                    value: shown.map((s) => `${s.name} ${s.values[i] ?? 0}`).join(" · "),
                    action: act ? actionLabel : undefined,
                  },
                  act,
                )}
              />
            );
          })}
        </svg>
        {tip.tooltip}
      </div>
      {series.length > 1 && (
        <ul className="chart-legend chart-legend-inline">
          {series.map((s, si) => (
            <li key={s.name}>
              <button
                type="button"
                className="chart-legend-toggle"
                aria-pressed={!hidden.has(s.name)}
                title={hidden.has(s.name) ? `Show ${s.name}` : `Hide ${s.name}`}
                onClick={() => toggle(s.name)}
              >
                <span className={s.dashed ? "chart-swatch chart-swatch-dashed" : "chart-swatch"} style={{ background: s.color ?? paletteColor(si) }} />
                <span className="chart-legend-label">{s.name}</span>
                <span className="chart-legend-value">{s.values.reduce((a, b) => a + b, 0)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
