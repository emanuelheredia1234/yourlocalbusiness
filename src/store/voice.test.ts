// The "Learn my brand voice" switch: one read per profile, what a finished read changes, and what it leaves alone.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManusState } from '@/ai/manus';

// A stand-in for Manus: records each task it's asked to start and answers reads with `state`.
const manus = vi.hoisted(() => ({
  created: [] as { fn: string; prompt: string; title?: string; interactive?: boolean }[],
  state: {} as Partial<ManusState>,
  startError: null as Error | null,
}));
vi.mock('@/ai/manus', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/ai/manus')>();
  return {
    ...real,
    createManusTask: vi.fn(async (o: { fn: string; prompt: string; title?: string; interactive?: boolean }) => {
      if (manus.startError) throw manus.startError;
      manus.created.push(o);
      const id = `task00${manus.created.length}`;
      return { taskId: id, taskUrl: `https://manus.im/app/${id}`, title: o.title ?? '' };
    }),
    readManusTask: vi.fn(async (taskId: string) => ({ taskId, status: 'running', agentStatus: '', done: false, waiting: false, waitingType: '', waitingDescription: '', error: '', title: '', taskUrl: `https://manus.im/app/${taskId}`, creditUsage: 0, text: '', imageCount: 0, images: [], ...manus.state })),
  };
});

import { ManusError } from '@/ai/manus';
import { skillFingerprint } from '@/ai/manusVoice';
import { useBusy } from '@/lib/busy';
import { useStore } from './useStore';
import { defaultSettings, newProject } from './defaults';
import { applyLatestVoiceRead, readVoice, refreshVoice, runningVoiceReads, setVoiceLearn, voiceOf, voiceSkill, voiceSkillEdited } from './voice';

const report = (emoji = 'few') =>
  [
    'VOICE TONE: friendly | warm, cheerful',
    'VOICE PERSON: we',
    'VOICE WORDS: fresh from the oven | come say hi',
    `VOICE EMOJI: ${emoji} | 🍞`,
    'VOICE HASHTAGS: few | #freshbread',
    'VOICE VISUALS: Bright natural light on bread.',
    'EXAMPLE: Good morning! The first loaves are out and the street smells like it.',
    'RESULT: VOICE READ | 15',
  ].join('\n');
const done = (text: string): Partial<ManusState> => ({ status: 'stopped', done: true, text });

beforeEach(() => {
  manus.created.length = 0;
  manus.state = {};
  manus.startError = null;
  const p = newProject('business', 'existing');
  const project = { ...p, id: 'p1', brand: { ...p.brand, name: 'Copper & Crumb', socials: { instagram: '@copper', facebook: 'Copper & Crumb Bakery' } } };
  useStore.setState({ projects: [project], activeProjectId: 'p1', skills: [], notices: [], posts: [], settings: defaultSettings() });
});

describe('turning it on', () => {
  it('starts one read-only Manus task for the profile, on the Social posting power', async () => {
    expect(await setVoiceLearn('p1', 'instagram', true)).toBe('started');
    expect(manus.created).toHaveLength(1);
    expect(manus.created[0]).toMatchObject({ fn: 'facebook', interactive: true, title: 'Read Instagram posts for brand voice · @copper' });
    expect(manus.created[0].prompt).toContain('https://www.instagram.com/copper/');
    expect(voiceOf('p1', 'instagram')).toMatchObject({ learn: true, task: { taskId: 'task001', state: 'working', profile: '@copper' } });
    expect(Object.keys(useBusy.getState().jobs)).toEqual([]);
  });

  it('never starts a second read while one is running', async () => {
    await setVoiceLearn('p1', 'instagram', true);
    await readVoice('p1', 'instagram');
    expect(await setVoiceLearn('p1', 'instagram', true)).toBe('reading');
    expect(manus.created).toHaveLength(1);
  });

  it('stays off, with nothing started, when Manus can’t take the task', async () => {
    manus.startError = new ManusError('Your Manus key isn’t set to power Social posting.', 'MANUS_SETUP');
    await expect(setVoiceLearn('p1', 'instagram', true)).rejects.toMatchObject({ code: 'MANUS_SETUP' });
    expect(voiceOf('p1', 'instagram')).toMatchObject({ learn: false });
    expect(voiceOf('p1', 'instagram')?.task).toBeUndefined();
  });

  it('refuses a profile that isn’t one', async () => {
    useStore.getState().updateProject('p1', (p) => ({ ...p, brand: { ...p.brand, socials: { instagram: 'https://www.facebook.com/copper' } } }));
    await expect(setVoiceLearn('p1', 'instagram', true)).rejects.toThrow(/isn’t an Instagram link/);
    expect(manus.created).toHaveLength(0);
  });
});

