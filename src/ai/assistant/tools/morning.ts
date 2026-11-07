// Today's action (the Dashboard's morning card) for the assistant: read it, and mark it done when the owner says
// they did it. Neither tool ever makes an action (only the Dashboard visit after 5 am or the owner's "Get today's
// action" does), and neither posts, sends or buys anything. In the claude.ai build, without accounts or as a guest
// they use the built-in version kept on this device (src/lib/morning/local.ts): no request.

import type { MorningAction, MorningToday } from '@/lib/integrations/types';
import { getMorningToday } from '@/lib/integrations/api';
import { useAuth } from '@/lib/cloud/auth';
import { projectTimeZone } from '@/lib/timeZone';
import { morningModeOf, useMorningConfig, type MorningMode } from '@/lib/morning/config';
import { localFeedback, localMorning } from '@/lib/morning/local';
import { actionDayOf } from '@/lib/morning/localTime';
import { targetPage } from '@/lib/morning/targets';
import { entryOf, useMorningStore } from '@/store/morning';
import { useStore } from '@/store/useStore';
import { defineTool, type AnyTool } from '../registry';

const modeNow = (): MorningMode => morningModeOf(useAuth.getState().phase, useMorningConfig.getState().config);

const projectOf = (id: string) => useStore.getState().projects.find((p) => p.id === id) ?? null;

/** Today's state for the turn's business: the built-in one, the card's last answer, or a read (never a generation). */
async function todayFor(projectId: string): Promise<{ mode: MorningMode; today: MorningToday | null; locked: string | null }> {
  const mode = modeNow();
  const project = projectOf(projectId);
  if (!project || mode === 'off') return { mode, today: null, locked: null };
  if (mode === 'local') {
    const s = useStore.getState();
    return { mode, today: localMorning(project, { posts: s.posts, ads: s.ads, myListings: s.myListings, now: Date.now() }), locked: null };
  }
  const e = entryOf(useMorningStore.getState(), projectId);
  const tz = projectTimeZone(project);
  if (e.today && e.today.actionDay === actionDayOf(Date.now(), e.today.timeZone)) return { mode, today: e.today, locked: e.locked };
  const today = await getMorningToday(projectId, tz);
  return { mode, today, locked: today.plan === 'paused' ? today.planCode ?? 'PLAN_REQUIRED' : null };
}

const from = (mode: MorningMode, a: MorningAction) => (mode === 'local' ? 'built in' : a.engine === 'ai' ? 'AI pick' : 'your plan');

const getTodaysAction = defineTool({
  name: 'get_todays_action',
  class: 'R',
  summary: 'Today’s action for this business (the Dashboard card, made by about 5 am in its time zone): its title, why, where its Do it button goes, and whether it’s done. Never makes one.',
  args: {},
  run: async (_a, ctx) => {
    let r;
    try {
      r = await todayFor(ctx.projectId);
    } catch (e) {
      return { ok: false, error: (e as Error)?.message || 'Couldn’t read today’s action.', note: 'Couldn’t read today’s action' };
    }
    const { mode, today, locked } = r;
    if (mode === 'off' || !today) return { data: { none: true, why: 'The morning action isn’t on here.' }, note: 'Looked at today’s action' };
    if (locked) return { data: { none: true, why: 'needs a plan' }, note: 'Looked at today’s action' };
    const a = today.action;
    if (!a) return { data: { none: true, why: today.late ? 'before 5 am' : 'not made yet: the Dashboard card makes it' }, note: 'Looked at today’s action' };
    if (a.state === 'generating') return { data: { none: true, why: 'being made now: it shows on the Dashboard in a moment' }, note: 'Looked at today’s action' };
    if (a.state === 'failed') return { data: { none: true, why: 'it didn’t come through: “Get today’s action” on the Dashboard tries again' }, note: 'Looked at today’s action' };
    const c = a.chosen != null ? a.candidates[a.chosen] : undefined;
    if (!c) return { data: { none: true, why: 'nothing new for today' }, note: 'Looked at today’s action' };
    const marked = new Set([...a.feedback.map((f) => f.i), a.chosen]);
    return {
      data: {
        date: a.localDate,
        state: a.state,
        title: c.title,
        why: c.why,
        kind: c.kind,
        page: targetPage(c),
        from: from(mode, a),
        ideasLeft: a.state === 'ready' ? a.candidates.filter((_x, i) => !marked.has(i)).length : 0,
        done: a.state === 'done',
      },
      note: 'Looked at today’s action',
    };
  },
});

const markTodaysActionDone = defineTool({
  name: 'mark_todays_action_done',
  class: 'L',
  summary: 'Mark today’s action done, only when the owner says they did it (the card shows Done; Undo is on the card).',
  args: {},
  validate: () => (modeNow() === 'off' ? 'The morning action isn’t on here.' : null),
  run: async (_a, ctx) => {
    const project = projectOf(ctx.projectId);
    if (!project) return { ok: false, error: 'That business isn’t open.' };
    let r;
    try {
      r = await todayFor(ctx.projectId);
    } catch (e) {
      return { ok: false, error: (e as Error)?.message || 'Couldn’t read today’s action.' };
    }
    const a = r.today?.action;
    if (!a || a.state !== 'ready' || a.chosen == null) return { ok: false, error: a?.state === 'done' ? 'Today’s action is already done.' : 'There’s no action for today to mark done.' };
    if (r.mode === 'local') {
      const out = localFeedback(project, 'done');
      return out?.state === 'done' ? { data: { done: true }, note: 'Marked today’s action done' } : { ok: false, error: 'Couldn’t mark it done.' };
    }
    const store = useMorningStore.getState();
    if (!entryOf(store, ctx.projectId).today) useMorningStore.setState((s) => ({ byProject: { ...s.byProject, [ctx.projectId]: { ...entryOf(s, ctx.projectId), today: r.today } } }));
    const ok = await store.feedback(ctx.projectId, a.id, 'done');
    if (!ok) return { ok: false, error: entryOf(useMorningStore.getState(), ctx.projectId).error || 'Couldn’t mark it done.' };
    return { data: { done: true }, note: 'Marked today’s action done' };
  },
});

export const morningTools: AnyTool[] = [getTodaysAction, markTodaysActionDone];
