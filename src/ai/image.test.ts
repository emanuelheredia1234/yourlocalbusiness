import { describe, expect, it } from 'vitest';
import { newProject } from '@/store/defaults';
import type { Project } from '@/lib/types';
import { sanitizeSvg } from '@/lib/svg';
import { ART_SIZE, heroScene, proceduralSvg, type ArtScene } from './local/art';
import { BIZ_SCENES, listingShots, postPhotoPrompt, postSubject } from './image';
import { BUSINESS_TYPES, IMAGE_STYLES } from './knowledge';
import { postIllustrationTask } from './tasks';
import { generateBrandKit } from './local/brand';
import { generateBusinessModel, generateListing } from './local/studio';
import { composePost } from './local/social';
import { manusImagePrompt } from './manus';
import { buildListing } from '@/lib/listing';
import { listingText } from './listingImages';

function product(): Project {
  const p = newProject('product', 'new');
  p.niche = 'Personal Finance';
  p.category = 'Freelancer Tax Tracking';
  p.format = 'course';
  p.studio.listing.title = 'Tax-Ready Freelancer Course';
  const kit = generateBrandKit(p);
  p.brand = { ...p.brand, name: kit.nameOptions[0].name, colors: kit.colors, audience: 'Freelance designers' };
  return p;
}

function business(): Project {
  const p = newProject('business', 'new');
  p.niche = 'Home Cleaning';
  p.category = 'Eco-friendly house cleaning';
  p.businessType = 'Home Cleaning';
  p.location = { city: 'Austin', region: 'TX' };
  const kit = generateBrandKit(p);
  p.brand = { ...p.brand, name: kit.nameOptions[0].name, colors: kit.colors };
  p.studio.packages = generateBusinessModel(p).packages;
  return p;
}

/** A business as setup leaves it: packages and listing from the shared business-type templates. */
function businessOf(type: string, category = ''): Project {
  const p = newProject('business', 'new');
  p.businessType = type;
  p.niche = type;
  p.category = category;
  p.location = { city: 'Austin', region: 'TX' };
  p.brand = { ...p.brand, name: 'Bluebonnet & Co' };
  p.studio.packages = generateBusinessModel(p).packages;
  p.studio.listing = generateListing(p);
  return p;
}

const NO_TEXT = /No text, letters, words, numbers, logos or watermarks/;

