import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Experiment, ExperimentLearning, Project, SalesPage } from '@/lib/types';

vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), pickExperimentWinner: vi.fn() }));
const api = await import('./api');
const { applyWinner, learnedSkill, upcomingPosts, MAX_LEARNED_LINES } = await import('./winner');
const { useStore } = await import('@/store/useStore');
const { newProject, defaultSettings } = await import('@/store/defaults');

const learning = (o: Partial<ExperimentLearning> = {}): ExperimentLearning => ({ changed: 'hook', winnerLabel: 'Question', loserLabels: ['Original'], metric: 'engagement_rate', lift: 18, summary: 'Hooks: “Question” beat “Original” on Instagram: +18% engagement', ...o });
const exp = (o: Partial<Experiment> = {}): Experiment => ({ id: 'e1', projectId: 'p1', kind: 'post', mode: 'times', changed: 'hook', network: 'instagram', metric: 'engagement_rate', subjectRef: 'post_a', name: '', state: 'finished', startedAt: null, endsAt: null, result: { verdict: 'winner', winner: 'b' }, delayed: false, winner: null, winnerUsedAt: null, counted: true, lastReadAt: null, refreshAt: null, createdAt: null, variants: [], ...o });

function project(): Project {
  const p = { ...newProject('business', 'existing'), id: 'p1' } as Project;
  p.marketing = {
    ...p.marketing,
    salesPage: { sections: [{ id: 'h', type: 'hero', visible: true, data: { eyebrow: '', headline: 'Fresh bread', subheadline: 'Daily', ctaLabel: 'Order', ctaSubtext: '', bullets: [] } }], theme: {} as SalesPage['theme'], updatedAt: 1 },
    seoVariant: { experimentId: 'e1', changed: 'headline', overrides: { headline: 'Warm bread at 7?' } },
    emails: [{ id: 's1', index: 0, purpose: 'Welcome', subject: 'Welcome!', preview: 'p', body: 'Hi there.\n\nMore.', delay: { value: 0, unit: 'minutes' }, ctaLabel: '', ctaUrl: '', variants: { experimentId: 'e2', changed: 'subject', b: { subject: 'Your guide is here', preview: 'p', body: 'Hi there.\n\nMore.' } } }],
  };
  return p;
}

beforeEach(() => {
  useStore.setState({ projects: [project()], activeProjectId: 'p1', posts: [], skills: [], settings: defaultSettings() });
});

describe('the Brain learns from a result', () => {
  it('one skill per business and dimension: created, then merged, keeping the last 5 lines', () => {
    const first = learnedSkill([], { projectId: 'p1', kind: 'post', learning: learning(), winnerText: 'Guess what’s back?' });
    expect(first.isNew).toBe(true);
    expect(first.skill).toMatchObject({ name: 'Learned: hooks', category: 'learned', source: 'feedback', projectId: 'p1', scope: ['social'], priority: 2, enabled: true, directives: { hookStyle: 'question' } });
    let skills = [first.skill];
    for (let i = 0; i < 7; i++) {
      const next = learnedSkill(skills, { projectId: 'p1', kind: 'post', learning: learning({ summary: `line ${i}` }) });
      expect(next.isNew).toBe(false);
      skills = [next.skill];
    }
    expect(skills[0].instructions.split('\n')).toHaveLength(MAX_LEARNED_LINES);
    expect(skills[0].instructions.split('\n').at(-1)).toBe('line 6');
    // another dimension or business is its own skill; email and page get their own scope
    expect(learnedSkill(skills, { projectId: 'p1', kind: 'post', learning: learning({ changed: 'cta' }), winnerText: 'Book today.' }).skill).toMatchObject({ name: 'Learned: calls to action', directives: { cta: 'Book today.' } });
    expect(learnedSkill(skills, { projectId: 'p2', kind: 'email', learning: learning({ changed: 'subject' }) }).skill.scope).toEqual(['email']);
    expect(learnedSkill([], { projectId: 'p1', kind: 'page', learning: learning({ changed: 'headline' }) }).skill.scope).toEqual(['seo']);
  });

  it('upcoming posts: unposted, later, same network, not a test version', () => {
    const now = Date.parse('2026-11-07T12:00:00Z');
    const base = { projectId: 'p1', platform: 'instagram', status: 'scheduled', scheduledAt: '2026-11-08T12:00:00Z' };
    const posts = [
      { id: 'a', ...base },
      { id: 'b', ...base, platform: 'facebook' },
      { id: 'c', ...base, scheduledAt: '2026-11-06T12:00:00Z' },
      { id: 'd', ...base, status: 'published' },
      { id: 'e', ...base, experiment: { id: 'e1', key: 'b' } },
    ] as never;
    expect(upcomingPosts(posts, { projectId: 'p1', network: 'instagram', now }).map((p) => p.id)).toEqual(['a']);
  });
});

