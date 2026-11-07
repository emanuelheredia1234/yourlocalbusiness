// The email sanitizer (P5 §5, §S8): an allowlist over a small tokenizer, no DOM. Every case here must come out with
// no script, no handler, no unsafe URL, no comment, no remote image or font, and the same on a second pass.
import { describe, expect, it } from 'vitest';
import { SanitizeError, decodeEntities, filterStyle, safeHref, sanitizeEmailCss, sanitizeEmailHtml } from './sanitize.mjs';

const OWN = 'https://sb.example.co/storage/v1/object/public/public-files/user-1/';
const imageAllowed = (src) => src.startsWith(OWN);
const clean = (html, opts = {}) => sanitizeEmailHtml(html, { imageAllowed, ...opts });
const safe = (html) => {
  expect(html).not.toMatch(/<\s*\/?\s*(script|iframe|object|embed|svg|math|form|input|button|textarea|select|meta|link|base|style|template|noscript|video|audio)\b/i);
  expect(html).not.toMatch(/<[^>]*\son[a-z]+\s*=/i);
  expect(html).not.toMatch(/<[^>]*(javascript|vbscript|data):/i);
  expect(html).not.toContain('<!--');
  expect(html).not.toContain('[[');
};

const CASES = {
  script: '<p>a<script>alert(1)</script>b</p>',
  scriptUpper: '<SCRIPT type="text/javascript">alert(1)</SCRIPT><p>ok</p>',
  splitScript: '<scr<script>ipt>alert(1)</script>',
  unclosedScript: '<p>before</p><script',
  unclosedScriptBody: '<p>x</p><script>alert(1)',
  imgOnerror: '<img src=x onerror=alert(1)>',
  svgOnload: '<svg onload=alert(1)><circle/></svg><p>after</p>',
  tabJs: '<a href="java&#x09;script:alert(1)">x</a>',
  spaceJs: '<a href=" javascript:alert(1)">x</a>',
  mixedJs: '<a href="JaVaScRiPt:alert(1)">x</a>',
  dataUrl: '<a href="data:text/html;base64,PHNjcmlwdD4=">x</a><img src="data:image/png;base64,AAAA" alt="">',
  vbscript: '<a href="vbscript:msgbox(1)">x</a>',
  iframe: '<iframe src="https://evil.example"></iframe><p>ok</p>',
  object: '<object data="x.swf"><param name=a value=b></object><embed src="x.swf">',
  form: '<form action="https://evil.example"><input name="pw"><button>Go</button><select><option>1</option></select><textarea>t</textarea></form>',
  meta: '<meta http-equiv="refresh" content="0;url=https://evil.example"><base href="https://evil.example/"><link rel="stylesheet" href="https://evil.example/x.css"><p>ok</p>',
  styleImport: '<style>@import url(https://evil.example/x.css); p{color:red}</style><p>ok</p>',
  fontFace: '<style>@font-face{font-family:x;src:url(https://evil.example/f.woff)}</style>',
  bgUrl: '<td style="background:url(https://track.example/p.gif);color:red">x</td>',
  expression: '<p style="width:expression(alert(1));color:blue">x</p>',
  behavior: '<p style="behavior:url(x.htc);-moz-binding:url(x.xml#y)">x</p>',
  cssEscape: '<p style="background:\\75 rl(https://track.example)">x</p>',
  msoScript: '<!--[if mso]><script>alert(1)</script><![endif]--><p>ok</p>',
  cdata: '<![CDATA[<script>alert(1)</script>]]><p>ok</p>',
  template: '<template><img src=x onerror=alert(1)></template><noscript><img src=x onerror=alert(1)></noscript><p>ok</p>',
  math: '<math><mi xlink:href="javascript:alert(1)">x</mi></math><p>ok</p>',
  quotes: `<p title='a "quoted" &amp; <b>' style="font-family:'Trebuchet MS', Arial">x</p>`,
  unquoted: '<td width=200 bgcolor=#ffeecc align=center>x</td>',
  unbalanced: '</div><p><b>bold<i>both</p>end</b>',
  unsubscribe: '<p>Click [[unsubscribe_link]] or <a href="[[unsubscribe_link]]">here</a></p>',
};

