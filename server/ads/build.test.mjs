// Building the Zernio request from a saved plan (server/ads/build.mjs, spec §6): golden bodies for a Meta plan with
// three creatives and a Google search plan, then every rule of §6 that decides what is sent.
import { describe, expect, it } from 'vitest';
import { addDays, buildLaunch, CTA_MAP, hashOf, keywordOf, launchDates, metaCreativeFor, namesFor, searchTextFor, storedBody, todayIn, withOffset } from './build.mjs';
import { AUSTIN, BERLIN, BUILT_AT, GOOGLE_ACCOUNT, LAUNCH_KEY, mediaUrl, META_ACCOUNT, picks, plan, project, TEXAS, US, ZID_GOOGLE, ZID_META } from './test-fixtures.mjs';

const meta = (p = {}, pk = {}, extra = {}) => buildLaunch({ platform: 'meta', plan: plan(p), project: project(), account: META_ACCOUNT, zid: ZID_META, picks: picks(pk), launchKey: LAUNCH_KEY, builtAt: BUILT_AT, mediaUrl: mediaUrl(), ...extra });
const google = (p = {}, pk = {}, extra = {}) => buildLaunch({ platform: 'google', plan: plan(p), project: project(), account: GOOGLE_ACCOUNT, zid: ZID_GOOGLE, picks: picks(pk), launchKey: LAUNCH_KEY, builtAt: BUILT_AT, ...extra });
const codes = (list) => list.map((n) => n.code);

const NAME = 'Winter pipes · Meta · YLB 1a2b3c4d5e6f';
const img = (v) => `https://app.test/api/media/public/img-${v}.jpg.${BUILT_AT}.jpg`;

describe('golden bodies', () => {
  it('a Meta plan with three picked creatives', () => {
    const b = meta();
    expect(b.blockers).toEqual([]);
    expect(b.body).toEqual({
      accountId: ZID_META,
      adAccountId: 'act_1',
      name: NAME,
      campaignName: NAME,
      adSetName: `${NAME} · Ad set`,
      adName: `${NAME} · Ad`,
      goal: 'traffic',
      budgetAmount: 25,
      budgetType: 'daily',
      startDate: '2026-12-01',
      endDate: '2026-12-14',
      status: 'PAUSED',
      campaignStatus: 'PAUSED',
      adSetStatus: 'ACTIVE',
      adStatus: 'ACTIVE',
      budgetLevel: 'adset',
      cities: [{ key: '2421836', radius: 15, distance_unit: 'mile' }],
      ageMin: 25,
      ageMax: 60,
      gender: 'all',
      advantageAudience: 0,
      interests: [{ id: '6003020834693', name: 'Home improvement' }],
      creatives: ['A', 'B', 'C'].map((v) => ({ name: `${NAME} · Ad ${v}`, headline: `Plumber today ${v}`, body: `Burst pipe? We come today. (${v})`, description: 'Call or book online', callToAction: 'BOOK_NOW', imageUrl: img(v), linkUrl: 'https://acme.example/plumbing' })),
      creativeFeatures: { enhance_cta: 'OPT_OUT', image_brightness_and_contrast: 'OPT_OUT', text_optimizations: 'OPT_OUT' },
      multiAdvertiser: 'OPT_OUT',
      aiDisclosure: 'OPT_IN',
    });
    expect(b.plannedTotal).toBe(350);
    expect(b.summary).toMatchObject({ status: 'PAUSED', daily: 25, days: 14, start: '2026-12-01', end: '2026-12-14', plannedTotal: 350, spendCap: 350 });
  });

  it('a Google search plan', () => {
    const b = google();
    expect(b.blockers).toEqual([]);
    const name = 'Winter pipes · Google · YLB 1a2b3c4d5e6f';
    expect(b.body).toEqual({
      accountId: ZID_GOOGLE,
      adAccountId: '1234567890',
      name,
      campaignName: name,
      adSetName: `${name} · Ad set`,
      adName: `${name} · Ad`,
      goal: 'traffic',
      budgetAmount: 25,
      budgetType: 'daily',
      startDate: '2026-12-01',
      endDate: '2026-12-14',
      status: 'PAUSED',
      campaignStatus: 'PAUSED',
      adSetStatus: 'ACTIVE',
      adStatus: 'ACTIVE',
      campaignType: 'search',
      headline: 'Plumber in Austin',
      additionalHeadlines: ['Same-day repairs', 'Book a plumber today', 'Burst pipe help'],
      body: 'Local plumbers who come the same day.',
      additionalDescriptions: ['Book online or call us now.'],
      linkUrl: 'https://acme.example/plumbing',
      keywords: ['plumber austin', { text: 'emergency plumber', matchType: 'exact' }, { text: 'burst pipe repair', matchType: 'phrase' }],
      locationTargetingType: 'presence',
      targeting: { cities: [{ key: '2421836' }], languages: ['en'] },
    });
    expect(b.summary.spendCap).toBeNull();
  });
});

