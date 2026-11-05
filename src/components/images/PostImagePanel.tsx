import { useEffect, useId, useRef, useState } from 'react';
import { Camera, Download, ExternalLink, Palette, Trash2, Type } from 'lucide-react';
import type { ImageAspect, ImageKind, MediaRef, PostPlatform, Project, StyleId } from '@/lib/types';
import { cn } from '@/lib/utils';
import { getBlob } from '@/lib/storage';
import { artMetaLine, aspectForPlatform, createPostImage, defaultImageKind, photoLabel, photoSourceNote, postSubject, releaseMedia, retypesetPostImage } from '@/ai/image';
import { pendingManus, type ManusTask } from '@/ai/manus';
import { AIThinking, GenerateButton } from '@/components/ai/AI';
import { openPage } from '@/ai/assistant/nav';
import { MediaThumb } from '@/components/media/MediaUpload';
import { download } from '@/components/ui/download';
import { AutoTextarea, Callout, InfoTip, Segmented, Toggle, Tooltip } from '@/components/ui/primitives';
import { artDirectionLabel, useArtDirection, useImageJob, usePhotoAvailability } from './useImageJob';

export const POST_ASPECTS: { id: ImageAspect; label: string; hint: string }[] = [
  { id: '4:5', label: 'Portrait', hint: '4:5 · Instagram & Facebook feed' },
  { id: '1:1', label: 'Square', hint: '1:1 · every feed' },
  { id: '9:16', label: 'Story', hint: '9:16 · Stories, Reels, TikTok' },
  { id: '1.91:1', label: 'Landscape', hint: '1.91:1 · LinkedIn & X' },
];

// a post image's shape on its network (moved to the image module, where the post card and the assistant use it too)
export { aspectForPlatform };

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
    <a href={url} target="_blank" rel="noopener noreferrer" className="link inline-flex items-center gap-1 text-small">
      {label} <ExternalLink size={12} aria-hidden="true" />
    </a>
  );
}

