import { useMemo } from 'react';
import { AlertTriangle, CalendarDays, Check, Clapperboard, Globe, Image as ImageIcon, Link2, Users } from 'lucide-react';
import type { CampaignConfig, ImageStyleId, PostPlatform, PostType, Project, VideoStyleId } from '@/lib/types';
import { cn, fmtCompact, stripProtocol, WEEKDAYS } from '@/lib/utils';
import { IMAGE_STYLES, PLATFORMS, POST_PLATFORMS, POST_TYPES, VIDEO_STYLES } from '@/ai/knowledge';
import { suggestTopics } from '@/ai/local/social';
import { getActiveProject, useStore } from '@/store/useStore';
import { Field, Segmented, Toggle } from '@/components/ui/primitives';
import { StackedBar } from '@/components/charts/Charts';
import { PostVisual } from '@/components/visuals/PostVisual';
import { PlatformChip } from '@/components/posts/PlatformIcon';
import { openConnect } from '@/components/posts/Connect';

const WEIGHTS = [
  { id: '0', label: 'Off' },
  { id: '1', label: 'Some' },
  { id: '2', label: 'More' },
  { id: '3', label: 'Most' },
] as const;

export function useCampaign() {
  const updateMarketing = useStore((s) => s.updateMarketing);
  return (patch: Partial<CampaignConfig>) => updateMarketing({ campaign: { ...getActiveProject()!.marketing.campaign, ...patch } });
}

export function cadence(cfg: CampaignConfig) {
  const days = cfg.days.filter(Boolean).length;
  const perWeek = days * cfg.postsPerDay;
  const videos = days * Math.min(cfg.videosPerDay, cfg.postsPerDay);
  // approx. posts over 30 days
  const month = Math.round((perWeek * 30) / 7);
  return { days, perWeek, videos, images: perWeek - videos, month };
}

