import { useMemo, useState } from 'react';
import { CalendarDays, CalendarClock, ChevronLeft, ChevronRight, ExternalLink, FileEdit, List, Pencil, Plus, Search, Send, Sparkles, Undo2 } from 'lucide-react';
import type { Post, PostFormat, PostPlatform, PostType } from '@/lib/types';
import { addDays, cn, combineDateTime, fmtCompact, fmtDate, fmtDateTime, fmtRelative, isoToDateStr, isoToTime, todayStr, WEEKDAYS, weekdayIndex } from '@/lib/utils';
import { PLATFORMS, POST_PLATFORMS, POST_TYPE_MAP, POST_TYPES, STYLE_LABEL } from '@/ai/knowledge';
import { followersFor, postLive } from '@/lib/metrics';
import { useNow } from '@/lib/hooks';
import { useActiveProject, useStore } from '@/store/useStore';
import { toast, useUI } from '@/store/ui';
import { Empty, Segmented, Tabs } from '@/components/ui/primitives';
import { FormatBadge, LiveMetrics, PostCard, PostTypeTag, publishNowFlow, schedulePostsFlow } from '@/components/posts/PostCard';
import { ExternalBadge, ManusFacebookButton } from '@/components/posts/ManusFacebook';
import { PlatformChip, PlatformGlyph } from '@/components/posts/PlatformIcon';
import { PostVisual } from '@/components/visuals/PostVisual';

type Tab = 'scheduled' | 'published' | 'drafts';

export default function ContentCalendar() {
  const project = useActiveProject()!;
  const allPosts = useStore((s) => s.posts);
  const openComposer = useUI((s) => s.openComposer);
  const posts = useMemo(() => allPosts.filter((p) => p.projectId === project.id), [allPosts, project.id]);
  const [tab, setTab] = useState<Tab>('scheduled');
  const [view, setView] = useState<'calendar' | 'list'>('calendar');
  const [platform, setPlatform] = useState<PostPlatform | 'all'>('all');
  const [type, setType] = useState<PostType | 'all'>('all');
  const [format, setFormat] = useState<PostFormat | 'all'>('all');
  const [q, setQ] = useState('');

  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return posts.filter((p) => (platform === 'all' || p.platform === platform) && (type === 'all' || p.postType === type) && (format === 'all' || p.format === format) && (!ql || `${p.headline} ${p.caption} ${p.hashtags.join(' ')}`.toLowerCase().includes(ql)));
  }, [posts, platform, type, format, q]);
  const scheduled = filtered.filter((p) => p.status === 'scheduled').sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
  const published = filtered.filter((p) => p.status === 'published').sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));
  const drafts = filtered.filter((p) => p.status === 'draft').sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
  const counts = { scheduled: posts.filter((p) => p.status === 'scheduled').length, published: posts.filter((p) => p.status === 'published').length, drafts: posts.filter((p) => p.status === 'draft').length };

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="eyebrow mb-1">Content calendar & queue</p>
          <h1 className="page-title">Content queue</h1>
          <p className="mt-1 text-[13.5px] text-muted">Everything scheduled, published and in draft across your platforms. Drag posts between days to reschedule; click any post to edit it.</p>
        </div>
        <button className="btn btn-primary" onClick={() => openComposer()}>
          <Sparkles size={16} className="text-accent" /> Create post
        </button>
      </header>

      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'scheduled', label: 'Scheduled', icon: <CalendarClock size={15} />, count: counts.scheduled },
          { id: 'published', label: 'Published', icon: <Send size={15} />, count: counts.published },
          { id: 'drafts', label: 'Drafts', icon: <FileEdit size={15} />, count: counts.drafts },
        ]}
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1 sm:max-w-[280px]">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input className="input pl-9" placeholder="Search captions and hashtags" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search posts" />
        </div>
        <select className="select w-auto" value={platform} onChange={(e) => setPlatform(e.target.value as PostPlatform | 'all')} aria-label="Filter by platform">
          <option value="all">All platforms</option>
          {POST_PLATFORMS.map((p) => (
            <option key={p} value={p}>
              {PLATFORMS[p].label}
            </option>
          ))}
        </select>
        <select className="select w-auto" value={type} onChange={(e) => setType(e.target.value as PostType | 'all')} aria-label="Filter by post type">
          <option value="all">All post types</option>
          {POST_TYPES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
        <select className="select w-auto" value={format} onChange={(e) => setFormat(e.target.value as PostFormat | 'all')} aria-label="Filter by format">
          <option value="all">Images & videos</option>
          <option value="image">Images</option>
          <option value="video">Videos</option>
        </select>
        {tab === 'scheduled' && (
          <Segmented
            size="sm"
            className="ml-auto"
            value={view}
            onChange={setView}
            options={[
              { id: 'calendar', label: 'Calendar', icon: <CalendarDays size={13} /> },
              { id: 'list', label: 'List', icon: <List size={13} /> },
            ]}
          />
        )}
      </div>

      {tab === 'scheduled' &&
        (counts.scheduled === 0 ? (
          <Empty icon={<CalendarClock size={20} />} title="Nothing scheduled yet" body="Schedule posts from your 7-day batch in the Social engine, or create one with the composer." action={<button className="btn btn-primary btn-sm" onClick={() => openComposer()}><Plus size={14} /> Create post</button>} />
        ) : view === 'calendar' ? (
          <MonthCalendar posts={scheduled} />
        ) : (
          <QueueList posts={scheduled} />
        ))}
      {tab === 'published' && (published.length === 0 ? <Empty icon={<Send size={20} />} title="No published posts yet" body="Posts publish automatically at their scheduled time, or press “Publish now” on any scheduled post." /> : <PublishedList posts={published} />)}
      {tab === 'drafts' &&
        (drafts.length === 0 ? (
          <Empty icon={<FileEdit size={20} />} title="No drafts" body="Drafts from the composer and the 7-day batch wait here until you schedule them." />
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex justify-end">
              <button className="btn btn-primary btn-sm" onClick={() => schedulePostsFlow(drafts.map((d) => d.id))}>
                <CalendarClock size={14} /> Schedule all {drafts.length} drafts
              </button>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {drafts.map((p) => (
                <PostCard key={p.id} post={p} brand={project.brand} />
              ))}
            </div>
          </div>
        ))}
    </div>
  );
}

