// The link social posts carry (the published page, else the website), where it goes on each network,
// and how a caption points to it: placed by the app, never made up, and the same however often it runs.
import { describe, expect, it } from 'vitest';
import type { LinkPlacement, Project } from './types';
import { DEFAULT_LINK_PLACEMENT, LINK_PLACEMENTS, LINK_PLACEMENT_LABEL, fitForX, firstCommentFor, firstCommentOf, knownLinks, linkPointer, linkText, pageLink, placeLink, placementFor, postLinkFor, postLinkOf, postPlacement, xLength, type PostLink } from './pageLink';

const page = 'https://yourlocalbusiness.replit.app/sparkle-cleaning-austin';
const site = 'https://sparkle-cleaning.net';
const L = (placement: LinkPlacement, url = page): PostLink => ({ url, placement });

/** Just the parts of a project these functions read. */
const proj = (o: { website?: string; url?: string; domainUrl?: string; pageType?: Project['marketing']['pageType']; linkPlacement?: Project['marketing']['linkPlacement'] } = {}) =>
  ({
    brand: { websiteUrl: o.website ?? '' },
    marketing: { ...(o.url ? { seoPublished: { slug: 's', url: o.url, ...(o.domainUrl ? { domainUrl: o.domainUrl } : {}), publishedAt: 1, hash: 'h' } } : {}), pageType: o.pageType, linkPlacement: o.linkPlacement },
  }) as unknown as Project;

describe('the link posts carry', () => {
  it('is the published page (on your domain first), else your website, else none', () => {
    expect(pageLink(proj({ website: 'sparkle-cleaning.net', url: page, domainUrl: 'https://mybakery.com/' }))).toEqual({ url: 'https://mybakery.com/', source: 'domain' });
    expect(pageLink(proj({ website: 'sparkle-cleaning.net', url: page }))).toEqual({ url: page, source: 'app' });
    expect(pageLink(proj({ website: 'sparkle-cleaning.net' }))).toEqual({ url: site, source: 'website' });
    expect(pageLink(proj())).toBeNull();
  });

  it('takes only a real web address from the website field', () => {
    expect(pageLink(proj({ website: 'mailto:hi@sparkle.net' }))).toBeNull();
    expect(pageLink(proj({ website: 'javascript:alert(1)' }))).toBeNull();
    expect(pageLink(proj({ website: 'localhost:3000' }))).toBeNull();
    expect(pageLink(proj({ website: 'http://user@sparkle.net' }))).toBeNull();
    expect(pageLink(proj({ website: 'www.sparkle.net/' }))).toEqual({ url: 'https://www.sparkle.net', source: 'website' });
    expect(pageLink(proj({ website: '  ' }))).toBeNull();
  });

  it('lists the page’s and website’s addresses, as captions may carry them', () => {
    expect(knownLinks(proj({ website: 'sparkle-cleaning.net', url: page }))).toEqual([page, 'sparkle-cleaning.net']);
    expect(knownLinks(proj({ url: page, domainUrl: 'https://mybakery.com/' }))).toEqual([page, 'https://mybakery.com/']);
    expect(knownLinks(proj())).toEqual([]);
  });
});

