import { describe, expect, it } from 'vitest';
import { newProject } from '@/store/defaults';
import type { Project } from '@/lib/types';
import { sanitizeSvg } from '@/lib/svg';
import { ART_SIZE, heroScene, proceduralSvg, type ArtScene } from './local/art';
import { BIZ_SCENES, listingShots, postPhotoPrompt, postSubject } from './image';
import { BUSINESS_TYPES, IMAGE_STYLES } from './knowledge';
import { postIllustrationTask } from './tasks';
import { generateBrandKit } from './local/brand';
import { generateBusinessModel } from './local/studio';
import { composePost } from './local/social';
import { buildListing } from '@/pages/studio/listing';

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

  it('plans listing images for a local business from its type and city', () => {
    const shots = listingShots(business());
    expect(shots[0].prompt).toMatch(/spotless living room/);
    expect(shots[0].prompt).toContain('Austin');
    expect(shots[1].prompt).toMatch(/cleaner/);
    expect(shots[0].scene).toBe('storefront');
  });

  it('has a photo scene for every business type', () => {
    for (const bt of BUSINESS_TYPES) expect(BIZ_SCENES[bt.id], bt.id).toBeTruthy();
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
