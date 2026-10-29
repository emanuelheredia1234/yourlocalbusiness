import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowDownRight, ArrowUpRight, Minus, Table2, ChartColumn } from 'lucide-react';
import { cn, fmtCompact, fmtDate } from '@/lib/utils';

// Chart conventions: single-series charts use the brand primary; categorical slots use
// --c1…--c8 in fixed order; text always uses ink tokens; hairline solid grid; 2px lines;
// bars ≤ 24px with 4px rounded data-ends; tooltips enhance but tables carry every value.

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

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return step * pow;
}

export interface Point {
  x: string;
  y: number;
}

export function AreaChart({ data, height = 220, color = 'rgb(var(--primary))', format = (n: number) => fmtCompact(n), label }: { data: Point[]; height?: number; color?: string; format?: (n: number) => string; label: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { l: 40, r: 44, t: 14, b: 26 };
  const w = Math.max(240, width);
  const ih = height - pad.t - pad.b;
  const iw = w - pad.l - pad.r;
  const max = niceMax(Math.max(1, ...data.map((d) => d.y)));
  const ticks = [0, max / 2, max];
  const x = (i: number) => pad.l + (data.length <= 1 ? iw / 2 : (i / (data.length - 1)) * iw);
  const y = (v: number) => pad.t + ih - (v / max) * ih;
  const line = data.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d.y).toFixed(1)}`).join(' ');
  const area = data.length ? `${line} L${x(data.length - 1).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z` : '';
  const labelEvery = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(iw / 70))));
  const last = data.length - 1;
  const active = hover ?? null;
  const onMove = (clientX: number) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r || !data.length) return;
    const rel = clientX - r.left - pad.l;
    const i = Math.round((rel / iw) * (data.length - 1));
    setHover(Math.max(0, Math.min(data.length - 1, i)));
  };
  return (
    <div
      ref={ref}
      className="relative w-full select-none outline-none"
      tabIndex={0}
      aria-label={`${label} over time`}
      onMouseMove={(e) => onMove(e.clientX)}
      onMouseLeave={() => setHover(null)}
      onTouchMove={(e) => onMove(e.touches[0].clientX)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') setHover((h) => Math.min(data.length - 1, (h ?? -1) + 1));
        if (e.key === 'ArrowLeft') setHover((h) => Math.max(0, (h ?? data.length) - 1));
        if (e.key === 'Escape') setHover(null);
      }}
      onBlur={() => setHover(null)}
    >
      {width > 0 && (
        <svg width={w} height={height} className="block overflow-visible">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.l} x2={w - pad.r} y1={y(t)} y2={y(t)} stroke="rgb(var(--line))" strokeWidth="1" />
              <text x={pad.l - 8} y={y(t)} dy="0.32em" textAnchor="end" className="num fill-muted text-[10.5px]">
                {format(t)}
              </text>
            </g>
          ))}
          {data.map((d, i) =>
            i % labelEvery === 0 || i === last ? (
              <text key={d.x} x={x(i)} y={height - 6} textAnchor={i === 0 ? 'start' : i === last ? 'end' : 'middle'} className="num fill-muted text-[10.5px]">
                {fmtDate(d.x)}
              </text>
            ) : null,
          )}
          <path d={area} fill={color} fillOpacity="0.1" />
          <path d={line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
          {last >= 0 && (
            <g>
              <circle cx={x(last)} cy={y(data[last].y)} r="4.5" fill={color} stroke="rgb(var(--surface))" strokeWidth="2" />
              <text x={x(last) + 8} y={y(data[last].y)} dy="0.32em" className="num fill-ink text-[11px] font-semibold">
                {format(data[last].y)}
              </text>
            </g>
          )}
          {active !== null && data[active] && (
            <g>
              <line x1={x(active)} x2={x(active)} y1={pad.t} y2={pad.t + ih} stroke="rgb(var(--ink-2))" strokeOpacity="0.5" strokeWidth="1" />
              <circle cx={x(active)} cy={y(data[active].y)} r="4.5" fill={color} stroke="rgb(var(--surface))" strokeWidth="2" />
            </g>
          )}
        </svg>
      )}
      {active !== null && data[active] && (
        <div className="pointer-events-none absolute z-10 rounded-md border border-line bg-surface px-2.5 py-1.5 shadow-pop" style={{ left: Math.min(w - 140, Math.max(0, x(active) - 60)), top: 0 }}>
          <p className="num text-[13px] font-bold text-ink">{format(data[active].y)}</p>
          <p className="flex items-center gap-1.5 text-[11px] text-muted">
            <span className="inline-block h-[2px] w-3 rounded" style={{ background: color }} />
            {label} · {fmtDate(data[active].x, { weekday: 'short', month: 'short', day: 'numeric' })}
          </p>
        </div>
      )}
    </div>
  );
}

export function BarList({ rows, format = (n: number) => fmtCompact(n), color = 'rgb(var(--primary))', max: maxOverride }: { rows: { label: ReactNode; value: number; sub?: string; key: string }[]; format?: (n: number) => string; color?: string; max?: number }) {
  const max = maxOverride ?? (Math.max(0, ...rows.map((r) => r.value)) || 1);
  const [hover, setHover] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-2.5">
      {rows.map((r) => (
        <div key={r.key} className="group" onMouseEnter={() => setHover(r.key)} onMouseLeave={() => setHover(null)} tabIndex={0} onFocus={() => setHover(r.key)} onBlur={() => setHover(null)}>
          <div className="mb-1 flex items-baseline justify-between gap-3 text-[13px]">
            <span className="min-w-0 truncate font-medium text-ink-2">{r.label}</span>
            <span className="num shrink-0 font-semibold text-ink">
              {format(r.value)}
              {r.sub && <span className="ml-1.5 font-normal text-muted">{r.sub}</span>}
            </span>
          </div>
          <div className="h-[14px] w-full rounded-r-[4px] bg-surface-2">
            <div className="h-full rounded-r-[4px] transition-all duration-500" style={{ width: `${Math.max(1.5, (r.value / max) * 100)}%`, background: color, opacity: hover && hover !== r.key ? 0.55 : 1 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function Sparkline({ values, width = 96, height = 28, color = 'rgb(var(--primary))' }: { values: number[]; width?: number; height?: number; color?: string }) {
  if (!values.length) return null;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const x = (i: number) => (values.length === 1 ? width / 2 : (i / (values.length - 1)) * (width - 6) + 3);
  const y = (v: number) => height - 3 - ((v - min) / Math.max(1e-9, max - min)) * (height - 6);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const last = values.length - 1;
  return (
    <svg width={width} height={height} className="block overflow-visible" aria-hidden="true">
      <path d={`${d} L${x(last)},${height} L${x(0)},${height} Z`} fill={color} fillOpacity="0.08" />
      <path d={d} fill="none" stroke="rgb(var(--faint))" strokeWidth="1.5" strokeLinejoin="round" />
      <path d={values.slice(-4).map((v, i) => `${i ? 'L' : 'M'}${x(last - Math.min(3, last) + i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
      <circle cx={x(last)} cy={y(values[last])} r="3" fill={color} stroke="rgb(var(--surface))" strokeWidth="1.5" />
    </svg>
  );
}

export function StatTile({ label, value, delta, deltaLabel = 'vs previous period', trend, upIsGood = true, hint, icon }: { label: string; value: string; delta?: number | null; deltaLabel?: string; trend?: number[]; upIsGood?: boolean; hint?: string; icon?: ReactNode }) {
  const dir = delta === null || delta === undefined ? 0 : delta > 0.0005 ? 1 : delta < -0.0005 ? -1 : 0;
  const good = dir === 0 ? null : (dir > 0) === upIsGood;
  return (
    <div className="panel flex min-w-0 flex-col gap-2 p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] font-semibold text-muted" title={label}>
          {icon}
          <span className="truncate">{label}</span>
        </span>
        {trend && (
          <span className="hidden shrink-0 sm:block">
            <Sparkline values={trend} width={52} height={22} />
          </span>
        )}
      </div>
      <span className="font-display text-[26px] font-bold leading-none tracking-[-0.02em] text-ink">{value}</span>
      <span className="flex items-center gap-1 text-xs text-muted" title={hint}>
        {delta === undefined ? (
          hint
        ) : delta === null ? (
          <>New · {deltaLabel}</>
        ) : (
          <>
            <span className={cn('inline-flex items-center gap-0.5 font-semibold', good === null ? 'text-muted' : good ? 'text-good' : 'text-bad')}>
              {dir > 0 ? <ArrowUpRight size={13} /> : dir < 0 ? <ArrowDownRight size={13} /> : <Minus size={13} />}
              {Math.abs(delta * 100).toFixed(Math.abs(delta) < 0.1 ? 1 : 0)}%
            </span>
            {deltaLabel}
          </>
        )}
      </span>
    </div>
  );
}

export function StackedBar({ parts, height = 14 }: { parts: { key: string; label: string; value: number; color: string }[]; height?: number }) {
  const total = parts.reduce((s, p) => s + p.value, 0) || 1;
  const visible = parts.filter((p) => p.value > 0);
  return (
    <div>
      <div className="flex w-full overflow-hidden rounded-[4px]" style={{ height, gap: 2 }}>
        {visible.map((p) => (
          <div key={p.key} title={`${p.label}: ${p.value}`} style={{ width: `${(p.value / total) * 100}%`, background: p.color }} />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
        {parts.map((p) => (
          <span key={p.key} className="inline-flex items-center gap-1.5 text-xs text-ink-2">
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: p.color }} />
            {p.label}
            <span className="num font-semibold text-ink">{p.value}</span>
            <span className="num text-muted">({Math.round((p.value / total) * 100)}%)</span>
          </span>
        ))}
      </div>
    </div>
  );
}

export function Funnel({ stages }: { stages: { label: string; value: number }[] }) {
  const max = Math.max(1, stages[0]?.value ?? 1);
  // ordinal ramp: darker = deeper in the funnel
  const shades = ['rgb(var(--primary) / 0.45)', 'rgb(var(--primary) / 0.62)', 'rgb(var(--primary) / 0.8)', 'rgb(var(--primary))', 'rgb(var(--primary-2))'];
  return (
    <div className="flex flex-col gap-2">
      {stages.map((s, i) => {
        const prev = i ? stages[i - 1].value : 0;
        const rate = i && prev ? s.value / prev : null;
        return (
          <div key={s.label} className="grid grid-cols-[110px_1fr_auto] items-center gap-3 text-[13px] sm:grid-cols-[140px_1fr_auto]">
            <span className="truncate font-medium text-ink-2">{s.label}</span>
            <div className="h-[22px] w-full rounded-[4px] bg-surface-2">
              <div className="h-full rounded-[4px] transition-all duration-500" style={{ width: `${Math.max(1.5, (s.value / max) * 100)}%`, background: shades[i % shades.length] }} />
            </div>
            <span className="num w-[92px] text-right">
              <b className="text-ink">{fmtCompact(s.value)}</b>
              {rate !== null && <span className="ml-1.5 text-xs text-muted">{(rate * 100).toFixed(rate < 0.1 ? 1 : 0)}%</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function ChartCard({ title, subtitle, children, table, action, className }: { title: string; subtitle?: string; children: ReactNode; table?: { columns: string[]; rows: (string | number)[][] }; action?: ReactNode; className?: string }) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const rows = useMemo(() => table?.rows ?? [], [table]);
  return (
    <section className={cn('panel flex min-w-0 flex-col p-4 sm:p-5', className)}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-display text-[15px] font-semibold text-ink">{title}</h3>
          {subtitle && <p className="text-xs text-muted">{subtitle}</p>}
        </div>
        <div className="flex min-w-0 max-w-full items-center gap-1.5">
          {action}
          {table && (
            <button className="btn btn-ghost btn-xs" onClick={() => setView((v) => (v === 'chart' ? 'table' : 'chart'))} aria-label={view === 'chart' ? 'Show table' : 'Show chart'}>
              {view === 'chart' ? <Table2 size={14} /> : <ChartColumn size={14} />}
              {view === 'chart' ? 'Table' : 'Chart'}
            </button>
          )}
        </div>
      </div>
      {view === 'chart' || !table ? (
        children
      ) : (
        <div className="scroll-thin max-h-[300px] overflow-auto">
          <table className="w-full text-left text-[13px]">
            <thead className="sticky top-0 bg-surface">
              <tr>
                {table.columns.map((c) => (
                  <th key={c} className="border-b border-line py-1.5 pr-3 text-xs font-semibold text-muted">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-b border-line/60">
                  {r.map((cell, j) => (
                    <td key={j} className={cn('py-1.5 pr-3', typeof cell === 'number' && 'num')}>
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
