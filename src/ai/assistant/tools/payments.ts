// Payments for the assistant (P6): selling through the owner's own Stripe account. Reads run at once; making a Stripe
// buy link asks on a card first (the price and our fee, nothing charged); setting up Stripe only opens Settings ›
// Payments: the owner ticks the seller terms there, and "Continue setup" is the owner's own click in the chat (the
// tool never gets or shows a Stripe setup link: those go only to the signed-in browser). Refunds, disputes, payouts,
// Stripe Tax and stopping selling are never done here (excluded.ts says where). Buyer emails only when the owner asks,
// and never into other tools. Not in the claude.ai build.

import { createStripeOffer, decimalToMinor, formatMoney, listOffers, listSales, requestId, salesSummary, stripePriceProblem, whopConnections, type Offer, type Sale } from '@/lib/offers';
import { disabledWords, dueWords, feeLabel, onboardingLink, stripePreview, type ConnectState } from '@/lib/stripeConnect';
import { listLeadFiles, type LeadFile } from '@/lib/leadFiles';
import { useOffers } from '@/store/offers';
import { useStore } from '@/store/useStore';
import { host } from '../host';
import { arg, clip, defineTool, type AnyTool } from '../registry';

const NOT_HERE = 'Payments need the app’s own server, so they aren’t available here.';
const OFF = 'Selling with Stripe isn’t on for this app (or you’re not signed in).';
const notOn = () => (__ARTIFACT_BUILD__ ? NOT_HERE : !useOffers.getState().config?.stripe.available ? OFF : null);
const message = (e: unknown) => (e as Error)?.message || 'That didn’t work. Try again.';

/** The Stripe account and the fee, read now (null: couldn't be read). */
async function readConnect(): Promise<ConnectState | null> {
  if (!useOffers.getState().config) await useOffers.getState().loadConfig();
  return useOffers.getState().refreshConnect();
}

/** The account in words: what it can do, what Stripe needs and by when (never an id beyond the last 4). */
export function accountWords(c: ConnectState | null): Record<string, unknown> {
  const a = c?.account;
  if (!a) return { status: 'not set up', next: 'start_stripe_setup opens Settings › Payments, where the owner sets it up.' };
  const words: Record<string, string> = { creating: 'being confirmed with Stripe', unknown: 'being confirmed with Stripe', onboarding: 'setup not finished', restricted: 'Stripe needs more information', active: 'receiving payments', rejected: 'closed by Stripe', disconnected: 'stopped selling here' };
  return {
    status: words[a.status] ?? a.status,
    ...(a.status === 'active' ? { payouts: a.payoutsEnabled ? 'on' : 'paused by Stripe' } : {}),
    ...(dueWords(a) ? { due: dueWords(a) } : {}),
    ...(disabledWords(a.disabledReason) ? { why: disabledWords(a.disabledReason) } : {}),
    ...(a.environment === 'sandbox' ? { testMode: true } : {}),
    ...(a.displayName ? { name: a.displayName } : {}),
    ...(a.accountLast4 ? { account: `…${a.accountLast4}` } : {}),
    stripeTax: a.taxEnabled ? 'on' : 'off',
  };
}

const statusTool = defineTool({
  name: 'get_payments_status',
  class: 'R',
  summary: 'Payments: the Stripe account in words (what Stripe needs, by when), our fee on the owner’s plan, Whop accounts, and how many Stripe buy links this business has.',
  args: {},
  validate: () => (__ARTIFACT_BUILD__ ? NOT_HERE : null),
  run: async (_a, ctx) => {
    const c = await readConnect();
    const cfg = useOffers.getState().config;
    let whop: { mode: string; status: string }[] | string = [];
    if (cfg?.whop.production || cfg?.whop.sandbox) {
      try {
        whop = (await whopConnections()).map((w) => ({ mode: w.environment === 'sandbox' ? 'Test mode' : 'Live', status: w.status === 'active' ? 'connected' : 'needs attention' }));
      } catch (e) {
        whop = message(e);
      }
    }
    let offers: Offer[] = [];
    try {
      offers = await listOffers(ctx.projectId);
    } catch {
      offers = useOffers.getState().byProject[ctx.projectId] ?? [];
    }
    const stripeOffers = offers.filter((o) => o.provider === 'stripe' && o.status !== 'archived');
    return {
      data: {
        stripe: cfg?.stripe.available ? { ...accountWords(c), ...(c?.fee ? { ourFee: feeLabel(c.fee) } : {}) } : 'not on for this app',
        whop: typeof whop === 'string' ? whop : whop.length ? whop : 'not connected',
        stripeBuyLinks: stripeOffers.length,
        ...(stripeOffers.some((o) => o.problem === 'stripe_setup') ? { note: 'Its Stripe buy links sell once Stripe setup is finished.' } : {}),
      },
      note: 'Looked at your payments',
    };
  },
});

