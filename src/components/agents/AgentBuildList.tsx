// The builds Manus and Viktor are doing for this page (Code & assets, or the SEO page): one compact row each, with
// the agent, what it builds and when, a status dot with what's happening, and what the owner can do next (the rest
// in ⋯). While a row is on screen it checks its build every few seconds; the app's watcher checks the rest. What
// the agent wrote is shown as plain text (it's untrusted: no links into the app, no HTML). Every follow-up that
// goes to the agent asks first, with who does it and what it costs.

import { useState, type ReactNode } from 'react';
import { Check, ExternalLink, Eye, RefreshCw, Send, X } from 'lucide-react';
import type { AgentBuild, AgentId, BuildTarget } from '@/lib/agentTypes';
import type { MediaRef, PromptImage } from '@/lib/types';
import { cn, fmtRelative } from '@/lib/utils';
import { MAX_PROMPT_IMAGES, planPromptImages, reportRefusals } from '@/lib/promptImages';
import { deleteBlob } from '@/lib/storage';
import { findCodeAsset } from '@/lib/codeAssets';
import { REQUEST_MAX, agentLink, buildResultHtml, buildSource, checkNow, dismissBuild, kindLabel, markNotStarted, pageErrorText, sendFollowup, stopBuild, useBuildPolling, type Followup } from '@/ai/agents/builds';
import { applyAgentPage, showAgentAsset, showAgentSeoPage } from '@/ai/agents/results';
import { agentName } from '@/ai/agents/who';
import { useActiveProject } from '@/store/useStore';
import { toast } from '@/store/ui';
import { PromptImages, usePasteImages } from '@/components/ai/PromptImages';
import { AutoTextarea, MoreMenu, Spinner, type MenuEntry } from '@/components/ui/primitives';
import { openHtmlPreview } from './HtmlPreview';
import { openAgentBuild } from './buildWindow';
import { AgentAvatar } from './AgentButtons';

const NO_BUILDS: AgentBuild[] = [];

/** The rows of this page's builds (nothing when there are none, and nothing in the claude.ai build). */
export function AgentBuildList({ target, className }: { target: BuildTarget; className?: string }) {
  const project = useActiveProject();
  const all = project?.agentBuilds ?? NO_BUILDS;
  const builds = all.filter((b) => b.target === target);
  useBuildPolling(project?.id ?? '', builds);
  if (__ARTIFACT_BUILD__ || !project || !builds.length) return null;
  return (
    <section className={className} aria-label="Builds by Manus and Viktor">
      <h3 className="flex items-baseline gap-2 text-h4 text-ink">
        Built with Manus or Viktor <span className="num font-mono text-caption font-normal text-muted">{builds.length}</span>
      </h3>
      <ul className="mt-1 divide-y divide-line">
        {builds.map((b) => (
          <BuildCard key={b.id} projectId={project.id} build={b} />
        ))}
      </ul>
    </section>
  );
}

const service = (via: AgentId) => (via === 'manus' ? 'Manus' : 'Slack');

type Tone = 'good' | 'warn' | 'bad' | 'primary' | 'faint';
const DOT: Record<Tone, string> = { good: 'bg-good-solid', warn: 'bg-warn-solid', bad: 'bg-bad-solid', primary: 'bg-primary', faint: 'bg-faint' };

/** A status dot and its words (like StatusDot, but the words wrap: an agent's message can be long). */
function StateLine({ tone, pulse, children }: { tone: Tone; pulse?: boolean; children: ReactNode }) {
  return (
    <span className="flex items-start gap-1.5 text-small text-ink-2">
      <span className={cn('mt-[7px] h-[7px] w-[7px] shrink-0 rounded-full', DOT[tone], pulse && 'animate-pulse-dot')} aria-hidden="true" />
      <span className="min-w-0">{children}</span>
    </span>
  );
}

