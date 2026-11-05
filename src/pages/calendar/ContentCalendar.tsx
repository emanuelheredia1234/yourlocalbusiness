import { useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { CalendarClock, CalendarDays, CheckCheck, ChevronLeft, ChevronRight, FileEdit, Pencil, Plus, Search, Send, SlidersHorizontal, Users } from 'lucide-react';
import type { Brand, Post, PostFormat, PostPlatform, PostType } from '@/lib/types';
import { addDays, cn, combineDateTime, fmtDate, fmtDateTime, isoToDateStr, isoToTime, todayStr, WEEKDAYS, weekdayIndex } from '@/lib/utils';
import { PLATFORMS, POST_PLATFORMS, POST_TYPES } from '@/ai/knowledge';
import { useMediaQuery, useNow } from '@/lib/hooks';
import { navigate } from '@/lib/router';
import { useActiveProject, useStore } from '@/store/useStore';
import { toast, useTabRequest, useUI } from '@/store/ui';
import { tabsOf } from '@/lib/pageTabs';
import { Callout, DateTimeButton, Drawer, Empty, InfoTip, MoreMenu, PageHeader, Popover, Segmented, Select, StatusDot, Tabs, Tooltip, type MenuEntry } from '@/components/ui/primitives';
import { PostCard, PostTypeTag, styleLabel } from '@/components/posts/PostCard';
import { ExternalBadge, ManusPostButton, useCanOfferManus, useManusPost, useManusReady } from '@/components/posts/ManusPost';
import { GroupShareBadge, useManusGroups } from '@/components/posts/ManusGroups';
import { DueBadge, PostedBy, addToCalendarFlow, failedOnItsNetwork, isDue, manusHolds, postMenuEntries, useMarkPosted } from '@/components/posts/PostActions';
import { PlatformMark } from '@/components/posts/PlatformIcon';
import { PostLinkNote } from '@/components/posts/PostLinkNote';
import { PostVisual } from '@/components/visuals/PostVisual';
import { networkLabel } from '@/ai/manusPost';

type Tab = 'scheduled' | 'published' | 'drafts';
type View = 'calendar' | 'list';

/** Planned posts Manus could take now (not handed over yet, or the last try failed). */
const notSent = (p: Post) => !p.external || p.external.state === 'failed';

/** "Post to groups" applies: a Facebook post, Manus reachable, no group share running. */
const groupsOpen = (p: Post, offer: boolean) => offer && p.platform === 'facebook' && !(p.groupShare && (p.groupShare.state === 'working' || p.groupShare.state === 'needs_input'));

/** A planned post's "⋯" menu (list rows and the phone agenda): Edit, Post to groups, then the post's own entries. */
function plannedMenu(p: Post, offer: boolean, openEditor: (id: string) => void): MenuEntry[] {
  return [{ label: 'Edit', icon: <Pencil />, onSelect: () => openEditor(p.id) }, ...(groupsOpen(p, offer) ? [{ label: 'Post to groups', icon: <Users />, onSelect: () => useManusGroups.getState().open(p.id) }] : []), ...postMenuEntries(p)];
}

/** The Social page on its 7-day batch. */
function openBatch() {
  void navigate('marketing-social').then((ok) => ok && useUI.getState().setSocialTab('batch'));
}

const HOW =
  'Plan posts on your calendar, then post them with Manus (it posts on your accounts for you) or post them yourself and mark them posted. Nothing goes out on its own. Drag posts between days to move them; click any post to edit it.';

export default function ContentCalendar() {
  const project = useActiveProject()!;
  const allPosts = useStore((s) => s.posts);
  const openComposer = useUI((s) => s.openComposer);
  const manusReady = useManusReady();
  // offer the buttons even when Manus isn't ready: the window explains what's missing
  const offer = useCanOfferManus() || manusReady;
  const wide = useMediaQuery('(min-width: 640px)');
  const posts = useMemo(() => allPosts.filter((p) => p.projectId === project.id), [allPosts, project.id]);
  const [tab, setTab] = useState<Tab>('scheduled');
  // a tab asked for from elsewhere (the assistant)
  useTabRequest<Tab>('calendar', tabsOf('calendar') as Tab[], setTab);
  const [view, setView] = useState<View>('calendar');
  const [platform, setPlatform] = useState<PostPlatform | 'all'>('all');
  const [type, setType] = useState<PostType | 'all'>('all');
  const [format, setFormat] = useState<PostFormat | 'all'>('all');
  const [q, setQ] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);

  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return posts.filter((p) => (platform === 'all' || p.platform === platform) && (type === 'all' || p.postType === type) && (format === 'all' || p.format === format) && (!ql || `${p.headline} ${p.caption} ${p.hashtags.join(' ')}`.toLowerCase().includes(ql)));
  }, [posts, platform, type, format, q]);
  const scheduled = filtered.filter((p) => p.status === 'scheduled').sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
  const published = filtered.filter((p) => p.status === 'published').sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));
  const drafts = filtered.filter((p) => p.status === 'draft').sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
  const counts = { scheduled: posts.filter((p) => p.status === 'scheduled').length, published: posts.filter((p) => p.status === 'published').length, drafts: posts.filter((p) => p.status === 'draft').length };
  const ready = scheduled.filter(notSent);
  const active = (platform !== 'all' ? 1 : 0) + (type !== 'all' ? 1 : 0) + (format !== 'all' ? 1 : 0) + (q.trim() ? 1 : 0);
  const clearFilters = () => {
    setPlatform('all');
    setType('all');
    setFormat('all');
    setQ('');
  };
  const planEmpty = tab === 'scheduled' && counts.scheduled === 0;
  const shown = tab === 'scheduled' ? scheduled : tab === 'published' ? published : drafts;
  const filters = { q, setQ, platform, setPlatform, type, setType, format, setFormat };
  const noMatches = <Empty variant="inline" className="py-6" title={q.trim() ? `No matches for “${q.trim()}”` : 'No posts match these filters'} action={<button type="button" className="link" onClick={clearFilters}>Clear filters</button>} />;

  const headerActions =
    wide && (!planEmpty || (tab === 'scheduled' && counts.scheduled > 0)) ? (
      <>
        {tab === 'scheduled' && counts.scheduled > 0 && (
          <Segmented
            value={view}
            onChange={setView}
            options={[
              { id: 'calendar', label: 'Calendar' },
              { id: 'list', label: 'List' },
            ]}
          />
        )}
        {!planEmpty && (
          <button type="button" className="btn btn-primary" onClick={() => openComposer()}>
            <Plus /> Create post
          </button>
        )}
      </>
    ) : undefined;

  return (
    <div>
      <PageHeader
        className="mb-4"
        title="Content calendar"
        description={
          <span className="inline-flex max-w-full items-center gap-1.5">
            <span className="num truncate">
              {counts.scheduled} planned · {counts.published} posted
            </span>
            <InfoTip title="How the calendar works" label="How the calendar works">
              {HOW}
            </InfoTip>
          </span>
        }
        actions={headerActions}
      />

      <Tabs<Tab>
        className="mb-5"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'scheduled', label: 'Planned', count: counts.scheduled },
          { id: 'published', label: 'Posted', count: counts.published },
          { id: 'drafts', label: 'Drafts', count: counts.drafts },
        ]}
      />

      {counts[tab] > 0 && (
        <div className="mb-5 flex flex-wrap items-center gap-2">
          {wide ? (
            <Filters {...filters} />
          ) : (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setFiltersOpen(true)}>
              <SlidersHorizontal /> Filters
              {active > 0 && <span className="num font-mono text-caption text-muted">{active}</span>}
            </button>
          )}
          <span className="ml-auto flex items-center gap-2">
            {tab === 'scheduled' && offer && ready.length > 1 && (
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => useManusPost.getState().open(ready.map((p) => p.id))}>
                <Send /> Send all {ready.length} to Manus
              </button>
            )}
            {tab === 'drafts' && drafts.length > 0 && (
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => addToCalendarFlow(drafts.map((d) => d.id))}>
                <CalendarClock /> Add all {drafts.length} to calendar
              </button>
            )}
          </span>
        </div>
      )}

      {tab === 'scheduled' &&
        (counts.scheduled === 0 ? (
          <Empty
            variant="page"
            icon={<CalendarDays />}
            title="Your week is wide open"
            body="Plan a week of posts in one go, or add a single post."
            action={
              <>
                <button type="button" className="btn btn-primary" onClick={() => openComposer()}>
                  <Plus /> Create post
                </button>
                <button type="button" className="link text-ui" onClick={openBatch}>
                  Plan my week
                </button>
              </>
            }
          />
        ) : scheduled.length === 0 ? (
          noMatches
        ) : (
          <>
            <DueCallout posts={scheduled} offer={offer} />
            {view === 'list' && wide ? <QueueList posts={scheduled} /> : <PlannedCalendar posts={scheduled} />}
          </>
        ))}
      {tab === 'published' &&
        (counts.published === 0 ? (
          <Empty icon={<Send />} title="Nothing posted yet" body="Posts show up here once Manus reports them posted, or once you mark a post you posted yourself." />
        ) : published.length === 0 ? (
          noMatches
        ) : (
          <PublishedList posts={published} />
        ))}
      {tab === 'drafts' &&
        (counts.drafts === 0 ? (
          <Empty icon={<FileEdit />} title="No drafts" body="Drafts from Create post and the 7-day batch wait here until you add them to your calendar." />
        ) : drafts.length === 0 ? (
          noMatches
        ) : (
          <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {drafts.map((p) => (
              <PostCard key={p.id} post={p} brand={project.brand} />
            ))}
          </div>
        ))}

      <Drawer
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        title="Filters"
        footer={
          <>
            <button type="button" className="btn btn-ghost btn-sm mr-auto" onClick={clearFilters} disabled={!active}>
              Clear filters
            </button>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setFiltersOpen(false)}>
              Show {shown.length} post{shown.length === 1 ? '' : 's'}
            </button>
          </>
        }
      >
        <Filters {...filters} stacked />
      </Drawer>
    </div>
  );
}

