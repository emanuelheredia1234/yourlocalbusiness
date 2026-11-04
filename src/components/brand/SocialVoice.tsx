// "Learn my brand voice from these posts": the switch under each social profile (onboarding and Settings), what
// Manus is doing or found, and the watcher that picks up finished reads while the app is open.
import { useEffect, useState } from 'react';
import { CheckCircle2, CircleAlert, ExternalLink, Hand, Loader2, RefreshCw } from 'lucide-react';
import type { SocialPlatform, VoiceReport } from '@/lib/types';
import { cn, fmtDate, fmtRelative } from '@/lib/utils';
import { navigate } from '@/lib/router';
import { VOICE_POSTS, profileTarget, sameProfile, voiceNetworkName, voiceSkillName, voiceSummary } from '@/ai/manusVoice';
import { useStore } from '@/store/useStore';
import { toast, useUI } from '@/store/ui';
import { applyLatestVoiceRead, isStartingVoiceRead, profileLabel, readVoice, refreshVoice, runningVoiceReads, setVoiceLearn, voiceReadRunning, voiceSkillEdited } from '@/store/voice';
import { Spinner, Toggle, confirmAction } from '../ui/primitives';
import { errorCopy, manusSetupHint, useCanOfferManus, useManusReady } from '../posts/ManusPost';

type ErrorCopy = { title: string; body: string; uncertain?: boolean };

/** Why a read couldn't start. A read never posts, so an uncertain start can only cost credits twice, not post twice. */
export function voiceErrorCopy(e: unknown): ErrorCopy {
  const c = errorCopy(e);
  return c.uncertain ? { title: 'Not sure the read started', body: 'The connection dropped while starting it, so Manus may be reading anyway. Check your Manus tasks before trying again: another read uses more credits.', uncertain: true } : c;
}

const linkCls = 'inline-flex items-center gap-1 font-semibold text-primary hover:underline disabled:opacity-60';

