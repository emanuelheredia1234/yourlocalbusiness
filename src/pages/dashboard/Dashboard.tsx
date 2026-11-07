// The Dashboard: a greeting, this week's plan (the page's one AI card), the next post in its frame with
// the one thing to do with it, the week's numbers, what's up next and the brand. A brand-new project
// (nothing posted, no strategy yet) gets one hero instead: its first three steps.
import { useMemo, type ReactNode } from 'react';
import {
  ArrowRight,
  CalendarDays,
  CheckCheck,
  Check,
  Clock,
  Compass,
  ExternalLink,
  Globe,
  PenSquare,
  Pencil,
  Plus,
} from 'lucide-react';
import type { Post, Project } from '@/lib/types';
import type { StrategyAction, StrategyState } from '@/lib/strategyTypes';
import { cn, ensureUrl, stripProtocol } from '@/lib/utils';
import { navigate } from '@/lib/router';
import { useMediaQuery, useNow } from '@/lib/hooks';
import { brandHandle } from '@/lib/brandMark';
import { PAGE_TYPE_LABEL } from '@/lib/pageTypes';
import { postedSince, useKpis } from '@/lib/kpis';
import { readiness } from '@/lib/readiness';
import { STEP_LABEL, actionDone, currentWeek, hasAnySection, readStrategy, strategyNextSteps, strategyProgress, type ActionCtx } from '@/lib/strategy';
import { actionTarget, runTarget } from '@/lib/strategyActions';
import { networkLabel } from '@/ai/postShared';
import { recommendPageType } from '@/ai/local/strategy';
import { openPage } from '@/ai/assistant/nav';
import { stopStrategy, useStrategyJob } from '@/ai/strategyJob';
import { useActiveProject, useStore } from '@/store/useStore';
import { useUI } from '@/store/ui';
import { BrandLogo, LogoMark } from '@/components/brand/Logo';
import { PostFrame } from '@/components/frames/Frames';
import { PostVisual } from '@/components/visuals/PostVisual';
import { PlatformMark } from '@/components/posts/PlatformIcon';
import { DueBadge, goesOutAt, isDue, postHeld, useMarkPosted } from '@/components/posts/PostActions';
import { PostNowButton, PublishStatus } from '@/components/posts/PostNowButton';
import { canPostFrom } from '@/lib/posting';
import { useConnections } from '@/store/analytics';
import { AIThinking, AiCard, GenerateButton, Spark } from '@/components/ai/AI';
import { Badge, Empty, MoreMenu, PageHeader, ProgressBar, Section, Skeleton, StatStrip, StatusDot, Swatch } from '@/components/ui/primitives';
import { CHECKING_LABEL, startRun, useCheckingServer } from '@/pages/strategy/runs';
import { AREA, ICON, WRITES } from './actionMeta';
import { MorningCard } from './MorningCard';

