// Pieces the Strategy tabs share: how a statement is backed (from the web, the AI's general knowledge,
// built-in guidance) with its sources, who wrote a section and its Refresh button, the staleness banners,
// a plan action with its "Do it" button, the page to build first and where its link goes.
// Everything an AI or a web page wrote is rendered as plain text; links only after isHttpUrl.
import { useMemo, useState, type ReactNode } from 'react';
import { Check, ChevronDown, ExternalLink, Globe, RefreshCw, Undo2 } from 'lucide-react';
import type { PostPlatform, Project } from '@/lib/types';
import type { Backed, ResearchReason, StepInfo, StrategyAction, StrategySource, StrategyState, StrategyStep } from '@/lib/strategyTypes';
import { actionDone, isHttpUrl, strategyFactsHash, type ActionCtx } from '@/lib/strategy';
import { actionTarget, runTarget } from '@/lib/strategyActions';
import { tickAction } from '@/lib/strategyWrite';
import { recommendPageType, defaultLinkPlacement } from '@/ai/local/strategy';
import { PAGE_TYPE_DESC, PAGE_TYPE_LABEL, missingLink } from '@/lib/pageTypes';
import { LINK_PLACEMENT_LABEL, pageLink, placementFor } from '@/lib/pageLink';
import { cn, fmtDate, fmtRelative } from '@/lib/utils';
import { PLATFORMS } from '@/ai/knowledge';
import { openPage } from '@/ai/assistant/nav';
import { useStore } from '@/store/useStore';
import { useUI } from '@/store/ui';
import { useStrategyJob } from '@/ai/strategyJob';
import { CopyButton } from '@/components/ui/primitives';
import { PlatformGlyph } from '@/components/posts/PlatformIcon';
import { linksFlow, undoLinksFlow } from './apply';
import { startRun } from './runs';

/** The workspace things the "done in the app" checks read. */
export function useActionCtx(): ActionCtx {
  const posts = useStore((s) => s.posts);
  const ads = useStore((s) => s.ads);
  const myListings = useStore((s) => s.myListings);
  return useMemo(() => ({ posts, ads, myListings, now: Date.now() }), [posts, ads, myListings]);
}

export const netLabel = (n: string) => (n === 'x' ? 'X' : PLATFORMS[n as PostPlatform]?.label ?? n);

/** A link to Settings → AI (where keys and what they power are set). */
export function SettingsAILink({ children = 'Settings → AI' }: { children?: ReactNode }) {
  return (
    <button type="button" className="link" onClick={() => void openPage('workspace-settings', 'ai')}>
      {children}
    </button>
  );
}

/** Text with "Settings → AI" turned into a link (not in the claude.ai build, which has no keys to set). */
export function WithSettingsLink({ text }: { text: string }) {
  const at = text.indexOf('Settings → AI');
  if (at < 0 || __ARTIFACT_BUILD__) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <SettingsAILink />
      {text.slice(at + 'Settings → AI'.length)}
    </>
  );
}

// ───────────── how a statement is backed ─────────────

const BASIS_CHIP = { web: 'From the web', ai: 'AI’s general knowledge', builtin: 'Built-in guidance' } as const;
const BASIS_CLASS = { web: 'bg-good-soft text-good', ai: 'bg-warn-soft text-warn', builtin: 'bg-surface-2 text-ink-2' } as const;

/** "From the web" (with when it was found), "AI's general knowledge" or "Built-in guidance". */
export function BasisBadge({ basis, sources, all, manus }: { basis: Backed['basis']; sources?: number[]; all: StrategySource[]; manus?: boolean }) {
  const cited = all.filter((x) => sources?.includes(x.n));
  const found = cited.length ? Math.min(...cited.map((x) => x.at || Date.now())) : 0;
  const tip =
    basis === 'web'
      ? `Found by a web search on ${found ? fmtDate(found, { month: 'short', day: 'numeric', year: 'numeric' }) : 'the date shown'}. Pages change: check them before you rely on them.${manus || cited.some((x) => x.via === 'manus') ? ' Manus read this page.' : ''}`
      : basis === 'ai'
        ? 'Not from a search. It may be out of date or wrong for your area.'
        : 'The app’s general starter notes, not research.';
  return (
    <span className={cn('badge w-fit', BASIS_CLASS[basis])} title={tip}>
      {BASIS_CHIP[basis]}
      <span className="sr-only">. {tip}</span>
    </span>
  );
}

