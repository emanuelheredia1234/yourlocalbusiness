import { useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Check, ChevronDown, Clock, ImageOff, Mail, MapPin, Phone, Plus, ShieldCheck, Star, X } from 'lucide-react';
import type { Brand, ContactData, GalleryData, HeroData, LeadFormData, OfferItem, OffersData, PageType, PromptImage, ProofStat, SalesPage, SalesSection, Testimonial } from '@/lib/types';
import { cn, lighten, readableOn, uid, withAlpha } from '@/lib/utils';
import { imageKeyNumber } from '@/lib/promptImages';
import { useMediaUrl } from '@/lib/media';
import { webLink } from '@/lib/pageTypes';
import { altFromNote, contactEmail, contactTel, hasContactDetail, heroTarget, itemTarget, priceText, publishableProof, showsCompareAt, showsGuarantee, websiteMenu, type PageTargets } from '@/ai/local/seo';
import { Editable } from '@/components/ui/Editable';
import { Icon } from '@/components/ui/Icon';

type Device = 'desktop' | 'mobile';

export interface SalesTokens {
  bg: string;
  ink: string;
  muted: string;
  soft: string;
  primary: string;
  onPrimary: string;
  accent: string;
  radius: string;
  font: string;
}

export function salesTokens(page: SalesPage, brand: Brand): SalesTokens {
  const c = brand.colors;
  const dark = page.theme.mode === 'dark';
  return {
    bg: dark ? '#0f1412' : '#ffffff',
    ink: dark ? '#eef3ef' : c.ink,
    muted: dark ? '#a9b8af' : '#5b6861',
    soft: dark ? '#18211c' : lighten(c.primary, 0.93),
    primary: c.primary,
    onPrimary: readableOn(c.primary),
    accent: c.accent,
    radius: page.theme.radius === 'sharp' ? '4px' : page.theme.radius === 'round' ? '22px' : '12px',
    font: page.theme.font === 'serif' ? 'Georgia, "Times New Roman", serif' : page.theme.font === 'grotesk' ? '"Helvetica Neue", Arial, system-ui, sans-serif' : 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  };
}

interface Ctx {
  t: SalesTokens;
  editing: boolean;
  device: Device;
  set: (data: SalesSection['data']) => void;
  /** a business: no price set reads “Ask for a quote” */
  business?: boolean;
  /** one of the page's images, by media id (undefined: it was removed from the page's images) */
  image: (mediaId: string) => PromptImage | undefined;
  /** the page's type */
  pageType: PageType;
  /** what the page's buttons can open */
  targets: PageTargets;
  /** what pressing Send in the form says */
  formNote: string;
  /** the page's images (an offered item can show one of them) */
  allImages: PromptImage[];
  /** why the hero's button is left off the page ('' when it goes somewhere) */
  heroOff: string;
  /** why the pricing card's and the closing section's buttons are left off the page ('' when they go somewhere) */
  closingOff: string;
}

/** The sales page as visitors see it, with click-to-edit text when `editing` is on. Preview shows exactly
 *  what the export publishes: no unconfirmed proof, no guarantee the owner hasn't turned on. Nothing in it
 *  is a link (the app finds its pages by the address's #), and its form never sends. */
