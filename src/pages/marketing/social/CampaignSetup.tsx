import { useMemo, type ReactNode } from 'react';
import { Check, Minus, Plus, TriangleAlert } from 'lucide-react';
import type { CampaignConfig, ImageStyleId, PostPlatform, PostType, Project, StyleId, VideoStyleId } from '@/lib/types';
import { cn, parseDateStr, WEEKDAYS } from '@/lib/utils';
import { brandMark } from '@/lib/brandMark';
import { IMAGE_STYLES, POST_PLATFORMS, POST_TYPES, VIDEO_STYLES } from '@/ai/knowledge';
import { suggestTopics } from '@/ai/local/social';
import { useStore } from '@/store/useStore';
import { cadence, patchCampaign, setVideoDay } from '@/ai/socialPlan';
import { videoDaysOverLimit } from '@/lib/videoWeek';
import { useVideoAllowance } from '@/store/videoWeek';
import { VideoWeekLine } from '@/components/billing/VideoWeekLine';
import { navigate } from '@/lib/router';
import { DateTimeButton, Segmented, SettingsRow, Toggle } from '@/components/ui/primitives';
import { StackedBar } from '@/components/charts/Charts';
import { PostVisual, orderStyles } from '@/components/visuals/PostVisual';
import { PlatformChip } from '@/components/posts/PlatformIcon';
import { NETWORKS } from '@/ai/postShared';
import { LinkPlacementCard } from './LinkPlacementCard';

const WEIGHTS = [
  { id: '0', label: 'Off' },
  { id: '1', label: 'Some' },
  { id: '2', label: 'More' },
  { id: '3', label: 'Most' },
] as const;


const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const pad = (n: number) => String(n).padStart(2, '0');
/** "14:30" today, as a time the time picker shows */
const hmToMs = (hm: string) => {
  const [h, m] = hm.split(':').map(Number);
  const d = new Date();
  d.setHours(h || 0, m || 0, 0, 0);
  return d.getTime();
};
const msToHm = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const msToDateStr = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export function useCampaign() {
  return (patch: Partial<CampaignConfig>) => patchCampaign(patch);
}

