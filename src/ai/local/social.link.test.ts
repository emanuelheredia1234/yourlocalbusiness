// Social posts carry the published page's link where each network's setting puts it: in the caption, in
// the first comment (a reply on X) or in the bio. The built-in engine and the AI write for that place, and
// the app places the link itself afterwards, so it is never made up. Without a page or website, posts are
// written exactly as before.
import { describe, expect, it } from 'vitest';
import { newProject } from '@/store/defaults';
import type { LinkPlacement, PageType, PostPlatform, PostType, Project, StyleId } from '@/lib/types';
import { firstCommentFor, placementFor, postLinkFor, xLength, type PostLink } from '@/lib/pageLink';
import { generateBusinessModel, generateListing } from './studio';
import { composePost, defaultCampaign, finishCaption, generateCampaignPlan, generateContentBatch, linkRule } from './social';
import { contentBatchTask, postTask, type TaskEnv } from '../tasks';

const PAGE = 'https://yourlocalbusiness.replit.app/summit-cleaning-austin';
const SITE = 'summit-clean.net';

function business(o: { website?: string; published?: boolean; pageType?: PageType; linkPlacement?: Partial<Record<PostPlatform, LinkPlacement>> } = {}): Project {
  const p = newProject('business', 'new');
  p.id = 'proj_link';
  p.niche = 'Home Cleaning';
  p.category = 'Eco-friendly house cleaning';
  p.businessType = 'Home Cleaning';
  p.location = { city: 'Austin', region: 'TX' };
  p.brand.name = 'Summit Co';
  p.brand.websiteUrl = o.website ?? '';
  const bm = generateBusinessModel(p);
  p.studio.packages = bm.packages;
  p.studio.price = bm.price;
  p.studio.listing = generateListing(p);
  if (o.published) p.marketing.seoPublished = { slug: 'summit-cleaning-austin', url: PAGE, publishedAt: 1, hash: 'h' };
  if (o.pageType) p.marketing.pageType = o.pageType;
  if (o.linkPlacement) p.marketing.linkPlacement = o.linkPlacement;
  return p;
}

const TYPES: PostType[] = ['educational', 'tip', 'question', 'sales', 'bts'];
const NETWORKS: PostPlatform[] = ['instagram', 'facebook', 'tiktok', 'linkedin', 'x'];
const compose = (p: Project, platform: PostPlatform, postType: PostType, seed: number | string, link?: PostLink | null) =>
  composePost(p, { topic: 'Spring deep clean', postType, platform, format: 'image', style: 'minimal' as StyleId, link }, {}, seed);