/** One build: what's happening and what can be done. */
export function BuildCard({ projectId, build: b }: { projectId: string; build: AgentBuild }) {
  const name = agentName(b.via);
  const link = agentLink(b);
  const what = kindLabel(b.target, b.kind);
  const [box, setBox] = useState<null | 'answer' | 'edit'>(null);
  const [busy, setBusy] = useState<null | 'page' | 'use' | 'send' | 'check' | 'stop'>(null);
  const earlier = b.target === 'asset' && b.imported?.assetId ? findCodeAsset(projectId, b.imported.assetId) : undefined;

  const withPage = async (run: (src: ReturnType<typeof buildSource>) => Promise<void> | void, kind: 'page' | 'use') => {
    if (busy) return;
    setBusy(kind);
    try {
      const h = await buildResultHtml(projectId, b.id);
      await run(buildSource(b, h));
    } catch (e) {
      toast({ kind: 'error', title: 'Couldn’t get the page', body: pageErrorText(e, b.via) });
    } finally {
      setBusy(null);
    }
  };
  const preview = () => void withPage((src) => openHtmlPreview({ title: `${name}’s ${what}`, target: b.target, src }), 'page');
  const use = (replaceAssetId?: string) =>
    void withPage(async (src) => {
      const r = await applyAgentPage(projectId, b.target, src, { ...(replaceAssetId ? { replaceAssetId } : {}), resultAt: b.result?.at });
      if (!r.ok) toast({ kind: 'error', title: 'Couldn’t use this page', body: r.message });
    }, 'use');
  const follow = async (f: Followup): Promise<boolean> => {
    setBusy('send');
    try {
      const r = await sendFollowup(projectId, b.id, f);
      if (r.outcome === 'sent') toast({ kind: 'success', title: `Sent to ${name}`, body: 'The app checks for the page.' });
      if (r.outcome === 'unknown') toast({ kind: 'info', title: 'May have been delivered', body: `The app checks ${b.via === 'manus' ? 'your Manus task' : 'Slack'} by itself.` });
      if (r.outcome === 'failed' || r.outcome === 'refused') toast({ kind: 'error', title: r.error.title, body: r.error.body });
      return r.outcome === 'sent' || r.outcome === 'unknown';
    } finally {
      setBusy(null);
    }
  };
  const check = async () => {
    setBusy('check');
    try {
      await checkNow(projectId, b.id);
    } finally {
      setBusy(null);
    }
  };
  const stop = async () => {
    setBusy('stop');
    try {
      await stopBuild(projectId, b.id);
    } finally {
      setBusy(null);
    }
  };

  const openLink = link ? (
    <a href={link} target="_blank" rel="noopener noreferrer" className="btn btn-ghost btn-xs">
      <ExternalLink aria-hidden="true" /> Open in {service(b.via)}
    </a>
  ) : null;
  // taking a build off the list sends nothing: an icon with its name, at the end of the row
  const dismiss = (
    <button type="button" className="btn btn-ghost btn-icon btn-xs text-muted" disabled={!!busy} onClick={() => dismissBuild(projectId, b.id)} aria-label="Dismiss" title="Take it off this list (nothing is sent)">
      <X />
    </button>
  );
  const changes = b.taskId || b.threadId ? (
    <button type="button" className="btn btn-ghost btn-xs" disabled={!!busy} aria-expanded={box === 'edit'} onClick={() => setBox(box === 'edit' ? null : 'edit')}>
      Ask for changes
    </button>
  ) : null;
  const checkButton = (label: string) => (
    <button type="button" className="btn btn-ghost btn-xs" disabled={!!busy} onClick={() => void check()}>
      {busy === 'check' ? <Spinner /> : <RefreshCw aria-hidden="true" />} {label}
    </button>
  );
  const linkEntry: MenuEntry[] = link ? [{ label: `Open in ${service(b.via)}`, icon: <ExternalLink />, onSelect: () => window.open(link, '_blank', 'noopener,noreferrer') }] : [];

  let status: ReactNode;
  let actions: ReactNode;
  // what doesn't fit in the row (at most 3 buttons) goes in ⋯
  let more: MenuEntry[] = [];
  switch (b.state) {
    case 'sending':
      status = (
        <StateLine tone="primary" pulse>
          Sending to {name}…
        </StateLine>
      );
      break;
    case 'unknown_start':
      status = <StateLine tone="warn">{b.message || `May have been delivered. Checking ${service(b.via)}…`}</StateLine>;
      actions = (
        <>
          {checkButton('Check now')}
          {openLink}
          {b.via === 'manus' && b.rounds === 1 && (
            <button type="button" className="btn btn-ghost btn-xs" disabled={!!busy} onClick={() => markNotStarted(projectId, b.id)}>
              I checked: it didn’t start
            </button>
          )}
        </>
      );
      break;
    case 'working':
      status = (
        <StateLine tone="primary" pulse>
          {b.message || `${name} is working`}
        </StateLine>
      );
      actions = (
        <>
          {openLink}
          {checkButton('Check now')}
          <button type="button" className="btn btn-ghost btn-xs" disabled={!!busy} onClick={() => void stop()} title={b.via === 'manus' ? 'Stop the Manus task' : 'Stop checking (nothing is sent to Slack)'}>
            {b.via === 'manus' ? 'Stop' : 'Stop waiting'}
          </button>
        </>
      );
      break;
    case 'needs_you':
      status = <StateLine tone="warn">{b.message || `${name} is waiting for you`}</StateLine>;
      actions = (
        <>
          <button type="button" className="btn btn-secondary btn-xs" disabled={!!busy} aria-expanded={box === 'answer'} onClick={() => setBox(box === 'answer' ? null : 'answer')}>
            Answer
          </button>
          <button type="button" className="btn btn-ghost btn-xs" disabled={!!busy} onClick={() => void follow({ kind: 'missing_file' })}>
            Ask for the page as one file
          </button>
        </>
      );
      more = [
        ...(b.result ? [{ label: 'Preview the last page', icon: <Eye />, onSelect: preview }] : []),
        ...linkEntry,
        { label: b.via === 'manus' ? 'Stop' : 'Stop waiting', icon: <X />, onSelect: () => void stop() },
      ];
      break;
    case 'built':
      status = (
        <StateLine tone="good">
          {name} built your {what}
          {b.via === 'manus' && b.credits ? <span className="text-muted">{` · used ${b.credits.toLocaleString('en-US')} Manus credits`}</span> : ''}
        </StateLine>
      );
      actions = (
        <>
          <button type="button" className="btn btn-ghost btn-xs" disabled={!!busy} onClick={preview}>
            {busy === 'page' ? <Spinner /> : <Eye aria-hidden="true" />} Preview
          </button>
          {earlier ? (
            <button type="button" className="btn btn-secondary btn-xs" disabled={!!busy} onClick={() => use(earlier.id)}>
              {busy === 'use' ? <Spinner /> : <Check aria-hidden="true" />} Update “{earlier.name}”
            </button>
          ) : (
            <button type="button" className="btn btn-secondary btn-xs" disabled={!!busy} onClick={() => use()}>
              {busy === 'use' ? <Spinner /> : <Check aria-hidden="true" />} {b.target === 'seo' ? 'Use as my SEO page' : 'Use this'}
            </button>
          )}
          {changes}
        </>
      );
      if (earlier) more = [{ label: 'Add as a new asset', onSelect: () => use() }];
      break;
    case 'imported': {
      const asset = b.imported?.assetId ? findCodeAsset(projectId, b.imported.assetId) : undefined;
      status = <StateLine tone="good">{b.imported?.seo ? 'Used as your SEO page' : asset ? `Used as “${asset.name}”` : 'Used'}</StateLine>;
      actions = (
        <>
          {asset && (
            <button type="button" className="btn btn-ghost btn-xs" onClick={() => void showAgentAsset(asset.id)}>
              Open it
            </button>
          )}
          {b.imported?.seo && (
            <button type="button" className="btn btn-ghost btn-xs" onClick={() => void showAgentSeoPage()}>
              Open it
            </button>
          )}
          {changes}
        </>
      );
      break;
    }
    case 'failed':
      status = <StateLine tone="bad">{b.message || `${name} couldn’t build it.`}</StateLine>;
      actions = (
        <>
          {openLink}
          <button type="button" className="btn btn-secondary btn-xs" onClick={() => void openAgentBuild({ target: b.target, via: b.via, from: b })}>
            Try again
          </button>
        </>
      );
      break;
    case 'stopped':
      status = <StateLine tone="faint">Stopped</StateLine>;
      actions = (
        <>
          {checkButton('Check again')}
          {openLink}
        </>
      );
      break;
  }
  const dismissible = b.state === 'built' || b.state === 'imported' || b.state === 'failed' || b.state === 'stopped';

  return (
    <li className="py-3">
      <div className="flex flex-col gap-2 md:flex-row md:items-start md:gap-4">
        <div className="flex min-w-0 flex-1 items-start gap-2.5">
          <AgentAvatar via={b.via} size={20} className="mt-px" />
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-small text-muted">
              <span className="font-medium text-ink">{name}</span> · {what} · <span className="num">{fmtRelative(b.lastSentAt)}</span>
            </p>
            <div role="status">{status}</div>
          </div>
        </div>
        {(actions || more.length > 0 || dismissible) && (
          <div className="flex shrink-0 flex-wrap items-center gap-1 pl-[30px] md:pl-0">
            {actions}
            {more.length > 0 && <MoreMenu items={more} size="xs" label={`More for ${name}’s ${what}`} />}
            {dismissible && dismiss}
          </div>
        )}
      </div>
      {b.state === 'needs_you' && b.said && (
        <blockquote className="well scroll-thin ml-[30px] mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap break-words px-3 py-2 text-small text-ink-2" aria-label={`What ${name} said`}>
          {b.said}
        </blockquote>
      )}
      {box === 'answer' && <AnswerBox via={b.via} busy={busy === 'send'} onCancel={() => setBox(null)} onSend={async (text) => (await follow({ kind: 'answer', text })) && setBox(null)} />}
      {box === 'edit' && <ChangesBox build={b} busy={busy === 'send'} onCancel={() => setBox(null)} onSend={async (text, images) => (await follow({ kind: 'edit', text, images })) && setBox(null)} />}
    </li>
  );
}