export function CampaignSetup({ project }: { project: Project }) {
  const cfg = project.marketing.campaign;
  const set = useCampaign();
  const accounts = useStore((s) => s.settings.accounts);
  const c = cadence(cfg);
  const sample = useMemo(() => suggestTopics(project)[0] ?? project.brand.tagline, [project]);
  const site = stripProtocol(project.brand.websiteUrl || `${project.brand.slug}.com`);
  const typeTotal = POST_TYPES.reduce((n, t) => n + cfg.postTypes[t.id], 0) || 1;
  const needImageStyle = c.images > 0 && cfg.imageStyles.length === 0;
  const needVideoStyle = c.videos > 0 && cfg.videoStyles.length === 0;

  const toggleIn = <T extends string>(list: T[], id: T): T[] => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  return (
    <div className="flex flex-col gap-5">
      <section className="panel p-4 sm:p-5" aria-label="Cadence">
        <h2 className="section-title mb-1 flex items-center gap-2">
          <CalendarDays size={17} className="text-primary" /> Posting cadence
        </h2>
        <p className="mb-4 text-[13px] text-muted">Pick your posting days, how many posts per day, and how many of those are videos.</p>
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <Field label="Posting days">
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Posting days">
              {WEEKDAYS.map((d, i) => (
                <button key={d} className={cn('chip min-w-[48px] justify-center', cfg.days[i] && 'chip-active')} aria-pressed={cfg.days[i]} onClick={() => set({ days: cfg.days.map((x, j) => (j === i ? !x : x)) })}>
                  {d}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Campaign goal">
            <Segmented<CampaignConfig['goal']>
              size="sm"
              value={cfg.goal}
              onChange={(goal) => set({ goal })}
              options={[
                { id: 'awareness', label: 'Awareness' },
                { id: 'leads', label: 'Leads' },
                { id: 'sales', label: project.track === 'business' ? 'Bookings' : 'Sales' },
              ]}
            />
          </Field>
          <Field label="Posts per day">
            <Segmented
              size="sm"
              value={String(cfg.postsPerDay)}
              onChange={(v) => {
                const n = Number(v);
                set({ postsPerDay: n, videosPerDay: Math.min(cfg.videosPerDay, n) });
              }}
              options={[1, 2, 3, 4, 5].map((n) => ({ id: String(n), label: String(n) }))}
            />
          </Field>
          <Field label="Videos per day" hint={`${cfg.postsPerDay - Math.min(cfg.videosPerDay, cfg.postsPerDay)} image post${cfg.postsPerDay - cfg.videosPerDay === 1 ? '' : 's'} + ${Math.min(cfg.videosPerDay, cfg.postsPerDay)} video${cfg.videosPerDay === 1 ? '' : 's'} each posting day`}>
            <Segmented size="sm" value={String(Math.min(cfg.videosPerDay, cfg.postsPerDay))} onChange={(v) => set({ videosPerDay: Number(v) })} options={Array.from({ length: cfg.postsPerDay + 1 }, (_, n) => ({ id: String(n), label: String(n) }))} />
          </Field>
          <Field label="Posting times">
            <div className="flex flex-wrap gap-2">
              {Array.from({ length: cfg.postsPerDay }, (_, i) => (
                <input key={i} type="time" className="input input-sm w-[118px]" value={cfg.times[i] ?? '12:00'} onChange={(e) => set({ times: Object.assign([...cfg.times], { [i]: e.target.value }) })} aria-label={`Post ${i + 1} time`} />
              ))}
            </div>
          </Field>
          <Field label="Start date" htmlFor="cmp-start">
            <input id="cmp-start" type="date" className="input w-[180px]" value={cfg.startDate} onChange={(e) => e.target.value && set({ startDate: e.target.value })} />
          </Field>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-md bg-surface-2 px-4 py-3 text-[13px]">
          <span>
            <b className="num">{c.perWeek}</b> posts/week
          </span>
          <span className="flex items-center gap-1">
            <Clapperboard size={13} /> <b className="num">{c.videos}</b> videos
          </span>
          <span className="flex items-center gap-1">
            <ImageIcon size={13} /> <b className="num">{c.images}</b> images
          </span>
          <span className="text-muted">
            ≈ <b className="num text-ink">{c.month}</b> posts over 30 days
          </span>
          {c.days === 0 && <span className="text-warn">Pick at least one posting day.</span>}
        </div>
      </section>

      <section className="panel p-4 sm:p-5" aria-label="Website watermark">
        <Toggle checked={cfg.watermark} onChange={(v) => set({ watermark: v })} label="Add my website as a watermark" description={site ? <>Every image and video shows <b className="text-ink">{site}</b> in the corner.</> : 'Add your website in Settings → Brand to show it on every visual.'} />
      </section>

      <section className="panel p-4 sm:p-5" aria-label="Visual styles">
        <h2 className="section-title mb-1">Visual styles</h2>
        <p className="mb-4 text-[13px] text-muted">Select the looks to rotate through. Every preview uses your brand colors.</p>
        <h3 className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold">
          <ImageIcon size={14} /> Image styles
        </h3>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
          {IMAGE_STYLES.map((s) => (
            <StyleCard key={s.id} checked={cfg.imageStyles.includes(s.id)} onToggle={() => set({ imageStyles: toggleIn<ImageStyleId>(cfg.imageStyles, s.id) })} label={s.label} desc={s.bestFor}>
              <PostVisual style={s.id} headline={sample} brand={project.brand} watermark={cfg.watermark} aspect="1/1" points={['Start small', 'Stay consistent', 'Track wins']} />
            </StyleCard>
          ))}
        </div>
        {needImageStyle && <Warn>Choose at least one image style for your image posts.</Warn>}
        <h3 className="mb-2 mt-5 flex items-center gap-1.5 text-[13px] font-semibold">
          <Clapperboard size={14} /> Video styles
        </h3>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
          {VIDEO_STYLES.map((s) => (
            <StyleCard key={s.id} checked={cfg.videoStyles.includes(s.id)} onToggle={() => set({ videoStyles: toggleIn<VideoStyleId>(cfg.videoStyles, s.id) })} label={s.label} desc={s.bestFor}>
              <PostVisual style={s.id} headline={sample} brand={project.brand} watermark={cfg.watermark} aspect="9/16" hoverPlay className="max-h-[260px]" />
            </StyleCard>
          ))}
        </div>
        {needVideoStyle && <Warn>Choose at least one video style, or set videos per day to 0.</Warn>}
      </section>

      <section className="panel p-4 sm:p-5" aria-label="Platforms and accounts">
        <h2 className="section-title mb-1 flex items-center gap-2">
          <Globe size={17} className="text-primary" /> Platforms & accounts
        </h2>
        <p className="mb-4 text-[13px] text-muted">Choose where this campaign publishes. Connect an account to schedule and publish (demo connection, no real posting).</p>
        <ul className="grid grid-cols-1 gap-2 md:grid-cols-2">
          {POST_PLATFORMS.map((p) => {
            const on = cfg.platforms.includes(p);
            const acct = accounts[p];
            return (
              <li key={p} className={cn('flex items-center gap-3 rounded-md border px-3 py-2.5', on ? 'border-primary/50 bg-primary-soft/50' : 'border-line')}>
                <input type="checkbox" className="h-4 w-4 accent-[rgb(var(--primary))]" checked={on} onChange={() => set({ platforms: toggleIn<PostPlatform>(cfg.platforms, p) })} aria-label={`Publish to ${PLATFORMS[p].label}`} id={`pl-${p}`} />
                <label htmlFor={`pl-${p}`} className="min-w-0 flex-1 cursor-pointer">
                  <PlatformChip platform={p} />
                  <span className="mt-0.5 block truncate text-xs text-muted">
                    {acct?.connected ? (
                      <>
                        {PLATFORMS[p].handlePrefix}
                        {acct.handle} · {fmtCompact(acct.followers)} followers
                      </>
                    ) : (
                      'Not connected'
                    )}
                  </span>
                </label>
                {acct?.connected ? (
                  <span className="badge bg-good-soft text-good">
                    <Check size={11} /> Connected
                  </span>
                ) : (
                  <button className="btn btn-secondary btn-xs" onClick={() => openConnect([p])}>
                    <Link2 size={12} /> Connect
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        {cfg.platforms.length === 0 && <Warn>Pick at least one platform.</Warn>}
      </section>

      <section className="panel p-4 sm:p-5" aria-label="Post type mix">
        <h2 className="section-title mb-1 flex items-center gap-2">
          <Users size={17} className="text-primary" /> Post type mix
        </h2>
        <p className="mb-4 text-[13px] text-muted">Weight the five post types. The plan also shifts the mix week by week, from awareness to conversion.</p>
        <ul className="flex flex-col gap-3">
          {POST_TYPES.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center gap-3">
              <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: `rgb(var(--${t.slot}))` }} />
              <span className="min-w-[180px] flex-1">
                <span className="block text-[13.5px] font-semibold">{t.label}</span>
                <span className="block text-xs text-muted">
                  {t.desc} Good for {t.goal.toLowerCase()}.
                </span>
              </span>
              <Segmented size="sm" value={String(cfg.postTypes[t.id])} onChange={(v) => set({ postTypes: { ...cfg.postTypes, [t.id]: Number(v) } as Record<PostType, number> })} options={WEIGHTS.map((w) => ({ id: w.id, label: w.label }))} />
            </li>
          ))}
        </ul>
        <div className="mt-4">
          <StackedBar parts={POST_TYPES.map((t) => ({ key: t.id, label: t.short, value: Math.round((cfg.postTypes[t.id] / typeTotal) * 100), color: `rgb(var(--${t.slot}))` }))} />
        </div>
      </section>
    </div>
  );
}

function StyleCard({ checked, onToggle, label, desc, children }: { checked: boolean; onToggle: () => void; label: string; desc: string; children: React.ReactNode }) {
  return (
    <label className={cn('group relative flex cursor-pointer flex-col overflow-hidden rounded-lg border bg-surface transition-shadow', checked ? 'border-primary ring-2 ring-primary/40' : 'border-line hover:shadow-card')}>
      <input type="checkbox" className="sr-only" checked={checked} onChange={onToggle} />
      <div className="flex justify-center bg-surface-2">{children}</div>
      <span className={cn('absolute right-2 top-2 z-30 flex h-6 w-6 items-center justify-center rounded-full border-2 shadow-sm', checked ? 'border-primary bg-primary text-on-primary' : 'border-white/80 bg-black/25 text-transparent')}>
        <Check size={13} />
      </span>
      <span className="p-2.5">
        <span className="block text-[12.5px] font-semibold leading-tight">{label}</span>
        <span className="mt-0.5 block text-[11px] leading-snug text-muted">{desc}</span>
      </span>
    </label>
  );
}

function Warn({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-3 flex items-center gap-1.5 text-xs font-medium text-warn">
      <AlertTriangle size={13} /> {children}
    </p>
  );
}