const setupTool = defineTool({
  name: 'start_stripe_setup',
  class: 'L',
  summary: 'Open Settings › Payments to set up selling with Stripe (the owner ticks the seller terms there); an account being set up gets a Continue setup button the owner presses.',
  args: {},
  validate: () => notOn(),
  run: async () => {
    const opened = await host.openPage('workspace-settings', 'payments');
    const c = await readConnect();
    const a = c?.account;
    const unfinished = !!a && (a.status === 'onboarding' || a.status === 'restricted');
    return {
      data: { opened: opened ? 'Settings › Payments' : 'stayed on this page', ...accountWords(c), ...(unfinished ? { next: 'The owner presses Continue setup (here or in Settings › Payments) to finish on Stripe’s page.' } : !a ? { next: 'The owner picks their country, ticks the seller terms and presses Get paid with Stripe.' } : {}) },
      note: opened ? 'Opened Settings › Payments' : 'Stayed on this page',
      ...(unfinished
        ? {
            buttons: [
              {
                label: 'Continue setup',
                icon: 'open' as const,
                // the owner's own click: a fresh link goes straight to Stripe's page, never into the chat
                run: async () => location.assign(await onboardingLink()),
              },
            ],
          }
        : {}),
    };
  },
});

/** The business's product files (what a Stripe buy link can deliver). */
async function productFiles(projectId: string): Promise<LeadFile[]> {
  return (await listLeadFiles(projectId, undefined, 'product')).filter((f) => f.purpose === 'product' && f.kind === 'file' && f.bytes > 0);
}

const pending = new Map<string, { files: LeadFile[] | null; error: string }>();

const offerTool = defineTool({
  name: 'create_stripe_offer',
  class: 'P-text',
  summary: 'Make a buy link sold through the owner’s own Stripe account (price like 49.50; fileId: one of the business’s product files, else the owner delivers it). Asks on a card first; nothing is charged.',
  args: {
    projectId: arg.string({ optional: true, max: 80, desc: 'the business (default: the open one)' }),
    title: arg.string({ max: 200 }),
    price: arg.number({ min: 0.5, max: 99_999_999 }),
    currency: arg.string({ optional: true, pattern: /^[a-z]{3}$/i, desc: 'usd, eur… (default: the Stripe account’s)' }),
    fileId: arg.string({ optional: true, pattern: /^[A-Za-z0-9_-]{22}$/, desc: 'a product file id' }),
  },
  prepare: async (a, ctx) => {
    if (notOn()) return;
    await readConnect();
    if (a.fileId) {
      try {
        pending.set(ctx.projectId, { files: await productFiles(a.projectId ?? ctx.projectId), error: '' });
      } catch (e) {
        pending.set(ctx.projectId, { files: null, error: message(e) });
      }
    }
  },
  validate: (a, ctx) => {
    const off = notOn();
    if (off) return off;
    if (a.projectId && !useStore.getState().projects.some((p) => p.id === a.projectId)) return 'That business isn’t in this workspace.';
    const c = useOffers.getState().connect;
    if (!c?.account) return 'Set up Stripe first: start_stripe_setup opens Settings › Payments, where the owner sets it up.';
    if (c.account.status === 'rejected') return 'Stripe closed this Stripe account, so it can’t sell. The owner contacts Stripe support.';
    const currency = (a.currency ?? c.account.defaultCurrency ?? 'usd').toLowerCase();
    const minor = decimalToMinor(String(a.price), currency);
    if (minor == null) return currency === 'jpy' ? 'Use a whole number for this currency.' : 'Use a price like 49 or 49.50.';
    const priceProblem = stripePriceProblem(minor, currency);
    if (priceProblem) return priceProblem;
    if (a.fileId) {
      const f = pending.get(ctx.projectId);
      if (f?.error) return f.error;
      if (!f?.files?.some((x) => x.id === a.fileId)) return 'That isn’t one of this business’s product files. The owner uploads one in Attach payment › Stripe › A file.';
    }
    return null;
  },
  card: (a, ctx) => {
    const c = useOffers.getState().connect;
    const currency = (a.currency ?? c?.account?.defaultCurrency ?? 'usd').toLowerCase();
    const minor = decimalToMinor(String(a.price), currency);
    const file = a.fileId ? pending.get(ctx.projectId)?.files?.find((x) => x.id === a.fileId) : null;
    const notActive = c?.account?.status !== 'active';
    return {
      title: `Make a Stripe buy link for “${clip(a.title, 80)}”?`,
      what: `${stripePreview(minor, currency, c?.fee ?? null, c?.account?.country)} ${file ? `Buyers download “${clip(file.title || file.fileName, 60)}” after paying.` : 'You deliver it yourself; the thank-you page says you’ll be in touch.'}${notActive ? ' It sells once your Stripe setup is finished.' : ''}`,
      who: 'Buyers pay through your own Stripe account. Nothing is charged now.',
      confirmLabel: 'Create buy link',
    };
  },
  run: async (a, ctx) => {
    const c = useOffers.getState().connect;
    const currency = (a.currency ?? c?.account?.defaultCurrency ?? 'usd').toLowerCase();
    const minor = decimalToMinor(String(a.price), currency);
    if (minor == null) return { ok: false, error: 'Use a price like 49 or 49.50.' };
    pending.delete(ctx.projectId);
    try {
      const o = await createStripeOffer({ projectId: a.projectId ?? ctx.projectId, title: a.title.trim(), priceMinor: minor, currency, delivery: a.fileId ? { kind: 'file', fileId: a.fileId } : { kind: 'none' }, clientRequestId: requestId() });
      useOffers.getState().put(o);
      // no address in what the model reads: pages use the {{buy:<id>}} token
      return { data: { id: o.id, title: o.title, price: o.priceDisplay, provider: 'stripe', status: o.status, ...(o.problem ? { problem: 'Finish Stripe setup to start selling.' } : {}), use: `{{buy:${o.id}}} in a page or email, or attach it with Attach payment` }, note: `Made the Stripe buy link “${clip(o.title, 60)}”` };
    } catch (e) {
      return { ok: false, error: message(e) };
    }
  },
});

