import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { Brand, BrandColors, LogoConfig, LogoFont, LogoShape, MiniLogo } from '@/lib/types';
import { cn, darken, initials, lighten, readableOn } from '@/lib/utils';
import { useMediaUrl } from '@/lib/media';
import { Icon } from '../ui/Icon';

export const LOGO_FONTS: Record<LogoFont, { label: string; family: string; weight: number; spacing: string; transform?: CSSProperties['textTransform'] }> = {
  grotesk: { label: 'Grotesk', family: '"Bricolage Grotesque", system-ui, sans-serif', weight: 700, spacing: '-0.02em' },
  serif: { label: 'Serif', family: 'Fraunces, Georgia, serif', weight: 700, spacing: '-0.01em' },
  rounded: { label: 'Rounded', family: 'Nunito, "Instrument Sans", system-ui, sans-serif', weight: 800, spacing: '-0.01em' },
  mono: { label: 'Mono', family: '"JetBrains Mono", ui-monospace, monospace', weight: 700, spacing: '-0.03em' },
  script: { label: 'Script', family: 'Pacifico, "Brush Script MT", cursive', weight: 400, spacing: '0' },
  poster: { label: 'Poster', family: 'Anton, Impact, sans-serif', weight: 400, spacing: '0.02em', transform: 'uppercase' },
};

export const SHAPES: { id: LogoShape; label: string }[] = [
  { id: 'circle', label: 'Circle' },
  { id: 'rounded', label: 'Rounded' },
  { id: 'hex', label: 'Hexagon' },
  { id: 'shield', label: 'Shield' },
  { id: 'blob', label: 'Organic' },
  { id: 'none', label: 'No shape' },
];

export function shapeEl(shape: LogoShape, fill: string) {
  switch (shape) {
    case 'circle':
      return <circle cx="50" cy="50" r="48" fill={fill} />;
    case 'rounded':
      return <rect x="2" y="2" width="96" height="96" rx="26" fill={fill} />;
    case 'hex':
      return <polygon points="50,2 92,26 92,74 50,98 8,74 8,26" fill={fill} strokeLinejoin="round" />;
    case 'shield':
      return <path d="M50 3 L90 16 V47 C90 73 72 89 50 97 C28 89 10 73 10 47 V16 Z" fill={fill} />;
    case 'blob':
      return <path d="M53 3 C76 4 97 22 96 48 C95 75 76 97 49 97 C23 97 3 77 4 51 C5 24 28 2 53 3 Z" fill={fill} />;
    default:
      return null;
  }
}

/** The symbol part of a logo, rendered as SVG so it can be exported. */
export function LogoMark({ colors, logo, name, size = 40, className }: { colors: BrandColors; logo: LogoConfig; name: string; size?: number; className?: string }) {
  const gid = `g${Math.abs(hashCode(colors.primary + colors.secondary + logo.shape))}`;
  if (logo.mode === 'upload' && logo.uploadDataUrl) {
    return <img src={logo.uploadDataUrl} alt={`${name} logo`} width={size} height={size} className={cn('shrink-0 rounded-md object-contain', className)} style={{ width: size, height: size }} />;
  }
  const none = logo.shape === 'none';
  const fg = none ? colors.primary : readableOn(colors.primary, '#ffffff', darken(colors.secondary, 0.4));
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} className={cn('shrink-0', className)} role="img" aria-label={`${name || 'Brand'} logo mark`}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={lighten(colors.primary, 0.08)} />
          <stop offset="1" stopColor={darken(colors.primary, 0.18)} />
        </linearGradient>
      </defs>
      {shapeEl(logo.shape, `url(#${gid})`)}
      {logo.monogram ? (
        <text x="50" y="51" textAnchor="middle" dominantBaseline="central" fill={fg} style={{ fontFamily: LOGO_FONTS[logo.font].family, fontWeight: LOGO_FONTS[logo.font].weight, fontSize: initials(name).length > 1 ? 40 : 52 }}>
          {initials(name)}
        </text>
      ) : (
        <Icon name={logo.icon} x={none ? 6 : 24} y={none ? 6 : 24} width={none ? 88 : 52} height={none ? 88 : 52} color={fg} strokeWidth={none ? 1.8 : 2.1} />
      )}
      {!none && <circle cx="80" cy="20" r="7" fill={colors.accent} stroke={fg} strokeOpacity="0.15" />}
    </svg>
  );
}

