// Settings › Payments › Product files (P6): the files buyers download after paying for a Stripe offer (lead_files
// with purpose 'product'). Never published at /m/: a buyer gets one only from the thank-you page or a link the
// seller sends. Name, size, how many offers deliver it, and Delete (refused while an offer delivers it: 409 IN_USE).
// Files are uploaded from Attach payment › Stripe › A file.

import { useCallback, useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { fmtBytes } from '@/lib/utils';
import { deleteLeadFile, listLeadFiles, type LeadFile } from '@/lib/leadFiles';
import { listAllOffers, type Offer } from '@/lib/offers';
import { toast } from '@/store/ui';
import { SettingsSection, Spinner, confirmAction } from '@/components/ui/primitives';

/** How many offers deliver each file (archived ones never sell, so they don't count). */
export function fileUses(offers: Pick<Offer, 'provider' | 'status' | 'delivery'>[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const o of offers) if (o.provider === 'stripe' && o.status !== 'archived' && o.delivery?.kind === 'file' && o.delivery.fileId) out[o.delivery.fileId] = (out[o.delivery.fileId] ?? 0) + 1;
  return out;
}

/** The list as drawn (render tests use this directly). */
export function ProductFilesView({ files, uses, error, busy, onDelete }: { files: LeadFile[] | null; uses: Record<string, number>; error: string; busy: string; onDelete: (f: LeadFile) => void }) {
  return (
    <SettingsSection title="Product files" description="What buyers download after paying through your Stripe buy links. Upload one from Attach payment › Stripe › A file.">
      <div className="pb-4 pt-1">
        {files === null && !error && (
          <p className="flex items-center gap-2 text-small text-muted">
            <Spinner size={14} /> Loading…
          </p>
        )}
        {error && <p className="text-small text-bad">{error}</p>}
        {files && !files.length && <p className="text-small text-muted">No product files yet.</p>}
        {files && files.length > 0 && (
          <ul className="flex flex-col divide-y divide-line">
            {files.map((f) => {
              const n = uses[f.id] ?? 0;
              return (
                <li key={f.id} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
                  <span className="min-w-0 truncate text-ui text-ink">{f.title || f.fileName || 'Untitled file'}</span>
                  <span className="text-caption text-muted">
                    {[f.fileName && f.fileName !== f.title ? f.fileName : '', f.bytes ? fmtBytes(f.bytes) : 'No file uploaded', n ? `used by ${n} offer${n === 1 ? '' : 's'}` : 'not used by an offer'].filter(Boolean).join(' · ')}
                  </span>
                  <button type="button" className="btn btn-ghost btn-xs ml-auto text-bad" disabled={busy === f.id} aria-label={`Delete ${f.title || f.fileName}`} onClick={() => onDelete(f)}>
                    {busy === f.id ? <Spinner size={12} /> : <Trash2 aria-hidden="true" />}
                    Delete
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </SettingsSection>
  );
}

export function ProductFilesCard() {
  const [files, setFiles] = useState<LeadFile[] | null>(null);
  const [uses, setUses] = useState<Record<string, number>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const [list, offers] = await Promise.all([listLeadFiles(undefined, signal, 'product'), listAllOffers(signal).catch(() => [] as Offer[])]);
      setFiles(list.filter((f) => f.purpose === 'product'));
      setUses(fileUses(offers));
      setError('');
    } catch (e) {
      if ((e as Error)?.name !== 'AbortError') setError((e as Error)?.message || 'Couldn’t load your product files.');
    }
  }, []);
  useEffect(() => {
    if (__ARTIFACT_BUILD__) return;
    const ctl = new AbortController();
    void load(ctl.signal);
    return () => ctl.abort();
  }, [load]);
  if (__ARTIFACT_BUILD__) return null;

  const onDelete = async (f: LeadFile) => {
    const ok = await confirmAction({ title: `Delete “${f.title || f.fileName}”?`, body: 'Buyers who paid for it can’t download it any more. This can’t be undone.', confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    setBusy(f.id);
    try {
      await deleteLeadFile(f.id);
      setFiles((l) => (l ?? []).filter((x) => x.id !== f.id));
      toast({ kind: 'success', title: 'File deleted' });
    } catch (e) {
      toast({ kind: 'error', title: (e as Error)?.message || 'That didn’t work. Try again.' });
    } finally {
      setBusy('');
    }
  };
  return <ProductFilesView files={files} uses={uses} error={error} busy={busy} onDelete={(f) => void onDelete(f)} />;
}
