// Generation (server/morning/generate.mjs and its parts): the schema check, the rules, choosing (repeats last, Not
// useful never), the facts (no personal data), the prompt, metering through the AI routes' gate, the fallbacks and
// the owner alerts. mock-providers and mock-supabase only.
import crypto from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BASE, morningServer } from './test-helpers.mjs';
import { checkContext, checkCandidate, parseAnswer, validateAnswer } from './validate.mjs';
import { ruleCandidates, keyOf } from './rules.mjs';
import { chooseCandidates, fallbackFor, makeAction } from './generate.mjs';
import { readFacts, derivedDoneOf, postFacts, experimentFacts } from './facts.mjs';
import { buildPrompt, MORNING_MARKER } from './prompt.mjs';
import { mockMorningReply } from '../test/mock-providers.mjs';
import { utcDay } from '../limits.mjs';

const facts0 = () => ({
  today: '2026-11-07',
  business: { brand: 'Calm Yoga', socials: [], hasWebsite: false },
  strategy: { has: true, pageType: 'booking', plan: { week: 1, focus: 'Get found', open: [{ id: 'a_build1', kind: 'build_page', week: 1, title: 'Build your booking page', pageType: 'booking' }] } },
  posts: { plannedNext7: 0, due: [{ id: 'post_1', headline: 'Open studio day' }] },
  page: { built: false, published: false },
  leadMagnet: false,
  emails: 0,
  numbers: [{ source: 'social', status: 'ok', fetchedAt: new Date(BASE).toISOString(), values: { followers: 1234, engagementRate: 4.5 } }],
  leads: { newSinceSeen: 2, newest: '2026-11-06', last7: 2, last30: 3 },
  sales: { paid30: 0, revenue: { USD: 120 }, stuckOffers: [] },
  history: { recent: [], notUseful: [] },
});
const good = { kind: 'write_post', title: 'Share a quick tip about breathing', why: 'Short tips get saved and shared, and they show what your classes feel like.', target: { topic: 'Breathing tip' } };