/**
 * Never cut a wordmark: at its normal size the word is measured against the room it has; when it
 * doesn't fit it is scaled down (to 60% at most), and if it still doesn't fit the logo stacks (mark
 * above the word). Measured again when the room changes and once the logo's web font has loaded.
 */
function useFittedWord(base: number, deps: unknown[]) {
  const ref = useRef<HTMLSpanElement>(null);
  const [stack, setStack] = useState(false);
  const stackedAt = useRef(0);
  useLayoutEffect(() => {
    const el = ref.current;
    const root = el?.parentElement;
    const host = root?.parentElement;
    if (!el || !root || !host) return;
    let alive = true;
    const fit = () => {
      if (!alive) return;
      if (stackedAt.current && host.clientWidth > stackedAt.current + 1) {
        stackedAt.current = 0;
        setStack(false);
        return;
      }
      el.style.fontSize = `${base}px`;
      const natural = el.scrollWidth;
      const room = el.clientWidth;
      if (!natural || !room || natural <= room + 1) return;
      const ratio = room / natural;
      if (ratio >= 0.6) el.style.fontSize = `${Math.floor(base * ratio * 10) / 10}px`;
      else if (!stackedAt.current) {
        el.style.fontSize = `${base * 0.6}px`;
        stackedAt.current = host.clientWidth;
        setStack(true);
      }
    };
    fit();
    void document.fonts?.ready.then(fit);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(fit);
    ro.observe(host);
    return () => {
      alive = false;
      ro.disconnect();
    };
  }, [base, stack, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  return { ref, stack };
}

export function BrandLogo({ brand, size = 36, layout, className, textClassName, tone }: { brand: Pick<Brand, 'name' | 'colors' | 'logo'>; size?: number; layout?: LogoConfig['layout']; className?: string; textClassName?: string; tone?: 'auto' | 'light' }) {
  const asked = layout ?? brand.logo.layout;
  const font = LOGO_FONTS[brand.logo.font];
  const name = brand.name || 'Your Brand';
  const fitted = useFittedWord(size * (asked === 'stacked' ? 0.42 : 0.56), [name, brand.logo.font, asked]);
  const l = asked === 'horizontal' && fitted.stack ? 'stacked' : asked;
  const word = (
    <span
      ref={asked === 'stacked' || asked === 'mark' ? undefined : fitted.ref}
      className={cn('block min-w-0 overflow-hidden whitespace-nowrap leading-none', textClassName)}
      style={{ fontFamily: font.family, fontWeight: font.weight, letterSpacing: font.spacing, textTransform: font.transform, fontSize: size * (l === 'stacked' ? 0.42 : 0.56), color: tone === 'light' ? '#fff' : undefined }}
    >
      {name}
    </span>
  );
  if (l === 'mark') return <LogoMark colors={brand.colors} logo={brand.logo} name={name} size={size} className={className} />;
  if (l === 'wordmark')
    return (
      <span className={cn('inline-flex max-w-full min-w-0 items-baseline gap-1', className)}>
        {word}
        <span className="inline-block shrink-0 rounded-full" style={{ width: size * 0.16, height: size * 0.16, background: brand.colors.accent }} />
      </span>
    );
  if (l === 'stacked')
    return (
      <span className={cn('inline-flex max-w-full flex-col items-center gap-2 text-center', className)}>
        <LogoMark colors={brand.colors} logo={brand.logo} name={name} size={size} />
        {word}
      </span>
    );
  return (
    <span className={cn('inline-flex max-w-full min-w-0 items-center', className)} style={{ gap: size * 0.28 }}>
      <LogoMark colors={brand.colors} logo={brand.logo} name={name} size={size} />
      {word}
    </span>
  );
}

export function MiniMark({ logo, size = 28, name = '' }: { logo?: MiniLogo; size?: number; name?: string }) {
  if (!logo) return <span className="inline-flex shrink-0 items-center justify-center rounded-full bg-surface-3 text-[10px] font-bold text-ink-2" style={{ width: size, height: size }}>{initials(name)}</span>;
  if (logo.dataUrl) return <img src={logo.dataUrl} alt="" className="shrink-0 rounded-full object-cover" style={{ width: size, height: size }} />;
  return (
    <LogoMark
      colors={{ primary: logo.color, secondary: darken(logo.color, 0.4), accent: lighten(logo.color, 0.5), ink: '#111', paper: '#fff' }}
      logo={{ mode: 'generated', icon: logo.icon, shape: logo.shape === 'none' ? 'circle' : logo.shape, layout: 'mark', font: 'grotesk', monogram: false }}
      name={name}
      size={size}
    />
  );
}

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

// ───────────────────────── Banner ─────────────────────────

/**
 * How big the banner can set the business name so the whole of it fits `width` px (measured in the
 * logo's font); under `min` px it wraps onto more lines instead. Never cut.
 */
export function bannerNameSize(name: string, font: (typeof LOGO_FONTS)[LogoFont], { max = 84, min = 44, width = 860 } = {}): { size: number; wrap: boolean } {
  const ctx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
  if (!ctx) return { size: max, wrap: name.length > 18 };
  const text = font.transform === 'uppercase' ? name.toUpperCase() : name;
  ctx.font = `${font.weight} ${max}px ${font.family}`;
  const em = Number.parseFloat(font.spacing) || 0; // letter spacing, in em
  const w = ctx.measureText(text).width + text.length * em * max;
  if (w <= width) return { size: max, wrap: false };
  const size = Math.floor((max * width) / w);
  return size >= min ? { size, wrap: false } : { size: min, wrap: true };
}

export function BrandBanner({ brand, className, rounded = true }: { brand: Brand; className?: string; rounded?: boolean }) {
  // measure again once the logo's web font has loaded (its width differs from the fallback's)
  const [, setFontsReady] = useState(0);
  useEffect(() => {
    let alive = true;
    void document.fonts?.ready.then(() => alive && setFontsReady((n) => n + 1));
    return () => {
      alive = false;
    };
  }, []);
  const c = brand.colors;
  const style = brand.banner.style;
  const imgUrl = useMediaUrl(brand.banner.imageId ? brand.images.find((m) => m.id === brand.banner.imageId) ?? null : null);
  const font = LOGO_FONTS[brand.logo.font];
  const dark = style !== 'blobs';
  const ink = dark ? '#ffffff' : c.ink;
  const name = brand.name || 'Your Brand';
  const id = `b${Math.abs(hashCode(name + c.primary + style))}`;
  const nameFit = bannerNameSize(name, font);
  return (
    <svg viewBox="0 0 1500 500" className={cn('block h-auto w-full', rounded && 'rounded-lg', className)} role="img" aria-label={`${name} cover banner`} preserveAspectRatio="xMidYMid slice">
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={c.primary} />
          <stop offset="1" stopColor={c.secondary} />
        </linearGradient>
        <radialGradient id={`${id}-glow`} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor={c.accent} stopOpacity="0.9" />
          <stop offset="1" stopColor={c.accent} stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`${id}-blob1`} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor={c.primary} stopOpacity="0.55" />
          <stop offset="1" stopColor={c.primary} stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}-shade`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#000" stopOpacity="0.72" />
          <stop offset="0.7" stopColor="#000" stopOpacity="0.1" />
        </linearGradient>
        <pattern id={`${id}-grid`} width="50" height="50" patternUnits="userSpaceOnUse">
          <path d="M50 0H0V50" fill="none" stroke="#ffffff" strokeOpacity="0.09" strokeWidth="1.5" />
        </pattern>
      </defs>
      {style === 'waves' && (
        <>
          <rect width="1500" height="500" fill={`url(#${id}-bg)`} />
          <path d="M0 360 C250 300 420 430 720 380 C1020 330 1180 250 1500 300 V500 H0 Z" fill={c.accent} opacity="0.85" />
          <path d="M0 410 C300 360 520 470 820 430 C1120 390 1270 340 1500 370 V500 H0 Z" fill={lighten(c.primary, 0.2)} opacity="0.9" />
          <path d="M0 455 C320 420 640 500 960 470 C1200 448 1350 430 1500 440 V500 H0 Z" fill={darken(c.secondary, 0.1)} />
        </>
      )}
      {style === 'grid' && (
        <>
          <rect width="1500" height="500" fill={darken(c.secondary, 0.15)} />
          <rect width="1500" height="500" fill={`url(#${id}-grid)`} />
          <circle cx="1180" cy="250" r="320" fill={`url(#${id}-glow)`} opacity="0.65" />
          <circle cx="1180" cy="250" r="150" fill="none" stroke={c.accent} strokeWidth="3" opacity="0.7" />
          <circle cx="1180" cy="250" r="220" fill="none" stroke={c.primary} strokeWidth="2" opacity="0.6" />
        </>
      )}
      {style === 'blobs' && (
        <>
          <rect width="1500" height="500" fill={c.paper} />
          <circle cx="1220" cy="120" r="300" fill={`url(#${id}-blob1)`} />
          <circle cx="980" cy="430" r="260" fill={`url(#${id}-glow)`} opacity="0.55" />
          <circle cx="1390" cy="420" r="90" fill={c.accent} opacity="0.85" />
          <circle cx="1060" cy="180" r="34" fill={c.primary} />
        </>
      )}
      {style === 'split' && (
        <>
          <rect width="1500" height="500" fill={c.paper} />
          <rect width="860" height="500" fill={`url(#${id}-bg)`} />
          {Array.from({ length: 12 }).map((_, i) => (
            <g key={i} transform={`translate(${920 + (i % 4) * 145} ${40 + Math.floor(i / 4) * 150})`} opacity={0.18 + (i % 3) * 0.2}>
              <Icon name={brand.logo.icon} width={92} height={92} color={i % 2 ? c.primary : c.accent} strokeWidth={1.6} />
            </g>
          ))}
        </>
      )}
      {style === 'photo' && (
        <>
          <rect width="1500" height="500" fill={`url(#${id}-bg)`} />
          {imgUrl && <image href={imgUrl} x="0" y="0" width="1500" height="500" preserveAspectRatio="xMidYMid slice" />}
          <rect width="1500" height="500" fill={`url(#${id}-shade)`} />
        </>
      )}
      <g transform={nameFit.wrap ? 'translate(110 95)' : 'translate(110 150)'}>
        <foreignObject x="0" y="0" width="1000" height={nameFit.wrap ? 320 : 230}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18, color: ink, fontFamily: '"Instrument Sans", system-ui, sans-serif' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
              <LogoMark colors={style === 'blobs' ? c : { ...c, primary: style === 'split' || style === 'waves' ? '#ffffff' : c.primary }} logo={style === 'split' || style === 'waves' ? { ...brand.logo, shape: brand.logo.shape } : brand.logo} name={name} size={104} />
              <span style={{ fontFamily: font.family, fontWeight: font.weight, letterSpacing: font.spacing, textTransform: font.transform, fontSize: nameFit.size, lineHeight: nameFit.wrap ? 1.05 : 1, whiteSpace: nameFit.wrap ? 'normal' : 'nowrap', overflowWrap: 'anywhere', maxWidth: 860 }}>{name}</span>
            </div>
            {brand.banner.showTagline && brand.tagline && <span style={{ fontSize: 34, opacity: 0.92, maxWidth: 760, lineHeight: 1.25 }}>{brand.tagline}</span>}
          </div>
        </foreignObject>
      </g>
    </svg>
  );
}
