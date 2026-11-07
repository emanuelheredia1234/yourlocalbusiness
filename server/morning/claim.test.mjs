// The mock database's emulation of 20261116000000_morning_action.sql: the claim's filters and order, disjoint
// concurrent claims, the lease, the backlog count, the project-delete trigger, users reading (never writing) their
// own rows, and nested JSON-path selects. The real row lock and RLS are checked on a Supabase branch (docs §13).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMockSupabase } from '../test/mock-supabase.mjs';
import { createDb } from '../integrations/db.mjs';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let supa;
let db;
const now = Date.parse('2026-11-07T15:07:00Z');

beforeAll(async () => {
  supa = await (await createMockSupabase()).start();
  supa.behavior.now = () => now;
  db = createDb({ supabaseUrl: supa.url, secretKey: supa.SECRET });
});
afterAll(() => supa.close());

const iso = (t) => new Date(t).toISOString();
async function business(email, id, { due = now - HOUR, active = now - DAY, onboarded = true, tz = 'America/Los_Angeles' } = {}) {
  const { user } = await supa.tokenFor(email);
  await db.upsert('user_docs', { user_id: user.id, kind: 'project', id, data: { id, onboarded, timeZone: tz, marketing: { leadsSeenAt: 5 } } }, { onConflict: 'user_id,kind,id' });
  await db.insert('business_settings', { user_id: user.id, project_id: id, time_zone: 'UTC', next_action_at: due == null ? null : iso(due), last_active_at: iso(active) });
  return user;
}
const claim = (n = 6) => db.rpc('ylb_morning_claim', { p_limit: n, p_lease_seconds: 600 });

describe('mock morning claim', () => {
  it('claims only due, active, onboarded, eligible businesses, oldest first, with the saved zone and a lease', async () => {
    const a = await business('a@m.test', 'proj_a', { due: now - 2 * HOUR });
    await business('b@m.test', 'proj_b', { due: now - 3 * HOUR });
    await business('c@m.test', 'proj_c', { due: now + HOUR });
    await business('d@m.test', 'proj_d', { active: now - 15 * DAY });
    await business('e@m.test', 'proj_e', { onboarded: false });
    await business('f@m.test', 'proj_f', { due: null });
    const g = await business('g@m.test', 'proj_g');
    supa.tables.set('project_slots', [...(supa.tables.get('project_slots') ?? []), { user_id: g.id, project_id: 'proj_g', state: 'locked' }]);
    const got = await claim(10);
    expect(got.map((r) => r.project_id)).toEqual(['proj_b', 'proj_a']);
    expect(got[1]).toMatchObject({ user_id: a.id, time_zone: 'UTC', doc_time_zone: 'America/Los_Angeles' });
    const row = supa.tables.get('business_settings').find((r) => r.project_id === 'proj_a');
    expect(row.claim_id).toBe(got[1].claim_id);
    expect(Date.parse(row.claimed_until)).toBe(now + 600_000);
    // held by the lease: nothing to claim again, and not in the backlog
    expect(await claim(10)).toEqual([]);
    expect(await db.rpc('ylb_morning_backlog', { p_older_than_seconds: 0 })).toBe(0);
  });

  it('concurrent claims get disjoint rows; plans enforced need an eligible account', async () => {
    supa.tables.set('business_settings', []);
    for (let i = 0; i < 8; i++) await business(`p${i}@m.test`, `proj_p${i}`, { due: now - HOUR - i * 1000 });
    const [x, y] = await Promise.all([claim(5), claim(5)]);
    const ids = [...x, ...y].map((r) => r.project_id);
    expect(ids.length).toBe(8);
    expect(new Set(ids).size).toBe(8);
    supa.tables.set('billing_settings', [{ id: 1, enforce: true }]);
    const n = await business('n@m.test', 'proj_n');
    const o = await business('o@m.test', 'proj_o');
    supa.tables.set('billing_accounts', [{ user_id: o.id, source: 'stripe', status: 'trialing' }, { user_id: n.id, source: 'stripe', status: 'canceled' }]);
    expect((await claim(10)).map((r) => r.project_id)).toEqual(['proj_o']);
    expect(await db.rpc('ylb_morning_backlog', { p_older_than_seconds: 1800 })).toBe(0);
    supa.tables.set('billing_settings', [{ id: 1, enforce: false }]);
    expect(await db.rpc('ylb_morning_backlog', { p_older_than_seconds: 1800 })).toBe(1);
  });

  it('deleting a business deletes its morning rows; users read their own rows and never write them', async () => {
    const t = await supa.tokenFor('del@m.test');
    await business('del@m.test', 'proj_del');
    await db.insert('daily_actions', { user_id: t.user.id, project_id: 'proj_del', local_date: '2026-11-07', time_zone: 'UTC', state: 'ready', source: 'cron' });
    const [row] = supa.tables.get('daily_actions').filter((r) => r.project_id === 'proj_del');
    expect(row).toMatchObject({ attempts: 1, candidates: [], feedback: [], cost_usd: 0 });
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    // one per business per day: a second insert is skipped by ON CONFLICT DO NOTHING
    const again = await db.insert('daily_actions', { user_id: t.user.id, project_id: 'proj_del', local_date: '2026-11-07', time_zone: 'UTC', state: 'generating', source: 'visit' }, { returning: true, ignoreDuplicates: true, onConflict: 'user_id,project_id,local_date' });
    expect(again).toEqual([]);
    const headers = { apikey: supa.PUBLISHABLE, authorization: `Bearer ${t.token}`, 'content-type': 'application/json' };
    const read = await fetch(`${supa.url}/rest/v1/daily_actions?select=id,state`, { headers });
    expect(await read.json()).toEqual([{ id: row.id, state: 'ready' }]);
    const write = await fetch(`${supa.url}/rest/v1/daily_actions?id=eq.${row.id}`, { method: 'PATCH', headers, body: JSON.stringify({ state: 'done' }) });
    expect(write.status).toBe(401);
    // nested JSON paths
    const [doc] = await db.select('user_docs', { user_id: t.user.id, kind: 'project', id: 'proj_del' }, { select: 'seen:data->marketing->>leadsSeenAt,tz:data->>timeZone' });
    expect(doc).toEqual({ seen: '5', tz: 'America/Los_Angeles' });
    await db.remove('user_docs', { user_id: t.user.id, kind: 'project', id: 'proj_del' });
    expect(supa.tables.get('daily_actions').some((r) => r.project_id === 'proj_del')).toBe(false);
    expect(supa.tables.get('business_settings').some((r) => r.project_id === 'proj_del')).toBe(false);
    // a bad state is refused by the check
    await expect(db.insert('daily_actions', { user_id: t.user.id, project_id: 'proj_x', local_date: '2026-11-07', time_zone: 'UTC', state: 'nope', source: 'cron' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
