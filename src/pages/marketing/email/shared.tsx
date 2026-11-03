import type { EmailStep, Project, Subscriber } from '@/lib/types';
import { ensureUrl, readableOn, uid } from '@/lib/utils';
import { renderTokens } from '@/ai/local/email';
import { getActiveProject, useStore } from '@/store/useStore';
import { BrandLogo } from '@/components/brand/Logo';

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

/** Add subscribers you imported (skipping emails already on the list). Returns how many were added. */
export function importSubscribers(rows: { name: string; email: string }[]): number {
  const s = useStore.getState();
  const current = getActiveProject()!.marketing.subscribers;
  const have = new Set(current.map((x) => x.email.toLowerCase()));
  const now = Date.now();
  const added: Subscriber[] = [];
  for (const r of rows) {
    const email = r.email.trim().toLowerCase();
    if (!email || have.has(email)) continue;
    have.add(email);
    added.push({ id: uid('sub'), name: r.name.trim() || email.split('@')[0], email, joinedAt: now, source: 'import' });
  }
  if (added.length) s.updateMarketing({ subscribers: [...added, ...current] });
  return added.length;
}

/** An email rendered the way a subscriber’s inbox shows it. */
export function EmailView({ project, email, tokens, compact }: { project: Project; email: EmailStep; tokens: Record<string, string>; compact?: boolean }) {
  const c = project.brand.colors;
  const body = renderTokens(email.body, tokens);
  return (
    <div className="overflow-hidden rounded-md border border-line bg-white text-[#1d2420]" style={{ fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif' }}>
      {!compact && (
        <div className="border-b border-[#e6ebe8] px-4 py-3 text-[12.5px] text-[#5b6861]">
          <p>
            <b className="text-[#1d2420]">{project.brand.name}</b> &lt;{tokens.sender_email}&gt;
          </p>
          <p>To: {tokens.email}</p>
          <p className="mt-1 text-[15px] font-semibold text-[#1d2420]">{renderTokens(email.subject, tokens)}</p>
        </div>
      )}
      <div className="px-5 py-5">
        <div className="mb-4" style={{ color: c.ink }}>
          <BrandLogo brand={project.brand} size={26} layout="horizontal" />
        </div>
        <div className="whitespace-pre-line text-[14px] leading-relaxed">{body}</div>
        {email.ctaLabel && (
          <span className="mt-5 inline-block rounded-md px-5 py-2.5 text-[14px] font-bold" style={{ background: c.primary, color: readableOn(c.primary) }}>
            {renderTokens(email.ctaLabel, tokens)}
          </span>
        )}
        <p className="mt-6 border-t border-[#e6ebe8] pt-3 text-[11px] text-[#8a968f]">
          You’re receiving this because you signed up at {tokens.lead_magnet_link.replace(/^https?:\/\//, '')}. Unsubscribe anytime.
        </p>
      </div>
    </div>
  );
}

export function delayLabel(e: EmailStep, i: number): string {
  const v = e.delay.value;
  if (!v) return i === 0 ? 'Immediately after sign-up' : 'Right after the previous email';
  const unit = v === 1 ? e.delay.unit.replace(/s$/, '') : e.delay.unit;
  return `${v} ${unit} after ${i === 0 ? 'sign-up' : `email ${i}`}`;
}
