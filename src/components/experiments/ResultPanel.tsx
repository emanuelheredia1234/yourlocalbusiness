// An A/B test's results (P4b §A5): each version's chosen metric with its counts and the secondary numbers, the
// verdict banner in plain words, the notes, and when it was last updated. Unknown numbers show as "—", never 0. The
// verdict is the server's; nothing here works one out.

import type { Experiment } from '@/lib/types';
import { CHANGED_LABEL, METRIC_LABEL, lastUpdated, metricLine, resultNotes, secondaryNumbers, verdictCopy, versionName } from '@/lib/experiments/math';
import { Badge, Callout } from '../ui/primitives';

export function ResultPanel({ experiment: e, alsoChanged = false }: { experiment: Experiment; alsoChanged?: boolean }) {
  const v = verdictCopy(e);
  const notes = resultNotes(e, alsoChanged);
  const winner = e.result.verdict === 'winner' ? e.result.winner : undefined;
  const updated = lastUpdated(e.result.computedAt ?? e.lastReadAt);
  return (
    <div className="flex flex-col gap-3" data-testid="result-panel">
      <Callout tone={v.tone === 'good' ? 'good' : v.tone === 'warn' ? 'warn' : 'info'} title={v.title}>
        {v.body}
        {e.result.source === 'omnisend' && e.result.ours && <span className="block text-small text-muted">Our own math: {verdictCopy({ ...e, result: { ...e.result, ...e.result.ours, source: undefined } }).title}.</span>}
      </Callout>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {e.variants.map((x) => (
          <div key={x.key} className="rounded-md border border-line bg-surface p-3" data-testid={`result-${x.key}`}>
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-small font-medium text-ink">
                {versionName(x.key)}
                {x.label ? ` · ${x.label}` : ''}
              </p>
              {winner === x.key && <Badge tone="good">Winner</Badge>}
              {e.winner === x.key && e.result.pickedByYou && <Badge tone="primary">Your pick</Badge>}
            </div>
            <p className="mt-1 text-caption text-muted">{METRIC_LABEL[e.metric]}</p>
            <p className="num font-mono text-body text-ink">{metricLine(e, x.key)}</p>
            <dl className="mt-2 grid grid-cols-3 gap-x-2 gap-y-1 text-caption">
              {secondaryNumbers(e, x).map((n) => (
                <div key={n.label} className="min-w-0">
                  <dt className="truncate text-muted">{n.label}</dt>
                  <dd className="num font-mono text-ink-2">{n.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
      {notes.map((n) => (
        <p key={n} className="text-small text-muted">
          {n}
        </p>
      ))}
      <p className="text-caption text-muted">
        Testing: {CHANGED_LABEL[e.changed]}
        {updated ? ` · ${updated}` : ''}
        {e.delayed ? ' · Results are delayed' : ''}
      </p>
    </div>
  );
}