describe('watching the read', () => {
  it('says when Manus needs you, then makes the project’s Brain skill when it’s done', async () => {
    await setVoiceLearn('p1', 'instagram', true);
    manus.state = { status: 'waiting', waiting: true, waitingType: 'needConnectMyBrowser' };
    await refreshVoice('p1', 'instagram');
    expect(voiceOf('p1', 'instagram')?.task).toMatchObject({ state: 'needs_input', message: expect.stringMatching(/connect your browser/) });

    manus.state = done(report());
    await refreshVoice('p1', 'instagram');
    const v = voiceOf('p1', 'instagram')!;
    expect(v).toMatchObject({ learn: true, profile: '@copper', postsRead: 15, skillId: 'skill_voice_p1_instagram', task: { state: 'done' } });
    expect(v.report?.tone).toBe('friendly');
    const skill = voiceSkill('p1', 'instagram')!;
    expect(skill).toMatchObject({ id: 'skill_voice_p1_instagram', name: 'Brand voice from your Instagram posts', category: 'voice', source: 'social', projectId: 'p1', enabled: true });
    // the only learned profile: its emoji use is the rule
    expect(skill.directives).toMatchObject({ tone: 'friendly', person: 'we', emoji: 'light', hashtags: ['#freshbread'] });
    expect(v.written).toBe(skillFingerprint(skill));
    expect(useStore.getState().notices[0]).toMatchObject({ kind: 'ai', title: 'Brand voice read from Instagram', route: 'brain' });
    expect(runningVoiceReads()).toEqual([]);
  });

  it('keeps a failure’s reason and makes no skill', async () => {
    await setVoiceLearn('p1', 'instagram', true);
    manus.state = done('It’s private.\nRESULT: FAILED | The account is private');
    await refreshVoice('p1', 'instagram');
    expect(voiceOf('p1', 'instagram')?.task).toMatchObject({ state: 'failed', message: 'The account is private' });
    expect(useStore.getState().skills).toEqual([]);
  });

  it('learns nothing from a profile you changed while Manus read it', async () => {
    await setVoiceLearn('p1', 'instagram', true);
    useStore.getState().updateProject('p1', (p) => ({ ...p, brand: { ...p.brand, socials: { ...p.brand.socials, instagram: '@crumb' } } }));
    manus.state = done(report());
    await refreshVoice('p1', 'instagram');
    expect(voiceOf('p1', 'instagram')?.report).toBeUndefined();
    expect(voiceOf('p1', 'instagram')?.task?.message).toMatch(/profile has changed since/);
    expect(useStore.getState().skills).toEqual([]);
  });

  it('lists running reads, least recently checked first, for three days', async () => {
    await setVoiceLearn('p1', 'instagram', true);
    await setVoiceLearn('p1', 'facebook', true);
    useStore.getState().updateProject('p1', (p) => ({ ...p, brand: { ...p.brand, voiceFrom: { ...p.brand.voiceFrom, instagram: { ...p.brand.voiceFrom!.instagram!, task: { ...p.brand.voiceFrom!.instagram!.task!, checkedAt: 5 } } } } }));
    expect(runningVoiceReads()).toEqual([
      { projectId: 'p1', platform: 'instagram' },
      { projectId: 'p1', platform: 'facebook' },
    ]);
    expect(runningVoiceReads(Date.now() + 4 * 24 * 3600_000)).toEqual([]);
  });
});

