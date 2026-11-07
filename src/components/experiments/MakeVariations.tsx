// "Make variations" (P4b §A2): one dialog for a post, an email step or the SEO page. Choose the one thing that
// differs (with its cost first), how many new versions, generate them (one AI request; Visual also makes an image or a
// video per version), review them side by side with the original (every version editable, with an "Also changed"
// warning when an edit touches something else), then save a DRAFT test. Nothing goes out and nothing counts toward
// the month's tests until it starts. Hidden in the claude.ai build and when the server has no A/B tests.

import { useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import { FlaskConical, TriangleAlert } from 'lucide-react';
import type { EmailStep, ExperimentChanged, ExperimentKind, Post, Project, ShareMode, VariantKey } from '@/lib/types';
import { useStore } from '@/store/useStore';
import { useAI } from '@/ai/useAI';
import { emailVariantsTask, pageVariantsTask, postVariantsTask } from '@/ai/tasks';
import { makePostImage, makePostVideo } from '@/ai/socialPosts';
import { imageErrorMessage } from '@/ai/image';
import { useProjectVideoWeek } from '@/store/videoWeek';
import { useExperiments } from '@/store/experiments';
import { useExperimentsOn } from '@/lib/experiments/config';
import { experimentErrorCopy } from '@/lib/experiments/api';
import { experimentsUsageLabel } from '@/lib/plans';
import { canTrialReel, SHARE_MODE_OPTIONS } from '@/lib/trialReels';
import { heroOf } from '@/lib/experiments/page';
import { savePageTest, saveEmailTest, savePostTest } from '@/lib/experiments/save';
import {
  CHANGES,
  KEYS,
  alsoChanged,
  applyEmailChange,
  applyPostChange,
  costLine,
  defaultPlannedTimes,
  emailDiff,
  firstParagraph,
  heroAlsoChanged,
  heroDiff,
  postDiff,
  postPiece,
  type EmailFields,
  type HeroFields,
  type PostChange,
  type PostFields,
  type VariantPiece,
} from '@/lib/experiments/variants';
import { AutoTextarea, Callout, Field, Modal, Spinner } from '../ui/primitives';
import { GenerateButton } from '../ai/AI';
import { toast } from '@/store/ui';

export type VariationTarget = { kind: 'post'; postId: string } | { kind: 'email'; projectId: string; stepId: string } | { kind: 'page'; projectId: string };

export const useMakeVariations = create<{
  target: VariationTarget | null;
  preset: { change?: ExperimentChanged; count?: 1 | 2 } | null;
  open: (t: VariationTarget, preset?: { change?: ExperimentChanged; count?: 1 | 2 }) => void;
  close: () => void;
}>((set) => ({
  target: null,
  preset: null,
  open: (target, preset) => set({ target, preset: preset ?? null }),
  close: () => set({ target: null, preset: null }),
}));

export const EXPLAINER = 'A/B testing: change one thing, see which does better. We only call a winner when the numbers are clear.';
export const LIMITS_COPY = 'Launch: 2 A/B tests a month · Grow: 10 · Scale: unlimited. Making variations uses AI credits; video variations use this week’s videos.';

/** A version in the review: its label and fields, by kind. */
interface Draft {
  key: VariantKey;
  label: string;
  post?: PostFields & { media?: Post['media']; plannedAt?: string };
  email?: EmailFields;
  hero?: HeroFields;
}

const localInput = (v: string) => {
  const d = new Date(v);
  if (!Number.isFinite(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** The dialog's host: mount once (App). */
/** What a Trial Reels test can compare (P4b §S4): they go out back to back, so never a posting time or a call to action. */
const TRIAL_CHANGES: ExperimentChanged[] = ['hook', 'caption', 'visual'];

export function MakeVariationsHost() {
  const target = useMakeVariations((s) => s.target);
  const on = useExperimentsOn();
  if (!target || !on || __ARTIFACT_BUILD__) return null;
  return <MakeVariations key={JSON.stringify(target)} target={target} />;
}

export function MakeVariations({ target }: { target: VariationTarget }) {
  const close = useMakeVariations((s) => s.close);
  const preset = useMakeVariations((s) => s.preset);
  const post = useStore((s) => (target.kind === 'post' ? s.posts.find((p) => p.id === target.postId) : undefined));
  const projectId = target.kind === 'post' ? post?.projectId : target.projectId;
  const project = useStore((s) => s.projects.find((p) => p.id === projectId));
  const step = target.kind === 'email' ? project?.marketing.emails.find((e) => e.id === target.stepId) : undefined;
  const hero = useMemo(() => (target.kind === 'page' && project ? heroOf(project) : null), [target.kind, project]);
  const kind: ExperimentKind = target.kind;
  const usage = useExperiments((s) => (projectId ? s.byProject[projectId]?.usage : null));
  const week = useProjectVideoWeek(kind === 'post' ? projectId : null);
  const isVideo = !!post && (post.media?.kind === 'video' || post.format === 'video');
  const videosLeft = week && week.limit != null ? Math.max(0, week.limit - week.used) : null;

  const choices = CHANGES[kind].filter((c) => !(kind === 'page' && hero?.mode === 'html' && c.id === 'hero'));
  const [change, setChange] = useState<ExperimentChanged>(preset?.change && choices.some((c) => c.id === preset.change) ? preset.change : choices[0].id);
  const [count, setCount] = useState<1 | 2>(kind === 'post' ? (preset?.count ?? 1) : 1);
  const [mode, setMode] = useState<'times' | 'trial_reels'>('times');
  const [shareMode, setShareMode] = useState<ShareMode>('TRIAL_REELS_DONT_SHARE_TO_FOLLOWERS');
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [problem, setProblem] = useState('');
  const [retried, setRetried] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const task = kind === 'post' ? postVariantsTask : kind === 'email' ? emailVariantsTask : pageVariantsTask;
  const ai = useAI(task);
  const n = kind === 'post' ? count : 1;
  const cost = costLine(kind, change, { count: n, video: isVideo, videosLeft });
  const trialOk = !!post && canTrialReel(post);

  useEffect(() => {
    if (projectId) void useExperiments.getState().load(projectId);
  }, [projectId]);

  if (!project || (kind === 'post' && !post) || (kind === 'email' && !step) || (kind === 'page' && !hero)) {
    return (
      <Modal open onClose={close} size="sm" title="Make variations">
        <p className="text-body text-muted">{kind === 'page' ? 'Write the page first: version A is the page as it is.' : 'That isn’t here any more.'}</p>
      </Modal>
    );
  }

  const original = (): { text: string; sub?: string; topic: string; whole?: string } => {
    if (kind === 'post' && post) return { text: postPiece(post, change as PostChange), topic: post.headline, whole: post.caption };
    if (kind === 'email' && step) return { text: change === 'subject' ? step.subject : firstParagraph(step.body), topic: step.purpose || step.subject, whole: step.body };
    return { text: change === 'cta' ? (hero?.ctaLabel ?? '') : (hero?.headline ?? ''), sub: hero?.subheadline, topic: project.brand.name };
  };

  const fromPieces = (pieces: VariantPiece[]): Draft[] =>
    pieces.map((p, i) => {
      const key = KEYS[i + 1];
      if (kind === 'post' && post) return { key, label: p.label, post: { ...applyPostChange(post, change as PostChange, p.text), media: change === 'visual' ? undefined : post.media } };
      if (kind === 'email' && step) return { key, label: p.label, email: applyEmailChange(step, change as 'subject' | 'opening', p.text) };
      const h = hero!;
      return { key, label: p.label, hero: change === 'cta' ? { ...h, ctaLabel: p.text } : change === 'hero' ? { ...h, headline: p.text, subheadline: p.sub ?? h.subheadline } : { ...h, headline: p.text } };
    });

  const generate = async (again = false) => {
    setError('');
    setProblem('');
    if (again) setRetried(true);
    if (change === 'time' && post) {
      const times = defaultPlannedTimes(post.scheduledAt, n + 1);
      setDrafts(KEYS.slice(1, n + 1).map((key, i) => ({ key, label: `Time ${key.toUpperCase()}`, post: { headline: post.headline, caption: post.caption, hashtags: post.hashtags, visualPrompt: post.visualPrompt, media: post.media, plannedAt: times[i + 1] } })));
      return;
    }
    const o = original();
    const out = await ai.run({ change, count: n, original: o.text, ...(o.sub !== undefined ? { originalSub: o.sub } : {}), context: { platform: post?.platform, topic: o.topic, whole: o.whole } }, { project });
    if (!out) return;
    if (out.problem || !out.variants.length) {
      setProblem(out.problem ?? 'The AI didn’t make the versions.');
      return;
    }
    let next = fromPieces(out.variants);
    if (kind === 'post' && post && mode === 'times') {
      const times = defaultPlannedTimes(post.scheduledAt, n + 1);
      next = next.map((d, i) => ({ ...d, post: { ...d.post!, plannedAt: times[i + 1] } }));
    }
    setDrafts(next);
    // Visual: a new image (or video) for each version, the same way the post's own buttons make them
    if (kind === 'post' && post && change === 'visual') {
      for (const d of next) {
        setBusy(`Making ${isVideo ? 'the video' : 'the image'} for version ${d.key.toUpperCase()}…`);
        try {
          const p = { ...post, ...d.post!, id: `${post.id}-${d.key}` } as Post;
          const media = isVideo ? (await makePostVideo(project, p, { seconds: 5 })).media : (await makePostImage(project, p)).media;
          setDrafts((cur) => cur?.map((x) => (x.key === d.key ? { ...x, post: { ...x.post!, media } } : x)) ?? cur);
        } catch (e) {
          setError(`Version ${d.key.toUpperCase()}: ${imageErrorMessage(e).body || 'its visual couldn’t be made.'} You can save it and add the visual in the post editor.`);
          break;
        }
      }
      setBusy('');
    }
  };

  const patch = (key: VariantKey, fn: (d: Draft) => Draft) => setDrafts((cur) => cur?.map((d) => (d.key === key ? fn(d) : d)) ?? cur);

  const also = (d: Draft): string[] => {
    if (d.post && post) return alsoChanged(change, postDiff(post, d.post));
    if (d.email && step) return alsoChanged(change, emailDiff(step, d.email));
    if (d.hero && hero) return heroAlsoChanged(change as 'headline' | 'hero' | 'cta', heroDiff(hero, d.hero));
    return [];
  };

  const save = async () => {
    if (!drafts) return;
    setBusy('Saving the test…');
    setError('');
    try {
      let id = '';
      if (kind === 'post' && post) {
        const e = await savePostTest({ source: post, change, mode, ...(mode === 'trial_reels' ? { shareMode } : {}), versions: drafts.map((d) => ({ label: d.label, fields: { headline: d.post!.headline, caption: d.post!.caption, hashtags: d.post!.hashtags, visualPrompt: d.post!.visualPrompt }, media: d.post!.media, plannedAt: mode === 'times' ? d.post!.plannedAt : undefined })) });
        id = e.id;
      } else if (kind === 'email' && step) {
        id = (await saveEmailTest({ project, step, change: change as 'subject' | 'opening', label: drafts[0].label, b: drafts[0].email! })).id;
      } else if (hero) {
        const h = drafts[0].hero!;
        const overrides = change === 'cta' ? { ctaLabel: h.ctaLabel } : change === 'headline' ? { headline: h.headline } : { headline: h.headline, subheadline: h.subheadline, imageId: h.imageId ?? '' };
        id = (await savePageTest({ project, change: change as 'headline' | 'hero' | 'cta', label: drafts[0].label, overrides })).id;
      }
      toast({ kind: 'success', title: 'A/B test saved as a draft', body: kind === 'post' ? 'Post version A when you’re ready: the test starts then.' : kind === 'email' ? 'Create the A/B draft in Omnisend from the step when you’re ready.' : 'Start the split from the page when you’re ready.' });
      if (id) useExperiments.getState().open(id);
      close();
    } catch (e) {
      setError(experimentErrorCopy(e));
    } finally {
      setBusy('');
    }
  };

  const running = ai.running || !!busy;
  const usageLine = experimentsUsageLabel(usage);

  return (
    <Modal
      open
      onClose={() => !running && close()}
      size={drafts ? 'xl' : 'md'}
      icon={<FlaskConical />}
      title="Make variations"
      subtitle={EXPLAINER}
      footer={
        drafts ? (
          <>
            <button type="button" className="btn btn-secondary btn-sm" disabled={running} onClick={() => setDrafts(null)}>
              Back
            </button>
            <button type="button" className="btn btn-primary btn-sm" disabled={running} onClick={() => void save()}>
              {busy ? <Spinner /> : null} Save as draft test
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn btn-secondary btn-sm" disabled={running} onClick={close}>
              Cancel
            </button>
            {change === 'time' ? (
              <button type="button" className="btn btn-primary btn-sm" onClick={() => void generate()}>
                Choose the times
              </button>
            ) : (
              <GenerateButton variant="ai" size="sm" running={ai.running} runningLabel={ai.stage || 'Writing…'} disabled={!!cost.disabled || running} onClick={() => void generate()}>
                {n === 1 ? 'Make 1 version' : `Make ${n} versions`}
              </GenerateButton>
            )}
          </>
        )
      }
    >
      {!drafts ? (
        <div className="flex flex-col gap-5" data-testid="variations-choose">
          <fieldset className="flex flex-col gap-2">
            <legend className="label mb-1">What to change</legend>
            {choices.map((c) => {
              const line = costLine(kind, c.id, { count: n, video: isVideo, videosLeft });
              // Trial Reels go out back to back: they compare a hook, a caption or a visual
              const notForTrial = kind === 'post' && mode === 'trial_reels' && !TRIAL_CHANGES.includes(c.id);
              const off = !!line.disabled || notForTrial;
              const why = notForTrial ? 'Not for Trial Reels: they go out back to back.' : line.reason;
              return (
                <label key={c.id} className="flex cursor-pointer items-start gap-3 rounded-md border border-line bg-surface px-3 py-2.5 has-[:checked]:border-primary has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60">
                  <input type="radio" name="variation-change" className="mt-1" checked={change === c.id} disabled={off} onChange={() => setChange(c.id)} />
                  <span className="flex min-w-0 flex-col">
                    <span className="text-body font-medium text-ink">{c.label}</span>
                    <span className="text-small text-muted">{c.hint}</span>
                    <span className="text-caption text-muted" data-testid={`cost-${c.id}`}>
                      {line.text}
                      {why ? ` · ${why}` : ''}
                    </span>
                  </span>
                </label>
              );
            })}
          </fieldset>
          {kind === 'post' && (
            <Field label="How many new versions">
              <div className="flex gap-2">
                {([1, 2] as const).map((c) => (
                  <button key={c} type="button" className={c === count ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'} aria-pressed={c === count} onClick={() => setCount(c)}>
                    {c}
                  </button>
                ))}
              </div>
            </Field>
          )}
          {kind === 'post' && (
            <Field label="How it runs" hint={mode === 'times' ? 'Each version goes out on the same network at a different time. You post each one; the app reminds you.' : 'Each version is a Trial Reel: Instagram shows it to non-followers first. They can go out back to back.'}>
              <div className="flex flex-wrap gap-2">
                <button type="button" className={mode === 'times' ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'} aria-pressed={mode === 'times'} onClick={() => setMode('times')}>
                  Same network, different times
                </button>
                {trialOk && (
                  <button
                    type="button"
                    className={mode === 'trial_reels' ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}
                    aria-pressed={mode === 'trial_reels'}
                    onClick={() => {
                      setMode('trial_reels');
                      if (!TRIAL_CHANGES.includes(change)) setChange('hook');
                    }}
                  >
                    Instagram Trial Reels
                  </button>
                )}
              </div>
            </Field>
          )}
          {kind === 'post' && mode === 'trial_reels' && (
            <Field label="Trial Reel type">
              <div className="flex flex-col gap-1.5">
                {SHARE_MODE_OPTIONS.filter((o) => o.value !== 'CUSTOM').map((o) => (
                  <label key={o.value} className="flex items-start gap-2 text-small text-ink-2">
                    <input type="radio" name="variation-share" className="mt-0.5" checked={shareMode === o.value} onChange={() => setShareMode(o.value)} />
                    <span>
                      {o.label}: {o.hint}
                      {o.value === 'TRIAL_REELS_SHARE_TO_FOLLOWERS_IF_LIKED' ? ' Instagram may share one with your followers before the test ends.' : ''}
                    </span>
                  </label>
                ))}
              </div>
            </Field>
          )}
          <p className="text-small text-muted">
            {LIMITS_COPY}
            {usageLine ? ` ${usageLine}.` : ''}
          </p>
          {problem && (
            <Callout tone="warn" title="The versions didn’t come out right">
              {problem} {retried ? 'Edit the original a little, or try again later.' : ''}
              {!retried && (
                <button type="button" className="btn btn-secondary btn-xs ml-2" onClick={() => void generate(true)}>
                  Try again
                </button>
              )}
            </Callout>
          )}
          {ai.result?.note && <p className="text-small text-muted">{ai.result.note}</p>}
        </div>
      ) : (
        <div className="flex flex-col gap-4" data-testid="variations-review">
          {busy && (
            <p className="flex items-center gap-2 text-small text-muted">
              <Spinner /> {busy}
            </p>
          )}
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <OriginalCard kind={kind} post={post} step={step} hero={hero} />
            {drafts.map((d) => (
              <VersionCard key={d.key} draft={d} change={change} kind={kind} project={project} also={also(d)} onChange={(fn) => patch(d.key, fn)} />
            ))}
          </div>
          {error && (
            <Callout tone="bad" title="Not saved">
              {error}
            </Callout>
          )}
        </div>
      )}
    </Modal>
  );
}

function OriginalCard({ kind, post, step, hero }: { kind: ExperimentKind; post?: Post; step?: EmailStep; hero: HeroFields | null }) {
  return (
    <div className="card flex flex-col gap-2 p-4">
      <p className="label">A · Original</p>
      {kind === 'post' && post && <p className="whitespace-pre-line break-words text-small text-ink-2">{post.caption}</p>}
      {kind === 'email' && step && (
        <>
          <p className="text-body font-medium text-ink">{step.subject}</p>
          <p className="whitespace-pre-line break-words text-small text-ink-2">{step.body}</p>
        </>
      )}
      {kind === 'page' && hero && (
        <>
          <p className="text-body font-medium text-ink">{hero.headline}</p>
          {hero.subheadline && <p className="text-small text-ink-2">{hero.subheadline}</p>}
          {hero.ctaLabel && <p className="text-small text-muted">Button: {hero.ctaLabel}</p>}
        </>
      )}
    </div>
  );
}

function VersionCard({ draft, change, kind, project, also, onChange }: { draft: Draft; change: ExperimentChanged; kind: ExperimentKind; project: Project; also: string[]; onChange: (fn: (d: Draft) => Draft) => void }) {
  const K = draft.key.toUpperCase();
  const images = project.marketing.seoImages ?? [];
  return (
    <div className="card flex flex-col gap-3 p-4" data-testid={`version-${draft.key}`}>
      <Field label={`${K} · Label`}>
        <input className="input" value={draft.label} maxLength={80} onChange={(e) => onChange((d) => ({ ...d, label: e.target.value }))} />
      </Field>
      {draft.post && (
        <>
          {change === 'time' ? (
            <Field label="Planned time">
              <input type="datetime-local" className="input" value={draft.post.plannedAt ? localInput(draft.post.plannedAt) : ''} onChange={(e) => onChange((d) => ({ ...d, post: { ...d.post!, plannedAt: e.target.value ? new Date(e.target.value).toISOString() : undefined } }))} />
            </Field>
          ) : (
            <>
              <Field label="Caption">
                <AutoTextarea className="input" value={draft.post.caption} onChange={(v) => onChange((d) => ({ ...d, post: { ...d.post!, caption: v } }))} />
              </Field>
              <Field label="On-image headline">
                <input className="input" value={draft.post.headline} onChange={(e) => onChange((d) => ({ ...d, post: { ...d.post!, headline: e.target.value } }))} />
              </Field>
              {change === 'visual' && (
                <Field label="Image description" hint={draft.post.media ? `With its new ${draft.post.media.kind}.` : 'No visual yet: add it in the post editor after saving.'}>
                  <AutoTextarea className="input" value={draft.post.visualPrompt} onChange={(v) => onChange((d) => ({ ...d, post: { ...d.post!, visualPrompt: v } }))} />
                </Field>
              )}
            </>
          )}
        </>
      )}
      {draft.email && (
        <>
          <Field label="Subject">
            <input className="input" value={draft.email.subject} onChange={(e) => onChange((d) => ({ ...d, email: { ...d.email!, subject: e.target.value } }))} />
          </Field>
          <Field label="Preview text">
            <input className="input" value={draft.email.preview} onChange={(e) => onChange((d) => ({ ...d, email: { ...d.email!, preview: e.target.value } }))} />
          </Field>
          <Field label="Body">
            <AutoTextarea className="input" value={draft.email.body} onChange={(v) => onChange((d) => ({ ...d, email: { ...d.email!, body: v } }))} />
          </Field>
        </>
      )}
      {draft.hero && kind === 'page' && (
        <>
          <Field label="Headline">
            <input className="input" value={draft.hero.headline} onChange={(e) => onChange((d) => ({ ...d, hero: { ...d.hero!, headline: e.target.value } }))} />
          </Field>
          {change === 'hero' && (
            <>
              <Field label="Subheading">
                <AutoTextarea className="input" minRows={2} value={draft.hero.subheadline} onChange={(v) => onChange((d) => ({ ...d, hero: { ...d.hero!, subheadline: v } }))} />
              </Field>
              {images.length > 0 && (
                <Field label="Hero image" hint="Only images on the page can be used: publish the page again after adding one.">
                  <select className="input" value={draft.hero.imageId ?? ''} onChange={(e) => onChange((d) => ({ ...d, hero: { ...d.hero!, imageId: e.target.value || undefined } }))}>
                    <option value="">No image</option>
                    {images.map((i) => (
                      <option key={i.media.id} value={i.media.id}>
                        {i.note ? `${i.key}: ${i.note}` : i.key}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
            </>
          )}
          <Field label="Button text">
            <input className="input" value={draft.hero.ctaLabel} onChange={(e) => onChange((d) => ({ ...d, hero: { ...d.hero!, ctaLabel: e.target.value } }))} />
          </Field>
        </>
      )}
      {also.length > 0 && (
        <p className="flex items-start gap-1.5 text-small text-warn" data-testid="also-changed">
          <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          Also changed: {also.join(', ')}. The test result will say more than one thing changed.
        </p>
      )}
    </div>
  );
}
