// The email studio's AI checks (P5 §A9): a design keeps the email's words and drops custom HTML, real pictures,
// unknown links and offers; "Make it bolder" may change only its keys and shorter labels; the local fallbacks are
// deterministic; the tasks are metered as the email function.
import { describe, expect, it } from 'vitest';
import type { EmailDoc } from '../../shared/email/blocks.mjs';
import { applyBolder, localBolder, localDesign, validateBlocksEdit, validateBolder, validateDesign, allowedFrom, type EmailDesignInput } from './emailDesign';
import { emailBlocksEditTask, emailBolderTask, emailDesignTask } from './tasks';
import { functionForTask } from './functions';

const OFFER = 'AbCdEfGhIjKlMnOpQrStUv';
const input: EmailDesignInput = {
  stepId: 'em_1',
  purpose: 'Offer',
  index: 4,
  total: 5,
  subject: 'Last chance',
  preview: 'p',
  body: 'Hi {{first_name}},\n\nThe course helps you cut hair at home. Read https://copperandcomb.com/faq first.\n\nSee you inside.',
  ctaLabel: 'Join now',
  ctaUrl: `{{buy:${OFFER}}}`,
  theme: { id: 'brand' },
  offers: [{ id: OFFER, title: 'Home cuts course', price: '$49' }],
  hasMagnet: false,
  hasPage: true,
};

describe('Design this email', () => {
  it('drops custom HTML, real pictures, unknown links and offers, and keeps the words', () => {
    const raw = {
      theme: { id: 'bold', overrides: { size: 17, evil: 'x' } },
      blocks: [
        { type: 'heading', text: 'Last chance', level: 1 },
        { type: 'text', text: 'Hi {{first_name}}, the course helps you cut hair at home. [Read this](https://evil.example) and [the FAQ](https://copperandcomb.com/faq).' },
        { type: 'custom', html: '<script>x</script>' },
        { type: 'image', src: 'https://evil.example/pixel.gif', alt: 'A haircut at home', prompt: 'A person cutting hair at home' },
        { type: 'button', label: 'Get the freebie', link: { kind: 'magnet' } },
        { type: 'button', label: 'Join now', link: { kind: 'offer', offerId: OFFER } },
        { type: 'offer', offerId: 'ZzZzZzZzZzZzZzZzZzZzZz', buttonLabel: 'Buy' },
        { type: 'offer', offerId: OFFER, title: 'Made up', price: '$1', buttonLabel: 'Buy' },
        { type: 'video', thumb: { src: 'https://x.example/t.png', alt: 't' }, link: { kind: 'url', url: 'https://x.example' } },
      ],
    };
    const doc = validateDesign(raw, input)!;
    expect(doc.theme).toEqual({ id: 'bold', overrides: { size: 17 } });
    expect(doc.blocks.map((b) => b.type)).toEqual(['heading', 'text', 'image', 'button', 'offer']);
    const text = doc.blocks[1] as Extract<EmailDoc['blocks'][number], { type: 'text' }>;
    expect(text.text).not.toContain('evil.example');
    expect(text.text).toContain('Read this and [the FAQ](https://copperandcomb.com/faq)');
    expect(doc.blocks[2]).toMatchObject({ type: 'image', src: '', prompt: 'A person cutting hair at home', origin: 'ai' });
    expect(doc.blocks[4]).toMatchObject({ type: 'offer', offerId: OFFER, title: 'Home cuts course', price: '$49' });
  });

  it('refuses a design that lost the email’s words, and falls back to the template locally, deterministically', () => {
    expect(validateDesign({ blocks: [{ type: 'divider' }] }, input)).toBeNull();
    expect(validateDesign('nonsense', input)).toBeNull();
    const a = localDesign(input);
    expect(localDesign(input)).toEqual(a);
    expect(a.blocks.some((b) => b.type === 'offer')).toBe(true);
    expect(JSON.stringify(a)).toContain('cut hair at home');
  });
});

describe('Make it bolder', () => {
  const doc: EmailDoc = {
    v: 1,
    theme: { id: 'brand' },
    blocks: [
      { id: 'b_aaaaaaaaaa', type: 'heading', text: 'A long heading here', level: 2 },
      { id: 'b_bbbbbbbbbb', type: 'text', text: 'Body words stay.' },
      { id: 'b_cccccccccc', type: 'button', label: 'Read the guide', link: { kind: 'page' }, style: 'outline' },
    ],
  };
  it('keeps only its keys, valid values and shorter labels for the doc’s own blocks', () => {
    const p = validateBolder({ overrides: { size: 18, font: 'georgia', width: 640, headingCase: 'upper', primary: 'red' }, labels: { b_aaaaaaaaaa: 'Short', b_bbbbbbbbbb: 'Changed body', b_cccccccccc: 'Read it now, today, right this minute please' } }, doc);
    expect(p.overrides).toEqual({ size: 18, headingCase: 'upper' });
    expect(p.labels).toEqual({ b_aaaaaaaaaa: 'Short' });
    const out = applyBolder(doc, p);
    expect(out.blocks[0]).toMatchObject({ text: 'Short', level: 1 });
    expect(out.blocks[1]).toMatchObject({ text: 'Body words stay.' });
    expect(out.blocks[2]).toMatchObject({ style: 'solid', full: true, label: 'Read the guide' });
  });

  it('has a deterministic local fallback', () => {
    expect(localBolder(doc)).toEqual({ overrides: { size: 18, density: 'airy', headingCase: 'upper' }, labels: {} });
    expect(localBolder(doc)).toEqual(localBolder(doc));
  });
});

describe('assistant block edits', () => {
  it('keeps the owner’s custom HTML as it was, and never adds one', () => {
    const before: EmailDoc = { v: 1, theme: { id: 'brand' }, blocks: [{ id: 'b_cccccccccc', type: 'custom', html: '<p>Mine</p>', source: 'owner' }, { id: 'b_dddddddddd', type: 'text', text: 'Old' }] };
    const out = validateBlocksEdit(
      { doc: { blocks: [{ id: 'b_cccccccccc', type: 'custom', html: '<script>x</script>' }, { id: 'b_dddddddddd', type: 'text', text: 'New' }, { type: 'custom', html: '<b>added</b>' }] } },
      before,
      allowedFrom(input),
      input.offers,
    )!;
    expect(out.blocks).toEqual([before.blocks[0], { id: 'b_dddddddddd', type: 'text', text: 'New' }]);
  });
});

describe('metering', () => {
  it('bills the three tasks to the email function', () => {
    for (const t of [emailDesignTask, emailBolderTask, emailBlocksEditTask]) expect(functionForTask(t.id)?.id).toBe('email');
  });
});
