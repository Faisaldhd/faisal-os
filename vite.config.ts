import { defineConfig } from 'vite';
import { pwa } from './build/pwa';

export default defineConfig({
  base: './',
  build: { target: 'es2022', sourcemap: false, assetsInlineLimit: 0 },
  plugins: [pwa()],
  test: { environment: 'jsdom' },
} as any);
