// The engine gets a task's images ready before it writes the prompt, so "attached image N" in the prompt
// is always the Nth image the AI really gets: a file that can't be loaded, or a limit of the AI, never
// shifts the numbers. Tasks that attach files their own way are unchanged.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaRef, PromptImage } from '@/lib/types';

vi.mock('@/lib/cloud/auth', async (original) => ({ ...(await original<typeof import('@/lib/cloud/auth')>()), authHeaders: async () => ({}) }));

// Redrawing images needs a browser: stand in with one small file per image, except the ones whose
// file "can't be loaded" here.
const unavailable = new Set<string>();
vi.mock('@/lib/promptImages', async (original) => {
  const real = await original<typeof import('@/lib/promptImages')>();
  return {
    ...real,
    imagesWithKeysForAI: vi.fn(async (images: PromptImage[] = [], max = real.MAX_AI_IMAGES) =>
      images
        .filter((i) => i.media.kind === 'image')
        .slice(0, max)
        .filter((i) => !unavailable.has(i.key))
        .map((i) => ({ key: i.key, blob: new Blob([i.key.padEnd(40, '.')], { type: 'image/jpeg' }) })),
    ),
  };
});

// the browser's FileReader, enough for data URLs
class Reader {
  result: string | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readAsDataURL(b: Blob) {
    void b.arrayBuffer().then((buf) => {
      this.result = `data:${b.type};base64,${btoa(String.fromCharCode(...new Uint8Array(buf)))}`;
      this.onload?.();
    });
  }
}
vi.stubGlobal('FileReader', Reader);

const { runTask, prepareAttachments } = await import('./engine');
const { describeImagesForAI } = await import('@/lib/promptImages');
const tasks = await import('./tasks');
const { newProject, defaultSettings } = await import('@/store/defaults');
const { NO_AI_SERVER, useRuntime } = await import('@/lib/platform');

const media = (id: string): MediaRef => ({ id, kind: 'image', name: `${id}.jpg`, mime: 'image/jpeg', size: 1, createdAt: 0, w: 800, h: 600 });
const img = (n: number, note?: string): PromptImage => ({ key: `img-${n}`, media: media(`m${n}`), ...(note ? { note } : {}) });

describe('describing images by what was attached', () => {
  it('numbers the images as attached, whatever their order in the list', () => {
    const images = [img(1, 'a'), img(2), img(3, 'c')];
    expect(describeImagesForAI(images, ['img-3', 'img-1']).split('\n')).toEqual([
      '{{img-1}} (attached image 2): "a" — 800×600 photo',
      '{{img-2}} (not attached: go by its note) — 800×600 photo',
      '{{img-3}} (attached image 1): "c" — 800×600 photo',
    ]);
    expect(describeImagesForAI(images, [])).not.toContain('attached image');
    // a number still means "the first N"
    expect(describeImagesForAI(images, 2)).toContain('{{img-2}} (attached image 2)');
  });
});

describe('images go with the prompt that describes them', () => {
  const fetchMock = vi.fn();
  const project = () => {
    const p = newProject('business', 'new');
    p.niche = 'Home Cleaning';
    p.businessType = 'Home Cleaning';
    return p;
  };
  const opts = () => ({ project: project(), skills: [], settings: defaultSettings() });
  const sent = () => JSON.parse(fetchMock.mock.calls[0][1].body) as { prompt: string; images?: string[] };

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ text: '{}' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    useRuntime.getState().set({ server: 'ok', ai: { ...NO_AI_SERVER, reachable: true, ready: true, routing: { seo: ['openai'], social: ['openai'] } } });
  });
  afterEach(() => {
    unavailable.clear();
    useRuntime.getState().set({ claudeImages: false, claudeImageLimits: null });
  });

  it('numbers only the images that were sent: one that couldn’t be loaded is “not attached”', async () => {
    unavailable.add('img-2');
    const images = [img(1, 'Shop front'), img(2, 'Our van'), img(3), img(4), img(5)];
    await runTask(tasks.salesPageTask, { images }, opts());
    const body = sent();
    expect(body.images).toHaveLength(3);
    expect(body.images!.map((u) => atob(u.split(',')[1]).replace(/\.+$/, ''))).toEqual(['img-1', 'img-3', 'img-4']);
    expect(body.prompt).toContain('{{img-1}} (attached image 1): "Shop front"');
    expect(body.prompt).toContain('{{img-2}} (not attached: go by its note): "Our van"');
    expect(body.prompt).toContain('{{img-3}} (attached image 2)');
    expect(body.prompt).toContain('{{img-4}} (attached image 3)');
    // the server takes 4: the fifth was never attached
    expect(body.prompt).toContain('{{img-5}} (not attached: go by its note)');
  });

  it('says none are attached when none could be sent', async () => {
    unavailable.add('img-1');
    await runTask(tasks.salesPageTask, { images: [img(1, 'Shop front')] }, opts());
    expect(sent().images).toBeUndefined();
    expect(sent().prompt).toContain('{{img-1}} (not attached: go by its note): "Shop front"');
  });

  it('keeps to Claude’s own limits in claude.ai (count, types, size)', async () => {
    useRuntime.getState().set({ claudeImages: true, claudeImageLimits: { maxCount: 2, maxInputBytes: 0, mediaTypes: ['image/jpeg'] } });
    const files = await prepareAttachments(tasks.salesPageTask, { images: [img(1), img(2), img(3)] }, 'claude');
    expect(files.keys).toEqual(['img-1', 'img-2']);
    expect(files.blobs).toHaveLength(2);
    // Claude without images: nothing is attached, and the prompt says so
    useRuntime.getState().set({ claudeImages: false, claudeImageLimits: null });
    expect(await prepareAttachments(tasks.salesPageTask, { images: [img(1)] }, 'claude')).toEqual({ keys: [] });
    // the built-in engine never gets files
    expect(await prepareAttachments(tasks.salesPageTask, { images: [img(1)] }, 'local')).toEqual({});
  });

  it('leaves tasks that attach a file their own way as they were', async () => {
    const own = vi.fn(async () => [new Blob(['photo'], { type: 'image/jpeg' })]);
    const task = { ...tasks.seoMetaTask, id: 'seoMeta', claude: { ...tasks.seoMetaTask.claude!, promptImages: undefined, images: own } };
    const files = await prepareAttachments(task, {}, 'server');
    expect(files).toEqual({ blobs: [expect.any(Blob)] });
    expect(own).toHaveBeenCalledTimes(1);
  });

  it('stops before asking when stopped while the images were being prepared', async () => {
    const ctl = new AbortController();
    ctl.abort();
    await expect(runTask(tasks.salesPageTask, { images: [img(1)] }, { ...opts(), signal: ctl.signal })).rejects.toMatchObject({ code: 'cancelled' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
