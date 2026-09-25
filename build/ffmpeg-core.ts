import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Plugin } from 'vite';
import { planParts } from '../src/apps/video/convert/plan.ts';

/**
 * Serves ffmpeg.wasm's core from our own origin (no CDN), for the Video Studio's
 * "Convert" button.
 *
 * ffmpeg-core.wasm is ~31 MB and Cloudflare Pages refuses files over 25 MiB, so
 * the build writes it as `ffmpeg/<version>/ffmpeg-core.wasm.<n>` parts of at most
 * 20 MiB (next to `ffmpeg-core.js`); the app joins them into a Blob URL
 * (`src/apps/video/convert/ffmpeg.ts`). The folder is versioned, so a cached copy
 * never outlives an upgrade, and `build/pwa.ts` keeps it out of the precache.
 *
 * `virtual:ffmpeg-core` tells the app the paths and the expected size. The dev
 * server serves the same paths straight from node_modules.
 */
const VIRTUAL = 'virtual:ffmpeg-core';
const RESOLVED = `\0${VIRTUAL}`;

export function ffmpegCore(): Plugin {
  const require = createRequire(import.meta.url);
  // The package exports no ./package.json: go up from its main file (dist/umd/ffmpeg-core.js).
  const pkgDir = join(dirname(require.resolve('@ffmpeg/core')), '..', '..');
  const version = (JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { version: string }).version;
  const js = join(pkgDir, 'dist/esm/ffmpeg-core.js');
  const wasm = join(pkgDir, 'dist/esm/ffmpeg-core.wasm');
  const dir = `ffmpeg/${version}`;
  let wasmBytes: Buffer | null = null;
  const wasmData = () => (wasmBytes ??= readFileSync(wasm));
  const layout = () => {
    const ranges = planParts(wasmData().length);
    return { ranges, parts: ranges.map((_, i) => `${dir}/ffmpeg-core.wasm.${i}`) };
  };
  return {
    name: 'faisal-ffmpeg-core',
    resolveId(id) {
      return id === VIRTUAL ? RESOLVED : null;
    },
    load(id) {
      if (id !== RESOLVED) return null;
      const { parts } = layout();
      return `export default ${JSON.stringify({ core: `${dir}/ffmpeg-core.js`, parts, size: wasmData().length })};`;
    },
    generateBundle() {
      const { ranges, parts } = layout();
      this.emitFile({ type: 'asset', fileName: `${dir}/ffmpeg-core.js`, source: readFileSync(js) });
      ranges.forEach((r, i) => this.emitFile({ type: 'asset', fileName: parts[i], source: wasmData().subarray(r.start, r.end) }));
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = /\/ffmpeg\/[^/]+\/ffmpeg-core\.(js|wasm\.(\d+))$/.exec((req.url ?? '').split('?')[0]);
        if (!m) return next();
        if (m[1] === 'js') {
          res.setHeader('Content-Type', 'text/javascript');
          res.end(readFileSync(js));
          return;
        }
        const r = layout().ranges[Number(m[2])];
        if (!r) return next();
        res.setHeader('Content-Type', 'application/octet-stream');
        res.end(wasmData().subarray(r.start, r.end));
      });
    },
  };
}
