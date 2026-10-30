// A log of recent AI requests (who served it, effort, tokens, cost) in DATA_DIR/ai-usage.json.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_ENTRIES = 500;

export class UsageLog {
  constructor(file) {
    this.file = file;
    this.entries = [];
    this.timer = null;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(raw?.entries)) this.entries = raw.entries.slice(0, MAX_ENTRIES);
    } catch {
      /* first run */
    }
  }

  add(entry) {
    const id = crypto.randomUUID();
    this.entries.unshift({ id, at: Date.now(), ...entry });
    if (this.entries.length > MAX_ENTRIES) this.entries.length = MAX_ENTRIES;
    this.scheduleSave();
    return id;
  }

  update(id, patch) {
    const e = this.entries.find((x) => x.id === id);
    if (!e) return;
    Object.assign(e, patch);
    this.scheduleSave();
  }

  scheduleSave() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 1000);
    this.timer.unref?.();
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
