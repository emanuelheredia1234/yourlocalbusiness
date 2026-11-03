// The "Learn my brand voice" switch next to each social profile: starting Manus's read of the profile's posts
// (ai/manusVoice.ts) and turning what it reports into that project's Brain skill. Each profile keeps its own
// switch, read and skill in brand.voiceFrom[platform]. A read is a one-shot Manus task: nothing here starts one
// again by itself.

import type { Directives, Project, Skill, SocialPlatform, SocialVoice } from '@/lib/types';
import { newSkill } from '@/ai/brain';
import { buildVoiceSkill, profileTarget, refreshVoiceRead, sameProfile, sharedEmoji, skillFingerprint, startVoiceRead, voiceNetworkName, voiceSkillId, voiceSkillName, voiceSummary } from '@/ai/manusVoice';
import { beginBusy, endBusy } from '@/lib/busy';
import { navigate } from '@/lib/router';
import { useStore } from './useStore';
import { toast } from './ui';

const keyOf = (projectId: string, platform: SocialPlatform) => `${projectId}:${platform}`;
/** Reads being handed to Manus right now (outside any component, so two clicks or two open editors can't start two). */
const starting = new Set<string>();
export const isStartingVoiceRead = (projectId: string, platform: SocialPlatform) => starting.has(keyOf(projectId, platform));

const projectOf = (projectId: string): Project | undefined => useStore.getState().projects.find((p) => p.id === projectId);

export function voiceOf(projectId: string, platform: SocialPlatform): SocialVoice | undefined {
  return projectOf(projectId)?.brand.voiceFrom?.[platform];
}

/** Manus is still on it (or waiting for you). */
export const voiceReadRunning = (v?: SocialVoice): boolean => !!v?.task && (v.task.state === 'working' || v.task.state === 'needs_input');

/** The profile as the app shows it ("@sparkle", "“Sparkle Bakery”"). */
export function profileLabel(platform: SocialPlatform, raw: string | undefined): string {
  const t = profileTarget(platform, raw);
  return t && !('error' in t) ? t.label : (raw ?? '').trim();
}

/** Change one profile's record on its own project: a read can finish while another project is open. */
function patchVoice(projectId: string, platform: SocialPlatform, fn: (v: SocialVoice) => SocialVoice): void {
  useStore.getState().updateProject(projectId, (p) => ({ ...p, brand: { ...p.brand, voiceFrom: { ...p.brand.voiceFrom, [platform]: fn(p.brand.voiceFrom?.[platform] ?? { learn: false }) } } }));
}

/** The learned skill: by the id kept with the profile, or its fixed id (when another device made it first). */
function skillOf(projectId: string, platform: SocialPlatform, v?: SocialVoice): Skill | undefined {
  const skills = useStore.getState().skills;
  return (v?.skillId ? skills.find((k) => k.id === v.skillId) : undefined) ?? skills.find((k) => k.id === voiceSkillId(projectId, platform));
}

export function voiceSkill(projectId: string, platform: SocialPlatform): Skill | undefined {
  return skillOf(projectId, platform, voiceOf(projectId, platform));
}

/** Whether you changed the learned skill after the app wrote it: the app then leaves it alone, and asks before replacing it. */
export function voiceSkillEdited(projectId: string, platform: SocialPlatform): boolean {
  const v = voiceOf(projectId, platform);
  const skill = skillOf(projectId, platform, v);
  return !!skill && !!v?.written && skillFingerprint(skill) !== v.written;
}

/** The emoji rule the project's switched-on learned voices share (none when they differ). */
function sharedEmojiOf(project: Project): Directives['emoji'] {
  const on = Object.values(project.brand.voiceFrom ?? {}).filter((v): v is SocialVoice => !!v?.learn && !!v.report);
  return sharedEmoji(on.map((v) => v.report!.emoji.level));
}

/** (Re)write the profile's skill from its last read, on or off with its switch. */
function writeSkill(projectId: string, platform: SocialPlatform): void {
  const s = useStore.getState();
  const project = projectOf(projectId);
  const v = project?.brand.voiceFrom?.[platform];
  if (!project || !v?.report) return;
  const built = buildVoiceSkill({
    report: v.report,
    platform,
    projectId,
    profileLabel: profileLabel(platform, v.profile),
    brandName: project.brand.name,
    postsRead: v.postsRead,
    analyzedAt: v.analyzedAt ?? Date.now(),
    emoji: v.learn ? sharedEmojiOf(project) : undefined,
  });
  const existing = skillOf(projectId, platform, v);
  const id = existing?.id ?? voiceSkillId(projectId, platform);
  if (existing) s.updateSkill(id, { ...built, enabled: v.learn });
  else s.addSkill({ ...newSkill(built), id, enabled: v.learn });
  patchVoice(projectId, platform, (x) => ({ ...x, skillId: id, written: skillFingerprint(built), keptEdits: undefined }));
}

