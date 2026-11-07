// The mock database's emulation of 20261117000000_experiments.sql: the columns match the SQL, the start function's
// limit (and two starts at the limit), the count, the page split counters, the result reader's claims, one running
// split per page, one test per post, the project-delete trigger and the variant cascade, users reading (never
// writing) their own rows and never a page version's HTML. The real locks and RLS are checked on a Supabase branch.
import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMockSupabase } from '../test/mock-supabase.mjs';
import { createDb } from '../integrations/db.mjs';

const SQL = fs.readFileSync(new URL('../../supabase/migrations/20261117000000_experiments.sql', import.meta.url), 'utf8');
const HOUR = 3_600_000;
const now = Date.parse('2026-11-07T15:07:00Z');
let supa;
let db;

beforeAll(async () => {
  supa = await (await createMockSupabase()).start();
  supa.behavior.now = () => now;
  db = createDb({ supabaseUrl: supa.url, secretKey: supa.SECRET });
});
afterAll(() => supa.close());

/** The column names of a `create table` in the migration. */
function sqlColumns(table) {
  const m = new RegExp(`create table if not exists public\\.${table} \\(([\\s\\S]*?)\\n\\);`).exec(SQL);
  return m[1]
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[a-z0-9_]+ (uuid|text|timestamptz|jsonb|date|bigint|int)\b/.test(l))
    .map((l) => l.split(' ')[0])
    .sort();
}

const exp = (user, over = {}) => ({ user_id: user.id, project_id: 'proj-1', kind: 'post', mode: 'times', changed: 'hook', network: 'instagram', metric: 'engagement_rate', subject_ref: 'post-1', state: 'draft', ...over });

describe('the migration', () => {
  it('sorts after the last migration and the mock rows carry exactly its columns', async () => {
    const files = fs.readdirSync(new URL('../../supabase/migrations/', import.meta.url)).sort();
    expect(files.indexOf('20261117000000_experiments.sql')).toBeGreaterThan(files.indexOf('20261116100000_ad_policy_confirmed.sql'));
    const { user } = await supa.tokenFor('cols@x.test');
    const [e] = await db.insert('experiments', exp(user), { returning: true });
    expect(Object.keys(e).sort()).toEqual(sqlColumns('experiments'));
    const [v] = await db.insert('experiment_variants', { experiment_id: e.id, key: 'a', user_id: user.id }, { returning: true });
    expect(Object.keys(v).sort()).toEqual(sqlColumns('experiment_variants'));
    expect(SQL).toContain('alter table public.page_leads add column if not exists experiment_id uuid;');
    expect(SQL).toContain('alter table public.page_leads add column if not exists variant_key text;');
    for (const fn of ['ylb_experiment_start(p_id uuid, p_user uuid, p_window_start date, p_limit int)', 'ylb_experiment_count(p_user uuid, p_window_start date)', 'ylb_experiment_add_counts(p_rows jsonb)', 'ylb_experiment_claim_reads(p_limit int, p_lease int)']) {
      expect(SQL).toContain(`create or replace function public.${fn}`);
    }
    // execute only for the server
    expect(SQL.match(/grant execute on function public\.ylb_experiment_\w+\([^)]*\) to service_role;/g)).toHaveLength(4);
  });

  it('refuses a mode, a metric or a Trial Reels network that doesn’t fit the kind', async () => {
    const { user } = await supa.tokenFor('checks@x.test');
    await expect(db.insert('experiments', exp(user, { mode: 'split' }))).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(db.insert('experiments', exp(user, { metric: 'lead_rate' }))).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(db.insert('experiments', exp(user, { mode: 'trial_reels', network: 'tiktok' }))).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(db.insert('experiments', exp(user, { kind: 'page', mode: 'split', changed: 'headline', network: null, metric: 'lead_rate', subject_ref: 'seo:proj-1' }))).resolves.toBeDefined();
  });
});

