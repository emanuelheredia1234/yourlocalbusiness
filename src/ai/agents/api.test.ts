// The client transport for Manus and Viktor: what each server answer means (a write that may have been
// delivered is never "not sent"), the request shapes the routes expect, and the Ref format.
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/cloud/auth', () => ({ authHeaders: async () => ({}) }));
const prepared = vi.fn(async (images: { key: string }[]) => images.map((i) => ({ name: `${i.key}.jpg`, mime: 'image/jpeg' as const, data: btoa('jpeg-bytes'), hash: 'h' })));
vi.mock('@/lib/promptImages', async (orig) => ({ ...(await orig<typeof import('@/lib/promptImages')>()), imagesForPublish: (images: { key: string }[]) => prepared(images) }));

const api = await import('./api');
const { AgentError, agentErrorText, agentFailure, manusRead, manusSend, manusStart, manusVerify, newRef, sendImages, viktorPreview, viktorRead, viktorSend, viktorVerify } = api;

type Call = { url: string; init: RequestInit };
const calls: Call[] = [];
let answer: (url: string, init: RequestInit) => Promise<Response> | Response = () => new Response('{}');
vi.stubGlobal(
  'fetch',
  vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return answer(url, init);
  }),
);
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const bodyOf = (c: Call) => JSON.parse(String(c.init.body));

afterEach(() => {
  calls.length = 0;
  answer = () => new Response('{}');
  prepared.mockClear();
});

describe('newRef', () => {
  it('is ylb- and 6 capital letters or digits, different each time', () => {
    const refs = new Set(Array.from({ length: 200 }, () => newRef()));
    for (const r of refs) expect(r).toMatch(/^ylb-[A-Z0-9]{6}$/);
    expect(refs.size).toBeGreaterThan(190);
  });
});

describe('what a server answer means', () => {
  const cases: [string, number, Record<string, unknown> | null, boolean, string][] = [
    ['no key or not ticked', 409, { code: 'NO_PROVIDER' }, true, 'SETUP'],
    ['Viktor not set up', 409, { code: 'NOT_READY', reason: 'no_viktor' }, true, 'SETUP'],
    ['own key needed', 403, { code: 'OWN_KEY_NEEDED' }, true, 'SETUP'],
    ['not configured', 501, { code: 'NOT_CONFIGURED' }, false, 'SETUP'],
    ['owner only', 403, { code: 'OWNER_ONLY' }, true, 'OWNER_ONLY'],
    ['admin token needed', 403, { code: 'FORBIDDEN' }, false, 'OWNER_ONLY'],
    ['not ours', 404, { code: 'NOT_FOUND' }, false, 'NOT_FOUND'],
    ['deleted', 410, { code: 'GONE' }, false, 'GONE'],
    ['too long', 413, { code: 'TOO_LONG', chars: 4200, limit: 3900 }, true, 'TOO_LONG'],
    ['too big', 413, { code: 'TOO_BIG' }, false, 'TOO_BIG'],
    ['no file', 404, { code: 'NO_FILE' }, false, 'NO_FILE'],
    ['not html', 415, { code: 'NOT_HTML', filename: 'page.zip' }, false, 'NOT_HTML'],
    ['a Manus website', 409, { code: 'WEBDEV' }, false, 'WEBDEV'],
    ['a remote file', 403, { code: 'EXTERNAL_FILE' }, false, 'EXTERNAL_FILE'],
    ['half a page', 422, { code: 'PARTIAL' }, false, 'PARTIAL'],
    ['rate limited', 429, { code: 'RATE_LIMIT', retryAfter: 2 }, true, 'RATE_LIMIT'],
    ['a write that may have gone (Slack)', 502, { code: 'SLACK_SEND_UNKNOWN', ref: 'ylb-AAAAAA' }, true, 'SEND_UNKNOWN'],
    ['a write that timed out', 504, { code: 'TIMEOUT' }, true, 'SEND_UNKNOWN'],
    ['a write cut off', 502, { code: 'CUT_OFF' }, true, 'SEND_UNKNOWN'],
    ['a write with an upstream error', 502, { code: 'UPSTREAM' }, true, 'SEND_UNKNOWN'],
    ['a write behind a proxy error page', 502, null, true, 'SEND_UNKNOWN'],
    ['a write Slack refused', 502, { code: 'SLACK_ERROR', slack: 'channel_not_found' }, true, 'NOT_SENT'],
    ['a write refused by the server', 400, { code: 'BAD_REQUEST' }, true, 'NOT_SENT'],
    ['a read with an upstream error', 502, { code: 'UPSTREAM' }, false, 'NETWORK'],
    ['a read behind a proxy error page', 503, null, false, 'NETWORK'],
    ['a read refused', 400, { code: 'BAD_REQUEST' }, false, 'ERROR'],
  ];
  for (const [what, status, body, write, code] of cases) {
    it(`${what} → ${code}`, () => {
      const e = agentFailure(status, body, write);
      expect(e).toBeInstanceOf(AgentError);
      expect(e.code).toBe(code);
    });
  }

  it('keeps the numbers the copy needs', () => {
    expect(agentFailure(413, { code: 'TOO_LONG', chars: 4200, limit: 3900 }, true).data).toMatchObject({ chars: 4200, limit: 3900 });
    expect(agentFailure(429, { code: 'RATE_LIMIT', retryAfter: 2 }, true).data).toMatchObject({ retryAfter: 2 });
    expect(agentFailure(409, { code: 'NOT_READY', reason: 'no_place' }, true).data).toMatchObject({ reason: 'no_place' });
  });

  it('a dropped connection: may have been delivered for a write, a network problem for a read', async () => {
    answer = () => {
      throw new TypeError('Failed to fetch');
    };
    await expect(viktorSend({ kind: 'chat', chat: { text: 'hi', website: '', images: [] }, ref: 'ylb-AAAAAA' })).rejects.toMatchObject({ code: 'SEND_UNKNOWN' });
    await expect(manusStart({ fn: 'agentchat', chat: { text: 'hi', website: '', images: [] }, ref: 'ylb-AAAAAA' })).rejects.toMatchObject({ code: 'SEND_UNKNOWN' });
    await expect(manusSend({ taskId: 'task000001', chat: { text: 'hi', website: '', images: [] } })).rejects.toMatchObject({ code: 'SEND_UNKNOWN' });
    await expect(manusRead('task000001')).rejects.toMatchObject({ code: 'NETWORK' });
    await expect(viktorRead(['vk_AAAAAAAAAAAAAAAAAAAAAA'])).rejects.toMatchObject({ code: 'NETWORK' });
    // the dry run sends nothing
    await expect(viktorPreview({ kind: 'chat', chat: { text: 'hi', website: '', images: [] }, ref: 'ylb-AAAAAA' })).rejects.toMatchObject({ code: 'NETWORK' });
  });

  it('a stopped request is cancelled, not a failure', async () => {
    const c = new AbortController();
    c.abort();
    answer = () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    };
    await expect(viktorSend({ kind: 'chat', chat: { text: 'hi', website: '', images: [] }, ref: 'ylb-AAAAAA' }, c.signal)).rejects.toMatchObject({ code: 'cancelled' });
  });
});