describe('status (R3, R11)', () => {
  it('always sends all four statuses; Meta holds the campaign PAUSED whatever the choice', () => {
    for (const status of ['PAUSED', 'ACTIVE']) {
      const m = meta({}, { status }).body;
      expect([m.status, m.campaignStatus, m.adSetStatus, m.adStatus]).toEqual(['PAUSED', 'PAUSED', 'ACTIVE', 'ACTIVE']);
      const g = google({}, { status }).body;
      expect([g.status, g.campaignStatus, g.adSetStatus, g.adStatus]).toEqual([status, status, 'ACTIVE', 'ACTIVE']);
    }
  });

  it('has no default: a missing choice blocks', () => {
    expect(codes(meta({}, { status: undefined }).blockers)).toContain('CONFIRM_REQUIRED');
  });
});

describe('dates in the ad account’s time zone', () => {
  it('ends on start + days − 1, date only: 14 days from 1 Dec ends 14 Dec', () => {
    expect(meta().body).toMatchObject({ startDate: '2026-12-01', endDate: '2026-12-14' });
    expect(addDays('2026-12-01', 13)).toBe('2026-12-14');
  });

  it('“as soon as approved” sends no startDate and counts today in the account’s zone', () => {
    // 03:30 UTC on 21 Nov is still 20 Nov in Chicago
    const at = Date.parse('2026-11-21T03:30:00Z');
    const b = meta({}, { startDate: null }, { builtAt: at, mediaUrl: mediaUrl(at) });
    expect(b.body).not.toHaveProperty('startDate');
    expect(b.body.endDate).toBe('2026-12-03');
    expect(codes(b.warnings)).toContain('START_DAY_COUNTS');
    expect(todayIn('America/Chicago', at)).toBe('2026-11-20');
  });

  it('writes a Meta start time without an offset; Google takes the date', () => {
    expect(meta({}, { startTime: '09:30' }).body.startDate).toBe('2026-12-01T09:30:00');
    expect(google({}, { startTime: '09:30' }).body.startDate).toBe('2026-12-01');
  });

  it('refuses a start in the past and odd lengths', () => {
    expect(codes(meta({}, { startDate: '2026-11-19' }).blockers)).toContain('START_IN_PAST');
    expect(codes(meta({}, { durationDays: 0 }).blockers)).toContain('BAD_DATES');
    expect(codes(meta({}, { durationDays: 91 }).blockers)).toContain('BAD_DATES');
    expect(codes(meta({}, { startDate: '2026-02-30' }).blockers)).toContain('BAD_DATES');
  });

  it('is the same body (and hash) when rebuilt with the same builtAt; the stored copy hides image links', () => {
    expect(meta().bodyHash).toBe(meta().bodyHash);
    expect(meta().summaryHash).toBe(meta().summaryHash);
    const later = BUILT_AT + 9 * 60_000;
    expect(meta({}, {}, { builtAt: later, mediaUrl: mediaUrl(later) }).bodyHash).not.toBe(meta().bodyHash);
    const b = meta();
    const stored = storedBody(b.body, b.ads);
    expect(stored.creatives.map((c) => c.imageUrl)).toEqual(['media:img-A.jpg', 'media:img-B.jpg', 'media:img-C.jpg']);
    expect(JSON.stringify(stored)).not.toContain('/api/media/public/');
    expect(b.body.creatives[0].imageUrl).toBe(img('A'));
  });

  it('end dates on a change carry the zone’s offset that day', () => {
    expect(withOffset('2026-12-14', '23:59:59', 'America/Chicago')).toBe('2026-12-14T23:59:59-06:00');
    expect(withOffset('2026-07-14', '23:59:59', 'America/Chicago')).toBe('2026-07-14T23:59:59-05:00');
    expect(withOffset('2026-12-14', '23:59:59', 'Asia/Kolkata')).toBe('2026-12-14T23:59:59+05:30');
    expect(launchDates({ platform: 'meta', picks: picks(), tz: 'America/Chicago', builtAt: BUILT_AT }).endAt).toBe('2026-12-15T05:59:59.000Z');
  });

  it('blocks when the account’s time zone is unknown', () => {
    expect(codes(buildLaunch({ platform: 'google', plan: plan(), project: project(), account: { ...GOOGLE_ACCOUNT, timezone: null }, zid: ZID_GOOGLE, picks: picks(), launchKey: LAUNCH_KEY, builtAt: BUILT_AT }).blockers)).toContain('GOOGLE_NO_TIMEZONE');
  });
});

