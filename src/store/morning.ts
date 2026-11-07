// The morning action as the server last said, per business (memory only: the server is the record, nothing here is
// saved to the workspace or synced). Keyed by project id, so a slow answer for business A never shows on business B;
// another account (or signing out) drops everything.
//
//   load(projectId, timeZone)     GET today's state (sends the business's zone). When the answer is due with no action
//                                 yet and this tab hasn't started that business's day, start('visit') once. Never for
//                                 an existing row, so never for a failed one: only the owner's button re-runs that.
//   start(projectId, mode, tz)    POST: 402 → locked (the upgrade prompt opens only from the card's own button); 409
//                                 NOT_DUE → the next time; 429 → "Try again in a few minutes."; network → plain words.
//   feedback(...)                 Done, Undo, Not useful: the answer replaces the action.
//
// While a row is generating the store asks again every 3 s for up to 90 s, then stops with "Still working on it." In
// local mode (the claude.ai build, accounts off, a guest) the card uses src/lib/morning/local.ts and nothing here
// makes a request.

import { create } from 'zustand';
import { IntegrationApiError, getMorningToday, sendMorningFeedback, startMorning } from '@/lib/integrations/api';
import type { MorningAction, MorningReason, MorningToday, MorningVerdict } from '@/lib/integrations/types';
import { MORNING } from '@/lib/morning/contract';

export const POLL_MS = 3_000;
export const POLL_FOR_MS = 90_000;
export const STILL_WORKING = 'Still working on it. Check back in a minute.';
export const TRY_LATER = 'Try again in a few minutes.';

export interface MorningEntry {
  today: MorningToday | null;
  loading: boolean;
  starting: boolean;
  /** the last failure, in plain words ('' when none) */
  error: string;
  /** a short note under the card (429, polling gave up) */
  notice: string;
  /** the 402 code while the plan is paused (from a POST, or from GET's plan: 'paused') */
  locked: string | null;
  /** polling gave up on a generating row */
  stalled: boolean;
  at: number;
}

const EMPTY: MorningEntry = { today: null, loading: false, starting: false, error: '', notice: '', locked: null, stalled: false, at: 0 };

interface MorningStore {
  byProject: Record<string, MorningEntry>;
  load: (projectId: string, timeZone: string) => Promise<void>;
  start: (projectId: string, mode: 'visit' | 'manual', timeZone: string) => Promise<void>;
  feedback: (projectId: string, id: string, verdict: MorningVerdict, reason?: MorningReason, note?: string) => Promise<boolean>;
  /** a local (no-server) answer */
  setLocal: (projectId: string, today: MorningToday) => void;
  reset: () => void;
}

/** `projectId:actionDay` this tab already started by itself (once per business per day). */
const autoStarted = new Set<string>();
/** per business: the polling timer and when it began */
const polls = new Map<string, { timer: ReturnType<typeof setTimeout> | null; since: number }>();
/** per business: a counter, so an older answer never replaces a newer one */
const seq = new Map<string, number>();
/** bumped by reset: answers from before it are dropped */
let epoch = 0;

const next = (projectId: string) => {
  const n = (seq.get(projectId) ?? 0) + 1;
  seq.set(projectId, n);
  return n;
};

function stopPoll(projectId: string) {
  const p = polls.get(projectId);
  if (p?.timer) clearTimeout(p.timer);
  polls.delete(projectId);
}

/** An answer's action folded into today's state. */
function withAction(t: MorningToday | null, action: MorningAction | null): MorningToday | null {
  if (!t) return t;
  const left = action?.state === 'failed' ? Math.max(0, MORNING.maxAttempts - (action.attempts ?? 1)) : t.attemptsLeft;
  return { ...t, action, dueNow: action ? false : t.dueNow, attemptsLeft: left };
}

/** Plain words for a refusal or a failure (the server's sentences are ours; never a provider's). */
const words = (e: unknown, fallback: string) => (e instanceof IntegrationApiError ? e.message : fallback);