function reschedule(id: string, date: string) {
  const s = useStore.getState();
  const p = s.posts.find((x) => x.id === id);
  if (!p || isoToDateStr(p.scheduledAt) === date) return;
  const at = combineDateTime(date, isoToTime(p.scheduledAt));
  if (new Date(at).getTime() < Date.now() - 60_000) {
    toast({ kind: 'error', title: 'That time has already passed', body: 'Pick today or a future day.' });
    return;
  }
  s.updatePost(id, { scheduledAt: at });
  toast({ kind: 'success', title: 'Rescheduled', body: fmtDateTime(at) });
}

const WEEKS = 5;
const mondayOf = (date: string) => addDays(date, -weekdayIndex(date));

/** Rolling five-week view, opening on the week of the next scheduled post. */
function MonthCalendar({ posts }: { posts: Post[] }) {
  const openEditor = useUI((s) => s.openPostEditor);
  const today = todayStr();
  const first = posts[0] ? isoToDateStr(posts[0].scheduledAt) : today;
  const [start, setStart] = useState(() => mondayOf(first < today ? today : first));
  const [dragOver, setDragOver] = useState<string | null>(null);
  const end = addDays(start, WEEKS * 7 - 1);
  const byDay = useMemo(() => {
    const map = new Map<string, Post[]>();
    for (const p of posts) {
      const k = isoToDateStr(p.scheduledAt);
      map.set(k, [...(map.get(k) ?? []), p]);
    }
    return map;
  }, [posts]);
  const shift = (weeks: number) => setStart((d) => addDays(d, weeks * 7));
  const inView = posts.filter((p) => {
    const d = isoToDateStr(p.scheduledAt);
    return d >= start && d <= end;
  }).length;

  return (
    <section className="panel overflow-hidden" aria-label="Scheduled posts calendar">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <h2 className="min-w-0 flex-1 font-display text-[16px] font-semibold">
          {fmtDate(start, { month: 'short', day: 'numeric' })} – {fmtDate(end, { month: 'short', day: 'numeric', year: 'numeric' })}
          <span className="ml-2 text-[12.5px] font-normal text-muted">
            {inView} post{inView === 1 ? '' : 's'} in view
          </span>
        </h2>
        <button className="btn btn-ghost btn-icon btn-sm" onClick={() => shift(-4)} aria-label="Previous four weeks">
          <ChevronLeft size={16} />
        </button>
        <button className="btn btn-secondary btn-sm" onClick={() => setStart(mondayOf(today))}>
          Today
        </button>
        <button className="btn btn-ghost btn-icon btn-sm" onClick={() => shift(4)} aria-label="Next four weeks">
          <ChevronRight size={16} />
        </button>
      </div>
      <div className="overflow-x-auto">
        <div className="grid min-w-[760px] grid-cols-7">
          {WEEKDAYS.map((d) => (
            <div key={d} className="border-b border-line px-2 py-1.5 text-center text-[11px] font-semibold uppercase tracking-wide text-muted">
              {d}
            </div>
          ))}
          {Array.from({ length: WEEKS * 7 }, (_, i) => {
            const date = addDays(start, i);
            const dayNum = Number(date.slice(8, 10));
            const list = byDay.get(date) ?? [];
            const past = date < today;
            return (
              <div
                key={date}
                className={cn('flex min-h-[118px] flex-col gap-1 border-b border-r border-line p-1.5 transition-colors', past && 'bg-surface-2/40', dragOver === date && 'bg-primary-soft')}
                onDragOver={(e) => {
                  if (past) return;
                  e.preventDefault();
                  setDragOver(date);
                }}
                onDragLeave={() => setDragOver((d) => (d === date ? null : d))}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(null);
                  const id = e.dataTransfer.getData('text/plain');
                  if (id) reschedule(id, date);
                }}
              >
                <span className={cn('num flex h-6 min-w-6 items-center justify-center self-end rounded-full px-1.5 text-[12px] font-semibold', date === today ? 'bg-primary text-on-primary' : past ? 'text-faint' : 'text-ink-2')}>
                  {dayNum === 1 || i === 0 ? fmtDate(date, { month: 'short', day: 'numeric' }) : dayNum}
                </span>
                {list.slice(0, 4).map((p) => (
                  <button
                    key={p.id}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/plain', p.id);
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                    onClick={() => openEditor(p.id)}
                    className="flex cursor-grab items-center gap-1 rounded border-l-[3px] bg-surface-2 px-1.5 py-1 text-left text-[11px] leading-tight hover:bg-surface-3 active:cursor-grabbing"
                    style={{ borderLeftColor: `rgb(var(--${POST_TYPE_MAP[p.postType].slot}))` }}
                    title={`${fmtDateTime(p.scheduledAt)} · ${PLATFORMS[p.platform].label} · ${p.headline}`}
                  >
                    <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm text-white" style={{ background: PLATFORMS[p.platform].color }}>
                      <PlatformGlyph platform={p.platform} size={8} />
                    </span>
                    <span className="num shrink-0 text-muted">{new Date(p.scheduledAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(':00', '').replace(' ', '').toLowerCase()}</span>
                    <span className="min-w-0 truncate font-medium">{p.headline}</span>
                  </button>
                ))}
                {list.length > 4 && <span className="px-1 text-[11px] font-semibold text-muted">+{list.length - 4} more</span>}
              </div>
            );
          })}
        </div>
      </div>
      <p className="border-t border-line px-4 py-2 text-[11.5px] text-muted">Tip: drag a post onto another day to reschedule it at the same time. Colors show the post type.</p>
    </section>
  );
}

