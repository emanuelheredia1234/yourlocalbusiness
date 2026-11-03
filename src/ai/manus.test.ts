import { describe, expect, it } from 'vitest';
import type { ManusState } from './manus';
import { manusImagePrompt, parseManusCreate, parseManusState } from './manus';
import { parseResult, postBlocker, postPrompt, postUrlFrom, scheduleWindowError, stateFromManus, suggestedAccount, textWarning } from './manusPost';
import { safeStorage } from '@/lib/storage';
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

describe('Posting with Manus', () => {
  const now = Date.parse('2026-10-28T12:00:00Z');
  const fb = (o: Partial<Parameters<typeof postPrompt>[0]> = {}) => postPrompt({ network: 'facebook', mode: 'schedule', account: 'Sumari', whenIso: '2026-10-29T16:00:00Z', timeZone: 'America/Chicago', text: 'Line one\n\n#tax #freelance', media: 'image', ...o });

  it('only schedules inside each network’s window', () => {
    expect(scheduleWindowError('facebook', '2026-10-28T12:10:00Z', now)).toMatch(/30 minutes/);
    expect(scheduleWindowError('facebook', '2027-02-01T12:00:00Z', now)).toMatch(/Facebook schedules posts up to 75 days/);
    expect(scheduleWindowError('facebook', '2026-10-29T09:00:00Z', now)).toBeNull();
    // TikTok only schedules 10 days ahead; LinkedIn three months
    expect(scheduleWindowError('tiktok', '2026-11-10T12:00:00Z', now)).toMatch(/TikTok schedules posts up to 10 days/);
    expect(scheduleWindowError('tiktok', '2026-11-05T12:00:00Z', now)).toBeNull();
    expect(scheduleWindowError('linkedin', '2027-01-20T12:00:00Z', now)).toBeNull();
    expect(scheduleWindowError('x', 'not a date', now)).toMatch(/Pick a date/);
  });

  it('writes exact Facebook instructions that never publish immediately', () => {
    const p = fb();
    expect(p).toContain('"Sumari"');
    expect(p).toContain('Line one\n\n#tax #freelance');
    expect(p).toContain('NOT "Publish now"');
    expect(p).toContain('America/Chicago');
    expect(p).toContain('2026-10-29T16:00:00.000Z');
    expect(p).toContain('Thursday, October 29, 2026 at 11:00 AM');
    expect(p).toContain('RESULT: SCHEDULED');
    expect(p).toContain('business.facebook.com');
    expect(fb({ account: '', media: null })).toContain('text-only post');
  });

  it('posts on Facebook right away with the video attached, exactly once', () => {
    const p = fb({ mode: 'now', text: 'New candles 🕯️\n\n#handmade', media: 'video' });
    expect(p).toMatch(/right now/);
    expect(p).toContain('New candles 🕯️\n\n#handmade');
    expect(p).toContain('Attach the video file provided');
    expect(p).toMatch(/Wait until Facebook has finished uploading/);
    expect(p).toContain('Choose "Publish"');
    expect(p).toContain('Never schedule it for later.');
    expect(p).toMatch(/Post exactly once/);
    expect(p).toContain('RESULT: POSTED');
    expect(p).not.toContain('RESULT: SCHEDULED');
    expect(fb({ mode: 'now', account: '' })).toMatch(/business's Facebook Page/);
  });

  it('posts on Instagram, TikTok, LinkedIn and X the way each one works', () => {
    const ig = postPrompt({ network: 'instagram', mode: 'now', account: '@sumari', whenIso: '', timeZone: 'UTC', text: 'Hi', media: 'image' });
    expect(ig).toContain('Post ONE organic post on Instagram, right now.');
    expect(ig).toContain('instagram.com');
    expect(ig).toContain('"@sumari"');
    expect(ig).toMatch(/choose "Original"/);
    expect(ig).toContain('Choose "Share"');
    const igLater = postPrompt({ network: 'instagram', mode: 'schedule', account: '@sumari', whenIso: '2026-10-29T16:00:00Z', timeZone: 'UTC', text: 'Hi', media: 'image' });
    expect(igLater).toMatch(/Meta Business Suite/);
    expect(igLater).toMatch(/only schedules from there/);
    const tt = postPrompt({ network: 'tiktok', mode: 'schedule', account: '@sumari', whenIso: '2026-10-29T16:00:00Z', timeZone: 'UTC', text: 'Hi', media: 'video' });
    expect(tt).toContain('tiktokstudio/upload');
    expect(tt).toMatch(/Turn on "Schedule"/);
    expect(tt).toContain('RESULT: SCHEDULED | <account name> | <date and time as TikTok shows it>');
    const li = postPrompt({ network: 'linkedin', mode: 'now', account: 'Sumari Tax Co', whenIso: '', timeZone: 'UTC', text: 'Hi', media: null });
    expect(li).toContain('Start a post');
    expect(li).toContain('"Sumari Tax Co"');
    expect(li).toContain('text-only post');
    const x = postPrompt({ network: 'x', mode: 'now', account: '@sumari', whenIso: '', timeZone: 'UTC', text: 'Hi', media: 'image' });
    expect(x).toContain('x.com');
    expect(x).toMatch(/never split the text into a thread/);
    // every network: one post, exactly as given, and a result line
    for (const p of [ig, tt, li, x]) {
      expect(p).toMatch(/Post exactly once/);
      expect(p).toContain('<<<POST TEXT\nHi\nPOST TEXT>>>');
      expect(p).toContain('RESULT: FAILED | <short reason>');
    }
  });

  it('knows what each network needs before Manus starts', () => {
    const video = { kind: 'video', id: 'm', name: 'v.mp4' } as never;
    const image = { kind: 'image', id: 'm', name: 'i.png' } as never;
    expect(postBlocker({ platform: 'instagram', format: 'image', media: undefined }, { viaServer: true })).toMatch(/Instagram needs an image or a video/);
    expect(postBlocker({ platform: 'tiktok', format: 'image', media: undefined }, { viaServer: true })).toMatch(/TikTok needs/);
    expect(postBlocker({ platform: 'linkedin', format: 'image', media: undefined }, { viaServer: true })).toBeNull();
    expect(postBlocker({ platform: 'facebook', format: 'video', media: undefined }, { viaServer: true })).toMatch(/storyboard can’t be posted/);
    expect(postBlocker({ platform: 'facebook', format: 'video', media: video }, { viaServer: false })).toMatch(/self-hosted/);
    expect(postBlocker({ platform: 'x', format: 'image', media: image }, { viaServer: false })).toBeNull();
    expect(textWarning({ platform: 'x', caption: 'a'.repeat(270), hashtags: ['#one', '#two'] })).toMatch(/X takes 280 characters on most accounts, and this post has 281/);
    expect(textWarning({ platform: 'x', caption: 'short', hashtags: [] })).toBeNull();
    expect(textWarning({ platform: 'linkedin', caption: 'a'.repeat(900), hashtags: [] })).toBeNull();
  });

  it('suggests the account last used for the project, then the brand’s handle', () => {
    const brand = { name: 'Sumari Tax Co', socials: { instagram: '@sumari.tax' } };
    expect(suggestedAccount('proj_a', 'instagram', brand)).toBe('@sumari.tax');
    expect(suggestedAccount('proj_a', 'facebook', brand)).toBe('Sumari Tax Co');
    expect(suggestedAccount('proj_a', 'x', brand)).toBe('');
    safeStorage.setItem('ylb-post-account:proj_a:instagram', '@sumari');
    expect(suggestedAccount('proj_a', 'instagram', brand)).toBe('@sumari');
    expect(suggestedAccount('proj_b', 'instagram', brand)).toBe('@sumari.tax');
    safeStorage.removeItem('ylb-post-account:proj_a:instagram');
  });

  it('reads Manus’s result line', () => {
    expect(parseResult('Done.\nRESULT: POSTED | Sumari | https://facebook.com/123')).toEqual({ state: 'posted', detail: 'Sumari · https://facebook.com/123' });
    expect(parseResult('RESULT: PUBLISHED | Sumari').state).toBe('posted');
    expect(parseResult('Done!\nRESULT: SCHEDULED | Sumari | Oct 29, 11:00 AM')).toEqual({ state: 'scheduled', detail: 'Sumari · Oct 29, 11:00 AM' });
    expect(parseResult('**RESULT: FAILED | Not signed in**')).toEqual({ state: 'failed', detail: 'Not signed in' });
    expect(parseResult('All good, it is scheduled.')).toEqual({ state: null, detail: '' });
  });

  it('keeps a reported link only when it’s on that network', () => {
    expect(postUrlFrom('Sumari · https://www.instagram.com/p/Cx1/', 'instagram')).toBe('https://www.instagram.com/p/Cx1/');
    expect(postUrlFrom('Sumari · https://x.com/sumari/status/1.', 'x')).toBe('https://x.com/sumari/status/1');
    expect(postUrlFrom('Sumari · https://twitter.com/sumari/status/1', 'x')).toBe('https://twitter.com/sumari/status/1');
    expect(postUrlFrom('https://evil.example/instagram.com/p/1', 'instagram')).toBeUndefined();
    expect(postUrlFrom('https://instagram.com.evil.example/p/1', 'instagram')).toBeUndefined();
    expect(postUrlFrom('http://www.instagram.com/p/1', 'instagram')).toBeUndefined();
    expect(postUrlFrom('https://www.facebook.com/', 'facebook')).toBeUndefined();
    expect(postUrlFrom('no link here', 'tiktok')).toBeUndefined();
  });

  it('maps Manus task states to post states', () => {
    const base: ManusState = { taskId: 't', status: 'running', agentStatus: 'running', done: false, waiting: false, waitingType: '', waitingDescription: '', error: '', title: '', taskUrl: '', creditUsage: 0, text: '', imageCount: 0, images: [] };
    expect(stateFromManus(base).state).toBe('working');
    expect(stateFromManus({ ...base, status: 'waiting', waiting: true, waitingType: 'needConnectMyBrowser' })).toEqual({ state: 'needs_input', message: expect.stringMatching(/connect your browser/) });
    expect(stateFromManus({ ...base, status: 'stopped', done: true, text: 'RESULT: SCHEDULED | Sumari | Oct 29' }).state).toBe('scheduled');
    expect(stateFromManus({ ...base, status: 'stopped', done: true, text: 'RESULT: FAILED | Page not found' })).toEqual({ state: 'failed', message: 'Page not found' });
    expect(stateFromManus({ ...base, status: 'stopped', done: true, text: 'I scheduled it.' }).state).toBe('finished');
    expect(stateFromManus({ ...base, status: 'error', error: 'crashed' })).toEqual({ state: 'failed', message: 'crashed' });
    // posting right away, on any network
    expect(stateFromManus(base, 'now')).toEqual({ state: 'working', message: 'Manus is posting it on Facebook…' });
    expect(stateFromManus(base, 'now', 'tiktok')).toEqual({ state: 'working', message: 'Manus is posting it on TikTok…' });
    expect(stateFromManus({ ...base, status: 'stopped', done: true, text: 'RESULT: POSTED | Sumari | https://fb.com/1' }, 'now')).toEqual({ state: 'posted', message: 'Sumari · https://fb.com/1', url: 'https://fb.com/1' });
    expect(stateFromManus({ ...base, status: 'stopped', done: true, text: 'RESULT: POSTED | @sumari' }, 'now', 'x')).toEqual({ state: 'posted', message: '@sumari', url: undefined });
    expect(stateFromManus({ ...base, status: 'stopped', done: true, text: 'I posted it.' }, 'now').message).toBe('I posted it.');
  });
});
