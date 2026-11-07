// A stand-in for a Supabase project, for tests and offline QA: Auth (email + password, email
// confirmation and password recovery with PKCE links, ES256 tokens and a JWKS), a PostgREST subset
// with per-user row security, and a Storage subset with per-user folders. The browser app can use
// it through supabase-js exactly as it would a real project.
//
//   node server/test/mock-supabase.mjs [port]   → prints { url, publishableKey, secretKey }

import crypto from 'node:crypto';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { mergeSale } from '../offers/sales.mjs';

const PUBLISHABLE = 'sb_publishable_mock_123';
const SECRET = 'sb_secret_mock_456';

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Primary keys per table: rows with the same values are one row (upserts replace them). */
const PRIMARY_KEYS = {
  user_docs: ['user_id', 'kind', 'id'],
  user_secrets: ['user_id', 'provider'],
  app_state: ['key'],
  market_listings: ['user_id', 'id'],
  ai_usage_daily: ['user_id', 'day'],
  published_pages: ['slug'],
  published_domains: ['domain'],
  page_leads: ['id'],
  // supabase/migrations/20261105000000_integrations.sql
  billing_customers: ['customer_tag'],
  billing_caps: ['customer_tag'],
  usage_ledger: ['id'],
  analytics_settings: ['user_id', 'project_id'],
  analytics_snapshots: ['user_id', 'project_id', 'source'],
  analytics_runs: ['id'],
  post_publish_jobs: ['id'],
  analytics_history: ['id'],
  webhook_deliveries: ['body_hash'],
  seo_google_steps: ['user_id', 'page_id', 'step'],
  // supabase/migrations/20261108000000_ads_launch.sql
  ad_account_choices: ['user_id', 'project_id', 'platform'],
  ad_campaigns: ['id'],
  ad_jobs: ['id'],
  ad_audit: ['id'],
  ad_limits: ['customer_tag'],
  // supabase/migrations/20261110000000_billing.sql
  billing_settings: ['id'],
  billing_accounts: ['user_id'],
  billing_ops: ['id'],
  project_slots: ['user_id', 'project_id'],
  // supabase/migrations/20261111000000_video_week.sql
  video_starts: ['id'],
  // supabase/migrations/20261112000000_leads_p2.sql
  lead_files: ['id'],
  // supabase/migrations/20261113000000_offers.sql
  payment_connections: ['id'],
  offers: ['id'],
  sales: ['id'],
  sale_refunds: ['provider', 'environment', 'refund_id'],
  // supabase/migrations/20261114000000_trial_paywall.sql
  billing_trials: ['subscription_id'],
  cancel_surveys: ['id'],
  // supabase/migrations/20261116000000_morning_action.sql
  business_settings: ['user_id', 'project_id'],
  daily_actions: ['id'],
};
/** the integration tables (all server-only) */
const INTEGRATION_TABLES = ['billing_customers', 'billing_caps', 'usage_ledger', 'analytics_settings', 'analytics_snapshots', 'analytics_runs', 'post_publish_jobs', 'analytics_history', 'webhook_deliveries', 'seo_google_steps', 'ad_account_choices', 'ad_campaigns', 'ad_jobs', 'ad_audit', 'ad_limits', 'billing_settings', 'billing_accounts', 'billing_ops', 'payment_connections', 'offers', 'sales', 'sale_refunds', 'billing_trials', 'cancel_surveys'];
/** tables users may read their own rows of but never write (only the server and the database functions do) */
const USER_READ_ONLY = new Set(['project_slots', 'business_settings', 'daily_actions']);
/** `generated always as identity` columns: the mock numbers them 1, 2, 3… per table */
const IDENTITY = { usage_ledger: 'id', analytics_history: 'id', ad_audit: 'id' };
/**
 * Other unique keys Postgres enforces besides the primary key: [columns, only rows where…]. A write that would
 * give two rows the same values is refused with 23505, as PostgREST answers (409).
 */
const UNIQUE = {
  billing_customers: [{ name: 'billing_customers_user_id_key', cols: ['user_id'] }],
  post_publish_jobs: [
    { name: 'post_publish_jobs_user_id_client_request_id_key', cols: ['user_id', 'client_request_id'] },
    { name: 'post_publish_jobs_one_live', cols: ['user_id', 'post_id', 'platform'], where: (r) => ['queued', 'sending', 'sent', 'unknown'].includes(r.state) },
  ],
  analytics_runs: [{ name: 'analytics_runs_one_running', cols: ['user_id', 'project_id'], where: (r) => r.state === 'running' }],
  ad_campaigns: [{ name: 'ad_campaigns_one_live', cols: ['user_id', 'plan_id', 'platform'], where: (r) => !['ended', 'failed'].includes(r.state) }],
  ad_jobs: [
    { name: 'ad_jobs_user_client_request', cols: ['user_id', 'client_request_id'] },
    { name: 'ad_jobs_one_live', cols: ['campaign_id'], where: (r) => ['queued', 'sending', 'unknown'].includes(r.state) },
    { name: 'ad_jobs_review_once', cols: ['user_id', 'review_nonce'], where: (r) => r.review_nonce != null },
  ],
  billing_accounts: [
    { name: 'billing_accounts_customer_tag_key', cols: ['customer_tag'] },
    { name: 'billing_accounts_stripe_customer_id_key', cols: ['stripe_customer_id'] },
    { name: 'billing_accounts_stripe_subscription_id_key', cols: ['stripe_subscription_id'] },
  ],
  billing_ops: [
    { name: 'billing_ops_user_id_client_request_id_key', cols: ['user_id', 'client_request_id'] },
    { name: 'billing_ops_one_live', cols: ['user_id'], where: (r) => ['sending', 'unknown'].includes(r.state) },
  ],
  payment_connections: [{ name: 'payment_connections_one_live', cols: ['user_id', 'provider', 'environment'], where: (r) => r.status !== 'disconnected' }],
  sales: [{ name: 'sales_one_per_payment', cols: ['provider', 'environment', 'provider_payment_id'] }],
  cancel_surveys: [{ name: 'cancel_surveys_portal_once', cols: ['subscription_id'], where: (r) => r.source === 'portal' }],
  daily_actions: [{ name: 'daily_actions_one_per_day', cols: ['user_id', 'project_id', 'local_date'] }],
};
/** Column defaults Postgres fills on insert (only for a new row: an upsert that matches keeps the stored values). */
const INSERT_DEFAULTS = {
  business_settings: () => ({ time_zone: 'UTC', next_action_at: null, last_active_at: new Date().toISOString(), claim_id: null, claimed_until: null, last_outcome: null, last_run_at: null, created_at: new Date().toISOString() }),
  daily_actions: () => ({ id: crypto.randomUUID(), engine: null, candidates: [], chosen: null, feedback: [], fallback: null, error_code: null, cost_usd: 0, own_key: false, provider: null, model: null, attempts: 1, started_at: new Date().toISOString(), generated_at: null, done_at: null, created_at: new Date().toISOString() }),
};
/** tables whose created_at defaults to now() here (the newer ones; older tests compare whole rows) */
const DEFAULT_CREATED = new Set(['payment_connections', 'offers', 'sales']);
/** tables with a user_id column that isn't a foreign key: deleting the user leaves their rows */
const NO_USER_FK = new Set(['usage_ledger']);
/** user_id references auth.users on delete set null: deleting the user keeps the row, without its user */
const USER_SET_NULL = new Set(['billing_trials']);
/** the claim_analytics_run slot: no second run for a business within this long of the last one's start */
const RUN_SLOT_MS = 15 * 60_000;
/** tables every signed-in person may read (writes stay owner-only), like the market_listings policies */
const PUBLIC_READ = new Set(['market_listings']);
/** tables with row-level security and no policies: only the secret key reaches them */
const SERVICE_ONLY = new Set(['user_secrets', 'app_state', 'ai_usage_daily', 'video_starts', 'published_pages', 'published_domains', 'page_leads', 'lead_files', ...INTEGRATION_TABLES]);
const DUPLICATE = { code: '23505', message: 'duplicate key value violates unique constraint' };
/** tables whose user_id references auth.users (a row for a user that's gone is refused, as Postgres does) */
const USER_FK = new Set(['published_pages', 'published_domains', 'billing_customers', 'analytics_settings', 'analytics_snapshots', 'analytics_runs', 'analytics_history', 'post_publish_jobs', 'seo_google_steps', 'ad_account_choices', 'ad_campaigns', 'ad_jobs', 'ad_audit', 'billing_accounts', 'billing_ops', 'project_slots', 'video_starts', 'page_leads', 'lead_files', 'payment_connections', 'offers', 'sales', 'sale_refunds', 'billing_trials', 'cancel_surveys', 'business_settings', 'daily_actions']);
const PROJECT_ID = /^[A-Za-z0-9_-]{1,80}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/;
/**
 * Check constraints Postgres enforces on a whole row (supabase/migrations/20261103050000_page_leads.sql,
 * 20261112000000_leads_p2.sql, 20261103040000_published_pages.sql): the name of the first one a row breaks, or null.
 * Columns the row doesn't have take their defaults, as an insert would.
 */
