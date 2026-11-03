// Images sent with a writing request: your server gets up to 4; Claude in claude.ai gets only what its
// own limits allow (its types, size and count), and none when it takes no images.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SampleOptions } from '@/lib/platform';

vi.mock('@/lib/cloud/auth', () => ({ authHeaders: async () => ({}) }));

let sampleOptions: SampleOptions | undefined;
const fakeSample = Object.assign(async () => ({ text: '{}', truncated: false }), {
  json: async (_prompt: string, o?: SampleOptions) => {
    sampleOptions = o;
    return { ok: true };
  },
  limits: async () => ({ maxPromptBytes: 262144 }),
});
vi.mock('@/lib/platform', async (original) => ({ ...(await original<typeof import('@/lib/platform')>()), getSample: async () => fakeSample }));

// the browser's FileReader, enough for data URLs
class Reader {
  result: string | null = null;
  error: Error | null = null;
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

let sent: { images?: string[] } | null = null;
vi.stubGlobal(
  'fetch',
  vi.fn(async (_url: string, init: RequestInit = {}) => {
    sent = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ text: '{"ok":true}' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }),
);

const { callArtifactClaude, callServerAI, fitClaudeImages, SERVER_MAX_IMAGES } = await import('./claude');
const { useRuntime } = await import('@/lib/platform');

const jpeg = (label: string, size = 10) => new Blob([label.padEnd(size, '.')], { type: 'image/jpeg' });

afterEach(() => {
  sent = null;
  sampleOptions = undefined;
  useRuntime.getState().set({ claudeImageLimits: null, claudeImages: false });
});

describe('images to your server', () => {
  it('sends up to 4, in order, as data URLs', async () => {
    const images = ['a', 'b', 'c', 'd', 'e', 'f'].map((l) => jpeg(l));
    await callServerAI('seo', 'Write the page', { serverUrl: '', tier: 'default', images });
    expect(SERVER_MAX_IMAGES).toBe(4);
    expect(sent?.images).toHaveLength(4);
    expect(sent!.images!.map((u) => atob(u.split(',')[1])[0])).toEqual(['a', 'b', 'c', 'd']);
    expect(sent!.images![0]).toMatch(/^data:image\/jpeg;base64,/);
  });

  it('sends none when there are none', async () => {
    await callServerAI('seo', 'Write the page', { serverUrl: '', tier: 'default' });
    expect(sent?.images).toBeUndefined();
  });
});

describe('images to Claude in claude.ai', () => {
  const limits = { maxCount: 2, maxInputBytes: 20, mediaTypes: ['image/jpeg', 'image/png'] };

  it('keeps to Claude’s types, size and count', () => {
    const png = new Blob(['p'], { type: 'image/png' });
    const svg = new Blob(['<svg/>'], { type: 'image/svg+xml' });
    const big = jpeg('big', 50);
    const a = jpeg('a');
    const b = jpeg('b');
    expect(fitClaudeImages([svg, big, a, png, b], limits)).toEqual([a, png]);
    expect(fitClaudeImages([a, b], null)).toEqual([]);
    // no type list or size limit given: only the count applies (and at least one)
    expect(fitClaudeImages([a, b, big], { maxCount: 0, maxInputBytes: 0, mediaTypes: [] })).toEqual([a]);
  });

  it('sends only what fits, and nothing when Claude takes no images here', async () => {
    useRuntime.getState().set({ claudeImages: true, claudeImageLimits: limits });
    await callArtifactClaude('Write the page', { tier: 'default', images: [jpeg('a'), jpeg('b'), jpeg('c')] });
    expect(sampleOptions?.images).toHaveLength(2);
    useRuntime.getState().set({ claudeImages: false, claudeImageLimits: null });
    await callArtifactClaude('Write the page', { tier: 'default', images: [jpeg('a')] });
    expect(sampleOptions).toBeDefined();
    expect(sampleOptions).not.toHaveProperty('images');
  });
});
