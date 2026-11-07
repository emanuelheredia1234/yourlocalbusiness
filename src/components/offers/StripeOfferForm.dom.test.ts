// @vitest-environment happy-dom
// Attach payment › Stripe in a real DOM: "A file" lists only the business's product files; Upload a file makes a
// product file (never a lead magnet) and picks it; Create sends whole minor units and the chosen file.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import type { LeadFile } from '@/lib/leadFiles';
import type { ConnectState } from '@/lib/stripeConnect';

const api = vi.hoisted(() => ({ listLeadFiles: vi.fn(), createLeadFile: vi.fn(), uploadLeadFileContent: vi.fn() }));
vi.mock('@/lib/leadFiles', async (orig) => ({ ...(await orig<typeof import('@/lib/leadFiles')>()), ...api }));

const { TooltipProvider } = await import('@/components/ui/shadcn/tooltip');
const { StripeOfferForm } = await import('./StripeOfferForm');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FILE: LeadFile = { id: 'FFFFFFFFFFFFFFFFFFFFFF', projectId: 'p1', title: 'Spring guide', brand: '', kind: 'file', fileName: 'guide.pdf', mime: 'application/pdf', bytes: 1000, url: '', gate: false, purpose: 'product', coverUrl: null, downloads: 0, lastDownloadAt: null, createdAt: null, updatedAt: null, link: '' };
const CONNECT: ConnectState = { available: true, environment: 'production', account: { id: 'RRRRRRRRRRRRRRRRRRRRRR', environment: 'production', status: 'active', country: 'US', defaultCurrency: 'usd', displayName: 'Maya', chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true, due: { now: 0, pastDue: 0, later: 0, pending: 0 }, deadline: null, disabledReason: null, taxEnabled: false, taxStatus: null, payoutFailedAt: null, accountLast4: 'h9Zq' }, fee: { pct: 3, tier: 'launch' }, termsUrl: '/seller-terms', termsVersion: 'v1', termsReady: true, countries: ['US'] };

let host: HTMLDivElement;
let root: Root;
const onCreate = vi.fn();
const setValue = (el: HTMLInputElement | HTMLSelectElement, value: string) => {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
};
const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) as HTMLButtonElement;

beforeEach(async () => {
  for (const f of [...Object.values(api), onCreate]) f.mockReset();
  api.listLeadFiles.mockResolvedValue([FILE, { ...FILE, id: 'MMMMMMMMMMMMMMMMMMMMMM', title: 'A magnet', purpose: 'magnet' }]);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(createElement(TooltipProvider, null, createElement(StripeOfferForm, { projectId: 'p1', connect: CONNECT, defaultTitle: 'Spring course', busy: false, error: '', onCreate })));
  });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('Attach payment › Stripe (DOM)', () => {
  it('A file: only product files; Create sends minor units and the file', async () => {
    await act(async () => button('A file').click());
    await act(async () => {});
    expect(api.listLeadFiles).toHaveBeenCalledWith('p1', expect.anything(), 'product');
    const select = host.querySelector('#attach-stripe-file') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['Choose a file', 'Spring guide']);
    await act(async () => setValue(host.querySelector('#attach-stripe-price') as HTMLInputElement, '49.50'));
    await act(async () => setValue(select, FILE.id));
    expect(host.textContent).toContain('Our fee $1.48 (3% on Launch)');
    await act(async () => button('Create buy link').click());
    expect(onCreate).toHaveBeenCalledWith({ title: 'Spring course', priceMinor: 4950, currency: 'usd', delivery: { kind: 'file', fileId: FILE.id } });
  });

  it('Upload a file makes a product file and picks it', async () => {
    api.listLeadFiles.mockResolvedValue([]);
    const made = { ...FILE, id: 'NNNNNNNNNNNNNNNNNNNNNN', title: 'Workbook' };
    api.createLeadFile.mockResolvedValue({ ...made, bytes: 0 });
    api.uploadLeadFileContent.mockResolvedValue(made);
    await act(async () => button('A file').click());
    await act(async () => {});
    expect(host.textContent).toContain('No product files yet.');
    const input = host.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['%PDF-1.4'], 'workbook.pdf', { type: 'application/pdf' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    await act(async () => {});
    expect(api.createLeadFile).toHaveBeenCalledWith({ projectId: 'p1', title: 'Spring course', kind: 'file', purpose: 'product' });
    expect((host.querySelector('#attach-stripe-file') as HTMLSelectElement).value).toBe(made.id);
  });
});
