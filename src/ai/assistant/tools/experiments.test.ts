// The assistant and A/B tests (P4b §A8): reads run at once; making variations, starting a test, posting a version and
// using the winner only open the app's window (the owner confirms there); a Trial Reel on a planned post asks first.
// Nothing here in the claude.ai build.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Experiment, ExperimentVariant } from '@/lib/types';

vi.mock('@/lib/experiments/api', async (original) => ({
  ...(await original<typeof import('@/lib/experiments/api')>()),
  listExperiments: vi.fn(),
  refreshExperiment: vi.fn(),
  getTrialEligibility: vi.fn(),
}));
const api = await import('@/lib/experiments/api');
const { useAuth } = await import('@/lib/cloud/auth');
const { useExperimentsConfig } = await import('@/lib/experiments/config');
const { useStore } = await import('@/store/useStore');
const { useExperiments } = await import('@/store/experiments');
const { answerCard } = await import('@/store/assistant');
const { fakeHost, runTool, seedWorkspace, testPost, testChat, TEST_PROJECT } = await import('../testing');
const { registry } = await import('.');
const { experimentToolsFor } = await import('./experiments');
const { abTestsHere } = await import('./excluded');

const v = (key: 'a' | 'b', o: Partial<ExperimentVariant> = {}): ExperimentVariant => ({ key, label: key === 'a' ? 'Original' : 'Question', postId: `post_${key}`, jobId: null, plannedAt: null, shareMode: null, hasHtml: false, omnisendCampaignId: null, metrics: {}, metricsAt: null, metricsError: null, visitors: 0, views: 0, leads: 0, ...o });
const ID = '11111111-1111-4111-8111-111111111111';
const exp = (o: Partial<Experiment> = {}): Experiment => ({ id: ID, projectId: TEST_PROJECT, kind: 'post', mode: 'times', changed: 'hook', network: 'instagram', metric: 'engagement_rate', subjectRef: 'post_a', name: 'Fresh bread', state: 'draft', startedAt: null, endsAt: null, result: {}, delayed: false, winner: null, winnerUsedAt: null, counted: false, lastReadAt: null, refreshAt: null, createdAt: null, variants: [v('a'), v('b')], ...o });
const list = vi.mocked(api.listExperiments);
const el = vi.mocked(api.getTrialEligibility);

let host: ReturnType<typeof fakeHost>;
beforeEach(() => {
  seedWorkspace({ posts: [testPost('post_a'), testPost('post_b'), testPost('vid', { format: 'video', status: 'draft', media: { id: 'm', kind: 'video', mime: 'video/mp4' } as never }), testPost('vid2', { format: 'video', status: 'scheduled', media: { id: 'm2', kind: 'video', mime: 'video/mp4' } as never })] });
  useAuth.setState({ phase: 'ready', user: { id: 'u1', email: 'a@b.c' } });
  useExperimentsConfig.setState({ config: { enabled: true, reachable: true } });
  list.mockReset();
  el.mockReset();
  host = fakeHost();
});
afterEach(() => {
  host.restore();
  useAuth.setState({ phase: 'loading' });
  useExperimentsConfig.setState({ config: null });
});

