import { useMemo, useState } from 'react';
import { CalendarDays, Clapperboard, Image as ImageIcon, List, Megaphone, Target } from 'lucide-react';
import type { CampaignPlan, PlanDay, PlanSlot, PostPlatform } from '@/lib/types';
import { cn, fmtCompact, fmtDate, fmtTime, WEEKDAYS, weekdayIndex } from '@/lib/utils';
import { PLATFORMS, POST_TYPE_MAP, POST_TYPES, STYLE_LABEL } from '@/ai/knowledge';
import { getActiveProject, useStore } from '@/store/useStore';
import { StackedBar } from '@/components/charts/Charts';
import { Modal, Segmented } from '@/components/ui/primitives';
import { PlatformChip, PlatformGlyph } from '@/components/posts/PlatformIcon';

const PHASE_TONE: Record<string, string> = {
  Awareness: 'rgb(var(--c1))',
  Authority: 'rgb(var(--c2))',
  Trust: 'rgb(var(--c5))',
  Conversion: 'rgb(var(--c4))',
  'Final push': 'rgb(var(--c4))',
};

export function setSlotTopic(slotId: string, topic: string) {
  const plan = getActiveProject()!.marketing.plan;
  if (!plan) return;
  useStore.getState().updateMarketing({ plan: { ...plan, days: plan.days.map((d) => ({ ...d, slots: d.slots.map((s) => (s.id === slotId ? { ...s, topic } : s)) })) } });
}