/** "[1] example.com" chips, each opening its page in a new tab. */
export function SourceChips({ ns, all }: { ns?: number[]; all: StrategySource[] }) {
  const list = (ns ?? []).map((n) => all.find((x) => x.n === n)).filter((x): x is StrategySource => !!x && isHttpUrl(x.url));
  if (!list.length) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {list.map((x) => (
        <a key={x.n} href={x.url} target="_blank" rel="noopener noreferrer nofollow" className="badge bg-surface-2 text-ink-2 hover:text-primary" title={x.title}>
          [{x.n}] {x.domain}
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      ))}
    </span>
  );
}

/** The basis badge and the sources of one point. */
export function Backing({ item, all, className, manus }: { item: Backed; all: StrategySource[]; className?: string; manus?: boolean }) {
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1.5', className)}>
      <BasisBadge basis={item.basis} sources={item.sources} all={all} manus={manus} />
      {item.basis === 'web' && <SourceChips ns={item.sources} all={all} />}
    </span>
  );
}

/** The sources a list of points cites, in number order. */
export function citedBy(items: (Backed | undefined)[]): number[] {
  return [...new Set(items.flatMap((x) => x?.sources ?? []))].sort((a, b) => a - b);
}

/** The sources, as found: title, site, when, the page's own date, and whether Manus read it. */
export function SourcesList({ ns, all, title = 'Sources', manusRead }: { ns?: number[]; all: StrategySource[]; title?: string; manusRead?: Set<number> }) {
  const list = (ns ? all.filter((x) => ns.includes(x.n)) : all).filter((x) => isHttpUrl(x.url)).sort((a, b) => a.n - b.n);
  if (!list.length) return null;
  return (
    <section className="flex flex-col gap-2" aria-label={title}>
      <h3 className="text-[13px] font-semibold text-ink">
        {title} ({list.length})
      </h3>
      <ol className="flex flex-col gap-1.5">
        {list.map((x) => (
          <li key={x.n} className="text-[12.5px] leading-snug text-ink-2">
            <a href={x.url} target="_blank" rel="noopener noreferrer nofollow" className="font-medium text-ink hover:text-primary hover:underline">
              [{x.n}] {x.title}
              <ExternalLink size={11} className="ml-1 inline-block align-[-1px] text-muted" aria-hidden="true" />
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
            <span className="text-muted">
              {' '}
              — {x.domain}
              {x.at ? ` · found ${fmtDate(x.at, { month: 'short', day: 'numeric', year: 'numeric' })}` : ''}
              {x.pageAge ? ` · page date ${x.pageAge}` : ''}
              {x.via === 'manus' || manusRead?.has(x.n) ? ' · Manus read this page' : ''}
            </span>
          </li>
        ))}
      </ol>
      <p className="text-xs text-muted">Links open the original pages. The app shows them as found and doesn’t vouch for them.</p>
    </section>
  );
}

// ───────────── research reasons ─────────────

/** Why research has no web sources, with the provider's name (spec §2.3). */
export function reasonCopy(reason: ResearchReason, p = 'Your AI'): string {
  switch (reason) {
    case 'unsupported':
      return `${p} can’t search the web for Strategy, so these notes come from its general knowledge. For sources, tick Strategy for a key that can search (Anthropic, OpenAI, xAI, Meta or OpenRouter) in Settings → AI.`;
    case 'provider_refused':
      return `${p} turned the web search down (it may be off for your account), so these notes come from the AI’s general knowledge.`;
    case 'not_used':
      return 'The AI answered without searching, so these notes come from its general knowledge. You can search again (paid).';
    case 'no_results':
      return 'The web search found nothing useful, so these notes come from the AI’s general knowledge.';
    case 'search_failed':
      return 'The web search failed this time, so these notes come from the AI’s general knowledge.';
    case 'claude_ai':
      return 'There’s no web search in claude.ai, so these notes come from Claude’s general knowledge and may be out of date.';
    case 'builtin':
      return 'No AI wrote this: these are the app’s built-in starter notes, not research.';
    default:
      return '';
  }
}

export function Banner({ children, tone = 'warn', className }: { children: ReactNode; tone?: 'warn' | 'info'; className?: string }) {
  return <div className={cn('rounded-md px-3 py-2.5 text-[13px] text-ink', tone === 'warn' ? 'bg-warn-soft' : 'bg-info-soft', className)}>{children}</div>;
}

// ───────────── who wrote a section ─────────────

/** "Anthropic Claude · claude-opus-5-5", "Claude in claude.ai" or "the built-in engine". */
export function writtenBy(info: Pick<StepInfo, 'provider' | 'meta'>): string {
  if (info.provider === 'local') return 'the built-in engine';
  if (info.provider === 'claude') return 'Claude in claude.ai';
  return info.meta ? `${info.meta.providerLabel} · ${info.meta.model}` : 'your AI';
}

