// Where to promote: the angle to lead with, the channels in three groups (start here, next, later), each
// with how to start and the app's tool for it when there is one, where the link goes, and the page to build.
import type { Project } from '@/lib/types';
import type { StrategyChannel, StrategyState } from '@/lib/strategyTypes';
import { CHANNEL_LABEL } from '@/lib/strategy';
import { channelTarget, runTarget } from '@/lib/strategyActions';
import { PLATFORMS } from '@/ai/knowledge';
import { PlatformGlyph } from '@/components/posts/PlatformIcon';
import { Backing, LinksCard, PageCard, SectionFooter, SourcesList, StaleBanners, citedBy } from './parts';

const GROUPS: { priority: 1 | 2 | 3; title: string }[] = [
  { priority: 1, title: 'Start here' },
  { priority: 2, title: 'Next' },
  { priority: 3, title: 'Later' },
];

function ChannelCard({ c, s }: { c: StrategyChannel; s: StrategyState }) {
  const t = channelTarget(c, s);
  const inApp = !!t && 'target' in t;
  return (
    <li className="flex flex-col gap-2 rounded-md border border-line bg-surface p-3">
      <div className="flex flex-wrap items-center gap-2">
        {c.platform && (
          <span className="flex h-6 w-6 items-center justify-center rounded text-white" style={{ background: PLATFORMS[c.platform].color }} aria-hidden="true">
            <PlatformGlyph platform={c.platform} size={12} />
          </span>
        )}
        <h4 className="text-[14px] font-semibold text-ink">{c.name}</h4>
        <span className="badge bg-surface-2 text-ink-2">{CHANNEL_LABEL[c.channelType]}</span>
        <span className="badge bg-surface-2 text-muted">{inApp ? 'In the app' : 'Outside the app'}</span>
      </div>
      <p className="text-[13px] text-ink-2">{c.why}</p>
      <Backing item={c} all={s.sources} />
      {c.how.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-muted">How to start</p>
          <ul className="mt-0.5 flex list-disc flex-col gap-0.5 pl-5 text-[13px] text-ink-2">
            {c.how.map((h) => (
              <li key={h}>{h}</li>
            ))}
          </ul>
        </div>
      )}
      {t && 'target' in t ? (
        <div>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void runTarget(t.target)}>
            {t.label}
          </button>
        </div>
      ) : t ? (
        <p className="text-xs text-muted">{t.hint}</p>
      ) : null}
    </li>
  );
}

export function PromoteTab({ project, s }: { project: Project; s: StrategyState }) {
  const pr = s.promote;
  if (!pr) {
    return (
      <div className="flex flex-col gap-4">
        <p className="rounded-md bg-surface-2 px-3 py-6 text-center text-[13px] text-muted">Not written yet. It’s step 2 of 6.</p>
        <LinksCard project={project} s={s} />
        <PageCard project={project} s={s} />
      </div>
    );
  }
  const pos = pr.positioning;
  return (
    <div className="flex flex-col gap-5">
      <StaleBanners project={project} s={s} step="promote" />
      <section className="panel flex flex-col gap-2 p-4 sm:p-5" aria-label="Your angle">
        <p className="eyebrow">Your angle</p>
        <p className="font-display text-[17px] font-semibold text-ink">{pos.line}</p>
        {pos.who && <p className="text-[13px] text-ink-2">Who: {pos.who}</p>}
        {pos.why && <p className="text-[13px] text-ink-2">{pos.why}</p>}
        <Backing item={pos} all={s.sources} />
      </section>

      {GROUPS.map((g) => {
        const list = pr.channels.filter((c) => c.priority === g.priority);
        if (!list.length) return null;
        return (
          <section key={g.priority} aria-label={g.title}>
            <h2 className="section-title mb-2">{g.title}</h2>
            <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {list.map((c) => (
                <ChannelCard key={c.name} c={c} s={s} />
              ))}
            </ul>
          </section>
        );
      })}

      <LinksCard project={project} s={s} />
      <PageCard project={project} s={s} />
      <SourcesList ns={citedBy([pos, ...pr.channels, pr.page, ...Object.values(pr.links)])} all={s.sources} title="Sources this section cites" />
      <SectionFooter project={project} s={s} step="promote" />
    </div>
  );
}
