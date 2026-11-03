// The built-in engine and the owner's images: a description names the kind, the first image goes where the
// template has a natural spot (only ever as its {{img-N}} token), edits add or take out an image, and the
// document fills in each token (or leaves it for publishing), with the storage stand-in where asked.
import { describe, expect, it } from 'vitest';
import { newProject } from '@/store/defaults';
import type { MediaRef, Project, PromptImage } from '@/lib/types';
import { STORAGE_SHIM, buildDocument, detectKind, generateCode, matchKind, modifyCode, placeImage, removeImages } from './code';

function business(): Project {
  const p = newProject('business', 'new');
  p.niche = 'Home Cleaning';
  p.category = 'House cleaning';
  p.brand.name = 'Tidy Nest';
  return p;
}

function product(): Project {
  const p = newProject('product', 'new');
  p.niche = 'Personal Finance';
  p.category = 'Freelancer taxes';
  p.brand.name = 'Ledger Lane';
  return p;
}

const media = (id: string, patch: Partial<MediaRef> = {}): MediaRef => ({ id, kind: 'image', name: `${id}.jpg`, mime: 'image/jpeg', size: 1, createdAt: 0, ...patch });
const img = (key: string, note?: string): PromptImage => ({ key, media: media(`m-${key}`), ...(note ? { note } : {}) });
const all = (c: { html: string; css: string; js: string }) => `${c.html}\n${c.css}\n${c.js}`;
const KINDS = ['calculator', 'leadform', 'pricing', 'hero', 'countdown', 'quiz', 'checklist', 'testimonials', 'booking', 'spreadsheet', 'faq', 'roi'] as const;

describe('the kind a description names', () => {
  it('is the first kind it names', () => {
    expect(matchKind('A FAQ that answers pricing and service-area questions')).toBe('faq');
    expect(matchKind('Launch countdown with an email capture')).toBe('countdown');
    expect(matchKind('a booking form for my cleaning packages')).toBe('booking');
    expect(matchKind('Pricing table with my three plans')).toBe('pricing');
    expect(matchKind('a 5-question quiz that recommends a plan')).toBe('quiz');
  });

  it('isn’t fooled by parts of other words', () => {
    expect(matchKind('a bookkeeping calculator')).toBe('calculator');
    expect(matchKind('something for my ebook readers')).toBeNull();
    expect(matchKind('link to my Facebook page')).toBeNull();
    expect(matchKind('a nice preview of the platform information')).toBeNull();
    expect(matchKind('make the background warmer')).toBeNull();
  });

  it('falls back to the project’s usual kind', () => {
    expect(detectKind('something nice', business())).toBe('booking');
    expect(detectKind('something nice', product())).toBe('calculator');
    expect(detectKind('a quiz', business())).toBe('quiz');
  });
});

