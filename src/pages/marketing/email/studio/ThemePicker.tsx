// Themes and templates (P5 §A4). A theme card shows its colours (from the brand, or the theme's own) and font;
// its settings (colour, background, font, corners, width, spacing) are in a popover; "Use for all emails" sets
// the project's default and every designed email's theme. Templates show as small previews with the email's own
// words, and replace the blocks behind a confirm (Undo puts them back).

import { useMemo, useRef, useState } from 'react';
import { LayoutTemplate, Palette, SlidersHorizontal } from 'lucide-react';
import type { EmailDoc, ThemeId, ThemeRef, ThemeTokens } from '../../../../../shared/email/blocks.mjs';
import { FONTS, THEMES } from '../../../../../shared/email/blocks.mjs';
import { applyTemplate, TEMPLATES, templateFor, type TemplateId } from '../../../../../shared/email/migrate.mjs';
import { renderEmail, resolveTheme } from '../../../../../shared/email/render.mjs';
import type { EmailStep, Project } from '@/lib/types';
import { cn } from '@/lib/utils';
import { plainOf, renderCtx, replaceDoc, setDoc } from '@/lib/emailDoc';
import { updateMarketingOf } from '@/lib/emailFunnel';
import { useProjectOffers } from '@/store/offers';
import { offerPrice } from '@/lib/offers';
import { toast } from '@/store/ui';
import { ColorInput, Field, Modal, Popover, Segmented, Swatch, confirmAction } from '@/components/ui/primitives';
import { FRAME_SANDBOX } from './EmailFrame';

type Overrides = Partial<ThemeTokens>;

