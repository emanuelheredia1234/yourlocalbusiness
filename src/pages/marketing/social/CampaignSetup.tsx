import { useMemo } from 'react';
import { AlertTriangle, CalendarDays, Check, Clapperboard, Globe, Image as ImageIcon, Users } from 'lucide-react';
import type { CampaignConfig, ImageStyleId, PostPlatform, PostType, Project, VideoStyleId } from '@/lib/types';
import { cn, WEEKDAYS } from '@/lib/utils';
import { brandMark } from '@/lib/brandMark';
import { IMAGE_STYLES, PLATFORMS, POST_PLATFORMS, POST_TYPES, VIDEO_STYLES } from '@/ai/knowledge';
import { suggestTopics } from '@/ai/local/social';
import { useStore } from '@/store/useStore';
import { cadence, patchCampaign } from '@/ai/socialPlan';
import { Field, Segmented, Toggle } from '@/components/ui/primitives';
import { StackedBar } from '@/components/charts/Charts';
import { PostVisual } from '@/components/visuals/PostVisual';
import { PlatformChip } from '@/components/posts/PlatformIcon';
import { NETWORKS } from '@/ai/manusPost';
import { LinkPlacementCard } from './LinkPlacementCard';

const WEIGHTS = [
  { id: '0', label: 'Off' },
  { id: '1', label: 'Some' },
  { id: '2', label: 'More' },
  { id: '3', label: 'Most' },
] as const;

export function useCampaign() {
  return (patch: Partial<CampaignConfig>) => patchCampaign(patch);
}

export function CampaignSetup({ project }: { project: Project }) {
  const cfg = project.marketing.campaign;
  const set = useCampaign();
  const updateBrand = useStore((s) => s.updateBrand);
  const c = cadence(cfg);
  const sample = useMemo(() => suggestTopics(project)[0] ?? project.brand.tagline, [project]);
  // only what you entered: your website, else your @handle, else your brand name
  const mark = brandMark(project.brand);
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
        <p className="mb-4 text-small text-muted">Pick your posting days, how many posts per day, and how many of those are videos.</p>
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
        <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-md bg-surface-2 px-4 py-3 text-small">
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

      <section className="panel p-4 sm:p-5" aria-label="Watermark">
        <Toggle checked={cfg.watermark} onChange={(v) => set({ watermark: v })} label="Add a watermark" description={mark && mark !== project.brand.name.trim() ? <>AI images show <b className="text-ink">{mark}</b> in the corner. Your own photos post as they are.</> : 'No website or @handle yet, so AI images show your brand name. Add your handles below, or your website in Settings → Brand.'} />
      </section>

      <section className="panel p-4 sm:p-5" aria-label="Visual styles">
        <h2 className="section-title mb-1">Visual styles</h2>
        <p className="mb-4 text-small text-muted">Select the looks to rotate through. Every preview uses your brand colors.</p>
        <h3 className="mb-2 flex items-center gap-1.5 text-small font-semibold">
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
        <h3 className="mb-2 mt-5 flex items-center gap-1.5 text-small font-semibold">
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
        <p className="mb-4 text-small text-muted">Choose where this campaign posts, and add your handle on each. This app doesn’t log in to your accounts: Manus posts for you, signed in as you in its own browser, or you post yourself. The handles show in previews and tell Manus which account to use.</p>
        <ul className="grid grid-cols-1 gap-2 md:grid-cols-2">
          {POST_PLATFORMS.map((p) => {
            const on = cfg.platforms.includes(p);
            return (
              <li key={p} className={cn('flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border px-3 py-2.5', on ? 'border-primary/50 bg-primary-soft/50' : 'border-line')}>
                <input type="checkbox" className="h-4 w-4 accent-[rgb(var(--primary))]" checked={on} onChange={() => set({ platforms: toggleIn<PostPlatform>(cfg.platforms, p) })} aria-label={`Post on ${PLATFORMS[p].label}`} id={`pl-${p}`} />
                <label htmlFor={`pl-${p}`} className="min-w-[110px] cursor-pointer">
                  <PlatformChip platform={p} />
                </label>
                <input
                  className="input input-sm min-w-0 flex-1 basis-[160px]"
                  value={project.brand.socials[p] ?? ''}
                  onChange={(e) => updateBrand({ socials: { ...project.brand.socials, [p]: e.target.value } })}
                  placeholder={NETWORKS[p].placeholder}
                  aria-label={`Your ${NETWORKS[p].account}`}
                />
              </li>
            );
          })}
        </ul>
        {cfg.platforms.length === 0 && <Warn>Pick at least one platform.</Warn>}
      </section>

      <LinkPlacementCard project={project} />

      <section className="panel p-4 sm:p-5" aria-label="Post type mix">
        <h2 className="section-title mb-1 flex items-center gap-2">
          <Users size={17} className="text-primary" /> Post type mix
        </h2>
        <p className="mb-4 text-small text-muted">Weight the five post types. The plan also shifts the mix week by week, from awareness to conversion.</p>
        <ul className="flex flex-col gap-3">
          {POST_TYPES.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center gap-3">
              <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: `rgb(var(--${t.slot}))` }} />
              <span className="min-w-[180px] flex-1">
                <span className="block text-small font-semibold">{t.label}</span>
                <span className="block text-caption text-muted">
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
        <span className="block text-small font-semibold leading-tight">{label}</span>
        <span className="mt-0.5 block text-caption leading-snug text-muted">{desc}</span>
      </span>
    </label>
  );
}

function Warn({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-3 flex items-center gap-1.5 text-caption font-medium text-warn">
      <AlertTriangle size={13} /> {children}
    </p>
  );
}
