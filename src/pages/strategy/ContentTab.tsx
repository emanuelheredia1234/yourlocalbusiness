// Social content: the content pillars with post ideas (each opens Create post), what gets attention on
// each network, a campaign setup to use in Social › Campaign setup, and post ideas.
import { MessageSquareText, PenSquare, Undo2 } from 'lucide-react';
import type { PostType, Project } from '@/lib/types';
import type { StrategyState } from '@/lib/strategyTypes';
import { GOAL_LABEL, MIX_WORD } from '@/lib/strategy';
import { POST_TYPE_IDS } from '@/lib/strategyNormalize';
import { openPage } from '@/ai/assistant/nav';
import { useUI } from '@/store/ui';
import { GenerateButton } from '@/components/ai/AI';
import { Empty, InfoTip, Section } from '@/components/ui/primitives';
import { PlatformMark } from '@/components/posts/PlatformIcon';
import { BasisTip, Cite, SectionFooter, SourcesList, StaleNote, citedBy, netLabel } from './parts';
import { campaignFlow, undoCampaignFlow } from './apply';

/** Post types as Strategy names them. */
export const POST_TYPE_LABEL: Record<PostType, string> = { educational: 'How-to', tip: 'Tip', question: 'Question', sales: 'Sales', bts: 'Behind the scenes' };
const VIDEO_WORD = { none: 'none', some: 'some', most: 'most' } as const;

export function ContentTab({ project, s }: { project: Project; s: StrategyState }) {
  const c = s.content;
  if (!c) return <Empty icon={<MessageSquareText />} title="Not written yet" body="It’s step 3 of 6." />;
  const write = (topic: string) => useUI.getState().openComposer({ topic });
  const camp = c.campaign;
  return (
    <div>
      <StaleNote project={project} s={s} step="content" />

      {c.pillars.length > 0 && (
        <Section
          title={
            <span className="inline-flex items-center gap-1">
              Content pillars
              <InfoTip label="About the post ideas">Each idea opens Create post with it as the topic. A draft open there is replaced.</InfoTip>
            </span>
          }
          description="What to post about, again and again. Pick an idea to write it."
        >
          <ul className="divide-y divide-line border-y border-line">
            {c.pillars.map((p) => (
              <li key={p.name} className="py-4">
                <p className="text-ui text-ink">{p.name}</p>
                {p.why && <p className="mt-0.5 text-small text-muted">{p.why}</p>}
                {p.ideas.length > 0 && (
                  <div className="mt-2.5 flex flex-wrap gap-2">
                    {p.ideas.map((idea) => (
                      <button key={idea} type="button" className="chip h-auto min-h-7 whitespace-normal py-1 text-left" onClick={() => write(idea)} title="Write this post">
                        <PenSquare aria-hidden="true" />
                        <span>
                          {idea}
                          <span className="sr-only"> · Write this post</span>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {c.formats.length > 0 && (
        <Section
          title={
            <span className="inline-flex items-center gap-1">
              What gets attention on each network
              <BasisTip items={c.formats} />
            </span>
          }
        >
          <ul className="divide-y divide-line border-y border-line">
            {c.formats.map((f) => (
              <li key={`${f.platform}-${f.what}`} className="flex items-start gap-3 py-3">
                <PlatformMark platform={f.platform} size={24} />
                <div className="min-w-0 flex-1">
                  <p className="text-ui text-ink">
                    {netLabel(f.platform)}: {f.what}
                    <Cite item={f} all={s.sources} />
                  </p>
                  {f.why && <p className="mt-0.5 text-small text-muted">{f.why}</p>}
                </div>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section
        title={
          <span className="inline-flex items-center gap-1">
            Campaign
            <BasisTip items={[camp]} />
          </span>
        }
        description="Settings for Social › Campaign setup."
      >
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-body sm:grid-cols-[minmax(120px,auto)_1fr]">
          <dt className="text-small text-muted sm:text-body">Goal</dt>
          <dd className="-mt-2 text-ink sm:mt-0">{GOAL_LABEL[camp.goal]}</dd>
          <dt className="text-small text-muted sm:text-body">Networks</dt>
          <dd className="-mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-ink sm:mt-0">
            {camp.platforms.map((n) => (
              <span key={n} className="inline-flex items-center gap-1.5">
                <PlatformMark platform={n} size={20} /> {netLabel(n)}
              </span>
            ))}
          </dd>
          <dt className="text-small text-muted sm:text-body">Post mix</dt>
          <dd className="-mt-2 text-ink sm:mt-0">{POST_TYPE_IDS.map((t) => `${POST_TYPE_LABEL[t]}: ${MIX_WORD[camp.postMix[t]]}`).join(' · ')}</dd>
          <dt className="text-small text-muted sm:text-body">Videos</dt>
          <dd className="-mt-2 text-ink sm:mt-0">{VIDEO_WORD[camp.videoShare]}</dd>
        </dl>
        {camp.why && (
          <p className="mt-4 max-w-[72ch] text-small text-ink-2">
            {camp.why}
            <Cite item={camp} all={s.sources} />
          </p>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void campaignFlow(project.id)}>
            Use for my campaign
          </button>
          {s.applied.campaign && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => undoCampaignFlow(project.id)}>
              <Undo2 /> Undo
            </button>
          )}
          <button type="button" className="link text-small" onClick={() => void openPage('marketing-social', 'plan')}>
            Regenerate your 30-day plan to use it
          </button>
        </div>
      </Section>

      {c.ideas.length > 0 && (
        <Section title="Post ideas">
          <ul className="divide-y divide-line border-y border-line">
            {c.ideas.map((i) => (
              <li key={i.headline} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:gap-4">
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  {i.platform ? <PlatformMark platform={i.platform} size={24} /> : <span className="h-6 w-6 shrink-0" aria-hidden="true" />}
                  <div className="min-w-0 flex-1">
                    <p className="text-ui text-ink">{i.headline}</p>
                    <p className="mt-0.5 text-small text-muted">
                      {POST_TYPE_LABEL[i.postType]}
                      {i.platform ? ` · ${netLabel(i.platform)}` : ''}
                    </p>
                    {i.why && <p className="mt-1 text-small text-ink-2">{i.why}</p>}
                  </div>
                </div>
                <div className="shrink-0 pl-9 sm:pl-0 [&>.btn]:max-sm:-ml-3 sm:[&>.btn]:-mr-3">
                  <GenerateButton variant="ai-ghost" size="sm" onClick={() => write(i.headline)}>
                    Write this post
                  </GenerateButton>
                </div>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <SourcesList ns={citedBy([...c.formats, camp])} all={s.sources} />
      <SectionFooter project={project} s={s} step="content" />
    </div>
  );
}
