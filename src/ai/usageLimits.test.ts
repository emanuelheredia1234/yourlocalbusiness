// Daily limits on the app's keys: what people see when they reach one, and the usage card's helpers.
import { describe, expect, it } from 'vitest';
import { dailyLimitText, friendlyAIError } from './claude';
import { imageErrorMessage } from './image';
import { videoErrorMessage } from './video';
import { countersNote, limitPercent, nextUtcMidnight, ownKeyCapability, parseMyKeys, requestsInUse, resetLabel } from './usageLimits';

const SERVER = 'You’ve reached today’s limit on the app’s AI keys (50 requests or $1.00 a day). It resets at midnight UTC. To keep going now, add your own API keys in Settings › AI keys.';

describe('reaching the daily limit', () => {
  it('shows the server’s message as is when it already points to Settings › AI keys', () => {
    expect(dailyLimitText(SERVER)).toBe(SERVER);
  });
  it('adds the pointer to Settings › AI keys when the message lacks it, or there is none', () => {
    expect(dailyLimitText('Limit reached.')).toBe('Limit reached. To keep going now, add your own API keys in Settings › AI keys.');
    expect(dailyLimitText('')).toMatch(/today’s limit.*Settings › AI keys/);
  });
  it('writing: the note says why the built-in engine answered', () => {
    const note = friendlyAIError('daily_limit', SERVER);
    expect(note.startsWith(SERVER)).toBe(true);
    expect(note).toMatch(/built-in engine answered instead/);
  });
  it('photos: a titled message with the server’s explanation', () => {
    const m = imageErrorMessage(Object.assign(new Error(SERVER), { code: 'DAILY_LIMIT' }));
    expect(m.title).toMatch(/limit/i);
    expect(m.body).toBe(SERVER);
  });
  it('videos: the same', () => {
    expect(videoErrorMessage('VIDEO_DAILY_LIMIT', SERVER)).toEqual({ title: expect.stringMatching(/limit/i), body: SERVER });
  });
});

describe('usage card helpers', () => {
  it('next reset is the coming midnight UTC', () => {
    expect(nextUtcMidnight(Date.parse('2026-11-03T23:59:00Z')).toISOString()).toBe('2026-11-04T00:00:00.000Z');
    expect(nextUtcMidnight(Date.parse('2026-12-31T00:00:00Z')).toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
  it('reset label uses the server’s time, or the next UTC midnight when it is missing or past', () => {
    const now = Date.parse('2026-11-03T12:00:00Z');
    const expected = new Date('2026-11-04T00:00:00Z').toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    expect(resetLabel('2026-11-04T00:00:00.000Z', now)).toContain(expected);
    expect(resetLabel(undefined, now)).toContain(expected);
    expect(resetLabel('2026-11-01T00:00:00.000Z', now)).toContain(expected);
    expect(resetLabel(undefined, now)).toMatch(/^(today|tomorrow) at /);
  });
  it('limit percent is capped at 100 and 0 when there is no limit', () => {
    expect(limitPercent(25, 50)).toBe(50);
    expect(limitPercent(80, 50)).toBe(100);
    expect(limitPercent(10, 0)).toBe(0);
    expect(limitPercent(0, 5)).toBe(0);
  });
});

describe('Settings › AI keys: the own-keys card', () => {
  const providers = [
    { id: 'openai', label: 'OpenAI', kinds: ['text', 'image'], keyUrl: 'https://platform.openai.com/api-keys' },
    { id: 'manus', label: 'Manus', kinds: ['image', 'agent'], keyUrl: '' },
  ];
  it('reads which keys are saved from byProvider', () => {
    const k = parseMyKeys({ available: true, keys: [{ provider: 'openai', last4: '0001' }], byProvider: { openai: { last4: '0001', updatedAt: '2026-11-03T00:00:00Z' }, manus: null }, providers });
    expect(k.available).toBe(true);
    expect(k.byProvider.openai).toEqual({ last4: '0001', updatedAt: '2026-11-03T00:00:00Z' });
    expect(k.byProvider.manus).toBeNull();
    expect(k.providers.map((p) => p.id)).toEqual(['openai', 'manus']);
  });
  it('without SUPABASE_SECRET_KEY: not available, providers still listed', () => {
    const k = parseMyKeys({ available: false, keys: [], byProvider: { openai: null }, providers });
    expect(k.available).toBe(false);
    expect(k.providers).toHaveLength(2);
  });
  it('tolerates missing or odd fields (and the older list-only answer)', () => {
    expect(parseMyKeys(null)).toEqual({ available: true, byProvider: {}, providers: [] });
    const k = parseMyKeys({ keys: [{ provider: 'manus', last4: 'abcd' }], providers: [{ id: 'x' }, 7] });
    expect(k.byProvider.manus).toEqual({ last4: 'abcd' });
    expect(k.providers).toEqual([]);
  });
  it('says what each key really runs: a Manus key is only for Manus tasks, not the app’s photos', () => {
    expect(ownKeyCapability(providers[0])).toEqual({ short: 'Writing, Photos', saved: 'Writing, Photos now run in your own OpenAI account.' });
    const m = ownKeyCapability(providers[1]);
    expect(m.short).toMatch(/^Manus tasks/);
    expect(m.saved).toMatch(/Other photos still use the app’s keys/);
    expect(ownKeyCapability({ id: 'xai', label: 'xAI', kinds: ['video'] }).saved).toBe('Videos now runs in your own xAI account.');
  });
});

describe('Settings › AI keys: the usage cards', () => {
  it('counts running requests in the Requests meter, like the server’s limit does', () => {
    expect(requestsInUse({ usedRequests: 0, running: 1 })).toBe(1);
    expect(requestsInUse({ usedRequests: 3 })).toBe(3);
  });
  it('warns when the counters are only in memory, or Supabase isn’t keeping them', () => {
    expect(countersNote('supabase', null)).toBeNull();
    expect(countersNote('memory', null)).toMatch(/start again/);
    expect(countersNote('supabase', { code: 'UNREACHABLE', message: 'Couldn’t reach Supabase.' })).toMatch(/start again/);
    const owner = countersNote('memory', { code: 'NOT_SET_UP', message: 'Run supabase/migrations/20261103030000_ai_usage_daily.sql …' }, { owner: true });
    expect(owner).toMatch(/20261103030000_ai_usage_daily\.sql/);
  });
});