export function ThemePicker({ project, step, doc }: { project: Project; step: EmailStep; doc: EmailDoc }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const current = doc.theme;
  const resolved = resolveTheme(current, project.brand.colors).tokens;
  const setTheme = (theme: ThemeRef) => setDoc(project.id, step.id, { ...doc, theme });
  const setOverride = (patch: Overrides) => {
    const overrides = { ...(current.overrides ?? {}), ...patch };
    setTheme(Object.keys(overrides).length ? { id: current.id, overrides } : { id: current.id });
  };
  const useForAll = async () => {
    if (
      !(await confirmAction({
        title: 'Use this theme for every email?',
        body: 'Every designed email and new designs take this theme. Their blocks and words stay as they are.',
        confirmLabel: 'Use for all emails',
      }))
    )
      return;
    updateMarketingOf(project.id, (m) => ({
      emailTheme: current,
      emails: m.emails.map((e) => (e.doc ? { ...e, doc: { ...e.doc, theme: current } } : e)),
    }));
    toast({ kind: 'success', title: 'Theme set for all emails' });
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Email theme">
        {THEMES.map((t) => {
          const tokens = resolveTheme({ id: t.id }, project.brand.colors).tokens;
          const on = t.id === current.id;
          return (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={on}
              className={cn('flex min-w-[112px] flex-col gap-1 rounded-md border px-2.5 py-2 text-left', on ? 'border-ink bg-surface-2' : 'border-line hover:border-line-2')}
              onClick={() => setTheme({ id: t.id as ThemeId })}
            >
              <span className="flex gap-1" aria-hidden="true">
                {[tokens.bg, tokens.paper, tokens.primary, tokens.accent, tokens.ink].map((c, i) => (
                  <Swatch key={i} color={c} size={12} />
                ))}
              </span>
              <span className="text-small font-medium text-ink">{t.label}</span>
              <span className="text-caption text-muted">{FONTS[tokens.font].label}</span>
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-2">
        <button ref={anchor} type="button" className="btn btn-secondary btn-xs" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <SlidersHorizontal aria-hidden="true" /> Theme settings
        </button>
        <button type="button" className="btn btn-ghost btn-xs" onClick={() => void useForAll()}>
          <Palette aria-hidden="true" /> Use for all emails
        </button>
      </div>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} align="start" className="w-72">
        <div className="grid gap-3 p-1">
          <Field label="Button and link colour">
            <ColorInput value={resolved.primary} onChange={(v) => /^#[0-9a-f]{6}$/i.test(v) && setOverride({ primary: v.toLowerCase() })} label="Button and link colour" />
          </Field>
          <Field label="Background">
            <ColorInput value={resolved.bg} onChange={(v) => /^#[0-9a-f]{6}$/i.test(v) && setOverride({ bg: v.toLowerCase() })} label="Background" />
          </Field>
          <Field label="Font">
            <select
              className="select"
              aria-label="Font"
              value={resolved.font}
              onChange={(e) =>
                setOverride({
                  font: e.target.value as ThemeTokens['font'],
                  headingFont: e.target.value as ThemeTokens['font'],
                })
              }
            >
              {Object.entries(FONTS).map(([id, f]) => (
                <option key={id} value={id}>
                  {f.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label={`Corners: ${resolved.radius}px`}>
            <input type="range" aria-label="Corners" min={0} max={24} value={resolved.radius} onChange={(e) => setOverride({ radius: Number(e.target.value) })} className="w-full" />
          </Field>
          <Field label={`Width: ${resolved.width}px`}>
            <input type="range" aria-label="Width" min={560} max={640} step={10} value={resolved.width} onChange={(e) => setOverride({ width: Number(e.target.value) })} className="w-full" />
          </Field>
          <Segmented<ThemeTokens['density']>
            size="sm"
            aria-label="Spacing"
            value={resolved.density}
            onChange={(density) => setOverride({ density })}
            options={[
              { id: 'tight', label: 'Tight' },
              { id: 'regular', label: 'Regular' },
              { id: 'airy', label: 'Airy' },
            ]}
          />
          {current.overrides && (
            <button type="button" className="link text-small" onClick={() => setTheme({ id: current.id })}>
              Back to the theme’s own settings
            </button>
          )}
        </div>
      </Popover>
    </div>
  );
}

/** The email's words in a template (its first offer for an offer card). */
export function templateDoc(tpl: TemplateId, step: EmailStep, p: Project, doc: EmailDoc, offer?: { id: string; title?: string; price?: string } | null): EmailDoc {
  const plain = step.doc ? plainOf(step.doc, p) : step;
  return applyTemplate(
    tpl,
    {
      id: step.id,
      subject: step.subject,
      body: plain.body,
      ctaLabel: plain.ctaLabel,
      ctaUrl: plain.ctaUrl,
    },
    { theme: doc.theme, seed: step.id, offer: offer ?? null },
  );
}

export function TemplatePicker({
  project,
  step,
  doc,
  index,
  total,
  open,
  onClose,
}: {
  project: Project;
  step: EmailStep;
  doc: EmailDoc;
  index: number;
  total: number;
  open: boolean;
  onClose: () => void;
}) {
  const { offers } = useProjectOffers(project.id);
  const offer = offers[0] ? { id: offers[0].id, title: offers[0].title, price: offerPrice(offers[0]) } : null;
  const suggested = templateFor(step.purpose, index, total);
  const previews = useMemo(
    () =>
      open
        ? TEMPLATES.map((t) => {
            const d = templateDoc(t.id, step, project, doc, offer);
            let html = '';
            try {
              html = renderEmail(d, renderCtx(project, 'preview', { subject: step.subject })).html;
            } catch {
              html = '';
            }
            return { t, d, html };
          })
        : [],
    // the offer's id is enough to tell
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open, step, project, doc, offer?.id],
  );
  const apply = async (d: EmailDoc, label: string) => {
    if (
      step.doc &&
      !(await confirmAction({
        title: `Use the “${label}” template?`,
        body: 'Its blocks replace this email’s blocks. Undo puts them back.',
        confirmLabel: 'Use template',
      }))
    )
      return;
    replaceDoc(project.id, step.id, d);
    onClose();
    toast({
      kind: 'success',
      title: `“${label}” template applied`,
      body: 'Undo in the studio puts the blocks back.',
    });
  };
  return (
    <Modal open={open} onClose={onClose} size="lg" title="Start from a template" subtitle="With this email’s own words. Your subject stays." icon={<LayoutTemplate />}>
      <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {previews.map(({ t, d, html }) => (
          <li key={t.id} className="flex flex-col gap-2 rounded-md border border-line p-2">
            <div className="h-[220px] overflow-hidden rounded border border-line bg-surface-2" aria-hidden="true">
              <iframe sandbox={FRAME_SANDBOX} srcDoc={html} title={`${t.label} template`} tabIndex={-1} className="pointer-events-none h-[550px] w-[640px] origin-top-left scale-[0.4] border-0" />
            </div>
            <p className="text-small font-medium text-ink">
              {t.label}
              {t.id === suggested && <span className="ml-1 text-caption text-muted">· suggested</span>}
            </p>
            <p className="text-caption text-muted">{t.desc}</p>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void apply(d, t.label)}>
              Use {t.label}
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
