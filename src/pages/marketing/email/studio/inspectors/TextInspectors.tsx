// Inspectors for the simple blocks: heading, text (with merge tags and links), button and divider.

import { useId, useRef } from 'react';
import type { ButtonBlock, DividerBlock, HeadingBlock, Link, TextBlock } from '../../../../../../shared/email/blocks.mjs';
import { linkToken } from '../../../../../../shared/email/blocks.mjs';
import type { Project } from '@/lib/types';
import { publishedAssetLinks } from '@/lib/emailDoc';
import { AutoTextarea, Field, Menu, Segmented, Toggle } from '@/components/ui/primitives';
import { LinkPicker } from '../LinkPicker';

export interface InspectorProps<B> {
  project: Project;
  block: B;
  onChange: (patch: Partial<B>) => void;
}

const MERGE = [
  { tag: '{{first_name}}', label: 'First name' },
  { tag: '{{lead_magnet_link}}', label: 'Free download link' },
  { tag: '{{product_link}}', label: 'Page link' },
  { tag: '{{sender_name}}', label: 'Your name' },
  { tag: '{{brand}}', label: 'Business name' },
];

export function HeadingInspector({ block, onChange }: InspectorProps<HeadingBlock>) {
  const id = useId();
  return (
    <div className="grid gap-3">
      <Field label="Heading" htmlFor={id}>
        <input id={id} className="input" value={block.text} onChange={(e) => onChange({ text: e.target.value })} />
      </Field>
      <Segmented<'1' | '2' | '3'>
        size="sm"
        aria-label="Heading size"
        value={String(block.level) as '1' | '2' | '3'}
        onChange={(v) => onChange({ level: Number(v) as 1 | 2 | 3 })}
        options={[
          { id: '1', label: 'Large' },
          { id: '2', label: 'Medium' },
          { id: '3', label: 'Small' },
        ]}
      />
    </div>
  );
}

export function TextInspector({ project, block, onChange }: InspectorProps<TextBlock>) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  // markup (a link) makes a plain block styled text; a merge tag doesn't
  const insert = (s: string, markup = false) => {
    const el = ref.current?.querySelector('textarea');
    const at = el ? el.selectionStart : block.text.length;
    onChange({
      text: `${block.text.slice(0, at)}${s}${block.text.slice(at)}`,
      ...(markup ? { plain: undefined } : {}),
    });
  };
  const linkTo = (l: Link) => {
    const target = linkToken(l, publishedAssetLinks(project));
    if (target) insert(`[link text](${target})`, true);
  };
  return (
    <div className="grid gap-3" ref={ref}>
      <Field
        label="Text"
        htmlFor={id}
        hint={
          block.plain
            ? 'Kept exactly as you typed it (your plain email). Insert a link to make it styled text.'
            : 'Use **bold**, *italic*, [text](link), and lines starting with "- " for a list. A blank line starts a new paragraph.'
        }
      >
        <AutoTextarea id={id} value={block.text} onChange={(v) => onChange({ text: v })} minRows={6} />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Menu
          trigger={
            <button type="button" className="btn btn-secondary btn-xs">
              Insert merge tag
            </button>
          }
          align="start"
          items={MERGE.map((m) => ({
            label: m.label,
            onSelect: () => insert(m.tag),
          }))}
        />
        <Menu
          trigger={
            <button type="button" className="btn btn-secondary btn-xs">
              Insert link
            </button>
          }
          align="start"
          items={[
            {
              label: 'Your free download',
              onSelect: () => linkTo({ kind: 'magnet' }),
            },
            { label: 'Your page', onSelect: () => linkTo({ kind: 'page' }) },
            {
              label: 'A web address',
              onSelect: () => insert('[link text](https://)', true),
            },
          ]}
        />
      </div>
    </div>
  );
}

export function ButtonInspector({ project, block, onChange }: InspectorProps<ButtonBlock>) {
  const id = useId();
  return (
    <div className="grid gap-3">
      <Field label="Button label" htmlFor={id}>
        <input id={id} className="input" value={block.label} onChange={(e) => onChange({ label: e.target.value })} />
      </Field>
      <LinkPicker project={project} value={block.link} onChange={(link) => onChange({ link })} />
      <Segmented<'solid' | 'outline'>
        size="sm"
        aria-label="Button style"
        value={block.style}
        onChange={(style) => onChange({ style })}
        options={[
          { id: 'solid', label: 'Solid' },
          { id: 'outline', label: 'Outline' },
        ]}
      />
      <Toggle checked={!!block.full} onChange={(v) => onChange({ full: v || undefined })} label="Full width" />
    </div>
  );
}

export function DividerInspector({ block, onChange }: InspectorProps<DividerBlock>) {
  const id = useId();
  return (
    <div className="grid gap-3">
      <Segmented<'line' | 'space'>
        size="sm"
        aria-label="Divider style"
        value={block.style}
        onChange={(style) => onChange({ style })}
        options={[
          { id: 'line', label: 'Line' },
          { id: 'space', label: 'Space' },
        ]}
      />
      <Field label={`Height: ${block.size}px`} htmlFor={id}>
        <input id={id} type="range" min={8} max={64} step={4} value={block.size} onChange={(e) => onChange({ size: Number(e.target.value) })} className="w-full" />
      </Field>
    </div>
  );
}
