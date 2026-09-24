import { defineConfig } from 'vite';
import { pwa } from './build/pwa.ts';

export default defineConfig({
  base: './',
  build: { target: 'es2022', sourcemap: false, assetsInlineLimit: 0 },
  server: {
    watch: {
      /*
       * Editors write files atomically: they create a hidden temp file next to the target and
       * rename it. Watching those throws EBUSY on Windows and kills the dev server mid-edit.
       */
      ignored: ['**/.*.tmpdir/**', '**/*.tmp', '**/.*.swp', '**/.npm-cache/**', '**/.tmp-uicheck/**'],
    },
  },
  plugins: [pwa()],
  test: { environment: 'jsdom' },
} as any);
