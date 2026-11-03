import { describe, expect, it } from 'vitest';
import { newProject } from '@/store/defaults';
import type { EmailStep, Listing, Post, Project } from '@/lib/types';
import { guessedWebsites, purgeListingWebsite, purgePostWebsite, purgeWebsite } from './domain';

/** A new brand as older versions saved it: a website made up from the name, used in the funnel copy. */
function oldProject(url = 'https://sparkleco.com'): Project {
  const p = newProject('business', 'new');
  p.brand = { ...p.brand, name: 'Sparkle Co', slug: 'sparkle-co', websiteUrl: url };
  p.marketing.leadMagnet = {
    id: 'lm1',
    type: 'checklist',
    title: 'The Spotless Home Checklist',
    subtitle: '',
    intro: '',
    sections: [],
    cta: 'Ready for the complete system? Sparkle Co → sparkleco.com',
    optInHeadline: '',
    optInBullets: [],
    buttonLabel: 'Send me the free checklist',
    createdAt: 1,
  } as Project['marketing']['leadMagnet'];
  p.marketing.emails = [
    { id: 'e1', index: 0, purpose: 'Welcome', subject: 'Your checklist', preview: 'Inside', body: 'Here it is.\n\nMore at https://sparkleco.com/blog.', delay: { value: 0, unit: 'minutes' }, ctaLabel: 'Get it', ctaUrl: '{{lead_magnet_link}}' },
    { id: 'e2', index: 1, purpose: 'Pitch', subject: 'Book a clean', preview: '', body: 'Book online.', delay: { value: 2, unit: 'days' }, ctaLabel: 'Book', ctaUrl: 'https://sparkleco.com/book' },
  ] as EmailStep[];
  return p;
}

function oldPost(p: Project, extra: Partial<Post> = {}): Post {
  return {
    id: 'post1',
    projectId: p.id,
    status: 'scheduled',
    platform: 'facebook',
    format: 'video',
    style: 'kinetic',
    postType: 'sales',
    headline: 'A spotless home',
    visualPrompt: 'Bold type. Brand colors #111 and #222, small watermark “sparkleco.com” bottom-right.',
    caption: 'Your weekend back.\n\nBook your spot → sparkleco.com',
    hashtags: [],
    scheduledAt: '2026-11-04T10:00:00.000Z',
    watermark: true,
    storyboard: [
      { id: 's1', text: 'A spotless home', shot: '', duration: 2 },
      { id: 's4', text: 'sparkleco.com', shot: '', duration: 3 },
    ],
    source: 'batch',
    createdAt: 1,
    updatedAt: 1,
    seed: 1,
    ...extra,
  } as Post;
}

function listing(p: Project, website = 'https://sparkleco.com'): Listing {
  return { id: 'lst1', kind: 'business', title: 'Sparkle Co', tagline: '', description: '', price: 120, priceModel: 'one-time', seller: { name: 'Sparkle Co' }, category: 'Home Services', tags: [], website, cover: { colors: ['#000', '#111', '#222'], icon: 'sparkles', pattern: 'dots' }, createdAt: 1, origin: 'mine', projectId: p.id };
}

describe('guessedWebsites', () => {
  it('lists both made-up forms of the slug', () => {
    expect(guessedWebsites(oldProject())).toEqual(['https://sparkle-co.com', 'https://sparkleco.com']);
  });
});

