// What the profile switch shows in each state (rendered to HTML: no browser needed).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Project, Skill, SocialVoice } from '@/lib/types';
import { newProject } from '@/store/defaults';
import { defaultSettings } from '@/store/defaults';
import { parseVoiceResult } from '@/ai/manusVoice';

// The store as the switch reads it, set per test (a server render reads a store's first state, so it's stood in for).
const fake = vi.hoisted(() => ({ state: {} as Record<string, unknown>, ready: true }));
vi.mock('@/store/useStore', () => {
  const useStore = Object.assign((sel: (s: unknown) => unknown) => sel(fake.state), { getState: () => fake.state, setState: () => {} });
  return { useStore };
});
vi.mock('@/components/posts/ManusPost', () => ({
  useManusReady: () => fake.ready,
  useCanOfferManus: () => true,
  manusSetupHint: () => 'Add your Manus API key in Settings › AI keys.',
  errorCopy: () => ({ title: 'x', body: 'y' }),
}));

import { SocialLinksEditor } from './BrandEditors';

const REPORT = parseVoiceResult(['VOICE TONE: friendly | warm, cheerful', 'VOICE PERSON: we', 'VOICE EMOJI: few | 🍞', 'VOICE HASHTAGS: few | #freshbread', 'EXAMPLE: Good morning! The first loaves are out.', 'RESULT: VOICE READ | 15'].join('\n')).report!;
const task = (state: NonNullable<SocialVoice['task']>['state'], message = '') => ({ taskId: 't1', taskUrl: 'https://manus.im/app/t1', state, message, profile: '@copper', requestedAt: 1, checkedAt: Date.now() });

function render(o: { instagram?: string; voice?: SocialVoice; skills?: Skill[]; useBrain?: boolean; onboarded?: boolean } = {}) {
  const p = newProject('business', 'existing');
  const project: Project = { ...p, id: 'p1', onboarded: o.onboarded ?? true, brand: { ...p.brand, socials: { instagram: o.instagram ?? '' }, voiceFrom: o.voice ? { instagram: o.voice } : undefined } };
  fake.state = { projects: [project], skills: o.skills ?? [], settings: { ...defaultSettings(), ai: { ...defaultSettings().ai, useBrain: o.useBrain ?? true } } };
  return renderToStaticMarkup(createElement(SocialLinksEditor, { socials: project.brand.socials, onChange: () => {}, projectId: 'p1', voiceSetup: 'button' }));
}

beforeEach(() => {
  fake.ready = true;
});

describe('the profile switch', () => {
  it('shows once a profile is added, with what it does, and stays off for a link to another site', () => {
    expect(render()).not.toContain('Learn my brand voice from these posts');
    expect(render()).toContain('reads its 15 latest posts. It only reads: it never posts, likes, follows, comments or messages.');
    const html = render({ instagram: '@copper' });
    expect(html).toContain('Learn my brand voice from these posts<span class="sr-only"> (Instagram)</span>');
    expect(html).toMatch(/role="switch" aria-checked="false"(?![^>]*disabled)/);
    expect(render({ instagram: 'https://www.facebook.com/copper' })).toContain('isn’t an Instagram link');
    expect(render({ instagram: 'https://www.facebook.com/copper' })).toMatch(/role="switch" aria-checked="false" disabled/);
  });

  it('says what’s missing when Manus isn’t set up', () => {
    fake.ready = false;
    const html = render({ instagram: '@copper' });
    expect(html).toMatch(/role="switch" aria-checked="false" disabled/);
    expect(html).toContain('Manus can’t read your posts yet: it uses the same Manus setup as posting. Add your Manus API key in Settings › AI keys.');
    // the way there is named after the section (Settings › AI keys)
    expect(html).toContain('>Open AI keys</button>');
  });

  it('follows the read: reading, needs you, failed', () => {
    expect(render({ instagram: '@copper', voice: { learn: true, task: task('working') } })).toContain('Manus is reading your Instagram posts');
    const needs = render({ instagram: '@copper', voice: { learn: true, task: task('needs_input', 'Please sign in to Instagram.') } });
    expect(needs).toContain('Manus needs you');
    expect(needs).toContain('Please sign in to Instagram.');
    expect(needs).toContain('href="https://manus.im/app/t1"');
    const failed = render({ instagram: '@copper', voice: { learn: true, task: task('failed', 'The account is private') } });
    expect(failed).toContain('Couldn’t read the Instagram posts');
    expect(failed).toContain('The account is private');
    expect(failed).toContain('Try again');
  });

  it('shows what was learned, and when it’s not used', () => {
    const skill = { id: 'skill_voice_p1_instagram', enabled: true } as Skill;
    const voice: SocialVoice = { learn: true, task: task('done', 'Manus read 15 posts.'), report: REPORT, profile: '@copper', postsRead: 15, analyzedAt: Date.now(), skillId: skill.id };
    const html = render({ instagram: '@copper', voice, skills: [skill] });
    expect(html).toContain('Learned from 15 posts by @copper');
    expect(html).toContain('warm, cheerful · speaks as “we” · a few emoji 🍞 · #freshbread');
    expect(html).toContain('What Manus learned');
    expect(html).toContain('View in Brain');
    expect(html).toContain('Analyze again');
    const off = render({ instagram: '@copper', voice: { ...voice, learn: false }, skills: [{ ...skill, enabled: false }] });
    expect(off).toContain('Not used while this is off.');
    expect(off).not.toContain('Analyze again');
    expect(render({ instagram: '@copper', voice, skills: [skill], useBrain: false })).toContain('The Brain is off, so nothing uses this voice');
    expect(render({ instagram: '@copper', voice, skills: [{ ...skill, enabled: false }] })).toContain('Its Brain skill is switched off.');
    expect(render({ instagram: '@copper', voice: { ...voice, keptEdits: true }, skills: [skill] })).toContain('Use the new read');
    // the Brain opens once setup is done
    expect(render({ instagram: '@copper', voice, skills: [skill], onboarded: false })).not.toContain('View in Brain');
  });

  it('says when the profile changed since the read', () => {
    const voice: SocialVoice = { learn: true, report: REPORT, profile: '@copper', postsRead: 15, analyzedAt: Date.now() };
    const html = render({ instagram: '@crumb', voice });
    expect(html).toContain('This profile changed since Manus read @copper.');
    expect(html).toContain('Analyze the new profile');
    const dropped = render({ instagram: '@crumb', voice: { learn: true, task: { ...task('done', 'Manus read @copper, but the profile has changed since. Analyze the new one to learn from it.') } } });
    expect(dropped).toContain('but the profile has changed since');
  });
});
