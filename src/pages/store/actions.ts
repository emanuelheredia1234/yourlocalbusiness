import type { Listing, Order } from '@/lib/types';
import { useStore } from '@/store/useStore';
import { toast, useUI } from '@/store/ui';

export function addListingToCart(l: Listing, opts: { option?: string; price?: number; bookingAt?: string } = {}) {
  useStore.getState().addToCart({
    listingId: l.id,
    title: l.title,
    price: opts.price ?? l.price,
    qty: 1,
    kind: l.kind,
    option: opts.option,
    bookingAt: opts.bookingAt,
    sellerName: l.seller.name,
    sellerOwnerId: l.seller.ownerId,
    cover: l.cover,
    origin: l.origin,
  });
  toast({ kind: 'success', title: 'Added to cart', body: opts.option ? `${l.title} · ${opts.option}` : l.title, action: { label: 'View cart', run: () => useUI.getState().setCartOpen(true) } });
}

export function accessFile(order: Order, item: Order['items'][number]): string {
  const s = useStore.getState();
  const own = s.myListings.find((l) => l.id === item.listingId);
  const project = own ? s.projects.find((p) => p.id === own.projectId) : null;
  const lines = [
    `# ${item.title}`,
    `Sold by ${item.sellerName} · Order ${order.number} · ${new Date(order.createdAt).toLocaleDateString()}`,
    '',
    'Thank you for your purchase! This file confirms your access.',
    '',
  ];
  if (project?.studio.outline.length) {
    lines.push(`## What’s inside`);
    for (const sec of project.studio.outline) {
      lines.push(`### ${sec.title}`, ...sec.items.map((i) => `- ${i.title}${i.meta ? ` (${i.meta})` : ''}`), '');
    }
  } else {
    lines.push('## Access', 'Your seller will email your download link and any login details to the address you used at checkout.', '');
  }
  lines.push('---', 'License: personal use by the purchaser. Please don’t redistribute.');
  return lines.join('\n');
}
