// New leads in the app: counted per project's page against what the owner has seen, announced once per
// page in the bell (never with what a visitor wrote, and never again from another device's marker), and
// added to the right project's subscribers once.
import { beforeEach, describe, expect, it } from 'vitest';
import type { Project } from '@/lib/types';
import { seoPageIdOf, type Lead } from '@/lib/leads';
import { isInventedNotice } from './cleanup';
import { newProject } from './defaults';
import { useStore } from './useStore';
import { addLeadToSubscribers, announceLeads, forgetLeads, leadsToAnnounce, markLeadsSeen, newLeadCount, useLeads } from './leads';

const T = (min: number) => Date.UTC(2026, 10, 3, 10, min);
const iso = (min: number) => new Date(T(min)).toISOString();

function project(id: string, brand: string, published = true): Project {
  const p = { ...newProject('business', 'new'), id };
  p.brand = { ...p.brand, name: brand };
  if (published) p.marketing.seoPublished = { slug: `${id}-page`, url: `https://app.example/${id}-page`, publishedAt: T(0), hash: 'h' };
  return p;
}

let n = 0;
const lead = (p: Project | string, min: number, over: Partial<Lead> = {}): Lead => ({
  id: `lead-${++n}`,
  pageId: seoPageIdOf(typeof p === 'string' ? p : p.id),
  slug: typeof p === 'string' ? `${p}-page` : p.marketing.seoPublished?.slug ?? 'old-name',
  name: 'Ann',
  email: 'ann@example.com',
  phone: '',
  message: 'Please call me about a quote',
  time: '',
  createdAt: iso(min),
  ...over,
});

beforeEach(() => {
  forgetLeads();
});

describe('what counts as new', () => {
  it('counts this project’s page’s leads newer than the owner last saw', () => {
    const a = project('pa', 'Maya Bakes');
    const recent = [lead(a, 5), lead(a, 3), lead('pb', 9), lead(a, 1)];
    expect(newLeadCount(a, recent)).toBe(3);
    a.marketing.leadsSeenAt = T(3);
    expect(newLeadCount(a, recent)).toBe(1);
    a.marketing.leadsSeenAt = T(5);
    expect(newLeadCount(a, recent)).toBe(0);
    expect(newLeadCount(a, null)).toBe(0);
    expect(newLeadCount(null, recent)).toBe(0);
  });
});

