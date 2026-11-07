// Plain-text emails ↔ block docs (P5 §1.3, §S8): the round trip is the identity for every email the app's own
// generator writes (every purpose, every length and framework, product and business), the CTA maps to a Link and
// back, and every template takes an email's words.
import { describe, expect, it } from 'vitest';
import { newProject } from '@/store/defaults';
import { generateEmailSequence, generateLeadMagnet } from '@/ai/local/email';
import { generateBrandKit } from '@/ai/local/brand';
import { generateBusinessModel } from '@/ai/local/studio';
import { normalizeDoc } from './blocks.mjs';
import { TEMPLATES, applyTemplate, docFromPlain, plainFromDoc, templateFor } from './migrate.mjs';
import { renderEmail } from './render.mjs';

const OFFER = 'AbCdEfGhIjKlMnOpQrStUv';

function project(track) {
  const p = newProject(track, 'new');
  p.niche = track === 'business' ? 'Home Cleaning' : 'Personal Finance';
  p.category = track === 'business' ? 'Eco-friendly house cleaning' : 'Freelancer Tax Tracking';
  if (track === 'business') p.location = { city: 'Austin', region: 'TX' };
  const kit = generateBrandKit(p);
  p.brand = { ...p.brand, name: kit.nameOptions[0].name, colors: kit.colors };
  if (track === 'business') p.studio.packages = generateBusinessModel(p).packages;
  return p;
}

const steps = [];
for (const track of ['product', 'business']) {
  const p = project(track);
  const lm = generateLeadMagnet(p, 'checklist');
  for (const d of [{}, { length: 'short' }, { length: 'long' }, { framework: 'AIDA' }, { framework: 'BAB' }, { framework: 'StoryBrand' }]) steps.push(...generateEmailSequence(p, lm, d, 1));
  steps.push(...generateEmailSequence(p, null, {}, 2));
}

const SHAPES = [
  { id: 'a', body: '', ctaLabel: '', ctaUrl: '' },
  { id: 'b', body: 'Only words, no button.', ctaLabel: '', ctaUrl: '' },
  { id: 'c', body: 'x', ctaLabel: 'Buy', ctaUrl: `{{buy:${OFFER}}}` },
  { id: 'd', body: 'x', ctaLabel: 'Go', ctaUrl: 'https://shop.example/a?b=1' },
  { id: 'e', body: 'x', ctaLabel: 'Go', ctaUrl: '[link to your offer]' },
  { id: 'f', body: 'x', ctaLabel: '', ctaUrl: 'https://shop.example' },
  { id: 'g', body: 'x', ctaLabel: 'Label only', ctaUrl: '' },
  { id: 'h', body: '**not bold** *nor italic* [nor](a link)\n- nor a list\n\n\n\nkept   as typed  ', ctaLabel: 'Go', ctaUrl: '{{product_link}}' },
];

