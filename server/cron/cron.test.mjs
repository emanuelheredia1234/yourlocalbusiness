import { describe, expect, it, vi } from 'vitest';
import { bearerMatches, createCron, cronMode, periodOf, TICK_PATH } from './index.mjs';
import { makeStorage } from '../test/fakes.mjs';

const SECRET = 'test-cron-secret-0000000000000000';
const quiet = { info() {}, warn() {}, error() {} };

/** A fake response for handle(): what send() was given. */
function call(cron, { method = 'POST', auth, path = TICK_PATH } = {}) {
  const out = {};
  const send = (_res, status, body, headers = {}) => Object.assign(out, { status, body, headers });
  const req = { method, headers: auth === undefined ? {} : { authorization: auth }, resume() {} };
  return cron.handle(req, {}, new URL(`http://local${path}`), send).then((handled) => ({ handled, ...out }));
}

describe('cron periods', () => {
  it('everyMs windows and daily HH:MM UTC days', () => {
    const t = Date.parse('2026-11-06T02:59:00Z');
    expect(periodOf({ everyMs: 3_600_000 }, t).id).toBe(periodOf({ everyMs: 3_600_000 }, Date.parse('2026-11-06T02:00:00Z')).id);
    expect(periodOf({ everyMs: 3_600_000 }, t).id).not.toBe(periodOf({ everyMs: 3_600_000 }, Date.parse('2026-11-06T03:00:00Z')).id);
    // before 03:00 the latest due run is yesterday's; from 03:00 it's today's
    expect(periodOf({ dailyAtUtc: '03:00' }, t).id).toBe('d2026-11-05');
    expect(periodOf({ dailyAtUtc: '03:00' }, Date.parse('2026-11-06T03:00:00Z')).id).toBe('d2026-11-06');
    expect(periodOf({ dailyAtUtc: '00:00' }, Date.parse('2026-11-06T23:59:59Z')).id).toBe('d2026-11-06');
  });

  it('refuses malformed jobs', () => {
    const cron = createCron({ env: {}, log: quiet });
    expect(() => cron.register({ name: 'x', everyMs: 60_000, run() {} })).toThrow(/name/);
    expect(() => cron.register({ name: 'job-a', run() {} })).toThrow(/everyMs or dailyAtUtc/);
    expect(() => cron.register({ name: 'job-a', everyMs: 1000, run() {} })).toThrow(/at least/);
    expect(() => cron.register({ name: 'job-a', dailyAtUtc: '25:00', run() {} })).toThrow(/HH:MM/);
    cron.register({ name: 'job-a', everyMs: 60_000, run() {} });
    expect(() => cron.register({ name: 'job-a', everyMs: 60_000, run() {} })).toThrow(/twice/);
  });
});

