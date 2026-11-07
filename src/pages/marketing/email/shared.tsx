import type { ReactNode } from 'react';
import type { Project, Subscriber } from '@/lib/types';
import { pageLink } from '@/lib/pageLink';
import { useStore } from '@/store/useStore';
import { buyLinksOf } from '@/store/offers';

/** A panel's title row: the title and its line on the left, the actions on the right. Unlike Section's own row it
 *  wraps, so on a phone the actions go under the title instead of squeezing it into a column one word wide. */
export function PanelHead({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0 flex-1 basis-60">
        <h2 className="text-h2 text-ink">{title}</h2>
        {description && <p className="mt-1 text-small text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/**
 * Merge values for previews and drafts: a real subscriber's, or clear placeholders (never invented people or sites).
 * The lead magnet's link is its published download on the app's address (https://<app>/m/<id>), which always serves
 * it: a domain's copy works only while that domain stays verified and this account's, so an email (which can't be
 * changed once sent) never uses it. The offer's is the page posts link to (pageLink: the published SEO page, else
 * the website).
 */
export function emailTokens(p: Project, sub?: Pick<Subscriber, 'name' | 'email'> | null): Record<string, string> {
  const profile = useStore.getState().settings.profile;
  const d = p.marketing.leadMagnet?.delivery;
  return {
    first_name: sub?.name ? sub.name.split(' ')[0] : '[First name]',
    email: sub?.email || '[subscriber’s email]',
    lead_magnet_link: d?.link || '[link to your free download]',
    product_link: pageLink(p)?.url ?? '[link to your offer]',
    sender_name: profile.name || p.brand.name,
    sender_email: profile.email || 'your sending address',
    brand: p.brand.name,
    // each of the business's offers: buy:<id> → its full buy link (an id that isn't one stays as typed)
    ...buyLinksOf(p.id),
  };
}

/** Whether a text still has a buy link that isn't one of the business's offers (after its tokens were filled in). */
export const hasUnknownBuyLink = (text: string): boolean => /\{\{\s*buy:/.test(text);

const usesToken = (raw: string, name: string) => new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`).test(raw);

/**
 * What to do when an email's button has no web address yet, by what its link is: the lead magnet's (publish the
 * download), the offer's (a website or a published page), or the owner's own (type a full link). short: for a
 * tooltip; else a sentence for a notice.
 */
export function missingLinkFix(project: Project, ctaUrl: string, form: 'short' | 'long' = 'long'): string {
  if (usesToken(ctaUrl, 'lead_magnet_link') && !project.marketing.leadMagnet?.delivery?.link) return form === 'short' ? 'Publish your download in Email › Lead magnet › Delivery' : 'Publish your download in Email › Lead magnet › Delivery first: this button links to it.';
  if (usesToken(ctaUrl, 'product_link') && !pageLink(project)) return form === 'short' ? 'Add your website in Settings › Brand, or publish your page' : 'Add your website in Settings › Brand, or a full https:// link as its Button link in Sequence.';
  return form === 'short' ? 'Add a link in Sequence › Button link' : 'Add a full https:// link as its Button link in Sequence.';
}

/** A button's address when it's a real web address (http or https with a host), else '' (a placeholder, a bad link). */
export function webHref(raw: string): string {
  const t = raw.trim();
  if (!/^https?:\/\//i.test(t)) return '';
  try {
    const u = new URL(t);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname.includes('.') && !u.username ? u.toString() : '';
  } catch {
    return '';
  }
}

/** Where subscribers signed up, for the footer: the host of the page posts link to, else the brand's name. */
export function signedUpAt(project: Project): string {
  const link = pageLink(project);
  if (link) {
    try {
      return new URL(link.url).host;
    } catch {
      /* fall through */
    }
  }
  return project.brand.name || 'our website';
}
