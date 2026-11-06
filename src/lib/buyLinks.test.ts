import { describe, expect, it } from 'vitest';
import { buyHref, buyToken, buyTokenIds, hasBuyToken, keepBuyLinksOnly, offerHref, resolveBuyTokens } from './buyLinks';

const A = 'AAAAAAAAAAAAAAAAAAAAAA';
const B = 'BBBBBBBBBBBBBBBBBBBBBB';
const known = new Set([A]);

describe('buy tokens', () => {
  it('makes and finds them', () => {
    expect(buyToken(A)).toBe(`{{buy:${A}}}`);
    expect(hasBuyToken(`x {{ buy:${A} }} y`)).toBe(true);
    expect(hasBuyToken('{{buy:short}}')).toBe(false);
    expect(buyTokenIds(`{{buy:${A}}} {{buy:${B}}} {{buy:${A}}}`)).toEqual([A, B]);
  });

  it('page mode: a relative /b/ link, so a page on the owner’s domain stays there', () => {
    expect(resolveBuyTokens(`<a href="{{buy:${A}}}">Buy</a>`, { mode: 'page', known })).toBe(`<a href="/b/${A}">Buy</a>`);
    expect(resolveBuyTokens(`<a class="b" href='{{ buy:${A} }}'>Buy</a>`, { mode: 'page', known })).toBe(`<a class="b" href='/b/${A}'>Buy</a>`);
  });

  it('absolute mode: the app’s full address', () => {
    expect(resolveBuyTokens(`<a href="{{buy:${A}}}">Buy</a>`, { mode: 'absolute', origin: 'https://app.example.com/', known })).toBe(`<a href="https://app.example.com/b/${A}">Buy</a>`);
    expect(offerHref({ id: A }, 'absolute', 'https://app.example.com')).toBe(`https://app.example.com/b/${A}`);
    // an origin that isn't one: relative rather than something odd
    expect(buyHref(A, { mode: 'absolute', origin: 'javascript:alert(1)', known })).toBe(`/b/${A}`);
  });

  it('preview mode: never a checkout', () => {
    expect(resolveBuyTokens(`<a href="{{buy:${A}}}">Buy</a>`, { mode: 'preview' })).toBe('<a href="#buy-preview">Buy</a>');
    expect(resolveBuyTokens(`<a href="{{buy:${B}}}">Buy</a>`, { mode: 'preview', known })).toBe('<a href="#">Buy</a>');
  });

  it('an id that isn’t one of the business’s offers goes nowhere', () => {
    expect(resolveBuyTokens(`<a href="{{buy:${B}}}">Buy</a>`, { mode: 'page', known })).toBe('<a href="#">Buy</a>');
    expect(resolveBuyTokens(`<a href="{{buy:${A}}}">Buy</a>`, { mode: 'absolute', origin: 'https://x.test' })).toBe('<a href="#">Buy</a>');
  });

  it('HTML: only inside href; elsewhere the token is removed; scripts are left alone', () => {
    const html = `<p>Get it {{buy:${A}}} now</p><img src="{{buy:${A}}}"><a href="{{buy:${A}}}">Buy</a><script>var u = "{{buy:${A}}}";</script>`;
    const out = resolveBuyTokens(html, { mode: 'page', known });
    expect(out).toBe(`<p>Get it  now</p><img src=""><a href="/b/${A}">Buy</a><script>var u = "{{buy:${A}}}";</script>`);
  });

  it('plain text (emails): everywhere', () => {
    expect(resolveBuyTokens(`Buy here: {{buy:${A}}}`, { mode: 'absolute', origin: 'https://app.test', known, format: 'text' })).toBe(`Buy here: https://app.test/b/${A}`);
  });

  it('text without tokens is returned as it is', () => {
    const t = '<a href="https://x.test">x</a>';
    expect(resolveBuyTokens(t, { mode: 'page', known })).toBe(t);
  });
});

describe('keepBuyLinksOnly (generated and imported pages)', () => {
  it('keeps the token only as a link’s href', () => {
    const html = `<a class="btn" href="{{buy:${A}}}">Buy</a><p>{{buy:${A}}}</p><button data-x="{{buy:${A}}}">x</button><script>location.href="{{buy:${A}}}"</script><form action="{{buy:${A}}}"></form>`;
    expect(keepBuyLinksOnly(html)).toBe(`<a class="btn" href="{{buy:${A}}}">Buy</a><p></p><button data-x="">x</button><script>location.href=""</script><form action=""></form>`);
  });
  it('with the business’s offers: another id goes nowhere', () => {
    expect(keepBuyLinksOnly(`<a href="{{buy:${B}}}">Buy</a>`, known)).toBe('<a href="#">Buy</a>');
    expect(keepBuyLinksOnly(`<a href="{{buy:${A}}}">Buy</a>`, known)).toBe(`<a href="{{buy:${A}}}">Buy</a>`);
  });
});
