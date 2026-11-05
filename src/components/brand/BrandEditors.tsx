import { useState } from 'react';
import { Check, Download, ImagePlus, Shapes, Trash2, Upload } from 'lucide-react';
import type { Brand, BrandColors, LogoConfig, MediaRef, SocialPlatform } from '@/lib/types';
import { cn, darken, lighten, resizeImage, uid } from '@/lib/utils';
import { putBlob } from '@/lib/storage';
import { LOGO_ICONS, PLATFORMS, SOCIAL_PLATFORMS } from '@/ai/knowledge';
import { paletteFrom } from '@/ai/local/brand';
import { toast } from '@/store/ui';
import { Icon } from '../ui/Icon';
import { ColorInput, Field, Segmented, SettingsRow, Spinner, Toggle } from '../ui/primitives';
import { BrandBanner, BrandLogo, LOGO_FONTS, LogoMark, SHAPES } from './Logo';
import { MediaDrop, MediaThumb } from '../media/MediaUpload';
import { download } from '../ui/download';
import { PlatformGlyph } from '../posts/PlatformIcon';
import { VoiceNote, VoiceSwitch } from './SocialVoice';

/**
 * The logo, its colours and how they look together: the controls, and beside them (on wide screens, sticky)
 * the brand as people see it: banner, logo and name, tagline and palette, with the mark at small sizes.
 */
