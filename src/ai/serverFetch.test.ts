// Every request to your server says who's signed in: with accounts on, the server refuses AI without
// it (and the app then quietly falls back to the built-in engine, as if no key worked).
import { afterEach, describe, expect, it, vi } from 'vitest';

const authHeaders = vi.fn(async (target: string) => (target.startsWith('/') || target.startsWith('https://app.example/') ? { authorization: 'Bearer user-token' } : {}));
vi.mock('@/lib/cloud/auth', () => ({ authHeaders: (t: string) => authHeaders(t) }));

const { serverFetch, pingServer } = await import('./claude');

const seen: { url: string; headers: Headers }[] = [];
const fakeFetch = vi.fn(async (url: string, init: RequestInit = {}) => {
  seen.push({ url, headers: new Headers(init.headers) });
  return new Response(JSON.stringify({ ok: true, ai: { ready: true, providers: [], routing: {} } }), { status: 200, headers: { 'content-type': 'application/json' } });
});
vi.stubGlobal('fetch', fakeFetch);

afterEach(() => {
  seen.length = 0;
  authHeaders.mockClear();
});

describe('requests to your server', () => {
  it('carry the sign-in token, asked for with the full address', async () => {
    await serverFetch('', '/api/ai/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(authHeaders).toHaveBeenCalledWith('/api/ai/generate');
    expect(seen[0].url).toBe('/api/ai/generate');
    expect(seen[0].headers.get('authorization')).toBe('Bearer user-token');
    expect(seen[0].headers.get('content-type')).toBe('application/json');
  });

  it('include the health check (which tells the app which keys power what)', async () => {
    await pingServer('');
    expect(seen[0].url).toBe('/api/health');
    expect(seen[0].headers.get('authorization')).toBe('Bearer user-token');
  });

  it('send no token to another site', async () => {
    await serverFetch('https://elsewhere.example/', '/api/ai/generate', { method: 'POST' });
    expect(authHeaders).toHaveBeenCalledWith('https://elsewhere.example/api/ai/generate');
    expect(seen[0].headers.get('authorization')).toBeNull();
  });
});
