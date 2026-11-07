// @vitest-environment happy-dom
// "Public on the web" (P7) in the browser: the Studio's toggle shows once the server has the market on and you're
// signed in, and the claude.ai build check alone hides it; a listing's details offer "View on the web" (this app's
// address, whatever the seller saved) and, for another seller's listing only, "Report listing", whose report names
// the in-app listing's seller. Requests are stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

vi.mock('@/components/ui/primitives', async (orig) => ({
  ...(await orig<typeof import('@/components/ui/primitives')>()),
  Modal: ({ title, subtitle, children, footer }: { title?: ReactNode; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) => createElement('section', null, createElement('h2', null, title), createElement('p', null, subtitle), children, createElement('footer', null, footer)),
  Select: ({ id, value, onChange, options }: { id?: string; value: string; onChange: (v: string) => void; options: { value: string; label: ReactNode }[] }) =>
    createElement('select', { id, value, onChange: (e: { target: { value: string } }) => onChange(e.target.value) }, createElement('option', { value: '' }, '—'), ...options.map((o) => createElement('option', { key: o.value, value: o.value }, o.label))),
  MoreMenu: ({ items, label }: { items: { label: string; onSelect: () => void }[]; label?: string }) => createElement('div', { 'aria-label': label }, ...items.map((i) => createElement('button', { key: i.label, type: 'button', onClick: i.onSelect }, i.label))),
}));
const api = vi.hoisted(() => ({ fetchPublicListings: vi.fn(() => new Promise(() => undefined)), reportListing: vi.fn(async () => undefined) }));
vi.mock('@/lib/marketPublic', async (orig) => ({ ...(await orig<typeof import('@/lib/marketPublic')>()), ...api }));

const { useAuth } = await import('@/lib/cloud/auth');
const { useMarketConfig } = await import('@/lib/marketConfig');
const { useMarketPublic } = await import('@/store/marketPublic');
const { newProject } = await import('@/store/defaults');
const { buildListing } = await import('@/lib/listing');
const { TooltipProvider } = await import('@/components/ui/shadcn/tooltip');
const { PublicWebToggle } = await import('./PublicWebToggle');
const { ListingWebRow, ReportListingDialog } = await import('./ReportListing');
type Listing = import('@/lib/types').Listing;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const APP = 'https://yourlocalbusiness.replit.app';
const SELLER = '11111111-2222-4333-8444-555555555555';
let host: HTMLDivElement;
let root: Root;
const render = async (el: ReturnType<typeof createElement>) => {
  await act(async () => root.render(createElement(TooltipProvider, null, el)));
};
const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim().includes(label)) as HTMLButtonElement | undefined;

beforeEach(() => {
  api.fetchPublicListings.mockClear();
  api.reportListing.mockClear();
  useAuth.setState({ phase: 'ready' });
  useMarketConfig.setState({ config: { enabled: true, publicUrl: `${APP}/market`, reachable: true } });
  useMarketPublic.setState({ byListing: {}, limit: 3, used: 0, loaded: false, loading: false, error: null, busy: {} });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('the Studio’s toggle', () => {
  it('shows when the market is on and you’re signed in (waiting for the state), and nothing in the claude.ai build', async () => {
    const p = newProject('business', 'new');
    await render(createElement(PublicWebToggle, { project: p, listing: buildListing(p) }));
    expect(host.textContent).toContain('Public on the web');
    expect(host.querySelector('[role="switch"]')?.hasAttribute('disabled')).toBe(true);
    expect(api.fetchPublicListings).toHaveBeenCalled();
    await act(async () => root.unmount());
    root = createRoot(host);
    vi.stubGlobal('__ARTIFACT_BUILD__', true);
    await render(createElement(PublicWebToggle, { project: p, listing: buildListing(p) }));
    expect(host.textContent).toBe('');
  });

  it('a failed read shows the reason and a Retry that reads again', async () => {
    const p = newProject('business', 'new');
    useMarketPublic.setState({ error: 'Couldn’t reach the server. Check your connection, then try again.', loading: true });
    await render(createElement(PublicWebToggle, { project: p, listing: buildListing(p) }));
    expect(host.textContent).toContain('Couldn’t check whether this listing is on the web. Couldn’t reach the server.');
    useMarketPublic.setState({ loading: false });
    await act(async () => button('Retry')!.click());
    expect(api.fetchPublicListings).toHaveBeenCalled();
  });
});

describe('a listing’s details', () => {
  const listing = (over: Partial<Listing> = {}): Listing => ({ ...buildListing(newProject('business', 'new')), seller: { name: 'Maya Cuts', ownerId: SELLER }, web: { slug: 'cut-ab12cd', url: 'https://evil.example/market/cut-ab12cd' }, ...over });

  it('another seller’s public listing: View on the web (this app’s address) and Report listing', async () => {
    const onReport = vi.fn();
    await render(createElement(ListingWebRow, { listing: listing(), mine: false, webOn: true, onReport }));
    expect(host.querySelector('a')?.getAttribute('href')).toBe(`${APP}/market/cut-ab12cd`);
    button('Report listing')!.click();
    expect(onReport).toHaveBeenCalled();
  });

  it('your own listing: View on the web, never Report; none without a web page, with the market off, or in the claude.ai build', async () => {
    await render(createElement(ListingWebRow, { listing: listing(), mine: true, webOn: true, onReport: () => {} }));
    expect(host.textContent).toContain('View on the web');
    expect(button('Report listing')).toBeUndefined();
    await render(createElement(ListingWebRow, { listing: listing({ web: undefined }), mine: false, webOn: true, onReport: () => {} }));
    expect(host.textContent).toBe('');
    await render(createElement(ListingWebRow, { listing: listing(), mine: false, webOn: false, onReport: () => {} }));
    expect(host.textContent).toBe('');
    vi.stubGlobal('__ARTIFACT_BUILD__', true);
    await render(createElement(ListingWebRow, { listing: listing(), mine: false, webOn: true, onReport: () => {} }));
    expect(host.textContent).toBe('');
  });

  it('the report dialog sends the slug, the listing’s seller, the reason and the note', async () => {
    const onClose = vi.fn();
    await render(createElement(ReportListingDialog, { slug: 'cut-ab12cd', sellerId: SELLER, title: 'Cut and color', onClose }));
    expect(button('Send report')?.disabled).toBe(true);
    const select = host.querySelector('select#report-reason') as HTMLSelectElement | null;
    if (select) {
      await act(async () => {
        select.value = 'scam';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }
    const note = host.querySelector('textarea#report-note') as HTMLTextAreaElement;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      set.call(note, 'Asked me to pay by gift card');
      note.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(select).not.toBeNull();
    await act(async () => button('Send report')!.click());
    expect(api.reportListing).toHaveBeenCalledWith('cut-ab12cd', SELLER, 'scam', 'Asked me to pay by gift card');
    expect(onClose).toHaveBeenCalled();
  });
});