describe('where the link goes', () => {
  it('has three places, with the contract’s labels', () => {
    expect(LINK_PLACEMENTS).toEqual(['post', 'comment', 'bio']);
    expect(LINK_PLACEMENT_LABEL).toEqual({ post: 'In the post', comment: 'First comment', bio: 'Bio' });
  });

  it('defaults to what posts did before: the bio on Instagram and TikTok, the post elsewhere', () => {
    expect(DEFAULT_LINK_PLACEMENT).toEqual({ instagram: 'bio', tiktok: 'bio', facebook: 'post', linkedin: 'post', x: 'post' });
    const p = proj({ url: page });
    for (const n of ['instagram', 'tiktok', 'facebook', 'linkedin', 'x'] as const) expect(placementFor(p, n)).toBe(DEFAULT_LINK_PLACEMENT[n]);
  });

  it('follows the project’s setting, and a post’s own choice over it', () => {
    const p = proj({ website: 'sparkle-cleaning.net', url: page, pageType: 'booking', linkPlacement: { facebook: 'comment' } });
    expect(postLinkFor(p, 'facebook')).toEqual({ url: page, placement: 'comment' });
    expect(postLinkFor(p, 'instagram')).toEqual({ url: page, placement: 'bio' });
    expect(postLinkFor(p, 'facebook', 'post')).toEqual({ url: page, placement: 'post' });
    expect(postLinkFor(proj(), 'facebook')).toBeNull();
  });

  it('reads an older post (no placement) as what its caption was written for, whatever the project says now', () => {
    const p = proj({ url: page, linkPlacement: { facebook: 'bio', instagram: 'comment' } });
    expect(postPlacement({ platform: 'facebook' })).toBe('post');
    expect(postPlacement({ platform: 'tiktok' })).toBe('bio');
    expect(postPlacement({ platform: 'facebook', linkPlacement: 'comment' })).toBe('comment');
    expect(postLinkOf(p, { platform: 'facebook' })).toEqual({ url: page, placement: 'post' });
    expect(postLinkOf(p, { platform: 'instagram', linkPlacement: 'comment' })).toEqual({ url: page, placement: 'comment' });
    expect(postLinkOf(proj(), { platform: 'facebook' })).toBeNull();
  });
});

describe('the first comment', () => {
  it('leads in by the page’s type, and says “More here:” for a website', () => {
    const lead = (pageType?: Project['marketing']['pageType']) => firstCommentFor(proj({ url: page, pageType }), L('comment'));
    expect(lead()).toBe(`All the details here: ${page}`);
    expect(lead('landing')).toBe(`All the details here: ${page}`);
    expect(lead('lead')).toBe(`Get in touch here: ${page}`);
    expect(lead('booking')).toBe(`Book here: ${page}`);
    expect(lead('website')).toBe(`Our website: ${page}`);
    expect(lead('showcase')).toBe(`See what we offer: ${page}`);
    expect(lead('checkout')).toBe(`Get it here: ${page}`);
    // a type this version doesn't know
    expect(lead('poster' as never)).toBe(`All the details here: ${page}`);
    const web = proj({ website: 'sparkle-cleaning.net', pageType: 'booking' });
    expect(firstCommentFor(web, postLinkFor(web, 'facebook', 'comment'))).toBe(`More here: ${site}`);
  });

  it('uses the full address, without a lone trailing slash', () => {
    const p = proj({ url: page, domainUrl: 'https://mybakery.com/', pageType: 'checkout' });
    expect(firstCommentFor(p, { url: 'https://mybakery.com/', placement: 'comment' })).toBe('Get it here: https://mybakery.com');
  });

  it('is only there when the link goes in the first comment', () => {
    const p = proj({ url: page });
    expect(firstCommentFor(p, L('post'))).toBeUndefined();
    expect(firstCommentFor(p, L('bio'))).toBeUndefined();
    expect(firstCommentFor(p, null)).toBeUndefined();
    expect(firstCommentOf({ platform: 'facebook', linkPlacement: 'comment', firstComment: '  Hi  ' })).toBe('Hi');
    expect(firstCommentOf({ platform: 'facebook', linkPlacement: 'comment', firstComment: '   ' })).toBeUndefined();
    expect(firstCommentOf({ platform: 'facebook', linkPlacement: 'post', firstComment: 'Hi' })).toBeUndefined();
    // an older Facebook post: its link was in the post
    expect(firstCommentOf({ platform: 'facebook', firstComment: 'Hi' })).toBeUndefined();
  });
});

describe('how a caption shows the link', () => {
  it('shows a domain’s home page bare, and any other address in full', () => {
    expect(linkText('https://mybakery.com/')).toBe('mybakery.com');
    expect(linkText('https://www.mybakery.com')).toBe('mybakery.com');
    expect(linkText(page)).toBe(page);
    expect(linkText('https://mybakery.com/?ref=ig')).toBe('https://mybakery.com/?ref=ig');
    expect(linkText('not a url')).toBe('not a url');
  });

  it('points to the comment, the reply on X, or the bio', () => {
    expect(linkPointer('comment', 'facebook')).toBe('the link in the first comment');
    expect(linkPointer('comment', 'x')).toBe('the link in the first reply');
    expect(linkPointer('bio', 'instagram')).toBe('the link in bio');
  });
});

