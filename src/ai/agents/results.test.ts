// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"handleDisabledFileLoadingAsSuccess":true}}
// Using a page from Manus or Viktor: a new asset with its kind, source and the owner's words (or an earlier one
// replaced, which Undo puts back); the SEO page's HTML mode with its images renumbered above the page's own numbers,
// metadata made from the page when there's none, the page type set, and Undo back to an empty builder.
import { beforeEach, describe, expect, it } from 'vitest';
import type { MediaRef, Project, PromptImage } from '@/lib/types';
import { useStore } from '@/store/useStore';
import { defaultSettings, newProject } from '@/store/defaults';
import { useSeoUndo } from '@/store/seoUndo';
import { useCodeTabMemory, undoCodeAsset } from '@/lib/codeAssets';
import { undoSeo } from '@/ai/seoBuilder';
import { addAgentAsset, remapImages, setAgentSeoPage, type AgentHtmlSource } from './results';

const PID = 'proj_r1';
const media = (id: string): MediaRef => ({ id, kind: 'image', name: `${id}.jpg`, mime: 'image/jpeg', size: 1, createdAt: 0, thumb: 'data:image/jpeg;base64,AAAA' });
const img = (n: number, id = `m${n}`, note?: string): PromptImage => ({ key: `img-${n}`, media: media(id), ...(note ? { note } : {}) });
const project = (): Project => useStore.getState().projects.find((p) => p.id === PID)!;

const PAGE = `<!DOCTYPE html><html><head><title>Calm Yoga Booking</title><meta name="description" content="Book a calm yoga class in Austin."><style>h1{color:#123}</style></head>
<body><header><h1>Book a class</h1><a href="https://calendly.com/calm">Book</a></header><img src="{{img-1}}" alt="Studio"><img src="{{img-2}}" alt="Mats"><img src="{{img-9}}" alt="not sent">
<form action="{{lead-action}}" method="post"><input name="name"><input name="email"><button>Send</button></form><script>console.log(1)</script></body></html>`;

const src = (patch: Partial<AgentHtmlSource> = {}): AgentHtmlSource => ({ via: 'viktor', html: PAGE, images: [img(1, 'm1', 'our studio'), img(2)], url: 'https://slack.example/p1', buildId: 'build_1', kind: 'booking', request: 'A booking widget', ...patch });

beforeEach(() => {
  const p = { ...newProject('business', 'new'), id: PID };
  p.brand = { ...p.brand, name: 'Calm Studio', websiteUrl: 'https://calm.example' };
  p.location = { city: 'Austin', region: 'TX' };
  useStore.setState({ projects: [p], activeProjectId: PID, settings: defaultSettings() });
  useSeoUndo.setState({ stacks: {} });
  useCodeTabMemory.setState({ undo: {}, drafts: {} });
});

describe('as a Code & assets asset', () => {
  it('a new asset first in the list, with the kind, the owner’s words, its source and only the owner’s images', () => {
    const r = addAgentAsset(PID, src());
    if (!r.ok) throw new Error(r.message);
    const a = project().studio.codeAssets[0];
    expect(r.asset.id).toBe(a.id);
    expect(a).toMatchObject({ name: 'Calm Yoga Booking', kind: 'booking', prompt: 'A booking widget', outdated: false, source: { via: 'viktor', url: 'https://slack.example/p1', buildId: 'build_1' } });
    expect(a.html).toContain('<img src="{{img-1}}" alt="Studio">');
    expect(a.html).not.toContain('img-9');
    expect(a.js).toBe('console.log(1)');
    expect(a.css).toBe('h1{color:#123}');
    expect(a.images?.map((i) => i.key)).toEqual(['img-1', 'img-2']);
    // the project keeps no thumbnails for these
    expect(a.images?.every((i) => i.media.thumb === undefined)).toBe(true);
    expect(r.notes.some((n) => n.includes('one of yours'))).toBe(true);
  });

  it('no kind (a page from the chat): the title’s kind, else a hero section', () => {
    const r1 = addAgentAsset(PID, src({ kind: undefined, html: PAGE.replace('Calm Yoga Booking', 'Pricing table for classes') }));
    expect(r1.ok && r1.asset.kind).toBe('pricing');
    const r2 = addAgentAsset(PID, src({ kind: 'nonsense', html: PAGE.replace('Calm Yoga Booking', 'Welcome') }));
    expect(r2.ok && r2.asset.kind).toBe('hero');
  });

  it('replacing an asset made earlier: the same file keeps its number, a new one gets the next; Undo puts the code back', () => {
    const first = addAgentAsset(PID, src());
    if (!first.ok) throw new Error(first.message);
    // the agent's next page numbers its images its own way: img-1 is the owner's new logo, img-2 the studio photo
    const next = src({ html: PAGE.replace('Book a class', 'Book a calm class'), images: [img(1, 'logo'), img(2, 'm1')] });
    const r = addAgentAsset(PID, next, { replaceAssetId: first.asset.id });
    if (!r.ok) throw new Error(r.message);
    const a = project().studio.codeAssets.find((x) => x.id === first.asset.id)!;
    expect(project().studio.codeAssets).toHaveLength(1);
    expect(a.html).toContain('Book a calm class');
    // the studio photo (m1) keeps img-1; the logo becomes img-3
    expect(a.html).toContain('<img src="{{img-3}}" alt="Studio">');
    expect(a.html).toContain('<img src="{{img-1}}" alt="Mats">');
    expect(a.images?.map((i) => `${i.key}=${i.media.id}`)).toEqual(['img-1=m1', 'img-2=m2', 'img-3=logo']);
    expect(undoCodeAsset(PID, a.id)).toBe('undone');
    expect(project().studio.codeAssets[0].html).toContain('Book a class');
  });

  it('a page that can’t be used is refused, and nothing changes', () => {
    const r = addAgentAsset(PID, src({ html: 'Here is your page: page.zip' }));
    expect(r).toEqual({ ok: false, message: 'That reply isn’t a usable page: it isn’t an HTML document.' });
    expect(project().studio.codeAssets).toEqual([]);
  });

  it('remapImages: the same file keeps its key, others take the next free one (never a reserved key)', () => {
    const r = remapImages([img(1), img(2)], [img(1, 'm2'), img(2, 'new')], ['img-3']);
    expect(r.map).toEqual({ 'img-1': 'img-2', 'img-2': 'img-4' });
    expect(r.added.map((i) => i.key)).toEqual(['img-4']);
  });
});