export function SalesPreview({
  page,
  brand,
  editing,
  device,
  onData,
  business,
  images = [],
  pageType = 'landing',
  targets,
  formNote = 'Nothing was sent: this is a preview.',
}: {
  page: SalesPage;
  brand: Brand;
  editing: boolean;
  device: Device;
  onData: (id: string, data: SalesSection['data']) => void;
  business?: boolean;
  /** the page's images (marketing.seoImages) */
  images?: PromptImage[];
  /** the page's type (absent: 'landing') */
  pageType?: PageType;
  /** what the page's buttons can open (pageTargets) */
  targets?: PageTargets;
  /** what pressing Send says (the preview never sends anything) */
  formNote?: string;
}) {
  const t = salesTokens(page, brand);
  const root = useRef<HTMLDivElement>(null);
  const image = (id: string) => images.find((i) => i.media.id === id && i.media.kind === 'image');
  const allImages = images.filter((i) => i.media.kind === 'image');
  const tg: PageTargets = targets ?? {
    booking: '',
    payment: '',
    hasForm: page.sections.some((s) => s.type === 'leadForm' && s.visible),
    hasContact: page.sections.some((s) => s.type === 'contact' && s.visible && hasContactDetail(s.data)),
  };
  // As published: a button shows only when it opens something. A landing page's pricing and closing buttons
  // always do (its link, else #pricing), and its hero button does unless Pricing is hidden and it has no link.
  const heroTo = !targets && pageType === 'landing' ? '#pricing' : heroTarget(page, pageType, tg);
  const heroOff = heroTo ? '' : pageType === 'landing' ? 'the Pricing section is hidden, and there’s no buy or booking link or website' : pageType === 'checkout' ? 'no payment link, and the Pricing section is hidden' : 'nothing on the page for it to open';
  const closingOff = pageType === 'landing' ? '' : heroOff;
  const menu = pageType === 'website' ? websiteMenu(page, !!business) : [];
  const go = (type: string) => root.current?.querySelector(`[data-section="${type}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  return (
    <div ref={root} className="overflow-hidden rounded-md border border-line shadow-card" style={{ background: t.bg, color: t.ink, fontFamily: t.font, width: device === 'mobile' ? 390 : '100%', maxWidth: '100%' }}>
      {pageType === 'website' && (
        <nav aria-label="Page menu (preview)" className="flex flex-wrap items-center gap-x-4 gap-y-1 px-6 py-3" style={{ borderBottom: `1px solid ${withAlpha(t.ink, 0.12)}` }}>
          <span className="mr-auto text-[15px] font-extrabold">{brand.name}</span>
          {menu.map((m) => (
            <button key={m.anchor} type="button" className="rounded px-1 py-0.5 text-[14px] font-semibold hover:underline" onClick={() => go(m.type)}>
              {m.label}
            </button>
          ))}
        </nav>
      )}
      {page.sections
        .filter((s) => s.visible)
        .map((s) => (
          <div key={s.id} data-section={s.type}>
            <SectionView s={s} ctx={{ t, editing, device, business, image, pageType, targets: tg, formNote, allImages, heroOff, closingOff, set: (d) => onData(s.id, d) }} />
          </div>
        ))}
      <footer className="px-6 py-6 text-center text-[12px]" style={{ color: t.muted, borderTop: `1px solid ${withAlpha(t.ink, 0.08)}` }}>
        © {new Date().getFullYear()} {brand.name}
      </footer>
    </div>
  );
}

function Wrap({ children, narrow, style }: { children: ReactNode; narrow?: boolean; style?: CSSProperties }) {
  return (
    <div className="mx-auto w-full px-6 py-12" style={{ maxWidth: narrow ? 560 : 980, ...style }}>
      {children}
    </div>
  );
}

const h2 = 'text-[26px] font-bold leading-tight tracking-[-0.01em] sm:text-[30px]';

function Ticks({ items, ctx, onChange, label }: { items: string[]; ctx: Ctx; onChange: (v: string[]) => void; label: string }) {
  return (
    <ul className="flex flex-col gap-2">
      {items.map((b, i) => (
        <li key={i} className="group flex items-start gap-2">
          <Check size={18} className="mt-0.5 shrink-0" style={{ color: ctx.t.primary }} />
          <Editable editing={ctx.editing} value={b} onChange={(v) => onChange(items.map((x, j) => (j === i ? v : x)))} label={`${label} ${i + 1}`} className="min-w-0 flex-1" />
          {ctx.editing && <RemoveBtn onClick={() => onChange(items.filter((_, j) => j !== i))} label={`Remove ${label} ${i + 1}`} />}
        </li>
      ))}
      {ctx.editing && <AddBtn onClick={() => onChange([...items, 'New point'])} label={`Add ${label}`} />}
    </ul>
  );
}

function RemoveBtn({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button type="button" className="shrink-0 rounded-full p-1 opacity-40 transition-opacity hover:bg-black/5 hover:opacity-100 focus-visible:opacity-100 group-hover:opacity-80" onClick={onClick} aria-label={label}>
      <X size={13} />
    </button>
  );
}

function AddBtn({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button type="button" className="mt-1 inline-flex items-center gap-1 self-start rounded-md border border-dashed px-2 py-1 text-[12px] font-semibold opacity-70 hover:opacity-100" style={{ borderColor: 'currentColor' }} onClick={onClick}>
      <Plus size={12} /> {label}
    </button>
  );
}

/** Shown on proof written before the app stopped inventing it: hidden from the page until the owner confirms. */
function ReviewNote({ ctx, text, onKeep }: { ctx: Ctx; text: string; onKeep: () => void }) {
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded px-2 py-1 text-left text-[11.5px] font-semibold" style={{ background: withAlpha(ctx.t.accent, 0.25), color: ctx.t.ink }}>
      <span>{text}</span>
      <button type="button" className="underline underline-offset-2" onClick={onKeep}>
        It’s real, show it
      </button>
    </p>
  );
}

const confirmed = <T extends { needsReview?: boolean }>(x: T): T => {
  const { needsReview: _r, ...rest } = x;
  return rest as T;
};

/** A button as the page shows it (never a link here). `off`: why it's left off the page, shown faded while editing. */
function Cta({ ctx, value, onChange, block, off, label = 'Button label' }: { ctx: Ctx; value: string; onChange: (v: string) => void; block?: boolean; off?: string; label?: string }) {
  if (off && !ctx.editing) return null;
  const btn = (
    <span className={cn('inline-flex items-center justify-center px-6 py-3.5 text-[16px] font-bold shadow-sm', block && 'w-full', off && 'opacity-50')} style={{ background: ctx.t.primary, color: ctx.t.onPrimary, borderRadius: ctx.t.radius }}>
      <Editable editing={ctx.editing} value={value} onChange={onChange} label={label} />
    </span>
  );
  if (!off) return btn;
  return (
    <span className={cn('inline-flex flex-col items-start gap-1', block && 'w-full')}>
      {btn}
      <span className="text-[11.5px] font-semibold" style={{ color: ctx.t.muted }}>
        Hidden on your page: {off}.
      </span>
    </span>
  );
}

/** The hero's data without its image. */
function noHeroImage(d: HeroData): HeroData {
  const { imageId: _id, imageAlt: _alt, ...rest } = d;
  return rest;
}

/**
 * One of the page's images. Editing, it has Remove and its alt text (what it shows, for people who can't
 * see it and for search engines), and says so when the image is no longer among the page's images.
 */
function PageImage({ img, alt, ctx, name, onAlt, onRemove, cover, priority, children }: { img?: PromptImage; alt: string; ctx: Ctx; name: string; onAlt: (alt: string) => void; onRemove: () => void; cover?: boolean; priority?: boolean; children?: ReactNode }) {
  const url = useMediaUrl(img?.media);
  const altId = useId();
  if (!img && !ctx.editing) return null;
  const n = img ? imageKeyNumber(img.key) : 0;
  return (
    <figure className="group relative m-0 min-w-0">
      {!img ? (
        <div className="flex aspect-[4/3] flex-col items-center justify-center gap-2 border border-dashed p-4 text-center text-[13px]" style={{ borderColor: withAlpha(ctx.t.ink, 0.25), color: ctx.t.muted, borderRadius: ctx.t.radius }}>
          <ImageOff size={20} aria-hidden="true" />
          This image was removed from your page’s images.
        </div>
      ) : url ? (
        <img src={url} alt={alt} className={cn('block w-full', cover ? 'aspect-[4/3] object-cover' : 'h-auto max-h-[460px] object-cover')} style={{ borderRadius: ctx.t.radius }} loading={priority ? 'eager' : 'lazy'} />
      ) : (
        <div className="aspect-[4/3] w-full animate-pulse" style={{ background: ctx.t.soft, borderRadius: ctx.t.radius }} role="img" aria-label={alt || 'Image loading'} />
      )}
      {ctx.editing && (
        <button type="button" onClick={onRemove} className="absolute right-2 top-2 rounded-full bg-black/60 p-1.5 text-white opacity-80 transition-opacity hover:bg-black/80 hover:opacity-100 focus-visible:opacity-100" aria-label={`Remove ${name} from the page`} title="Remove from the page">
          <X size={13} />
        </button>
      )}
      {children}
      {ctx.editing && img && (
        <div className="mt-2 flex items-center gap-2 text-[12px]" style={{ color: ctx.t.muted }}>
          <label htmlFor={altId} className="shrink-0 font-semibold">
            Image {n} alt text
          </label>
          <input id={altId} className="min-w-0 flex-1 rounded border bg-transparent px-2 py-1 text-[12.5px]" style={{ borderColor: withAlpha(ctx.t.ink, 0.2), color: ctx.t.ink }} value={alt} maxLength={150} placeholder="What the image shows" onChange={(e) => onAlt(e.target.value)} />
        </div>
      )}
    </figure>
  );
}

function GallerySection({ d, ctx }: { d: GalleryData; ctx: Ctx }) {
  const { t, editing } = ctx;
  const set = (p: Partial<GalleryData>) => ctx.set({ ...d, ...p });
  const setItem = (imageId: string, p: Partial<GalleryData['items'][number]>) => set({ items: d.items.map((it) => (it.imageId === imageId ? { ...it, ...p } : it)) });
  // the preview shows what the published page does: photos it still has, and nothing when there are none
  const items = editing ? d.items : d.items.filter((it) => !!ctx.image(it.imageId));
  if (!editing && !items.length) return null;
  const cols = ctx.device === 'mobile' ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3';
  return (
    <section>
      <Wrap>
        <Editable editing={editing} value={d.heading} onChange={(v) => set({ heading: v })} label="Gallery heading" tag="h2" className={h2} />
        {(editing || !!d.intro.trim()) && <Editable editing={editing} value={d.intro} onChange={(v) => set({ intro: v })} label="Gallery intro" placeholder="A line about these photos (optional)" tag="p" multiline className="mt-3 max-w-[680px] text-[16px] leading-relaxed" style={{ color: t.muted }} />}
        {items.length ? (
          <div className={cn('mt-6 grid gap-5', cols)}>
            {items.map((it, i) => (
              <PageImage key={it.imageId} img={ctx.image(it.imageId)} alt={it.alt} ctx={ctx} name={`photo ${i + 1}`} cover onAlt={(alt) => setItem(it.imageId, { alt })} onRemove={() => set({ items: d.items.filter((x) => x.imageId !== it.imageId) })}>
                {(editing || !!it.caption.trim()) && <Editable editing={editing} value={it.caption} onChange={(v) => setItem(it.imageId, { caption: v })} label={`Photo ${i + 1} caption`} placeholder="Caption (optional)" tag="figcaption" className="mt-2 block text-[14px]" style={{ color: t.muted }} />}
              </PageImage>
            ))}
          </div>
        ) : (
          <p className="mt-5 rounded-md border border-dashed p-5 text-center text-[14px]" style={{ borderColor: withAlpha(t.ink, 0.25), color: t.muted }}>
            No photos here yet. Add images under “Guide the AI”, then choose “Add to the page”, or add them with Edit with AI.
          </p>
        )}
      </Wrap>
    </section>
  );
}

function SectionView({ s, ctx }: { s: SalesSection; ctx: Ctx }) {
  const { t, editing } = ctx;
  const cols = (n: 2 | 3) => (ctx.device === 'mobile' ? 'grid-cols-1' : n === 3 ? 'grid-cols-1 md:grid-cols-3' : 'grid-cols-1 md:grid-cols-2');
  switch (s.type) {
    case 'hero': {
      const d = s.data;
      const set = (p: Partial<typeof d>) => ctx.set({ ...d, ...p });
      const img = d.imageId ? ctx.image(d.imageId) : undefined;
      // beside the copy on a wide screen; a removed image only shows (as a note) while editing
      const withImage = !!img || (editing && !!d.imageId);
      const copy = (
        <>
          <Editable editing={editing} value={d.eyebrow} onChange={(v) => set({ eyebrow: v })} label="Eyebrow" tag="p" className="mb-3 text-[12.5px] font-bold uppercase tracking-[0.12em]" style={{ color: t.primary }} />
          <Editable editing={editing} value={d.headline} onChange={(v) => set({ headline: v })} label="Headline (H1)" tag="h1" className="max-w-[760px] text-[32px] font-extrabold leading-[1.08] tracking-[-0.02em] sm:text-[44px]" />
          <Editable editing={editing} value={d.subheadline} onChange={(v) => set({ subheadline: v })} label="Subheadline" tag="p" multiline className="mt-4 max-w-[640px] text-[17px] leading-relaxed" style={{ color: t.muted }} />
          <div className="mt-6 max-w-[560px] text-[15px]">
            <Ticks items={d.bullets} ctx={ctx} onChange={(v) => set({ bullets: v })} label="bullet" />
          </div>
          <div className="mt-7 flex flex-col items-start gap-2">
            <Cta ctx={ctx} value={d.ctaLabel} onChange={(v) => set({ ctaLabel: v })} off={ctx.heroOff} />
            {(editing || !!d.ctaSubtext.trim()) && <Editable editing={editing} value={d.ctaSubtext} onChange={(v) => set({ ctaSubtext: v })} label="Fine print" placeholder="Fine print (optional)" tag="p" className="text-[12.5px]" style={{ color: t.muted }} />}
          </div>
        </>
      );
      return (
        <header style={{ background: `radial-gradient(90% 70% at 15% 0%, ${withAlpha(t.primary, 0.14)}, transparent 70%), ${t.bg}` }}>
          <Wrap style={{ paddingTop: 64, paddingBottom: 64 }}>
            {withImage ? (
              <div className={cn('grid items-center gap-8', ctx.device === 'mobile' ? 'grid-cols-1' : 'grid-cols-1 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]')}>
                <div className="min-w-0">{copy}</div>
                <PageImage img={img} alt={d.imageAlt ?? ''} ctx={ctx} name="the main image" priority onAlt={(imageAlt) => set({ imageAlt })} onRemove={() => ctx.set(noHeroImage(d))} />
              </div>
            ) : (
              copy
            )}
          </Wrap>
        </header>
      );
    }
    case 'problem': {
      const d = s.data;
      const set = (p: Partial<typeof d>) => ctx.set({ ...d, ...p });
      return (
        <section>
          <Wrap>
            <Editable editing={editing} value={d.heading} onChange={(v) => set({ heading: v })} label="Problem heading" tag="h2" className={h2} />
            <Editable editing={editing} value={d.intro} onChange={(v) => set({ intro: v })} label="Problem intro" tag="p" multiline className="mt-3 max-w-[680px] text-[16px] leading-relaxed" style={{ color: t.muted }} />
            <div className={cn('mt-6 grid gap-4', cols(3))}>
              {d.points.map((p, i) => (
                <div key={i} className="group relative p-5" style={{ background: t.soft, borderRadius: t.radius }}>
                  <Editable editing={editing} value={p.title} onChange={(v) => set({ points: d.points.map((x, j) => (j === i ? { ...x, title: v } : x)) })} label={`Pain point ${i + 1} title`} tag="h3" className="text-[16px] font-bold" />
                  <Editable editing={editing} value={p.body} onChange={(v) => set({ points: d.points.map((x, j) => (j === i ? { ...x, body: v } : x)) })} label={`Pain point ${i + 1} text`} tag="p" multiline className="mt-1.5 text-[14px] leading-relaxed" style={{ color: t.muted }} />
                  {editing && d.points.length > 1 && (
                    <span className="absolute right-2 top-2">
                      <RemoveBtn onClick={() => set({ points: d.points.filter((_, j) => j !== i) })} label={`Remove pain point ${i + 1}`} />
                    </span>
                  )}
                </div>
              ))}
            </div>
            {editing && d.points.length < 6 && <AddBtn onClick={() => set({ points: [...d.points, { title: 'Another frustration', body: 'Describe it in their words.' }] })} label="Add pain point" />}
            <Editable editing={editing} value={d.agitation} onChange={(v) => set({ agitation: v })} label="Agitation" tag="p" multiline className="mt-6 max-w-[680px] border-l-4 pl-4 text-[16px] font-semibold leading-relaxed" style={{ borderColor: t.accent }} />
          </Wrap>
        </section>
      );
    }
    case 'solution': {
      const d = s.data;
      const set = (p: Partial<typeof d>) => ctx.set({ ...d, ...p });
      return (
        <section style={{ background: t.soft }}>
          <Wrap>
            <Editable editing={editing} value={d.heading} onChange={(v) => set({ heading: v })} label="Solution heading" tag="h2" className={h2} />
            <Editable editing={editing} value={d.intro} onChange={(v) => set({ intro: v })} label="Solution intro" tag="p" multiline className="mt-3 max-w-[680px] text-[16px] leading-relaxed" style={{ color: t.muted }} />
            <div className={cn('mt-6 grid gap-4', cols(2))}>
              {d.features.map((f, i) => (
                <div key={i} className="group relative flex gap-3 p-5" style={{ background: t.bg, borderRadius: t.radius }}>
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center" style={{ background: withAlpha(t.primary, 0.12), color: t.primary, borderRadius: t.radius }}>
                    <Icon name={f.icon} size={20} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <Editable editing={editing} value={f.title} onChange={(v) => set({ features: d.features.map((x, j) => (j === i ? { ...x, title: v } : x)) })} label={`Feature ${i + 1} title`} tag="h3" className="text-[16px] font-bold" />
                    <Editable editing={editing} value={f.body} onChange={(v) => set({ features: d.features.map((x, j) => (j === i ? { ...x, body: v } : x)) })} label={`Feature ${i + 1} text`} tag="p" multiline className="mt-1 text-[14px] leading-relaxed" style={{ color: t.muted }} />
                  </div>
                  {editing && d.features.length > 1 && <RemoveBtn onClick={() => set({ features: d.features.filter((_, j) => j !== i) })} label={`Remove feature ${i + 1}`} />}
                </div>
              ))}
            </div>
            {editing && d.features.length < 8 && <AddBtn onClick={() => set({ features: [...d.features, { title: 'New feature', body: 'What it does and why it matters.', icon: 'sparkles' }] })} label="Add feature" />}
          </Wrap>
        </section>
      );
    }
    case 'proof': {
      const d = s.data;
      const set = (p: Partial<typeof d>) => ctx.set({ ...d, ...p });
      // Editing shows everything (with review notes); the preview shows only what gets published.
      const shown = editing ? d : publishableProof(d);
      if (!editing && !shown.stats.length && !shown.testimonials.length) return null;
      const setStat = (i: number, p: Partial<ProofStat>) => set({ stats: d.stats.map((y, j) => (j === i ? { ...y, ...p } : y)) });
      const setQuote = (i: number, p: Partial<Testimonial>) => set({ testimonials: d.testimonials.map((y, j) => (j === i ? { ...y, ...p } : y)) });
      return (
        <section>
          <Wrap>
            {(editing || shown.testimonials.length > 0) && <Editable editing={editing} value={d.heading} onChange={(v) => set({ heading: v })} label="Proof heading" tag="h2" className={h2} />}
            {editing && (
              <p className="mt-1 text-[13px]" style={{ color: t.muted }}>
                Only real quotes and facts you can back up. Anything left empty stays off your page.
              </p>
            )}
            {(shown.stats.length > 0 || editing) && (
              <div className={cn('mt-6 grid gap-3', ctx.device === 'mobile' ? 'grid-cols-1' : 'grid-cols-3')}>
                {shown.stats.map((x, i) => (
                  <div key={i} className="group relative flex flex-col gap-1 p-4 text-center" style={{ background: t.soft, borderRadius: t.radius }}>
                    {editing && x.needsReview && <ReviewNote ctx={ctx} text="May be written by AI. Hidden from your page." onKeep={() => setStat(i, confirmed(x))} />}
                    <Editable editing={editing} value={x.value} onChange={(v) => setStat(i, { value: v })} label={`Fact ${i + 1} number`} placeholder="[Number]" tag="b" className="block text-[28px] font-extrabold" style={{ color: t.primary }} />
                    <Editable editing={editing} value={x.label} onChange={(v) => setStat(i, { label: v })} label={`Fact ${i + 1} label`} placeholder="[What it counts]" tag="span" className="block text-[13px]" style={{ color: t.muted }} />
                    {editing && (
                      <span className="absolute right-1 top-1">
                        <RemoveBtn onClick={() => set({ stats: d.stats.filter((_, j) => j !== i) })} label={`Remove fact ${i + 1}`} />
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
            {editing && d.stats.length < 6 && <AddBtn onClick={() => set({ stats: [...d.stats, { value: '', label: '' }] })} label="Add a fact (like years in business)" />}
            {editing && d.testimonials.length === 0 && (
              <div className="mt-5 rounded-md border border-dashed p-5 text-center text-[14px]" style={{ borderColor: withAlpha(t.ink, 0.25), color: t.muted }}>
                <p className="font-semibold" style={{ color: t.ink }}>
                  Add real testimonials from customers
                </p>
                <p className="mt-1">Paste what a customer actually said, with their name and their OK to share it. Nothing shows here until you do.</p>
              </div>
            )}
            {shown.testimonials.length > 0 && (
              <div className={cn('mt-5 grid gap-4', cols(3))}>
                {shown.testimonials.map((q, i) => (
                  <figure key={i} className="group relative flex flex-col gap-3 p-5" style={{ border: `1px solid ${withAlpha(t.ink, 0.1)}`, borderRadius: t.radius }}>
                    {editing && q.needsReview && <ReviewNote ctx={ctx} text="May be written by AI, not a customer. Hidden from your page." onKeep={() => setQuote(i, confirmed(q))} />}
                    {editing ? (
                      <div className="flex items-center gap-0.5">
                        {Array.from({ length: 5 }, (_, k) => (
                          <button key={k} type="button" onClick={() => setQuote(i, { rating: q.rating === k + 1 ? 0 : k + 1 })} aria-label={q.rating === k + 1 ? 'Clear the star rating' : `The customer gave ${k + 1} star${k ? 's' : ''}`} aria-pressed={k < q.rating}>
                            <Star size={15} style={{ color: t.accent, fill: k < q.rating ? t.accent : 'transparent' }} />
                          </button>
                        ))}
                        {!q.rating && <span className="ml-1.5 text-[11.5px]" style={{ color: t.muted }}>No rating</span>}
                      </div>
                    ) : q.rating > 0 ? (
                      <div className="flex gap-0.5" aria-label={`${q.rating} out of 5 stars`}>
                        {Array.from({ length: 5 }, (_, k) => (
                          <Star key={k} size={15} aria-hidden="true" style={{ color: t.accent, fill: k < q.rating ? t.accent : 'transparent' }} />
                        ))}
                      </div>
                    ) : null}
                    <Editable editing={editing} value={q.quote} onChange={(v) => setQuote(i, { quote: v })} label={`Testimonial ${i + 1} quote`} placeholder="[Customer quote]" tag="blockquote" multiline className="text-[15px] leading-relaxed" />
                    <figcaption className="mt-auto text-[13px]" style={{ color: t.muted }}>
                      <Editable editing={editing} value={q.name} onChange={(v) => setQuote(i, { name: v })} label={`Testimonial ${i + 1} name`} placeholder="[Customer name]" tag="b" className="font-bold" style={{ color: t.ink }} />
                      {(editing || !!q.role.trim()) && ' · '}
                      {(editing || !!q.role.trim()) && <Editable editing={editing} value={q.role} onChange={(v) => setQuote(i, { role: v })} label={`Testimonial ${i + 1} role`} placeholder="[Who they are, optional]" />}
                    </figcaption>
                    {editing && (
                      <span className="absolute bottom-2 right-2">
                        <RemoveBtn onClick={() => set({ testimonials: d.testimonials.filter((_, j) => j !== i) })} label={`Remove testimonial ${i + 1}`} />
                      </span>
                    )}
                  </figure>
                ))}
              </div>
            )}
            {editing && d.testimonials.length < 6 && <AddBtn onClick={() => set({ testimonials: [...d.testimonials, { quote: '', name: '', role: '', rating: 0 }] })} label="Add testimonial" />}
          </Wrap>
        </section>
      );
    }
    case 'pricing': {
      const d = s.data;
      const set = (p: Partial<typeof d>) => ctx.set({ ...d, ...p });
      return (
        <section id="pricing" style={{ background: t.soft }}>
          <Wrap narrow>
            <Editable editing={editing} value={d.heading} onChange={(v) => set({ heading: v })} label="Pricing heading" tag="h2" className={cn(h2, 'text-center')} />
            <div className="relative mt-6 p-7" style={{ background: t.bg, borderRadius: t.radius, boxShadow: `0 18px 40px -22px ${withAlpha('#000000', 0.35)}`, border: `2px solid ${t.primary}` }}>
              {(d.badge || editing) && (
                <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full px-3 py-1 text-[12px] font-bold" style={{ background: t.accent, color: readableOn(t.accent) }}>
                  <Editable editing={editing} value={d.badge} onChange={(v) => set({ badge: v })} label="Badge" placeholder="Badge (optional)" />
                </span>
              )}
              <Editable editing={editing} value={d.planName} onChange={(v) => set({ planName: v })} label="Plan name" tag="h3" className="text-center text-[18px] font-bold" />
              <p className="mt-2 flex flex-wrap items-baseline justify-center gap-2">
                {(showsCompareAt(d) || editing) && (
                  <s className="text-[18px]" style={{ color: t.muted }} title="Your earlier price, only if you really charged it">
                    $
                    {editing ? <input type="number" min={0} placeholder="—" className="w-16 bg-transparent text-[18px] outline-none ylb-editable" value={d.compareAt || ''} onChange={(e) => set({ compareAt: Math.max(0, Number(e.target.value) || 0), compareAtNeedsReview: undefined })} aria-label="Earlier price (optional)" /> : d.compareAt}
                  </s>
                )}
                {editing ? (
                  <b className="text-[44px] font-extrabold leading-none">
                    $
                    <input type="number" min={0} placeholder="—" className="w-24 bg-transparent text-[44px] font-extrabold outline-none ylb-editable" value={d.price || ''} onChange={(e) => set({ price: Math.max(0, Number(e.target.value) || 0) })} aria-label={ctx.business ? 'Price (empty: “Ask for a quote”)' : 'Price'} />
                  </b>
                ) : (
                  <b className={cn('font-extrabold leading-none', d.price > 0 ? 'text-[44px]' : 'text-[28px]')}>{priceText(d.price, !!ctx.business)}</b>
                )}
                <Editable editing={editing} value={d.priceNote} onChange={(v) => set({ priceNote: v })} label="Price note" className="text-[13px]" style={{ color: t.muted }} />
              </p>
              {editing && d.compareAtNeedsReview && d.compareAt > 0 && (
                <div className="mt-2 flex justify-center">
                  <ReviewNote ctx={ctx} text={`Was $${d.compareAt} a price you really charged? Hidden from your page.`} onKeep={() => set({ compareAtNeedsReview: undefined })} />
                </div>
              )}
              <div className="mt-5 text-[15px]">
                <Ticks items={d.includes} ctx={ctx} onChange={(v) => set({ includes: v })} label="included item" />
              </div>
              <div className="mt-6">
                <Cta ctx={ctx} value={d.ctaLabel} onChange={(v) => set({ ctaLabel: v })} block off={ctx.closingOff} />
              </div>
            </div>
          </Wrap>
        </section>
      );
    }
    case 'faq': {
      const d = s.data;
      const set = (p: Partial<typeof d>) => ctx.set({ ...d, ...p });
      return (
        <section>
          <Wrap narrow>
            <Editable editing={editing} value={d.heading} onChange={(v) => set({ heading: v })} label="FAQ heading" tag="h2" className={cn(h2, 'text-center')} />
            <div className="mt-6 flex flex-col gap-2">
              {d.items.map((it, i) => (
                <FaqItem
                  key={i}
                  ctx={ctx}
                  q={it.q}
                  a={it.a}
                  index={i}
                  onQ={(v) => set({ items: d.items.map((x, j) => (j === i ? { ...x, q: v } : x)) })}
                  onA={(v) => set({ items: d.items.map((x, j) => (j === i ? { ...x, a: v } : x)) })}
                  onRemove={d.items.length > 1 ? () => set({ items: d.items.filter((_, j) => j !== i) }) : undefined}
                />
              ))}
            </div>
            {editing && d.items.length < 10 && <AddBtn onClick={() => set({ items: [...d.items, { q: 'Another common question?', a: 'A short, honest answer.' }] })} label="Add question" />}
          </Wrap>
        </section>
      );
    }
    case 'guarantee': {
      const d = s.data;
      const set = (p: Partial<typeof d>) => ctx.set({ ...d, ...p });
      // A guarantee only when the owner turned theirs on; otherwise just the closing heading and button.
      const on = editing ? !!d.offered : showsGuarantee(d);
      const leftover = !d.offered && !!(d.heading.trim() || d.body.trim());
      return (
        <section style={{ background: t.soft }}>
          <Wrap narrow style={{ textAlign: 'center' }}>
            {editing && !d.offered && (
              <div className="mb-10 rounded-md border border-dashed p-5 text-[14px]" style={{ borderColor: withAlpha(t.ink, 0.25), color: t.muted }}>
                <p className="font-semibold" style={{ color: t.ink }}>
                  Do you offer a guarantee or refunds?
                </p>
                <p className="mt-1">{leftover ? 'An earlier draft has guarantee text that you didn’t write. It’s hidden from your page. Show it only if you really offer it.' : 'Add one only if you really offer it, in your own words. Nothing shows until you do.'}</p>
                <button type="button" className="mt-3 inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-[13px] font-semibold" style={{ borderColor: withAlpha(t.ink, 0.25), color: t.ink }} onClick={() => set({ offered: true })}>
                  <ShieldCheck size={14} /> {leftover ? 'Review and show it' : 'Add my guarantee'}
                </button>
              </div>
            )}
            {on && (
              <>
                <span className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full" style={{ background: withAlpha(t.primary, 0.12), color: t.primary }}>
                  <ShieldCheck size={28} />
                </span>
                <Editable editing={editing} value={d.heading} onChange={(v) => set({ heading: v })} label="Guarantee heading" placeholder="[Your guarantee, in a few words]" tag="h2" className={h2} />
                <Editable editing={editing} value={d.body} onChange={(v) => set({ body: v })} label="Guarantee text" placeholder="[What you promise, and how a customer claims it]" tag="p" multiline className="mx-auto mt-3 max-w-[520px] text-[15.5px] leading-relaxed" style={{ color: t.muted }} />
                {editing && (
                  <div className="mt-3 flex flex-wrap items-center justify-center gap-3 text-[13px]" style={{ color: t.muted }}>
                    <label className="inline-flex items-center gap-2">
                      Time limit
                      <input type="number" min={0} max={365} placeholder="—" className="w-16 rounded border bg-transparent px-2 py-1 text-[13px]" style={{ borderColor: withAlpha(t.ink, 0.2) }} value={d.days || ''} onChange={(e) => set({ days: Math.max(0, Number(e.target.value) || 0) })} />
                      days
                    </label>
                    <button type="button" className="underline underline-offset-2" onClick={() => set({ offered: false, heading: '', body: '', days: 0 })}>
                      Remove guarantee
                    </button>
                  </div>
                )}
              </>
            )}
            <div className={on ? 'mt-10' : undefined}>
              <Editable editing={editing} value={d.finalHeading} onChange={(v) => set({ finalHeading: v })} label="Final heading" tag="h2" className={h2} />
              <div className="mt-5">
                <Cta ctx={ctx} value={d.finalCta} onChange={(v) => set({ finalCta: v })} off={ctx.closingOff} />
              </div>
            </div>
          </Wrap>
        </section>
      );
    }
    case 'gallery':
      return <GallerySection d={s.data} ctx={ctx} />;
    case 'leadForm':
      return <LeadFormSection d={s.data} ctx={ctx} />;
    case 'offers':
      return <OffersSection d={s.data} ctx={ctx} />;
    case 'about': {
      const d = s.data;
      const set = (p: Partial<typeof d>) => ctx.set({ ...d, ...p });
      // as published: an About section without words is left out
      if (!editing && !d.body.trim()) return null;
      return (
        <section>
          <Wrap narrow>
            <Editable editing={editing} value={d.heading} onChange={(v) => set({ heading: v })} label="About heading" tag="h2" className={h2} />
            <Editable editing={editing} value={d.body} onChange={(v) => set({ body: v })} label="About text" placeholder="A few lines about who you are and how you work" tag="p" multiline className="mt-3 whitespace-pre-line text-[16px] leading-relaxed" style={{ color: t.muted }} />
          </Wrap>
        </section>
      );
    }
    case 'contact':
      return <ContactSection d={s.data} ctx={ctx} />;
  }
}

/** A text field as the page shows it (labelled; in Edit, a look only). */
function FormField({ ctx, id, label, type = 'text', multiline, placeholder, autoComplete }: { ctx: Ctx; id: string; label: string; type?: string; multiline?: boolean; placeholder?: string; autoComplete?: string }) {
  const style = { borderColor: withAlpha(ctx.t.ink, 0.28), background: ctx.t.bg, color: ctx.t.ink, borderRadius: ctx.t.radius };
  const cls = 'w-full border px-3 py-2.5 text-[15px] disabled:opacity-60';
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="mb-1.5 block text-[14px] font-semibold">
        {label}
      </label>
      {multiline ? <textarea id={id} rows={4} className={cn(cls, 'resize-y')} style={style} disabled={ctx.editing} /> : <input id={id} type={type} className={cls} style={style} disabled={ctx.editing} placeholder={placeholder} autoComplete={autoComplete} />}
    </div>
  );
}

/** The page's form: the app's own fields. In the preview it never sends: Send says so. */
function LeadFormSection({ d, ctx }: { d: LeadFormData; ctx: Ctx }) {
  const { t, editing } = ctx;
  const ids = useId();
  const [sent, setSent] = useState(false);
  const set = (p: Partial<LeadFormData>) => ctx.set({ ...d, ...p });
  return (
    <section style={{ background: t.soft }}>
      <Wrap narrow>
        <Editable editing={editing} value={d.heading} onChange={(v) => set({ heading: v })} label="Form heading" tag="h2" className={h2} />
        {(editing || !!d.intro.trim()) && <Editable editing={editing} value={d.intro} onChange={(v) => set({ intro: v })} label="Form intro" placeholder="A line above the form (optional)" tag="p" multiline className="mt-3 text-[16px] leading-relaxed" style={{ color: t.muted }} />}
        {editing && (
          <div className="mt-4 rounded-md border border-dashed p-3 text-[13px]" style={{ borderColor: withAlpha(t.ink, 0.25), color: t.muted }}>
            <p>
              Visitors fill in their name, email, phone (optional){d.askTime ? ', a preferred time' : ''} and a message. {__ARTIFACT_BUILD__ ? 'The form sends only on pages published from the app’s own site.' : 'What they send arrives in Email → Leads once the page is published.'}
            </p>
            <label className="mt-2 inline-flex items-center gap-2 font-semibold" style={{ color: t.ink }}>
              <input type="checkbox" checked={!!d.askTime} onChange={(e) => set({ askTime: e.target.checked })} />
              Ask for a preferred time
            </label>
          </div>
        )}
        <form
          className="mt-6 grid gap-4"
          aria-label={d.heading.trim() || 'Form'}
          onSubmit={(e) => {
            e.preventDefault();
            setSent(true);
          }}
        >
          <FormField ctx={ctx} id={`${ids}-name`} label="Your name" autoComplete="off" />
          <FormField ctx={ctx} id={`${ids}-email`} label="Email" type="email" autoComplete="off" />
          <FormField ctx={ctx} id={`${ids}-phone`} label="Phone (optional)" type="tel" autoComplete="off" />
          {d.askTime && <FormField ctx={ctx} id={`${ids}-time`} label="Preferred day and time" placeholder="For example: Tuesday morning" autoComplete="off" />}
          <FormField ctx={ctx} id={`${ids}-message`} label="Message (optional)" multiline />
          <div>
            {editing ? (
              <Cta ctx={ctx} value={d.buttonLabel} onChange={(v) => set({ buttonLabel: v })} label="Form button label" />
            ) : (
              <button type="submit" className="inline-flex items-center justify-center px-6 py-3.5 text-[16px] font-bold shadow-sm" style={{ background: t.primary, color: t.onPrimary, borderRadius: t.radius }}>
                {d.buttonLabel.trim() || 'Send'}
              </button>
            )}
          </div>
          <p role="status" className="text-[14px] font-semibold empty:hidden" style={{ color: t.ink }}>
            {sent && !editing ? ctx.formNote : ''}
          </p>
        </form>
      </Wrap>
    </section>
  );
}

const CTA_NAMES: { id: OfferItem['cta']; label: string }[] = [
  { id: 'book', label: 'Book now' },
  { id: 'buy', label: 'Buy now' },
  { id: 'inquire', label: 'Ask about this' },
  { id: 'none', label: 'No button' },
];

/** What an item's button would say, and why it's left off the page when it is. */
function itemButton(it: OfferItem, ctx: Ctx): { label: string; off: string } | null {
  const business = !!ctx.business;
  const to = itemTarget(it, ctx.targets, business);
  if (to) return { label: to.label, off: '' };
  switch (it.cta) {
    case 'book':
      return { label: 'Book now', off: 'no booking link, and the form isn’t on the page' };
    case 'buy':
      return { label: 'Buy now', off: 'no payment link' };
    case 'inquire':
      return { label: business && it.price <= 0 && !it.priceNote.trim() ? 'Get a quote' : 'Ask about this', off: 'no form or contact details on the page' };
    default:
      return null;
  }
}

/** The item's price as the page shows it: $N and its note, or the note alone, or “Ask for a quote” (a business) / “Free”. */
function itemPrice(it: OfferItem, business: boolean): { main: string; note: string } {
  const note = it.priceNote.trim();
  if (it.price > 0) return { main: `$${it.price}`, note };
  return { main: note || (business ? 'Ask for a quote' : 'Free'), note: '' };
}

/** What the business sells, each item with its own price and button. Every item is the owner's. */
function OffersSection({ d, ctx }: { d: OffersData; ctx: Ctx }) {
  const { t, editing } = ctx;
  const set = (p: Partial<OffersData>) => ctx.set({ ...d, ...p });
  // as published: offers without items are left out
  if (!editing && !d.items.length) return null;
  const cols = ctx.device === 'mobile' ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3';
  const buyNoLink = editing && d.items.some((it) => it.cta === 'buy' && !itemTarget(it, ctx.targets, !!ctx.business));
  return (
    <section>
      <Wrap>
        <Editable editing={editing} value={d.heading} onChange={(v) => set({ heading: v })} label="Offers heading" tag="h2" className={h2} />
        {(editing || !!d.intro.trim()) && <Editable editing={editing} value={d.intro} onChange={(v) => set({ intro: v })} label="Offers intro" placeholder="A line about what you offer (optional)" tag="p" multiline className="mt-3 max-w-[680px] text-[16px] leading-relaxed" style={{ color: t.muted }} />}
        {editing && !d.items.length && (
          <p className="mt-5 rounded-md border border-dashed p-5 text-center text-[14px]" style={{ borderColor: withAlpha(t.ink, 0.25), color: t.muted }}>
            Add your services in Studio, or add items here.
          </p>
        )}
        {d.items.length > 0 && (
          <div className={cn('mt-6 grid gap-4', cols)}>
            {d.items.map((it, i) => (
              <OfferCard key={it.id} it={it} index={i} ctx={ctx} onChange={(p) => set({ items: d.items.map((x) => (x.id === it.id ? { ...x, ...p } : x)) })} onReplace={(next) => set({ items: d.items.map((x) => (x.id === it.id ? next : x)) })} onRemove={() => set({ items: d.items.filter((x) => x.id !== it.id) })} />
            ))}
          </div>
        )}
        {editing && d.items.length < 24 && <AddBtn onClick={() => set({ items: [...d.items, { id: uid('item'), name: 'New item', description: '', price: 0, priceNote: '', duration: '', cta: 'inquire' }] })} label="Add an item" />}
        {buyNoLink && (
          <p className="mt-3 text-[12.5px] font-semibold" style={{ color: t.muted }}>
            Buy buttons need a payment link: add one under Page type, or give the item its own link.
          </p>
        )}
      </Wrap>
    </section>
  );
}

function OfferCard({ it, index, ctx, onChange, onReplace, onRemove }: { it: OfferItem; index: number; ctx: Ctx; onChange: (p: Partial<OfferItem>) => void; onReplace: (next: OfferItem) => void; onRemove: () => void }) {
  const { t, editing } = ctx;
  const ids = useId();
  const business = !!ctx.business;
  const name = it.name.trim() || `item ${index + 1}`;
  const price = itemPrice(it, business);
  const button = itemButton(it, ctx);
  const linkBad = !!it.link?.trim() && !webLink(it.link);
  const noImage = (x: OfferItem): OfferItem => {
    const { imageId: _id, imageAlt: _alt, ...rest } = x;
    return rest;
  };
  const pickImage = (id: string) => {
    if (!id) return onReplace(noImage(it));
    const img = ctx.allImages.find((x) => x.media.id === id);
    onReplace({ ...it, imageId: id, imageAlt: id === it.imageId ? it.imageAlt ?? '' : altFromNote(img?.note) });
  };
  const control = 'w-full rounded border bg-transparent px-2 py-1.5 text-[13px]';
  const controlStyle = { borderColor: withAlpha(t.ink, 0.25), color: t.ink, background: t.bg };
  return (
    <article className="group relative flex min-w-0 flex-col gap-2 p-5" style={{ background: t.soft, borderRadius: t.radius }}>
      {it.imageId && <PageImage img={ctx.image(it.imageId)} alt={it.imageAlt ?? ''} ctx={ctx} name={`the image of ${name}`} cover onAlt={(imageAlt) => onChange({ imageAlt })} onRemove={() => onReplace(noImage(it))} />}
      <Editable editing={editing} value={it.name} onChange={(v) => onChange({ name: v })} label={`Item ${index + 1} name`} tag="h3" className="text-[17px] font-bold" />
      {(editing || !!it.duration.trim()) && <Editable editing={editing} value={it.duration} onChange={(v) => onChange({ duration: v })} label={`Item ${index + 1} duration`} placeholder="Duration (optional)" tag="p" className="text-[13px]" style={{ color: t.muted }} />}
      {(editing || !!it.description.trim()) && <Editable editing={editing} value={it.description} onChange={(v) => onChange({ description: v })} label={`Item ${index + 1} description`} placeholder="What’s included (optional)" tag="p" multiline className="text-[14px] leading-relaxed" style={{ color: t.muted }} />}
      <p className="flex flex-wrap items-baseline gap-x-2">
        {editing ? (
          <>
            <b className="text-[24px] font-extrabold leading-none">
              $
              <input type="number" min={0} placeholder="—" className="w-20 bg-transparent text-[24px] font-extrabold outline-none ylb-editable" value={it.price || ''} onChange={(e) => onChange({ price: Math.max(0, Number(e.target.value) || 0) })} aria-label={`Price of ${name} (empty: ${business ? 'Ask for a quote' : 'Free'})`} />
            </b>
            <Editable editing value={it.priceNote} onChange={(v) => onChange({ priceNote: v })} label={`Item ${index + 1} price note`} placeholder="per visit (optional)" className="text-[13px]" style={{ color: t.muted }} />
          </>
        ) : (
          <>
            <b className={cn('font-extrabold leading-none', it.price > 0 ? 'text-[24px]' : 'text-[18px]')}>{price.main}</b>
            {price.note && (
              <span className="text-[13px]" style={{ color: t.muted }}>
                {price.note}
              </span>
            )}
          </>
        )}
      </p>
      {button && (!button.off || editing) && (
        <div className="mt-auto pt-2">
          <span className={cn('inline-flex items-center justify-center px-4 py-2.5 text-[14px] font-bold', button.off && 'opacity-50')} style={{ background: t.primary, color: t.onPrimary, borderRadius: t.radius }}>
            {button.label}
          </span>
          {button.off && (
            <span className="mt-1 block text-[11.5px] font-semibold" style={{ color: t.muted }}>
              Hidden on your page: {button.off}.
            </span>
          )}
        </div>
      )}
      {editing && (
        <div className="mt-2 grid gap-2 border-t pt-3 text-[12px]" style={{ borderColor: withAlpha(t.ink, 0.12), color: t.muted }}>
          <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 gap-y-2">
            <label htmlFor={`${ids}-cta`} className="font-semibold">
              Button
            </label>
            <select id={`${ids}-cta`} className={control} style={controlStyle} value={it.cta} onChange={(e) => onChange({ cta: e.target.value as OfferItem['cta'] })}>
              {CTA_NAMES.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
            <label htmlFor={`${ids}-img`} className="font-semibold">
              Image
            </label>
            <select id={`${ids}-img`} className={control} style={controlStyle} value={it.imageId ?? ''} onChange={(e) => pickImage(e.target.value)}>
              <option value="">No image</option>
              {ctx.allImages.map((img) => (
                <option key={img.media.id} value={img.media.id}>
                  Image {imageKeyNumber(img.key)}
                </option>
              ))}
              {it.imageId && !ctx.allImages.some((img) => img.media.id === it.imageId) && <option value={it.imageId}>Removed image</option>}
            </select>
          </div>
          {it.cta !== 'none' && (
            <div>
              <label htmlFor={`${ids}-link`} className="mb-1 block font-semibold">
                Its own link (optional)
              </label>
              <input id={`${ids}-link`} type="url" inputMode="url" spellCheck={false} placeholder="https://" maxLength={500} className={control} style={controlStyle} value={it.link ?? ''} onChange={(e) => onChange({ link: e.target.value.trim() || undefined })} aria-invalid={linkBad || undefined} aria-describedby={linkBad ? `${ids}-link-bad` : undefined} />
              {linkBad && (
                <span id={`${ids}-link-bad`} className="mt-1 block font-semibold" style={{ color: t.ink }}>
                  Use a web address, like https://…
                </span>
              )}
            </div>
          )}
          <button type="button" className="justify-self-start underline underline-offset-2" onClick={onRemove}>
            Remove {name}
          </button>
        </div>
      )}
    </article>
  );
}

/** How to reach the business: in Edit, the owner's details; as published, the ones that are filled in (as text here). */
function ContactSection({ d, ctx }: { d: ContactData; ctx: Ctx }) {
  const { t, editing } = ctx;
  const ids = useId();
  const set = (p: Partial<ContactData>) => ctx.set({ ...d, ...p });
  // as published: contact without details is left out
  if (!editing && !hasContactDetail(d)) return null;
  const fields: { key: 'address' | 'hours' | 'phone' | 'email'; label: string; icon: ReactNode; type?: string; check?: string }[] = [
    { key: 'address', label: 'Address or area', icon: <MapPin size={16} /> },
    { key: 'hours', label: 'Hours', icon: <Clock size={16} /> },
    { key: 'phone', label: 'Phone', icon: <Phone size={16} />, type: 'tel', check: d.phone.trim() && !contactTel(d.phone) ? 'Not a phone number (6 to 15 digits): it shows as text, without a call link.' : '' },
    { key: 'email', label: 'Email', icon: <Mail size={16} />, type: 'email', check: d.email.trim() && !contactEmail(d.email) ? 'Not an email address: it shows as text, without a link.' : '' },
  ];
  const control = 'w-full rounded border bg-transparent px-2.5 py-2 text-[14px]';
  return (
    <section>
      <Wrap narrow>
        <Editable editing={editing} value={d.heading} onChange={(v) => set({ heading: v })} label="Contact heading" tag="h2" className={h2} />
        {(editing || !!d.intro.trim()) && <Editable editing={editing} value={d.intro} onChange={(v) => set({ intro: v })} label="Contact intro" placeholder="A line about where you work (optional)" tag="p" multiline className="mt-3 text-[16px] leading-relaxed" style={{ color: t.muted }} />}
        {editing ? (
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            {fields.map((f) => (
              <div key={f.key} className="min-w-0 text-[13px]">
                <label htmlFor={`${ids}-${f.key}`} className="mb-1 block font-semibold">
                  {f.label}
                </label>
                <input id={`${ids}-${f.key}`} type={f.type ?? 'text'} className={control} style={{ borderColor: withAlpha(t.ink, 0.25), color: t.ink }} value={d[f.key]} maxLength={200} onChange={(e) => set({ [f.key]: e.target.value })} aria-describedby={f.check ? `${ids}-${f.key}-check` : undefined} />
                {f.check && (
                  <span id={`${ids}-${f.key}-check`} className="mt-1 block text-[12px]" style={{ color: t.muted }}>
                    {f.check}
                  </span>
                )}
              </div>
            ))}
            <p className="text-[12px] sm:col-span-2" style={{ color: t.muted }}>
              Empty ones stay off your page.
            </p>
          </div>
        ) : (
          <ul className="mt-5 grid gap-2.5 text-[15px]">
            {fields
              .filter((f) => d[f.key].trim())
              .map((f) => (
                <li key={f.key} className="flex items-start gap-2.5">
                  <span className="mt-0.5 shrink-0" style={{ color: t.primary }} aria-hidden="true">
                    {f.icon}
                  </span>
                  <span className="min-w-0 break-words">
                    <span className="sr-only">{f.label}: </span>
                    {d[f.key].trim()}
                  </span>
                </li>
              ))}
          </ul>
        )}
      </Wrap>
    </section>
  );
}

function FaqItem({ ctx, q, a, index, onQ, onA, onRemove }: { ctx: Ctx; q: string; a: string; index: number; onQ: (v: string) => void; onA: (v: string) => void; onRemove?: () => void }) {
  const [open, setOpen] = useState(index === 0);
  const show = open || ctx.editing;
  return (
    <div className="group" style={{ border: `1px solid ${withAlpha(ctx.t.ink, 0.12)}`, borderRadius: ctx.t.radius }}>
      <div className="flex items-start gap-2 px-4 py-3">
        <Editable editing={ctx.editing} value={q} onChange={onQ} label={`Question ${index + 1}`} className="min-w-0 flex-1 text-[15px] font-bold" />
        {ctx.editing && onRemove && <RemoveBtn onClick={onRemove} label={`Remove question ${index + 1}`} />}
        {!ctx.editing && (
          <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={open ? 'Collapse answer' : 'Expand answer'} className="shrink-0 p-0.5">
            <ChevronDown size={18} className={cn('transition-transform', open && 'rotate-180')} />
          </button>
        )}
      </div>
      {show && <Editable editing={ctx.editing} value={a} onChange={onA} label={`Answer ${index + 1}`} tag="p" multiline className="block px-4 pb-4 text-[14.5px] leading-relaxed" style={{ color: ctx.t.muted }} />}
    </div>
  );
}
