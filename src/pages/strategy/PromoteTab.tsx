// Where to promote: the angle to lead with, the channels in three groups (start here, next, later), each
// with how to start and the app's tool for it when there is one, where the link goes, and the page to build.
import type { Project } from '@/lib/types';
import type { StrategyChannel, StrategyState } from '@/lib/strategyTypes';
import { CHANNEL_LABEL } from '@/lib/strategy';
import { channelTarget, runTarget } from '@/lib/strategyActions';
import { Empty, Section } from '@/components/ui/primitives';
import { Megaphone } from 'lucide-react';
import { BasisTip, Cite, LinksCard, PageCard, SectionFooter, SourcesList, StaleNote, citedBy } from './parts';
import { ChannelTile } from './PlanTab';

const GROUPS: { priority: 1 | 2 | 3; title: string }[] = [
  { priority: 1, title: 'Start here' },
  { priority: 2, title: 'Next' },
  { priority: 3, title: 'Later' },
];

function ChannelCard({ c, s }: { c: StrategyChannel; s: StrategyState }) {
  const t = channelTarget(c, s);
  const inApp = !!t && 'target' in t;
  return (
    <li className="card flex min-w-0 flex-col gap-3 p-5">
      <div className="flex items-start gap-3">
        <ChannelTile platform={c.platform} type={c.channelType} />
        <div className="min-w-0 flex-1">
          <h3 className="flex items-center gap-1 text-h3 text-ink">
            <span className="min-w-0">{c.name}</span>
            <BasisTip items={[c]} />
          </h3>
          <p className="text-small text-muted">
            {CHANNEL_LABEL[c.channelType]} · {inApp ? 'In the app' : 'Outside the app'}
          </p>
        </div>
      </div>
      <p className="text-body text-ink-2">
        {c.why}
        <Cite item={c} all={s.sources} />
      </p>
      {c.how.length > 0 && (
        <div>
          <p className="text-small font-medium text-ink">How to start</p>
          <ul className="mt-1 flex list-disc flex-col gap-1 pl-5 text-small text-ink-2 marker:text-faint">
            {c.how.map((h) => (
              <li key={h}>{h}</li>
            ))}
          </ul>
        </div>
      )}
      {t && 'target' in t ? (
        <div className="mt-auto pt-1">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void runTarget(t.target)}>
            {t.label}
          </button>
        </div>
      ) : t ? (
        <p className="mt-auto text-small text-muted">{t.hint}</p>
      ) : null}
    </li>
  );
}

export function PromoteTab({ project, s }: { project: Project; s: StrategyState }) {
  const pr = s.promote;
  if (!pr) {
    return (
      <div>
        <Empty icon={<Megaphone />} title="Not written yet" body="It’s step 2 of 6." />
        <LinksCard project={project} s={s} />
        <PageCard project={project} s={s} className="mt-10" />
      </div>
    );
  }
  const pos = pr.positioning;
  return (
    <div>
      <StaleNote project={project} s={s} step="promote" />
      <Section
        title={
          <span className="inline-flex items-center gap-1">
            Your angle
            <BasisTip items={[pos]} />
          </span>
        }
      >
        <div className="well px-5 py-4">
          <p className="text-title text-ink">
            {pos.line}
            <Cite item={pos} all={s.sources} />
          </p>
          {pos.who && <p className="mt-2 text-small text-muted">Who: {pos.who}</p>}
          {pos.why && <p className="mt-1 text-small text-ink-2">{pos.why}</p>}
        </div>
      </Section>

      {GROUPS.map((g) => {
        const list = pr.channels.filter((c) => c.priority === g.priority);
        if (!list.length) return null;
        return (
          <Section key={g.priority} title={g.title}>
            <ul className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2" aria-label={g.title}>
              {list.map((c) => (
                <ChannelCard key={c.name} c={c} s={s} />
              ))}
            </ul>
          </Section>
        );
      })}

      <LinksCard project={project} s={s} />
      <PageCard project={project} s={s} className="mt-10" />
      <SourcesList ns={citedBy([pos, ...pr.channels, pr.page, ...Object.values(pr.links)])} all={s.sources} />
      <SectionFooter project={project} s={s} step="promote" />
    </div>
  );
}