describe('the HTML sanitizer', () => {
  for (const [name, html] of Object.entries(CASES)) {
    it(`${name}: safe, and the same on a second pass`, () => {
      const once = clean(html).html;
      safe(once);
      expect(clean(once).html).toBe(once);
    });
  }

  it('says what it removed, in words', () => {
    const r = clean('<script>x</script><script>y</script><form><input></form><img src="https://elsewhere.example/a.png" alt=""><img src="https://elsewhere.example/b.png" alt=""><a href="javascript:x" onclick="y">z</a><!-- c -->');
    expect(r.removed).toMatchObject({ script: 2, form: 1, image: 2, link: 1, handler: 1, comment: 1 });
    expect(r.notes).toEqual(['2 scripts', '1 form or form field', '1 comment', '1 event handler', '2 outside images', '1 unsafe link']);
  });

  it('keeps text, decoded once and escaped again; keeps tables and their layout attributes', () => {
    expect(clean('<p>Fish &amp; Chips &lt;b&gt; &copy; &nbsp;x</p>').html).toBe('<p>Fish &amp; Chips &lt;b&gt; ©  x</p>');
    expect(clean(CASES.unquoted).html).toBe('<td width="200" align="center" bgcolor="#ffeecc">x</td>');
    expect(clean('<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" id="t" data-x="1"><tr><td colspan="2" valign="top">a</td></tr></table>').html).toBe('<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0"><tr><td valign="top" colspan="2">a</td></tr></table>');
    expect(clean(CASES.quotes).html).toBe('<p style="font-family:&#39;Trebuchet MS&#39;, Arial" title="a &quot;quoted&quot; &amp; &lt;b&gt;">x</p>');
  });

  it('turns unknown tags into divs, drops html and body, closes what was left open', () => {
    expect(clean('<html><body><section><header>Hi</header></section></body></html>').html).toBe('<div><div>Hi</div></div>');
    expect(clean(CASES.unbalanced).html).toBe('<p><b>bold<i>both</i></b></p>end');
    expect(clean('<font color="red" face="Georgia" size="7">x</font>').html).toBe('<span style="color:red;font-family:Georgia">x</span>');
  });

  it('[[…]] in content is text, never a tag Omnisend fills in', () => {
    const { html } = clean(CASES.unsubscribe);
    expect(html).toBe('<p>Click &#91;&#91;unsubscribe_link&#93;&#93; or <a href="#">here</a></p>');
  });

  it('links: https, http, mailto and tel stay; tokens the renderer knows stay; anything else is #', () => {
    expect(clean('<a href="https://ok.example/a?b=1&amp;c=2">x</a>').html).toBe('<a href="https://ok.example/a?b=1&amp;c=2" target="_blank" rel="noopener">x</a>');
    expect(clean('<a href="mailto:hi@ok.example">x</a><a href="tel:+15125550100">y</a>').html).toContain('href="mailto:hi@ok.example"');
    expect(clean('<a href="{{buy:AbCdEfGhIjKlMnOpQrStUv}}">buy</a>').html).toBe('<a href="{{buy:AbCdEfGhIjKlMnOpQrStUv}}" target="_blank" rel="noopener">buy</a>');
    expect(clean('<a href="{{ lead_magnet_link }}">get</a>').html).toContain('href="{{lead_magnet_link}}"');
    expect(clean('<a href="{{evil}}">x</a>').html).toBe('<a href="#">x</a>');
    expect(clean('<a href="//evil.example/x">x</a>').html).toBe('<a href="#">x</a>');
    expect(clean('<a href="https://user:pw@evil.example/">x</a>').html).toBe('<a href="#">x</a>');
  });

  it('images: {{img-N}} kept, the caller’s own kept, remote ones removed with a note; srcset dropped', () => {
    expect(clean('<img src="{{img-1}}" alt="Hero" width="600">').html).toBe('<img src="{{img-1}}" alt="Hero" width="600" border="0">');
    expect(clean(`<img src="${OWN}AAAAAAAAAAAAAAAAAAAAAA.png" srcset="https://evil.example/a.png 2x" alt="x">`).html).toBe(`<img src="${OWN}AAAAAAAAAAAAAAAAAAAAAA.png" alt="x" border="0">`);
    const remote = clean('<p>a<img src="https://track.example/pixel.gif" width="1" height="1">b</p>');
    expect(remote.html).toBe('<p>ab</p>');
    expect(remote.notes).toEqual(['1 outside image']);
    expect(clean('<img src="http://own.example/a.png" alt="">', { imageAllowed: () => true }).html).toBe('');
  });

  it('classes get the custom prefix (never the renderer’s), ids and data- go', () => {
    expect(clean('<p class="hero ylb-col u-done" id="x" data-a="b">x</p>').html).toBe('<p class="u-hero u-done">x</p>');
  });

  it('refuses output over 20 KB instead of cutting it', () => {
    const big = `<p>${'x'.repeat(21 * 1024)}</p>`;
    expect(() => clean(big)).toThrow(SanitizeError);
    try {
      clean(big);
    } catch (e) {
      expect(e).toMatchObject({ code: 'TOO_LARGE' });
    }
    // what goes in may be bigger: only what comes out counts
    expect(clean(`<script>${'x'.repeat(40 * 1024)}</script><p>ok</p>`).html).toBe('<p>ok</p>');
  });

  it('collects the head’s <style> for an agent import', () => {
    const r = clean('<html><head><style>.a{color:red}</style></head><body><p class="a">x</p></body></html>', { collectStyles: true });
    expect(r.html).toBe('<p class="u-a">x</p>');
    expect(r.styles).toBe('.a{color:red}');
  });
});