type FilterProps = {
  q: string;
  setQ: (v: string) => void;
  platform: PostPlatform | 'all';
  setPlatform: (v: PostPlatform | 'all') => void;
  type: PostType | 'all';
  setType: (v: PostType | 'all') => void;
  format: PostFormat | 'all';
  setFormat: (v: PostFormat | 'all') => void;
  stacked?: boolean;
};

/** Search plus the three filters: one row on wide screens, stacked in the phone's Filters sheet. */
function Filters({ q, setQ, platform, setPlatform, type, setType, format, setFormat, stacked }: FilterProps) {
  const sel = stacked ? 'w-full' : 'w-auto min-w-[148px]';
  return (
    <div className={cn('flex gap-2', stacked ? 'flex-col' : 'flex-wrap items-center')}>
      <div className={cn('relative', stacked ? 'w-full' : 'w-48 lg:w-60')}>
        <Search size={16} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" aria-hidden="true" />
        <input className="input input-sm w-full pl-8" placeholder="Search posts" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search posts" />
      </div>
      <Select<PostPlatform | 'all'>
        size="sm"
        className={sel}
        value={platform}
        onChange={setPlatform}
        aria-label="Filter by platform"
        options={[{ value: 'all', label: 'All platforms' }, ...POST_PLATFORMS.map((p) => ({ value: p, label: PLATFORMS[p].label, icon: <PlatformMark platform={p} size={16} /> }))]}
      />
      <Select<PostType | 'all'> size="sm" className={sel} value={type} onChange={setType} aria-label="Filter by post type" options={[{ value: 'all', label: 'All post types' }, ...POST_TYPES.map((t) => ({ value: t.id, label: t.label }))]} />
      <Select<PostFormat | 'all'>
        size="sm"
        className={sel}
        value={format}
        onChange={setFormat}
        aria-label="Filter by format"
        options={[
          { value: 'all', label: 'Images & videos' },
          { value: 'image', label: 'Images' },
          { value: 'video', label: 'Videos' },
        ]}
      />
    </div>
  );
}

