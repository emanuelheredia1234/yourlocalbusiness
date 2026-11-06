// The names published pages can't take, and the short public prefixes (/b/, /m/, /o/) no page can answer on.
import { describe, expect, it } from 'vitest';
import { createPages, isPublicRoute, PUBLIC_ROUTE_PREFIXES, RESERVED_SLUGS, SLUG_RE } from './pages.mjs';

const UPCOMING = ['market', 'pricing', 'plans', 'unsubscribe', 'offers', 'thank-you', 'thanks', 'download', 'store', 'listings', 'cron', 'webhooks'];

describe('reserved names', () => {
  it('keeps the upcoming public routes for the app', () => {
    for (const slug of UPCOMING) {
      expect(SLUG_RE.test(slug), slug).toBe(true);
      expect(RESERVED_SLUGS.has(slug), slug).toBe(true);
    }
  });

  it('the short prefixes can never be a published name', () => {
    expect(PUBLIC_ROUTE_PREFIXES).toEqual(['/b/', '/m/', '/o/']);
    for (const p of ['b', 'm', 'o']) {
      expect(SLUG_RE.test(p)).toBe(false);
      expect(RESERVED_SLUGS.has(p)).toBe(true);
    }
    expect(isPublicRoute('/b/abc123')).toBe(true);
    expect(isPublicRoute('/m/x')).toBe(true);
    expect(isPublicRoute('/o/token')).toBe(true);
    expect(isPublicRoute('/bob')).toBe(false);
    expect(isPublicRoute('/market')).toBe(false);
  });

  it('matchPage never takes /b/, /m/ or /o/, and still takes a page name', () => {
    const pages = createPages({ supabaseUrl: 'http://127.0.0.1:9', secretKey: 'test-secret-key', auth: { enabled: true }, send() {}, readJson: async () => ({}) });
    const at = (p) => new URL(`http://local${p}`);
    expect(pages.matchPage(at('/joes-bakery'))).toBe(true);
    for (const p of ['/b/abc', '/m/abc', '/o/abc', '/b/img/x.png', '/m/', '/o/abc/']) expect(pages.matchPage(at(p)), p).toBe(false);
    expect(pages.matchPage(at('/joes-bakery/'))).toBe(true);
  });
});