/** The section was written from other details than the project has now. */
export const detailsChanged = (p: Project, s: StrategyState, info?: StepInfo) => !!info && info.factsHash !== strategyFactsHash(p, s.inputs);
/** The section is older than the research (or Manus's findings) under it. */
export function beforeResearch(s: StrategyState, step: StrategyStep): boolean {
  const info = s[step];
  if (!info || step === 'research') return false;
  const at = Math.max(s.research?.at ?? 0, s.manus?.state === 'done' ? s.manus.doneAt ?? 0 : 0);
  return !!at && (info.researchAt ?? 0) < at;
}

/** The banners above a section: the owner's details changed, or newer research came in. */
export function StaleBanners({ project, s, step }: { project: Project; s: StrategyState; step: StrategyStep }) {
  const info = s[step];
  const details = detailsChanged(project, s, info);
  const older = beforeResearch(s, step);
  if (!details && !older) return null;
  return (
    <div className="flex flex-col gap-1.5">
      {details && <Banner>Your details changed since this was written.</Banner>}
      {older && <Banner>Written before your latest research.</Banner>}
    </div>
  );
}

/** "Written 2h ago by … · Brain: …" and the paid Refresh button (after its confirm). */
export function SectionFooter({ project, s, step }: { project: Project; s: StrategyState; step: StrategyStep }) {
  const info = s[step];
  const job = useStrategyJob(project.id);
  if (!info) return null;
  return (
    <footer className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3 text-xs text-muted">
      <p className="min-w-0">
        Written {fmtRelative(info.at)} by {writtenBy(info)}
        {info.skills?.length ? ` · Brain applied: ${info.skills.join(', ')}` : ''}
        {info.note && info.provider !== 'local' ? <span className="block">{info.note}</span> : null}
      </p>
      <button type="button" className="btn btn-ghost btn-sm" disabled={!!job} onClick={() => void startRun(project.id, step === 'research' ? { kind: 'research' } : { kind: 'refresh', step })}>
        <RefreshCw size={14} /> {step === 'research' ? 'Search again' : 'Refresh this section'}
      </button>
    </footer>
  );
}

// ───────────── a plan action ─────────────

/** One step of the plan: done in the app (the app can see it), or "I did this"; and its "Do it" button. */
export function ActionRow({ project, s, action, ctx, tickable = true }: { project: Project; s: StrategyState; action: StrategyAction; ctx: ActionCtx; tickable?: boolean }) {
  const [open, setOpen] = useState(false);
  const done = actionDone(action, project, s, ctx);
  const t = actionTarget(action, project, s);
  const checkId = `tick-${action.id}`;
  return (
    <li className="rounded-md border border-line bg-surface px-3 py-2.5">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className={cn('text-[13.5px] font-semibold', done.done ? 'text-muted line-through decoration-line-2' : 'text-ink')}>{action.title}</p>
          {action.detail && (
            <>
              <button type="button" className="mt-0.5 inline-flex items-center gap-1 text-xs text-muted hover:text-ink" aria-expanded={open} onClick={() => setOpen(!open)}>
                <ChevronDown size={12} className={cn('transition-transform', open && 'rotate-180')} /> {open ? 'Less' : 'More'}
              </button>
              {open && <p className="mt-1 text-[13px] text-ink-2">{action.detail}</p>}
            </>
          )}
          <div className="mt-1.5">
            <Backing item={action} all={s.sources} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {t && !done.done && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void runTarget(t.target)}>
              {t.label}
            </button>
          )}
          {done.by === 'app' ? (
            <span className="inline-flex items-center gap-1 text-xs font-semibold text-good">
              <Check size={14} /> Done in the app
            </span>
          ) : tickable ? (
            <label htmlFor={checkId} className="inline-flex cursor-pointer items-center gap-1.5 text-xs font-medium text-ink-2">
              <input id={checkId} type="checkbox" className="h-4 w-4 accent-[rgb(var(--primary))]" checked={done.done} onChange={(e) => tickAction(project.id, action.id, e.target.checked)} />
              I did this
            </label>
          ) : null}
        </div>
      </div>
    </li>
  );
}

// ───────────── the page to build first ─────────────