describe('the requests', () => {
  it('start a Manus build with the structured fields, the files and the Ref', async () => {
    answer = () => json(200, { ok: true, task_id: 'task000007', task_url: 'https://manus.im/app/task000007' });
    const build = { target: 'asset' as const, kind: 'booking', facts: [{ id: 'name' as const, value: 'Bean & Leaf' }], website: 'https://beanleaf.example', request: 'A booking widget', images: [{ key: 'img-1', note: 'the shop' }] };
    const out = await manusStart({ fn: 'build', build, ref: 'ylb-ABC123', profile: 'lite', files: [{ id: 'file00001', filename: 'img-1.jpg' }] });
    expect(out).toEqual({ taskId: 'task000007', taskUrl: 'https://manus.im/app/task000007' });
    expect(calls[0].url).toBe('/api/ai/manus/create');
    expect(bodyOf(calls[0])).toEqual({ fn: 'build', build, ref: 'ylb-ABC123', profile: 'lite', files: [{ file_id: 'file00001', filename: 'img-1.jpg' }] });
  });

  it('send a Viktor message with its files titled by their keys, and read the thread back', async () => {
    answer = () => json(200, { thread: { id: 'vk_AAAAAAAAAAAAAAAAAAAAAA', permalink: 'https://qa.slack.com/archives/D1/p1' }, message: { ts: '1.000001', located: true }, sentAt: 1234 });
    const sent = await viktorSend({ kind: 'chat', chat: { text: 'hello', website: '', images: [{ key: 'img-1', note: '' }] }, ref: 'ylb-ABC123', files: [{ id: 'FQA00001', filename: 'img-1.jpg' }] });
    expect(sent).toEqual({ threadId: 'vk_AAAAAAAAAAAAAAAAAAAAAA', permalink: 'https://qa.slack.com/archives/D1/p1', ts: '1.000001', located: true, sentAt: 1234 });
    expect(bodyOf(calls[0])).toMatchObject({ kind: 'chat', ref: 'ylb-ABC123', files: [{ file_id: 'FQA00001', title: 'img-1' }] });
    answer = () => json(200, { threads: [], errors: { vk_BBBBBBBBBBBBBBBBBBBBBB: { code: 'NOT_FOUND', message: 'gone' }, vk_CCCCCCCCCCCCCCCCCCCCCC: { code: 'WHATEVER', message: 'x' } } });
    const read = await viktorRead(['vk_BBBBBBBBBBBBBBBBBBBBBB', 'vk_CCCCCCCCCCCCCCCCCCCCCC', 'vk_BBBBBBBBBBBBBBBBBBBBBB']);
    expect(bodyOf(calls[1])).toEqual({ threadIds: ['vk_BBBBBBBBBBBBBBBBBBBBBB', 'vk_CCCCCCCCCCCCCCCCCCCCCC'] });
    expect(read.errors).toEqual({ vk_BBBBBBBBBBBBBBBBBBBBBB: { code: 'NOT_FOUND', message: 'gone' }, vk_CCCCCCCCCCCCCCCCCCCCCC: { code: 'ERROR', message: 'x' } });
  });

  it('verify: found or not', async () => {
    answer = () => json(200, { found: false });
    expect(await viktorVerify({ ref: 'ylb-ABC123', sentAt: 1 })).toBeNull();
    expect(await manusVerify('ylb-ABC123', 1)).toBeNull();
    answer = () => json(200, { found: true, task_id: 'task000009', task_url: 'https://manus.im/app/task000009' });
    expect(await manusVerify('ylb-ABC123', 1)).toEqual({ taskId: 'task000009', taskUrl: 'https://manus.im/app/task000009' });
    expect(bodyOf(calls.at(-1)!)).toEqual({ ref: 'ylb-ABC123', sent_at: 1 });
  });

  it('send each image as bytes to the agent’s attach route, and stop at the first failure (not sent)', async () => {
    let n = 0;
    answer = (url) => {
      n += 1;
      if (n === 2) return json(502, { code: 'UPSTREAM', error: 'Slack had an error.' });
      return json(200, { file_id: `FQA0000${n}`, filename: decodeURIComponent(/filename=([^&]+)/.exec(url)![1]) });
    };
    const media = { id: 'm1', kind: 'image' as const, name: 'a.jpg', mime: 'image/jpeg', size: 10, createdAt: 1 };
    const images = [
      { key: 'img-1', media, note: 'the shop front' },
      { key: 'img-3', media },
    ];
    const err = await sendImages('viktor', images).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect(err).toMatchObject({ code: 'NOT_SENT', message: expect.stringMatching(/^Couldn’t send image 3 to Viktor: slack had an error/) });
    expect(calls[0].url).toBe('/api/ai/slack/attach?filename=img-1.jpg&alt=the%20shop%20front');
    expect(calls[0].init.body).toBeInstanceOf(Blob);
    expect(new Headers(calls[0].init.headers).get('content-type')).toBe('image/jpeg');
    n = 0;
    answer = (url) => json(200, { file_id: `file0000${++n}`, filename: decodeURIComponent(/filename=([^&]+)/.exec(url)![1]) });
    expect(await sendImages('manus', images)).toEqual([
      { id: 'file00001', filename: 'img-1.jpg' },
      { id: 'file00002', filename: 'img-3.jpg' },
    ]);
    expect(calls.at(-1)!.url).toBe('/api/ai/manus/attach?filename=img-3.jpg');
  });
});

