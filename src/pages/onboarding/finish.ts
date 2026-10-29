import type { PostPlatform, Project } from '@/lib/types';
import { slugify } from '@/lib/utils';
import { newSkill, parseDirectives } from '@/ai/brain';
import { FORMATS, matchBusinessType, POST_PLATFORMS } from '@/ai/knowledge';
import { generateListing } from '@/ai/local/studio';
import { useStore } from '@/store/useStore';
import { defaultStudio } from '@/store/defaults';

/** Finalize a wizard project: fill studio + listing defaults, seed the Brain with a brand-voice skill. */
export function finishOnboarding(projectId: string): void {
  const s = useStore.getState();
  const p = s.projects.find((x) => x.id === projectId);
  if (!p) return;
  const brandName = p.brand.name.trim() || p.idea?.title || 'My Brand';
  const slug = p.brand.slug || slugify(brandName);
  const draft: Project = {
    ...p,
    brand: { ...p.brand, name: brandName, slug, websiteUrl: p.brand.websiteUrl || `https://${slug}.com` },
  };
  const listing = generateListing(draft);
  const blank = defaultStudio().listing;
  const fmt = p.format ? FORMATS[p.format] : null;
  const bt = p.track === 'business' ? matchBusinessType(`${p.businessType} ${p.category} ${p.niche}`) : null;
  const price = p.studio.price || p.idea?.price || (fmt ? Math.round((fmt.price[0] + fmt.price[1]) / 2) : bt ? Math.round((bt.services[1].price[0] + bt.services[1].price[1]) / 2) : 49);
  const socialPlatforms = (Object.keys(p.brand.socials) as PostPlatform[]).filter((k) => POST_PLATFORMS.includes(k) && (p.brand.socials[k] ?? '').trim());
  const platforms: PostPlatform[] = socialPlatforms.length ? socialPlatforms.slice(0, 3) : p.track === 'business' ? ['instagram', 'facebook'] : ['instagram', 'tiktok'];

  s.updateProject(projectId, (cur) => ({
    ...cur,
    onboarded: true,
    wizardStep: 'done',
    brand: draft.brand,
    studio: {
      ...cur.studio,
      price,
      priceModel: p.idea?.priceModel ?? fmt?.model ?? 'one-time',
      outlineLabel: fmt?.outlineLabel ?? 'Business model',
      // keep only listing fields the user changed from the blank defaults (e.g. bookingType 'buy')
      listing: { ...listing, ...Object.fromEntries(Object.entries(cur.studio.listing).filter(([k, v]) => (Array.isArray(v) ? v.length : !!v) && v !== (blank as unknown as Record<string, unknown>)[k])) },
    },
    marketing: { ...cur.marketing, campaign: { ...cur.marketing.campaign, platforms } },
  }));

  const voiceId = `brand-voice-${projectId}`;
  if (!s.skills.some((k) => k.libraryId === voiceId)) {
    const b = draft.brand;
    const instructions = [
      `Write as ${b.name}. Personality: ${b.personality.length ? b.personality.join(', ') : 'warm, clear, practical'}.`,
      b.audience ? `Audience: ${b.audience}` : '',
      b.valueProp ? `Value proposition: ${b.valueProp}` : '',
      b.tagline ? `Tagline: “${b.tagline}”` : '',
      p.location?.city ? `Mention ${p.location.city} when it feels natural.` : '',
    ]
      .filter(Boolean)
      .join('\n');
    s.addSkill(
      newSkill({
        name: `${b.name} brand voice`,
        category: 'voice',
        description: 'Created from your brand kit during setup. Edit it to sharpen every output.',
        instructions,
        scope: ['all'],
        priority: 2,
        source: 'custom',
        libraryId: voiceId,
        directives: { tone: parseDirectives(b.personality.join(' ')).tone },
      }),
    );
  }
  s.notify({ kind: 'ai', title: `${brandName} is ready`, body: 'Your Brain now knows your brand voice.', route: 'brain' });
}
