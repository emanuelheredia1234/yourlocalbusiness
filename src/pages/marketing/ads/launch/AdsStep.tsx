// Step 3: the ads. Meta: the plan's picked versions (1 to 3), each with the image Meta gets ("Make the image" or
// your own JPEG/PNG photo); Google: the search ad exactly as the plan has it. Only the plan's own words are sent:
// to change them, edit the plan (the review reads the saved plan again).
import { useRef, useState } from 'react';
import { ImageUp, RefreshCw } from 'lucide-react';
import type { AdCampaign, AdCreative, Project } from '@/lib/types';
import { useStore } from '@/store/useStore';
import { useMediaUrl } from '@/lib/media';
import { Callout, Checkbox } from '@/components/ui/primitives';
import { GenerateButton } from '@/components/ai/AI';
import { beginBusy, endBusy } from '@/lib/busy';
import { imageStale, makeAdImage, useOwnPhoto, type AdImageResult } from './makeAdImage';
import type { LaunchDraft } from './draft';

function AdImage({ mediaId }: { mediaId: string }) {
  const url = useMediaUrl({ id: mediaId, kind: 'image', name: '', mime: 'image/jpeg', size: 0, createdAt: 0 });
  return url ? <img src={url} alt="" className="h-16 w-16 shrink-0 rounded-md object-cover ring-1 ring-inset ring-line" /> : <div className="h-16 w-16 shrink-0 rounded-md bg-surface-3" aria-hidden="true" />;
}

function CreativeRow({ project, plan, cr, picked, canPick, onPick }: { project: Project; plan: AdCampaign; cr: AdCreative; picked: boolean; canPick: boolean; onPick: (v: boolean) => void }) {
  const [stage, setStage] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const busy = !!stage;
  const save = (r: AdImageResult) => {
    if (!r.ok) return setErr(r.message);
    const live = useStore.getState().ads.find((a) => a.id === plan.id) ?? plan;
    useStore.getState().upsertAd({ ...live, creatives: live.creatives.map((x) => (x.id === cr.id ? { ...x, media: r.media } : x)) });
  };
  const run = async (fn: (onStage: (s: string) => void) => Promise<AdImageResult>) => {
    if (busy) return;
    setErr(null);
    setStage('Starting…');
    const id = `ad-image:${cr.id}`;
    beginBusy(id, 'Making the ad image');
    try {
      save(await fn(setStage));
    } finally {
      endBusy(id);
      setStage('');
    }
  };
  const video = cr.format === 'video';
  const stale = imageStale(project, cr);
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-line p-3">
      <div className="flex items-start gap-3">
        {cr.media ? <AdImage mediaId={cr.media.mediaId} /> : <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-md bg-surface-2 text-caption text-muted ring-1 ring-inset ring-line">No image</div>}
        <div className="min-w-0 flex-1">
          <Checkbox id={`lw-cr-${cr.id}`} checked={picked} disabled={!picked && !canPick} onChange={onPick} label={<span className="text-ui">Version {cr.variant}</span>} description={cr.headline} />
          <p className="mt-1 line-clamp-2 text-small text-muted">{cr.primaryText}</p>
        </div>
      </div>
      {video ? (
        <p className="text-caption text-warn">Video ads need a finished video. Pick an image version.</p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <GenerateButton variant="ai-outline" size="sm" running={busy} runningLabel={stage || 'Making…'} onClick={() => void run((s) => makeAdImage(project, cr, s))}>
            {cr.media ? (stale ? 'Make it again' : 'Make a new image') : 'Make the image'}
          </GenerateButton>
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => file.current?.click()}>
            <ImageUp /> Use my photo
          </button>
          <input
            ref={file}
            type="file"
            accept="image/jpeg,image/png"
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void run((s) => useOwnPhoto(f, s));
            }}
          />
          {cr.media && <span className="text-caption text-muted">{cr.media.madeBy === 'owner' ? 'Your photo' : 'Made by the app'}</span>}
          {stale && (
            <span className="inline-flex items-center gap-1 text-caption text-warn">
              <RefreshCw size={12} aria-hidden="true" /> The text changed since this image was made.
            </span>
          )}
        </div>
      )}
      {err && <Callout tone="bad">{err}</Callout>}
    </li>
  );
}

export function AdsStep({ project, plan, draft, onChange }: { project: Project; plan: AdCampaign; draft: LaunchDraft; onChange: (patch: Partial<LaunchDraft>) => void }) {
  if (draft.platform === 'google') {
    const s = plan.search;
    if (!s) return <Callout tone="warn">This plan has no Google search ad yet. Generate it in the plan first.</Callout>;
    return (
      <div className="flex flex-col gap-4">
        <div>
          <p className="label">Headlines ({s.headlines.length})</p>
          <ul className="flex flex-col gap-1 text-small text-ink">
            {s.headlines.map((h, i) => (
              <li key={i}>{h}</li>
            ))}
          </ul>
        </div>
        <div>
          <p className="label">Descriptions ({s.descriptions.length})</p>
          <ul className="flex flex-col gap-1 text-small text-ink">
            {s.descriptions.map((h, i) => (
              <li key={i}>{h}</li>
            ))}
          </ul>
        </div>
        <div>
          <p className="label">Keywords</p>
          <p className="font-mono text-small text-ink-2">{s.keywords.join(', ') || 'None yet'}</p>
        </div>
        {(s.headlines.length < 3 || s.descriptions.length < 2) && <Callout tone="warn">Add at least 3 headlines and 2 descriptions in the plan, so Google doesn’t write any for you.</Callout>}
        <p className="text-caption text-muted">Only your own words are sent. To change them, edit the plan; the review reads it again.</p>
      </div>
    );
  }
  const picked = new Set(draft.creativeIds);
  const offered = plan.creatives.filter((c) => plan.selectedCreativeIds.includes(c.id));
  if (!offered.length) return <Callout tone="warn">Tick at least one ad version in the plan first.</Callout>;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-small text-muted">Pick 1 to 3 versions. Each needs its image: Meta fetches it from your account when the ads are created.</p>
      <ul className="flex flex-col gap-3" aria-label="Ads to launch">
        {offered.map((cr) => (
          <CreativeRow key={cr.id} project={project} plan={plan} cr={cr} picked={picked.has(cr.id)} canPick={picked.size < 3} onPick={(v) => onChange({ creativeIds: v ? [...draft.creativeIds, cr.id] : draft.creativeIds.filter((x) => x !== cr.id) })} />
        ))}
      </ul>
      <p className="text-caption text-muted">Only your own words are sent, and Meta is told not to rewrite them. To change them, edit the plan.</p>
      {offered.some((c) => picked.has(c.id) && !c.media && c.format !== 'video') && (
        <p className="text-caption text-warn">Every picked version needs its image before the review.</p>
      )}
    </div>
  );
}
