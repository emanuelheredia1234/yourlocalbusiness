// The builds Manus and Viktor are doing for this page (Code & assets, or the SEO page): one card each, with what's
// happening and what the owner can do next. While a card is on screen it checks its build every few seconds; the
// app's watcher checks the rest. What the agent wrote is shown as plain text (it's untrusted: no links into the
// app, no HTML). Every follow-up that goes to the agent asks first, with who does it and what it costs.

import { useState } from 'react';
import { Bot, Check, ExternalLink, Eye, MessagesSquare, RefreshCw, Send, X } from 'lucide-react';
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
import { AutoTextarea, Spinner } from '@/components/ui/primitives';
import { openHtmlPreview } from './HtmlPreview';
import { openAgentBuild } from './buildWindow';

const ICON: Record<AgentId, typeof Bot> = { manus: Bot, viktor: MessagesSquare };
const NO_BUILDS: AgentBuild[] = [];

/** The cards of this page's builds (nothing when there are none, and nothing in the claude.ai build). */
export function AgentBuildList({ target, className }: { target: BuildTarget; className?: string }) {
  const project = useActiveProject();
  const all = project?.agentBuilds ?? NO_BUILDS;
  const builds = all.filter((b) => b.target === target);
  useBuildPolling(project?.id ?? '', builds);
  if (__ARTIFACT_BUILD__ || !project || !builds.length) return null;
  return (
    <section className={cn('panel overflow-hidden', className)} aria-label="Builds by Manus and Viktor">
      <h3 className="border-b border-line px-4 py-2.5 text-[13px] font-semibold">Built with Manus or Viktor ({builds.length})</h3>
      <ul className="divide-y divide-line">
        {builds.map((b) => (
          <BuildCard key={b.id} projectId={project.id} build={b} />
        ))}
      </ul>
    </section>
  );
}

const service = (via: AgentId) => (via === 'manus' ? 'Manus' : 'Slack');

/** One build: what's happening and what can be done. */
export function BuildCard({ projectId, build: b }: { projectId: string; build: AgentBuild }) {
  const name = agentName(b.via);
  const Icon = ICON[b.via];
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
      <ExternalLink size={12} /> Open in {service(b.via)}
    </a>
  ) : null;
  const dismiss = (
    <button type="button" className="btn btn-ghost btn-xs text-muted" disabled={!!busy} onClick={() => dismissBuild(projectId, b.id)} title="Take it off this list (nothing is sent)">
      <X size={12} /> Dismiss
    </button>
  );
  const changes = b.taskId || b.threadId ? (
    <button type="button" className="btn btn-secondary btn-xs" disabled={!!busy} aria-expanded={box === 'edit'} onClick={() => setBox(box === 'edit' ? null : 'edit')}>
      Ask for changes
    </button>
  ) : null;

  let status: React.ReactNode;
  let actions: React.ReactNode;
  switch (b.state) {
    case 'sending':
      status = (
        <span className="flex items-center gap-1.5">
          <Spinner size={12} /> Sending to {name}…
        </span>
      );
      break;
    case 'unknown_start':
      status = b.message || `May have been delivered. Checking ${service(b.via)}…`;
      actions = (
        <>
          <button type="button" className="btn btn-secondary btn-xs" disabled={!!busy} onClick={() => void check()}>
            {busy === 'check' ? <Spinner size={12} /> : <RefreshCw size={12} />} Check now
          </button>
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
        <span className="flex items-center gap-1.5">
          <Spinner size={12} /> {b.message || `${name} is working`}
        </span>
      );
      actions = (
        <>
          {openLink}
          <button type="button" className="btn btn-secondary btn-xs" disabled={!!busy} onClick={() => void check()}>
            {busy === 'check' ? <Spinner size={12} /> : <RefreshCw size={12} />} Check now
          </button>
          <button type="button" className="btn btn-ghost btn-xs" disabled={!!busy} onClick={() => void stop()} title={b.via === 'manus' ? 'Stop the Manus task' : 'Stop checking (nothing is sent to Slack)'}>
            {b.via === 'manus' ? 'Stop' : 'Stop waiting'}
          </button>
        </>
      );
      break;
    case 'needs_you':
      status = b.message || `${name} is waiting for you`;
      actions = (
        <>
          <button type="button" className="btn btn-secondary btn-xs" disabled={!!busy} aria-expanded={box === 'answer'} onClick={() => setBox(box === 'answer' ? null : 'answer')}>
            Answer
          </button>
          <button type="button" className="btn btn-secondary btn-xs" disabled={!!busy} onClick={() => void follow({ kind: 'missing_file' })}>
            Ask for the page as one file
          </button>
          {b.result && (
            <button type="button" className="btn btn-ghost btn-xs" disabled={!!busy} onClick={preview}>
              {busy === 'page' ? <Spinner size={12} /> : <Eye size={12} />} Preview the last page
            </button>
          )}
          {openLink}
          <button type="button" className="btn btn-ghost btn-xs" disabled={!!busy} onClick={() => void stop()}>
            {b.via === 'manus' ? 'Stop' : 'Stop waiting'}
          </button>
        </>
      );
      break;
    case 'built':
      status = (
        <span className="text-good">
          {name} built your {what}
          {b.via === 'manus' && b.credits ? ` · used ${b.credits.toLocaleString('en-US')} Manus credits` : ''}
        </span>
      );
      actions = (
        <>
          <button type="button" className="btn btn-secondary btn-xs" disabled={!!busy} onClick={preview}>
            {busy === 'page' ? <Spinner size={12} /> : <Eye size={12} />} Preview
          </button>
          {earlier ? (
            <>
              <button type="button" className="btn btn-primary btn-xs" disabled={!!busy} onClick={() => use(earlier.id)}>
                {busy === 'use' ? <Spinner size={12} /> : <Check size={12} />} Update “{earlier.name}”
              </button>
              <button type="button" className="btn btn-secondary btn-xs" disabled={!!busy} onClick={() => use()}>
                Add as a new asset
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-primary btn-xs" disabled={!!busy} onClick={() => use()}>
              {busy === 'use' ? <Spinner size={12} /> : <Check size={12} />} {b.target === 'seo' ? 'Use as my SEO page' : 'Use this'}
            </button>
          )}
          {changes}
          {dismiss}
        </>
      );
      break;
    case 'imported': {
      const asset = b.imported?.assetId ? findCodeAsset(projectId, b.imported.assetId) : undefined;
      status = b.imported?.seo ? 'Used as your SEO page' : asset ? `Used as “${asset.name}”` : 'Used';
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
          {dismiss}
        </>
      );
      break;
    }
    case 'failed':
      status = <span className="text-bad">{b.message || `${name} couldn’t build it.`}</span>;
      actions = (
        <>
          {openLink}
          <button type="button" className="btn btn-secondary btn-xs" onClick={() => void openAgentBuild({ target: b.target, via: b.via, from: b })}>
            Try again
          </button>
          {dismiss}
        </>
      );
      break;
    case 'stopped':
      status = 'Stopped';
      actions = (
        <>
          <button type="button" className="btn btn-secondary btn-xs" disabled={!!busy} onClick={() => void check()}>
            {busy === 'check' ? <Spinner size={12} /> : <RefreshCw size={12} />} Check again
          </button>
          {openLink}
          {dismiss}
        </>
      );
      break;
  }

  return (
    <li className="px-4 py-3">
      <p className="flex flex-wrap items-center gap-x-1.5 text-[12px] font-semibold text-ink-2">
        <Icon size={13} className="text-muted" aria-hidden="true" />
        {name} · {what} · <span className="font-normal text-muted">{fmtRelative(b.lastSentAt)}</span>
      </p>
      <div className="mt-1 text-[13px] text-ink" role="status">
        {status}
      </div>
      {b.state === 'needs_you' && b.said && (
        <blockquote className="mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-md border-l-2 border-line-2 bg-surface-2 px-2.5 py-1.5 text-xs text-ink-2 scroll-thin" aria-label={`What ${name} said`}>
          {b.said}
        </blockquote>
      )}
      {actions && <div className="mt-2 flex flex-wrap items-center gap-1.5">{actions}</div>}
      {box === 'answer' && <AnswerBox via={b.via} busy={busy === 'send'} onCancel={() => setBox(null)} onSend={async (text) => (await follow({ kind: 'answer', text })) && setBox(null)} />}
      {box === 'edit' && <ChangesBox build={b} busy={busy === 'send'} onCancel={() => setBox(null)} onSend={async (text, images) => (await follow({ kind: 'edit', text, images })) && setBox(null)} />}
    </li>
  );
}

