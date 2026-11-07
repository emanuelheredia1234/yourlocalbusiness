// The email studio (P5 §A2): an email's blocks on the left (above on phones), the live preview on the right, the
// selected block's inspector under the list. The first block edit writes the doc (a plain email gets one made from
// its words); the plain fields are derived from it. Theme and template at the top, with Undo for replacing changes.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { LayoutTemplate, Undo2 } from 'lucide-react';
import type { Block, BlockType, EmailDoc } from '../../../../../shared/email/blocks.mjs';
import type { EmailStep, Project } from '@/lib/types';
import { docOf, setDoc, undoDoc, useEmailUndo } from '@/lib/emailDoc';
import { toast } from '@/store/ui';
import { BlockList } from './BlockList';
import { BLOCK_LABEL, duplicateBlock, insertBlock, moveBlock, newBlock, patchBlock, removeBlock } from './blockOps';
import { EmailPreview } from './EmailFrame';
import { BlockInspector } from './inspectors';
import { TemplatePicker, ThemePicker } from './ThemePicker';

/** A value that settles `ms` after its last change (the preview re-renders after typing pauses). */
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function EmailStudio({ project, step, index, total, actions }: { project: Project; step: EmailStep; index: number; total: number; actions?: ReactNode }) {
  // made once per change of the email (a plain email's doc is made from its words; its ids come from the email's)
  const doc = useMemo(() => docOf(step, project), [step, project]);
  const [selected, setSelected] = useState<string | null>(doc.blocks[0]?.id ?? null);
  const [templates, setTemplates] = useState(false);
  const canUndo = useEmailUndo((s) => step.id in s);
  const preview = useDebounced(doc, 150);
  const write = (next: EmailDoc) => setDoc(project.id, step.id, next);
  const setBlocks = (blocks: Block[]) => write({ ...doc, blocks });
  const block = doc.blocks.find((b) => b.id === selected) ?? null;

  const add = (type: BlockType) => {
    const b = newBlock(type, project);
    setBlocks(insertBlock(doc.blocks, b, selected ?? undefined));
    setSelected(b.id);
  };
  const remove = (id: string) => {
    const i = doc.blocks.findIndex((b) => b.id === id);
    const next = removeBlock(doc.blocks, id);
    setBlocks(next);
    if (selected === id) setSelected(next[Math.max(0, i - 1)]?.id ?? null);
  };
  const undo = () => {
    if (undoDoc(project.id, step.id)) toast({ kind: 'info', title: 'Put the earlier design back' });
  };

  return (
    <div className="flex flex-col gap-4" data-testid="email-studio">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <ThemePicker project={project} step={step} doc={doc} />
        <div className="flex flex-wrap items-center gap-2">
          {actions}
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setTemplates(true)}>
            <LayoutTemplate aria-hidden="true" /> Start from a template
          </button>
          {canUndo && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={undo}>
              <Undo2 aria-hidden="true" /> Undo
            </button>
          )}
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <BlockList
            blocks={doc.blocks}
            selected={selected}
            onSelect={setSelected}
            onMove={(id, dir) => setBlocks(moveBlock(doc.blocks, id, dir))}
            onDuplicate={(id) => setBlocks(duplicateBlock(doc.blocks, id))}
            onRemove={remove}
            onAdd={add}
          />
          {block && (
            <section className="rounded-md border border-line p-3" aria-label={`${BLOCK_LABEL[block.type]} settings`} data-testid="inspector">
              <p className="mb-3 text-small font-semibold text-ink">{BLOCK_LABEL[block.type]}</p>
              <BlockInspector key={block.id} project={project} block={block} onChange={(patch) => setBlocks(patchBlock(doc.blocks, block.id, patch))} />
            </section>
          )}
        </div>
        <EmailPreview project={project} step={step} doc={preview} />
      </div>
      <TemplatePicker project={project} step={step} doc={doc} index={index} total={total} open={templates} onClose={() => setTemplates(false)} />
    </div>
  );
}
