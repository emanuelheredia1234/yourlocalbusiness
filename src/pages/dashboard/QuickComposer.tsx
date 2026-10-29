import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { CalendarClock, FilePlus2, ImageUp, Send, Sparkles, X } from 'lucide-react';
import type { MediaRef, Post, PostFormat, PostPlatform, PostType, StyleId } from '@/lib/types';
import { addDays, cn, combineDateTime, hashStr, todayStr, truncate, uid } from '@/lib/utils';
import { IMAGE_STYLES, PLATFORMS, POST_PLATFORMS, POST_TYPES, VIDEO_STYLES, isVideoStyle } from '@/ai/knowledge';
import { suggestTopics } from '@/ai/local/social';
import { postTask } from '@/ai/tasks';
import { useAI } from '@/ai/useAI';
import { useActiveProject, useStore } from '@/store/useStore';
import { toast, useUI } from '@/store/ui';
import { navigate } from '@/lib/router';
import { AutoTextarea, ChipInput, Field, Modal, Segmented, Toggle } from '@/components/ui/primitives';
import { AIResultBar, AIThinking, GenerateButton } from '@/components/ai/AI';
import { PostVisual, pointsFromCaption } from '@/components/visuals/PostVisual';
import { MediaDrop, MediaThumb } from '@/components/media/MediaUpload';
import { PlatformGlyph } from '@/components/posts/PlatformIcon';
import { ensureConnected } from '@/components/posts/Connect';
import { PostImagePanel } from '@/components/images/PostImagePanel';
import { VideoPanel } from '@/components/images/VideoPanel';
import { postVideoPrompt, releaseMedia } from '@/ai/image';
import { useManusFb, useManusReady } from '@/components/posts/ManusFacebook';

