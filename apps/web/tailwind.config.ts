import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: 'class',
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        accent: {
          DEFAULT: '#06b6d4',
          50: '#ecfeff',
          100: '#cffafe',
          200: '#a5f3fc',
          300: '#67e8f9',
          400: '#22d3ee',
          500: '#06b6d4',
          600: '#0891b2',
          700: '#0e7490',
          800: '#155e75',
          900: '#164e63',
        },
        surface: {
          DEFAULT: '#0a0a0a',
          50: '#171717',
          100: '#1a1a1a',
          200: '#262626',
          300: '#404040',
        },
      },
      animation: {
        // Slow, low-key pulse for the "10 envíos gratis" hero badge.
        // Default `animate-pulse` (1s) is too aggressive and feels like
        // an alert; 4s reads as "alive" without distracting from the
        // hero copy. Used in app/page.tsx hero badge.
        'pulse-slow': 'pulse 4s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      },
    },
  },
  plugins: [],
};

export default config;
