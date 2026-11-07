// Report another seller's public listing (P7) from the in-app Marketplace: a reason and an optional note, sent to the
// app's owner, who reviews it. Only for listings that are public on the web (the ones the owner moderates), never your
// own, never in the claude.ai build.

import { useState } from 'react';
import { Flag, Globe } from 'lucide-react';
import type { Listing } from '@/lib/types';
import { Field, Modal, MoreMenu, Select, Spinner } from '@/components/ui/primitives';
import { REPORT_REASONS, reportListing, type ReportReason } from '@/lib/marketPublic';
import { webUrl } from '@/lib/marketConfig';
import { toast } from '@/store/ui';

/**
 * A listing's "View on the web" (its public page, at this app's address) and, for another seller's listing, "Report
 * listing". Nothing in the claude.ai build, where the market is off, or for a listing that isn't on the web.
 */
export function ListingWebRow({ listing: l, mine, webOn, onReport }: { listing: Listing; mine: boolean; webOn: boolean; onReport: () => void }) {
  if (__ARTIFACT_BUILD__ || !webOn || !l.web) return null;
  return (
    <div className="flex items-center justify-between gap-2 border-t border-line pt-3">
      <a className="link inline-flex items-center gap-1.5 text-small" href={webUrl(l.web.slug)} target="_blank" rel="noopener">
        <Globe size={14} aria-hidden="true" /> View on the web
      </a>
      {!mine && l.seller.ownerId && <MoreMenu label="More for this listing" items={[{ label: 'Report listing', icon: <Flag />, onSelect: onReport }]} />}
    </div>
  );
}

export function ReportListingDialog({ slug, sellerId, title, onClose }: { slug: string; sellerId: string; title: string; onClose: () => void }) {
  const [reason, setReason] = useState<ReportReason | ''>('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async () => {
    if (!reason) return setError('Choose a reason.');
    setBusy(true);
    setError(null);
    try {
      await reportListing(slug, sellerId, reason, note);
      toast({ kind: 'success', title: 'Thanks. The owner will take a look.' });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title="Report listing"
      subtitle={title}
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || !reason} onClick={() => void send()}>
            {busy && <Spinner size={16} />} Send report
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="What’s wrong?" htmlFor="report-reason">
          <Select id="report-reason" value={reason} onChange={setReason} options={REPORT_REASONS} placeholder="Choose a reason" />
        </Field>
        <Field label="Anything else? (optional)" htmlFor="report-note" hint="Up to 500 characters. The seller never sees who reported it." error={error}>
          <textarea id="report-note" className="input min-h-[96px]" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