function Counter({ n, max }: { n: number; max: number }) {
  return <span className={cn('num ml-auto font-mono text-caption', n > max ? 'text-bad' : 'text-muted')}>{`${n.toLocaleString('en-US')} / ${max.toLocaleString('en-US')}`}</span>;
}

/** Answer the agent's question in the owner's own words. */
function AnswerBox({ via, busy, onSend, onCancel }: { via: AgentId; busy: boolean; onSend: (text: string) => Promise<unknown>; onCancel: () => void }) {
  const [text, setText] = useState('');
  const max = REQUEST_MAX[via];
  const n = text.trim().length;
  return (
    <div className="well ml-[30px] mt-2 flex flex-col gap-2 p-3">
      <label className="text-small font-medium text-ink-2">Your answer to {agentName(via)}</label>
      <AutoTextarea value={text} onChange={setText} minRows={2} placeholder="Your words, sent as you write them." />
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-primary btn-xs" disabled={busy || !n || n > max} onClick={() => void onSend(text)}>
          {busy ? <Spinner /> : <Send aria-hidden="true" />} Send
        </button>
        <button type="button" className="btn btn-secondary btn-xs" onClick={onCancel}>
          Cancel
        </button>
        <Counter n={n} max={max} />
      </div>
    </div>
  );
}

