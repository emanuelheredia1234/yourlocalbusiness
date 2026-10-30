import { useEffect, useId, useRef, useState } from 'react';
import { Camera, Download, ExternalLink, ImagePlus, Palette, RefreshCw, Trash2, Type, WandSparkles } from 'lucide-react';
import type { ImageAspect, ImageKind, MediaRef, PostPlatform, Project, StyleId } from '@/lib/types';
import { cn } from '@/lib/utils';
import { getBlob } from '@/lib/storage';
import { navigate } from '@/lib/router';
import { artMetaLine, createPostImage, defaultImageKind, photoLabel, photoSourceNote, postSubject, releaseMedia, retypesetPostImage } from '@/ai/image';
import { pendingManus, type ManusTask } from '@/ai/manus';
import { AIThinking } from '@/components/ai/AI';
import { download } from '@/components/ui/download';
import { AutoTextarea, Field, Segmented, Spinner, Toggle } from '@/components/ui/primitives';
import { artDirectionLabel, useArtDirection, useImageJob, usePhotoAvailability } from './useImageJob';

export const POST_ASPECTS: { id: ImageAspect; label: string; hint: string }[] = [
  { id: '4:5', label: 'Portrait', hint: '4:5 · Instagram & Facebook feed' },
  { id: '1:1', label: 'Square', hint: '1:1 · every feed' },
  { id: '9:16', label: 'Story', hint: '9:16 · Stories, Reels, TikTok' },
  { id: '1.91:1', label: 'Landscape', hint: '1.91:1 · LinkedIn & X' },
];

export function aspectForPlatform(p: PostPlatform | undefined): ImageAspect {
  if (p === 'tiktok') return '9:16';
  if (p === 'linkedin' || p === 'x') return '1.91:1';
  return '4:5';
}

const KIND_LABEL: Record<string, string> = { photo: 'photo', illustration: 'illustration', design: 'brand design' };

export function describeGenerated(m: MediaRef | null | undefined): string {
  const g = m?.generated;
  if (!g) return '';
  return g.kind === 'design' ? 'Built-in brand design' : `${g.provider} ${KIND_LABEL[g.kind]}`;
}

export interface PostImagePanelProps {
  project: Project;
  headline: string;
  /** the image description; edits flow back through onPromptChange */
  prompt: string;
  onPromptChange: (v: string) => void;
  style: StyleId;
  watermark: boolean;
  platform?: PostPlatform;
  media: MediaRef | null | undefined;
  onChange: (m: MediaRef | null) => void;
  /** remembers a running Manus task under this key, so it can be picked up after a reload */
  pendingKey?: string;
  className?: string;
}

/** "Open in Manus" link for a task. */
export function ManusLink({ url, label = 'Open in Manus' }: { url?: string; label?: string }) {
  if (!url) return null;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline">
      {label} <ExternalLink size={11} />
    </a>
  );
}

