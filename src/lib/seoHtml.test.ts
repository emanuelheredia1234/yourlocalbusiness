// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"handleDisabledFileLoadingAsSuccess":true}}
// The SEO page in HTML mode as a document: the app's own head from the owner's metadata, JSON-LD from the owner's
// facts only, no script but that, its form posting exactly to /<slug>/lead,
// published at the same page id with its own images; and its score, read from the HTML.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaRef, Project, PromptImage } from '@/lib/types';

vi.mock('@/lib/promptImages', async (original) => ({
  ...(await original<typeof import('@/lib/promptImages')>()),
  // redrawing images needs a canvas: stand in with a tiny data URL per image
  imageDataUrls: vi.fn(async (images: PromptImage[] = []) => Object.fromEntries(images.map((i) => [i.key, `data:image/jpeg;base64,${i.key.toUpperCase()}`]))),
}));

const { useStore } = await import('@/store/useStore');
const { defaultSettings, newProject } = await import('@/store/defaults');
const { setAgentSeoPage } = await import('@/ai/agents/results');
const { seoHtmlDocument } = await import('./seoHtml');
const { seoFileHtml, seoPageId, seoPublishBuild, seoSourceHtml, seoHtmlActive } = await import('./seoPage');
const { publishTarget } = await import('./publish');
const { scoreSeo, scoreSeoHtml, htmlFacts, salesFacts, scoreFacts, generateSalesPage, generateSeoMeta } = await import('@/ai/local/seo');
const { setSeoHtmlActive } = await import('@/ai/seoBuilder');

const PID = 'proj_h1';
const media = (id: string): MediaRef => ({ id, kind: 'image', name: `${id}.jpg`, mime: 'image/jpeg', size: 1, createdAt: 0 });
const img = (n: number, id = `m${n}`): PromptImage => ({ key: `img-${n}`, media: media(id) });
const project = (): Project => useStore.getState().projects.find((p) => p.id === PID)!;

const PAGE = `<!DOCTYPE html><html><head><title>Calm Yoga</title><meta name="description" content="Calm yoga classes."><script type="application/ld+json">{"@type":"Product","offers":{"price":"9.99"},"aggregateRating":{"ratingValue":"5"}}</script></head>
<body><header><h1>Yoga classes in Austin</h1><p>Calm yoga classes for beginners.</p><a href="#contact">Book</a></header>
<section><h2>Classes</h2><img src="{{img-1}}" alt="Our studio"><img src="{{img-2}}" alt=""></section>
<section><h2>FAQ</h2><details><summary>Q1</summary><p>A</p></details><details><summary>Q2</summary><p>A</p></details><details><summary>Q3</summary><p>A</p></details></section>
<section id="contact"><h2>Contact</h2><form action="{{lead-action}}" method="post"><input name="name"><input name="email" type="email"><button>Send</button></form></section>
<script>alert(1)</script></body></html>`;

function setUp(o: { own?: boolean } = {}) {
  const p = { ...newProject('business', 'new'), id: PID };
  p.brand = { ...p.brand, name: 'Calm Studio', websiteUrl: 'https://calm.example' };
  p.location = { city: 'Austin', region: 'TX' };
  p.studio.listing = { ...p.studio.listing, phone: '+1 512 555 0100', contactEmail: 'hello@calm.example' };
  useStore.setState({ projects: [p], activeProjectId: PID, settings: defaultSettings() });
  const r = setAgentSeoPage(PID, { via: 'manus', html: PAGE, images: [img(1), img(2)], url: 'https://manus.im/app/t1', buildId: 'b1', kind: 'lead' });
  if (!r.ok) throw new Error(r.message);
  const m = project().marketing;
  useStore.getState().updateProject(PID, (x) => ({ ...x, marketing: { ...x.marketing, seo: { ...m.seo!, primaryKeyword: 'yoga classes in austin', secondaryKeywords: ['beginner yoga', 'calm yoga'], ogImageAlt: 'Our studio', ...(o.own ? { canonical: 'https://calm.example/yoga' } : {}) } } }));
}

beforeEach(() => setUp());

