import { useMemo, useState } from 'react';
import { CalendarDays, CalendarClock, CheckCheck, ChevronLeft, ChevronRight, FileEdit, List, Pencil, Plus, Search, Send, Sparkles } from 'lucide-react';
import type { Post, PostFormat, PostPlatform, PostType } from '@/lib/types';
import { addDays, cn, combineDateTime, fmtDate, fmtDateTime, isoToDateStr, isoToTime, todayStr, WEEKDAYS, weekdayIndex } from '@/lib/utils';
import { PLATFORMS, POST_PLATFORMS, POST_TYPE_MAP, POST_TYPES } from '@/ai/knowledge';
import { useNow } from '@/lib/hooks';
import { useActiveProject, useStore } from '@/store/useStore';
import { toast, useUI } from '@/store/ui';
import { Empty, Segmented, Tabs } from '@/components/ui/primitives';
import { FormatBadge, PostCard, PostTypeTag, styleLabel } from '@/components/posts/PostCard';
import { ExternalBadge, ManusPostButton, manusSetupHint, useCanOfferManus, useManusPost, useManusReady } from '@/components/posts/ManusPost';
import { GroupShareBadge, PostToGroupsButton } from '@/components/posts/ManusGroups';
import { DueBadge, PostedBy, PostMoreMenu, addToCalendarFlow, isDue, manusHolds, useMarkPosted } from '@/components/posts/PostActions';
import { PlatformChip, PlatformGlyph } from '@/components/posts/PlatformIcon';
import { PostVisual } from '@/components/visuals/PostVisual';
import { networkLabel } from '@/ai/manusPost';

type Tab = 'scheduled' | 'published' | 'drafts';

/** Planned posts Manus could take now (not handed over yet, or the last try failed). */
const notSent = (p: Post) => !p.external || p.external.state === 'failed';