describe('goal, places and people', () => {
  it('sends leads and sales as traffic, with the note', () => {
    for (const objective of ['leads', 'sales']) {
      const b = meta({ objective });
      expect(b.body.goal).toBe('traffic');
      expect(codes(b.warnings)).toContain('GOAL_NOTE');
    }
    expect(meta({ objective: 'awareness' }).body.goal).toBe('awareness');
  });

  it('raises a Meta city radius below 10 miles to 10, and says so', () => {
    const b = meta({}, { radiusMi: 5 });
    expect(b.body.cities[0].radius).toBe(10);
    expect(codes(b.warnings)).toContain('RADIUS_RAISED');
  });

  it('never sends a city together with its own country', () => {
    const b = meta({}, { locations: [AUSTIN, US] });
    expect(b.body.cities).toHaveLength(1);
    expect(b.body).not.toHaveProperty('countries');
    expect(codes(b.warnings)).toContain('COUNTRY_DROPPED');
    expect(meta({}, { locations: [TEXAS] }).body.regions).toEqual([{ key: '3886' }]);
  });

  it('never sends empty targeting', () => {
    const b = meta({}, { locations: [] });
    expect(codes(b.blockers)).toContain('NO_LOCATION');
    expect(b.body).not.toHaveProperty('countries');
  });

  it('blocks EU places on Meta (payer details) and a special category', () => {
    expect(codes(meta({}, { locations: [BERLIN] }).blockers)).toContain('EU_TARGETING');
    expect(codes(meta({}, { specialCategory: 'yes' }).blockers)).toContain('SPECIAL_CATEGORY');
    expect(codes(meta({}, { specialCategory: null }).blockers)).toContain('SPECIAL_CATEGORY_UNANSWERED');
    expect(meta({}, { specialCategory: 'yes' }).body).not.toHaveProperty('specialAdCategories');
  });

  it('lists plan interests that weren’t matched as left out', () => {
    expect(meta().leftOut.map((n) => n.message)).toEqual(['“Gardening” wasn’t matched to a Meta interest, so it’s left out.']);
  });

  it('leaves ages, interests and a radius out of Google, and says so', () => {
    const b = google();
    expect(b.body).not.toHaveProperty('ageMin');
    expect(b.body).not.toHaveProperty('interests');
    expect(codes(b.leftOut)).toEqual(['GOOGLE_NO_RADIUS', 'GOOGLE_NO_AGE']);
  });
});