describe('the schema check', () => {
  const ctx = checkContext(facts0());
  const drop = (over) => checkCandidate({ ...good, ...over }, ctx).drop;

  it('keeps a good candidate with a server-made key and drops unknown fields', () => {
    const r = checkCandidate({ ...good, extra: 'x', target: { ...good.target, url: 'x' } }, ctx);
    expect(r.candidate).toEqual({ kind: 'write_post', title: good.title, why: good.why, target: { topic: 'Breathing tip' }, from: 'ai', key: 'write_post:breathing-tip' });
  });

  it('drops wrong kinds, lengths, lines, steps and target values', () => {
    expect(drop({ kind: 'launch_rocket' })).toBe('kind');
    expect(drop({ title: 'Go' })).toBe('length');
    expect(drop({ title: 'x'.repeat(91) })).toBe('length');
    expect(drop({ why: 'Too short.' })).toBe('length');
    expect(drop({ title: 'Line one here\nline two' })).toBe('text');
    expect(drop({ title: 42 })).toBe('text');
    expect(drop({ steps: ['a', 'b', 'c', 'd'] })).toBe('steps');
    expect(drop({ steps: ['x'.repeat(121)] })).toBe('steps');
    expect(drop({ target: { platform: 'myspace' } })).toBe('platform');
    expect(drop({ target: { topic: 'x'.repeat(81) } })).toBe('topic');
    expect(drop({ kind: 'assistant', target: {} })).toBe('prompt');
    expect(drop({ kind: 'assistant', target: { prompt: 'x'.repeat(301) } })).toBe('prompt');
  });

  it('only plan actions and posts that were given, with the action’s own kind', () => {
    expect(drop({ target: { planActionId: 'a_made_up' } })).toBe('planActionId');
    expect(drop({ target: { planActionId: 'a_build1' } })).toBe('planActionId'); // write_post ≠ build_page
    expect(checkCandidate({ ...good, kind: 'build_page', target: { planActionId: 'a_build1' } }, ctx).candidate).toMatchObject({ key: 'plan:a_build1', target: { planActionId: 'a_build1', pageType: 'booking' } });
    expect(drop({ kind: 'calendar', target: { postId: 'post_nope' } })).toBe('postId');
    expect(checkCandidate({ ...good, kind: 'calendar', target: { postId: 'post_1' } }, ctx).candidate.key).toBe('post:post_1');
  });

  it('no web address or markup anywhere; no invented percentage or money', () => {
    for (const t of ['See https://example.com today please', 'Go to www.example.com for more', 'Read [this](x) before you start', 'Update yourshop.com before noon']) expect(drop({ title: t })).toBe('link');
    expect(drop({ why: 'Add <b>bold</b> words to your bio so people notice them quickly.' })).toBe('markup');
    expect(drop({ why: 'Businesses that do this see 37% more sales, so it is worth trying.' })).toBe('number');
    expect(drop({ why: 'A $50 voucher is a nice way to say thanks to your best customers.' })).toBe('number');
    // numbers from the facts may be quoted
    expect(checkCandidate({ ...good, why: 'You have 1,234 followers and a 4.5% engagement rate: ask them a question.' }, ctx).candidate).toBeTruthy();
    expect(checkCandidate({ ...good, why: 'You took $120 in the last month, so thank those customers today.' }, ctx).candidate).toBeTruthy();
  });

  it('parses one code fence; anything that isn’t JSON is invalid', () => {
    expect(parseAnswer('```json\n{"candidates":[]}\n```')).toEqual({ candidates: [] });
    expect(parseAnswer('Sure! {"candidates":[]}')).toBeNull();
    expect(validateAnswer('nope', facts0())).toMatchObject({ valid: [], parsed: false });
  });

  it('each QA marker of the mock', () => {
    const sent = (marker) => `${MORNING_MARKER} {\\"id\\":\\"a_build1\\",\\"kind\\":\\"build_page\\"} ${marker}`;
    expect(validateAnswer(mockMorningReply(sent('')), facts0()).valid).toHaveLength(3);
    expect(validateAnswer(mockMorningReply(sent('qa-morning-invalid')), facts0()).valid).toHaveLength(0);
    expect(validateAnswer(mockMorningReply(sent('qa-morning-badkind')), facts0())).toMatchObject({ valid: [], dropped: ['kind', 'kind', 'kind'] });
    expect(validateAnswer(mockMorningReply(sent('qa-morning-url')), facts0())).toMatchObject({ dropped: ['link'] });
    expect(validateAnswer(mockMorningReply(sent('qa-morning-two')), facts0())).toMatchObject({ dropped: ['length'] });
    expect(validateAnswer(mockMorningReply(sent('qa-morning-percent')), facts0())).toMatchObject({ dropped: ['number'] });
  });
});

