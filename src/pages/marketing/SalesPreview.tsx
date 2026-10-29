import { useState, type CSSProperties, type ReactNode } from 'react';
import { Check, ChevronDown, Plus, ShieldCheck, Star, X } from 'lucide-react';
import type { Brand, SalesPage, SalesSection } from '@/lib/types';
import { cn, lighten, readableOn, withAlpha } from '@/lib/utils';
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
  example: boolean;
  set: (data: SalesSection['data']) => void;
}

/** The sales page as visitors see it, with click-to-edit text when `editing` is on. */
export function SalesPreview({ page, brand, editing, device, example, onData }: { page: SalesPage; brand: Brand; editing: boolean; device: Device; example: boolean; onData: (id: string, data: SalesSection['data']) => void }) {
  const t = salesTokens(page, brand);
  return (
    <div className="overflow-hidden rounded-md border border-line shadow-card" style={{ background: t.bg, color: t.ink, fontFamily: t.font, width: device === 'mobile' ? 390 : '100%', maxWidth: '100%' }}>
      {page.sections
        .filter((s) => s.visible)
        .map((s) => (
          <SectionView key={s.id} s={s} ctx={{ t, editing, device, example, set: (d) => onData(s.id, d) }} />
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

function Cta({ ctx, value, onChange, block }: { ctx: Ctx; value: string; onChange: (v: string) => void; block?: boolean }) {
  return (
    <span className={cn('inline-flex items-center justify-center px-6 py-3.5 text-[16px] font-bold shadow-sm', block && 'w-full')} style={{ background: ctx.t.primary, color: ctx.t.onPrimary, borderRadius: ctx.t.radius }}>
      <Editable editing={ctx.editing} value={value} onChange={onChange} label="Button label" />
    </span>
  );
}

function SectionView({ s, ctx }: { s: SalesSection; ctx: Ctx }) {
  const { t, editing } = ctx;
  const cols = (n: 2 | 3) => (ctx.device === 'mobile' ? 'grid-cols-1' : n === 3 ? 'grid-cols-1 md:grid-cols-3' : 'grid-cols-1 md:grid-cols-2');
  switch (s.type) {
    case 'hero': {
      const d = s.data;
      const set = (p: Partial<typeof d>) => ctx.set({ ...d, ...p });
      return (
        <header style={{ background: `radial-gradient(90% 70% at 15% 0%, ${withAlpha(t.primary, 0.14)}, transparent 70%), ${t.bg}` }}>
          <Wrap style={{ paddingTop: 64, paddingBottom: 64 }}>
            <Editable editing={editing} value={d.eyebrow} onChange={(v) => set({ eyebrow: v })} label="Eyebrow" tag="p" className="mb-3 text-[12.5px] font-bold uppercase tracking-[0.12em]" style={{ color: t.primary }} />
            <Editable editing={editing} value={d.headline} onChange={(v) => set({ headline: v })} label="Headline (H1)" tag="h1" className="max-w-[760px] text-[32px] font-extrabold leading-[1.08] tracking-[-0.02em] sm:text-[44px]" />
            <Editable editing={editing} value={d.subheadline} onChange={(v) => set({ subheadline: v })} label="Subheadline" tag="p" multiline className="mt-4 max-w-[640px] text-[17px] leading-relaxed" style={{ color: t.muted }} />
            <div className="mt-6 max-w-[560px] text-[15px]">
              <Ticks items={d.bullets} ctx={ctx} onChange={(v) => set({ bullets: v })} label="bullet" />
            </div>
            <div className="mt-7 flex flex-col items-start gap-2">
              <Cta ctx={ctx} value={d.ctaLabel} onChange={(v) => set({ ctaLabel: v })} />
              <Editable editing={editing} value={d.ctaSubtext} onChange={(v) => set({ ctaSubtext: v })} label="Fine print" tag="p" className="text-[12.5px]" style={{ color: t.muted }} />
            </div>
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
      return (
        <section>
          <Wrap>
            <Editable editing={editing} value={d.heading} onChange={(v) => set({ heading: v })} label="Proof heading" tag="h2" className={h2} />
            <div className={cn('mt-6 grid gap-3', ctx.device === 'mobile' ? 'grid-cols-1' : 'grid-cols-3')}>
              {d.stats.map((x, i) => (
                <div key={i} className="p-4 text-center" style={{ background: t.soft, borderRadius: t.radius }}>
                  <Editable editing={editing} value={x.value} onChange={(v) => set({ stats: d.stats.map((y, j) => (j === i ? { ...y, value: v } : y)) })} label={`Stat ${i + 1} value`} tag="b" className="block text-[28px] font-extrabold" style={{ color: t.primary }} />
                  <Editable editing={editing} value={x.label} onChange={(v) => set({ stats: d.stats.map((y, j) => (j === i ? { ...y, label: v } : y)) })} label={`Stat ${i + 1} label`} tag="span" className="block text-[13px]" style={{ color: t.muted }} />
                </div>
              ))}
            </div>
            <div className={cn('mt-5 grid gap-4', cols(3))}>
              {d.testimonials.map((q, i) => (
                <figure key={i} className="group relative flex flex-col gap-3 p-5" style={{ border: `1px solid ${withAlpha(t.ink, 0.1)}`, borderRadius: t.radius }}>
                  {ctx.example && <span className="absolute right-3 top-3 rounded-full px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-wide" style={{ background: withAlpha(t.accent, 0.25), color: t.ink }}>Example</span>}
                  <div className="flex gap-0.5" aria-label={`${q.rating} out of 5 stars`}>
                    {Array.from({ length: 5 }, (_, k) =>
                      editing ? (
                        <button key={k} type="button" onClick={() => set({ testimonials: d.testimonials.map((y, j) => (j === i ? { ...y, rating: k + 1 } : y)) })} aria-label={`Rate ${k + 1} stars`}>
                          <Star size={15} style={{ color: t.accent, fill: k < q.rating ? t.accent : 'transparent' }} />
                        </button>
                      ) : (
                        <Star key={k} size={15} aria-hidden="true" style={{ color: t.accent, fill: k < q.rating ? t.accent : 'transparent' }} />
                      ),
                    )}
                  </div>
                  <Editable editing={editing} value={q.quote} onChange={(v) => set({ testimonials: d.testimonials.map((y, j) => (j === i ? { ...y, quote: v } : y)) })} label={`Testimonial ${i + 1} quote`} tag="blockquote" multiline className="text-[15px] leading-relaxed" />
                  <figcaption className="mt-auto text-[13px]" style={{ color: t.muted }}>
                    <Editable editing={editing} value={q.name} onChange={(v) => set({ testimonials: d.testimonials.map((y, j) => (j === i ? { ...y, name: v } : y)) })} label={`Testimonial ${i + 1} name`} tag="b" className="font-bold" style={{ color: t.ink }} />
                    {' · '}
                    <Editable editing={editing} value={q.role} onChange={(v) => set({ testimonials: d.testimonials.map((y, j) => (j === i ? { ...y, role: v } : y)) })} label={`Testimonial ${i + 1} role`} />
                  </figcaption>
                  {editing && d.testimonials.length > 1 && (
                    <span className="absolute bottom-2 right-2">
                      <RemoveBtn onClick={() => set({ testimonials: d.testimonials.filter((_, j) => j !== i) })} label={`Remove testimonial ${i + 1}`} />
                    </span>
                  )}
                </figure>
              ))}
            </div>
            {editing && d.testimonials.length < 6 && <AddBtn onClick={() => set({ testimonials: [...d.testimonials, { quote: 'Paste a real customer quote here.', name: 'Customer name', role: 'Customer', rating: 5 }] })} label="Add testimonial" />}
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
                  <Editable editing={editing} value={d.badge} onChange={(v) => set({ badge: v })} label="Badge" placeholder="Badge" />
                </span>
              )}
              <Editable editing={editing} value={d.planName} onChange={(v) => set({ planName: v })} label="Plan name" tag="h3" className="text-center text-[18px] font-bold" />
              <p className="mt-2 flex flex-wrap items-baseline justify-center gap-2">
                {(d.compareAt > d.price || editing) && (
                  <s className="text-[18px]" style={{ color: t.muted }}>
                    $
                    {editing ? <input type="number" min={0} className="w-16 bg-transparent text-[18px] outline-none ylb-editable" value={d.compareAt} onChange={(e) => set({ compareAt: Math.max(0, Number(e.target.value) || 0) })} aria-label="Compare-at price" /> : d.compareAt}
                  </s>
                )}
                <b className="text-[44px] font-extrabold leading-none">
                  $
                  {editing ? <input type="number" min={0} className="w-24 bg-transparent text-[44px] font-extrabold outline-none ylb-editable" value={d.price} onChange={(e) => set({ price: Math.max(0, Number(e.target.value) || 0) })} aria-label="Price" /> : d.price}
                </b>
                <Editable editing={editing} value={d.priceNote} onChange={(v) => set({ priceNote: v })} label="Price note" className="text-[13px]" style={{ color: t.muted }} />
              </p>
              <div className="mt-5 text-[15px]">
                <Ticks items={d.includes} ctx={ctx} onChange={(v) => set({ includes: v })} label="included item" />
              </div>
              <div className="mt-6">
                <Cta ctx={ctx} value={d.ctaLabel} onChange={(v) => set({ ctaLabel: v })} block />
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
      return (
        <section style={{ background: t.soft }}>
          <Wrap narrow style={{ textAlign: 'center' }}>
            <span className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full" style={{ background: withAlpha(t.primary, 0.12), color: t.primary }}>
              <ShieldCheck size={28} />
            </span>
            <Editable editing={editing} value={d.heading} onChange={(v) => set({ heading: v })} label="Guarantee heading" tag="h2" className={h2} />
            <Editable editing={editing} value={d.body} onChange={(v) => set({ body: v })} label="Guarantee text" tag="p" multiline className="mx-auto mt-3 max-w-[520px] text-[15.5px] leading-relaxed" style={{ color: t.muted }} />
            {editing && (
              <label className="mt-3 inline-flex items-center gap-2 text-[13px]" style={{ color: t.muted }}>
                Guarantee length
                <input type="number" min={0} max={365} className="w-16 rounded border bg-transparent px-2 py-1 text-[13px]" style={{ borderColor: withAlpha(t.ink, 0.2) }} value={d.days} onChange={(e) => set({ days: Math.max(0, Number(e.target.value) || 0) })} />
                days
              </label>
            )}
            <div className="mt-10">
              <Editable editing={editing} value={d.finalHeading} onChange={(v) => set({ finalHeading: v })} label="Final heading" tag="h2" className={h2} />
              <div className="mt-5">
                <Cta ctx={ctx} value={d.finalCta} onChange={(v) => set({ finalCta: v })} />
              </div>
            </div>
          </Wrap>
        </section>
      );
    }
  }
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
