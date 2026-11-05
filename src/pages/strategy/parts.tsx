// Pieces the Strategy tabs share: how a statement is backed (superscript source numbers, or an ⓘ when it's
// the AI's general knowledge or the app's built-in guidance), the sources list at a tab's end, who wrote a
// section and its Refresh button, the note when a section is out of date, a plan step with its check circle
// and its button, the page to build first and where its link goes, and the run buttons (each says when its
// run is checking your AI server first). Everything an AI or a web page wrote is rendered as plain text;
// links only after isHttpUrl.
import { useId, useMemo, type ComponentProps, type ReactNode } from 'react';
import { ArrowRight, Check, Undo2 } from 'lucide-react';
import type { Brand, PostPlatform, Project } from '@/lib/types';
import type { ActionKind, Backed, ResearchReason, StepInfo, StrategyAction, StrategySource, StrategyState, StrategyStep } from '@/lib/strategyTypes';
import { actionDone, isHttpUrl, strategyFactsHash, type ActionCtx } from '@/lib/strategy';
import { actionTarget, runTarget } from '@/lib/strategyActions';
import { tickAction } from '@/lib/strategyWrite';
import { recommendPageType, defaultLinkPlacement } from '@/ai/local/strategy';
import { PAGE_TYPE_LABEL, missingLink } from '@/lib/pageTypes';
import { LINK_PLACEMENT_LABEL, pageLink, placementFor } from '@/lib/pageLink';
import { useMediaUrl } from '@/lib/media';
import { cn, fmtDate, fmtRelative, stripProtocol } from '@/lib/utils';
import { PLATFORMS } from '@/ai/knowledge';
import { openPage } from '@/ai/assistant/nav';
import { useStore } from '@/store/useStore';
import { useUI } from '@/store/ui';
import { useStrategyJob } from '@/ai/strategyJob';
import { GenerateButton } from '@/components/ai/AI';
import { BrowserFrame } from '@/components/frames/Frames';
import { Badge, Callout, CopyButton, InfoTip, Section } from '@/components/ui/primitives';
import { cn as mergeCn } from '@/components/ui/shadcn/utils';
import { PlatformMark } from '@/components/posts/PlatformIcon';
import { linksFlow, undoLinksFlow } from './apply';
import { CHECKING_LABEL, runKey, startRun, useCheckingServer, type RunKind } from './runs';

/** The workspace things the "done in the app" checks read. */
export function useActionCtx(): ActionCtx {
  const posts = useStore((s) => s.posts);
  const ads = useStore((s) => s.ads);
  const myListings = useStore((s) => s.myListings);
  return useMemo(() => ({ posts, ads, myListings, now: Date.now() }), [posts, ads, myListings]);
}

export const netLabel = (n: string) => (n === 'x' ? 'X' : PLATFORMS[n as PostPlatform]?.label ?? n);

/**
 * A page Section that keeps the region name the page had (the Section primitive takes no aria-label yet: a
 * design-system follow-up). The name sits on a wrapper that takes the Section's place, spacing and id.
 */
export function NamedSection({ label, className, id, ...rest }: { label: string } & ComponentProps<typeof Section>) {
  return (
    <section aria-label={label} id={id} className={mergeCn('mt-10 first:mt-0', className)}>
      <Section {...rest} className="mt-0" />
    </section>
  );
}

// ───────────── Settings › AI keys ─────────────

/** Where keys and what they power are set, as the app names it. */
export const SETTINGS_AI = 'Settings › AI keys';
/** The AI layer's sentences still say "Settings → AI": they're shown (and linked) with the page's name. */
const SETTINGS_RX = /Settings (?:→|›) AI(?: keys)?/;

/** A link to Settings › AI keys. */
export function SettingsAILink({ children = SETTINGS_AI }: { children?: ReactNode }) {
  return (
    <button type="button" className="link" onClick={() => void openPage('workspace-settings', 'ai')}>
      {children}
    </button>
  );
}

/** Text with "Settings › AI keys" as a link (in the claude.ai build, which has no keys to set, as plain words). */
export function WithSettingsLink({ text }: { text: string }) {
  const m = SETTINGS_RX.exec(text);
  if (!m) return <>{text}</>;
  if (__ARTIFACT_BUILD__) return <>{text.replace(SETTINGS_RX, SETTINGS_AI)}</>;
  return (
    <>
      {text.slice(0, m.index)}
      <SettingsAILink />
      {text.slice(m.index + m[0].length)}
    </>
  );
}

