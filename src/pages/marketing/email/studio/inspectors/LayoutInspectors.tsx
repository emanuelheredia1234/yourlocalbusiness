// Inspectors for two columns (each column its own small block list), social links (from the brand's profiles)
// and custom HTML (cleaned by the shared sanitizer before it's kept, with what was removed shown).

import { useId, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import type { ColumnChild, ColumnsBlock, CustomBlock, SocialBlock, SocialPlatform } from '../../../../../../shared/email/blocks.mjs';
import { COLUMN_TYPES, SOCIAL_LABELS, SOCIAL_PLATFORMS } from '../../../../../../shared/email/blocks.mjs';
import { sanitizeEmailCss, sanitizeEmailHtml, SanitizeError } from '../../../../../../shared/email/sanitize.mjs';
import { isHostedImage } from '@/lib/emailDoc';
import { CodeEditor } from '@/components/code/CodeEditor';
import { Callout, Field, Menu, Segmented, Toggle } from '@/components/ui/primitives';
import { BLOCK_LABEL, blockSummary, insertBlock, moveBlock, newBlock, patchBlock, removeBlock } from '../blockOps';
import { BlockInspector } from './index';
import type { InspectorProps } from './TextInspectors';

export function ColumnsInspector({ project, block, onChange }: InspectorProps<ColumnsBlock>) {
  const [open, setOpen] = useState<string | null>(null);
  const setCol = (i: 0 | 1, blocks: ColumnChild[]) => {
    const cols = [...block.cols] as ColumnsBlock['cols'];
    cols[i] = { blocks };
    onChange({ cols });
  };
  return (
    <div className="grid gap-3">
      <Segmented<ColumnsBlock['ratio']>
        size="sm"
        aria-label="Column widths"
        value={block.ratio}
        onChange={(ratio) => onChange({ ratio })}
        options={[
          { id: '50/50', label: 'Half and half' },
          { id: '33/67', label: 'Narrow left' },
          { id: '67/33', label: 'Narrow right' },
        ]}
      />
      <Toggle checked={block.stack} onChange={(stack) => onChange({ stack })} label="Stack on phones" />
      {([0, 1] as const).map((i) => {
        const list = block.cols[i].blocks;
        return (
          <div key={i} className="rounded-md border border-line p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-small font-medium text-ink">{i === 0 ? 'Left column' : 'Right column'}</p>
              <Menu
                trigger={
                  <button type="button" className="btn btn-ghost btn-xs" disabled={list.length >= 6}>
                    <Plus aria-hidden="true" /> Add
                  </button>
                }
                items={COLUMN_TYPES.map((t) => ({
                  label: BLOCK_LABEL[t],
                  onSelect: () => setCol(i, insertBlock(list, newBlock(t, project) as ColumnChild)),
                }))}
              />
            </div>
            <ul className="flex flex-col gap-1">
              {list.map((b) => (
                <li key={b.id} className="rounded border border-line">
                  <div className="flex items-center gap-1 px-2 py-1">
                    <button type="button" className="min-w-0 flex-1 truncate text-left text-small text-ink-2" aria-expanded={open === b.id} onClick={() => setOpen(open === b.id ? null : b.id)}>
                      <span className="text-muted">{BLOCK_LABEL[b.type]}:</span> {blockSummary(b)}
                    </button>
                    <button type="button" className="btn btn-ghost btn-icon btn-xs" aria-label="Move up" onClick={() => setCol(i, moveBlock(list, b.id, -1))}>
                      <ArrowUp />
                    </button>
                    <button type="button" className="btn btn-ghost btn-icon btn-xs" aria-label="Move down" onClick={() => setCol(i, moveBlock(list, b.id, 1))}>
                      <ArrowDown />
                    </button>
                    <button type="button" className="btn btn-ghost btn-icon btn-xs" aria-label="Remove" onClick={() => setCol(i, removeBlock(list, b.id))}>
                      <Trash2 />
                    </button>
                  </div>
                  {open === b.id && (
                    <div className="border-t border-line p-2">
                      <BlockInspector project={project} block={b} onChange={(patch) => setCol(i, patchBlock(list, b.id, patch as Partial<ColumnChild>))} />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

export function SocialInspector({ project, block, onChange }: InspectorProps<SocialBlock>) {
  const socials = (project.brand.socials ?? {}) as Partial<Record<SocialPlatform, string>>;
  const have = SOCIAL_PLATFORMS.filter((s) => socials[s]?.trim());
  const on = (pf: SocialPlatform) => block.links.some((l) => l.platform === pf);
  const toggle = (pf: SocialPlatform, v: boolean) =>
    onChange({
      links: v ? [...block.links, { platform: pf, url: socials[pf]!.trim() }] : block.links.filter((l) => l.platform !== pf),
    });
  return (
    <div className="grid gap-3">
      {have.length ? (
        have.map((pf) => <Toggle key={pf} checked={on(pf)} onChange={(v) => toggle(pf, v)} label={SOCIAL_LABELS[pf]} description={socials[pf]} />)
      ) : (
        <Callout tone="info">Add your social profiles in Settings › Brand first.</Callout>
      )}
      <Segmented<SocialBlock['style']>
        size="sm"
        aria-label="Style"
        value={block.style}
        onChange={(style) => onChange({ style })}
        options={[
          { id: 'text', label: 'Text links' },
          { id: 'icons', label: 'Icons' },
        ]}
      />
      {block.style === 'icons' && <p className="text-caption text-muted">Icons show where the app hosts them; otherwise the links show as text.</p>}
    </div>
  );
}

/** Custom HTML and CSS, cleaned for email: what's kept, and what was removed in plain words. */
export function cleanCustom(html: string, css: string): { ok: true; html: string; css: string; notes: string[] } | { ok: false; message: string } {
  try {
    // outside images go (tracking pixels, hotlinks); the claude.ai build has no hosting, so any https picture stays
    const h = sanitizeEmailHtml(html, { collectStyles: true, imageAllowed: (src) => __ARTIFACT_BUILD__ || isHostedImage(src) });
    const c = sanitizeEmailCss([css, h.styles ?? ''].filter(Boolean).join('\n'), { scope: '' });
    return {
      ok: true,
      html: h.html,
      css: c.css,
      notes: [...h.notes, ...c.notes],
    };
  } catch (e) {
    if (e instanceof SanitizeError)
      return {
        ok: false,
        message: 'This HTML is too big for one block (at most 20 KB once cleaned).',
      };
    return { ok: false, message: 'This HTML couldn’t be cleaned.' };
  }
}

export function CustomInspector({ block, onChange }: InspectorProps<CustomBlock>) {
  const ids = useId();
  const [html, setHtml] = useState(block.html);
  const [css, setCss] = useState(block.css ?? '');
  const [error, setError] = useState('');
  const dirty = html !== block.html || css !== (block.css ?? '');
  const apply = () => {
    const r = cleanCustom(html, css);
    if (!r.ok) return setError(r.message);
    setError('');
    setHtml(r.html);
    setCss(r.css);
    onChange({
      html: r.html,
      css: r.css || undefined,
      notes: r.notes.length ? r.notes : undefined,
      source: block.source,
    });
  };
  return (
    <div className="grid gap-3">
      <Callout tone="warn">Custom HTML may not look right in every inbox (Outlook especially). Scripts, forms, video and outside images are removed.</Callout>
      <Field label="HTML" htmlFor={`${ids}-html`}>
        <CodeEditor lang="html" value={html} onChange={setHtml} ariaLabel="Custom HTML" className="h-56" />
      </Field>
      <Field label="CSS (optional)" htmlFor={`${ids}-css`}>
        <CodeEditor lang="css" value={css} onChange={setCss} ariaLabel="Custom CSS" className="h-32" />
      </Field>
      <div className="flex items-center gap-2">
        <button type="button" className="btn btn-primary btn-sm" disabled={!dirty} onClick={apply}>
          Clean and apply
        </button>
        {dirty && <span className="text-caption text-muted">Not applied yet</span>}
      </div>
      {error && <Callout tone="bad">{error}</Callout>}
      {block.notes?.length ? (
        <Callout tone="info" title="Cleaned for email">
          <span data-testid="custom-notes">{block.notes.join(' ')}</span>
        </Callout>
      ) : null}
    </div>
  );
}
