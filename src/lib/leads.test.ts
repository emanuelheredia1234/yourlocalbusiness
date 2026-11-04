// Leads from a page's form, as the app reads them: only well-formed answers become leads, the CSV never
// lets a visitor's text run as a spreadsheet formula, a lead becomes a subscriber only with a real email,
// the page id matches the one the page is published with, and the server's refusals read in plain words.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Project } from './types';
import { LeadsError, csvCell, deleteLead, leadEmail, leadTime, leadToSubscriber, leadsCsv, listLeads, seoPageIdOf, toLead, type Lead } from './leads';
import { seoPageId } from './seoPage';

const lead = (over: Partial<Lead> = {}): Lead => ({ id: 'l1', pageId: 'seo:p1', slug: 'maya-bakes', name: 'Ann Lee', email: 'Ann.Lee@Example.com', phone: '', message: 'Hi', time: '', createdAt: '2026-11-03T10:00:00.123456+00:00', ...over });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('reading the server’s answer', () => {
  it('takes only objects with an id, and only text in each field', () => {
    for (const bad of [null, undefined, 'x', 3, [], [{ id: 'a' }], {}, { id: '' }, { id: 7 }]) expect(toLead(bad), JSON.stringify(bad)).toBeNull();
    expect(toLead({ id: 'a', pageId: 'seo:p', slug: 's', name: { evil: true }, email: 5, phone: null, message: ['x'], time: undefined, createdAt: '2026-11-03T10:00:00Z', extra: '<b>x</b>' })).toEqual({ id: 'a', pageId: 'seo:p', slug: 's', name: '', email: '', phone: '', message: '', time: '', createdAt: '2026-11-03T10:00:00Z' });
  });

  it('reads the time, microseconds and all, and 0 when it can’t', () => {
    expect(leadTime(lead())).toBe(Date.UTC(2026, 10, 3, 10, 0, 0, 123));
    expect(leadTime({ createdAt: '' })).toBe(0);
    expect(leadTime({ createdAt: 'yesterday' })).toBe(0);
  });
});