describe('ylb_experiment_start and ylb_experiment_count', () => {
  it('counts a start once in its window, refuses at the limit, and two starts at the limit can’t both pass', async () => {
    const { user } = await supa.tokenFor('limit@x.test');
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push((await db.insert('experiments', exp(user, { subject_ref: `post-${i}` }), { returning: true }))[0].id);
    const start = (id, limit = 2, win = '2026-11-03') => db.rpc('ylb_experiment_start', { p_id: id, p_user: user.id, p_window_start: win, p_limit: limit });
    expect(await start(ids[0])).toBe('ok');
    expect(await start(ids[0])).toBe('state');
    expect(await db.rpc('ylb_experiment_count', { p_user: user.id, p_window_start: '2026-11-03' })).toBe(1);
    const both = await Promise.all([start(ids[1]), start(ids[2])]);
    expect(both.sort()).toEqual(['limit', 'ok']);
    expect(await db.rpc('ylb_experiment_count', { p_user: user.id, p_window_start: '2026-11-03' })).toBe(2);
    // the next window starts from 0; no limit (null) always passes
    expect(await start(ids[3], 2, '2026-12-03')).toBe('ok');
    const row = supa.tables.get('experiments').find((e) => e.id === ids[3]);
    expect(row).toMatchObject({ state: 'running', counted_month: '2026-12-03', started_at: new Date(now).toISOString() });
    const extra = (await db.insert('experiments', exp(user, { subject_ref: 'post-9' }), { returning: true }))[0].id;
    expect(await start(extra, null)).toBe('ok');
    expect(await db.rpc('ylb_experiment_start', { p_id: crypto.randomUUID(), p_user: user.id, p_window_start: '2026-11-03', p_limit: 2 })).toBe('missing');
  });

  it('keeps one running split per page', async () => {
    const { user } = await supa.tokenFor('split@x.test');
    const page = (over) => exp(user, { kind: 'page', mode: 'split', changed: 'headline', network: null, metric: 'lead_rate', subject_ref: 'seo:proj-1', ...over });
    const [a] = await db.insert('experiments', page(), { returning: true });
    const [b] = await db.insert('experiments', page(), { returning: true });
    const start = (id) => db.rpc('ylb_experiment_start', { p_id: id, p_user: user.id, p_window_start: '2026-11-03', p_limit: null });
    expect(await start(a.id)).toBe('ok');
    expect(await start(b.id)).toBe('running');
    expect(supa.tables.get('experiments').find((e) => e.id === b.id).state).toBe('draft');
  });
});

describe('the page split counters and the result reader', () => {
  it('adds counts only to running tests, summing repeats, at most 200 rows', async () => {
    const { user } = await supa.tokenFor('counts@x.test');
    const [run] = await db.insert('experiments', exp(user, { kind: 'page', mode: 'split', changed: 'cta', network: null, metric: 'lead_rate', subject_ref: 'seo:p2', state: 'running' }), { returning: true });
    const [stopped] = await db.insert('experiments', exp(user, { kind: 'page', mode: 'split', changed: 'cta', network: null, metric: 'lead_rate', subject_ref: 'seo:p3', state: 'stopped' }), { returning: true });
    for (const e of [run, stopped]) for (const key of ['a', 'b']) await db.insert('experiment_variants', { experiment_id: e.id, key, user_id: user.id });
    const n = await db.rpc('ylb_experiment_add_counts', { p_rows: [{ experiment_id: run.id, key: 'a', visitors: 2, views: 3, leads: 0 }, { experiment_id: run.id, key: 'a', visitors: 1, views: 1, leads: 1 }, { experiment_id: run.id, key: 'b', visitors: -5, views: 1 }, { experiment_id: stopped.id, key: 'a', visitors: 9 }] });
    expect(n).toBe(2);
    const vs = supa.tables.get('experiment_variants');
    expect(vs.find((v) => v.experiment_id === run.id && v.key === 'a')).toMatchObject({ visitors: 3, views: 4, leads: 1 });
    expect(vs.find((v) => v.experiment_id === run.id && v.key === 'b')).toMatchObject({ visitors: 0, views: 1, leads: 0 });
    expect(vs.find((v) => v.experiment_id === stopped.id && v.key === 'a').visitors).toBe(0);
  });

  it('claims running post and email tests due a read, oldest first, never the same one twice', async () => {
    supa.tables.set('experiments', []);
    const { user } = await supa.tokenFor('reads@x.test');
    const iso = (t) => new Date(t).toISOString();
    const rows = [
      exp(user, { state: 'running', subject_ref: 'p-new', last_read_at: null }),
      exp(user, { state: 'running', subject_ref: 'p-old', last_read_at: iso(now - 5 * HOUR) }),
      exp(user, { state: 'running', subject_ref: 'p-fresh', last_read_at: iso(now - HOUR) }),
      exp(user, { state: 'draft', subject_ref: 'p-draft' }),
      exp(user, { kind: 'email', mode: 'omnisend_ab', changed: 'subject', network: null, metric: 'open_rate', state: 'running', subject_ref: 's:1', last_read_at: iso(now - 4 * HOUR) }),
      exp(user, { kind: 'email', mode: 'omnisend_ab', changed: 'subject', network: null, metric: 'open_rate', state: 'running', subject_ref: 's:2', last_read_at: iso(now - 7 * HOUR) }),
    ];
    for (const r of rows) await db.insert('experiments', r);
    const [x, y] = await Promise.all([db.rpc('ylb_experiment_claim_reads', { p_limit: 2, p_lease: 600 }), db.rpc('ylb_experiment_claim_reads', { p_limit: 5, p_lease: 600 })]);
    const refs = [...x, ...y].map((c) => supa.tables.get('experiments').find((e) => e.id === c.id).subject_ref);
    expect(refs.sort()).toEqual(['p-new', 'p-old', 's:2']);
    expect(x.every((c) => c.user_id === user.id && /^[0-9a-f-]{36}$/.test(c.read_claim))).toBe(true);
    expect(await db.rpc('ylb_experiment_claim_reads', { p_limit: 5, p_lease: 600 })).toEqual([]);
  });
});

