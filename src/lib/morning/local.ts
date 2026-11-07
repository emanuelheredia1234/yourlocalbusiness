// The morning action made in this browser: the claude.ai build (no server at all) and the app without accounts or a
// guest. The same rule ids, keys and templates as the server (shared/morning.json), from what the browser knows:
// the Strategy plan with full derivedDone, due and planned posts, the page, lead magnet, emails, profiles and the
// habits; never leads, sales or analytics (server-only data). No request is made here, ever.
//
// Deterministic per action day: the day's candidates are kept per device in safeStorage (`ylb-morning:<projectId>`)
// with the chosen index, the verdicts, and the keys shown (7 days, shown last) or marked Not useful (30 days, never
// offered again).

import type { Post, Project } from '@/lib/types';
import type { MorningAction, MorningCandidate, MorningFeedback, MorningReason, MorningToday, MorningVerdict } from '@/lib/integrations/types';
import { currentWeek, readStrategy, strategyNextSteps, type ActionCtx } from '@/lib/strategy';
import { projectTimeZone } from '@/lib/timeZone';
import { safeStorage } from '@/lib/storage';
import { MORNING, fill, morningKey } from './contract';
import { actionDayOf, daysBetween, isLate, localDateOf, nextMorningAt } from './localTime';

const T = MORNING.rules;
const L = MORNING.limits;
const DAY_MS = 86_400_000;