describe('plain → doc → plain', () => {
  it(`is the identity for every generated email (${steps.length}) and every hand-made shape`, () => {
    expect(steps.length).toBeGreaterThanOrEqual(70);
    for (const s of [...steps, ...SHAPES]) {
      const doc = docFromPlain(s);
      expect(normalizeDoc(doc).problems).toEqual([]);
      expect(plainFromDoc(doc)).toEqual({ body: s.body, ctaLabel: s.ctaLabel, ctaUrl: s.ctaUrl });
    }
  });

  it('covers every purpose in the sequence', () => {
    expect(new Set(steps.map((s) => s.purpose)).size).toBe(5);
  });

  it('maps the CTA to a Link', () => {
    const link = (ctaUrl) => docFromPlain({ id: 'x', body: '', ctaLabel: 'Go', ctaUrl }).blocks[1].link;
    expect(link('{{lead_magnet_link}}')).toEqual({ kind: 'magnet' });
    expect(link('{{product_link}}')).toEqual({ kind: 'page' });
    expect(link(`{{buy:${OFFER}}}`)).toEqual({ kind: 'offer', offerId: OFFER });
    expect(link('https://shop.example/')).toEqual({ kind: 'url', url: 'https://shop.example/' });
    expect(link('[link to your offer]')).toEqual({ kind: 'url', url: '[link to your offer]' });
    expect(link('')).toEqual({ kind: 'url', url: '' });
  });

  it('makes the same ids for the same step, so docOf is stable', () => {
    expect(docFromPlain(steps[0])).toEqual(docFromPlain(structuredClone(steps[0])));
    expect(docFromPlain(steps[0]).blocks[0].id).not.toBe(docFromPlain(steps[1]).blocks[0].id);
  });

  it('a doc’s plain words: headings and text joined, markup removed except links, the first button', () => {
    const doc = { v: 1, theme: { id: 'brand' }, blocks: [{ type: 'heading', text: 'Hello', level: 1 }, { type: 'text', text: 'A **bold** [link]({{lead_magnet_link}}).\n- one\n- two' }, { type: 'button', label: 'First', link: { kind: 'asset', assetId: 'calc' } }, { type: 'button', label: 'Second', link: { kind: 'page' } }] };
    expect(plainFromDoc(doc, { assetLinks: { calc: 'https://app.example/p/calc' } })).toEqual({ body: 'Hello\n\nA bold link ({{lead_magnet_link}}).\n- one\n- two', ctaLabel: 'First', ctaUrl: 'https://app.example/p/calc' });
  });

  it('a migrated email renders its body as written (the old plain-text draft, now designed)', () => {
    const s = steps[0];
    const { html } = renderEmail(docFromPlain(s), { target: 'omnisend', values: { first_name: '[First name]', lead_magnet_link: 'https://app.example/m/AAAAAAAAAAAAAAAAAAAAAA', product_link: 'https://shop.example', sender_name: 'Maya' } });
    expect(html).toContain('Hi &#91;First name&#93;');
    expect(html).toContain('>Download your free guide</a>');
  });
});

describe('templates', () => {
  const plain = { subject: 'Your guide is inside', body: 'Hi {{first_name}},\n\nOne.\n\nTwo.\n\nThree.\n\nFour.', ctaLabel: 'Get it', ctaUrl: '{{lead_magnet_link}}' };
  it('each takes the email’s words: subject in the heading, paragraphs over the text slots, the CTA on the button', () => {
    expect(TEMPLATES.map((t) => t.id)).toEqual(['delivery', 'quick_win', 'story', 'offer', 'newsletter', 'plain']);
    for (const t of TEMPLATES) {
      const doc = applyTemplate(t.id, plain, { offer: { id: OFFER, title: 'Course', price: '$49' } });
      expect(normalizeDoc(doc).problems).toEqual([]);
      const back = plainFromDoc(doc);
      const words = back.body.replace(/\n\n/g, ' ');
      for (const w of ['One.', 'Two.', 'Three.', 'Four.']) expect(words).toContain(w);
      expect(back.ctaLabel).toBe('Get it');
      expect(back.ctaUrl).toBe('{{lead_magnet_link}}');
      if (t.blocks.some((b) => b.slot === 'subject')) expect(doc.blocks[0]).toMatchObject({ type: 'heading', text: 'Your guide is inside' });
      if (t.id === 'offer') expect(doc.blocks.find((b) => b.type === 'offer')).toMatchObject({ offerId: OFFER, title: 'Course', price: '$49' });
    }
  });

  it('no CTA, no button; fewer paragraphs than slots, no empty blocks', () => {
    const doc = applyTemplate('story', { subject: 'S', body: 'Only one.', ctaLabel: '', ctaUrl: '' });
    expect(doc.blocks.filter((b) => b.type === 'button')).toEqual([]);
    expect(doc.blocks.filter((b) => b.type === 'text')).toHaveLength(1);
  });

  it('suits each sequence purpose', () => {
    expect(steps.slice(0, 5).map((s, i) => templateFor(s.purpose, i + 1, 5))).toEqual(['delivery', 'quick_win', 'story', 'story', 'offer']);
    expect(templateFor('something else', 1)).toBe('delivery');
    expect(templateFor('something else', 5, 5)).toBe('offer');
  });

  it('the delivery and newsletter templates show the logo header', () => {
    expect(applyTemplate('delivery', plain).theme).toEqual({ id: 'brand', overrides: { headerLogo: true } });
    expect(applyTemplate('plain', plain, { theme: { id: 'warm' } }).theme).toEqual({ id: 'warm' });
  });
});
