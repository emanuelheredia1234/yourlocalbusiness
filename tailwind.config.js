import animate from 'tailwindcss-animate';

/*
  "Ink & Aura": near-black/white chrome, Geist, ink primary buttons, iris (#5A3AF7) only for state,
  the purple-to-orange aura only for AI moments. Every colour is an RGB-channel CSS variable
  (src/index.css), so opacity modifiers work (bg-primary/10) and the dark set is written once.
*/
/** @type {import('tailwindcss').Config} */
const token = (name) => `rgb(var(--${name}) / <alpha-value>)`;
const names = ['bg', 'surface', 'surface-2', 'surface-3', 'elevated', 'selected', 'line', 'line-2', 'line-3', 'ink', 'ink-2', 'muted', 'faint',
  'inverse', 'on-inverse', 'action', 'action-hover', 'action-active', 'on-action', 'primary', 'primary-hover', 'on-primary', 'primary-soft', 'primary-line',
  'ring', 'ring-offset', 'thumb', 'good', 'good-solid', 'good-soft', 'good-line', 'warn', 'warn-solid', 'on-warn', 'warn-soft', 'warn-line',
  'bad', 'bad-solid', 'bad-solid-hover', 'on-bad', 'bad-soft', 'bad-line', 'ai-1', 'ai-2', 'ai-3', 'overlay', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8',
  'ord-1', 'ord-2', 'ord-3', 'ord-4',
  'primary-2', 'info', 'info-soft', 'accent', 'accent-soft', 'on-accent']; // last six: legacy aliases (Phase 3 deletes)
