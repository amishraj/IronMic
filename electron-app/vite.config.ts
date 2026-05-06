import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// IronMic ships TWO renderer entries:
//   - index.html (`main`):   the full IronMic UI (sidebar, timeline, editor, etc.)
//   - forge.html (`forge`):  the minimal floating-bar UI for Forge mode.
//
// Keeping Forge as a separate Rollup input gives it its own JS chunk,
// independent of the main bundle. The Forge bar is meant to feel instant
// and unobtrusive, so we explicitly avoid pulling in TipTap, charts, the
// AI chat engine, etc. by simply not importing them from forge-main.tsx.
export default defineConfig({
  plugins: [react()],
  root: 'src/renderer',
  base: './',
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'src/renderer/index.html'),
        forge: path.resolve(__dirname, 'src/renderer/forge.html'),
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
});
