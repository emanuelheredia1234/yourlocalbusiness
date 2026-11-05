import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChartColumn, Table2 } from 'lucide-react';
import { cn, fmtCompact, fmtDate } from '@/lib/utils';

// Chart conventions: one series uses iris (rgb(--primary)); categorical slots use --c1…--c8 in a fixed
// order and ordinal ramps --ord-1…4; text uses ink tokens; hairline gridlines (`line`) on a `line-3`
// baseline; lines 2px with a 4.5px end dot ringed in surface; bars ≤ 24px with 4px rounded data ends
// and a 2px gap. Tooltips add detail, but every chart sits in a ChartCard whose Table view carries
// every value (slots 3–5 are under 3:1 on white by design).

function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setW(Math.floor(entries[0].contentRect.width)));
    ro.observe(el);
    setW(Math.floor(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** A round step (1, 2 or 5 × 10ⁿ) near `v`. */
function niceStep(v: number): number {
  if (v <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

/** The y scale: a top of at least `minMax` and gridlines at round steps (every whole number up to 5). */
function yScale(values: number[], minMax = 1): { max: number; ticks: number[] } {
  const top = Math.max(minMax, 1, ...values);
  const step = top <= 5 && Number.isInteger(top) ? 1 : niceStep(top / 4);
  const max = Math.ceil(top / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let t = 0; t <= max + 1e-9; t += step) ticks.push(Math.round(t * 1000) / 1000);
  return { max, ticks };
}

export interface Point {
  x: string;
  y: number;
}

/** The floating value box of a chart: value, an 8px swatch and the series' label. */
function ChartTip({ left, value, label, color }: { left: number; value: string; label: string; color: string }) {
  return (
    <div className="pointer-events-none absolute top-0 z-10 rounded-pop border border-line bg-elevated px-2.5 py-1.5 shadow-pop" style={{ left }}>
      <p className="num text-small font-medium text-ink">{value}</p>
      <p className="flex items-center gap-1.5 whitespace-nowrap text-caption text-muted">
        <span className="inline-block h-2 w-2 shrink-0 rounded-xs" style={{ background: color }} aria-hidden="true" />
        {label}
      </p>
    </div>
  );
}

/** Hover, touch and arrow keys move a marker along the days. */
function useScrub(count: number, toIndex: (clientX: number) => number) {
  const [hover, setHover] = useState<number | null>(null);
  const handlers = {
    onMouseMove: (e: React.MouseEvent) => count && setHover(toIndex(e.clientX)),
    onMouseLeave: () => setHover(null),
    onTouchMove: (e: React.TouchEvent) => count && setHover(toIndex(e.touches[0].clientX)),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowRight') setHover((h) => Math.min(count - 1, (h ?? -1) + 1));
      if (e.key === 'ArrowLeft') setHover((h) => Math.max(0, (h ?? count) - 1));
      if (e.key === 'Escape') setHover(null);
    },
    onBlur: () => setHover(null),
  };
  return [hover, handlers] as const;
}

/** Gridlines with their values, and the baseline. */
function Grid({ ticks, y, left, right, format }: { ticks: number[]; y: (v: number) => number; left: number; right: number; format: (n: number) => string }) {
  return (
    <>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={left} x2={right} y1={y(t)} y2={y(t)} stroke={t === 0 ? 'rgb(var(--line-3))' : 'rgb(var(--line))'} strokeWidth="1" shapeRendering="crispEdges" />
          <text x={left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="num fill-muted text-micro">
            {format(t)}
          </text>
        </g>
      ))}
    </>
  );
}

/**
 * A line over time with a soft fill (one series). `minMax` keeps the top of the scale at least that high,
 * so a count of 1 doesn't fill the chart.
 */
export function AreaChart({ data, height = 220, color = 'rgb(var(--primary))', format = (n: number) => fmtCompact(n), label, minMax }: { data: Point[]; height?: number; color?: string; format?: (n: number) => string; label: string; minMax?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const pad = { l: 36, r: 36, t: 14, b: 26 };
  const w = Math.max(240, width);
  const ih = height - pad.t - pad.b;
  const iw = w - pad.l - pad.r;
  const { max, ticks } = yScale(
    data.map((d) => d.y),
    minMax,
  );
  const x = (i: number) => pad.l + (data.length <= 1 ? iw / 2 : (i / (data.length - 1)) * iw);
  const y = (v: number) => pad.t + ih - (v / max) * ih;
  const line = data.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d.y).toFixed(1)}`).join(' ');
  const area = data.length ? `${line} L${x(data.length - 1).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z` : '';
  const labelEvery = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(iw / 72))));
  const last = data.length - 1;
  const [active, scrub] = useScrub(data.length, (clientX) => {
    const r = ref.current?.getBoundingClientRect();
    const i = r ? Math.round(((clientX - r.left - pad.l) / iw) * (data.length - 1)) : 0;
    return Math.max(0, Math.min(data.length - 1, i));
  });
  return (
    <div ref={ref} className="relative w-full select-none rounded-xs" tabIndex={0} role="img" aria-label={`${label} over time`} {...scrub}>
      {width > 0 && (
        <svg width={w} height={height} className="block overflow-visible" aria-hidden="true">
          <Grid ticks={ticks} y={y} left={pad.l} right={w - pad.r} format={format} />
          {data.map((d, i) =>
            i % labelEvery === 0 || i === last ? (
              <text key={d.x} x={x(i)} y={height - 6} textAnchor={i === 0 ? 'start' : i === last ? 'end' : 'middle'} className="num fill-muted text-micro">
                {fmtDate(d.x)}
              </text>
            ) : null,
          )}
          <path d={area} fill={color} fillOpacity="0.08" />
          <path d={line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
          {last >= 0 && (
            <g>
              <circle cx={x(last)} cy={y(data[last].y)} r="4.5" fill={color} stroke="rgb(var(--surface))" strokeWidth="2" />
              <text x={x(last) + 9} y={y(data[last].y)} dy="0.32em" className="num fill-ink text-micro">
                {format(data[last].y)}
              </text>
            </g>
          )}
          {active !== null && data[active] && (
            <g>
              <line x1={x(active)} x2={x(active)} y1={pad.t} y2={pad.t + ih} stroke="rgb(var(--line-3))" strokeWidth="1" />
              <circle cx={x(active)} cy={y(data[active].y)} r="4.5" fill={color} stroke="rgb(var(--surface))" strokeWidth="2" />
            </g>
          )}
        </svg>
      )}
      {active !== null && data[active] && <ChartTip left={Math.min(w - 170, Math.max(0, x(active) - 60))} value={format(data[active].y)} label={`${label} · ${fmtDate(data[active].x, { weekday: 'short', month: 'short', day: 'numeric' })}`} color={color} />}
    </div>
  );
}

/**
 * Columns per day (one series): for sparse counts, where a line would draw spikes. Bars are at most 24px
 * wide with 4px rounded tops and a 2px gap; the days that have a value carry it above the bar.
 */
export function ColumnChart({ data, height = 220, color = 'rgb(var(--primary))', format = (n: number) => fmtCompact(n), label, minMax }: { data: Point[]; height?: number; color?: string; format?: (n: number) => string; label: string; minMax?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const pad = { l: 36, r: 12, t: 18, b: 26 };
  const w = Math.max(240, width);
  const ih = height - pad.t - pad.b;
  const iw = w - pad.l - pad.r;
  const { max, ticks } = yScale(
    data.map((d) => d.y),
    minMax,
  );
  const slot = data.length ? iw / data.length : iw;
  const bar = Math.max(2, Math.min(24, slot - 2));
  const cx = (i: number) => pad.l + slot * i + slot / 2;
  const y = (v: number) => pad.t + ih - (v / max) * ih;
  const labelEvery = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(iw / 72))));
  const last = data.length - 1;
  const showValues = data.filter((d) => d.y > 0).length <= 14 && bar >= 8;
  const [active, scrub] = useScrub(data.length, (clientX) => {
    const r = ref.current?.getBoundingClientRect();
    const i = r ? Math.floor((clientX - r.left - pad.l) / slot) : 0;
    return Math.max(0, Math.min(data.length - 1, i));
  });
  // a bar with a rounded top (the data end) and a square foot on the baseline
  const path = (i: number, v: number) => {
    const x0 = cx(i) - bar / 2;
    const top = y(v);
    const h = y(0) - top;
    const r = Math.min(4, bar / 2, h);
    return `M${x0},${y(0)} V${top + r} Q${x0},${top} ${x0 + r},${top} H${x0 + bar - r} Q${x0 + bar},${top} ${x0 + bar},${top + r} V${y(0)} Z`;
  };
  return (
    <div ref={ref} className="relative w-full select-none rounded-xs" tabIndex={0} role="img" aria-label={`${label} per day`} {...scrub}>
      {width > 0 && (
        <svg width={w} height={height} className="block overflow-visible" aria-hidden="true">
          <Grid ticks={ticks} y={y} left={pad.l} right={w - pad.r} format={format} />
          {active !== null && <rect x={pad.l + slot * active} y={pad.t} width={slot} height={ih} fill="rgb(var(--ink) / 0.04)" />}
          {data.map((d, i) =>
            d.y > 0 ? (
              <g key={d.x}>
                <path d={path(i, d.y)} fill={color} />
                {showValues && (
                  <text x={cx(i)} y={y(d.y) - 5} textAnchor="middle" className="num fill-ink text-micro">
                    {format(d.y)}
                  </text>
                )}
              </g>
            ) : null,
          )}
          {data.map((d, i) =>
            i % labelEvery === 0 || i === last ? (
              <text key={`x-${d.x}`} x={cx(i)} y={height - 6} textAnchor={i === 0 ? 'start' : i === last ? 'end' : 'middle'} dx={i === 0 ? -bar / 2 : i === last ? bar / 2 : 0} className="num fill-muted text-micro">
                {fmtDate(d.x)}
              </text>
            ) : null,
          )}
        </svg>
      )}
      {active !== null && data[active] && <ChartTip left={Math.min(w - 170, Math.max(0, cx(active) - 60))} value={format(data[active].y)} label={`${label} · ${fmtDate(data[active].x, { weekday: 'short', month: 'short', day: 'numeric' })}`} color={color} />}
    </div>
  );
}

/** Horizontal bars, one per row: the label above, the value at the bar's tip. `max` sets the scale. */
export function BarList({ rows, format = (n: number) => fmtCompact(n), color = 'rgb(var(--primary))', max: maxOverride }: { rows: { label: ReactNode; value: number; sub?: string; key: string }[]; format?: (n: number) => string; color?: string; max?: number }) {
  const max = maxOverride ?? (Math.max(0, ...rows.map((r) => r.value)) || 1);
  return (
    <ul className="flex flex-col gap-3">
      {rows.map((r) => {
        const share = Math.max(0, Math.min(1, r.value / (max || 1)));
        // the bar's length leaves room for the value after it
        const len = `(100% - 4rem) * ${share.toFixed(4)}`;
        return (
          <li key={r.key} className="min-w-0">
            <div className="flex min-w-0 items-center gap-2 text-small text-ink-2">
              <span className="flex min-w-0 items-center gap-1.5 truncate">{r.label}</span>
              {r.sub && <span className="shrink-0 text-caption text-muted">{r.sub}</span>}
            </div>
            <div className="relative mt-1.5 h-3">
              <span className="absolute inset-y-0 left-0 rounded-r-xs" style={{ width: `max(2px, calc(${len}))`, background: color }} aria-hidden="true" />
              <span className="num absolute top-1/2 -translate-y-1/2 text-small font-medium text-ink" style={{ left: `calc(${len} + 8px)` }}>
                {format(r.value)}
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** Kept for compatibility; the redesign shows no sparklines (a trend needs its axis). */
export function Sparkline({ values, width = 96, height = 28, color = 'rgb(var(--primary))' }: { values: number[]; width?: number; height?: number; color?: string }) {
  if (!values.length) return null;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const x = (i: number) => (values.length === 1 ? width / 2 : (i / (values.length - 1)) * (width - 6) + 3);
  const y = (v: number) => height - 3 - ((v - min) / Math.max(1e-9, max - min)) * (height - 6);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  return (
    <svg width={width} height={height} className="block overflow-visible" aria-hidden="true">
      <path d={d} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/**
 * One key number, drawn like a StatStrip cell: label, value, and a muted line under it. The change
 * against the period before shows only when that period had something to compare with (`delta` is a
 * fraction; null means no baseline). `trend` and `icon` are accepted and not drawn.
 */
export function StatTile({ label, value, delta, deltaLabel = 'vs previous period', upIsGood = true, hint }: { label: string; value: string; delta?: number | null; deltaLabel?: string; trend?: number[]; upIsGood?: boolean; hint?: string; icon?: ReactNode }) {
  const d = typeof delta === 'number' && Number.isFinite(delta) && Math.abs(delta) > 0.0005 ? delta : null;
  const good = d === null ? null : d > 0 === upIsGood;
  return (
    <div className="card min-w-0 px-5 py-4">
      <span className="block truncate text-small text-muted" title={label}>
        {label}
      </span>
      <span className="num mt-1 block text-phone-kpi text-ink sm:text-kpi">{value}</span>
      <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 text-caption text-muted">
        {d !== null ? (
          <>
            <span className={cn('font-mono', good ? 'text-good' : 'text-bad')}>
              {d > 0 ? '↑' : '↓'} {Math.abs(d * 100).toFixed(Math.abs(d) < 0.1 ? 1 : 0)}%
            </span>
            <span className="truncate">{deltaLabel}</span>
          </>
        ) : (
          hint && <span className="truncate">{hint}</span>
        )}
      </span>
    </div>
  );
}

/** Parts of a whole on one bar (2px gaps), with a legend of 8px swatches, counts and shares. */
export function StackedBar({ parts, height = 14 }: { parts: { key: string; label: string; value: number; color: string }[]; height?: number }) {
  const total = parts.reduce((s, p) => s + p.value, 0) || 1;
  const visible = parts.filter((p) => p.value > 0);
  return (
    <div>
      <div className="flex w-full gap-0.5 overflow-hidden rounded-xs" style={{ height: Math.min(24, height) }}>
        {visible.map((p) => (
          <div key={p.key} title={`${p.label}: ${p.value}`} style={{ width: `${(p.value / total) * 100}%`, background: p.color }} />
        ))}
      </div>
      <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1.5">
        {parts.map((p) => (
          <span key={p.key} className="inline-flex items-center gap-1.5 text-caption text-ink-2">
            <span className="inline-block h-2 w-2 shrink-0 rounded-xs" style={{ background: p.color }} aria-hidden="true" />
            {p.label}
            <span className="num font-medium text-ink">{p.value}</span>
            <span className="num text-muted">({Math.round((p.value / total) * 100)}%)</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/** Stages from wide to narrow on an ordinal ramp (darker = deeper), with the rate from the stage before. */
export function Funnel({ stages }: { stages: { label: string; value: number }[] }) {
  const max = Math.max(1, stages[0]?.value ?? 1);
  const ramp = ['rgb(var(--ord-1))', 'rgb(var(--ord-2))', 'rgb(var(--ord-3))', 'rgb(var(--ord-4))'];
  return (
    <div className="flex flex-col gap-2">
      {stages.map((s, i) => {
        const prev = i ? stages[i - 1].value : 0;
        const rate = i && prev ? s.value / prev : null;
        return (
          <div key={s.label} className="grid grid-cols-[110px_1fr_auto] items-center gap-3 text-small sm:grid-cols-[140px_1fr_auto]">
            <span className="truncate text-ink-2">{s.label}</span>
            <div className="h-5 w-full">
              <div className="h-full rounded-r-xs transition-[width] duration-240 ease-out" style={{ width: `${Math.max(1.5, (s.value / max) * 100)}%`, background: ramp[Math.min(i, ramp.length - 1)] }} />
            </div>
            <span className="num w-[92px] text-right">
              <span className="font-medium text-ink">{fmtCompact(s.value)}</span>
              {rate !== null && <span className="ml-1.5 text-caption text-muted">{(rate * 100).toFixed(rate < 0.1 ? 1 : 0)}%</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** A chart in a card: a title, an optional action, and a Table view of the same numbers. */
export function ChartCard({ title, subtitle, children, table, action, className }: { title: string; subtitle?: string; children: ReactNode; table?: { columns: string[]; rows: (string | number)[][] }; action?: ReactNode; className?: string }) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const rows = useMemo(() => table?.rows ?? [], [table]);
  return (
    <section className={cn('card flex min-w-0 flex-col p-4 sm:p-5', className)}>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0">
          <h3 className="text-h3 text-ink">{title}</h3>
          {subtitle && <p className="text-small text-muted">{subtitle}</p>}
        </div>
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5">
          {action}
          {table && (
            <button type="button" className="btn btn-ghost btn-xs" onClick={() => setView((v) => (v === 'chart' ? 'table' : 'chart'))} aria-label={view === 'chart' ? 'Show table' : 'Show chart'}>
              {view === 'chart' ? <Table2 /> : <ChartColumn />}
              {view === 'chart' ? 'Table' : 'Chart'}
            </button>
          )}
        </div>
      </div>
      {view === 'chart' || !table ? (
        children
      ) : (
        <div className="scroll-thin max-h-[300px] overflow-auto">
          <table className="w-full text-left text-small">
            <thead className="sticky top-0 bg-surface">
              <tr>
                {table.columns.map((c) => (
                  <th key={c} className="border-b border-line py-2 pr-3 text-caption font-medium text-muted">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-b border-line last:border-b-0">
                  {r.map((cell, j) => (
                    <td key={j} className={cn('py-2 pr-3 text-ink-2', typeof cell === 'number' && 'num font-mono')}>
                      {typeof cell === 'number' ? cell.toLocaleString() : cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
