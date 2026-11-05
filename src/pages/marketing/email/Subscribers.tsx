import { useRef } from 'react';
import { Download, Trash2, Upload, Users } from 'lucide-react';
import type { Project } from '@/lib/types';
import { fmtDateTime, fmtRelative, readFileAsText, slugify } from '@/lib/utils';
import { importSubscribers, parseSubscriberCsv, subscribersCsv } from '@/lib/emailFunnel';
import { useStore } from '@/store/useStore';
import { toast } from '@/store/ui';
import { Empty, InfoTip, Tooltip, confirmAction } from '@/components/ui/primitives';
import { download } from '@/components/ui/download';

const SOURCE: Record<string, string> = { optin: 'Signed up', import: 'Imported', lead: 'From your page' };

export function Subscribers({ project }: { project: Project }) {
  const updateMarketing = useStore((s) => s.updateMarketing);
  const subs = project.marketing.subscribers;
  const fileRef = useRef<HTMLInputElement>(null);
  const csv = () => subscribersCsv(subs);
  const importFile = async (file: File) => {
    const rows = parseSubscriberCsv(await readFileAsText(file));
    if (!rows.length) {
      toast({ kind: 'error', title: 'No email addresses found', body: 'Use a CSV with an email column (exports from Mailchimp, Kit, MailerLite and others work).' });
      return;
    }
    const n = importSubscribers(rows, project.id);
    toast({ kind: 'success', title: n ? `Imported ${n} subscriber${n === 1 ? '' : 's'}` : 'Everyone in that file is already on your list', body: n < rows.length ? `${rows.length - n} already on the list were skipped.` : undefined });
  };

  return (
    <section aria-label="Subscribers">
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex items-center gap-1">
          <h2 className="text-h3 text-ink">
            {subs.length} subscriber{subs.length === 1 ? '' : 's'}
          </h2>
          <InfoTip label="About this list">Your email provider collects sign-ups from your opt-in page and tracks opens and clicks. This list is for the people you bring in: import a CSV export from your provider to keep a copy here.</InfoTip>
        </div>
        <div className="ml-auto flex flex-wrap gap-1.5">
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv,text/plain"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void importFile(f);
              e.target.value = '';
            }}
          />
          {subs.length > 0 && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => download(`${slugify(project.brand.name)}-subscribers.csv`, csv())}>
              <Download /> Export CSV
            </button>
          )}
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => fileRef.current?.click()}>
            <Upload /> Import CSV
          </button>
        </div>
      </div>
      {subs.length === 0 ? (
        <div className="card">
          <Empty icon={<Users />} title="No subscribers yet" body="Import a CSV from your email provider to see your list here." />
        </div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[520px] text-left text-small">
            <thead className="border-b border-line bg-surface-2 text-caption text-muted">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">
                  Subscriber
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Source
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Added
                </th>
                <th scope="col" className="w-12 px-4 py-2">
                  <span className="sr-only">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {subs.slice(0, 500).map((s) => (
                <tr key={s.id} className="transition-colors duration-120 hover:bg-surface-2">
                  <td className="px-4 py-2.5">
                    <span className="block text-ui text-ink">{s.name}</span>
                    <span className="block text-small text-muted">{s.email}</span>
                  </td>
                  <td className="px-3 py-2.5 text-ink-2">{SOURCE[s.source] ?? s.source}</td>
                  <td className="px-3 py-2.5">
                    <time className="num font-mono text-caption text-muted" dateTime={Number.isFinite(s.joinedAt) ? new Date(s.joinedAt).toISOString() : undefined} title={fmtDateTime(s.joinedAt)}>
                      {fmtRelative(s.joinedAt)}
                    </time>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <Tooltip content="Remove">
                      <button
                        type="button"
                        className="btn btn-danger-ghost btn-icon btn-xs"
                        aria-label={`Remove ${s.name}`}
                        onClick={async () => {
                          if (await confirmAction({ title: `Remove ${s.name}?`, confirmLabel: 'Remove', danger: true })) updateMarketing({ subscribers: project.marketing.subscribers.filter((x) => x.id !== s.id) });
                        }}
                      >
                        <Trash2 />
                      </button>
                    </Tooltip>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {subs.length > 500 && <p className="border-t border-line px-4 py-2 text-caption text-muted">Showing the first 500. Export the CSV for everyone.</p>}
        </div>
      )}
    </section>
  );
}
