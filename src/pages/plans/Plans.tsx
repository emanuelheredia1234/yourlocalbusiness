// #plans: the public plans page (Launch, Grow, Scale), signed out too. A monthly / annual switch (annual shows the
// saving), three cards, the comparison table from shared/plans.json, and the FAQ. Start → sign up → Stripe Checkout
// → back to the app (the plan is read again there). Signed in with a plan, the buttons switch plans instead.
//
// Not in the claude.ai artifact build, and not while the app's server hasn't set up Stripe ("not available here").

import { useState, type ReactNode } from 'react';
import { ArrowLeft, Check, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { navigate } from '@/lib/router';
import { PLANS, SHARED_FEATURES, TIERS, compareRows, creditsUsd, formatPrice, microUsd, monthsFree, planFor, tierRank, yearlySavings, type Interval, type Tier } from '@/lib/plans';
import { changeKind, changeRefusal, checkout, confirmPlanChange } from '@/lib/billing/actions';
import { useAuth, showSignIn } from '@/lib/cloud/auth';
import { hasLivePlan, savePlanIntent, useBilling, useBillingOn } from '@/store/billing';
import { useStore } from '@/store/useStore';
import { AppMark } from '@/components/layout/Shell';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger, Badge, Callout, Segmented, Spinner } from '@/components/ui/primitives';

// ───────────── the cards (also the in-app plan picker) ─────────────

export type CardAction = { label: string; disabled?: boolean; onClick?: () => void; note?: string };