/** Ask for changes: the owner's words, and new images numbered after the ones the build already has. */
function ChangesBox({ build: b, busy, onSend, onCancel }: { build: AgentBuild; busy: boolean; onSend: (text: string, images: PromptImage[]) => Promise<unknown>; onCancel: () => void }) {
  const [text, setText] = useState('');
  const [images, setImages] = useState<PromptImage[]>([]);
  const [adding, setAdding] = useState(false);
  const max = REQUEST_MAX[b.via];
  const n = text.trim().length;
  const reserved = b.images.map((i) => i.key);
  const room = Math.max(0, MAX_PROMPT_IMAGES - images.length);
  const paste = usePasteImages(
    (media: MediaRef[]) => {
      setImages((cur) => {
        const plan = planPromptImages(cur, media, { reserved });
        reportRefusals(plan.refused);
        for (const m of media) if (!plan.added.some((a) => a.media.id === m.id)) void deleteBlob(m.id);
        return plan.images;
      });
    },
    { room, disabled: busy, onBusy: setAdding },
  );
  return (
    <div className="well ml-[30px] mt-2 flex flex-col gap-2 p-3">
      <label className="text-small font-medium text-ink-2">What should {agentName(b.via)} change?</label>
      <AutoTextarea value={text} onChange={setText} minRows={2} placeholder="For example: make the headline shorter and use a dark background." {...paste} />
      <PromptImages images={images} onChange={setImages} reserved={reserved} busy={adding} disabled={busy} label="New images (optional)" hint="They’re numbered after the images already sent." />
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-primary btn-xs" disabled={busy || adding || !n || n > max} onClick={() => void onSend(text, images)}>
          {busy ? <Spinner /> : <Send aria-hidden="true" />} Send
        </button>
        <button type="button" className="btn btn-secondary btn-xs" onClick={onCancel}>
          Cancel
        </button>
        <Counter n={n} max={max} />
      </div>
    </div>
  );
}
