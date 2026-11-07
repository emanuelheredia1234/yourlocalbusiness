// shared/morning.json is read by the server and the app: its lists stay equal to the app's own (action kinds, page
// types, code kinds, lead magnet types, networks), every kind has a place to go (or, done outside the app, none),
// and the key is the server's.
import { describe, expect, it } from 'vitest';
import { PAGE_TYPES } from '@/lib/pageTypes';
import { ACTION_LABEL } from '@/lib/strategy';
import { CODE_KINDS } from '@/ai/local/code';
import { LEAD_MAGNET_TYPES } from '@/ai/local/email';
import { POST_PLATFORMS } from '@/ai/knowledge';
import { newProject } from '@/store/defaults';
import { keyOf } from '../../../server/morning/rules.mjs';
import { MORNING, morningKey } from './contract';
import { doIt, targetPage } from './targets';
import { MORNING_AREA } from '@/pages/dashboard/actionMeta';

describe('shared/morning.json', () => {
  it('lists the 21 Strategy kinds plus leads, analytics, strategy and assistant', () => {
    expect(MORNING.kinds).toEqual([...Object.keys(ACTION_LABEL), 'leads', 'analytics', 'strategy', 'assistant']);
    expect(Object.keys(ACTION_LABEL)).toHaveLength(21);
  });
  it('copies the app’s page types, code kinds, lead magnet types and networks', () => {
    expect(MORNING.pageTypes).toEqual(PAGE_TYPES);
    expect(MORNING.codeKinds).toEqual(CODE_KINDS.map((k) => k.id));
    expect(MORNING.leadMagnetTypes).toEqual(LEAD_MAGNET_TYPES.map((k) => k.id));
    expect(MORNING.platforms).toEqual(POST_PLATFORMS);
  });
  it('every kind maps in targets.ts (offline alone has no Do it) and has an area', () => {
    const p = { ...newProject('business', 'existing'), id: 'p1' };
    for (const kind of MORNING.kinds) {
      const target = kind === 'assistant' ? { prompt: 'Help me' } : {};
      const go = doIt({ kind, title: 'Do the thing today', target }, p);
      if (kind === 'offline') expect(go, kind).toBeNull();
      else expect(go?.label, kind).toBeTruthy();
      expect(MORNING_AREA[kind], kind).toBeTruthy();
      if (kind !== 'offline') expect(targetPage({ kind, target }), kind).toBeTruthy();
    }
  });
  it('makes the same keys as the server', () => {
    const cases = [
      { kind: 'write_post', title: 'Behind the scenes', target: { topic: 'Behind the scenes at Copper Kettle' } },
      { kind: 'build_page', title: 'Build it', target: { pageType: 'booking' } },
      { kind: 'calendar', title: 'Post it', target: { postId: 'post_1' } },
      { kind: 'build_page', title: 'Build it', target: { planActionId: 'a_x1' } },
      { kind: 'assistant', title: 'Ask', target: { prompt: 'Help me write a short, warm thank-you message to a new customer of Copper Kettle.' } },
      { kind: 'socials', title: 'Add profiles', target: {} },
    ] as const;
    for (const c of cases) expect(morningKey(c as never)).toBe(keyOf(c, {}));
  });
});
