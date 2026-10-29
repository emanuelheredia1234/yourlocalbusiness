import { describe, expect, it } from 'vitest';
import { sanitizeSvg } from './svg';

describe('sanitizeSvg', () => {
  it('keeps drawing elements, gradients and internal references', () => {
    const r = sanitizeSvg(
      `Here you go:\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 1000"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff0"/><stop offset="1" style="stop-color:#f0f"/></linearGradient></defs><rect width="800" height="1000" fill="url(#g)"/><circle cx="400" cy="500" r="120" style="fill:#123456;opacity:.8"/></svg> trailing text`,
    );
    expect(r).not.toBeNull();
    expect(r!.width).toBe(800);
    expect(r!.height).toBe(1000);
    expect(r!.svg).toContain('<linearGradient id="g"');
    expect(r!.svg).toContain('fill="url(#g)"');
    expect(r!.svg).toContain('stop-color="#f0f"');
    expect(r!.svg).toContain('fill="#123456"');
    expect(r!.svg.startsWith('<svg width="800" height="1000"')).toBe(true);
    expect(r!.svg.endsWith('</svg>')).toBe(true);
    expect(r!.svg).not.toContain('trailing');
  });

  it('removes scripts, handlers, foreignObject, text and external references', () => {
    const r = sanitizeSvg(
      `<svg viewBox="0 0 100 100" onload="alert(1)"><script>alert('x')</script><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">hi</div></foreignObject><text x="1" y="2">Buy now</text><image href="https://evil.example/a.png"/><use href="https://evil.example/s.svg#a"/><use href="#ok"/><rect width="10" height="10" fill="url(https://evil.example/x)" onclick="steal()"/><path d="M0 0L10 10" style="fill:url(javascript:alert(1));stroke:#000"/><a href="javascript:alert(1)"><circle r="3"/></a><style>rect{fill:red}</style></svg>`,
    );
    expect(r).not.toBeNull();
    const s = r!.svg;
    for (const bad of ['script', 'alert', 'onload', 'onclick', 'foreignObject', 'Buy now', 'evil.example', 'javascript', '<style', '<image', '<a ', '<text']) expect(s).not.toContain(bad);
    expect(s).toContain('<use href="#ok"/>');
    expect(s).toContain('<path d="M0 0L10 10" stroke="#000"/>');
    expect(s).toContain('<rect width="10" height="10"/>');
  });

  it('rejects markup that is not an svg or draws nothing', () => {
    expect(sanitizeSvg('no svg here')).toBeNull();
    expect(sanitizeSvg('<svg viewBox="0 0 10 10"><text>hi</text></svg>')).toBeNull();
    expect(sanitizeSvg('<svg><rect width="1" height="1"/></svg>')).toBeNull(); // no size
  });

  it('closes unbalanced tags and fixes percentage sizes', () => {
    const r = sanitizeSvg('<svg width="100%" height="100%" viewBox="0 0 300 200"><g><rect width="5" height="5"/>');
    expect(r!.svg).toBe('<svg width="300" height="200" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200"><g><rect width="5" height="5"/></g></svg>');
  });
});
