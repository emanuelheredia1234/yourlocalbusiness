// The business name on generated images is never cut: it gets smaller, then wraps, but every
// character stays and every line fits the space it has.
import { describe, expect, it } from 'vitest';
import { BRAND_FONT, fitName } from './imageCanvas';

/** A canvas stand-in: text is 0.6 × font size wide per character (like a bold display face). */
function fakeCtx() {
  const ctx = {
    font: '',
    letterSpacing: '0px',
    measureText(t: string) {
      const px = Number(/(\d+(?:\.\d+)?)px/.exec(ctx.font)?.[1] ?? 10);
      return { width: t.length * px * 0.6 } as TextMetrics;
    },
  };
  return ctx as unknown as CanvasRenderingContext2D;
}

const width = (ctx: CanvasRenderingContext2D, l: string) => ctx.measureText(l).width;

describe('the business name on images', () => {
  it('keeps a short name on one line at full size', () => {
    const ctx = fakeCtx();
    const fit = fitName(ctx, 'Sumari', BRAND_FONT, 40, 600, 60);
    expect(fit.lines).toEqual(['Sumari']);
    expect(fit.size).toBe(40);
  });

  it('shrinks a long name to fit one line before wrapping it', () => {
    const ctx = fakeCtx();
    const name = 'Freelancer Tax Tracking Co'; // 26 characters: 624 px at 40 px, too wide for 500
    const fit = fitName(ctx, name, BRAND_FONT, 40, 500, 60);
    expect(fit.lines).toEqual([name]);
    expect(fit.size).toBeLessThan(40);
    expect(width(ctx, fit.lines[0])).toBeLessThanOrEqual(500);
  });

  it('wraps a very long name onto more lines, every word kept', () => {
    const ctx = fakeCtx();
    const name = 'The Original Downtown Sunrise Bakery, Coffee Roasters & Wedding Cake Studio of Springfield';
    const fit = fitName(ctx, name, BRAND_FONT, 40, 520, 90);
    expect(fit.lines.length).toBeGreaterThan(1);
    expect(fit.lines.join(' ')).toBe(name);
    for (const l of fit.lines) expect(width(ctx, l)).toBeLessThanOrEqual(520);
    expect(fit.lines.join('')).not.toContain('…');
  });

  it('never cuts even one enormous word', () => {
    const ctx = fakeCtx();
    const name = 'Supercalifragilisticexpialidociousbookkeepingservices';
    const fit = fitName(ctx, name, BRAND_FONT, 40, 300, 60);
    expect(fit.lines.join('')).toBe(name);
    for (const l of fit.lines) expect(width(ctx, l)).toBeLessThanOrEqual(300);
  });

  it('tidies spacing but keeps every character', () => {
    const ctx = fakeCtx();
    expect(fitName(ctx, '  Maya’s   Candle  Co.  ', BRAND_FONT, 40, 900, 60).lines).toEqual(['Maya’s Candle Co.']);
  });
});