describe('rules and choosing', () => {
  it('every rule candidate passes the schema check; highest score first', () => {
    const f = facts0();
    f.sales = { ...f.sales, lastPaidAt: BASE - 3_600_000, stuckOffers: [{ title: 'Ten-class pass', clicks: 40 }] };
    f.page = { built: true, published: false };
    f.numbers[0].fetchedAt = new Date(BASE - 9 * 86_400_000).toISOString();
    const rules = ruleCandidates(f, BASE);
    expect(rules.map((r) => r.rule)).toEqual(['new_leads', 'post_due', 'plan_step', 'new_sale', 'offer_no_sales', 'nothing_planned', 'publish_page', 'lead_magnet', 'welcome_emails', 'stale_numbers', 'socials', 'website', 'habit', 'habit', 'habit']);
    const ctx = checkContext(f);
    for (const r of rules) expect(checkCandidate(r, ctx).candidate, r.rule).toBeTruthy();
    expect(rules[0]).toMatchObject({ kind: 'leads', title: 'Reply to your 2 new leads', key: 'leads:2026-11-06' });
    // facts never leak a web address into a template
    const odd = { ...facts0(), business: { brand: 'shop.example.com', socials: [], hasWebsite: false } };
    for (const r of ruleCandidates(odd, BASE)) expect(checkCandidate(r, checkContext(odd)).candidate, r.rule).toBeTruthy();
  });

  it('duplicates dropped, Not useful never, recent ones last; topped up to 3', () => {
    const c = (key, from = 'ai') => ({ key, kind: 'offline', title: key, why: 'x', from });
    const rules = [c('r1', 'rule'), c('r2', 'rule'), c('r3', 'rule')];
    expect(chooseCandidates([c('a1'), c('a1'), c('a2')], rules, {}).map((x) => x.key)).toEqual(['a1', 'a2', 'r1']);
    expect(chooseCandidates([c('a1'), c('a2')], rules, { notUseful: [{ key: 'a1' }], recent: [{ key: 'a2' }] }).map((x) => x.key)).toEqual(['r1', 'r2', 'r3']);
    expect(chooseCandidates([c('a2')], [c('r1', 'rule')], { recent: [{ key: 'a2' }] }).map((x) => x.key)).toEqual(['r1', 'a2']);
    expect(chooseCandidates([c('a1')], [], { notUseful: [{ key: 'a1' }] })).toEqual([]);
  });

  it('fallback reasons in our words; owner alerts for the owner’s keys only', () => {
    expect(fallbackFor({ code: 'NO_PROVIDER' })).toEqual({ fallback: 'no_ai' });
    expect(fallbackFor({ code: 'CREDITS_USED' })).toEqual({ fallback: 'credits' });
    expect(fallbackFor({ code: 'DAILY_LIMIT' })).toEqual({ fallback: 'daily_limit' });
    expect(fallbackFor({ code: 'REFUSAL' })).toEqual({ fallback: 'refused' });
    expect(fallbackFor({ code: 'AUTH', attempts: [{ providerLabel: 'xAI' }] })).toEqual({ fallback: 'no_ai', alert: 'ai_key' });
    expect(fallbackFor({ code: 'CREDITS', attempts: [{ providerLabel: 'xAI' }] })).toEqual({ fallback: 'no_ai', alert: 'ai_credits' });
    expect(fallbackFor({ code: 'AUTH', attempts: [{ providerLabel: 'OpenAI (your key)' }] })).toEqual({ fallback: 'own_key' });
    expect(fallbackFor({ code: 'TIMEOUT' })).toEqual({ fallback: 'ai_error' });
  });

  it('the server’s derivedDone sees what the app sees', () => {
    const p = { id: 'p1', track: 'business', marketing: { salesPage: { x: 1 }, pageType: 'booking', seoPublished: null, emails: [1, 2, 3, 4, 5], leadMagnet: null }, studio: { packages: [], codeAssets: [{ kind: 'quiz' }], listing: {} }, brand: { socials: { instagram: 'x' }, websiteUrl: '' } };
    const ctx = { posts: [{ projectId: 'p1', source: 'batch', status: 'draft' }], ads: [], listings: [] };
    const s = { promote: { page: { pageType: 'booking' } }, applied: {} };
    const done = (a) => derivedDoneOf(a, p, s, ctx);
    expect(done({ kind: 'build_page' })).toBe(true);
    expect(done({ kind: 'build_page', pageType: 'lead' })).toBe(false);
    expect(done({ kind: 'publish_page' })).toBe(false);
    expect(done({ kind: 'welcome_emails' })).toBe(true);
    expect(done({ kind: 'batch_7' })).toBe(true);
    expect(done({ kind: 'calendar' })).toBe(false);
    expect(done({ kind: 'code_asset', codeKind: 'quiz' })).toBe(true);
    expect(done({ kind: 'code_asset', codeKind: 'faq' })).toBe(false);
    expect(done({ kind: 'socials' })).toBe(true);
    expect(done({ kind: 'website' })).toBe(false);
    expect(done({ kind: 'packages' })).toBe(false);
    expect(done({ kind: 'link_settings' })).toBe(false);
  });
});