const CHECKS = {
  page_leads: (r) => {
    const v = { source: 'page', kind: 'form', consent: false, payload: {}, name: '', email: '', phone: '', message: '', time: '', ...r };
    if (!/^(seo|artifact|magnet):[A-Za-z0-9_-]{1,80}$/.test(String(v.page_id))) return 'page_leads_page_id_format';
    if (!(v.slug === '' || SLUG.test(String(v.slug)))) return 'page_leads_slug_format';
    if (v.project_id != null && !PROJECT_ID.test(String(v.project_id))) return 'page_leads_project_id_format';
    if (!['page', 'asset', 'magnet'].includes(v.source)) return 'page_leads_source_check';
    if (!['form', 'lead', 'booking', 'quiz', 'calculator', 'roi', 'checklist', 'magnet'].includes(v.kind)) return 'page_leads_kind_check';
    if (!v.payload || typeof v.payload !== 'object' || Array.isArray(v.payload) || Buffer.byteLength(JSON.stringify(v.payload)) > 8192) return 'page_leads_payload_check';
    if (v.name.length > 120 || v.email.length > 254 || v.phone.length > 40 || v.message.length > 2000 || v.time.length > 120) return 'page_leads_sizes';
    if (!v.email && !v.phone) return 'page_leads_contact';
    return null;
  },
  published_pages: (r) => (r.project_id != null && !PROJECT_ID.test(String(r.project_id)) ? 'published_pages_project_id_format' : null),
  lead_files: (r) => {
    const v = { title: '', file_name: '', bytes: 0, url: '', ...r };
    if (!/^[A-Za-z0-9_-]{22}$/.test(String(v.id))) return 'lead_files_id_format';
    if (!PROJECT_ID.test(String(v.project_id))) return 'lead_files_project_id_format';
    if (v.title.length > 200) return 'lead_files_title_size';
    if (String(v.brand ?? '').length > 120) return 'lead_files_brand_size';
    if (!['file', 'url'].includes(v.kind)) return 'lead_files_kind_check';
    if (v.file_name.length > 120) return 'lead_files_file_name_size';
    if (!(Number(v.bytes) >= 0 && Number(v.bytes) <= 26214400)) return 'lead_files_bytes_range';
    if (v.url.length > 2000 || !(v.url === '' || /^https?:\/\//.test(v.url))) return 'lead_files_url_format';
    if (!((v.kind === 'url' && v.url !== '') || v.kind === 'file')) return 'lead_files_url_needed';
    return null;
  },
};
Object.assign(CHECKS, {
  payment_connections: (r) => {
    const v = { kind: 'account_key', account_name: '', webhook_mode: 'none', webhook_state: 'missing', status: 'active', ...r };
    if (!/^[A-Za-z0-9_-]{22}$/.test(String(v.id))) return 'payment_connections_id_format';
    if (!['whop', 'stripe'].includes(v.provider)) return 'payment_connections_provider_check';
    if (!['account_key', 'app_install'].includes(v.kind)) return 'payment_connections_kind_check';
    if (!['sandbox', 'production'].includes(v.environment)) return 'payment_connections_environment_check';
    if (!/^biz_[A-Za-z0-9]{4,64}$/.test(String(v.account_id))) return 'payment_connections_account_format';
    if (typeof v.key_ciphertext !== 'string') return 'payment_connections_key_ciphertext_not_null';
    if (String(v.key_last4 ?? '').length > 4) return 'payment_connections_last4_size';
    if (!['none', 'auto', 'manual'].includes(v.webhook_mode)) return 'payment_connections_webhook_mode_check';
    if (!['missing', 'ok', 'unknown', 'disabled'].includes(v.webhook_state)) return 'payment_connections_webhook_state_check';
    if (!['active', 'key_rejected', 'disconnected'].includes(v.status)) return 'payment_connections_status_check';
    return null;
  },
  offers: (r) => {
    const v = { price_display: '', provider_ref: {}, delivery: { kind: 'provider' }, status: 'active', ...r };
    if (!/^[A-Za-z0-9_-]{22}$/.test(String(v.id))) return 'offers_id_format';
    if (!PROJECT_ID.test(String(v.project_id))) return 'offers_project_id_format';
    if (typeof v.title !== 'string' || v.title.length > 200) return 'offers_title_size';
    if (String(v.price_display).length > 40) return 'offers_price_display_size';
    if (v.currency != null && !/^[a-z]{3}$/.test(String(v.currency))) return 'offers_currency_format';
    if (!['whop', 'external', 'stripe'].includes(v.provider)) return 'offers_provider_check';
    if (!['draft', 'active', 'paused', 'checkout_unknown', 'archived'].includes(v.status)) return 'offers_status_check';
    if (!v.provider_ref || typeof v.provider_ref !== 'object' || Array.isArray(v.provider_ref) || Buffer.byteLength(JSON.stringify(v.provider_ref)) > 4096) return 'offers_provider_ref_check';
    if (v.provider === 'whop' && v.connection_id == null) return 'offers_whop_connection';
    if (v.provider === 'external' && !('url' in v.provider_ref)) return 'offers_external_url';
    return null;
  },
  sales: (r) => {
    if (!PROJECT_ID.test(String(r.project_id))) return 'sales_project_id_format';
    if (!['whop', 'stripe'].includes(r.provider)) return 'sales_provider_check';
    if (!['sandbox', 'production'].includes(r.environment)) return 'sales_environment_check';
    if (!['pending', 'paid', 'failed', 'refunded', 'partially_refunded', 'disputed'].includes(r.status)) return 'sales_status_check';
    if (!/^[a-z]{3}$/.test(String(r.currency))) return 'sales_currency_format';
    if (r.buyer_email != null && String(r.buyer_email).length > 254) return 'sales_buyer_email_size';
    return null;
  },
});
const MORNING_ZONE = /^[A-Za-z][A-Za-z0-9_+/-]{0,63}$/;
Object.assign(CHECKS, {
  business_settings: (r) => {
    if (!PROJECT_ID.test(String(r.project_id))) return 'business_settings_project_id_check';
    if (!MORNING_ZONE.test(String(r.time_zone ?? 'UTC'))) return 'business_settings_time_zone_check';
    if (r.last_outcome != null && !['ready', 'rules', 'failed', 'exists', 'skipped_plan', 'skipped_slot', 'skipped_late'].includes(r.last_outcome)) return 'business_settings_last_outcome_check';
    return null;
  },
  daily_actions: (r) => {
    const v = { candidates: [], feedback: [], cost_usd: 0, attempts: 1, ...r };
    if (!PROJECT_ID.test(String(v.project_id))) return 'daily_actions_project_id_check';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v.local_date))) return 'daily_actions_local_date_check';
    if (typeof v.time_zone !== 'string' || v.time_zone.length < 1 || v.time_zone.length > 64) return 'daily_actions_time_zone_check';
    if (!['generating', 'ready', 'done', 'dismissed', 'failed'].includes(v.state)) return 'daily_actions_state_check';
    if (!['cron', 'visit', 'manual'].includes(v.source)) return 'daily_actions_source_check';
    if (v.engine != null && !['ai', 'rules'].includes(v.engine)) return 'daily_actions_engine_check';
    if (!Array.isArray(v.candidates) || v.candidates.length > 3 || Buffer.byteLength(JSON.stringify(v.candidates)) > 8192) return 'daily_actions_candidates_check';
    if (v.chosen != null && !(Number.isInteger(v.chosen) && v.chosen >= 0 && v.chosen <= 2)) return 'daily_actions_chosen_check';
    if (!Array.isArray(v.feedback) || v.feedback.length > 3 || Buffer.byteLength(JSON.stringify(v.feedback)) > 2048) return 'daily_actions_feedback_check';
    if (v.fallback != null && !['no_ai', 'own_key', 'credits', 'daily_limit', 'invalid_output', 'refused', 'ai_error', 'fresh'].includes(v.fallback)) return 'daily_actions_fallback_check';
    if (v.error_code != null && String(v.error_code).length > 40) return 'daily_actions_error_code_check';
    if (!(Number(v.cost_usd) >= 0)) return 'daily_actions_cost_usd_check';
    if (!(Number.isInteger(Number(v.attempts)) && v.attempts >= 1 && v.attempts <= 3)) return 'daily_actions_attempts_check';
    if (v.provider != null && String(v.provider).length > 40) return 'daily_actions_provider_check';
    if (v.model != null && String(v.model).length > 128) return 'daily_actions_model_check';
    return null;
  },
});
const checkRefusal = (table, row) => {
  const name = CHECKS[table]?.(row);
  return name ? { code: '23514', details: null, hint: null, message: `new row for relation "${table}" violates check constraint "${name}"` } : null;
};
/**
 * Storage buckets with rules (supabase/migrations/20261112000000_leads_p2.sql): size and the types allowed (no SVG).
 * Any other bucket (media) takes anything, as before.
 */
const BUCKETS = {
  'lead-files': {
    public: false,
    maxBytes: 26214400,
    types: ['application/pdf', 'application/epub+zip', 'application/zip', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'image/png', 'image/jpeg', 'image/webp', 'audio/mpeg', 'video/mp4'],
  },
  'public-files': { public: true, maxBytes: 5242880, types: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] },
};
/** the user_secrets.provider check constraint (supabase/migrations/20261103030000_ai_usage_daily.sql) */
const SECRET_PROVIDERS = new Set(['openai', 'anthropic', 'google', 'xai', 'openrouter', 'meta', 'manus']);

/**
 * domainOwnerCheck: the published_pages_domain_owner foreign key (a page only on a domain its owner has);
 * false is a database where the migration was last run before it was added.
 * projectSlots: emulate the billing migration's rule on user_docs (a project row is written by a signed-in user only
 * while it holds an active project_slots row, once billing_settings.enforce is true) and its two triggers (a new
 * project gets a slot while plans aren't enforced; deleting a project frees its slot). The real policy is checked on a
 * Supabase branch, never claimed from this mock.
 */
