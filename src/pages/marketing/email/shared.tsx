import type { CSSProperties, ReactNode } from 'react';
import type { EmailStep, Project, Subscriber } from '@/lib/types';
import { readableOn } from '@/lib/utils';
import { pageLink } from '@/lib/pageLink';
import { renderTokens } from '@/ai/local/email';
import { useStore } from '@/store/useStore';
import { BrandLogo } from '@/components/brand/Logo';

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
  };
}

// The email as a subscriber's inbox shows it: the business's content, so its colours are the email's own
// (a white message in both themes), not the app's.
const INK = '#1d2420';
const META = '#5b6861';
const RULE = '#e6ebe8';
const FINE = '#8a968f';
const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

/** An email rendered the way a subscriber’s inbox shows it. */
export function EmailView({ project, email, tokens, compact }: { project: Project; email: EmailStep; tokens: Record<string, string>; compact?: boolean }) {
  const c = project.brand.colors;
  const body = renderTokens(email.body, tokens);
  const label = renderTokens(email.ctaLabel, tokens);
  const href = webHref(renderTokens(email.ctaUrl, tokens));
  const button: CSSProperties = { display: 'inline-block', marginTop: 20, borderRadius: 8, padding: '10px 20px', fontSize: 14, fontWeight: 700, background: c.primary, color: readableOn(c.primary), textDecoration: 'none' };
  const where = signedUpAt(project);
  const row: CSSProperties = { fontSize: 13, lineHeight: '20px', color: META };
  return (
    <div className="overflow-hidden" style={{ background: '#ffffff', color: INK, fontFamily: FONT }}>
      {!compact && (
        <div style={{ borderBottom: `1px solid ${RULE}`, padding: '12px 20px' }}>
          <p style={row}>
            <span style={{ display: 'inline-block', width: 56, color: FINE }}>From</span>
            <b style={{ color: INK, fontWeight: 600 }}>{project.brand.name}</b> &lt;{tokens.sender_email}&gt;
          </p>
          <p style={row}>
            <span style={{ display: 'inline-block', width: 56, color: FINE }}>To</span>
            {tokens.email}
          </p>
          <p style={{ ...row, marginTop: 4, fontSize: 16, lineHeight: '24px', fontWeight: 600, color: INK }}>{renderTokens(email.subject, tokens)}</p>
        </div>
      )}
      <div style={{ padding: '20px 24px 22px' }}>
        <div style={{ marginBottom: 16, color: c.ink }}>
          <BrandLogo brand={project.brand} size={26} layout="horizontal" />
        </div>
        <div className="whitespace-pre-line" style={{ fontSize: 14, lineHeight: 1.65 }}>
          {body}
        </div>
        {email.ctaLabel &&
          (href ? (
            <a href={href} target="_blank" rel="noopener noreferrer" aria-label={`${label} (opens in a new tab)`} className="focus-visible:shadow-focus outline-none" style={button}>
              {label}
            </a>
          ) : (
            <span aria-disabled="true" title={missingLinkFix(project, email.ctaUrl, 'short')} style={{ ...button, cursor: 'not-allowed' }}>
              {label}
            </span>
          ))}
        <p style={{ marginTop: 24, borderTop: `1px solid ${RULE}`, paddingTop: 12, fontSize: 11, lineHeight: '16px', color: FINE }}>
          You’re receiving this because you signed up at {where}. Unsubscribe anytime.
        </p>
      </div>
    </div>
  );
}

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
