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
        // Clean light system with an emerald brand accent.
        canvas: '#f6f8f7', // app background
        card: '#ffffff', // panels / cards
        sunken: '#f1f4f3', // insets, search field, segmented track
        hair: '#e6ebe8', // default border
        hairsoft: '#eef2f0', // subtle row dividers
        brand: {
          DEFAULT: '#059669',
          dim: '#047857',
          soft: '#ecfdf5',
        },
        ink: '#0f1a16', // primary text
        muted: '#5b6a64', // secondary text
        ghost: '#94a39c', // tertiary / placeholder
      },
      boxShadow: {
        card: '0 1px 2px rgba(16,24,20,0.04), 0 10px 28px -20px rgba(16,24,20,0.18)',
        glow: '0 0 0 1px rgba(5,150,105,0.15), 0 6px 18px -8px rgba(5,150,105,0.30)',
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
      },
      animation: {
        'pulse-soft': 'pulse-soft 1.6s ease-in-out infinite',
        shimmer: 'shimmer 1.6s infinite',
        'fade-in': 'fade-in 0.3s ease-out both',
      },
    },
  },
  plugins: [],
};

export default config;
