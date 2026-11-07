// The block model (P5 §2): normalizeDoc keeps known blocks and fields, fills defaults and ids, and turns anything
// that would change the email into a problem in plain words, never cutting it.
import { describe, expect, it } from 'vitest';
import { EMAIL_LIMITS, blockIdFrom, docBuyIds, docImageSrcs, docLinks, normalizeDoc } from './blocks.mjs';

const OFFER = 'AbCdEfGhIjKlMnOpQrStUv';
const messages = (raw) => normalizeDoc(raw).problems.map((p) => p.message);

describe('normalizeDoc', () => {
  it('drops unknown fields, fills defaults and makes missing or repeated ids', () => {
    const { doc, problems } = normalizeDoc({ v: 9, extra: 1, blocks: [{ type: 'heading', text: 'Hi', evil: '<script>' }, { id: 'b_AAAAAAAAAA', type: 'divider' }, { id: 'b_AAAAAAAAAA', type: 'button', label: 'Go', link: { kind: 'page', x: 1 } }] });
    expect(problems).toEqual([]);
    expect(doc.v).toBe(1);
    expect(doc.theme).toEqual({ id: 'brand' });
    expect(doc.blocks[0]).toEqual({ id: expect.stringMatching(/^b_[A-Za-z0-9_-]{10}$/), type: 'heading', text: 'Hi', level: 2 });
    expect(doc.blocks[1]).toEqual({ id: 'b_AAAAAAAAAA', type: 'divider', style: 'line', size: 24 });
    expect(doc.blocks[2]).toMatchObject({ type: 'button', label: 'Go', link: { kind: 'page' }, style: 'solid' });
    expect(doc.blocks[2].id).not.toBe('b_AAAAAAAAAA');
    expect(normalizeDoc({ blocks: [{ type: 'text', text: 'a' }] }).doc).toEqual(normalizeDoc({ blocks: [{ type: 'text', text: 'a' }] }).doc);
  });

  it('never throws, and names the first problem in plain words', () => {
    for (const raw of [null, 'x', 42, [], { blocks: 'x' }, { blocks: [null, 7, { type: 'marquee' }] }]) expect(() => normalizeDoc(raw)).not.toThrow();
    expect(messages({ blocks: [{ type: 'marquee' }] })).toEqual(['Block 1 isn’t a kind of block the app knows.']);
    expect(messages({ blocks: [{ type: 'text', text: 'x'.repeat(EMAIL_LIMITS.text + 1) }] })).toEqual(['Block 1 (text) is too long: 5,001 characters, and at most 5,000 fit.']);
    expect(messages({ blocks: [{ type: 'image', src: 'http://x.example/a.png', alt: '' }] })).toEqual(['Block 1 (image) must be an https address.', 'Block 1 (image) needs a short description (alt text).']);
    expect(messages({ theme: { id: 'neon' } })).toEqual(['The email’s theme isn’t one the app knows.']);
    expect(messages({ theme: { id: 'brand', overrides: { primary: 'red', size: 30, radius: 4, nope: 1 } } })).toEqual(['The theme setting “primary” isn’t valid.', 'The theme setting “size” isn’t valid.']);
    expect(messages({ blocks: Array.from({ length: 61 }, () => ({ type: 'divider' })) })).toEqual(['An email holds at most 60 blocks.']);
    expect(messages({ blocks: [{ type: 'button', label: 'Go', link: { kind: 'offer', offerId: 'short' } }] })).toEqual(['Block 1 (button)’s link points to an offer that isn’t one of this business’s.']);
    expect(messages({ blocks: [{ type: 'video', thumb: { src: 'https://x.example/a.png', alt: 'a' }, link: { kind: 'page' } }] })).toEqual(['Block 1 (video) must link to the video’s web address.']);
    expect(messages({ blocks: [{ type: 'custom', html: 'x'.repeat(EMAIL_LIMITS.customHtmlBytes + 1) }] })[0]).toMatch(/is too big: 21 KB/);
    expect(messages({ blocks: [{ type: 'text', text: 'x'.repeat(100 * 1024) }] })[0]).toMatch(/design is too big/);
  });

  it('columns: exactly two, only heading, text, image and button inside, at most 6 each', () => {
    expect(messages({ blocks: [{ type: 'columns', cols: [{ blocks: [{ type: 'columns' }] }, { blocks: [] }] }] })).toEqual(['Block 1 (columns), column 1, block 1 (columns) can’t go inside a column.']);
    expect(messages({ blocks: [{ type: 'columns', cols: [{ blocks: [] }] }] })).toEqual(['Block 1 (columns) needs exactly two columns.']);
    expect(messages({ blocks: [{ type: 'columns', cols: [{ blocks: Array.from({ length: 7 }, () => ({ type: 'text', text: 'a' })) }, { blocks: [] }] }] })).toEqual(['Block 1 (columns): a column holds at most 6 blocks.']);
    const { doc } = normalizeDoc({ blocks: [{ type: 'columns', cols: [{ blocks: [{ type: 'text', text: 'a' }] }, { blocks: [{ type: 'text', text: 'b' }] }] }] });
    const ids = [doc.blocks[0].id, doc.blocks[0].cols[0].blocks[0].id, doc.blocks[0].cols[1].blocks[0].id];
    expect(new Set(ids).size).toBe(3);
  });

  it('keeps a migrated plain body up to the old limit', () => {
    expect(messages({ blocks: [{ type: 'text', plain: true, text: 'x'.repeat(EMAIL_LIMITS.plainText) }] })).toEqual([]);
    expect(messages({ blocks: [{ type: 'text', plain: true, text: 'x'.repeat(EMAIL_LIMITS.plainText + 1) }] })).toHaveLength(1);
  });
});

describe('what a doc links to and shows', () => {
  const doc = normalizeDoc({
    blocks: [
      { type: 'text', text: `See [this]({{product_link}}) and {{buy:${OFFER}}}` },
      { type: 'button', label: 'Get', link: { kind: 'magnet' } },
      { type: 'offer', offerId: 'ZzZzZzZzZzZzZzZzZzZzZz', title: 'T', price: '$1', image: { src: 'https://a.example/1.png', alt: 'a' } },
      { type: 'columns', cols: [{ blocks: [{ type: 'image', src: 'https://a.example/2.png', alt: 'b', link: { kind: 'url', url: 'https://x.example' } }] }, { blocks: [] }] },
      { type: 'custom', html: '<a href="{{buy:YyYyYyYyYyYyYyYyYyYyYy}}">x</a> <a href="{{ product_link }}">p</a> {{lead_magnet_link}}' },
    ],
  }).doc;
  it('lists links, buy ids and images', () => {
    expect(docLinks(doc)).toEqual([{ kind: 'page' }, { kind: 'magnet' }, { kind: 'offer', offerId: 'ZzZzZzZzZzZzZzZzZzZzZz' }, { kind: 'url', url: 'https://x.example' }, { kind: 'page' }]);
    expect(docBuyIds(doc).sort()).toEqual([OFFER, 'YyYyYyYyYyYyYyYyYyYyYy', 'ZzZzZzZzZzZzZzZzZzZzZz'].sort());
    expect(docImageSrcs(doc)).toEqual(['https://a.example/1.png', 'https://a.example/2.png']);
  });
  it('block ids from a seed are stable and well formed', () => {
    expect(blockIdFrom('x')).toBe(blockIdFrom('x'));
    expect(blockIdFrom('x')).toMatch(/^b_[A-Za-z0-9_-]{10}$/);
    expect(new Set(Array.from({ length: 1000 }, (_, i) => blockIdFrom(`s${i}`))).size).toBe(1000);
  });
});