// ───────────── how a statement is backed ─────────────

/** Superscript source numbers after a statement found on the web, each opening its page in a new tab. */
export function Cite({ item, all }: { item?: Pick<Backed, 'basis' | 'sources'>; all: StrategySource[] }) {
  if (!item || item.basis !== 'web') return null;
  const list = (item.sources ?? []).map((n) => all.find((x) => x.n === n)).filter((x): x is StrategySource => !!x && isHttpUrl(x.url));
  if (!list.length) return null;
  return (
    <sup className="ml-0.5 whitespace-nowrap text-micro">
      {list.map((x, i) => (
        <span key={x.n}>
          {i > 0 && (
            <span aria-hidden="true" className="text-muted">
              ,
            </span>
          )}
          <a href={x.url} target="_blank" rel="noopener noreferrer nofollow" className="num px-px font-medium text-primary hover:underline" title={`${x.title} · ${x.domain}`} aria-label={`Source ${x.n}: ${x.title}, ${x.domain} (opens in a new tab)`}>
            {x.n}
          </a>
        </span>
      ))}
    </sup>
  );
}

/**
 * An ⓘ for points that aren't from the web (spec: the "AI's general knowledge" and "Built-in guidance" chips
 * become this): all of them, or the ones without a source number when the list is mixed.
 */
export function BasisTip({ items }: { items: (Pick<Backed, 'basis' | 'sources'> | undefined)[] }) {
  const bases = new Set(items.filter((x): x is Pick<Backed, 'basis' | 'sources'> => !!x).map((x) => (x.basis === 'web' && !x.sources?.length ? 'ai' : x.basis)));
  const ai = bases.has('ai');
  const builtin = bases.has('builtin');
  if (!ai && !builtin) return null;
  const mixed = bases.has('web');
  const label = mixed ? 'About these sources' : ai ? 'Based on general knowledge' : 'Built-in guidance';
  const text = mixed
    ? 'Points without a source number are based on general knowledge, not a web source. They may be out of date or wrong for your area.'
    : ai && builtin
      ? 'Based on general knowledge and the app’s starter notes, not on a web source.'
      : ai
        ? 'Based on general knowledge, not a web source. It may be out of date or wrong for your area.'
        : 'Built-in guidance: the app’s general starter notes, not research.';
  return (
    <InfoTip label={label} title={mixed ? 'Sources' : label}>
      {text}
    </InfoTip>
  );
}

/** The sources a list of points cites, in number order. */
export function citedBy(items: (Backed | undefined)[]): number[] {
  return [...new Set(items.flatMap((x) => x?.sources ?? []))].sort((a, b) => a - b);
}

/** The sources a tab cites, at its end: number, title (opening the page), site, when it was found, the page's own date, and whether Manus read it. */
export function SourcesList({ ns, all, manusRead }: { ns?: number[]; all: StrategySource[]; manusRead?: Set<number> }) {
  const list = (ns ? all.filter((x) => ns.includes(x.n)) : all).filter((x) => isHttpUrl(x.url)).sort((a, b) => a.n - b.n);
  if (!list.length) return null;
  return (
    <section aria-label="Sources" className="mt-10 border-t border-line pt-4">
      <h2 className="flex items-center gap-1 text-caption font-medium text-muted">
        Sources
        <InfoTip label="About the sources">Links open the original pages. The app shows them as found and doesn’t vouch for them: pages change, so check them before you rely on them.</InfoTip>
      </h2>
      <SourceItems list={list} manusRead={manusRead} />
    </section>
  );
}

/** The list itself (also in the page's Sources window). */
export function SourceItems({ list, manusRead }: { list: StrategySource[]; manusRead?: Set<number> }) {
  return (
    <ol className="mt-1 flex flex-col gap-1">
      {list.map((x) => (
        <li key={x.n} className="flex gap-2 text-caption text-muted">
          <span className="num w-4 shrink-0 text-right font-mono text-ink-2">{x.n}</span>
          <span className="min-w-0 break-words">
            <a href={x.url} target="_blank" rel="noopener noreferrer nofollow" className="font-medium text-ink-2 hover:text-primary hover:underline">
              {x.title}
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
            {' · '}
            {x.domain}
            {x.at ? ` · found ${fmtDate(x.at, { month: 'short', day: 'numeric', year: 'numeric' })}` : ''}
            {x.pageAge ? ` · page date ${x.pageAge}` : ''}
            {x.via === 'manus' || manusRead?.has(x.n) ? ' · Manus read this page' : ''}
          </span>
        </li>
      ))}
    </ol>
  );
}