export function LogoDesigner({ brand, onChange, iconOptions, paletteOptions, withBanner }: { brand: Brand; onChange: (patch: Partial<Brand>) => void; iconOptions?: string[]; paletteOptions?: BrandColors[]; withBanner?: boolean }) {
  const [showAll, setShowAll] = useState(false);
  const logo = brand.logo;
  const setLogo = (p: Partial<LogoConfig>) => onChange({ logo: { ...logo, ...p } });
  const icons = showAll ? LOGO_ICONS.map((i) => i.name) : (iconOptions?.length ? iconOptions : LOGO_ICONS.slice(0, 12).map((i) => i.name));
  const picked = (on: boolean) => (on ? 'border-primary-line bg-primary-soft text-primary' : 'border-line-2 text-ink-2 hover:border-line-3 hover:text-ink');
  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_272px]">
      <BrandCard brand={brand} className="xl:sticky xl:top-4 xl:order-2 xl:self-start" />
      <div className="flex min-w-0 flex-col gap-5">
        <Field label="Logo source">
          <Segmented
            options={[
              { id: 'generated', label: 'AI logo concept' },
              { id: 'upload', label: 'Upload my logo' },
            ]}
            value={logo.mode}
            onChange={(v) => setLogo({ mode: v })}
          />
        </Field>
        {logo.mode === 'upload' ? (
          <LogoUploader logo={logo} onChange={setLogo} />
        ) : (
          <>
            <Field
              label="Icon"
              right={
                <button type="button" className="link text-caption" onClick={() => setShowAll((v) => !v)}>
                  {showAll ? 'Show suggested' : 'Browse all icons'}
                </button>
              }
            >
              <div className="scroll-thin flex max-h-[148px] flex-wrap gap-1.5 overflow-y-auto p-0.5">
                {icons.map((name) => {
                  const on = logo.icon === name && !logo.monogram;
                  return (
                    <button key={name} type="button" title={name} onClick={() => setLogo({ icon: name, monogram: false })} className={cn('flex h-10 w-10 items-center justify-center rounded-md border transition-colors duration-120', picked(on))} aria-label={`Use ${name} icon`} aria-pressed={on}>
                      <Icon name={name} size={18} />
                    </button>
                  );
                })}
                <button type="button" onClick={() => setLogo({ monogram: !logo.monogram })} className={cn('flex h-10 min-w-10 items-center justify-center rounded-md border px-2 font-brand text-[13px] font-bold transition-colors duration-120', picked(logo.monogram))} aria-pressed={logo.monogram} aria-label="Use your initials">
                  Aa
                </button>
              </div>
            </Field>
            <Field label="Shape">
              <div className="flex flex-wrap gap-1.5">
                {SHAPES.map((s) => (
                  <button key={s.id} type="button" className={cn('chip', logo.shape === s.id && 'chip-active')} aria-pressed={logo.shape === s.id} onClick={() => setLogo({ shape: s.id })}>
                    {logo.shape === s.id && <Check aria-hidden="true" />}
                    {s.label}
                  </button>
                ))}
              </div>
            </Field>
          </>
        )}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Wordmark font" htmlFor="logo-font">
            <select id="logo-font" className="select" value={logo.font} onChange={(e) => setLogo({ font: e.target.value as LogoConfig['font'] })}>
              {Object.entries(LOGO_FONTS).map(([id, f]) => (
                <option key={id} value={id}>
                  {f.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Layout" htmlFor="logo-layout">
            <select id="logo-layout" className="select" value={logo.layout} onChange={(e) => setLogo({ layout: e.target.value as LogoConfig['layout'] })}>
              <option value="horizontal">Icon + name</option>
              <option value="stacked">Stacked</option>
              <option value="mark">Icon only</option>
              <option value="wordmark">Name only</option>
            </select>
          </Field>
        </div>
        <PaletteEditor colors={brand.colors} onChange={(colors) => onChange({ colors })} options={paletteOptions} />
        {withBanner && (
          <Field label="Cover banner">
            <BannerControls brand={brand} onChange={onChange} />
          </Field>
        )}
      </div>
    </div>
  );
}

/** The brand as people see it (a product frame): banner, logo and name, tagline, palette; then the mark at small sizes. */
export function BrandCard({ brand, className, marks = true }: { brand: Brand; className?: string; marks?: boolean }) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-3', className)}>
      <div className="overflow-hidden rounded-stage border border-line bg-surface shadow-product" aria-label="Brand preview" role="img">
        <BrandBanner brand={brand} rounded={false} className="aspect-[3/1] w-full" />
        <div className="flex flex-col gap-2.5 p-4" style={{ background: brand.colors.paper, color: brand.colors.ink }}>
          <BrandLogo brand={brand} size={34} layout={brand.logo.layout === 'mark' || brand.logo.layout === 'wordmark' ? brand.logo.layout : 'horizontal'} />
          {brand.tagline && <p className="clamp-2 text-small opacity-80">{brand.tagline}</p>}
          <div className="mt-1 flex gap-1">
            {(['primary', 'secondary', 'accent', 'ink', 'paper'] as const).map((k) => (
              <span key={k} className="h-6 flex-1 rounded-xs ring-1 ring-inset ring-black/10" style={{ background: brand.colors[k] }} title={`${k}: ${brand.colors[k]}`} />
            ))}
          </div>
        </div>
      </div>
      {marks && (
        <div className="flex items-center gap-3 rounded-pop px-3 py-2.5" style={{ background: darken(brand.colors.secondary, 0.25) }}>
          <LogoMark colors={brand.colors} logo={brand.logo} name={brand.name} size={40} />
          <LogoMark colors={brand.colors} logo={brand.logo} name={brand.name} size={28} />
          <LogoMark colors={brand.colors} logo={brand.logo} name={brand.name} size={18} />
          <span className="ml-auto">
            <BrandLogo brand={brand} size={22} tone="light" layout="wordmark" />
          </span>
        </div>
      )}
      {marks && <LogoExport brand={brand} />}
    </div>
  );
}

export function PaletteEditor({ colors, onChange, options }: { colors: BrandColors; onChange: (c: BrandColors) => void; options?: BrandColors[] }) {
  return (
    <div className="flex flex-col gap-4">
      {options && options.length > 0 && (
        <Field label="Palette suggestions">
          <div className="flex flex-wrap gap-2.5 p-0.5">
            {options.map((p, i) => {
              const active = p.primary === colors.primary && p.accent === colors.accent;
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => onChange(p)}
                  className={cn('flex overflow-hidden rounded-md ring-offset-2 ring-offset-surface transition-shadow duration-120', active ? 'ring-[1.5px] ring-primary' : 'ring-1 ring-line-2 hover:ring-line-3')}
                  aria-label={`Palette ${i + 1}`}
                  aria-pressed={active}
                >
                  {[p.primary, p.secondary, p.accent, p.paper].map((c, k) => (
                    <span key={k} className="h-8 w-7" style={{ background: c }} />
                  ))}
                </button>
              );
            })}
          </div>
        </Field>
      )}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field label="Primary">
          <ColorInput value={colors.primary} onChange={(v) => onChange({ ...paletteFrom([v, colors.secondary, colors.accent]) })} label="Primary color" />
        </Field>
        <Field label="Secondary">
          <ColorInput value={colors.secondary} onChange={(v) => onChange({ ...colors, secondary: v, ink: paletteFrom([colors.primary, v, colors.accent]).ink })} label="Secondary color" />
        </Field>
        <Field label="Accent">
          <ColorInput value={colors.accent} onChange={(v) => onChange({ ...colors, accent: v })} label="Accent color" />
        </Field>
      </div>
    </div>
  );
}

