// The email's blocks in order (P5 §A2): each row its type, a short summary, and move up/down, duplicate and delete.
// Keyboard: ↑/↓ move the selection, Alt+↑/↓ move the selected block. "Add block" adds after the selected one.

import type { KeyboardEvent } from 'react';
import { ArrowDown, ArrowUp, Code, Columns2, Copy, Heading, Image, Minus, MousePointerClick, Plus, Share2, ShoppingBag, Trash2, Type, Video } from 'lucide-react';
import type { Block, BlockType } from '../../../../../shared/email/blocks.mjs';
import { cn } from '@/lib/utils';
import { Menu } from '@/components/ui/primitives';
import { ADD_ORDER, BLOCK_LABEL, blockSummary } from './blockOps';

const ICON: Record<BlockType, typeof Type> = {
  heading: Heading,
  text: Type,
  image: Image,
  button: MousePointerClick,
  columns: Columns2,
  offer: ShoppingBag,
  video: Video,
  social: Share2,
  divider: Minus,
  custom: Code,
};

export function BlockList({
  blocks,
  selected,
  onSelect,
  onMove,
  onDuplicate,
  onRemove,
  onAdd,
}: {
  blocks: Block[];
  selected: string | null;
  onSelect: (id: string) => void;
  onMove: (id: string, dir: -1 | 1) => void;
  onDuplicate: (id: string) => void;
  onRemove: (id: string) => void;
  onAdd: (type: BlockType) => void;
}) {
  const keys = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    const dir = e.key === 'ArrowUp' ? -1 : 1;
    const i = blocks.findIndex((b) => b.id === selected);
    e.preventDefault();
    if (e.altKey && selected) onMove(selected, dir);
    else {
      const next = blocks[Math.max(0, Math.min(blocks.length - 1, i < 0 ? 0 : i + dir))];
      if (next) onSelect(next.id);
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-1 outline-none focus-visible:shadow-focus" tabIndex={0} onKeyDown={keys} aria-label="Blocks (arrow keys select, Alt+arrows move)" data-testid="block-list">
        {blocks.map((b, i) => {
          const Icon = ICON[b.type];
          const on = b.id === selected;
          return (
            <li key={b.id} className={cn('flex items-center gap-1 rounded-md border px-2 py-1.5', on ? 'border-line-2 bg-surface-2' : 'border-line')}>
              <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" aria-pressed={on} onClick={() => onSelect(b.id)}>
                <Icon size={16} className="shrink-0 text-muted" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block text-caption text-muted">{BLOCK_LABEL[b.type]}</span>
                  <span className="block truncate text-small text-ink">{blockSummary(b)}</span>
                </span>
              </button>
              <button type="button" className="btn btn-ghost btn-icon btn-xs" aria-label={`Move ${BLOCK_LABEL[b.type]} up`} disabled={i === 0} onClick={() => onMove(b.id, -1)}>
                <ArrowUp />
              </button>
              <button type="button" className="btn btn-ghost btn-icon btn-xs" aria-label={`Move ${BLOCK_LABEL[b.type]} down`} disabled={i === blocks.length - 1} onClick={() => onMove(b.id, 1)}>
                <ArrowDown />
              </button>
              <button type="button" className="btn btn-ghost btn-icon btn-xs" aria-label={`Duplicate ${BLOCK_LABEL[b.type]}`} onClick={() => onDuplicate(b.id)}>
                <Copy />
              </button>
              <button type="button" className="btn btn-ghost btn-icon btn-xs" aria-label={`Delete ${BLOCK_LABEL[b.type]}`} onClick={() => onRemove(b.id)}>
                <Trash2 />
              </button>
            </li>
          );
        })}
      </ul>
      <Menu
        align="start"
        trigger={
          <button type="button" className="btn btn-secondary btn-sm self-start" disabled={blocks.length >= 60}>
            <Plus aria-hidden="true" /> Add block
          </button>
        }
        items={ADD_ORDER.map((t) => {
          const Icon = ICON[t];
          return {
            label: BLOCK_LABEL[t],
            icon: <Icon />,
            onSelect: () => onAdd(t),
          };
        })}
      />
    </div>
  );
}
