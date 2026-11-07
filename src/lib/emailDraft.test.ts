// The Omnisend draft request's checks (P5 §A6): a link with no address, wherever it is (custom HTML included), is
// refused before the request and named by where it is; the [brackets] hint only when the email has placeholders.
import { beforeEach, describe, expect, it } from 'vitest';
import { newProject } from '@/store/defaults';
import { useStore } from '@/store/useStore';
import { normalizeDoc, type EmailDoc } from '../../shared/email/blocks.mjs';
import { draftHasPlaceholders, draftProblem, type EmailDraftPayload } from './emailDraft';
import type { Project } from './types';

let p: Project;
beforeEach(() => {
  p = newProject('business');
  p.brand.name = 'Copper & Comb';
  useStore.setState({ projects: [p], activeProjectId: p.id });
});

const draft = (blocks: unknown[], o: Partial<EmailDraftPayload> = {}): EmailDraftPayload => ({
  name: 'x',
  subject: 'Your guide',
  preheader: 'Page one',
  doc: normalizeDoc({ v: 1, blocks }).doc as EmailDoc,
  values: { first_name: '[First name]', lead_magnet_link: '[link to your free download]', product_link: '[link to your offer]', brand: 'Copper & Comb' },
  brand: { name: 'Copper & Comb', colors: {} },
  footerNote: '',
  assetLinks: {},
  ...o,
});

describe('draftProblem', () => {
  it('refuses a custom block whose href is a link tag with no address yet', () => {
    const d = draft([{ type: 'custom', html: '<a href="{{lead_magnet_link}}">Get it</a>' }]);
    expect(draftProblem(p, d)).toMatch(/^A link in this email’s custom HTML has no web address yet\./);
    const ok = draft([{ type: 'custom', html: '<a href="{{lead_magnet_link}}">Get it</a>' }], { values: { lead_magnet_link: 'https://app.example/m/AAAAAAAAAAAAAAAAAAAAAA' } });
    expect(draftProblem(p, ok)).toBe('');
  });

  it('names where the link is: a linked image isn’t called a button', () => {
    const d = draft([{ type: 'image', src: 'https://sb.example/storage/v1/object/public/public-files/u/AAAAAAAAAAAAAAAAAAAAAA.png', alt: 'x', link: { kind: 'magnet' } }]);
    expect(draftProblem(p, d)).toMatch(/^This email’s linked image has no web address yet\./);
    expect(draftProblem(p, draft([{ type: 'button', label: 'Go', link: { kind: 'page' } }]))).toMatch(/^This email’s button has no web address yet\./);
  });
});

describe('draftHasPlaceholders', () => {
  it('no hint for an email without placeholders, though first_name’s value is one', () => {
    expect(draftHasPlaceholders(draft([{ type: 'text', text: 'Hello there. See [our page](https://copperandcomb.com).' }]))).toBe(false);
  });
  it('a hint when the email uses a tag whose value is a placeholder, or has [bracket] words', () => {
    expect(draftHasPlaceholders(draft([{ type: 'text', text: 'Hi {{first_name}},' }]))).toBe(true);
    expect(draftHasPlaceholders(draft([{ type: 'custom', html: '<p>Hi {{ first_name }}</p>' }]))).toBe(true);
    expect(draftHasPlaceholders(draft([{ type: 'text', text: 'Open [your hours].' }]))).toBe(true);
    expect(draftHasPlaceholders(draft([{ type: 'text', text: 'Hi.' }], { subject: 'For [First name]' }))).toBe(true);
  });
});
