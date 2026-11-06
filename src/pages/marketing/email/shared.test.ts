// The email preview's merge values and button: the lead magnet's link is its published download (never a made-up
// /free address), the offer's link is the page posts link to, and the button is a real link only for a web address.
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { EmailStep, Project } from '@/lib/types';
import { newProject } from '@/store/defaults';
import { EmailView, emailTokens, webHref } from './shared';

const ID = 'AbCdEfGhIjKlMnOpQrStUv';
function project(): Project {
  const p = newProject('product', 'new');
  p.brand = { ...p.brand, name: 'Maya Bakes', websiteUrl: 'mayabakes.com' };
  return p;
}
const withMagnet = (p: Project, domainLink?: string): Project => {
  p.marketing.leadMagnet = { id: 'lm', type: 'guide', title: 'Free guide', subtitle: '', intro: '', sections: [], cta: '', optInHeadline: '', optInBullets: [], buttonLabel: '', createdAt: 0, delivery: { source: 'pdf', fileId: ID, link: `https://app.example/m/${ID}`, ...(domainLink ? { domainLink } : {}), gate: true, publishedAt: 1 } };
  return p;
};
const email = (over: Partial<EmailStep> = {}): EmailStep => ({ id: 'e1', index: 0, purpose: '', subject: 'Hi {{first_name}}', preview: '', body: 'Your guide: {{lead_magnet_link}}', delay: { value: 0, unit: 'days' }, ctaLabel: 'Get the guide', ctaUrl: '{{lead_magnet_link}}', ...over });
const view = (p: Project, e: EmailStep) => renderToStaticMarkup(createElement(EmailView, { project: p, email: e, tokens: emailTokens(p) }));

describe('merge values', () => {
  it('the lead magnet’s link: its published /m/ link on the app’s address, else a placeholder, never /free', () => {
    expect(emailTokens(project()).lead_magnet_link).toBe('[link to your free download]');
    expect(emailTokens(withMagnet(project())).lead_magnet_link).toBe(`https://app.example/m/${ID}`);
    // a domain link saved before (or a domain the SEO page has now) is never what an email sends: it stops working
    // when the domain is removed or loses its verification, and a sent email can't be changed
    const p = withMagnet(project(), `https://olddomain.com/m/${ID}`);
    p.marketing.seoPublished = { slug: 'maya', url: 'https://app.example/maya', domain: 'mayabakes.com', domainUrl: 'https://mayabakes.com/', publishedAt: 1, hash: '' };
    expect(emailTokens(p).lead_magnet_link).toBe(`https://app.example/m/${ID}`);
    p.marketing.seoPublished = undefined;
    expect(emailTokens(p).lead_magnet_link).toBe(`https://app.example/m/${ID}`);
    expect(JSON.stringify(emailTokens(project()))).not.toContain('/free');
  });

  it('the offer’s link: the published page (its domain first), else the website, else a placeholder', () => {
    const p = project();
    expect(emailTokens(p).product_link).toBe('https://mayabakes.com');
    p.marketing.seoPublished = { slug: 'maya', url: 'https://app.example/maya', publishedAt: 1, hash: '' };
    expect(emailTokens(p).product_link).toBe('https://app.example/maya');
    p.marketing.seoPublished = { ...p.marketing.seoPublished, domain: 'mayabakes.com', domainUrl: 'https://mayabakes.com/' };
    expect(emailTokens(p).product_link).toBe('https://mayabakes.com/');
    p.brand.websiteUrl = '';
    p.marketing.seoPublished = undefined;
    expect(emailTokens(p).product_link).toBe('[link to your offer]');
  });
});

describe('the preview’s button', () => {
  it('is a link that opens in a new tab for a web address', () => {
    const html = view(withMagnet(project()), email());
    expect(html).toContain(`<a href="https://app.example/m/${ID}" target="_blank" rel="noopener noreferrer" aria-label="Get the guide (opens in a new tab)"`);
    expect(html).toContain('signed up at mayabakes.com');
  });

  it('is not a link while it has no address, and says where to add one', () => {
    const html = view(project(), email());
    expect(html).not.toContain('<a ');
    // the lead magnet's link, with nothing published: publish the download
    expect(html).toContain('<span aria-disabled="true" title="Publish your download in Email › Lead magnet › Delivery"');
    const noSite = project();
    noSite.brand.websiteUrl = '';
    expect(view(noSite, email({ ctaUrl: '{{product_link}}' }))).toContain('title="Add your website in Settings › Brand, or publish your page"');
    expect(view(project(), email({ ctaUrl: '[link]' }))).toContain('title="Add a link in Sequence › Button link"');
    for (const bad of ['javascript:alert(1)', 'mailto:x@y.co', '[link]', 'https://localhost/x', 'https://u:p@x.com']) expect(webHref(bad), bad).toBe('');
    expect(webHref(' https://x.com/a ')).toBe('https://x.com/a');
  });

  it('the footer names the brand when there’s no page or website', () => {
    const p = project();
    p.brand.websiteUrl = '';
    expect(view(p, email())).toContain('signed up at Maya Bakes.');
  });
});