/** The three plan cards. `action(tier)`: the card's button. */
export function PlanCards({ interval, action, busy }: { interval: Interval; action: (tier: Tier) => CardAction; busy?: Tier | null }) {
  const extra = PLANS.additionalBusiness.price;
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {TIERS.map((tier) => {
        const p = planFor(tier);
        const popular = tier === 'grow';
        const a = action(tier);
        const perMonth = interval === 'year' ? Math.round(p.price.year / 12) : p.price.month;
        return (
          <section key={tier} aria-label={p.name} className={cn('card flex flex-col gap-5 p-5 sm:p-6', popular && 'border-primary shadow-sm')}>
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-h2 text-ink">{p.name}</h2>
              {popular && <Badge tone="primary">Most popular</Badge>}
            </div>
            <div>
              <p className="num text-phone-kpi text-ink sm:text-kpi">
                {formatPrice(p.price[interval])}
                <span className="text-body text-muted">/{interval}</span>
              </p>
              <p className="mt-1 text-small text-muted">{interval === 'year' ? `${formatPrice(perMonth)} a month · save ${formatPrice(yearlySavings(tier))} a year` : `or ${formatPrice(p.price.year)} a year (${monthsFree(tier)} months free)`}</p>
            </div>
            <ul className="flex flex-1 flex-col gap-2 text-small text-ink-2">
              <Line>1 business included</Line>
              <Line>
                Each extra business {formatPrice(extra.month)}/mo · {formatPrice(extra.year)}/yr
              </Line>
              <Line>
                {p.aiCreditsPerMonth.toLocaleString('en-US')} AI credits a month (about {creditsUsd(p.aiCreditsPerMonth)} of AI)
              </Line>
              <Line>Video: {p.video.label}</Line>
              <Line off={!p.adsLaunch}>{p.adsLaunch ? 'Launch ads from the app' : 'Ads: plan and export (launch on Grow and Scale)'}</Line>
              <Line>{microUsd(p.treg.monthlyMicro)} a month of analytics updates</Line>
              <Line>{p.leadEmailsPerMonth.toLocaleString('en-US')} lead emails a month</Line>
              <Line>{p.publicListings} public Marketplace listings</Line>
              <Line>
                {p.customDomains} custom {p.customDomains === 1 ? 'domain' : 'domains'}
              </Line>
              <Line>{p.platformFeePct ? `${p.platformFeePct}% fee on your sales` : 'No fee on your sales'}</Line>
              <Line>{p.promptControl === 'per_prompt' ? 'Control every prompt' : 'Style notes for the AI'}</Line>
              <Line>{p.support === 'priority' ? 'Priority support' : 'Email support'}</Line>
            </ul>
            <div>
              <button type="button" className={cn('btn btn-lg w-full', popular ? 'btn-primary' : 'btn-secondary')} disabled={a.disabled || !!busy} onClick={a.onClick}>
                {busy === tier && <Spinner size={16} />} {a.label}
              </button>
              {a.note && <p className="mt-2 text-caption text-muted">{a.note}</p>}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function Line({ children, off }: { children: ReactNode; off?: boolean }) {
  return (
    <li className="flex items-start gap-2">
      {off ? <Minus size={16} className="mt-0.5 shrink-0 text-faint" aria-hidden="true" /> : <Check size={16} className="mt-0.5 shrink-0 text-good" aria-hidden="true" />}
      <span className="min-w-0">{children}</span>
    </li>
  );
}

export function IntervalSwitch({ value, onChange }: { value: Interval; onChange: (v: Interval) => void }) {
  return (
    <Segmented<Interval>
      aria-label="Billing period"
      value={value}
      onChange={onChange}
      options={[
        { id: 'month', label: 'Monthly' },
        { id: 'year', label: `Annual · ${monthsFree('grow')} months free` },
      ]}
    />
  );
}

// ───────────── what each card's button does ─────────────

/** The cards' buttons for whoever is looking: start (signed out or no plan), current plan, or switch. */
export function usePlanActions(interval: Interval): { action: (tier: Tier) => CardAction; busy: Tier | null } {
  const phase = useAuth((s) => s.phase);
  const plan = useBilling((s) => s.plan);
  const account = useBilling((s) => s.account);
  const used = useBilling((s) => s.businesses?.used ?? 0);
  const [busy, setBusy] = useState<Tier | null>(null);
  const live = hasLivePlan(plan, account);
  const run = (tier: Tier, fn: () => Promise<unknown>) => async () => {
    setBusy(tier);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };
  const action = (tier: Tier): CardAction => {
    const name = planFor(tier).name;
    if (phase === 'off') return { label: `Start with ${name}`, disabled: true, note: 'Plans need an account, and accounts are off on this server.' };
    if (phase !== 'ready') {
      // signed out (or a guest): remember the choice, create the account, then on to Stripe
      return {
        label: `Start with ${name}`,
        onClick: () => {
          savePlanIntent({ tier, interval });
          if (phase === 'guest') showSignIn();
          else void navigate('dashboard', { force: true });
        },
      };
    }
    if (plan?.plan === 'owner') return { label: 'Owner plan', disabled: true };
    // Checkout keeps every active business: more than one is charged as extra businesses, so the card says the total
    if (!live || account?.source !== 'stripe') return { label: `Start with ${name}`, onClick: run(tier, () => checkout(tier, interval)), ...(used > 1 ? { note: checkoutTotal(tier, interval, used) } : {}) };
    const kind = changeKind(account.tier, account.interval, tier, interval);
    if (kind === 'same') return { label: 'Current plan', disabled: true };
    if (kind === 'to_month') return { label: `Switch to ${name}`, disabled: true, note: 'Yearly to monthly happens at renewal: contact support.' };
    const refused = changeRefusal(kind, tier, account.pendingDowngrade ? plan?.tier : null);
    if (refused) return { label: `Switch to ${name}`, disabled: true, note: refused };
    return { label: `Switch to ${name}`, onClick: run(tier, () => confirmPlanChange(tier, interval)), ...(tierRank(tier) < tierRank(account.tier) && kind === 'downgrade' ? { note: 'Starts at your next renewal.' } : {}) };
  };
  return { action, busy };
}

/** "You have 4 businesses: $388/month in total ($97 + 3 × $97)." */
export function checkoutTotal(tier: Tier, interval: Interval, businesses: number): string {
  const base = planFor(tier).price[interval];
  const each = PLANS.additionalBusiness.price[interval];
  const extra = Math.max(0, businesses - 1);
  return `You have ${businesses} businesses: ${formatPrice(base + extra * each)}/${interval} in total (${formatPrice(base)} + ${extra} × ${formatPrice(each)}).`;
}

// ───────────── the page ─────────────

const FAQ: { q: string; a: ReactNode }[] = [
  { q: 'What is an AI credit?', a: 'About one cent of AI cost on the app’s keys: writing, images, video and research all use credits. Your plan’s credits renew each month. If you add your own AI keys in Settings, those requests never use credits.' },
  { q: 'How do extra businesses work?', a: `Each plan includes one business. Each extra one is ${formatPrice(PLANS.additionalBusiness.price.month)}/month (${formatPrice(PLANS.additionalBusiness.price.year)}/year on yearly plans) and adds ${PLANS.additionalBusiness.aiCreditsPerMonth.toLocaleString('en-US')} AI credits a month. Adding one charges the rest of the current period today; removing one takes effect at renewal, with no refund.` },
  { q: 'What happens if a payment fails?', a: `You keep full access for ${PLANS.graceDays} days while you update your card. After that, paid actions (AI on the app’s keys, posting, analytics updates, launching ads, publishing) pause until a payment goes through. Your work is never deleted.` },
  { q: 'What happens if I cancel?', a: `Your plan runs to the end of the period you paid for. Published pages keep working for ${PLANS.pagesAfterCancelDays} days after that, and your data is kept for ${PLANS.dataAfterCancelDays} days. Extra businesses are locked, never deleted: you can still open, read and export everything.` },
  { q: 'I already use the app. What changes for me?', a: `When plans start, existing accounts get ${PLANS.existingAccountTrial.days} days of ${planFor(PLANS.existingAccountTrial.tier).name} free, with every business they have. Then choose a plan; checkout keeps your businesses.` },
  { q: 'Can I switch plans?', a: 'Upgrades (and monthly to yearly) start right away and charge the prorated difference today. Downgrades start at your next renewal, and you keep your current plan until then. Yearly to monthly happens at renewal: contact support.' },
  { q: 'What about taxes?', a: 'Prices are in US dollars. Where sales tax or VAT applies, Stripe adds it at checkout and it shows on your invoice.' },
  { q: 'How do I pay and manage billing?', a: 'Securely with Stripe. Your card, invoices and cancelling are in Settings › Plan › Manage billing.' },
];

export default function PlansPage() {
  const on = useBillingOn();
  const phase = useAuth((s) => s.phase);
  const hasProject = useStore((s) => s.projects.length > 0);
  const [interval, setPeriod] = useState<Interval>('month');
  const { action, busy } = usePlanActions(interval);
  const rows = compareRows();
  const inApp = phase === 'ready' || phase === 'guest' || phase === 'off';

  return (
    <div className="min-h-full bg-surface">
      <header className="flex h-14 items-center gap-3 border-b border-line gutter" style={{ paddingTop: 'env(safe-area-inset-top, 0px)', boxSizing: 'content-box' }}>
        <AppMark size={24} />
        <span className="text-h4 text-ink">Yourlocalbusiness</span>
        <span className="ml-auto">
          {inApp ? (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void navigate(hasProject ? 'dashboard' : 'onboarding', { force: true })}>
              <ArrowLeft /> Back to the app
            </button>
          ) : (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void navigate('dashboard', { force: true })}>
              Sign in
            </button>
          )}
        </span>
      </header>

      <main className="mx-auto w-full max-w-[1200px] gutter pb-24 pt-10 sm:pt-14">
        {!on ? (
          <div className="mx-auto max-w-[560px]">
            <h1 className="text-phone-h1 text-ink sm:text-h1">Plans</h1>
            <Callout tone="info" className="mt-4">
              Plans aren’t available here.
            </Callout>
          </div>
        ) : (
          <>
            <div className="mx-auto max-w-[720px] text-center">
              <h1 className="text-phone-display text-ink sm:text-display">Plans for your local business</h1>
              <p className="mt-3 text-body-lg text-muted">Start with one business and add more any time. Pay securely with Stripe; cancel whenever you like.</p>
              <div className="mt-6 flex justify-center">
                <IntervalSwitch value={interval} onChange={setPeriod} />
              </div>
            </div>

            <div className="mt-10">
              <PlanCards interval={interval} action={action} busy={busy} />
            </div>
            <p className="mt-4 text-center text-small text-muted">Start → create your account → pay with Stripe → straight back to the app.</p>

            <section className="mt-16" aria-labelledby="compare-title">
              <h2 id="compare-title" className="text-h2 text-ink">
                Compare plans
              </h2>
              <div className="card mt-4 overflow-x-auto">
                <table className="w-full min-w-[560px] text-left text-small">
                  <thead>
                    <tr className="border-b border-line">
                      <th scope="col" className="px-4 py-3 font-medium text-muted">
                        <span className="sr-only">Feature</span>
                      </th>
                      {TIERS.map((t) => (
                        <th key={t} scope="col" className="px-4 py-3 text-h4 text-ink">
                          {planFor(t).name}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.label} className="border-b border-line last:border-b-0">
                        <th scope="row" className="px-4 py-2.5 font-normal text-ink-2">
                          {r.label}
                        </th>
                        {TIERS.map((t) => (
                          <td key={t} className="num px-4 py-2.5 text-ink">
                            <Cell value={r.values[t]} />
                          </td>
                        ))}
                      </tr>
                    ))}
                    {SHARED_FEATURES.map((f) => (
                      <tr key={f} className="border-b border-line last:border-b-0">
                        <th scope="row" className="px-4 py-2.5 font-normal text-ink-2">
                          {f}
                        </th>
                        {TIERS.map((t) => (
                          <td key={t} className="px-4 py-2.5">
                            <Cell value />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="mx-auto mt-16 max-w-[760px]" aria-labelledby="faq-title">
              <h2 id="faq-title" className="text-h2 text-ink">
                Questions
              </h2>
              <Accordion type="single" collapsible className="card mt-4 px-5">
                {FAQ.map((f, i) => (
                  <AccordionItem key={f.q} value={`q${i}`}>
                    <AccordionTrigger>{f.q}</AccordionTrigger>
                    <AccordionContent>
                      <p className="text-body text-ink-2">{f.a}</p>
                    </AccordionContent>
                  </AccordionItem>
                ))}
              </Accordion>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

function Cell({ value }: { value: string | boolean }) {
  if (value === true) return <Check size={16} className="text-good" aria-label="Included" />;
  if (value === false) return <Minus size={16} className="text-faint" aria-label="Not included" />;
  return <>{value}</>;
}

/**
 * The in-app plan picker: after sign-in, with plans on and no plan yet, before the first business (instead of the
 * setup). The same cards; Start goes straight to Stripe Checkout.
 */
export function PlanPickerScreen({ footer }: { footer?: ReactNode }) {
  const [interval, setPeriod] = useState<Interval>('month');
  const { action, busy } = usePlanActions(interval);
  return (
    <div className="min-h-full bg-surface">
      <header className="flex h-14 items-center gap-3 border-b border-line gutter" style={{ paddingTop: 'env(safe-area-inset-top, 0px)', boxSizing: 'content-box' }}>
        <AppMark size={24} />
        <span className="text-h4 text-ink">Yourlocalbusiness</span>
        {footer && <span className="ml-auto">{footer}</span>}
      </header>
      <main className="mx-auto w-full max-w-[1200px] gutter pb-24 pt-10">
        <div className="mx-auto max-w-[720px] text-center">
          <h1 className="text-phone-display text-ink sm:text-display">Pick your plan</h1>
          <p className="mt-3 text-body-lg text-muted">Then set up your first business. You’ll pay securely with Stripe.</p>
          <div className="mt-6 flex justify-center">
            <IntervalSwitch value={interval} onChange={setPeriod} />
          </div>
        </div>
        <div className="mt-10">
          <PlanCards interval={interval} action={action} busy={busy} />
        </div>
        <p className="mt-6 text-center text-small">
          <button type="button" className="link" onClick={() => void navigate('plans', { force: true })}>
            Compare plans and questions
          </button>
        </p>
      </main>
    </div>
  );
}
