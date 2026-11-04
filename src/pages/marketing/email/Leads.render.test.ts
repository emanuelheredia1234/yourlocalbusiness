// Email → Leads as it first shows (rendered once, as on the server: no effects run, so the list is what the
// watcher already has): why it isn't there when it can't be, an empty list that says where leads come
// from, and a lead with its ways to reply, its preferred time, its page, Add to subscribers and Delete.
// Visitors wrote every word: nothing they typed becomes a link unless it's a real email or phone number.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Project } from '@/lib/types';
import type { PublishAccess } from '@/lib/publish';
import type { Lead } from '@/lib/leads';

const state: { access: PublishAccess } = { access: 'ready' };
vi.mock('@/lib/publish', async (original) => ({ ...(await original<typeof import('@/lib/publish')>()), usePublishAccess: () => ({ access: state.access, retry: () => {} }) }));

// Rendered on the server, a zustand hook shows the store's first state: read the current one instead.
const live = <S,>(store: { getState: () => S }) => Object.assign(<T,>(select: (s: S) => T = (s) => s as unknown as T) => select(store.getState()), store);
vi.mock('@/store/useStore', async (original) => {
  const real = await original<typeof import('@/store/useStore')>();
  return { ...real, useStore: live(real.useStore), useActiveProject: () => real.getActiveProject() };
});
vi.mock('@/store/leads', async (original) => {
  const real = await original<typeof import('@/store/leads')>();
  return { ...real, useLeads: live(real.useLeads), useNewLeadCount: (p: Project | null | undefined) => real.newLeadCount(p, real.useLeads.getState().recent) };
});

const { useStore } = await import('@/store/useStore');
const { newProject, defaultSettings } = await import('@/store/defaults');
const { useLeads } = await import('@/store/leads');
const { seoPageIdOf } = await import('@/lib/leads');
const { Leads } = await import('./Leads');
const { default: EmailFunnel } = await import('../EmailFunnel');
const { Sidebar } = await import('@/components/layout/Shell');

function project(): Project {
  const p = { ...newProject('business', 'new'), id: 'proj_leads1', onboarded: true };
  p.brand = { ...p.brand, name: 'Maya Bakes' };
  return p;
}

const lead = (over: Partial<Lead> = {}): Lead => ({
  id: '0b7c1a2e-1111-4222-8333-444455556666',
  pageId: seoPageIdOf('proj_leads1'),
  slug: 'maya-bakes',
  name: 'Ann Lee',
  email: 'ann@example.com',
  phone: '+1 512 555 0100',
  message: 'Can you do a cake for Friday?',
  time: 'Tuesday morning',
  createdAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
  ...over,
});

const use = (p: Project, recent: Lead[] | null) => {
  useStore.setState({ projects: [p], activeProjectId: p.id, settings: defaultSettings() });
  useLeads.setState({ recent, checkedAt: 0, error: '' });
};
const render = (p: Project, recent: Lead[] | null) => {
  use(p, recent);
  return renderToStaticMarkup(createElement(Leads, { project: p }));
};

beforeEach(() => {
  state.access = 'ready';
});

describe('where leads can’t be shown', () => {
  it('says why, and what to do', () => {
    state.access = 'signed-out';
    let html = render(project(), null);
    expect(html).toContain('Sign in to see leads from your pages.');
    expect(html).toMatch(/<button type="button" class="btn btn-primary btn-sm">Sign in<\/button>/);
    state.access = 'unavailable';
    expect(render(project(), null)).toContain('Leads need the app’s own server. In claude.ai, page forms can’t send.');
    state.access = 'off';
    expect(render(project(), null)).toContain('Leads need publishing, which isn’t set up on this app’s server yet.');
    state.access = 'unreachable';
    html = render(project(), null);
    expect(html).toContain('Couldn’t reach the app’s server.');
    expect(html).toContain('Try again');
    state.access = 'checking';
    expect(render(project(), null)).toContain('aria-label="Checking the app’s server"');
  });
});