export async function createMockSupabase({ confirmEmail = true, tokenTtl = 3600, missingTables = [], missingBuckets = [], secretProviders = SECRET_PROVIDERS, domainOwnerCheck = true, projectSlots = false } = {}) {
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const kid = 'mock-key-1';
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'ES256', use: 'sig' };
  const users = new Map(); // id → user
  const refresh = new Map(); // refresh token → user id
  const codes = new Map(); // auth code → { userId, challenge, method, type }
  const emails = []; // { to, type, link }
  const tables = new Map(); // table → rows[]
  const objects = new Map(); // `${bucket}/${path}` → { bytes, type, created }
  const calls = [];
  // down: every request fails; restDelayMs: the database answers this slowly (auth stays quick);
  // fail(method, pathname, searchParams): { status, body } to answer one request with instead (or nothing)
  // now: the database's clock (now()) for the billing functions, e.g. () => fixed + offset in tests
  const behavior = { down: false, restDelayMs: 0, fail: null, now: null };
  const dbNow = () => (typeof behavior.now === 'function' ? behavior.now() : Date.now());
  let server;
  let base = '';

  const issuer = () => `${base}/auth/v1`;
  const userJson = (u) => ({
    id: u.id,
    aud: 'authenticated',
    role: 'authenticated',
    email: u.email,
    email_confirmed_at: u.confirmed_at,
    confirmation_sent_at: u.confirmation_sent_at ?? null,
    confirmed_at: u.confirmed_at,
    created_at: u.created_at,
    updated_at: u.updated_at,
    app_metadata: { provider: 'email', providers: ['email'], ...(u.app_metadata ?? {}) },
    user_metadata: {},
    identities: [],
    is_anonymous: false,
  });

  async function session(u) {
    const now = Math.floor(Date.now() / 1000);
    const access_token = await new SignJWT({ email: u.email, role: 'authenticated', aal: 'aal1', session_id: crypto.randomUUID(), is_anonymous: false, app_metadata: userJson(u).app_metadata, user_metadata: {} })
      .setProtectedHeader({ alg: 'ES256', kid, typ: 'JWT' })
      .setSubject(u.id)
      .setIssuer(issuer())
      .setAudience('authenticated')
      .setIssuedAt(now)
      .setExpirationTime(now + tokenTtl)
      .sign(privateKey);
    const refresh_token = b64url(crypto.randomBytes(24));
    refresh.set(refresh_token, u.id);
    return { access_token, token_type: 'bearer', expires_in: tokenTtl, expires_at: now + tokenTtl, refresh_token, user: userJson(u) };
  }

  /** Who a request is: { userId } for a valid user token, { service: true } for the secret key, else null. */
  async function caller(req) {
    const key = req.headers.apikey || '';
    const auth = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')?.[1] || '';
    if (key === SECRET && (!auth || auth === SECRET)) return { service: true };
    if (!auth || auth === PUBLISHABLE) return { anon: true };
    try {
      const { jwtVerify } = await import('jose');
      const { payload } = await jwtVerify(auth, publicKey, { issuer: issuer(), audience: 'authenticated' });
      return users.has(payload.sub) ? { userId: payload.sub } : null;
    } catch {
      return null;
    }
  }

  function send(res, status, body, headers = {}) {
    const cors = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'content-range, x-client-info' };
    if (body === undefined) {
      res.writeHead(status, { ...cors, ...headers });
      return res.end();
    }
    if (Buffer.isBuffer(body)) {
      res.writeHead(status, { ...cors, ...headers });
      return res.end(body);
    }
    res.writeHead(status, { 'content-type': 'application/json', ...cors, ...headers });
    res.end(JSON.stringify(body));
  }
  const authError = (res, status, error_code, msg) => send(res, status, { code: status, error_code, msg });

  function mail(to, type, user, redirectTo, challenge, method) {
    const token = b64url(crypto.randomBytes(16));
    codes.set(`verify:${token}`, { userId: user.id, type, redirectTo, challenge, method });
    const link = `${base}/auth/v1/verify?token=${token}&type=${type}&redirect_to=${encodeURIComponent(redirectTo || '')}`;
    emails.push({ to: user.email, type, link, at: Date.now() });
    if (type === 'signup') user.confirmation_sent_at = new Date().toISOString();
  }

  // ───────────── PostgREST subset ─────────────

  function parseFilter(raw) {
    const [op, ...rest] = raw.split('.');
    const value = rest.join('.');
    if (op === 'in') return { op, value: value.replace(/^\(|\)$/g, '').split(',').map((v) => decodeURIComponent(v).replace(/^"|"$/g, '')) };
    return { op, value: decodeURIComponent(value) };
  }

  function matches(row, filters) {
    return filters.every(([col, f]) => {
      const v = row[col];
      if (f.op === 'not') return !matches(row, [[col, parseFilter(f.value)]]);
      if (f.op === 'eq') return String(v) === f.value;
      if (f.op === 'neq') return String(v) !== f.value;
      if (f.op === 'in') return f.value.includes(String(v));
      if (f.op === 'gt') return String(v) > f.value;
      if (f.op === 'gte') return String(v) >= f.value;
      if (f.op === 'is') return f.value === 'null' ? v == null : String(v) === f.value;
      // ISO times compare correctly as text
      if (f.op === 'lt') return String(v) < f.value;
      if (f.op === 'lte') return String(v) <= f.value;
      return true;
    });
  }

  /**
   * What Postgres refuses in published_pages besides its keys (supabase/migrations/20261103040000_published_pages.sql):
   * a second home page on a domain (the published_pages_domain_home index), and a page on a domain its owner
   * doesn't have (the published_pages_domain_owner foreign key). `changed`: the columns the write sets.
   */
  function pageRefusal(row, others, changed) {
    const sets = (c) => !changed || changed.includes(c);
    if ((sets('home') || sets('domain')) && row.home && row.domain != null && others.some((r) => r.home && r.domain === row.domain))
      return { code: '23505', details: `Key (domain)=(${row.domain}) already exists.`, hint: null, message: 'duplicate key value violates unique constraint "published_pages_domain_home"' };
    if (domainOwnerCheck && (sets('domain') || sets('user_id')) && row.domain != null && !(tables.get('published_domains') ?? []).some((d) => d.domain === row.domain && d.user_id === row.user_id))
      return { code: '23503', details: `Key (domain, user_id)=(${row.domain}, ${row.user_id}) is not present in table "published_domains".`, hint: null, message: 'insert or update on table "published_pages" violates foreign key constraint "published_pages_domain_owner"' };
    return null;
  }

  function project(row, select) {
    if (!select || select === '*') return { ...row };
    const out = {};
    for (const c of select.split(',').map((s) => s.trim()).filter(Boolean)) {
      // alias:column->a->>b (a JSON field as text; ->key keeps JSON), as PostgREST reads it
      const j = /^(?:(\w+):)?(\w+)((?:->>?\w+)+)$/.exec(c);
      if (j) {
        const steps = [...j[3].matchAll(/(->>?)(\w+)/g)].map((m) => [m[1], m[2]]);
        let v = row[j[2]];
        for (const [, key] of steps) v = v != null && typeof v === 'object' ? v[key] : undefined;
        const asText = steps[steps.length - 1][0] === '->>';
        out[j[1] ?? steps[steps.length - 1][1]] = v == null ? null : asText ? (typeof v === 'object' ? JSON.stringify(v) : String(v)) : v;
      } else out[c] = row[c];
    }
    return out;
  }

  /** A unique key besides the primary key (UNIQUE) that `row` would share with one of `others`, as Postgres refuses it. */
  function uniqueRefusal(table, row, others) {
    for (const u of UNIQUE[table] ?? []) {
      if (u.where && !u.where(row)) continue;
      const clash = others.find((r) => (!u.where || u.where(r)) && u.cols.every((c) => r[c] != null && String(r[c]) === String(row[c])));
      if (clash) return { code: '23505', details: `Key (${u.cols.join(', ')})=(${u.cols.map((c) => row[c]).join(', ')}) already exists.`, hint: null, message: `duplicate key value violates unique constraint "${u.name}"` };
    }
    return null;
  }
  const identities = new Map(); // table → the last number given

  async function rest(req, res, url, table, raw) {
    // like PostgREST before a migration has created the table
    if (missingTables.includes(table)) return send(res, 404, { code: 'PGRST205', details: null, hint: null, message: `Could not find the table 'public.${table}' in the schema cache` });
    const who = await caller(req);
    if (!who) return send(res, 401, { code: 'PGRST301', message: 'JWT expired or invalid' });
    if (who.anon || (SERVICE_ONLY.has(table) && !who.service)) return send(res, 401, { code: '42501', message: 'permission denied for table ' + table });
    if (USER_READ_ONLY.has(table) && !who.service && req.method !== 'GET' && req.method !== 'HEAD') return send(res, 401, { code: '42501', message: 'permission denied for table ' + table });
    const rows = tables.get(table) ?? [];
    tables.set(table, rows);
    const owned = (r) => who.service || r.user_id === who.userId;
    const visible = (r) => owned(r) || PUBLIC_READ.has(table);
    const filters = [];
    for (const [k, v] of url.searchParams) if (!['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'].includes(k)) filters.push([k, parseFilter(v)]);
    const prefer = String(req.headers.prefer || '');

    if (req.method === 'GET' || req.method === 'HEAD') {
      let out = rows.filter((r) => visible(r) && matches(r, filters));
      const order = url.searchParams.get('order');
      if (order) {
        const keys = order.split(',').map((o) => o.split('.'));
        out = [...out].sort((a, b) => {
          for (const [col, dir] of keys) {
            const c = (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (dir === 'desc' ? -1 : 1);
            if (c) return c;
          }
          return 0;
        });
      }
      let offset = Number(url.searchParams.get('offset') || 0);
      let limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 1000;
      const range = /^(\d+)-(\d+)$/.exec(String(req.headers.range || ''));
      if (range) {
        offset = Number(range[1]);
        limit = Number(range[2]) - offset + 1;
      }
      limit = Math.min(limit, 1000); // PostgREST's usual max-rows
      const total = out.length;
      out = out.slice(offset, offset + limit).map((r) => project(r, url.searchParams.get('select')));
      return send(res, 200, out, { 'content-range': `${offset}-${offset + out.length - 1}/${total}` });
    }

    if (req.method === 'POST') {
      let body;
      try {
        body = JSON.parse(raw || 'null');
      } catch {
        return send(res, 400, { message: 'invalid json' });
      }
      const items = Array.isArray(body) ? body : [body];
      const pk = (url.searchParams.get('on_conflict') || '').split(',').filter(Boolean);
      // like Postgres: a partial unique index can't be inferred by ON CONFLICT (cols) without its WHERE, which PostgREST
      // can't send: naming only such an index's columns is refused (42P10). (Tables whose other unique keys this mock
      // doesn't list keep taking their on_conflict as given.)
      if (pk.length) {
        const same = (cols) => cols.length === pk.length && cols.every((c) => pk.includes(c));
        const full = [PRIMARY_KEYS[table] ?? ['id'], ...(UNIQUE[table] ?? []).filter((u) => !u.where).map((u) => u.cols)];
        const partialOnly = (UNIQUE[table] ?? []).some((u) => u.where && same(u.cols)) && !full.some(same);
        if (partialOnly) return send(res, 400, { code: '42P10', details: null, hint: null, message: 'there is no unique or exclusion constraint matching the ON CONFLICT specification' });
      }
      const keyCols = pk.length ? pk : PRIMARY_KEYS[table] ?? ['id'];
      const upsert = /resolution=merge-duplicates/.test(prefer);
      const skipExisting = /resolution=ignore-duplicates/.test(prefer); // INSERT … ON CONFLICT DO NOTHING
      const primary = PRIMARY_KEYS[table] ?? keyCols;
      const written = [];
      for (const item of items) {
        if (table === 'user_secrets' && !secretProviders.has(item.provider)) return send(res, 400, { code: '23514', message: 'new row for relation "user_secrets" violates check constraint "user_secrets_provider_check"' });
        if (!who.service && item.user_id !== who.userId) return send(res, 403, { code: '42501', message: 'new row violates row-level security policy for table "' + table + '"' });
        if (USER_FK.has(table) && !users.has(item.user_id)) return send(res, 409, { code: '23503', details: `Key (user_id)=(${item.user_id}) is not present in table "users".`, hint: null, message: `insert or update on table "${table}" violates foreign key constraint "${table}_user_id_fkey"` });
        if (projectSlots && table === 'user_docs' && item.kind === 'project') {
          // the before-insert trigger, then the policy's check on the proposed row (an upsert's too)
          slots.onProjectInsert(item.user_id, item.id);
          if (!who.service && !slots.writeOk(item.user_id, item.id)) return send(res, 403, { code: '42501', message: 'new row violates row-level security policy for table "user_docs"' });
        }
        const row = { ...(DEFAULT_CREATED.has(table) && item.created_at == null ? { created_at: new Date().toISOString() } : {}), ...item, updated_at: new Date().toISOString() };
        // `generated always as identity`: Postgres numbers the row itself and refuses a value from the caller
        if (IDENTITY[table]) {
          if (row[IDENTITY[table]] != null) return send(res, 400, { code: '428C9', details: `Column "${IDENTITY[table]}" is an identity column defined as GENERATED ALWAYS.`, hint: 'Use OVERRIDING SYSTEM VALUE to override.', message: `cannot insert a non-DEFAULT value into column "${IDENTITY[table]}"` });
          const n = (identities.get(table) ?? 0) + 1;
          identities.set(table, n);
          row[IDENTITY[table]] = n;
        }
        const i = rows.findIndex((r) => keyCols.every((c) => r[c] === row[c]));
        if (i >= 0 && skipExisting) continue;
        if (i >= 0 && !upsert) return send(res, 409, DUPLICATE);
        const next = i >= 0 ? { ...rows[i], ...row } : INSERT_DEFAULTS[table] ? { ...INSERT_DEFAULTS[table](), ...row } : row;
        // INSERT … ON CONFLICT DO NOTHING also skips a row that clashes with another unique key (daily_actions_one_per_day)
        if (i < 0 && skipExisting && uniqueRefusal(table, next, rows)) continue;
        // the primary key stays unique when an upsert matched on another unique key (a renamed slug)
        if (rows.some((r, j) => j !== i && primary.every((c) => r[c] === next[c]))) return send(res, 409, DUPLICATE);
        const refused = checkRefusal(table, next) ?? (table === 'published_pages' ? pageRefusal(next, rows.filter((_, j) => j !== i), null) : null) ?? uniqueRefusal(table, next, rows.filter((_, j) => j !== i));
        if (refused) return send(res, refused.code === '23514' ? 400 : 409, refused);
        if (i >= 0) rows[i] = next;
        else rows.push(next);
        written.push(next);
      }
      return /return=representation/.test(prefer) ? send(res, 201, written.map((r) => project(r, url.searchParams.get('select')))) : send(res, 201, undefined);
    }

    if (req.method === 'PATCH') {
      const patch = JSON.parse(raw || '{}');
      const hit = rows.filter((r) => owned(r) && matches(r, filters));
      if (projectSlots && table === 'user_docs' && !who.service && hit.some((r) => (patch.kind ?? r.kind) === 'project' && !slots.writeOk(r.user_id, patch.id ?? r.id))) return send(res, 403, { code: '42501', message: 'new row violates row-level security policy for table "user_docs"' });
      // an update that would give a row another row's primary key changes nothing
      const primary = PRIMARY_KEYS[table] ?? ['id'];
      if (primary.some((c) => c in patch)) {
        const keyOf = (r) => JSON.stringify(primary.map((c) => (hit.includes(r) && c in patch ? patch[c] : r[c])));
        if (hit.some((h) => rows.some((r) => r !== h && keyOf(r) === keyOf(h)))) return send(res, 409, DUPLICATE);
      }
      for (const r of hit) {
        const refused = checkRefusal(table, { ...r, ...patch });
        if (refused) return send(res, 400, refused);
      }
      if (table === 'published_pages') {
        const after = rows.map((r) => (hit.includes(r) ? { ...r, ...patch } : r));
        for (let j = 0; j < rows.length; j++) {
          if (!hit.includes(rows[j])) continue;
          const refused = pageRefusal(after[j], after.filter((_, k) => k !== j), Object.keys(patch));
          if (refused) return send(res, 409, refused);
        }
      }
      if (UNIQUE[table]) {
        const after = rows.map((r) => (hit.includes(r) ? { ...r, ...patch } : r));
        for (let j = 0; j < rows.length; j++) {
          if (!hit.includes(rows[j])) continue;
          const refused = uniqueRefusal(table, after[j], after.filter((_, k) => k !== j));
          if (refused) return send(res, 409, refused);
        }
      }
      // a domain changes hands only once its previous owner's pages are off it (published_pages_domain_owner,
      // checked when the change is saved)
      if (table === 'published_domains' && domainOwnerCheck && 'user_id' in patch) {
        const pages = tables.get('published_pages') ?? [];
        const held = hit.find((d) => d.user_id !== patch.user_id && pages.some((p) => p.domain === d.domain && p.user_id === d.user_id));
        if (held) return send(res, 409, { code: '23503', details: `Key (domain, user_id)=(${held.domain}, ${held.user_id}) is still referenced from table "published_pages".`, hint: null, message: 'update or delete on table "published_domains" violates foreign key constraint "published_pages_domain_owner" on table "published_pages"' });
      }
      for (const r of hit) Object.assign(r, patch, { updated_at: new Date().toISOString() });
      return /return=representation/.test(prefer) ? send(res, 200, hit) : send(res, 204, undefined);
    }

    if (req.method === 'DELETE') {
      const keep = [];
      const gone = [];
      for (const r of rows) (owned(r) && matches(r, filters) ? gone : keep).push(r);
      tables.set(table, keep);
      if (projectSlots && table === 'user_docs') for (const d of gone) if (d.kind === 'project') slots.onProjectDelete(d.user_id, d.id);
      // 20261116000000_morning_action.sql: deleting a business deletes its morning rows (always on)
      if (table === 'user_docs') for (const d of gone) if (d.kind === 'project') morningOnProjectDelete(d.user_id, d.id);
      // a removed domain's pages lose it (published_pages.domain: on delete set null)
      if (table === 'published_domains') for (const p of tables.get('published_pages') ?? []) if (gone.some((d) => d.domain === p.domain)) p.domain = null;
      return /return=representation/.test(prefer) ? send(res, 200, gone) : send(res, 204, undefined);
    }
    return send(res, 405, { message: 'method not allowed' });
  }

  /** POST /rest/v1/rpc/<fn>: the database functions the server calls (execute revoked from browsers). */
  async function rpc(req, res, fn, raw) {
    if (fn === 'claim_analytics_run') return claimAnalyticsRun(req, res, raw);
    if (fn === 'ads_begin_launch' || fn === 'ads_begin_change') return adsBegin(req, res, fn, raw);
    if (BILLING_FNS.has(fn)) return billingRpc(req, res, fn, raw);
    if (fn === 'ylb_claim_video_start') return claimVideoStart(req, res, raw);
    if (fn === 'lead_file_downloaded') return leadFileDownloaded(req, res, raw);
    if (fn === 'offer_clicked' || fn === 'record_sale') return offersRpc(req, res, fn, raw);
    if (fn === 'ylb_cancel_survey_totals') return surveyTotals(req, res, fn);
    if (fn === 'ylb_morning_claim' || fn === 'ylb_morning_backlog') return morningRpc(req, res, fn, raw);
    if (fn !== 'ylb_add_ai_usage') return send(res, 404, { code: 'PGRST202', message: `Could not find the function public.${fn} in the schema cache` });
    if (missingTables.includes('ai_usage_daily')) return send(res, 404, { code: 'PGRST202', message: `Could not find the function public.${fn} in the schema cache` });
    const who = await caller(req);
    if (!who?.service) return send(res, 401, { code: '42501', message: `permission denied for function ${fn}` });
    let b;
    try {
      b = JSON.parse(raw || '{}');
    } catch {
      return send(res, 400, { message: 'invalid json' });
    }
    if (!users.has(b.p_user)) return send(res, 409, { code: '23503', message: 'insert or update on table "ai_usage_daily" violates foreign key constraint' });
    const rows = tables.get('ai_usage_daily') ?? [];
    tables.set('ai_usage_daily', rows);
    const r6 = (n) => Math.round(n * 1e6) / 1e6;
    let row = rows.find((r) => r.user_id === b.p_user && r.day === b.p_day);
    if (!row) {
      row = { user_id: b.p_user, day: b.p_day, email: '', requests: 0, usd: 0, own_requests: 0, own_usd: 0 };
      rows.push(row);
    }
    row.requests += Math.max(0, Number(b.p_requests) || 0);
    // like the SQL: a negative p_usd corrects an earlier estimate, the total never goes below 0
    row.usd = Math.max(0, r6(row.usd + (Number(b.p_usd) || 0)));
    row.own_requests += Math.max(0, Number(b.p_own_requests) || 0);
    row.own_usd = r6(row.own_usd + Math.max(0, Number(b.p_own_usd) || 0));
    if (b.p_email) row.email = b.p_email;
    row.updated_at = new Date().toISOString();
    return send(res, 200, { ...row });
  }

  /** public.ylb_cancel_survey_totals (20261114000000_trial_paywall.sql): every answer and trial, counted. Server-only. */
  async function surveyTotals(req, res, fn) {
    if (missingTables.includes('cancel_surveys') || missingTables.includes('billing_trials')) return send(res, 404, { code: 'PGRST202', message: `Could not find the function public.${fn} in the schema cache` });
    const who = await caller(req);
    if (!who?.service) return send(res, 401, { code: '42501', message: `permission denied for function ${fn}` });
    const answers = tables.get('cancel_surveys') ?? [];
    const trials = tables.get('billing_trials') ?? [];
    const byReason = {};
    for (const r of answers) {
      byReason[r.reason] ??= { cancelled: 0, kept: 0 };
      byReason[r.reason][r.outcome === 'cancelled' ? 'cancelled' : 'kept'] += 1;
    }
    const now = dbNow();
    return send(res, 200, {
      answers: answers.length,
      byReason,
      trialing: trials.filter((t) => t.outcome === 'trialing' && Date.parse(t.trial_ends_at) > now).length,
      endedEarly: trials.filter((t) => t.outcome === 'ended_early').length,
      duplicates: trials.filter((t) => ['duplicate', 'ended_early', 'end_failed'].includes(t.outcome)).length,
    });
  }

  /** public.lead_file_downloaded (supabase/migrations/20261112000000_leads_p2.sql): one more download, in one statement. Server-only. */
  async function leadFileDownloaded(req, res, raw) {
    const fn = 'lead_file_downloaded';
    if (missingTables.includes('lead_files')) return send(res, 404, { code: 'PGRST202', message: `Could not find the function public.${fn} in the schema cache` });
    const who = await caller(req);
    if (!who?.service) return send(res, 401, { code: '42501', message: `permission denied for function ${fn}` });
    let b;
    try {
      b = JSON.parse(raw || '{}');
    } catch {
      return send(res, 400, { message: 'invalid json' });
    }
    for (const r of tables.get('lead_files') ?? []) {
      if (r.id !== b.p_id) continue;
      r.downloads = (Number(r.downloads) || 0) + 1;
      r.last_download_at = new Date().toISOString();
    }
    return send(res, 204, undefined);
  }

  /**
   * public.offer_clicked and public.record_sale (supabase/migrations/20261113000000_offers.sql). record_sale applies
   * server/offers/sales.mjs mergeSale, the same rule as the SQL, in one step (no await: like the row lock). Server-only.
   */
  async function offersRpc(req, res, fn, raw) {
    if (missingTables.includes(fn === 'offer_clicked' ? 'offers' : 'sales')) return send(res, 404, { code: 'PGRST202', message: `Could not find the function public.${fn} in the schema cache` });
    const who = await caller(req);
    if (!who?.service) return send(res, 401, { code: '42501', message: `permission denied for function ${fn}` });
    let b;
    try {
      b = JSON.parse(raw || '{}');
    } catch {
      return send(res, 400, { message: 'invalid json' });
    }
    if (fn === 'offer_clicked') {
      for (const r of tables.get('offers') ?? []) {
        if (r.id !== b.p_id) continue;
        r.clicks = (Number(r.clicks) || 0) + 1;
        r.last_click_at = new Date().toISOString();
      }
      return send(res, 204, undefined);
    }
    const p = b.p;
    if (!p || typeof p !== 'object') return send(res, 400, { code: '22P02', message: 'invalid input' });
    if (!users.has(p.user_id)) return send(res, 409, { code: '23503', message: 'insert or update on table "sales" violates foreign key constraint "sales_user_id_fkey"' });
    const rows = tables.get('sales') ?? [];
    tables.set('sales', rows);
    const i = rows.findIndex((r) => r.provider === p.provider && r.environment === p.environment && r.provider_payment_id === p.provider_payment_id);
    const { outcome, row } = mergeSale(i >= 0 ? rows[i] : null, p);
    if (outcome === 'inserted') {
      const refused = checkRefusal('sales', row);
      if (refused) return send(res, 400, refused);
      const at = new Date().toISOString();
      rows.push({ id: crypto.randomUUID(), application_fee_minor: null, ...row, created_at: at, updated_at: at });
    } else if (outcome === 'updated') {
      const refused = checkRefusal('sales', row);
      if (refused) return send(res, 400, refused);
      rows[i] = { ...row, updated_at: new Date().toISOString() };
    }
    return send(res, 200, outcome);
  }

  /**
   * public.ylb_claim_video_start (supabase/migrations/20261111000000_video_week.sql): counts the user's video starts
   * for the week that aren't refunded or own-key, refuses at the business's or the account's limit, else inserts a
   * pending row. One request at a time here, as the advisory lock makes it in Postgres. Server-only.
   */
  async function claimVideoStart(req, res, raw) {
    const fn = 'ylb_claim_video_start';
    if (missingTables.includes('video_starts')) return send(res, 404, { code: 'PGRST202', message: `Could not find the function public.${fn} in the schema cache` });
    const who = await caller(req);
    if (!who?.service) return send(res, 401, { code: '42501', message: `permission denied for function ${fn}` });
    let b;
    try {
      b = JSON.parse(raw || '{}');
    } catch {
      return send(res, 400, { message: 'invalid json' });
    }
    if (!users.has(b.p_user)) return send(res, 409, { code: '23503', message: 'insert or update on table "video_starts" violates foreign key constraint "video_starts_user_id_fkey"' });
    const rows = tables.get('video_starts') ?? [];
    tables.set('video_starts', rows);
    const proj = b.p_project ?? '';
    const own = b.p_own === true;
    const mine = rows.filter((r) => r.user_id === b.p_user && r.week_start === b.p_week && r.state !== 'refunded' && !r.own_key);
    const usedProject = mine.filter((r) => r.project_id === proj).length;
    const limit = b.p_limit ?? null;
    if (!own && limit != null && usedProject >= limit) return send(res, 200, { ok: false, used: usedProject, limit, reason: 'business' });
    if (!own && b.p_user_limit != null && mine.length >= b.p_user_limit) return send(res, 200, { ok: false, used: mine.length, limit: b.p_user_limit, reason: 'account' });
    const id = b.p_id ?? crypto.randomUUID();
    if (rows.some((r) => r.id === id)) return send(res, 200, { ok: true, id, used: usedProject, limit });
    const now = new Date().toISOString();
    rows.push({ id, user_id: b.p_user, project_id: proj, week_start: b.p_week, state: 'pending', own_key: own, job_id: null, created_at: now, updated_at: now });
    return send(res, 200, { ok: true, id, used: usedProject + (own ? 0 : 1), limit });
  }

  /**
   * public.claim_analytics_run (supabase/migrations/20261105000000_integrations.sql): inserts the run only when no
   * run for the business started in the last 15 minutes and none is running (the partial unique index), and
   * returns it as a one-row set, or an empty one. Server-only, like the SQL (execute revoked from browsers).
   */
  async function claimAnalyticsRun(req, res, raw) {
    const fn = 'claim_analytics_run';
    if (missingTables.includes('analytics_runs')) return send(res, 404, { code: 'PGRST202', message: `Could not find the function public.${fn} in the schema cache` });
    const who = await caller(req);
    if (!who?.service) return send(res, 401, { code: '42501', message: `permission denied for function ${fn}` });
    let b;
    try {
      b = JSON.parse(raw || '{}');
    } catch {
      return send(res, 400, { message: 'invalid json' });
    }
    if (!users.has(b.p_user)) return send(res, 409, { code: '23503', message: 'insert or update on table "analytics_runs" violates foreign key constraint "analytics_runs_user_id_fkey"' });
    const rows = tables.get('analytics_runs') ?? [];
    tables.set('analytics_runs', rows);
    const now = Date.now();
    const same = rows.filter((r) => r.user_id === b.p_user && r.project_id === b.p_project);
    if (same.some((r) => Date.parse(r.started_at) > now - RUN_SLOT_MS)) return send(res, 200, []);
    const row = { id: b.p_id, user_id: b.p_user, project_id: b.p_project, state: 'running', sources: b.p_sources ?? {}, started_at: new Date(now).toISOString(), finished_at: null, cost_micro: 0 };
    // on conflict do nothing: the primary key, or a run still marked running (analytics_runs_one_running)
    if (rows.some((r) => r.id === row.id) || uniqueRefusal('analytics_runs', row, rows)) return send(res, 200, []);
    rows.push(row);
    return send(res, 200, [{ ...row }]);
  }

  /**
   * public.ads_begin_launch / ads_begin_change (supabase/migrations/20261108000000_ads_launch.sql; ad_jobs.error_detail
   * from 20261115000000_ad_job_error_detail.sql): one transaction
   * each. The same (user_id, client_request_id) answers the job that is there; otherwise the campaign row (launch),
   * the job and the audit row go in together, or none does (a unique index refuses with 23505 and its name).
   */
  async function adsBegin(req, res, fn, raw) {
    if (missingTables.includes('ad_jobs')) return send(res, 404, { code: 'PGRST202', message: `Could not find the function public.${fn} in the schema cache` });
    const who = await caller(req);
    if (!who?.service) return send(res, 401, { code: '42501', message: `permission denied for function ${fn}` });
    let b;
    try {
      b = JSON.parse(raw || '{}')?.p ?? {};
    } catch {
      return send(res, 400, { message: 'invalid json' });
    }
    const t = (name) => {
      if (!tables.has(name)) tables.set(name, []);
      return tables.get(name);
    };
    const j = b.job ?? {};
    const same = t('ad_jobs').find((r) => r.user_id === j.user_id && r.client_request_id === j.client_request_id);
    if (same) {
      const camp = t('ad_campaigns').find((r) => r.id === same.campaign_id && r.user_id === same.user_id) ?? null;
      return send(res, 200, { existing: true, job: { ...same }, ...(fn === 'ads_begin_launch' ? { campaign: camp && { ...camp } } : {}) });
    }
    if (!users.has(j.user_id)) return send(res, 409, { code: '23503', message: 'insert or update on table "ad_jobs" violates foreign key constraint "ad_jobs_user_id_fkey"' });
    const at = new Date().toISOString();
    let camp = null;
    if (fn === 'ads_begin_launch') {
      const c = b.campaign ?? {};
      camp = { budget_level: 'adset', spend_cap: null, end_at: null, configured_status: null, review: {}, remote: {}, results: null, last_read_at: null, ended_at: null, ...c, created_at: at, updated_at: at };
      if (t('ad_campaigns').some((r) => r.id === camp.id)) return send(res, 409, DUPLICATE);
      const refused = uniqueRefusal('ad_campaigns', camp, t('ad_campaigns'));
      if (refused) return send(res, 409, refused);
    } else if (!t('ad_campaigns').some((r) => r.id === j.campaign_id && r.user_id === j.user_id)) {
      return send(res, 409, { code: '23503', message: 'insert or update on table "ad_jobs" violates foreign key constraint "ad_jobs_campaign_id_fkey"' });
    }
    const job = { actor: 'customer', before: null, provider_ref: {}, error_code: null, error_detail: null, requested_at: at, finished_at: null, checked_at: null, ...j, ...(camp ? { campaign_id: camp.id } : {}), updated_at: at };
    const refusedJob = uniqueRefusal('ad_jobs', job, t('ad_jobs'));
    if (refusedJob) return send(res, 409, refusedJob);
    const n = (identities.get('ad_audit') ?? 0) + 1;
    identities.set('ad_audit', n);
    const a = b.audit ?? {};
    if (camp) t('ad_campaigns').push(camp);
    t('ad_jobs').push(job);
    t('ad_audit').push({ before: null, after: null, project_id: null, ...a, id: n, at, campaign_id: job.campaign_id, job_id: job.id });
    return send(res, 200, { existing: false, job: { ...job }, ...(camp ? { campaign: { ...camp } } : {}) });
  }

  // ───────────── plans: project slots and the billing functions (supabase/migrations/20261110000000_billing.sql) ─────────────
  // Each function body below runs without an await, so two calls never interleave: like the advisory lock per user.

  const slots = (() => {
    const t = (name) => {
      if (!tables.has(name)) tables.set(name, []);
      return tables.get(name);
    };
    const iso = (ms) => new Date(ms).toISOString();
    const enforced = () => t('billing_settings').find((r) => Number(r.id) === 1)?.enforce === true;
    const account = (u) => t('billing_accounts').find((r) => r.user_id === u) ?? null;
    const mine = (u) => t('project_slots').filter((r) => r.user_id === u);
    const active = (u) => mine(u).filter((r) => r.state === 'active');
    const byClaim = (a, b) => (a.claimed_at < b.claimed_at ? -1 : a.claimed_at > b.claimed_at ? 1 : a.project_id < b.project_id ? -1 : a.project_id > b.project_id ? 1 : 0);
    const eligible = (a) => !!a && (a.source === 'owner' || (['active', 'trialing', 'past_due'].includes(a.status) && (a.source !== 'comp' || a.comp_until == null || Date.parse(a.comp_until) > dbNow())));
    const counts = (u) => ({ active: active(u).length, locked: mine(u).filter((r) => r.state === 'locked').length });
    const insert = (u, id) => {
      const row = { user_id: u, project_id: id, state: 'active', claimed_at: iso(dbNow()), lock_at: null, locked_at: null, locked_reason: null };
      t('project_slots').push(row);
      return row;
    };
    const lock = (r, reason) => Object.assign(r, { state: 'locked', locked_at: iso(dbNow()), locked_reason: reason });

    function applySlots(u) {
      for (const r of mine(u)) if (r.lock_at && Date.parse(r.lock_at) <= dbNow()) Object.assign(lock(r, 'removed'), { lock_at: null });
      if (!enforced()) return counts(u);
      const a = account(u);
      if (!a) return counts(u);
      const ok = eligible(a) && a.status !== 'unpaid';
      const lim = a.source === 'owner' ? null : ok ? a.business_limit ?? null : 1;
      const reason = ok ? 'limit' : a.status === 'unpaid' ? 'payment' : 'plan_ended';
      if (lim != null) {
        const on = active(u).sort(byClaim);
        if (!ok) on.slice(1).forEach((r) => lock(r, reason));
        else if (on.length > lim) on.slice(lim).forEach((r) => lock(r, reason));
      }
      if (ok) {
        const room = lim == null ? Infinity : Math.max(0, lim - active(u).length);
        mine(u)
          .filter((r) => r.state === 'locked' && r.locked_reason !== 'removed')
          .sort(byClaim)
          .slice(0, room)
          .forEach((r) => Object.assign(r, { state: 'active', locked_at: null, locked_reason: null }));
      }
      return counts(u);
    }

    return {
      enforced,
      writeOk: (u, id) => !enforced() || mine(u).some((r) => r.project_id === id && r.state === 'active'),
      onProjectInsert(u, id) {
        if (!enforced() && !mine(u).some((r) => r.project_id === id)) insert(u, id);
      },
      onProjectDelete(u, id) {
        tables.set('project_slots', t('project_slots').filter((r) => !(r.user_id === u && r.project_id === id)));
      },
      claim(u, id, { admin = false } = {}) {
        if (typeof id !== 'string' || id.length < 1 || id.length > 80) return { ok: false, reason: 'bad_request' };
        const there = mine(u).find((r) => r.project_id === id);
        if (there) return there.state === 'active' ? { ok: true, state: 'active' } : { ok: false, reason: 'locked', state: 'locked' };
        if (!enforced()) {
          insert(u, id);
          return { ok: true, state: 'active' };
        }
        const a = account(u);
        if (admin || a?.source === 'owner') {
          insert(u, id);
          return { ok: true, state: 'active' };
        }
        if (!eligible(a)) {
          // 20261114000000_trial_paywall.sql: the first business needs no plan (setup makes it before the paywall)
          if (!mine(u).length) {
            insert(u, id);
            return { ok: true, state: 'active', used: 1, limit: 1, starter: true };
          }
          return { ok: false, reason: 'plan_required' };
        }
        const used = active(u).length;
        if (a.business_limit != null && used >= a.business_limit) return { ok: false, reason: 'limit', used, limit: a.business_limit };
        insert(u, id);
        return { ok: true, state: 'active', used: used + 1, limit: a.business_limit ?? null };
      },
      applySlots,
      choose(u, ids) {
        const a = account(u);
        const lim = a?.source === 'owner' ? null : !a || !eligible(a) ? 1 : a.business_limit ?? null;
        const list = [...new Set(Array.isArray(ids) ? ids.map(String) : [])];
        if (!list.length || (lim != null && list.length > lim)) return { ok: false, reason: 'limit', limit: lim };
        if (list.some((id) => !mine(u).some((r) => r.project_id === id))) return { ok: false, reason: 'not_found' };
        for (const r of mine(u)) {
          if (list.includes(r.project_id)) Object.assign(r, { state: 'active', locked_at: null, locked_reason: null, lock_at: null });
          else if (r.state === 'active') lock(r, 'limit');
        }
        return { ok: true, active: list.length };
      },
      apply(u, row, fetchedAt) {
        const list = t('billing_accounts');
        const i = list.findIndex((r) => r.user_id === u);
        let wrote = false;
        if (i < 0) {
          const next = { ...row, user_id: u, stripe_fetched_at: fetchedAt ?? null, created_at: iso(dbNow()), updated_at: iso(dbNow()) };
          const clash = uniqueRefusal('billing_accounts', next, list);
          if (clash) return { error: clash };
          list.push(next);
          wrote = true;
        } else {
          const stored = list[i].stripe_fetched_at;
          if (stored == null || fetchedAt == null || Date.parse(stored) <= Date.parse(fetchedAt)) {
            const next = { ...list[i], ...row, user_id: u, stripe_fetched_at: fetchedAt ?? list[i].stripe_fetched_at, updated_at: iso(dbNow()) };
            const clash = uniqueRefusal('billing_accounts', next, list.filter((_, j) => j !== i));
            if (clash) return { error: clash };
            list[i] = next;
            wrote = true;
          }
        }
        applySlots(u);
        return { wrote };
      },
      startExisting(days, tags) {
        const docs = t('user_docs').filter((d) => d.kind === 'project');
        const n = new Map();
        for (const d of docs) n.set(d.user_id, (n.get(d.user_id) ?? 0) + 1);
        let added = 0;
        for (const [u, count] of n) {
          if (account(u) || !tags?.[u]) continue;
          const until = iso(dbNow() + days * 86_400_000);
          t('billing_accounts').push({ user_id: u, customer_tag: tags[u], source: 'comp', tier: 'grow', interval: null, status: 'trialing', stripe_customer_id: null, stripe_subscription_id: null, tier_item_id: null, business_item_id: null, extra_businesses: 0, comp_extra: Math.max(0, count - 1), business_limit: Math.max(1, count), extra_keep: 0, extra_keep_until: null, tier_keep: null, tier_keep_until: null, current_period_start: null, current_period_end: null, billing_anchor: null, cancel_at_period_end: false, canceled_at: null, ended_at: null, trial_ends_at: until, grace_until: null, comp_until: until, comp_note: 'existing account', checkout_session_id: null, checkout_expires_at: null, stripe_fetched_at: null, created_at: iso(dbNow()), updated_at: iso(dbNow()) });
          added += 1;
        }
        return added;
      },
    };
  })();

  const BILLING_FNS = new Set(['claim_project_slot', 'ylb_apply_slots', 'ylb_choose_active_slots', 'ylb_billing_apply', 'ylb_billing_start_existing']);

  /** The billing migration's functions: claim_project_slot for signed-in users; the rest for the server only. */
  async function billingRpc(req, res, fn, raw) {
    if (missingTables.includes('project_slots') || missingTables.includes('billing_accounts')) return send(res, 404, { code: 'PGRST202', message: `Could not find the function public.${fn} in the schema cache` });
    const who = await caller(req);
    let b;
    try {
      b = JSON.parse(raw || '{}');
    } catch {
      return send(res, 400, { message: 'invalid json' });
    }
    if (fn === 'claim_project_slot') {
      if (!who?.userId) return send(res, 401, { code: '42501', message: who?.service || who?.anon ? `permission denied for function ${fn}` : 'not signed in' });
      const admin = users.get(who.userId)?.app_metadata?.ylb_role === 'admin';
      return send(res, 200, slots.claim(who.userId, b.p_project_id, { admin }));
    }
    if (!who?.service) return send(res, 401, { code: '42501', message: `permission denied for function ${fn}` });
    if (fn === 'ylb_apply_slots') return send(res, 200, slots.applySlots(b.p_user));
    if (fn === 'ylb_choose_active_slots') return send(res, 200, slots.choose(b.p_user, b.p_ids));
    if (fn === 'ylb_billing_start_existing') return send(res, 200, slots.startExisting(Number(b.p_days) || 0, b.p_tags ?? {}));
    if (!users.has(b.p_user)) return send(res, 409, { code: '23503', message: 'insert or update on table "billing_accounts" violates foreign key constraint "billing_accounts_user_id_fkey"' });
    const out = slots.apply(b.p_user, b.p_row ?? {}, b.p_fetched_at ?? null);
    if (out.error) return send(res, 409, out.error);
    return send(res, 200, out.wrote);
  }

  // ───────────── morning action (supabase/migrations/20261116000000_morning_action.sql) ─────────────
  // Each call runs without an await, so two concurrent calls get disjoint rows (the real row lock, `for update skip
  // locked`, is checked on a Supabase branch).

  function morningOnProjectDelete(u, id) {
    for (const t of ['daily_actions', 'business_settings']) if (tables.has(t)) tables.set(t, tables.get(t).filter((r) => !(r.user_id === u && r.project_id === id)));
  }

  /** public.ylb_morning_eligible: saved and onboarded, slot not locked, on a plan (or plans not enforced). */
  function morningEligible(s) {
    const doc = (tables.get('user_docs') ?? []).find((d) => d.user_id === s.user_id && d.kind === 'project' && d.id === s.project_id);
    if (!doc || doc.data?.onboarded !== true) return false;
    if ((tables.get('project_slots') ?? []).some((p) => p.user_id === s.user_id && p.project_id === s.project_id && p.state === 'locked')) return false;
    if (!slots.enforced()) return true;
    const a = (tables.get('billing_accounts') ?? []).find((r) => r.user_id === s.user_id);
    return !!a && (a.source === 'owner' || (['active', 'trialing', 'past_due'].includes(a.status) && (a.source !== 'comp' || a.comp_until == null || Date.parse(a.comp_until) > dbNow())));
  }

  function morningDue(s, at, olderThanMs = 0) {
    return s.next_action_at != null && Date.parse(s.next_action_at) <= at - olderThanMs && Date.parse(s.last_active_at) >= at - 14 * 86_400_000 && (s.claimed_until == null || Date.parse(s.claimed_until) < at) && morningEligible(s);
  }

  async function morningRpc(req, res, fn, raw) {
    if (missingTables.includes('business_settings')) return send(res, 404, { code: 'PGRST202', message: `Could not find the function public.${fn} in the schema cache` });
    const who = await caller(req);
    if (!who?.service) return send(res, 401, { code: '42501', message: `permission denied for function ${fn}` });
    let b;
    try {
      b = JSON.parse(raw || '{}');
    } catch {
      return send(res, 400, { message: 'invalid json' });
    }
    const at = dbNow();
    const rows = tables.get('business_settings') ?? [];
    if (fn === 'ylb_morning_backlog') return send(res, 200, rows.filter((s) => morningDue(s, at, Math.max(0, Number(b.p_older_than_seconds) || 0) * 1000)).length);
    const lim = Math.max(1, Math.min(Number(b.p_limit) || 1, 200));
    const lease = Math.max(60, Math.min(Number(b.p_lease_seconds) || 600, 3600));
    const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
    const picked = rows
      .filter((s) => morningDue(s, at))
      .sort((x, y) => cmp(Date.parse(x.next_action_at), Date.parse(y.next_action_at)) || cmp(x.user_id, y.user_id) || cmp(x.project_id, y.project_id))
      .slice(0, lim);
    const out = [];
    for (const s of picked) {
      s.claim_id = crypto.randomUUID();
      s.claimed_until = new Date(at + lease * 1000).toISOString();
      s.updated_at = new Date().toISOString();
      const doc = (tables.get('user_docs') ?? []).find((d) => d.user_id === s.user_id && d.kind === 'project' && d.id === s.project_id);
      const tz = doc?.data?.timeZone;
      out.push({ user_id: s.user_id, project_id: s.project_id, time_zone: s.time_zone, doc_time_zone: tz == null ? null : String(tz), next_action_at: s.next_action_at, claim_id: s.claim_id });
    }
    return send(res, 200, out);
  }

  // ───────────── Storage subset ─────────────

  const signed = new Map(); // token → { key, until } (createSignedUrl)

  async function storage(req, res, url, rawBuf) {
    const p0 = url.pathname.replace(/^\/storage\/v1/, '');
    // a bucket the migration hasn't made yet: Storage answers 400 with "Bucket not found"
    const bucketOf = /^\/object\/(?:list\/|sign\/|authenticated\/|public\/)?([^/]+)/.exec(p0)?.[1];
    if (bucketOf && missingBuckets.includes(bucketOf)) return send(res, 400, { statusCode: '404', error: 'Bucket not found', message: 'Bucket not found' });
    // a public bucket's file: no key needed
    const pub = /^\/object\/public\/([^/]+)\/(.+)$/.exec(p0);
    if (pub && (req.method === 'GET' || req.method === 'HEAD')) {
      const o = BUCKETS[pub[1]]?.public ? objects.get(`${pub[1]}/${decodeURIComponent(pub[2])}`) : null;
      if (!o) return send(res, 400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
      return send(res, 200, req.method === 'HEAD' ? undefined : o.bytes, { 'content-type': o.type, 'content-length': o.bytes.length });
    }
    // a signed link: no key needed, the token is the permission (like Supabase Storage)
    const sg = /^\/object\/sign\/([^/]+)\/(.+)$/.exec(p0);
    if (sg && req.method === 'GET') {
      const t = signed.get(url.searchParams.get('token') || '');
      const key = `${sg[1]}/${decodeURIComponent(sg[2])}`;
      if (!t || t.key !== key || t.until < Date.now()) return send(res, 400, { statusCode: '400', error: 'InvalidJWT', message: 'invalid signature' });
      const o = objects.get(key);
      if (!o) return send(res, 400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
      return send(res, 200, o.bytes, { 'content-type': o.type, 'content-length': o.bytes.length });
    }
    const who = await caller(req);
    if (!who || who.anon) return send(res, 400, { statusCode: '403', error: 'Unauthorized', message: 'Invalid JWT' });
    const own = (path) => who.service || path.split('/')[0] === who.userId;
    const p = url.pathname.replace(/^\/storage\/v1/, '');
    let m = /^\/object\/list\/([^/]+)$/.exec(p);
    if (m && req.method === 'POST') {
      const { prefix = '', limit = 100, offset = 0 } = JSON.parse(rawBuf.toString() || '{}');
      const dir = prefix.replace(/\/+$/, '');
      const below = [...objects.keys()].filter((k) => k.startsWith(`${m[1]}/${dir}/`) && own(k.slice(m[1].length + 1))).map((k) => k.slice(m[1].length + 1 + dir.length + 1));
      // like Supabase: the files in the folder, and each sub-folder once, as an entry without an id
      const entries = new Map();
      for (const n of below) {
        const [first, ...deeper] = n.split('/');
        if (deeper.length) entries.set(`folder:${first}`, { name: first, id: null, metadata: null });
        else entries.set(`file:${n}`, { name: n, id: n, metadata: { size: objects.get(`${m[1]}/${dir}/${n}`).bytes.length } });
      }
      const list = [...entries.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return send(res, 200, list.slice(offset, offset + limit));
    }
    m = /^\/object\/([^/]+)$/.exec(p);
    if (m && req.method === 'DELETE') {
      const { prefixes = [] } = JSON.parse(rawBuf.toString() || '{}');
      const removed = [];
      for (const path of prefixes) {
        if (!own(path)) continue;
        if (objects.delete(`${m[1]}/${path}`)) removed.push({ name: path });
      }
      return send(res, 200, removed);
    }
    m = /^\/object\/sign\/([^/]+)\/(.+)$/.exec(p);
    if (m && req.method === 'POST') {
      const path = decodeURIComponent(m[2]);
      if (!own(path)) return send(res, 400, { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' });
      if (!objects.has(`${m[1]}/${path}`)) return send(res, 400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
      const { expiresIn = 60 } = JSON.parse(rawBuf.toString() || '{}');
      const token = b64url(crypto.randomBytes(18));
      signed.set(token, { key: `${m[1]}/${path}`, until: Date.now() + Number(expiresIn) * 1000 });
      return send(res, 200, { signedURL: `/object/sign/${m[1]}/${m[2]}?token=${token}` });
    }
    m = /^\/object\/(?:authenticated\/)?([^/]+)\/(.+)$/.exec(p);
    if (m) {
      const [, bucket, path] = m;
      const key = `${bucket}/${decodeURIComponent(path)}`;
      if (!own(decodeURIComponent(path))) return send(res, 400, { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' });
      if (req.method === 'POST' || req.method === 'PUT') {
        if (objects.has(key) && req.headers['x-upsert'] !== 'true' && req.method === 'POST') return send(res, 400, { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' });
        if (rawBuf.length > 50 * 1024 * 1024) return send(res, 413, { statusCode: '413', error: 'Payload too large', message: 'The object exceeded the maximum allowed size' });
        let bytes = rawBuf;
        let type = String(req.headers['content-type'] || 'application/octet-stream');
        // supabase-js sends Blobs and Files as multipart form data: keep the file part
        if (/^multipart\/form-data/i.test(type)) {
          const form = await new Response(rawBuf, { headers: { 'content-type': type } }).formData();
          const file = [...form.values()].find((v) => typeof v !== 'string');
          if (!file) return send(res, 400, { statusCode: '400', error: 'Bad request', message: 'no file in the form' });
          bytes = Buffer.from(await file.arrayBuffer());
          type = file.type || 'application/octet-stream';
        }
        const rules = BUCKETS[bucket];
        if (rules && bytes.length > rules.maxBytes) return send(res, 400, { statusCode: '413', error: 'Payload too large', message: 'The object exceeded the maximum allowed size' });
        if (rules && !rules.types.includes(type.split(';')[0].trim().toLowerCase())) return send(res, 400, { statusCode: '415', error: 'invalid_mime_type', message: `mime type ${type} is not supported` });
        objects.set(key, { bytes, type, created: Date.now() });
        return send(res, 200, { Key: key, Id: crypto.randomUUID() });
      }
      if (req.method === 'GET') {
        const o = objects.get(key);
        if (!o) return send(res, 400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
        return send(res, 200, o.bytes, { 'content-type': o.type, 'content-length': o.bytes.length });
      }
      // does it exist (the server checks media before handing out a link to it): headers only
      if (req.method === 'HEAD') {
        const o = objects.get(key);
        if (!o) return send(res, 404, undefined);
        return send(res, 200, undefined, { 'content-type': o.type, 'content-length': o.bytes.length });
      }
    }
    return send(res, 404, { message: 'mock storage: no route ' + p });
  }

  // ───────────── Auth ─────────────

  async function authRoute(req, res, url, raw) {
    const p = url.pathname.replace(/^\/auth\/v1/, '');
    const body = (() => {
      try {
        return JSON.parse(raw || '{}');
      } catch {
        return {};
      }
    })();

    if (p === '/.well-known/jwks.json') return send(res, 200, { keys: [jwk] });
    if (p === '/settings') return send(res, 200, { external: { email: true }, disable_signup: false, mailer_autoconfirm: !confirmEmail });

    if (p === '/signup' && req.method === 'POST') {
      const email = String(body.email || '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return authError(res, 400, 'validation_failed', 'Unable to validate email address: invalid format');
      if (String(body.password || '').length < 6) return authError(res, 422, 'weak_password', 'Password should be at least 6 characters.');
      const existing = [...users.values()].find((u) => u.email === email);
      if (existing?.confirmed_at) return authError(res, 422, 'user_already_exists', 'User already registered');
      const now = new Date().toISOString();
      const u = existing ?? { id: crypto.randomUUID(), email, created_at: now };
      Object.assign(u, { password: body.password, updated_at: now, confirmed_at: confirmEmail ? null : now });
      users.set(u.id, u);
      if (!confirmEmail) return send(res, 200, await session(u));
      mail(email, 'signup', u, url.searchParams.get('redirect_to') || '', body.code_challenge, body.code_challenge_method);
      return send(res, 200, userJson(u));
    }

    if (p === '/resend' && req.method === 'POST') {
      const u = [...users.values()].find((x) => x.email === String(body.email || '').toLowerCase());
      if (u && !u.confirmed_at) mail(u.email, 'signup', u, url.searchParams.get('redirect_to') || '', body.code_challenge, body.code_challenge_method);
      return send(res, 200, {});
    }

    if (p === '/recover' && req.method === 'POST') {
      const u = [...users.values()].find((x) => x.email === String(body.email || '').toLowerCase());
      if (u) mail(u.email, 'recovery', u, url.searchParams.get('redirect_to') || '', body.code_challenge, body.code_challenge_method);
      return send(res, 200, {});
    }

    if (p === '/verify' && req.method === 'GET') {
      const v = codes.get(`verify:${url.searchParams.get('token')}`);
      if (!v) return send(res, 303, undefined, { location: `${url.searchParams.get('redirect_to') || base}#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired` });
      codes.delete(`verify:${url.searchParams.get('token')}`);
      const u = users.get(v.userId);
      if (v.type === 'signup') u.confirmed_at = u.confirmed_at || new Date().toISOString();
      const target = new URL(v.redirectTo || base);
      if (v.challenge) {
        const code = crypto.randomUUID();
        codes.set(`pkce:${code}`, { userId: u.id, challenge: v.challenge, method: v.method, type: v.type });
        target.searchParams.set('code', code);
        return send(res, 303, undefined, { location: target.toString() });
      }
      const s = await session(u);
      return send(res, 303, undefined, { location: `${target.toString()}#access_token=${s.access_token}&refresh_token=${s.refresh_token}&expires_in=${s.expires_in}&token_type=bearer&type=${v.type}` });
    }

    if (p === '/token' && req.method === 'POST') {
      const grant = url.searchParams.get('grant_type');
      if (grant === 'password') {
        const u = [...users.values()].find((x) => x.email === String(body.email || '').toLowerCase());
        if (!u || u.password !== body.password) return authError(res, 400, 'invalid_credentials', 'Invalid login credentials');
        if (!u.confirmed_at) return authError(res, 400, 'email_not_confirmed', 'Email not confirmed');
        return send(res, 200, await session(u));
      }
      if (grant === 'refresh_token') {
        const id = refresh.get(body.refresh_token);
        if (!id || !users.has(id)) return authError(res, 400, 'refresh_token_not_found', 'Invalid Refresh Token: Refresh Token Not Found');
        refresh.delete(body.refresh_token);
        return send(res, 200, await session(users.get(id)));
      }
      if (grant === 'pkce') {
        const c = codes.get(`pkce:${body.auth_code}`);
        if (!c) return authError(res, 400, 'flow_state_not_found', 'invalid flow state, no valid flow state found');
        const verifier = String(body.code_verifier || '');
        const challenge = c.method === 'plain' ? verifier : b64url(crypto.createHash('sha256').update(verifier).digest());
        if (challenge !== c.challenge) return authError(res, 400, 'bad_code_verifier', 'code challenge does not match previously saved code verifier');
        codes.delete(`pkce:${body.auth_code}`);
        return send(res, 200, await session(users.get(c.userId)));
      }
      return authError(res, 400, 'unsupported_grant_type', 'unsupported grant type');
    }

    if (p === '/user') {
      const who = await caller(req);
      if (!who?.userId) return authError(res, 401, 'bad_jwt', 'invalid JWT');
      const u = users.get(who.userId);
      if (req.method === 'GET') return send(res, 200, userJson(u));
      if (req.method === 'PUT') {
        if (body.password) {
          if (String(body.password).length < 6) return authError(res, 422, 'weak_password', 'Password should be at least 6 characters.');
          if (body.password === u.password) return authError(res, 422, 'same_password', 'New password should be different from the old password.');
          u.password = body.password;
        }
        u.updated_at = new Date().toISOString();
        return send(res, 200, userJson(u));
      }
    }

    if (p === '/logout' && req.method === 'POST') return send(res, 204, undefined);

    const adminUser = /^\/admin\/users\/([0-9a-f-]{36})$/.exec(p);
    if (adminUser && req.method === 'GET') {
      const who = await caller(req);
      if (!who?.service) return authError(res, 403, 'not_admin', 'User not allowed');
      const u = users.get(adminUser[1]);
      return u ? send(res, 200, userJson(u)) : authError(res, 404, 'user_not_found', 'User not found');
    }
    if (adminUser && req.method === 'DELETE') {
      const who = await caller(req);
      if (!who?.service) return authError(res, 403, 'not_admin', 'User not allowed');
      users.delete(adminUser[1]);
      const theirDomains = new Set((tables.get('published_domains') ?? []).filter((d) => d.user_id === adminUser[1]).map((d) => d.domain));
      // on delete cascade (usage_ledger.user_id has no foreign key on purpose: its rows stay for invoices); billing_trials
      // keeps its rows without the user (on delete set null: one trial per email and card, even after a deletion)
      for (const [t, rows] of tables) {
        if (USER_SET_NULL.has(t)) for (const r of rows) if (r.user_id === adminUser[1]) r.user_id = null;
        if (!NO_USER_FK.has(t) && !USER_SET_NULL.has(t)) tables.set(t, rows.filter((r) => r.user_id !== adminUser[1]));
      }
      // other accounts' pages on a domain that went with it lose it (on delete set null)
      for (const p of tables.get('published_pages') ?? []) if (theirDomains.has(p.domain)) p.domain = null;
      return send(res, 200, {});
    }

    return authError(res, 404, 'not_found', 'mock auth: no route ' + p);
  }

  function handle(req, res, rawBuf) {
    const url = new URL(req.url, 'http://mock');
    const raw = rawBuf.toString('utf8');
    calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body: raw.length < 20000 ? raw : `<${raw.length} bytes>` });
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'access-control-allow-headers': req.headers['access-control-request-headers'] || '*',
        'access-control-max-age': '600',
      });
      return res.end();
    }
    if (url.pathname === '/__mock/emails') return send(res, 200, emails.filter((e) => !url.searchParams.get('to') || e.to === url.searchParams.get('to')));
    if (behavior.down) return send(res, 503, { message: 'mock outage' });
    const injected = behavior.fail?.(req.method, url.pathname, url.searchParams);
    if (injected) return send(res, injected.status, injected.body);
    if (url.pathname.startsWith('/auth/v1/')) return void authRoute(req, res, url, raw);
    const fn = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url.pathname);
    if (fn && req.method === 'POST') return void rpc(req, res, fn[1], raw);
    const t = /^\/rest\/v1\/([a-z_]+)$/.exec(url.pathname);
    if (t && behavior.restDelayMs) return void setTimeout(() => rest(req, res, url, t[1], raw), behavior.restDelayMs);
    if (t) return void rest(req, res, url, t[1], raw);
    if (url.pathname.startsWith('/storage/v1/')) return void storage(req, res, url, rawBuf);
    return send(res, 404, { message: 'mock: no route ' + url.pathname });
  }

  return {
    PUBLISHABLE,
    SECRET,
    users,
    tables,
    objects,
    /** the plans emulation (projectSlots): enforced(), claim(userId, projectId), applySlots(userId), … */
    slots,
    emails,
    calls,
    behavior,
    get url() {
      return base;
    },
    /** A valid access token for a user (creating a confirmed user if needed). */
    /** autoconfirmed: made while "Confirm email" was off (no confirmation email was ever sent) */
    async tokenFor(email, password = 'password123', { autoconfirmed = false, appMetadata = null } = {}) {
      let u = [...users.values()].find((x) => x.email === email);
      if (!u) {
        const now = new Date().toISOString();
        const sent = new Date(Date.now() - 60_000).toISOString();
        u = { id: crypto.randomUUID(), email, password, created_at: sent, updated_at: now, confirmed_at: now, confirmation_sent_at: autoconfirmed ? null : sent, ...(appMetadata ? { app_metadata: appMetadata } : {}) };
        users.set(u.id, u);
      }
      return { token: (await session(u)).access_token, user: u };
    },
    lastEmail(to, type) {
      return [...emails].reverse().find((e) => e.to === to && (!type || e.type === type));
    },
    async start(port = 0) {
      server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => handle(req, res, Buffer.concat(chunks)));
      });
      await new Promise((r) => server.listen(port, '127.0.0.1', r));
      base = `http://127.0.0.1:${server.address().port}`;
      return this;
    },
    close() {
      return new Promise((r) => server.close(r));
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mock = await createMockSupabase({ confirmEmail: process.env.MOCK_CONFIRM_EMAIL !== '0' });
  await mock.start(Number(process.argv[2] || 0));
  console.log(JSON.stringify({ url: mock.url, publishableKey: mock.PUBLISHABLE, secretKey: mock.SECRET }));
}
