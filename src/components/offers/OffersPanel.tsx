// Studio › Listing & publish › Offers: everything a business sells through a buy link, with who takes the payment,
// whether it's selling, its clicks and live sales, and where it's used. Refresh from Whop re-reads a Whop plan's
// price; Pause makes its link say "not available right now"; Archive retires it ("no longer available").

import { useState } from 'react';
import { Archive, Pause, Play, RefreshCw } from 'lucide-react';
import type { Project } from '@/lib/types';
import { fmtNum, fmtRelative } from '@/lib/utils';
import { OffersError, archiveOffer, checkOffer, offerConnection, offerPrice, offerProblem, offerUses, updateOffer, type Offer, type WhopConnection } from '@/lib/offers';
import { useOffers, useProjectOffers } from '@/store/offers';
import { toast } from '@/store/ui';
import { CopyButton, MoreMenu, SettingsSection, Spinner, confirmAction } from '@/components/ui/primitives';
import { OfferBadges } from './AttachPayment';

/** One offer's row (render tests draw it directly). */
export function OfferRow({
  offer,
  uses,
  connection,
  busy,
  onCheck,
  onPause,
  onArchive,
}: {
  offer: Offer;
  uses: string[];
  connection?: Pick<WhopConnection, 'status'> | null;
  busy?: boolean;
  onCheck: () => void;
  onPause: (paused: boolean) => void;
  onArchive: () => void;
}) {
  const problem = offerProblem(offer, connection);
  const paused = offer.status === 'paused';
  return (
    <li className="flex flex-col gap-1.5 py-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 truncate text-ui text-ink">{offer.title}</span>
        {offerPrice(offer) && <span className="text-small text-ink-2">{offerPrice(offer)}</span>}
        <OfferBadges offer={offer} />
        <span className="ml-auto flex items-center gap-1">
          {busy && <Spinner size={14} />}
          {offer.link && <CopyButton text={offer.link} label="Copy link" size="xs" />}
          <MoreMenu
            label={`More for ${offer.title}`}
            size="xs"
            items={[
              ...(offer.provider === 'whop'
                ? [
                    {
                      label: offer.status === 'checkout_unknown' ? 'Check again' : 'Refresh from Whop',
                      icon: <RefreshCw />,
                      onSelect: onCheck,
                    },
                  ]
                : []),
              ...(offer.status === 'active' || paused
                ? [
                    {
                      label: paused ? 'Resume' : 'Pause',
                      icon: paused ? <Play /> : <Pause />,
                      onSelect: () => onPause(!paused),
                    },
                  ]
                : []),
              {
                label: 'Archive',
                icon: <Archive />,
                onSelect: onArchive,
                danger: true,
              },
            ]}
          />
        </span>
      </div>
      <p className="text-caption text-muted">
        {fmtNum(offer.clicks)} click{offer.clicks === 1 ? '' : 's'}
        {offer.provider === 'whop'
          ? ` · ${fmtNum(offer.sales.count)} ${offer.environment === 'sandbox' ? 'test ' : ''}sale${offer.sales.count === 1 ? '' : 's'}`
          : ' · sales happen on your own checkout'}
        {offer.sales.last ? ` · last ${fmtRelative(offer.sales.last)}` : ''}
        {` · ${uses.length ? `Used on: ${uses.join(', ')}` : 'Not used anywhere yet'}`}
      </p>
      {problem && <p className="text-caption text-warn">{problem}</p>}
    </li>
  );
}

export function OffersPanel({ project }: { project: Project }) {
  const { on, offers, loaded } = useProjectOffers(project.id);
  const connections = useOffers((s) => s.connections);
  const error = useOffers((s) => s.error[project.id] ?? '');
  const [busy, setBusy] = useState('');
  if (!on) return null;

  const act = async (id: string, fn: () => Promise<Offer>, ok?: string) => {
    setBusy(id);
    try {
      const o = await fn();
      useOffers.getState().put(o);
      if (ok) toast({ kind: 'success', title: ok });
    } catch (e) {
      toast({
        kind: 'error',
        title: e instanceof OffersError || e instanceof Error ? e.message : 'That didn’t work. Try again.',
      });
    } finally {
      setBusy('');
    }
  };
  const archive = async (o: Offer) => {
    const uses = offerUses(project, o.id);
    const ok = await confirmAction({
      title: `Archive “${o.title}”?`,
      body: `Its buy link will say it’s no longer available${uses.length ? `, on: ${uses.join(', ')}` : ''}. Sales so far stay in Analytics.`,
      confirmLabel: 'Archive',
      danger: true,
    });
    if (ok) await act(o.id, () => archiveOffer(o.id), 'Offer archived');
  };

  return (
    <SettingsSection title="Offers" description="What this business sells through buy links. Each link stays the same wherever you use it, even if you change how it’s paid.">
      {!loaded && !error && (
        <p className="flex items-center gap-2 py-4 text-small text-muted">
          <Spinner size={14} /> Loading…
        </p>
      )}
      {error && !loaded && <p className="py-4 text-small text-bad">{error}</p>}
      {loaded && !offers.length && <p className="py-4 text-small text-muted">No offers yet. Use Attach payment on an asset, the SEO checkout page or the listing’s buy link to make one.</p>}
      {offers.length > 0 && (
        <ul className="flex flex-col divide-y divide-line">
          {offers.map((o) => (
            <OfferRow
              key={o.id}
              offer={o}
              uses={offerUses(project, o.id)}
              connection={offerConnection(o, connections)}
              busy={busy === o.id}
              onCheck={() => void act(o.id, async () => (await checkOffer(o.id)).offer, o.status === 'checkout_unknown' ? undefined : 'Price refreshed from Whop')}
              onPause={(paused) => void act(o.id, () => updateOffer(o.id, { status: paused ? 'paused' : 'active' }), paused ? 'Paused' : 'Selling again')}
              onArchive={() => void archive(o)}
            />
          ))}
        </ul>
      )}
    </SettingsSection>
  );
}
