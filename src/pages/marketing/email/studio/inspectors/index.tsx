// The inspector for a block, by its type.

import type { Block } from '../../../../../../shared/email/blocks.mjs';
import type { Project } from '@/lib/types';
import { ButtonInspector, DividerInspector, HeadingInspector, TextInspector } from './TextInspectors';
import { ImageInspector, OfferInspector, VideoInspector } from './MediaInspectors';
import { ColumnsInspector, CustomInspector, SocialInspector } from './LayoutInspectors';

export function BlockInspector({ project, block, onChange }: { project: Project; block: Block; onChange: (patch: Partial<Block>) => void }) {
  // each inspector gets its own block type's patch
  const set = onChange as (patch: object) => void;
  switch (block.type) {
    case 'heading':
      return <HeadingInspector project={project} block={block} onChange={set} />;
    case 'text':
      return <TextInspector project={project} block={block} onChange={set} />;
    case 'button':
      return <ButtonInspector project={project} block={block} onChange={set} />;
    case 'divider':
      return <DividerInspector project={project} block={block} onChange={set} />;
    case 'image':
      return <ImageInspector project={project} block={block} onChange={set} />;
    case 'video':
      return <VideoInspector project={project} block={block} onChange={set} />;
    case 'offer':
      return <OfferInspector project={project} block={block} onChange={set} />;
    case 'columns':
      return <ColumnsInspector project={project} block={block} onChange={set} />;
    case 'social':
      return <SocialInspector project={project} block={block} onChange={set} />;
    case 'custom':
      return <CustomInspector key={block.id} project={project} block={block} onChange={set} />;
  }
}
