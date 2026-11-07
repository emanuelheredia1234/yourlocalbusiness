// The email studio's block edits (P5 §A2): new blocks with their defaults, and insert, move, duplicate, remove and
// patch on a list of blocks (an email's, or one column's). Pure: the studio writes the result with setDoc.

import type { Block, BlockType, ColumnChild, EmailDoc } from '../../../../../shared/email/blocks.mjs';
import { SOCIAL_LABELS } from '../../../../../shared/email/blocks.mjs';
import type { Project } from '@/lib/types';
import { newBlockId } from '@/lib/emailDoc';

export const BLOCK_LABEL: Record<BlockType, string> = {
  heading: 'Heading',
  text: 'Text',
  image: 'Image',
  button: 'Button',
  columns: 'Two columns',
  offer: 'Offer card',
  video: 'Video',
  social: 'Social links',
  divider: 'Divider',
  custom: 'Custom HTML',
};

/** The order "Add block" offers them in. */
export const ADD_ORDER: BlockType[] = ['heading', 'text', 'image', 'button', 'columns', 'offer', 'video', 'social', 'divider', 'custom'];

/** A new block of a type, with sensible defaults (social links from the brand's profiles). */
export function newBlock(type: BlockType, p?: Project): Block {
  const id = newBlockId();
  switch (type) {
    case 'heading':
      return { id, type, text: 'A short heading', level: 2 };
    case 'text':
      return { id, type, text: 'Write something helpful here.' };
    case 'image':
      return { id, type, src: '', alt: '', width: 'full', origin: 'url' };
    case 'button':
      return {
        id,
        type,
        label: 'Learn more',
        link: { kind: 'page' },
        style: 'solid',
      };
    case 'columns':
      return {
        id,
        type,
        ratio: '50/50',
        stack: true,
        cols: [
          { blocks: [{ id: newBlockId(), type: 'text', text: 'Left column' }] },
          {
            blocks: [{ id: newBlockId(), type: 'text', text: 'Right column' }],
          },
        ],
      };
    case 'offer':
      return {
        id,
        type,
        offerId: '',
        title: '',
        price: '',
        buttonLabel: 'Buy now',
      };
    case 'video':
      return {
        id,
        type,
        thumb: { src: '', alt: '' },
        link: { kind: 'url', url: '' },
      };
    case 'social': {
      const links = Object.entries(p?.brand.socials ?? {})
        .filter(([k, v]) => typeof v === 'string' && v.trim() && Object.hasOwn(SOCIAL_LABELS, k))
        .slice(0, 8)
        .map(([platform, url]) => ({
          platform,
          url: url as string,
        })) as Extract<Block, { type: 'social' }>['links'];
      return { id, type, links, style: 'text' };
    }
    case 'divider':
      return { id, type, style: 'line', size: 24 };
    case 'custom':
      return { id, type, html: '<p>Your HTML</p>', source: 'owner' };
  }
}

/** A fresh copy of a block (new ids, columns' children too). */
export function copyBlock<T extends Block>(b: T): T {
  const c = structuredClone(b) as T;
  c.id = newBlockId();
  if (c.type === 'columns') for (const col of c.cols) for (const x of col.blocks) x.id = newBlockId();
  return c;
}

/** `list` with `block` after the block `afterId` (at the end when it's absent or not there). */
export function insertBlock<T extends Block | ColumnChild>(list: T[], block: T, afterId?: string): T[] {
  const i = afterId ? list.findIndex((b) => b.id === afterId) : -1;
  if (i < 0) return [...list, block];
  return [...list.slice(0, i + 1), block, ...list.slice(i + 1)];
}

/** `list` with the block moved one place up (-1) or down (+1); unchanged at an end. */
export function moveBlock<T extends { id: string }>(list: T[], id: string, dir: -1 | 1): T[] {
  const i = list.findIndex((b) => b.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return list;
  const out = [...list];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

export const removeBlock = <T extends { id: string }>(list: T[], id: string): T[] => list.filter((b) => b.id !== id);

export function duplicateBlock<T extends Block>(list: T[], id: string): T[] {
  const b = list.find((x) => x.id === id);
  return b ? insertBlock(list, copyBlock(b), id) : list;
}

export function patchBlock<T extends { id: string }>(list: T[], id: string, patch: Partial<T>): T[] {
  return list.map((b) => (b.id === id ? ({ ...b, ...patch } as T) : b));
}

/** The doc with new top-level blocks. */
export const withBlocks = (doc: EmailDoc, blocks: Block[]): EmailDoc => ({
  ...doc,
  blocks,
});

const oneLine = (s: string, max = 60) => {
  const t = s
    .replace(/[*_[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** A short summary for the block list. */
export function blockSummary(b: Block): string {
  switch (b.type) {
    case 'heading':
    case 'text':
      return oneLine(b.text) || 'Empty';
    case 'image':
      return b.src ? oneLine(b.alt) || 'No description yet' : b.prompt ? `Picture idea: ${oneLine(b.prompt, 48)}` : 'No picture yet';
    case 'button':
      return oneLine(b.label) || 'No label';
    case 'columns':
      return `${b.ratio} · ${b.cols[0].blocks.length + b.cols[1].blocks.length} blocks`;
    case 'offer':
      return oneLine(b.title) || 'Choose an offer';
    case 'video':
      return b.link.url ? oneLine(b.caption || b.link.url) : 'No video link yet';
    case 'social':
      return b.links.length ? b.links.map((l) => SOCIAL_LABELS[l.platform]).join(', ') : 'No links';
    case 'divider':
      return b.style === 'line' ? 'Line' : 'Space';
    case 'custom':
      return b.source === 'agent' ? 'Designed by an agent' : 'Your HTML';
  }
}