describe('A/B tests in the morning action (P4b)', () => {
  const LA = 'America/Los_Angeles';
  const at = (h) => new Date(BASE + h * 3_600_000).toISOString();
  const rows = [
    { id: 'e_times', kind: 'post', mode: 'times', changed: 'hook', name: 'Question hooks', state: 'running', result: { verdict: 'keep_going' }, winner_used_at: null },
    { id: 'e_won', kind: 'post', mode: 'trial_reels', changed: 'caption', name: 'Short captions', state: 'finished', result: { verdict: 'winner', winner: 'b', lift: 18 }, winner_used_at: null },
    { id: 'e_used', kind: 'page', mode: 'split', changed: 'headline', name: 'Used', state: 'finished', result: { verdict: 'winner', winner: 'a' }, winner_used_at: at(-24) },
    { id: 'e_later', kind: 'post', mode: 'times', changed: 'cta', name: 'Later', state: 'draft', result: {}, winner_used_at: null },
  ];
  const variants = [
    { experiment_id: 'e_times', key: 'b', post_id: 'post_b', job_id: null, planned_at: at(2) },
    { experiment_id: 'e_times', key: 'a', post_id: 'post_a', job_id: 'job-1', planned_at: at(-20) },
    { experiment_id: 'e_later', key: 'a', post_id: 'post_l', job_id: null, planned_at: at(30) },
  ];

  it('the facts: a winner that is in and not used; the next unposted version planned for today', () => {
    expect(experimentFacts(rows, variants, LA, '2026-11-07')).toEqual({
      ready: [{ id: 'e_won', name: 'Short captions', kind: 'post', changed: 'caption', winner: 'b' }],
      due: [{ id: 'e_times', name: 'Question hooks', key: 'b', postId: 'post_b' }],
    });
    // A not posted yet: B isn't due before A, whatever its date
    const aFirst = variants.map((v) => (v.key === 'a' && v.experiment_id === 'e_times' ? { ...v, job_id: null, planned_at: at(48) } : v));
    expect(experimentFacts(rows, aFirst, LA, '2026-11-07').due).toEqual([]);
    expect(experimentFacts([], [], LA, '2026-11-07')).toEqual({ ready: [], due: [] });
  });

  it('the rules: version due (the post isn’t suggested twice) and the winner, each passing the check, with the test’s key', () => {
    const f = { ...facts0(), posts: { plannedNext7: 1, due: [{ id: 'post_b', headline: 'Version B' }] }, experiments: experimentFacts(rows, variants, LA, '2026-11-07') };
    const rules = ruleCandidates(f, BASE);
    const due = rules.find((r) => r.rule === 'variant_due');
    const won = rules.find((r) => r.rule === 'experiment_winner');
    expect(due).toMatchObject({ kind: 'calendar', title: 'Post version B of your A/B test', target: { experimentId: 'e_times', postId: 'post_b' }, key: 'experiment:e_times:post:post_b' });
    expect(due.why).toContain('“Question hooks”');
    expect(won).toMatchObject({ kind: 'analytics', target: { experimentId: 'e_won' }, key: 'experiment:e_won:winner' });
    expect(rules.find((r) => r.rule === 'post_due')).toBeUndefined();
    const ctx = checkContext(f);
    for (const r of [due, won]) expect(checkCandidate(r, ctx).candidate, r.rule).toBeTruthy();
    // the AI may name only the tests given, and a test's post only with that test
    const ai = { kind: 'analytics', title: 'See which version won your test', why: 'Your caption test has a clear winner, so use it next.' };
    expect(checkCandidate({ ...ai, target: { experimentId: 'e_other' } }, ctx).drop).toBe('experimentId');
    expect(checkCandidate({ ...ai, target: { experimentId: 'e_won' } }, ctx).candidate.target).toEqual({ experimentId: 'e_won' });
    expect(checkCandidate({ ...ai, kind: 'calendar', target: { experimentId: 'e_won', postId: 'post_x' } }, ctx).drop).toBe('postId');
  });

  it('readFacts reads the business’s tests (ids, names, states; never page HTML)', async () => {
    const app = await morningServer();
    try {
      const who = await app.user('ab@m.test');
      await app.business(who, 'proj_ab');
      const base = { user_id: who.id, project_id: 'proj_ab', network: 'instagram', metric: 'engagement_rate' };
      const [t] = await app.db.insert('experiments', { ...base, kind: 'post', mode: 'times', changed: 'hook', subject_ref: 'post_a', name: 'Question hooks', state: 'running' }, { returning: true });
      await app.db.insert('experiments', { ...base, kind: 'post', mode: 'trial_reels', changed: 'caption', subject_ref: 'post_c', name: 'Short captions', state: 'finished', result: { verdict: 'winner', winner: 'a' } });
      await app.db.insert('experiments', { ...base, project_id: 'proj_other', kind: 'post', mode: 'trial_reels', changed: 'caption', subject_ref: 'post_z', name: 'Other business', state: 'finished', result: { verdict: 'winner', winner: 'a' } });
      await app.db.insert('experiment_variants', { experiment_id: t.id, key: 'a', user_id: who.id, post_id: 'post_a', job_id: crypto.randomUUID(), planned_at: at(-20) });
      await app.db.insert('experiment_variants', { experiment_id: t.id, key: 'b', user_id: who.id, post_id: 'post_b', planned_at: at(1) });
      const facts = await readFacts(app.db, { userId: who.id, projectId: 'proj_ab', tz: LA, now: BASE });
      expect(facts.experiments.due).toEqual([{ id: t.id, name: 'Question hooks', key: 'b', postId: 'post_b' }]);
      expect(facts.experiments.ready.map((e) => e.name)).toEqual(['Short captions']);
      expect(buildPrompt(facts, ruleCandidates(facts, BASE))).toContain('experimentId (only an id from experiments.ready or experiments.due');
    } finally {
      await app.close();
    }
  });
});

