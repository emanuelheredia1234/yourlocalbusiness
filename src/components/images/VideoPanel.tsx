import { useEffect, useId, useRef, useState } from 'react';
import { Clapperboard, Download, RefreshCw, Trash2, WandSparkles } from 'lucide-react';
import type { MediaRef } from '@/lib/types';
import { cn } from '@/lib/utils';
import { deleteBlob, getBlob } from '@/lib/storage';
import { useRuntime } from '@/lib/platform';
import { useMediaUrl } from '@/lib/media';
import { createVideo, fmtUsd, pendingVideos, VIDEO_DURATIONS, VIDEO_RESOLUTIONS, videoCost, videoTransport, type VideoAspect, type VideoJob, type VideoResolution } from '@/ai/video';
import { primaryProvider } from '@/ai/functions';
import { metaLine } from '@/ai/meta';
import { AIThinking } from '@/components/ai/AI';
import { download } from '@/components/ui/download';
import { AutoTextarea, Field, Segmented, Spinner, Toggle } from '@/components/ui/primitives';
import { artDirectionLabel, useArtDirection, useImageJob } from './useImageJob';
import { artDirection, recordVisualSkills } from '@/ai/image';

const ASPECTS: { id: VideoAspect; label: string; hint: string }[] = [
  { id: '9:16', label: 'Vertical', hint: '9:16 · Reels, TikTok, Stories' },
  { id: '1:1', label: 'Square', hint: '1:1 · feeds' },
  { id: '3:4', label: 'Portrait', hint: '3:4 · feeds' },
  { id: '16:9', label: 'Wide', hint: '16:9 · YouTube, websites, listings' },
];

/**
 * Videos come from HeyGen through OpenRouter in the viewer's Zapier connector (claude.ai), or from
 * the keys that power Videos on your server (self-hosted).
 */
export function videoAvailability(zapier: string, ai = useRuntime.getState().ai): { ok: boolean; reason: string } {
  if (videoTransport.server) {
    if (!ai.reachable) return { ok: false, reason: 'Start the Yourlocalbusiness server (npm run server) to make videos.' };
    if (!ai.routing.videos?.length) return { ok: false, reason: 'No API key makes videos yet. In Settings → AI, tick Videos for an OpenRouter, Google or xAI key.' };
    return { ok: true, reason: '' };
  }
  switch (zapier) {
    case 'ready':
    case 'checking':
      return { ok: true, reason: '' };
    case 'needs_reauth':
      return { ok: false, reason: 'Videos are made by HeyGen through OpenRouter in Zapier. Reconnect Zapier in claude.ai Settings → Connectors.' };
    case 'missing':
      return { ok: false, reason: 'Videos are made by HeyGen through Zapier. Add the Zapier connector in claude.ai Settings → Connectors, with OpenRouter connected in Zapier.' };
    default:
      return { ok: false, reason: 'Videos are made by HeyGen through your Zapier connector, which this view can’t reach. Open the app in claude.ai.' };
  }
}

export interface VideoPanelProps {
  title?: string;
  /** what the clip should show; edits flow back through onPromptChange */
  prompt: string;
  onPromptChange?: (v: string) => void;
  defaultAspect: VideoAspect;
  /** a photo the clip can start from (e.g. the listing cover) */
  startImage?: MediaRef | null;
  media: MediaRef | null | undefined;
  onChange: (m: MediaRef | null) => void;
  /** file name without extension */
  name: string;
  /** remembers a running job under this key, so it can be picked up after a reload */
  pendingKey?: string;
  /** whose Brain skills apply: social posts or the listing (studio) */
  purpose?: 'post' | 'listing';
  className?: string;
}

