// The email renderer (P5 §4, §S8): every block in every target, themes and contrast, merge tags and buy links,
// the footer's unsubscribe link per target, Outlook's VML and ghost tables, determinism and the size limits.
import { describe, expect, it } from 'vitest';
import { EMAIL_LIMITS, normalizeDoc } from './blocks.mjs';
import { docFromPlain } from './migrate.mjs';
import { ESP_IDS, ESP_TOOLS, RenderError, contrast, renderEmail, renderText, resolveTheme } from './render.mjs';

const OFFER = 'AbCdEfGhIjKlMnOpQrStUv';
const OTHER = 'ZzZzZzZzZzZzZzZzZzZzZz';
const IMG = 'https://sb.example.co/storage/v1/object/public/public-files/user-1/AAAAAAAAAAAAAAAAAAAAAA.png';
const BASE_CTX = {
  subject: 'Your guide is inside',
  preheader: 'Start with page one.',
  brand: { name: 'Bean & Leaf', colors: { primary: '#176b52', accent: '#e0a526', ink: '#1d2420', paper: '#ffffff' } },
  values: { first_name: '[First name]', lead_magnet_link: 'https://app.example/m/AAAAAAAAAAAAAAAAAAAAAA', product_link: 'https://shop.example/guide', sender_name: 'Maya', brand: 'Bean & Leaf' },
  links: { [`buy:${OFFER}`]: `https://app.example/b/${OFFER}`, 'asset:calc1': 'https://app.example/p/calc' },
  iconBase: 'https://app.example',
};
const ctx = (target, extra = {}) => ({ ...BASE_CTX, target, ...(target === 'gmail' ? { optOutUrl: 'https://app.example/u/xyz', postalAddress: '1 Main St, Austin, TX' } : {}), ...(target === 'export' ? { esp: 'mailchimp' } : {}), ...extra });
const TARGETS = ['preview', 'export', 'omnisend', 'gmail'];

/** One of every block. */
const ALL = {
  v: 1,
  theme: { id: 'brand' },
  blocks: [
    { type: 'heading', text: 'Welcome, {{first_name}}', level: 1 },
    { type: 'text', text: 'Hi {{first_name}},\n\nHere is **your guide** and *a tip*. [Open it]({{lead_magnet_link}}).\n\n- One\n- Two' },
    { type: 'image', src: IMG, alt: 'The guide', width: 'full', origin: 'upload', w: 1200, h: 600, link: { kind: 'page' } },
    { type: 'button', label: 'Download your free guide', link: { kind: 'magnet' } },
    { type: 'columns', ratio: '33/67', stack: true, cols: [{ blocks: [{ type: 'image', src: IMG, alt: 'Left', width: 160, origin: 'upload' }] }, { blocks: [{ type: 'heading', text: 'Right', level: 3 }, { type: 'text', text: 'Side text' }, { type: 'button', label: 'See it', link: { kind: 'asset', assetId: 'calc1' }, style: 'outline' }] }] },
    { type: 'offer', offerId: OFFER, title: 'The full course', price: '$49', blurb: 'Everything in one place.', image: { src: IMG, alt: 'Course' }, buttonLabel: 'Buy now' },
    { type: 'video', thumb: { src: IMG, alt: 'Watch' }, link: { kind: 'url', url: 'https://video.example/v/1' }, caption: 'Two minutes' },
    { type: 'social', links: [{ platform: 'instagram', url: 'https://instagram.com/beanleaf' }, { platform: 'facebook', url: 'https://facebook.com/beanleaf' }], style: 'icons' },
    { type: 'divider', style: 'line', size: 24 },
    { type: 'divider', style: 'space', size: 16 },
    { type: 'custom', html: '<table role="presentation"><tr><td class="box" style="color:#333">Custom {{first_name}} <a href="{{buy:' + OFFER + '}}">buy</a></td></tr></table>', css: '.box{padding:8px} @media (max-width:600px){.box{padding:4px!important}}', source: 'owner' },
  ],
};

