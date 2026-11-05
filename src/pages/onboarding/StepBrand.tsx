import { useEffect, useMemo, useRef } from 'react';
import { Check, Globe } from 'lucide-react';
import type { Brand, Project } from '@/lib/types';
import { cn, ensureUrl, slugify, stripProtocol } from '@/lib/utils';
import { BUSINESS_NICHE_SUGGESTIONS } from '@/ai/knowledge';
import { generateBrandKit } from '@/ai/local/brand';
import { brandKitTask } from '@/ai/tasks';
import { useAI } from '@/ai/useAI';
import { useStore } from '@/store/useStore';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger, AutoTextarea, ChipInput, Field, Skeleton } from '@/components/ui/primitives';
import { LogoDesigner } from '@/components/brand/BrandEditors';
import { AIResultBar, AIThinking, GenerateButton } from '@/components/ai/AI';
import { CityInput, Section } from './StepSetup';

export function StepBrand({ project }: { project: Project }) {
  const update = useStore((s) => s.updateProject);
  const brand = project.brand;
  const setBrand = (patch: Partial<Brand>) => update(project.id, (p) => ({ ...p, brand: { ...p.brand, ...patch } }));
  const set = (patch: Partial<Project>) => update(project.id, (p) => ({ ...p, ...patch }));
  const isBiz = project.track === 'business';
  const ai = useAI(brandKitTask);
  const localKit = useMemo(() => generateBrandKit(project), [project.niche, project.category, project.businessType, project.idea?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const generated = brand.nameOptions.length > 0;
  const bizReady = !isBiz || (project.businessType.trim().length > 1 && !!project.location?.city);
  const cityText = project.location ? `${project.location.city}${project.location.region ? `, ${project.location.region}` : ''}` : '';
  const autoRan = useRef(false);

  const generate = async () => {
    const r = await ai.run({});
    if (!r) return;
    const keepName = brand.name && !brand.nameOptions.some((n) => n.name === brand.name) ? brand.name : '';
    const name = keepName || r.nameOptions[0]?.name || brand.name;
    const slug = slugify(name);
    update(project.id, (p) => ({
      ...p,
      brand: {
        ...p.brand,
        name,
        slug,
        nameOptions: r.nameOptions,
        tagline: r.tagline,
        pitch: r.pitch,
        valueProp: r.valueProp,
        audience: r.audience,
        personality: r.personality,
        mission: r.mission,
        domainIdeas: r.domainIdeas.map((d) => d.replace(/^[a-z0-9-]+/, slug.replace(/-/g, ''))).filter((v, i, a) => a.indexOf(v) === i),
        colors: r.colors,
        logo: { ...p.brand.logo, mode: 'generated', icon: r.icon, shape: r.shape, font: r.font },
        banner: { ...p.brand.banner, style: r.bannerStyle },
      },
    }));
  };

  useEffect(() => {
    if (!generated && !isBiz && !autoRan.current) {
      autoRan.current = true;
      generate();
    }
    return () => {
      // Unmounting cancels an in-flight run; let the next mount start it again if nothing was generated.
      const p = useStore.getState().projects.find((x) => x.id === project.id);
      if (!p?.brand.nameOptions.length) autoRan.current = false;
    };
    // run once when arriving from product research
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pickName = (name: string) => {
    const slug = slugify(name);
    // domain ideas only: the website stays what the owner typed
    setBrand({ name, slug, domainIdeas: [`${slug.replace(/-/g, '')}.com`, `get${slug.replace(/-/g, '')}.com`, `${slug.replace(/-/g, '')}.co`] });
  };

  const kitButton = generated ? (
    <GenerateButton running={ai.running} onClick={generate} size="sm" runningLabel="Designing…">
      Regenerate kit
    </GenerateButton>
  ) : (
    <GenerateButton variant="ai" size="lg" running={ai.running} onClick={generate} disabled={!bizReady} runningLabel="Designing…">
      Generate brand kit
    </GenerateButton>
  );

  return (
    <div className="flex flex-col gap-6">
      {isBiz ? (
        <Section title="Tell us about your business idea" desc="Your brand kit is made from these details.">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Type of business" htmlFor="btype">
              <input id="btype" className="input" placeholder="e.g. Coffee shop" value={project.businessType} onChange={(e) => set({ businessType: e.target.value, niche: e.target.value })} />
            </Field>
            <Field label="Specialty (optional)" htmlFor="bspec">
              <input id="bspec" className="input" placeholder="e.g. Specialty espresso & pastries" value={project.category} onChange={(e) => set({ category: e.target.value })} />
            </Field>
            <Field label="City" htmlFor="bcity2">
              <CityInput id="bcity2" value={cityText} onChange={(city, region, lat, lng) => set({ location: city ? { city, region, lat, lng } : null })} />
            </Field>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="Quick picks">
            {BUSINESS_NICHE_SUGGESTIONS.map((n) => (
              <button key={n} type="button" className={cn('chip', project.businessType === n && 'chip-active')} aria-pressed={project.businessType === n} onClick={() => set({ businessType: n, niche: n })}>
                {project.businessType === n && <Check aria-hidden="true" />}
                {n}
              </button>
            ))}
          </div>
          <div className="mt-5 flex flex-wrap items-center justify-end gap-3 border-t border-line pt-5">
            {!bizReady && <p className="mr-auto text-small text-muted">Add your business type and city to generate.</p>}
            {generated && <p className="mr-auto text-small text-muted">Names, logo, palette, banner and messaging: edit anything below.</p>}
            {kitButton}
          </div>
        </Section>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-small text-muted">Names, logo, palette, banner and messaging, made from your product idea.</p>
          {kitButton}
        </div>
      )}

      {ai.running && (
        <div className="ai-hero-glow flex flex-col gap-5 rounded-2xl border border-line p-5 sm:p-6" aria-busy="true">
          <AIThinking running={ai.running} stage={ai.stage} chars={ai.chars} onStop={ai.stop} />
          <div className="grid grid-cols-1 gap-5 md:grid-cols-[minmax(0,1fr)_272px]" aria-hidden="true">
            <div className="flex flex-col gap-3">
              <div className="flex gap-2">
                <Skeleton ai className="h-7 w-28 rounded-full" />
                <Skeleton ai className="h-7 w-32 rounded-full" />
                <Skeleton ai className="h-7 w-24 rounded-full" />
              </div>
              <Skeleton ai className="h-28 w-full rounded-pop" />
              <Skeleton ai className="h-9 w-2/3 rounded-md" />
              <Skeleton ai className="h-9 w-1/2 rounded-md" />
            </div>
            <div className="flex flex-col gap-3">
              <Skeleton ai className="aspect-[3/1] w-full rounded-stage" />
              <Skeleton ai className="h-16 w-full rounded-pop" />
              <div className="flex gap-1">
                {[0, 1, 2, 3, 4].map((i) => (
                  <Skeleton key={i} ai className="h-6 flex-1 rounded-xs" />
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
      {ai.result && !ai.running && <AIResultBar provider={ai.result.provider} skills={ai.result.skills} ms={ai.result.ms} note={ai.result.note} logId={ai.logId} />}

      {generated && !ai.running && (
        <div className={cn('flex flex-col gap-6 rounded-2xl', ai.result && 'ai-arrive')}>
          <Section title="Brand name" desc="Pick one of the ideas or type your own.">
            <div className="flex flex-wrap gap-2" role="group" aria-label="Name ideas">
              {brand.nameOptions.map((n) => {
                const active = brand.name === n.name;
                return (
                  <button key={n.name} type="button" onClick={() => pickName(n.name)} aria-pressed={active} title={n.rationale} className={cn('chip h-9 px-3.5 text-ui', active && 'chip-active')}>
                    {active && <Check aria-hidden="true" />}
                    {n.name}
                  </button>
                );
              })}
            </div>
            {(() => {
              const chosen = brand.nameOptions.find((n) => n.name === brand.name);
              return chosen ? (
                <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-small text-muted">
                  {chosen.rationale}
                  <span className="inline-flex items-center gap-1 font-mono text-caption text-ink-2">
                    <Globe size={12} aria-hidden="true" /> {chosen.domain}
                  </span>
                </p>
              ) : null;
            })()}
            <Field label="Or use a custom name" htmlFor="customname" className="mt-5 max-w-md">
              <input id="customname" className="input" value={brand.name} onChange={(e) => setBrand({ name: e.target.value, slug: slugify(e.target.value) })} onBlur={(e) => pickName(e.target.value)} />
            </Field>
          </Section>

          <section className="rounded-2xl border border-line bg-surface p-5 sm:p-6" aria-labelledby="brand-board-title">
            <div className="mb-5">
              <h2 id="brand-board-title" className="text-h3 text-ink">
                Logo, colours &amp; banner
              </h2>
              <p className="mt-0.5 text-small text-muted">Drawn live from your icon, shape, type and palette. Export it, or upload your own later.</p>
            </div>
            <LogoDesigner brand={brand} onChange={setBrand} iconOptions={localKit.iconOptions} paletteOptions={[brand.colors, ...localKit.paletteOptions].filter((p, i, a) => a.findIndex((x) => x.primary === p.primary && x.accent === p.accent) === i)} withBanner />
          </section>

          <Section title="Website" desc="Add yours if you have one. Without it, posts say “link in bio”.">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Website URL (optional)" htmlFor="web">
                <input id="web" className="input" placeholder="https://yourbusiness.com" value={brand.websiteUrl} onChange={(e) => setBrand({ websiteUrl: e.target.value })} onBlur={(e) => e.target.value && setBrand({ websiteUrl: ensureUrl(e.target.value) })} />
              </Field>
              <Field label="File name" htmlFor="slug" hint="Used in the names of files you download.">
                <input id="slug" className="input font-mono" value={brand.slug} onChange={(e) => setBrand({ slug: slugify(e.target.value, 40) })} />
              </Field>
            </div>
            {brand.domainIdeas.length > 0 && (
              <div className="mt-4 flex flex-wrap items-center gap-1.5">
                <span className="mr-1 text-small text-muted">Domain ideas (not checked; use one once you own it):</span>
                {brand.domainIdeas.map((d) => (
                  <button key={d} type="button" className={cn('chip font-mono', stripProtocol(brand.websiteUrl) === d && 'chip-active')} aria-pressed={stripProtocol(brand.websiteUrl) === d} onClick={() => setBrand({ websiteUrl: `https://${d}` })}>
                    {d}
                  </button>
                ))}
              </div>
            )}
          </Section>

          <div className="card px-5">
            <Accordion type="single" collapsible>
              <AccordionItem value="words" className="border-b-0">
                <AccordionTrigger>
                  <span>
                    Words that describe you
                    <span className="mt-0.5 block text-small font-normal text-muted">Tagline, pitch, value proposition, audience and mission.</span>
                  </span>
                </AccordionTrigger>
                <AccordionContent>
                  <div className="flex flex-col divide-y divide-line">
                    <InlineRow label="Tagline" htmlFor="tg">
                      <input id="tg" className={cn('input', INLINE)} value={brand.tagline} onChange={(e) => setBrand({ tagline: e.target.value })} />
                    </InlineRow>
                    <InlineRow label="Personality">
                      <ChipInput values={brand.personality} onChange={(v) => setBrand({ personality: v })} placeholder="Warm, Practical…" max={5} />
                    </InlineRow>
                    <InlineRow label="Elevator pitch" htmlFor="pt">
                      <AutoTextarea id="pt" rows={2} value={brand.pitch} onChange={(v) => setBrand({ pitch: v })} minRows={2} className={INLINE} />
                    </InlineRow>
                    <InlineRow label="Value proposition" htmlFor="vp">
                      <AutoTextarea id="vp" rows={1} value={brand.valueProp} onChange={(v) => setBrand({ valueProp: v })} minRows={1} className={INLINE} />
                    </InlineRow>
                    <InlineRow label="Target audience" htmlFor="au">
                      <AutoTextarea id="au" rows={1} value={brand.audience} onChange={(v) => setBrand({ audience: v })} minRows={1} className={INLINE} />
                    </InlineRow>
                    <InlineRow label="Mission" htmlFor="ms">
                      <input id="ms" className={cn('input', INLINE)} value={brand.mission} onChange={(e) => setBrand({ mission: e.target.value })} />
                    </InlineRow>
                  </div>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </div>
        </div>
      )}
    </div>
  );
}

/** Long text edited in place: borderless until hover or focus, its text lined up with the label. */
const INLINE = 'input-inline -mx-3 w-[calc(100%+24px)]';

function InlineRow({ label, htmlFor, children }: { label: string; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 py-3">
      {htmlFor ? (
        <label htmlFor={htmlFor} className="text-small font-medium text-ink-2">
          {label}
        </label>
      ) : (
        <p className="text-small font-medium text-ink-2">{label}</p>
      )}
      {children}
    </div>
  );
}
