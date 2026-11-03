import { describe, expect, it } from 'vitest';
import { newProject } from '@/store/defaults';
import type { Project } from '@/lib/types';
import { buildFacts, voiceFor } from './text';

function project(websiteUrl = ''): Project {
  const p = newProject('business', 'new');
  p.businessType = 'House cleaning';
  p.niche = 'House cleaning';
  p.brand = { ...p.brand, name: 'Sparkle Co', slug: 'sparkle-co', websiteUrl };
  return p;
}

describe('website facts and CTAs', () => {
  it('never makes up a domain when the owner has no website', () => {
    const f = buildFacts(project());
    expect(f.url).toBe('');
    expect(f.urlDisplay).toBe('');
    expect(f.mark).toBe('Sparkle Co');
    for (let i = 0; i < 20; i++) {
      for (const kind of ['link', 'buy', 'book'] as const) {
        const cta = voiceFor(project(), {}, `seed-${i}`).cta(kind, 'facebook');
        expect(cta).not.toMatch(/sparkle-?co\.com|yourbrand\.com|\.com/);
        expect(cta).toMatch(/link in bio/);
      }
    }
  });

  it('points to the owner’s real website when there is one', () => {
    const p = project('https://sparkle-cleaning.net');
    const f = buildFacts(p);
    expect(f.url).toBe('https://sparkle-cleaning.net');
    expect(f.urlDisplay).toBe('sparkle-cleaning.net');
    expect(f.mark).toBe('sparkle-cleaning.net');
    expect(voiceFor(p, {}, 'x').cta('book', 'facebook')).toContain('sparkle-cleaning.net');
    // Instagram and TikTok never get a URL in the caption
    expect(voiceFor(p, {}, 'x').cta('book', 'instagram')).toContain('link in bio');
  });

  it('adds “link in bio” to the owner’s own CTA only when there is no link to give', () => {
    expect(voiceFor(project(), { cta: 'Book this week' }, 'x').cta('book', 'facebook')).toBe('Book this week (link in bio)');
    expect(voiceFor(project(), { cta: 'Tap the link in bio' }, 'x').cta('book', 'facebook')).toBe('Tap the link in bio');
    expect(voiceFor(project('sparkle-cleaning.net'), { cta: 'Book this week' }, 'x').cta('book', 'facebook')).toBe('Book this week sparkle-cleaning.net');
  });
});