/** The rows between the card's top and its footer (one block's HTML). */
const bodyOf = (html) => html.slice(html.indexOf('border-collapse:separate;">'), html.lastIndexOf('<td class="ylb-pad" align="center" style="padding:'));
const hrefs = (html) => [...html.matchAll(/<a\b[^>]*\shref="([^"]*)"/g)].map((m) => m[1]);
const count = (s, sub) => s.split(sub).length - 1;

describe('every block in every target', () => {
  for (const target of TARGETS) {
    it(`renders the full doc for ${target} (snapshot)`, () => {
      const out = renderEmail(ALL, ctx(target));
      expect(out.html).toMatchSnapshot();
      expect(out.text).toMatchSnapshot();
      expect(out.warnings).toEqual([]);
    });
  }
  for (const b of ALL.blocks) {
    it(`a ${b.type}${b.style ? ` (${b.style})` : ''} block (snapshot)`, () => {
      expect(bodyOf(renderEmail({ v: 1, theme: { id: 'brand' }, blocks: [b] }, ctx('preview')).html)).toMatchSnapshot();
    });
  }
});

describe('invariants', () => {
  it('Omnisend: exactly one [[unsubscribe_link]], in the footer’s href; content can’t add another', () => {
    const doc = { ...ALL, blocks: [...ALL.blocks, { type: 'text', text: 'Fake [[unsubscribe_link]] here' }, { type: 'custom', html: '<a href="[[unsubscribe_link]]">x</a> [[unsubscribe_link]]' }] };
    const { html } = renderEmail(doc, ctx('omnisend', { values: { ...BASE_CTX.values, first_name: '[[unsubscribe_link]]' } }));
    expect(count(html, '[[unsubscribe_link]]')).toBe(1);
    expect(html).toMatch(/<a href="\[\[unsubscribe_link\]\]"[^>]*>Unsubscribe<\/a><\/p><\/td>\n<\/tr>\n<\/table>/);
  });

  it('export: the chosen tool’s unsubscribe tag; Other shows a note and warns', () => {
    for (const esp of ESP_IDS) {
      const out = renderEmail(ALL, ctx('export', { esp }));
      const tag = ESP_TOOLS[esp].unsubscribe;
      if (tag) {
        expect(out.html).toContain(`<a href="${tag}"`);
        expect(out.warnings).not.toContain('NO_UNSUBSCRIBE_TAG');
      } else {
        expect(out.html).toContain('&#91;Add your unsubscribe link&#93;');
        expect(out.warnings).toContain('NO_UNSUBSCRIBE_TAG');
      }
    }
    expect(renderEmail(ALL, ctx('export', { esp: 'kit' })).html).toContain('<a href="{{ unsubscribe_url }}"');
    expect(renderEmail(ALL, ctx('export', { esp: 'mailerlite' })).html).toContain('<a href="{$unsubscribe}"');
    expect(renderEmail(ALL, ctx('export', { esp: 'brevo' })).html).toContain('<a href="{{ unsubscribe }}"');
  });

  it('preview: no unsubscribe tag, buy links stay in the preview', () => {
    const out = renderEmail(ALL, ctx('preview', { links: { [`buy:${OFFER}`]: '#buy-preview', 'asset:calc1': 'https://app.example/p/calc' } }));
    expect(out.html).not.toContain('[[unsubscribe_link]]');
    expect(out.html).toContain('href="#unsubscribe-preview"');
    expect(out.html).not.toContain(`/b/${OFFER}`);
    expect(out.html).toContain('href="#buy-preview"');
    // a preview anchor opens nothing: no target
    expect(out.html).not.toMatch(/href="#buy-preview" target/);
  });

  it('gmail: the opt-out link is required, the postal address warned about', () => {
    expect(() => renderEmail(ALL, { ...BASE_CTX, target: 'gmail' })).toThrow(RenderError);
    try {
      renderEmail(ALL, { ...BASE_CTX, target: 'gmail', optOutUrl: 'javascript:alert(1)' });
    } catch (e) {
      expect(e.code).toBe('NO_OPT_OUT');
    }
    const out = renderEmail(ALL, { ...BASE_CTX, target: 'gmail', optOutUrl: 'https://app.example/u/xyz' });
    expect(out.html).toContain('<a href="https://app.example/u/xyz"');
    expect(out.warnings).toContain('NO_POSTAL_ADDRESS');
    expect(renderEmail(ALL, ctx('gmail')).html).toContain('1 Main St, Austin, TX');
  });

  it('no scripts, no handlers, no javascript: — whatever the blocks say', () => {
    const evil = {
      v: 1,
      theme: { id: 'brand' },
      blocks: [
        { type: 'text', text: '<script>alert(1)</script> [x](javascript:alert(1)) <img src=x onerror=alert(1)>' },
        { type: 'heading', text: '<b onmouseover="x">hi</b>', level: 2 },
        { type: 'button', label: 'Go', link: { kind: 'url', url: 'javascript:alert(1)' } },
        { type: 'custom', html: '<scr<script>ipt>alert(1)</script><a href="JaVaScRiPt:alert(1)" onclick="x">a</a><svg onload=alert(1)></svg><iframe src="https://evil.example"></iframe>' },
        { type: 'social', links: [{ platform: 'x', url: 'javascript:alert(1)' }], style: 'text' },
      ],
    };
    for (const target of TARGETS) {
      const { html } = renderEmail(evil, ctx(target));
      expect(html).not.toMatch(/<script/i);
      // (the words may stay as text, escaped; never inside a tag)
      expect(html).not.toMatch(/<[^>]*\son\w+=/i);
      expect(html).not.toMatch(/<[^>]*javascript:/i);
      expect(html).not.toMatch(/<iframe|<svg/i);
    }
  });

  it('merge tags in custom HTML fill its text only, never a style or other attribute', () => {
    const doc = { v: 1, theme: { id: 'brand' }, blocks: [{ type: 'custom', html: '<p style="font-family:{{first_name}}" title="{{first_name}}">Hi</p><p>Dear {{first_name}}</p>' }] };
    const values = { ...BASE_CTX.values, first_name: 'x;background-image:url(https://track.example/p.gif)' };
    for (const target of TARGETS) {
      const { html } = renderEmail(doc, ctx(target, { values }));
      // the value lands in the text only, never in a tag
      expect(html.split('url(')).toHaveLength(2);
      expect(html).toContain('Dear x;background-image:url(https://track.example/p.gif)</p>');
      expect(html).not.toMatch(/<[^>]*url\(/);
      expect(html).not.toMatch(/style="[^"]*background-image/);
    }
    // the value alone in a style: no url( anywhere
    const onlyStyle = { ...doc, blocks: [{ type: 'custom', html: '<p style="font-family:{{first_name}}">Hi</p>' }] };
    expect(renderEmail(onlyStyle, ctx('omnisend', { values })).html).not.toContain('url(');
  });

  it('every <img has alt and width; every <a goes to https, #, or the unsubscribe tag', () => {
    for (const target of TARGETS) {
      const { html } = renderEmail(ALL, ctx(target));
      for (const img of html.match(/<img\b[^>]*>/g)) {
        expect(img).toMatch(/\salt="[^"]*"/);
        expect(img).toMatch(/\swidth="\d+"/);
      }
      for (const href of hrefs(html)) expect(href).toMatch(/^(https:\/\/|#|\[\[unsubscribe_link\]\]$|\*\|UNSUB\|\*$)/);
    }
  });

  it('is deterministic, and bytes is the UTF-8 length', () => {
    const a = renderEmail(ALL, ctx('omnisend'));
    const b = renderEmail(structuredClone(ALL), ctx('omnisend'));
    expect(a.html).toBe(b.html);
    expect(a.text).toBe(b.text);
    expect(a.bytes).toBe(Buffer.byteLength(a.html, 'utf8'));
  });

  it('warns over 90 KB (Gmail clips) and refuses over 200 KB', () => {
    const big = (n) => ({ v: 1, theme: { id: 'brand' }, blocks: Array.from({ length: n }, () => ({ type: 'text', text: 'Lorem ipsum dolor sit amet. '.repeat(170) })) });
    const ok = renderEmail(big(8), ctx('omnisend'));
    expect(ok.bytes).toBeLessThan(EMAIL_LIMITS.warnBytes);
    expect(ok.warnings).not.toContain('GMAIL_CLIP');
    const clip = renderEmail(big(20), ctx('omnisend'));
    expect(clip.bytes).toBeGreaterThan(EMAIL_LIMITS.warnBytes);
    expect(clip.warnings).toContain('GMAIL_CLIP');
    let err;
    try {
      renderEmail(big(45), ctx('omnisend'));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RenderError);
    expect(err).toMatchObject({ code: 'TOO_LARGE' });
  });
});

describe('Outlook', () => {
  it('a VML roundrect for buttons, a ghost table for columns and the card, the namespaces on <html>', () => {
    const { html } = renderEmail(ALL, ctx('omnisend'));
    expect(html).toMatch(/^<!doctype html>\n<html lang="en" xmlns="http:\/\/www\.w3\.org\/1999\/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">/);
    expect(html).toContain('<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml"');
    expect(html).toContain('<w:anchorlock/><center');
    expect(count(html, '<v:roundrect')).toBe(3); // the button, the column's button, the offer card's
    expect(html).toMatch(/<!--\[if mso\]><table role="presentation" border="0" cellpadding="0" cellspacing="0" width="536"><tr><td width="177" valign="top"><!\[endif\]-->/);
    expect(html).toContain('<o:PixelsPerInch>96</o:PixelsPerInch>');
  });

  it('two columns that don’t stack are plain table cells', () => {
    const { html } = renderEmail({ v: 1, theme: { id: 'brand' }, blocks: [{ type: 'columns', stack: false, cols: [{ blocks: [{ type: 'text', text: 'a' }] }, { blocks: [{ type: 'text', text: 'b' }] }] }] }, ctx('preview'));
    expect(html).toContain('<td width="268" valign="top" style="width:268px;">');
    expect(html).not.toContain('class="ylb-col"');
  });
});

describe('merge tags and links', () => {
  it('known tags are filled in and escaped; unknown ones stay as written and warn', () => {
    const doc = { v: 1, theme: { id: 'brand' }, blocks: [{ type: 'text', text: 'Hi {{first_name}} from {{sender_name}}, {{coupon}} {{email}}' }] };
    const out = renderEmail(doc, ctx('preview', { values: { ...BASE_CTX.values, sender_name: '<b>Maya</b>' } }));
    expect(out.html).toContain('Hi &#91;First name&#93; from &lt;b&gt;Maya&lt;/b&gt;, {{coupon}} {{email}}');
    expect(out.warnings).toEqual(['UNKNOWN_TAG:coupon', 'MISSING_VALUE:email']);
    expect(out.text).toContain('Hi [First name] from <b>Maya</b>, {{coupon}} {{email}}');
  });

  it('buy links: known ones resolve, unknown ones become # with a warning', () => {
    const doc = { v: 1, theme: { id: 'brand' }, blocks: [{ type: 'text', text: `Buy {{buy:${OFFER}}} or {{buy:${OTHER}}}` }, { type: 'button', label: 'Buy', link: { kind: 'offer', offerId: OTHER } }] };
    const out = renderEmail(doc, ctx('omnisend'));
    expect(out.html).toContain(`<a href="https://app.example/b/${OFFER}" target="_blank" rel="noopener"`);
    expect(out.html).toContain('href="#"');
    expect(out.warnings).toEqual([`UNKNOWN_BUY_LINK:${OTHER}`]);
  });

  it('a link placeholder ([link to your free download]) is text, not a link', () => {
    const doc = docFromPlain({ id: 'e1', body: 'Get it: {{lead_magnet_link}}', ctaLabel: 'Get it', ctaUrl: '{{lead_magnet_link}}' });
    const out = renderEmail(doc, ctx('preview', { values: { ...BASE_CTX.values, lead_magnet_link: '[link to your free download]' } }));
    expect(out.html).toContain('Get it: &#91;link to your free download&#93;');
    expect(out.warnings).toContain('NO_LINK:magnet');
  });

  it('unicode and right-to-left text come through as written', () => {
    const doc = { v: 1, theme: { id: 'brand' }, blocks: [{ type: 'heading', text: 'مرحبا بك 👋', level: 2 }, { type: 'text', text: 'Ça marche — 日本語 ✓' }] };
    const out = renderEmail(doc, ctx('omnisend', { subject: 'שלום' }));
    expect(out.html).toContain('مرحبا بك 👋');
    expect(out.html).toContain('Ça marche — 日本語 ✓');
    expect(out.html).toContain('<title>שלום</title>');
    expect(out.bytes).toBe(Buffer.byteLength(out.html));
  });

  it('long text near the limits renders whole', () => {
    const text = 'x'.repeat(EMAIL_LIMITS.text);
    const { doc, problems } = normalizeDoc({ v: 1, blocks: [{ type: 'text', text }, { type: 'heading', text: 'h'.repeat(EMAIL_LIMITS.heading), level: 1 }] });
    expect(problems).toEqual([]);
    const { html } = renderEmail(doc, ctx('omnisend'));
    expect(html).toContain(text);
  });
});

describe('themes', () => {
  it('each theme renders, with its colours inline', () => {
    for (const id of ['brand', 'clean', 'bold', 'warm', 'minimal', 'editorial']) {
      const { tokens, warnings } = resolveTheme({ id }, BASE_CTX.brand.colors);
      expect(warnings).toEqual([]);
      const out = renderEmail({ ...ALL, theme: { id } }, ctx('omnisend'));
      expect(out.html).toContain(`background-color:${tokens.bg};`);
      expect(out.html).toContain(`bgcolor="${tokens.primary}"`);
      expect(out.html).toContain(tokens.fontStack.split(',')[0].replace(/'/g, '&#39;'));
    }
  });

  it('the brand’s colours appear inline; overrides apply', () => {
    const out = renderEmail({ v: 1, theme: { id: 'brand', overrides: { radius: 0, size: 18 } }, blocks: [{ type: 'button', label: 'Go', link: { kind: 'page' } }] }, ctx('omnisend', { brand: { name: 'X', colors: { primary: '#7a1f5c' } } }));
    expect(out.html).toContain('bgcolor="#7a1f5c"');
    expect(out.html).toContain('font-size:18px;line-height:1.2;');
    expect(out.html).toContain('border-radius:0px;');
  });

  it('a dark brand: text falls back to dark on white, with a warning', () => {
    const { tokens, warnings } = resolveTheme({ id: 'brand' }, { primary: '#222222', ink: '#2a2a2a', paper: '#111111' });
    expect(warnings).toContain('CONTRAST_TEXT');
    expect(tokens.ink).toBe('#1d2420');
    expect(tokens.paper).toBe('#ffffff');
    expect(contrast(tokens.ink, tokens.paper)).toBeGreaterThanOrEqual(4.5);
    const out = renderEmail({ v: 1, theme: { id: 'brand' }, blocks: [{ type: 'text', text: 'hi' }] }, ctx('preview', { brand: { name: 'Dark', colors: { primary: '#222222', ink: '#2a2a2a', paper: '#111111' } } }));
    expect(out.warnings).toContain('CONTRAST_TEXT');
  });

  it('a light button colour gets dark text; an override that can’t be read warns', () => {
    const light = resolveTheme({ id: 'brand' }, { primary: '#f6e27a' });
    expect(light.tokens.primaryText).toBe(light.tokens.ink);
    expect(light.warnings).toEqual([]);
    const forced = resolveTheme({ id: 'brand', overrides: { primaryText: '#ffffff' } }, { primary: '#f6e27a' });
    expect(forced.warnings).toContain('CONTRAST_BUTTON');
    expect(forced.tokens.primaryText).not.toBe('#ffffff');
  });
});

describe('the text part', () => {
  it('has the words, the links as addresses and the footer', () => {
    const text = renderText(ALL, ctx('gmail'));
    expect(text).toContain('Welcome, [First name]');
    expect(text).toContain('Open it (https://app.example/m/AAAAAAAAAAAAAAAAAAAAAA)');
    expect(text).toContain('- One\n- Two');
    expect(text).toContain('Download your free guide: https://app.example/m/AAAAAAAAAAAAAAAAAAAAAA');
    expect(text).toContain(`Buy now: https://app.example/b/${OFFER}`);
    expect(text).toContain('Instagram: https://instagram.com/beanleaf');
    expect(text).toContain('Unsubscribe: https://app.example/u/xyz');
    expect(text).toContain('1 Main St, Austin, TX');
    expect(text).not.toMatch(/<[a-z]/i);
  });
});
