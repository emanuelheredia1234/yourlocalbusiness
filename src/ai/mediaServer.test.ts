import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createManusTask, fetchManusImage, manusErrorMessage, manusImageLimit, manusTransport } from './manus';
import { downloadVideo, readVideo, startVideo, videoTransport, waitForVideo } from './video';

// The self-hosted app reaches Manus and video through your server (/api/ai/…), not Zapier.
manusTransport.server = true;
videoTransport.server = true;

const fetchMock = vi.fn();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** The browser's FileReader, as far as readFileAsDataURL needs it (tests run in Node). */
class NodeFileReader {
  result: string | null = null;
  error: unknown = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readAsDataURL(blob: Blob) {
    void blob.arrayBuffer().then((b) => {
      let bin = '';
      for (const x of new Uint8Array(b)) bin += String.fromCharCode(x);
      this.result = `data:${blob.type || 'application/octet-stream'};base64,${btoa(bin)}`;
      this.onload?.();
    });
  }
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('FileReader', NodeFileReader);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Manus through your server', () => {
  it('starts a task for a function, with the image as a data URL', async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: true, task_id: 'task000001', task_url: 'https://manus.im/app/task000001', task_title: 'FB' }));
    const t = await createManusTask({ fn: 'facebook', prompt: 'Schedule it', title: 'FB', interactive: true, image: new Blob([new Uint8Array([0xff, 0xd8, 0xff, 1])], { type: 'image/jpeg' }), imageName: 'post.png' });
    expect(t).toEqual({ taskId: 'task000001', taskUrl: 'https://manus.im/app/task000001', title: 'FB' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/ai/manus/create');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ fn: 'facebook', prompt: 'Schedule it', interactive_mode: true, hide_in_task_list: false, title: 'FB', image_filename: 'post.jpg' });
    expect(body.image_data_url).toMatch(/^data:image\/jpeg;base64,/);
    // the key's effort picks the profile on the server
    expect(body).not.toHaveProperty('agent_profile');
  });

  it('brings back large images that wouldn’t fit through Zapier', async () => {
    const out = (images: unknown[]) => json({ task_id: 't1', status: 'stopped', done: true, image_count: 1, images, text: 'Done', task_url: 'https://manus.im/app/t1', credit_usage: 40 });
    fetchMock.mockResolvedValueOnce(out([{ filename: 'a.png', content_type: 'image/png', size_bytes: 5_000_000, base64: '', note: 'Image too large' }]));
    fetchMock.mockResolvedValueOnce(out([{ filename: 'a.png', content_type: 'image/png', size_bytes: 5_000_000, base64: 'iVBORw0KGgo=', note: '' }]));
    const got = await fetchManusImage('t1');
    expect(manusImageLimit()).toBe(15_000_000);
    expect(got.image?.base64).toBe('iVBORw0KGgo=');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ task_id: 't1', max_images: 8, max_image_bytes: 1 });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ task_id: 't1', max_images: 1, max_image_bytes: 15_000_000 });
  });

  it('explains a missing Manus key', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'Your Manus key isn’t set to power Facebook scheduling.', code: 'NO_PROVIDER' }, 409));
    const err = await createManusTask({ fn: 'facebook', prompt: 'x' }).catch((e) => e);
    expect(err.code).toBe('MANUS_SETUP');
    expect(manusErrorMessage(err.code, err.message)?.body).toMatch(/isn’t set to power/);
  });
});

describe('videos through your server', () => {
  it('starts, waits, and downloads a job with the key’s quality', async () => {
    vi.useFakeTimers();
    const meta = { provider: 'openrouter', providerLabel: 'OpenRouter', fn: 'videos', kind: 'video', model: 'heygen/heygen-video-1', effort: '768p', effortLabel: '768p', effortField: 'resolution', ms: 61000, usage: null, cost: { usd: 0.16, source: 'provider' }, credits: null };
    fetchMock.mockResolvedValueOnce(json({ job: { id: 'vid_1', state: 'running', error: '', progress: null, meta: { ...meta, cost: null } } }));
    const job = await startVideo({ prompt: 'a candle', aspect: '9:16', duration: 6, resolution: '480p' });
    expect(job).toEqual({ jobId: 'vid_1', pollingUrl: '', server: true });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ prompt: 'a candle', aspect: '9:16', duration: 6 });

    fetchMock.mockResolvedValueOnce(json({ job: { id: 'vid_1', state: 'running', error: '', progress: 40, meta } }));
    fetchMock.mockResolvedValueOnce(json({ job: { id: 'vid_1', state: 'done', error: '', progress: null, meta } }));
    const p = waitForVideo(job);
    await vi.advanceTimersByTimeAsync(4_000);
    await vi.advanceTimersByTimeAsync(5_000);
    const state = await p;
    expect(state).toMatchObject({ done: true, cost: 0.16, meta: { effort: '768p' } });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/ai/video/vid_1');

    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), { status: 200, headers: { 'content-type': 'video/mp4' } }));
    const blob = await downloadVideo(job, state);
    expect(blob.size).toBe(8);
    expect(fetchMock.mock.calls[3][0]).toBe('/api/ai/video/vid_1/content');
  });

  it('says when the server lost the job', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'This video job isn’t on the server any more.', code: 'NOT_FOUND' }, 404));
    await expect(readVideo({ jobId: 'vid_x', pollingUrl: '', server: true })).rejects.toMatchObject({ code: 'VIDEO_LOST' });
  });
});