describe('creatives and text (R4)', () => {
  it('maps the planner’s buttons to Meta’s, and an unknown one to Learn more with a note', () => {
    expect(CTA_MAP).toMatchObject({ 'Learn More': 'LEARN_MORE', 'Shop Now': 'SHOP_NOW', 'Book Now': 'BOOK_NOW', 'Sign Up': 'SIGN_UP', Download: 'DOWNLOAD', 'Get Quote': 'GET_QUOTE', 'Contact Us': 'CONTACT_US', 'Get Offer': 'GET_OFFER' });
    const p = plan();
    p.creatives[0].cta = 'Call Now';
    const b = buildLaunch({ platform: 'meta', plan: p, project: project(), account: META_ACCOUNT, zid: ZID_META, picks: picks(), launchKey: LAUNCH_KEY, builtAt: BUILT_AT, mediaUrl: mediaUrl() });
    expect(b.body.creatives[0].callToAction).toBe('LEARN_MORE');
    expect(codes(b.warnings)).toContain('CTA_DEFAULTED');
  });

  it('sends one creative as the single-ad shape, creativeFeatures only at the top', () => {
    const b = meta({}, { creativeIds: ['cr-B'] });
    expect(b.body).not.toHaveProperty('creatives');
    expect(b.body).toMatchObject({ headline: 'Plumber today B', callToAction: 'BOOK_NOW', imageUrl: img('B'), linkUrl: 'https://acme.example/plumbing', aiDisclosure: 'OPT_OUT' });
    for (const c of meta().body.creatives) expect(c).not.toHaveProperty('creativeFeatures');
  });

  it('only sends creatives the plan picked, 1 to 3', () => {
    expect(codes(meta({ selectedCreativeIds: ['cr-A'] }, { creativeIds: ['cr-A', 'cr-B'] }).blockers)).toContain('NO_CREATIVE');
    expect(codes(meta({}, { creativeIds: ['nope'] }).blockers)).toContain('NO_CREATIVE');
  });

  it('needs an image for every Meta ad, and refuses video', () => {
    const p = plan();
    delete p.creatives[1].media;
    p.creatives[2].format = 'video';
    const b = buildLaunch({ platform: 'meta', plan: p, project: project(), account: META_ACCOUNT, zid: ZID_META, picks: picks(), launchKey: LAUNCH_KEY, builtAt: BUILT_AT, mediaUrl: mediaUrl() });
    expect(codes(b.blockers)).toEqual(expect.arrayContaining(['NO_IMAGE', 'VIDEO_NOT_READY']));
    const noLinks = meta({}, {}, { mediaUrl: () => { throw Object.assign(new Error('x'), { code: 'NO_IMAGE_LINKS' }); } });
    expect(codes(noLinks.blockers)).toContain('NO_IMAGE_LINKS');
  });

  it('blocks text over the limits (never cut) and warns above 40 on a Meta headline', () => {
    const p = plan();
    p.creatives[0].headline = 'x'.repeat(256);
    p.creatives[1].headline = 'A rather long headline for a small phone screen';
    const b = buildLaunch({ platform: 'meta', plan: p, project: project(), account: META_ACCOUNT, zid: ZID_META, picks: picks(), launchKey: LAUNCH_KEY, builtAt: BUILT_AT, mediaUrl: mediaUrl() });
    expect(codes(b.blockers)).toContain('TEXT_TOO_LONG');
    expect(codes(b.warnings)).toContain('HEADLINE_LONG');
    expect(b.body.creatives[0].headline).toHaveLength(256);
    const g = google({ search: { ...plan().search, headlines: ['Plumber in Austin today, fast and friendly', 'Same-day repairs', 'Book a plumber'] } });
    expect(codes(g.blockers)).toContain('TEXT_TOO_LONG');
  });

  it('gives Google at least 3 headlines and 2 descriptions of the customer’s own, at most 15 and 4', () => {
    expect(codes(google({ search: { ...plan().search, headlines: ['One', 'Two', 'two'] } }).blockers)).toContain('TOO_FEW_HEADLINES');
    expect(codes(google({ search: { ...plan().search, descriptions: ['Only one.'] } }).blockers)).toContain('TOO_FEW_HEADLINES');
    expect(codes(google({ search: { ...plan().search, headlines: Array.from({ length: 16 }, (_, i) => `Headline ${i}`) } }).blockers)).toContain('TOO_MANY_HEADLINES');
    expect(codes(google({ search: null }).blockers)).toContain('NO_SEARCH_AD');
    expect(codes(google({ search: { ...plan().search, keywords: [] } }).blockers)).toContain('NO_KEYWORDS');
  });

  it('maps keyword syntax: [kw] exact, "kw" phrase, plain broad', () => {
    expect(keywordOf('[emergency plumber]')).toEqual({ text: 'emergency plumber', matchType: 'exact' });
    expect(keywordOf('"burst pipe"')).toEqual({ text: 'burst pipe', matchType: 'phrase' });
    expect(keywordOf('plumber')).toEqual({ text: 'plumber', matchType: 'broad' });
  });

  it('flags claims until the customer ticks them', () => {
    const p = plan();
    p.creatives[0].headline = 'Licensed plumbers';
    const run = (claimsConfirmed) => buildLaunch({ platform: 'meta', plan: p, project: project(), account: META_ACCOUNT, zid: ZID_META, picks: picks({ claimsConfirmed }), launchKey: LAUNCH_KEY, builtAt: BUILT_AT, mediaUrl: mediaUrl() });
    expect(codes(run([]).blockers)).toEqual(['CLAIM_UNCONFIRMED']);
    expect(run([]).claims).toEqual([{ phrase: 'licensed', field: 'Ad A headline', confirmed: false }]);
    expect(run(['licensed']).blockers).toEqual([]);
    expect(run(['licensed']).summary.claimsConfirmed).toEqual(['licensed']);
  });

  it('needs an https final URL that isn’t a link shortener; an empty plan URL isn’t replaced by the website', () => {
    expect(codes(meta({ finalUrl: 'http://acme.example' }).blockers)).toContain('NO_FINAL_URL');
    expect(codes(meta({ finalUrl: 'https://bit.ly/abc' }).blockers)).toContain('NO_FINAL_URL');
    expect(codes(meta({ finalUrl: '' }).blockers)).toContain('NO_FINAL_URL');
    expect(meta({ finalUrl: undefined }).body.creatives[0].linkUrl).toBe('https://acme.example');
  });

  it('checks the daily amount against the account minimum (Meta) and whole numbers', () => {
    expect(codes(buildLaunch({ platform: 'meta', plan: plan(), project: project(), account: { ...META_ACCOUNT, minDaily: 30 }, zid: ZID_META, picks: picks(), launchKey: LAUNCH_KEY, builtAt: BUILT_AT, mediaUrl: mediaUrl() }).blockers)).toContain('BUDGET_TOO_LOW');
    expect(codes(meta({}, { dailyBudget: 25.5 }).blockers)).toContain('BUDGET_INVALID');
  });
});

