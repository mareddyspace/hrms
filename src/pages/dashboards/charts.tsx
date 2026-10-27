/**
 * Small dependency-free SVG charts for dashboards. Colours come from theme CSS variables
 * (see charts.css), so they follow light and night themes. Hover a mark for its exact value.
 */
import type { ReactNode } from "react";
import "./charts.css";

export interface ChartDatum {
  label: string;
  value: number;
  /** Longer name for hover text, when the label is abbreviated. */
  title?: string;
  /** CSS colour, e.g. "var(--ok)". Defaults to the categorical palette (donut) or accent (bars). */
  color?: string;
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
}: {
  data: ChartDatum[];
  ariaLabel: string;
  unit?: string;
  height?: number;
}) {
  const W = 320;
  const H = height;
  const pad = { top: 16, right: 6, bottom: 22, left: 30 };
  const innerW = W - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;
  const max = Math.max(0, ...data.map((d) => d.value));
  const t = ticks(max);
  const top = t[t.length - 1] || 1;
  const slot = innerW / Math.max(1, data.length);
  const barW = Math.min(34, slot * 0.62);
  const y = (v: number) => pad.top + innerH - (v / top) * innerH;
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel}>
      {t.map((v) => (
        <g key={v}>
          <line className="chart-grid" x1={pad.left} x2={W - pad.right} y1={y(v)} y2={y(v)} />
          <text className="chart-axis" x={pad.left - 5} y={y(v) + 3} textAnchor="end">
            {v}
          </text>
        </g>
      ))}
      {data.map((d, i) => {
        const x = pad.left + slot * i + (slot - barW) / 2;
        const h = (d.value / top) * innerH;
        return (
          <g key={d.label} className="chart-mark">
            <title>{`${d.title ?? d.label}: ${d.value}${unit}`}</title>
            <rect x={pad.left + slot * i} y={pad.top} width={slot} height={innerH} fill="transparent" />
            <rect
              className="chart-bar"
              x={x}
              y={y(d.value)}
              width={barW}
              height={Math.max(0, h)}
              rx={3}
              style={d.color ? { fill: d.color } : undefined}
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
  );
}

/* ───────────── Horizontal bar chart (long labels) ───────────── */

export function HBarChart({
  data,
  ariaLabel,
  max: fixedMax,
  unit = "",
}: {
  data: ChartDatum[];
  ariaLabel: string;
  /** Scale end, e.g. the total possible; defaults to the largest value. */
  max?: number;
  unit?: string;
}) {
  const W = 320;
  const row = 22;
  const labelW = 104;
  const valueW = 34;
  const H = data.length * row + 4;
  const top = Math.max(1, fixedMax ?? Math.max(0, ...data.map((d) => d.value)));
  const trackW = W - labelW - valueW;
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel}>
      {data.map((d, i) => {
        const yy = i * row + 2;
        return (
          <g key={d.label} className="chart-mark">
            <title>{`${d.title ?? d.label}: ${d.value}${unit}`}</title>
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
              style={d.color ? { fill: d.color } : undefined}
            />
            <text className="chart-value" x={W} y={yy + 14} textAnchor="end">
              {d.value}
              {unit}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/* ───────────── Donut ───────────── */

export function DonutChart({
  data,
  ariaLabel,
  centerValue,
  centerLabel,
  showPct = true,
}: {
  data: ChartDatum[];
  ariaLabel: string;
  centerValue?: ReactNode;
  centerLabel?: string;
  showPct?: boolean;
}) {
  const total = data.reduce((n, d) => n + d.value, 0);
  const r = 42;
  const c = 2 * Math.PI * r;
  let offset = 0;
  const pct = (v: number) => (total ? Math.round((v / total) * 1000) / 10 : 0);
  return (
    <div className="chart-donut">
      <svg className="chart chart-donut-svg" viewBox="0 0 120 120" role="img" aria-label={ariaLabel}>
        <circle className="chart-track-ring" cx={60} cy={60} r={r} />
        {total > 0 &&
          data.map((d, i) => {
            if (!d.value) return null;
            const len = (d.value / total) * c;
            const seg = (
              <circle
                key={d.label}
                className="chart-seg"
                cx={60}
                cy={60}
                r={r}
                style={{ stroke: d.color ?? paletteColor(i) }}
                strokeDasharray={`${len} ${c - len}`}
                strokeDashoffset={-offset}
                transform="rotate(-90 60 60)"
              >
                <title>{`${d.title ?? d.label}: ${d.value} (${pct(d.value)}%)`}</title>
              </circle>
            );
            offset += len;
            return seg;
          })}
        <text className="chart-center-value" x={60} y={centerLabel ? 62 : 65} textAnchor="middle">
          {centerValue ?? total}
        </text>
        {centerLabel && (
          <text className="chart-axis" x={60} y={76} textAnchor="middle">
            {centerLabel}
          </text>
        )}
      </svg>
      <ul className="chart-legend" aria-hidden="true">
        {data.map((d, i) => (
          <li key={d.label} title={`${d.title ?? d.label}: ${d.value}`}>
            <span className="chart-swatch" style={{ background: d.color ?? paletteColor(i) }} />
            <span className="chart-legend-label">{d.label}</span>
            <span className="chart-legend-value">
              {d.value}
              {showPct && <span className="muted"> · {pct(d.value)}%</span>}
            </span>
          </li>
        ))}
      </ul>
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
}: {
  labels: string[];
  /** Hover text per x position (defaults to labels). */
  titles?: string[];
  series: LineSeries[];
  ariaLabel: string;
  height?: number;
  /** Show every nth x label to avoid crowding. */
  labelEvery?: number;
}) {
  const W = 320;
  const H = height;
  const pad = { top: 12, right: 10, bottom: 22, left: 30 };
  const innerW = W - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;
  const max = Math.max(0, ...series.flatMap((s) => s.values));
  const t = ticks(max);
  const top = t[t.length - 1] || 1;
  const n = labels.length;
  const x = (i: number) => pad.left + (n <= 1 ? innerW / 2 : (innerW * i) / (n - 1));
  const y = (v: number) => pad.top + innerH - (v / top) * innerH;
  const hoverText = (i: number) =>
    `${titles?.[i] ?? labels[i]}: ${series.map((s) => `${s.name} ${s.values[i] ?? 0}`).join(", ")}`;
  return (
    <div>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel}>
        {t.map((v) => (
          <g key={v}>
            <line className="chart-grid" x1={pad.left} x2={W - pad.right} y1={y(v)} y2={y(v)} />
            <text className="chart-axis" x={pad.left - 5} y={y(v) + 3} textAnchor="end">
              {v}
            </text>
          </g>
        ))}
        {labels.map((l, i) =>
          i % labelEvery === 0 || i === n - 1 ? (
            <text key={`x${i}`} className="chart-axis" x={x(i)} y={H - 7} textAnchor="middle">
              {l}
            </text>
          ) : null,
        )}
        {series.map((s, si) => {
          const color = s.color ?? paletteColor(si);
          const d = s.values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
          return (
            <g key={s.name}>
              <path className="chart-line" d={d} style={{ stroke: color }} strokeDasharray={s.dashed ? "5 4" : undefined} />
              {s.values.map((v, i) => (
                <circle key={i} className="chart-dot" cx={x(i)} cy={y(v)} r={2.6} style={{ fill: color }} />
              ))}
            </g>
          );
        })}
        {labels.map((_, i) => {
          const half = n <= 1 ? innerW / 2 : innerW / (n - 1) / 2;
          return (
            <rect key={`h${i}`} className="chart-hover" x={x(i) - half} y={pad.top} width={half * 2} height={innerH}>
              <title>{hoverText(i)}</title>
            </rect>
          );
        })}
      </svg>
      {series.length > 1 && (
        <ul className="chart-legend chart-legend-inline" aria-hidden="true">
          {series.map((s, si) => (
            <li key={s.name}>
              <span className={s.dashed ? "chart-swatch chart-swatch-dashed" : "chart-swatch"} style={{ background: s.color ?? paletteColor(si) }} />
              <span className="chart-legend-label">{s.name}</span>
              <span className="chart-legend-value">{s.values.reduce((a, b) => a + b, 0)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
