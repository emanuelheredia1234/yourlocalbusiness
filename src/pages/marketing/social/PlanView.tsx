import { useMemo } from 'react';
import { Check, Clapperboard, Image as ImageIcon } from 'lucide-react';
import type { CampaignPlan, PlanDay, PlanSlot, PostPlatform } from '@/lib/types';
import { fmtDate, fmtTime } from '@/lib/utils';
import { PLATFORMS, POST_TYPE_MAP, POST_TYPES, STYLE_LABEL } from '@/ai/knowledge';
import { setSlotTopic } from '@/ai/socialPlan';
import { StackedBar } from '@/components/charts/Charts';
import { Badge, Section, StatStrip, Tooltip } from '@/components/ui/primitives';
import { PlatformGlyph } from '@/components/posts/PlatformIcon';

/** The 30-day plan as an agenda: the strategy and its numbers, then each week's theme and its posts (topics editable). */
export function PlanView({ plan, covered }: { plan: CampaignPlan; covered: Set<string> }) {
  const s = plan.summary;
  const platforms = Object.entries(s.byPlatform) as [PostPlatform, number][];
  const weeks = useMemo(
    () =>
      plan.weeks.map((w) => ({
        ...w,
        days: plan.days.filter((d) => d.week === w.week),
      })),
    [plan],
  );
  const first = plan.days[0]?.date ?? plan.startDate;
  const last = plan.days[plan.days.length - 1]?.date ?? plan.startDate;

  return (
    <div>
      <StatStrip
        items={[
          { label: 'Posts', value: s.total, sub: `${fmtDate(first)} – ${fmtDate(last)}` },
          { label: 'Videos', value: s.videos },
          { label: 'Images', value: s.images },
          { label: 'Networks', value: platforms.length, sub: platforms.map(([p, n]) => `${PLATFORMS[p].label.replace(' (Twitter)', '')} ${n}`).join(' · ') },
        ]}
      />

      <Section title="Strategy" className="mt-10">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          <p className="max-w-[72ch] text-body text-ink-2 lg:col-span-7">{plan.strategy}</p>
          <div className="lg:col-span-5">
            <p className="mb-2 text-small font-medium text-ink-2">Post mix</p>
            <StackedBar parts={POST_TYPES.map((t) => ({ key: t.id, label: t.short, value: s.byType[t.id], color: `rgb(var(--${t.slot}))` }))} />
          </div>
        </div>
      </Section>

      {weeks.map((w) => {
        const slots = w.days.flatMap((d) => d.slots.map((sl) => ({ d, sl })));
        return (
          <section key={w.week} className="mt-10" aria-label={`Week ${w.week}`}>
            <div className="mb-3">
              <h3 className="text-h4 text-ink">
                Week {w.week} <span className="text-ink-2">· {w.theme}</span>
              </h3>
              <p className="mt-0.5 text-small text-muted">{w.goal}</p>
              {(w.kpi || w.keyMessage) && (
                <p className="mt-0.5 text-caption text-muted">
                  {w.kpi && <>Watch: {w.kpi}</>}
                  {w.kpi && w.keyMessage && ' · '}
                  {w.keyMessage && <>“{w.keyMessage}”</>}
                </p>
              )}
            </div>
            {slots.length ? (
              <ul className="card divide-y divide-line overflow-hidden">
                {slots.map(({ d, sl }) => (
                  <SlotRow key={sl.id} day={d} slot={sl} done={covered.has(sl.id)} />
                ))}
              </ul>
            ) : (
              <p className="text-small text-muted">Rest week: no posts planned.</p>
            )}
          </section>
        );
      })}
    </div>
  );
}

function SlotRow({ day, slot: sl, done }: { day: PlanDay; slot: PlanSlot; done: boolean }) {
  const type = POST_TYPE_MAP[sl.postType];
  const p = PLATFORMS[sl.platform];
  const when = `${fmtDate(day.date, { weekday: 'short', month: 'short', day: 'numeric' })} · ${fmtTime(sl.time)}`;
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 px-4 py-2.5 md:grid-cols-[176px_120px_minmax(0,1fr)_auto]">
      <span className="num whitespace-nowrap font-mono text-caption text-muted">{when}</span>
      <span className="flex items-center gap-2 md:order-none">
        <Badge>
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: `rgb(var(--${type.slot}))` }} aria-hidden="true" />
          {type.short}
        </Badge>
      </span>
      <label className="col-span-2 flex min-w-0 items-center gap-2 md:col-span-1">
        <span className="sr-only">Topic for {when}</span>
        <input className="input input-inline min-w-0 flex-1 text-ui" defaultValue={sl.topic} onBlur={(e) => e.target.value.trim() && e.target.value !== sl.topic && setSlotTopic(sl.id, e.target.value.trim())} />
      </label>
      <span className="col-span-2 flex items-center justify-end gap-2.5 text-caption text-muted md:col-span-1">
        <Tooltip content={`${p.label} · ${sl.format === 'video' ? 'Video' : 'Image'} · ${STYLE_LABEL[sl.style]}`}>
          <span className="flex items-center gap-1.5" tabIndex={0} aria-label={`${p.label}, ${sl.format === 'video' ? 'video' : 'image'}, ${STYLE_LABEL[sl.style]}`}>
            <PlatformGlyph platform={sl.platform} size={14} />
            {sl.format === 'video' ? <Clapperboard size={14} aria-hidden="true" /> : <ImageIcon size={14} aria-hidden="true" />}
          </span>
        </Tooltip>
        {done && (
          <span className="flex items-center gap-1 text-good">
            <Check size={14} aria-hidden="true" /> Post ready
          </span>
        )}
      </span>
    </li>
  );
}