describe('A/B test tools', () => {
  it('list_experiments reads the tests and the month’s usage', async () => {
    list.mockResolvedValue({ experiments: [exp({ state: 'running', result: { verdict: 'keep_going' } })], usage: { used: 1, limit: 2, resetsAt: '2026-12-01T12:00:00Z' } });
    const r = await runTool('list_experiments');
    expect(registry.get('list_experiments')).toMatchObject({ class: 'R' });
    expect(r.result).toMatchObject({ tests: [{ id: ID, state: 'running', verdict: 'Keep going', testing: 'Hook' }], usage: expect.stringMatching(/^A\/B tests this month: 1 of 2/) });
  });

  it('make_variations only opens the dialog, prefilled (the owner sees the cost and saves there)', async () => {
    const r = await runTool('make_variations', { target: 'post', id: 'post_a', change: 'hook', count: 2 });
    expect(registry.get('make_variations')).toMatchObject({ class: 'Pub' });
    expect(r).toMatchObject({ ok: true, status: 'opened' });
    expect(host.calls.windows).toEqual([{ kind: 'make-variations', target: 'post', id: 'post_a', change: 'hook', count: 2 }]);
    const bad = await runTool('make_variations', { target: 'email', id: 'nope', change: 'hook' });
    expect(bad.ok).toBe(false);
  });

  it('start_experiment opens version A’s posting window: the owner always confirms', async () => {
    list.mockResolvedValue({ experiments: [exp()], usage: { used: 0, limit: 2, resetsAt: null } });
    const r = await runTool('start_experiment', { id: ID });
    expect(registry.get('start_experiment')).toMatchObject({ class: 'Pub' });
    expect(r.status).toBe('opened');
    expect(host.calls.windows).toEqual([{ kind: 'post-now', postId: 'post_a' }]);
    list.mockResolvedValue({ experiments: [exp({ kind: 'page', variants: [v('a', { postId: null }), v('b', { postId: null })] })], usage: { used: 0, limit: 2, resetsAt: null } });
    await runTool('start_experiment', { id: ID });
    expect(host.calls.windows[1]).toEqual({ kind: 'page', route: 'marketing-seo' });
  });

  it('use_winner opens the card only when there is a winner (or anyway on too close to call)', async () => {
    list.mockResolvedValue({ experiments: [exp({ state: 'finished', result: { verdict: 'too_close' } })], usage: { used: 1, limit: 2, resetsAt: null } });
    expect((await runTool('use_winner', { id: ID })).error).toMatch(/too close to call/);
    const r = await runTool('use_winner', { id: ID, anyway: true });
    expect(r.status).toBe('opened');
    expect(host.calls.windows).toEqual([{ kind: 'experiment', experimentId: ID, name: 'Fresh bread' }]);
  });

  it('list_experiments with an id reads one test, with “Update results” when allowed', async () => {
    list.mockResolvedValue({ experiments: [exp({ state: 'running', result: { verdict: 'winner', winner: 'b', lift: 18 } })], usage: { used: 1, limit: 2, resetsAt: null } });
    vi.mocked(api.refreshExperiment).mockResolvedValue({ experiment: exp({ state: 'running', result: { verdict: 'winner', winner: 'b', lift: 18 } }) });
    const r = await runTool('list_experiments', { id: ID, update: true });
    expect(r.result).toMatchObject({ verdict: 'Clear winner: Version B +18%', canUseWinner: true, update: 'Read new numbers now.' });
  });

  it('set_trial_reel: a draft changes at once; a planned post asks first; too few followers refuses', async () => {
    el.mockResolvedValue({ eligible: true, followers: 2340 });
    const r = await runTool('set_trial_reel', { postId: 'vid', mode: 'trial_non_followers' });
    expect(r.result).toMatchObject({ postAs: 'Trial Reel (only non-followers)', eligibility: 'Trial Reels: available (2,340 followers)' });
    expect(useStore.getState().posts.find((p) => p.id === 'vid')?.instagram?.shareMode).toBe('TRIAL_REELS_DONT_SHARE_TO_FOLLOWERS');
    const run = runTool('set_trial_reel', { postId: 'vid2', mode: 'trial' });
    let cardId = '';
    await vi.waitFor(() => {
      const c = testChat().find((m) => m.role === 'card' && m.card?.state === 'pending');
      expect(c).toBeTruthy();
      cardId = c!.id;
    });
    answerCard(cardId, false);
    expect((await run).status).toBe('declined');
    expect(useStore.getState().posts.find((p) => p.id === 'vid2')?.instagram).toBeUndefined();
    el.mockResolvedValue({ eligible: false, reason: 'followers', followers: 640 });
    const no = await runTool('set_trial_reel', { postId: 'vid', mode: 'trial' });
    expect(no.ok).toBe(false);
    expect(no.error).toMatch(/1,000\+ followers \(you have 640\)/);
    expect((await runTool('set_trial_reel', { postId: 'post_a', mode: 'trial' })).error).toMatch(/Instagram videos only/);
  });

  it('set_trial_reel on a planned post: the eligibility comes first, so too few followers is refused before any card', async () => {
    useExperiments.setState({ eligibility: {} });
    el.mockResolvedValue({ eligible: false, reason: 'followers', followers: 640 });
    const cards = testChat().filter((m) => m.role === 'card').length;
    const no = await runTool('set_trial_reel', { postId: 'vid2', mode: 'trial' });
    expect(no.ok).toBe(false);
    expect(no.error).toMatch(/1,000\+ followers \(you have 640\)/);
    expect(testChat().filter((m) => m.role === 'card').length).toBe(cards);
    // eligible: the card carries the line
    useExperiments.setState({ eligibility: {} });
    el.mockResolvedValue({ eligible: true, followers: 2340 });
    const run = runTool('set_trial_reel', { postId: 'vid2', mode: 'trial' });
    let card: { id: string; what: string } | null = null;
    await vi.waitFor(() => {
      const c = testChat().find((m) => m.role === 'card' && m.card?.state === 'pending');
      expect(c).toBeTruthy();
      card = { id: c!.id, what: c!.card!.what };
    });
    expect(card!.what).toContain('Trial Reels: available (2,340 followers).');
    answerCard(card!.id, false);
    expect((await run).status).toBe('declined');
  });

  it('off on the server: the tools say so and open nothing', async () => {
    useExperimentsConfig.setState({ config: { enabled: false, reachable: true } });
    const r = await runTool('make_variations', { target: 'post', id: 'post_a' });
    expect(r.ok).toBe(false);
    expect(host.calls.windows).toEqual([]);
  });
});

describe('the claude.ai build', () => {
  it('registers no A/B test tools; one excluded tool explains', () => {
    expect(experimentToolsFor(true)).toEqual([]);
    expect(experimentToolsFor(false).map((t) => t.name)).toEqual(['list_experiments', 'make_variations', 'start_experiment', 'use_winner', 'set_trial_reel']);
    expect(abTestsHere).toMatchObject({ class: 'X', name: 'ab_tests' });
  });
});
