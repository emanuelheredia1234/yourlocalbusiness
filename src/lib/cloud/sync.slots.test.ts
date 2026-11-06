// Plans and saving (spec §B3): a project the account refuses (the plan has no free business slot: Postgres 42501
// from row-level security) is set aside on this device instead of blocking everything else. Against mock-supabase's
// emulation of the billing migration (projectSlots), through the real supabase-js client.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createMockSupabase } from '../../../server/test/mock-supabase.mjs';
import { initial, useStore } from '@/store/useStore';
import { createSync, isSlotRefusal, supabaseBackend, useSyncStatus, type SyncBackend } from './sync';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let supa: any;
let client: SupabaseClient;
let userId: string;

const account = (limit: number) => ({
  customer_tag: `cust_${'b'.repeat(24)}`,
  source: 'stripe',
  tier: 'launch',
  interval: 'month',
  status: 'active',
  extra_businesses: limit - 1,
  comp_extra: 0,
  business_limit: limit,
  extra_keep: 0,
  cancel_at_period_end: false,
});

beforeAll(async () => {
  supa = await (await createMockSupabase({ projectSlots: true })).start();
  const { user } = await supa.tokenFor('slots@example.com');
  userId = user.id;
  client = createClient(supa.url, supa.PUBLISHABLE, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await client.auth.signInWithPassword({ email: 'slots@example.com', password: 'password123' });
  expect(error).toBeNull();
});
afterAll(() => supa.close());

const rows = () => (supa.tables.get('user_docs') ?? []) as { kind: string; id: string }[];
const claim = async (id: string) => (await client.rpc('claim_project_slot', { p_project_id: id })).data as { ok: boolean; reason?: string };

function newDevice(backend: SyncBackend = supabaseBackend(client, userId)) {
  const { version: _v, ...fresh } = initial();
  useStore.setState({ ...fresh, skills: [] });
  return createSync({ backend, userId, delay: 5, fresh: true });
}

beforeEach(() => {
  for (const t of ['user_docs', 'project_slots', 'billing_accounts']) supa.tables.set(t, []);
  supa.tables.set('billing_settings', [{ id: 1, enforce: true, card_trial_days: 0, existing_trial_days: 30 }]);
  supa.tables.set('billing_accounts', [{ user_id: userId, ...account(1) }]);
  useSyncStatus.getState().set({ held: [], pending: 0, problem: null, message: null });
});

describe('a project the plan has no slot for', () => {
  it('is held on this device while the rest of the same save goes through (projects go one per request)', async () => {
    expect(await claim('proj_ok')).toMatchObject({ ok: true });
    const a = newDevice();
    await a.pull();
    a.start();
    const s = useStore.getState();
    s.createProject('business', 'new', 'proj_ok');
    s.createProject('business', 'new', 'proj_held');
    s.addPosts([{ id: 'post_1', projectId: 'proj_held', status: 'draft', platform: 'instagram', createdAt: 1, updatedAt: 1, headline: 'Hi', body: 'x' } as never]);
    // the held project means the account doesn't have everything yet
    expect(await a.flush()).toBe(false);
    a.stop();
    expect(rows().map((r) => `${r.kind}:${r.id}`).sort()).toEqual(['post:post_1', 'project:proj_ok', 'settings:user']);
    const st = useSyncStatus.getState();
    expect(st.held).toEqual(['proj_held']);
    // not a failure: no backoff, no error message, nothing pending
    expect(st.problem).toBeNull();
    expect(st.pending).toBe(0);
    expect(useStore.getState().projects.map((p) => p.id)).toEqual(['proj_ok', 'proj_held']);
    a.forget();
  });

  it('is never retried on its own, re-marked or removed by a pull, and changing it here keeps it held', async () => {
    const real = supabaseBackend(client, userId);
    let projectUpserts = 0;
    const counting: SyncBackend = {
      ...real,
      upsert: (r) => {
        projectUpserts += r.filter((x) => x.kind === 'project').length;
        return real.upsert(r);
      },
    };
    const a = newDevice(counting);
    await a.pull();
    a.start();
    useStore.getState().createProject('product', 'new', 'proj_held');
    await a.flush();
    expect(a.held()).toEqual(['proj_held']);
    expect(projectUpserts).toBe(1);
    // a pull: the account not having it is expected (it stays here, held, not "never saved yet")
    await a.pull();
    expect(useStore.getState().projects.map((p) => p.id)).toEqual(['proj_held']);
    expect(a.pending()).toBe(0);
    expect(a.held()).toEqual(['proj_held']);
    // an edit here doesn't send it again, nor does another save
    useStore.getState().updateProject('proj_held', (p) => ({ ...p, niche: 'candles' }));
    expect(await a.flush()).toBe(false);
    await a.flush();
    expect(projectUpserts).toBe(1);
    expect(a.held()).toEqual(['proj_held']);
    expect(rows().some((r) => r.id === 'proj_held')).toBe(false);
    a.stop();
    a.forget();
  });

  it('release() saves it once a slot is claimed for it (the plan got room)', async () => {
    const a = newDevice();
    await a.pull();
    a.start();
    useStore.getState().createProject('business', 'new', 'proj_held');
    await a.flush();
    expect(a.held()).toEqual(['proj_held']);
    // a business was added: the plan's limit is 2 now, and the slot is claimed for it
    supa.tables.set('billing_accounts', [{ user_id: userId, ...account(2) }]);
    expect(await claim('proj_held')).toMatchObject({ ok: true });
    a.release(['proj_held']);
    expect(await a.flush()).toBe(true);
    expect(a.held()).toEqual([]);
    expect(useSyncStatus.getState().held).toEqual([]);
    expect(rows().some((r) => r.kind === 'project' && r.id === 'proj_held')).toBe(true);
    a.stop();
    a.forget();
  });

  it('drop() removes it from this device only (nothing is deleted from the account)', async () => {
    const a = newDevice();
    await a.pull();
    a.start();
    useStore.getState().createProject('business', 'new', 'proj_held');
    await a.flush();
    a.drop('proj_held');
    expect(useStore.getState().projects).toEqual([]);
    expect(a.held()).toEqual([]);
    expect(a.pending()).toBe(0);
    a.stop();
    a.forget();
  });
});

describe('other errors', () => {
  it('a refusal that isn’t row-level security still backs off as before (nothing is held)', async () => {
    const real = supabaseBackend(client, userId);
    const failing: SyncBackend = { ...real, upsert: async () => Promise.reject(Object.assign(new Error('boom'), { code: '500' })) };
    const a = newDevice(failing);
    await a.pull();
    a.start();
    useStore.getState().createProject('business', 'new', 'proj_x');
    expect(await a.flush()).toBe(false);
    expect(a.held()).toEqual([]);
    expect(a.pending()).toBeGreaterThan(0);
    expect(useSyncStatus.getState().problem).toBe('error');
    a.stop();
    a.forget();
  });

  it('isSlotRefusal reads PostgREST’s 42501', () => {
    expect(isSlotRefusal({ code: '42501', message: 'new row violates row-level security policy' })).toBe(true);
    expect(isSlotRefusal({ code: '23505' })).toBe(false);
    expect(isSlotRefusal(new Error('fetch failed'))).toBe(false);
    expect(isSlotRefusal(null)).toBe(false);
  });
});