describe('cron claims', () => {
  it('runs a job once per period, again in the next one, with one app_state document per job', async () => {
    let t = Date.parse('2026-11-06T10:00:00Z');
    const storage = makeStorage();
    const cron = createCron({ env: {}, storage, now: () => t, log: quiet });
    const run = vi.fn(async () => ({ rows: 2 }));
    cron.register({ name: 'every-hour', everyMs: 3_600_000, run });
    const first = await cron.tick();
    expect(first.jobs[0]).toMatchObject({ name: 'every-hour', status: 'ran', result: { rows: 2 } });
    t += 30 * 60_000;
    const second = await cron.tick();
    expect(second.jobs[0]).toMatchObject({ status: 'skipped', reason: 'done', last: 'done' });
    t += 31 * 60_000;
    expect((await cron.tick()).jobs[0].status).toBe('ran');
    expect(run).toHaveBeenCalledTimes(2);
    expect([...storage.documents.keys()]).toEqual(['cron:every-hour']);
  });

  it('two ticks at once (or two copies of the server) run it once', async () => {
    const storage = makeStorage({ latencyMs: 5 });
    const t = Date.parse('2026-11-06T10:00:00Z');
    const run = vi.fn(async () => {});
    const a = createCron({ env: {}, storage, now: () => t, log: quiet });
    const b = createCron({ env: {}, storage, now: () => t, log: quiet });
    a.register({ name: 'daily-job', dailyAtUtc: '03:00', run });
    b.register({ name: 'daily-job', dailyAtUtc: '03:00', run });
    const [x, y, z] = await Promise.all([a.tick(), b.tick(), a.tick()]);
    expect(run).toHaveBeenCalledTimes(1);
    const statuses = [x, y, z].map((s) => s.jobs[0].status).sort();
    expect(statuses).toEqual(['ran', 'skipped', 'skipped']);
  });

  it('records a failure and does not retry it in the same period', async () => {
    let t = Date.parse('2026-11-06T10:00:00Z');
    const storage = makeStorage();
    const cron = createCron({ env: {}, storage, now: () => t, log: quiet });
    const run = vi.fn(async () => {
      throw Object.assign(new Error('provider said: secret sk_live_xxx'), { code: 'UPSTREAM' });
    });
    cron.register({ name: 'flaky', everyMs: 3_600_000, run });
    const s = await cron.tick();
    expect(s.jobs[0]).toMatchObject({ status: 'failed', error: 'UPSTREAM' });
    expect(JSON.stringify(s)).not.toContain('sk_live');
    expect(storage.documents.get('cron:flaky').value).toMatchObject({ state: 'failed', error: 'UPSTREAM' });
    t += 60_000;
    expect((await cron.tick()).jobs[0]).toMatchObject({ status: 'skipped', reason: 'done', last: 'failed' });
    expect(run).toHaveBeenCalledTimes(1);
    t += 3_600_000;
    await cron.tick();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('does not run when the claim cannot be written', async () => {
    const storage = makeStorage();
    storage.fail.put = 'UNREACHABLE';
    const cron = createCron({ env: {}, storage, log: quiet });
    const run = vi.fn();
    cron.register({ name: 'needs-claim', everyMs: 60_000, run });
    expect((await cron.tick()).jobs[0]).toMatchObject({ status: 'skipped', reason: 'no_claim', error: 'UNREACHABLE' });
    expect(run).not.toHaveBeenCalled();
  });

  it('keeps claims in memory without app_state', async () => {
    const cron = createCron({ env: {}, storage: { enabled: false }, log: quiet });
    const run = vi.fn();
    cron.register({ name: 'mem-job', everyMs: 3_600_000, run });
    await cron.tick();
    await cron.tick();
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('cron budget', () => {
  it('answers when the budget is spent; the slow job finishes in the background and is not started again', async () => {
    const storage = makeStorage();
    const cron = createCron({ env: {}, storage, log: quiet, budgetMs: 60 });
    let release;
    let aborted = false;
    const slow = vi.fn(
      (ctx) =>
        new Promise((resolve) => {
          ctx.signal.addEventListener('abort', () => (aborted = true));
          release = resolve;
        }),
    );
    const after = vi.fn();
    cron.register({ name: 'slow-job', everyMs: 3_600_000, run: slow, minMs: 0 });
    cron.register({ name: 'after-job', everyMs: 3_600_000, run: after, minMs: 1000 });
    const t0 = Date.now();
    const s = await cron.tick();
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(s.jobs[0]).toMatchObject({ name: 'slow-job', status: 'running', reason: 'budget' });
    // not enough left for the next one: unclaimed, so the next tick runs it
    expect(s.jobs[1]).toMatchObject({ name: 'after-job', status: 'skipped', reason: 'budget' });
    expect(after).not.toHaveBeenCalled();
    expect(aborted).toBe(true);
    // a second tick while it's still running doesn't start it again
    expect((await cron.tick()).jobs[0]).toMatchObject({ status: 'skipped', reason: 'done', last: 'running' });
    release({ ok: true });
    await cron.settled();
    expect(storage.documents.get('cron:slow-job').value.state).toBe('done');
    expect(slow).toHaveBeenCalledTimes(1);
  });

  it('hands jobs the deadline', async () => {
    const t = 1_000_000;
    const cron = createCron({ env: {}, now: () => t, log: quiet, budgetMs: 40_000 });
    let seen;
    cron.register({ name: 'reads-deadline', everyMs: 60_000, run: (ctx) => (seen = ctx.deadline) });
    await cron.tick();
    expect(seen).toBe(t + 40_000);
  });
});

describe('POST /api/cron/tick', () => {
  const make = (env) => {
    const cron = createCron({ env, log: quiet });
    const run = vi.fn();
    cron.register({ name: 'auth-job', everyMs: 60_000, run });
    return { cron, run };
  };

  it('503 NOT_SET_UP without CRON_SECRET', async () => {
    const { cron, run } = make({});
    const r = await call(cron, { auth: `Bearer ${SECRET}` });
    expect(r).toMatchObject({ handled: true, status: 503, body: { code: 'NOT_SET_UP' } });
    expect(run).not.toHaveBeenCalled();
  });

  it('401 with a missing or wrong bearer, and the secret is never logged', async () => {
    const lines = [];
    const log = { info: (l) => lines.push(l), warn: (l) => lines.push(l), error: (l) => lines.push(l) };
    const cron = createCron({ env: { CRON_SECRET: SECRET }, log });
    const run = vi.fn();
    cron.register({ name: 'auth-job', everyMs: 60_000, run });
    expect((await call(cron, {})).status).toBe(401);
    expect((await call(cron, { auth: 'Bearer nope' })).status).toBe(401);
    expect((await call(cron, { auth: SECRET })).status).toBe(401);
    expect((await call(cron, { auth: `Bearer ${SECRET}x` })).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
    const ok = await call(cron, { auth: `Bearer ${SECRET}` });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, ran: 1, jobs: [{ name: 'auth-job', status: 'ran' }] });
    expect(lines.join('\n')).not.toContain(SECRET);
    expect(JSON.stringify(ok.body)).not.toContain(SECRET);
  });

  it('405 for anything but POST; other paths are not handled', async () => {
    const { cron } = make({ CRON_SECRET: SECRET });
    expect((await call(cron, { method: 'GET', auth: `Bearer ${SECRET}` })).status).toBe(405);
    expect((await call(cron, { path: '/api/cron/other' })).handled).toBe(false);
  });

  it('a double tick over HTTP runs the job once', async () => {
    const { cron, run } = make({ CRON_SECRET: SECRET });
    const [a, b] = await Promise.all([call(cron, { auth: `Bearer ${SECRET}` }), call(cron, { auth: `Bearer ${SECRET}` })]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('who drives the jobs', () => {
  it('local dev ticks in-process; with CRON_SECRET or on a Replit deployment only the tick does', () => {
    expect(cronMode({})).toBe('local');
    expect(cronMode({ CRON_SECRET: SECRET })).toBe('tick');
    expect(cronMode({ REPLIT_DEPLOYMENT: '1' })).toBe('tick');
    const deployed = createCron({ env: { REPLIT_DEPLOYMENT: '1' }, log: quiet });
    expect(deployed.startLocal()).toBe(false);
    expect(deployed.notes()[0]).toMatch(/NOT running/);
    const local = createCron({ env: {}, log: quiet });
    local.register({ name: 'local-job', everyMs: 60_000, run() {} });
    expect(local.startLocal()).toBe(true);
    expect(local.startLocal()).toBe(false);
    local.stopLocal();
  });

  it('bearerMatches is strict', () => {
    expect(bearerMatches(`Bearer ${SECRET}`, SECRET)).toBe(true);
    expect(bearerMatches(`bearer ${SECRET}`, SECRET)).toBe(true);
    expect(bearerMatches(`Bearer ${SECRET}`, '')).toBe(false);
    expect(bearerMatches(undefined, SECRET)).toBe(false);
    expect(bearerMatches(`Basic ${SECRET}`, SECRET)).toBe(false);
  });
});