describe('purgeWebsite', () => {
  it('clears a website made up from the slug, keeps it aside to ask about, and fixes the funnel copy', () => {
    for (const url of ['https://sparkleco.com', 'https://sparkle-co.com']) {
      const out = purgeWebsite(oldProject(url))!;
      expect(out.brand.websiteUrl).toBe('');
      expect(out.brand.guessedWebsite).toBe(url);
      expect(out.marketing.leadMagnet!.cta).toBe('Ready for the complete system? Sparkle Co → [link to your offer]');
      expect(out.marketing.emails[0].body).toBe('Here it is.\n\nMore at [link to your offer].');
      expect(out.marketing.emails[0].ctaUrl).toBe('{{lead_magnet_link}}');
      expect(out.marketing.emails[1].ctaUrl).toBe('{{product_link}}');
      expect(JSON.stringify(out)).not.toMatch(/sparkle-?co\.com(?!")/);
    }
  });

  it('changes nothing the second time', () => {
    const once = purgeWebsite(oldProject())!;
    expect(purgeWebsite(once)).toBeNull();
  });

  it('leaves the owner’s own website alone, and points old copy at it', () => {
    const p = oldProject('https://sparkle-cleaning.net');
    const out = purgeWebsite(p)!;
    expect(out.brand.websiteUrl).toBe('https://sparkle-cleaning.net');
    expect(out.brand.guessedWebsite).toBeUndefined();
    expect(out.marketing.leadMagnet!.cta).toBe('Ready for the complete system? Sparkle Co → sparkle-cleaning.net');
    expect(purgeWebsite(out)).toBeNull();
  });

  it('never touches an existing business or a website the owner confirmed', () => {
    const existing = oldProject();
    existing.origin = 'existing';
    expect(purgeWebsite(existing)).toBeNull();
    const confirmed = oldProject();
    confirmed.brand.websiteConfirmed = true;
    expect(purgeWebsite(confirmed)).toBeNull();
  });

  it('leaves a clean project alone', () => {
    const p = newProject('product', 'new');
    p.brand = { ...p.brand, name: 'Tax Tidy', slug: 'tax-tidy', websiteUrl: '' };
    expect(purgeWebsite(p)).toBeNull();
  });

  it('needs the exact made-up address', () => {
    expect(purgeWebsite({ ...oldProject('https://sparkleco.com/shop'), marketing: newProject().marketing })).toBeNull();
    expect(purgeWebsite({ ...oldProject('https://www.sparkleco.co'), marketing: newProject().marketing })).toBeNull();
  });
});

describe('purgeListingWebsite', () => {
  it('drops a made-up website link from your listing, once', () => {
    const p = oldProject();
    const out = purgeListingWebsite(listing(p), p)!;
    expect(out).not.toHaveProperty('website');
    expect(out.title).toBe('Sparkle Co');
    expect(purgeListingWebsite(out, p)).toBeNull();
    // the project already cleaned first: same result
    expect(purgeListingWebsite(listing(p), purgeWebsite(p)!)).toEqual(out);
  });

  it('keeps a real website, a confirmed one, an existing business’s, and other sellers’ listings', () => {
    const p = oldProject('https://sparkle-cleaning.net');
    expect(purgeListingWebsite(listing(p, 'https://sparkle-cleaning.net'), p)).toBeNull();
    const confirmed = oldProject();
    confirmed.brand.websiteConfirmed = true;
    expect(purgeListingWebsite(listing(confirmed), confirmed)).toBeNull();
    const existing = oldProject();
    existing.origin = 'existing';
    expect(purgeListingWebsite(listing(existing), existing)).toBeNull();
    const q = oldProject();
    expect(purgeListingWebsite({ ...listing(q), origin: 'community' }, q)).toBeNull();
    expect(purgeListingWebsite(listing(q), undefined)).toBeNull();
  });
});

describe('purgePostWebsite', () => {
  it('replaces the made-up address in a planned post with “link in bio” and the brand name', () => {
    const p = oldProject();
    const out = purgePostWebsite(oldPost(p), p)!;
    expect(out.caption).toBe('Your weekend back.\n\nBook your spot → the link in bio');
    expect(out.visualPrompt).toContain('small watermark “Sparkle Co” bottom-right');
    expect(out.storyboard!.map((s) => s.text)).toEqual(['A spotless home', 'Link in bio']);
    expect(purgePostWebsite(out, p)).toBeNull();
  });

  it('uses the owner’s @handle on the image, and their real website when they have one', () => {
    const p = oldProject();
    p.brand.socials = { instagram: 'instagram.com/sparkle.co/' };
    expect(purgePostWebsite(oldPost(p), p)!.visualPrompt).toContain('watermark “@sparkle.co”');
    const real = oldProject('https://sparkle-cleaning.net');
    const out = purgePostWebsite(oldPost(real), real)!;
    expect(out.caption).toContain('→ sparkle-cleaning.net');
    expect(out.storyboard![1].text).toBe('sparkle-cleaning.net');
  });

  it('leaves posts that are already out, or with Manus, as they went out', () => {
    const p = oldProject();
    expect(purgePostWebsite(oldPost(p, { status: 'published' }), p)).toBeNull();
    expect(purgePostWebsite(oldPost(p, { external: { via: 'manus', network: 'facebook', taskId: 't', taskUrl: 'u', state: 'working', message: '' } as Post['external'] }), p)).toBeNull();
    expect(purgePostWebsite(oldPost(p, { projectId: 'other' }), p)).toBeNull();
  });

  it('does not touch longer domains that only start the same way', () => {
    const p = oldProject();
    const post = oldPost(p, { caption: 'See sparkleco.com.au and mysparkleco.com', visualPrompt: '', storyboard: undefined });
    expect(purgePostWebsite(post, p)).toBeNull();
  });
});
