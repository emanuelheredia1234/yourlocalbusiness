import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { CalendarClock, FilePlus2, ImageUp, Send, Sparkles, X } from 'lucide-react';
import type { LinkPlacement, MediaRef, Post, PostFormat, PostPlatform, PostType, StyleId } from '@/lib/types';
import { addDays, cn, todayStr, truncate } from '@/lib/utils';
import { IMAGE_STYLES, PLATFORMS, POST_PLATFORMS, POST_TYPES, VIDEO_STYLES, isVideoStyle } from '@/ai/knowledge';
import { suggestTopics } from '@/ai/local/social';
import { buildComposerPosts, composerTaskInput } from '@/ai/socialPosts';
import { LINK_FACTS, LINK_PLACEMENTS, LINK_PLACEMENT_LABEL, linkText, pageLink, postLinkFor } from '@/lib/pageLink';
import { networkLabel } from '@/ai/manusPost';
import { postTask } from '@/ai/tasks';
import { useAI } from '@/ai/useAI';
import { useActiveProject, useStore } from '@/store/useStore';
import { toast } from '@/store/ui';
import { navigate } from '@/lib/router';
import { isOwnPhoto } from '@/lib/media';
import { AutoTextarea, ChipInput, Field, Segmented, Toggle } from '@/components/ui/primitives';
import { AIResultBar, AIThinking, GenerateButton } from '@/components/ai/AI';
import { PostVisual, pointsFromCaption } from '@/components/visuals/PostVisual';
import { MediaDrop, MediaThumb } from '@/components/media/MediaUpload';
import { PlatformGlyph } from '@/components/posts/PlatformIcon';
import { PostImagePanel } from '@/components/images/PostImagePanel';
import { VideoPanel } from '@/components/images/VideoPanel';
import { postVideoPrompt, releaseMedia } from '@/ai/image';
import { manusSetupHint, useCanOfferManus, useManusPost, useManusReady } from '@/components/posts/ManusPost';

