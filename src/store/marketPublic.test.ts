// "Public on the web" (P7), keeping the web page in step with the in-app listing: a republish updates the page only
// while the server says it is on the web (an owner's hide or the sweep's over-limit never goes back on by itself,
// whatever this device saved), a listing that is off the web loses its saved address (so other people's Marketplace
// stops offering it), and unpublishing a listing or deleting its business takes its page down.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ fetchPublicListings: vi.fn(), setListingPublic: vi.fn(), unlistPublic: vi.fn(), publicImagesFor: vi.fn() }));
vi.mock('@/lib/marketPublic', async (original) => ({ ...(await original<typeof import('@/lib/marketPublic')>()), ...api }));
const community = vi.hoisted(() => ({ pushMyListings: vi.fn(async () => undefined), startCommunitySync: vi.fn(async () => undefined) }));
vi.mock('@/lib/community', async (original) => ({ ...(await original<typeof import('@/lib/community')>()), ...community }));

const { useAuth } = await import('@/lib/cloud/auth');
const { useMarketConfig } = await import('@/lib/marketConfig');
const { useStore } = await import('@/store/useStore');
const { newProject } = await import('@/store/defaults');
const { buildListing } = await import('@/lib/listing');
const { refreshWebPage, unlistBeforeRemoving, useMarketPublic } = await import('./marketPublic');
const { unpublishProjectListing } = await import('@/lib/listingPublish');
const { deleteProjectEverywhere } = await import('@/lib/projectActions');
type State = import('@/lib/marketPublic').PublicListingState;
type Listing = import('@/lib/types').Listing;

const APP = 'https://yourlocalbusiness.replit.app';
const state = (listingId: string, status: State['status']): State => ({ listingId, projectId: 'biz-a', slug: 'cut-and-color-ab12cd', url: `${APP}/market/cut-and-color-ab12cd`, status, indexable: status === 'live', missing: [], reportCount: 0, publicAt: null, contentUpdatedAt: null });

function setup() {
  const p = { ...newProject('business', 'existing'), id: 'biz-a' };
  const listing: Listing = { ...buildListing(p), id: 'lst_1', projectId: 'biz-a', web: { slug: 'cut-and-color-ab12cd', url: `${APP}/market/cut-and-color-ab12cd` } };
  p.studio.publishedListingId = listing.id;
  useStore.setState({ projects: [p], activeProjectId: p.id, myListings: [listing] });
  return { p, listing };
}
const savedWeb = () => useStore.getState().myListings.find((l) => l.id === 'lst_1')?.web;

beforeEach(() => {
  for (const f of [...Object.values(api), ...Object.values(community)]) f.mockReset();
  community.pushMyListings.mockResolvedValue(undefined);
  api.publicImagesFor.mockResolvedValue({ galleryPaths: [], cache: {} });
  api.unlistPublic.mockResolvedValue(undefined);
  useAuth.setState({ phase: 'ready' });
  useMarketConfig.setState({ config: { enabled: true, publicUrl: `${APP}/market`, reachable: true } });
  useMarketPublic.setState({ byListing: {}, limit: 3, used: 0, loaded: false, loading: false, error: null, busy: {} });
});

describe('a republished listing’s web page', () => {
  it('over the limit (the sweep) or hidden (the owner): nothing is sent, even though this device saved its address; the address goes', async () => {
    for (const status of ['over_limit', 'hidden', 'unlisted'] as const) {
      const { p, listing } = setup();
      useMarketPublic.setState({ loaded: false, byListing: {} });
      api.fetchPublicListings.mockResolvedValue({ listings: [state('lst_1', status)], limit: 3, used: 0 });
      await refreshWebPage(p, listing);
      expect(api.fetchPublicListings, status).toHaveBeenCalledTimes(1);
      expect(api.setListingPublic, status).not.toHaveBeenCalled();
      expect(savedWeb(), status).toBeUndefined();
      api.fetchPublicListings.mockReset();
    }
    expect(community.pushMyListings).toHaveBeenCalled();
  });

  it('on the web: the page gets the new content', async () => {
    const { p, listing } = setup();
    api.fetchPublicListings.mockResolvedValue({ listings: [state('lst_1', 'thin')], limit: 3, used: 1 });
    api.setListingPublic.mockResolvedValue({ listing: state('lst_1', 'live'), created: false });
    await refreshWebPage(p, listing);
    expect(api.setListingPublic).toHaveBeenCalledTimes(1);
    expect(api.setListingPublic.mock.calls[0][0]).toBe('lst_1');
    expect(useMarketPublic.getState().byListing.lst_1.status).toBe('live');
  });

  it('the state can’t be read: nothing is sent', async () => {
    const { p, listing } = setup();
    api.fetchPublicListings.mockRejectedValue(new Error('Couldn’t reach the server.'));
    await refreshWebPage(p, listing);
    expect(api.setListingPublic).not.toHaveBeenCalled();
    expect(useMarketPublic.getState()).toMatchObject({ loaded: false, error: 'Couldn’t reach the server.' });
  });

  it('never on the web: nothing is sent', async () => {
    const { p, listing } = setup();
    api.fetchPublicListings.mockResolvedValue({ listings: [], limit: 3, used: 0 });
    await refreshWebPage(p, listing);
    expect(api.setListingPublic).not.toHaveBeenCalled();
    expect(savedWeb()).toBeUndefined();
  });

  it('reading the state again gives a listing on the web its address back', async () => {
    setup();
    useStore.setState({ myListings: useStore.getState().myListings.map((l) => ({ ...l, web: undefined })) });
    api.fetchPublicListings.mockResolvedValue({ listings: [state('lst_1', 'held')], limit: 3, used: 1 });
    await useMarketPublic.getState().load();
    expect(savedWeb()).toEqual({ slug: 'cut-and-color-ab12cd', url: `${APP}/market/cut-and-color-ab12cd` });
  });
});

describe('taking the page down with the listing', () => {
  it('unlistBeforeRemoving: a listing with a saved address is unlisted; one never on the web isn’t', async () => {
    const { listing } = setup();
    await unlistBeforeRemoving([listing, { ...listing, id: 'lst_2', web: undefined }, undefined]);
    expect(api.unlistPublic.mock.calls).toEqual([['lst_1']]);
  });

  it('unpublishing the listing takes its web page down', async () => {
    setup();
    unpublishProjectListing();
    await vi.waitFor(() => expect(api.unlistPublic).toHaveBeenCalledWith('lst_1'));
    expect(useStore.getState().myListings).toEqual([]);
  });

  it('deleting its business takes its web page down', async () => {
    setup();
    deleteProjectEverywhere('biz-a');
    await vi.waitFor(() => expect(api.unlistPublic).toHaveBeenCalledWith('lst_1'));
  });

  it('with the market off nothing is sent', async () => {
    const { listing } = setup();
    useMarketConfig.setState({ config: { enabled: false, publicUrl: null, reachable: true } });
    await unlistBeforeRemoving([listing]);
    expect(api.unlistPublic).not.toHaveBeenCalled();
  });
});
