// Per-key AI settings, kept on the server in DATA_DIR/ai-providers.json and, when Supabase's secret
// key is set, also (encrypted) in Supabase: hosts like Replit's published apps wipe their disk on
// restart, and several copies of the server must agree on the keys (server/appState.mjs).
//
//   { providers: { [id]: { apiKey?, enabled?, functions?, effort?: {kind: value}, models?: {kind: id} } }, order: [id],
//     limits?: { requestsPerDay, usdPerDay },   (daily limits for signed-in non-admin users on these keys; 0 = none)
//     connections?: { slack?: SlackConn } }       (the owner's Slack user token for Viktor: see slackPublic())
// Keys from Replit Secrets / env vars take precedence over keys typed into the app, and no key
// is ever sent back to the browser (only its last 4 characters).

import fs from 'node:fs';
import path from 'node:path';
import { FUNCTION_IDS, PROVIDERS, PROVIDER_IDS, adapterId, defaultEffort, effortIds, fnById, kindDef, supportedFunctions, supports } from './registry.mjs';
import { hasChannelScopes, missingFor } from '../slack/manifest.mjs';

export function maskKey(key) {
  if (!key) return '';
  return `••••${String(key).slice(-4)}`;
}

const MODEL_RE = /^[A-Za-z0-9][\w.:/@+-]{0,127}$/;

const fail = (status, message) => Object.assign(new Error(message), { status });
const REMOTE_KEY = 'ai-providers';

/**
 * Writing functions added after keys could already have a saved "Powers" list: such a key powers them
 * too (as a new key would) until the owner unticks them. Saving the list records which functions
 * existed then (`seen`), so later ones are told apart from ones the owner unticked.
 */
const ADDED_LATER = ['assistant', 'strategy'];
/**
 * Manus's Building pages & assets and Chat with Manus are on for Manus keys saved before they existed, until the
 * owner unticks them: the owner asked for these, and every build or chat still asks first, with who does it
 * and what it costs, before anything goes to Manus.
 */
const ADDED_LATER_AGENTS = ['build', 'agentchat'];
const isNewFor = (saved, fn) => (Array.isArray(saved.seen) ? !saved.seen.includes(fn) && (fnById[fn]?.kind === 'text' || ADDED_LATER_AGENTS.includes(fn)) : ADDED_LATER.includes(fn) || ADDED_LATER_AGENTS.includes(fn));

/** The Secret that holds the owner's Slack user token (it wins over one saved in the app). */
export const SLACK_ENV = 'SLACK_USER_TOKEN';
const SLACK_FIELDS = ['token', 'verified', 'viktor', 'where', 'problem'];

/** Daily limits for each signed-in non-admin user on the owner's keys, until the owner changes them. */
export const DEFAULT_LIMITS = { requestsPerDay: 50, usdPerDay: 1 };
const MAX_LIMITS = { requestsPerDay: 100_000, usdPerDay: 10_000 };

function cleanLimits(raw) {
  const out = { ...DEFAULT_LIMITS };
  for (const k of Object.keys(DEFAULT_LIMITS)) {
    const v = Number(raw?.[k]);
    if (raw && raw[k] !== undefined && raw[k] !== null && Number.isFinite(v) && v >= 0) out[k] = k === 'requestsPerDay' ? Math.min(Math.floor(v), MAX_LIMITS[k]) : Math.min(Math.round(v * 1e6) / 1e6, MAX_LIMITS[k]);
  }
  return out;
}
const LOCAL_ONLY = { enabled: false };