const clip = (v: unknown, n: number) =>
  typeof v === 'string'
    ? Array.from(v.replace(/[\u0000-\u001F\u007F\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim())
        .slice(0, n)
        .join('')
    : '';
const LINKISH = /(\b[a-z][a-z0-9+.-]*:\/\/\S+|\bwww\.\S+|\b[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}\b)/gi;
/** A fact put into a template: no web address, no braces, clipped. */
const safe = (v: unknown, n: number) => clip(String(v ?? '').replace(LINKISH, '').replace(/[{}<>[\]]/g, ''), n);
const len = (s: string) => Array.from(s).length;

interface Scored extends MorningCandidate {
  rule: string;
  score: number;
}

const goesOut = (p: Post) => (p.external?.state === 'scheduled' && p.external.scheduledFor ? p.external.scheduledFor : p.scheduledAt);

/** The rule candidates for a business on its action day, highest score first. */
export function localCandidates(project: Project, ctx: ActionCtx, day: string, now = ctx.now): Scored[] {
  const out: Scored[] = [];
  const tz = projectTimeZone(project);
  const brand = safe(project.brand?.name, 60) || 'your business';
  const add = (rule: string, score: number, kind: MorningCandidate['kind'], title: string, why: string, target: MorningCandidate['target'] = {}, from: MorningCandidate['from'] = 'rule') => {
    const t = clip(title, L.title);
    const w = clip(why, L.why);
    if (len(t) < L.titleMin || len(w) < L.whyMin) return;
    const c = { kind, title: t, why: w, target, from };
    out.push({ ...c, key: morningKey(c), rule, score });
  };

  // posts in the business's zone: due today or overdue, and planned in the next 7 days
  const today = localDateOf(now, tz);
  const planned = ctx.posts.filter((p) => p.projectId === project.id && p.status === 'scheduled');
  const at = (p: Post) => Date.parse(goesOut(p));
  const due = planned
    .filter((p) => Number.isFinite(at(p)))
    .filter((p) => localDateOf(at(p), tz) === today || (at(p) < now && localDateOf(at(p), tz) < today))
    .sort((a, b) => at(a) - at(b));
  if (due[0]) add('post_due', 90, 'calendar', T.post_due.title, fill(T.post_due.why, { headline: safe(due[0].headline, 60) || 'a post' }), { postId: due[0].id });

  const s = readStrategy(project);
  const step = strategyNextSteps(project, s, ctx, 1)[0];
  if (s.plan && step) {
    const title = safe(step.title, 90);
    const week = s.plan.weeks.find((w) => w.week === currentWeek(s.plan!, now));
    const focus = safe(week?.focus, 100);
    const target: MorningCandidate['target'] = { planActionId: step.id };
    if (step.pageType) target.pageType = step.pageType;
    if (step.topic) target.topic = safe(step.topic, L.topic);
    if (step.codeKind) target.codeKind = step.codeKind;
    if (step.leadMagnetType) target.leadMagnetType = step.leadMagnetType;
    if (step.platform) target.platform = step.platform;
    add('plan_step', 80, step.kind, len(title) >= L.titleMin ? title : 'Do the next step of your plan', fill(T.plan_step.why, { week: step.week, focus: focus ? `: ${focus}` : '' }), target, 'plan');
  }
  if (!s.plan) add('no_plan', 75, 'strategy', T.no_plan.title, T.no_plan.why);
  const next7 = planned.filter((p) => at(p) >= now && at(p) < now + 7 * DAY_MS).length;
  if (next7 === 0) add('nothing_planned', 55, 'batch_7', T.nothing_planned.title, T.nothing_planned.why);
  const m = project.marketing;
  if (m.salesPage && !m.seoPublished) add('publish_page', 50, 'publish_page', T.publish_page.title, T.publish_page.why);
  if (!m.salesPage) add('build_page', 45, 'build_page', T.build_page.title, T.build_page.why, { pageType: s.promote?.page.pageType ?? 'landing' });
  if (!m.leadMagnet) add('lead_magnet', 40, 'lead_magnet', T.lead_magnet.title, T.lead_magnet.why);
  if ((m.emails?.length ?? 0) < 5) add('welcome_emails', 35, 'welcome_emails', T.welcome_emails.title, T.welcome_emails.why);
  if (!Object.values(project.brand?.socials ?? {}).some(Boolean)) add('socials', 25, 'socials', T.socials.title, T.socials.why);
  if (!project.brand?.websiteUrl) add('website', 20, 'website', T.website.title, T.website.why);
  // the three habits, rotating by the action day
  const habits: [MorningCandidate['kind'], string, string, MorningCandidate['target']][] = [
    ['offline', T.habit_comments.title, T.habit_comments.why, {}],
    ['write_post', T.habit_bts.title, T.habit_bts.why, { topic: fill(T.habit_bts.topic, { brand }) }],
    ['assistant', T.habit_referral.title, T.habit_referral.why, { prompt: fill(T.habit_referral.prompt, { brand }) }],
  ];
  const start = Math.floor(Date.parse(`${day}T00:00:00Z`) / DAY_MS) % 3;
  for (let i = 0; i < 3; i++) {
    const [kind, title, why, target] = habits[(start + i) % 3];
    add('habit', 10 - i, kind, title, why, target);
  }
  return out.sort((a, b) => b.score - a.score);
}

// ───────────── this device's record ─────────────

interface LocalHistory {
  key: string;
  day: string;
  notUseful?: true;
}
interface LocalRecord {
  day: string;
  candidates: MorningCandidate[];
  chosen: number | null;
  state: 'ready' | 'done' | 'dismissed';
  feedback: MorningFeedback[];
  doneAt: string | null;
  history: LocalHistory[];
}

export const localKey = (projectId: string) => `ylb-morning:${projectId}`;

function readRecord(projectId: string): LocalRecord | null {
  try {
    const raw = safeStorage.getItem(localKey(projectId));
    const r = raw ? (JSON.parse(raw) as LocalRecord) : null;
    return r && typeof r.day === 'string' && Array.isArray(r.candidates) ? { ...r, feedback: Array.isArray(r.feedback) ? r.feedback : [], history: Array.isArray(r.history) ? r.history : [] } : null;
  } catch {
    return null;
  }
}
const writeRecord = (projectId: string, r: LocalRecord) => safeStorage.setItem(localKey(projectId), JSON.stringify(r));

/** The final list: Not useful (30 days) never, shown lately (7 days) last, duplicates once, at most 3. */
export function chooseLocal(cands: Scored[], history: LocalHistory[], day: string): MorningCandidate[] {
  const age = (h: LocalHistory) => daysBetween(h.day, day);
  const notUseful = new Set(history.filter((h) => h.notUseful && age(h) < MORNING.notUsefulDays).map((h) => h.key));
  const recent = new Set(history.filter((h) => !h.notUseful && age(h) > 0 && age(h) <= MORNING.recentDays).map((h) => h.key));
  const seen = new Set<string>();
  const fresh: MorningCandidate[] = [];
  const repeats: MorningCandidate[] = [];
  for (const { rule: _r, score: _s, ...c } of cands) {
    if (seen.has(c.key) || notUseful.has(c.key)) continue;
    seen.add(c.key);
    (recent.has(c.key) ? repeats : fresh).push(c);
  }
  return [...fresh, ...repeats].slice(0, 3);
}

/** This device's record for the action day, made (and kept) the first time the day is asked for. */
function recordFor(project: Project, ctx: ActionCtx, day: string, now: number): LocalRecord {
  const cur = readRecord(project.id);
  if (cur && cur.day === day) return cur;
  const history = (cur?.history ?? []).filter((h) => daysBetween(h.day, day) < MORNING.notUsefulDays);
  const candidates = chooseLocal(localCandidates(project, ctx, day, now), history, day);
  const r: LocalRecord = candidates.length
    ? { day, candidates, chosen: 0, state: 'ready', feedback: [], doneAt: null, history: [...history, { key: candidates[0].key, day }] }
    : { day, candidates: [], chosen: null, state: 'dismissed', feedback: [], doneAt: null, history };
  writeRecord(project.id, r);
  return r;
}

const actionOf = (projectId: string, tz: string, r: LocalRecord): MorningAction => ({
  id: `local:${projectId}:${r.day}`,
  projectId,
  localDate: r.day,
  timeZone: tz,
  state: r.state,
  source: 'visit',
  engine: 'rules',
  chosen: r.chosen,
  candidates: r.candidates,
  feedback: r.feedback,
  fallback: null,
  credits: null,
  ownKey: false,
  generatedAt: null,
  doneAt: r.doneAt,
});

/** Today's action for a business, made in this browser (no request). */
export function localMorning(project: Project, ctx: ActionCtx, now = ctx.now): MorningToday {
  const tz = projectTimeZone(project);
  const day = actionDayOf(now, tz);
  const r = recordFor(project, ctx, day, now);
  return { actionDay: day, timeZone: tz, action: actionOf(project.id, tz, r), dueNow: false, late: isLate(now, tz), nextAt: new Date(nextMorningAt(now, tz)).toISOString(), attemptsLeft: 0, plan: 'active' };
}

/** Done, Undo or Not useful on this device (the server's rules). Returns the action as it is now, or null. */
export function localFeedback(project: Project, verdict: MorningVerdict, reason?: MorningReason, note?: string, now = Date.now()): MorningAction | null {
  const tz = projectTimeZone(project);
  const r = readRecord(project.id);
  if (!r) return null;
  const today = actionDayOf(now, tz);
  if (verdict === 'done' && r.state === 'ready') {
    r.state = 'done';
    r.doneAt = new Date(now).toISOString();
  } else if (verdict === 'undo' && r.state === 'done' && r.day === today) {
    r.state = 'ready';
    r.doneAt = null;
  } else if (verdict === 'not_useful' && r.state === 'ready' && r.chosen != null) {
    const shown = r.candidates[r.chosen];
    const n = note ? clip(note, L.note) : '';
    r.feedback = [...r.feedback, { i: r.chosen, ...(reason ? { reason } : {}), ...(n ? { note: n } : {}), at: new Date(now).toISOString() }].slice(0, 3);
    if (shown) r.history = [...r.history, { key: shown.key, day: r.day, notUseful: true }];
    const marked = new Set(r.feedback.map((f) => f.i));
    const next = r.candidates.findIndex((_c, i) => !marked.has(i));
    if (next < 0) r.state = 'dismissed';
    else {
      r.chosen = next;
      r.history = [...r.history, { key: r.candidates[next].key, day: r.day }];
    }
  }
  writeRecord(project.id, r);
  return actionOf(project.id, tz, r);
}

