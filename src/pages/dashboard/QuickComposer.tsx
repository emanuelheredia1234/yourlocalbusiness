import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Bookmark, CalendarClock, FilePlus2, Heart, ImageUp, MessageCircle, Send, X } from 'lucide-react';
import type { LinkPlacement, MediaRef, Post, PostFormat, PostPlatform, PostType, Project, StyleId } from '@/lib/types';
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
import { useMediaQuery } from '@/lib/hooks';
import { AutoTextarea, ChipInput, DateTimeButton, Field, InfoTip, MoreMenu, Segmented, Select, StickyActionBar, Toggle } from '@/components/ui/primitives';
import { AIResultBar, AIThinking, GenerateButton, Spark } from '@/components/ai/AI';
import { PostVisual, orderStyles, pointsFromCaption } from '@/components/visuals/PostVisual';
import { PhoneFrame } from '@/components/frames/Frames';
import { MediaDrop, MediaThumb } from '@/components/media/MediaUpload';
import { PlatformGlyph } from '@/components/posts/PlatformIcon';
import { LogoMark } from '@/components/brand/Logo';
import { PostImagePanel } from '@/components/images/PostImagePanel';
import { VideoPanel } from '@/components/images/VideoPanel';
import { postVideoPrompt, releaseMedia } from '@/ai/image';
import { manusSetupHint, useCanOfferManus, useManusPost, useManusReady } from '@/components/posts/ManusPost';

const pad = (n: number) => String(n).padStart(2, '0');
/** "2026-11-06" + "12:30" as a time in ms (the person's own time zone). */
const toMs = (date: string, time: string) => new Date(`${date}T${time || '12:00'}`).getTime();
const startOfToday = () => new Date(`${todayStr()}T00:00`).getTime();

/** The composer's idea chips, four at a time. */
const IDEAS_SHOWN = 4;