/** The switch and status under one profile. */
export function VoiceSwitch({ projectId, platform }: { projectId: string; platform: SocialPlatform }) {
  const raw = useStore((s) => s.projects.find((p) => p.id === projectId)?.brand.socials[platform] ?? '');
  const voice = useStore((s) => s.projects.find((p) => p.id === projectId)?.brand.voiceFrom?.[platform]);
  const skill = useStore((s) => (voice?.skillId ? s.skills.find((k) => k.id === voice.skillId) : undefined));
  const useBrain = useStore((s) => s.settings.ai.useBrain);
  // the Brain page opens once setup is done
  const onboarded = useStore((s) => !!s.projects.find((p) => p.id === projectId)?.onboarded);
  const offer = useCanOfferManus();
  const ready = useManusReady();
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [err, setErr] = useState<ErrorCopy | null>(null);
  // a new profile, a new start: an old error no longer applies
  useEffect(() => setErr(null), [raw]);

  const name = voiceNetworkName(platform);
  const target = profileTarget(platform, raw);
  const valid = !!target && !('error' in target);
  const on = !!voice?.learn;
  const report = voice?.report;
  const task = voice?.task;
  const running = voiceReadRunning(voice);
  const starting = busy || isStartingVoiceRead(projectId, platform);
  const sameAsRead = !!report && valid && sameProfile(platform, voice?.profile, raw);
  // the last read finished on a profile you've changed since, so nothing was learned from it
  const dropped = task?.state === 'done' && (!report || !sameProfile(platform, task.profile, voice?.profile));
  // turning it back on for the profile Manus already read costs nothing, so it doesn't need Manus
  const canTurnOn = valid && !starting && (ready || sameAsRead || running);
  const canAnalyze = on && valid && ready && !running && !starting;
  if (!offer && !on && !report) return null;
  // nothing to read yet: the switch shows once there's a profile (the note under the profiles explains it)
  if (!raw.trim() && !on && !report && !task) return null;

  const toggle = async (next: boolean) => {
    setErr(null);
    if (next && !canTurnOn) return;
    setBusy(true);
    try {
      const r = await setVoiceLearn(projectId, platform, next);
      if (r === 'started') toast({ kind: 'info', title: `Manus is reading your ${name} posts`, body: 'It only reads, and it usually takes a few minutes. The profile shows its progress.' });
      else if (r === 'reused') toast({ kind: 'success', title: `Your ${name} voice is back on`, body: 'What Manus learned from this profile applies again.' });
    } catch (e) {
      setErr(voiceErrorCopy(e));
    } finally {
      setBusy(false);
    }
  };

  const analyze = async () => {
    setErr(null);
    let replace = false;
    if (voiceSkillEdited(projectId, platform)) {
      const ok = await confirmAction({ title: 'Replace your edits?', body: `You edited “${voiceSkillName(platform)}” in the Brain. Analyzing again replaces it with what Manus finds now.`, confirmLabel: 'Analyze and replace' });
      if (!ok) return;
      replace = true;
    }
    setBusy(true);
    try {
      await readVoice(projectId, platform, { replace });
      toast({ kind: 'info', title: `Manus is reading your ${name} posts again`, body: 'It only reads, and it usually takes a few minutes.' });
    } catch (e) {
      setErr(voiceErrorCopy(e));
    } finally {
      setBusy(false);
    }
  };

  const check = async () => {
    setChecking(true);
    try {
      await refreshVoice(projectId, platform);
    } catch (e) {
      toast({ kind: 'error', ...errorCopy(e) });
    } finally {
      setChecking(false);
    }
  };

  const replaceWithNewRead = async () => {
    if (await confirmAction({ title: 'Use the new read?', body: `It replaces your edited “${voiceSkillName(platform)}” skill with what Manus found this time.`, confirmLabel: 'Replace my skill' })) applyLatestVoiceRead(projectId, platform);
  };

  const taskLink = (label: string) =>
    task?.taskUrl ? (
      <a href={task.taskUrl} target="_blank" rel="noopener noreferrer" className={linkCls}>
        {label} <ExternalLink size={11} />
      </a>
    ) : null;
  const checkButton = (
    <button type="button" className={linkCls} onClick={check} disabled={checking}>
      <RefreshCw size={11} className={cn(checking && 'animate-spin')} /> Check now
    </button>
  );
  const analyzeButton = (label: string) =>
    canAnalyze ? (
      <button type="button" className={linkCls} onClick={analyze}>
        {label}
      </button>
    ) : null;

  return (
    <div className="mt-2 flex flex-col gap-1.5 text-[12px]">
      <Toggle
        checked={on}
        disabled={on ? starting : !canTurnOn}
        onChange={toggle}
        label={
          <span className="text-[12.5px] font-medium">
            Learn my brand voice from these posts<span className="sr-only"> ({name})</span>
          </span>
        }
      />
      {target && 'error' in target && <p className="font-medium text-warn">{target.error}</p>}
      {starting && (
        <p className="flex items-center gap-1.5 text-info">
          <Spinner size={12} /> Starting the Manus task…
        </p>
      )}
      {err && (
        <div className="rounded-md border border-bad/30 bg-bad-soft px-2.5 py-1.5" role="alert">
          <p className="font-semibold text-bad">{err.title}</p>
          <p className="text-ink-2">{err.body}</p>
        </div>
      )}
      {task && running && (
        <div role="status" className={cn('rounded-md px-2.5 py-1.5', task.state === 'needs_input' ? 'bg-warn/15 text-warn' : 'bg-info/10 text-info')}>
          <p className="flex items-center gap-1.5 font-semibold">
            {task.state === 'needs_input' ? <Hand size={12} /> : <Loader2 size={12} className="animate-spin" />}
            {task.state === 'needs_input' ? 'Manus needs you' : `Manus is reading your ${name} posts`}
          </p>
          {task.state === 'needs_input' && task.message && <p className="mt-0.5 break-words text-ink-2">{task.message}</p>}
          <p className="mt-1 flex flex-wrap items-center gap-3">
            {taskLink(task.state === 'needs_input' ? 'Open in Manus' : 'Watch in Manus')}
            {checkButton}
            <span className="text-muted">Checked {fmtRelative(task.checkedAt)}</span>
          </p>
        </div>
      )}
      {task && !running && (task.state === 'failed' || task.state === 'finished') && (
        <div role="status" className="rounded-md bg-bad-soft px-2.5 py-1.5">
          <p className="flex items-center gap-1.5 font-semibold text-bad">
            <CircleAlert size={12} /> {task.state === 'failed' ? `Couldn’t read the ${name} posts` : 'Manus finished without a report'}
          </p>
          {task.message && <p className="mt-0.5 break-words text-ink-2">{task.message}</p>}
          <p className="mt-1 flex flex-wrap items-center gap-3">
            {taskLink('Open in Manus')}
            {task.state === 'finished' && checkButton}
            {analyzeButton('Try again')}
          </p>
          {report && <p className="mt-1 text-muted">{on ? 'Still using' : 'Kept'} what Manus learned on {fmtDate(voice?.analyzedAt ?? Date.now())}.</p>}
        </div>
      )}
      {dropped && <p className="text-warn">{task.message}</p>}
      {report && (
        <div role="status" className="rounded-md border border-line px-2.5 py-1.5">
          <p className="flex items-center gap-1.5 font-semibold text-ink">
            <CheckCircle2 size={12} className={on ? 'text-good' : 'text-muted'} />
            {on ? 'Learned' : 'Read'} from {voice?.postsRead ? `${voice.postsRead} posts` : 'recent posts'} by {profileLabel(platform, voice?.profile)} · {fmtRelative(voice?.analyzedAt ?? Date.now())}
          </p>
          {!on && <p className="text-muted">Not used while this is off.</p>}
          {voiceSummary(report) && <p className="mt-0.5 text-ink-2">{voiceSummary(report)}</p>}
          <VoiceDetails report={report} />
          {voice?.keptEdits && (
            <p className="mt-1 text-warn">
              Manus read the posts again, but you had edited the skill, so it was left as you had it.{' '}
              <button type="button" className={linkCls} onClick={replaceWithNewRead}>
                Use the new read
              </button>
            </p>
          )}
          {on && skill && !skill.enabled && (
            <p className="mt-1 text-warn">
              Its Brain skill is switched off.{' '}
              <button type="button" className={linkCls} onClick={() => useStore.getState().updateSkill(skill.id, { enabled: true })}>
                Turn it on
              </button>
            </p>
          )}
          {on && !useBrain && <p className="mt-1 text-warn">The Brain is off, so nothing uses this voice until you turn the Brain on.</p>}
          {report && valid && !sameAsRead && <p className="mt-1 text-warn">This profile changed since Manus read {profileLabel(platform, voice?.profile)}.</p>}
          <p className="mt-1 flex flex-wrap items-center gap-3">
            {skill && onboarded && (
              <button type="button" className={linkCls} onClick={() => void navigate('brain')}>
                View in Brain
              </button>
            )}
            {!running && analyzeButton(sameAsRead ? 'Analyze again' : 'Analyze the new profile')}
          </p>
        </div>
      )}
      {on && !report && !task && !starting && (
        <p className="flex flex-wrap items-center gap-2 text-muted">
          Not analyzed yet. {analyzeButton('Analyze my posts')}
        </p>
      )}
      {on && !raw.trim() && <p className="text-muted">Add the profile to analyze it again.</p>}
    </div>
  );
}

