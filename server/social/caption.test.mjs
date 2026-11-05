// What each network gets of a post (spec §1.7 "Caption composition", §9.2 WP2 caption tests).
import { describe, expect, it } from 'vitest';
import { cleanHashtags, composeFor, escapeLinkedIn, sameStart, X_MAX, xLength, xPostCost, YT_TITLE_MAX } from './caption.mjs';

const LONG_URL = `https://example.com/${'a'.repeat(120)}`;

describe('X', () => {
  it('counts a link as 23 characters, whatever its length', () => {
    expect(xLength(`Hi ${LONG_URL}`)).toBe(3 + 23);
    expect(xLength('héllo')).toBe(5);
  });

  it('fits 280 with a long link and appends only the hashtags that still fit', () => {
    const caption = `${'x'.repeat(250)} ${LONG_URL}`; // 250 + 1 + 23 = 274
    expect(xLength(caption)).toBe(274);
    const out = composeFor('x', { caption, hashtags: ['#a', 'bb', 'c'] });
    expect(out.error).toBeUndefined();
    expect(xLength(out.text)).toBeLessThanOrEqual(X_MAX);
    // "\n\n#a" makes 278; adding " #bb" (282) or " #c" (281) would not fit
    expect(out.text).toBe(`${caption}\n\n#a`);
  });

  it('adds hashtags that fit', () => {
    const out = composeFor('x', { caption: 'Fresh bread today', hashtags: ['bakery', '#Bread', 'bakery'] });
    expect(out.text).toBe('Fresh bread today\n\n#bakery #Bread');
    expect(out.hasUrl).toBe(false);
    expect(xPostCost(out)).toBe(15_000);
  });

  it('refuses a text that can’t fit, and prices a post with a link higher', () => {
    expect(composeFor('x', { caption: 'y'.repeat(281) }).error).toBe('TEXT_TOO_LONG');
    const withLink = composeFor('x', { caption: `See ${LONG_URL}` });
    expect(withLink.hasUrl).toBe(true);
    expect(xPostCost(withLink)).toBe(200_000);
  });

  it('makes the first comment a reply when the link goes there', () => {
    const out = composeFor('x', { caption: 'Bread!', linkPlacement: 'comment', firstComment: 'Order: https://joes.example/order' });
    expect(out.comment).toBe('Order: https://joes.example/order');
  });
});

describe('Instagram', () => {
  it('keeps at most 30 hashtags', () => {
    const tags = Array.from({ length: 40 }, (_, i) => `tag${i}`);
    const out = composeFor('instagram', { caption: 'Hello', hashtags: tags });
    expect(out.text.match(/#tag\d+/g)).toHaveLength(30);
    expect(out.text.startsWith('Hello\n\n#tag0 ')).toBe(true);
    expect(out.commentSupported).toBe(true);
  });
});

describe('LinkedIn', () => {
  it('escapes the reserved characters and keeps hashtags as hashtags', () => {
    expect(escapeLinkedIn('a|b{c}@d[e](f)<g>#h*i_j~k\\l')).toBe('a\\|b\\{c\\}\\@d\\[e\\]\\(f\\)\\<g\\>\\#h\\*i\\_j\\~k\\\\l');
    const out = composeFor('linkedin', { caption: 'Sale (today) @ 50%_off', hashtags: ['#local'] });
    expect(out.text).toBe('Sale \\(today\\) \\@ 50%\\_off\n\n{hashtag|\\#|local}');
  });
});

describe('YouTube', () => {
  it('cuts the title to 100 characters and puts hashtags in tags', () => {
    const out = composeFor('youtube', { headline: 'T'.repeat(150), caption: 'About the video', hashtags: ['#bake', 'bread'] });
    expect([...out.title].length).toBeLessThanOrEqual(YT_TITLE_MAX);
    expect(out.title.endsWith('…')).toBe(true);
    expect(out.description).toBe('About the video');
    expect(out.tags).toEqual(['bake', 'bread']);
    expect(out.commentSupported).toBe(false);
  });
});

describe('Facebook and TikTok', () => {
  it('Facebook sends the link as its own field when it goes in the post', () => {
    const out = composeFor('facebook', { caption: 'New menu https://joes.example/menu', hashtags: ['food'], linkPlacement: 'post' });
    expect(out).toMatchObject({ text: 'New menu https://joes.example/menu\n\n#food', link: 'https://joes.example/menu' });
    expect(composeFor('facebook', { caption: 'New menu https://joes.example/menu', linkPlacement: 'bio' }).link).toBeUndefined();
  });

  it('TikTok leaves links out and has no first comment', () => {
    const out = composeFor('tiktok', { caption: 'Watch https://joes.example now', hashtags: ['fyp'], linkPlacement: 'comment', firstComment: 'link' });
    expect(out.text).toBe('Watch now\n\n#fyp');
    expect(out.comment).toBeUndefined();
    expect(out.commentSupported).toBe(false);
  });
});

describe('helpers', () => {
  it('cleans hashtags', () => {
    expect(cleanHashtags([' #a ', 'b c', '', '#A', null])).toEqual(['#a', '#bc']);
  });

  it('matches a network’s copy of a post by its start, ignoring links and escapes', () => {
    expect(sameStart('Fresh \\(warm\\) bread https://x.y today', 'Fresh (warm) bread https://t.co/abc today')).toBe(true);
    expect(sameStart('Fresh bread', 'Stale bread')).toBe(false);
    expect(sameStart('', 'anything')).toBe(false);
  });
});
