// Strategy's honesty patterns and text helpers: what counts as a link, a market number, a prediction or a
// claim, and how owner-facing copy loses them line by line without touching [placeholders].
import { describe, expect, it } from 'vitest';
import type { OwnerFacts } from './strategyTypes';
import { CLAIMS, EMAIL_RE, NUMBER_CLAIM, PHONE_RE, PREDICTION, URL_RE, cleanText, claimFree, clip, enumOf, noLinks, nums, sentences, unsourcedOk } from './strategyNormalize';
import { ownerFacts } from './strategy';
import { qaProject } from '@/test/strategyQa';

const none: OwnerFacts = { nums: new Set(), text: '' };
const priced = (): OwnerFacts => {
  const p = qaProject();
  p.studio.price = 49;
  p.studio.packages = [{ id: 'k1', name: 'Family box', price: 120, description: 'Bread for the week, licensed kitchen', includes: ['Two loaves'] } as never];
  return ownerFacts(p, { goal: '10 new bookings', budget: '$100 a month', timePerWeek: '3 hours', competitors: [], tried: '', notes: '' });
};

describe('the patterns', () => {
  it('URL, email and phone', () => {
    expect('see https://example.com/x and www.example.org'.match(URL_RE)).toEqual(['https://example.com/x', 'www.example.org']);
    expect('mail me@example.com'.match(EMAIL_RE)).toEqual(['me@example.com']);
    expect('call +1 (512) 555-0100 today'.match(PHONE_RE)).toEqual(['+1 (512) 555-0100']);
    expect('open 9 to 5'.match(PHONE_RE)).toBeNull();
  });

  it('NUMBER_CLAIM: market numbers, not ordinary counts', () => {
    for (const yes of ['73% of buyers search on their phone', '40 percent more', 'Posts get 3x more reach', '2 times more likely', 'It costs $49', 'about 10k people', '1.5 million users', '500 customers a month', '12,000 views']) expect(NUMBER_CLAIM.test(yes)).toBe(true);
    for (const no of ['Post 3 times a week', 'Try 3 short videos', 'A 5-email welcome sequence', 'Week 2', 'Send the email to three businesses', 'Top 3 tips']) expect(NUMBER_CLAIM.test(no)).toBe(false);
  });

  it('PREDICTION: promises of results', () => {
    for (const yes of ['You will get more clients.', 'You’ll double your sales', "you'll see results", 'This will bring new bookings', 'Guaranteed growth']) expect(PREDICTION.test(yes)).toBe(true);
    for (const no of ['Try a short video.', 'Start with your best customers.', 'Will it rain?']) expect(PREDICTION.test(no)).toBe(false);
  });

  it('CLAIMS: things only the owner can say', () => {
    for (const yes of ['Trusted by 500 families', 'Fully licensed and insured', 'Award-winning bread', 'money-back guarantee', '4.9 stars on Google', 'Book a free consultation', '10 years of experience', 'Limited time offer', '20% off today']) expect(CLAIMS.test(yes)).toBe(true);
    for (const no of ['Fresh bread every morning', 'Show how you bake', 'Ask for a quote']) expect(CLAIMS.test(no)).toBe(false);
  });
});