/** Everything Manus reported, as the app kept it. */
function VoiceDetails({ report: r }: { report: VoiceReport }) {
  const rows: [string, string][] = [
    ['Tone', [r.adjectives.join(', '), r.tone && !r.adjectives.includes(r.tone) ? `(${r.tone})` : ''].filter(Boolean).join(' ')],
    ['Speaks as', r.person ? (r.person === 'i' ? '“I”' : `“${r.person}”`) : ''],
    ['Phrases', r.words.map((w) => `“${w}”`).join(', ')],
    ['Openings', r.openings],
    ['Closings', r.endings],
    ['Emoji', [r.emoji.level, r.emoji.list.join(' ')].filter(Boolean).join(': ')],
    ['Hashtags', [r.hashtags.level, r.hashtags.list.join(' ')].filter(Boolean).join(': ')],
    ['Length', [r.length.level, r.length.structure].filter(Boolean).join(': ')],
    ['Topics', r.topics.join('; ')],
    ['Look', r.visuals],
  ];
  const shown = rows.filter(([, v]) => v);
  if (!shown.length && !r.examples.length) return null;
  return (
    <details className="mt-1">
      <summary className="cursor-pointer font-semibold text-primary">What Manus learned</summary>
      <dl className="mt-1 flex flex-col gap-0.5 text-ink-2">
        {shown.map(([k, v]) => (
          <div key={k}>
            <dt className="inline font-semibold text-ink">{k}: </dt>
            <dd className="inline break-words">{v}</dd>
          </div>
        ))}
      </dl>
      {r.examples.length > 0 && (
        <>
          <p className="mt-1.5 font-semibold text-ink">New example captions in this voice (written by Manus, style only)</p>
          <ul className="mt-0.5 flex list-disc flex-col gap-0.5 pl-4 text-ink-2">
            {r.examples.map((x) => (
              <li key={x} className="break-words">
                {x}
              </li>
            ))}
          </ul>
        </>
      )}
    </details>
  );
}

