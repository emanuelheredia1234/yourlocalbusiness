// Attach payment › Stripe (P6): a buy link sold through the seller's own Stripe account. The seller sets the title,
// the price and what the buyer gets (nothing to download: they deliver it themselves; or one of their product files,
// downloaded from the thank-you page after paying). Nothing is sent to Stripe here: each checkout sends its price.
// The preview shows our fee for display only (feePreview mirrors the server's rule; the server decides).
// Without a Stripe account: where to set it up. While Stripe setup isn't finished: the offer is made, with a note.

import { useEffect, useState } from 'react';
import { CircleAlert, Plus, Upload } from 'lucide-react';
import { STRIPE_CURRENCIES, decimalToMinor, stripePriceProblem, type OffersError } from '@/lib/offers';
import { stripePreview, type ConnectState } from '@/lib/stripeConnect';
import { LEAD_FILE_ACCEPT, MAX_LEAD_FILE_BYTES, createLeadFile, listLeadFiles, refusedFileName, uploadLeadFileContent, type LeadFile } from '@/lib/leadFiles';
import { navigate } from '@/lib/router';
import { useUI } from '@/store/ui';
import { Callout, Field, Segmented, Spinner } from '@/components/ui/primitives';

/** Currencies offered (shared/stripe-currencies.json; the account's own default first when it's one of them). */
export { STRIPE_CURRENCIES };

export { stripePreview };

export interface StripeOfferInput {
  title: string;
  priceMinor: number;
  currency: string;
  delivery: { kind: 'none' } | { kind: 'file'; fileId: string };
}

const message = (e: unknown) => ((e as OffersError | Error)?.message ? (e as Error).message : 'Something went wrong. Try again.');

/** What's wrong with the price, in words ('' when it's fine), before anything is sent. */
export function priceProblem(text: string, currency: string): string {
  if (!text.trim()) return '';
  const minor = decimalToMinor(text, currency);
  if (minor == null) return currency.toUpperCase() === 'JPY' ? 'Use a whole number.' : 'Use a number like 49 or 49.50.';
  return stripePriceProblem(minor, currency);
}