describe('the list', () => {
  it('says where leads come from when there are none, with a way to build a lead form page', () => {
    const html = render(project(), []);
    expect(html).toContain('No leads yet');
    expect(html).toContain('When someone sends the form on your published page, it shows here. Lead form pages have a form, and so do booking pages without a booking link.');
    expect(html).toContain('Build a lead form page');
    expect(html).toContain('Reply from your own email or phone: the app doesn’t send email.');
    // nothing to export
    expect(html).toMatch(/<button type="button" class="btn btn-secondary btn-sm" disabled="">.*Export CSV<\/button>/);
  });

  it('shows a lead with its ways to reply, its preferred time and its page', () => {
    const html = render(project(), [lead()]);
    expect(html).toContain('1 lead<');
    expect(html).toContain('<ul tabindex="-1" aria-label="Leads"');
    expect(html).toContain('<bdi>Ann Lee</bdi>');
    expect(html).toMatch(/<time dateTime="[^"]+" title="[^"]+"[^>]*>2h ago<\/time>/);
    expect(html).toContain('href="mailto:ann@example.com"');
    expect(html).toContain('href="tel:+15125550100"');
    expect(html).toContain('Preferred time: <bdi>Tuesday morning</bdi>');
    expect(html).toContain('Can you do a cake for Friday?');
    expect(html).toContain('From /maya-bakes · Maya Bakes');
    expect(html).toContain('Add only people who asked to hear from you.');
    expect(html).toMatch(/<button type="button" class="btn btn-secondary btn-xs">.*Add to subscribers<\/button>/);
    expect(html).toContain('aria-label="Delete the lead from Ann Lee"');
    expect(html).not.toContain('Show all');
    expect(html).not.toContain('No leads yet');
  });

  it('never makes a link of what isn’t a real email or phone number, and shows a visitor’s markup as text', () => {
    const html = render(project(), [lead({ name: '', email: 'javascript:alert(1)', phone: 'call me', time: '', message: '<script>alert(1)</script> {{img-1}}' })]);
    expect(html).not.toMatch(/href="(javascript|mailto:javascript|tel:)/);
    expect(html).toContain('javascript:alert(1)');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; {{img-1}}');
    expect(html).not.toContain('<script>');
    expect(html).toContain('No name given');
    expect(html).not.toContain('Preferred time');
    // no email to add, and the Delete button names what there is
    expect(html).toMatch(/<button type="button" class="btn btn-secondary btn-xs" disabled="" title="No email address to add">/);
    expect(html).toContain('aria-label="Delete the lead from javascript:alert(1)"');
  });

  it('shows Subscribed once the lead is on the list, and a long message with Show all', () => {
    const p = project();
    p.marketing.subscribers = [{ id: 's1', name: 'Ann', email: 'ANN@example.com', joinedAt: 1, source: 'lead' }];
    const html = render(p, [lead({ message: Array.from({ length: 9 }, (_, i) => `Line ${i + 1}`).join('\n') })]);
    expect(html).toMatch(/<button type="button" class="btn btn-secondary btn-xs" disabled="">.*Subscribed<\/button>/);
    expect(html).not.toContain('Add to subscribers');
    expect(html).toMatch(/<p id="[^"]+-msg" dir="auto" class="[^"]*line-clamp-6[^"]*">/);
    expect(html).toMatch(/aria-expanded="false" aria-controls="[^"]+-msg">Show all<\/button>/);
  });

  it('shows only this page’s leads at first', () => {
    const html = render(project(), [lead(), lead({ id: 'other', pageId: 'seo:someone_else', slug: 'other-page', name: 'Bo' })]);
    expect(html).toContain('Ann Lee');
    expect(html).not.toContain('Bo<');
    expect(html).toContain('1 lead<');
  });
});

describe('Email', () => {
  it('has a Leads tab with the count of new leads, opens on it, and the Email channel shows a badge', () => {
    const p = project();
    use(p, [lead(), lead({ id: 'l2', name: 'Cy' })]);
    let html = renderToStaticMarkup(createElement(EmailFunnel));
    expect(html).toMatch(/<button role="tab" aria-selected="true"[^>]*>.*Leads<span class="num font-mono text-caption text-muted">2<\/span><\/button>/);
    // the Email channel's badge sits in the sidebar's Marketing group now (it replaced the channel switcher)
    expect(renderToStaticMarkup(createElement(Sidebar))).toMatch(/>Email<\/span><span class="nav-count">2<span class="sr-only">, 2 new leads<\/span><\/span><\/button>/);
    expect(html).toContain('Messages from your published page’s form show under Leads.');
    expect(html).toContain('aria-label="Delete the lead from Cy"');
    // seen: no count, and the funnel opens where it always did
    p.marketing.leadsSeenAt = Date.now();
    use(p, [lead()]);
    html = renderToStaticMarkup(createElement(EmailFunnel));
    expect(html).toMatch(/<button role="tab" aria-selected="false"[^>]*>.*Leads<\/button>/);
    expect(html).not.toContain('new lead');
    expect(renderToStaticMarkup(createElement(Sidebar))).not.toContain('new lead');
    expect(html).toMatch(/<button role="tab" aria-selected="true"[^>]*>.*Lead magnet &amp; opt-in<\/button>/);
  });
});
