import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-inter)', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      colors: {
        // Cool, light blue-grey system with a navy/blue accent (HOSPITY-style).
        canvas: '#e9edf4', // app background
        card: '#ffffff', // panels / cards
        sunken: '#eef2f8', // insets, search field, segmented track
        hair: '#e2e8f1', // default border
        hairsoft: '#edf1f7', // subtle row dividers
        navy: {
          DEFAULT: '#0b2545', // deep navy — active nav, dark buttons
          soft: '#eef2fb',
        },
        // `brand` is the blue accent (links, progress, focus rings).
        brand: {
          DEFAULT: '#2f6fed',
          dim: '#2257c7',
          soft: '#eaf1ff',
        },
        ink: '#0b1f3a', // primary text (deep navy)
        muted: '#5d6b86', // secondary text
        ghost: '#9aa6bd', // tertiary / placeholder
      },
      boxShadow: {
        card: '0 1px 2px rgba(11,31,58,0.04), 0 18px 40px -24px rgba(11,31,58,0.18)',
        soft: '0 2px 6px rgba(11,31,58,0.05), 0 24px 48px -28px rgba(11,31,58,0.22)',
        glow: '0 0 0 1px rgba(47,111,237,0.14), 0 8px 22px -8px rgba(47,111,237,0.32)',
      },
      borderRadius: {
        '4xl': '1.75rem',
      },
      keyframes: {
        'pulse-soft': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.45' },
        },
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
        'fade-in': {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        indeterminate: {
          '0%': { transform: 'translateX(-110%)' },
          '100%': { transform: 'translateX(320%)' },
        },
      },
      animation: {
        'pulse-soft': 'pulse-soft 1.6s ease-in-out infinite',
        shimmer: 'shimmer 1.6s infinite',
        'fade-in': 'fade-in 0.3s ease-out both',
        indeterminate: 'indeterminate 1.4s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};

export default config;
