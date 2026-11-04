// Paid ads plans apart from their page: where the ads send people, the plan as text and as a CSV for an
// ads manager, and how an AI answer is applied. Shared by Marketing → Paid ads and the assistant, so both
// do exactly the same. The app never runs or pays for ads: these are plans the owner takes to each platform.

import type { AdCampaign, Project } from './types';
import { ensureUrl, fmtMoney } from './utils';
import { AD_OBJECTIVES, type AdsResult } from '@/ai/local/ads';
import { useStore } from '@/store/useStore';

/** The buttons an ad can have (the ads managers' own choices). */
export const AD_CTAS = ['Learn More', 'Shop Now', 'Book Now', 'Sign Up', 'Download', 'Get Quote', 'Contact Us', 'Get Offer'];

const csvCell = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;

/** Where the ads send people: the URL you entered for this campaign, else your website or your own buy/book
 *  link. '' until there is one (never made up). */
export function adFinalUrl(c: AdCampaign, p: Project): string {
  return ensureUrl(c.finalUrl ?? (p.brand.websiteUrl || p.studio.listing.buyUrl || ''));
}

/** Everything to paste into an ads manager, as plain text. */
export function adsText(c: AdCampaign, finalUrl = ''): string {
  const picked = c.creatives.filter((x) => c.selectedCreativeIds.includes(x.id));
  const lines = [`${c.name}`, `Objective: ${AD_OBJECTIVES.find((o) => o.id === c.objective)?.label ?? c.objective}`, `Final URL: ${finalUrl || '[add the page your ads link to]'}`, `Budget: ${fmtMoney(c.dailyBudget)}/day for ${c.durationDays} days (${fmtMoney(c.dailyBudget * c.durationDays)} total)`, `Location: ${c.locations}${c.radiusMi ? ` (+${c.radiusMi} mi)` : ''} · Ages ${c.ageMin}–${c.ageMax}`, c.interests.length ? `Interests: ${c.interests.join(', ')}` : '', ''];
  for (const a of c.audiences) lines.push(`Audience: ${a.name}`, `  ${a.description}`, a.interests.length ? `  ${a.interests.join(', ')}` : '', '');
  for (const cr of picked) lines.push(`Ad ${cr.variant}: ${cr.angle}`, `  Primary text: ${cr.primaryText}`, `  Headline: ${cr.headline}`, `  Description: ${cr.description}`, `  Button: ${cr.cta}`, '');
  if (c.search) lines.push('Google search ads', ...c.search.headlines.map((h) => `  Headline: ${h}`), ...c.search.descriptions.map((d) => `  Description: ${d}`), `  Keywords: ${c.search.keywords.join(', ')}`, ...c.search.sitelinks.map((l) => `  Sitelink: ${l.title}: ${l.desc}`), '');
  return lines.filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n').trim();
}

/** The ads as a CSV: one row per creative (and per search headline and description). */
export function adsCsv(c: AdCampaign, finalUrl = ''): string {
  const rows = [['type', 'variant', 'angle', 'primary_text', 'headline', 'description', 'button', 'final_url']];
  for (const cr of c.creatives.filter((x) => c.selectedCreativeIds.includes(x.id))) rows.push(['social', cr.variant, cr.angle, cr.primaryText, cr.headline, cr.description, cr.cta, finalUrl]);
  if (c.search) {
    for (const h of c.search.headlines) rows.push(['search headline', '', '', '', h, '', '', finalUrl]);
    for (const d of c.search.descriptions) rows.push(['search description', '', '', '', '', d, '', finalUrl]);
    for (const k of c.search.keywords) rows.push(['keyword', '', '', '', k, '', '', '']);
  }
  return rows.map((r) => r.map(csvCell).join(',')).join('\n');
}

/** A campaign as it is now (null once it's deleted). */
export const adById = (id: string): AdCampaign | null => useStore.getState().ads.find((a) => a.id === id) ?? null;

/** Change a campaign as it is now (a deleted one stays deleted). */
export function patchAd(id: string, patch: Partial<AdCampaign>): AdCampaign | null {
  const live = adById(id);
  if (!live) return null;
  const next = { ...live, ...patch };
  useStore.getState().upsertAd(next);
  return next;
}

/**
 * An AI answer for a campaign (Generate audiences & creatives): new audiences, creatives and search ads, all
 * creatives picked; the owner's own interests stay, and the AI's are used only when there were none.
 */
export function applyAds(id: string, r: AdsResult): AdCampaign | null {
  const live = adById(id);
  if (!live) return null;
  return patchAd(id, { audiences: r.audiences, interests: live.interests.length ? live.interests : r.interests, creatives: r.creatives, search: r.search, selectedCreativeIds: r.creatives.map((x) => x.id) });
}