export function QuickComposer({ onDone, initialTopic, compact }: { onDone?: () => void; initialTopic?: string; compact?: boolean }) {
  const project = useActiveProject()!;
  const fid = useId();
  const manusReady = useManusReady();
  const addPosts = useStore((s) => s.addPosts);
  const publish = useStore((s) => s.publishPost);
  const schedule = useStore((s) => s.schedulePosts);
  const notify = useStore((s) => s.notify);
  const ai = useAI(postTask);
  const [topic, setTopic] = useState(initialTopic ?? '');
  const [source, setSource] = useState<'ai' | 'upload'>('ai');
  const [media, setMedia] = useState<MediaRef | null>(null);
  const [genMedia, setGenMedia] = useState<MediaRef | null>(null);
  const [genVideo, setGenVideo] = useState<MediaRef | null>(null);
  const genRef = useRef<MediaRef | null>(null);
  genRef.current = genMedia;
  // an AI image that never made it into a post is dropped when the composer closes
  useEffect(() => () => void releaseMedia(genRef.current), []);
  const [desc, setDesc] = useState('');
  const [platforms, setPlatforms] = useState<PostPlatform[]>(project.marketing.campaign.platforms.slice(0, 2).length ? project.marketing.campaign.platforms.slice(0, 2) : ['instagram']);
  const [postType, setPostType] = useState<PostType>('tip');
  const [format, setFormat] = useState<PostFormat>('image');
  const [style, setStyle] = useState<StyleId>(project.marketing.campaign.imageStyles[0] ?? 'minimal');
  const [watermark, setWatermark] = useState(project.marketing.campaign.watermark);
  const [headline, setHeadline] = useState('');
  const [caption, setCaption] = useState('');
  const [hashtags, setHashtags] = useState<string[]>([]);
  const [visualPrompt, setVisualPrompt] = useState('');
  const [storyboard, setStoryboard] = useState<Post['storyboard']>(undefined);
  const [date, setDate] = useState(addDays(todayStr(), 1));
  const [time, setTime] = useState(PLATFORMS[platforms[0] ?? 'instagram'].times[1]);
  const suggestions = useMemo(() => suggestTopics(project), [project.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const effFormat: PostFormat = source === 'upload' && media ? (media.kind === 'video' ? 'video' : 'image') : format;
  const styles = effFormat === 'video' ? VIDEO_STYLES : IMAGE_STYLES;
  useEffect(() => {
    if (isVideoStyle(style) !== (effFormat === 'video')) setStyle(effFormat === 'video' ? project.marketing.campaign.videoStyles[0] ?? 'ugc' : project.marketing.campaign.imageStyles[0] ?? 'minimal');
  }, [effFormat]); // eslint-disable-line react-hooks/exhaustive-deps
  const hasDraft = caption.trim().length > 0;

  const generate = async () => {
    if (source === 'ai' && !topic.trim()) {
      toast({ kind: 'info', title: 'What should the post be about?', body: 'Type a topic or pick a suggestion.' });
      return;
    }
    if (source === 'upload' && !media) {
      toast({ kind: 'info', title: 'Add your photo or video first' });
      return;
    }
    const r = await ai.run({ topic: topic.trim() || desc || 'Behind the scenes', postType, platform: platforms[0] ?? 'instagram', format: effFormat, style, watermark, media: source === 'upload' ? media ?? undefined : undefined, mediaDescription: source === 'upload' ? desc || topic : undefined, hasMedia: source === 'upload' });
    if (r) {
      setHeadline(r.headline);
      setCaption(r.caption);
      setHashtags(r.hashtags);
      setVisualPrompt(r.visualPrompt);
      setStoryboard(r.storyboard);
    }
  };

  const build = (status: Post['status']): Post[] => {
    const now = Date.now();
    return platforms.map((platform) => ({
      id: uid('post'),
      projectId: project.id,
      status: 'draft',
      platform,
      format: effFormat,
      style,
      postType,
      headline: headline || truncate(topic, 60),
      visualPrompt,
      caption: platform === 'x' && caption.length > 270 ? truncate(caption.split('\n\n')[0], 240) : caption,
      hashtags: platform === 'x' ? hashtags.slice(0, 2) : hashtags,
      scheduledAt: status === 'published' ? new Date().toISOString() : combineDateTime(date, time),
      media: source === 'upload' ? media ?? undefined : effFormat === 'image' ? genMedia ?? undefined : genVideo ?? undefined,
      storyboard,
      watermark,
      source: 'composer',
      createdAt: now,
      updatedAt: now,
      seed: hashStr(uid('s')),
    }));
  };

  const reset = (discard = false) => {
    if (discard) void releaseMedia(genMedia);
    setGenMedia(null);
    setGenVideo(null);
    setCaption('');
    setHeadline('');
    setHashtags([]);
    setVisualPrompt('');
    setStoryboard(undefined);
    setTopic('');
    setMedia(null);
    setDesc('');
    ai.reset();
  };

  const act = async (mode: 'publish' | 'schedule' | 'draft' | 'manus') => {
    if (!hasDraft) return;
    if (!platforms.length) {
      toast({ kind: 'info', title: 'Pick at least one platform' });
      return;
    }
    // Facebook goes to Manus for real; other platforms keep the in-app scheduler
    const simulated = mode === 'manus' ? platforms.filter((p) => p !== 'facebook') : platforms;
    if (mode !== 'draft' && simulated.length && !(await ensureConnected(simulated))) return;
    const posts = build(mode === 'publish' ? 'published' : 'scheduled');
    addPosts(posts);
    if (mode === 'manus') {
      schedule(posts.map((p) => p.id));
      const fb = posts.find((p) => p.platform === 'facebook');
      reset();
      onDone?.();
      if (fb) useManusFb.getState().open(fb.id);
      return;
    }
    if (mode === 'publish') {
      posts.forEach((p) => publish(p.id));
      notify({ kind: 'post', title: `Published to ${platforms.map((p) => PLATFORMS[p].label).join(', ')}`, body: posts[0].headline, route: 'calendar' });
      toast({ kind: 'success', title: 'Published', body: 'Watch live engagement in the Calendar → Published tab.', action: { label: 'View', run: () => navigate('calendar') } });
    } else if (mode === 'schedule') {
      schedule(posts.map((p) => p.id));
      toast({ kind: 'success', title: `Scheduled for ${date} at ${time}`, action: { label: 'Open calendar', run: () => navigate('calendar') } });
    } else toast({ kind: 'success', title: 'Saved to drafts', action: { label: 'Open calendar', run: () => navigate('calendar') } });
    reset();
    onDone?.();
  };

  const previewPost = { headline: headline || truncate(topic || 'Your headline appears here', 60) };

  return (
    <div className={cn('grid gap-5', !compact && 'lg:grid-cols-[minmax(0,1fr)_300px]')}>
      <div className="flex min-w-0 flex-col gap-4">
        <Segmented
          options={[
            { id: 'ai', label: 'AI visual + caption', icon: <Sparkles size={14} /> },
            { id: 'upload', label: 'My photo or video', icon: <ImageUp size={14} /> },
          ]}
          value={source}
          onChange={setSource}
        />
        {source === 'upload' && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[160px_minmax(0,1fr)]">
            {media ? <MediaThumb media={media} className="aspect-square" onRemove={() => setMedia(null)} /> : <MediaDrop onFiles={(m) => setMedia(m[0])} compact />}
            <Field label="What’s in it? (optional)" htmlFor={`${fid}-desc`} hint="Helps the AI write an accurate caption. With Claude, the image itself is read too.">
              <AutoTextarea id={`${fid}-desc`} value={desc} onChange={setDesc} minRows={3} placeholder="e.g. Fresh sourdough coming out of the oven this morning" />
            </Field>
          </div>
        )}
        <Field label={source === 'ai' ? 'What do you want to post about?' : 'Angle or message'} htmlFor={`${fid}-topic`}>
          <AutoTextarea id={`${fid}-topic`} value={topic} onChange={setTopic} minRows={2} placeholder="e.g. A quick tip to save 2 hours a week on bookkeeping" />
          <div className="mt-2 flex flex-wrap gap-1.5">
            {suggestions.slice(0, compact ? 3 : 5).map((s) => (
              <button key={s} type="button" className="chip max-w-full" onClick={() => setTopic(s)}>
                <span className="truncate">{s}</span>
              </button>
            ))}
          </div>
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Platforms">
            <div className="flex flex-wrap gap-1.5">
              {POST_PLATFORMS.map((p) => {
                const on = platforms.includes(p);
                return (
                  <button key={p} type="button" aria-pressed={on} onClick={() => setPlatforms((x) => (on ? x.filter((y) => y !== p) : [...x, p]))} className={cn('chip', on && 'chip-active')}>
                    <PlatformGlyph platform={p} size={13} /> {PLATFORMS[p].label.replace(' (Twitter)', '')}
                  </button>
                );
              })}
            </div>
          </Field>
          <Field label="Post type" htmlFor={`${fid}-type`}>
            <select id={`${fid}-type`} className="select" value={postType} onChange={(e) => setPostType(e.target.value as PostType)}>
              {POST_TYPES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>
          {source === 'ai' && (
            <Field label="Format">
              <Segmented options={[{ id: 'image', label: 'Image' }, { id: 'video', label: 'Video' }]} value={format} onChange={setFormat} size="sm" />
            </Field>
          )}
          <Field label="Visual style" htmlFor={`${fid}-style`}>
            <select id={`${fid}-style`} className="select" value={style} onChange={(e) => setStyle(e.target.value as StyleId)}>
              {styles.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <GenerateButton running={ai.running} onClick={generate}>
            {hasDraft ? 'Regenerate' : source === 'upload' ? 'Write AI caption' : 'Generate post'}
          </GenerateButton>
          <Toggle checked={watermark} onChange={setWatermark} label="Website watermark" />
        </div>
        <AIThinking running={ai.running} stage={ai.stage} chars={ai.chars} onStop={ai.stop} />
        {ai.result && !ai.running && <AIResultBar provider={ai.result.provider} skills={ai.result.skills} ms={ai.result.ms} note={ai.result.note} logId={ai.logId} />}
        {hasDraft && (
          <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface-2/50 p-3">
            <Field label="On-image headline" htmlFor={`${fid}-h`}>
              <input id={`${fid}-h`} className="input" value={headline} onChange={(e) => setHeadline(e.target.value)} />
            </Field>
            <Field label="Caption" htmlFor={`${fid}-c`} right={`${caption.length} chars`}>
              <AutoTextarea id={`${fid}-c`} value={caption} onChange={setCaption} minRows={4} />
            </Field>
            <Field label="Hashtags">
              <ChipInput values={hashtags} onChange={setHashtags} prefix="#" />
            </Field>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
              <Field label="Date" htmlFor={`${fid}-d`}>
                <input id={`${fid}-d`} type="date" className="input" value={date} min={todayStr()} onChange={(e) => setDate(e.target.value)} />
              </Field>
              <Field label="Time" htmlFor={`${fid}-t`}>
                <input id={`${fid}-t`} type="time" className="input" value={time} onChange={(e) => setTime(e.target.value)} />
              </Field>
            </div>
            <div className="flex flex-wrap gap-2">
              <button className="btn btn-primary" onClick={() => act('publish')}>
                <Send size={15} /> Publish now
              </button>
              <button className="btn btn-secondary" onClick={() => act('schedule')}>
                <CalendarClock size={15} /> Schedule
              </button>
              {manusReady && platforms.includes('facebook') && effFormat === 'image' && (
                <button className="btn btn-secondary" onClick={() => act('manus')} title="Manus schedules the Facebook post for real, in Meta Business Suite">
                  <Send size={15} /> Schedule on Facebook (Manus)
                </button>
              )}
              <button className="btn btn-ghost" onClick={() => act('draft')}>
                <FilePlus2 size={15} /> Save draft
              </button>
              <button className="btn btn-ghost ml-auto text-muted" onClick={() => reset(true)}>
                <X size={15} /> Clear
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="min-w-0">
        <p className="eyebrow mb-2">Live preview</p>
        <div className="mx-auto w-full max-w-[300px]">
          <PostVisual style={style} headline={previewPost.headline} brand={project.brand} watermark={watermark} media={source === 'upload' ? media : effFormat === 'image' ? genMedia : genVideo} storyboard={storyboard} points={pointsFromCaption(caption)} aspect="4/5" hoverPlay autoPlay={effFormat === 'video' && !!storyboard} />
          {hasDraft && <p className="clamp-3 mt-2 whitespace-pre-line text-xs text-muted">{caption}</p>}
        </div>
        {source === 'ai' && effFormat === 'video' && hasDraft && (
          <VideoPanel
            className="mx-auto mt-3 w-full max-w-[420px]"
            prompt={visualPrompt ? postVideoPrompt(project, visualPrompt, style, storyboard) : topic}
            defaultAspect={platforms[0] === 'linkedin' || platforms[0] === 'x' ? '16:9' : '9:16'}
            media={genVideo}
            onChange={setGenVideo}
            name={(headline || topic || 'video').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}
            pendingKey={`composer-video:${project.id}`}
          />
        )}
        {source === 'ai' && effFormat === 'image' && (hasDraft || topic.trim().length > 3) && (
          <PostImagePanel
            className="mx-auto mt-3 w-full max-w-[420px]"
            project={project}
            headline={previewPost.headline}
            prompt={visualPrompt || topic}
            onPromptChange={setVisualPrompt}
            style={style}
            watermark={watermark}
            platform={platforms[0]}
            media={genMedia}
            onChange={setGenMedia}
            pendingKey={`composer:${project.id}`}
          />
        )}
      </div>
    </div>
  );
}

export function ComposerHost() {
  const open = useUI((s) => s.composerOpen);
  const preset = useUI((s) => s.composerPreset);
  const close = useUI((s) => s.closeComposer);
  const project = useActiveProject();
  if (!open || !project) return null;
  return (
    <Modal open onClose={close} size="xl" title="Create a new post" subtitle="Generate with AI, or upload your own media and let AI write the caption.">
      <QuickComposer onDone={close} initialTopic={preset?.topic} />
    </Modal>
  );
}
