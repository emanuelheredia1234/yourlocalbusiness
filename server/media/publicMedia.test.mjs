// GET /api/media/public/<token> (spec §1.7 "Media", §9.2 WP2 media token tests).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mediaToken, publicMediaUrl, verifyMediaToken } from '../social/media.mjs';
import { MP4, PNG, startPosting, TEST_SECRETS } from '../social/test-helpers.mjs';
import { parseRange } from './publicMedia.mjs';

let t;
let alice;
let bob;

beforeAll(async () => {
  t = await startPosting();
  alice = await t.user('alice-media@example.com');
  bob = await t.user('bob-media@example.com');
  t.file(alice, 'pic-1', PNG, 'image/png');
  t.file(alice, 'vid-1', MP4, 'video/mp4');
});
afterAll(async () => {
  await t.close();
});

const get = (token, headers = {}, method = 'GET') => fetch(`${t.base}/api/media/public/${token}`, { method, headers });

describe('the public media link', () => {
  it('streams the file with private, noindex headers', async () => {
    const token = mediaToken(t.env, { userId: alice.id, mediaId: 'pic-1', kind: 'image' }, t.clock.t);
    const r = await get(token);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/png');
    expect(r.headers.get('content-length')).toBe(String(PNG.length));
    expect(r.headers.get('cache-control')).toBe('private, max-age=0');
    expect(r.headers.get('x-robots-tag')).toBe('noindex');
    expect(Buffer.from(await r.arrayBuffer()).equals(PNG)).toBe(true);
    const h = await get(token, {}, 'HEAD');
    expect(h.status).toBe(200);
    expect(h.headers.get('content-length')).toBe(String(PNG.length));
  });

  it('answers a Range request with 206 and just those bytes', async () => {
    const token = mediaToken(t.env, { userId: alice.id, mediaId: 'vid-1', kind: 'video' }, t.clock.t);
    const r = await get(token, { range: 'bytes=10-99' });
    expect(r.status).toBe(206);
    expect(r.headers.get('content-range')).toBe(`bytes 10-99/${MP4.length}`);
    expect(r.headers.get('content-length')).toBe('90');
    expect(Buffer.from(await r.arrayBuffer()).equals(MP4.subarray(10, 100))).toBe(true);
    const tail = await get(token, { range: 'bytes=-16' });
    expect(tail.status).toBe(206);
    expect(Buffer.from(await tail.arrayBuffer()).equals(MP4.subarray(MP4.length - 16))).toBe(true);
    expect((await get(token, { range: `bytes=${MP4.length + 5}-` })).status).toBe(416);
  });

  it('a bad MAC answers 403, an expired token 410', async () => {
    const token = mediaToken(t.env, { userId: alice.id, mediaId: 'pic-1', kind: 'image' }, t.clock.t);
    const [payload, sig] = token.split('.');
    const flipped = `${payload}.${sig[0] === 'A' ? 'B' : 'A'}${sig.slice(1)}`;
    expect((await get(flipped)).status).toBe(403);
    // someone else's id in a payload signed with another key
    const forged = mediaToken({ MEDIA_URL_SECRET: 'another-secret-entirely-0123456789' }, { userId: alice.id, mediaId: 'pic-1', kind: 'image' }, t.clock.t);
    expect((await get(forged)).status).toBe(403);
    expect((await get('not-a-token')).status).toBe(403);
    const old = mediaToken(t.env, { userId: alice.id, mediaId: 'pic-1', kind: 'image' }, t.clock.t - 31 * 60_000);
    expect((await get(old)).status).toBe(410);
    // a video link lasts 2 hours
    const video = mediaToken(t.env, { userId: alice.id, mediaId: 'vid-1', kind: 'video' }, t.clock.t - 90 * 60_000);
    expect((await get(video, { range: 'bytes=0-3' })).status).toBe(206);
    expect(verifyMediaToken(t.env, video, t.clock.t + 31 * 60_000)).toMatchObject({ ok: false, why: 'expired' });
  });

  it('another user’s file, or one that isn’t there, answers 404', async () => {
    // a valid token for Bob naming Alice's file id: Bob's folder has no such file
    const token = mediaToken(t.env, { userId: bob.id, mediaId: 'pic-1', kind: 'image' }, t.clock.t);
    expect((await get(token)).status).toBe(404);
    expect((await get(mediaToken(t.env, { userId: alice.id, mediaId: 'nope', kind: 'image' }, t.clock.t))).status).toBe(404);
  });

  it('isn’t served without MEDIA_URL_SECRET, and links can’t be made without it', () => {
    expect(() => mediaToken({}, { userId: alice.id, mediaId: 'pic-1', kind: 'image' })).toThrow();
    expect(publicMediaUrl({ ...TEST_SECRETS, MEDIA_PUBLIC_BASE_URL: 'https://x.test/' }, { userId: alice.id, mediaId: 'pic-1', kind: 'image' })).toMatch(/^https:\/\/x\.test\/api\/media\/public\//);
  });

  it('parses ranges', () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=0-500', 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=5-1', 100)).toBe('bad');
    expect(parseRange('bytes=0-1,5-6', 100)).toBe('bad');
    expect(parseRange('items=0-1', 100)).toBe('bad');
  });
});

describe('which sides make links', () => {
  // Meta fetches launched ads' images from these links (server/ads/), so they work with social posting off
  async function serveWith(connections) {
    const http = await import('node:http');
    const { createPublicMediaRoutes } = await import('./publicMedia.mjs');
    const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
    const routes = createPublicMediaRoutes({
      env: TEST_SECRETS,
      connections,
      send: (res, status, body, headers = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(body));
      },
      mediaStore: { enabled: true, head: async () => ({ type: 'image/jpeg', size: JPEG.length }), get: async () => new Response(JPEG, { status: 200, headers: { 'content-length': String(JPEG.length) } }) },
    });
    const server = http.createServer((req, res) => void routes.handle(req, res, new URL(req.url, 'http://local')));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
  }
  const uid = '0b6f3a52-5d0e-4c58-9a0c-0e7c5b1d2a11';

  it('serves an ad image with social off and ads on; refuses only when both are off', async () => {
    const url = (base) => publicMediaUrl({ ...TEST_SECRETS, MEDIA_PUBLIC_BASE_URL: base }, { userId: uid, mediaId: 'ad-a.jpg', kind: 'image', type: 'image/jpeg' });
    const adsOnly = await serveWith({ socialEnabled: false, adsEnabled: true });
    const off = await serveWith({ socialEnabled: false, adsEnabled: false });
    try {
      const r = await fetch(url(adsOnly.base));
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toBe('image/jpeg');
      expect((await fetch(url(off.base))).status).toBe(503);
    } finally {
      await adsOnly.close();
      await off.close();
    }
  });
});
