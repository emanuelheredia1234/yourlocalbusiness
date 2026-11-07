// The email studio's glue (P5 §A1): a doc made on the fly from the plain words (nothing written), setDoc deriving
// the plain fields, exports from a doc, and the render context (values from emailTokens, buy links absolute except
// in a preview, asset links only for published assets).
import { beforeEach, describe, expect, it } from 'vitest';
import { newProject } from '@/store/defaults';
import { useStore } from '@/store/useStore';
import { useOffers } from '@/store/offers';
import { generateEmailSequence } from '@/ai/local/email';
import { emailTokens } from '@/pages/marketing/email/shared';
import { sequenceCsv, sequenceText } from './emailFunnel';
import { BUY_PREVIEW, docOf, emailHtml, emailText, emailValues, renderCtx, replaceDoc, setDoc, undoDoc, unhostedImages, unknownBuyIds, variantDoc } from './emailDoc';
import type { EmailDoc } from '../../shared/email/blocks.mjs';
import type { Project } from './types';

const OFFER = 'AbCdEfGhIjKlMnOpQrStUv';
const OTHER = 'ZzZzZzZzZzZzZzZzZzZzZz';

function setup(): Project {
  const p = newProject('business');
  p.brand.name = 'Copper & Comb';
  p.brand.websiteUrl = 'https://copperandcomb.com';
  p.marketing.emails = generateEmailSequence(p, null);
  p.studio.codeAssets = [
    { id: 'pub', name: 'Quiz', kind: 'hero', prompt: '', html: '', css: '', js: '', published: { slug: 'quiz', url: 'https://yourlocalbusiness.replit.app/quiz', publishedAt: 1, hash: 'h' } },
    { id: 'draft', name: 'Draft', kind: 'hero', prompt: '', html: '', css: '', js: '' },
  ] as Project['studio']['codeAssets'];
  useStore.setState({ projects: [p], activeProjectId: p.id });
  useOffers.setState((s) => ({ ...s, byProject: { [p.id]: [{ id: OFFER, title: 'Cut', link: `https://yourlocalbusiness.replit.app/b/${OFFER}` }] as never } }));
  return p;
}
const now = (id: string) => useStore.getState().projects.find((x) => x.id === id)!;

describe('docOf and setDoc', () => {
  let p: Project;
  beforeEach(() => {
    p = setup();
  });

  it('makes a doc from the plain words without writing anything', () => {
    const e = p.marketing.emails[0];
    const doc = docOf(e, p);
    expect(doc.blocks[0]).toMatchObject({ type: 'text', plain: true, text: e.body });
    expect(now(p.id).marketing.emails[0].doc).toBeUndefined();
  });

  it('writes the doc and derives body, button label and link from it', () => {
    const e = p.marketing.emails[0];
    const doc: EmailDoc = {
      v: 1,
      theme: { id: 'bold' },
      blocks: [
        { id: 'b_aaaaaaaaaa', type: 'heading', text: 'Welcome', level: 1 },
        { id: 'b_bbbbbbbbbb', type: 'text', text: 'Hi {{first_name}}, here it is.' },
        { id: 'b_cccccccccc', type: 'button', label: 'Get it', link: { kind: 'offer', offerId: OFFER }, style: 'solid' },
      ],
    };
    setDoc(p.id, e.id, doc);
    const after = now(p.id).marketing.emails[0];
    expect(after.doc?.theme).toEqual({ id: 'bold' });
    expect(after.body).toBe('Welcome\n\nHi {{first_name}}, here it is.');
    expect(after.ctaLabel).toBe('Get it');
    expect(after.ctaUrl).toBe(`{{buy:${OFFER}}}`);
  });

  it('undoes a replacing change, back to no doc at all', () => {
    const e = p.marketing.emails[1];
    replaceDoc(p.id, e.id, { v: 1, theme: { id: 'warm' }, blocks: [{ id: 'b_dddddddddd', type: 'text', text: 'New' }] });
    expect(now(p.id).marketing.emails[1].doc?.theme.id).toBe('warm');
    expect(undoDoc(p.id, e.id)).toBe(true);
    expect(now(p.id).marketing.emails[1].doc).toBeUndefined();
    expect(undoDoc(p.id, e.id)).toBe(false);
  });
});

