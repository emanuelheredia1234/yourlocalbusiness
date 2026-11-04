// A business that never set a price (setup doesn't ask it) is never shown a made-up one.
import { describe, expect, it } from 'vitest';
import { newProject } from '@/store/defaults';
import type { Project } from '@/lib/types';
import { leadPrice, priceLabel } from '@/lib/listing';
import { buildFacts } from '../text';
import { composePost } from './social';
import { generateEmailSequence } from './email';
import { generateSalesPage, generateSeoMeta, exportSalesHtml, priceText } from './seo';

function business(): Project {
  const p = newProject('business', 'new');
  p.niche = 'Home Cleaning';
  p.category = 'Eco-friendly house cleaning';
  p.businessType = 'Home Cleaning';
  p.location = { city: 'Austin', region: 'TX' };
  p.brand.name = 'Summit Co';
  return p;
}

describe('a business with no price set', () => {
  it('has no price in its facts, and its listing asks for a quote', () => {
    const p = business();
    expect(buildFacts(p).price).toBe(0);
    expect(leadPrice(p)).toEqual({ price: 0, model: 'quote' });
    expect(priceLabel(0, 'quote')).toBe('Get a quote');
  });

  it('uses its own package price when it has packages', () => {
    const p = business();
    p.studio.packages = [{ id: 'a', name: 'Standard clean', price: 120, priceModel: 'per-session', includes: [], popular: false } as unknown as Project['studio']['packages'][number], { id: 'b', name: 'Deep clean', price: 220, priceModel: 'per-session', includes: [], popular: true } as unknown as Project['studio']['packages'][number]];
    expect(buildFacts(p).price).toBe(220);
  });

  it('writes posts and emails without a price', () => {
    const p = business();
    for (let i = 0; i < 12; i++) {
      const post = composePost(p, { topic: 'Spring cleaning', postType: 'sales', platform: 'facebook', format: 'image', style: 'minimal' }, {}, `seed-${i}`);
      expect(post.caption).not.toMatch(/Starting at \$|\$\d/);
    }
    const emails = JSON.stringify(generateEmailSequence(p, null));
    expect(emails).not.toMatch(/Investment: \$/);
    if (emails.includes('Investment:')) expect(emails).toContain('Investment: [your price].');
  });

  it('shows "Ask for a quote" on its sales page, never "$0"', () => {
    const p = business();
    const meta = generateSeoMeta(p);
    const page = generateSalesPage(p);
    const html = exportSalesHtml(page, meta, p.brand, p);
    expect(html).not.toContain('<b>$0</b>');
    if (page.sections.some((s) => s.type === 'pricing' && s.visible)) expect(html).toContain('Ask for a quote');
    expect(priceText(0, true)).toBe('Ask for a quote');
    expect(priceText(0, false)).toBe('Free');
    expect(priceText(49, true)).toBe('$49');
  });
});
