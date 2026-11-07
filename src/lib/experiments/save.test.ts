// Deleting a draft test from its card (P4b review): what the workspace kept for it goes too, so the SEO page's A/B
// panel and the email step aren't left pointing at a test that's gone.
import { beforeEach, describe, expect, it } from 'vitest';
import type { Experiment, Project } from '@/lib/types';

const { forgetDraftLocally } = await import('./save');
const { useStore } = await import('@/store/useStore');
const { newProject, defaultSettings } = await import('@/store/defaults');

const exp = (o: Partial<Experiment>): Pick<Experiment, 'id' | 'projectId' | 'variants'> => ({ id: 'e1', projectId: 'p1', variants: [], ...o });

function project(): Project {
  const p = { ...newProject('business', 'existing'), id: 'p1' } as Project;
  p.marketing = {
    ...p.marketing,
    seoVariant: { experimentId: 'e1', changed: 'headline', overrides: { headline: 'Warm bread at 7?' } },
    emails: [
      { id: 's1', index: 0, purpose: 'Welcome', subject: 'Welcome!', preview: 'p', body: 'Hi', delay: { value: 0, unit: 'minutes' }, ctaLabel: '', ctaUrl: '', variants: { experimentId: 'e2', changed: 'subject', b: { subject: 'B', preview: 'p', body: 'Hi' } } },
      { id: 's2', index: 1, purpose: 'Tip', subject: 'Tip', preview: 'p', body: 'Hi', delay: { value: 1, unit: 'days' }, ctaLabel: '', ctaUrl: '', variants: { experimentId: 'e3', changed: 'subject', b: { subject: 'B2', preview: 'p', body: 'Hi' } } },
    ],
  };
  return p;
}

beforeEach(() => {
  useStore.setState({ projects: [project()], activeProjectId: 'p1', posts: [], skills: [], settings: defaultSettings() });
});

describe('a deleted draft test', () => {
  it('a page test: the SEO page’s version B goes; the email steps stay', () => {
    forgetDraftLocally(exp({ id: 'e1' }));
    const p = useStore.getState().projects[0];
    expect(p.marketing.seoVariant).toBeUndefined();
    expect(p.marketing.emails.map((m) => m.variants?.experimentId)).toEqual(['e2', 'e3']);
  });

  it('an email test: only that step’s version B goes', () => {
    forgetDraftLocally(exp({ id: 'e2' }));
    const p = useStore.getState().projects[0];
    expect(p.marketing.emails.map((m) => m.variants?.experimentId)).toEqual([undefined, 'e3']);
    expect(p.marketing.seoVariant?.experimentId).toBe('e1');
  });
});
