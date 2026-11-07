// The build window: what Manus or Viktor should build (an asset, or the SEO page), the owner's website as a style
// reference, their own words and images, and the facts they may use; then a confirm that says who does the work
// and what it costs, with the exact message the server will send ("Show the exact message", a dry run). Sending is
// one click and one request: never retried. The fields are kept per project and target while the app is open.

import { useEffect, useId, useMemo, useState } from 'react';
import { CircleAlert, Globe, Send } from 'lucide-react';
import type { AgentId, AgentPreview, BuildFactId, BuildTarget } from '@/lib/agentTypes';
import type { MediaRef, PageType, Project } from '@/lib/types';
import { cn, plural } from '@/lib/utils';
import { CODE_KINDS } from '@/ai/local/code';
import { PAGE_TYPES, missingLink, webLink } from '@/lib/pageTypes';
import { isValidDomain } from '@/lib/publish';
import { MAX_PROMPT_IMAGES, planPromptImages, reportRefusals } from '@/lib/promptImages';
import { deleteBlob } from '@/lib/storage';
import { useRuntime } from '@/lib/platform';
import { buildFacts, chosenFacts } from '@/ai/agents/facts';
import { EMAIL_KIND_LABEL, REQUEST_MAX, buildRequestOf, kindNoun, startBuild } from '@/ai/agents/builds';
import { LEAD_MAGNET_TYPES } from '@/ai/local/email';
import { agentErrorText, manusPreview, newRef, viktorPreview } from '@/ai/agents/api';
import { MANUS_PROFILES, agentCost, agentName, agentPlace, agentWho, useAgentReady } from '@/ai/agents/who';
import { openPage } from '@/ai/assistant/nav';
import { useStore } from '@/store/useStore';
import { toast } from '@/store/ui';
import { PromptImages, usePasteImages } from '@/components/ai/PromptImages';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger, AutoTextarea, Callout, Checkbox, Field, Modal, OptionCards, Spinner } from '@/components/ui/primitives';
import { PageTypeLinks, PageTypePicker } from '@/pages/marketing/PageTypePicker';
import { closeAgentBuild, setWindowFields, useAgentBuildWindow, windowKey, type BuildWindowFields } from './buildWindow';
import { AgentAvatar } from './AgentButtons';

const AGENTS: AgentId[] = ['manus', 'viktor'];