describe('the built-in engine places the first image', () => {
  it('in the hero, in place of the sample window, with the owner’s note as its alt text', () => {
    const code = generateCode(product(), 'hero', '', {}, 0, [img('img-1', 'Our team at the desk'), img('img-2')]);
    expect(code.html).toContain('<img class="hero-img" src="{{img-1}}" alt="Our team at the desk" />');
    expect(code.html).not.toContain('class="window"');
    // the picture is content now, so it isn't hidden from screen readers
    expect(code.html).toContain('<div class="visual">');
    expect(code.html).not.toContain('{{img-2}}');
    expect(code.css).toContain('.hero-img {');
    expect(() => new Function(code.js)).not.toThrow();
  });

  it('as the lead form’s cover', () => {
    const code = generateCode(product(), 'leadform', '', {}, 0, [img('img-1', 'The guide’s cover')]);
    expect(code.html).toContain('<img class="cover-img" src="{{img-1}}" alt="The guide’s cover" />');
    expect(code.html).not.toContain('<div class="cover"');
    expect(code.html).toContain('id="optin"');
    expect(code.css).toContain('.cover-img {');
  });

  it('next to a sheet’s title, and at the top of everything else', () => {
    const sheet = generateCode(product(), 'spreadsheet', '', {}, 0, [img('img-1')]);
    expect(sheet.html).toMatch(/<div class="toolbar"><b>(?:<!--[^>]*-->)?<img class="sheet-logo" src="\{\{img-1\}\}"/);
    for (const kind of ['calculator', 'pricing', 'countdown', 'quiz', 'checklist', 'testimonials', 'booking', 'faq', 'roi'] as const) {
      const code = generateCode(business(), kind, '', {}, 0, [img('img-1', 'Shop front')]);
      expect(code.html, kind).toContain('<img class="ylb-photo" src="{{img-1}}" alt="Shop front" />');
      expect(code.html.indexOf('{{img-1}}'), kind).toBeLessThan(code.html.indexOf('<span class="pill">'));
      expect(code.css, kind).toContain('.ylb-photo {');
    }
  });

  it('never makes up what a picture shows: no note, empty alt and a TODO', () => {
    const code = generateCode(product(), 'quiz', '', {}, 0, [img('img-3')]);
    expect(code.html).toContain('<img class="ylb-photo" src="{{img-3}}" alt="" />');
    expect(code.html).toContain('<!-- TODO: describe image 3 in alt=""');
  });

  it('escapes the note, and only ever uses the token (never an address)', () => {
    const code = generateCode(product(), 'hero', '', {}, 0, [img('img-1', 'Tom & Jo’s "best" <shop>')]);
    expect(code.html).toContain('alt="Tom &amp; Jo’s &quot;best&quot; &lt;shop&gt;"');
    expect(all(code)).not.toMatch(/data:image|https?:\/\/[^"'\s]*\.(?:jpe?g|png|webp|gif)/);
  });

  it('adds nothing without images, and every kind’s script still parses with one', () => {
    for (const kind of KINDS) {
      expect(all(generateCode(business(), kind, '')), kind).not.toContain('{{img-');
      const code = generateCode(business(), kind, '', {}, 0, [img('img-1')]);
      expect(all(code), kind).toContain('{{img-1}}');
      expect(() => new Function(code.js), kind).not.toThrow();
    }
  });

  it('skips a video', () => {
    const video: PromptImage = { key: 'img-1', media: media('v', { kind: 'video', mime: 'video/mp4' }) };
    expect(all(generateCode(product(), 'hero', '', {}, 0, [video]))).not.toContain('{{img-1}}');
  });
});

describe('the built-in editor and images', () => {
  const hero = () => generateCode(product(), 'hero', '');

  it('adds the image a change names, where it fits', () => {
    const r = modifyCode(hero(), 'put image 2 in the header', [img('img-1'), img('img-2', 'Storefront')]);
    expect(r.html).toContain('<img class="hero-img" src="{{img-2}}" alt="Storefront" />');
    expect(r.applied).toEqual(['Added image 2 in place of the sample window']);
    // its CSS goes with the other additions, which later edits keep
    expect(r.css).toMatch(/\/\* ylb-extra \*\/[\s\S]*\.hero-img \{/);
    expect(modifyCode(r, 'make it dark').css).toContain('.hero-img {');
  });

  it('adds the first image not used yet when none is named, then says when all are in', () => {
    const images = [img('img-1'), img('img-2')];
    const once = modifyCode(hero(), 'add a photo', images);
    expect(once.html).toContain('{{img-1}}');
    const twice = modifyCode(once, 'add another photo', images);
    expect(twice.html).toContain('<img class="ylb-photo" src="{{img-2}}"');
    expect(twice.applied).toEqual(['Added image 2 at the top']);
    const full = modifyCode(twice, 'add a picture', images);
    expect(full.html).toBe(twice.html);
    expect(full.notes[0]).toMatch(/All your images are in it already/);
  });

  it('reads “this photo” as the one just added', () => {
    const images = [img('img-1'), img('img-2'), img('img-3')];
    expect(modifyCode(hero(), 'add this photo at the top', images).html).toContain('src="{{img-3}}"');
    expect(modifyCode(hero(), 'put the new picture in', images).html).toContain('src="{{img-3}}"');
  });

  it('says what to do when there’s no image to add', () => {
    const none = modifyCode(hero(), 'add our logo', []);
    expect(none.applied).toEqual([]);
    expect(none.notes).toEqual(['Add the image first (Add images, or paste it into the box), then ask again.']);
    expect(modifyCode(hero(), 'use image 4', [img('img-1')]).notes).toEqual(['There’s no image 4 in this asset.']);
  });

  it('takes out the image named, or the only one shown', () => {
    const two = modifyCode(modifyCode(hero(), 'use image 1', [img('img-1'), img('img-2')]), 'use image 2', [img('img-1'), img('img-2')]);
    const out = modifyCode(two, 'remove image 2', [img('img-1'), img('img-2')]);
    expect(out.html).not.toContain('{{img-2}}');
    expect(out.html).toContain('{{img-1}}');
    expect(out.applied).toEqual(['Took out image 2']);
    expect(modifyCode(two, 'remove the photo', []).notes).toEqual(['Say which image to take out, e.g. “remove image 2”.']);
    const only = modifyCode(out, 'delete the picture', []);
    expect(all(only)).not.toContain('{{img-');
  });

  it('doesn’t add or take out a picture when the change is about something else', () => {
    const shown = modifyCode(hero(), 'use image 1', [img('img-1')]);
    const shadow = modifyCode(shown, 'add a drop shadow to image 1', [img('img-1')]);
    expect(shadow.html).toBe(shown.html);
    expect(shadow.applied).toEqual(['Stronger shadows']);
    const flat = modifyCode(shown, 'remove the shadow from the photo', [img('img-1')]);
    expect(flat.html).toBe(shown.html);
    expect(flat.applied).toEqual(['Flat style']);
    expect(modifyCode(shown, 'no shadows please', []).applied).toEqual(['Flat style']);
    const border = modifyCode(hero(), 'use my accent color for the image border', [img('img-1')]);
    expect(border.html).not.toContain('{{img-1}}');
    // a few words between the verb and the picture are fine
    expect(modifyCode(hero(), 'put the shop front photo at the top', [img('img-1')]).applied).toEqual(['Added image 1 in place of the sample window']);
    expect(modifyCode(shown, 'please delete the old photo', [img('img-1')]).applied).toEqual(['Took out image 1']);
  });

  it('reads "logo colors", "bigger image" and "background" as what they mean', () => {
    const base = hero();
    expect(modifyCode(base, 'use my logo colors for the button', [img('img-1')]).html).toBe(base.html);
    // the built-in editor can't resize a picture: it changes nothing (and the Code tab says so)
    const bigger = modifyCode(base, 'make image 1 bigger', [img('img-1')]);
    expect(bigger.css).toBe(base.css);
    expect(bigger.applied).toEqual([]);
    expect(modifyCode(base, 'make the text bigger', []).css).toContain('--scale: 1.12');
    expect(modifyCode(base, 'make the background dark', []).applied).toEqual(['Dark theme']);
    expect(modifyCode(base, 'Make the button bigger and rounder', []).applied).toEqual(['Rounder corners', 'Larger text']);
  });
});

describe('placing and removing images', () => {
  it('puts an image at the very start when there’s no spot', () => {
    const r = placeImage({ html: '<main><p>Hi</p></main>', css: '' }, img('img-1', 'Logo'));
    expect(r.spot).toBe('top');
    expect(r.html).toBe('<img class="ylb-photo" src="{{img-1}}" alt="Logo" />\n<main><p>Hi</p></main>');
    expect(r.css).toContain('.ylb-photo {');
    expect(placeImage({ html: '<p>Hi</p>', css: r.css }, img('img-2')).css).toBe('');
  });

  it('takes an image out everywhere it’s used, and nothing else', () => {
    const code = {
      html: '<div class="ylb"><!-- TODO: describe image 2 in alt="" (what it shows), or leave it empty if it\'s only decoration. --><img class="ylb-photo" src="{{img-2}}" alt="" />\n<img src="{{img-1}}" alt="a"><div style="background:url({{ img-2 }})"></div><picture><source srcset="{{img-2}}"></picture></div>',
      css: '.a { background-image: url("{{img-2}}"); } .b { background: url({{img-1}}) center / cover; }',
      js: 'var pics = ["{{img-2}}", "{{img-1}}"];',
    };
    const out = removeImages(code, ['img-2']);
    expect(all(out)).not.toMatch(/img-2|TODO: describe image 2/);
    expect(out.html).toContain('<img src="{{img-1}}" alt="a">');
    expect(out.html).toContain('style="background:none"');
    expect(out.css).toBe('.a { background-image: none; } .b { background: url({{img-1}}) center / cover; }');
    expect(out.js).toBe('var pics = ["", "{{img-1}}"];');
    expect(removeImages(code, [])).toBe(code);
  });
});

describe('the document', () => {
  const code = { html: '<img src="{{img-1}}" alt=""><img src="{{img-9}}" alt="">', css: '.x { background: url({{img-1}}); }', js: 'var a = "{{img-1}}";' };

  it('fills in each image’s address, and shows nothing for an image it doesn’t have', () => {
    const doc = buildDocument(code, 'Hi', { images: { 'img-1': 'data:image/jpeg;base64,AAAA' } });
    expect(doc).toContain('<img src="data:image/jpeg;base64,AAAA" alt="">');
    expect(doc).toContain('url(data:image/jpeg;base64,AAAA)');
    expect(doc).toContain('var a = "data:image/jpeg;base64,AAAA";');
    expect(doc).toContain('<img src="" alt="">');
    expect(doc).not.toContain('{{img-');
  });

  it('keeps the tokens for publishing when it isn’t given addresses', () => {
    const doc = buildDocument(code, 'Hi');
    expect(doc).toContain('{{img-1}}');
    expect(doc).not.toContain(STORAGE_SHIM);
  });

  it('starts with the storage stand-in when asked, before any of the page’s own code', () => {
    const doc = buildDocument(code, 'Hi', { storageShim: true });
    const at = doc.indexOf(STORAGE_SHIM);
    expect(at).toBeGreaterThan(doc.indexOf('<head>'));
    expect(at).toBeLessThan(doc.indexOf('<style>'));
    expect(at).toBeLessThan(doc.indexOf('<body>'));
    expect(STORAGE_SHIM).not.toMatch(/<\/script/i);
  });
});

describe('the storage stand-in', () => {
  const run = (win: Record<string, unknown>) => new Function('window', STORAGE_SHIM)(win);
  const blocked = () => {
    const win: Record<string, unknown> = {};
    for (const name of ['localStorage', 'sessionStorage'])
      Object.defineProperty(win, name, {
        configurable: true,
        get() {
          throw new Error('SecurityError: the document is sandboxed');
        },
      });
    return win;
  };

  it('gives a sandboxed page working in-memory storage', () => {
    const win = blocked();
    run(win);
    const ls = win.localStorage as Storage;
    ls.setItem('ticks', '[true,false]');
    ls.setItem('n', 2 as unknown as string);
    expect(ls.getItem('ticks')).toBe('[true,false]');
    expect(ls.getItem('n')).toBe('2');
    expect(ls.getItem('missing')).toBeNull();
    expect(ls.length).toBe(2);
    expect(ls.key(0)).toBe('ticks');
    expect(ls.key(5)).toBeNull();
    ls.removeItem('n');
    expect(ls.length).toBe(1);
    ls.clear();
    expect(ls.length).toBe(0);
    // each is its own store
    (win.sessionStorage as Storage).setItem('a', 'b');
    expect(ls.getItem('a')).toBeNull();
  });

  it('leaves storage that works alone', () => {
    const real = { getItem: () => null, marker: 'real' };
    const win: Record<string, unknown> = { localStorage: real, sessionStorage: real };
    run(win);
    expect(win.localStorage).toBe(real);
    expect(win.sessionStorage).toBe(real);
  });
});
