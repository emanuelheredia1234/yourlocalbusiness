// P6 rules checks: the Connect code and its tests never name Stripe's live API host (tests run against mock-stripe
// only), and nothing writes to Stripe without going through the client's Idempotency-Key rule.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const files = [
  ...['connectConfig', 'connectFee', 'connectWebhook', 'stripeConnect'].flatMap((n) => [`payments/${n}.mjs`, `payments/${n}.test.mjs`]),
  'payments/connectFee.test.mjs',
  'offers/stripeOffer.mjs',
  'offers/stripeOffer.test.mjs',
  'offers/stripeCheckout.mjs',
  'offers/buy.stripe.test.mjs',
  'offers/thanks.test.mjs',
].filter((f, i, all) => all.indexOf(f) === i && fs.existsSync(path.join(root, f)));

describe('Stripe Connect rules', () => {
  it('no test or Connect module calls api.stripe.com', () => {
    expect(files.length).toBeGreaterThan(8);
    for (const f of files) expect(fs.readFileSync(path.join(root, f), 'utf8'), f).not.toContain('api.stripe.com');
  });

  it('Connect modules write to Stripe only through the client (post with an idempotencyKey), never fetch()', () => {
    for (const f of files.filter((x) => !x.endsWith('.test.mjs'))) {
      const src = fs.readFileSync(path.join(root, f), 'utf8');
      expect(src, f).not.toMatch(/\bfetch\(\s*[`'"]https?:\/\/[^`'"]*stripe/);
      for (const m of src.matchAll(/stripe\.post\(([\s\S]*?)\);/g)) expect(m[1], f).toMatch(/idempotencyKey/);
    }
  });
});