/** The owner's website as a style reference: an https address with a real public host ('' for none). */
export function checkWebsite(raw: string): { url: string; error: string } {
  const t = raw.trim();
  if (!t) return { url: '', error: '' };
  const bad = { url: '', error: 'Use your website’s https address, like https://example.com' };
  if (t.length > 300 || /[\s<>|"]/.test(t)) return bad;
  const w = webLink(t);
  if (!w) return bad;
  let u: URL;
  try {
    u = new URL(w);
  } catch {
    return bad;
  }
  if (u.protocol !== 'https:' || !isValidDomain(u.hostname) || u.hostname.endsWith('.local')) return bad;
  return { url: w, error: '' };
}

/** The window (mounted once, in App): open while useAgentBuildWindow says so. */
export function AgentBuildHost() {
  const open = useAgentBuildWindow((s) => s.open);
  if (!open || __ARTIFACT_BUILD__) return null;
  return <AgentBuildWindow key={windowKey(open.projectId, open.target, open.stepId)} projectId={open.projectId} target={open.target} stepId={open.stepId} />;
}

export function AgentBuildWindow({ projectId, target, stepId }: { projectId: string; target: BuildTarget; stepId?: string }) {
  const project = useStore((s) => s.projects.find((p) => p.id === projectId));
  const fields = useAgentBuildWindow((s) => s.fields[windowKey(projectId, target, stepId)]);
  const [step, setStep] = useState<1 | 2>(1);
  if (!project || !fields) return null;
  return step === 1 ? <BuildForm project={project} target={target} f={fields} onNext={() => setStep(2)} /> : <BuildConfirm project={project} target={target} f={fields} stepId={stepId} onBack={() => setStep(1)} />;
}

/** The kinds the window offers: Code & assets' (business-only ones for a business), the six page types, the email kinds or the lead magnet types. */
function kindOptions(p: Project, target: BuildTarget): string[] {
  if (target === 'email') return Object.keys(EMAIL_KIND_LABEL);
  if (target === 'leadMagnet') return LEAD_MAGNET_TYPES.map((t) => t.id);
  return target === 'asset' ? CODE_KINDS.filter((k) => !k.business || p.track === 'business').map((k) => k.id) : PAGE_TYPES;
}

/** The window's title for each target. */
export const BUILD_TITLE: Record<BuildTarget, string> = {
  asset: 'Build an asset with Manus or Viktor',
  seo: 'Build your SEO page with Manus or Viktor',
  email: 'Design an email with Manus or Viktor',
  leadMagnet: 'Make your lead magnet with Manus or Viktor',
};
const PLACEHOLDER: Record<BuildTarget, string> = {
  asset: 'For example: a booking widget for my yoga classes, with my three class types and a short note about what to bring.',
  seo: 'For example: a calm, friendly page for first-time customers. Show my three services with photos.',
  email: 'For example: a warm, simple email in my brand colours with one big button.',
  leadMagnet: 'For example: a one-page checklist for first-time home bakers, with 5 sections and a tip in each.',
};

/** Why step 1 can't go on yet ('' when it can). */
export function stepOneProblem(p: Project, target: BuildTarget, f: BuildWindowFields, ready: boolean): string {
  if (!ready) return '';
  if (!kindOptions(p, target).includes(f.kind)) return target === 'seo' ? 'Choose the kind of page.' : 'Choose what to build.';
  if (target === 'seo' && missingLink(p, f.kind as PageType) === 'payment') return 'Add your payment link first. The app never takes payments: Buy now opens your own link.';
  if (checkWebsite(f.website).error) return checkWebsite(f.website).error;
  if (f.request.trim().length > REQUEST_MAX[f.via]) return `Your words are too long for ${agentName(f.via)}: at most ${REQUEST_MAX[f.via].toLocaleString('en-US')} characters.`;
  return '';
}

/** Step 1: what to build, the website, the owner's words and images, the facts that go, the agent's options. */
export function BuildForm({ project, target, f, onNext }: { project: Project; target: BuildTarget; f: BuildWindowFields; onNext: () => void }) {
  const ids = useId();
  const ready = { manus: useAgentReady('manus', 'build'), viktor: useAgentReady('viktor', 'build') };
  const r = ready[f.via];
  const [websiteError, setWebsiteError] = useState('');
  const [adding, setAdding] = useState(false);
  const facts = useMemo(() => buildFacts(project), [project]);
  const reserved = target === 'seo' && project.marketing.seoImageMax ? [`img-${project.marketing.seoImageMax}`] : [];
  const cap = REQUEST_MAX[f.via];
  const name = agentName(f.via);
  const problem = stepOneProblem(project, target, f, r.ready);
  const profile = useRuntime((s) => s.ai.agents?.manus.profile ?? '');
  const defaultProfile = MANUS_PROFILES.find((x) => x.id === profile);
  const chosenProfile = MANUS_PROFILES.find((x) => x.id === f.profile);

  // a lead magnet's PDF is the app's own design, with no pictures yet: no images for it
  const withImages = target !== 'leadMagnet';
  // images pasted or dropped on the text box join the request's images
  const paste = usePasteImages(
    (media: MediaRef[]) => {
      const now = useAgentBuildWindow.getState().fields[windowKey(project.id, target)]?.images ?? [];
      const plan = planPromptImages(now, media, { reserved });
      reportRefusals(plan.refused);
      for (const m of media) if (!plan.added.some((a) => a.media.id === m.id)) void deleteBlob(m.id);
      if (plan.added.length) setWindowFields({ images: plan.images });
    },
    { room: MAX_PROMPT_IMAGES - f.images.length, onBusy: setAdding },
  );

  const blurWebsite = () => {
    const c = checkWebsite(f.website);
    setWebsiteError(c.error);
    if (!c.error && c.url !== f.website) setWindowFields({ website: c.url });
  };
  const toggleFact = (id: BuildFactId, on: boolean) => setWindowFields({ unticked: on ? f.unticked.filter((x) => x !== id) : [...new Set([...f.unticked, id])] });
  const factIds = [...new Set(facts.map((x) => x.id))];

  const settingsLink = (
    <button type="button" className="link" onClick={() => void openPage('workspace-settings', 'ai').then((ok) => ok && closeAgentBuild())}>
      Open Settings › AI keys
    </button>
  );

  return (
    <Modal
      open
      onClose={() => closeAgentBuild()}
      size="lg"
      title={BUILD_TITLE[target]}
      subtitle="Step 1 of 2"
      footer={
        <>
          {problem && (
            <p className="mr-auto flex min-w-0 basis-full items-start gap-1.5 text-caption text-bad sm:basis-auto" role="alert">
              <CircleAlert size={14} className="mt-px shrink-0" aria-hidden="true" />
              {problem}
            </p>
          )}
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => closeAgentBuild()}>
            Cancel
          </button>
          <button type="button" className="btn btn-ai btn-sm" disabled={!r.ready || !!problem || adding} onClick={onNext}>
            Next
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-6">
        <fieldset className="min-w-0">
          <legend className="label">Who builds it</legend>
          <OptionCards
            aria-label="Who builds it"
            value={f.via}
            onChange={(via) => setWindowFields({ via })}
            columns={2}
            options={AGENTS.filter((via) => ready[via].show).map((via) => {
              const a = ready[via];
              return {
                value: via,
                title: agentName(via),
                icon: <span className="text-h3 text-ink-2">{via === 'manus' ? 'M' : 'V'}</span>,
                description: a.ready ? (via === 'manus' ? 'An AI agent with its own computer and browser, in your Manus account.' : 'The AI employee from viktor.com, in your Slack.') : a.text,
                disabled: !a.ready && f.via !== via,
              };
            })}
          />
          {!r.ready && (
            <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-small text-bad" role="status">
              <span>{r.text}</span>
              {r.settings && settingsLink}
            </p>
          )}
        </fieldset>

        {target === 'email' || target === 'leadMagnet' ? (
          <Field label="What" htmlFor={`${ids}-kind`}>
            <select id={`${ids}-kind`} className="select" value={f.kind} onChange={(e) => setWindowFields({ kind: e.target.value })}>
              {target === 'email'
                ? Object.entries(EMAIL_KIND_LABEL).map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))
                : LEAD_MAGNET_TYPES.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
            </select>
          </Field>
        ) : target === 'asset' ? (
          <Field label="What" htmlFor={`${ids}-kind`}>
            <select id={`${ids}-kind`} className="select" value={f.kind} onChange={(e) => setWindowFields({ kind: e.target.value })}>
              {CODE_KINDS.filter((k) => !k.business || project.track === 'business').map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label}
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <div className="flex flex-col gap-3">
            <PageTypePicker value={(PAGE_TYPES as string[]).includes(f.kind) ? (f.kind as PageType) : 'landing'} onChange={(t) => setWindowFields({ kind: t })} compact />
            <PageTypeLinks project={project} type={(PAGE_TYPES as string[]).includes(f.kind) ? (f.kind as PageType) : 'landing'} />
          </div>
        )}

        <Field
          label="What to build and the features you want"
          htmlFor={`${ids}-request`}
          right={<span className={cn('num font-mono', f.request.trim().length > cap && 'text-bad')}>{`${f.request.trim().length.toLocaleString('en-US')} / ${cap.toLocaleString('en-US')}`}</span>}
          hint={withImages ? 'Your own words, sent as you write them inside the app’s template. Paste or drop images here too.' : 'Your own words, sent as you write them inside the app’s template.'}
        >
          <AutoTextarea id={`${ids}-request`} value={f.request} onChange={(v) => setWindowFields({ request: v })} minRows={4} placeholder={PLACEHOLDER[target]} {...(withImages ? paste : {})} />
        </Field>

        {withImages && (
          <PromptImages
            images={f.images}
            onChange={(images) => setWindowFields({ images })}
            reserved={reserved}
            busy={adding}
            label="Images"
            hint={`Your images go to ${f.via === 'manus' ? 'Manus' : 'Slack'} with your request. The page shows each one as {{img-N}}; add a note to say where it goes.`}
          />
        )}

        <Field label="Your website (reference)" htmlFor={`${ids}-site`} error={websiteError} hint={f.website.trim() ? `${name} opens it only to see your colors, fonts and style. They don’t sign in or change anything there.` : 'No reference: leave it empty, or add your website’s https address.'}>
          <div className="relative">
            <Globe size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden="true" />
            <input id={`${ids}-site`} className="input pl-9" type="url" inputMode="url" autoComplete="url" placeholder="https://example.com" value={f.website} onChange={(e) => setWindowFields({ website: e.target.value })} onBlur={blurWebsite} aria-invalid={!!websiteError} />
          </div>
        </Field>

        <fieldset className="min-w-0">
          <legend className="label">Facts {name} may use</legend>
          {facts.length === 0 ? (
            <p className="text-small text-muted">No facts yet: add your business details in Settings › Brand and Studio.</p>
          ) : (
            <ul className="well grid gap-x-6 gap-y-3 p-4 sm:grid-cols-2">
              {factIds.map((id) => {
                const lines = facts.filter((x) => x.id === id);
                return (
                  <li key={id} className="min-w-0">
                    <Checkbox checked={!f.unticked.includes(id)} onChange={(on) => toggleFact(id, on)} label={lines[0].label} description={<span className="clamp-2 break-words">{lines.map((x) => x.value).join('; ')}</span>} />
                  </li>
                );
              })}
            </ul>
          )}
          <p className="hint">Only these facts go: the page must not add reviews, prices or numbers of its own.</p>
        </fieldset>

        {f.via === 'manus' ? (
          <Field label="Agent" htmlFor={`${ids}-profile`} hint={chosenProfile ? chosenProfile.note : defaultProfile ? `${defaultProfile.label}: ${defaultProfile.note}` : 'The agent set for your Manus key in Settings › AI keys.'}>
            <select id={`${ids}-profile`} className="select" value={f.profile} onChange={(e) => setWindowFields({ profile: e.target.value })}>
              <option value="">{defaultProfile ? `${defaultProfile.label} (your Settings default)` : '(your Settings default)'}</option>
              {MANUS_PROFILES.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.label}
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-small text-ink-2">
            <AgentAvatar via="viktor" size={16} />
            {`In ${agentPlace() || 'the place you chose in Settings'}.`}
            <button type="button" className="link" onClick={() => void openPage('workspace-settings', 'ai').then((ok) => ok && closeAgentBuild())}>
              Change in Settings
            </button>
          </p>
        )}
      </div>
    </Modal>
  );
}

/** "Build a booking page from your words, 2 images, 5 facts and your website." */
export function confirmWhat(target: BuildTarget, kind: string, o: { words: boolean; images: number; facts: number; website: boolean }): string {
  const parts = [o.words ? 'your words' : '', o.images ? plural(o.images, 'image') : '', o.facts ? plural(o.facts, 'fact') : '', o.website ? 'your website' : ''].filter(Boolean);
  const from = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0] ?? '';
  return `Build ${kindNoun(target, kind)}${from ? ` from ${from}` : ''}.`;
}

