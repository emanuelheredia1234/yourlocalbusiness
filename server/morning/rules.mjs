// The built-in rules: always computed, used when AI can't be (or tops up a short AI list). Each rule makes at most
// one candidate with a score, its rule id and a server-made key; titles and reasons come from the templates in
// shared/morning.json filled with facts (never AI text). Highest score first.

import { MORNING } from './config.mjs';
import { clip } from './facts.mjs';

const T = MORNING.rules;
const LINKISH = /(\b[a-z][a-z0-9+.-]*:\/\/\S+|\bwww\.\S+|\b[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}\b)/gi;

/** A fact put into a template: no web address, no braces, clipped. */
const safe = (v, n) => clip(String(v ?? '').replace(LINKISH, '').replace(/[{}<>[\]]/g, ''), n);
/** Fill {name} placeholders. */
export const fill = (tpl, vars) => String(tpl ?? '').replace(/\{(\w+)\}/g, (_, k) => (vars[k] == null ? '' : String(vars[k])));
const slug = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

/** A candidate's key (≤ 120): what "the same idea" means for repeats and Not useful. */
export function keyOf(c, facts) {
  const t = c.target ?? {};
  let k;
  if (t.experimentId) k = `experiment:${t.experimentId}:${t.postId ? `post:${t.postId}` : 'winner'}`;
  else if (t.planActionId) k = `plan:${t.planActionId}`;
  else if (t.postId) k = `post:${t.postId}`;
  else if (c.kind === 'leads') k = `leads:${facts?.leads?.newest ?? ''}`;
  else if (c.kind === 'build_page') k = `build_page:${t.pageType ?? ''}`;
  else if (c.kind === 'write_post') k = `write_post:${slug(t.topic ?? c.title)}`;
  else if (c.kind === 'assistant') k = `assistant:${slug(String(t.prompt ?? '').slice(0, 40))}`;
  else k = c.kind;
  return k.slice(0, MORNING.limits.key);
}

const dayNumber = (ymd) => Math.floor(Date.parse(`${ymd}T00:00:00Z`) / 86_400_000);

