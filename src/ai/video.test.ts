import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  calls: [] as { action: string; params: Record<string, unknown> }[],
  answer: (() => ({})) as (action: string, params: Record<string, unknown>) => unknown,
}));

vi.mock('@/lib/platform', () => ({
  getMcp: async () => ({
    callTool: async (_server: string, _tool: string, input: { action: string; params: Record<string, unknown> }) => {
      mock.calls.push({ action: input.action, params: input.params });
      return { payload: mock.answer(input.action, input.params) };
    },
  }),
  useRuntime: { getState: () => ({ set: () => {} }) },
}));

import { downloadVideo, parseVideoStart, startVideo, videoAspectFor, videoCost, waitForVideo } from './video';
import { postVideoPrompt } from './image';
import { newProject } from '@/store/defaults';

const envelope = (data: unknown) => ({ isError: false, results: { data: { success: true, data }, logs: ['…'] }, timing: { totalMs: 1 } });
const job = { jobId: 'gen-vid-1', pollingUrl: 'https://openrouter.ai/api/v1/videos/gen-vid-1' };
const short = (a: string) => a.replace('code_action_app217255cliapi__', '');

beforeEach(() => {
  mock.calls.length = 0;
});
afterEach(() => vi.useRealTimers());

describe('HeyGen video through OpenRouter', () => {
  it('starts a job with the chosen length, quality and shape', async () => {
    mock.answer = () => envelope({ ok: true, error: null, job_id: 'gen-vid-1', status: 'pending', polling_url: job.pollingUrl });
    expect(await startVideo({ prompt: 'a barista pouring latte art', aspect: '9:16', duration: 8, resolution: '768p' })).toEqual(job);
    expect(mock.calls).toEqual([{ action: 'code_action_app217255cliapi__start_video', params: { model: 'heygen/heygen-video-1', prompt: 'a barista pouring latte art', duration: '8', resolution: '768p', aspect_ratio: '9:16' } }]);
    expect(() => parseVideoStart({ ok: false, error: 'HTTP 402: {"message":"Insufficient credits"}' })).toThrow(/out of credits/);
  });

  it('checks every 15 seconds until the video is ready', async () => {
    vi.useFakeTimers();
    const seq = ['pending', 'in_progress', 'completed'];
    let i = 0;
    mock.answer = () => {
      const status = seq[Math.min(i++, seq.length - 1)];
      return envelope({ ok: true, status, done: status === 'completed', failed: false, size_bytes: status === 'completed' ? 6 : null, content_type: 'video/mp4', cost: 0.05 });
    };
    const p = waitForVideo(job);
    await vi.advanceTimersByTimeAsync(19_000);
    expect(mock.calls).toHaveLength(0); // the first check waits 20 seconds
    await vi.advanceTimersByTimeAsync(40_000);
    const s = await p;
    expect(s).toMatchObject({ done: true, sizeBytes: 6, cost: 0.05 });
    expect(mock.calls.map((c) => short(c.action))).toEqual(['video_status', 'video_status', 'video_status']);
  });

  it('brings a large video back in pieces and joins them', async () => {
    const bytes = [0, 0, 0, 24, 102, 116, 121, 112]; // "....ftyp"
    const b64 = (a: number[]) => btoa(String.fromCharCode(...a));
    mock.answer = (_a, p) => {
      const off = Number(p.offset);
      const part = off === 0 ? bytes.slice(0, 5) : bytes.slice(5);
      return envelope({ ok: true, offset: off, length: part.length, total_size: bytes.length, done: off + part.length >= bytes.length, content_type: 'video/mp4', base64: b64(part) });
    };
    const blob = await downloadVideo(job, { status: 'completed', done: true, failed: false, error: '', sizeBytes: 8, contentType: 'video/mp4', cost: null });
    expect(mock.calls.map((c) => c.params.offset)).toEqual(['0', '5']);
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual(bytes);
    expect(blob.type).toBe('video/mp4');
  });

  it('prices and shapes videos', () => {
    expect(videoCost(8, '768p')).toBeCloseTo(0.288);
    expect(videoAspectFor('4:5')).toBe('3:4');
    expect(videoAspectFor('1.91:1')).toBe('16:9');
  });

  it('writes a video prompt from the post without on-screen words', () => {
    const p = newProject('business', 'new');
    const prompt = postVideoPrompt(p, 'vertical selfie-style UGC video, handheld, jump cuts every second, bold burned-in captions, natural light. Subject: a cleaner wiping a sunny kitchen. On-image text: “Spotless in 2 hours”.', 'ugc', [{ shot: 'Close-up of a sparkling counter' }, { shot: 'Point at caption text' }, { shot: 'Wide shot of the kitchen' }]);
    expect(prompt).toContain('a cleaner wiping a sunny kitchen');
    expect(prompt).toContain('Shots: Close-up of a sparkling counter; Wide shot of the kitchen.');
    expect(prompt).toMatch(/No on-screen text/);
    expect(prompt).not.toMatch(/Spotless|burned-in|caption text/i);
  });
});
