import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A stand-in for the viewer's Zapier connector: records each action and answers like Zapier does.
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

import { createManusTask, fetchManusImage, MANUS_CREATE, MANUS_IMAGE_LIMIT, manusAttachPrompt, manusImagePrompt, manusTransport, parseManusState, pickManusImage, waitForManus } from './manus';

// these tests cover the claude.ai route (Zapier); manus.server.test.ts covers your server
manusTransport.server = false;

// Shapes as Zapier returns them for the code actions (values made up)
const envelope = (data: unknown) => ({ isError: false, results: { data: { success: true, data }, logs: ['…'] }, timing: { totalMs: 1 } });
const output = (o: Record<string, unknown> = {}) =>
  envelope({ task_id: 't1', status: 'stopped', agent_status: 'stopped', done: true, waiting: false, waiting_type: '', waiting_description: '', error: '', title: 'Image', task_url: 'https://manus.im/app/t1', credit_usage: 10, text: '', image_count: 0, images: [], ...o });
const file = (filename: string, content_type: string, size_bytes: number, base64 = '') => ({ filename, content_type, size_bytes, base64, note: base64 ? '' : `Image too large: ${size_bytes} bytes` });
const task = { taskId: 't1', taskUrl: 'https://manus.im/app/t1', title: 'Image' };
const colors = { primary: '#7a3e1d', secondary: '#2b1a12', accent: '#e8a33d', ink: '#1d130d', paper: '#fbf6ef' };

beforeEach(() => {
  mock.calls.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('starting a Manus task', () => {
  it('sends every field as text, the way the code action declares them', async () => {
    mock.answer = () => envelope({ ok: true, task_id: 'abc', task_url: 'https://manus.im/app/abc', task_title: 'T', image_attached: false, error: '', stage: '' });
    const t = await createManusTask({ fn: 'photos', prompt: 'one image', hidden: true });
    expect(t).toEqual({ taskId: 'abc', taskUrl: 'https://manus.im/app/abc', title: 'T' });
    expect(mock.calls).toEqual([{ action: MANUS_CREATE, params: { prompt: 'one image', interactive_mode: 'false', hide_in_task_list: 'true', agent_profile: 'standard' } }]);
  });
});

describe('bringing an image back', () => {
  it('picks the first image small enough to travel through Zapier', () => {
    const s = (images: ReturnType<typeof file>[]) => parseManusState(output({ image_count: images.length, images })).images;
    expect(pickManusImage(s([file('a.png', 'image/png', 5_122_696), file('b.png', 'image/png', 4_775_625)]))).toBe(-1);
    expect(pickManusImage(s([file('a.png', 'image/png', 5_122_696), file('a.jpg', 'image/jpeg', 412_000)]))).toBe(1);
    expect(pickManusImage(s([file('a.jpg', 'image/jpeg', 0)]))).toBe(0); // size unknown: worth a try
    expect(pickManusImage(s([file('notes.pdf', 'application/pdf', 10_000)]))).toBe(-1);
  });

  it('lists the files first, then downloads only the one that fits', async () => {
    const listed = [file('cafe.png', 'image/png', 5_122_696), file('cafe.jpg', 'image/jpeg', 412_000)];
    mock.answer = (_a, p) => (Number(p.max_image_bytes) <= 1 ? output({ image_count: 2, images: listed }) : output({ image_count: 2, images: [listed[0], file('cafe.jpg', 'image/jpeg', 412_000, '/9j/AAAA')] }));
    const r = await fetchManusImage('t1');
    expect(mock.calls.map((c) => [c.params.max_images, c.params.max_image_bytes])).toEqual([
      [8, 1],
      [2, MANUS_IMAGE_LIMIT],
    ]);
    expect(r.image).toMatchObject({ filename: 'cafe.jpg', contentType: 'image/jpeg', base64: '/9j/AAAA' });
  });

  it('never downloads an oversized file', async () => {
    mock.answer = () => output({ image_count: 1, images: [file('cafe.png', 'image/png', 5_122_696)] });
    const r = await fetchManusImage('t1');
    expect(mock.calls).toHaveLength(1);
    expect(r.image).toBeNull();
    expect(r.state.imageCount).toBe(1);
  });
});

describe('waiting for Manus', () => {
  it('returns as soon as the task has stopped', async () => {
    mock.answer = () => output({ text: 'Here is your image.' });
    const s = await waitForManus(task);
    expect(s.text).toBe('Here is your image.');
    expect(mock.calls).toHaveLength(1);
  });

  it('after a follow-up, ignores the old "stopped" until Manus has picked it up', async () => {
    vi.useFakeTimers();
    const before = parseManusState(output({ text: 'Here is your image.', image_count: 1 }));
    const seq = [output({ text: 'Here is your image.', image_count: 1 }), output({ status: 'running', agent_status: 'running', done: false }), output({ text: 'Here is the JPEG.', image_count: 2 })];
    let i = 0;
    mock.answer = () => seq[Math.min(i++, seq.length - 1)];
    const p = waitForManus(task, { after: before });
    await vi.advanceTimersByTimeAsync(60_000);
    const s = await p;
    expect(s.text).toBe('Here is the JPEG.');
    expect(i).toBe(3);
  });

  it('stops waiting for a change after a while', async () => {
    vi.useFakeTimers();
    const before = parseManusState(output({ text: 'Here is your image.', image_count: 1 }));
    mock.answer = () => output({ text: 'Here is your image.', image_count: 1 });
    const p = waitForManus(task, { after: before });
    await vi.advanceTimersByTimeAsync(120_000);
    expect((await p).text).toBe('Here is your image.');
  });
});

describe('Manus image prompts', () => {
  it('asks for a small JPEG at the canvas size', () => {
    const p = manusImagePrompt({ subject: 'a barista pouring latte art.', aspect: '4:5', styleHint: 'editorial lifestyle photograph', colors, purpose: 'post', textSpace: 'bottom' });
    expect(p).toContain('Subject: a barista pouring latte art.\n');
    expect(p).toMatch(/resize it to about 1080×1350 px, save it as a JPEG .* under 1\.5 MB/);
    expect(p).not.toMatch(/\.\./);
  });

  it('follows up for a smaller copy, or for the missing file', () => {
    expect(manusAttachPrompt({ imageCount: 1, aspect: '1:1' })).toMatch(/too large.*about 1080×1080 px.*JPEG/);
    expect(manusAttachPrompt({ imageCount: 0, aspect: '3:2' })).toMatch(/didn't receive an image file.*about 1200×800 px/);
  });
});