/** The text box inside an AI composer frame: no border or fill of its own. */
const COMPOSER_TEXT = '!border-0 !bg-transparent !px-1 !py-0.5 !shadow-none';

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

  // who makes it and what it costs: behind the ⓘ, never on the panel
  const about = [!photo.ok ? photo.reason : '', source || (kind === 'illustration' ? 'Illustrations are drawn in your brand colors; your headline and logo go on top.' : ''), kind === 'photo' ? artDirectionLabel(art.skills.map((k) => k.name)) : ''].filter(Boolean);
  const made = job.done || describeGenerated(media);

  return (
    <section className={cn('flex flex-col gap-3 rounded-lg border border-line bg-surface p-4', className)} aria-label="AI image">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-1 text-h4 text-ink">
          AI image
          {about.length > 0 && (
            <InfoTip label="Who makes the image" link={!photo.ok && !__ARTIFACT_BUILD__ ? { label: 'Open Settings › AI keys', onClick: () => void openPage('workspace-settings', 'ai') } : undefined}>
              {about.map((t, i) => (
                <span key={t} className={cn('block', i > 0 && 'mt-1.5')}>
                  {t}
                </span>
              ))}
            </InfoTip>
          )}
        </h3>
        <Segmented<ImageKind>
          size="sm"
          value={kind}
          onChange={(v) => (v === 'photo' && !photo.ok ? undefined : setKind(v))}
          options={[
            { id: 'illustration', label: 'Illustration', icon: <Palette /> },
            { id: 'photo', label: <span className={cn(!photo.ok && 'text-faint')}>{photoLabel()}</span>, icon: <Camera className={cn(!photo.ok && 'text-faint')} /> },
          ]}
        />
      </div>
      {resumable && !job.running && (
        <Callout
          tone="info"
          onDismiss={() => {
            if (pendingKey) pendingManus.clear(pendingKey);
            setResumable(null);
          }}
          action={
            <button type="button" className="btn btn-secondary btn-xs" onClick={() => generate(resumable)}>
              Pick it up
            </button>
          }
        >
          A Manus photo you started is still on its way.
        </Callout>
      )}
      {uploaded && <p className="text-small text-muted">This post uses your own photo. Generating replaces it with an AI image.</p>}
      <div>
        <label htmlFor={`${fid}-desc`} className="label">
          Image description
        </label>
        <div className="ai-composer px-3 pb-2 pt-2.5">
          <AutoTextarea id={`${fid}-desc`} value={description} onChange={onPromptChange} minRows={2} className={COMPOSER_TEXT} placeholder="e.g. a sunlit desk with a laptop showing a tidy budget dashboard" aria-describedby={`${fid}-hint`} />
          <div className="mt-1.5 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Image shape">
            {POST_ASPECTS.map((a) => (
              <button key={a.id} type="button" role="radio" aria-checked={aspect === a.id} title={a.hint} className={cn('chip', aspect === a.id && 'chip-active')} onClick={() => setAspect(a.id)}>
                {a.label}
              </button>
            ))}
          </div>
        </div>
        <p id={`${fid}-hint`} className="hint">
          Describe the scene. Your headline and logo go on top, so leave words out.
        </p>
      </div>
      <Toggle checked={overlay} onChange={setOverlay} label="Headline and logo on the image" />
      <AIThinking running={job.running} stage={job.stage} onStop={job.stop} compact />
      {job.running && job.task && <ManusLink url={job.task.taskUrl} label="Watch it in Manus" />}
      {job.error && (
        <Callout tone="bad" title={job.error.title}>
          {job.error.body}
          <span className="mt-1 flex flex-wrap items-center gap-3">
            <ManusLink url={job.error.taskUrl} label="Open the task in Manus" />
            {job.error.code === 'MANUS_TIMEOUT' && job.task && (
              <button type="button" className="link text-small" onClick={() => generate(job.task!)}>
                Keep waiting
              </button>
            )}
            {kind === 'photo' && (
              <button type="button" className="link text-small" onClick={() => setKind('illustration')}>
                Make an illustration instead
              </button>
            )}
          </span>
        </Callout>
      )}
      {media && !job.running && (
        <div className="flex min-w-0 items-center gap-3">
          {/* the image in use, with the selection ring */}
          <span className="shrink-0 rounded-md ring-2 ring-primary ring-offset-2 ring-offset-surface">
            <MediaThumb media={media} className="h-12 w-12 rounded-md" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1 text-small font-medium text-ink">
              {uploaded ? 'Your photo' : g?.kind === 'design' ? 'Brand design' : g?.kind === 'photo' ? 'AI photo' : 'AI illustration'}
              {made && !uploaded && (
                <InfoTip label="How this image was made">
                  {made}
                  {g?.taskUrl && (
                    <span className="mt-1.5 block">
                      <ManusLink url={g.taskUrl} label="View task" />
                    </span>
                  )}
                </InfoTip>
              )}
            </p>
            {stale ? (
              <p className="text-caption text-ink-2">The headline or layout changed since it was made.</p>
            ) : (
              job.note && <p className="text-caption text-warn">{job.note}</p>
            )}
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <GenerateButton size="sm" running={job.running} runningLabel="Designing…" onClick={() => void generate()}>
          {g ? 'Regenerate' : 'Generate image'}
        </GenerateButton>
        {stale && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={retypeset} disabled={job.running}>
            <Type /> Update text
          </button>
        )}
        {media && (
          <>
            <button type="button" className="btn btn-secondary btn-sm" onClick={save} aria-label="Download image">
              <Download /> Download
            </button>
            <Tooltip content="Remove the image">
              <button type="button" className="btn btn-danger-ghost btn-icon btn-sm ml-auto" onClick={remove} aria-label="Remove image">
                <Trash2 />
              </button>
            </Tooltip>
          </>
        )}
      </div>
    </section>
  );
}
