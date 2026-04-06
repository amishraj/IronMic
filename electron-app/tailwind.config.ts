import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/renderer/**/*.{tsx,ts,html}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      colors: {
        iron: {
          bg: 'rgb(var(--iron-bg) / <alpha-value>)',
          surface: 'rgb(var(--iron-surface) / <alpha-value>)',
          'surface-hover': 'rgb(var(--iron-surface-hover) / <alpha-value>)',
          'surface-active': 'rgb(var(--iron-surface-active) / <alpha-value>)',
          border: 'rgb(var(--iron-border) / var(--iron-border-alpha))',
          'border-hover': 'rgb(var(--iron-border-hover) / var(--iron-border-hover-alpha))',
          text: 'rgb(var(--iron-text) / <alpha-value>)',
          'text-secondary': 'rgb(var(--iron-text-secondary) / <alpha-value>)',
          'text-muted': 'rgb(var(--iron-text-muted) / <alpha-value>)',
          accent: 'rgb(var(--iron-accent) / <alpha-value>)',
          'accent-hover': 'rgb(var(--iron-accent-hover) / <alpha-value>)',
          'accent-light': 'rgb(var(--iron-accent-light) / <alpha-value>)',
          danger: 'rgb(var(--iron-danger) / <alpha-value>)',
          'danger-hover': 'rgb(var(--iron-danger-hover) / <alpha-value>)',
          success: 'rgb(var(--iron-success) / <alpha-value>)',
          warning: 'rgb(var(--iron-warning) / <alpha-value>)',
        },
      },
      borderRadius: {
        DEFAULT: '8px',
        lg: '10px',
        xl: '12px',
      },
      boxShadow: {
        glow: 'var(--iron-shadow-glow)',
        'glow-strong': 'var(--iron-shadow-glow-strong)',
        'glow-danger': '0 0 20px rgba(var(--iron-danger) / 0.15)',
        'glow-success': '0 0 20px rgba(var(--iron-success) / 0.15)',
        'depth-sm': 'var(--iron-shadow-depth-sm)',
        depth: 'var(--iron-shadow-depth)',
        'depth-lg': 'var(--iron-shadow-depth-lg)',
      },
      backgroundImage: {
        'gradient-accent': 'var(--iron-gradient-accent)',
        'gradient-accent-hover': 'linear-gradient(135deg, rgb(var(--iron-accent-hover)) 0%, rgb(var(--iron-accent-light)) 100%)',
        'gradient-surface': 'var(--iron-gradient-surface)',
      },
      animation: {
        'pulse-recording': 'pulse-recording 1.5s ease-in-out infinite',
        'glow-pulse': 'glow-pulse 2s ease-in-out infinite',
        'fade-in': 'fade-in 0.2s ease-out',
        'slide-up': 'slide-up 0.25s ease-out',
        'slide-in': 'slide-in 0.3s ease-out',
        'pulse-slow': 'pulse-slow 2.5s ease-in-out infinite',
        'glow-recording': 'glow-recording 1.2s ease-in-out infinite',
      },
      keyframes: {
        'pulse-recording': {
          '0%, 100%': { opacity: '1', transform: 'scale(1)' },
          '50%': { opacity: '0.6', transform: 'scale(1.05)' },
        },
        'pulse-slow': {
          '0%, 100%': { opacity: '1', transform: 'scale(1)' },
          '50%': { opacity: '0.75', transform: 'scale(1.02)' },
        },
        'glow-recording': {
          '0%, 100%': { opacity: '1', filter: 'brightness(1)' },
          '50%': { opacity: '0.85', filter: 'brightness(1.15)' },
        },
        'glow-pulse': {
          '0%, 100%': { boxShadow: 'var(--iron-shadow-glow)' },
          '50%': { boxShadow: 'var(--iron-shadow-glow-strong)' },
        },
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'slide-up': {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-in': {
          '0%': { opacity: '0', transform: 'translateX(100%)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
      },
    },
  },
  plugins: [],
};

export default config;
