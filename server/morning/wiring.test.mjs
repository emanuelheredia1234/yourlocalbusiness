// The morning module in server/integrations/wiring.mjs: its route prefix, /api/config's flag, the cron job names (last
// in each tick), MORNING_ACTIONS=off, the env settings, the startup notes and the migration list.
import { describe, expect, it } from 'vitest';
import http from 'node:http';
import { createIntegrations, moduleFor } from '../integrations/wiring.mjs';
import { morningSettings } from './config.mjs';

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};
const db = { enabled: true, select: async () => [], insert: async () => [], update: async () => [], upsert: async () => [], remove: async () => [], rpc: async () => [] };
const auth = { enabled: true, identify: async () => ({ id: '00000000-0000-4000-8000-000000000001', email: 'x@y.test', isAdmin: false }) };

describe('morning wiring', () => {
  it('routes /api/morning/ to the module', () => {
    expect(moduleFor('/api/morning/today')).toBe('morning');
    expect(moduleFor('/api/morning/actions/abc/feedback')).toBe('morning');
    expect(moduleFor('/api/morningx')).toBeNull();
  });

  it('on: the config flag, both jobs (the hourly one last in each tick), the notes and the migration list', () => {
    const integrations = createIntegrations({ env: {}, send, db, auth, appState: { enabled: false } });
    expect(integrations.morningConfig()).toEqual({ enabled: true });
    const names = integrations.cronJobs().map((j) => j.name);
    expect(names.slice(-2)).toEqual(['morning-actions', 'morning-prune']);
    const hourly = integrations.cronJobs().find((j) => j.name === 'morning-actions');
    expect(hourly).toMatchObject({ everyMs: 3_600_000, minMs: 25_000 });
    expect(integrations.cronJobs().find((j) => j.name === 'morning-prune')).toMatchObject({ dailyAtUtc: '05:23' });
    const notes = integrations.notes().join('\n');
    expect(notes).toContain('Morning action: on (needs supabase/migrations/20261116000000_morning_action.sql); up to 24 businesses per hourly tick');
    expect(notes).toContain('No AI key powers Morning action');
    expect(notes).toContain('supabase/migrations/20261116000000_morning_action.sql in Supabase');
    const powered = createIntegrations({ env: {}, send, db, auth, appState: { enabled: false }, aiPowered: () => true }).notes().join('\n');
    expect(powered).not.toContain('No AI key powers Morning action');
  });

  it('MORNING_ACTIONS=off: no jobs, every route 503 NOT_SET_UP, and the notes say so', async () => {
    const integrations = createIntegrations({ env: { MORNING_ACTIONS: 'off' }, send, db, auth, appState: { enabled: false } });
    expect(integrations.morningConfig()).toEqual({ enabled: false });
    expect(integrations.cronJobs().some((j) => j.name.startsWith('morning'))).toBe(false);
    expect(integrations.notes().join('\n')).toContain('Morning action: off (MORNING_ACTIONS=off).');
    const server = http.createServer((req, res) => integrations.handle(req, res, new URL(req.url, 'http://local')));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const r = await fetch(`http://127.0.0.1:${server.address().port}/api/morning/today?projectId=p1`);
      expect(r.status).toBe(503);
      expect((await r.json()).code).toBe('NOT_SET_UP');
    } finally {
      await new Promise((r) => server.close(r));
    }
    // without the database or accounts it's off too
    expect(createIntegrations({ env: {}, send, db: { enabled: false } }).morningConfig()).toEqual({ enabled: false });
  });

  it('MORNING_PER_TICK and MORNING_CONCURRENCY: bad values fall back to the defaults', () => {
    expect(morningSettings({})).toEqual({ off: false, perTick: 24, concurrency: 6 });
    expect(morningSettings({ MORNING_PER_TICK: '50', MORNING_CONCURRENCY: '10' })).toMatchObject({ perTick: 50, concurrency: 10 });
    expect(morningSettings({ MORNING_PER_TICK: '0', MORNING_CONCURRENCY: '11' })).toMatchObject({ perTick: 24, concurrency: 6 });
    expect(morningSettings({ MORNING_PER_TICK: 'lots', MORNING_CONCURRENCY: '-1' })).toMatchObject({ perTick: 24, concurrency: 6 });
    expect(morningSettings({ MORNING_ACTIONS: 'OFF' }).off).toBe(true);
  });
});