describe('making an action', () => {
  let app;
  beforeAll(async () => {
    app = await morningServer();
  });
  afterAll(() => app.close());
  beforeEach(() => {
    app.providers.reset();
    app.set(BASE);
  });

  const start = async (who, id) => {
    const row = await app.morning.store.begin({ userId: who.id, projectId: id, localDate: '2026-11-07', timeZone: 'America/Los_Angeles', source: 'visit', now: app.clock() });
    return makeAction({ store: app.morning.store, db: app.db, aiText: app.ai.generateText, alerts: { raise: async () => {} } }, { who, row, now: app.clock });
  };

  it('the facts carry counts only: no lead names, emails or messages, no buyer emails, no competitor text', async () => {
    const who = await app.user('facts@m.test');
    await app.business(who, 'proj_facts', { notes: 'We open early on Saturdays' });
    await app.db.insert('page_leads', { user_id: who.id, project_id: 'proj_facts', slug: 'calm-yoga', page_id: 'seo:proj_facts', name: 'Jane Lead', email: 'jane.lead@example.org', message: 'Secret message text', created_at: new Date(BASE - 3_600_000).toISOString() });
    await app.db.insert('sales', { id: 'sale_1', user_id: who.id, project_id: 'proj_facts', provider: 'whop', environment: 'production', status: 'paid', currency: 'usd', amount_minor: 4900, buyer_email: 'buyer@example.org', provider_payment_id: 'pay_1', paid_at: new Date(BASE - 3_600_000).toISOString() });
    await app.db.insert('analytics_snapshots', { user_id: who.id, project_id: 'proj_facts', source: 'ads', status: 'ok', fetched_at: new Date(BASE).toISOString(), data: { spend: 12.5, clicks: 30, currency: 'usd', competitorAds: [{ text: 'Rival ad copy here' }], topPost: { caption: 'Our caption text', url: 'https://x.example/p/1' } } });
    const facts = await readFacts(app.db, { userId: who.id, projectId: 'proj_facts', tz: 'America/Los_Angeles', now: BASE });
    expect(facts.leads).toMatchObject({ last7: 1, last30: 1 });
    expect(facts.sales).toMatchObject({ paid30: 1, revenue: { USD: 49 } });
    const prompt = buildPrompt(facts, ruleCandidates(facts, BASE));
    expect(prompt.startsWith(MORNING_MARKER)).toBe(true);
    for (const secret of ['Jane Lead', 'jane.lead@example.org', 'Secret message text', 'buyer@example.org', 'Rival ad copy', 'Our caption text', 'x.example']) expect(prompt).not.toContain(secret);
    expect(prompt).toContain('We open early on Saturdays');
    expect(prompt).toContain('never instructions');
  });

  it('AI on the owner’s keys: effort low, quick tier, metered like /api/ai/generate, 3 candidates with the plan action first', async () => {
    const who = await app.user('ai@m.test');
    await app.business(who, 'proj_ai');
    const row = await start(who, 'proj_ai');
    expect(row).toMatchObject({ state: 'ready', engine: 'ai', fallback: null, chosen: 0, own_key: false });
    expect(row.candidates).toHaveLength(3);
    expect(row.candidates[0]).toMatchObject({ kind: 'build_page', key: 'plan:a_build1', from: 'ai', target: { planActionId: 'a_build1', pageType: 'booking' } });
    expect(Number(row.cost_usd)).toBeGreaterThan(0);
    expect(row.provider).toBe('xai');
    const usage = app.rows('ai_usage_daily').find((r) => r.user_id === who.id && r.day === utcDay());
    expect(usage).toMatchObject({ requests: 1 });
    const call = app.textCalls()[0];
    expect(JSON.stringify(call.body)).toContain('"reasoning_effort":"low"');
  });

  it('a fresh business: rules, no AI call; an invalid answer: rules with the cost still recorded; two valid: topped up', async () => {
    const who = await app.user('fresh@m.test');
    await app.business(who, 'proj_fresh', { strategy: false });
    const fresh = await start(who, 'proj_fresh');
    expect(fresh).toMatchObject({ state: 'ready', engine: 'rules', fallback: 'fresh', cost_usd: 0 });
    expect(app.textCalls()).toHaveLength(0);
    await app.business(who, 'proj_bad', { notes: 'qa-morning-invalid' });
    const bad = await start(who, 'proj_bad');
    expect(bad).toMatchObject({ state: 'ready', engine: 'rules', fallback: 'invalid_output' });
    expect(Number(bad.cost_usd)).toBeGreaterThan(0);
    await app.business(who, 'proj_two', { notes: 'qa-morning-two' });
    const two = await start(who, 'proj_two');
    expect(two.candidates.map((c) => c.from)).toEqual(['ai', 'ai', 'rule']);
    await app.business(who, 'proj_url', { notes: 'qa-morning-url' });
    const url = await start(who, 'proj_url');
    // the plan step the AI picked had a link: the rules' plan step stands in for it
    expect(url.candidates.map((c) => c.from)).toEqual(['ai', 'ai', 'plan']);
    expect(JSON.stringify(url.candidates)).not.toContain('example.com');
  });

  it('the owner’s key refused: rules + an owner alert, and nothing of the provider’s words on the row', async () => {
    const who = await app.user('auth@m.test');
    await app.business(who, 'proj_auth');
    app.providers.behavior.xai = 'auth';
    app.providers.behavior.openai = 'auth';
    const raised = [];
    const row0 = await app.morning.store.begin({ userId: who.id, projectId: 'proj_auth', localDate: '2026-11-07', timeZone: 'America/Los_Angeles', source: 'cron', now: app.clock() });
    const row = await makeAction({ store: app.morning.store, db: app.db, aiText: app.ai.generateText, alerts: { raise: async (k) => raised.push(k) } }, { who, row: row0, now: app.clock });
    expect(row).toMatchObject({ state: 'ready', engine: 'rules', fallback: 'no_ai' });
    expect(raised).toEqual(['ai_key']);
    expect(JSON.stringify(row)).not.toMatch(/Incorrect API key|sk-abc|rejected/i);
  });

  it('a read that fails: failed (UNAVAILABLE), never retried', async () => {
    const who = await app.user('down@m.test');
    await app.business(who, 'proj_down');
    app.supa.behavior.fail = (method, p) => (method === 'GET' && p.endsWith('/offers') ? { status: 500, body: { message: 'boom' } } : null);
    try {
      const row = await start(who, 'proj_down');
      expect(row).toMatchObject({ state: 'failed', error_code: 'UNAVAILABLE' });
      expect(app.textCalls()).toHaveLength(0);
    } finally {
      app.supa.behavior.fail = null;
    }
  });

  it('keys for repeats and Not useful are the server’s', () => {
    expect(keyOf({ kind: 'assistant', target: { prompt: 'Help me write a thank-you note to a customer' } })).toBe('assistant:help-me-write-a-thank-you-note-to-a-cust');
    expect(keyOf({ kind: 'leads', target: {} }, { leads: { newest: '2026-11-06' } })).toBe('leads:2026-11-06');
  });
});

describe('postFacts: due and overdue against the action day', () => {
  const LA = 'America/Los_Angeles';
  // 2026-11-08 01:30 in Los Angeles (PST, UTC−8): the action day is still 2026-11-07
  const now = Date.parse('2026-11-08T09:30:00Z');
  const post = (id, at) => ({ id, status: 'scheduled', scheduledAt: at, headline: id });
  const posts = [post('yesterday_evening', '2026-11-08T02:00:00Z'), post('two_days_ago', '2026-11-06T18:00:00Z'), post('later_today', '2026-11-08T18:00:00Z')];

  it('before 05:00 an unpublished post from the action day is due, not overdue; the next calendar day is neither', () => {
    const f = postFacts(posts, LA, now);
    expect(f).toMatchObject({ dueToday: 1, overdue: 1 });
    expect(f.due.map((d) => d.id)).toEqual(['two_days_ago', 'yesterday_evening']);
  });

  it('after 05:00 the calendar day is the action day', () => {
    const later = Date.parse('2026-11-08T14:00:00Z');
    expect(postFacts(posts, LA, later)).toMatchObject({ dueToday: 1, overdue: 2 });
  });
});