export default function ContentCalendar() {
  const project = useActiveProject()!;
  const allPosts = useStore((s) => s.posts);
  const openComposer = useUI((s) => s.openComposer);
  const manusReady = useManusReady();
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
          <p className="mt-1 text-[13.5px] text-muted">Plan posts on your calendar, then post them with Manus (it posts on your accounts for you) or post them yourself and mark them posted. Nothing goes out on its own. Drag posts between days to move them; click any post to edit it.</p>
        </div>
        <button className="btn btn-primary" onClick={() => openComposer()}>
          <Sparkles size={16} className="text-accent" /> Create post
        </button>
      </header>

      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'scheduled', label: 'Planned', icon: <CalendarClock size={15} />, count: counts.scheduled },
          { id: 'published', label: 'Posted', icon: <Send size={15} />, count: counts.published },
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
          <Empty icon={<CalendarClock size={20} />} title="Nothing planned yet" body="Add posts from your 7-day batch in the Social engine, or create one with the composer." action={<button className="btn btn-primary btn-sm" onClick={() => openComposer()}><Plus size={14} /> Create post</button>} />
        ) : (
          <>
            <PlannedBar posts={scheduled} manusReady={manusReady} />
            {view === 'calendar' ? <MonthCalendar posts={scheduled} /> : <QueueList posts={scheduled} />}
          </>
        ))}
      {tab === 'published' &&
        (published.length === 0 ? (
          <Empty icon={<Send size={20} />} title="Nothing posted yet" body={manusReady ? 'Posts show up here once Manus reports them posted, or once you mark a post you posted yourself.' : `Posts show up here once you mark them posted. ${manusSetupHint()}`} />
        ) : (
          <PublishedList posts={published} />
        ))}
      {tab === 'drafts' &&
        (drafts.length === 0 ? (
          <Empty icon={<FileEdit size={20} />} title="No drafts" body="Drafts from the composer and the 7-day batch wait here until you add them to your calendar." />
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex justify-end">
              <button className="btn btn-primary btn-sm" onClick={() => addToCalendarFlow(drafts.map((d) => d.id))}>
                <CalendarClock size={14} /> Add all {drafts.length} to calendar
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

/** Above the planned posts: what's due, and sending several to Manus at once. */
function PlannedBar({ posts, manusReady: isReady }: { posts: Post[]; manusReady: boolean }) {
  const now = useNow(60_000);
  // offer the buttons even when Manus isn't ready: the window explains what's missing
  const manusReady = useCanOfferManus() || isReady;
  const due = posts.filter((p) => isDue(p, now) && notSent(p));
  const ready = posts.filter(notSent);
  // a failed try may still have gone out: Manus doesn't look for an earlier copy before posting
  const failed = ready.filter((p) => p.external?.state === 'failed').length;
  if (!due.length && !(manusReady && ready.length > 1)) return null;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface-2/50 px-4 py-2.5">
      <p className="min-w-0 flex-1 text-[13px] text-ink-2">
        {due.length ? (
          <>
            <b className="text-warn">{due.length} due:</b> {due.length > 1 ? 'their times have' : 'its time has'} passed and {due.length > 1 ? 'they haven’t' : 'it hasn’t'} been posted. {manusReady ? 'Post them with Manus, or post them yourself and mark them posted.' : 'Post them yourself and mark them posted.'}
          </>
        ) : (
          `${ready.length} planned posts to send with Manus.`
        )}
        {failed > 0 && (
          <>
            {' '}
            <b className="text-warn">{failed} failed last time</b> and may already be out or scheduled: check before sending {failed === 1 ? 'it' : 'them'} again.
          </>
        )}
      </p>
      {manusReady && due.length > 0 && (
        <button className="btn btn-primary btn-sm" onClick={() => useManusPost.getState().open(due.map((p) => p.id))}>
          <Send size={14} /> Post {due.length > 1 ? `${due.length} due` : 'it'} with Manus
        </button>
      )}
      {manusReady && ready.length > 1 && (
        <button className="btn btn-secondary btn-sm" onClick={() => useManusPost.getState().open(ready.map((p) => p.id))}>
          <Send size={14} /> Send all {ready.length} to Manus
        </button>
      )}
    </div>
  );
}

function reschedule(id: string, date: string) {
  const s = useStore.getState();
  const p = s.posts.find((x) => x.id === id);
  if (!p || isoToDateStr(p.scheduledAt) === date) return;
  if (manusHolds(p)) {
    toast({ kind: 'info', title: 'Manus already has this post', body: `Moving it here won’t change it on ${PLATFORMS[p.platform].label}. Change it there, or wait for Manus’s result.` });
    return;
  }
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
  const now = useNow(60_000);
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
                    className={cn('flex cursor-grab items-center gap-1 rounded border-l-[3px] bg-surface-2 px-1.5 py-1 text-left text-[11px] leading-tight hover:bg-surface-3 active:cursor-grabbing', isDue(p, now) && notSent(p) && 'ring-1 ring-warn/60')}
                    style={{ borderLeftColor: `rgb(var(--${POST_TYPE_MAP[p.postType].slot}))` }}
                    title={`${fmtDateTime(p.scheduledAt)} · ${PLATFORMS[p.platform].label} · ${p.headline}${isDue(p, now) && notSent(p) ? ' · Due: not posted yet' : ''}`}
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
      <p className="border-t border-line px-4 py-2 text-[11.5px] text-muted">Tip: drag a post onto another day to move it, at the same time. Colors show the post type; an outlined post is due.</p>
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
                    <span className="text-[11px] text-muted">{styleLabel(p)}</span>
                    <DueBadge post={p} />
                    <ExternalBadge post={p} compact />
                    <GroupShareBadge post={p} compact />
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
                  <ManusPostButton post={p} primary />
                  <PostToGroupsButton post={p} />
                  <button className="btn btn-secondary btn-sm" onClick={() => useMarkPosted.getState().open(p.id)}>
                    <CheckCheck size={13} /> Mark as posted
                  </button>
                  <PostMoreMenu post={p} />
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
  const byManus = posts.filter((p) => p.publishedBy === 'manus').length;
  const networks = POST_PLATFORMS.map((n) => ({ n, count: posts.filter((p) => p.platform === n).length })).filter((x) => x.count);
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Posted" value={String(posts.length)} />
        <Tile label="By Manus" value={String(byManus)} />
        <Tile label="Marked by you" value={String(posts.length - byManus)} />
        <Tile label="Networks" value={networks.map((x) => `${networkLabel(x.n)} ${x.count}`).join(' · ') || '–'} small />
      </div>
      <p className="text-[12.5px] text-muted">Likes, views and clicks live on each network: this app doesn’t read them. Open a post there to see how it’s doing.</p>
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
              </div>
              <p className="truncate text-[13.5px] font-semibold">{p.headline}</p>
              <p className="mb-1.5 truncate text-[12.5px] text-muted">{p.caption.split('\n')[0]}</p>
              <PostedBy post={p} />
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button className="btn btn-ghost btn-xs" onClick={() => openEditor(p.id)}>
                  <Pencil size={12} /> Open
                </button>
                {p.external && <ExternalBadge post={p} compact />}
                {p.groupShare && <GroupShareBadge post={p} compact />}
                <PostToGroupsButton post={p} size="xs" />
                <PostMoreMenu post={p} className="ml-auto" />
              </div>
            </div>
          </li>
        ))}
      </ul>
      {posts.length > 60 && <p className="text-center text-xs text-muted">Showing the 60 most recent posts.</p>}
    </div>
  );
}

function Tile({ label, value, small }: { label: string; value: string; small?: boolean }) {
  return (
    <div className="panel px-4 py-3">
      <p className="text-xs font-medium text-muted">{label}</p>
      <p className={cn('num font-bold', small ? 'text-[13px] leading-snug' : 'text-[20px]')}>{value}</p>
    </div>
  );
}