describe('placing the link in a caption', () => {
  const t = (caption: string, link: PostLink | null, platform: Parameters<typeof placeLink>[2], known: string[], want: string) => expect(placeLink(caption, link, platform, known), caption).toBe(want);

  it('puts the address in the post, or says where it is', () => {
    t('Book your spot 👉 sparkle-cleaning.net', L('post'), 'facebook', [site], `Book your spot 👉 ${page}`);
    t('Book your spot 👉 sparkle-cleaning.net', L('comment'), 'facebook', [site], 'Book your spot 👉 the link in the first comment');
    t('Book your spot 👉 sparkle-cleaning.net', L('comment'), 'x', [site], 'Book your spot 👉 the link in the first reply');
    t('Come see us. Book at the link in bio', L('post'), 'facebook', [], `Come see us. Book at ${page}`);
    t('Book this week (link in bio)', L('comment'), 'linkedin', [], 'Book this week (link in the first comment)');
    t('Link in the first comment 👇', L('bio'), 'instagram', [], 'Link in bio 👇');
    t('Link in the first reply 👇', L('comment'), 'facebook', [], 'Link in the first comment 👇');
    t(`Our page: ${page}/ is new`, L('comment'), 'facebook', [site], 'Our page: the link in the first comment is new');
  });

  it('keeps the capital letter of a sentence', () => {
    t('Link in bio 👆', L('comment'), 'facebook', [], 'Link in the first comment 👆');
  });

  it('leaves other addresses, query strings and other people’s links alone', () => {
    t('See https://sparkle-cleaning.net/other and sparkle-cleaning.net.', L('bio'), 'instagram', [site], 'See https://sparkle-cleaning.net/other and the link in bio.');
    t('Visit sparkle-cleaning.net?ref=ig today', L('bio'), 'instagram', [site], 'Visit sparkle-cleaning.net?ref=ig today');
    t('Book at https://app.example/menu-old', L('post', 'https://mybakery.com/'), 'x', ['https://app.example/menu'], 'Book at https://app.example/menu-old');
    t('Tell us in the comments 👇', L('comment'), 'facebook', [], 'Tell us in the comments 👇');
    t('Drop your link in the comments 👇', L('bio'), 'facebook', [], 'Drop your link in the comments 👇');
  });

  it('moves an old address to the current one', () => {
    t('Book at mybakery.com', L('post', 'https://mybakery.com/'), 'x', ['https://app.example/menu', 'https://mybakery.com/'], 'Book at mybakery.com');
    t('Book at https://app.example/menu', L('post', 'https://mybakery.com/'), 'x', ['https://app.example/menu', 'https://mybakery.com/'], 'Book at mybakery.com');
  });

  it('changes nothing without a link, and nothing more when run again', () => {
    t('Go → the link in bio', null, 'facebook', [], 'Go → the link in bio');
    expect(placeLink('', L('post'), 'facebook')).toBe('');
    for (const pl of LINK_PLACEMENTS) {
      const once = placeLink('Book your spot 👉 sparkle-cleaning.net', L(pl), 'facebook', [site]);
      expect(placeLink(once, L(pl), 'facebook', [site])).toBe(once);
    }
  });

  it('comes back the same after post → comment → bio → post', () => {
    const a = placeLink('Book your spot 👉 sparkle-cleaning.net', L('comment'), 'facebook', [site]);
    const b = placeLink(a, L('bio'), 'facebook', [site]);
    expect(placeLink(b, L('post'), 'facebook', [site])).toBe(`Book your spot 👉 ${page}`);
  });

  it('takes an address with $& in it as it is', () => {
    t('Book at $&-price the link in bio', L('post', 'https://a.example/$&x'), 'facebook', [], 'Book at $&-price https://a.example/$&x');
  });

  it('says it once when an owner’s call to action already pointed to the bio', () => {
    t('Tap the link in bio sparkle-cleaning.net', L('post'), 'facebook', [site], `Tap ${page}`);
    t('Tap the link in bio sparkle-cleaning.net', L('comment'), 'facebook', [site], 'Tap the link in the first comment');
    t('Tap the link in bio sparkle-cleaning.net', L('bio'), 'facebook', [site], 'Tap the link in bio');
    t('Link in bio: sparkle-cleaning.net', L('bio'), 'instagram', [site], 'Link in bio');
    // two mentions far apart stay two
    expect(placeLink('See sparkle-cleaning.net. Book soon, sparkle-cleaning.net', L('post'), 'facebook', [site]).split(page).length - 1).toBe(2);
  });
});

