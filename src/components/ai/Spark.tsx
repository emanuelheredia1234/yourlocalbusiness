// The one AI glyph (replaces lucide Sparkles/WandSparkles in AI moments), painted with the aura.
// The gradient is defined once (AuraDefs, mounted in main.tsx outside the sign-in gate, so sign-in and
// onboarding have it too) and referenced by id; stop-color goes through `style` because CSS variables
// don't work in SVG presentation attributes. In forced-colours mode the paths use CanvasText (index.css).

import { cn } from '@/lib/utils';

export type SparkSize = 12 | 14 | 16 | 18 | 20 | 24;

export function Spark({ size = 16, className, mono = false }: { size?: SparkSize; className?: string; mono?: boolean }) {
  const fill = mono ? 'currentColor' : 'url(#ylb-aura)';
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" className={cn('spark shrink-0', className)}>
      <path fill={fill} d="M10 3.5c.55 4.3 3.7 7.45 8 8-4.3.55-7.45 3.7-8 8-.55-4.3-3.7-7.45-8-8 4.3-.55 7.45-3.7 8-8Z" />
      <path fill={fill} d="M19 2c.22 1.7 1.3 2.78 3 3-1.7.22-2.78 1.3-3 3-.22-1.7-1.3-2.78-3-3 1.7-.22 2.78-1.3 3-3Z" />
    </svg>
  );
}

/** A small aura-edged tile holding a Spark (the command palette's "Ask AI" row). */
export function AiTile({ size = 24, className }: { size?: 24 | 28 | 32; className?: string }) {
  return (
    <span className={cn('aura-edge flex shrink-0 items-center justify-center rounded', className)} style={{ width: size, height: size }} aria-hidden="true">
      <Spark size={size >= 32 ? 16 : 14} />
    </span>
  );
}

/** The aura gradient every Spark (and the app mark's spark) paints with. Mount once. */
export function AuraDefs() {
  return (
    <svg width="0" height="0" className="absolute" aria-hidden="true" focusable="false" style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }}>
      <defs>
        <linearGradient id="ylb-aura" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" style={{ stopColor: 'rgb(var(--ai-1))' }} />
          <stop offset=".55" style={{ stopColor: 'rgb(var(--ai-2))' }} />
          <stop offset="1" style={{ stopColor: 'rgb(var(--ai-3))' }} />
        </linearGradient>
      </defs>
    </svg>
  );
}
