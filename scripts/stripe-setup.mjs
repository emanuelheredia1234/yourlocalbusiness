#!/usr/bin/env node
// Stripe products and prices for the plans (shared/plans.json), found by lookup key. Safe to run again.
//
//   npm run stripe:setup                     dry run: what is there, what is missing, what differs (changes nothing)
//   npm run stripe:setup -- --apply          create what is missing (Products by custom id, Prices by lookup key)
//   npm run stripe:setup -- --apply --portal also create a Customer Portal configuration (quantity editing off)
//   npm run stripe:setup -- --live …         required for a live key (sk_live_/rk_live_): the owner runs it only with
//                                            their explicit OK
//   npm run stripe:setup -- --apply --replace  a price that differs gets a NEW price that takes its lookup key
//                                            (transfer_lookup_key); prices are immutable, old subscriptions keep theirs
//
// STRIPE_SECRET_KEY is read from env only and printed as its last 4. STRIPE_API_BASE (tests, the mock) is honoured
// only with an sk_test_ key. Every write has a fixed Idempotency-Key, so running it twice never makes a second
// product, price or configuration. Exit 0 only when every lookup key is ok or created.

import { fileURLToPath } from 'node:url';
import { createStripeClient, stripeMode } from '../server/billing/stripeClient.mjs';
import { PRICE_TABLE, PLANS } from '../server/billing/plans.mjs';
import { mask } from '../server/integrations/common.mjs';

const RED = (s) => `\u001b[31m${s}\u001b[0m`;

/** Customer Portal: card, invoices, cancel at period end; no plan or quantity changes there (the app does those). */
export const PORTAL_FEATURES = Object.freeze({
  payment_method_update: { enabled: 'true' },
  invoice_history: { enabled: 'true' },
  customer_update: { enabled: 'true', allowed_updates: ['email', 'address', 'tax_id'] },
  subscription_cancel: { enabled: 'true', mode: 'at_period_end', cancellation_reason: { enabled: 'true', options: ['too_expensive', 'missing_features', 'unused', 'other'] } },
  subscription_update: { enabled: 'false' },
});

/**
 * args: the command-line flags; env: process.env; fetch: for tests; out: a line printer. → { code, rows, portal }
 * (code 0: all ok or created).
 */