/** Generate, re-typeset, download or remove the AI image of one post. */
export function PostImagePanel({ project, headline, prompt, onPromptChange, style, watermark, platform, media, onChange, pendingKey, className }: PostImagePanelProps) {
  const photo = usePhotoAvailability();
  const fid = useId();
  const g = media?.generated;
  const [kind, setKind] = useState<ImageKind>(() => (g?.kind === 'photo' ? 'photo' : g ? 'illustration' : defaultImageKind()));
  const [aspect, setAspect] = useState<ImageAspect>(() => g?.aspect ?? aspectForPlatform(platform));
  const [overlay, setOverlay] = useState(g?.overlay ?? true);
  const job = useImageJob();
  const current = useRef(media);
  current.current = media;
  useEffect(() => {
    if (kind === 'photo' && !photo.ok) setKind('illustration');
  }, [photo.ok, kind]);
  // a Manus image started before a reload, still on its way
  const [resumable, setResumable] = useState<ManusTask | null>(() => (pendingKey ? pendingManus.get(pendingKey) : null));
  const source = kind === 'photo' && photo.ok ? photoSourceNote() : '';
  const art = useArtDirection('post');

  // show just the scene: the style, headline and watermark notes are handled by the controls below
  const description = prompt.trim() ? postSubject(project, prompt, style) : '';
  const uploaded = media && !g;
  const stale = !!g?.artId && (g.headline !== headline || (g.overlay ?? true) !== overlay || (g.watermark ?? watermark) !== watermark || g.aspect !== aspect);
  const replace = (m: MediaRef) => {
    const old = current.current;
    onChange(m);
    if (old && old.id !== m.id) setTimeout(() => releaseMedia(old), 0);
  };

  const generate = (resume?: ManusTask) => {
    setResumable(null);
    return job.run(
      (signal, onStage, onTask) => createPostImage({ project, kind: resume ? 'photo' : kind, prompt: description || headline, aspect, style, headline, overlay, watermark, signal, onStage, onTask, pendingKey, resume }),
      (r) => {
        replace(r.media);
        const made = r.art.kind === 'design' ? 'Built-in brand design' : r.art.meta ? `${r.art.kind === 'photo' ? 'Photo' : 'Illustration'} by ${artMetaLine(r.art)}` : `${r.art.provider} ${KIND_LABEL[r.art.kind]}`;
        return { done: `${made} · ${(r.art.ms / 1000).toFixed(1)}s`, note: r.art.note ?? '' };
      },
    );
  };

  const retypeset = () =>
    media &&
    job.run(
      async (_signal, onStage) => {
        onStage('Updating the text…');
        const m = await retypesetPostImage(media, { project, aspect, style, headline, overlay, watermark });
        if (!m) throw Object.assign(new Error('The original artwork isn’t stored on this device any more. Generate a new image instead.'), { code: 'NO_ART' });
        return m;
      },
      (m) => {
        replace(m);
        return { done: 'Text updated on the same artwork' };
      },
    );

  const save = async () => {
    if (!media) return;
    const blob = await getBlob(media.id);
    if (blob) await download(media.name, blob);
  };

  const remove = () => {
    const old = media;
    onChange(null);
    if (old) setTimeout(() => releaseMedia(old), 0);
  };

  return (
    <section className={cn('flex flex-col gap-3 rounded-lg border border-line bg-surface p-3', className)} aria-label="AI image">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-ink">
          <ImagePlus size={15} className="text-primary" /> AI image
        </h3>
        <Segmented<ImageKind>
          size="sm"
          value={kind}
          onChange={(v) => (v === 'photo' && !photo.ok ? undefined : setKind(v))}
          options={[
            { id: 'illustration', label: 'Illustration', icon: <Palette size={13} /> },
            { id: 'photo', label: <span className={cn(!photo.ok && 'opacity-50')}>{photoLabel()}</span>, icon: <Camera size={13} className={cn(!photo.ok && 'opacity-50')} /> },
          ]}
        />
      </div>
      {!photo.ok && (
        <p className="text-[11.5px] leading-snug text-muted">
          {photo.reason}{' '}
          {!__ARTIFACT_BUILD__ && (
            <button type="button" className="font-semibold text-primary hover:underline" onClick={() => navigate('workspace-settings')}>
              Open settings
            </button>
          )}
        </p>
      )}
      {source && <p className="text-[11.5px] leading-snug text-muted">{source}</p>}
      {resumable && !job.running && (
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-surface-2 px-3 py-2 text-[12.5px]">
          <span className="min-w-0 flex-1 text-ink-2">A Manus photo you started is still on its way.</span>
          <button type="button" className="btn btn-secondary btn-xs" onClick={() => generate(resumable)}>
            Pick it up
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-xs text-muted"
            onClick={() => {
              if (pendingKey) pendingManus.clear(pendingKey);
              setResumable(null);
            }}
          >
            Dismiss
          </button>
        </div>
      )}
      {uploaded && <p className="text-xs text-muted">This post uses your own photo. Generating replaces it with an AI image.</p>}
      <Field label="Image description" htmlFor={`${fid}-desc`} hint="Describe the scene. Your headline and logo are added on top, so leave words out.">
        <AutoTextarea id={`${fid}-desc`} value={description} onChange={onPromptChange} minRows={2} className="text-[13px]" placeholder="e.g. a sunlit desk with a laptop showing a tidy budget dashboard" />
      </Field>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Image shape">
        {POST_ASPECTS.map((a) => (
          <button key={a.id} type="button" role="radio" aria-checked={aspect === a.id} title={a.hint} className={cn('chip', aspect === a.id && 'chip-active')} onClick={() => setAspect(a.id)}>
            {a.label}
          </button>
        ))}
      </div>
      <Toggle checked={overlay} onChange={setOverlay} label="Headline and logo on the image" />
      {kind === 'photo' && art.skills.length > 0 && (
        <p className="text-[11.5px] text-muted" title={art.text}>
          {artDirectionLabel(art.skills.map((k) => k.name))}
        </p>
      )}
      <AIThinking running={job.running} stage={job.stage} onStop={job.stop} compact />
      {job.running && job.task && <ManusLink url={job.task.taskUrl} label="Watch it in Manus" />}
      {job.error && (
        <div className="rounded-md border border-bad/30 bg-bad-soft px-3 py-2 text-[12.5px]" role="alert">
          <p className="font-semibold text-bad">{job.error.title}</p>
          <p className="text-ink-2">{job.error.body}</p>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <ManusLink url={job.error.taskUrl} label="Open the task in Manus" />
            {job.error.code === 'MANUS_TIMEOUT' && job.task && (
              <button type="button" className="text-xs font-semibold text-primary hover:underline" onClick={() => generate(job.task!)}>
                Keep waiting
              </button>
            )}
            {kind === 'photo' && (
              <button type="button" className="text-xs font-semibold text-primary hover:underline" onClick={() => setKind('illustration')}>
                Make an illustration instead
              </button>
            )}
          </div>
        </div>
      )}
      {!job.running && (job.done || job.note) && (
        <p className="text-[11.5px] text-muted">
          {job.done}
          {job.note && <span className="block text-warn">{job.note}</span>}
        </p>
      )}
      {!job.running && !job.done && g && (
        <p className="flex flex-wrap items-center gap-2 text-[11.5px] text-muted">
          {describeGenerated(media)} <ManusLink url={g.taskUrl} label="View task" />
        </p>
      )}
      {stale && !job.running && (
        <p className="text-[11.5px] text-ink-2">
          The headline or layout changed since this image was made.{' '}
          <button type="button" className="font-semibold text-primary hover:underline" onClick={retypeset}>
            Update the image text
          </button>{' '}
          (no new generation).
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-ai btn-sm" onClick={() => generate()} disabled={job.running}>
          {job.running ? <Spinner size={14} /> : g ? <RefreshCw size={14} /> : <WandSparkles size={14} className="text-accent" />}
          {g ? 'Regenerate' : 'Generate image'}
        </button>
        {stale && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={retypeset} disabled={job.running}>
            <Type size={14} /> Update text
          </button>
        )}
        {media && (
          <>
            <button type="button" className="btn btn-ghost btn-sm" onClick={save} aria-label="Download image">
              <Download size={14} /> Download
            </button>
            <button type="button" className="btn btn-ghost btn-sm ml-auto text-muted hover:text-bad" onClick={remove} aria-label="Remove image">
              <Trash2 size={14} />
            </button>
          </>
        )}
      </div>
    </section>
  );
}