/** A settings card with a page-level heading (h2): the setup's sections sit right under the page title. */
function SetupSection({ title, description, children, label }: { title: ReactNode; description?: ReactNode; children: ReactNode; label: string }) {
  return (
    <section className="card" aria-label={label}>
      <div className="px-5 pb-1 pt-5">
        <h2 className="text-h3 text-ink">{title}</h2>
        {description && <p className="mt-0.5 text-small text-muted">{description}</p>}
      </div>
      <div className="px-5 pb-1">{children}</div>
    </section>
  );
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
  // plans: AI videos a week for a business; going over is a warning (the server refuses each video past the week's
  // limit), with the upgrade link while plans are on
  const allowance = useVideoAllowance();
  const overLimit = videoDaysOverLimit(c.videos, allowance);
  const videoDaysText = c.videos === 0 ? 'No videos. Add one to a posting day to mix videos in.' : `${c.videos} video${c.videos === 1 ? '' : 's'} a week, on ${c.videoDayCount} day${c.videoDayCount === 1 ? '' : 's'}. The rest are image posts.`;

  return (
    <div className="flex flex-col gap-5">
      <SetupSection label="Cadence" title="Posting cadence" description="When you post, how often, and how many of those are videos.">
        <SettingsRow label="Posting days">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Posting days">
            {WEEKDAYS.map((d, i) => (
              <button key={d} type="button" className={cn('chip min-w-[48px] justify-center', cfg.days[i] && 'chip-active')} aria-pressed={cfg.days[i]} onClick={() => set({ days: cfg.days.map((x, j) => (j === i ? !x : x)) })}>
                {cfg.days[i] && <Check aria-hidden="true" />}
                {d}
              </button>
            ))}
          </div>
        </SettingsRow>
        <SettingsRow label="Posts per day">
          <Segmented
            size="sm"
            value={String(cfg.postsPerDay)}
            onChange={(v) => set({ postsPerDay: Number(v) })}
            options={[1, 2, 3, 4, 5].map((n) => ({ id: String(n), label: String(n) }))}
          />
        </SettingsRow>
        <SettingsRow label="Video days" description={videoDaysText}>
          <div className="flex flex-wrap gap-1.5 md:justify-end" role="group" aria-label="Videos on each posting day">
            {WEEKDAYS.map((d, i) => (
              <VideoDayStepper key={d} day={d} dayName={DAY_NAMES[i]} on={cfg.days[i]} count={c.videoDays[i]} max={cfg.postsPerDay} onChange={(n) => setVideoDay(i, n, project.id)} />
            ))}
          </div>
        </SettingsRow>
        <SettingsRow label="Posting times" description="One for each post of the day.">
          <div className="flex flex-wrap gap-2 md:justify-end">
            {Array.from({ length: cfg.postsPerDay }, (_, i) => (
              <DateTimeButton key={i} mode="time" aria-label={`Post ${i + 1} time`} value={hmToMs(cfg.times[i] ?? '12:00')} onChange={(ms) => set({ times: Object.assign([...cfg.times], { [i]: msToHm(ms) }) })} />
            ))}
          </div>
        </SettingsRow>
        <SettingsRow label="Start date">
          <DateTimeButton mode="date" aria-label="Start date" value={parseDateStr(cfg.startDate).getTime()} onChange={(ms) => set({ startDate: msToDateStr(ms) })} />
        </SettingsRow>
        <SettingsRow label="Campaign goal">
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
        </SettingsRow>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-line py-4">
          <p className="num font-mono text-small text-muted">
            {c.perWeek} posts a week · {c.videos} videos · {c.images} images · ≈ {c.month} over 30 days
          </p>
          {c.days === 0 && <Warn>Pick at least one posting day.</Warn>}
          {overLimit && (
            <Warn>
              {overLimit}
              {allowance?.enforced && (
                <button type="button" className="link text-caption" onClick={() => void navigate('plans', { force: true })}>
                  See plans
                </button>
              )}
            </Warn>
          )}
          <VideoWeekLine projectId={project.id} className="w-full" />
        </div>
      </SetupSection>

      <SetupSection label="Visual styles" title="Look and feel" description="The looks your posts rotate through, in your brand’s colours and photos.">
        <SettingsRow label="Watermark" htmlFor="cmp-watermark" description={mark && mark !== project.brand.name.trim() ? <>AI images show {mark} in the corner. Your own photos post as they are.</> : 'No website or @handle yet, so AI images show your brand name.'}>
          <Toggle id="cmp-watermark" checked={cfg.watermark} onChange={(v) => set({ watermark: v })} />
        </SettingsRow>
        <div className="border-t border-line py-4">
          <StyleGroup label="Image styles">
            {orderStyles(IMAGE_STYLES).map((s) => (
              <StyleCard key={s.id} checked={cfg.imageStyles.includes(s.id)} onToggle={() => set({ imageStyles: toggleIn<ImageStyleId>(cfg.imageStyles, s.id) })} label={s.label} desc={s.bestFor}>
                <PostVisual style={s.id} headline={sample} brand={project.brand} watermark={cfg.watermark} aspect="1/1" points={['Start small', 'Stay consistent', 'Track wins']} className="rounded-none" />
              </StyleCard>
            ))}
          </StyleGroup>
          {needImageStyle && <Warn>Choose at least one image style for your image posts.</Warn>}
        </div>
        <div className="border-t border-line py-4">
          <StyleGroup label="Video styles">
            {orderStyles(VIDEO_STYLES).map((s) => (
              <StyleCard key={s.id} checked={cfg.videoStyles.includes(s.id)} onToggle={() => set({ videoStyles: toggleIn<VideoStyleId>(cfg.videoStyles, s.id) })} label={s.label} desc={s.bestFor} tall>
                <PostVisual style={s.id as StyleId} headline={sample} brand={project.brand} watermark={cfg.watermark} aspect="9/16" hoverPlay className="rounded-none" />
              </StyleCard>
            ))}
          </StyleGroup>
          {needVideoStyle && <Warn>Choose at least one video style, or turn the video days off.</Warn>}
        </div>
      </SetupSection>

      <SetupSection label="Platforms and accounts" title="Platforms" description="Where this campaign posts, and your handle on each. Post from the app when your account is connected, or post it yourself.">
        <ul>
          {POST_PLATFORMS.map((p) => (
            <PlatformRow key={p} platform={p} on={cfg.platforms.includes(p)} handle={project.brand.socials[p] ?? ''} onToggle={() => set({ platforms: toggleIn<PostPlatform>(cfg.platforms, p) })} onHandle={(v) => updateBrand({ socials: { ...project.brand.socials, [p]: v } })} />
          ))}
        </ul>
        {cfg.platforms.length === 0 && (
          <div className="pb-4">
            <Warn>Pick at least one platform.</Warn>
          </div>
        )}
      </SetupSection>

      <LinkPlacementCard project={project} />

      <SetupSection label="Post type mix" title="Post mix" description="How much of each kind of post. The plan also shifts the mix week by week, from awareness to booking.">
        <ul>
          {POST_TYPES.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line py-3 first:border-t-0">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: `rgb(var(--${t.slot}))` }} aria-hidden="true" />
              <span className="min-w-[180px] flex-1">
                <span className="block text-ui text-ink">{t.label}</span>
                <span className="block text-small text-muted">
                  {t.desc} Good for {t.goal.toLowerCase()}.
                </span>
              </span>
              <Segmented size="sm" value={String(cfg.postTypes[t.id])} onChange={(v) => set({ postTypes: { ...cfg.postTypes, [t.id]: Number(v) } as Record<PostType, number> })} options={WEIGHTS.map((w) => ({ id: w.id, label: w.label }))} />
            </li>
          ))}
        </ul>
        <div className="border-t border-line py-4">
          <p className="mb-2 text-small font-medium text-ink-2">Your mix</p>
          <StackedBar parts={POST_TYPES.map((t) => ({ key: t.id, label: t.short, value: Math.round((cfg.postTypes[t.id] / typeTotal) * 100), color: `rgb(var(--${t.slot}))` }))} />
        </div>
      </SetupSection>
    </div>
  );
}