const money = (m: Record<string, number>) => Object.entries(m).filter(([, n]) => n > 0).map(([cur, n]) => formatMoney(n, cur)).join(' · ') || formatMoney(0, 'usd');

const salesTool = defineTool({
  name: 'list_sales',
  class: 'R',
  summary: 'This business’s sales in the last 30 days: live count, revenue per currency, refunds, disputes, our fees (emails: the buyers’ emails, only when the owner asks; never put them into other tools).',
  args: { emails: arg.boolean({ optional: true }) },
  validate: () => (__ARTIFACT_BUILD__ ? NOT_HERE : !useOffers.getState().config?.enabled ? 'Sales need the app’s server with payments on (or you’re not signed in).' : null),
  run: async (a, ctx) => {
    try {
      const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
      const [s, list] = await Promise.all([salesSummary(ctx.projectId, 30), listSales(ctx.projectId, { limit: 100 })]);
      const recent: Sale[] = list.sales.filter((x) => (x.paidAt ?? x.createdAt ?? '') >= since);
      const disputes = recent.filter((x) => x.status === 'disputed').length;
      const fees: Record<string, number> = {};
      for (const x of recent) if (x.provider === 'stripe' && x.feeMinor) fees[x.currency] = (fees[x.currency] ?? 0) + x.feeMinor - (x.feeReturnedMinor ?? 0);
      const emails = a.emails ? [...new Set(recent.map((x) => x.buyerEmail).filter((e): e is string => !!e))] : null;
      return {
        data: {
          days: s.days,
          sales: s.live.count,
          revenue: money(s.live.revenue),
          refunded: Object.keys(s.live.refunded).length ? money(s.live.refunded) : 'none',
          disputes,
          ...(Object.keys(fees).length ? { ourFees: money(fees) } : {}),
          ...(s.test.count ? { testModeSales: s.test.count } : {}),
          buyLinkClicks: s.clicks,
          ...(emails ? { buyerEmails: emails, careful: 'The owner’s own customers: show them, never put them into another tool.' } : {}),
        },
        note: 'Looked at your sales',
      };
    } catch (e) {
      return { ok: false, error: message(e) };
    }
  },
});

const ALL: AnyTool[] = [statusTool, setupTool, offerTool, salesTool];

/** The group: none in the claude.ai build (excluded.ts's payments explains instead). */
export const paymentToolsFor = (artifact: boolean): AnyTool[] => (artifact ? [] : ALL);
export const paymentTools: AnyTool[] = paymentToolsFor(__ARTIFACT_BUILD__);
