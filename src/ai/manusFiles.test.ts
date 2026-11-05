// A video for Manus (Facebook groups): the video goes to Manus first (through your server), then the task
// carries it. Signed in, the server takes it from your account's storage; otherwise the browser sends the
// bytes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const signedFileUrl = vi.fn(async (_id: string): Promise<string | null> => null);
vi.mock('@/lib/cloud/auth', () => ({ authHeaders: async () => ({}), signedFileUrl: (id: string) => signedFileUrl(id) }));

const { manusTransport, sendFileToManus } = await import('./manus');

manusTransport.server = true;
const fetchMock = vi.fn();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  fetchMock.mockReset();
  signedFileUrl.mockReset();
  signedFileUrl.mockResolvedValue(null);
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('sending a file to Manus', () => {
  it('lets the server take it from your account (a private link), when it’s there', async () => {
    signedFileUrl.mockResolvedValueOnce('https://x.supabase.co/storage/v1/object/sign/media/u1/media_v?token=t');
    fetchMock.mockResolvedValueOnce(json({ file_id: 'file00001', filename: 'Candles.mp4' }));
    const out = await sendFileToManus({ blob: new Blob([new Uint8Array(10)], { type: 'video/mp4' }), name: 'Candles.mov', mediaId: 'media_v' });
    expect(out).toEqual({ file_id: 'file00001', filename: 'Candles.mp4' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/ai/manus/attach');
    expect(JSON.parse(init.body)).toEqual({ url: 'https://x.supabase.co/storage/v1/object/sign/media/u1/media_v?token=t', filename: 'Candles.mp4' });
  });

  it('sends the bytes itself when the file isn’t in an account', async () => {
    fetchMock.mockResolvedValueOnce(json({ file_id: 'file00002', filename: 'clip.mp4' }));
    const blob = new Blob([new Uint8Array(20)], { type: 'video/mp4' });
    await sendFileToManus({ blob, name: 'clip', mediaId: 'media_local' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/ai/manus/attach?filename=clip.mp4');
    expect(init.body).toBe(blob);
    expect(new Headers(init.headers).get('content-type')).toBe('video/mp4');
  });

  it('explains a file too big for the host', async () => {
    fetchMock.mockResolvedValueOnce(new Response('Request Entity Too Large', { status: 413 }));
    await expect(sendFileToManus({ blob: new Blob([new Uint8Array(5)], { type: 'video/mp4' }), name: 'big' })).rejects.toMatchObject({ code: 'MANUS_CREATE', message: expect.stringMatching(/too big/) });
  });
});