export async function runSetup({ args = [], env = process.env, fetch = globalThis.fetch, out = (line) => console.log(line) } = {}) {
  const flags = new Set(args);
  const apply = flags.has('--apply');
  const key = String(env.STRIPE_SECRET_KEY ?? '').trim();
  const mode = stripeMode(key);
  if (!mode) {
    out('STRIPE_SECRET_KEY is missing or isn’t a Stripe secret key (sk_test_/sk_live_/rk_test_/rk_live_).');
    return { code: 2, rows: [] };
  }
  out(`mode: ${mode}   key: ${mask(key)}   ${apply ? 'APPLY (creates what is missing)' : 'dry run (changes nothing; add --apply)'}`);
  if (mode === 'live' && !flags.has('--live')) {
    out(RED('This is a live key. Run it again with --live, and only with the owner’s explicit OK.'));
    return { code: 2, rows: [] };
  }
  if (String(env.STRIPE_API_BASE ?? '').trim() && !/^sk_test_/.test(key)) {
    out(RED('STRIPE_API_BASE is only for tests with an sk_test_ key.'));
    return { code: 2, rows: [] };
  }
  const stripe = createStripeClient({ env, fetch });
  const rows = [];
  const products = new Map(); // id → exists
  async function ensureProduct(id, name) {
    if (products.get(id)) return true;
    try {
      await stripe.get(`/v1/products/${encodeURIComponent(id)}`);
      products.set(id, true);
      return true;
    } catch (e) {
      if (e?.status !== 404) throw e;
    }
    const made = await stripe.post('/v1/products', { id, name, metadata: { ylb: '1' } }, { idempotencyKey: `ylb-setup-product-${id}-v1` });
    if (made.outcome !== 'ok') {
      out(RED(`product ${id}: ${made.outcome === 'unknown' ? 'no answer (run again: the same key returns the same product)' : `refused (${made.error?.code ?? made.error?.kind})`}`));
      return false;
    }
    products.set(id, true);
    return true;
  }

  for (const [lookupKey, want] of Object.entries(PRICE_TABLE)) {
    const list = await stripe.get('/v1/prices', { 'lookup_keys[]': lookupKey, active: 'true', 'expand[]': 'data.product', limit: 10 });
    const found = (list?.data ?? []).find((p) => p.lookup_key === lookupKey) ?? null;
    const productOf = (p) => (typeof p?.product === 'string' ? p.product : p?.product?.id);
    if (found) {
      const same = found.unit_amount === want.amount && String(found.currency).toLowerCase() === PLANS.currency && found.recurring?.interval === want.interval && (found.recurring?.interval_count ?? 1) === 1;
      if (same) {
        rows.push({ lookupKey, state: 'ok', price: found.id, product: productOf(found) });
        continue;
      }
      if (!(apply && flags.has('--replace'))) {
        rows.push({ lookupKey, state: 'MISMATCH', price: found.id, have: { amount: found.unit_amount, currency: found.currency, interval: found.recurring?.interval }, want: { amount: want.amount, currency: PLANS.currency, interval: want.interval } });
        continue;
      }
      out(RED(`${lookupKey}: replacing ${found.id} with a new price (${want.amount} ${PLANS.currency}/${want.interval}). Existing subscriptions keep the old price.`));
    } else if (!apply) {
      rows.push({ lookupKey, state: 'missing (dry run)' });
      continue;
    }
    if (!(await ensureProduct(want.product, want.productName))) {
      rows.push({ lookupKey, state: 'failed' });
      continue;
    }
    const body = { product: want.product, currency: PLANS.currency, unit_amount: want.amount, recurring: { interval: want.interval }, lookup_key: lookupKey, tax_behavior: 'exclusive', nickname: `${want.productName} (${want.interval === 'month' ? 'monthly' : 'yearly'})`, metadata: { ylb: '1' }, ...(found ? { transfer_lookup_key: 'true' } : {}) };
    const made = await stripe.post('/v1/prices', body, { idempotencyKey: `ylb-setup-price-${lookupKey}-${found ? `replace-${found.id}` : 'v1'}` });
    if (made.outcome === 'ok') rows.push({ lookupKey, state: 'created', price: made.value.id, product: want.product });
    else rows.push({ lookupKey, state: made.outcome === 'unknown' ? 'unknown (run again)' : 'failed', ...(made.error ? { code: made.error.code ?? made.error.kind } : {}) });
  }

  for (const r of rows) out(`${r.lookupKey.padEnd(22)} ${r.state === 'MISMATCH' ? RED(r.state) : r.state}${r.price ? `  ${r.price}` : ''}${r.state === 'MISMATCH' ? `  have ${r.have.amount} ${r.have.currency}/${r.have.interval}, want ${r.want.amount} ${r.want.currency}/${r.want.interval}` : ''}`);

  let portal = null;
  if (flags.has('--portal')) {
    if (!apply) out('Customer Portal: dry run. With --apply --portal a configuration is made (card, invoices, cancel at period end; plan and quantity changes off).');
    else {
      const made = await stripe.post('/v1/billing_portal/configurations', { features: PORTAL_FEATURES, business_profile: { headline: 'Manage your plan' } }, { idempotencyKey: 'ylb-setup-portal-v1' });
      if (made.outcome === 'ok') {
        portal = made.value.id;
        out(`Customer Portal configuration: ${portal}  (set STRIPE_PORTAL_CONFIGURATION to it)`);
      } else out(RED(`Customer Portal configuration: ${made.outcome === 'unknown' ? 'no answer (run again)' : 'refused'}`));
    }
  } else {
    out('Customer Portal: set it up in Stripe → Settings → Billing → Customer portal (payment methods, invoices, cancel at period end; subscription updates OFF), or run with --apply --portal.');
  }

  const code = rows.length === Object.keys(PRICE_TABLE).length && rows.every((r) => r.state === 'ok' || r.state === 'created') ? 0 : 1;
  out(code === 0 ? 'All plan prices are ready.' : 'Not ready: see the rows above.');
  return { code, rows, portal };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runSetup({ args: process.argv.slice(2) })
    .then(({ code }) => process.exit(code))
    .catch((e) => {
      // never the key: a StripeError carries only its kind and code
      console.error(`Stripe setup failed: ${e?.name === 'StripeError' ? `${e.kind}${e.code ? ` (${e.code})` : ''}` : e?.message ?? e}`);
      process.exit(1);
    });
}
