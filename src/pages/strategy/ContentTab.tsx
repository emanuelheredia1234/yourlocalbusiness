// Social content: the content pillars with post ideas (each opens Create individual post), what gets
// attention on each network, a campaign setup to use in Social → Campaign setup, and post ideas.
import { PenSquare, Undo2 } from 'lucide-react';
import type { PostType, Project } from '@/lib/types';
import type { StrategyState } from '@/lib/strategyTypes';
import { GOAL_LABEL, MIX_WORD } from '@/lib/strategy';
import { POST_TYPE_IDS } from '@/lib/strategyNormalize';
import { PLATFORMS } from '@/ai/knowledge';
import { openPage } from '@/ai/assistant/nav';
import { useUI } from '@/store/ui';
import { PlatformGlyph } from '@/components/posts/PlatformIcon';
import { Backing, SectionFooter, SourcesList, StaleBanners, citedBy, netLabel } from './parts';
import { campaignFlow, undoCampaignFlow } from './apply';

/** Post types as Strategy names them. */
export const POST_TYPE_LABEL: Record<PostType, string> = { educational: 'How-to', tip: 'Tip', question: 'Question', sales: 'Sales', bts: 'Behind the scenes' };
const VIDEO_WORD = { none: 'none', some: 'some', most: 'most' } as const;

function Glyph({ net }: { net: keyof typeof PLATFORMS }) {
  return (
    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-white" style={{ background: PLATFORMS[net].color }} aria-hidden="true">
      <PlatformGlyph platform={net} size={12} />
    </span>
  );
}

export function ContentTab({ project, s }: { project: Project; s: StrategyState }) {
  const c = s.content;
  if (!c) return <p className="rounded-md bg-surface-2 px-3 py-6 text-center text-[13px] text-muted">Not written yet. It’s step 3 of 6.</p>;
  const write = (topic: string) => useUI.getState().openComposer({ topic });
  const camp = c.campaign;
  return (
    <div className="flex flex-col gap-5">
      <StaleBanners project={project} s={s} step="content" />

      {c.pillars.length > 0 && (
        <section className="panel flex flex-col gap-3 p-4 sm:p-5" aria-label="Content pillars">
          <h2 className="section-title">Content pillars</h2>
          <ul className="flex flex-col gap-3">
            {c.pillars.map((p) => (
              <li key={p.name}>
                <p className="text-[13.5px] font-semibold text-ink">{p.name}</p>
                {p.why && <p className="text-[13px] text-ink-2">{p.why}</p>}
                {p.ideas.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {p.ideas.map((idea) => (
                      <button key={idea} type="button" className="chip h-auto min-h-7 whitespace-normal py-1 text-left" onClick={() => write(idea)} title="Write this post">
                        <PenSquare size={12} className="shrink-0" aria-hidden="true" />
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
          <p className="text-xs text-muted">Each idea is a Write this post button: it opens Create individual post with this topic. A draft open there is replaced.</p>
        </section>
      )}

      {c.formats.length > 0 && (
        <section className="panel flex flex-col gap-2 p-4 sm:p-5" aria-label="What gets attention on each network">
          <h2 className="section-title">What gets attention on each network</h2>
          <ul className="flex flex-col divide-y divide-line">
            {c.formats.map((f) => (
              <li key={`${f.platform}-${f.what}`} className="flex items-start gap-3 py-2.5">
                <Glyph net={f.platform} />
                <div className="min-w-0 flex-1">
                  <p className="text-[13.5px] font-semibold text-ink">
                    {netLabel(f.platform)}: {f.what}
                  </p>
                  {f.why && <p className="text-[13px] text-ink-2">{f.why}</p>}
                  <Backing item={f} all={s.sources} className="mt-1" />
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="panel flex flex-col gap-2.5 p-4 sm:p-5" aria-label="Campaign">
        <h2 className="section-title">Campaign</h2>
        <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 text-[13px] sm:grid-cols-[auto_1fr]">
          <dt className="font-semibold text-ink-2">Goal</dt>
          <dd className="text-ink">{GOAL_LABEL[camp.goal]}</dd>
          <dt className="font-semibold text-ink-2">Networks</dt>
          <dd className="flex flex-wrap items-center gap-1.5 text-ink">
            {camp.platforms.map((n) => (
              <span key={n} className="inline-flex items-center gap-1">
                <Glyph net={n} /> {netLabel(n)}
              </span>
            ))}
          </dd>
          <dt className="font-semibold text-ink-2">Post mix</dt>
          <dd className="text-ink">{POST_TYPE_IDS.map((t) => `${POST_TYPE_LABEL[t]}: ${MIX_WORD[camp.postMix[t]]}`).join(' · ')}</dd>
          <dt className="font-semibold text-ink-2">Videos</dt>
          <dd className="text-ink">{VIDEO_WORD[camp.videoShare]}</dd>
        </dl>
        {camp.why && <p className="text-[13px] text-ink-2">{camp.why}</p>}
        <Backing item={camp} all={s.sources} />
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void campaignFlow(project.id)}>
            Use for my campaign
          </button>
          {s.applied.campaign && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => undoCampaignFlow(project.id)}>
              <Undo2 size={14} /> Undo
            </button>
          )}
          <button type="button" className="link text-[13px]" onClick={() => void openPage('marketing-social', 'plan')}>
            Regenerate your 30-day plan to use it
          </button>
        </div>
      </section>

      {c.ideas.length > 0 && (
        <section className="panel flex flex-col gap-2 p-4 sm:p-5" aria-label="Post ideas">
          <h2 className="section-title">Post ideas</h2>
          <ul className="flex flex-col divide-y divide-line">
            {c.ideas.map((i) => (
              <li key={i.headline} className="flex flex-wrap items-start gap-3 py-2.5">
                {i.platform && <Glyph net={i.platform} />}
                <div className="min-w-0 flex-1 basis-56">
                  <p className="text-[13.5px] font-semibold text-ink">{i.headline}</p>
                  <p className="text-xs text-muted">
                    {POST_TYPE_LABEL[i.postType]}
                    {i.platform ? ` · ${netLabel(i.platform)}` : ''}
                  </p>
                  {i.why && <p className="mt-0.5 text-[13px] text-ink-2">{i.why}</p>}
                </div>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => write(i.headline)}>
                  <PenSquare size={13} /> Write this post
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <SourcesList ns={citedBy([...c.formats, camp])} all={s.sources} title="Sources this section cites" />
      <SectionFooter project={project} s={s} step="content" />
    </div>
  );
}