describe('the CSV', () => {
  it('quotes every cell, keeps line breaks, and turns would-be formulas into text', () => {
    expect(csvCell('plain')).toBe('"plain"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell('=1+1')).toBe(`"'=1+1"`);
    expect(csvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    for (const s of ['@x', '+x', '-x', '\tx', '\rx']) expect(csvCell(s), JSON.stringify(s)).toBe(`"'${s}"`);
    expect(csvCell('a=1')).toBe('"a=1"');
    expect(csvCell('')).toBe('""');
  });

  it('has a header row, then one row per lead with its page and when it came in', () => {
    const csv = leadsCsv([lead({ message: '=SUM(A1)\nline 2', phone: '+1 512 555 0100', time: 'Tuesday morning' }), lead({ id: 'l2', name: '', email: '', phone: '555 0100', createdAt: 'bad' })], (l) => `/${l.slug} · Maya Bakes`);
    const rows = csv.split('\n');
    expect(rows[0]).toBe('name,email,phone,preferred_time,message,page,received');
    expect(csv).toBe(
      [
        'name,email,phone,preferred_time,message,page,received',
        `"Ann Lee","Ann.Lee@Example.com","'+1 512 555 0100","Tuesday morning","'=SUM(A1)\nline 2","/maya-bakes · Maya Bakes","2026-11-03T10:00:00.123Z"`,
        `"","","555 0100","","Hi","/maya-bakes · Maya Bakes","bad"`,
      ].join('\n'),
    );
  });
});

describe('a lead as a subscriber', () => {
  it('needs a real email, lower-cased, and is marked as from your page', () => {
    expect(leadToSubscriber(lead({ email: '' }), 'sub_1')).toBeNull();
    expect(leadToSubscriber(lead({ email: 'javascript:alert(1)' }), 'sub_1')).toBeNull();
    expect(leadToSubscriber(lead({ email: 'nope' }), 'sub_1')).toBeNull();
    expect(leadToSubscriber(lead(), 'sub_1')).toEqual({ id: 'sub_1', name: 'Ann Lee', email: 'ann.lee@example.com', joinedAt: Date.UTC(2026, 10, 3, 10, 0, 0, 123), source: 'lead' });
    expect(leadToSubscriber(lead({ name: '  ', email: ' Bo@Shop.Example ' }), 'sub_2')).toMatchObject({ name: 'bo', email: 'bo@shop.example', source: 'lead' });
    expect(leadEmail(lead({ email: 'x <y@z.com>' }))).toBe('');
    // longer than any email the server takes: not looked at
    expect(leadEmail(lead({ email: `${'a'.repeat(250)}@example.com` }))).toBe('');
  });
});

describe('the page id', () => {
  it('is the one the SEO page is published with, for any project id', () => {
    for (const id of ['proj_abc123', 'proj/1 ü', 'old id/with:odd chars', 'x'.repeat(100), '']) expect(seoPageIdOf(id), id).toBe(seoPageId({ id } as Project));
  });
});

describe('the server', () => {
  const answer = (status: number, body: unknown) => vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

  it('asks for a page of leads, passing the time back exactly', async () => {
    const fetch = answer(200, { leads: [{ id: 'a', pageId: 'seo:p1', slug: 's', createdAt: '2026-11-03T10:00:00.5+00:00' }, { nope: true }, 'x'] });
    vi.stubGlobal('fetch', fetch);
    const leads = await listLeads({ before: '2026-11-03T10:00:00.123456+00:00', pageId: 'seo:p1' });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('/api/leads?before=2026-11-03T10%3A00%3A00.123456%2B00%3A00&limit=50&pageId=seo%3Ap1');
    expect(init?.method).toBe('GET');
    expect(leads).toEqual([{ id: 'a', pageId: 'seo:p1', slug: 's', name: '', email: '', phone: '', message: '', time: '', createdAt: '2026-11-03T10:00:00.5+00:00' }]);
    await listLeads({ limit: 500 });
    expect(fetch.mock.calls[1][0]).toBe('/api/leads?limit=100');
    await listLeads();
    expect(fetch.mock.calls[2][0]).toBe('/api/leads?limit=50');
  });

  it('says what went wrong in plain words', async () => {
    const cases: [number, unknown, string, string][] = [
      [401, { error: 'Sign in to see your leads.', code: 'AUTH_REQUIRED' }, 'AUTH_REQUIRED', 'Your sign-in has ended. Sign in again, then try once more.'],
      [503, { error: 'Publishing isn’t set up…', code: 'PAGES_OFF' }, 'PAGES_OFF', 'Leads need publishing, which isn’t set up on this app’s server yet.'],
      [429, { error: 'Too many requests.', code: 'RATE_LIMIT' }, 'RATE_LIMIT', 'That’s a lot of requests at once. Wait a minute, then try again.'],
      [403, { error: 'Cross-site request refused.', code: 'FORBIDDEN' }, 'FORBIDDEN', 'This request was refused because it didn’t come from the app’s own page.'],
      [503, { error: 'Run supabase/migrations/20261103050000_page_leads.sql in Supabase → SQL Editor.', code: 'LEADS_TABLE' }, 'LEADS_TABLE', 'Run supabase/migrations/20261103050000_page_leads.sql in Supabase → SQL Editor.'],
      [429, null, 'RATE_LIMIT', 'That’s a lot of requests at once. Wait a minute, then try again.'],
      [500, { error: 'Unexpected server error' }, 'HTTP_500', 'Unexpected server error'],
    ];
    for (const [status, body, code, message] of cases) {
      vi.stubGlobal('fetch', answer(status, body));
      const e = await listLeads().catch((x: unknown) => x);
      expect(e, code).toBeInstanceOf(LeadsError);
      expect((e as LeadsError).code, code).toBe(code);
      expect((e as LeadsError).message, code).toBe(message);
      expect((e as LeadsError).status, code).toBe(status);
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const e = (await listLeads().catch((x: unknown) => x)) as LeadsError;
    expect([e.code, e.message]).toEqual(['NETWORK', 'Couldn’t reach the server. Check your connection, then try again.']);
  });

  it('deletes a lead once, and one that’s already gone counts as deleted', async () => {
    let fetch = answer(200, { ok: true });
    vi.stubGlobal('fetch', fetch);
    await deleteLead('0b7c1a2e-1111-4222-8333-444455556666');
    expect(fetch.mock.calls[0][0]).toBe('/api/leads/0b7c1a2e-1111-4222-8333-444455556666');
    expect(fetch.mock.calls[0][1]?.method).toBe('DELETE');
    vi.stubGlobal('fetch', answer(404, { error: 'That lead isn’t in your list.', code: 'NOT_FOUND' }));
    await expect(deleteLead('gone')).resolves.toBeUndefined();
    fetch = answer(503, { error: 'Supabase refused that.', code: 'UPSTREAM' });
    vi.stubGlobal('fetch', fetch);
    await expect(deleteLead('x/y')).rejects.toMatchObject({ code: 'UPSTREAM' });
    // never tried again by itself, and the id stays in its own part of the address
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe('/api/leads/x%2Fy');
  });
});
