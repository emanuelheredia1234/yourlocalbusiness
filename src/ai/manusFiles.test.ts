// A post with a video: the video goes to Manus first (through your server), then the task carries
// it. Signed in, the server takes it from your account's storage; otherwise the browser sends the
// bytes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const signedFileUrl = vi.fn(async (_id: string): Promise<string | null> => null);
vi.mock('@/lib/cloud/auth', () => ({ authHeaders: async () => ({}), signedFileUrl: (id: string) => signedFileUrl(id) }));

const { manusTransport, sendFileToManus } = await import('./manus');
const { startManusPost } = await import('./manusPost');
const { putBlob } = await import('@/lib/storage');

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

describe('a video post', () => {
  it('sends the video, then a task that posts it now with the caption', async () => {
    await putBlob('media_fbvid', new Blob([new Uint8Array(64)], { type: 'video/mp4' }));
    fetchMock.mockResolvedValueOnce(json({ file_id: 'file00003', filename: 'launch.mp4' }));
    fetchMock.mockResolvedValueOnce(json({ ok: true, task_id: 'task000009', task_url: 'https://manus.im/app/task000009', task_title: 'Post' }));
    const stages: string[] = [];
    const post = {
      id: 'post_fb1',
      platform: 'facebook',
      headline: 'Launch day',
      caption: 'Our new candle line is here.',
      hashtags: ['#candles'],
      scheduledAt: '2026-11-03T18:00:00.000Z',
      media: { id: 'media_fbvid', kind: 'video', name: 'launch.mp4', mime: 'video/mp4', size: 64, createdAt: 1, thumb: '' },
    } as never;
    const ext = await startManusPost(post, 'Candle Co', 'now', (s) => stages.push(s));
    expect(stages).toEqual(['Sending the video to Manus…', 'Starting the Manus task…']);
    const create = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(create.fn).toBe('facebook');
    expect(create.files).toEqual([{ file_id: 'file00003', filename: 'launch.mp4' }]);
    expect(create.image_data_url).toBeUndefined();
    expect(create.prompt).toContain('Attach the video file provided');
    expect(create.prompt).toContain('Our new candle line is here.\n\n#candles');
    expect(create.prompt).toContain('RESULT: POSTED');
    expect(ext).toMatchObject({ network: 'facebook', mode: 'now', state: 'working', taskId: 'task000009', page: 'Candle Co' });
  });

  it('posts a TikTok video the TikTok way', async () => {
    await putBlob('media_ttvid', new Blob([new Uint8Array(32)], { type: 'video/mp4' }));
    fetchMock.mockResolvedValueOnce(json({ file_id: 'file00004', filename: 'clip.mp4' }));
    fetchMock.mockResolvedValueOnce(json({ ok: true, task_id: 'task000010', task_url: 'https://manus.im/app/task000010', task_title: 'Post' }));
    const post = { id: 'post_tt1', platform: 'tiktok', headline: 'Clip', caption: 'Watch this.', hashtags: [], scheduledAt: '2026-11-04T18:00:00.000Z', media: { id: 'media_ttvid', kind: 'video', name: 'clip.mp4', mime: 'video/mp4', size: 32, createdAt: 1, thumb: '' } } as never;
    const ext = await startManusPost(post, '@candles', 'schedule');
    const create = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(create.fn).toBe('facebook'); // the "Social posting" function, whatever the network
    expect(create.title).toBe('Schedule TikTok post · Clip');
    expect(create.prompt).toContain('tiktokstudio/upload');
    expect(create.prompt).toContain('"@candles"');
    expect(ext).toMatchObject({ network: 'tiktok', mode: 'schedule', scheduledFor: '2026-11-04T18:00:00.000Z', message: 'Manus is opening TikTok…' });
  });

  it('won’t send an Instagram post with nothing to show', async () => {
    const post = { id: 'p', platform: 'instagram', headline: 'h', caption: 'c', hashtags: [], scheduledAt: '' } as never;
    await expect(startManusPost(post, '@a', 'now')).rejects.toMatchObject({ message: expect.stringMatching(/Instagram needs an image or a video/) });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses when the video is gone, rather than posting text only', async () => {
    const post = { id: 'p', platform: 'facebook', headline: 'h', caption: 'c', hashtags: [], scheduledAt: '', media: { id: 'media_missing', kind: 'video', name: 'v.mp4' } } as never;
    await expect(startManusPost(post, 'Page', 'now')).rejects.toMatchObject({ message: expect.stringMatching(/video isn’t on this device/) });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