// ───────────── research reasons ─────────────

/** Why research has no web sources, with the provider's name (spec §2.3). */
export function reasonCopy(reason: ResearchReason, p = 'Your AI'): string {
  switch (reason) {
    case 'unsupported':
      return `${p} can’t search the web for Strategy, so these notes come from its general knowledge. For sources, tick Strategy for a key that can search (Anthropic, OpenAI, xAI, Meta or OpenRouter) in ${SETTINGS_AI}.`;
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

/** The note above a section that's out of date: your details changed since it was written, or newer research came in. */
export function StaleNote({ project, s, step, action, className }: { project: Project; s: StrategyState; step: StrategyStep; action?: ReactNode; className?: string }) {
  const info = s[step];
  const details = detailsChanged(project, s, info);
  const older = beforeResearch(s, step);
  if (!details && !older) return null;
  const what = step === 'plan' ? 'this plan was' : 'this was';
  const text = details && older ? `Your details changed and newer research came in since ${what} written.` : details ? `Your details changed since ${what} written.` : `${step === 'plan' ? 'This plan was' : 'This was'} written before your latest research.`;
  return (
    <Callout tone="warn" action={action} className={cn('mb-6', className)}>
      {text}
    </Callout>
  );
}

/**
 * A button that starts a paid run (after its confirm): disabled while a run goes, and saying "Checking your AI
 * server…" while the run it started waits on that check.
 */
export function RunButton({
  projectId,
  kind,
  children,
  variant = 'ai-outline',
  size = 'sm',
  className,
  runningLabel = 'Researching…',
  disabled,
}: {
  projectId: string;
  kind: RunKind;
  children: ReactNode;
  variant?: 'ai' | 'ai-outline' | 'ai-ghost' | 'secondary';
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  runningLabel?: string;
  /** e.g. while the app is still finding out which key powers Strategy */
  disabled?: boolean;
}) {
  const job = useStrategyJob(projectId);
  const checking = useCheckingServer(projectId);
  const mine = checking === runKey(kind);
  return (
    <GenerateButton variant={variant} size={size} className={className} running={mine} runningLabel={mine ? CHECKING_LABEL : runningLabel} disabled={disabled || !!job || !!checking} onClick={() => void startRun(projectId, kind)}>
      {children}
    </GenerateButton>
  );
}

/** "Written 2h ago" (who wrote it, and the Brain skills, in its ⓘ) and the paid Refresh button (after its confirm). */
export function SectionFooter({ project, s, step }: { project: Project; s: StrategyState; step: StrategyStep }) {
  const info = s[step];
  if (!info) return null;
  return (
    <footer className="mt-10 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-line pt-3">
      <div className="flex items-center gap-1 text-small text-muted">
        <span>Written {fmtRelative(info.at)}</span>
        <InfoTip label="Who wrote this" title="Who wrote this">
          <p>By {writtenBy(info)}.</p>
          {info.skills?.length ? <p className="mt-1">Brain skills applied: {info.skills.join(', ')}.</p> : null}
          {info.note && info.provider !== 'local' ? <p className="mt-1">{info.note}</p> : null}
        </InfoTip>
      </div>
      <RunButton projectId={project.id} kind={step === 'research' ? { kind: 'research' } : { kind: 'refresh', step }} variant="ai-ghost" className="-mr-3" runningLabel={step === 'research' ? 'Researching…' : 'Writing…'}>
        {step === 'research' ? 'Search again' : 'Refresh this section'}
      </RunButton>
    </footer>
  );
}

// ───────────── a plan step ─────────────

/** A 20px check circle: done is filled with a check, open is an empty ring. */
export function CheckCircle({ done, className }: { done: boolean; className?: string }) {
  return done ? (
    <span className={cn('flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary text-on-primary', className)} aria-hidden="true">
      <Check size={14} strokeWidth={3} />
    </span>
  ) : (
    <span className={cn('h-5 w-5 shrink-0 rounded-full border-[1.5px] border-line-3', className)} aria-hidden="true" />
  );
}

/** The kinds whose button leads to the AI writing something (the rest open a page). */
export const WRITES = new Set<ActionKind>(['write_post', 'build_page', 'plan_30', 'batch_7', 'lead_magnet', 'welcome_emails', 'ads']);

/** A step's "Do it": an AI-writing button for the steps that write, else a link to where it's done. */
function DoIt({ project, s, action }: { project: Project; s: StrategyState; action: StrategyAction }) {
  const t = actionTarget(action, project, s);
  if (!t) return null;
  return WRITES.has(action.kind) ? (
    <GenerateButton variant="ai-ghost" size="sm" onClick={() => void runTarget(t.target)}>
      {t.label}
    </GenerateButton>
  ) : (
    <button type="button" className="link inline-flex items-center gap-1 text-small" onClick={() => void runTarget(t.target)}>
      {t.label} <ArrowRight size={14} aria-hidden="true" />
    </button>
  );
}

/**
 * One step of the plan: its check circle (you tick it, unless the app can see it's done), the title and detail
 * with their sources, and its button. Done reads muted with "Done", never struck out.
 */
export function ActionRow({ project, s, action, ctx, tickable = true }: { project: Project; s: StrategyState; action: StrategyAction; ctx: ActionCtx; tickable?: boolean }) {
  const titleId = useId();
  const done = actionDone(action, project, s, ctx);
  const right = done.done ? <span className="text-small text-muted">{done.by === 'app' ? 'Done in the app' : 'Done'}</span> : <DoIt project={project} s={s} action={action} />;
  return (
    <li className="flex items-start gap-3 py-3">
      {done.by === 'app' || !tickable ? (
        <span className="mt-0.5 flex shrink-0">
          <CheckCircle done={done.done} />
          {done.done && <span className="sr-only">Done in the app: </span>}
        </span>
      ) : (
        <label className="relative mt-0.5 flex h-5 w-5 shrink-0 cursor-pointer">
          <input type="checkbox" className="absolute inset-0 m-0 h-5 w-5 cursor-pointer appearance-none rounded-full" checked={done.done} onChange={(e) => tickAction(project.id, action.id, e.target.checked)} aria-label="I did this" aria-describedby={titleId} />
          <CheckCircle done={done.done} className="pointer-events-none" />
        </label>
      )}
      <div className="min-w-0 flex-1">
        <p id={titleId} className={cn('text-ui', done.done ? 'text-muted' : 'text-ink')}>
          {action.title}
          <Cite item={action} all={s.sources} />
        </p>
        {action.detail && <p className="mt-0.5 text-small text-muted">{action.detail}</p>}
        <div className="mt-1.5 sm:hidden [&>.btn]:-ml-3">{right}</div>
      </div>
      <div className="shrink-0 max-sm:hidden [&>.btn]:-mr-3">{right}</div>
    </li>
  );
}

// ───────────── the page to build first ─────────────

/** A small browser window with the business's photo (or colours): what a page of theirs looks like. */
function PageThumb({ brand }: { brand: Brand }) {
  const photo = (brand.images ?? []).find((m) => m.kind === 'image') ?? null;
  const src = useMediaUrl(photo);
  const c = brand.colors;
  return (
    <div className="relative h-[90px] w-[120px] shrink-0" aria-hidden="true">
      <div className="absolute left-0 top-0 w-[240px] origin-top-left scale-50">
        <BrowserFrame>
          <div className="h-20 w-full bg-cover bg-center" style={{ backgroundImage: src ? `url("${src}")` : `linear-gradient(135deg, ${c.primary}, ${c.secondary})` }} />
          <div className="flex flex-col gap-2 p-3">
            <span className="h-2.5 w-3/4 rounded-full bg-surface-3" />
            <span className="h-2 w-1/2 rounded-full bg-surface-3" />
            <span className="mt-1 h-5 w-20 rounded" style={{ background: c.primary }} />
          </div>
        </BrowserFrame>
      </div>
    </div>
  );
}

/** Which page to build first, why, what it needs, whether it's built and published, and the button to it. */
export function PageCard({ project, s, className }: { project: Project; s: StrategyState; className?: string }) {
  const rec = s.promote?.page ?? recommendPageType(project);
  const m = project.marketing;
  const need = missingLink(project, rec.pageType);
  const built = !!m.salesPage && (m.pageType ?? 'landing') === rec.pageType;
  const published = built && !!m.seoPublished;
  const link = published ? pageLink(project) : null;
  return (
    <section aria-label="The page to build first" className={cn('card flex flex-col gap-4 p-5 sm:flex-row sm:gap-5', className)}>
      <PageThumb brand={project.brand} />
      <div className="min-w-0 flex-1">
        <p className="text-caption text-muted">Build this page first</p>
        <h2 className="mt-0.5 flex items-center gap-1 text-h2 text-ink">
          {PAGE_TYPE_LABEL[rec.pageType]}
          <BasisTip items={[rec]} />
        </h2>
        <p className="mt-1 text-body text-ink-2">
          {rec.why}
          <Cite item={rec} all={s.sources} />
        </p>
        {rec.secondType && (
          <p className="mt-1.5 text-small text-muted">
            Second choice: {PAGE_TYPE_LABEL[rec.secondType]}. {rec.secondWhy}
          </p>
        )}
        {need === 'booking' && <p className="mt-1.5 text-small text-muted">You’ll need your booking link (Calendly, Square, Acuity…). Without it, the page offers a “Request a time” form.</p>}
        {need === 'payment' && <p className="mt-1.5 text-small text-muted">You’ll need your own payment link (Stripe, Square, PayPal, Gumroad, Shopify…). The app never takes payments.</p>}
        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
          {built && (
            <Badge tone={published ? 'good' : 'neutral'} dot>
              {published ? 'Published' : 'Written, not published'}
            </Badge>
          )}
          {link && (
            <a href={link.url} target="_blank" rel="noopener noreferrer nofollow" className="link min-w-0 truncate text-small">
              {stripProtocol(link.url)}
            </a>
          )}
          {/* the SEO page builder with this type chosen, as before (on a built page, its type picker opens) */}
          <button type="button" className="btn btn-secondary btn-sm sm:ml-auto" onClick={() => void useUI.getState().openSeoBuilder({ pageType: rec.pageType })}>
            {built ? 'Open in SEO page' : 'Build this page'}
          </button>
        </div>
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
    <NamedSection
      label="Where the link goes"
      id="strategy-links"
      className="scroll-mt-16"
      title={
        <span className="inline-flex items-center gap-1">
          Where the link goes
          <BasisTip items={rows.map((r) => r.rec)} />
        </span>
      }
      description="On each network: in the post, its first comment, or your profile’s bio."
    >
      {rows.length > 0 && (
        <ul className="card divide-y divide-line">
          {rows.map(({ net, rec }) => {
            const now = placementFor(project, net);
            return (
              <li key={net} className="flex items-start gap-3 px-4 py-3">
                <PlatformMark platform={net} size={24} />
                <div className="min-w-0 flex-1">
                  <p className="text-ui text-ink">
                    {netLabel(net)}: {LINK_PLACEMENT_LABEL[rec.placement]}
                    {now !== rec.placement && <span className="text-small text-muted"> (now: {LINK_PLACEMENT_LABEL[now]})</span>}
                  </p>
                  <p className="mt-0.5 text-small text-muted">
                    {rec.why}
                    <Cite item={rec} all={s.sources} />
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <div className="well mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 text-small">
        <span className="font-medium text-ink">Your link</span>
        {link ? (
          <>
            <span className="min-w-0 break-all font-mono text-caption text-ink-2">{link.url}</span>
            <span className="text-muted">({SOURCE_WORDS[link.source]})</span>
            <CopyButton text={link.url} size="xs" className="ml-auto" />
          </>
        ) : (
          <span className="text-ink-2">No page yet. Build and publish your page first; posts carry its link once it’s published.</span>
        )}
      </div>
      {bio.length > 0 && <p className="mt-3 text-small text-ink-2">Put your link in your profile bio on {bio.join(', ')}. The app never changes your profile.</p>}
      {s.promote && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void linksFlow(project.id)}>
            Use these link settings
          </button>
          {applied && (
            <>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => undoLinksFlow(project.id)}>
                <Undo2 /> Undo
              </button>
              <span className="text-small text-muted">Set {fmtRelative(applied.at)}.</span>
            </>
          )}
        </div>
      )}
    </NamedSection>
  );
}