const sans = ['"Geist Variable"', '"Geist Fallback"', 'ui-sans-serif', 'system-ui', '-apple-system', '"Segoe UI"', 'sans-serif'];
const type = (size, line, extra = {}) => [size, { lineHeight: line, ...extra }];

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        ...Object.fromEntries(names.map((n) => [n, token(n)])),
        // shadcn/ui vocabulary mapped onto ours
        background: token('surface'), foreground: token('ink'),
        card: token('surface'), 'card-foreground': token('ink'),
        popover: token('elevated'), 'popover-foreground': token('ink'),
        'primary-foreground': token('on-primary'),
        secondary: token('surface-3'), 'secondary-foreground': token('ink'),
        'accent-foreground': token('ink'),
        'muted-foreground': token('muted'),
        border: token('line'), input: token('line-2'),
        destructive: token('bad-solid'), 'destructive-foreground': token('on-bad'),
      },
      fontFamily: {
        sans, display: sans,
        mono: ['"Geist Mono Variable"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
        editorial: ['"Instrument Serif"', 'Georgia', '"Times New Roman"', 'serif'],
        brand: ['"Bricolage Grotesque"', 'system-ui', 'sans-serif'], // customer content only
        serif: ['Fraunces', 'Georgia', '"Times New Roman"', 'serif'],
        hand: ['Caveat', '"Comic Sans MS"', 'cursive'],
        poster: ['Anton', 'Impact', '"Arial Narrow"', 'sans-serif'],
      },
      fontSize: {
        micro: type('11px', '14px', { fontWeight: '500' }),
        caption: type('12px', '16px'),
        small: type('13px', '20px'),
        body: type('14px', '22px'),
        ui: type('14px', '20px', { fontWeight: '500', letterSpacing: '-0.005em' }),
        'body-lg': type('16px', '26px'),
        h4: type('14px', '20px', { fontWeight: '600', letterSpacing: '-0.006em' }),
        h3: type('16px', '24px', { fontWeight: '600', letterSpacing: '-0.012em' }),
        title: type('18px', '26px', { fontWeight: '600', letterSpacing: '-0.015em' }),
        h2: type('20px', '28px', { fontWeight: '600', letterSpacing: '-0.02em' }),
        h1: type('30px', '36px', { fontWeight: '600', letterSpacing: '-0.03em' }),
        kpi: type('34px', '40px', { fontWeight: '600', letterSpacing: '-0.035em' }),
        display: type('36px', '40px', { fontWeight: '650', letterSpacing: '-0.035em' }),
        'display-xl': type('44px', '48px', { fontWeight: '650', letterSpacing: '-0.04em' }),
        'display-2xl': type('56px', '58px', { fontWeight: '650', letterSpacing: '-0.045em' }),
        'phone-h1': type('24px', '30px', { fontWeight: '600', letterSpacing: '-0.025em' }),
        'phone-display': type('28px', '32px', { fontWeight: '650', letterSpacing: '-0.03em' }),
        'phone-kpi': type('28px', '34px', { fontWeight: '600', letterSpacing: '-0.03em' }),
        'phone-hero': type('36px', '40px', { fontWeight: '650', letterSpacing: '-0.035em' }),
        '2xs': type('11px', '14px'), // legacy name = micro without the weight
      },
      borderRadius: { xs: '4px', sm: '6px', DEFAULT: '8px', md: '10px', pop: '12px', lg: '14px', stage: '16px', xl: '20px', '2xl': '24px' },
      boxShadow: {
        xs: 'var(--shadow-xs)', DEFAULT: 'var(--shadow-sm)', sm: 'var(--shadow-sm)', card: 'var(--shadow-card)', md: 'var(--shadow-md)',
        pop: 'var(--shadow-pop)', lg: 'var(--shadow-pop)', dialog: 'var(--shadow-dialog)', xl: 'var(--shadow-dialog)',
        product: 'var(--shadow-product)', ai: 'var(--glow-ai)', focus: '0 0 0 3px rgb(var(--ring) / .18)',
      },
      transitionDuration: { 120: '120ms', 180: '180ms', 240: '240ms', 320: '320ms' },
      transitionTimingFunction: { out: 'cubic-bezier(0.22, 1, 0.36, 1)', 'in-out': 'cubic-bezier(0.65, 0, 0.35, 1)', exit: 'cubic-bezier(0.4, 0, 1, 1)' },
      zIndex: { topbar: '20', launcher: '40', overlay: '45', nav: '50', sheet: '55', dialog: '60', palette: '65', pop: '70', toast: '80', tip: '90' },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'rise-in': { from: { opacity: '0', transform: 'translateY(4px)' }, to: { opacity: '1', transform: 'none' } },
        'slide-in-right': { from: { transform: 'translateX(100%)' }, to: { transform: 'none' } },
        shimmer: { '0%': { backgroundPosition: '200% 0' }, '100%': { backgroundPosition: '-200% 0' } },
        'pulse-dot': { '0%,100%': { opacity: '0.35' }, '50%': { opacity: '1' } },
        spin: { to: { transform: 'rotate(360deg)' } },
        breathe: { '0%,100%': { transform: 'scale(.9)', opacity: '.85' }, '50%': { transform: 'scale(1.06)', opacity: '1' } },
        'aura-sweep': { '0%': { opacity: '1' }, '100%': { opacity: '0' } },
        'accordion-down': { from: { height: '0' }, to: { height: 'var(--radix-accordion-content-height)' } },
        'accordion-up': { from: { height: 'var(--radix-accordion-content-height)' }, to: { height: '0' } },
      },
      animation: {
        'fade-in': 'fade-in 120ms cubic-bezier(0.22,1,0.36,1) both',
        'rise-in': 'rise-in 240ms cubic-bezier(0.22,1,0.36,1) both',
        'slide-in-right': 'slide-in-right 320ms cubic-bezier(0.22,1,0.36,1) both',
        shimmer: 'shimmer 1.6s linear infinite',
        'shimmer-text': 'shimmer 2.2s linear infinite',
        'pulse-dot': 'pulse-dot 1.2s ease-in-out infinite',
        breathe: 'breathe 2s cubic-bezier(0.65,0,0.35,1) infinite',
        'aura-sweep': 'aura-sweep 1.2s cubic-bezier(0.22,1,0.36,1) both',
        'accordion-down': 'accordion-down 180ms cubic-bezier(0.22,1,0.36,1)',
        'accordion-up': 'accordion-up 180ms cubic-bezier(0.22,1,0.36,1)',
      },
    },
  },
  plugins: [animate],
};
