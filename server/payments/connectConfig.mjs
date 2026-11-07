// Stripe Connect settings from env (P6), pure: no I/O. Keys stay in env; this only says whether they're there.
//
//   connectConfig(env, { mode }) → { enabled, ready, environment, live, … , missing() }
//
// mode: the Stripe client's ('test' | 'live' | null, from STRIPE_SECRET_KEY: the same key P1 billing uses). One mode
// per deployment: a test key is 'sandbox', a live key 'production'.
//
// Env: STRIPE_CONNECT (off turns it off; default on once the key and the Connect webhook secret are there),
// STRIPE_CONNECT_WEBHOOK_SECRET and STRIPE_CONNECT_WEBHOOK_SECRET_PREVIOUS (the Connect endpoint's own signing secret,
// and the previous one while rotating), STRIPE_PLATFORM_COUNTRY (US), CONNECT_RETURN_FEES (on; off keeps our fee after
// refunds), CONNECT_DOWNLOADS_PER_SALE (10), CONNECT_DOWNLOAD_DAYS (30), CONNECT_SESSIONS_PER_VISITOR_PER_HOUR (20),
// APP_PUBLIC_URL (the app's address for Stripe's return links and Checkout's success page; https in production).

const off = (v) => ['off', 'none', 'false', '0', 'no'].includes(String(v ?? '').trim().toLowerCase());
const whole = (v, fallback, min = 1, max = 1_000_000) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? Math.min(max, Math.floor(n)) : fallback;
};

/** The app's public origin from APP_PUBLIC_URL (no path), or null. */
export function publicOrigin(env = process.env) {
  try {
    const u = new URL(String(env.APP_PUBLIC_URL ?? '').trim());
    if ((u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password) return u.origin;
  } catch {
    /* not set */
  }
  return null;
}

export function connectConfig(env = process.env, { mode = null } = {}) {
  const switchedOff = off(env.STRIPE_CONNECT);
  const webhookSecrets = [env.STRIPE_CONNECT_WEBHOOK_SECRET, env.STRIPE_CONNECT_WEBHOOK_SECRET_PREVIOUS].map((s) => String(s ?? '').trim()).filter(Boolean);
  const environment = mode === 'live' ? 'production' : mode === 'test' ? 'sandbox' : null;
  const origin = publicOrigin(env);
  // Stripe wants https return links and success pages in live mode
  const publicUrlOk = environment === 'production' ? !!origin && origin.startsWith('https://') : true;
  const country = String(env.STRIPE_PLATFORM_COUNTRY ?? '').trim().toUpperCase();
  const cfg = {
    switchedOff,
    environment,
    live: environment === 'production',
    webhookSecrets,
    platformCountry: /^[A-Z]{2}$/.test(country) ? country : 'US',
    returnFees: !off(env.CONNECT_RETURN_FEES),
    downloadsPerSale: whole(env.CONNECT_DOWNLOADS_PER_SALE, 10, 1, 1000),
    downloadDays: whole(env.CONNECT_DOWNLOAD_DAYS, 30, 1, 3650),
    sessionsPerVisitorPerHour: whole(env.CONNECT_SESSIONS_PER_VISITOR_PER_HOUR, 20, 1, 10_000),
    publicOrigin: origin,
    publicUrlOk,
  };
  /** What's missing, by Secret name only (for notes() and the owner's view): never a value. */
  cfg.missing = () => {
    const out = [];
    if (!environment) out.push('STRIPE_SECRET_KEY');
    if (!webhookSecrets.length) out.push('STRIPE_CONNECT_WEBHOOK_SECRET');
    if (!publicUrlOk) out.push('APP_PUBLIC_URL (https)');
    return out;
  };
  // on by default once the key and the Connect secret are there
  cfg.enabled = !switchedOff && !!environment && webhookSecrets.length > 0;
  // and able to send buyers and sellers to Stripe (an https address in live mode)
  cfg.ready = cfg.enabled && publicUrlOk;
  return cfg;
}