export function VideoPanel({ title = 'AI video', prompt, onPromptChange, defaultAspect, startImage, media, onChange, name, pendingKey, purpose = 'post', className }: VideoPanelProps) {
  const fid = useId();
  const zapier = useRuntime((s) => s.zapier);
  const ai = useRuntime((s) => s.ai);
  const avail = videoAvailability(zapier, ai);
  const server = videoTransport.server;
  const maker = server ? primaryProvider('videos') : undefined;
  const job = useImageJob();
  const [aspect, setAspect] = useState<VideoAspect>(defaultAspect);
  const [duration, setDuration] = useState<number>(8);
  const [resolution, setResolution] = useState<VideoResolution>('768p');
  const [fromImage, setFromImage] = useState(!!startImage);
  // editable here; a new suggestion from outside (e.g. a regenerated post) replaces it
  const [text, setText] = useState(prompt);
  useEffect(() => setText(prompt), [prompt]);
  const [resumable, setResumable] = useState<VideoJob | null>(() => (pendingKey ? pendingVideos.get(pendingKey) : null));
  const current = useRef(media);
  current.current = media;
  useEffect(() => setFromImage(!!startImage), [startImage?.id]);
  const isVideo = media?.kind === 'video';
  const cost = videoCost(duration, resolution);
  const art = useArtDirection(purpose);

  const generate = (resume?: VideoJob) => {
    setResumable(null);
    return job.run(
      async (signal, onStage) => {
        const first = fromImage && startImage && !resume ? await getBlob(startImage.id) : null;
        const brief = artDirection(purpose);
        const r = await createVideo({ prompt: brief.text ? `${text.trim()} Art direction: ${brief.text}` : text, aspect, duration, resolution, firstFrame: first, name, signal, onStage, pendingKey, resume });
        recordVisualSkills(brief, { task: 'video', label: purpose === 'post' ? 'Post video' : 'Listing demo video', purpose, ms: r.ms });
        return r;
      },
      (r) => {
        const old = current.current;
        onChange(r.media);
        if (old && old.id !== r.media.id && old.kind === 'video') setTimeout(() => deleteBlob(old.id), 0);
        if (r.meta) return { done: `Video by ${metaLine(r.meta)} · ${Math.round(r.ms / 1000)}s`, note: r.meta.note ?? '' };
        return { done: `HeyGen video · ${Math.round(r.ms / 1000)}s${r.cost != null ? ` · ${fmtUsd(r.cost)}` : ''}` };
      },
    );
  };

  const save = async () => {
    if (!media) return;
    const blob = await getBlob(media.id);
    if (blob) await download(media.name, blob);
  };

  const remove = () => {
    const old = media;
    onChange(null);
    if (old) setTimeout(() => deleteBlob(old.id), 0);
  };

  return (
    <section className={cn('flex flex-col gap-3 rounded-lg border border-line bg-surface p-3', className)} aria-label={title}>
      <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-ink">
        <Clapperboard size={15} className="text-primary" /> {title}
      </h3>
      {!avail.ok ? (
        <p className="text-[11.5px] leading-snug text-muted">{avail.reason}</p>
      ) : server ? (
        <p className="text-[11.5px] leading-snug text-muted">
          {maker ? `${maker.label} makes the clip with ${maker.models.video} at ${maker.effort.video?.label ?? 'its default'} quality (set per key in Settings → AI). It takes a minute or more.` : 'Your AI keys make the clip.'}
        </p>
      ) : (
        <p className="text-[11.5px] leading-snug text-muted">HeyGen Video makes the clip, with sound, through OpenRouter in your Zapier. It takes about a minute.</p>
      )}
      {resumable && !job.running && (
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-surface-2 px-3 py-2 text-[12.5px]">
          <span className="min-w-0 flex-1 text-ink-2">A video you started is still on its way.</span>
          <button type="button" className="btn btn-secondary btn-xs" onClick={() => generate(resumable)}>
            Pick it up
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-xs text-muted"
            onClick={() => {
              if (pendingKey) pendingVideos.clear(pendingKey);
              setResumable(null);
            }}
          >
            Dismiss
          </button>
        </div>
      )}
      <Field label="What happens in the video" htmlFor={`${fid}-p`} hint="Describe the scene, the action and the camera. Captions are added on top, so leave words out.">
        <AutoTextarea id={`${fid}-p`} value={text} onChange={(v) => { setText(v); onPromptChange?.(v); }} minRows={2} className="text-[13px]" placeholder="e.g. a slow push-in on a barista pouring latte art in a sunny cafe" />
      </Field>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Video shape">
        {ASPECTS.map((a) => (
          <button key={a.id} type="button" role="radio" aria-checked={aspect === a.id} title={a.hint} className={cn('chip', aspect === a.id && 'chip-active')} onClick={() => setAspect(a.id)}>
            {a.label}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-xs text-ink-2" htmlFor={`${fid}-d`}>
          Length
          <select id={`${fid}-d`} className="input h-8 w-auto py-0 text-xs" value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
            {VIDEO_DURATIONS.map((d) => (
              <option key={d} value={d}>
                {d} seconds
              </option>
            ))}
          </select>
        </label>
        {!server && <Segmented<VideoResolution> size="sm" value={resolution} onChange={setResolution} options={VIDEO_RESOLUTIONS.map((r) => ({ id: r.id, label: r.label }))} />}
      </div>
      {art.skills.length > 0 && (
        <p className="text-[11.5px] text-muted" title={art.text}>
          {artDirectionLabel(art.skills.map((k) => k.name))}
        </p>
      )}
      {startImage && <Toggle checked={fromImage} onChange={setFromImage} label="Start from the cover photo" />}
      {!server && (
        <p className="text-[11.5px] text-muted">
          About {fmtUsd(cost)} on OpenRouter (list price; it has billed less so far).
        </p>
      )}
      <AIThinking running={job.running} stage={job.stage} onStop={job.stop} compact />
      {job.error && (
        <div className="rounded-md border border-bad/30 bg-bad-soft px-3 py-2 text-[12.5px]" role="alert">
          <p className="font-semibold text-bad">{job.error.title}</p>
          <p className="text-ink-2">{job.error.body}</p>
        </div>
      )}
      {!job.running && job.done && <p className="text-[11.5px] text-muted">{job.done}</p>}
      {isVideo && !job.running && <VideoPreview media={media!} />}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-ai btn-sm" onClick={() => generate()} disabled={job.running || !avail.ok || text.trim().length < 4}>
          {job.running ? <Spinner size={14} /> : isVideo ? <RefreshCw size={14} /> : <WandSparkles size={14} className="text-accent" />}
          {isVideo ? 'Regenerate video' : 'Generate video'}
        </button>
        {isVideo && (
          <>
            <button type="button" className="btn btn-ghost btn-sm" onClick={save} aria-label="Download video">
              <Download size={14} /> Download
            </button>
            <button type="button" className="btn btn-ghost btn-sm ml-auto text-muted hover:text-bad" onClick={remove} aria-label="Remove video">
              <Trash2 size={14} />
            </button>
          </>
        )}
      </div>
    </section>
  );
}

function VideoPreview({ media }: { media: MediaRef }) {
  const url = useMediaUrl(media);
  if (!url || url === media.thumb) return null;
  return <video src={url} controls playsInline className="max-h-[360px] w-full rounded-md bg-ink object-contain" aria-label="Generated video" />;
}
