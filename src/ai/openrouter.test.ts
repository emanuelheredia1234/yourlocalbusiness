import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  calls: [] as { action: string; selected_api: string; params: Record<string, unknown> }[],
  answer: (() => ({})) as () => unknown,
}));

vi.mock('@/lib/platform', () => ({
  getMcp: async () => ({
    callTool: async (_server: string, _tool: string, input: { action: string; selected_api: string; params: Record<string, unknown> }) => {
      mock.calls.push(input);
      return { payload: mock.answer() };
    },
  }),
  useRuntime: { getState: () => ({ set: () => {} }) },
}));

import { generateMuseImage, MUSE_MODEL, OPENROUTER_API, OPENROUTER_IMAGE, parseMuseResult } from './openrouter';

// the shape the custom Zapier action returns (values made up)
const envelope = (data: unknown) => ({ isError: false, results: { data: { success: true, data }, logs: ['…'] }, timing: { totalMs: 1 } });

beforeEach(() => {
  mock.calls.length = 0;
});

describe('Meta Muse through OpenRouter', () => {
  it('asks for one Muse image at the post shape and reads it back', async () => {
    mock.answer = () => envelope({ ok: true, error: '', endpoint: 'https://openrouter.ai/api/v1/images', model: MUSE_MODEL, content_type: 'image/webp', size_bytes: 416574, base64: 'UklGRg==', text: '', note: '', usage: { cost: 0.01 } });
    const img = await generateMuseImage('a barista pouring latte art', '1.91:1');
    expect(mock.calls).toEqual([{ selected_api: OPENROUTER_API, action: OPENROUTER_IMAGE, params: { model: MUSE_MODEL, prompt: 'a barista pouring latte art', aspect_ratio: '16:9', max_image_bytes: '2000000' } }]);
    expect(img).toEqual({ base64: 'UklGRg==', contentType: 'image/webp', sizeBytes: 416574, cost: 0.01 });
  });

  it('explains an empty OpenRouter balance', () => {
    const fail = { ok: false, error: 'HTTP 402: {"message":"Insufficient credits. Add more using https://openrouter.ai/settings/credits","code":402}', base64: '' };
    expect(() => parseMuseResult(fail)).toThrow(/out of credits/);
    try {
      parseMuseResult(fail);
    } catch (e) {
      expect((e as { code: string }).code).toBe('MUSE_CREDITS');
    }
    expect(() => parseMuseResult({ ok: false, error: 'HTTP 400: bad prompt', base64: '' })).toThrow('HTTP 400: bad prompt');
    expect(() => parseMuseResult({ ok: true, base64: '', note: 'Image too large: 3000000 bytes' })).toThrow('Image too large');
  });
});
