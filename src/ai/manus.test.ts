import { describe, expect, it } from 'vitest';
import { manusImagePrompt, parseManusCreate, parseManusState } from './manus';
import { unwrapZapier, ZapierError } from '@/lib/zapier';

// Shapes as Zapier returns them (values made up)
const codeActionEnvelope = (data: unknown) => ({ isError: false, results: { data: { success: true, data }, logs: ['…'] }, timing: { totalMs: 1 } });
const outputRunning = { task_id: 't1', status: 'running', agent_status: 'running', done: false, waiting: false, waiting_type: '', waiting_description: '', error: '', title: 'Image', task_url: 'https://manus.im/app/t1', credit_usage: 0, text: '', image_count: 0, images: [] };

const colors = { primary: '#1f5f4a', secondary: '#0f3b2e', accent: '#f2b33d', ink: '#111814', paper: '#fbfaf6' };

describe('Zapier results', () => {
  it('unwraps code actions and built-in actions', () => {
    expect(unwrapZapier(codeActionEnvelope({ ok: true, task_id: 'x' }))).toEqual({ ok: true, task_id: 'x' });
    expect(unwrapZapier({ results: [{ id: 'a' }], paging_token: 'p' })).toEqual([{ id: 'a' }]);
    expect(unwrapZapier(JSON.stringify(codeActionEnvelope({ a: 1 })))).toEqual({ a: 1 });
  });

  it('turns Zapier failures into errors', () => {
    expect(() => unwrapZapier({ isError: true, error: 'Connection expired' })).toThrow(ZapierError);
    expect(() => unwrapZapier({ isError: false, results: { data: { success: false, error: 'boom' } } })).toThrow('boom');
    expect(() => unwrapZapier('not json at all')).toThrow(ZapierError);
  });
});

describe('Manus', () => {
  it('reads a created task and its status', () => {
    expect(parseManusCreate(codeActionEnvelope({ ok: true, task_id: 'abc', task_url: 'https://manus.im/app/abc', task_title: 'T', error: '' }))).toEqual({ taskId: 'abc', taskUrl: 'https://manus.im/app/abc', title: 'T' });
    expect(parseManusCreate({ task_id: 'abc' }).taskUrl).toBe('https://manus.im/app/abc');
    expect(() => parseManusCreate({ ok: false, task_id: '', error: 'insufficient_credits: out of credits' })).toThrow('out of credits');
    const s = parseManusState(unwrapZapier(codeActionEnvelope(outputRunning)));
    expect(s).toMatchObject({ taskId: 't1', status: 'running', done: false, waiting: false, taskUrl: 'https://manus.im/app/t1' });
    const done = parseManusState({ ...outputRunning, status: 'stopped', done: true, image_count: 1, images: [{ filename: 'a.png', content_type: 'image/png', size_bytes: 3, base64: 'AAAA', note: '' }] });
    expect(done.images[0]).toMatchObject({ filename: 'a.png', contentType: 'image/png', base64: 'AAAA' });
    expect(parseManusState({ ...outputRunning, status: 'error', error: 'x' }).done).toBe(true);
  });

  it('asks Manus for one text-free image at the right size', () => {
    const p = manusImagePrompt({ subject: 'a cozy cafe counter', aspect: '4:5', colors, purpose: 'post', textSpace: 'bottom' });
    expect(p).toContain('exactly ONE');
    expect(p).toContain('a cozy cafe counter');
    expect(p).toContain('1080×1350');
    expect(p).toMatch(/no text, letters/i);
    expect(p).toContain('lower third');
    expect(p).toMatch(/Do not ask questions/);
  });
});
