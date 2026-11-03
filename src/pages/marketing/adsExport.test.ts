import { describe, expect, it } from 'vitest';
import { newProject } from '@/store/defaults';
import type { AdCampaign, Project } from '@/lib/types';
import { adFinalUrl, adsCsv, adsText } from './AdsEngine';

function project(websiteUrl = ''): Project {
  const p = newProject('business', 'new');
  p.brand = { ...p.brand, name: 'Sparkle Co', slug: 'sparkle-co', websiteUrl };
  return p;
}

const campaign = (extra: Partial<AdCampaign> = {}): AdCampaign => ({
  id: 'ad1',
  projectId: 'p1',
  name: 'Sparkle Co · Bookings',
  objective: 'sales',
  platforms: ['meta'],
  dailyBudget: 25,
  durationDays: 14,
  startDate: '2026-11-03',
  status: 'draft',
  locations: 'Austin, TX',
  radiusMi: 10,
  ageMin: 25,
  ageMax: 54,
  interests: [],
  audiences: [],
  creatives: [{ id: 'c1', variant: 'A', angle: 'Time back', primaryText: 'Your weekend back.', headline: 'Home cleaning', description: 'Book online', cta: 'Book Now', visualHeadline: '', style: 'minimal', format: 'image' }] as AdCampaign['creatives'],
  selectedCreativeIds: ['c1'],
  search: null,
  createdAt: 1,
  ...extra,
});

describe('ads final URL', () => {
  it('is empty until the owner has a link: never a domain made up from the name', () => {
    expect(adFinalUrl(campaign(), project())).toBe('');
    expect(adsText(campaign(), '')).toContain('Final URL: [add the page your ads link to]');
    expect(adsText(campaign(), '')).not.toMatch(/sparkle-?co\.com/);
  });

  it('uses the campaign’s own URL, else the website, else the owner’s buy/book link', () => {
    expect(adFinalUrl(campaign(), project('sparkle-cleaning.net'))).toBe('https://sparkle-cleaning.net');
    const p = project();
    p.studio.listing.buyUrl = 'https://calendly.com/sparkle';
    expect(adFinalUrl(campaign(), p)).toBe('https://calendly.com/sparkle');
    expect(adFinalUrl(campaign({ finalUrl: 'sparkle-cleaning.net/offer' }), p)).toBe('https://sparkle-cleaning.net/offer');
    // cleared on purpose: stays empty
    expect(adFinalUrl(campaign({ finalUrl: '' }), project('sparkle-cleaning.net'))).toBe('');
  });

  it('goes into the plan and the CSV', () => {
    expect(adsText(campaign(), 'https://sparkle-cleaning.net/offer')).toContain('Final URL: https://sparkle-cleaning.net/offer');
    const csv = adsCsv(campaign(), 'https://sparkle-cleaning.net/offer').split('\n');
    expect(csv[0]).toContain('"final_url"');
    expect(csv[1].endsWith('"https://sparkle-cleaning.net/offer"')).toBe(true);
  });
});
