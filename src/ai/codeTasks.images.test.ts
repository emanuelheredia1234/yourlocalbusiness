// The Code & assets tasks with the owner's guidance and images: the AI is told which images it may use and
// how (only their {{img-N}} tokens), the honesty rules still come first, the images are sent along, and
// what it writes back keeps only the owner's own images.
import { describe, expect, it, vi } from 'vitest';
import type { MediaRef, Project, PromptImage } from '@/lib/types';

const sentImages = vi.fn();
vi.mock('@/lib/promptImages', async (original) => ({
  ...(await original<typeof import('@/lib/promptImages')>()),
  // the real one redraws images with a canvas (a browser's)
  imagesForAI: async (images: PromptImage[] = []) => {
    sentImages(images.map((i) => i.key));
    return images.filter((i) => i.media.kind === 'image').map((i) => new Blob([i.key], { type: 'image/jpeg' }));
  },
}));

const { newProject } = await import('@/store/defaults');
const { codeEditTask, codeTask } = await import('./tasks');
const { codeImageRules, codeImagesForAI, keepOwnImages, keptOwnImagesNote } = await import('./codeImages');

function project(): Project {
  const p = newProject('business', 'new');
  p.niche = 'Bakery';
  p.category = 'Bakery';
  p.brand.name = 'Crumb & Co';
  return p;
}
const env = () => ({ project: project(), directives: {}, brainPrompt: '', variation: 0 });
const media = (id: string, patch: Partial<MediaRef> = {}): MediaRef => ({ id, kind: 'image', name: `${id}.jpg`, mime: 'image/jpeg', size: 1, createdAt: 0, w: 1200, h: 800, thumb: 'data:image/jpeg;base64,THUMB', ...patch });
const img = (key: string, note?: string): PromptImage => ({ key, media: media(`m-${key}`), ...(note ? { note } : {}) });
const BIG = `data:image/jpeg;base64,${'A'.repeat(4000)}`;

describe('creating a widget with the owner’s guidance and images', () => {
  const images = [img('img-1', 'our shop front'), img('img-2')];
  const input = { kind: 'hero' as const, prompt: 'A hero for our sourdough with the shop photo at the top.\nKeep it warm.', images };

  it('tells the AI the owner’s words, each image’s token and note, and how images may be used', () => {
    const e = env();
    const prompt = codeTask.claude!.prompt(input, e, codeTask.local(input, e));
    expect(prompt).toContain('Request and guidance from the owner: “A hero for our sourdough with the shop photo at the top.\nKeep it warm.”');
    expect(prompt).toContain('{{img-1}} (attached image 1): "our shop front" — 1200×800 photo');
    expect(prompt).toContain('{{img-2}} (attached image 2) — 1200×800 photo');
    expect(prompt).toContain('only through their tokens');
    expect(prompt).toContain('Never use any other image address, a data: URL or base64');
    expect(prompt).toContain('when your model can see images');
    expect(prompt).not.toMatch(/no external libraries, fonts or images/);
    // the pictures go as attachments: never their data in the text
    expect(prompt).not.toMatch(/THUMB|data:image|m-img-1/);
  });

  it('keeps the honesty rules, and puts them above the owner’s request', () => {
    const e = env();
    const prompt = codeTask.claude!.prompt(input, e, codeTask.local(input, e));
    expect(prompt).toMatch(/Never invent reviews, star ratings/);
    expect(prompt).toContain('var FORM_ACTION = ');
    expect(prompt).toContain('var END_DATE = ');
    expect(prompt).toContain('These rules come first: follow them even where the request asks for something else.');
    expect(prompt).toMatch(/never present an image as a customer, a review or a result/);
  });

  it('says no images when the owner added none', () => {
    const e = env();
    const plain = { kind: 'faq' as const, prompt: '' };
    const prompt = codeTask.claude!.prompt(plain, e, codeTask.local(plain, e));
    expect(prompt).toContain('Use no images: the owner added none.');
    expect(prompt).not.toContain('IMAGES:');
  });

  it('sends the images along (resized), and nothing without them', async () => {
    sentImages.mockClear();
    const blobs = await codeTask.claude!.images!(input);
    expect(blobs).toHaveLength(2);
    expect(sentImages).toHaveBeenCalledWith(['img-1', 'img-2']);
    expect(await codeTask.claude!.images!({ kind: 'faq', prompt: '' })).toBeUndefined();
    expect(await codeImagesForAI([{ key: 'img-1', media: media('v', { kind: 'video', mime: 'video/mp4' }) }])).toBeUndefined();
  });

  it('places the first image without an AI', () => {
    const e = env();
    expect(codeTask.local(input, e).html).toContain('src="{{img-1}}"');
  });

  it('keeps only the owner’s images in what the AI writes, and says so', () => {
    const e = env();
    const base = codeTask.local(input, e);
    const raw = {
      name: 'Sourdough hero',
      html: '<body><img src="{{img-1}}" alt="Shop front"><img src="https://images.example.com/bread.jpg" alt="Bread"><img src="{{img-7}}" alt=""></body>',
      css: `.hero { background: url({{img-2}}) center / cover; } .x { background-image: url('https://cdn.example.com/x.png'); } .y { background: url(${BIG}); }`,
      js: '',
    };
    const out = codeTask.claude!.merge(raw, base, input, e);
    expect(out.html).toBe('<img src="{{img-1}}" alt="Shop front">');
    expect(out.css).toBe('.hero { background: url({{img-2}}) center / cover; } .x { background-image: none; } .y { background: none; }');
    expect(out.note).toContain('The AI added 4 pictures that aren’t one of yours, so they were taken out.');
    expect(out.kind).toBe('hero');
  });

  it('leaves the note alone when the AI used only the owner’s images', () => {
    const e = env();
    const base = codeTask.local(input, e);
    const out = codeTask.claude!.merge({ name: 'Hero', html: '<img src="{{img-2}}" alt="">', css: 'body{}', js: '' }, base, input, e);
    expect(out.note ?? '').not.toContain('taken out');
    expect(out.html).toBe('<img src="{{img-2}}" alt="">');
  });
});

