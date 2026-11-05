import type { CSSProperties, ReactNode } from 'react';
import type { EmailStep, Project, Subscriber } from '@/lib/types';
import { ensureUrl, readableOn } from '@/lib/utils';
import { renderTokens } from '@/ai/local/email';
import { useStore } from '@/store/useStore';
import { BrandLogo } from '@/components/brand/Logo';

/** A panel's title row: the title and its line on the left, the actions on the right. Unlike Section's own row it
 *  wraps, so on a phone the actions go under the title instead of squeezing it into a column one word wide. */
export function PanelHead({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0 flex-1 basis-72">
        <h2 className="text-h2 text-ink">{title}</h2>
        {description && <p className="mt-1 text-small text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Merge values for previews: a real subscriber's, or clear placeholders (never invented people or sites). */
export function emailTokens(p: Project, sub?: Pick<Subscriber, 'name' | 'email'> | null): Record<string, string> {
  const site = p.brand.websiteUrl ? ensureUrl(p.brand.websiteUrl).replace(/\/$/, '') : '';
  const profile = useStore.getState().settings.profile;
  return {
    first_name: sub?.name ? sub.name.split(' ')[0] : '[First name]',
    email: sub?.email || '[subscriber’s email]',
    lead_magnet_link: site ? `${site}/free` : '[link to your free download]',
    product_link: site ? `${site}/${p.marketing.seo?.slug || 'offer'}` : '[link to your offer]',
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
        {email.ctaLabel && (
          <span style={{ display: 'inline-block', marginTop: 20, borderRadius: 8, padding: '10px 20px', fontSize: 14, fontWeight: 700, background: c.primary, color: readableOn(c.primary) }}>{renderTokens(email.ctaLabel, tokens)}</span>
        )}
        <p style={{ marginTop: 24, borderTop: `1px solid ${RULE}`, paddingTop: 12, fontSize: 11, lineHeight: '16px', color: FINE }}>
          You’re receiving this because you signed up at {tokens.lead_magnet_link.replace(/^https?:\/\//, '')}. Unsubscribe anytime.
        </p>
      </div>
    </div>
  );
}