/**
 * Keep the learned skills' shared emoji rule right after a switch changes or a read finishes (see sharedEmoji).
 * A skill you edited is yours: it's left alone.
 */
export function syncVoiceSkills(projectId: string): void {
  const s = useStore.getState();
  const project = projectOf(projectId);
  if (!project) return;
  const shared = sharedEmojiOf(project);
  for (const [platform, v] of Object.entries(project.brand.voiceFrom ?? {}) as [SocialPlatform, SocialVoice | undefined][]) {
    const skill = v && skillOf(projectId, platform, v);
    if (!v || !skill || !v.written || skillFingerprint(skill) !== v.written) continue;
    const emoji = v.learn ? shared : undefined;
    if (skill.directives.emoji === emoji) continue;
    const directives: Directives = { ...skill.directives, emoji };
    if (!emoji) delete directives.emoji;
    s.updateSkill(skill.id, { directives });
    patchVoice(projectId, platform, (x) => ({ ...x, written: skillFingerprint({ ...skill, directives }) }));
  }
}

/**
 * Ask Manus to read the profile's latest posts: one Manus task (read only). `replace`: you agreed to replace your
 * edits to the learned skill with what it finds. Throws the reason it couldn't start; never retried by itself.
 */
export async function readVoice(projectId: string, platform: SocialPlatform, o: { replace?: boolean } = {}): Promise<void> {
  const k = keyOf(projectId, platform);
  const project = projectOf(projectId);
  if (!project || starting.has(k) || voiceReadRunning(project.brand.voiceFrom?.[platform])) return;
  starting.add(k);
  beginBusy(`manus-voice:${k}`, 'Sending to Manus', 'app');
  try {
    const task = await startVoiceRead({ platform, profile: project.brand.socials[platform] ?? '', brandName: project.brand.name, replace: o.replace });
    patchVoice(projectId, platform, (x) => ({ ...x, learn: true, task }));
  } finally {
    starting.delete(k);
    endBusy(`manus-voice:${k}`);
  }
}

/**
 * The switch next to a profile. On: use what Manus learned from it, reading the profile first when nothing was
 * learned from it yet (one Manus task). Off: its skill is switched off and kept, so turning it back on costs
 * nothing. A read that's running carries on either way. Throws the reason a read couldn't start (the switch
 * then stays off).
 */
export async function setVoiceLearn(projectId: string, platform: SocialPlatform, on: boolean): Promise<'off' | 'reading' | 'reused' | 'started'> {
  const s = useStore.getState();
  const project = projectOf(projectId);
  if (!project) return 'off';
  const v = project.brand.voiceFrom?.[platform];
  const skill = skillOf(projectId, platform, v);
  if (!on) {
    patchVoice(projectId, platform, (x) => ({ ...x, learn: false }));
    if (skill?.enabled) s.updateSkill(skill.id, { enabled: false });
    syncVoiceSkills(projectId);
    return 'off';
  }
  patchVoice(projectId, platform, (x) => ({ ...x, learn: true }));
  if (voiceReadRunning(v)) return 'reading';
  if (v?.report && sameProfile(platform, v.profile, project.brand.socials[platform])) {
    if (skill) s.updateSkill(skill.id, { enabled: true });
    else writeSkill(projectId, platform);
    syncVoiceSkills(projectId);
    return 'reused';
  }
  try {
    await readVoice(projectId, platform);
  } catch (e) {
    patchVoice(projectId, platform, (x) => ({ ...x, learn: false }));
    throw e;
  }
  return 'started';
}

/** After a read finished while you'd edited the skill: replace your edited skill with what Manus found. */
export function applyLatestVoiceRead(projectId: string, platform: SocialPlatform): void {
  writeSkill(projectId, platform);
  syncVoiceSkills(projectId);
}

const openUrl = (url: string) => {
  if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener,noreferrer');
};

