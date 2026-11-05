// "Guide my other tabs with this strategy": five rows, each written only on a click after a preview
// (spec §3.5): Brain skills for social posts and the email funnel (bound to this project), a block in the
// SEO page's guidance, the campaign settings and where links go, with Undo or "changed in your Brain".
import type { ReactNode } from 'react';
import { TriangleAlert, Undo2 } from 'lucide-react';
import type { Project } from '@/lib/types';
import type { StrategyState } from '@/lib/strategyTypes';
import { fmtDate } from '@/lib/utils';
import { areaAt, skillState, type SkillArea } from '@/lib/strategyApply';
import { openPage } from '@/ai/assistant/nav';
import { useStore } from '@/store/useStore';
import { InfoTip, Section } from '@/components/ui/primitives';
import { campaignFlow, linksFlow, replaceSkillFlow, seoFlow, skillFlow, skillOnFlow, undoCampaignFlow, undoLinksFlow } from './apply';

function Row({ title, sub, status, children }: { title: string; sub: string; status?: ReactNode; children: ReactNode }) {
  return (
    <li className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
      <div className="min-w-0 flex-1">
        <p className="text-ui text-ink">{title}</p>
        <p className="mt-0.5 text-small text-muted">{sub}</p>
        {status && <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-ink-2">{status}</div>}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div>
    </li>
  );
}

const btn = 'btn btn-secondary btn-sm';

function SkillRow({ project, s, area, title, sub }: { project: Project; s: StrategyState; area: SkillArea; title: string; sub: string }) {
  const skills = useStore((st) => st.skills);
  const st = skillState(project.id, area, s, skills);
  const has = areaAt(s, area) > 0;
  const pid = project.id;
  const copy = st.copy ? (
    <span className="inline-flex items-center gap-1 text-warn">
      <TriangleAlert size={12} aria-hidden="true" /> A copy is also in your Brain.
    </span>
  ) : null;
  let status: ReactNode = null;
  let buttons: ReactNode = null;
  switch (st.state) {
    case 'none':
      buttons = (
        <>
          <button type="button" className="btn btn-ghost btn-sm" disabled={!has} onClick={() => void skillFlow(pid, area, 'preview')}>
            Preview
          </button>
          <button type="button" className={btn} disabled={!has} onClick={() => void skillFlow(pid, area, 'add')}>
            Add
          </button>
        </>
      );
      break;
    case 'on':
      status = <span className="num">On · used {st.skill?.stats.applied ?? 0}×</span>;
      buttons = (
        <>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void skillFlow(pid, area, 'preview')}>
            Preview
          </button>
          {st.update && (
            <button type="button" className={btn} onClick={() => void skillFlow(pid, area, 'update')}>
              Update from the new strategy
            </button>
          )}
          <button type="button" className={btn} onClick={() => skillOnFlow(pid, area, false)}>
            Turn off
          </button>
        </>
      );
      break;
    case 'off':
      status = 'Off in your Brain';
      buttons = (
        <button type="button" className={btn} onClick={() => skillOnFlow(pid, area, true)}>
          Turn on
        </button>
      );
      break;
    case 'edited':
      status = 'Changed in your Brain';
      buttons = (
        <button type="button" className={btn} onClick={() => void replaceSkillFlow(pid, area)}>
          Replace…
        </button>
      );
      break;
    case 'missing':
      status = 'Removed from your Brain';
      buttons = (
        <button type="button" className={btn} disabled={!has} onClick={() => void skillFlow(pid, area, 'add')}>
          Add again
        </button>
      );
      break;
  }
  return (
    <Row
      title={title}
      sub={sub}
      status={
        status || copy ? (
          <>
            {status}
            {copy}
          </>
        ) : undefined
      }
    >
      {buttons}
    </Row>
  );
}

export function ApplyPanel({ project, s }: { project: Project; s: StrategyState }) {
  const appBrain = useStore((st) => st.settings.ai.useBrain);
  const pid = project.id;
  const a = s.applied;
  const added = (at?: number) => (at ? `Added ${fmtDate(at)}` : 'Not added');
  return (
    <Section
      title={
        <span className="inline-flex items-center gap-1">
          Guide my other tabs with this strategy
          <InfoTip label="How this works">These only shape what your AI writes, not the built-in engine. You see exactly what’s sent first, and you can change or remove it any time.</InfoTip>
        </span>
      }
      description="Your AI in these tabs follows the strategy’s direction."
    >
      <ul className="divide-y divide-line border-y border-line">
        <SkillRow project={project} s={s} area="social" title="Social posts and campaigns" sub="A Brain skill for this project’s social posts: who to talk to, content pillars, what works on each network." />
        <SkillRow project={project} s={s} area="email" title="Email" sub="A Brain skill for this project’s lead magnet and welcome emails." />
        <Row title="SEO page guidance" sub="Adds a short block to the SEO page’s “Guide the AI” box." status={added(a.seo?.at)}>
          <button type="button" className={btn} disabled={!s.assets} onClick={() => void seoFlow(pid)}>
            {a.seo ? 'Add again…' : 'Preview and add'}
          </button>
        </Row>
        <Row title="Campaign settings" sub="Sets the goal, networks, post mix and videos in Social › Campaign setup. Your days, times and watermark stay." status={added(a.campaign?.at)}>
          <button type="button" className={btn} disabled={!s.content} onClick={() => void campaignFlow(pid)}>
            Preview and use
          </button>
          {a.campaign && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => undoCampaignFlow(pid)}>
              <Undo2 /> Undo
            </button>
          )}
        </Row>
        <Row title="Where links go" sub="Sets where the page link goes on each network. Each post can still choose its own." status={added(a.links?.at)}>
          <button type="button" className={btn} disabled={!s.promote} onClick={() => void linksFlow(pid)}>
            Preview and use
          </button>
          {a.links && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => undoLinksFlow(pid)}>
              <Undo2 /> Undo
            </button>
          )}
        </Row>
      </ul>
      {!appBrain && (
        <p className="mt-3 text-small text-muted">
          The Brain is off for the whole app, so the skills aren’t used.{' '}
          <button type="button" className="link" onClick={() => void openPage('brain', 'skills')}>
            Turn it on in the Brain.
          </button>
        </p>
      )}
    </Section>
  );
}
