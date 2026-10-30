// Per-key AI settings, kept on the server in DATA_DIR/ai-providers.json:
//   { providers: { [id]: { apiKey?, enabled?, functions?, effort?: {kind: value}, models?: {kind: id} } }, order: [id] }
// Keys from Replit Secrets / env vars take precedence over keys typed into the app, and no key
// is ever sent back to the browser (only its last 4 characters).

import fs from 'node:fs';
import path from 'node:path';
import { FUNCTION_IDS, PROVIDERS, PROVIDER_IDS, defaultEffort, effortIds, kindDef, supportedFunctions, supports } from './registry.mjs';

export function maskKey(key) {
  if (!key) return '';
  return `••••${String(key).slice(-4)}`;
}

const MODEL_RE = /^[A-Za-z0-9][\w.:/@+-]{0,127}$/;

const fail = (status, message) => Object.assign(new Error(message), { status });

export class AIStore {
  /**
   * @param {string} file  where settings are saved
   * @param {object} o     env: where Secrets are read; legacyFile: the old image-providers.json to import once
   */
  constructor(file, { env = process.env, legacyFile = '' } = {}) {
    this.file = file;
    this.env = env;
    this.state = { providers: {}, order: [...PROVIDER_IDS] };
    this.imported = false;
    let loaded = false;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw && typeof raw === 'object') {
        this.state = {
          providers: raw.providers && typeof raw.providers === 'object' ? raw.providers : {},
          order: Array.isArray(raw.order) ? raw.order : [...PROVIDER_IDS],
        };
        loaded = true;
      }
    } catch {
      /* first run */
    }
    if (!loaded && legacyFile) this.importLegacy(legacyFile);
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
    for (const id of ['meta', 'openai']) {
      const key = typeof old[id]?.apiKey === 'string' ? old[id].apiKey.trim() : '';
      if (key) {
        this.state.providers[id] = { apiKey: key, enabled: true, functions: ['photos'] };
        this.imported = true;
      }
    }
    if (this.imported) this.save();
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
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
    const functions = Array.isArray(saved.functions) ? supported.filter((f) => saved.functions.includes(f)) : supported;
    const models = {};
    const effort = {};
    for (const kind of Object.keys(PROVIDERS[id].kinds)) {
      models[kind] = this.modelFor(id, kind, saved);
      const want = saved.effort?.[kind];
      effort[kind] = effortIds(id, kind, models[kind]).includes(want) ? want : defaultEffort(id, kind, models[kind]);
    }
    return { enabled: saved.enabled !== false, functions, models, effort };
  }

  order() {
    const known = this.state.order.filter((id) => PROVIDERS[id]);
    return [...new Set([...known, ...PROVIDER_IDS])];
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

  update(id, patch = {}) {
    if (!PROVIDERS[id]) throw fail(404, 'Unknown provider');
    const cur = structuredClone(this.state.providers[id] || {});
    if (patch.removeKey === true) delete cur.apiKey;
    if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) {
      const k = patch.apiKey.trim();
      if (k.length > 512 || /\s/.test(k)) throw fail(400, 'That doesn’t look like an API key.');
      cur.apiKey = k;
    }
    if (typeof patch.enabled === 'boolean') cur.enabled = patch.enabled;
    if (Array.isArray(patch.functions)) cur.functions = [...new Set(patch.functions.filter((f) => typeof f === 'string' && supports(id, f).ok))];
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
    this.state.providers[id] = cur;
    this.save();
  }

  setOrder(order) {
    if (!Array.isArray(order)) throw fail(400, 'Send the providers in priority order.');
    const ids = order.filter((id) => typeof id === 'string' && PROVIDERS[id]);
    this.state.order = [...new Set([...ids, ...PROVIDER_IDS])];
    this.save();
  }
}