export const useMorningStore = create<MorningStore>((set, get) => {
  const patch = (projectId: string, p: Partial<MorningEntry>) => set((s) => ({ byProject: { ...s.byProject, [projectId]: { ...(s.byProject[projectId] ?? EMPTY), ...p } } }));

  /** Keep asking while the row is generating, up to 90 s; then a note and a Refresh link. */
  function watch(projectId: string, timeZone: string) {
    const action = get().byProject[projectId]?.today?.action;
    if (action?.state !== 'generating') {
      stopPoll(projectId);
      return;
    }
    const now = Date.now();
    const p = polls.get(projectId) ?? { timer: null, since: now };
    if (p.timer) return;
    if (now - p.since >= POLL_FOR_MS) {
      polls.delete(projectId);
      patch(projectId, { stalled: true, notice: STILL_WORKING });
      return;
    }
    p.timer = setTimeout(() => {
      p.timer = null;
      void get().load(projectId, timeZone);
    }, POLL_MS);
    polls.set(projectId, p);
  }

  async function begin(projectId: string, mode: 'visit' | 'manual', timeZone: string) {
    next(projectId);
    const e0 = epoch;
    patch(projectId, { starting: true, error: '', notice: '', stalled: false });
    try {
      const { action } = await startMorning(projectId, mode, timeZone);
      if (e0 !== epoch) return;
      // a write's answer is the newest state: a read that was on its way is dropped
      next(projectId);
      const cur = get().byProject[projectId]?.today ?? null;
      patch(projectId, { starting: false, today: withAction(cur, action), at: Date.now() });
      stopPoll(projectId);
      watch(projectId, timeZone);
    } catch (e) {
      if (e0 !== epoch) return;
      const cur = get().byProject[projectId]?.today ?? null;
      if (e instanceof IntegrationApiError && e.status === 402) patch(projectId, { starting: false, locked: e.code });
      else if (e instanceof IntegrationApiError && e.code === 'NOT_DUE') patch(projectId, { starting: false, today: cur ? { ...cur, dueNow: false, late: true, nextAt: e.nextAt ?? cur.nextAt } : cur });
      else if (e instanceof IntegrationApiError && e.status === 429) {
        // no attempts left today: the card says "Try again tomorrow."
        const out = /tomorrow/i.test(e.message);
        patch(projectId, { starting: false, notice: out ? '' : TRY_LATER, today: out && cur ? { ...cur, attemptsLeft: 0 } : cur });
      } else patch(projectId, { starting: false, error: words(e, 'Couldn’t get today’s action. Check your connection and try again.') });
    }
  }

  return {
    byProject: {},

    load: async (projectId, timeZone) => {
      if (__ARTIFACT_BUILD__) return;
      const mine = next(projectId);
      const e0 = epoch;
      patch(projectId, { loading: true });
      try {
        const today = await getMorningToday(projectId, timeZone);
        if (e0 !== epoch || seq.get(projectId) !== mine) return;
        const was = get().byProject[projectId]?.notice ?? '';
        const working = today.action?.state === 'generating';
        const day = `${projectId}:${today.actionDay}`;
        // the first visit after 5 am makes the day's action: once per business per day in this tab, never for a row that exists
        const auto = today.dueNow && !today.action && !autoStarted.has(day) && !get().byProject[projectId]?.starting;
        patch(projectId, { today, loading: false, error: '', locked: today.plan === 'paused' ? today.planCode ?? 'PLAN_REQUIRED' : null, at: Date.now(), ...(auto ? { starting: true } : {}), ...(working ? {} : { stalled: false, notice: was === STILL_WORKING ? '' : was }) });
        if (auto) {
          autoStarted.add(day);
          await begin(projectId, 'visit', timeZone);
          return;
        }
        watch(projectId, timeZone);
      } catch (e) {
        if (e0 !== epoch || seq.get(projectId) !== mine) return;
        patch(projectId, { loading: false, error: words(e, 'Couldn’t load today’s action.') });
      }
    },

    start: async (projectId, mode, timeZone) => {
      if (__ARTIFACT_BUILD__ || get().byProject[projectId]?.starting) return;
      await begin(projectId, mode, timeZone);
    },

    feedback: async (projectId, id, verdict, reason, note) => {
      if (__ARTIFACT_BUILD__) return false;
      next(projectId);
      const e0 = epoch;
      try {
        const { action } = await sendMorningFeedback(id, verdict, reason, note);
        if (e0 !== epoch) return false;
        next(projectId);
        patch(projectId, { today: withAction(get().byProject[projectId]?.today ?? null, action), error: '' });
        return true;
      } catch (e) {
        if (e0 !== epoch) return false;
        patch(projectId, { error: words(e, 'Couldn’t save that. Try again.') });
        return false;
      }
    },

    setLocal: (projectId, today) => patch(projectId, { today, loading: false, error: '', locked: null, at: Date.now() }),

    reset: () => {
      epoch += 1;
      for (const id of [...polls.keys()]) stopPoll(id);
      autoStarted.clear();
      seq.clear();
      set({ byProject: {} });
    },
  };
});

/** A business's entry (an empty one before the first load). */
export const entryOf = (s: { byProject: Record<string, MorningEntry> }, projectId: string): MorningEntry => s.byProject[projectId] ?? EMPTY;
