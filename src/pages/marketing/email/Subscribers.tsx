import { useRef } from 'react';
import { Download, Trash2, Upload, Users } from 'lucide-react';
import type { Project } from '@/lib/types';
import { fmtRelative, readFileAsText, slugify } from '@/lib/utils';
import { importSubscribers, parseSubscriberCsv, subscribersCsv } from '@/lib/emailFunnel';
import { useStore } from '@/store/useStore';
import { toast } from '@/store/ui';
import { Empty, confirmAction } from '@/components/ui/primitives';
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
    <div className="flex flex-col gap-4">
      <p className="rounded-md border border-line bg-surface-2/60 px-3 py-2 text-small text-ink-2">
        Your email provider collects sign-ups from your opt-in page and tracks opens and clicks. This list is for the people you bring in: import a CSV export from your provider to keep a copy here.
      </p>
      <section className="panel overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
          <p className="text-small font-semibold">
            {subs.length} subscriber{subs.length === 1 ? '' : 's'}
          </p>
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
            <button className="btn btn-secondary btn-sm" onClick={() => fileRef.current?.click()}>
              <Upload size={14} /> Import CSV
            </button>
            {subs.length > 0 && (
              <button className="btn btn-ghost btn-sm" onClick={() => download(`${slugify(project.brand.name)}-subscribers.csv`, csv())}>
                <Download size={14} /> Export CSV
              </button>
            )}
          </div>
        </div>
        {subs.length === 0 ? (
          <Empty className="m-4" icon={<Users size={20} />} title="No subscribers yet" body="Import a CSV from your email provider to see your list here." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-small">
              <thead className="border-b border-line text-caption text-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">Subscriber</th>
                  <th className="px-2 py-2 font-medium">Source</th>
                  <th className="px-2 py-2 font-medium">Added</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {subs.slice(0, 500).map((s) => (
                  <tr key={s.id}>
                    <td className="px-4 py-2.5">
                      <span className="block font-semibold">{s.name}</span>
                      <span className="block text-caption text-muted">{s.email}</span>
                    </td>
                    <td className="px-2 py-2.5 text-caption text-ink-2">{SOURCE[s.source] ?? s.source}</td>
                    <td className="px-2 py-2.5 text-caption text-muted">{fmtRelative(s.joinedAt)}</td>
                    <td className="px-4 py-2.5 text-right">
                      <button
                        className="btn btn-ghost btn-icon btn-xs text-muted hover:text-bad"
                        aria-label={`Remove ${s.name}`}
                        onClick={async () => {
                          if (await confirmAction({ title: `Remove ${s.name}?`, confirmLabel: 'Remove', danger: true })) updateMarketing({ subscribers: project.marketing.subscribers.filter((x) => x.id !== s.id) });
                        }}
                      >
                        <Trash2 size={13} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {subs.length > 500 && <p className="px-4 py-2 text-caption text-muted">Showing the first 500. Export the CSV for everyone.</p>}
          </div>
        )}
      </section>
    </div>
  );
}
