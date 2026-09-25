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
  test: {
    environment: 'jsdom',
    /*
     * 20 s, not vitest's 5 s default. Several suites build a whole document, a 12 MP image or a
     * 10,000-row sheet per test in jsdom, and on a loaded two-core CI runner one of those can take
     * many times what it takes on a developer's machine. That is how the Desktop release failed
     * twice at `npm test` and skipped both the installer and the web publishes: a slow machine read
     * as a broken product.
     *
     * This limit is a hang detector, not a correctness claim: the functional assertions and the
     * timing budgets in the tests themselves still decide what passes, and a real hang still fails.
     */
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
} as any);