/** "Good morning" before noon, "Good afternoon" before 6 pm, then "Good evening". */
function greetingFor(d: Date): string {
  const h = d.getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

/** The end of this week (Monday to Sunday), local time. */
function endOfWeek(now: number): number {
  const d = new Date(now);
  d.setDate(d.getDate() + ((7 - d.getDay()) % 7));
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

/** "Thu 12:30 PM" */
const dayTime = (iso: string) => {
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
};
/** "Thu, Nov 5 · 12:00 PM" */
const dayDateTime = (iso: string) => {
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} · ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
};

/** The name a post shows on its network: a page's name on Facebook and LinkedIn, else the brand's own handle there, else its name (never a made-up handle). */
const handleFor = (p: Project, post?: Post) =>
  (post && post.platform !== 'facebook' && post.platform !== 'linkedin' ? brandHandle(p.brand, [post.platform]).replace(/^@/, '') : '') || p.brand.name || 'Your brand';

/** Start a strategy as Strategy's own button does: go there, then the run (with its confirm when it's paid). */
function planMyStrategy(projectId: string) {
  void openPage('strategy', 'plan').then((ok) => ok && startRun(projectId, { kind: 'all' }));
}

export function Dashboard() {
  const project = useActiveProject()!;
  const posts = useStore((s) => s.posts);
  const ads = useStore((s) => s.ads);
  const myListings = useStore((s) => s.myListings);
  const job = useStrategyJob(project.id);
  const now = useNow(60_000);
  const k = useKpis(project, 7);
  const s = useMemo(() => readStrategy(project), [project]);
  const ctx: ActionCtx = useMemo(() => ({ posts, ads, myListings, now }), [posts, ads, myListings, now]);

  const mine = useMemo(() => posts.filter((p) => p.projectId === project.id), [posts, project.id]);
  const planned = useMemo(() => mine.filter((p) => p.status === 'scheduled').sort((a, b) => goesOutAt(a).localeCompare(goesOutAt(b))), [mine]);
  const next = planned[0];
  const weekEnd = endOfWeek(now);
  const thisWeek = planned.filter((p) => {
    const t = new Date(goesOutAt(p)).getTime();
    return t >= now && t <= weekEnd;
  }).length;
  const fresh = mine.length === 0 && !hasAnySection(s) && !job;
  const brand = project.brand.name || 'Your business';
  const today = new Date(now).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const week = thisWeek ? `${thisWeek} post${thisWeek === 1 ? ' goes' : 's go'} out this week` : 'Nothing planned this week';

  return (
    <div>
      <PageHeader
        size="display"
        title={greetingFor(new Date(now))}
        description={
          <>
            <span className="max-sm:hidden">
              {brand} · {today} ·{' '}
            </span>
            {week}
          </>
        }
        actions={
          <button type="button" className="btn btn-secondary max-sm:hidden" onClick={() => navigate('calendar')}>
            <CalendarDays /> View calendar
          </button>
        }
      />

      {fresh ? (
        <FirstSteps project={project} />
      ) : (
        <>
          <MorningCard project={project} ctx={ctx} className="mb-4" />
          <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-12">
            <PlanCard project={project} s={s} ctx={ctx} className="lg:col-span-8" primaryTaken={!!next && !postHeld(next)} />
            <NextPost project={project} post={next} now={now} className="lg:col-span-4" />
          </div>
          {mine.length > 0 && <Numbers project={project} posts={mine} planned={planned} now={now} k={k} />}
          <Readiness project={project} posts={mine} listed={myListings.some((l) => l.projectId === project.id)} />
          <div className="mt-10 grid grid-cols-1 items-start gap-x-4 gap-y-10 lg:grid-cols-12">
            <UpNext project={project} posts={planned.slice(0, 5)} now={now} className="lg:col-span-8" />
            <BrandCard project={project} className="lg:col-span-4" />
          </div>
        </>
      )}
    </div>
  );
}

// ───────────── a brand-new project ─────────────

/** "Let's get {Brand} its first customers": three first steps and Plan my strategy. */
function FirstSteps({ project }: { project: Project }) {
  const checking = useCheckingServer(project.id);
  const job = useStrategyJob(project.id);
  const page = recommendPageType(project).pageType;
  const m = project.marketing;
  const steps: { icon: ReactNode; title: string; done: boolean; action: string; run: () => void }[] = [
    { icon: <Compass />, title: 'Plan your strategy', done: false, action: 'Open Strategy', run: () => void openPage('strategy', 'plan') },
    { icon: <PenSquare />, title: 'Create your first post', done: false, action: 'Create a post', run: () => useUI.getState().openComposer() },
    {
      icon: <Globe />,
      title: `Publish your ${PAGE_TYPE_LABEL[page].toLowerCase()}`,
      done: !!m.seoPublished,
      action: m.salesPage ? 'Open SEO page' : 'Build it',
      run: () => void (m.salesPage ? navigate('marketing-seo') : useUI.getState().openSeoBuilder({ pageType: page })),
    },
  ];
  return (
    <Empty
      variant="ai"
      title={`Let’s get ${project.brand.name || 'your business'} its first customers`}
      body="Three steps, about ten minutes."
      action={
        <div className="flex w-full flex-col items-center gap-6">
          <ol className="card w-full divide-y divide-line text-left">
            {steps.map((x) => (
              <li key={x.title} className="flex items-center gap-3 px-4 py-3">
                {x.done ? (
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center">
                    <CheckCircle done />
                  </span>
                ) : (
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface-3 text-ink-2 [&>svg]:size-4" aria-hidden="true">
                    {x.icon}
                  </span>
                )}
                <span className={cn('min-w-0 flex-1 text-ui', x.done ? 'text-muted' : 'text-ink')}>{x.title}</span>
                {x.done ? (
                  <span className="shrink-0 text-small text-muted">Done</span>
                ) : (
                  <button type="button" className="link shrink-0 text-small" onClick={x.run}>
                    {x.action}
                  </button>
                )}
              </li>
            ))}
          </ol>
          <GenerateButton variant="ai" size="lg" running={!!job || checking === 'all'} runningLabel={checking === 'all' ? CHECKING_LABEL : 'Researching…'} onClick={() => planMyStrategy(project.id)}>
            Plan my strategy
          </GenerateButton>
        </div>
      }
    />
  );
}

// ───────────── this week's plan ─────────────

/** A 20px check circle: filled when done, an empty ring when not. */
function CheckCircle({ done }: { done: boolean }) {
  return done ? (
    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary text-on-primary" aria-hidden="true">
      <Check size={14} strokeWidth={3} />
    </span>
  ) : (
    <span className="h-5 w-5 shrink-0 rounded-full border-[1.5px] border-line-3" aria-hidden="true" />
  );
}

/** The rows the card shows: the next open steps first (this week's), then this week's done ones, in plan order. */
function planRows(p: Project, s: StrategyState, ctx: ActionCtx, w: number): StrategyAction[] {
  const actions = s.plan?.actions ?? [];
  const open = strategyNextSteps(p, s, ctx, 3);
  const done = actions.filter((a) => a.week === w && !open.includes(a) && actionDone(a, p, s, ctx).done);
  const picked = [...open, ...done].slice(0, 3);
  return actions.filter((a) => picked.includes(a));
}

function PlanRow({ project, s, a, ctx }: { project: Project; s: StrategyState; a: StrategyAction; ctx: ActionCtx }) {
  const done = actionDone(a, project, s, ctx).done;
  const t = actionTarget(a, project, s);
  const meta = [a.platform ? networkLabel(a.platform) : '', AREA[a.kind]].filter(Boolean).join(' · ');
  const action = done ? (
    <span className="text-small text-muted">{actionDone(a, project, s, ctx).by === 'app' ? 'Done in the app' : 'Done'}</span>
  ) : t ? (
    WRITES.has(a.kind) ? (
      <GenerateButton variant="ai-ghost" size="sm" onClick={() => void runTarget(t.target)}>
        {t.label}
      </GenerateButton>
    ) : (
      <button type="button" className="link inline-flex items-center gap-1 text-small" onClick={() => void runTarget(t.target)}>
        {t.label} <ArrowRight size={14} aria-hidden="true" />
      </button>
    )
  ) : null;
  return (
    <li className="flex items-start gap-3 py-3 sm:items-center">
      {done ? (
        <span className="flex h-8 w-8 shrink-0 items-center justify-center">
          <CheckCircle done />
          <span className="sr-only">Done: </span>
        </span>
      ) : (
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface-3 text-ink-2 [&>svg]:size-4" aria-hidden="true">
          {ICON[a.kind] ?? <Compass />}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p className={cn('text-ui sm:truncate', done ? 'text-muted' : 'text-ink')} title={a.title}>
          {a.title}
        </p>
        <p className="truncate text-small text-muted">{meta}</p>
        {action && <div className="mt-1.5 sm:hidden [&>.btn]:-ml-3">{action}</div>}
      </div>
      {action && <div className="shrink-0 max-sm:hidden [&>.btn]:-mr-3">{action}</div>}
    </li>
  );
}

/** "This week's plan": the week's goal and its next steps, each with the button that does it. */
function PlanCard({ project, s, ctx, className, primaryTaken }: { project: Project; s: StrategyState; ctx: ActionCtx; className?: string; primaryTaken: boolean }) {
  const job = useStrategyJob(project.id);
  const checking = useCheckingServer(project.id);
  // a phone's strip keeps its width for the stage ("Researching your market…"): compact, without the step
  const wide = useMediaQuery('(min-width: 640px)');
  const title = (
    <span className="flex min-w-0 items-center gap-2">
      <Spark size={18} />
      <h2 className="truncate text-h3 text-ink">This week’s plan</h2>
    </span>
  );
  if (job) {
    const step = job.steps[job.index] ?? job.steps[0];
    return (
      <AiCard className={className}>
        <section aria-label="Your plan this week">
          {title}
          <AIThinking running compact={!wide} stage={`${STEP_LABEL[step]}…`} step={wide ? `Step ${job.index + 1} of ${job.steps.length}` : undefined} onStop={() => stopStrategy(project.id)} className="mt-4" />
          <div className="mt-5 flex flex-col gap-3" aria-hidden="true">
            <Skeleton ai className="h-6 w-2/3" />
            <Skeleton ai className="h-4 w-11/12" />
            <Skeleton ai className="h-4 w-4/5" />
            <Skeleton ai className="h-4 w-3/5" />
          </div>
        </section>
      </AiCard>
    );
  }
  const plan = s.plan;
  if (!plan) {
    return (
      <AiCard className={className}>
        <section aria-label="Your plan this week">
          <Empty
            variant="ai"
            glow={false}
            className="py-6 sm:py-8"
            title={`Plan how ${project.brand.name || 'your business'} gets customers`}
            body="Research, where to promote, and a 4-week plan. About two minutes."
            action={
              <GenerateButton variant={primaryTaken ? 'ai-outline' : 'ai'} running={checking === 'all'} runningLabel={CHECKING_LABEL} onClick={() => planMyStrategy(project.id)}>
                Plan my strategy
              </GenerateButton>
            }
          />
        </section>
      </AiCard>
    );
  }
  const pr = strategyProgress(project, s, ctx);
  const w = currentWeek(plan, ctx.now);
  const week = plan.weeks.find((x) => x.week === w);
  const rows = planRows(project, s, ctx, w);
  const headline = w <= 4 && week ? week.goal || week.focus : 'Keep going with the steps still open.';
  return (
    <AiCard className={className}>
      <section aria-label="Your plan this week">
        <div className="flex items-center gap-2">
          {title}
          <Badge className="shrink-0">{w <= 4 ? `Week ${w} of 4` : 'After week 4'}</Badge>
          <span className="num ml-auto shrink-0 text-small text-muted">
            {pr.done} of {pr.total} done
          </span>
        </div>
        <p className="clamp-2 mt-3 text-h2 text-ink">{headline}</p>
        {rows.length > 0 ? (
          <ul className="mt-4 divide-y divide-line border-t border-line">
            {rows.map((a) => (
              <PlanRow key={a.id} project={project} s={s} a={a} ctx={ctx} />
            ))}
          </ul>
        ) : (
          <p className="mt-4 border-t border-line pt-4 text-small text-muted">Every step is done. Keep the habits going.</p>
        )}
        <div className="mt-3 border-t border-line pt-3">
          <button type="button" className="link inline-flex items-center gap-1 text-small" onClick={() => void openPage('strategy', 'plan')}>
            Open plan <ArrowRight size={14} aria-hidden="true" />
          </button>
        </div>
      </section>
    </AiCard>
  );
}

// ───────────── the next post ─────────────

/** The next planned post as it will look, with the one thing to do with it (the page's only filled button). */
function NextPost({ project, post, now, className }: { project: Project; post?: Post; now: number; className?: string }) {
  const { byPlatform } = useConnections();
  const b = project.brand;
  if (!post) {
    return (
      <section aria-label="Next post" className={cn('flex min-w-0 flex-col items-center', className)}>
        <PostFrame handle={handleFor(project)} avatar={<LogoMark colors={b.colors} logo={b.logo} name={b.name} size={24} />} meta="Your next post shows here" className="w-full max-w-[300px]">
          <div className="relative aspect-square w-full" style={{ background: `linear-gradient(140deg, ${b.colors.paper} 0%, ${b.colors.primary} 100%)` }}>
            <span className="absolute inset-0 flex items-center justify-center">
              <LogoMark colors={b.colors} logo={b.logo} name={b.name} size={72} />
            </span>
            <span className="absolute right-3 top-3">
              <Badge className="shadow-xs">Preview</Badge>
            </span>
          </div>
        </PostFrame>
        <button type="button" className="btn btn-secondary btn-sm mt-3" onClick={() => useUI.getState().openComposer()}>
          <Plus /> Create a post
        </button>
      </section>
    );
  }
  const held = postHeld(post);
  const connected = !__ARTIFACT_BUILD__ && canPostFrom(byPlatform[post.platform]);
  const due = isDue(post, now);
  const openEditor = () => useUI.getState().openPostEditor(post.id);
  return (
    <section aria-label="Next post" className={cn('flex min-w-0 flex-col items-center', className)}>
      <PostFrame
        handle={handleFor(project, post)}
        avatar={<LogoMark colors={b.colors} logo={b.logo} name={b.name} size={24} />}
        meta={networkLabel(post.platform)}
        corner={<PlatformMark platform={post.platform} size={20} />}
        footer={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="inline-flex items-center gap-1.5">
              <Clock size={14} aria-hidden="true" />
              {due ? 'Was due' : 'Next post'} · <span className="num font-mono">{dayTime(goesOutAt(post))}</span>
            </span>
            <DueBadge post={post} now={now} />
          </span>
        }
        className="w-full max-w-[300px]"
      >
        <PostVisual style={post.style} headline={post.headline} brand={b} watermark={post.watermark} media={post.media} storyboard={post.storyboard} aspect="1/1" className="!rounded-none" />
        {/* the caption as PostFrame lays it out, with the padding outside the clamp (a 4th line must not peek through it) */}
        {post.caption && (
          <div className="px-3 py-2.5">
            <p className="clamp-3 text-small text-ink-2">
              <span className="mr-1 font-semibold text-ink">{handleFor(project, post)}</span>
              {post.caption}
            </p>
          </div>
        )}
      </PostFrame>
      <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
        {held ? (
          <>
            <PublishStatus post={post} compact />
            <PostNowButton post={post} />
          </>
        ) : connected ? (
          <PostNowButton post={post} primary />
        ) : (
          <>
            <PostNowButton post={post} />
            <button type="button" className="btn btn-primary btn-sm" onClick={() => useMarkPosted.getState().open(post.id)}>
              <CheckCheck /> Mark as posted
            </button>
          </>
        )}
        <button type="button" className="btn btn-ghost btn-sm" onClick={openEditor}>
          <Pencil /> Edit
        </button>
      </div>
    </section>
  );
}

// ───────────── the week's numbers ─────────────

function Numbers({ project, posts, planned, now, k }: { project: Project; posts: Post[]; planned: Post[]; now: number; k: ReturnType<typeof useKpis> }) {
  const sum = (key: 'posted' | 'made') => k.prev.reduce((t, d) => t + d[key], 0);
  const prevPosted = sum('posted');
  const prevMade = sum('made');
  const networks = [...new Set(postedSince(posts, project.id, k.since).map((p) => networkLabel(p.platform)))];
  const upcoming = planned.find((p) => new Date(goesOutAt(p)).getTime() > now);
  // posts the owner still has to get out (not the ones that are, or may be, out already): today's, and the ones whose day has passed
  const today = new Date(now).toDateString();
  const open = planned.filter((p) => !postHeld(p));
  const dueToday = open.filter((p) => new Date(goesOutAt(p)).toDateString() === today).length;
  const overdue = open.filter((p) => isDue(p, now) && new Date(goesOutAt(p)).toDateString() !== today).length;
  return (
    <section aria-label="This week" className="mt-6">
      <StatStrip
        items={[
          { label: 'Posted · 7 days', value: k.posted, sub: networks.length ? networks.join(', ') : 'Nothing in the last 7 days', delta: prevPosted > 0 ? k.posted - prevPosted : null, onClick: () => navigate('analytics') },
          { label: 'Planned', value: k.upcoming, sub: upcoming ? `Next: ${dayTime(goesOutAt(upcoming))}` : 'Nothing planned', onClick: () => navigate('calendar') },
          { label: 'Due today', value: dueToday, sub: overdue ? `${overdue} overdue` : 'Nothing overdue', onClick: () => navigate('calendar') },
          { label: 'Made with AI · 7 days', value: k.made, sub: 'Posts, emails, pages', delta: prevMade > 0 ? k.made - prevMade : null },
        ]}
      />
    </section>
  );
}

// ───────────── launch readiness ─────────────

/** The steps from a brand to a first post, only while some are open. */
function Readiness({ project, posts, listed }: { project: Project; posts: Post[]; listed: boolean }) {
  const r = readiness(project, { scheduled: posts.filter((p) => p.status !== 'draft').length, posted: posts.filter((p) => p.status === 'published').length, listed });
  const total = r.items.length;
  if (r.done >= total) return null;
  return (
    <section aria-label="Launch readiness" className="card mt-6 p-4 sm:px-5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h2 className="text-h4 text-ink">Launch readiness</h2>
        <ProgressBar value={r.done} max={total} label={`${r.done} of ${total}`} className="min-w-[160px] flex-1" />
      </div>
      <ul className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-4">
        {r.items.map((it) => (
          <li key={it.label} className={cn(it.done && 'max-sm:hidden')}>
            {it.done ? (
              <span className="flex min-h-8 items-center gap-2.5 text-small text-muted">
                <CheckCircle done />
                <span className="min-w-0 truncate" title={it.label}>
                  {it.label}
                </span>
              </span>
            ) : (
              <button type="button" className="group flex min-h-8 w-full items-center gap-2.5 text-left text-small text-ink" onClick={() => navigate(it.route)}>
                <CheckCircle done={false} />
                <span className="min-w-0 flex-1 truncate group-hover:underline" title={it.label}>
                  {it.label}
                </span>
                <ArrowRight size={14} className="shrink-0 text-muted" aria-hidden="true" />
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ───────────── up next ─────────────

/** A planned post's state as a dot and a word (a due one shows its badge). */
function RowState({ post, now }: { post: Post; now: number }) {
  if (isDue(post, now) && (!post.external || post.external.state === 'failed' || post.external.state === 'scheduled')) return <DueBadge post={post} now={now} />;
  if (post.external?.via === 'api' && post.external.state === 'working') return <StatusDot tone="primary" pulse>Posting…</StatusDot>;
  if (post.external?.via === 'api' && post.external.state === 'unknown') return <StatusDot tone="warn">Check it</StatusDot>;
  return <StatusDot tone="primary">{postHeld(post) ? 'Sent earlier' : 'Planned'}</StatusDot>;
}

/** A grid cell that keeps the region name the page had (the Section primitive takes no aria-label yet). */
function Region({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <section aria-label={label} className={cn('min-w-0', className)}>
      {children}
    </section>
  );
}

function UpNext({ project, posts, now, className }: { project: Project; posts: Post[]; now: number; className?: string }) {
  const openEditor = (id: string) => useUI.getState().openPostEditor(id);
  return (
    <Region label="Upcoming posts" className={className}>
      <Section
        title="Up next"
        className="mt-0"
        actions={
          <button type="button" className="link text-small" onClick={() => navigate('calendar')}>
            Open calendar
          </button>
        }
      >
        {posts.length ? (
          <ul className="card divide-y divide-line">
            {posts.map((p) => (
              <li key={p.id} className="relative flex min-w-0 items-center gap-3 px-4 py-3 transition-colors duration-120 hover:bg-surface-2">
                <span className="w-10 shrink-0 overflow-hidden rounded-md" aria-hidden="true">
                  <PostVisual style={p.style} headline={p.headline} brand={project.brand} media={p.media} storyboard={p.storyboard} aspect="1/1" className="!rounded-none" />
                </span>
                <span className="min-w-0 flex-1">
                  <button type="button" className="block w-full truncate text-left text-ui text-ink after:absolute after:inset-0" onClick={() => openEditor(p.id)} title={p.headline}>
                    {p.headline}
                  </button>
                  <span className="mt-0.5 block truncate text-small text-muted">
                    {networkLabel(p.platform)} · <span className="num">{dayDateTime(goesOutAt(p))}</span>
                  </span>
                </span>
                <span className="shrink-0 max-sm:hidden">
                  <RowState post={p} now={now} />
                </span>
                {/* above the row's stretched title button */}
                <span className="relative z-[1] -mr-1 shrink-0">
                  <MoreMenu
                    label={`More for ${p.headline}`}
                    items={[
                      { label: 'Edit', icon: <Pencil />, onSelect: () => openEditor(p.id) },
                      { label: 'Open in calendar', icon: <CalendarDays />, onSelect: () => void openPage('calendar', 'scheduled') },
                    ]}
                  />
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="card px-4 py-3">
            <Empty
              variant="inline"
              title="Nothing planned yet."
              action={
                <button type="button" className="link" onClick={() => void navigate('marketing-social').then((ok) => ok && useUI.getState().setSocialTab('batch'))}>
                  Plan my week
                </button>
              }
            />
          </div>
        )}
      </Section>
    </Region>
  );
}

// ───────────── the brand ─────────────

/** Your website as you entered it. One that older versions made up from your name is asked about once. */
function WebsiteLink({ project }: { project: Project }) {
  const updateProject = useStore((s) => s.updateProject);
  const b = project.brand;
  const answer = (mine: boolean) =>
    updateProject(project.id, (p) => {
      const { guessedWebsite, ...brand } = p.brand;
      return { ...p, brand: mine && guessedWebsite ? { ...brand, websiteUrl: guessedWebsite, websiteConfirmed: true } : brand };
    });
  if (b.websiteUrl) {
    return (
      <a href={ensureUrl(b.websiteUrl)} target="_blank" rel="noopener noreferrer" className="link inline-flex max-w-full items-center gap-1.5 text-small">
        <Globe size={14} className="shrink-0" aria-hidden="true" />
        <span className="truncate">{stripProtocol(b.websiteUrl)}</span>
        <ExternalLink size={12} className="shrink-0" aria-hidden="true" />
      </a>
    );
  }
  if (b.guessedWebsite) {
    return (
      <div className="well px-3 py-2.5 text-small text-ink-2">
        <p>
          Is <span className="font-medium text-ink">{stripProtocol(b.guessedWebsite)}</span> your website? It was filled in from your brand name, not by you, so it’s no longer shown on your posts, ads or listing.
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" className="btn btn-secondary btn-xs" onClick={() => answer(true)}>
            Yes, it’s mine
          </button>
          <button type="button" className="btn btn-ghost btn-xs" onClick={() => answer(false)}>
            No
          </button>
        </div>
      </div>
    );
  }
  return (
    <button type="button" className="link inline-flex items-center gap-1.5 text-small" onClick={() => void openPage('workspace-settings', 'brand')}>
      <Globe size={14} aria-hidden="true" /> Add your website
    </button>
  );
}

function BrandCard({ project, className }: { project: Project; className?: string }) {
  const b = project.brand;
  const markOnly = b.logo.layout === 'mark';
  const palette = [b.colors.primary, b.colors.secondary, b.colors.accent, b.colors.ink, b.colors.paper];
  return (
    <Region label="Active project" className={className}>
      <Section
        title="Your brand"
        className="mt-0"
        actions={
          <button type="button" className="btn btn-ghost btn-sm -mr-2" onClick={() => void openPage('workspace-settings', 'brand')}>
            <Pencil /> Edit brand
          </button>
        }
      >
        <div className="card flex flex-col gap-4 p-5">
          <div className="flex min-w-0 items-center gap-3">
            <BrandLogo brand={b} size={40} layout={markOnly ? 'mark' : 'horizontal'} className="min-w-0" />
            {markOnly && <p className="min-w-0 truncate text-h3 text-ink">{b.name}</p>}
          </div>
          {b.tagline && <p className="text-small text-muted">{b.tagline}</p>}
          <div className="flex items-center gap-2">
            {palette.map((c, i) => (
              <Swatch key={`${c}-${i}`} color={c} size={20} />
            ))}
          </div>
          <WebsiteLink project={project} />
        </div>
      </Section>
    </Region>
  );
}