/** One weekday's videos: − n + within the day's posts; a day without posts shows a dash. */
function VideoDayStepper({ day, dayName, on, count, max, onChange }: { day: string; dayName: string; on: boolean; count: number; max: number; onChange: (n: number) => void }) {
  return (
    <div className={cn('flex items-center gap-0.5 rounded-full border px-0.5 py-0.5', on && count > 0 ? 'border-primary bg-primary-soft/50' : 'border-line', !on && 'opacity-60')}>
      <button type="button" className="btn btn-ghost btn-icon btn-xs" aria-label={`One fewer video on ${dayName}`} disabled={!on || count <= 0} onClick={() => onChange(count - 1)}>
        <Minus />
      </button>
      <span className="num min-w-[48px] text-center text-small text-ink-2" aria-live="polite">
        <span className="font-medium text-ink">{day}</span> {on ? count : '–'}
        <span className="sr-only">{on ? ` ${count} video${count === 1 ? '' : 's'}` : ' no posts'}</span>
      </span>
      <button type="button" className="btn btn-ghost btn-icon btn-xs" aria-label={`One more video on ${dayName}`} disabled={!on || count >= max} onClick={() => onChange(count + 1)}>
        <Plus />
      </button>
    </div>
  );
}

function PlatformRow({ platform: p, on, handle, onToggle, onHandle }: { platform: PostPlatform; on: boolean; handle: string; onToggle: () => void; onHandle: (v: string) => void }) {
  const id = `pl-${p}`;
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2 border-t border-line py-3 first:border-t-0 sm:grid-cols-[auto_150px_minmax(0,1fr)]">
      {/* one label for the switch, so its name is "Post on Instagram" (not the network twice) */}
      <Toggle id={id} checked={on} onChange={onToggle} />
      <label htmlFor={id} className="cursor-pointer">
        <span className="sr-only">Post on </span>
        <PlatformChip platform={p} />
      </label>
      <input className="input input-sm col-span-2 min-w-0 sm:col-span-1" value={handle} onChange={(e) => onHandle(e.target.value)} placeholder={NETWORKS[p].placeholder} aria-label={`Your ${NETWORKS[p].account}`} />
    </li>
  );
}

function StyleGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label}>
      <h3 className="mb-3 text-h4 text-ink">{label}</h3>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">{children}</div>
    </div>
  );
}

/** A visual style to rotate through: a real post preview, picked with the option-card ring and a check. */
function StyleCard({ checked, onToggle, label, desc, children, tall }: { checked: boolean; onToggle: () => void; label: string; desc: string; children: ReactNode; tall?: boolean }) {
  return (
    <label
      className={cn(
        'group relative flex cursor-pointer flex-col overflow-hidden rounded-lg border bg-surface transition-[border-color,box-shadow,background-color] duration-120 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring',
        checked ? 'border-transparent bg-primary-soft/50 ring-[1.5px] ring-inset ring-primary' : 'border-line hover:border-line-3 hover:shadow-sm',
      )}
    >
      <input type="checkbox" className="sr-only" checked={checked} onChange={onToggle} />
      <div className={cn('relative overflow-hidden', tall && 'mx-auto w-full max-w-[150px]')}>{children}</div>
      {checked && (
        <span className="absolute right-2 top-2 z-30 flex h-[18px] w-[18px] items-center justify-center rounded-full bg-primary text-on-primary" aria-hidden="true">
          <Check size={12} strokeWidth={3} />
        </span>
      )}
      <span className="p-3">
        <span className="block text-ui text-ink">{label}</span>
        <span className="clamp-2 mt-0.5 block text-caption text-muted">{desc}</span>
      </span>
    </label>
  );
}

function Warn({ children }: { children: ReactNode }) {
  return (
    <p className="mt-3 flex items-center gap-1.5 text-caption font-medium text-warn">
      <TriangleAlert size={14} aria-hidden="true" /> {children}
    </p>
  );
}