function Counter({ n, max }: { n: number; max: number }) {
  return <span className={cn('num text-[11px]', n > max ? 'text-bad' : 'text-muted')}>{`${n.toLocaleString('en-US')} / ${max.toLocaleString('en-US')}`}</span>;
}

/** Answer the agent's question in the owner's own words. */
function AnswerBox({ via, busy, onSend, onCancel }: { via: AgentId; busy: boolean; onSend: (text: string) => Promise<unknown>; onCancel: () => void }) {
  const [text, setText] = useState('');
  const max = REQUEST_MAX[via];
  const n = text.trim().length;
  return (
    <div className="mt-2 flex flex-col gap-1.5 rounded-md border border-line bg-surface p-2.5">
      <label className="text-xs font-semibold text-ink-2">Your answer to {agentName(via)}</label>
      <AutoTextarea value={text} onChange={setText} minRows={2} className="text-[13px]" placeholder="Your words, sent as you write them." />
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-primary btn-xs" disabled={busy || !n || n > max} onClick={() => void onSend(text)}>
          {busy ? <Spinner size={12} /> : <Send size={12} />} Send
        </button>
        <button type="button" className="btn btn-ghost btn-xs" onClick={onCancel}>
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
    <div className="mt-2 flex flex-col gap-1.5 rounded-md border border-line bg-surface p-2.5">
      <label className="text-xs font-semibold text-ink-2">What should {agentName(b.via)} change?</label>
      <AutoTextarea value={text} onChange={setText} minRows={2} className="text-[13px]" placeholder="For example: make the headline shorter and use a dark background." {...paste} />
      <PromptImages images={images} onChange={setImages} reserved={reserved} busy={adding} disabled={busy} label="New images (optional)" hint="They’re numbered after the images already sent." />
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-primary btn-xs" disabled={busy || adding || !n || n > max} onClick={() => void onSend(text, images)}>
          {busy ? <Spinner size={12} /> : <Send size={12} />} Send
        </button>
        <button type="button" className="btn btn-ghost btn-xs" onClick={onCancel}>
          Cancel
        </button>
        <Counter n={n} max={max} />
      </div>
    </div>
  );
}