/** The rule candidates for a business on its action day, highest score first. */
export function ruleCandidates(facts, now) {
  const out = [];
  const brand = safe(facts.business?.brand, 60) || 'your business';
  const add = (rule, score, kind, title, why, target = {}, from = 'rule') => {
    const t = clip(title, MORNING.limits.title);
    const w = clip(why, MORNING.limits.why);
    if (Array.from(t).length < MORNING.limits.titleMin || Array.from(w).length < MORNING.limits.whyMin) return;
    const c = { kind, title: t, why: w, target, from, rule, score };
    out.push({ ...c, key: keyOf(c, facts) });
  };

  const leads = facts.leads ?? {};
  if (leads.newSinceSeen > 0) {
    const n = leads.newSinceSeen;
    add('new_leads', 100, 'leads', fill(T.new_leads.title, { n, leads: n === 1 ? 'lead' : 'leads' }), fill(T.new_leads.why, { n, people: n === 1 ? 'person' : 'people' }));
  }
  const due = facts.posts?.due?.[0];
  // a due A/B test version is suggested as such below, not twice
  if (due && due.id !== facts.experiments?.due?.[0]?.postId) add('post_due', 90, 'calendar', T.post_due.title, fill(T.post_due.why, { headline: safe(due.headline, 60) || 'a post' }), { postId: due.id });
  // A/B tests (P4b): the next version due today (the app only reminds; nothing posts by itself), and a winner that's in
  const nextVariant = facts.experiments?.due?.[0];
  if (nextVariant) {
    const key = String(nextVariant.key ?? '').toUpperCase();
    add('variant_due', 88, 'calendar', fill(T.variant_due.title, { key }), fill(T.variant_due.why, { key, name: safe(nextVariant.name, 60) || 'your A/B test' }), { experimentId: nextVariant.id, postId: nextVariant.postId });
  }
  const won = facts.experiments?.ready?.[0];
  if (won) add('experiment_winner', 85, 'analytics', T.experiment_winner.title, fill(T.experiment_winner.why, { name: safe(won.name, 60) || 'Your A/B test' }), { experimentId: won.id });
  const plan = facts.strategy?.plan;
  const step = plan?.open?.[0];
  if (step) {
    const title = safe(step.title, 90);
    const focus = safe(plan.focus, 100);
    const target = { planActionId: step.id };
    for (const k of ['pageType', 'topic', 'codeKind', 'leadMagnetType', 'platform']) if (step[k]) target[k] = k === 'topic' ? safe(step[k], 80) : step[k];
    add('plan_step', 80, step.kind, Array.from(title).length >= MORNING.limits.titleMin ? title : 'Do the next step of your plan', fill(T.plan_step.why, { week: step.week, focus: focus ? `: ${focus}` : '' }), target, 'plan');
  }
  if (!plan) add('no_plan', 75, 'strategy', T.no_plan.title, T.no_plan.why);
  const sales = facts.sales ?? {};
  if (sales.lastPaidAt != null && sales.lastPaidAt >= now - 2 * 86_400_000) add('new_sale', 70, 'assistant', T.new_sale.title, T.new_sale.why, { prompt: fill(T.new_sale.prompt, { brand }) });
  const stuck = sales.stuckOffers?.[0];
  if (stuck) {
    const offer = safe(stuck.title, 50) || 'your offer';
    add('offer_no_sales', 60, 'assistant', fill(T.offer_no_sales.title, { offer }), fill(T.offer_no_sales.why, { clicks: stuck.clicks }), { prompt: fill(T.offer_no_sales.prompt, { offer }) });
  }
  if ((facts.posts?.plannedNext7 ?? 0) === 0) add('nothing_planned', 55, 'batch_7', T.nothing_planned.title, T.nothing_planned.why);
  if (facts.page?.built && !facts.page?.published) add('publish_page', 50, 'publish_page', T.publish_page.title, T.publish_page.why);
  if (!facts.page?.built) add('build_page', 45, 'build_page', T.build_page.title, T.build_page.why, { pageType: facts.strategy?.pageType ?? 'landing' });
  if (!facts.leadMagnet) add('lead_magnet', 40, 'lead_magnet', T.lead_magnet.title, T.lead_magnet.why);
  if ((facts.emails ?? 0) < 5) add('welcome_emails', 35, 'welcome_emails', T.welcome_emails.title, T.welcome_emails.why);
  const stale = (facts.numbers ?? []).some((n) => ['ok', 'partial'].includes(n.status) && n.fetchedAt && Date.parse(n.fetchedAt) < now - 7 * 86_400_000);
  if (stale) add('stale_numbers', 30, 'analytics', T.stale_numbers.title, T.stale_numbers.why);
  if (!(facts.business?.socials ?? []).length) add('socials', 25, 'socials', T.socials.title, T.socials.why);
  if (!facts.business?.hasWebsite) add('website', 20, 'website', T.website.title, T.website.why);
  // the three habits, rotating by the action day: nearly always one is left after the filters
  const habits = [
    () => ['offline', T.habit_comments.title, T.habit_comments.why, {}],
    () => ['write_post', T.habit_bts.title, T.habit_bts.why, { topic: fill(T.habit_bts.topic, { brand }) }],
    () => ['assistant', T.habit_referral.title, T.habit_referral.why, { prompt: fill(T.habit_referral.prompt, { brand }) }],
  ];
  const start = dayNumber(facts.today ?? '2026-01-01') % 3;
  for (let i = 0; i < 3; i++) {
    const [kind, title, why, target] = habits[(start + i) % 3]();
    add('habit', 10 - i, kind, title, why, target);
  }
  return out.sort((a, b) => b.score - a.score);
}