/** Check a read Manus is doing, and use what it found once it's done. */
export async function refreshVoice(projectId: string, platform: SocialPlatform): Promise<void> {
  const before = voiceOf(projectId, platform);
  if (!before?.task) return;
  const { task, report, postsRead } = await refreshVoiceRead(before.task, platform);
  const v = voiceOf(projectId, platform);
  const project = projectOf(projectId);
  // the project is gone, or a newer read replaced this one meanwhile
  if (!project || !v?.task || v.task.taskId !== task.taskId) return;
  const s = useStore.getState();
  const name = voiceNetworkName(platform);
  const changed = task.state !== v.task.state;
  const open = { label: 'Open in Manus', run: () => openUrl(task.taskUrl) };

  if (task.state === 'done' && report) {
    // already used (a second check of the same finished read)
    if (!changed) {
      patchVoice(projectId, platform, (x) => ({ ...x, task: { ...x.task!, checkedAt: task.checkedAt } }));
      return;
    }
    if (!sameProfile(platform, task.profile, project.brand.socials[platform])) {
      // you changed the profile while Manus read the old one: that voice isn't this profile's
      patchVoice(projectId, platform, (x) => ({ ...x, task: { ...task, message: `Manus read ${profileLabel(platform, task.profile)}, but the profile has changed since. Analyze the new one to learn from it.` } }));
      toast({ kind: 'info', title: `Manus read your old ${name} profile`, body: 'The profile changed while Manus was reading, so nothing was learned from it. Analyze the new one next to the profile.' });
      return;
    }
    const edited = voiceSkillEdited(projectId, platform);
    patchVoice(projectId, platform, (x) => ({ ...x, task, report, profile: task.profile, postsRead, analyzedAt: Date.now() }));
    if (edited && !task.replace) patchVoice(projectId, platform, (x) => ({ ...x, keptEdits: true }));
    else writeSkill(projectId, platform);
    syncVoiceSkills(projectId);
    const learn = !!voiceOf(projectId, platform)?.learn;
    // the Brain page opens once setup is done
    const brain = project.onboarded ? { label: 'Open the Brain', run: () => void navigate('brain') } : undefined;
    if (edited && !task.replace) {
      toast({ kind: 'info', title: `Manus read your ${name} posts again`, body: 'You had edited its Brain skill, so it was left as it was. You can still use the new read: see the profile.', action: open });
    } else if (learn) {
      const body = s.settings.ai.useBrain ? `New posts, captions, emails and pages now continue it (Brain: “${voiceSkillName(platform)}”).` : 'The Brain is off, so nothing uses it yet: turn the Brain on to continue this voice.';
      toast({ kind: 'success', title: `Manus learned your ${name} voice`, body, action: brain });
    } else {
      toast({ kind: 'info', title: `Manus read your ${name} posts`, body: 'Turn on “Learn my brand voice” for that profile to use it.', action: brain });
    }
    s.notify({ kind: 'ai', title: `Brand voice read from ${name}`, body: voiceSummary(report) || `${postsRead ?? 'Recent'} posts read.`, route: 'brain' });
    return;
  }

  patchVoice(projectId, platform, (x) => ({ ...x, task }));
  if (!changed) return;
  if (task.state === 'needs_input') {
    toast({ kind: 'info', title: 'Manus needs you', body: task.message, action: open });
    s.notify({ kind: 'info', title: `Manus needs you to read your ${name} posts`, body: task.message, route: 'workspace-settings' });
  } else if (task.state === 'failed') {
    toast({ kind: 'error', title: `Couldn’t read your ${name} posts`, body: task.message, action: open });
  } else if (task.state === 'finished') {
    toast({ kind: 'info', title: 'Manus finished without a report', body: `Open the task to see what it found about your ${name} posts, then analyze again.`, action: open });
  }
}

const HORIZON = 3 * 24 * 3600_000;

/** The reads Manus is still doing, in every project, least recently checked first (for the watcher). */
export function runningVoiceReads(now = Date.now()): { projectId: string; platform: SocialPlatform }[] {
  const out: { projectId: string; platform: SocialPlatform; checkedAt: number }[] = [];
  for (const p of useStore.getState().projects) {
    for (const [platform, v] of Object.entries(p.brand.voiceFrom ?? {}) as [SocialPlatform, SocialVoice | undefined][]) {
      if (v?.task && voiceReadRunning(v) && now - v.task.requestedAt < HORIZON) out.push({ projectId: p.id, platform, checkedAt: v.task.checkedAt });
    }
  }
  return out.sort((a, b) => a.checkedAt - b.checkedAt).map(({ projectId, platform }) => ({ projectId, platform }));
}
