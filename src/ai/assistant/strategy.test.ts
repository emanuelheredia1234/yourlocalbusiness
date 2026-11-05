// The assistant's v1 touches for Strategy (spec §3.9): its page label and tabs, the guide line and help
// topic, the intent rule that opens #strategy without an AI, and the workspace summary's strategy line.
import { describe, expect, it } from 'vitest';
import { useStore } from '@/store/useStore';
import { defaultSettings } from '@/store/defaults';
import { qaProject, qaSavedStrategy } from '@/test/strategyQa';
import { APP_GUIDE, HELP_TOPICS } from './guide';
import { matchPageIntent } from './intents';
import { PAGE_LABELS, pageName } from './nav';
import { workspaceSummary } from './workspace';

describe('Strategy in the assistant', () => {
  it('knows the page, its tabs, and what it does', () => {
    expect(PAGE_LABELS.strategy).toBe('Strategy');
    expect(pageName('strategy', 'promote')).toBe('Strategy › Where to promote');
    expect(APP_GUIDE).toContain('- #strategy (tabs plan, research, promote, content, assets, outreach, seo):');
    expect(HELP_TOPICS.strategy).toMatch(/^Strategy \(#strategy\): fill in Your details/);
    for (const t of [APP_GUIDE, HELP_TOPICS.strategy]) {
      expect(t).not.toMatch(/<\/script/i);
      expect(t).not.toMatch(/<\/style/i);
    }
  });

  it('opens Strategy for messages about getting clients, without an AI', () => {
    for (const m of ['where should I promote my business?', 'How do I get more clients?', 'what’s my marketing plan', 'help me find clients', 'show me my strategy', 'Where to promote a bakery']) expect(matchPageIntent(m)).toMatchObject({ route: 'strategy', label: 'Strategy' });
    // the 30-day plan and the posts still go where they went
    expect(matchPageIntent('open my 30-day plan')).toMatchObject({ route: 'marketing-social', tab: 'plan' });
    expect(matchPageIntent('I want to write a new post')).toMatchObject({ route: 'marketing-social', tab: 'create' });
  });

  it('the workspace summary carries the strategy in brief (left out before anything is written)', () => {
    const p = { ...qaProject('p1'), onboarded: true };
    useStore.setState({ projects: [p], activeProjectId: 'p1', posts: [], ads: [], myListings: [], skills: [], notices: [], settings: defaultSettings() });
    expect(workspaceSummary()!).not.toHaveProperty('strategy');
    useStore.setState({ projects: [{ ...p, strategy: qaSavedStrategy(p) }] });
    const s = workspaceSummary()!.strategy!;
    expect(s).toMatchObject({ researched: 'web', steps: { done: 0, total: 5 }, week: expect.any(Number), next: expect.any(String) });
    expect(JSON.stringify(s).length).toBeLessThan(300);
  });
});