describe('what the bell announces', () => {
  it('only pages that are published, past both markers, one entry per page', () => {
    const a = project('pa', 'Maya Bakes');
    const b = project('pb', 'Bo’s Bikes');
    const c = project('pc', 'Unpublished', false);
    const recent = [lead(a, 7, { slug: 'maya-bakes' }), lead(a, 4, { slug: 'maya-old' }), lead(b, 6), lead(c, 8)];
    expect(leadsToAnnounce([a, b, c], recent)).toEqual([
      { projectId: 'pa', count: 2, newest: T(7), slug: 'maya-bakes', brand: 'Maya Bakes' },
      { projectId: 'pb', count: 1, newest: T(6), slug: 'pb-page', brand: 'Bo’s Bikes' },
    ]);
    // the marker is the later of "seen" and "announced"
    a.marketing.leadsNotifiedAt = T(4);
    b.marketing.leadsSeenAt = T(6);
    expect(leadsToAnnounce([a, b, c], recent)).toEqual([{ projectId: 'pa', count: 1, newest: T(7), slug: 'maya-bakes', brand: 'Maya Bakes' }]);
    a.marketing.leadsSeenAt = T(9);
    expect(leadsToAnnounce([a, b, c], recent)).toEqual([]);
    expect(leadsToAnnounce([a, b], [])).toEqual([]);
  });

  it('puts one notice per page in the bell, with no visitor’s words, and not twice', () => {
    const a = project('pa', 'Maya Bakes');
    const b = project('pb', 'Bo’s Bikes');
    useStore.setState({ projects: [a, b], activeProjectId: 'pa', notices: [] });
    const recent = [lead(a, 3, { name: 'Zed Secret', email: 'zed@secret.example', message: 'my private note' }), lead(a, 2), lead(b, 1)];
    announceLeads(recent);
    const notices = useStore.getState().notices;
    expect(notices.map((x) => [x.kind, x.title, x.body, x.route])).toEqual([
      ['lead', 'New lead from your page', '/pb-page · Bo’s Bikes', 'marketing-email'],
      ['lead', '2 new leads from your page', '/pa-page · Maya Bakes', 'marketing-email'],
    ]);
    expect(JSON.stringify(notices)).not.toMatch(/Zed|secret|private|ann@example/);
    // the cleanup keeps them (it deletes notices made up by older versions)
    expect(notices.some(isInventedNotice)).toBe(false);
    const st = useStore.getState();
    expect(st.projects.find((p) => p.id === 'pa')!.marketing.leadsNotifiedAt).toBe(T(3));
    expect(st.projects.find((p) => p.id === 'pb')!.marketing.leadsNotifiedAt).toBe(T(1));
    // looking again finds nothing new
    announceLeads(recent);
    expect(useStore.getState().notices).toHaveLength(2);
    // a hundred or more: "100+"
    useStore.setState({ notices: [] });
    announceLeads(Array.from({ length: 100 }, (_, i) => lead(a, 10 + i)));
    expect(useStore.getState().notices[0].title).toBe('100+ new leads from your page');
  });

  it('marks leads seen only forward', () => {
    const a = project('pa', 'Maya Bakes');
    useStore.setState({ projects: [a], activeProjectId: 'pa' });
    markLeadsSeen('pa', T(5));
    expect(useStore.getState().projects[0].marketing.leadsSeenAt).toBe(T(5));
    markLeadsSeen('pa', T(2));
    markLeadsSeen('pa', 0);
    markLeadsSeen('nope', T(9));
    expect(useStore.getState().projects[0].marketing.leadsSeenAt).toBe(T(5));
  });

  it('forgets the leads it saw (signed out, or another account), and takes out a deleted one', () => {
    useLeads.setState({ recent: [lead('pa', 1), lead('pa', 2)], checkedAt: 5, error: 'x' });
    useLeads.getState().drop(useLeads.getState().recent![0].id);
    expect(useLeads.getState().recent).toHaveLength(1);
    forgetLeads();
    expect(useLeads.getState()).toMatchObject({ recent: null, checkedAt: 0, error: '' });
  });
});

describe('adding a lead to subscribers', () => {
  it('adds to the project the page belongs to, once, with a real email only', () => {
    const a = project('pa', 'Maya Bakes');
    const b = project('pb', 'Bo’s Bikes');
    b.marketing.subscribers = [{ id: 's1', name: 'Cy', email: 'Cy@Example.com', joinedAt: 1, source: 'import' }];
    useStore.setState({ projects: [a, b], activeProjectId: 'pa' });

    // b's page: added to b, though a is open
    expect(addLeadToSubscribers(lead(b, 4, { name: 'Dee', email: 'Dee@Example.com' }))).toEqual({ status: 'added', projectId: 'pb', brand: 'Bo’s Bikes' });
    const subs = useStore.getState().projects.find((p) => p.id === 'pb')!.marketing.subscribers;
    expect(subs[0]).toMatchObject({ name: 'Dee', email: 'dee@example.com', source: 'lead', joinedAt: T(4) });
    expect(useStore.getState().projects.find((p) => p.id === 'pa')!.marketing.subscribers).toEqual([]);
    // already there, in any case
    expect(addLeadToSubscribers(lead(b, 5, { email: 'CY@example.COM' })).status).toBe('exists');
    expect(addLeadToSubscribers(lead(b, 5, { email: 'dee@example.com' })).status).toBe('exists');
    // no email, or not a real one
    expect(addLeadToSubscribers(lead(b, 6, { email: '', phone: '555 0100' })).status).toBe('no-email');
    expect(addLeadToSubscribers(lead(b, 6, { email: 'javascript:alert(1)' })).status).toBe('no-email');
    // a page that isn't in the projects: the open one
    expect(addLeadToSubscribers(lead('gone', 7, { name: '', email: 'eve@example.com' }))).toEqual({ status: 'added', projectId: 'pa', brand: 'Maya Bakes' });
    expect(useStore.getState().projects.find((p) => p.id === 'pa')!.marketing.subscribers[0]).toMatchObject({ name: 'eve', email: 'eve@example.com', source: 'lead' });
    expect(useStore.getState().projects.find((p) => p.id === 'pb')!.marketing.subscribers).toHaveLength(2);
  });
});
