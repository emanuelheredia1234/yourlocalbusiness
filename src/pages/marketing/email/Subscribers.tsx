import { useRef } from 'react';
import { Download, Trash2, Upload, Users } from 'lucide-react';
import type { Project } from '@/lib/types';
import { emailValid, fmtRelative, readFileAsText, slugify } from '@/lib/utils';
import { useStore } from '@/store/useStore';
import { toast } from '@/store/ui';
import { Empty, confirmAction } from '@/components/ui/primitives';
import { download } from '@/components/ui/download';
import { importSubscribers } from './shared';

const SOURCE: Record<string, string> = { optin: 'Signed up', import: 'Imported' };

/** Split one CSV line (quotes and doubled quotes supported). */
function cells(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',' || ch === ';' || ch === '\t') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

/** Name and email from a CSV export (any provider's): finds the email column, and a name column if there is one. */
export function parseSubscriberCsv(text: string): { name: string; email: string }[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const head = cells(lines[0]).map((h) => h.toLowerCase());
  const hasHeader = head.some((h) => /e-?mail/.test(h));
  const emailCol = hasHeader ? head.findIndex((h) => /e-?mail/.test(h)) : -1;
  const nameCol = hasHeader ? head.findIndex((h) => /^(first[ _]?name|name|full[ _]?name)$/.test(h)) : -1;
  const out: { name: string; email: string }[] = [];
  for (const line of hasHeader ? lines.slice(1) : lines) {
    const c = cells(line);
    const email = emailCol >= 0 ? c[emailCol] : c.find((x) => emailValid(x));
    if (!email || !emailValid(email)) continue;
    out.push({ name: nameCol >= 0 ? c[nameCol] ?? '' : '', email });
  }
  return out;
}

export function Subscribers({ project }: { project: Project }) {
  const updateMarketing = useStore((s) => s.updateMarketing);
  const subs = project.marketing.subscribers;
  const fileRef = useRef<HTMLInputElement>(null);
  const csv = () => ['name,email,source,joined', ...subs.map((s) => [s.name, s.email, s.source, new Date(s.joinedAt).toISOString()].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))].join('\n');
  const importFile = async (file: File) => {
    const rows = parseSubscriberCsv(await readFileAsText(file));
    if (!rows.length) {
      toast({ kind: 'error', title: 'No email addresses found', body: 'Use a CSV with an email column (exports from Mailchimp, Kit, MailerLite and others work).' });
      return;
    }
    const n = importSubscribers(rows);
    toast({ kind: 'success', title: n ? `Imported ${n} subscriber${n === 1 ? '' : 's'}` : 'Everyone in that file is already on your list', body: n < rows.length ? `${rows.length - n} already on the list were skipped.` : undefined });
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="rounded-md border border-line bg-surface-2/60 px-3 py-2 text-[13px] text-ink-2">
        Your email provider collects sign-ups from your opt-in page and tracks opens and clicks. This list is for the people you bring in: import a CSV export from your provider to keep a copy here.
      </p>
      <section className="panel overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
          <p className="text-[13px] font-semibold">
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
            <table className="w-full min-w-[520px] text-left text-[13px]">
              <thead className="border-b border-line text-xs text-muted">
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
                      <span className="block text-xs text-muted">{s.email}</span>
                    </td>
                    <td className="px-2 py-2.5 text-xs text-ink-2">{SOURCE[s.source] ?? s.source}</td>
                    <td className="px-2 py-2.5 text-xs text-muted">{fmtRelative(s.joinedAt)}</td>
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
            {subs.length > 500 && <p className="px-4 py-2 text-xs text-muted">Showing the first 500. Export the CSV for everyone.</p>}
          </div>
        )}
      </section>
    </div>
  );
}
