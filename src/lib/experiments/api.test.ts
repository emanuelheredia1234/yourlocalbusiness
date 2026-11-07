import { afterEach, describe, expect, it, vi } from 'vitest';
import apiSource from './api.ts?raw';
import * as api from './api';
import { experimentsConfig, experimentsOn } from './config';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('A/B test calls in the claude.ai build', () => {
  it('refuse before any request (NOT_SET_UP), and the config is off without asking', async () => {
    vi.stubGlobal('__ARTIFACT_BUILD__', true);
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const calls = [
      api.listExperiments('p1'),
      api.getExperiment('e1'),
      api.getExperimentUsage(),
      api.getTrialEligibility('p1'),
      api.createExperiment({ projectId: 'p1', kind: 'post', mode: 'times', changed: 'hook', subjectRef: 'post_1', variants: [] }),
      api.patchExperiment('e1', { name: 'x' }),
      api.deleteExperiment('e1'),
      api.startPageSplit('e1', '<html>', 'abc'),
      api.createEmailAbDraft('e1', { a: { subject: 'a', body: 'b' }, b: { subject: 'c', body: 'd' } }),
      api.refreshExperiment('e1'),
      api.stopExperiment('e1'),
      api.useExperimentWinner('e1', 'b'),
    ];
    for (const c of calls) await expect(c).rejects.toMatchObject({ code: 'NOT_SET_UP' });
    expect(await experimentsConfig(true)).toEqual({ enabled: false, reachable: false });
    expect(experimentsOn('ready', { enabled: true, reachable: true }, true)).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it('every experiments path in the app goes through a call guarded by __ARTIFACT_BUILD__', () => {
    const RAW = import.meta.glob(['/src/**/*.{ts,tsx}', '!/src/**/*.test.{ts,tsx}'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
    // no other app file names an experiments route: they all go through api.ts
    for (const [file, text] of Object.entries(RAW)) if (!file.endsWith('/lib/experiments/api.ts')) expect(text.includes(`'/api/experiments`) || text.includes('`/api/experiments')).toBe(false);
    const lines = (apiSource as string).split('\n').filter((l) => l.includes('/api/experiments'));
    expect(lines.length).toBeGreaterThanOrEqual(10);
    for (const l of lines) expect(l).toMatch(/__ARTIFACT_BUILD__ \? noServer\(\)/);
  });
});

describe('experimentsOn', () => {
  it('only when signed in and the server says so', () => {
    expect(experimentsOn('ready', { enabled: true, reachable: true }, false)).toBe(true);
    expect(experimentsOn('ready', { enabled: false, reachable: true }, false)).toBe(false);
    expect(experimentsOn('guest', { enabled: true, reachable: true }, false)).toBe(false);
    expect(experimentsOn('ready', null, false)).toBe(false);
  });
});
