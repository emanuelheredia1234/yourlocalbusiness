// The app and the server describe the same kinds: every Code & assets kind and every SEO page type has the
// words Manus and Viktor get (shared/agent-targets.json) and the same name; the Manus agent profiles the build
// window offers are the server's own.
import { describe, expect, it } from 'vitest';
import targets from '../../../shared/agent-targets.json';
import { CODE_KINDS } from '@/ai/local/code';
import { PAGE_TYPES, PAGE_TYPE_LABEL } from '@/lib/pageTypes';
import { describeProviders } from '../../../server/providers/registry.mjs';
import { AGENT_TARGETS, BUILD_TARGETS, KIND_LABELS } from '../../../server/agents/templates.mjs';
import { LEAD_MAGNET_TYPES } from '@/ai/local/email';
import { MANUS_PROFILES } from './who';

describe('what Manus and Viktor are told to build', () => {
  it('covers every Code & assets kind and every SEO page type, and nothing else', () => {
    expect(Object.keys(targets.asset).sort()).toEqual(CODE_KINDS.map((k) => k.id).sort());
    expect(Object.keys(targets.seo).sort()).toEqual([...PAGE_TYPES].sort());
    expect(AGENT_TARGETS).toEqual(targets);
    for (const desc of [...Object.values(targets.asset), ...Object.values(targets.seo)]) expect(desc).toMatch(/^[A-Z].*\.$/);
  });

  it('names each kind as the app does (the Manus task title)', () => {
    expect(KIND_LABELS.asset).toEqual(Object.fromEntries(CODE_KINDS.map((k) => [k.id, k.label])));
    expect(KIND_LABELS.seo).toEqual(PAGE_TYPE_LABEL);
  });

  it('P5: emails and lead magnets too — the four targets, each kind with its words and its name', () => {
    expect(Object.keys(targets).sort()).toEqual([...BUILD_TARGETS].sort());
    expect(Object.keys(targets.email).sort()).toEqual(['newsletter', 'nurture', 'offer', 'welcome']);
    // the lead magnet's kinds are the LeadMagnetType ids, named as the app names them
    expect(Object.keys(targets.leadMagnet).sort()).toEqual(LEAD_MAGNET_TYPES.map((t) => t.id).sort());
    expect(KIND_LABELS.leadMagnet).toEqual(Object.fromEntries(LEAD_MAGNET_TYPES.map((t) => [t.id, t.label])));
    for (const target of BUILD_TARGETS) {
      expect(Object.keys(KIND_LABELS[target]).sort()).toEqual(Object.keys(targets[target]).sort());
      for (const desc of Object.values(targets[target])) expect(desc).toMatch(/^[A-Z0-9].*\.$/);
    }
  });
});

describe('the Manus agent profiles', () => {
  it('are the server’s, with the same labels and notes', () => {
    const manus = describeProviders().find((p) => p.id === 'manus');
    expect(MANUS_PROFILES).toEqual(manus?.kinds.agent?.efforts);
  });
});
