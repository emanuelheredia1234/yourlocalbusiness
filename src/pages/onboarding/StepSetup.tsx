import { useMemo } from 'react';
import type { Brand, ProductFormat, Project } from '@/lib/types';
import { cn, ensureUrl, slugify } from '@/lib/utils';
import { BUSINESS_NICHE_SUGGESTIONS, CITIES, findCity, FORMAT_LIST, matchNiche, NICHE_SUGGESTIONS } from '@/ai/knowledge';
import { brandKitTask } from '@/ai/tasks';
import { useAI } from '@/ai/useAI';
import { useStore } from '@/store/useStore';
import { toast } from '@/store/ui';
import { AutoTextarea, Field } from '@/components/ui/primitives';
import { BrandImagesEditor, LogoDesigner, SocialLinksEditor } from '@/components/brand/BrandEditors';
import { AIThinking, GenerateButton } from '@/components/ai/AI';

/** A titled card in a setup step (the n prop is kept for callers and no longer drawn: steps aren't numbered). */
export function Section({ title, desc, children, actions }: { n?: number; title: string; desc?: string; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <section className="card">
      {/* (phones: the actions go under the title; beside it they'd squeeze it to a word or two per line) */}
      <div className="flex flex-col gap-3 px-5 pb-4 pt-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-h3 text-ink">{title}</h2>
          {desc && <p className="mt-0.5 text-small text-muted">{desc}</p>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
      <div className="px-5 pb-5">{children}</div>
    </section>
  );
}

export function CityInput({ value, onChange, id }: { value: string; onChange: (city: string, region: string, lat?: number, lng?: number) => void; id?: string }) {
  const listId = useMemo(() => `cities-${Math.random().toString(36).slice(2, 7)}`, []);
  return (
    <>
      <input
        id={id}
        className="input"
        list={listId}
        placeholder="e.g. Austin, TX"
        value={value}
        onChange={(e) => {
          const v = e.target.value;
          const hit = findCity(v);
          const [city, region] = v.split(',').map((x) => x.trim());
          if (hit && v.toLowerCase().startsWith(hit.city.toLowerCase()) && v.includes(',')) onChange(hit.city, hit.region, hit.lat, hit.lng);
          else onChange(city ?? '', region ?? '', hit?.lat, hit?.lng);
        }}
      />
      <datalist id={listId}>
        {CITIES.map((c) => (
          <option key={`${c.city}-${c.region}`} value={`${c.city}, ${c.region}`} />
        ))}
      </datalist>
    </>
  );
}

export function StepSetup({ project }: { project: Project }) {
  const update = useStore((s) => s.updateProject);
  const brand = project.brand;
  const setBrand = (patch: Partial<Brand>) => update(project.id, (p) => ({ ...p, brand: { ...p.brand, ...patch } }));
  const set = (patch: Partial<Project>) => update(project.id, (p) => ({ ...p, ...patch }));
  const isBiz = project.track === 'business';
  const ai = useAI(brandKitTask);
  const prof = useMemo(() => matchNiche(project.niche, ''), [project.niche]);
  const cityText = project.location ? `${project.location.city}${project.location.region ? `, ${project.location.region}` : ''}` : '';

  const writeCopy = async () => {
    if (!brand.name.trim()) {
      toast({ kind: 'info', title: 'Add your name first', body: 'The AI uses it in your tagline and pitch.' });
      return;
    }
    const r = await ai.run({});
    if (r) {
      setBrand({ tagline: r.tagline, pitch: r.pitch, valueProp: r.valueProp, audience: r.audience, personality: r.personality, mission: r.mission });
      toast({ kind: 'ai', title: 'Brand copy drafted', body: 'Edit anything below.' });
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Section n={1} title={isBiz ? 'Your business' : 'Your product'} desc="This becomes the Project Context every module uses.">
        <div className="grid grid-cols-1 gap-x-4 gap-y-5 sm:grid-cols-2">
          <Field label={isBiz ? 'Business name' : 'Product or brand name'} htmlFor="bname">
            <input id="bname" className="input" placeholder={isBiz ? 'e.g. Copper & Crumb Bakery' : 'e.g. Ledgerly Tax Tracker'} value={brand.name} onChange={(e) => setBrand({ name: e.target.value, slug: slugify(e.target.value) })} />
          </Field>
          <Field label="Website URL" htmlFor="burl" hint="Shown as a watermark on posts if you choose.">
            <input id="burl" className="input" placeholder="https://yourbusiness.com" value={brand.websiteUrl} onChange={(e) => setBrand({ websiteUrl: e.target.value })} onBlur={(e) => e.target.value && setBrand({ websiteUrl: ensureUrl(e.target.value) })} />
          </Field>
          <Field label={isBiz ? 'Business type / niche' : 'Niche'} htmlFor="bniche">
            <input id="bniche" className="input" placeholder={isBiz ? 'e.g. Bakery, Home Cleaning, Hair Salon' : 'e.g. Personal Finance'} value={isBiz ? project.businessType || project.niche : project.niche} onChange={(e) => (isBiz ? set({ businessType: e.target.value, niche: e.target.value }) : set({ niche: e.target.value }))} />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {(isBiz ? BUSINESS_NICHE_SUGGESTIONS : NICHE_SUGGESTIONS).slice(0, 6).map((n) => (
                <button key={n} type="button" className={cn('chip', (isBiz ? project.businessType || project.niche : project.niche) === n && 'chip-active')} onClick={() => (isBiz ? set({ businessType: n, niche: n }) : set({ niche: n }))}>
                  {n}
                </button>
              ))}
            </div>
          </Field>
          <Field label={isBiz ? 'Specialty' : 'Specific category'} htmlFor="bcat" hint={isBiz ? 'What makes you different, e.g. “eco-friendly deep cleaning”.' : 'e.g. Freelancer Tax Tracking'}>
            <input id="bcat" className="input" value={project.category} onChange={(e) => set({ category: e.target.value })} />
            {!isBiz && prof?.categories && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {prof.categories.slice(0, 4).map((c) => (
                  <button key={c} type="button" className="chip" onClick={() => set({ category: c })}>
                    {c}
                  </button>
                ))}
              </div>
            )}
          </Field>
          {isBiz ? (
            <Field label="City" htmlFor="bcity" hint="Used for your store location, local SEO and ads targeting.">
              <CityInput id="bcity" value={cityText} onChange={(city, region, lat, lng) => set({ location: city ? { city, region, lat, lng } : null })} />
            </Field>
          ) : (
            <Field label="Product format" htmlFor="bformat">
              <select id="bformat" className="select" value={project.format ?? ''} onChange={(e) => set({ format: (e.target.value || null) as ProductFormat | null })}>
                <option value="">Choose a format…</option>
                {FORMAT_LIST.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {/* a business sets its prices on its packages in the Studio, when it wants to show them */}
          {!isBiz && (
            <Field label="Price (USD)" htmlFor="bprice">
              <input id="bprice" type="number" min={0} className="input num" value={project.studio.price || ''} placeholder="29" onChange={(e) => update(project.id, (p) => ({ ...p, studio: { ...p.studio, price: Number(e.target.value) || 0 } }))} />
            </Field>
          )}
          <Field label="Short description" htmlFor="bdesc" className="sm:col-span-2">
            <AutoTextarea id="bdesc" value={project.summary} onChange={(v) => set({ summary: v })} minRows={2} placeholder={isBiz ? 'What you offer, who you serve and where.' : 'What it is, who it’s for and the result it delivers.'} />
          </Field>
        </div>
      </Section>

      <Section n={2} title="Logo" desc="Upload your logo, or pick a quick icon-and-color mark.">
        <LogoDesigner brand={brand} onChange={setBrand} />
      </Section>

      <Section
        n={3}
        title="Brand voice (optional)"
        desc="The AI can draft your tagline, pitch and audience from the details above. Everything stays editable."
        actions={
          <GenerateButton running={ai.running} onClick={writeCopy} size="sm" runningLabel="Writing…">
            Write my tagline &amp; pitch
          </GenerateButton>
        }
      >
        <div className="flex flex-col gap-4">
          <AIThinking running={ai.running} stage={ai.stage} chars={ai.chars} onStop={ai.stop} compact />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Tagline" htmlFor="btag">
              <input id="btag" className="input" value={brand.tagline} onChange={(e) => setBrand({ tagline: e.target.value })} />
            </Field>
            <Field label="Target audience" htmlFor="baud">
              <input id="baud" className="input" value={brand.audience} onChange={(e) => setBrand({ audience: e.target.value })} />
            </Field>
            <Field label="Elevator pitch" htmlFor="bpitch" className="sm:col-span-2">
              <AutoTextarea id="bpitch" value={brand.pitch} onChange={(v) => setBrand({ pitch: v })} minRows={2} />
            </Field>
          </div>
        </div>
      </Section>

      <Section n={4} title="Product & brand images" desc="Used in social posts, your cover banner and store listing.">
        <BrandImagesEditor brand={brand} onChange={(images) => setBrand({ images })} />
      </Section>

      <Section n={5} title="Your social profiles" desc="Links or handles. Nothing gets connected: they show in post previews and tell Manus which account to post as.">
        <div className="-mt-4">
          <SocialLinksEditor socials={brand.socials} onChange={(socials) => setBrand({ socials })} projectId={project.id} />
        </div>
      </Section>
      <p className="text-small text-muted">You can change all of this later in Settings › Brand.</p>
    </div>
  );
}