/**
 * What the switches do, once under the profiles, and what's missing when Manus isn't set up.
 * setup: 'button' adds "Open Settings → AI" (Settings → Brand); 'none' when the page already says it (Social accounts).
 */
export function VoiceNote({ projectId, setup = 'text' }: { projectId: string; setup?: 'button' | 'text' | 'none' }) {
  const offer = useCanOfferManus();
  const ready = useManusReady();
  const anyOn = useStore((s) => Object.values(s.projects.find((p) => p.id === projectId)?.brand.voiceFrom ?? {}).some((v) => v?.learn));
  if (!offer && !anyOn) return null;
  return (
    <div className="flex flex-col gap-2 text-[12.5px]">
      <p className="text-muted">
        <b className="font-semibold text-ink-2">Learn my brand voice:</b> turn it on under a profile you added, and Manus opens that profile in its own browser and reads its {VOICE_POSTS} latest posts. It only reads: it never posts, likes, follows, comments or messages. Each profile is one Manus task, on your Manus credits. What it learns becomes a Brain skill for this project, so new posts, captions, emails and pages continue that voice. Manus may ask you to sign in the first time.
      </p>
      {!ready && offer && setup !== 'none' && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-warn/40 bg-warn-soft px-3 py-2" role="alert">
          <p className="min-w-0 flex-1 font-medium text-warn">Manus can’t read your posts yet: it uses the same Manus setup as posting. {manusSetupHint()}</p>
          {setup === 'button' && !__ARTIFACT_BUILD__ && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => useUI.getState().setSettingsTab('ai')}>
              Open Settings → AI
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Checks the reads Manus is still doing, every 45 seconds while the app is open (in every project). */
export function useVoiceReadWatcher() {
  useEffect(() => {
    let busy = false;
    let alive = true;
    const tick = async () => {
      if (busy || (typeof document !== 'undefined' && document.hidden)) return;
      const due = runningVoiceReads().slice(0, 3);
      if (!due.length) return;
      busy = true;
      try {
        for (const r of due) {
          if (!alive) return;
          try {
            await refreshVoice(r.projectId, r.platform);
          } catch {
            /* transient: try again on the next tick */
          }
        }
      } finally {
        busy = false;
      }
    };
    const first = setTimeout(tick, 5000);
    const t = setInterval(tick, 45_000);
    return () => {
      alive = false;
      clearTimeout(first);
      clearInterval(t);
    };
  }, []);
}