describe('the text helpers', () => {
  it('clip cuts at a word with "…", strips control characters and keeps newlines only when asked', () => {
    const cut = clip('bread '.repeat(30), 50);
    expect(cut.length).toBeLessThanOrEqual(50);
    expect(cut).toMatch(/^(bread )+bread…$/);
    expect(clip('a\u0000b\u0007c', 10)).toBe('a b c');
    expect(clip('line one\n\n\n\nline two', 40, true)).toBe('line one\n\nline two');
    expect(clip('line one\nline two', 40)).toBe('line one line two');
    expect(clip({ x: 1 }, 10)).toBe('');
    expect(clip(42, 10)).toBe('42');
  });

  it('noLinks drops links, or writes placeholders for an email the owner sends', () => {
    expect(noLinks('See https://evil.example/now for details.', 'drop')).toBe('See for details.');
    expect(noLinks('See https://evil.example/now. Or mail me@x.com or call 512 555 0100.', 'placeholders')).toBe('See [link to your page]. Or mail [your email] or call [your phone].');
  });

  it('a link however it’s written: //host, a bare host with a path, hxxp spellings, other schemes, Markdown links', () => {
    expect('a //evil.example/x or evil.example/book or hxxps://evil.example or http[:]//evil.example or ftp://evil.example/f'.match(URL_RE)).toEqual(['//evil.example/x', 'evil.example/book', 'hxxps://evil.example', 'http[:]//evil.example', 'ftp://evil.example/f']);
    expect(cleanText('Join the [local group](//evil.example/x) to find leads.')).toBe('Join the local group to find leads.');
    expect(claimFree('See [this list](evil.example/deals) of directories.', none)).toBe('See this list of directories.');
    expect(cleanText('Book through hxxps://evil.example or evil.example/book today.')).toBe('Book through or today.');
    // in an email the owner sends, a mail client would make each one a link: a placeholder instead
    expect(noLinks('Book at evil.example/book or //evil.example/x.', 'placeholders')).toBe('Book at [link to your page] or [link to your page].');
  });

  it('never takes ordinary words for links', () => {
    const words = 'Built on Node.js, Node.js/Express or Vue.js. E.g. U.S. shops sell at $4.50 a loaf with 3.5 stars, 24/7, and/or from 9 a.m./5 p.m., rated 1.5/10 by St. Louis/Kansas City critics.';
    expect(cleanText(words)).toBe(words);
    expect(words.match(URL_RE)).toBeNull();
  });

  it('keeps a link the app has checked: the business’s own address (or a page under it) and the strategy’s sources', () => {
    const own: OwnerFacts = { ...none, sites: ['qabakery.com', 'facebook.com/qabakery'], pages: new Set(['example.com/qa-research/where-buyers-look']) };
    expect(cleanText('Order at qabakery.com/order or https://www.qabakery.com/menu, not at evil.example/book.', own)).toBe('Order at qabakery.com/order or https://www.qabakery.com/menu, not at.');
    // on a shared host, only the business's own page
    expect(cleanText('Post on facebook.com/qabakery/posts, not facebook.com/evilgroup.', own)).toBe('Post on facebook.com/qabakery/posts, not.');
    expect(cleanText('Listed on example.com/qa-research/where-buyers-look?utm_source=x but not example.com/qa-research/other.', own)).toBe('Listed on example.com/qa-research/where-buyers-look?utm_source=x but not.');
    // a spelling like hxxps:// is never a checked link, nor is another scheme or another host
    expect(cleanText('Visit hxxps://qabakery.com or ftp://qabakery.com/f or shop.qabakery.com/x.', own)).toBe('Visit or or.');
    expect(noLinks('Book at qabakery.com/book or evil.example/book.', 'placeholders', own)).toBe('Book at qabakery.com/book or [link to your page].');
    // the owner's facts carry the business's addresses: its website (typed with or without https://) and its published page
    const p = qaProject();
    p.brand.websiteUrl = 'www.QABakery.com/';
    p.marketing.seoPublished = { url: 'https://pages.example.app/qa-bakery', at: 1 } as never;
    expect(ownerFacts(p, { goal: '', budget: '', timePerWeek: '', competitors: [], tried: '', notes: '' }).sites).toEqual(['pages.example.app/qa-bakery', 'qabakery.com']);
  });

  it('sentences split after . ! ?', () => {
    expect(sentences('One. Two! Three? Four')).toEqual(['One.', 'Two!', 'Three?', 'Four']);
  });

  it('cleanText drops predictions; unsourcedOk drops market numbers the owner didn’t give', () => {
    expect(cleanText('Post short videos. You will get 40 bookings.')).toBe('Post short videos.');
    expect(unsourcedOk('Buyers like photos. 73% of buyers search on their phone.', none)).toBe('Buyers like photos.');
    // "$49" is the owner's own price
    expect(unsourcedOk('Lead with the $49 box.', priced())).toBe('Lead with the $49 box.');
    expect(unsourcedOk('Lead with the $59 box.', priced())).toBe('');
  });

  it('claimFree works line by line, keeps [placeholders] and the owner’s own claims', () => {
    const body = 'Hi [Name],\n\nYou will get 20% off forever. Thanks again for choosing us.\nWe are trusted by 500 families.\n\n[Your name]';
    expect(claimFree(body, none)).toBe('Hi [Name],\n\nThanks again for choosing us.\n\n[Your name]');
    // the owner wrote "licensed kitchen" in a package: it may be said
    expect(claimFree('Baked in a licensed kitchen.', priced())).toBe('Baked in a licensed kitchen.');
    expect(claimFree('Fully insured.', priced())).toBe('');
    expect(claimFree('Your goal: 10 new bookings.', priced())).toBe('Your goal: 10 new bookings.');
    expect(claimFree('Get 30 bookings.', priced())).toBe('');
  });

  it('enumOf and nums', () => {
    expect(enumOf(' Bio ', ['post', 'comment', 'bio'] as const, 'post')).toBe('bio');
    expect(enumOf('sidebar', ['post', 'comment', 'bio'] as const, 'post')).toBe('post');
    expect(nums([1, '2', '[3]', 9, 1, 2.5, 'x'], new Set([1, 2, 3]))).toEqual([1, 2, 3]);
    expect(nums([1, 2, 3, 4, 5], new Set([1, 2, 3, 4, 5]))).toEqual([1, 2, 3, 4]);
    expect(nums('1', new Set([1]))).toEqual([]);
  });
});
