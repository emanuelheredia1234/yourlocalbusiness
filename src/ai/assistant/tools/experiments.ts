// A/B tests and Instagram Trial Reels for the assistant (P4b §A8). Reads run at once; everything else opens the app's
// own window where the owner confirms: "Make variations" (it uses AI credits, and a video slot for a video's visual),
// a version's posting window (posting a version starts the test and counts toward the month's A/B tests), the test's
// card (Use the winner). The assistant never posts a version, starts a split or makes an Omnisend draft by itself, and
// never posts a second version on its own. Not in the claude.ai build: there are no A/B tests there.

import type { Experiment, ShareMode } from '@/lib/types';
import { useStore } from '@/store/useStore';
import { useExperiments } from '@/store/experiments';
import { experimentErrorCopy, getTrialEligibility, listExperiments, refreshExperiment } from '@/lib/experiments/api';
import { experimentsOnNow } from '@/lib/experiments/config';
import { CHANGED_LABEL, metricLine, verdictCopy, versionName } from '@/lib/experiments/math';
import { CHANGES } from '@/lib/experiments/variants';
import { experimentsUsageLabel } from '@/lib/plans';
import { canTrialReel, eligibilityView, isTrialMode, shareModeLabel, shareModeOf } from '@/lib/trialReels';
import { arg, defineTool, type AnyTool } from '../registry';

const NOT_HERE = 'A/B tests need the app’s server, so they aren’t available here.';
const OFF = 'A/B tests aren’t on for this app (or you’re not signed in).';
const notOn = () => (__ARTIFACT_BUILD__ ? NOT_HERE : !experimentsOnNow() ? OFF : null);

const ID = { pattern: /^[0-9a-f-]{36}$/i, desc: 'test id' } as const;

async function load(projectId: string): Promise<{ experiments: Experiment[]; usage: string | null }> {
  const got = await listExperiments(projectId);
  for (const e of got.experiments) useExperiments.getState().upsert(e);
  useExperiments.getState().setUsage(projectId, got.usage);
  return { experiments: got.experiments, usage: experimentsUsageLabel(got.usage) };
}

const brief = (e: Experiment) => ({
  id: e.id,
  name: e.name,
  kind: e.kind,
  testing: CHANGED_LABEL[e.changed],
  state: e.state,
  verdict: verdictCopy(e).title,
  ...(e.winner ? { winnerInUse: versionName(e.winner) } : {}),
});

const listTool = defineTool({
  name: 'list_experiments',
  class: 'R',
  summary: 'A/B tests, verdicts and this month’s usage; with id, one test’s numbers (update: read new ones, every 15 min at most).',
  args: { id: arg.string({ ...ID, optional: true }), update: arg.boolean({ optional: true }) },
  validate: () => notOn(),
  run: async (a, ctx) => {
    let all: Awaited<ReturnType<typeof load>>;
    try {
      all = await load(ctx.projectId);
    } catch (err) {
      return { ok: false, error: experimentErrorCopy(err) };
    }
    if (!a.id) return { data: { tests: all.experiments.map(brief), usage: all.usage ?? 'unknown' }, note: 'Looked at your A/B tests' };
    let e = all.experiments.find((x) => x.id === a.id);
    if (!e) return { ok: false, error: 'That A/B test isn’t in this business.' };
    let updated: string | undefined;
    if (a.update) {
      if (e.refreshAt && Date.parse(e.refreshAt) > Date.now()) updated = 'Results were updated a few minutes ago: try again later.';
      else {
        try {
          e = (await refreshExperiment(e.id)).experiment;
          useExperiments.getState().upsert(e);
          updated = 'Read new numbers now.';
        } catch (err) {
          updated = experimentErrorCopy(err);
        }
      }
    }
    const v = verdictCopy(e);
    const one = e;
    return {
      data: {
        ...brief(one),
        verdictText: `${v.title}. ${v.body}`,
        versions: one.variants.map((x) => ({ version: versionName(x.key), label: x.label, result: metricLine(one, x.key) })),
        ...(one.delayed ? { delayed: 'Results are delayed.' } : {}),
        ...(updated ? { update: updated } : {}),
        canUseWinner: !one.winner && one.result.verdict === 'winner',
        canPickAnyway: !one.winner && (one.result.verdict === 'too_close' || one.result.verdict === 'tie'),
      },
      note: 'Looked at an A/B test',
    };
  },
});

const ALL_CHANGES = [...new Set(Object.values(CHANGES).flatMap((l) => l.map((c) => c.id)))];

const makeTool = defineTool({
  name: 'make_variations',
  class: 'Pub',
  summary: 'Open Make variations (post: hook caption visual cta time; email: subject opening; page: headline hero cta). Owner sees the cost, saves a draft.',
  args: {
    target: arg.enum(['post', 'email', 'page'] as const),
    id: arg.string({ max: 120, desc: 'post id, email step id or "page"' }),
    change: arg.enum(ALL_CHANGES, { optional: true }),
    count: arg.number({ optional: true, min: 1, max: 2, int: true }),
  },
  validate: (a, ctx) => {
    const off = notOn();
    if (off) return off;
    if (a.change && !CHANGES[a.target].some((c) => c.id === a.change)) return `For ${a.target === 'post' ? 'a post' : a.target === 'email' ? 'an email' : 'the page'} the change is one of: ${CHANGES[a.target].map((c) => c.id).join(', ')}.`;
    const s = useStore.getState();
    if (a.target === 'post') {
      const p = s.posts.find((x) => x.id === a.id && x.projectId === ctx.projectId);
      if (!p) return 'That post isn’t in this business.';
      if (p.experiment) return 'That post is already a version in an A/B test.';
      if (p.status === 'published' || p.external) return 'That post went out already: make variations of one that hasn’t.';
    }
    if (a.target === 'email' && !s.projects.find((x) => x.id === ctx.projectId)?.marketing.emails.some((e) => e.id === a.id)) return 'That email step isn’t in this business.';
    return null;
  },
  window: (a) => ({ kind: 'make-variations', target: a.target, id: a.id, ...(a.change ? { change: a.change } : {}), ...(a.count ? { count: a.count as 1 | 2 } : {}) }),
});

