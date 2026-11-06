// Plans, projects and picks for the ads tests (fake values only).

export const BUILT_AT = Date.parse('2026-11-20T16:00:00Z'); // 10:00 in America/Chicago, a Friday
export const LAUNCH_KEY = '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d';
export const ZID_META = 'aaaaaaaaaaaaaaaaaaaaaaa1';
export const ZID_GOOGLE = 'aaaaaaaaaaaaaaaaaaaaaaa2';

export const META_ACCOUNT = Object.freeze({ adAccountId: 'act_1', name: 'Acme Plumbing', idTail: 't_1', currency: 'USD', timezone: 'America/Chicago', minDaily: 1 });
export const GOOGLE_ACCOUNT = Object.freeze({ adAccountId: '1234567890', name: 'Acme Plumbing Ads', idTail: '7890', currency: 'USD', timezone: 'America/New_York', minDaily: 1 });

export function project(extra = {}) {
  return { id: 'proj-1', name: 'Acme Plumbing', brand: { websiteUrl: 'https://acme.example' }, studio: { listing: {} }, ...extra };
}

const creative = (variant, extra = {}) => ({
  id: `cr-${variant}`,
  variant,
  angle: 'Fast help',
  primaryText: `Burst pipe? We come today. (${variant})`,
  headline: `Plumber today ${variant}`,
  description: 'Call or book online',
  cta: 'Book Now',
  style: 'bold',
  format: 'image',
  visualHeadline: 'Fast help',
  media: { mediaId: `img-${variant}.jpg`, width: 1080, height: 1080, madeBy: variant === 'A' ? 'ai' : 'owner', type: 'image/jpeg' },
  ...extra,
});

export function plan(extra = {}) {
  return {
    id: 'plan-1',
    projectId: 'proj-1',
    name: 'Winter pipes',
    objective: 'traffic',
    platforms: ['meta', 'google'],
    dailyBudget: 25,
    durationDays: 14,
    startDate: '2026-12-01',
    status: 'draft',
    locations: 'Austin, TX',
    radiusMi: 15,
    ageMin: 25,
    ageMax: 60,
    interests: ['Home improvement', 'Gardening'],
    audiences: [],
    creatives: [creative('A'), creative('B'), creative('C')],
    selectedCreativeIds: ['cr-A', 'cr-B', 'cr-C'],
    search: {
      headlines: ['Plumber in Austin', 'Same-day repairs', 'Book a plumber today', 'Burst pipe help'],
      descriptions: ['Local plumbers who come the same day.', 'Book online or call us now.'],
      path: [],
      keywords: ['plumber austin', '[emergency plumber]', '"burst pipe repair"'],
      sitelinks: [],
    },
    createdAt: 1,
    finalUrl: 'https://acme.example/plumbing',
    ...extra,
  };
}

export const AUSTIN = { key: '2421836', name: 'Austin', kind: 'city', cc: 'US' };
export const TEXAS = { key: '3886', name: 'Texas', kind: 'region', cc: 'US' };
export const US = { key: 'US', name: 'United States', kind: 'country', cc: 'US' };
export const BERLIN = { key: '577564', name: 'Berlin', kind: 'city', cc: 'DE' };

export function picks(extra = {}) {
  return {
    status: 'PAUSED',
    startDate: '2026-12-01',
    startTime: null,
    dailyBudget: 25,
    durationDays: 14,
    locations: [AUSTIN],
    radiusMi: 15,
    interests: [{ id: '6003020834693', name: 'Home improvement' }],
    creativeIds: ['cr-A', 'cr-B', 'cr-C'],
    languages: ['en'],
    claimsConfirmed: [],
    specialCategory: 'none',
    ...extra,
  };
}

/** media links as the preview makes them, minted with builtAt (fake: no secret needed) */
export const mediaUrl = (builtAt = BUILT_AT) => (c) => ({ url: `https://app.test/api/media/public/${c.media.mediaId}.${builtAt}.jpg`, madeBy: c.media.madeBy });
