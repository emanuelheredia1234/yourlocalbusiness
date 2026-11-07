// The shared email modules (shared/email/*.mjs, typed by their .d.mts) as the app imports them: the types line up
// with what the modules return, so tsc checks the hand-written declarations on every build.
import { describe, expect, it } from 'vitest';
import { EMAIL_LIMITS, THEME_IDS, normalizeDoc, type EmailDoc, type Link } from '../../shared/email/blocks.mjs';
import { docFromPlain, plainFromDoc, applyTemplate, type TemplateId } from '../../shared/email/migrate.mjs';
import { ESP_IDS, renderEmail, renderText, resolveTheme, type RenderContext, type RenderResult } from '../../shared/email/render.mjs';
import { sanitizeEmailCss, sanitizeEmailHtml } from '../../shared/email/sanitize.mjs';

describe('the shared email modules, from the app', () => {
  it('render a migrated step in every target with the declared shapes', () => {
    const doc: EmailDoc = docFromPlain({ id: 'em_1', body: 'Hi {{first_name}}', ctaLabel: 'Go', ctaUrl: '{{product_link}}' });
    const link: Link = { kind: 'page' };
    expect(doc.blocks[1]).toMatchObject({ type: 'button', link });
    for (const target of ['preview', 'export', 'omnisend', 'gmail'] as const) {
      const ctx: RenderContext = { target, values: { first_name: 'Ann', product_link: 'https://shop.example' }, optOutUrl: 'https://app.example/u/1', esp: ESP_IDS[0] };
      const out: RenderResult = renderEmail(doc, ctx);
      expect(out.bytes).toBeGreaterThan(1000);
      expect(renderText(doc, ctx)).toContain('Hi Ann');
    }
    expect(plainFromDoc(doc)).toEqual({ body: 'Hi {{first_name}}', ctaLabel: 'Go', ctaUrl: '{{product_link}}' });
    const tpl: TemplateId = 'plain';
    expect(normalizeDoc(applyTemplate(tpl, { body: 'x', ctaLabel: '', ctaUrl: '' })).problems).toEqual([]);
    expect(resolveTheme({ id: THEME_IDS[1] }).tokens.width).toBeLessThanOrEqual(640);
    expect(EMAIL_LIMITS.htmlBytes).toBe(200 * 1024);
    expect(sanitizeEmailHtml('<b onclick="x">ok</b>').html).toBe('<b>ok</b>');
    expect(sanitizeEmailCss('p{color:red}', { scope: '.s' }).css).toBe('.s p{color:red}');
  });
});
