import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Pause, Play } from 'lucide-react';
import type { Brand, MediaRef, Scene, StyleId } from '@/lib/types';
import { cn, darken, lighten, mix, readableOn, stripProtocol, withAlpha } from '@/lib/utils';
import { isVideoStyle } from '@/ai/knowledge';
import { useMediaUrl } from '@/lib/media';
import { Icon } from '../ui/Icon';
import { LogoMark } from '../brand/Logo';

export interface PostVisualProps {
  style: StyleId;
  headline: string;
  brand: Brand;
  watermark?: boolean;
  media?: MediaRef | null;
  storyboard?: Scene[];
  points?: string[];
  aspect?: '1/1' | '4/5' | '9/16';
  autoPlay?: boolean;
  hoverPlay?: boolean;
  className?: string;
  label?: string;
}

const cq = (n: number) => `${n}cqw`;

export function PostVisual(props: PostVisualProps) {
  const { style, brand, watermark, aspect, className, label } = props;
  const video = isVideoStyle(style);
  const ratio = aspect ?? (video ? '9/16' : '1/1');
  const mediaUrl = useMediaUrl(props.media ?? null);
  const url = stripProtocol(brand.websiteUrl || (brand.slug ? `${brand.slug}.com` : ''));
  const finished = props.media?.kind === 'image' && props.media.generated?.final;
  if (finished) {
    // AI images already carry the headline, logo and watermark: show them exactly as they will post
    const m = props.media!;
    return (
      <div className={cn('pv relative w-full overflow-hidden rounded-md bg-surface-3', className)} style={{ aspectRatio: m.w && m.h ? `${m.w}/${m.h}` : ratio, maxWidth: '100%' }} role="img" aria-label={label ?? `AI image: ${props.headline}`}>
        {mediaUrl && <img src={mediaUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />}
      </div>
    );
  }
  return (
    <div className={cn('pv relative w-full overflow-hidden rounded-md bg-surface-3', className)} style={{ aspectRatio: ratio, maxWidth: '100%' }} role="img" aria-label={label ?? `${video ? 'Video' : 'Image'} mockup: ${props.headline}`}>
      {video ? <VideoStage {...props} mediaUrl={mediaUrl} /> : <ImageStage {...props} mediaUrl={mediaUrl} />}
      {watermark && url && (
        <span
          className="pointer-events-none absolute z-20 rounded-full font-semibold"
          style={{
            right: cq(3),
            bottom: video ? cq(10) : cq(3),
            padding: `${cq(0.8)} ${cq(2.2)}`,
            fontSize: cq(2.6),
            background: 'rgba(0,0,0,0.42)',
            color: '#fff',
            letterSpacing: '0.02em',
            backdropFilter: 'blur(4px)',
          }}
        >
          {url}
        </span>
      )}
    </div>
  );
}

// ───────────────────────── Image styles ─────────────────────────

function ImageStage({ style, headline, brand, media, mediaUrl, points }: PostVisualProps & { mediaUrl: string | null }) {
  const c = brand.colors;
  const name = brand.name || 'Your Brand';
  const isImg = media?.kind === 'image' && mediaUrl;
  const isVid = media?.kind === 'video' && mediaUrl;
  const mediaEl = isImg ? (
    <img src={mediaUrl!} alt="" className="h-full w-full object-cover" />
  ) : isVid ? (
    <video src={mediaUrl!} muted loop playsInline autoPlay className="h-full w-full object-cover" />
  ) : null;

  switch (style) {
    case 'neon':
      return (
        <div className="absolute inset-0 flex flex-col justify-between" style={{ background: '#0a0a12', padding: cq(6) }}>
          <div className="absolute inset-0" style={{ background: `radial-gradient(60% 50% at 80% 10%, ${withAlpha(c.accent, 0.35)}, transparent 70%), radial-gradient(60% 60% at 10% 100%, ${withAlpha(c.primary, 0.45)}, transparent 70%)` }} />
          <div className="absolute inset-0 opacity-40" style={{ backgroundImage: 'linear-gradient(rgba(255,255,255,.06) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.06) 1px, transparent 1px)', backgroundSize: `${cq(8)} ${cq(8)}` }} />
          {mediaEl && <div className="absolute inset-0 opacity-35 mix-blend-screen">{mediaEl}</div>}
          <div className="relative flex items-center justify-between">
            <span className="font-bold uppercase text-white/80" style={{ fontSize: cq(3), letterSpacing: '0.18em' }}>
              {name}
            </span>
            <span className="rounded font-black uppercase" style={{ fontSize: cq(2.8), padding: `${cq(0.8)} ${cq(1.8)}`, background: c.accent, color: readableOn(c.accent), transform: 'rotate(4deg)' }}>
              New
            </span>
          </div>
          <h3
            className="relative font-poster uppercase leading-[0.95] text-white"
            style={{ fontSize: cq(headline.length > 48 ? 8.4 : 10.5), textShadow: `0 0 ${cq(0.6)} ${c.accent}, 0 0 ${cq(2.4)} ${c.accent}, 0 0 ${cq(6)} ${c.primary}`, animation: 'pv-flicker 4s infinite' }}
          >
            {headline}
          </h3>
          <div className="relative flex items-center gap-[2cqw]">
            <span className="inline-block rounded-full" style={{ width: cq(16), height: cq(1.2), background: c.accent, boxShadow: `0 0 ${cq(2)} ${c.accent}` }} />
            <span className="inline-block rounded-full" style={{ width: cq(6), height: cq(1.2), background: c.primary, boxShadow: `0 0 ${cq(2)} ${c.primary}` }} />
          </div>
        </div>
      );
    case 'editorial': {
      const photo = mediaEl ?? (
        <div className="h-full w-full" style={{ background: `linear-gradient(135deg, ${lighten(c.primary, 0.35)}, ${darken(c.secondary, 0.05)})` }}>
          <div className="h-full w-full" style={{ background: `radial-gradient(30% 40% at 30% 40%, ${withAlpha('#ffffff', 0.55)}, transparent 70%), radial-gradient(25% 30% at 75% 65%, ${withAlpha(c.accent, 0.6)}, transparent 70%), radial-gradient(20% 25% at 60% 20%, ${withAlpha('#ffffff', 0.35)}, transparent 70%)` }} />
        </div>
      );
      return (
        <div className="absolute inset-0 flex flex-col" style={{ background: mix(c.paper, '#fffaf2', 0.5) }}>
          <div className="relative overflow-hidden" style={{ height: '60%' }}>
            {photo}
            <span className="absolute left-[4cqw] top-[4cqw] rounded-sm bg-white/90 font-mono font-semibold uppercase text-black/80" style={{ fontSize: cq(2.3), padding: `${cq(0.5)} ${cq(1.4)}`, letterSpacing: '0.12em' }}>
              Journal
            </span>
          </div>
          <div className="flex flex-1 flex-col justify-center" style={{ padding: `${cq(4)} ${cq(6)}` }}>
            <span className="font-mono uppercase" style={{ fontSize: cq(2.3), letterSpacing: '0.16em', color: withAlpha(c.ink, 0.65) }}>
              Vol. 01 · {name}
            </span>
            <h3 className="font-serif italic leading-[1.05]" style={{ fontSize: cq(headline.length > 50 ? 5.4 : 6.6), color: c.ink, marginTop: cq(1.6) }}>
              {headline}
            </h3>
            <span className="block" style={{ marginTop: cq(2.4), width: cq(12), height: 2, background: c.primary }} />
          </div>
        </div>
      );
    }
    case 'isometric':
      return (
        <div className="absolute inset-0 overflow-hidden" style={{ background: `linear-gradient(160deg, ${darken(c.secondary, 0.25)}, ${darken(c.primary, 0.45)})` }}>
          <div className="absolute inset-0 opacity-30" style={{ backgroundImage: `repeating-linear-gradient(30deg, ${withAlpha('#ffffff', 0.18)} 0 1px, transparent 1px ${cq(6)}), repeating-linear-gradient(150deg, ${withAlpha('#ffffff', 0.18)} 0 1px, transparent 1px ${cq(6)})` }} />
          <div className="absolute left-1/2 top-[40%]" style={{ width: cq(52), height: cq(52), transform: 'translate(-50%,-50%) rotateX(58deg) rotateZ(-45deg)', transformStyle: 'preserve-3d' }}>
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="absolute inset-0 rounded-[2cqw]"
                style={{
                  transform: `translateZ(${cq(i * 7)}) translate(${cq(i * -2)}, ${cq(i * -2)})`,
                  background: i === 2 ? '#ffffff' : i === 1 ? c.accent : c.primary,
                  boxShadow: `${cq(2)} ${cq(2)} ${cq(4)} rgba(0,0,0,0.35)`,
                  animation: `pv-float ${4 + i}s ease-in-out infinite`,
                  animationDelay: `${i * 0.4}s`,
                }}
              >
                {i === 2 && (
                  <div className="flex h-full flex-col gap-[2.4cqw] p-[4cqw]">
                    {mediaEl ? (
                      <div className="h-[60%] overflow-hidden rounded-[1.4cqw]">{mediaEl}</div>
                    ) : (
                      <div className="flex items-center gap-[2cqw]">
                        <LogoMark colors={c} logo={brand.logo} name={name} size={0} className="!h-[9cqw] !w-[9cqw]" />
                        <span className="h-[2cqw] flex-1 rounded-full" style={{ background: withAlpha(c.ink, 0.15) }} />
                      </div>
                    )}
                    {[78, 56, 66].map((w) => (
                      <span key={w} className="h-[2cqw] rounded-full" style={{ width: `${w}%`, background: withAlpha(c.primary, 0.35) }} />
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="absolute inset-x-0 bottom-0" style={{ padding: cq(6) }}>
            <p className="font-mono font-semibold leading-tight text-white" style={{ fontSize: cq(headline.length > 50 ? 4.2 : 5) }}>
              <span style={{ color: c.accent }}>&gt; </span>
              {headline}
              <span className="ml-[1cqw] inline-block align-middle" style={{ width: cq(2.2), height: cq(4.4), background: c.accent, animation: 'pv-blink 1s steps(1) infinite' }} />
            </p>
          </div>
        </div>
      );
    case 'handcrafted': {
      const steps = (points && points.length ? points : ['Start small', 'Stay consistent', 'See it compound']).slice(0, 3);
      const paper = mix('#fbf3e3', c.accent, 0.08);
      return (
        <div className="absolute inset-0 flex flex-col" style={{ background: paper, padding: cq(6), backgroundImage: `radial-gradient(${withAlpha(c.ink, 0.08)} 0.35cqw, transparent 0.4cqw)`, backgroundSize: `${cq(3)} ${cq(3)}` }}>
          <h3 className="font-hand font-bold leading-[0.95]" style={{ fontSize: cq(headline.length > 44 ? 7.6 : 9), color: c.ink }}>
            {headline}
          </h3>
          <svg viewBox="0 0 200 12" className="block" style={{ width: cq(42), marginTop: cq(1) }} aria-hidden="true">
            <path d="M2 8 C 30 2, 50 12, 80 6 S 140 2, 198 7" fill="none" stroke={c.accent} strokeWidth="4" strokeLinecap="round" />
          </svg>
          <ol className="mt-auto flex flex-col" style={{ gap: cq(2.6) }}>
            {steps.map((s, i) => (
              <li key={i} className="flex items-center" style={{ gap: cq(3) }}>
                <span
                  className="flex shrink-0 items-center justify-center font-hand font-bold"
                  style={{ width: cq(10), height: cq(10), fontSize: cq(6), border: `${cq(0.6)} solid ${c.primary}`, color: c.primary, borderRadius: '255px 15px 225px 15px/15px 225px 15px 255px', transform: `rotate(${(i - 1) * 4}deg)` }}
                >
                  {i + 1}
                </span>
                <span className="font-hand leading-tight" style={{ fontSize: cq(5.4), color: c.ink }}>
                  {s.length > 46 ? s.slice(0, 44) + '…' : s}
                </span>
              </li>
            ))}
          </ol>
          <div className="mt-[3cqw] flex items-center justify-between">
            <span className="font-hand" style={{ fontSize: cq(4.2), color: withAlpha(c.ink, 0.7) }}>
              — {name}
            </span>
            <svg viewBox="0 0 24 24" style={{ width: cq(7), height: cq(7) }} aria-hidden="true">
              <path d="M12 2l2.6 6.6L21 9.3l-5 4.6 1.4 7.1L12 17.3 6.6 21l1.4-7.1-5-4.6 6.4-.7z" fill={c.accent} stroke={c.ink} strokeWidth="1" strokeLinejoin="round" />
            </svg>
          </div>
        </div>
      );
    }
    case 'minimal':
    default:
      return (
        <div className="absolute inset-0 flex flex-col items-center" style={{ background: `linear-gradient(165deg, ${lighten(c.primary, 0.9)}, ${lighten(c.accent, 0.82)})`, padding: cq(6) }}>
          <div className="flex w-full items-center" style={{ gap: cq(2) }}>
            <LogoMark colors={c} logo={brand.logo} name={name} size={0} className="!h-[6cqw] !w-[6cqw]" />
            <span className="font-semibold" style={{ fontSize: cq(3), color: c.ink }}>
              {name}
            </span>
          </div>
          <div className="relative my-auto flex items-center justify-center" style={{ width: cq(46), height: cq(46) }}>
            <span className="absolute rounded-[50%] blur-[2px]" style={{ bottom: cq(-4), width: cq(40), height: cq(5), background: withAlpha(c.ink, 0.18) }} />
            <div className="relative flex h-full w-full items-center justify-center overflow-hidden rounded-[4cqw]" style={{ background: `linear-gradient(145deg, ${c.primary}, ${darken(c.secondary, 0.1)})`, boxShadow: `0 ${cq(3)} ${cq(6)} ${withAlpha(c.ink, 0.22)}` }}>
              {mediaEl ?? <Icon name={brand.logo.icon} width="46%" height="46%" color={readableOn(c.primary)} strokeWidth={1.6} />}
            </div>
          </div>
          <h3 className="text-center font-display font-bold leading-[1.08] tracking-[-0.02em]" style={{ fontSize: cq(headline.length > 48 ? 5.4 : 6.6), color: c.ink }}>
            {headline}
          </h3>
        </div>
      );
  }
}

// ───────────────────────── Video styles (animated storyboards) ─────────────────────────

function defaultScenes(headline: string, brand: Brand): Scene[] {
  return [
    { id: 's1', text: headline, shot: '', duration: 2 },
    { id: 's2', text: 'Here’s the problem', shot: '', duration: 3 },
    { id: 's3', text: 'Here’s the fix', shot: '', duration: 3 },
    { id: 's4', text: brand.name || 'Learn more', shot: '', duration: 2 },
  ];
}

function useStoryboard(scenes: Scene[], playing: boolean) {
  const [idx, setIdx] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const total = scenes.reduce((s, x) => s + Math.max(1, x.duration), 0);
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      setElapsed((e) => {
        const next = (e + dt) % total;
        let acc = 0;
        let i = 0;
        for (; i < scenes.length; i++) {
          acc += Math.max(1, scenes[i].duration);
          if (next < acc) break;
        }
        setIdx(Math.min(i, scenes.length - 1));
        return next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, total, scenes]);
  return { idx, elapsed, total };
}

function VideoStage({ style, headline, brand, storyboard, mediaUrl, media, autoPlay, hoverPlay }: PostVisualProps & { mediaUrl: string | null }) {
  const reduced = useMemo(() => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches, []);
  const [playing, setPlaying] = useState(!!autoPlay && !reduced);
  const scenes = storyboard && storyboard.length ? storyboard : defaultScenes(headline, brand);
  const { idx, elapsed, total } = useStoryboard(scenes, playing);
  const scene = scenes[idx] ?? scenes[0];
  const c = brand.colors;
  const name = brand.name || 'Your Brand';
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (playing) v.play().catch(() => undefined);
    else v.pause();
  }, [playing, mediaUrl]);
  const bgMedia =
    media && mediaUrl ? (
      media.kind === 'video' ? (
        <video ref={videoRef} src={mediaUrl} muted loop playsInline className="absolute inset-0 h-full w-full object-cover" />
      ) : (
        <img src={mediaUrl} alt="" className="absolute inset-0 h-full w-full object-cover" style={{ animation: playing ? 'pv-kenburns 9s ease-in-out infinite alternate' : undefined }} />
      )
    ) : null;

  let body: ReactNode;
  const sceneKey = `${scene.id}-${idx}`;
  const caption = (text: string, extra?: CSSProperties) => (
    <p
      key={sceneKey}
      className="text-center font-display font-extrabold leading-[1.08] text-white"
      style={{ fontSize: cq(text.length > 40 ? 6.4 : 8), textShadow: '0 0.4cqw 0 #000, 0 -0.4cqw 0 #000, 0.4cqw 0 0 #000, -0.4cqw 0 0 #000, 0 0.8cqw 2cqw rgba(0,0,0,.4)', animation: 'pv-pop .35s ease-out both', ...extra }}
    >
      {text}
    </p>
  );

  switch (style) {
    case 'kinetic': {
      const bgs = [c.primary, c.accent, darken(c.secondary, 0.05), c.ink];
      const bg = bgs[idx % bgs.length];
      const words = scene.text.split(/\s+/).slice(0, 12);
      body = (
        <div className="absolute inset-0 flex items-center justify-center transition-colors duration-300" style={{ background: bg, padding: cq(8) }}>
          {bgMedia && <div className="absolute inset-0 opacity-25">{bgMedia}</div>}
          <p key={sceneKey} className="relative flex flex-wrap justify-center font-poster uppercase leading-[0.95]" style={{ gap: `0 ${cq(2.4)}`, fontSize: cq(words.length > 6 ? 9 : 12), color: readableOn(bg) }}>
            {words.map((w, i) => (
              <span key={i} className="inline-block" style={{ animation: 'pv-pop .4s cubic-bezier(.2,.9,.3,1.4) both', animationDelay: playing ? `${i * 0.12}s` : '0s' }}>
                {w}
              </span>
            ))}
          </p>
        </div>
      );
      break;
    }
    case 'split': {
      const before = scenes[Math.min(1, scenes.length - 1)]?.text ?? 'Before';
      const after = scenes[Math.min(2, scenes.length - 1)]?.text ?? 'After';
      const showAfter = idx >= 2;
      body = (
        <div className="absolute inset-0 flex flex-col">
          <div className="relative flex flex-1 flex-col items-center justify-center overflow-hidden" style={{ background: '#4b5052', filter: 'saturate(0.2)' }}>
            {bgMedia}
            <div className="absolute inset-0 bg-black/45" />
            <span className="relative rounded font-bold uppercase text-white" style={{ fontSize: cq(3), letterSpacing: '0.18em', padding: `${cq(0.6)} ${cq(1.6)}`, background: 'rgba(0,0,0,.5)' }}>
              Before
            </span>
            <p className="relative text-center font-display font-bold text-white" style={{ fontSize: cq(5.2), padding: `0 ${cq(6)}`, marginTop: cq(2) }}>
              {idx === 0 ? scene.text : before}
            </p>
          </div>
          <div className="relative h-[0.8cqw]" style={{ background: c.accent }} />
          <div className="relative flex flex-1 flex-col items-center justify-center overflow-hidden" style={{ background: `linear-gradient(160deg, ${c.primary}, ${darken(c.secondary, 0.1)})` }}>
            <div className="absolute inset-y-0 left-0 bg-white/10" style={{ width: showAfter ? '100%' : '0%', transition: 'width .6s ease' }} />
            <span className="relative rounded font-bold uppercase" style={{ fontSize: cq(3), letterSpacing: '0.18em', padding: `${cq(0.6)} ${cq(1.6)}`, background: c.accent, color: readableOn(c.accent) }}>
              After
            </span>
            <p className="relative text-center font-display font-bold" style={{ fontSize: cq(5.2), padding: `0 ${cq(6)}`, marginTop: cq(2), color: readableOn(c.primary), opacity: showAfter ? 1 : 0.35, transition: 'opacity .4s' }}>
              {idx >= 3 ? scene.text : after}
            </p>
          </div>
        </div>
      );
      break;
    }
    case 'cinematic':
      body = (
        <div className="absolute inset-0 overflow-hidden bg-black">
          <div className="absolute inset-0" style={{ animation: playing ? 'pv-kenburns 10s ease-in-out infinite alternate' : undefined }}>
            {bgMedia ?? (
              <div className="h-full w-full" style={{ background: `radial-gradient(70% 50% at 70% 35%, ${withAlpha(c.accent, 0.55)}, transparent 70%), radial-gradient(60% 60% at 25% 75%, ${withAlpha(c.primary, 0.75)}, transparent 70%), linear-gradient(180deg, #0c0c0c, ${darken(c.secondary, 0.5)})` }}>
                <div className="absolute left-1/2 top-[42%] -translate-x-1/2 -translate-y-1/2 rounded-[3cqw]" style={{ width: cq(40), height: cq(52), background: `linear-gradient(150deg, ${lighten(c.primary, 0.15)}, ${darken(c.primary, 0.35)})`, boxShadow: `0 ${cq(6)} ${cq(14)} rgba(0,0,0,.6)` }}>
                  <div className="flex h-full items-center justify-center">
                    <Icon name={brand.logo.icon} width="42%" height="42%" color="rgba(255,255,255,.85)" strokeWidth={1.4} />
                  </div>
                </div>
              </div>
            )}
          </div>
          <div className="pointer-events-none absolute inset-[-20%] opacity-[0.16] mix-blend-overlay" style={{ backgroundImage: 'repeating-radial-gradient(circle at 17% 32%, #fff 0 0.08cqw, transparent 0.1cqw 0.9cqw)', animation: playing ? 'pv-grain .6s steps(4) infinite' : undefined }} />
          <div className="absolute inset-x-0 top-0 bg-black" style={{ height: '11%' }} />
          <div className="absolute inset-x-0 bottom-0 bg-black" style={{ height: '11%' }} />
          <p key={sceneKey} className="absolute inset-x-0 text-center font-serif italic text-white" style={{ bottom: '17%', fontSize: cq(scene.text.length > 40 ? 5.4 : 6.6), padding: `0 ${cq(8)}`, animation: 'pv-slide-up .8s ease-out both', textShadow: '0 0.5cqw 2cqw rgba(0,0,0,.6)' }}>
            {scene.text}
          </p>
          {idx === scenes.length - 1 && (
            <div className="absolute left-1/2 top-[14%] -translate-x-1/2 animate-fade-in">
              <LogoMark colors={c} logo={brand.logo} name={name} size={0} className="!h-[10cqw] !w-[10cqw]" />
            </div>
          )}
        </div>
      );
      break;
    case 'talking':
      body = (
        <div className="absolute inset-0 overflow-hidden" style={{ background: `linear-gradient(180deg, ${lighten(c.primary, 0.82)}, ${lighten(c.accent, 0.7)})` }}>
          {bgMedia ?? (
            <div className="absolute left-1/2 top-[30%] -translate-x-1/2 -translate-y-1/2">
              <div className="relative flex items-center justify-center rounded-full" style={{ width: cq(46), height: cq(46), background: `linear-gradient(160deg, ${lighten(c.secondary, 0.25)}, ${c.secondary})` }}>
                <svg viewBox="0 0 100 100" style={{ width: '78%', height: '78%' }} aria-hidden="true">
                  <circle cx="50" cy="38" r="18" fill={lighten(c.secondary, 0.55)} />
                  <path d="M16 96 C18 70 34 60 50 60 C66 60 82 70 84 96 Z" fill={lighten(c.secondary, 0.45)} />
                </svg>
              </div>
              <div className="mt-[3cqw] flex h-[7cqw] items-end justify-center gap-[1cqw]">
                {Array.from({ length: 9 }).map((_, i) => (
                  <span key={i} className="block w-[1.4cqw] origin-bottom rounded-full" style={{ height: '100%', background: c.primary, animation: playing ? `pv-wave ${0.5 + (i % 4) * 0.12}s ease-in-out infinite` : undefined, transform: playing ? undefined : `scaleY(${0.3 + ((i * 37) % 60) / 100})`, animationDelay: `${i * 0.07}s` }} />
                ))}
              </div>
            </div>
          )}
          {idx % 2 === 1 && (
            <div key={`broll-${idx}`} className="absolute right-[4cqw] top-[6cqw] overflow-hidden rounded-[2cqw] border-[0.6cqw] border-white shadow-lg" style={{ width: cq(34), height: cq(42), animation: 'pv-slide-up .45s ease-out both', background: `linear-gradient(140deg, ${c.primary}, ${c.accent})` }}>
              <div className="flex h-full items-center justify-center">
                <Icon name={brand.logo.icon} width="50%" height="50%" color="#fff" strokeWidth={1.6} />
              </div>
              <span className="absolute left-[2cqw] top-[2cqw] rounded bg-black/50 font-bold uppercase text-white" style={{ fontSize: cq(2.2), padding: `${cq(0.3)} ${cq(1)}` }}>
                B-roll
              </span>
            </div>
          )}
          <div className="absolute inset-x-[5cqw] bottom-[13cqw] overflow-hidden rounded-[2cqw]" style={{ background: c.primary, boxShadow: `0 ${cq(2)} ${cq(5)} rgba(0,0,0,.25)` }}>
            <div className="flex items-center gap-[2cqw]" style={{ padding: `${cq(2.4)} ${cq(3)}` }}>
              <span className="shrink-0 rounded-full" style={{ width: cq(2.4), height: cq(2.4), background: c.accent }} />
              <p key={sceneKey} className="font-display font-bold leading-tight" style={{ fontSize: cq(scene.text.length > 40 ? 4.4 : 5.2), color: readableOn(c.primary), animation: 'pv-slide-up .35s ease-out both' }}>
                {scene.text}
              </p>
            </div>
          </div>
        </div>
      );
      break;
    case 'ugc':
    default:
      body = (
        <div className="absolute inset-0 overflow-hidden" style={{ background: `linear-gradient(170deg, ${lighten(c.accent, 0.35)}, ${darken(c.primary, 0.15)})` }}>
          {bgMedia ?? (
            <div className="absolute inset-0" key={`cut-${idx}`} style={{ transform: `scale(${1 + (idx % 2) * 0.12}) translateX(${(idx % 3) - 1}cqw)` }}>
              <svg viewBox="0 0 100 178" preserveAspectRatio="xMidYMax slice" className="absolute inset-0 h-full w-full" aria-hidden="true">
                <circle cx="50" cy="70" r="22" fill={withAlpha('#1a1a1a', 0.55)} />
                <path d="M8 178 C10 125 30 100 50 100 C70 100 90 125 92 178 Z" fill={withAlpha('#1a1a1a', 0.55)} />
              </svg>
            </div>
          )}
          <div className="absolute left-[4cqw] top-[9cqw] flex items-center gap-[1.4cqw] rounded-full bg-black/40 font-bold text-white" style={{ fontSize: cq(2.8), padding: `${cq(0.8)} ${cq(2)}` }}>
            <span className="inline-block rounded-full bg-red-500" style={{ width: cq(2), height: cq(2), animation: 'pv-blink 1s steps(1) infinite' }} />
            {idx === 0 ? 'POV' : `0:${String(Math.floor(elapsed)).padStart(2, '0')}`}
          </div>
          <div className="absolute inset-x-[6cqw] top-[48%] -translate-y-1/2">{caption(scene.text)}</div>
          <div className="absolute bottom-[13cqw] left-[4cqw] flex items-center gap-[2cqw]">
            <LogoMark colors={c} logo={brand.logo} name={name} size={0} className="!h-[7cqw] !w-[7cqw] rounded-full ring-2 ring-white" />
            <span className="font-bold text-white" style={{ fontSize: cq(3.2), textShadow: '0 1px 4px rgba(0,0,0,.6)' }}>
              @{(brand.slug || name).replace(/[^a-z0-9]/gi, '').toLowerCase()}
            </span>
          </div>
        </div>
      );
  }

  return (
    <div className="absolute inset-0" onMouseEnter={() => hoverPlay && !reduced && setPlaying(true)} onMouseLeave={() => hoverPlay && setPlaying(false)}>
      {body}
      <div className="absolute inset-x-[3cqw] top-[3cqw] z-10 flex gap-[1cqw]">
        {scenes.map((s, i) => {
          const start = scenes.slice(0, i).reduce((a, x) => a + Math.max(1, x.duration), 0);
          const pct = i < idx ? 100 : i > idx ? 0 : ((elapsed - start) / Math.max(1, s.duration)) * 100;
          return (
            <span key={s.id + i} className="h-[0.8cqw] flex-1 overflow-hidden rounded-full bg-white/35">
              <span className="block h-full bg-white" style={{ width: `${Math.max(0, Math.min(100, playing ? pct : i === 0 ? 0 : 0))}%` }} />
            </span>
          );
        })}
      </div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setPlaying((p) => !p);
        }}
        className="absolute bottom-[3cqw] left-[3cqw] z-20 flex items-center gap-[1.2cqw] rounded-full bg-black/55 font-semibold text-white backdrop-blur hover:bg-black/70"
        style={{ fontSize: cq(2.8), padding: `${cq(1.2)} ${cq(2.6)}` }}
        aria-label={playing ? 'Pause preview' : 'Play preview'}
      >
        {playing ? <Pause className="h-[3.4cqw] w-[3.4cqw]" /> : <Play className="h-[3.4cqw] w-[3.4cqw] fill-current" />}
        <span className="num">
          {Math.floor(elapsed)}s / {total}s
        </span>
      </button>
    </div>
  );
}

/** Pull numbered steps out of a caption for infographic-style visuals. */
export function pointsFromCaption(caption: string): string[] {
  return caption
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^\d+[.)]\s+/.test(l))
    .map((l) => l.replace(/^\d+[.)]\s+/, '').replace(/[.!]$/, ''))
    .slice(0, 3);
}