export function QuickComposer({ onDone, initialTopic, compact }: { onDone?: () => void; initialTopic?: string; compact?: boolean }) {
  const project = useActiveProject()!;
  const fid = useId();
  const manusReady = useManusReady();
  const offerManus = useCanOfferManus();
  const addPosts = useStore((s) => s.addPosts);
  const schedule = useStore((s) => s.schedulePosts);
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
  // where each network's link goes on this post (it starts at the project's setting for that network)
  const [linkWhere, setLinkWhere] = useState<Partial<Record<PostPlatform, LinkPlacement>>>({});
  const link = pageLink(project);
  const linkFor = (p: PostPlatform) => postLinkFor(project, p, linkWhere[p]);
  const [date, setDate] = useState(addDays(todayStr(), 1));
  const [time, setTime] = useState(PLATFORMS[platforms[0] ?? 'instagram'].times[1]);
  const suggestions = useMemo(() => suggestTopics(project), [project.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const effFormat: PostFormat = source === 'upload' && media ? (media.kind === 'video' ? 'video' : 'image') : format;
  // your own photo posts untouched: a visual style, watermark or on-image headline never goes on it
  const ownPhoto = source === 'upload' && isOwnPhoto(media);
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
    const r = await ai.run(composerTaskInput(project, { topic, description: desc, upload: source === 'upload' ? media : null, postType, platforms, format: effFormat, style, watermark, linkWhere }));
    if (r) {
      setHeadline(r.headline);
      setCaption(r.caption);
      setHashtags(r.hashtags);
      setVisualPrompt(r.visualPrompt);
      setStoryboard(r.storyboard);
    }
  };

  // one draft per network, each with its link where it goes there (and short enough for X)
  const build = (): Post[] =>
    buildComposerPosts(project, {
      platforms,
      format: effFormat,
      style,
      postType,
      headline,
      topic,
      caption,
      hashtags,
      visualPrompt,
      storyboard,
      watermark,
      date,
      time,
      media: source === 'upload' ? media ?? undefined : effFormat === 'image' ? genMedia ?? undefined : genVideo ?? undefined,
      linkWhere,
    });

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
    setLinkWhere({});
    ai.reset();
  };

  /** manus: on your calendar, then straight to Manus (it posts them, now or at their time) */
  const act = (mode: 'calendar' | 'draft' | 'manus') => {
    if (!hasDraft) return;
    if (!platforms.length) {
      toast({ kind: 'info', title: 'Pick at least one platform' });
      return;
    }
    const posts = build();
    addPosts(posts);
    if (mode !== 'draft') schedule(posts.map((p) => p.id));
    reset();
    onDone?.();
    if (mode === 'manus') useManusPost.getState().open(posts.map((p) => p.id));
    else if (mode === 'calendar') toast({ kind: 'success', title: posts.length > 1 ? `${posts.length} posts added to your calendar` : 'Added to your calendar', body: `For ${date} at ${time}. When it’s time, post with Manus, or post it yourself and mark it posted.`, action: { label: 'Open calendar', run: () => navigate('calendar') } });
    else toast({ kind: 'success', title: 'Saved to drafts', action: { label: 'Open calendar', run: () => navigate('calendar') } });
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
          {!ownPhoto && (
            <Field label="Visual style" htmlFor={`${fid}-style`}>
              <select id={`${fid}-style`} className="select" value={style} onChange={(e) => setStyle(e.target.value as StyleId)}>
                {styles.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
        {/* before generating, so the AI writes for the first network's choice; the others get the link moved for them */}
        {link ? (
          <Field label="Where the link goes" hint={<>Your link: <span className="[overflow-wrap:anywhere]">{linkText(link.url)}</span></>}>
            <ul className="flex flex-col gap-1.5">
              {platforms.map((p) => (
                <li key={p} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="flex min-w-[96px] items-center gap-1.5 text-small">
                    <PlatformGlyph platform={p} size={13} /> {networkLabel(p)}
                  </span>
                  <select className="select input-sm w-auto" aria-label={`Where the link goes on ${networkLabel(p)}`} value={linkFor(p)!.placement} onChange={(e) => setLinkWhere((x) => ({ ...x, [p]: e.target.value as LinkPlacement }))}>
                    {LINK_PLACEMENTS.map((id) => (
                      <option key={id} value={id}>
                        {id === 'comment' && p === 'x' ? 'First reply' : LINK_PLACEMENT_LABEL[id]}
                      </option>
                    ))}
                  </select>
                  <span className="text-caption text-muted">{LINK_FACTS[p]}</span>
                </li>
              ))}
            </ul>
          </Field>
        ) : (
          <p className="text-small text-muted">{__ARTIFACT_BUILD__ ? 'No link in your posts yet. Add your website in Settings → Brand.' : 'No link in your posts yet. Publish your page (Marketing Hub → SEO page), or add your website in Settings → Brand.'}</p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <GenerateButton running={ai.running} onClick={generate}>
            {hasDraft ? 'Regenerate' : source === 'upload' ? 'Write AI caption' : 'Generate post'}
          </GenerateButton>
          {!ownPhoto && <Toggle checked={watermark} onChange={setWatermark} label="Watermark" />}
        </div>
        <AIThinking running={ai.running} stage={ai.stage} chars={ai.chars} onStop={ai.stop} />
        {ai.result && !ai.running && <AIResultBar provider={ai.result.provider} skills={ai.result.skills} ms={ai.result.ms} note={ai.result.note} logId={ai.logId} />}
        {hasDraft && (
          <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface-2/50 p-3">
            <Field label={ownPhoto ? 'Headline' : 'On-image headline'} htmlFor={`${fid}-h`} hint={ownPhoto ? 'Names the post in your lists. It isn’t added to your photo.' : undefined}>
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
              {offerManus && (
                <button className="btn btn-primary" onClick={() => act('manus')} title="Manus posts it on your accounts, in its own browser: right away, or scheduled for this date and time">
                  <Send size={15} /> Post with Manus
                </button>
              )}
              <button className={cn('btn', manusReady ? 'btn-secondary' : 'btn-primary')} onClick={() => act('calendar')}>
                <CalendarClock size={15} /> Add to calendar
              </button>
              <button className="btn btn-ghost" onClick={() => act('draft')}>
                <FilePlus2 size={15} /> Save draft
              </button>
              <button className="btn btn-ghost ml-auto text-muted" onClick={() => reset(true)}>
                <X size={15} /> Clear
              </button>
            </div>
            <p className="text-caption text-muted">{manusReady ? 'Nothing posts by itself: Manus posts it when you confirm (now, or scheduled for this time), or you post it yourself and mark it posted.' : `Nothing posts by itself. ${manusSetupHint()} Until then, copy the text and post it yourself, then mark it posted.`}</p>
          </div>
        )}
      </div>
      <div className="min-w-0">
        <p className="eyebrow mb-2">Live preview</p>
        <div className="mx-auto w-full max-w-[300px]">
          <PostVisual style={style} headline={previewPost.headline} brand={project.brand} watermark={watermark} media={source === 'upload' ? media : effFormat === 'image' ? genMedia : genVideo} storyboard={storyboard} points={pointsFromCaption(caption)} aspect="4/5" hoverPlay autoPlay={effFormat === 'video' && !!storyboard} />
          {hasDraft && <p className="clamp-3 mt-2 whitespace-pre-line text-caption text-muted">{caption}</p>}
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