describe('X’s count', () => {
  it('counts a link as 23, an emoji as 2, “…” as 2 and a line break as 2 (the app posts it as CR LF)', () => {
    expect(xLength('a'.repeat(270) + '\n\n#one #two')).toBe(283);
    expect(xLength('a\r\nb')).toBe(4);
    expect(xLength('Hello')).toBe(5);
    expect(xLength('Hello 🔥')).toBe(8);
    expect(xLength('⚡️')).toBe(2);
    expect(xLength('👩‍💻')).toBe(2);
    expect(xLength('👩‍💻 ⚡️')).toBe(5);
    expect(xLength('🇺🇸')).toBe(2);
    expect(xLength('café')).toBe(4);
    expect(xLength('—’')).toBe(2);
    expect(xLength('…')).toBe(2);
    expect(xLength(`Book → ${page}`)).toBe(5 + 2 + 1 + 23);
    expect(xLength('Book at sparkle-cleaning.net.')).toBe(8 + 23 + 1);
    expect(xLength(`${'a'.repeat(250)} https://example.com/${'x'.repeat(60)}`)).toBe(274);
  });
});

describe('fitting an X post', () => {
  it('keeps the paragraph with the link whole and shortens the opening', () => {
    const long = `${'Spring is the best time to deep clean your kitchen, your fridge and every cupboard you have been avoiding all winter long. '.repeat(2)}\n\nHere is the simple version:\n\n1. Empty it\n2. Wipe it\n\nBook your spot 👉 ${page}`;
    const fitted = fitForX(long, ['#cleaning', '#austin']);
    expect(fitted.endsWith(`\n\nBook your spot 👉 ${page}`)).toBe(true);
    expect(xLength(`${fitted}\n\n#cleaning #austin`)).toBeLessThanOrEqual(280);
  });

  it('leaves a post that fits as it is', () => {
    const shortOne = 'Short and sweet.\n\nLink in the first reply 👇';
    expect(fitForX(shortOne, ['#a'])).toBe(shortOne);
  });

  it('keeps the last paragraph (the call to action) when there’s no link', () => {
    expect(xLength(fitForX('x'.repeat(400), []))).toBeLessThanOrEqual(280);
    const saveIt = `${'A long opening line about cleaning your oven the easy way. '.repeat(5)}\n\nTry this today: soak the racks.\n\nSave this for later 📌`;
    const fitted = fitForX(saveIt, ['#tips']);
    expect(fitted.endsWith('\n\nSave this for later 📌')).toBe(true);
    expect(xLength(`${fitted}\n\n#tips`)).toBeLessThanOrEqual(280);
  });

  it('prefers the link’s paragraph over a later one without it', () => {
    const mid = `${'Opening words that go on and on about spring cleaning. '.repeat(5)}\n\nBook your spot 👉 the link in the first reply\n\nThanks for reading!`;
    expect(fitForX(mid, []).endsWith('\n\nBook your spot 👉 the link in the first reply')).toBe(true);
  });

  it('never cuts an address in half when it has to shorten the opening', () => {
    // the cut would land inside the address: it ends before it instead (half an address is a wrong one)
    const fitted = fitForX(`Order at ${page} before noon, every day this week.\n\nSee you soon!`, [], 45);
    expect(fitted).toBe('Order at…\n\nSee you soon!');
    // with room for it, the address stays whole
    const roomy = fitForX(`Order at ${page} before noon, every day this week, while the loaves are still warm from the oven.\n\nSee you soon!`, [], 70);
    expect(roomy).toContain(page);
    expect(roomy).not.toMatch(/https:\/\/\S*…/);
    expect(xLength(roomy)).toBeLessThanOrEqual(70);
  });
});
