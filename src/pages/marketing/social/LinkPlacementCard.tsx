// "Where the link goes": per network, new posts put the link in the post, in the first comment (a reply on X)
// or say it's in the bio. The suggestions are the built-in defaults; the Strategy tab's "Use these link
// settings" writes the same field. Posts already made keep their own choice.
import { useId } from 'react';
import { Link2 } from 'lucide-react';
import type { LinkPlacement, PostPlatform, Project } from '@/lib/types';
import { POST_PLATFORMS } from '@/ai/knowledge';
import { networkLabel } from '@/ai/manusPost';
import { DEFAULT_LINK_PLACEMENT, LINK_FACTS, LINK_PLACEMENTS, LINK_PLACEMENT_LABEL, linkText, pageLink, placementFor } from '@/lib/pageLink';
import { navigate } from '@/lib/router';
import { getActiveProject, useStore } from '@/store/useStore';
import { CopyButton } from '@/components/ui/primitives';
import { PlatformChip } from '@/components/posts/PlatformIcon';

/** An option's words: X's first comment is a reply, and the built-in default is marked as the suggestion. */
const optionLabel = (id: LinkPlacement, p: PostPlatform) => `${id === 'comment' && p === 'x' ? 'First reply' : LINK_PLACEMENT_LABEL[id]}${id === DEFAULT_LINK_PLACEMENT[p] ? ' (suggested)' : ''}`;

export function LinkPlacementCard({ project }: { project: Project }) {
  const titleId = useId();
  const updateMarketing = useStore((s) => s.updateMarketing);
  const link = pageLink(project);
  const inCampaign = project.marketing.campaign.platforms;
  // the campaign's networks first, then the others
  const rows = [...POST_PLATFORMS.filter((p) => inCampaign.includes(p)), ...POST_PLATFORMS.filter((p) => !inCampaign.includes(p))];
  const changed = POST_PLATFORMS.some((p) => placementFor(project, p) !== DEFAULT_LINK_PLACEMENT[p]);
  // the latest saved settings, so two quick changes never undo each other
  const setPlacement = (p: PostPlatform, v: LinkPlacement) => updateMarketing({ linkPlacement: { ...(getActiveProject()?.marketing.linkPlacement ?? {}), [p]: v } });
  return (
    <section className="panel p-4 sm:p-5" aria-labelledby={titleId}>
      <h2 id={titleId} className="section-title mb-1 flex items-center gap-2">
        <Link2 size={17} className="text-primary" aria-hidden="true" /> Where the link goes
      </h2>
      <p className="mb-3 text-[13px] text-muted">New posts put your link in the post, in the first comment (a reply on X), or say it’s in your bio. The suggestions follow how each network treats links. Posts you already made keep theirs.</p>
      {link ? (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md bg-surface-2 px-3 py-2 text-[12.5px]">
          <span className="min-w-[12rem] flex-1">
            Your posts link to {link.source === 'website' ? 'your website' : 'your page'}: <b className="[overflow-wrap:anywhere]">{linkText(link.url)}</b>.
            {link.source === 'website' && !__ARTIFACT_BUILD__ && ' Publish your page to link to it instead.'}
          </span>
          <CopyButton text={link.url} label="Copy link" size="xs" />
        </div>
      ) : (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md bg-surface-2 px-3 py-2 text-[12.5px] text-muted">
          {/* publishing needs the app's own server, so in claude.ai only the website can be the link */}
          <span className="min-w-[12rem] flex-1">{__ARTIFACT_BUILD__ ? 'No link in your posts yet. Add your website in Settings → Brand.' : 'No link in your posts yet. Publish your SEO page, or add your website in Settings → Brand.'}</span>
          {!__ARTIFACT_BUILD__ && (
            <button type="button" className="btn btn-secondary btn-xs" onClick={() => void navigate('marketing-seo')}>
              Open the SEO page builder
            </button>
          )}
        </div>
      )}
      <ul className="flex flex-col gap-2">
        {rows.map((p) => {
          const value = placementFor(project, p);
          const factId = `${titleId}-${p}`;
          return (
            <li key={p} className="flex flex-col gap-1 rounded-md border border-line px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <span className="flex min-w-[120px] flex-wrap items-center gap-x-1.5">
                  <PlatformChip platform={p} />
                  {!inCampaign.includes(p) && <span className="text-[11.5px] text-muted">(not in this campaign)</span>}
                </span>
                <select className="select input-sm w-auto max-w-full" aria-label={`Where the link goes on ${networkLabel(p)}`} aria-describedby={factId} value={value} onChange={(e) => setPlacement(p, e.target.value as LinkPlacement)}>
                  {LINK_PLACEMENTS.map((id) => (
                    <option key={id} value={id}>
                      {optionLabel(id, p)}
                    </option>
                  ))}
                </select>
              </div>
              <p id={factId} className="text-[11.5px] text-muted">
                {LINK_FACTS[p]}
                {value === 'bio' ? ' Keep your link in your bio there: the app never changes your profile.' : ''}
              </p>
            </li>
          );
        })}
      </ul>
      {changed && (
        <button type="button" className="btn btn-ghost btn-sm mt-3" onClick={() => updateMarketing({ linkPlacement: undefined })}>
          Use the suggestions
        </button>
      )}
    </section>
  );
}