export function LogoUploader({ logo, onChange }: { logo: LogoConfig; onChange: (p: Partial<LogoConfig>) => void }) {
  return (
    <div className="flex items-center gap-4">
      <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-pop border border-line bg-surface-2">
        {logo.uploadDataUrl ? <img src={logo.uploadDataUrl} alt="Uploaded logo" className="h-full w-full object-contain" /> : <ImagePlus size={20} className="text-muted" aria-hidden="true" />}
      </div>
      <div className="flex min-w-0 flex-col items-start gap-1.5">
        <span className="flex flex-wrap items-center gap-2">
          <label className="btn btn-secondary btn-sm cursor-pointer">
            <Upload /> {logo.uploadDataUrl ? 'Replace logo' : 'Upload logo'}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                try {
                  const r = await resizeImage(f, 256, 'image/png');
                  onChange({ uploadDataUrl: r.dataUrl, mode: 'upload' });
                } catch (err) {
                  toast({ kind: 'error', title: 'Couldn’t read that logo', body: (err as Error).message });
                }
              }}
            />
          </label>
          {logo.uploadDataUrl && (
            <button type="button" className="btn btn-danger-ghost btn-sm" onClick={() => onChange({ uploadDataUrl: undefined, mode: 'generated' })}>
              Remove upload
            </button>
          )}
        </span>
        <span className="text-caption text-muted">PNG, JPG, WebP or SVG. Resized to 256px.</span>
      </div>
    </div>
  );
}

function LogoExport({ brand }: { brand: Brand }) {
  const exportPng = async () => {
    const svg = document.querySelector<SVGSVGElement>('[data-logo-export] svg');
    if (!svg) return;
    const xml = new XMLSerializer().serializeToString(svg);
    const img = new Image();
    const blobUrl = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml' }));
    img.onload = async () => {
      const c = document.createElement('canvas');
      c.width = 1024;
      c.height = 1024;
      c.getContext('2d')?.drawImage(img, 0, 0, 1024, 1024);
      URL.revokeObjectURL(blobUrl);
      c.toBlob(async (b) => {
        if (!b) return;
        await download(`${(brand.slug || 'logo').replace(/[^a-z0-9-]/g, '')}-mark.png`, b);
      }, 'image/png');
    };
    img.src = blobUrl;
  };
  const exportSvg = async () => {
    const svg = document.querySelector<SVGSVGElement>('[data-logo-export] svg');
    if (!svg) return;
    const xml = new XMLSerializer().serializeToString(svg);
    await download(`${(brand.slug || 'logo').replace(/[^a-z0-9-]/g, '')}-mark.svg`, xml);
  };
  const uploaded = brand.logo.mode === 'upload';
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div data-logo-export className="hidden">
        <LogoMark colors={brand.colors} logo={brand.logo} name={brand.name} size={512} />
      </div>
      <button type="button" className="btn btn-secondary btn-xs" onClick={exportSvg} disabled={uploaded}>
        <Download /> Mark as SVG
      </button>
      <button type="button" className="btn btn-secondary btn-xs" onClick={exportPng} disabled={uploaded}>
        <Download /> Mark as PNG
      </button>
    </div>
  );
}

export function BannerDesigner({ brand, onChange }: { brand: Brand; onChange: (patch: Partial<Brand>) => void }) {
  return (
    <div className="flex flex-col gap-4">
      <BrandBanner brand={brand} className="rounded-pop border border-line" />
      <BannerControls brand={brand} onChange={onChange} />
    </div>
  );
}