describe('deletes and access', () => {
  it('deleting a business deletes its tests and their variants; deleting a test deletes its variants', async () => {
    const t = await supa.tokenFor('del@x.test');
    await db.upsert('user_docs', { user_id: t.user.id, kind: 'project', id: 'proj-del', data: { id: 'proj-del' } }, { onConflict: 'user_id,kind,id' });
    const [e] = await db.insert('experiments', exp(t.user, { project_id: 'proj-del' }), { returning: true });
    const [f] = await db.insert('experiments', exp(t.user, { project_id: 'proj-keep', subject_ref: 'post-k' }), { returning: true });
    await db.insert('experiment_variants', [{ experiment_id: e.id, key: 'a', user_id: t.user.id, post_id: 'post-d1' }, { experiment_id: f.id, key: 'a', user_id: t.user.id, post_id: 'post-k1' }]);
    // a post is a variant of one test only
    await expect(db.insert('experiment_variants', { experiment_id: f.id, key: 'b', user_id: t.user.id, post_id: 'post-k1' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await db.remove('user_docs', { user_id: t.user.id, kind: 'project', id: 'proj-del' });
    expect(supa.tables.get('experiments').some((x) => x.id === e.id)).toBe(false);
    expect(supa.tables.get('experiment_variants').some((v) => v.experiment_id === e.id)).toBe(false);
    await db.remove('experiments', { id: f.id, user_id: t.user.id });
    expect(supa.tables.get('experiment_variants').some((v) => v.experiment_id === f.id)).toBe(false);
  });

  it('users read their own rows, never a page version’s HTML, and never write', async () => {
    const t = await supa.tokenFor('read@x.test');
    const [e] = await db.insert('experiments', exp(t.user, { subject_ref: 'post-r' }), { returning: true });
    await db.insert('experiment_variants', { experiment_id: e.id, key: 'b', user_id: t.user.id, html: '<p>B</p>' });
    const headers = { apikey: supa.PUBLISHABLE, authorization: `Bearer ${t.token}`, 'content-type': 'application/json' };
    expect(await (await fetch(`${supa.url}/rest/v1/experiments?select=id,state`, { headers })).json()).toEqual([{ id: e.id, state: 'draft' }]);
    expect((await fetch(`${supa.url}/rest/v1/experiment_variants?select=key,visitors`, { headers })).status).toBe(200);
    for (const select of ['html', '*', 'key,html']) expect((await fetch(`${supa.url}/rest/v1/experiment_variants?select=${select}`, { headers })).status, select).toBe(401);
    expect((await fetch(`${supa.url}/rest/v1/experiments?id=eq.${e.id}`, { method: 'PATCH', headers, body: JSON.stringify({ state: 'running' }) })).status).toBe(401);
    expect((await fetch(`${supa.url}/rest/v1/rpc/ylb_experiment_start`, { method: 'POST', headers, body: JSON.stringify({ p_id: e.id, p_user: t.user.id, p_window_start: '2026-11-03', p_limit: null }) })).status).toBe(401);
  });
});