export function QuickComposer({ onDone, initialTopic, compact }: { onDone?: () => void; initialTopic?: string; compact?: boolean }) {
  const project = useActiveProject()!;
  const fid = useId();
  const phone = useMediaQuery('(max-width: 639px)');
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
  const [ideaPage, setIdeaPage] = useState(0);
  const ideaPages = Math.max(1, Math.ceil(suggestions.length / IDEAS_SHOWN));
  const ideas = suggestions.slice((ideaPage % ideaPages) * IDEAS_SHOWN, (ideaPage % ideaPages) * IDEAS_SHOWN + IDEAS_SHOWN);
  const effFormat: PostFormat = source === 'upload' && media ? (media.kind === 'video' ? 'video' : 'image') : format;
  // your own photo posts untouched: a visual style, watermark or on-image headline never goes on it
  const ownPhoto = source === 'upload' && isOwnPhoto(media);
  const styles: { id: StyleId; label: string }[] = effFormat === 'video' ? orderStyles(VIDEO_STYLES) : orderStyles(IMAGE_STYLES);
  useEffect(() => {
    if (isVideoStyle(style) !== (effFormat === 'video')) setStyle(effFormat === 'video' ? project.marketing.campaign.videoStyles[0] ?? 'ugc' : project.marketing.campaign.imageStyles[0] ?? 'minimal');
  }, [effFormat]); // eslint-disable-line react-hooks/exhaustive-deps
  const hasDraft = caption.trim().length > 0;

  const generate = async () => {
    if (source === 'ai' && !topic.trim()) {
      toast({ kind: 'info', title: 'What should the post be about?', body: 'Type a topic or pick an idea.' });
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

  const previewHeadline = headline || truncate(topic || 'Your headline appears here', 60);
  const previewMedia = source === 'upload' ? media : effFormat === 'image' ? genMedia : genVideo;
  const shownOn = platforms[0] ?? 'instagram';
  const footer = (
    <>
      <button type="button" className="btn btn-secondary" onClick={() => act('draft')}>
        <FilePlus2 /> Save draft
      </button>
      <button type="button" className="btn btn-primary" onClick={() => act('calendar')}>
        <CalendarClock /> Add to calendar
      </button>
    </>
  );

  return (
    <div className={cn('grid items-start gap-x-8 gap-y-6', !compact && 'lg:grid-cols-12')}>
      <div className={cn('flex min-w-0 flex-col gap-5', !compact && 'lg:col-span-7')}>
        <Segmented
          options={[
            { id: 'ai', label: 'AI visual + caption', icon: <Spark size={14} mono /> },
            { id: 'upload', label: 'My photo or video', icon: <ImageUp /> },
          ]}
          value={source}
          onChange={setSource}
          className="self-start"
        />
        {source === 'upload' && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[160px_minmax(0,1fr)]">
            {media ? <MediaThumb media={media} className="aspect-square" onRemove={() => setMedia(null)} /> : <MediaDrop onFiles={(m) => setMedia(m[0])} compact />}
            <Field label="What’s in it? (optional)" htmlFor={`${fid}-desc`} hint="Helps the AI write an accurate caption.">
              <AutoTextarea id={`${fid}-desc`} value={desc} onChange={setDesc} minRows={3} placeholder="e.g. Fresh sourdough coming out of the oven this morning" />
            </Field>
          </div>
        )}
        <div>
          <label htmlFor={`${fid}-topic`} className="label">
            {source === 'ai' ? 'What do you want to post about?' : 'Angle or message'}
          </label>
          <div className="ai-composer px-3 pb-2.5 pt-2">
            <AutoTextarea
              id={`${fid}-topic`}
              value={topic}
              onChange={setTopic}
              minRows={2}
              placeholder="e.g. A quick tip to keep balayage bright between visits"
              className="!border-0 !bg-transparent !px-1 !py-0.5 !shadow-none"
            />
          </div>
          {ideas.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5" role="group" aria-label="Ideas">
              {ideas.map((s) => (
                <button key={s} type="button" className="chip max-w-full" title={s} onClick={() => setTopic(s)}>
                  <span className="max-w-[36ch] truncate">{s}</span>
                </button>
              ))}
              {ideaPages > 1 && (
                <button type="button" className="btn btn-ghost btn-xs" onClick={() => setIdeaPage((n) => n + 1)}>
                  More ideas
                </button>
              )}
            </div>
          )}
        </div>

        <Field label="Platforms">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Platforms">
            {POST_PLATFORMS.map((p) => {
              const on = platforms.includes(p);
              return (
                <button key={p} type="button" aria-pressed={on} onClick={() => setPlatforms((x) => (on ? x.filter((y) => y !== p) : [...x, p]))} className={cn('chip', on && 'chip-active')}>
                  <PlatformGlyph platform={p} size={14} /> {PLATFORMS[p].label.replace(' (Twitter)', '')}
                </button>
              );
            })}
          </div>
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Post type" htmlFor={`${fid}-type`}>
            <Select<PostType> id={`${fid}-type`} value={postType} onChange={setPostType} options={POST_TYPES.map((t) => ({ value: t.id, label: t.label }))} />
          </Field>
          {!ownPhoto && (
            <Field label="Visual style" htmlFor={`${fid}-style`}>
              <Select<StyleId> id={`${fid}-style`} value={style} onChange={setStyle} options={styles.map((s) => ({ value: s.id, label: s.label }))} />
            </Field>
          )}
          {source === 'ai' && (
            <Field label="Format">
              <Segmented options={[{ id: 'image', label: 'Image' }, { id: 'video', label: 'Video' }]} value={format} onChange={setFormat} size="sm" />
            </Field>
          )}
          {!ownPhoto && (
            <Field label="Watermark" htmlFor={`${fid}-wm`}>
              <Toggle id={`${fid}-wm`} checked={watermark} onChange={setWatermark} />
            </Field>
          )}
        </div>
        {/* before generating, so the AI writes for the first network's choice; the others get the link moved for them */}
        {link ? (
          <Field label="Where the link goes" right={<span className="font-mono [overflow-wrap:anywhere] max-sm:hidden">{linkText(link.url)}</span>}>
            <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
              {platforms.map((p) => (
                <li key={p} className="grid min-h-12 grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 px-3 py-1.5">
                  <span className="flex min-w-0 items-center gap-2 text-ui text-ink">
                    <PlatformGlyph platform={p} size={16} /> <span className="truncate">{networkLabel(p)}</span>
                  </span>
                  <Select<LinkPlacement>
                    size="sm"
                    className="w-[176px] max-sm:w-[148px]"
                    aria-label={`Where the link goes on ${networkLabel(p)}`}
                    value={linkFor(p)!.placement}
                    onChange={(v) => setLinkWhere((x) => ({ ...x, [p]: v }))}
                    options={LINK_PLACEMENTS.map((id) => ({ value: id, label: id === 'comment' && p === 'x' ? 'First reply' : LINK_PLACEMENT_LABEL[id] }))}
                  />
                  <InfoTip label={`How links work on ${networkLabel(p)}`}>{LINK_FACTS[p]}</InfoTip>
                </li>
              ))}
            </ul>
            {/* on a phone the address goes under the list, so the label keeps its one line */}
            <p className="mt-1.5 font-mono text-caption text-muted [overflow-wrap:anywhere] sm:hidden">{linkText(link.url)}</p>
          </Field>
        ) : (
          <p className="text-small text-muted">{__ARTIFACT_BUILD__ ? 'No link in your posts yet. Add your website in Settings → Brand.' : 'No link in your posts yet. Publish your page (Marketing → SEO page), or add your website in Settings → Brand.'}</p>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <GenerateButton variant={hasDraft ? 'ai-outline' : 'ai'} running={ai.running} runningLabel="Writing…" onClick={generate}>
            {hasDraft ? 'Regenerate' : source === 'upload' ? 'Write AI caption' : 'Generate post'}
          </GenerateButton>
        </div>
        <AIThinking running={ai.running} stage={ai.stage} onStop={ai.stop} />
        {ai.result && !ai.running && <AIResultBar provider={ai.result.provider} skills={ai.result.skills} ms={ai.result.ms} note={ai.result.note} logId={ai.logId} />}

        {hasDraft && (
          <div className="flex flex-col gap-4 border-t border-line pt-5">
            <Field label={ownPhoto ? 'Headline' : 'On-image headline'} htmlFor={`${fid}-h`} hint={ownPhoto ? 'Names the post in your lists. It isn’t added to your photo.' : undefined}>
              <input id={`${fid}-h`} className="input" value={headline} onChange={(e) => setHeadline(e.target.value)} />
            </Field>
            <Field label="Caption" htmlFor={`${fid}-c`} right={<span className="num font-mono">{caption.length} chars</span>}>
              <AutoTextarea id={`${fid}-c`} value={caption} onChange={setCaption} minRows={4} />
            </Field>
            <Field label="Hashtags">
              <ChipInput values={hashtags} onChange={setHashtags} prefix="#" />
            </Field>
            <Field label="When">
              <DateTimeButton
                aria-label="When it goes out"
                value={toMs(date, time)}
                min={startOfToday()}
                onChange={(ms) => {
                  const d = new Date(ms);
                  setDate(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
                  setTime(`${pad(d.getHours())}:${pad(d.getMinutes())}`);
                }}
              />
            </Field>
          </div>
        )}

        {source === 'ai' && effFormat === 'video' && hasDraft && (
          <VideoPanel
            className="w-full"
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
            className="w-full"
            project={project}
            headline={previewHeadline}
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

        {hasDraft && (
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-5">
            {offerManus && (
              <button type="button" className="btn btn-secondary" onClick={() => act('manus')} title="Manus posts it on your accounts, in its own browser: right away, or scheduled for this date and time">
                <Send /> Post with Manus
              </button>
            )}
            <span className="ml-auto flex items-center gap-2 max-sm:hidden">{footer}</span>
            <InfoTip label="How posting works">{manusReady ? 'Nothing posts by itself: Manus posts it when you confirm (now, or scheduled for this time), or you post it yourself and mark it posted.' : `Nothing posts by itself. ${manusSetupHint()} Until then, copy the text and post it yourself, then mark it posted.`}</InfoTip>
            <MoreMenu label="More post actions" items={[{ label: 'Clear the draft', icon: <X />, onSelect: () => reset(true), danger: true }]} />
            {phone && (
              <div className="sm:hidden">
                <StickyActionBar>{footer}</StickyActionBar>
              </div>
            )}
          </div>
        )}
      </div>

      <div className={cn('flex min-w-0 flex-col items-center gap-3', !compact && 'lg:sticky lg:top-6 lg:col-span-5')}>
        <p className="flex items-center gap-1.5 self-center text-small text-muted">
          <PlatformGlyph platform={shownOn} size={14} /> Preview on {networkLabel(shownOn)}
        </p>
        <PhoneFrame>
          <PhonePost project={project} platform={shownOn} headline={previewHeadline} caption={caption} hashtags={hashtags} style={style} watermark={watermark} media={previewMedia} storyboard={storyboard} video={effFormat === 'video'} />
        </PhoneFrame>
      </div>
    </div>
  );
}

/** The post as it shows in a feed on the phone: the network's bar, the account, the picture, the caption. */
function PhonePost({
  project,
  platform,
  headline,
  caption,
  hashtags,
  style,
  watermark,
  media,
  storyboard,
  video,
}: {
  project: Project;
  platform: PostPlatform;
  headline: string;
  caption: string;
  hashtags: string[];
  style: StyleId;
  watermark: boolean;
  media: MediaRef | null;
  storyboard?: Post['storyboard'];
  video: boolean;
}) {
  const brand = project.brand;
  const handle = (brand.socials[platform] || brand.name || 'yourbusiness').replace(/^@/, '');
  return (
    <div className="flex h-full flex-col bg-surface text-ink">
      <div className="h-11 shrink-0" aria-hidden="true" />
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
        <PlatformGlyph platform={platform} size={16} />
        <span className="text-small font-semibold">{networkLabel(platform)}</span>
      </div>
      <div className="flex shrink-0 items-center gap-2 px-3 py-2">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-surface-3">
          <LogoMark colors={brand.colors} logo={brand.logo} name={brand.name} size={24} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-small font-semibold">{handle}</span>
          <span className="block text-caption text-muted">{project.location?.city || 'Just now'}</span>
        </span>
      </div>
      <div className="shrink-0">
        <PostVisual style={style} headline={headline} brand={brand} watermark={watermark} media={media} storyboard={storyboard} points={pointsFromCaption(caption)} aspect="4/5" className="rounded-none" hoverPlay autoPlay={video && !!storyboard} />
      </div>
      <div className="flex shrink-0 items-center gap-3.5 px-3 pb-1 pt-2.5 text-ink" aria-hidden="true">
        <Heart size={18} />
        <MessageCircle size={18} />
        <Send size={18} />
        <Bookmark size={18} className="ml-auto" />
      </div>
      {/* the clamp sits on an element without padding, or the next line would show in the padding */}
      <div className="px-3 pb-3">
        <p className="clamp-3 text-small text-ink-2">
          <span className="mr-1 font-semibold text-ink">{handle}</span>
          {caption ? (
            <>
              {caption}
              {hashtags.length > 0 && <span className="text-primary"> {hashtags.join(' ')}</span>}
            </>
          ) : (
            <span className="text-muted">Your caption shows here once it’s written.</span>
          )}
        </p>
      </div>
    </div>
  );
}
