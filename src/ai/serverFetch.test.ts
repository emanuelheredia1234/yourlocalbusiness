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

describe('the daily limit on the app’s keys', () => {
  it('a DAILY_LIMIT answer becomes the daily_limit error, with the server’s message', async () => {
    const { callServerAI, AIError } = await import('./claude');
    const message = 'You’ve reached today’s limit on the app’s AI keys (50 requests or $1.00 a day). It resets at midnight UTC. To keep going now, add your own API keys in Settings → AI.';
    fakeFetch.mockImplementationOnce(async () => new Response(JSON.stringify({ code: 'DAILY_LIMIT', error: message, limits: { reached: true } }), { status: 429, headers: { 'content-type': 'application/json' } }));
    const err = await callServerAI('product', 'hi', { serverUrl: '', tier: 'default' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AIError);
    expect((err as InstanceType<typeof AIError>).code).toBe('daily_limit');
    expect((err as Error).message).toBe(message);
  });
});