export class AIStore {
  /**
   * @param {string} file  where settings are saved
   * @param {object} o     env: where Secrets are read; legacyFile: the old image-providers.json to import once
   */
  constructor(file, { env = process.env, legacyFile = '', remote = LOCAL_ONLY } = {}) {
    this.file = file;
    this.env = env;
    this.remote = remote;
    this.remoteVersion = null; // updated_at of the Supabase copy this server's settings are based on
    this.lastCheck = 0;
    this.checking = null;
    this.pending = Promise.resolve();
    this.unsynced = []; // changes made here that Supabase doesn't have yet (re-applied on top of newer settings)
    this.problem = null; // what went wrong the last time Supabase was asked: { code, message }
    this.state = { providers: {}, order: [...PROVIDER_IDS] };
    this.imported = false;
    let loaded = false;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw && typeof raw === 'object') {
        this.adopt(raw);
        loaded = true;
      }
    } catch {
      /* first run */
    }
    if (!loaded && legacyFile) this.importLegacy(legacyFile);
  }

  adopt(raw) {
    this.state = {
      providers: raw?.providers && typeof raw.providers === 'object' ? raw.providers : {},
      order: Array.isArray(raw?.order) ? raw.order : [...PROVIDER_IDS],
      ...(raw?.limits && typeof raw.limits === 'object' ? { limits: raw.limits } : {}),
      // the Slack connection (Viktor) lives here too: a field left out would be wiped by the next load
      ...(raw?.connections && typeof raw.connections === 'object' && !Array.isArray(raw.connections) ? { connections: raw.connections } : {}),
    };
  }

  /** Where settings typed into the app are kept: 'supabase' (survives restarts) or 'disk'. */
  get storage() {
    return this.remote.enabled ? 'supabase' : 'disk';
  }

  /** Why Supabase isn't keeping the settings right now (null when it is, or isn't used). */
  get storageProblem() {
    return this.remote.enabled ? this.problem : null;
  }

  noteProblem(e) {
    this.problem = { code: e?.code || 'UNREACHABLE', message: e?.message || 'Couldn’t reach Supabase.' };
  }

  /** Re-apply this server's changes that Supabase doesn't have yet, on top of the settings just read. */
  reapply() {
    for (const change of this.unsynced) {
      try {
        change(this.state);
      } catch {
        /* no longer applies to the newer settings */
      }
    }
  }

  /** Settings from Supabase this server can't decrypt: say so, and never write over them on its own. */
  unreadable(got) {
    this.remoteVersion = got.updatedAt;
    this.problem = {
      code: 'UNREADABLE',
      message: 'The AI settings saved in Supabase were encrypted with a different secret (SUPABASE_SECRET_KEY or USER_KEYS_SECRET changed), so this server can’t read them. Put the old secret back to get them, or save a change here to replace them.',
    };
  }

  /**
   * At start-up: take the settings saved in Supabase. If Supabase has none yet, upload this server's
   * (keys typed into the app before Supabase kept them). Never throws.
   */
  async loadRemote() {
    if (!this.remote.enabled) return 'disk';
    try {
      const got = await this.remote.get(REMOTE_KEY);
      this.lastCheck = Date.now();
      if (got?.unreadable) {
        this.unreadable(got);
        console.warn(`AI settings: ${this.problem.message}`);
        return 'unreadable';
      }
      if (got) {
        this.adopt(got.value);
        this.remoteVersion = got.updatedAt;
        this.reapply();
        this.saveLocal();
        this.problem = null;
        if (this.unsynced.length) await this.push();
        return 'loaded';
      }
      this.problem = null;
      this.remoteVersion = null;
      if (!Object.keys(this.state.providers).length) return 'empty';
      // created only if no other copy of the server created it meanwhile (then theirs is taken)
      this.unsynced.push(() => {});
      await this.push();
      return 'uploaded';
    } catch (e) {
      this.noteProblem(e);
      console.warn(`AI settings: ${e.message} Using this server’s copy for now.`);
      return e.code === 'NO_TABLE' ? 'no-table' : 'unreachable';
    }
  }

  /** Pick up changes saved by another copy of the server (looked up at most every `every` ms). */
  async refresh({ force = false, every = 10_000 } = {}) {
    if (!this.remote.enabled) return;
    if (this.checking) {
      // a forced look must start after any change that's being saved, so wait for the one under way
      if (!force) return this.checking;
      await this.checking;
    } else if (!force && Date.now() - this.lastCheck < every) return;
    this.checking = (async () => {
      try {
        const version = await this.remote.version(REMOTE_KEY);
        if (version && version !== this.remoteVersion) {
          const got = await this.remote.get(REMOTE_KEY);
          if (got?.unreadable) this.unreadable(got);
          else if (got) {
            this.adopt(got.value);
            this.remoteVersion = got.updatedAt;
            this.reapply();
            this.saveLocal();
            this.problem = null;
          }
        } else if (this.problem?.code !== 'UNREADABLE' && !this.unsynced.length) this.problem = null;
      } catch (e) {
        this.noteProblem(e);
        console.warn(`AI settings: ${e.message}`);
      } finally {
        this.lastCheck = Date.now();
        this.checking = null;
      }
    })();
    return this.checking;
  }

  /** Resolves when the last change reached Supabase; rejects (NOT_SAVED…) if it couldn't. */
  persisted() {
    return this.pending;
  }

  /**
   * Send this server's settings to Supabase, but only over the version they're based on. If another
   * copy saved first, start from its settings, re-apply this server's changes and try again.
   */
  async push() {
    if (!this.unsynced.length) return;
    for (let attempt = 0; ; attempt++) {
      const sending = this.unsynced.length;
      try {
        const version = await this.remote.put(REMOTE_KEY, this.state, { ifVersion: this.remoteVersion ?? null });
        this.remoteVersion = version;
        this.lastCheck = Date.now();
        this.unsynced.splice(0, sending);
        this.problem = null;
        return;
      } catch (e) {
        if (e?.code === 'CONFLICT' && attempt < 3) {
          const got = await this.remote.get(REMOTE_KEY);
          if (got?.unreadable) {
            this.unreadable(got);
            throw Object.assign(new Error(this.problem.message), { code: 'UNREADABLE', status: 502 });
          }
          if (!got) {
            // the saved settings were deleted meanwhile: save this server's again (never lose keys silently)
            this.remoteVersion = null;
            continue;
          }
          this.adopt(got.value);
          this.remoteVersion = got.updatedAt;
          this.reapply();
          this.saveLocal();
          continue;
        }
        this.noteProblem(e);
        throw e;
      }
    }
  }

  /** Apply a change here (and on disk), then queue it for Supabase. */
  mutate(change) {
    change(this.state);
    this.saveLocal();
    if (!this.remote.enabled) return;
    this.unsynced.push(change);
    // one save at a time, so an older one can never land after a newer one
    const p = this.pending.catch(() => undefined).then(() => this.push());
    p.catch((e) => console.warn(`AI settings: ${e.message}`));
    this.pending = p;
  }

  /** Bring over image keys saved by the old Settings → Image generation page (photos only). */
  importLegacy(legacyFile) {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
    } catch {
      return;
    }
    const old = raw?.providers && typeof raw.providers === 'object' ? raw.providers : {};
    const found = {};
    for (const id of ['meta', 'openai']) {
      const key = typeof old[id]?.apiKey === 'string' ? old[id].apiKey.trim() : '';
      if (key) found[id] = { apiKey: key, enabled: true, functions: ['photos'], seen: [...FUNCTION_IDS] };
    }
    if (!Object.keys(found).length) return;
    this.imported = true;
    // never over a key already saved (in Supabase too: this is re-applied there by loadRemote)
    const change = (st) => {
      for (const [id, v] of Object.entries(found)) if (!st.providers[id]?.apiKey) st.providers[id] = { ...v };
    };
    change(this.state);
    this.saveLocal();
    if (this.remote.enabled) this.unsynced.push(change);
  }

  saveLocal() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (e) {
      // a read-only disk is fine when Supabase keeps the settings
      if (!this.remote.enabled) throw e;
      console.warn(`AI settings: couldn’t write ${this.file} (${e.message}).`);
    }
  }

  /** The Secret (env var) holding this provider's key, if one is set. */
  envKey(id) {
    for (const name of PROVIDERS[id]?.envKeys ?? []) {
      const v = this.env[name];
      if (typeof v === 'string' && v.trim()) return { name, key: v.trim() };
    }
    return null;
  }

  key(id) {
    return this.envKey(id)?.key || this.state.providers[id]?.apiKey || '';
  }

  keySource(id) {
    if (this.envKey(id)) return 'secrets';
    return this.state.providers[id]?.apiKey ? 'app' : '';
  }

  /** Saved model for a kind, or the provider's default. */
  modelFor(id, kind, saved = this.state.providers[id] || {}) {
    const k = kindDef(id, kind);
    if (!k) return '';
    const v = saved.models?.[kind];
    return typeof v === 'string' && MODEL_RE.test(v) ? v : k.defaultModel;
  }

  /** Effective settings with defaults filled in: a new key powers everything it supports. */
  settings(id) {
    const saved = this.state.providers[id] || {};
    const supported = supportedFunctions(id);
    const functions = Array.isArray(saved.functions) ? supported.filter((f) => saved.functions.includes(f) || isNewFor(saved, f)) : supported;
    const models = {};
    const effort = {};
    for (const kind of Object.keys(PROVIDERS[id].kinds)) {
      models[kind] = this.modelFor(id, kind, saved);
      const want = saved.effort?.[kind];
      effort[kind] = effortIds(id, kind, models[kind]).includes(want) ? want : defaultEffort(id, kind, models[kind]);
    }
    return { enabled: saved.enabled !== false, functions, models, effort };
  }

  /** Priority order. Slots added since the order was saved go right after their provider's last slot. */
  order() {
    const out = [...new Set(this.state.order.filter((id) => PROVIDERS[id]))];
    for (const id of PROVIDER_IDS) {
      if (out.includes(id)) continue;
      const last = out.reduce((at, x, i) => (adapterId(x) === adapterId(id) ? i : at), -1);
      if (last < 0) out.push(id);
      else out.splice(last + 1, 0, id);
    }
    return out;
  }

  /** Switched on and has a key. */
  ready(id) {
    return !!PROVIDERS[id] && this.settings(id).enabled && !!this.key(id);
  }

  powers(id, fn) {
    return this.ready(id) && this.settings(id).functions.includes(fn);
  }

  /** The keys that power a function, in priority order. */
  route(fn) {
    return this.order().filter((id) => this.powers(id, fn));
  }

  routing() {
    return Object.fromEntries(FUNCTION_IDS.map((fn) => [fn, this.route(fn)]));
  }

  /** Everything the Settings page shows. Keys appear only masked. */
  list() {
    return {
      order: this.order(),
      limits: this.limits(),
      providers: this.order().map((id) => {
        const env = this.envKey(id);
        return {
          id,
          configured: !!this.key(id),
          source: this.keySource(id),
          envKey: env?.name ?? '',
          keyHint: maskKey(this.key(id)),
          ready: this.ready(id),
          ...this.settings(id),
        };
      }),
      routing: this.routing(),
    };
  }

  /** The provider's saved entry with a change applied (throws on an invalid change). */
  patched(prev, id, patch) {
    const cur = structuredClone(prev || {});
    if (patch.removeKey === true) delete cur.apiKey;
    if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) {
      const k = patch.apiKey.trim();
      if (k.length > 512 || /\s/.test(k)) throw fail(400, 'That doesn’t look like an API key.');
      cur.apiKey = k;
    }
    if (typeof patch.enabled === 'boolean') cur.enabled = patch.enabled;
    if (Array.isArray(patch.functions)) {
      cur.functions = [...new Set(patch.functions.filter((f) => typeof f === 'string' && supports(id, f).ok))];
      cur.seen = [...FUNCTION_IDS];
    }
    if (patch.models && typeof patch.models === 'object') {
      cur.models = { ...(cur.models || {}) };
      for (const [kind, model] of Object.entries(patch.models)) {
        if (!kindDef(id, kind)) continue;
        if (model === '' || model === null) delete cur.models[kind];
        else if (typeof model === 'string' && MODEL_RE.test(model.trim())) cur.models[kind] = model.trim();
        else throw fail(400, 'That isn’t a valid model name.');
      }
    }
    if (patch.effort && typeof patch.effort === 'object') {
      cur.effort = { ...(cur.effort || {}) };
      for (const [kind, value] of Object.entries(patch.effort)) {
        if (!kindDef(id, kind)) continue;
        const allowed = effortIds(id, kind, this.modelFor(id, kind, cur));
        if (!allowed.includes(value)) throw fail(400, `“${value}” isn’t an effort this model accepts.`);
        cur.effort[kind] = value;
      }
    }
    return cur;
  }

  update(id, patch = {}) {
    if (!PROVIDERS[id]) throw fail(404, 'Unknown provider');
    this.patched(this.state.providers[id], id, patch); // check it first: an invalid change throws here
    this.mutate((st) => {
      st.providers[id] = this.patched(st.providers[id], id, patch);
    });
  }

  /** Daily limits for signed-in non-admin users on these keys (0 = no limit). */
  limits() {
    return cleanLimits(this.state.limits);
  }

  /** Change the daily limits: { requestsPerDay?, usdPerDay? } (non-negative numbers; 0 = no limit). */
  setLimits(patch) {
    if (!patch || typeof patch !== 'object') throw fail(400, 'Send the daily limits.');
    const next = {};
    for (const k of Object.keys(DEFAULT_LIMITS)) {
      if (patch[k] === undefined) continue;
      const v = Number(patch[k]);
      if (patch[k] === null || patch[k] === '' || !Number.isFinite(v) || v < 0) throw fail(400, k === 'requestsPerDay' ? 'Requests per day must be 0 (no limit) or more.' : 'Dollars per day must be 0 (no limit) or more.');
      if (v > MAX_LIMITS[k]) throw fail(400, k === 'requestsPerDay' ? `Requests per day can be at most ${MAX_LIMITS[k]}.` : `Dollars per day can be at most ${MAX_LIMITS[k]}.`);
      next[k] = v;
    }
    if (!Object.keys(next).length) throw fail(400, 'Send requestsPerDay or usdPerDay.');
    this.mutate((st) => {
      st.limits = cleanLimits({ ...cleanLimits(st.limits), ...next });
    });
  }

  setOrder(order) {
    if (!Array.isArray(order)) throw fail(400, 'Send the providers in priority order.');
    const ids = order.filter((id) => typeof id === 'string' && PROVIDERS[id]);
    this.mutate((st) => {
      st.order = [...new Set([...ids, ...PROVIDER_IDS])];
    });
  }

  // ───────────── the owner's Slack connection (Viktor) ─────────────
  //   SlackConn = { token?, verified?: { teamId, team, url, userId, user, scopes: string[], last4, checkedAt },
  //                 viktor?: { userId, botId?, appId?, name }, where?: { kind: 'dm', channelId } | { kind: 'channel', channelId, name, private },
  //                 problem?: { code: 'bad_token' | 'missing_scopes', at, needed?: string[] } }
  // The token acts as the owner in Slack: it never leaves the server (slackPublic() is all the browser sees).

  /** The Slack user token: the Secret, else the one saved here ('' for none). */
  slackToken() {
    const env = this.env[SLACK_ENV];
    return (typeof env === 'string' && env.trim()) || this.state.connections?.slack?.token || '';
  }

  /** Where the token comes from: 'secrets', 'app' or ''. */
  slackSource() {
    const env = this.env[SLACK_ENV];
    if (typeof env === 'string' && env.trim()) return 'secrets';
    return this.state.connections?.slack?.token ? 'app' : '';
  }

  /** A copy of the saved connection without the token. */
  slack() {
    const { token: _token, ...rest } = structuredClone(this.state.connections?.slack ?? {});
    return rest;
  }

  /** Change the saved connection: a field set to null (or undefined) is removed. Same conflict handling as the keys. */
  setSlack(patch) {
    const change = (st) => {
      const cur = { ...(st.connections?.slack ?? {}) };
      for (const k of SLACK_FIELDS) {
        if (!(k in patch)) continue;
        if (patch[k] === null || patch[k] === undefined) delete cur[k];
        else cur[k] = structuredClone(patch[k]);
      }
      const connections = { ...(st.connections ?? {}) };
      if (Object.keys(cur).length) connections.slack = cur;
      else delete connections.slack;
      if (Object.keys(connections).length) st.connections = connections;
      else delete st.connections;
    };
    this.mutate(change);
  }

  /** Whether Viktor can be used, from what's saved (no Slack call): ok | no_token | bad_token | missing_scopes | no_viktor | no_place. */
  slackReadiness() {
    const s = this.state.connections?.slack ?? {};
    const token = this.slackToken();
    const where = s.where?.kind === 'dm' || s.where?.kind === 'channel' ? s.where.kind : '';
    const place = s.where?.kind === 'channel' && s.where.name ? `#${s.where.name}` : '';
    const out = (reason) => ({ ready: reason === 'ok', reason, where, place });
    if (!token) return out('no_token');
    if (s.problem?.code === 'bad_token') return out('bad_token');
    // scopes are known once the token was checked with auth.test (Settings re-checks it every 10 minutes)
    const scopes = s.verified && s.verified.last4 === token.slice(-4) ? s.verified.scopes : null;
    if (s.problem?.code === 'missing_scopes' || (scopes && missingFor(scopes, where || 'dm', !!s.where?.private).length)) return out('missing_scopes');
    if (!s.viktor?.userId) return out('no_viktor');
    if (!where || !s.where.channelId) return out('no_place');
    return out('ok');
  }

  /** The only shape of the Slack connection the browser sees: never the token, only its last 4 characters. */
  slackPublic() {
    const s = this.state.connections?.slack ?? {};
    const token = this.slackToken();
    const v = s.verified ?? null;
    const scopes = Array.isArray(v?.scopes) ? v.scopes : [];
    const r = this.slackReadiness();
    return {
      configured: !!token,
      source: this.slackSource(),
      envKey: SLACK_ENV,
      tokenHint: maskKey(token),
      team: v?.team ?? '',
      teamId: v?.teamId ?? '',
      user: v?.user ?? '',
      userId: v?.userId ?? '',
      url: v?.url ?? '',
      scopes,
      missingScopes: v ? missingFor(scopes, r.where || 'dm', !!s.where?.private) : [],
      channelScopes: hasChannelScopes(scopes),
      viktor: s.viktor ? { userId: s.viktor.userId, botId: s.viktor.botId ?? '', name: s.viktor.name ?? '' } : null,
      where: s.where ? { kind: s.where.kind, channelId: s.where.channelId, ...(s.where.kind === 'channel' ? { name: s.where.name ?? '', private: !!s.where.private } : {}) } : null,
      problem: s.problem ? { code: s.problem.code, ...(Array.isArray(s.problem.needed) ? { needed: s.problem.needed } : {}) } : null,
      ready: r.ready,
      reason: r.reason,
      checkedAt: v?.checkedAt ?? 0,
    };
  }
}