describe('names and swaps', () => {
  it('tags the name with 12 hex of the launch key and keeps it under 120 characters', () => {
    const n = namesFor('x'.repeat(300), 'google', LAUNCH_KEY);
    expect(n.tag).toBe('YLB 1a2b3c4d5e6f');
    expect(n.name.endsWith(' · Google · YLB 1a2b3c4d5e6f')).toBe(true);
    expect(n.adSetName.length).toBeLessThanOrEqual(120);
  });

  it('builds a full Meta creative swap and the whole Google text lists', () => {
    const p = plan();
    const m = metaCreativeFor({ plan: p, project: project(), creative: p.creatives[1], mediaUrl: mediaUrl(), claimsConfirmed: [] });
    expect(m.blockers).toEqual([]);
    expect(m.creative).toEqual({ headline: 'Plumber today B', body: 'Burst pipe? We come today. (B)', description: 'Call or book online', callToAction: 'BOOK_NOW', linkUrl: 'https://acme.example/plumbing', imageUrl: img('B') });
    const g = searchTextFor({ plan: p, project: project(), claimsConfirmed: [] });
    expect(g).toMatchObject({ headlines: p.search.headlines, descriptions: p.search.descriptions, finalUrls: ['https://acme.example/plumbing'], blockers: [] });
  });

  it('hashes canonically (key order doesn’t matter)', () => {
    expect(hashOf({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(hashOf({ b: [1, { d: 3, c: 2 }], a: 1 }));
  });
});