describe('inline styles', () => {
  it('keeps allowed properties; drops the rest and anything that fetches or runs', () => {
    expect(filterStyle('color:red;position:absolute;background:#fff;padding-top:4px;display:flex;mso-hide:all;border-left:1px solid #000;z-index:9')).toBe('color:red;background-color:#fff;padding-top:4px;mso-hide:all;border-left:1px solid #000');
    expect(filterStyle('color:red!important')).toBe('color:red');
    expect(filterStyle('color:red !important', { allowImportant: true })).toBe('color:red!important');
    for (const bad of ['background:url(x)', 'width:expression(1)', 'color:var(--x)', 'font-family:\\61 rial', 'behavior:url(a)', 'background-color:red;/*x*/']) expect(filterStyle(bad)).not.toMatch(/url|expression|var\(|\\|behavior|\/\*/);
    // a merge tag is never kept in a style (its value could add CSS after sanitizing)
    expect(filterStyle('font-family:{{first_name}};color:red')).toBe('color:red');
    expect(filterStyle('color:}')).toBe('');
  });
});

describe('custom CSS', () => {
  const SCOPE = '.ylb-c-b_AAAAAAAAAA';
  it('scopes each selector, maps html/body/:root to the block, prefixes classes, drops *', () => {
    const { css } = sanitizeEmailCss('body{color:#111} html p, :root .x{margin:0} .hero > td{padding:8px} *{margin:0} p *{color:red} a.btn:hover{color:blue}', { scope: SCOPE });
    expect(css).toBe(`${SCOPE}{color:#111}\n${SCOPE} p,${SCOPE} .u-x{margin:0}\n${SCOPE} .u-hero > td{padding:8px}\n${SCOPE} a.u-btn:hover{color:blue}`);
  });

  it('keeps @media (widths, colour scheme) and !important only there; drops every other at-rule', () => {
    const { css, notes } = sanitizeEmailCss('@import url(https://evil.example/x.css); @charset "utf-8"; @font-face{font-family:x;src:url(x)} @keyframes k{from{opacity:0}} @supports (display:grid){p{color:red}} p{color:red!important} @media (max-width:600px){p{color:blue!important}} @media print{p{color:green}} @media (prefers-color-scheme: dark){p{color:white}}', { scope: SCOPE });
    expect(css).toBe(`${SCOPE} p{color:red}\n@media (max-width:600px){${SCOPE} p{color:blue!important}}\n@media (prefers-color-scheme: dark){${SCOPE} p{color:white}}`);
    expect(notes.join(' ')).toMatch(/@import/);
    expect(notes.join(' ')).toMatch(/@font-face/);
  });

  it('drops escapes, urls and expressions; without a scope it only cleans (and is stable)', () => {
    const { css } = sanitizeEmailCss('p{background:\\75 rl(https://t.example);color:red} td{background-image:url(https://t.example/p.gif)} q{width:expression(1)}', { scope: SCOPE });
    expect(css).toBe(`${SCOPE} p{color:red}`);
    const once = sanitizeEmailCss('body .a{color:red} @media (max-width:600px){.a{color:blue!important}}').css;
    expect(once).toBe('body .u-a{color:red}\n@media (max-width:600px){.u-a{color:blue!important}}');
    expect(sanitizeEmailCss(once).css).toBe(once);
  });

  it('refuses more than 8 KB', () => {
    expect(() => sanitizeEmailCss(Array.from({ length: 600 }, (_, i) => `.c${i}{color:red}`).join(''), { scope: SCOPE })).toThrow(SanitizeError);
  });
});

describe('URLs and entities', () => {
  it('safeHref strips controls and whitespace before the scheme check', () => {
    for (const bad of ['java\tscript:alert(1)', ' javascript:alert(1)', 'JAVASCRIPT:x', 'jav\u0000ascript:x', 'data:text/html,x', 'vbscript:x', 'file:///etc/passwd', '//evil.example', 'https://u:p@x.example']) expect(safeHref(bad, { mailto: true })).toBeNull();
    expect(safeHref('https://ok.example/a b')).toBe('https://ok.example/a%20b');
    expect(safeHref('#buy-preview')).toBeNull();
    expect(safeHref('#buy-preview', { fragment: true })).toBe('#buy-preview');
  });
  it('decodes numeric and named references once; bad numbers become U+FFFD', () => {
    expect(decodeEntities('&#x26;amp; &#38; &#0; &#xD800; &bogus; &amp')).toBe('&amp; & � � &bogus; &');
  });
});
