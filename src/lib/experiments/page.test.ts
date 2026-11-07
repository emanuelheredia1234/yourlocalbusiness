import { describe, expect, it } from 'vitest';
import { heroOf, withSeoVariant } from './page';
import { newProject } from '@/store/defaults';
import type { Project, SalesPage } from '@/lib/types';

const sections = (): SalesPage => ({ sections: [{ id: 'h', type: 'hero', visible: true, data: { eyebrow: '', headline: 'Fresh bread daily', subheadline: 'Baked at 5 am', ctaLabel: 'Order now', ctaSubtext: '', bullets: [], imageId: 'm1' } }], theme: {} as SalesPage['theme'], updatedAt: 1 });

describe('the SEO page’s version B', () => {
  it('section mode: only the hero fields change, the saved page doesn’t', () => {
    const p = { ...newProject('business', 'existing'), id: 'p1' } as Project;
    p.marketing = { ...p.marketing, salesPage: sections() };
    expect(heroOf(p)).toMatchObject({ mode: 'sections', headline: 'Fresh bread daily', ctaLabel: 'Order now', imageId: 'm1' });
    const b = withSeoVariant(p, { headline: 'Warm bread at 7?', imageId: 'm2' });
    const hero = b.marketing.salesPage!.sections[0];
    expect(hero.type === 'hero' && hero.data).toMatchObject({ headline: 'Warm bread at 7?', subheadline: 'Baked at 5 am', ctaLabel: 'Order now', imageId: 'm2' });
    expect(p.marketing.salesPage!.sections[0]).toEqual(sections().sections[0]);
  });

  it('HTML mode: the first h1 and the form’s button, escaped; no image swap', () => {
    const p = { ...newProject('business', 'existing'), id: 'p1' } as Project;
    p.marketing = { ...p.marketing, seo: { metaTitle: 't' } as Project['marketing']['seo'], seoHtml: { html: '<h1 class="x">Fresh <em>bread</em></h1><h1>Second</h1><form action="{{lead-action}}"><button type="button">x</button><button>Get the menu</button></form>', css: '', images: [], source: 'manus', title: '', description: '', notes: [], active: true, hasLeadForm: true, importedAt: 1 } as Project['marketing']['seoHtml'] };
    expect(heroOf(p)).toMatchObject({ mode: 'html', headline: 'Fresh bread', ctaLabel: 'Get the menu' });
    const b = withSeoVariant(p, { headline: 'Bread & <butter>', ctaLabel: 'Book a table' });
    expect(b.marketing.seoHtml!.html).toBe('<h1 class="x">Bread &amp; &lt;butter&gt;</h1><h1>Second</h1><form action="{{lead-action}}"><button type="button">x</button><button>Book a table</button></form>');
  });
});
