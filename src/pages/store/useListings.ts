import { useMemo } from 'react';
import type { Listing } from '@/lib/types';
import { useStore } from '@/store/useStore';
import { useCommunity } from '@/lib/community';
import { SAMPLE_LISTINGS } from './seed';

/** Every listing the viewer can see: theirs, other viewers’ (shared store) and samples. */
export function useAllListings(): Listing[] {
  const mine = useStore((s) => s.myListings);
  const showSamples = useStore((s) => s.settings.showSampleListings);
  const community = useCommunity((s) => s.listings);
  return useMemo(() => {
    const own = mine.map((l) => ({ ...l, origin: 'mine' as const }));
    const ids = new Set(own.map((l) => l.id));
    const others = community.filter((l) => !ids.has(l.id));
    return [...own, ...others, ...(showSamples ? SAMPLE_LISTINGS : [])];
  }, [mine, community, showSamples]);
}

export function findListing(id: string | null): Listing | undefined {
  if (!id) return undefined;
  const s = useStore.getState();
  return s.myListings.find((l) => l.id === id) ?? useCommunity.getState().listings.find((l) => l.id === id) ?? SAMPLE_LISTINGS.find((l) => l.id === id);
}
