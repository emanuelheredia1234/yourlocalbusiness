// The listing windows the assistant opens: "Publish listing" shows exactly what goes public, who sees it
// and what's missing, with the page's checks; "Show / hide my listings" names the listings. Rendered to
// HTML (no browser): the Modal is stood in for, and so are the stores (a server render reads a store's
// first state).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Project } from '@/lib/types';

const fake = vi.hoisted(() => ({ store: {} as Record<string, unknown>, runtime: {} as Record<string, unknown> }));
vi.mock('@/store/useStore', () => {
  const useStore = Object.assign((sel: (s: unknown) => unknown) => sel(fake.store), { getState: () => fake.store, setState: () => {}, subscribe: () => () => {} });
  const active = () => (fake.store.projects as Project[])[0] ?? null;
  return { useStore, useActiveProject: active, getActiveProject: active };
});
vi.mock('@/lib/platform', async (orig) => {
  const real = await orig<typeof import('@/lib/platform')>();
  const state = () => ({ ...real.useRuntime.getState(), ...fake.runtime });
  return { ...real, useRuntime: Object.assign((sel: (s: unknown) => unknown) => sel(state()), { getState: state, setState: () => {}, subscribe: () => () => {} }) };
});
vi.mock('@/components/ui/primitives', async (orig) => ({
  ...(await orig<typeof import('@/components/ui/primitives')>()),
  Modal: ({ title, subtitle, children, footer }: { title?: ReactNode; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) => createElement('section', null, createElement('h2', null, title), createElement('p', null, subtitle), children, createElement('footer', null, footer)),
}));

import { buildListing } from '@/lib/listing';
import { defaultSettings, newProject } from '@/store/defaults';
import ListingWindow from './ListingWindow';

let project: Project;
const render = (action: 'publish' | 'show' | 'hide') => renderToStaticMarkup(createElement(ListingWindow, { action, project, close: () => undefined }));
const publishButton = (html: string) => html.match(/<button[^>]*>(?:(?!<\/button>).)*(Publish to Marketplace|Update listing|Republish listing)<\/button>/)?.[0] ?? '';

function ready() {
  project.studio.packages = [{ id: 'a', name: 'Standard clean', price: 120, priceModel: 'per-session', description: '', includes: ['Kitchen', 'Bathrooms'], popular: true }];
  project.studio.listing = { ...project.studio.listing, title: 'Copper Kettle Cleaning', tagline: 'Spotless homes', description: 'We clean homes across Austin with eco-friendly products, kitchens and bathrooms included. Book a time that suits you.', tags: ['cleaning', 'austin', 'eco'], category: 'Home Services', bookingType: 'book', buyUrl: 'https://cal.com/copper' };
}

beforeEach(() => {
  project = { ...newProject('business', 'existing'), id: 'p1', onboarded: true, location: { city: 'Austin', region: 'TX' } };
  project.brand.name = 'Copper Kettle';
  fake.store = { projects: [project], activeProjectId: 'p1', myListings: [], settings: defaultSettings() };
  fake.runtime = { community: 'local' };
});

describe('the publish window', () => {
  it('says what’s missing and keeps Publish off until the listing passes the page’s checks', () => {
    const html = render('publish');
    expect(html).toContain('Publish your listing to the Marketplace');
    // a one-line subtitle, then who will see it
    expect(html).toContain('This is exactly what goes public.');
    expect(html).toContain('Only you can see your listings here for now');
    expect(html).toContain('Finish these first:');
    for (const s of ['Title', 'Description (80+ characters)', '3+ search tags', 'Service packages (Structure tab)']) expect(html).toContain(`<li>${s}</li>`);
    expect(publishButton(html)).toContain('disabled');
  });

  it('shows exactly what goes public and who sees it, then lets the owner publish', () => {
    ready();
    fake.runtime = { community: 'live' };
    const html = render('publish');
    for (const s of ['Copper Kettle Cleaning', 'Spotless homes', '$120/session', 'Standard clean: $120 per session', 'Home Services', 'cleaning, austin, eco', 'eco-friendly products', 'Book a time', 'Austin, TX', 'Book: On cal.com', 'Everyone who uses this app can see it.']) expect(html).toContain(s);
    expect(html).not.toContain('Finish these first');
    expect(publishButton(html)).not.toContain('disabled');
    expect(publishButton(html)).toContain('Publish to Marketplace');
  });

  it('on a live listing: Republish when nothing changed, Update when something did', () => {
    ready();
    const live = buildListing(project);
    fake.store = { ...fake.store, myListings: [live] };
    project.studio.publishedListingId = live.id;
    expect(render('publish')).toContain('Update your Marketplace listing');
    expect(publishButton(render('publish'))).toContain('Republish listing');
    project.studio.listing = { ...project.studio.listing, tagline: 'Now in Round Rock too' };
    expect(publishButton(render('publish'))).toContain('Update listing');
  });
});

describe('the show / hide window', () => {
  it('names the listings it hides or shows', () => {
    ready();
    fake.store = { ...fake.store, myListings: [buildListing(project)] };
    fake.runtime = { community: 'live' };
    const hide = render('hide');
    expect(hide).toContain('Hide your listings from other people?');
    expect(hide).toContain('Other people won’t see your listings (“Copper Kettle Cleaning”) any more.');
    expect(hide).toContain('Hide my listings</button>');
    fake.store = { ...fake.store, settings: { ...defaultSettings(), shareToCommunity: false } };
    expect(render('show')).toContain('Everyone who uses this app will see your listings: “Copper Kettle Cleaning”');
    expect(render('hide')).toContain('already hidden');
  });

  it('without a shared Marketplace, there is nothing to show or hide', () => {
    const html = render('show');
    expect(html).toContain('There’s nothing to show or hide.');
    expect(html).not.toContain('Show my listings</button>');
  });
});
