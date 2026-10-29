import { useState } from 'react';
import { Download, Trash2, UserPlus, Users } from 'lucide-react';
import type { Project } from '@/lib/types';
import { cn, emailValid, fmtPct, fmtRelative, slugify } from '@/lib/utils';
import { useStore } from '@/store/useStore';
import { Empty, confirmAction } from '@/components/ui/primitives';
import { download } from '@/components/ui/download';
import { addSubscriber } from './shared';

const SOURCE: Record<string, { label: string; cls: string }> = {
  test: { label: 'Test', cls: 'bg-surface-2 text-ink-2' },
  optin: { label: 'Opt-in', cls: 'bg-good-soft text-good' },
  sample: { label: 'Sample', cls: 'bg-warn-soft text-warn' },
};

export function Subscribers({ project }: { project: Project }) {
  const updateMarketing = useStore((s) => s.updateMarketing);
  const subs = project.marketing.subscribers;
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [filter, setFilter] = useState<'all' | 'test' | 'optin' | 'sample'>('all');
  const delivered = subs.reduce((n, s) => n + s.step, 0);
  const opens = subs.reduce((n, s) => n + s.opened.length, 0);
  const clicks = subs.reduce((n, s) => n + s.clicked.length, 0);
  const converted = subs.filter((s) => s.converted).length;
  const shown = filter === 'all' ? subs : subs.filter((s) => s.source === filter);

  const csv = () =>
    ['name,email,source,joined,emails_received,opened,clicked,converted', ...subs.map((s) => [s.name, s.email, s.source, new Date(s.joinedAt).toISOString(), s.step, s.opened.length, s.clicked.length, s.converted ? 'yes' : 'no'].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))].join('\n');

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Subscribers" value={String(subs.length)} />
        <Tile label="Open rate" value={delivered ? fmtPct(opens / delivered) : '—'} />
        <Tile label="Click rate" value={delivered ? fmtPct(clicks / delivered) : '—'} />
        <Tile label="Converted" value={subs.length ? `${converted} (${fmtPct(converted / subs.length)})` : '—'} />
      </div>

      <section className="panel overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
          <div className="flex flex-wrap gap-1">
            {(['all', 'optin', 'test', 'sample'] as const).map((f) => (
              <button key={f} className={cn('chip', filter === f && 'chip-active')} onClick={() => setFilter(f)}>
                {f === 'all' ? `All (${subs.length})` : `${SOURCE[f].label} (${subs.filter((s) => s.source === f).length})`}
              </button>
            ))}
          </div>
          <form
            className="ml-auto flex flex-wrap gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (!emailValid(email)) return;
              addSubscriber(name, email, 'test');
              setName('');
              setEmail('');
            }}
          >
            <input className="input input-sm w-[120px]" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Test subscriber name" />
            <input className="input input-sm w-[180px]" type="email" placeholder="email@example.com" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Test subscriber email" />
            <button className="btn btn-secondary btn-sm" disabled={!emailValid(email)}>
              <UserPlus size={14} /> Add test
            </button>
          </form>
          {subs.length > 0 && (
            <button className="btn btn-ghost btn-sm" onClick={() => download(`${slugify(project.brand.name)}-subscribers.csv`, csv())}>
              <Download size={14} /> CSV
            </button>
          )}
        </div>
        {shown.length === 0 ? (
          <Empty className="m-4" icon={<Users size={20} />} title="No subscribers here yet" body="Sign up through the opt-in preview or add a test subscriber above." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-[13px]">
              <thead className="border-b border-line text-xs text-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">Subscriber</th>
                  <th className="px-2 py-2 font-medium">Source</th>
                  <th className="px-2 py-2 font-medium">Joined</th>
                  <th className="px-2 py-2 font-medium">Sequence</th>
                  <th className="px-2 py-2 text-right font-medium">Opens</th>
                  <th className="px-2 py-2 text-right font-medium">Clicks</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {shown.slice(0, 200).map((s) => (
                  <tr key={s.id}>
                    <td className="px-4 py-2.5">
                      <span className="block font-semibold">
                        {s.name}
                        {s.converted && <span className="badge ml-1.5 bg-accent/25 text-ink">Customer</span>}
                      </span>
                      <span className="block text-xs text-muted">{s.email}</span>
                    </td>
                    <td className="px-2 py-2.5">
                      <span className={cn('badge', SOURCE[s.source].cls)}>{SOURCE[s.source].label}</span>
                    </td>
                    <td className="px-2 py-2.5 text-xs text-muted">{fmtRelative(s.joinedAt)}</td>
                    <td className="px-2 py-2.5">
                      <span className="flex items-center gap-2">
                        <span className="flex gap-0.5" aria-label={`${s.step} of 5 emails received`}>
                          {[1, 2, 3, 4, 5].map((n) => (
                            <span key={n} className={cn('h-1.5 w-4 rounded-full', n <= s.step ? 'bg-primary' : 'bg-surface-3')} />
                          ))}
                        </span>
                        <span className="num text-xs text-muted">{s.step}/5</span>
                      </span>
                    </td>
                    <td className="num px-2 py-2.5 text-right">{s.opened.length}</td>
                    <td className="num px-2 py-2.5 text-right">{s.clicked.length}</td>
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
          </div>
        )}
      </section>
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="panel px-4 py-3">
      <p className="text-xs font-medium text-muted">{label}</p>
      <p className="num text-[20px] font-bold">{value}</p>
    </div>
  );
}