/** The Stripe tab's body (render tests draw it directly). */
export function StripeOfferForm({
  projectId,
  connect,
  defaultTitle = '',
  busy,
  error,
  onCreate,
  initialFiles = null,
}: {
  projectId: string;
  connect: ConnectState | null;
  defaultTitle?: string;
  busy: boolean;
  error: string;
  onCreate: (input: StripeOfferInput) => void;
  /** tests: the product files, without asking the server */
  initialFiles?: LeadFile[] | null;
}) {
  const account = connect?.account ?? null;
  const [title, setTitle] = useState(defaultTitle);
  const [price, setPrice] = useState('');
  const [currency, setCurrency] = useState(account?.defaultCurrency && STRIPE_CURRENCIES.includes(account.defaultCurrency) ? account.defaultCurrency : 'usd');
  const [deliver, setDeliver] = useState<'none' | 'file'>('none');
  const [files, setFiles] = useState<LeadFile[] | null>(initialFiles);
  const [fileId, setFileId] = useState('');
  const [uploading, setUploading] = useState(false);
  const [fileError, setFileError] = useState('');

  useEffect(() => {
    if (deliver !== 'file' || files !== null) return;
    const ctl = new AbortController();
    listLeadFiles(projectId, ctl.signal, 'product')
      .then((l) => setFiles(l.filter((f) => f.purpose === 'product' && f.kind === 'file' && f.bytes > 0)))
      .catch((e: Error) => {
        if (e?.name === 'AbortError') return;
        setFiles([]);
        setFileError(message(e));
      });
    return () => ctl.abort();
  }, [deliver, files, projectId]);

  const upload = async (file: File) => {
    setFileError('');
    if (refusedFileName(file.name)) return setFileError('That kind of file can’t be a download.');
    if (file.size > MAX_LEAD_FILE_BYTES) return setFileError('That file is too big: a download can be up to 25 MB.');
    setUploading(true);
    try {
      const row = await createLeadFile({ projectId, title: title.trim() || file.name.slice(0, 120), kind: 'file', purpose: 'product' });
      const done = await uploadLeadFileContent(row.id, file, file.name);
      setFiles((l) => [done, ...(l ?? []).filter((f) => f.id !== done.id)]);
      setFileId(done.id);
    } catch (e) {
      setFileError(message(e));
    } finally {
      setUploading(false);
    }
  };

  if (!account) {
    return (
      <Callout
        tone="info"
        title="Set up Stripe to sell here"
        action={
          <button
            type="button"
            className="btn btn-secondary btn-xs"
            onClick={() => {
              useUI.getState().setSettingsTab('payments');
              void navigate('workspace-settings');
            }}
          >
            Go to Settings › Payments
          </button>
        }
      >
        Buyers pay you through your own Stripe account, and you see every payment in your Stripe Dashboard.
      </Callout>
    );
  }

  const currencies = [...new Set([...(account.defaultCurrency && STRIPE_CURRENCIES.includes(account.defaultCurrency) ? [account.defaultCurrency] : []), ...STRIPE_CURRENCIES])];
  const minor = decimalToMinor(price, currency);
  const problem = priceProblem(price, currency);
  const ready = !!title.trim() && minor != null && !problem && (deliver === 'none' || !!fileId);
  const preview = !problem ? stripePreview(minor, currency, connect?.fee ?? null, account.country) : '';

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready || minor == null) return;
        onCreate({ title: title.trim(), priceMinor: minor, currency, delivery: deliver === 'file' ? { kind: 'file', fileId } : { kind: 'none' } });
      }}
    >
      {account.status !== 'active' && <Callout tone="warn">Finish Stripe setup to start selling. You can make the buy link now: it sells once Stripe is ready.</Callout>}
      {account.environment === 'sandbox' && <p className="text-caption text-warn">Test mode: buyers can’t really pay, and its sales never count as revenue.</p>}
      <Field label="Title" htmlFor="attach-stripe-title" hint="What buyers see at checkout.">
        <input id="attach-stripe-title" className="input" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Field label="Price" htmlFor="attach-stripe-price" error={problem || undefined}>
          <input id="attach-stripe-price" className="input" inputMode="decimal" value={price} placeholder={currency.toUpperCase() === 'JPY' ? '5000' : '49.00'} onChange={(e) => setPrice(e.target.value)} />
        </Field>
        <Field label="Currency" htmlFor="attach-stripe-currency">
          <select id="attach-stripe-currency" className="select" value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {currencies.map((c) => (
              <option key={c} value={c}>
                {c.toUpperCase()}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="What the buyer gets">
        <Segmented<'none' | 'file'>
          size="sm"
          aria-label="What the buyer gets"
          value={deliver}
          onChange={setDeliver}
          options={[
            { id: 'none', label: 'Nothing to download' },
            { id: 'file', label: 'A file' },
          ]}
        />
      </Field>
      {deliver === 'none' && <p className="text-caption text-muted">You deliver it yourself (by email or in person). The thank-you page says you’ll be in touch.</p>}
      {deliver === 'file' && (
        <div className="flex flex-col gap-2">
          {files === null ? (
            <p className="flex items-center gap-2 text-small text-muted">
              <Spinner size={14} /> Loading your product files…
            </p>
          ) : files.length ? (
            <Field label="Product file" htmlFor="attach-stripe-file" hint="Buyers download it from the thank-you page after paying.">
              <select id="attach-stripe-file" className="select" value={fileId} onChange={(e) => setFileId(e.target.value)}>
                <option value="">Choose a file</option>
                {files.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.title || f.fileName}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <p className="text-small text-muted">No product files yet. Upload the file buyers get.</p>
          )}
          <div>
            <label className="btn btn-secondary btn-sm">
              {uploading ? <Spinner size={14} /> : <Upload aria-hidden="true" />}
              Upload a file
              <input
                type="file"
                className="sr-only"
                accept={LEAD_FILE_ACCEPT}
                disabled={uploading}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (f) void upload(f);
                }}
              />
            </label>
          </div>
          {fileError && (
            <p className="flex items-start gap-1.5 text-caption text-bad">
              <CircleAlert size={14} className="mt-px shrink-0" aria-hidden="true" />
              {fileError}
            </p>
          )}
        </div>
      )}
      {preview && <p className="text-caption text-ink-2">{preview}</p>}
      {error && <Callout tone="bad">{error}</Callout>}
      <div>
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy || uploading || !ready}>
          {busy ? <Spinner size={14} /> : <Plus aria-hidden="true" />}
          Create buy link
        </button>
      </div>
    </form>
  );
}