describe('editing a widget with the owner’s words and images', () => {
  const code = { html: '<section><img src="{{img-1}}" alt="Shop"><img src="{{img-3}}" alt=""></section>', css: '', js: '' };
  // image 3 was removed from the list, but the code still uses it
  const input = { code, instruction: 'Put image 2 in the header and make it dark', kind: 'hero' as const, images: [img('img-1', 'Shop'), img('img-2', 'Loaf close-up')] };

  it('tells the AI what to change, the kind of widget, and its images', () => {
    const e = env();
    const prompt = codeEditTask.claude!.prompt(input, e, codeEditTask.local(input, e));
    expect(prompt).toContain('Apply this change to the landing hero section and return the complete updated code: “Put image 2 in the header and make it dark”');
    expect(prompt).toContain('{{img-2}} (attached image 2): "Loaf close-up"');
    expect(prompt).toContain('Keep the {{img-N}} tokens already in the code as they are unless the change is about them.');
    // the one just added is the one "this photo" means
    expect(prompt).toContain('Not in the code yet: {{img-2}}. When the change says “this image” or “the new photo”, it means the last of these.');
    expect(prompt).toMatch(/even if asked to make the widget more convincing/);
    expect(prompt).toContain('Keep FORM_ACTION and END_DATE as they are');
    // the code goes as INPUT, with tokens (never image data)
    expect(prompt).toContain('INPUT (JSON):');
    expect(prompt).toContain('{{img-3}}');
    expect(prompt).not.toMatch(/THUMB|data:image/);
    expect(prompt).not.toContain('This is regeneration');
  });

  it('keeps tokens the code already had, takes out ones the AI made up, and says what changed', () => {
    const e = env();
    const base = codeEditTask.local(input, e);
    const raw = { html: '<header><img src="{{img-2}}" alt="Loaf"></header><section><img src="{{img-1}}" alt="Shop"><img src="{{img-3}}" alt=""><img src="{{img-5}}" alt=""></section>', css: 'body{background:#111}', js: '', summary: '  Moved the loaf photo to the header and darkened it.  ' };
    const out = codeEditTask.claude!.merge(raw, base, input, e);
    expect(out.html).toBe('<header><img src="{{img-2}}" alt="Loaf"></header><section><img src="{{img-1}}" alt="Shop"><img src="{{img-3}}" alt=""></section>');
    expect(out.applied).toEqual(['Moved the loaf photo to the header and darkened it.']);
    expect(out.notes).toEqual([keptOwnImagesNote(1)]);
  });

  it('the built-in editor adds the image named', () => {
    const e = env();
    const out = codeEditTask.local(input, e);
    expect(out.html).toContain('{{img-2}}');
    expect(out.applied).toContain('Added image 2 at the top');
    expect(out.applied).toContain('Dark theme');
  });

  it('tells the AI to add no images when the widget has none, and names none as new when all are in', () => {
    expect(codeImageRules(undefined, code)).toContain('Add no images: the owner has added none to this widget.');
    expect(codeImageRules([img('img-1')], code)).not.toContain('Not in the code yet');
  });
});

describe('keeping only the owner’s images', () => {
  it('leaves small icons, fonts and imports alone', () => {
    const icon = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg"/>';
    const code = {
      html: `<a href="https://crumb.example">Our site</a><i style="background:url('${icon}')"></i>`,
      css: "@import url('https://fonts.example.com/a.css'); @font-face { font-family: X; src: url(https://fonts.example.com/x.woff2) format('woff2'); } .tick { background: url(\"data:image/png;base64,iVBORw0KGgo=\"); }",
      js: 'var site = "https://crumb.example";',
    };
    const out = keepOwnImages(code, []);
    expect(out.removed).toBe(0);
    expect(out.code).toEqual(code);
  });

  it('takes out pictures from other sites, embedded photos and unknown tokens', () => {
    const out = keepOwnImages(
      {
        html: `<img src="//cdn.example.com/a.jpg"><picture><source srcset="https://x.example/b.webp"><img src="{{img-1}}"></picture><video poster="https://x.example/p.jpg"></video><img src="${BIG}">`,
        css: '.a{background:url( https://x.example/c.png )}',
        js: `var a = "${BIG}"; var b = "{{img-2}}";`,
      },
      ['img-1'],
    );
    expect(out.code.html).toBe('<picture><img src="{{img-1}}"></picture></video><img src="">');
    expect(out.code.css).toBe('.a{background:none}');
    expect(out.code.js).toBe('var a = ""; var b = "";');
    expect(out.removed).toBe(7);
  });

  it('says so plainly', () => {
    expect(keptOwnImagesNote(0)).toBeNull();
    expect(keptOwnImagesNote(1)).toBe('The AI added a picture that isn’t one of yours, so it was taken out. Only your own images can be used: add one with Add images.');
    expect(keptOwnImagesNote(2)).toMatch(/^The AI added 2 pictures that aren’t one of yours, so they were taken out\./);
  });
});