describe('AI images', () => {
  it('draws every built-in scene as a clean SVG at every size', () => {
    const colors = product().brand.colors;
    const scenes: ArtScene[] = ['pedestal', 'device', 'book', 'storefront', 'desk', 'people', 'neon', 'iso', 'paper', 'soft'];
    for (const scene of scenes) {
      for (const aspect of Object.keys(ART_SIZE) as (keyof typeof ART_SIZE)[]) {
        const raw = proceduralSvg(colors, { aspect, scene, seed: 42 });
        expect(raw).not.toMatch(/<text|NaN|undefined/);
        const clean = sanitizeSvg(raw);
        expect(clean, `${scene} ${aspect}`).not.toBeNull();
        expect([clean!.width, clean!.height]).toEqual(ART_SIZE[aspect]);
      }
    }
  });

  it('turns a post visual prompt into an image prompt without the overlay text', () => {
    const p = product();
    const vp = 'Minimalist studio shot of a laptop with a tax tracker. On-image text: “Stop overpaying taxes”. Brand colors #123456 and #abcdef, small watermark “site.com” bottom-right.';
    const subject = postSubject(p, vp);
    expect(subject).not.toMatch(/On-image text|watermark|Stop overpaying/);
    expect(subject).toContain('laptop with a tax tracker');
    const prompt = postPhotoPrompt(p, vp, 'minimal');
    expect(prompt).toMatch(NO_TEXT);
    expect(prompt).toContain('minimalist studio shot');
    expect(prompt).toContain('lower third');
    expect(postPhotoPrompt(p, vp, 'minimal', false)).not.toContain('lower third');
    // the built-in engine's format: style boilerplate, subject, on-image text, colors and watermark
    const built = composePost(p, { topic: 'Stop overpaying taxes', postType: 'tip', platform: 'instagram', format: 'image', style: 'minimal', watermark: true }, {}, 'seed');
    const s2 = postSubject(p, built.visualPrompt, 'minimal');
    expect(s2).not.toMatch(/On-image text|watermark|Brand colors|minimalist studio shot|^Subject/i);
    expect(s2.length).toBeGreaterThan(10);
  });

  it('never asks the image model for lettering, whatever the style', () => {
    const p = product();
    for (const s of IMAGE_STYLES) {
      const prompt = postPhotoPrompt(p, `${s.prompt}. Subject: a freelancer at a desk.`, s.id);
      expect(prompt, s.id).not.toMatch(/lettering|typography|serif headline|numbered steps/i);
      expect(prompt, s.id).toMatch(NO_TEXT);
    }
  });

  it('plans four listing images from a product’s context', () => {
    const p = product();
    const shots = listingShots(p);
    expect(shots.map((s) => s.id)).toEqual(['hero', 'lifestyle', 'inside', 'offer']);
    expect(shots[0].prompt).toContain('Tax-Ready Freelancer Course');
    expect(shots[0].prompt).toMatch(/laptop playing a video lesson/);
    expect(shots[1].prompt).toContain('Freelance designers');
    expect(shots[0].scene).toBe(heroScene(p));
    for (const s of shots) expect(s.prompt).toMatch(NO_TEXT);
    expect(shots.filter((s) => s.layout !== 'clean').map((s) => s.aspect)).toEqual(['1:1', '1:1']);
  });

  it('plans listing images for a local business from its own details', () => {
    const p = business();
    const shots = listingShots(p);
    expect(shots.map((s) => s.label)).toEqual(['Cover', 'At work', 'What you get', 'Offer card']);
    expect(shots[0].prompt).toContain('Cover photo for a local home cleaning business in Austin');
    // a house cleaner clearly is a home-cleaning business: the stock living room is a safe setting
    expect(shots[0].prompt).toMatch(/spotless living room/);
    expect(shots[0].prompt).toContain('Specialty: Eco-friendly house cleaning.');
    expect(shots[0].prompt).toMatch(/What customers get \([^)]+\): Standard Clean/);
    expect(shots[1].prompt).toMatch(/cleaner/);
    expect(shots[0].scene).toBe('storefront');
    // the backgrounds of the two graphics show this business too
    expect(shots[2].prompt).toContain('a local home cleaning business in Austin');
    expect(shots[3].prompt).toContain('a local home cleaning business in Austin');
    for (const s of shots) {
      expect(s.prompt).toMatch(NO_TEXT);
      // no business name (or any quoted words) for the model to letter onto the photo
      expect(s.prompt).not.toContain(p.brand.name);
      expect(s.prompt).not.toMatch(/[“”"]/);
      expect(s.prompt).not.toMatch(/business business/i);
    }
  });

  it('describes a business in its own words when no stock setting fits', () => {
    const stock = Object.values(BIZ_SCENES).flatMap((s) => [s.hero, s.work]);
    // misfires of the shared business-type matcher, and types it has no template for
    const types = ['Skincare studio', 'Senior home care', 'Healthcare clinic', 'Child daycare', 'Carpet installation', 'Music teacher', 'Street tacos', 'Pest control prevention', 'Tattoo shop', 'Pool cleaning', 'Dentist', 'Law firm', 'Locksmith', 'Physical therapy', 'Auto Detailing', 'Bakery'];
    for (const type of types) {
      const p = businessOf(type);
      const shots = listingShots(p);
      const all = shots.map((s) => s.prompt).join('\n');
      for (const st of stock) expect(all, type).not.toContain(st);
      expect(shots[0].prompt.toLowerCase(), type).toContain(type.toLowerCase());
      expect(all, type).not.toMatch(/business business/i);
      // package lines from another business's template (e.g. house cleaning for a pool cleaner) stay out
      expect(all, type).not.toMatch(/Room-by-room|latte|Coffee & Pastry|kitchen cabinet|Bath & Brush|Express Detail/i);
      for (const s of shots) expect(s.prompt, type).toMatch(NO_TEXT);
    }
    expect(listingShots(businessOf('Dentist'))[1].prompt).toMatch(/^A local dentist at work in Austin, serving a customer\./);
    expect(listingShots(businessOf('Pool cleaning'))[1].prompt).toMatch(/^Someone from a local pool cleaning business at work in Austin/);
    // a steakhouse is a restaurant (the shared matcher calls it a café)
    expect(listingShots(businessOf('Steakhouse'))[0].prompt).toMatch(/restaurant dining room/);
    expect(listingShots(businessOf('Steakhouse')).map((s) => s.prompt).join(' ')).not.toMatch(/latte|barista|pastr/i);
    // nothing known about the business: still grammatical
    expect(listingShots(businessOf(''))[0].prompt).toMatch(/^Cover photo for a local business in Austin:/);
  });

  it('words the second photo for a shop or for a service', () => {
    const bakery = listingShots(businessOf('Bakery', 'Sourdough and pastries'));
    expect(bakery[1]).toMatchObject({ label: 'With a customer', desc: 'Someone enjoying what you sell' });
    expect(bakery[1].prompt).toMatch(/^A customer enjoying what a local bakery sells in Austin\./);
    expect(bakery[0].prompt).toContain('what it sells, beautifully presented');
    const cafe = listingShots(businessOf('Coffee Shop'));
    expect(cafe[1].prompt).toContain('Setting: a barista pouring latte art');
    const salon = listingShots(businessOf('Hair Salon'));
    expect(salon[1]).toMatchObject({ label: 'At work', desc: 'Your service in action' });
    expect(salon[1].prompt).toMatch(/^A stylist blow-drying/);
  });

  it('has a photo scene for every business type', () => {
    for (const bt of BUSINESS_TYPES) expect(BIZ_SCENES[bt.id], bt.id).toBeTruthy();
  });

  it('tells Manus a business listing is for a local business', () => {
    const colors = business().brand.colors;
    const base = { subject: 'a sparkling backyard pool', aspect: '3:2' as const, colors, purpose: 'listing' as const, textSpace: 'none' as const };
    expect(manusImagePrompt({ ...base, business: true })).toContain('local business’s marketplace listing');
    expect(manusImagePrompt(base)).toContain('marketplace product listing');
  });

  it('typesets only finished lines on the listing graphics', () => {
    const p = business();
    // the house-cleaning template's packages hold "[…]" lines for the owner to fill in
    expect(p.studio.packages.flatMap((x) => x.includes).some((l) => /\[[^\]]+\]/.test(l))).toBe(true);
    const text = listingText(p);
    expect(text.items?.length).toBeGreaterThan(0);
    for (const item of text.items ?? []) expect(item).not.toMatch(/\[[^\]]+\]/);
  });

  it('keeps Claude’s SVG only when it is safe and drawable', () => {
    const p = product();
    const env = { project: p, directives: {}, brainPrompt: '', variation: 0 };
    const input = { subject: 'a desk', aspect: '1:1' as const, scene: 'desk' as const, seed: 1, textArea: 'bottom' as const };
    const base = postIllustrationTask.local(input, env);
    expect(base.drawnBy).toBe('builtin');
    const good = postIllustrationTask.claude!.merge({ svg: '<svg viewBox="0 0 1080 1080"><rect width="1080" height="1080" fill="#f0f"/><script>x()</script></svg>' }, base, input, env);
    expect(good.drawnBy).toBe('claude');
    expect(good.svg).not.toContain('script');
    const bad = postIllustrationTask.claude!.merge({ svg: 'sorry, I cannot draw' }, base, input, env);
    expect(bad).toBe(base);
    const prompt = postIllustrationTask.claude!.prompt(input, env, base);
    expect(prompt).toContain('viewBox="0 0 1080 1080"');
    expect(prompt).toMatch(/no text, letters/i);
  });

  it('carries gallery images on the listing', () => {
    const p = product();
    const l = buildListing(p, undefined, undefined, ['data:image/jpeg;base64,AAA']);
    expect(l.gallery).toEqual(['data:image/jpeg;base64,AAA']);
    expect(buildListing(p).gallery).toBeUndefined();
  });
});
