import { defineConfig } from 'vite';
import { ffmpegCore } from './build/ffmpeg-core.ts';
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
  // ffmpeg.wasm's worker is found with `new URL('./worker.js', import.meta.url)`; pre-bundling would break that path.
  optimizeDeps: { exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'] },
  plugins: [ffmpegCore(), pwa()],
  test: { environment: 'jsdom' },
} as any);