describe('Use the winner', () => {
  it('page, B won: the saved page gets B’s hero and the version is cleared', async () => {
    vi.mocked(api.pickExperimentWinner).mockResolvedValue({ experiment: exp({ kind: 'page', changed: 'headline', winner: 'b' }), learning: learning({ changed: 'headline' }) });
    await applyWinner(exp({ kind: 'page', changed: 'headline' }), 'b');
    const p = useStore.getState().projects[0];
    const hero = p.marketing.salesPage!.sections[0];
    expect(hero.type === 'hero' && hero.data.headline).toBe('Warm bread at 7?');
    expect(p.marketing.seoVariant).toBeUndefined();
    expect(useStore.getState().skills.map((s) => s.name)).toEqual(['Learned: page headlines']);
  });

  it('page, A won: the version is dropped and the page stays', async () => {
    vi.mocked(api.pickExperimentWinner).mockResolvedValue({ experiment: exp({ kind: 'page', winner: 'a' }), learning: learning({ changed: 'headline' }) });
    await applyWinner(exp({ kind: 'page', changed: 'headline', result: { verdict: 'winner', winner: 'a' } }), 'a');
    const p = useStore.getState().projects[0];
    const hero = p.marketing.salesPage!.sections[0];
    expect(hero.type === 'hero' && hero.data.headline).toBe('Fresh bread');
    expect(p.marketing.seoVariant).toBeUndefined();
  });

  it('email, B won: the step’s subject becomes B’s, and the other version is dropped', async () => {
    vi.mocked(api.pickExperimentWinner).mockResolvedValue({ experiment: exp({ id: 'e2', kind: 'email', changed: 'subject', winner: 'b' }), learning: learning({ changed: 'subject' }) });
    await applyWinner(exp({ id: 'e2', kind: 'email', changed: 'subject' }), 'b');
    const step = useStore.getState().projects[0].marketing.emails[0];
    expect(step.subject).toBe('Your guide is here');
    expect(step.variants).toBeUndefined();
    expect(api.pickExperimentWinner).toHaveBeenLastCalledWith('e2', 'b', false);
  });

  it('email with blocks, B won the opening: the doc gets B’s opening too (renders and drafts use the doc)', async () => {
    const { applyTemplate } = await import('../../../shared/email/migrate.mjs');
    const { normalizeDoc } = await import('../../../shared/email/blocks.mjs');
    const { plainOf } = await import('@/lib/emailDoc');
    const p0 = useStore.getState().projects[0];
    const doc = normalizeDoc(applyTemplate('quick_win', { subject: 'Your tip', body: 'First para.\n\nSecond para.', ctaLabel: '', ctaUrl: '' })).doc;
    const body = plainOf(doc, p0).body;
    const bBody = body.replace('First para.', 'Quick one today. First para.');
    useStore.getState().updateProject('p1', (p) => ({ ...p, marketing: { ...p.marketing, emails: [{ ...p.marketing.emails[0], doc, body, variants: { experimentId: 'e3', changed: 'opening', b: { subject: 'Welcome!', preview: 'p', body: bBody } } }] } }));
    vi.mocked(api.pickExperimentWinner).mockResolvedValue({ experiment: exp({ id: 'e3', kind: 'email', changed: 'opening', winner: 'b' }), learning: learning({ changed: 'opening' }) });
    await applyWinner(exp({ id: 'e3', kind: 'email', changed: 'opening' }), 'b');
    const step = useStore.getState().projects[0].marketing.emails[0];
    expect(step.variants).toBeUndefined();
    const texts = step.doc!.blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n\n');
    expect(texts).toContain('Quick one today. First para.');
    expect(step.body).toContain('Quick one today. First para.');
    expect(step.body.startsWith('Your tip')).toBe(true);
  });

  it('"Pick one anyway" sends override', async () => {
    vi.mocked(api.pickExperimentWinner).mockResolvedValue({ experiment: exp({ winner: 'a' }), learning: learning({ override: true, lift: null }) });
    await applyWinner(exp({ result: { verdict: 'too_close' } }), 'a', { override: true });
    expect(api.pickExperimentWinner).toHaveBeenLastCalledWith('e1', 'a', true);
  });
});
