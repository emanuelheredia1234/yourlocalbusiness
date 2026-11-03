import { useMemo } from 'react';
import type { Listing } from '@/lib/types';
import { useStore } from '@/store/useStore';
import { useCommunity } from '@/lib/community';

/** Every listing the viewer can see: theirs, and other people’s when the Marketplace is shared. */
export function useAllListings(): Listing[] {
  const mine = useStore((s) => s.myListings);
  const community = useCommunity((s) => s.listings);
  return useMemo(() => {
    const own = mine.map((l) => ({ ...l, origin: 'mine' as const }));
    const ids = new Set(own.map((l) => l.id));
    return [...own, ...community.filter((l) => !ids.has(l.id))];
  }, [mine, community]);
}

export function findListing(id: string | null): Listing | undefined {
  if (!id) return undefined;
  return useStore.getState().myListings.find((l) => l.id === id) ?? useCommunity.getState().listings.find((l) => l.id === id);
}