/** The same rule as social.claims2.test.ts: no promised results, owner actions or invented facts. */
const CLAIMS =
  /you[’']ll |for two weeks|removes [^.|]* before it starts|fixes it|helps [^.|]* (get|save|build|make) |imagine next month|without [^.|]* again|never worry|runs itself|we checked|i read every one|i[’']ll send|will send you|book a consultation|strategy call|start the program|get the framework|don[’']t share this often|love most|deserves our best|every [^.|]* we talk to|is common and fixable|simple system|built to help|save hours|5 hours|costs less than|can help|easy fix|cheaper than|quality comes from|need a system|why so many [^.|]* stay stuck|the lesson:/i;

describe('without a page or website setting, captions are written as before', () => {
  it('keeps the website on Facebook and “link in bio” on Instagram', () => {
    const p = business({ website: SITE });
    expect(compose(p, 'facebook', 'sales', 1).caption).toContain(SITE);
    expect(compose(p, 'instagram', 'sales', 1).caption).toMatch(/link in bio/i);
    const none = business();
    expect(compose(none, 'facebook', 'sales', 1).caption).toMatch(/link in bio/i);
    expect(compose(none, 'facebook', 'sales', 1, null).caption).not.toMatch(/https?:\/\//);
  });

  it('the default link settings give exactly today’s captions (the website, where it went before)', () => {
    const p = business({ website: SITE });
    for (const platform of NETWORKS.filter((n) => n !== 'x'))
      for (const postType of TYPES)
        for (let seed = 0; seed < 8; seed++) expect(compose(p, platform, postType, seed, postLinkFor(p, platform)).caption, `${platform} ${postType} ${seed}`).toBe(compose(p, platform, postType, seed).caption);
  });
});

describe('with a published page', () => {
  const p = business({ website: SITE, published: true });

  it('puts the page in the post instead of the website', () => {
    const c = compose(p, 'facebook', 'sales', 3, postLinkFor(p, 'facebook', 'post')).caption;
    expect(c).toContain(PAGE);
    expect(c).not.toContain(SITE);
  });

  it('points to the first comment (a reply on X), with no address in the caption', () => {
    const fb = compose(p, 'facebook', 'sales', 3, postLinkFor(p, 'facebook', 'comment')).caption;
    expect(fb).toMatch(/link in the first comment/i);
    expect(fb).not.toMatch(/https?:\/\/|summit-clean\.net/);
    const x = compose(p, 'x', 'sales', 3, postLinkFor(p, 'x', 'comment')).caption;
    expect(x).toMatch(/link in the first reply/i);
    expect(x).not.toMatch(/https?:\/\/|summit-clean\.net/);
  });

  it('says the link is in the bio, with no address in the caption', () => {
    for (const platform of ['instagram', 'facebook'] as const) {
      const c = compose(p, platform, 'sales', 5, postLinkFor(p, platform, 'bio')).caption;
      expect(c).toMatch(/link in bio/i);
      expect(c).not.toMatch(/https?:\/\/|summit-clean\.net/);
    }
  });

  it('fits X with its hashtags, keeping the whole address (X counts it as 23)', () => {
    for (const postType of TYPES)
      for (let seed = 0; seed < 40; seed++) {
        const link = postLinkFor(p, 'x', 'post');
        const c = composePost(p, { topic: 'How to deep clean a kitchen before guests arrive for a long holiday weekend', postType, platform: 'x', format: 'image', style: 'minimal', link }, {}, seed);
        expect(xLength(`${c.caption}\n\n${c.hashtags.join(' ')}`), c.caption).toBeLessThanOrEqual(280);
        // the posts whose call to action carries a link keep it whole
        if (postType === 'sales' || postType === 'bts') expect(c.caption, c.caption).toContain(PAGE);
        expect(c.caption).not.toMatch(/https?:\/\/\S*…/);
      }
  });
});

describe('a week of posts', () => {
  it('stores each network’s placement, and the first comment only where the link goes there', () => {
    const p = business({ website: SITE, published: true, pageType: 'booking', linkPlacement: { facebook: 'comment', x: 'comment' } });
    const cfg = { ...defaultCampaign(), platforms: ['instagram', 'facebook', 'x'] as PostPlatform[], startDate: '2026-11-10' };
    const posts = generateContentBatch(p, generateCampaignPlan(p, cfg), cfg);
    expect(new Set(posts.map((x) => x.platform))).toEqual(new Set(['instagram', 'facebook', 'x']));
    for (const post of posts) {
      expect(post.linkPlacement).toBe(placementFor(p, post.platform));
      if (post.linkPlacement === 'comment') {
        expect(post.firstComment).toBe(`Book here: ${PAGE}`);
        expect(post.caption).not.toContain(PAGE);
      } else expect(post.firstComment).toBeUndefined();
      if (post.platform === 'instagram') expect(post.caption).not.toMatch(/https?:\/\//);
    }
  });

  it('sets neither without a page or website', () => {
    const p = business();
    const cfg = { ...defaultCampaign(), startDate: '2026-11-10' };
    for (const post of generateContentBatch(p, generateCampaignPlan(p, cfg), cfg)) {
      expect(post.linkPlacement).toBeUndefined();
      expect(post.firstComment).toBeUndefined();
    }
  });
});

describe('the first comment the app writes', () => {
  it('makes no claim, whatever the page type', () => {
    for (const pageType of ['lead', 'booking', 'website', 'landing', 'showcase', 'checkout'] as PageType[]) {
      const p = business({ published: true, pageType });
      const c = firstCommentFor(p, postLinkFor(p, 'facebook', 'comment'))!;
      expect(c.endsWith(PAGE)).toBe(true);
      expect(c).not.toMatch(CLAIMS);
    }
    const web = business({ website: SITE });
    expect(firstCommentFor(web, postLinkFor(web, 'facebook', 'comment'))).toBe(`More here: https://${SITE}`);
  });
});

describe('what the AI is told, and what the app does with its caption', () => {
  const p = business({ website: SITE, published: true });
  const env = (project: Project): TaskEnv => ({ project, directives: {}, brainPrompt: '', variation: 0 });

  it('gives one link rule per placement, and never asks it to make up an address', () => {
    expect(linkRule(null, 'facebook')).toBe('There is no link yet: write no web address; if the call to action needs a link, say “link in bio”.');
    expect(linkRule({ url: PAGE, placement: 'post' }, 'facebook')).toBe(`End the call to action with this exact link: ${PAGE}. Write no other web address.`);
    expect(linkRule({ url: 'https://mybakery.com/', placement: 'post' }, 'x')).toContain('this exact link: mybakery.com.');
    expect(linkRule({ url: PAGE, placement: 'comment' }, 'linkedin')).toContain('so the call to action says “link in the first comment”');
    expect(linkRule({ url: PAGE, placement: 'comment' }, 'x')).toContain('link in the first reply');
    expect(linkRule({ url: PAGE, placement: 'bio' }, 'instagram')).toBe('Write no web address: the call to action says “link in bio”.');
  });

  it('places the link in a written post, wherever the AI put it', () => {
    const input = { topic: 'Spring deep clean', postType: 'sales' as const, platform: 'facebook' as const, format: 'image' as const, style: 'minimal' as StyleId, link: postLinkFor(p, 'facebook', 'comment') };
    const base = postTask.local(input, env(p));
    const raw = { headline: 'Spring is here', caption: 'Fresh start for your home.\n\nBook at summit-clean.net today', hashtags: ['clean', '#austin'], visualPrompt: 'A bright kitchen' };
    const out = postTask.claude!.merge(raw, base, input, env(p));
    expect(out.caption).toBe('Fresh start for your home.\n\nBook at the link in the first comment today');
    expect(out.hashtags).toEqual(['#clean', '#austin']);
    expect(postTask.claude!.merge(raw, base, { ...input, link: postLinkFor(p, 'facebook', 'post') }, env(p)).caption).toBe(`Fresh start for your home.\n\nBook at ${PAGE} today`);
    const prompt = postTask.claude!.prompt(input, env(p), base);
    expect(prompt).toContain('Write no web address: the link goes in the first comment, so the call to action says “link in the first comment”.');
    expect(prompt).not.toContain('Link only to the brand’s own website');
  });

  it('shortens a long X post from the AI at the start, never at the link', () => {
    const input = { topic: 'Spring deep clean', postType: 'sales' as const, platform: 'x' as const, format: 'image' as const, style: 'minimal' as StyleId, link: postLinkFor(p, 'x', 'post') };
    const base = postTask.local(input, env(p));
    const raw = { headline: 'Spring', caption: `${'A spotless home makes the whole week feel lighter, and spring is the time to do it. '.repeat(4)}\n\nBook your spot 👉 summit-clean.net`, hashtags: ['#clean', '#austin'], visualPrompt: 'x' };
    const out = postTask.claude!.merge(raw, base, input, env(p));
    expect(out.caption.endsWith(`\n\nBook your spot 👉 ${PAGE}`)).toBe(true);
    expect(xLength(`${out.caption}\n\n${out.hashtags.join(' ')}`)).toBeLessThanOrEqual(280);
  });

  it('tells the AI each network’s rule for a week of posts, and places the links in what it writes', () => {
    const q = business({ website: SITE, published: true, linkPlacement: { facebook: 'comment' } });
    const cfg = { ...defaultCampaign(), platforms: ['instagram', 'facebook'] as PostPlatform[], startDate: '2026-11-10' };
    const input = { plan: generateCampaignPlan(q, cfg), config: cfg };
    const base = contentBatchTask.local(input, env(q));
    const prompt = contentBatchTask.claude!.prompt(input, env(q), base);
    expect(prompt).toContain('"links": {');
    expect(prompt).toContain(`"facebook": "Write no web address: the link goes in the first comment`);
    expect(prompt).toContain(`"instagram": "Write no web address: the call to action says “link in bio”."`);
    // the input no longer sends the website on its own (the project context still says what it is)
    expect(prompt.slice(prompt.indexOf('INPUT (JSON):'))).not.toContain('"website":');
    const fb = base.find((x) => x.platform === 'facebook')!;
    const ig = base.find((x) => x.platform === 'instagram')!;
    const raw = { posts: [fb, ig].map((x) => ({ slotId: x.planSlotId, headline: 'New', caption: 'Spring is here.\n\nSee summit-clean.net', hashtags: ['spring'], visualPrompt: 'x' })) };
    const merged = contentBatchTask.claude!.merge(raw, base, input, env(q));
    const mfb = merged.find((x) => x.id === fb.id)!;
    const mig = merged.find((x) => x.id === ig.id)!;
    expect(mfb.caption).toBe('Spring is here.\n\nSee the link in the first comment');
    expect(mfb.firstComment).toBe(`All the details here: ${PAGE}`);
    expect(mfb.linkPlacement).toBe('comment');
    expect(mig.caption).toBe('Spring is here.\n\nSee the link in bio');
    expect(mig.hashtags).toEqual(['#spring']);
  });

  it('leaves an older post’s caption alone when it has no placement (it was written for the built-in default)', () => {
    const q = business({ website: SITE, published: true });
    expect(finishCaption(q, 'Book at summit-clean.net', 'facebook', null, [])).toBe('Book at summit-clean.net');
  });
});