describe('the published page', () => {
  const target = publishTarget('https://app.example', 'calm-yoga');

  it('has the app’s head from the owner’s metadata, the share image as a full address, and twitter tags', () => {
    const html = seoPublishBuild(project(), target).html;
    expect(html).toContain('<title>Calm Yoga</title>');
    expect(html).toContain('<meta name="description" content="Calm yoga classes." />');
    expect(html).toContain('<meta name="keywords" content="yoga classes in austin, beginner yoga, calm yoga" />');
    expect(html).toContain('<link rel="canonical" href="https://app.example/calm-yoga" />');
    expect(html).toContain('<meta property="og:type" content="business.business" />');
    expect(html).toContain('<meta property="og:url" content="https://app.example/calm-yoga" />');
    expect(html).toContain('<meta property="og:image" content="https://app.example{{img-1}}" />');
    expect(html).toContain('<meta property="og:image:alt" content="Our studio" />');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
  });

  it('keeps an address the owner pasted as the canonical', () => {
    setUp({ own: true });
    expect(seoPublishBuild(project(), target).html).toContain('<link rel="canonical" href="https://calm.example/yoga" />');
  });

  it('has JSON-LD from the owner’s facts only: no offers, prices or ratings from the agent’s page', () => {
    const html = seoPublishBuild(project(), target).html;
    const json = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)![1]);
    expect(json).toEqual({
      '@context': 'https://schema.org',
      '@type': 'LocalBusiness',
      name: 'Calm Studio',
      description: 'Calm yoga classes.',
      url: 'https://app.example/calm-yoga',
      image: 'https://app.example{{img-1}}',
      address: { '@type': 'PostalAddress', addressLocality: 'Austin', addressRegion: 'TX' },
      telephone: '+1 512 555 0100',
      email: 'hello@calm.example',
    });
    expect(html).not.toMatch(/offers|aggregateRating|9\.99/);
  });

  it('has no script but its JSON-LD', () => {
    const html = seoPublishBuild(project(), target).html;
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html).toContain('<script type="application/ld+json">');
    expect(html).not.toContain('alert(1)');
  });

  it('its form posts exactly to /<slug>/lead (seoHtml.lead.test.ts runs the server’s lead check on it)', () => {
    const html = seoPublishBuild(project(), target).html;
    expect(html).toContain('<form action="/calm-yoga/lead" method="post">');
    expect(html).not.toContain('{{lead-action}}');
  });

  it('is published under the SEO page’s own id, with the HTML-mode page’s images', () => {
    const p = project();
    expect(seoPageId(p)).toBe(`seo:${PID}`);
    expect(seoPublishBuild(p, target).images).toBe(p.marketing.seoHtml!.images);
  });

  it('the builder’s page again once Version switches back', () => {
    const p = project();
    p.marketing.salesPage = generateSalesPage(p);
    useStore.setState({ projects: [p] });
    expect(setSeoHtmlActive(PID, false)).toBe(true);
    expect(seoHtmlActive(project())).toBe(false);
    const html = seoPublishBuild(project(), target).html;
    expect(html).not.toContain('Yoga classes in Austin');
  });
});

describe('the source view and the file', () => {
  it('the source shows {{img-N}} placeholders; the form sends nowhere before publishing', () => {
    const html = seoSourceHtml(project());
    expect(html).toContain('<img src="{{img-1}}" alt="Our studio">');
    expect(html).toContain('action=""');
  });

  it('the file has the images inside it', async () => {
    const out = await seoFileHtml(project());
    expect(out.missing).toEqual([]);
    expect(out.html).toContain('<img src="data:image/jpeg;base64,IMG-1" alt="Our studio">');
    expect(out.html).not.toContain('{{img-');
  });

  it('a "{{" in the owner’s words can’t become an image token', () => {
    const p = project();
    p.marketing.seo = { ...p.marketing.seo!, metaTitle: 'Yoga {{img-2}} classes' };
    expect(seoHtmlDocument(p, { canonical: '', origin: '', leadAction: '', imageUrl: () => 'X' })).toContain('<title>Yoga {&#123;img-2}} classes</title>');
  });
});

describe('its score', () => {
  it('reads the HTML: headings, first paragraph, FAQ questions, the button at the top, image alt text', () => {
    expect(htmlFacts(project().marketing.seoHtml!.html)).toEqual({
      all: expect.stringContaining('Yoga classes in Austin'),
      h1: 'Yoga classes in Austin',
      h2s: ['Classes', 'FAQ', 'Contact'],
      firstPara: 'Calm yoga classes for beginners.',
      faqItems: 3,
      heroCta: true,
      images: [{ alt: 'Our studio' }, { alt: '' }],
    });
    const s = scoreSeoHtml(project().marketing.seo!, project().marketing.seoHtml!.html, 'lead');
    const check = (id: string) => s.checks.find((c) => c.id === id)!;
    expect(check('h1-kw').pass).toBe(true);
    expect(check('faq').pass).toBe(true);
    expect(check('cta').pass).toBe(true);
    expect(check('img-alt')).toMatchObject({ pass: false, partial: true });
    expect(check('img-alt').tip).toBe('1 of 2 described. Ask for a change that describes each image (alt text).');
  });

  it('the builder’s score is the same as before the change (scoreSeo = scoreFacts of the page’s facts)', () => {
    const p = project();
    const page = generateSalesPage(p);
    const meta = generateSeoMeta(p);
    expect(scoreSeo(meta, page, 'landing')).toEqual(scoreFacts(meta, salesFacts(page), 'landing'));
    expect(scoreSeo(meta, null, 'lead')).toEqual(scoreFacts(meta, salesFacts(null), 'lead'));
  });
});
