// Source `social`: one entry per network with a stored handle or a connected account. Connected (with a target):
// own insights. Not connected: treg public data. Connected but needing a reconnect or limited: public data with
// the note 'reconnect' (never a silent fallback).

import { handlesOf } from '../handles.mjs';
import { publicStats } from './social-public.mjs';
import { ownStats } from './social-own.mjs';
import { publicCode } from '../runner.mjs';

const isOwnUsable = (s) => s?.state === 'connected' && !!s.targetLabel;
const needsReconnect = (s) => s?.state === 'needs_reconnect' || s?.state === 'limited';

/** Which networks this project has something for: a handle or a usable connection. */
export function socialPlan(project, statuses) {
  const handles = handlesOf(project);
  const byPlatform = Object.fromEntries((statuses || []).map((s) => [s.platform, s]));
  const networks = new Set(Object.keys(handles));
  for (const n of ['instagram', 'facebook', 'tiktok', 'linkedin', 'x', 'youtube']) if (isOwnUsable(byPlatform[n])) networks.add(n);
  return { handles, byPlatform, networks: [...networks] };
}

/**
 * → { status, errorCode?, data: SocialData, summary, resolved } (resolved: ids to keep). Throws only a stopping
 * treg error (cap, block, team balance) when no network could be read at all.
 */
export async function socialSource({ project, statuses, runner, resolved, env, fetch, now, recordEstimate }) {
  const { handles, byPlatform, networks } = socialPlan(project, statuses);
  if (!networks.length) return { status: 'not_connected', errorCode: 'NO_HANDLES', data: { networks: [] } };
  const results = [];
  let patch = {};
  let failed = 0;
  let stop = null;
  await Promise.all(
    networks.map(async (network) => {
      const status = byPlatform[network];
      const handle = handles[network];
      try {
        if (isOwnUsable(status)) {
          try {
            const own = await ownStats(network, { runner, env, fetch, now, status, handle, recordEstimate });
            if (own) return void results.push(own);
          } catch (e) {
            if (!handle) {
              results.push({ network, origin: 'own', note: e?.kind === 'reconnect' ? 'reconnect' : 'busy' });
              return;
            }
            const got = await publicStats(runner, network, handle, resolved, { note: e?.kind === 'reconnect' ? 'reconnect' : 'busy' });
            patch = { ...patch, ...(got.resolved || {}) };
            return void results.push(got.stats);
          }
        }
        if (!handle) return;
        const got = await publicStats(runner, network, handle, resolved, { note: needsReconnect(status) ? 'reconnect' : undefined });
        patch = { ...patch, ...(got.resolved || {}) };
        results.push(got.stats);
      } catch (e) {
        failed += 1;
        stop = stop ?? e;
      }
    }),
  );
  const order = ['instagram', 'facebook', 'tiktok', 'linkedin', 'x', 'youtube'];
  results.sort((a, b) => order.indexOf(a.network) - order.indexOf(b.network));
  if (!results.length) {
    if (stop) throw stop;
    return { status: 'error', errorCode: 'UNAVAILABLE', data: { networks: [] } };
  }
  const withNumbers = results.filter((r) => r.followers !== undefined || r.engagement !== undefined);
  const status = failed || withNumbers.length < results.length ? 'partial' : 'ok';
  const summary = {
    followers: results.reduce((a, r) => a + (r.followers ?? 0), 0),
    engagement: results.reduce((a, r) => a + (r.engagement ?? 0), 0),
    byNetwork: Object.fromEntries(results.filter((r) => r.followers !== undefined).map((r) => [r.network, r.followers])),
  };
  return { status, errorCode: stop?.kind ? publicCode(stop) : null, data: { networks: results }, summary, resolved: Object.keys(patch).length ? patch : null };
}