/** Step 2: the confirm, with who does the work, what it costs and the exact message (a dry run). Send is one click, once. */
export function BuildConfirm({ project, target, f, stepId, onBack }: { project: Project; target: BuildTarget; f: BuildWindowFields; stepId?: string; onBack: () => void }) {
  const name = agentName(f.via);
  // one Ref for the exact message shown and the one sent
  const [ref] = useState(() => newRef());
  // the open sections: "message" (the exact message, fetched the first time it opens) and "who"
  const [open, setOpen] = useState<string[]>([]);
  const show = open.includes('message');
  const [preview, setPreview] = useState<{ state: 'idle' | 'loading' | 'done' | 'error'; data?: AgentPreview; error?: string }>({ state: 'idle' });
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<{ title: string; body: string; settings: boolean } | null>(null);
  const facts = chosenFacts(project, f.unticked);
  const website = checkWebsite(f.website).url;
  const input = { projectId: project.id, via: f.via, target, kind: f.kind, request: f.request, website, images: f.images, facts, ...(stepId ? { stepId } : {}), ...(f.via === 'manus' && f.profile ? { profile: f.profile } : {}) };
  const over = preview.data ? preview.data.chars > preview.data.limit : false;

  useEffect(() => {
    if (!show || preview.state !== 'idle') return;
    setPreview({ state: 'loading' });
    const req = buildRequestOf(input);
    const ask = f.via === 'manus' ? manusPreview({ fn: 'build', build: req, ref, ...(input.profile ? { profile: input.profile } : {}) }) : viktorPreview({ kind: 'build', build: req, ref });
    ask.then(
      (data) => setPreview({ state: 'done', data }),
      (e) => setPreview({ state: 'error', error: agentErrorText(e, f.via).body }),
    );
  }, [show]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = async () => {
    if (sending) return;
    setSending(true);
    setError(null);
    const r = await startBuild({ ...input, ref });
    if (r.outcome === 'refused') {
      setError(r.error);
      setSending(false);
      return;
    }
    if (r.outcome === 'sent') {
      closeAgentBuild(true);
      toast({ kind: 'success', title: `Sent to ${name}`, body: 'You can keep working; the app checks for the page.' });
    } else if (r.outcome === 'unknown') {
      closeAgentBuild(true);
      toast({ kind: 'info', title: 'May have been delivered', body: `The app checks ${f.via === 'manus' ? 'your Manus tasks' : 'Slack'} by itself before anything is sent again.` });
    } else {
      // the build's card shows what happened; Try again there brings these fields back
      closeAgentBuild();
      toast({ kind: 'error', title: r.error.title, body: r.error.body });
    }
  };

  return (
    <Modal
      open
      onClose={() => !sending && closeAgentBuild()}
      size="lg"
      title={`Send this to ${name}?`}
      subtitle="Step 2 of 2"
      footer={
        <>
          <button type="button" className="btn btn-secondary btn-sm mr-auto" disabled={sending} onClick={onBack}>
            Back
          </button>
          <button type="button" className="btn btn-secondary btn-sm" disabled={sending} onClick={() => closeAgentBuild()}>
            Cancel
          </button>
          <button type="button" className={cn('btn btn-ai btn-sm', sending && 'is-running')} disabled={sending || over} aria-busy={sending || undefined} onClick={() => void send()}>
            {sending ? <Spinner /> : <Send />} {sending ? `Sending to ${name}…` : `Send to ${name}`}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-start gap-3">
          <AgentAvatar via={f.via} size={28} className="mt-px" />
          <p className="min-w-0 text-body text-ink">{confirmWhat(target, f.kind, { words: !!f.request.trim(), images: f.images.length, facts: facts.length, website: !!website })}</p>
        </div>
        <Accordion type="multiple" value={open} onValueChange={setOpen} className="border-y border-line">
          <AccordionItem value="message">
            <AccordionTrigger className="py-2.5 text-small font-medium text-ink-2 hover:text-ink">Show the exact message</AccordionTrigger>
            <AccordionContent className="pb-3">
              {preview.state === 'loading' && (
                <p className="flex items-center gap-2 text-small text-muted" role="status">
                  <Spinner size={14} /> Writing it the way the server sends it…
                </p>
              )}
              {preview.state === 'error' && (
                <p className="flex items-start gap-1.5 text-small text-bad" role="alert">
                  <CircleAlert size={14} className="mt-[3px] shrink-0" aria-hidden="true" />
                  {preview.error}
                </p>
              )}
              {preview.data && (
                <>
                  <pre className="well scroll-thin max-h-[300px] overflow-auto whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-caption text-ink-2">{preview.data.text}</pre>
                  <p className={cn('mt-1.5 text-caption', over ? 'text-bad' : 'text-muted')}>
                    <span className="num">{`${preview.data.chars.toLocaleString('en-US')} of ${preview.data.limit.toLocaleString('en-US')} characters`}</span>
                    {over && ` · Too long for one ${f.via === 'manus' ? 'Manus' : 'Slack'} message: shorten your words or untick some facts.`}
                  </p>
                </>
              )}
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="who" className="border-b-0">
            <AccordionTrigger className="py-2.5 text-small font-medium text-ink-2 hover:text-ink">Who does it and what it costs</AccordionTrigger>
            {/* kept in the page while closed (hidden), so it's there to find and to read the moment it opens */}
            <AccordionContent forceMount hidden={!open.includes('who')} className="pb-3">
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-small">
                <dt className="text-muted">Who</dt>
                <dd className="text-ink-2">{agentWho(f.via, 'build')}</dd>
                <dt className="text-muted">Cost</dt>
                <dd className="text-ink-2">{agentCost(f.via)}</dd>
              </dl>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
        {error && <Callout tone="bad">{error.body}</Callout>}
        <p className="text-caption text-muted">One click sends it once. Nothing is published: you preview the page here when it’s back, then use it or ask for changes.</p>
      </div>
    </Modal>
  );
}
