// Report another seller's public listing (P7) from the in-app Marketplace: a reason and an optional note, sent to the
// app's owner, who reviews it. Only for listings that are public on the web (the ones the owner moderates), never your
// own, never in the claude.ai build.

import { useState } from 'react';
import { Field, Modal, Select, Spinner } from '@/components/ui/primitives';
import { REPORT_REASONS, reportListing, type ReportReason } from '@/lib/marketPublic';
import { toast } from '@/store/ui';

export function ReportListingDialog({ slug, title, onClose }: { slug: string; title: string; onClose: () => void }) {
  const [reason, setReason] = useState<ReportReason | ''>('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async () => {
    if (!reason) return setError('Choose a reason.');
    setBusy(true);
    setError(null);
    try {
      await reportListing(slug, reason, note);
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
