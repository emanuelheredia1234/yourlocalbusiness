// Shared in-memory stand-ins for the integration tests: appState's storage contract (makeStorage), the
// integration db (makeDb, server/integrations/db.mjs's shape) and a logger that keeps every line (makeLog).
// Test values only.

export const conflict = () => Object.assign(new Error('Conflict'), { code: 'CONFLICT' });

export function makeStorage({ latencyMs = 0 } = {}) {
  const documents = new Map();
  const calls = [];
  const fail = { get: null, put: null };
  let version = 0;
  const pause = () => (latencyMs ? new Promise((resolve) => setTimeout(resolve, latencyMs)) : Promise.resolve());
  const failure = (which, key) => {
    const code = typeof fail[which] === 'function' ? fail[which](key) : fail[which];
    if (code) throw Object.assign(new Error(`storage ${which} failed`), { code });
  };
  return {
    enabled: true,
    documents,
    calls,
    fail,
    async get(key) {
      calls.push({ op: 'get', key });
      await pause();
      failure('get', key);
      const row = documents.get(key);
      return row ? structuredClone(row) : null;
    },
    async put(key, value, options = {}) {
      calls.push({ op: 'put', key, ifVersion: options.ifVersion });
      await pause();
      failure('put', key);
      const current = documents.get(key);
      if (options.ifVersion !== undefined && (current?.updatedAt ?? null) !== options.ifVersion) throw conflict();
      version += 1;
      const updatedAt = `v${version}`;
      documents.set(key, { value: structuredClone(value), updatedAt });
      return updatedAt;
    },
    puts: (key) => calls.filter((c) => c.op === 'put' && (!key || c.key === key)).length,
  };
}

function matches(row, filters) {
  return Object.entries(filters).every(([col, f]) => {
    const [op, v] = Array.isArray(f) ? f : [f === null ? 'is' : 'eq', f];
    const x = row[col];
    switch (op) {
      case 'eq':
        return String(x) === String(v);
      case 'neq':
        return String(x) !== String(v);
      case 'gt':
        return x > v;
      case 'gte':
        return x >= v;
      case 'lt':
        return x < v;
      case 'lte':
        return x <= v;
      case 'is':
        return x === v || (v === null && x == null);
      case 'in':
        return v.map(String).includes(String(x));
      default:
        return false;
    }
  });
}

const KEYS = { billing_customers: ['customer_tag'], webhook_deliveries: ['body_hash'] };

export function makeDb() {
  const tables = new Map();
  const calls = [];
  const fail = {};
  let id = 0;
  const rows = (t) => {
    if (!tables.has(t)) tables.set(t, []);
    return tables.get(t);
  };
  const check = (op, table) => {
    calls.push({ op, table });
    const f = typeof fail[table] === 'function' ? fail[table](op) : fail[table];
    if (f) throw Object.assign(new Error('db failed'), { code: 'UNAVAILABLE', status: 503 });
  };
  const sameKey = (table, a, b) => (KEYS[table] ?? ['id']).every((k) => a[k] !== undefined && String(a[k]) === String(b[k]));
  return {
    enabled: true,
    tables,
    calls,
    fail,
    rows,
    async select(table, filters = {}, { limit, offset = 0 } = {}) {
      check('select', table);
      const out = rows(table).filter((r) => matches(r, filters));
      return structuredClone(out.slice(offset, limit != null ? offset + limit : undefined));
    },
    async insert(table, input, { ignoreDuplicates = false } = {}) {
      check('insert', table);
      for (const r of [].concat(input)) {
        const row = { ...r };
        if (table === 'usage_ledger') row.id = ++id;
        if (row.created_at === undefined && table === 'usage_ledger') row.created_at = new Date().toISOString();
        if (rows(table).some((x) => sameKey(table, x, row))) {
          if (ignoreDuplicates) continue;
          throw Object.assign(new Error('dup'), { code: 'CONFLICT', status: 409 });
        }
        rows(table).push(row);
      }
      return [];
    },
    async upsert(table, input) {
      check('upsert', table);
      for (const r of [].concat(input)) {
        const list = rows(table);
        const i = list.findIndex((x) => sameKey(table, x, r));
        if (i >= 0) list[i] = { ...list[i], ...r };
        else list.push({ ...r });
      }
      return [];
    },
    async update(table, filters, patch) {
      check('update', table);
      for (const r of rows(table)) if (matches(r, filters)) Object.assign(r, patch);
      return [];
    },
    async remove(table, filters) {
      check('remove', table);
      tables.set(
        table,
        rows(table).filter((r) => !matches(r, filters)),
      );
      return [];
    },
    async rpc() {
      return [];
    },
  };
}

/** A logger that keeps every line (safeLog writes JSON lines with logger.log). */
export function makeLog() {
  const lines = [];
  return {
    lines,
    log: (line) => lines.push(String(line)),
    warn: (line) => lines.push(String(line)),
    error: (line) => lines.push(String(line)),
    events: (name) => lines.map((l) => JSON.parse(l)).filter((e) => e.event === name),
    text: () => lines.join('\n'),
  };
}

