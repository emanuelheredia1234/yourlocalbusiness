// The SEO page in HTML mode, published: its form is one the server's lead check (server/leads.mjs) accepts, so what
// visitors send reaches Email → Leads. (Plain Node: the server's code can't load in the DOM test environment.)
import { describe, expect, it } from 'vitest';
import type { Project } from '@/lib/types';
import { newProject } from '@/store/defaults';
import { generateSeoMeta } from '@/ai/local/seo';
import { publishTarget } from './publish';
import { seoPublishBuild } from './seoPage';

// a plain-JS server module without type declarations: its one function used here, typed here
const { hasLeadForm } = (await import('../../server/leads.mjs' as string)) as { hasLeadForm: (html: string, slug: string) => boolean };

function project(): Project {
  const p = newProject('business', 'new');
  p.brand = { ...p.brand, name: 'Calm Studio' };
  p.marketing.seo = generateSeoMeta(p);
  // as the importer keeps a form that fits: post, {{lead-action}}, the hidden field
  p.marketing.seoHtml = {
    html: '<h1>Calm yoga</h1><form method="post" action="{{lead-action}}"><div class="hp" aria-hidden="true"><label>Website <input type="text" name="website" tabindex="-1" autocomplete="off"></label></div><input name="email" maxlength="254"><button>Send</button></form>',
    css: '.hp{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}',
    images: [],
    source: { via: 'viktor', at: 1 },
    title: 'Calm yoga',
    description: '',
    notes: [],
    active: true,
    hasLeadForm: true,
    importedAt: 1,
  };
  return p;
}

describe('a published HTML-mode page’s form', () => {
  it('posts to /<slug>/lead in the exact form the server accepts, on the app’s address and on a domain', () => {
    for (const target of [publishTarget('https://app.example', 'calm-yoga'), publishTarget('https://app.example', 'calm-yoga', 'calm.example', true)]) {
      const html = seoPublishBuild(project(), target).html;
      expect(hasLeadForm(html, 'calm-yoga')).toBe(true);
      expect(hasLeadForm(html, 'other-page')).toBe(false);
    }
  });

  it('without the active HTML-mode page, there is no such form', () => {
    const p = project();
    p.marketing.seoHtml = { ...p.marketing.seoHtml!, active: false };
    expect(hasLeadForm(seoPublishBuild(p, publishTarget('https://app.example', 'calm-yoga')).html, 'calm-yoga')).toBe(false);
  });
});

describe('the published lead magnet on the SEO page', () => {
  const delivery = { source: 'pdf' as const, fileId: 'AbCdEfGhIjKlMnOpQrStUv', link: 'https://app.example/m/AbCdEfGhIjKlMnOpQrStUv', gate: true, publishedAt: 1 };
  const withMagnet = (p: Project) => {
    p.marketing.leadMagnet = { id: 'lm', type: 'guide', title: 'Free guide', subtitle: '', intro: '', sections: [], cta: '', optInHeadline: '', optInBullets: [], buttonLabel: '', createdAt: 0, delivery };
    return p;
  };

  it('an HTML-mode page’s form sends its id, so the server gives the download after the sign-up', () => {
    const html = seoPublishBuild(withMagnet(project()), publishTarget('https://app.example', 'calm-yoga')).html;
    expect(html).toContain('<form method="post" action="/calm-yoga/lead"><input type="hidden" name="kind" value="lead"><input type="hidden" name="magnet" value="AbCdEfGhIjKlMnOpQrStUv">');
    expect(hasLeadForm(html, 'calm-yoga')).toBe(true);
    // without one, nothing is added
    expect(seoPublishBuild(project(), publishTarget('https://app.example', 'calm-yoga')).html).not.toContain('name="magnet"');
  });
});
