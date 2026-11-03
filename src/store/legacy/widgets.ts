// Older versions of the Code tab's widgets told real site visitors things that weren't true: forms said
// "Check your inbox… We just sent" and bookings said "You're booked… a confirmation is on its way" while
// nothing was sent; about 1 in 4 booking slots was randomly "taken"; a countdown ran to "now + 7 days"
// "before the price goes up"; heroes showed "★★★★★ Loved by…"; carousels had invented customers; quote
// calculators showed a made-up "Next available" date; pricing tables promised "Lifetime updates".
// The owner may have edited or pasted that code anywhere, so it can't be patched safely. This only flags
// those assets as outdated (the Code tab shows "Outdated: regenerate") and never touches their code.
// An asset that already has `outdated` set (flagged, regenerated or dismissed) is left alone, so running
// this again changes nothing.

import type { CodeAsset, Project } from '@/lib/types';

/** Whether an asset still carries what older versions made up. */
export function isOutdatedWidget(a: CodeAsset): boolean {
  const html = String(a.html ?? '');
  const js = String(a.js ?? '');
  const all = `${html}\n${js}`;
  switch (a.kind) {
    // forms: current versions send through FORM_ACTION and say when they're not connected
    case 'leadform':
    case 'booking':
      return !js.includes('FORM_ACTION');
    // current countdowns only run to an END_DATE the owner set
    case 'countdown':
      return !js.includes('END_DATE');
    // current carousels show the owner's quotes or obvious [Customer quote] placeholders
    case 'testimonials':
      return !html.includes('[Customer quote]') && !html.includes('What customers say');
    case 'hero':
      return /★|loved by|trusted by|\brated\b|\breviews?\b/i.test(html);
    case 'calculator':
    case 'roi':
      return all.includes('Next available');
    case 'pricing':
      return /Lifetime updates|save 20%/i.test(html);
    case 'faq':
      return /We confirm within one business day|Instant access after checkout/.test(html);
    default:
      return false;
  }
}

/** The project with outdated widgets flagged, or null when there's nothing to change. */
export function purgeCodeAssets(p: Project): Project | null {
  const list = Array.isArray(p.studio?.codeAssets) ? p.studio.codeAssets : [];
  const flag = (a: CodeAsset) => !!a && typeof a === 'object' && !('outdated' in a) && isOutdatedWidget(a);
  if (!list.some(flag)) return null;
  return { ...p, studio: { ...p.studio, codeAssets: list.map((a) => (flag(a) ? { ...a, outdated: true } : a)) } };
}