export function PlanView({ plan, covered }: { plan: CampaignPlan; covered: Set<string> }) {
  const [view, setView] = useState<'calendar' | 'list'>('calendar');
  const [day, setDay] = useState<PlanDay | null>(null);
  const lead = weekdayIndex(plan.days[0]?.date ?? plan.startDate);
  const s = plan.summary;
  const platforms = Object.entries(s.byPlatform) as [PostPlatform, number][];
  const dayLive = day ? plan.days.find((d) => d.date === day.date) ?? day : null;

  return (
    <div className="flex flex-col gap-5">
      <section className="panel p-4 sm:p-5" aria-label="Campaign strategy">
        <div className="flex flex-wrap items-start gap-4">
          <div className="min-w-[240px] flex-1">
            <p className="eyebrow mb-1">Strategy</p>
            <p className="text-[14px] leading-relaxed text-ink-2">{plan.strategy}</p>
          </div>
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Posts" value={String(s.total)} icon={<Megaphone size={12} />} />
            <Stat label="Videos" value={String(s.videos)} icon={<Clapperboard size={12} />} />
            <Stat label="Images" value={String(s.images)} icon={<ImageIcon size={12} />} />
            <Stat label="Est. reach" value={fmtCompact(s.estReach)} icon={<Target size={12} />} />
          </dl>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <p className="mb-2 text-xs font-semibold text-muted">Post type mix</p>
            <StackedBar parts={POST_TYPES.map((t) => ({ key: t.id, label: t.short, value: s.byType[t.id], color: `rgb(var(--${t.slot}))` }))} />
          </div>
          <div>
            <p className="mb-2 text-xs font-semibold text-muted">Platforms</p>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {platforms.map(([p, n]) => (
                <span key={p} className="flex items-center gap-1.5 text-[13px]">
                  <PlatformChip platform={p} showLabel={false} /> {PLATFORMS[p].label} <b className="num">{n}</b>
                </span>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section aria-label="Weekly themes" className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {plan.weeks.map((w) => (
          <div key={w.week} className="panel flex flex-col gap-1.5 p-3.5">
            <p className="eyebrow">Week {w.week}</p>
            <p className="text-[14px] font-semibold leading-snug">{w.theme}</p>
            <p className="text-xs text-ink-2">{w.goal}</p>
            <p className="mt-auto pt-1 text-[11.5px] text-muted">
              <b className="text-ink-2">KPI:</b> {w.kpi}
            </p>
            <p className="text-[11.5px] italic text-muted">“{w.keyMessage}”</p>
          </div>
        ))}
      </section>

      <section className="panel overflow-hidden" aria-label="30-day calendar">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
          <h3 className="flex items-center gap-2 text-[14px] font-semibold">
            <CalendarDays size={16} className="text-primary" /> 30-day plan · {fmtDate(plan.days[0].date)} – {fmtDate(plan.days[plan.days.length - 1].date)}
          </h3>
          <Segmented
            size="sm"
            value={view}
            onChange={setView}
            options={[
              { id: 'calendar', label: 'Calendar', icon: <CalendarDays size={13} /> },
              { id: 'list', label: 'List', icon: <List size={13} /> },
            ]}
          />
        </div>
        {view === 'calendar' ? (
          <div className="overflow-x-auto p-3">
            <div className="grid min-w-[700px] grid-cols-7 gap-1.5">
              {WEEKDAYS.map((d) => (
                <div key={d} className="px-1 pb-1 text-center text-[11px] font-semibold uppercase tracking-wide text-muted">
                  {d}
                </div>
              ))}
              {Array.from({ length: lead }, (_, i) => (
                <div key={`b${i}`} />
              ))}
              {plan.days.map((d) => (
                <button key={d.date} onClick={() => setDay(d)} className={cn('flex min-h-[96px] flex-col gap-1 rounded-md border p-1.5 text-left transition-colors hover:border-primary', d.posting ? 'border-line bg-surface' : 'border-dashed border-line bg-surface-2/40')} aria-label={`${fmtDate(d.date, { weekday: 'long', month: 'long', day: 'numeric' })}: ${d.slots.length} posts`}>
                  <span className="flex items-center justify-between gap-1">
                    <span className="num text-[12px] font-bold">{fmtDate(d.date, { day: 'numeric' })}</span>
                    <span className="h-1.5 w-6 rounded-full" style={{ background: PHASE_TONE[d.phase] ?? 'rgb(var(--line))' }} title={d.phase} />
                  </span>
                  {d.slots.map((sl) => (
                    <span key={sl.id} className="flex items-center gap-1 rounded bg-surface-2 px-1 py-0.5 text-[10.5px] leading-tight" title={`${fmtTime(sl.time)} · ${PLATFORMS[sl.platform].label} · ${POST_TYPE_MAP[sl.postType].label}: ${sl.topic}`}>
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: `rgb(var(--${POST_TYPE_MAP[sl.postType].slot}))` }} />
                      {sl.format === 'video' ? <Clapperboard size={9} className="shrink-0" /> : <ImageIcon size={9} className="shrink-0" />}
                      <span className="min-w-0 truncate">{POST_TYPE_MAP[sl.postType].short}</span>
                      {covered.has(sl.id) && <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-good" title="Post generated" />}
                    </span>
                  ))}
                  {!d.posting && <span className="mt-auto text-[10px] text-faint">Rest day</span>}
                </button>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 px-1 text-[11.5px] text-muted">
              {POST_TYPES.map((t) => (
                <span key={t.id} className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full" style={{ background: `rgb(var(--${t.slot}))` }} /> {t.short}
                </span>
              ))}
              <span className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-good" /> Post generated
              </span>
            </div>
          </div>
        ) : (
          <SlotTable plan={plan} covered={covered} />
        )}
      </section>

      <Modal open={!!dayLive} onClose={() => setDay(null)} title={dayLive ? fmtDate(dayLive.date, { weekday: 'long', month: 'long', day: 'numeric' }) : ''} subtitle={dayLive ? `${dayLive.phase} phase · week ${dayLive.week}` : ''} size="md">
        {dayLive && (dayLive.slots.length ? <SlotList slots={dayLive.slots} covered={covered} /> : <p className="py-6 text-center text-[13px] text-muted">Rest day: no posts planned. Turn this weekday on in the setup to add posts.</p>)}
      </Modal>
    </div>
  );
}

function Stat({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <div className="rounded-md bg-surface-2 px-3 py-2">
      <dt className="flex items-center gap-1 text-[11px] font-medium text-muted">
        {icon}
        {label}
      </dt>
      <dd className="num text-[17px] font-bold">{value}</dd>
    </div>
  );
}

function SlotList({ slots, covered }: { slots: PlanSlot[]; covered: Set<string> }) {
  return (
    <ul className="flex flex-col gap-3">
      {slots.map((s) => (
        <li key={s.id} className="rounded-md border border-line p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
            <span className="num font-semibold">{fmtTime(s.time)}</span>
            <PlatformChip platform={s.platform} />
            <span className="badge bg-surface-2 text-ink-2">{s.format === 'video' ? 'Video' : 'Image'}</span>
            <span className="text-muted">{STYLE_LABEL[s.style]}</span>
            <span className="ml-auto flex items-center gap-1.5 font-medium">
              <span className="h-2 w-2 rounded-full" style={{ background: `rgb(var(--${POST_TYPE_MAP[s.postType].slot}))` }} />
              {POST_TYPE_MAP[s.postType].short}
            </span>
          </div>
          <label className="sr-only" htmlFor={`topic-${s.id}`}>
            Topic
          </label>
          <input id={`topic-${s.id}`} className="input" defaultValue={s.topic} onBlur={(e) => e.target.value.trim() && e.target.value !== s.topic && setSlotTopic(s.id, e.target.value.trim())} />
          {covered.has(s.id) && <p className="mt-1.5 text-[11.5px] text-good">Post already generated. Edit it in the batch below.</p>}
        </li>
      ))}
    </ul>
  );
}

function SlotTable({ plan, covered }: { plan: CampaignPlan; covered: Set<string> }) {
  const rows = useMemo(() => plan.days.flatMap((d) => d.slots.map((s) => ({ d, s }))), [plan]);
  return (
    <div className="max-h-[560px] overflow-auto scroll-thin">
      <table className="w-full min-w-[760px] text-left text-[13px]">
        <thead className="sticky top-0 z-10 border-b border-line bg-surface text-xs text-muted">
          <tr>
            <th className="px-4 py-2 font-medium">Date</th>
            <th className="px-2 py-2 font-medium">Platform</th>
            <th className="px-2 py-2 font-medium">Format · style</th>
            <th className="px-2 py-2 font-medium">Type</th>
            <th className="px-2 py-2 font-medium">Topic (editable)</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map(({ d, s }) => (
            <tr key={s.id}>
              <td className="num whitespace-nowrap px-4 py-2 text-xs">
                {fmtDate(d.date, { weekday: 'short', month: 'short', day: 'numeric' })} · {fmtTime(s.time)}
              </td>
              <td className="px-2 py-2">
                <span className="flex items-center gap-1.5 text-xs">
                  <span className="flex h-5 w-5 items-center justify-center rounded text-white" style={{ background: PLATFORMS[s.platform].color }}>
                    <PlatformGlyph platform={s.platform} size={11} />
                  </span>
                  {PLATFORMS[s.platform].label}
                </span>
              </td>
              <td className="px-2 py-2 text-xs text-ink-2">
                {s.format === 'video' ? 'Video' : 'Image'} · {STYLE_LABEL[s.style]}
              </td>
              <td className="px-2 py-2">
                <span className="flex items-center gap-1.5 whitespace-nowrap text-xs font-medium">
                  <span className="h-2 w-2 rounded-full" style={{ background: `rgb(var(--${POST_TYPE_MAP[s.postType].slot}))` }} />
                  {POST_TYPE_MAP[s.postType].short}
                </span>
              </td>
              <td className="px-2 py-1.5">
                <span className="flex items-center gap-2">
                  <input className="input input-sm min-w-[260px]" defaultValue={s.topic} onBlur={(e) => e.target.value.trim() && e.target.value !== s.topic && setSlotTopic(s.id, e.target.value.trim())} aria-label={`Topic for ${fmtDate(d.date)}`} />
                  {covered.has(s.id) && <span className="h-2 w-2 shrink-0 rounded-full bg-good" title="Post generated" />}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
