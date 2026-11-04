import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// The app's own cn() (src/lib/utils.ts) only joins strings; the shadcn files (and primitives whose
// defaults a caller may override) use this merging one, taught the app's custom scale names.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['micro', 'caption', 'small', 'body', 'ui', 'body-lg', 'h4', 'h3', 'title', 'h2', 'h1', 'kpi', 'display', 'display-xl', 'display-2xl', 'phone-h1', 'phone-display', 'phone-kpi', 'phone-hero', '2xs'] }],
      shadow: [{ shadow: ['xs', 'card', 'pop', 'dialog', 'product', 'ai', 'focus'] }],
      rounded: [{ rounded: ['pop', 'stage'] }],
      z: [{ z: ['topbar', 'launcher', 'overlay', 'nav', 'sheet', 'dialog', 'palette', 'pop', 'toast', 'tip'] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
