// The SEO page builder's choice of page type (six option cards), and the links each type's buttons open: the
// owner's own booking or payment link, typed here for this page (the app never takes payments).
import { useId } from 'react';
import { CalendarCheck, Check, CircleAlert, CreditCard, Globe, LayoutGrid, MessageSquareText, PanelTop, type LucideIcon } from 'lucide-react';
import type { PageType, Project } from '@/lib/types';
import { cn } from '@/lib/utils';
import { PAGE_TYPES, PAGE_TYPE_DESC, PAGE_TYPE_LABEL, PAGE_TYPE_LINKS, bookingLink, linkFromListing, paymentLink, webLink } from '@/lib/pageTypes';
import { useStore } from '@/store/useStore';
import { InfoTip } from '@/components/ui/primitives';

const ICONS: Record<PageType, LucideIcon> = { lead: MessageSquareText, booking: CalendarCheck, website: Globe, landing: PanelTop, showcase: LayoutGrid, checkout: CreditCard };

/** Each type in one line (the full description is behind the ⓘ). */
const SHORT: Record<PageType, string> = {
  lead: 'A short pitch and a form for enquiries.',
  booking: 'Your services, prices and a Book button.',
  website: 'One page with a menu: services, about, contact.',
  landing: 'One offer and one call to action.',
  showcase: 'What you sell, each with a price and a button.',
  checkout: 'One offer with a Buy now button.',
};

/**
 * The six page types as option cards: real radio buttons in a fieldset with a legend, so arrow keys move
 * between them and screen readers hear one group. Selected: the iris ring and a check.
 */
export function PageTypePicker({ value, onChange, disabled, compact }: { value: PageType; onChange: (t: PageType) => void; disabled?: boolean; compact?: boolean }) {
  const name = useId();
  return (
    <fieldset className="min-w-0" disabled={disabled}>
      <legend className="label">What kind of page?</legend>
      <div className={cn('grid grid-cols-1 gap-3 sm:grid-cols-2', !compact && 'lg:grid-cols-3')}>
        {PAGE_TYPES.map((t) => {
          const Icon = ICONS[t];
          const on = value === t;
          return (
            <div key={t} className="relative min-w-0">
              <label
                className={cn(
                  'flex h-full cursor-pointer flex-col items-start rounded-lg border bg-surface text-left transition-[border-color,box-shadow,background-color] duration-120 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring',
                  compact ? 'gap-2.5 p-3' : 'gap-3 p-4',
                  on ? 'border-transparent bg-primary-soft/50 ring-[1.5px] ring-inset ring-primary' : 'border-line hover:border-line-3 hover:shadow-sm',
                  disabled && 'cursor-not-allowed bg-surface-2 hover:border-line hover:shadow-none',
                )}
              >
                <input type="radio" name={name} value={t} checked={on} onChange={() => onChange(t)} className="sr-only" aria-describedby={`${name}-${t}`} />
                <span className={cn('flex shrink-0 items-center justify-center bg-surface-3 text-ink-2', compact ? 'h-8 w-8 rounded-md' : 'h-10 w-10 rounded-pop')} aria-hidden="true">
                  <Icon size={compact ? 16 : 20} />
                </span>
                <span className="min-w-0 pr-7">
                  <span className={cn('block', compact ? 'text-h4' : 'text-h3', disabled ? 'text-faint' : 'text-ink')}>{PAGE_TYPE_LABEL[t]}</span>
                  <span id={`${name}-${t}`} className="mt-1 block text-small text-muted">
                    {SHORT[t]}
                  </span>
                </span>
              </label>
              {on && (
                <span className="pointer-events-none absolute right-3 top-3 flex h-[18px] w-[18px] items-center justify-center rounded-full bg-primary text-on-primary" aria-hidden="true">
                  <Check size={12} strokeWidth={3} />
                </span>
              )}
              <span className="absolute bottom-2 right-2">
                <InfoTip label={`About the ${PAGE_TYPE_LABEL[t].toLowerCase()}`}>{PAGE_TYPE_DESC[t]}</InfoTip>
              </span>
            </div>
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
      {error ? (
        <p id={`${id}-note`} className="mt-1.5 flex items-center gap-1.5 text-caption text-bad">
          <CircleAlert size={14} className="shrink-0" aria-hidden="true" />
          {error}
        </p>
      ) : (
        <p id={`${id}-note`} className="hint">
          {hint}
        </p>
      )}
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
        <p key={n} className="well px-3 py-2 text-small text-ink-2">
          {n}
        </p>
      ))}
    </div>
  );
}
