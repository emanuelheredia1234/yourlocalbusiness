import type { EmailStep, Project, Subscriber } from '@/lib/types';
import { createRng, ensureUrl, hashStr, readableOn, uid } from '@/lib/utils';
import { renderTokens } from '@/ai/local/email';
import { getActiveProject, useStore } from '@/store/useStore';
import { BrandLogo } from '@/components/brand/Logo';

export function emailTokens(p: Project, sub?: Pick<Subscriber, 'name' | 'email'> | null): Record<string, string> {
  const site = ensureUrl(p.brand.websiteUrl || `${p.brand.slug || 'yourbrand'}.com`).replace(/\/$/, '');
  const profile = useStore.getState().settings.profile;
  return {
    first_name: (sub?.name || 'Alex').split(' ')[0],
    email: sub?.email || 'alex@example.com',
    lead_magnet_link: `${site}/free`,
    product_link: `${site}/${p.marketing.seo?.slug || 'offer'}`,
    sender_name: profile.name || p.brand.name,
    brand: p.brand.name,
  };
}

export function addSubscriber(name: string, email: string, source: Subscriber['source']): Subscriber {
  const sub: Subscriber = { id: uid('sub'), name: name.trim() || email.split('@')[0], email: email.trim().toLowerCase(), joinedAt: Date.now(), source, step: 0, opened: [], clicked: [] };
  const s = useStore.getState();
  s.updateMarketing({ subscribers: [sub, ...getActiveProject()!.marketing.subscribers] });
  s.notify({ kind: 'lead', title: source === 'test' ? `Test subscriber added: ${sub.name}` : `New subscriber: ${sub.name}`, body: sub.email, route: 'marketing-email' });
  return sub;
}

export function patchSubscriber(id: string, patch: Partial<Subscriber>) {
  const subs = getActiveProject()!.marketing.subscribers;
  useStore.getState().updateMarketing({ subscribers: subs.map((s) => (s.id === id ? { ...s, ...patch } : s)) });
}

/** Deterministic simulated engagement for one subscriber + email (demo only). */
export function simulatedEngagement(sub: Subscriber, step: number): { open: boolean; click: boolean; convert: boolean } {
  const rng = createRng(hashStr(`${sub.id}|${step}`));
  const openP = [0.92, 0.74, 0.66, 0.6, 0.58][step - 1] ?? 0.5;
  const clickP = [0.55, 0.32, 0.28, 0.24, 0.3][step - 1] ?? 0.2;
  const open = rng.chance(openP);
  const click = open && rng.chance(clickP);
  const convert = step === 5 && click && rng.chance(0.45);
  return { open, click, convert };
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
            <b className="text-[#1d2420]">{project.brand.name}</b> &lt;hello@{(project.brand.slug || 'brand').replace(/[^a-z0-9-]/gi, '')}.com&gt;
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