/** Planned posts whose time has passed: the one note on the page that asks for something. */
function DueCallout({ posts, offer }: { posts: Post[]; offer: boolean }) {
  const now = useNow(60_000);
  const wide = useMediaQuery('(min-width: 640px)');
  const due = posts.filter((p) => isDue(p, now) && notSent(p));
  if (!due.length) return null;
  // a failed try may still have gone out: Manus doesn't look for an earlier copy before posting
  const failed = due.filter(failedOnItsNetwork).length;
  const many = due.length > 1;
  const action = offer ? (
    <button type="button" className="btn btn-secondary btn-xs" onClick={() => useManusPost.getState().open(due.map((p) => p.id))}>
      <Send /> Post {many ? `${due.length} due` : 'it'} with Manus
    </button>
  ) : undefined;
  return (
    // on phones the button goes under the words, so they keep the callout's width
    <Callout tone="warn" className="mb-5" action={wide ? action : undefined}>
      {due.length} planned post{many ? 's are' : ' is'} past {many ? 'their' : 'its'} time and not posted. {offer ? `Post ${many ? 'them' : 'it'} with Manus, or post ${many ? 'them' : 'it'} yourself and mark ${many ? 'them' : 'it'} posted.` : `Post ${many ? 'them' : 'it'} yourself and mark ${many ? 'them' : 'it'} posted.`}
      {failed > 0 && ` ${failed} failed last time and may already be out or scheduled: check before sending ${failed === 1 ? 'it' : 'them'} again.`}
      {!wide && action && <span className="mt-2 flex">{action}</span>}
    </Callout>
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

/** Dropping a post on a day moves it there, at the same time. */
function useDayDrop() {
  const [over, setOver] = useState<string | null>(null);
  const bind = (date: string, past: boolean) => ({
    onDragOver: (e: DragEvent) => {
      if (past) return;
      e.preventDefault();
      setOver(date);
    },
    onDragLeave: () => setOver((d) => (d === date ? null : d)),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      setOver(null);
      const id = e.dataTransfer.getData('text/plain');
      if (id) reschedule(id, date);
    },
  });
  return { over, bind };
}

const WEEKS = 5;
const mondayOf = (date: string) => addDays(date, -weekdayIndex(date));
const timeOf = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

function byDay(posts: Post[]): Map<string, Post[]> {
  const map = new Map<string, Post[]>();
  for (const p of posts) {
    const k = isoToDateStr(p.scheduledAt);
    map.set(k, [...(map.get(k) ?? []), p]);
  }
  return map;
}

/** The week the calendar opens on: the next planned post's, or this week. */
function useStartWeek(posts: Post[]) {
  const today = todayStr();
  const first = posts[0] ? isoToDateStr(posts[0].scheduledAt) : today;
  return useState(() => mondayOf(first < today ? today : first));
}

/** The planned posts on a calendar: a month grid on wide screens, a week on tablets, an agenda on phones. */
function PlannedCalendar({ posts }: { posts: Post[] }) {
  const month = useMediaQuery('(min-width: 1024px)');
  const week = useMediaQuery('(min-width: 768px)');
  if (month) return <MonthGrid posts={posts} />;
  if (week) return <WeekView posts={posts} />;
  return <Agenda posts={posts} />;
}

function CalendarBar({ title, sub, onPrev, onToday, onNext, prevLabel, nextLabel }: { title: string; sub: string; onPrev: () => void; onToday: () => void; onNext: () => void; prevLabel: string; nextLabel: string }) {
  return (
    <div className="flex items-center gap-1.5 border-b border-line py-2.5 pl-4 pr-2.5">
      <h2 className="min-w-0 flex-1 truncate text-h4 text-ink">
        {title}
        <span className="num ml-2 text-small font-normal text-muted">{sub}</span>
      </h2>
      <Tooltip content={prevLabel}>
        <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={onPrev} aria-label={prevLabel}>
          <ChevronLeft />
        </button>
      </Tooltip>
      <button type="button" className="btn btn-secondary btn-sm" onClick={onToday}>
        Today
      </button>
      <Tooltip content={nextLabel}>
        <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={onNext} aria-label={nextLabel}>
          <ChevronRight />
        </button>
      </Tooltip>
    </div>
  );
}

/** A post on the calendar: its network and time, then its title. Drag it to another day; click to edit. */
function EventChip({ post, now, onOpen, onDark }: { post: Post; now: number; onOpen: () => void; onDark?: boolean }) {
  const due = isDue(post, now) && notSent(post);
  const failed = failedOnItsNetwork(post);
  const missed = due && isoToDateStr(post.scheduledAt) < todayStr();
  return (
    <button
      type="button"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', post.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onClick={onOpen}
      className={cn(
        'flex w-full min-w-0 cursor-grab flex-col gap-0.5 rounded border border-line px-1.5 py-1 text-left transition-[border-color,box-shadow] duration-120 hover:border-line-3 active:cursor-grabbing active:shadow-pop',
        onDark ? 'bg-surface' : 'bg-surface-2',
      )}
      title={`${fmtDateTime(post.scheduledAt)} · ${PLATFORMS[post.platform].label} · ${post.headline}${failed ? ' · Didn’t go through last time' : due ? ' · Due: not posted yet' : ''}`}
    >
      <span className="flex w-full min-w-0 items-center gap-1.5">
        <PlatformMark platform={post.platform} size={12} />
        <span className="num truncate font-mono text-micro text-muted">{timeOf(post.scheduledAt)}</span>
        {(due || failed) && <span className={cn('ml-auto h-1.5 w-1.5 shrink-0 rounded-full', failed || missed ? 'bg-bad-solid' : 'bg-primary')} aria-hidden="true" />}
      </span>
      <span className="block w-full truncate text-caption font-medium text-ink">{post.headline}</span>
      {(due || failed) && <span className="sr-only">{failed ? 'Didn’t go through last time' : missed ? 'Didn’t post' : 'Due today'}</span>}
    </button>
  );
}

/** "+2 more" on a full day: the day's posts in a popover. */
function DayMore({ date, posts, now, hidden }: { date: string; posts: Post[]; now: number; hidden: number }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const openEditor = useUI((s) => s.openPostEditor);
  return (
    <>
      <button ref={ref} type="button" className="self-start rounded px-1 text-caption font-medium text-muted transition-colors duration-120 hover:text-ink" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        +{hidden} more
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref} align="start" className="w-64 p-2">
        <p className="px-1 pb-2 text-caption font-medium text-muted">{fmtDate(date, { weekday: 'long', month: 'short', day: 'numeric' })}</p>
        <div className="flex flex-col gap-1">
          {posts.map((p) => (
            <EventChip
              key={p.id}
              post={p}
              now={now}
              onOpen={() => {
                setOpen(false);
                openEditor(p.id);
              }}
            />
          ))}
        </div>
      </Popover>
    </>
  );
}