/** Which page to build first, why, what it needs, whether it's built, and Build this page. */
export function PageCard({ project, s }: { project: Project; s: StrategyState }) {
  const rec = s.promote?.page ?? recommendPageType(project);
  const m = project.marketing;
  const need = missingLink(project, rec.pageType);
  const built = !!m.salesPage && (m.pageType ?? 'landing') === rec.pageType;
  return (
    <section className="panel flex flex-col gap-2.5 p-4" aria-label="The page to build first">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary">
          <Globe size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="section-title">Build this page first: {PAGE_TYPE_LABEL[rec.pageType]}</h3>
          <p className="text-[12.5px] text-muted">{PAGE_TYPE_DESC[rec.pageType]}</p>
        </div>
      </div>
      <p className="text-[13px] text-ink-2">{rec.why}</p>
      <Backing item={rec} all={s.sources} />
      {rec.secondType && (
        <p className="text-[13px] text-ink-2">
          Second choice: {PAGE_TYPE_LABEL[rec.secondType]} — {rec.secondWhy}
        </p>
      )}
      {need === 'booking' && <p className="text-[13px] text-ink-2">You’ll need your booking link (Calendly, Square, Acuity…). Without it, the page offers a “Request a time” form.</p>}
      {need === 'payment' && <p className="text-[13px] text-ink-2">You’ll need your own payment link (Stripe, Square, PayPal, Gumroad, Shopify…). The app never takes payments.</p>}
      {built && (
        <p className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-good">
          <Check size={14} /> Built: your SEO page is a {PAGE_TYPE_LABEL[rec.pageType].toLowerCase()}
          {m.seoPublished ? ' · Published' : ''}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <button type="button" className="btn btn-primary btn-sm" onClick={() => useUI.getState().openSeoBuilder({ pageType: rec.pageType })}>
          Build this page
        </button>
        <span className="text-xs text-muted">Opens the SEO page builder with this type chosen. Nothing is written until you press Write page.</span>
      </div>
    </section>
  );
}

// ───────────── where the link goes ─────────────

const SOURCE_WORDS = { domain: 'your domain', app: 'the app’s address', website: 'your website' } as const;

/** Where the page's link goes on each network (post, first comment or bio), and Use these link settings. */
export function LinksCard({ project, s }: { project: Project; s: StrategyState }) {
  const recs = s.promote?.links ?? {};
  const nets = [...new Set([...(Object.keys(recs) as PostPlatform[]), ...project.marketing.campaign.platforms])].filter((n) => n in PLATFORMS);
  const rows = nets.map((n) => ({ net: n, rec: recs[n] ?? defaultLinkPlacement(n) }));
  const link = pageLink(project);
  const bio = rows.filter((r) => r.rec.placement === 'bio').map((r) => netLabel(r.net));
  const applied = s.applied.links;
  return (
    <section id="strategy-links" className="panel flex scroll-mt-20 flex-col gap-3 p-4" aria-label="Where the link goes">
      <h3 className="section-title">Where the link goes</h3>
      <ul className="flex flex-col divide-y divide-line">
        {rows.map(({ net, rec }) => {
          const now = placementFor(project, net);
          return (
            <li key={net} className="flex items-start gap-3 py-2.5">
              <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-white" style={{ background: PLATFORMS[net].color }}>
                <PlatformGlyph platform={net} size={14} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[13.5px] font-semibold text-ink">
                  {netLabel(net)}: {LINK_PLACEMENT_LABEL[rec.placement]}
                  {now !== rec.placement && <span className="font-normal text-muted"> (now: {LINK_PLACEMENT_LABEL[now]})</span>}
                </p>
                <p className="text-[13px] text-ink-2">{rec.why}</p>
                <Backing item={rec} all={s.sources} className="mt-1" />
              </div>
            </li>
          );
        })}
      </ul>
      <div className="rounded-md bg-surface-2 px-3 py-2.5 text-[13px]">
        <span className="font-semibold text-ink">Your link: </span>
        {link ? (
          <span className="inline-flex flex-wrap items-center gap-2">
            <span className="break-all text-ink-2">{link.url}</span>
            <span className="text-muted">({SOURCE_WORDS[link.source]})</span>
            <CopyButton text={link.url} size="xs" />
          </span>
        ) : (
          <span className="text-ink-2">No page yet. Build and publish your page first; posts carry its link once it’s published.</span>
        )}
      </div>
      {bio.length > 0 && (
        <p className="flex flex-wrap items-center gap-2 text-[13px] text-ink-2">
          Put your link in your profile bio on {bio.join(', ')}. The app never changes your profile.
          {link && <CopyButton text={link.url} label="Copy link" size="xs" />}
        </p>
      )}
      {s.promote && (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void linksFlow(project.id)}>
            Use these link settings
          </button>
          {applied && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => undoLinksFlow(project.id)}>
              <Undo2 size={14} /> Undo
            </button>
          )}
          {applied && <span className="text-xs text-muted">Set {fmtRelative(applied.at)}.</span>}
        </div>
      )}
    </section>
  );
}

/** A small card heading with an optional note. */
export function CardTitle({ children, note }: { children: ReactNode; note?: ReactNode }) {
  return (
    <div className="mb-2">
      <h3 className="section-title">{children}</h3>
      {note && <p className="mt-0.5 text-[12.5px] text-muted">{note}</p>}
    </div>
  );
}