describe('after a read', () => {
  const learnInstagram = async () => {
    await setVoiceLearn('p1', 'instagram', true);
    manus.state = done(report());
    await refreshVoice('p1', 'instagram');
  };

  it('turning it off switches the skill off and keeps it; on again costs nothing', async () => {
    await learnInstagram();
    expect(await setVoiceLearn('p1', 'instagram', false)).toBe('off');
    expect(voiceSkill('p1', 'instagram')?.enabled).toBe(false);
    expect(voiceOf('p1', 'instagram')).toMatchObject({ learn: false, postsRead: 15 });
    expect(await setVoiceLearn('p1', 'instagram', true)).toBe('reused');
    expect(voiceSkill('p1', 'instagram')?.enabled).toBe(true);
    expect(manus.created).toHaveLength(1);
  });

  it('writes the skill again from the last read if you deleted it', async () => {
    await learnInstagram();
    await setVoiceLearn('p1', 'instagram', false);
    useStore.getState().deleteSkill('skill_voice_p1_instagram');
    await setVoiceLearn('p1', 'instagram', true);
    expect(voiceSkill('p1', 'instagram')).toMatchObject({ enabled: true, source: 'social' });
    expect(manus.created).toHaveLength(1);
  });

  it('a new profile needs a new read', async () => {
    await learnInstagram();
    await setVoiceLearn('p1', 'instagram', false);
    useStore.getState().updateProject('p1', (p) => ({ ...p, brand: { ...p.brand, socials: { ...p.brand.socials, instagram: '@crumb' } } }));
    expect(await setVoiceLearn('p1', 'instagram', true)).toBe('started');
    expect(manus.created[1].prompt).toContain('https://www.instagram.com/crumb/');
  });

  it('shares the emoji rule only while the learned profiles agree', async () => {
    await learnInstagram();
    await setVoiceLearn('p1', 'facebook', true);
    manus.state = done(report('many'));
    await refreshVoice('p1', 'facebook');
    expect(voiceSkill('p1', 'instagram')?.directives.emoji).toBeUndefined();
    expect(voiceSkill('p1', 'facebook')?.directives.emoji).toBeUndefined();
    // Facebook off: Instagram's own use is the rule again
    await setVoiceLearn('p1', 'facebook', false);
    expect(voiceSkill('p1', 'instagram')?.directives.emoji).toBe('light');
    expect(voiceSkillEdited('p1', 'instagram')).toBe(false);
  });

  it('leaves a skill you edited alone, until you choose the new read', async () => {
    await learnInstagram();
    useStore.getState().updateSkill('skill_voice_p1_instagram', { instructions: 'My own words.' });
    expect(voiceSkillEdited('p1', 'instagram')).toBe(true);
    await readVoice('p1', 'instagram');
    manus.state = done(report('none'));
    await refreshVoice('p1', 'instagram');
    expect(voiceSkill('p1', 'instagram')?.instructions).toBe('My own words.');
    expect(voiceOf('p1', 'instagram')).toMatchObject({ keptEdits: true, report: { emoji: { level: 'none' } } });
    applyLatestVoiceRead('p1', 'instagram');
    expect(voiceSkill('p1', 'instagram')?.instructions).toMatch(/^How Copper & Crumb writes on Instagram/);
    expect(voiceSkill('p1', 'instagram')?.directives.emoji).toBe('none');
    expect(voiceOf('p1', 'instagram')?.keptEdits).toBeUndefined();
  });

  it('replaces your edits when you agreed to', async () => {
    await learnInstagram();
    useStore.getState().updateSkill('skill_voice_p1_instagram', { instructions: 'My own words.' });
    await readVoice('p1', 'instagram', { replace: true });
    manus.state = done(report());
    await refreshVoice('p1', 'instagram');
    expect(voiceSkill('p1', 'instagram')?.instructions).toMatch(/^How Copper & Crumb writes/);
  });

  it('goes with its project', async () => {
    await learnInstagram();
    useStore.getState().addSkill({ ...voiceSkill('p1', 'instagram')!, id: 'shared', projectId: undefined });
    useStore.getState().deleteProject('p1');
    expect(useStore.getState().skills.map((k) => k.id)).toEqual(['shared']);
  });
});