function QueueList({ posts }: { posts: Post[] }) {
  const project = useActiveProject()!;
  const update = useStore((s) => s.updatePost);
  const openEditor = useUI((s) => s.openPostEditor);
  const groups = useMemo(() => {
    const map = new Map<string, Post[]>();
    for (const p of posts) {
      const k = isoToDateStr(p.scheduledAt);
      map.set(k, [...(map.get(k) ?? []), p]);
    }
    return [...map.entries()];
  }, [posts]);
  return (
    <div className="flex flex-col gap-4">
      {groups.map(([date, list]) => (
        <section key={date} className="panel overflow-hidden" aria-label={fmtDate(date, { weekday: 'long', month: 'long', day: 'numeric' })}>
          <h3 className="border-b border-line bg-surface-2/50 px-4 py-2 text-[13px] font-semibold">
            {fmtDate(date, { weekday: 'long', month: 'short', day: 'numeric' })} <span className="font-normal text-muted">· {list.length} post{list.length > 1 ? 's' : ''}</span>
          </h3>
          <ul className="divide-y divide-line">
            {list.map((p) => (
              <li key={p.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
                <button className="w-16 shrink-0 overflow-hidden rounded-md" onClick={() => openEditor(p.id)} aria-label={`Edit ${p.headline}`}>
                  <PostVisual style={p.style} headline={p.headline} brand={project.brand} media={p.media} storyboard={p.storyboard} aspect="1/1" className="rounded-none" />
                </button>
                <div className="min-w-[200px] flex-1">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <PlatformChip platform={p.platform} />
                    <FormatBadge format={p.format} />
                    <PostTypeTag type={p.postType} />
                    <span className="text-[11px] text-muted">{STYLE_LABEL[p.style]}</span>
                    <ExternalBadge post={p} compact />
                  </div>
                  <p className="truncate text-[13.5px] font-semibold">{p.headline}</p>
                  <p className="clamp-2 text-[12.5px] text-muted">{p.caption}</p>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <input type="date" className="input input-sm w-[136px]" value={isoToDateStr(p.scheduledAt)} min={todayStr()} onChange={(e) => e.target.value && update(p.id, { scheduledAt: combineDateTime(e.target.value, isoToTime(p.scheduledAt)) })} aria-label="Reschedule date" />
                  <input type="time" className="input input-sm w-[104px]" value={isoToTime(p.scheduledAt)} onChange={(e) => e.target.value && update(p.id, { scheduledAt: combineDateTime(isoToDateStr(p.scheduledAt), e.target.value) })} aria-label="Reschedule time" />
                  <button className="btn btn-secondary btn-sm" onClick={() => openEditor(p.id)}>
                    <Pencil size={13} /> Edit
                  </button>
                  <ManusFacebookButton post={p} />
                  <button className="btn btn-primary btn-sm" onClick={() => publishNowFlow(p.id)}>
                    <Send size={13} /> Publish now
                  </button>
                  <button className="btn btn-ghost btn-icon btn-sm" onClick={() => update(p.id, { status: 'draft' })} aria-label="Move back to drafts" title="Unschedule">
                    <Undo2 size={14} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function PublishedList({ posts }: { posts: Post[] }) {
  const project = useActiveProject()!;
  const openEditor = useUI((s) => s.openPostEditor);
  const settings = useStore((s) => s.settings);
  const now = useNow(3000);
  const totals = posts.reduce(
    (t, p) => {
      const m = postLive(p, now, followersFor(settings, p.platform));
      return { impressions: t.impressions + m.impressions, engagements: t.engagements + m.engagements, clicks: t.clicks + m.clicks };
    },
    { impressions: 0, engagements: 0, clicks: 0 },
  );
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Published posts" value={String(posts.length)} />
        <Tile label="Impressions" value={fmtCompact(totals.impressions)} live />
        <Tile label="Engagements" value={fmtCompact(totals.engagements)} live />
        <Tile label="Link clicks" value={fmtCompact(totals.clicks)} live />
      </div>
      <ul className="flex flex-col gap-3">
        {posts.slice(0, 60).map((p) => (
          <li key={p.id} className="panel flex flex-col gap-3 p-3 sm:flex-row">
            <button className="w-full shrink-0 overflow-hidden rounded-md sm:w-28" onClick={() => openEditor(p.id)} aria-label={`Open ${p.headline}`}>
              <PostVisual style={p.style} headline={p.headline} brand={project.brand} media={p.media} storyboard={p.storyboard} aspect="1/1" className="rounded-none" />
            </button>
            <div className="min-w-0 flex-1">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <PlatformChip platform={p.platform} />
                <FormatBadge format={p.format} />
                <PostTypeTag type={p.postType} />
                {p.source === 'sample' && <span className="badge bg-warn-soft text-warn">Sample</span>}
                <span className="num ml-auto text-xs text-muted" title={p.publishedAt ? fmtDateTime(p.publishedAt) : ''}>
                  Published {p.publishedAt ? `${fmtDateTime(p.publishedAt)} · ${fmtRelative(p.publishedAt, now)}` : ''}
                </span>
              </div>
              <p className="truncate text-[13.5px] font-semibold">{p.headline}</p>
              <p className="mb-2 truncate text-[12.5px] text-muted">{p.caption.split('\n')[0]}</p>
              <LiveMetrics post={p} />
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button className="btn btn-ghost btn-xs" onClick={() => openEditor(p.id)}>
                  <ExternalLink size={12} /> View on {PLATFORMS[p.platform].label}
                </button>
                <span className="font-mono text-[11px] text-faint">
                  {p.platform === 'x' ? 'x' : p.platform}.com/…/{p.id.slice(-8)}
                </span>
              </div>
            </div>
          </li>
        ))}
      </ul>
      {posts.length > 60 && <p className="text-center text-xs text-muted">Showing the 60 most recent posts.</p>}
    </div>
  );
}

function Tile({ label, value, live }: { label: string; value: string; live?: boolean }) {
  return (
    <div className="panel px-4 py-3">
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted">
        {label}
        {live && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-good" aria-label="Live" />}
      </p>
      <p className="num text-[20px] font-bold">{value}</p>
    </div>
  );
}