describe('what the owner is told', () => {
  it('says “may have been delivered” and where to check', () => {
    expect(agentErrorText(new AgentError('x', 'SEND_UNKNOWN'), 'viktor').body).toBe('May have been delivered. The connection dropped after your request left. Check Slack before sending it again, or it may go twice.');
    expect(agentErrorText(new AgentError('x', 'SEND_UNKNOWN'), 'manus').body).toContain('Check your Manus tasks');
  });

  it('gives the counts, the wait and the age', () => {
    expect(agentErrorText(new AgentError('x', 'TOO_LONG', { chars: 4210, limit: 3900 }), 'viktor').body).toBe('Too long for one Slack message (4,210 of 3,900 characters). Shorten your words.');
    expect(agentErrorText(new AgentError('x', 'RATE_LIMIT', { retryAfter: 2 }), 'viktor').body).toBe('Slack asked the app to slow down. Try again in 2 seconds.');
    expect(agentErrorText(new AgentError('x', 'NOT_FOUND'), 'manus').body).toBe('This task is older than 30 days, or wasn’t started by this app.');
    expect(agentErrorText(new AgentError('x', 'GONE'), 'viktor').body).toBe('It was deleted in Slack.');
    expect(agentErrorText(new AgentError('channel_not_found.', 'NOT_SENT'), 'viktor').body).toBe('Not sent: channel_not_found.');
  });

  it('points setup problems at Settings with the readiness text', () => {
    const t = agentErrorText(new AgentError('x', 'SETUP', { reason: 'no_token' }), 'viktor');
    expect(t).toMatchObject({ settings: true, body: 'Connect Slack in Settings › AI keys › Viktor (Slack).' });
    expect(agentErrorText(new AgentError('x', 'SETUP', { reason: 'not_ticked' }), 'manus').body).toBe('Tick “Building pages & assets” for your Manus key in Settings › AI keys.');
  });
});
