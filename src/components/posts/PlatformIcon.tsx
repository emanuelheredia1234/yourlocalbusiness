import type { SocialPlatform } from '@/lib/types';
import { PLATFORMS } from '@/ai/knowledge';
import { cn } from '@/lib/utils';

/** Simple platform glyphs (not official marks) so each network is recognizable at a glance. */
export function PlatformGlyph({ platform, size = 16, className }: { platform: SocialPlatform; size?: number; className?: string }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', className: cn('shrink-0', className), 'aria-hidden': true } as const;
  switch (platform) {
    case 'instagram':
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="3" width="18" height="18" rx="5" />
          <circle cx="12" cy="12" r="4" />
          <circle cx="17.3" cy="6.7" r="1.1" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'facebook':
      return (
        <svg {...common} fill="currentColor">
          <path d="M13.5 22v-8h2.7l.4-3.2h-3.1V8.8c0-.9.3-1.6 1.6-1.6h1.7V4.4c-.3 0-1.3-.1-2.5-.1-2.5 0-4.2 1.5-4.2 4.3v2.3H7.4V14h2.7v8h3.4z" />
        </svg>
      );
    case 'tiktok':
      return (
        <svg {...common} fill="currentColor">
          <path d="M16.6 2h-3.3v13.2a2.9 2.9 0 1 1-2.1-2.8V9a6.3 6.3 0 1 0 5.4 6.2V8.6a7.8 7.8 0 0 0 4.4 1.4V6.7a4.5 4.5 0 0 1-4.4-4.7z" />
        </svg>
      );
    case 'linkedin':
      return (
        <svg {...common} fill="currentColor">
          <path d="M4.98 3.5a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM3.3 9h3.4v12H3.3zM9.3 9h3.2v1.7h.1c.5-.9 1.6-1.9 3.4-1.9 3.6 0 4.3 2.4 4.3 5.5V21h-3.4v-5.9c0-1.4 0-3.2-2-3.2s-2.2 1.5-2.2 3.1v6H9.3z" />
        </svg>
      );
    case 'x':
      return (
        <svg {...common} fill="currentColor">
          <path d="M17.8 3h3.1l-6.8 7.8 8 10.2h-6.3l-4.9-6.4-5.6 6.4H2.2l7.3-8.3L1.8 3h6.4l4.4 5.8L17.8 3zm-1.1 16.2h1.7L7.4 4.7H5.6l11.1 14.5z" />
        </svg>
      );
    case 'youtube':
      return (
        <svg {...common} fill="currentColor">
          <path d="M21.6 7.2a2.6 2.6 0 0 0-1.8-1.8C18.2 5 12 5 12 5s-6.2 0-7.8.4A2.6 2.6 0 0 0 2.4 7.2 27 27 0 0 0 2 12a27 27 0 0 0 .4 4.8 2.6 2.6 0 0 0 1.8 1.8C5.8 19 12 19 12 19s6.2 0 7.8-.4a2.6 2.6 0 0 0 1.8-1.8A27 27 0 0 0 22 12a27 27 0 0 0-.4-4.8zM10 15V9l5.2 3L10 15z" />
        </svg>
      );
  }
}

export function PlatformChip({ platform, className, showLabel = true }: { platform: SocialPlatform; className?: string; showLabel?: boolean }) {
  const p = PLATFORMS[platform];
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs font-semibold text-ink-2', className)}>
      <span className="flex h-5 w-5 items-center justify-center rounded-md text-white" style={{ background: p.color }}>
        <PlatformGlyph platform={platform} size={12} />
      </span>
      {showLabel && p.label}
    </span>
  );
}
