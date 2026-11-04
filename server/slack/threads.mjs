// The Slack threads this app started with Viktor (the privacy guard). The owner's user token can read every
// DM the owner has, so the server reads, and replies in, only threads in this list, owned by the caller:
// there is no route that posts to, or reads, any other conversation. Kept like the Manus task list:
// DATA_DIR/slack-threads.json (mode 600) and, with Supabase, app_state['slack-threads'] (encrypted), merged
// on save so several copies of the server agree.
//
//   { id: 'vk_' + 22 base64url, owner, channel, place: 'dm' | 'channel', ts: '<parent ts>' | null,
//     kind: 'build' | 'chat', target?, at, updatedAt, permalink?, sent: [{ ts | null, ref, at, kind }] (last 50),
//     unlocated?: { ref, sentAt } }

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const REMOTE_KEY = 'slack-threads';
export const THREAD_TTL = 30 * 24 * 3600_000;
const MAX_THREADS = 500;
const MAX_SENT = 50;

export class ThreadRegistry {
  constructor({ file = '', remote = { enabled: false } } = {}) {
    this.file = file;
    this.remote = remote;
    this.threads = new Map();
    this.chain = Promise.resolve();
    try {
      const raw = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
      for (const [id, t] of Object.entries(raw?.threads ?? {})) if (this.fresh(t)) this.threads.set(id, t);
    } catch {
      /* none yet */
    }
  }

  fresh(t, now = Date.now()) {
    return !!t && typeof t === 'object' && now - (t.at ?? 0) < THREAD_TTL;
  }

  /** A new thread id: opaque, unguessable. */
  static newId() {
    return `vk_${crypto.randomBytes(16).toString('base64url')}`;
  }

  /** Merge the list kept in Supabase into this server's (started by another copy, or before a restart). */
  async loadRemote() {
    if (!this.remote.enabled) return;
    try {
      const got = await this.remote.get(REMOTE_KEY);
      for (const [id, t] of Object.entries(got?.unreadable ? {} : (got?.value?.threads ?? {}))) {
        if (!this.fresh(t)) continue;
        const mine = this.threads.get(id);
        if (!mine || (t.updatedAt ?? 0) > (mine.updatedAt ?? 0)) this.threads.set(id, t);
      }
    } catch (e) {
      console.warn(`Slack threads: ${e.message}`);
    }
  }

  /** Before using a thread this server doesn't know: look in Supabase. */
  async ensure(id) {
    if (!this.threads.has(id)) await this.loadRemote();
  }

  get(id) {
    const t = this.threads.get(id);
    if (!t) return null;
    if (!this.fresh(t)) {
      this.threads.delete(id);
      return null;
    }
    return t;
  }

  /** Every thread (for /verify: one that already holds a Ref). */
  all() {
    return [...this.threads.values()].filter((t) => this.fresh(t));
  }

  add(entry) {
    const now = Date.now();
    const t = { ...entry, at: entry.at ?? now, updatedAt: now, sent: (entry.sent ?? []).slice(-MAX_SENT) };
    this.threads.set(t.id, t);
    this.save();
    return t;
  }

  /** Change a thread (change(t) edits it in place). */
  update(id, change) {
    const t = this.threads.get(id);
    if (!t) return null;
    change(t);
    t.sent = (t.sent ?? []).slice(-MAX_SENT);
    t.updatedAt = Date.now();
    this.save();
    return t;
  }

  /** Resolves when the list has reached Supabase (never rejects). */
  saved() {
    return this.chain;
  }

  prune() {
    for (const [id, t] of this.threads) if (!this.fresh(t)) this.threads.delete(id);
    if (this.threads.size > MAX_THREADS) {
      const oldest = [...this.threads.values()].sort((a, b) => (a.at ?? 0) - (b.at ?? 0)).slice(0, this.threads.size - MAX_THREADS);
      for (const t of oldest) this.threads.delete(t.id);
    }
  }

  save() {
    this.prune();
    if (this.remote.enabled) {
      this.chain = this.chain.then(async () => {
        try {
          await this.loadRemote();
          this.prune();
          await this.remote.put(REMOTE_KEY, { threads: Object.fromEntries(this.threads) });
        } catch (e) {
          console.warn(`Slack threads: ${e.message}`);
        }
      });
    }
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ threads: Object.fromEntries(this.threads) }), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (e) {
      if (!this.remote.enabled) console.error('Could not save the Slack thread list:', e.message);
    }
  }
}