describe('as the SEO page (HTML mode)', () => {
  it('its images are numbered above the page’s own (seoImageMax), which is raised; the same file keeps its number', () => {
    const p = project();
    p.marketing.seoImages = [img(1, 'm1'), img(4, 'own')];
    p.marketing.seoImageMax = 6;
    useStore.setState({ projects: [p] });
    const r = setAgentSeoPage(PID, src());
    if (!r.ok) throw new Error(r.message);
    const h = project().marketing.seoHtml!;
    // m1 is already the page's img-1; m2 is new: img-7, above the highest number ever used (6)
    expect(h.html).toContain('<img src="{{img-1}}" alt="Studio">');
    expect(h.html).toContain('<img src="{{img-7}}" alt="Mats">');
    expect(h.html).not.toContain('img-9');
    expect(h.images.map((i) => `${i.key}=${i.media.id}`)).toEqual(['img-1=m1', 'img-7=m2']);
    expect(project().marketing.seoImageMax).toBe(7);
    expect(h).toMatchObject({ active: true, hasLeadForm: true, title: 'Calm Yoga Booking', source: { via: 'viktor', url: 'https://slack.example/p1', buildId: 'build_1' } });
    expect(h.html).toContain('action="{{lead-action}}"');
    expect(h.html).not.toContain('<script');
    expect(project().marketing.pageType).toBe('booking');
    expect(r.replaced).toBe(false);
  });

  it('makes metadata from the page when there’s none (no AI), with the address the app would give it', () => {
    setAgentSeoPage(PID, src());
    expect(project().marketing.seo).toEqual({
      metaTitle: 'Calm Yoga Booking',
      metaDescription: 'Book a calm yoga class in Austin.',
      slug: 'calm-studio',
      primaryKeyword: '',
      secondaryKeywords: [],
      ogTitle: 'Calm Yoga Booking',
      ogDescription: 'Book a calm yoga class in Austin.',
      ogImageAlt: 'our studio',
      canonical: 'https://calm.example/calm-studio',
    });
  });

  it('Undo takes an empty builder back to nothing; the image numbers used stay used', () => {
    setAgentSeoPage(PID, src());
    expect(project().marketing.seoImageMax).toBe(2);
    expect(undoSeo(PID)).toBe('undone');
    const m = project().marketing;
    expect(m.seoHtml).toBeUndefined();
    expect(m.seo).toBeNull();
    expect(m.salesPage).toBeNull();
    expect(m.seoImageMax).toBe(2);
  });

  it('refused past img-99', () => {
    const p = project();
    p.marketing.seoImageMax = 99;
    useStore.setState({ projects: [p] });
    expect(setAgentSeoPage(PID, src())).toEqual({ ok: false, message: 'Too many image numbers used on this page: remove an image you no longer use.' });
    expect(project().marketing.seoHtml).toBeUndefined();
  });

  it('a second page replaces the first (Undo brings it back)', () => {
    setAgentSeoPage(PID, src());
    const r = setAgentSeoPage(PID, src({ via: 'manus', html: PAGE.replace('Book a class', 'Manus’s class page'), url: 'https://manus.im/app/t1', buildId: 'build_2' }));
    expect(r.ok && r.replaced).toBe(true);
    expect(project().marketing.seoHtml?.source.via).toBe('manus');
    undoSeo(PID);
    expect(project().marketing.seoHtml?.source.via).toBe('viktor');
  });
});