const startTool = defineTool({
  name: 'start_experiment',
  class: 'Pub',
  summary: 'Start a draft test where the owner confirms (version A’s post, the page split, the Omnisend draft). Counts toward the month.',
  args: { id: arg.string(ID) },
  validate: () => notOn(),
  window: async (a, ctx) => {
    let e: Experiment | undefined;
    try {
      e = (await load(ctx.projectId)).experiments.find((x) => x.id === a.id);
    } catch (err) {
      return experimentErrorCopy(err);
    }
    if (!e) return 'That A/B test isn’t in this business.';
    if (e.state !== 'draft') return e.state === 'running' ? 'That test is already running: post its next version with open_post_now on that version’s post (the owner confirms; versions go out in order).' : 'That test has ended.';
    if (e.kind === 'page') return { kind: 'page', route: 'marketing-seo' };
    if (e.kind === 'email') return { kind: 'page', route: 'marketing-email', tab: 'sequence' };
    const a0 = e.variants.find((v) => v.key === 'a');
    const post = a0?.postId ? useStore.getState().posts.find((p) => p.id === a0.postId) : undefined;
    if (!post) return 'Version A’s post isn’t here any more.';
    return { kind: 'post-now', postId: post.id };
  },
});

const winnerTool = defineTool({
  name: 'use_winner',
  class: 'Pub',
  summary: 'Open a test’s card to use its winner (anyway: pick one when too close to call).',
  args: { id: arg.string(ID), key: arg.enum(['a', 'b', 'c'] as const, { optional: true }), anyway: arg.boolean({ optional: true }) },
  validate: () => notOn(),
  window: async (a, ctx) => {
    let e: Experiment | undefined;
    try {
      e = (await load(ctx.projectId)).experiments.find((x) => x.id === a.id);
    } catch (err) {
      return experimentErrorCopy(err);
    }
    if (!e) return 'That A/B test isn’t in this business.';
    if (e.winner) return `${versionName(e.winner)} is already in use for that test.`;
    const v = e.result.verdict;
    if (v !== 'winner' && !(a.anyway && (v === 'too_close' || v === 'tie'))) return v === 'too_close' || v === 'tie' ? 'It’s too close to call: the owner can pick one anyway (say so with anyway: true).' : 'There’s no clear winner yet.';
    return { kind: 'experiment', experimentId: e.id, name: e.name };
  },
});

const MODES: Record<'reel' | 'trial' | 'trial_non_followers', ShareMode> = { reel: 'CUSTOM', trial: 'TRIAL_REELS_SHARE_TO_FOLLOWERS_IF_LIKED', trial_non_followers: 'TRIAL_REELS_DONT_SHARE_TO_FOLLOWERS' };

const trialTool = defineTool({
  name: 'set_trial_reel',
  class: 'P-text',
  summary: 'An Instagram video as a Reel or Trial Reel (needs 1,000+ followers); asks first on a planned post.',
  args: { postId: arg.string({ max: 120 }), mode: arg.enum(['reel', 'trial', 'trial_non_followers'] as const) },
  validate: (a, ctx) => {
    const off = notOn();
    if (off) return off;
    const p = useStore.getState().posts.find((x) => x.id === a.postId && x.projectId === ctx.projectId);
    if (!p) return 'That post isn’t in this business.';
    if (!canTrialReel(p)) return 'Trial Reels are for Instagram videos only.';
    if (p.status === 'published' || p.external) return 'That post went out already.';
    if (p.experiment) return 'That post is a version in an A/B test, which sets how it goes out.';
    return null;
  },
  card: (a) => {
    const p = useStore.getState().posts.find((x) => x.id === a.postId);
    if (!p || p.status !== 'scheduled') return null;
    return { title: `Post “${p.headline}” as a ${shareModeLabel(MODES[a.mode])}?`, what: 'It’s on your calendar: this changes how it goes out on Instagram when you post it.', who: 'Nothing is posted now. You still confirm when you post it.', confirmLabel: 'Change it' };
  },
  run: async (a, ctx) => {
    const mode = MODES[a.mode];
    let line = '';
    if (isTrialMode(mode)) {
      const el = await getTrialEligibility(ctx.projectId).catch(() => ({ eligible: 'unknown' as const, reason: 'unreadable' as const }));
      const view = eligibilityView(el);
      line = view.line;
      if (view.disabled) return { ok: false, error: `${view.line}. It stays a regular Reel.` };
    }
    useStore.getState().updatePost(a.postId, { instagram: mode === 'CUSTOM' ? undefined : { shareMode: mode } });
    const now = shareModeOf(useStore.getState().posts.find((p) => p.id === a.postId) ?? {});
    return { data: { postAs: shareModeLabel(now), ...(line ? { eligibility: line } : {}) }, note: `Set to post as a ${shareModeLabel(now)}` };
  },
});

const ALL: AnyTool[] = [listTool, makeTool, startTool, winnerTool, trialTool];

/** The group: none in the claude.ai build (excluded.ts's ab_tests explains instead). */
export const experimentToolsFor = (artifact: boolean): AnyTool[] => (artifact ? [] : ALL);
export const experimentTools: AnyTool[] = experimentToolsFor(__ARTIFACT_BUILD__);