/** Rolling five-week view, opening on the week of the next planned post. */
function MonthGrid({ posts }: { posts: Post[] }) {
  const openEditor = useUI((s) => s.openPostEditor);
  const now = useNow(60_000);
  const today = todayStr();
  const [start, setStart] = useStartWeek(posts);
  const { over, bind } = useDayDrop();
  const end = addDays(start, WEEKS * 7 - 1);
  const days = useMemo(() => byDay(posts), [posts]);
  const shift = (weeks: number) => setStart((d) => addDays(d, weeks * 7));
  const inView = posts.filter((p) => {
    const d = isoToDateStr(p.scheduledAt);
    return d >= start && d <= end;
  }).length;
  return (
    <section className="card overflow-hidden" aria-label="Scheduled posts calendar">
      <CalendarBar
        title={`${fmtDate(start, { month: 'short', day: 'numeric' })} – ${fmtDate(end, { month: 'short', day: 'numeric', year: 'numeric' })}`}
        sub={`${inView} post${inView === 1 ? '' : 's'} in view`}
        onPrev={() => shift(-4)}
        onToday={() => setStart(mondayOf(today))}
        onNext={() => shift(4)}
        prevLabel="Previous four weeks"
        nextLabel="Next four weeks"
      />
      <div className="grid grid-cols-7">
        {WEEKDAYS.map((d, i) => (
          <div key={d} className={cn('border-b border-line px-2.5 py-1.5 text-caption text-muted', i < 6 && 'border-r', i >= 5 && 'bg-surface-2')}>
            {d}
          </div>
        ))}
        {Array.from({ length: WEEKS * 7 }, (_, i) => {
          const date = addDays(start, i);
          const dayNum = Number(date.slice(8, 10));
          const list = days.get(date) ?? [];
          const past = date < today;
          const weekend = i % 7 >= 5;
          return (
            <div
              key={date}
              className={cn('flex min-h-[120px] min-w-0 flex-col gap-1 border-line p-1.5 transition-colors duration-120', i % 7 < 6 && 'border-r', i < (WEEKS - 1) * 7 && 'border-b', over === date ? 'bg-primary-soft' : weekend && 'bg-surface-2')}
              {...bind(date, past)}
            >
              <span className={cn('num flex h-6 min-w-6 items-center justify-center self-start rounded-full px-1.5 font-mono text-small', date === today ? 'bg-primary text-on-primary' : past ? 'text-faint' : 'text-muted')}>
                {dayNum === 1 || i === 0 ? fmtDate(date, { month: 'short', day: 'numeric' }) : dayNum}
              </span>
              {list.slice(0, 3).map((p) => (
                <EventChip key={p.id} post={p} now={now} onOpen={() => openEditor(p.id)} onDark={weekend} />
              ))}
              {list.length > 3 && <DayMore date={date} posts={list} now={now} hidden={list.length - 3} />}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** One week, every post of each day stacked (tablets). */
function WeekView({ posts }: { posts: Post[] }) {
  const openEditor = useUI((s) => s.openPostEditor);
  const now = useNow(60_000);
  const today = todayStr();
  const [start, setStart] = useStartWeek(posts);
  const { over, bind } = useDayDrop();
  const days = useMemo(() => byDay(posts), [posts]);
  const end = addDays(start, 6);
  const inView = posts.filter((p) => {
    const d = isoToDateStr(p.scheduledAt);
    return d >= start && d <= end;
  }).length;
  return (
    <section className="card overflow-hidden" aria-label="Scheduled posts calendar">
      <CalendarBar
        title={`${fmtDate(start, { month: 'short', day: 'numeric' })} – ${fmtDate(end, { month: 'short', day: 'numeric', year: 'numeric' })}`}
        sub={`${inView} post${inView === 1 ? '' : 's'} this week`}
        onPrev={() => setStart((d) => addDays(d, -7))}
        onToday={() => setStart(mondayOf(today))}
        onNext={() => setStart((d) => addDays(d, 7))}
        prevLabel="Previous week"
        nextLabel="Next week"
      />
      <div className="grid grid-cols-7">
        {Array.from({ length: 7 }, (_, i) => {
          const date = addDays(start, i);
          const list = days.get(date) ?? [];
          const past = date < today;
          const weekend = i >= 5;
          return (
            <div key={date} className={cn('flex min-h-[420px] min-w-0 flex-col gap-1.5 border-line p-1.5 transition-colors duration-120', i < 6 && 'border-r', over === date ? 'bg-primary-soft' : weekend && 'bg-surface-2')} {...bind(date, past)}>
              <div className="mb-1 flex items-center justify-between gap-1 px-1 pt-0.5">
                <span className="text-caption text-muted">{WEEKDAYS[i]}</span>
                <span className={cn('num flex h-6 min-w-6 items-center justify-center rounded-full px-1.5 font-mono text-small', date === today ? 'bg-primary text-on-primary' : past ? 'text-faint' : 'text-muted')}>{Number(date.slice(8, 10))}</span>
              </div>
              {list.map((p) => (
                <EventChip key={p.id} post={p} now={now} onOpen={() => openEditor(p.id)} onDark={weekend} />
              ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** The post's state as one dot and a word (Due posts show their badge instead). */
function RowState({ post, now }: { post: Post; now: number }) {
  if (isDue(post, now) && (!post.external || post.external.state === 'failed' || post.external.state === 'scheduled')) return <DueBadge post={post} now={now} />;
  return <StatusDot tone="primary">{manusHolds(post) ? 'With Manus' : 'Planned'}</StatusDot>;
}

function groupByDay(posts: Post[]): [string, Post[]][] {
  return [...byDay(posts).entries()];
}

/** Phones: the planned posts by day, each a row that opens the post, with the post's "⋯" menu. */
function Agenda({ posts }: { posts: Post[] }) {
  const project = useActiveProject()!;
  const openEditor = useUI((s) => s.openPostEditor);
  const offer = useCanOfferManus();
  const now = useNow(60_000);
  const groups = useMemo(() => groupByDay(posts), [posts]);
  return (
    <div className="flex flex-col gap-4" aria-label="Scheduled posts calendar">
      {groups.map(([date, list]) => (
        <section key={date} aria-label={fmtDate(date, { weekday: 'long', month: 'long', day: 'numeric' })}>
          <h3 className="sticky top-0 z-[1] -mx-4 flex items-baseline gap-2 bg-surface px-4 py-2 text-h4 text-ink">
            {date === todayStr() ? 'Today' : fmtDate(date, { weekday: 'long' })}
            <span className="num font-mono text-caption font-normal text-muted">{fmtDate(date, { month: 'short', day: 'numeric' })}</span>
          </h3>
          <ul className="flex flex-col">
            {list.map((p) => (
              <li key={p.id} className="relative -mx-2 flex min-w-0 items-center gap-3 rounded-md px-2 py-2 transition-colors duration-120 hover:bg-surface-2">
                <span className="w-12 shrink-0 overflow-hidden rounded-md">
                  <PostVisual style={p.style} headline={p.headline} brand={project.brand} media={p.media} storyboard={p.storyboard} aspect="1/1" className="!rounded-none" />
                </span>
                <span className="min-w-0 flex-1">
                  <button type="button" className="block w-full truncate text-left text-ui text-ink after:absolute after:inset-0 after:rounded-md" onClick={() => openEditor(p.id)} aria-label={`Edit ${p.headline}, ${PLATFORMS[p.platform].label} at ${timeOf(p.scheduledAt)}`}>
                    {p.headline}
                  </button>
                  <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-caption text-muted">
                    <PlatformMark platform={p.platform} size={12} />
                    <span className="truncate">{networkLabel(p.platform)}</span>
                    <span aria-hidden="true">·</span>
                    <span className="num shrink-0 font-mono">{timeOf(p.scheduledAt)}</span>
                  </span>
                </span>
                <span className="shrink-0">
                  <RowState post={p} now={now} />
                </span>
                {/* above the row's stretched title button */}
                <span className="relative z-[1] -mr-1 shrink-0">
                  <MoreMenu items={plannedMenu(p, offer, openEditor)} />
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** The list view: days, each a card of rows with the time, the one action that fits, and "⋯". */
function QueueList({ posts }: { posts: Post[] }) {
  const groups = useMemo(() => groupByDay(posts), [posts]);
  return (
    <div className="flex flex-col gap-6">
      {groups.map(([date, list]) => (
        <section key={date} aria-label={fmtDate(date, { weekday: 'long', month: 'long', day: 'numeric' })}>
          <h3 className="mb-2 flex items-baseline gap-2 text-h4 text-ink">
            {fmtDate(date, { weekday: 'long', month: 'short', day: 'numeric' })}
            <span className="text-caption font-normal text-muted">
              {list.length} post{list.length > 1 ? 's' : ''}
            </span>
          </h3>
          <ul className="card divide-y divide-line">
            {list.map((p) => (
              <QueueRow key={p.id} post={p} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/**
 * A row's 56px thumbnail. The row's title is its button; the picture opens the post too, for the mouse,
 * without being a button itself (a video's visual has a play button of its own).
 */
function Thumb({ post: p, brand, onOpen }: { post: Post; brand: Brand; onOpen: () => void }) {
  return (
    <div className="w-14 shrink-0 cursor-pointer overflow-hidden rounded-md" onClick={onOpen}>
      <PostVisual style={p.style} headline={p.headline} brand={brand} media={p.media} storyboard={p.storyboard} aspect="1/1" className="!rounded-none" />
    </div>
  );
}

/** Platform, type and look of a post as one muted line. */
function PostMeta({ post, children }: { post: Post; children?: ReactNode }) {
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-muted">
      <span className="inline-flex items-center gap-1.5 font-medium text-ink-2">
        <PlatformMark platform={post.platform} size={14} />
        {networkLabel(post.platform)}
      </span>
      <PostTypeTag type={post.postType} />
      <span>{styleLabel(post)}</span>
      {children}
    </div>
  );
}

function QueueRow({ post: p }: { post: Post }) {
  const project = useActiveProject()!;
  const update = useStore((s) => s.updatePost);
  const openEditor = useUI((s) => s.openPostEditor);
  const offer = useCanOfferManus();
  const now = useNow(60_000);
  const held = manusHolds(p);
  const menu = plannedMenu(p, offer, openEditor);
  return (
    <li className="flex flex-col gap-3 px-4 py-3 md:flex-row md:items-center">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <Thumb post={p} brand={project.brand} onOpen={() => openEditor(p.id)} />
        <div className="min-w-0 flex-1">
          <button type="button" className="block max-w-full truncate text-left text-ui text-ink hover:underline" onClick={() => openEditor(p.id)} aria-label={`Edit ${p.headline}`}>
            {p.headline}
          </button>
          <p className="truncate text-small text-muted">{p.caption.split('\n')[0]}</p>
          <PostMeta post={p}>
            <DueBadge post={p} now={now} />
            <ExternalBadge post={p} compact />
            <GroupShareBadge post={p} compact />
          </PostMeta>
          <PostLinkNote post={p} compact className="mt-1.5" />
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 pl-[68px] md:pl-0">
        <DateTimeButton value={new Date(p.scheduledAt).getTime()} onChange={(ms) => update(p.id, { scheduledAt: new Date(ms).toISOString() })} min={Date.now()} aria-label="Reschedule" />
        {offer && !held ? (
          <ManusPostButton post={p} />
        ) : (
          !held && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => useMarkPosted.getState().open(p.id)}>
              <CheckCheck /> Mark as posted
            </button>
          )
        )}
        <MoreMenu items={menu} />
      </div>
    </li>
  );
}

/** Posted: what went out, who posted it and its link (the app doesn't read likes or views). */
function PublishedList({ posts }: { posts: Post[] }) {
  const project = useActiveProject()!;
  const openEditor = useUI((s) => s.openPostEditor);
  const offer = useCanOfferManus();
  const byManus = posts.filter((p) => p.publishedBy === 'manus').length;
  const networks = POST_PLATFORMS.map((n) => ({ n, count: posts.filter((p) => p.platform === n).length })).filter((x) => x.count);
  return (
    <div className="flex flex-col gap-4">
      <p className="num flex flex-wrap items-center gap-x-2 gap-y-1 text-small text-muted">
        <span>{posts.length} posted</span>
        <span aria-hidden="true">·</span>
        <span>{byManus} by Manus</span>
        <span aria-hidden="true">·</span>
        <span>{posts.length - byManus} marked by you</span>
        {networks.length > 0 && (
          <>
            <span aria-hidden="true">·</span>
            <span>{networks.map((x) => `${networkLabel(x.n)} ${x.count}`).join(', ')}</span>
          </>
        )}
        <InfoTip title="Likes, views and clicks" label="About likes and views">
          Likes, views and clicks live on each network: this app doesn’t read them. Open a post there to see how it’s doing.
        </InfoTip>
      </p>
      <ul className="card divide-y divide-line">
        {posts.slice(0, 60).map((p) => (
          <li key={p.id} className="flex items-start gap-3 px-4 py-3">
            <Thumb post={p} brand={project.brand} onOpen={() => openEditor(p.id)} />
            <div className="min-w-0 flex-1">
              <button type="button" className="block max-w-full truncate text-left text-ui text-ink hover:underline" onClick={() => openEditor(p.id)} aria-label={`Open ${p.headline}`}>
                {p.headline}
              </button>
              <p className="truncate text-small text-muted">{p.caption.split('\n')[0]}</p>
              <PostMeta post={p}>
                {p.external && <ExternalBadge post={p} compact />}
                {p.groupShare && <GroupShareBadge post={p} compact />}
              </PostMeta>
              <PostedBy post={p} className="mt-1.5" />
              <PostLinkNote post={p} compact className="mt-1.5" />
            </div>
            <MoreMenu items={[...(groupsOpen(p, offer) ? [{ label: 'Post to groups', icon: <Users />, onSelect: () => useManusGroups.getState().open(p.id) }] : []), ...postMenuEntries(p)]} />
          </li>
        ))}
      </ul>
      {posts.length > 60 && <p className="text-center text-caption text-muted">Showing the 60 most recent posts.</p>}
    </div>
  );
}
