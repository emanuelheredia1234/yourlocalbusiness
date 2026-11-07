// The buyer's pages after a Stripe Checkout (server/offers/stripeCheckout.mjs, spec S5.2–S5.4): the thank-you page
// reads the session back and claims nothing it can't confirm, records the sale, and offers the paid download; the
// download is limited, closed after a refund or dispute and after N days; a seller's 7-day link; the cancelled page.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { offersServer, testBilling } from './test-helpers.mjs';
import { checkSaleTicket, makeSaleTicket } from './stripeCheckout.mjs';

const PDF = Buffer.from('%PDF-1.4\n%%EOF\n');

describe('the thank-you page and the paid download', () => {
  let h;
  let s;
  let fileOffer;
  let noneOffer;
  let ip = 0;
  beforeAll(async () => {
    h = await offersServer({ stripe: true, billing: testBilling(), env: { CONNECT_DOWNLOADS_PER_SALE: '3', CONNECT_DOWNLOAD_DAYS: '30' } });
    s = await h.stripeSeller('thanks@example.com');
    // a product file in Storage
    const fileId = crypto.randomBytes(16).toString('base64url');
    const path = `${s.who.id}/${fileId}/v1/pattern.pdf`;
    await h.db.insert('lead_files', { id: fileId, user_id: s.who.id, project_id: 'p1', title: 'Pattern', kind: 'file', purpose: 'product', file_name: 'pattern.pdf', object_path: path, bytes: PDF.length });
    h.supa.objects.set(`lead-files/${path}`, { bytes: PDF, type: 'application/pdf', created: Date.now() });
    fileOffer = (await h.call(s.who, 'POST', '/api/offers', { projectId: 'p1', provider: 'stripe', title: 'Pattern pack', priceMinor: 1500, currency: 'usd', delivery: { kind: 'file', fileId }, clientRequestId: crypto.randomUUID() })).body.offer;
    noneOffer = (await h.call(s.who, 'POST', '/api/offers', { projectId: 'p1', provider: 'stripe', title: 'Lesson', priceMinor: 2500, currency: 'usd', clientRequestId: crypto.randomUUID() })).body.offer;
  });
  afterAll(() => h.close());
  const visit = (path, opts = {}) => h.visit(path, { ...opts, headers: { 'x-test-ip': `192.0.2.${(ip++ % 200) + 1}`, ...(opts.headers ?? {}) } });
  /** A buyer clicks and pays (or not): the session id. */
  async function buy(offer, { pay = true, async = false } = {}) {
    const r = await visit(`/b/${offer.id}`);
    const sid = r.headers.get('location').split('/__pay/')[1];
    if (pay) await fetch(`${h.stripe.base}/__checkout/complete`, { method: 'POST', body: JSON.stringify({ id: sid, account: s.accountId, async, email: 'buyer@example.com' }) });
    return sid;
  }
  const saleOf = (sid) => h.rows('sales').find((x) => x.checkout_session_id === sid);

  it('a session id that isn’t one, or no session id: the plain page, claiming nothing', async () => {
    for (const q of ['', '?session_id=nope', '?session_id=cs_test_short', `?session_id=cs_live_${'a'.repeat(300)}`, '?session_id={CHECKOUT_SESSION_ID}']) {
      const r = await visit(`/b/${noneOffer.id}/done${q}`);
      expect(r.status).toBe(200);
      expect(r.text).toContain('Your receipt comes from');
      expect(r.text).not.toContain('Payment received');
      expect(r.headers.get('content-security-policy')).toContain("default-src 'none'");
      expect(r.headers.get('cache-control')).toBe('no-store');
      expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    }
  });

  it('another offer’s session, or one made on another account: the plain page', async () => {
    const sid = await buy(noneOffer);
    const r = await visit(`/b/${fileOffer.id}/done?session_id=${sid}`);
    expect(r.text).not.toContain('Payment received');
    const other = await h.stripeSeller('thanks-other@example.com');
    const theirs = (await h.call(other.who, 'POST', '/api/offers', { projectId: 'p1', provider: 'stripe', title: 'Other', priceMinor: 999, currency: 'usd', clientRequestId: crypto.randomUUID() })).body.offer;
    expect((await visit(`/b/${theirs.id}/done?session_id=${sid}`)).text).not.toContain('Payment received');
  });

  it('paid: records the sale (once, whatever the visits), names the seller, and offers the download', async () => {
    const sid = await buy(fileOffer);
    const r = await visit(`/b/${fileOffer.id}/done?session_id=${sid}`);
    expect(r.text).toContain('Payment received');
    expect(r.text).toContain(`/b/${fileOffer.id}/file?session_id=${sid}`);
    expect(r.text).toContain('Save this page to download again for 30 days');
    expect(r.text).toContain('Payments are processed by Stripe');
    expect(r.text).not.toMatch(/<script/i);
    await visit(`/b/${fileOffer.id}/done?session_id=${sid}`);
    const rows = h.rows('sales').filter((x) => x.checkout_session_id === sid);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: 'stripe', environment: 'sandbox', status: 'paid', amount_minor: 1500, currency: 'usd', buyer_email: 'buyer@example.com', application_fee_minor: 45, fee_pct: 3, fee_tier: 'launch', offer_id: fileOffer.id, provider_account: s.accountId });
    expect(rows[0].application_fee_id).toMatch(/^fee_/);
    const none = await buy(noneOffer);
    expect((await visit(`/b/${noneOffer.id}/done?session_id=${none}`)).text).toContain('The seller will be in touch');
  });

  it('a delayed payment is "processing" with no download; an unfinished checkout links back', async () => {
    const sid = await buy(fileOffer, { async: true });
    const r = await visit(`/b/${fileOffer.id}/done?session_id=${sid}`);
    expect(r.text).toContain('Your payment is processing');
    expect(r.text).not.toContain('/file?');
    expect(saleOf(sid).status).toBe('pending');
    expect((await visit(`/b/${fileOffer.id}/file?session_id=${sid}`)).status).toBe(410);
    const open = await buy(noneOffer, { pay: false });
    const o = await visit(`/b/${noneOffer.id}/done?session_id=${open}`);
    expect(o.text).toContain('wasn’t finished');
    expect(o.text).toContain(`href="/b/${noneOffer.id}"`);
  });

  it('/file: a 302 to a 60-second signed link, counted per sale up to the limit; HEAD counts nothing; before the thank-you page it reads the session itself', async () => {
    const sid = await buy(fileOffer);
    // straight to /file (the thank-you page never loaded): the same read records the sale
    expect((await visit(`/b/${fileOffer.id}/file?session_id=${sid}`, { method: 'HEAD' })).status).toBe(200);
    const r = await visit(`/b/${fileOffer.id}/file?session_id=${sid}`);
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toMatch(new RegExp(`^${h.supa.url}/storage/v1/object/sign/lead-files/.+&download=pattern\\.pdf$`));
    expect(Buffer.from(await (await fetch(r.headers.get('location'))).arrayBuffer()).equals(PDF)).toBe(true);
    expect(saleOf(sid).downloads).toBe(1);
    await visit(`/b/${fileOffer.id}/file?session_id=${sid}`);
    await visit(`/b/${fileOffer.id}/file?session_id=${sid}`);
    const over = await visit(`/b/${fileOffer.id}/file?session_id=${sid}`);
    expect(over.status).toBe(429);
    expect(over.text).toContain('Ask the seller for a new link');
    expect(saleOf(sid).downloads).toBe(3);
    // another offer's file path with this session: closed
    expect((await visit(`/b/${noneOffer.id}/file?session_id=${sid}`)).status).toBe(410);
  });

  it('refunded or disputed: 410; past the download days: 410', async () => {
    for (const status of ['refunded', 'disputed']) {
      const sid = await buy(fileOffer);
      await visit(`/b/${fileOffer.id}/done?session_id=${sid}`);
      saleOf(sid).status = status;
      const r = await visit(`/b/${fileOffer.id}/file?session_id=${sid}`);
      expect(r.status, status).toBe(410);
      expect(r.text).toContain('no longer available');
    }
    const sid = await buy(fileOffer);
    await visit(`/b/${fileOffer.id}/done?session_id=${sid}`);
    saleOf(sid).paid_at = new Date(Date.now() - 31 * 86_400_000).toISOString();
    expect((await visit(`/b/${fileOffer.id}/file?session_id=${sid}`)).status).toBe(410);
  });

  it('a seller’s new link: the seller’s own sale only, works 7 days, a forged or expired one doesn’t', async () => {
    const sid = await buy(fileOffer);
    await visit(`/b/${fileOffer.id}/done?session_id=${sid}`);
    const sale = saleOf(sid);
    const other = await h.user('not-the-seller@example.com');
    expect((await h.call(other, 'POST', `/api/offers/sales/${sale.id}/download-link`, {})).status).toBe(404);
    const got = await h.call(s.who, 'POST', `/api/offers/sales/${sale.id}/download-link`, {});
    expect(got.status).toBe(200);
    expect(got.body.url).toMatch(new RegExp(`^https://app\\.example\\.test/b/${fileOffer.id}/file\\?t=`));
    const t = new URL(got.body.url).searchParams.get('t');
    expect((await visit(`/b/${fileOffer.id}/file?t=${t}`)).status).toBe(302);
    expect((await visit(`/b/${fileOffer.id}/file?t=${t.slice(0, -2)}xx`)).status).toBe(410);
    // the ticket format: expiry, sale and MAC; an expired one is refused
    const secret = Buffer.alloc(32, 7);
    const old = makeSaleTicket(secret, sale.id, Date.now() - 8 * 86_400_000);
    expect(checkSaleTicket(secret, old)).toBeNull();
    expect(checkSaleTicket(secret, makeSaleTicket(secret, sale.id))).toBe(sale.id);
    expect(checkSaleTicket(Buffer.alloc(32, 8), makeSaleTicket(secret, sale.id))).toBeNull();
  });

  it('/back: "Checkout cancelled. Nothing was charged." with a link back; reads no query', async () => {
    const r = await visit(`/b/${noneOffer.id}/back?next=https://evil.example`);
    expect(r.status).toBe(200);
    expect(r.text).toContain('Nothing was charged');
    expect(r.text).toContain(`href="/b/${noneOffer.id}"`);
    expect(r.text).not.toContain('evil');
  });
});