describe('exports from a doc', () => {
  it('uses the doc’s plain-text part in .txt and CSV, with buy links filled in, and an html column on request', () => {
    const p = setup();
    const e = p.marketing.emails[2];
    setDoc(p.id, e.id, { v: 1, theme: { id: 'brand' }, blocks: [{ id: 'b_eeeeeeeeee', type: 'text', text: 'Read **this**, {{first_name}}.' }, { id: 'b_ffffffffff', type: 'button', label: 'Buy', link: { kind: 'offer', offerId: OFFER }, style: 'solid' }] });
    const q = now(p.id);
    const text = emailText(q.marketing.emails[2], q);
    expect(text).toContain('Read this, {{first_name}}.');
    expect(text).toContain(`https://yourlocalbusiness.replit.app/b/${OFFER}`);
    expect(sequenceText(q)).toContain('Read this, {{first_name}}.');
    const csv = sequenceCsv(q, {}, () => '<html>x</html>');
    expect(csv.split('\n')[0]).toBe('step,send,subject,preview,body,button,button_link,html');
    expect(csv).toContain('"<html>x</html>"');
    expect(sequenceCsv(q).split('\n')[0]).toBe('step,send,subject,preview,body,button,button_link');
  });
});

describe('the render context', () => {
  it('fills values as emailTokens does, buy links absolute (dead in a preview), published assets only', () => {
    const p = setup();
    const t = emailTokens(p);
    expect(emailValues(p)).toEqual({ first_name: t.first_name, email: t.email, lead_magnet_link: t.lead_magnet_link, product_link: t.product_link, sender_name: t.sender_name, brand: t.brand });
    const exp = renderCtx(p, 'export', { esp: 'mailchimp' });
    expect(exp.links?.[`buy:${OFFER}`]).toBe(`https://yourlocalbusiness.replit.app/b/${OFFER}`);
    expect(exp.links?.['asset:pub']).toBe('https://yourlocalbusiness.replit.app/quiz');
    expect(exp.links?.['asset:draft']).toBeUndefined();
    expect(renderCtx(p, 'preview').links?.[`buy:${OFFER}`]).toBe(BUY_PREVIEW);
  });

  it('renders a preview whose buy buttons never open a checkout, and an export with the tool’s unsubscribe tag', () => {
    const p = setup();
    const e = { ...p.marketing.emails[4], doc: { v: 1 as const, theme: { id: 'brand' as const }, blocks: [{ id: 'b_gggggggggg', type: 'button' as const, label: 'Buy', link: { kind: 'offer' as const, offerId: OFFER }, style: 'solid' as const }] } };
    const pv = emailHtml(e, p, 'preview');
    expect(pv.html).toContain('href="#buy-preview"');
    expect(pv.html).not.toContain('/b/');
    const ex = emailHtml(e, p, 'export', { esp: 'mailchimp' });
    expect(ex.html).toContain('*|UNSUB|*');
    expect(ex.html).toContain(`/b/${OFFER}`);
  });

  it('finds unknown buy links and images the server wouldn’t host', () => {
    const p = setup();
    const doc: EmailDoc = {
      v: 1,
      theme: { id: 'brand' },
      blocks: [
        { id: 'b_hhhhhhhhhh', type: 'button', label: 'Buy', link: { kind: 'offer', offerId: OTHER }, style: 'solid' },
        { id: 'b_iiiiiiiiii', type: 'image', src: 'https://cdn.example/x.png', alt: 'x', width: 'full', origin: 'url' },
        { id: 'b_jjjjjjjjjj', type: 'image', src: 'https://abc.supabase.co/storage/v1/object/public/public-files/u1/e-AAAAAAAAAAAAAAAAAAAAAA.png', alt: 'y', width: 'full', origin: 'upload' },
      ],
    };
    expect(unknownBuyIds(doc, p)).toEqual([OTHER]);
    expect(unhostedImages(doc)).toEqual(['https://cdn.example/x.png']);
  });

  it('makes version B’s doc with B’s opening in the first text block', () => {
    const p = setup();
    const e = p.marketing.emails[1];
    const step = { ...e, doc: docOf(e, p), variants: { experimentId: 'x', changed: 'opening' as const, b: { subject: e.subject, preview: e.preview, body: `A new opening.\n\n${e.body.split(/\n\s*\n/).slice(1).join('\n\n')}` } } };
    const b = variantDoc(step, p)!;
    expect(b.blocks[0]).toMatchObject({ type: 'text', text: step.variants.b.body });
  });
});
