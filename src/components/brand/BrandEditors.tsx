import { useState } from 'react';
import { Download, ImagePlus, Trash2, Upload, Wand2 } from 'lucide-react';
import type { Brand, BrandColors, LogoConfig, MediaRef, SocialPlatform } from '@/lib/types';
import { cn, darken, lighten, resizeImage, uid } from '@/lib/utils';
import { putBlob } from '@/lib/storage';
import { LOGO_ICONS, PLATFORMS, SOCIAL_PLATFORMS } from '@/ai/knowledge';
import { paletteFrom } from '@/ai/local/brand';
import { toast } from '@/store/ui';
import { Icon } from '../ui/Icon';
import { ColorInput, Field, Segmented, Toggle } from '../ui/primitives';
import { BrandBanner, BrandLogo, LOGO_FONTS, LogoMark, SHAPES } from './Logo';
import { MediaDrop, MediaThumb } from '../media/MediaUpload';
import { download } from '../ui/download';
import { PlatformGlyph } from '../posts/PlatformIcon';

export function LogoDesigner({ brand, onChange, iconOptions, paletteOptions }: { brand: Brand; onChange: (patch: Partial<Brand>) => void; iconOptions?: string[]; paletteOptions?: BrandColors[] }) {
  const [showAll, setShowAll] = useState(false);
  const logo = brand.logo;
  const setLogo = (p: Partial<LogoConfig>) => onChange({ logo: { ...logo, ...p } });
  const icons = showAll ? LOGO_ICONS.map((i) => i.name) : (iconOptions?.length ? iconOptions : LOGO_ICONS.slice(0, 12).map((i) => i.name));
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      <div className="flex flex-col gap-3">
        <div className="flex min-h-[150px] items-center justify-center overflow-hidden rounded-lg border border-line p-6" style={{ background: brand.colors.paper, color: brand.colors.ink }}>
          <BrandLogo brand={brand} size={64} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex h-[96px] items-center justify-center rounded-lg" style={{ background: darken(brand.colors.secondary, 0.25) }}>
            <BrandLogo brand={brand} size={36} tone="light" />
          </div>
          <div className="flex h-[96px] items-center justify-center gap-3 rounded-lg border border-line bg-surface">
            <LogoMark colors={brand.colors} logo={logo} name={brand.name} size={52} />
            <LogoMark colors={brand.colors} logo={logo} name={brand.name} size={28} />
            <LogoMark colors={brand.colors} logo={logo} name={brand.name} size={18} />
          </div>
        </div>
        <LogoExport brand={brand} />
      </div>
      <div className="flex min-w-0 flex-col gap-4">
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
            <Field label="Icon" right={<button className="link" onClick={() => setShowAll((s) => !s)}>{showAll ? 'Show suggested' : 'Browse all icons'}</button>}>
              <div className="scroll-thin flex max-h-[148px] flex-wrap gap-1.5 overflow-y-auto">
                {icons.map((name) => (
                  <button
                    key={name}
                    type="button"
                    title={name}
                    onClick={() => setLogo({ icon: name, monogram: false })}
                    className={cn('flex h-10 w-10 items-center justify-center rounded-md border transition-colors', logo.icon === name && !logo.monogram ? 'border-primary bg-primary-soft text-primary' : 'border-line text-ink-2 hover:bg-surface-2')}
                    aria-label={`Use ${name} icon`}
                    aria-pressed={logo.icon === name && !logo.monogram}
                  >
                    <Icon name={name} size={18} />
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setLogo({ monogram: !logo.monogram })}
                  className={cn('flex h-10 min-w-10 items-center justify-center rounded-md border px-2 font-display text-[13px] font-bold', logo.monogram ? 'border-primary bg-primary-soft text-primary' : 'border-line text-ink-2 hover:bg-surface-2')}
                  aria-pressed={logo.monogram}
                >
                  Aa
                </button>
              </div>
            </Field>
            <Field label="Shape">
              <div className="flex flex-wrap gap-1.5">
                {SHAPES.map((s) => (
                  <button key={s.id} type="button" className={cn('chip', logo.shape === s.id && 'chip-active')} onClick={() => setLogo({ shape: s.id })}>
                    {s.label}
                  </button>
                ))}
              </div>
            </Field>
          </>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Wordmark font">
            <select className="select" value={logo.font} onChange={(e) => setLogo({ font: e.target.value as LogoConfig['font'] })}>
              {Object.entries(LOGO_FONTS).map(([id, f]) => (
                <option key={id} value={id}>
                  {f.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Layout">
            <select className="select" value={logo.layout} onChange={(e) => setLogo({ layout: e.target.value as LogoConfig['layout'] })}>
              <option value="horizontal">Icon + name</option>
              <option value="stacked">Stacked</option>
              <option value="mark">Icon only</option>
              <option value="wordmark">Name only</option>
            </select>
          </Field>
        </div>
        <PaletteEditor colors={brand.colors} onChange={(colors) => onChange({ colors })} options={paletteOptions} />
      </div>
    </div>
  );
}

export function PaletteEditor({ colors, onChange, options }: { colors: BrandColors; onChange: (c: BrandColors) => void; options?: BrandColors[] }) {
  return (
    <div className="flex flex-col gap-3">
      {options && options.length > 0 && (
        <Field label="Palette suggestions">
          <div className="flex flex-wrap gap-2">
            {options.map((p, i) => {
              const active = p.primary === colors.primary && p.accent === colors.accent;
              return (
                <button key={i} type="button" onClick={() => onChange(p)} className={cn('flex overflow-hidden rounded-md border-2', active ? 'border-ink' : 'border-transparent hover:border-line-2')} aria-label={`Palette ${i + 1}`} aria-pressed={active}>
                  {[p.primary, p.secondary, p.accent, p.paper].map((c, k) => (
                    <span key={k} className="h-8 w-7" style={{ background: c }} />
                  ))}
                </button>
              );
            })}
          </div>
        </Field>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
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
    <div className="flex items-center gap-3">
      <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-line bg-surface-2">
        {logo.uploadDataUrl ? <img src={logo.uploadDataUrl} alt="Uploaded logo" className="h-full w-full object-contain" /> : <ImagePlus size={22} className="text-muted" />}
      </div>
      <div className="flex flex-col gap-1.5">
        <label className="btn btn-secondary btn-sm cursor-pointer">
          <Upload size={14} /> {logo.uploadDataUrl ? 'Replace logo' : 'Upload logo'}
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
        <span className="text-xs text-muted">PNG, JPG, WebP or SVG. Resized to 256px.</span>
        {logo.uploadDataUrl && (
          <button className="self-start text-xs font-semibold text-bad hover:underline" onClick={() => onChange({ uploadDataUrl: undefined, mode: 'generated' })}>
            Remove upload
          </button>
        )}
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
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div data-logo-export className="hidden">
        <LogoMark colors={brand.colors} logo={brand.logo} name={brand.name} size={512} />
      </div>
      <button className="btn btn-secondary btn-sm" onClick={exportSvg} disabled={brand.logo.mode === 'upload'}>
        <Download size={14} /> Mark as SVG
      </button>
      <button className="btn btn-secondary btn-sm" onClick={exportPng} disabled={brand.logo.mode === 'upload'}>
        <Download size={14} /> Mark as PNG
      </button>
    </div>
  );
}

export function BannerDesigner({ brand, onChange }: { brand: Brand; onChange: (patch: Partial<Brand>) => void }) {
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
      <BrandBanner brand={brand} className="border border-line" />
      <div className="flex flex-wrap items-center gap-1.5">
        {styles.map((s) => (
          <button
            key={s.id}
            type="button"
            className={cn('chip', brand.banner.style === s.id && 'chip-active')}
            disabled={s.id === 'photo' && !photos.length}
            title={s.id === 'photo' && !photos.length ? 'Add a brand image first' : undefined}
            onClick={() => onChange({ banner: { ...brand.banner, style: s.id, imageId: s.id === 'photo' ? brand.banner.imageId ?? photos[0]?.id : brand.banner.imageId } })}
          >
            {s.label}
          </button>
        ))}
        <span className="ml-auto">
          <Toggle checked={brand.banner.showTagline} onChange={(v) => onChange({ banner: { ...brand.banner, showTagline: v } })} label="Show tagline" />
        </span>
      </div>
      {brand.banner.style === 'photo' && photos.length > 1 && (
        <div className="flex gap-2">
          {photos.map((m) => (
            <button key={m.id} onClick={() => onChange({ banner: { ...brand.banner, imageId: m.id } })} className={cn('h-12 w-16 overflow-hidden rounded-md border-2', brand.banner.imageId === m.id ? 'border-ink' : 'border-transparent')}>
              <MediaThumb media={m} className="h-full w-full border-0" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function SocialLinksEditor({ socials, onChange }: { socials: Brand['socials']; onChange: (s: Brand['socials']) => void }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {SOCIAL_PLATFORMS.map((p: SocialPlatform) => (
        <Field key={p} label={PLATFORMS[p].label} htmlFor={`soc-${p}`}>
          <div className="flex items-center gap-2">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-white" style={{ background: PLATFORMS[p].color }}>
              <PlatformGlyph platform={p} size={16} />
            </span>
            <input id={`soc-${p}`} className="input" placeholder={p === 'linkedin' ? 'linkedin.com/company/…' : `@yourhandle`} value={socials[p] ?? ''} onChange={(e) => onChange({ ...socials, [p]: e.target.value })} />
          </div>
        </Field>
      ))}
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
    <div className="flex flex-col gap-3">
      <MediaDrop multiple onFiles={(m) => onChange([...brand.images, ...m].slice(0, 24))} label="Drop product or brand photos" sub="Images or short videos · used in posts, banners and listings" compact />
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted">{brand.images.length ? `${brand.images.length} in your gallery` : 'No photos yet? Start with brand-colored presets.'}</span>
        <button
          className="btn btn-secondary btn-sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const presets = await makePresets(brand.colors, brand.logo.icon, brand.name);
            onChange([...brand.images, ...presets]);
            setBusy(false);
          }}
        >
          <Wand2 size={14} /> Add sample presets
        </button>
      </div>
      {brand.images.length > 0 && (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
          {brand.images.map((m) => (
            <MediaThumb key={m.id} media={m} className="aspect-square" onRemove={() => onChange(brand.images.filter((x) => x.id !== m.id))} />
          ))}
        </div>
      )}
      {brand.images.length > 0 && (
        <button className="inline-flex items-center gap-1 self-start text-xs font-semibold text-muted hover:text-bad" onClick={() => onChange([])}>
          <Trash2 size={12} /> Clear gallery
        </button>
      )}
    </div>
  );
}
