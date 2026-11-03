// A log of recent AI requests (who served it, effort, tokens, cost) in DATA_DIR/ai-usage.json and,
// when Supabase's secret key is set, also in Supabase (merged, so copies of the server don't erase
// each other's entries, and the log survives restarts).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_ENTRIES = 500;
const REMOTE_KEY = 'ai-usage';
const REMOTE_EVERY = 15_000;

/**
 * Both logs, newest first. For an entry in both, the most updated copy wins (each update bumps its
 * rev), and this server's on a tie: so a copy that never saw an update can't undo it.
 */
export function mergeEntries(mine, theirs) {
  const byId = new Map();
  for (const e of Array.isArray(theirs) ? theirs : []) if (e && typeof e.id === 'string') byId.set(e.id, e);
  for (const e of mine) {
    const other = byId.get(e.id);
    if (!other || (e.rev ?? 0) >= (other.rev ?? 0)) byId.set(e.id, e);
  }
  return [...byId.values()].sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, MAX_ENTRIES);
}

export class UsageLog {
  constructor(file, { remote = { enabled: false } } = {}) {
    this.file = file;
    this.remote = remote;
    this.entries = [];
    this.timer = null;
    this.remoteTimer = null;
    this.remoteChain = Promise.resolve();
    // updates for entries another copy of the server logged (applied once its entry arrives)
    this.orphans = new Map(); // id → { patch, at }
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(raw?.entries)) this.entries = raw.entries.slice(0, MAX_ENTRIES);
    } catch {
      /* first run */
    }
  }

  add(entry) {
    const id = crypto.randomUUID();
    this.entries.unshift({ id, at: Date.now(), rev: 0, ...entry });
    if (this.entries.length > MAX_ENTRIES) this.entries.length = MAX_ENTRIES;
    this.scheduleSave();
    return id;
  }

  update(id, patch) {
    const e = this.entries.find((x) => x.id === id);
    if (!e) {
      // logged by another copy of the server: apply it when that entry arrives from Supabase
      if (this.remote.enabled && id) {
        const prev = this.orphans.get(id);
        this.orphans.set(id, { patch: { ...(prev?.patch ?? {}), ...patch }, at: Date.now() });
        this.scheduleSave();
      }
      return;
    }
    Object.assign(e, patch, { rev: (e.rev ?? 0) + 1 });
    this.scheduleSave();
  }

  /** Apply waiting updates to entries that have arrived; drop ones waiting over an hour. */
  adoptOrphans() {
    for (const [id, o] of this.orphans) {
      const e = this.entries.find((x) => x.id === id);
      if (e) {
        Object.assign(e, o.patch, { rev: (e.rev ?? 0) + 1 });
        this.orphans.delete(id);
      } else if (Date.now() - o.at > 3600_000) this.orphans.delete(id);
    }
  }

  scheduleSave() {
    if (this.remote.enabled && !this.remoteTimer) {
      this.remoteTimer = setTimeout(() => {
        this.remoteTimer = null;
        void this.flushRemote();
      }, REMOTE_EVERY);
      this.remoteTimer.unref?.();
    }
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 1000);
    this.timer.unref?.();
  }

  /** At start-up: bring in the log kept in Supabase. Never throws. */
  async loadRemote() {
    if (!this.remote.enabled) return;
    try {
      const got = await this.remote.get(REMOTE_KEY);
      if (got && !got.unreadable) this.entries = mergeEntries(this.entries, got.value?.entries);
      this.adoptOrphans();
    } catch (e) {
      console.warn(`Usage log: ${e.message}`);
    }
  }

  /** Merge with Supabase's copy and save it there (one at a time). Never throws. */
  flushRemote() {
    if (!this.remote.enabled) return Promise.resolve();
    if (this.remoteTimer) {
      clearTimeout(this.remoteTimer);
      this.remoteTimer = null;
    }
    this.remoteChain = this.remoteChain.then(async () => {
      try {
        const got = await this.remote.get(REMOTE_KEY);
        // a log saved under another secret can't be read: it's replaced (it holds no keys)
        this.entries = mergeEntries(this.entries, got?.unreadable ? [] : got?.value?.entries);
        this.adoptOrphans();
        await this.remote.put(REMOTE_KEY, { entries: this.entries });
      } catch (e) {
        console.warn(`Usage log: ${e.message}`);
      }
    });
    return this.remoteChain;
  }

  flush() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ entries: this.entries }), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('Could not save the AI usage log:', e.message);
    }
  }

  recent(limit = 50) {
    return this.entries.slice(0, limit);
  }

  /** Totals per day (last 14 days) and per provider. */
  totals(now = Date.now()) {
    const since = now - 14 * 24 * 3600_000;
    const days = new Map();
    const providers = new Map();
    const add = (map, key, e) => {
      const t = map.get(key) ?? { requests: 0, failed: 0, costUsd: 0, credits: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
      t.requests += 1;
      if (!e.ok) t.failed += 1;
      t.costUsd += e.cost?.usd ?? 0;
      t.credits += e.credits ?? 0;
      t.inputTokens += e.usage?.input ?? 0;
      t.outputTokens += e.usage?.output ?? 0;
      t.reasoningTokens += e.usage?.reasoning ?? 0;
      map.set(key, t);
    };
    for (const e of this.entries) {
      if (e.at < since) continue;
      add(days, new Date(e.at).toISOString().slice(0, 10), e);
      add(providers, e.provider, e);
    }
    const round = (t) => ({ ...t, costUsd: Math.round(t.costUsd * 1e4) / 1e4 });
    return {
      days: [...days.entries()].map(([day, t]) => ({ day, ...round(t) })),
      providers: [...providers.entries()].map(([provider, t]) => ({ provider, ...round(t) })),
    };
  }
}