/** The banner's style, its tagline, and (for a photo banner) which photo. */
function BannerControls({ brand, onChange }: { brand: Brand; onChange: (patch: Partial<Brand>) => void }) {
  const styles: { id: Brand['banner']['style']; label: string }[] = [
    { id: 'waves', label: 'Waves' },
    { id: 'grid', label: 'Grid glow' },
    { id: 'blobs', label: 'Soft shapes' },
    { id: 'split', label: 'Split pattern' },
    { id: 'photo', label: 'Photo' },
  ];
  const photos = brand.images.filter((m) => m.kind === 'image');
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Banner style">
          {styles.map((s) => {
            const on = brand.banner.style === s.id;
            const noPhoto = s.id === 'photo' && !photos.length;
            return (
              <button
                key={s.id}
                type="button"
                className={cn('chip disabled:cursor-not-allowed disabled:border-line disabled:text-faint', on && 'chip-active')}
                aria-pressed={on}
                disabled={noPhoto}
                title={noPhoto ? 'Add a brand image first' : undefined}
                onClick={() => onChange({ banner: { ...brand.banner, style: s.id, imageId: s.id === 'photo' ? brand.banner.imageId ?? photos[0]?.id : brand.banner.imageId } })}
              >
                {on && <Check aria-hidden="true" />}
                {s.label}
              </button>
            );
          })}
        </div>
        <Toggle checked={brand.banner.showTagline} onChange={(v) => onChange({ banner: { ...brand.banner, showTagline: v } })} label="Show tagline" />
      </div>
      {brand.banner.style === 'photo' && photos.length > 1 && (
        <div className="flex flex-wrap gap-2 p-0.5" role="group" aria-label="Banner photo">
          {photos.map((m) => {
            const on = brand.banner.imageId === m.id;
            return (
              <button key={m.id} type="button" aria-pressed={on} aria-label={m.name || 'Photo'} onClick={() => onChange({ banner: { ...brand.banner, imageId: m.id } })} className={cn('h-12 w-16 overflow-hidden rounded-md ring-offset-2 ring-offset-surface', on ? 'ring-[1.5px] ring-primary' : 'ring-1 ring-line-2 hover:ring-line-3')}>
                <MediaThumb media={m} className="h-full w-full" />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

const SOCIAL_PLACEHOLDER: Record<SocialPlatform, string> = {
  instagram: '@yourhandle',
  facebook: 'Page name or facebook.com/…',
  tiktok: '@yourhandle',
  linkedin: 'linkedin.com/company/…',
  x: '@yourhandle',
  youtube: '@yourchannel',
};

/**
 * Your profile links or handles, one row per network: its colour tile joined to the field. Nothing is
 * connected: they show in post previews and tell Manus which account to post as. With `projectId`, each
 * profile also gets the "Learn my brand voice" switch (Manus reads its posts); `voiceSetup` says how to
 * point at a missing Manus setup (see VoiceNote). Rows sit inside a SettingsSection (or anything padded alike).
 */
export function SocialLinksEditor({ socials, onChange, projectId, voiceSetup }: { socials: Brand['socials']; onChange: (s: Brand['socials']) => void; projectId?: string; voiceSetup?: 'button' | 'text' | 'none' }) {
  return (
    <div>
      {SOCIAL_PLATFORMS.map((p: SocialPlatform) => (
        <SettingsRow key={p} label={PLATFORMS[p].label} htmlFor={`soc-${p}`}>
          <div className="w-full md:max-w-[420px]">
            <div className="flex w-full">
              <span className="flex w-9 shrink-0 items-center justify-center rounded-l-md text-white max-sm:w-11" style={{ background: PLATFORMS[p].color }} aria-hidden="true">
                <PlatformGlyph platform={p} size={16} />
              </span>
              <input id={`soc-${p}`} className="input min-w-0 rounded-l-none border-l-0" placeholder={SOCIAL_PLACEHOLDER[p]} value={socials[p] ?? ''} onChange={(e) => onChange({ ...socials, [p]: e.target.value })} autoCapitalize="none" spellCheck={false} />
            </div>
            {projectId && <VoiceSwitch projectId={projectId} platform={p} />}
          </div>
        </SettingsRow>
      ))}
      {projectId && (
        <div className="border-t border-line py-4">
          <VoiceNote projectId={projectId} setup={voiceSetup} />
        </div>
      )}
    </div>
  );
}

/** Draws simple brand-colored preset images (product shots / textures) for users without photos. */
async function makePresets(colors: BrandColors, icon: string, name: string): Promise<MediaRef[]> {
  const variants = [
    { bg: [lighten(colors.primary, 0.85), lighten(colors.accent, 0.75)], shape: colors.primary, label: 'Studio shot' },
    { bg: [darken(colors.secondary, 0.1), colors.primary], shape: colors.accent, label: 'Bold backdrop' },
    { bg: [lighten(colors.accent, 0.6), colors.paper], shape: colors.secondary, label: 'Flat lay' },
  ];
  const out: MediaRef[] = [];
  for (const v of variants) {
    const canvas = document.createElement('canvas');
    canvas.width = 900;
    canvas.height = 900;
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;
    const g = ctx.createLinearGradient(0, 0, 900, 900);
    g.addColorStop(0, v.bg[0]);
    g.addColorStop(1, v.bg[1]);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 900, 900);
    for (let i = 0; i < 6; i++) {
      ctx.globalAlpha = 0.12;
      ctx.fillStyle = i % 2 ? colors.accent : '#ffffff';
      ctx.beginPath();
      ctx.arc(120 + i * 140, 160 + ((i * 97) % 520), 90 + (i % 3) * 40, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.ellipse(450, 700, 230, 34, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = v.shape;
    const r = 60;
    ctx.beginPath();
    ctx.moveTo(250 + r, 230);
    ctx.arcTo(650, 230, 650, 690, r);
    ctx.arcTo(650, 690, 250, 690, r);
    ctx.arcTo(250, 690, 250, 230, r);
    ctx.arcTo(250, 230, 650, 230, r);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.globalAlpha = 0.9;
    ctx.font = '700 64px "Bricolage Grotesque", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText((name || 'Brand').slice(0, 14), 450, 480);
    ctx.globalAlpha = 1;
    const blob: Blob | null = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.86));
    if (!blob) continue;
    const id = uid('media');
    await putBlob(id, blob);
    const thumbCanvas = document.createElement('canvas');
    thumbCanvas.width = 240;
    thumbCanvas.height = 240;
    thumbCanvas.getContext('2d')?.drawImage(canvas, 0, 0, 240, 240);
    out.push({ id, kind: 'image', name: `${v.label} (${icon}).jpg`, mime: 'image/jpeg', size: blob.size, createdAt: Date.now(), w: 900, h: 900, thumb: thumbCanvas.toDataURL('image/jpeg', 0.7) });
  }
  return out;
}

export function BrandImagesEditor({ brand, onChange }: { brand: Brand; onChange: (images: MediaRef[]) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-col gap-4">
      <MediaDrop multiple onFiles={(m) => onChange([...brand.images, ...m].slice(0, 24))} label="Drop product or brand photos" sub="Images or short videos · used in posts, banners and listings" compact />
      {brand.images.length > 0 && (
        <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 md:grid-cols-8">
          {brand.images.map((m) => (
            <MediaThumb key={m.id} media={m} className="aspect-square" onRemove={() => onChange(brand.images.filter((x) => x.id !== m.id))} />
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-auto text-small text-muted">{brand.images.length ? `${brand.images.length} in your gallery` : 'No photos yet? Start with brand-coloured presets.'}</span>
        {brand.images.length > 0 && (
          <button type="button" className="btn btn-danger-ghost btn-xs" onClick={() => onChange([])}>
            <Trash2 /> Clear gallery
          </button>
        )}
        <button
          type="button"
          className="btn btn-secondary btn-xs"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const presets = await makePresets(brand.colors, brand.logo.icon, brand.name);
            onChange([...brand.images, ...presets]);
            setBusy(false);
          }}
        >
          {busy ? <Spinner size={14} /> : <Shapes />} Add sample presets
        </button>
      </div>
    </div>
  );
}
