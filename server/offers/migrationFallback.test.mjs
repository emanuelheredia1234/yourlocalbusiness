// Before P6's migration (20261118000000_stripe_connect.sql) runs: Whop and outside buy links and lead magnets keep
// working on the older columns, and the reminder names P6's migration (never P2's or P3's).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBuy } from './buy.mjs';
import { DbError } from '../integrations/db.mjs';
import { createLeadFiles } from '../leadFiles.mjs';
import { createMockSupabase } from '../test/mock-supabase.mjs';

const ID = 'EEEEEEEEEEEEEEEEEEEEEE';
const P6_COLUMNS = ['connect_account_id', 'delivery', 'price_minor', 'currency'];

/** A response stand-in: status, headers and body. */
function fakeRes() {
  const out = { status: 0, headers: {}, body: '' };
  return {
    out,
    writeHead(status, headers = {}) {
      out.status = status;
      out.headers = headers;
    },
    end(b) {
      out.body = b ? String(b) : '';
    },
  };
}

describe('/b/ before P6’s migration', () => {
  it('an outside link still works: the P3 columns are asked for once P6’s are refused (42703), and the log names P6’s migration', async () => {
    const asked = [];
    const db = {
      enabled: true,
      async select(table, filters, { select }) {
        asked.push(select);
        if (P6_COLUMNS.some((c) => select.split(',').includes(c))) throw new DbError(400, 'BAD_REQUEST', 'The database refused that value.', { pg: '42703' });
        return [{ id: ID, user_id: 'u1', project_id: 'p1', title: 'Course', provider: 'external', connection_id: null, provider_ref: { url: 'https://shop.example.com/buy' }, status: 'active', updated_at: '2026-11-01T00:00:00Z' }];
      },
      async rpc() {
        return null;
      },
    };
    const lines = [];
    const buy = createBuy({ db, log: { warn: (l) => lines.push(l), log() {} } });
    const res = fakeRes();
    await buy.serveBuy({ method: 'GET', headers: {}, socket: { remoteAddress: '203.0.113.7' } }, res, new URL(`http://app.test/b/${ID}`), null, { notFound: (q, r) => r.writeHead(404), gone: (q, r) => r.writeHead(410) });
    expect(res.out.status).not.toBe(503);
    expect(res.out.status).not.toBe(404);
    expect(asked).toHaveLength(2);
    expect(asked[1].split(',').some((c) => P6_COLUMNS.includes(c))).toBe(false);
    expect(lines.join('\n')).toContain('20261118000000_stripe_connect.sql');
    // the next click asks with the P3 columns straight away
    buy.drop(ID);
    await buy.serveBuy({ method: 'GET', headers: {}, socket: { remoteAddress: '203.0.113.8' } }, fakeRes(), new URL(`http://app.test/b/${ID}`), null, { notFound: () => {}, gone: () => {} });
    expect(asked).toHaveLength(3);
    expect(asked[2]).toBe(asked[1]);
  });
});

describe('/m/ before P6’s migration', () => {
  let supa;
  beforeAll(async () => {
    supa = await (await createMockSupabase()).start();
  });
  afterAll(() => supa.close());

  it('a lead magnet is still found when lead_files has no purpose column; a product-file list is empty', async () => {
    const { user } = await supa.tokenFor('fallback@example.com');
    supa.tables.set('lead_files', [...(supa.tables.get('lead_files') ?? []), { id: ID, user_id: user.id, project_id: 'p1', title: 'Free guide', brand: '', kind: 'url', url: 'https://example.com/guide', gate: true, downloads: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }]);
    const seen = [];
    // PostgREST before the migration: naming purpose is 42703
    const fetchNoPurpose = async (url, init) => {
      const u = String(url);
      seen.push(u);
      if (u.includes('/rest/v1/lead_files') && /purpose/.test(decodeURIComponent(u) + String(init?.body ?? ''))) return new Response(JSON.stringify({ code: '42703', message: 'column lead_files.purpose does not exist' }), { status: 400, headers: { 'content-type': 'application/json' } });
      return fetch(url, init);
    };
    const files = createLeadFiles({ enabled: true, supabaseUrl: supa.url, secretKey: supa.SECRET, fetch: fetchNoPurpose, whoIs: async () => null, send: () => {}, readJson: async () => ({}) });
    const magnet = await files.findMagnet(ID, 'test');
    expect(magnet).toMatchObject({ id: ID, title: 'Free guide' });
    expect(seen.filter((u) => u.includes('/rest/v1/lead_files')).length).toBe(2);
  });
});
