import { useEffect, useMemo, useRef } from 'react';
import { Check, Globe, RefreshCw } from 'lucide-react';
import type { Brand, Project } from '@/lib/types';
import { cn, ensureUrl, slugify, stripProtocol } from '@/lib/utils';
import { BUSINESS_NICHE_SUGGESTIONS } from '@/ai/knowledge';
import { generateBrandKit } from '@/ai/local/brand';
import { brandKitTask } from '@/ai/tasks';
import { useAI } from '@/ai/useAI';
import { useStore } from '@/store/useStore';
import { AutoTextarea, ChipInput, Field } from '@/components/ui/primitives';
import { BannerDesigner, LogoDesigner } from '@/components/brand/BrandEditors';
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
        websiteUrl: p.brand.websiteUrl && p.origin === 'existing' ? p.brand.websiteUrl : `https://${slug.replace(/-/g, '')}.com`,
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
    setBrand({ name, slug, websiteUrl: `https://${slug.replace(/-/g, '')}.com`, domainIdeas: [`${slug.replace(/-/g, '')}.com`, `get${slug.replace(/-/g, '')}.com`, `${slug.replace(/-/g, '')}.co`] });
  };

  return (
    <div className="flex flex-col gap-4">
      {isBiz && (
        <Section n={0} title="Tell us about your business idea" desc="The brand kit is generated from these details.">
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
          <div className="mt-3 flex flex-wrap gap-1.5">
            {BUSINESS_NICHE_SUGGESTIONS.map((n) => (
              <button key={n} type="button" className={cn('chip', project.businessType === n && 'chip-active')} onClick={() => set({ businessType: n, niche: n })}>
                {n}
              </button>
            ))}
          </div>
        </Section>
      )}

      <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface-2/60 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-display text-[16px] font-semibold">AI Brand Identity Generator</p>
            <p className="text-xs text-muted">Names, logo concept, palette, cover banner, pitch and website, all editable.</p>
          </div>
          {generated ? (
            <button className="btn btn-secondary btn-sm" onClick={generate} disabled={ai.running}>
              <RefreshCw size={14} /> Regenerate kit
            </button>
          ) : (
            <GenerateButton running={ai.running} onClick={generate} disabled={!bizReady}>
              Generate brand kit
            </GenerateButton>
          )}
        </div>
        {!bizReady && <p className="text-xs text-muted">Add your business type and city to generate.</p>}
        <AIThinking running={ai.running} stage={ai.stage} chars={ai.chars} onStop={ai.stop} />
        {ai.result && !ai.running && <AIResultBar provider={ai.result.provider} skills={ai.result.skills} ms={ai.result.ms} note={ai.result.note} logId={ai.logId} />}
      </div>

      {generated && (
        <>
          <Section n={1} title="Brand name" desc="Pick one of the suggestions or type your own.">
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
              {brand.nameOptions.map((n) => {
                const active = brand.name === n.name;
                return (
                  <button key={n.name} type="button" onClick={() => pickName(n.name)} aria-pressed={active} className={cn('flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors', active ? 'border-primary bg-primary-soft ring-1 ring-primary' : 'border-line hover:bg-surface-2')}>
                    <span className="flex w-full items-center justify-between gap-2">
                      <span className="font-display text-[17px] font-bold tracking-[-0.01em]">{n.name}</span>
                      {active && <Check size={16} className="shrink-0 text-primary" />}
                    </span>
                    <span className="text-xs leading-snug text-muted">{n.rationale}</span>
                    <span className="mt-1 inline-flex items-center gap-1 font-mono text-[11px] text-ink-2">
                      <Globe size={11} /> {n.domain}
                    </span>
                  </button>
                );
              })}
            </div>
            <Field label="Or use a custom name" htmlFor="customname" className="mt-3 max-w-md">
              <input id="customname" className="input" value={brand.name} onChange={(e) => setBrand({ name: e.target.value, slug: slugify(e.target.value) })} onBlur={(e) => pickName(e.target.value)} />
            </Field>
          </Section>

          <Section n={2} title="Logo concept" desc="Rendered live from your icon, shape, type and palette. Export it or upload your own later.">
            <LogoDesigner brand={brand} onChange={setBrand} iconOptions={localKit.iconOptions} paletteOptions={[brand.colors, ...localKit.paletteOptions].filter((p, i, a) => a.findIndex((x) => x.primary === p.primary && x.accent === p.accent) === i)} />
          </Section>

          <Section n={3} title="Cover banner" desc="Used on your store listing and social profiles.">
            <BannerDesigner brand={brand} onChange={setBrand} />
          </Section>

          <Section n={4} title="Description" desc="Your elevator pitch, value proposition and target audience.">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Tagline" htmlFor="tg">
                <input id="tg" className="input" value={brand.tagline} onChange={(e) => setBrand({ tagline: e.target.value })} />
              </Field>
              <Field label="Personality">
                <ChipInput values={brand.personality} onChange={(v) => setBrand({ personality: v })} placeholder="Warm, Practical…" max={5} />
              </Field>
              <Field label="Elevator pitch" htmlFor="pt" className="sm:col-span-2">
                <AutoTextarea id="pt" value={brand.pitch} onChange={(v) => setBrand({ pitch: v })} minRows={2} />
              </Field>
              <Field label="Value proposition" htmlFor="vp">
                <AutoTextarea id="vp" value={brand.valueProp} onChange={(v) => setBrand({ valueProp: v })} minRows={2} />
              </Field>
              <Field label="Target audience" htmlFor="au">
                <AutoTextarea id="au" value={brand.audience} onChange={(v) => setBrand({ audience: v })} minRows={2} />
              </Field>
              <Field label="Mission" htmlFor="ms" className="sm:col-span-2">
                <input id="ms" className="input" value={brand.mission} onChange={(e) => setBrand({ mission: e.target.value })} />
              </Field>
            </div>
          </Section>

          <Section n={5} title="Website" desc="Suggested from your name. Use your own domain if you have one.">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <Field label="Website URL" htmlFor="web">
                <input id="web" className="input" value={brand.websiteUrl} onChange={(e) => setBrand({ websiteUrl: e.target.value })} onBlur={(e) => e.target.value && setBrand({ websiteUrl: ensureUrl(e.target.value) })} />
              </Field>
              <Field label="URL slug" htmlFor="slug" hint={`Store page: yourlocalbusiness.app/s/${brand.slug || 'your-brand'}`}>
                <input id="slug" className="input font-mono" value={brand.slug} onChange={(e) => setBrand({ slug: slugify(e.target.value, 40) })} />
              </Field>
            </div>
            {brand.domainIdeas.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-muted">Domain ideas:</span>
                {brand.domainIdeas.map((d) => (
                  <button key={d} className={cn('chip font-mono', stripProtocol(brand.websiteUrl) === d && 'chip-active')} onClick={() => setBrand({ websiteUrl: `https://${d}` })}>
                    {d}
                  </button>
                ))}
              </div>
            )}
          </Section>
        </>
      )}
    </div>
  );
}
