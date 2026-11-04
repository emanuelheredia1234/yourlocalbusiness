// The SEO page builder's choice of page type (six radio cards), and the links each type's buttons open: the
// owner's own booking or payment link, typed here for this page (the app never takes payments).
import { useId } from 'react';
import { CalendarCheck, CreditCard, Globe, LayoutGrid, MessageSquareText, PanelTop, type LucideIcon } from 'lucide-react';
import type { PageType, Project } from '@/lib/types';
import { cn } from '@/lib/utils';
import { PAGE_TYPES, PAGE_TYPE_DESC, PAGE_TYPE_LABEL, PAGE_TYPE_LINKS, bookingLink, linkFromListing, paymentLink, webLink } from '@/lib/pageTypes';
import { useStore } from '@/store/useStore';

const ICONS: Record<PageType, LucideIcon> = { lead: MessageSquareText, booking: CalendarCheck, website: Globe, landing: PanelTop, showcase: LayoutGrid, checkout: CreditCard };

/** The six page types as radio cards: a fieldset with a legend, so arrow keys move between them and screen readers hear one group. */
export function PageTypePicker({ value, onChange, disabled, compact }: { value: PageType; onChange: (t: PageType) => void; disabled?: boolean; compact?: boolean }) {
  const name = useId();
  return (
    <fieldset className="min-w-0" disabled={disabled}>
      <legend className="label">What kind of page?</legend>
      <div className={cn('grid grid-cols-1 gap-2 sm:grid-cols-2', !compact && 'lg:grid-cols-3')}>
        {PAGE_TYPES.map((t) => {
          const Icon = ICONS[t];
          const on = value === t;
          return (
            <label
              key={t}
              className={cn(
                'flex cursor-pointer gap-2.5 rounded-md border p-3 text-left transition-colors has-[:focus-visible]:shadow-focus',
                on ? 'border-primary bg-primary-soft' : 'border-line hover:border-line-2 hover:bg-surface-2',
                disabled && 'cursor-not-allowed opacity-60',
              )}
            >
              <input type="radio" name={name} value={t} checked={on} onChange={() => onChange(t)} className="sr-only" aria-describedby={`${name}-${t}`} />
              <Icon size={16} className={cn('mt-0.5 shrink-0', on ? 'text-primary' : 'text-muted')} aria-hidden="true" />
              <span className="min-w-0">
                <span className="block text-small font-semibold text-ink">{PAGE_TYPE_LABEL[t]}</span>
                <span id={`${name}-${t}`} className="mt-0.5 block text-caption leading-snug text-muted">
                  {PAGE_TYPE_DESC[t]}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

/** The price a checkout page shows: the pricing card's, else the price it would start with. */
function checkoutPrice(project: Project): number {
  const card = project.marketing.salesPage?.sections.find((s) => s.type === 'pricing');
  if (card?.type === 'pricing') return card.data.price;
  if (project.track === 'business') {
    const pkg = project.studio.packages.find((p) => p.popular) ?? project.studio.packages[0];
    return pkg?.price ?? 0;
  }
  return project.studio.price;
}

function LinkField({ id, label, value, onChange, hint, required }: { id: string; label: string; value: string; onChange: (v: string) => void; hint: string; required?: boolean }) {
  const error = value.trim() && !webLink(value) ? 'Use a web address, like https://buy.stripe.com/…' : '';
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="label">
        {label}
      </label>
      <input
        id={id}
        className="input"
        type="url"
        inputMode="url"
        autoComplete="url"
        spellCheck={false}
        placeholder="https://"
        maxLength={500}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-required={required || undefined}
        aria-describedby={`${id}-note`}
      />
      <p id={`${id}-note`} className={error ? 'mt-1 text-caption font-medium text-bad' : 'hint'}>
        {error || hint}
      </p>
    </div>
  );
}

/** The link fields the type uses (booking, payment), saved to marketing.pageLinks of the active project. */
export function PageTypeLinks({ project, type }: { project: Project; type: PageType }) {
  const updateMarketing = useStore((s) => s.updateMarketing);
  const id = useId();
  const links = project.marketing.pageLinks ?? {};
  const kinds = PAGE_TYPE_LINKS[type];
  const set = (kind: 'booking' | 'payment', v: string) => {
    // the links as they are now: the other field may have changed since this render
    const cur = useStore.getState().projects.find((p) => p.id === project.id)?.marketing.pageLinks ?? {};
    updateMarketing({ pageLinks: { ...cur, [kind]: v.trim() || undefined } });
  };
  const notes: string[] = [];
  if (type === 'checkout' && checkoutPrice(project) <= 0) notes.push('Checkout pages show the price: set it in Studio, or type it on the page.');
  if (type === 'lead') notes.push(__ARTIFACT_BUILD__ ? 'Lead forms work on pages published from the app’s own site, not in claude.ai.' : 'What people send arrives in Email → Leads once the page is published.');
  if (!kinds.length && !notes.length) return null;

  const booking = bookingLink(project);
  const payment = paymentLink(project);
  const bookingHint = `${linkFromListing(project, 'booking') ? `Using your listing’s booking link (${hostOf(booking)}). Paste another to use it on this page only. ` : ''}Calendly, Square Appointments, Acuity or your own booking page. Book now opens it. Without one, the page has a “Request a time” form instead.`;
  const paymentHint = `${linkFromListing(project, 'payment') ? `Using your listing’s checkout link (${hostOf(payment)}). Paste another to use it on this page only. ` : ''}A Stripe Payment Link, Square, PayPal, Gumroad or Shopify checkout. Buy now opens it: the app never takes payments.${type === 'showcase' ? ' Without one, items marked Buy don’t show a button.' : ''}`;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {kinds.includes('booking') && <LinkField id={`${id}-booking`} label="Your booking link (optional)" value={links.booking ?? ''} onChange={(v) => set('booking', v)} hint={bookingHint} />}
      {kinds.includes('payment') && <LinkField id={`${id}-payment`} label={type === 'checkout' ? 'Your payment link' : 'Your payment link (optional)'} required={type === 'checkout'} value={links.payment ?? ''} onChange={(v) => set('payment', v)} hint={paymentHint} />}
      {notes.map((n) => (
        <p key={n} className="rounded-md border border-line bg-surface-2 px-3 py-2 text-caption text-ink-2">
          {n}
        </p>
      ))}
    </div>
  );
}
