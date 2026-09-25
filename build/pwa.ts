import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { Plugin } from 'vite';

/**
 * Too big to download on first visit; cached when first used (the Linux VM, ffmpeg.wasm for
 * the Video Studio's "Convert", and the PDF stack below).
 *
 * The PDF stack is ~4.0 MiB — pdf.js and its worker, the embedded fontkit, the Arabic and
 * Liberation faces it embeds, and the standard PDF fonts — and it is only needed by a visitor
 * who actually opens a PDF, so it stays out of the precache (apps-suite acceptance item 1).
 * The service worker caches every one of these the first time it is fetched, exactly like the
 * v86 files: the shell still boots offline, the PDF app needs one online visit first.
 */
const RUNTIME_ONLY = [
  /^v86\//, /^ffmpeg\//, /\.wasm$/, /^assets\/libv86-/, /\.map$/, /\/README\.md$/, /^sw\.js$/,
  /^assets\/pdf[.-]/,               // pdf.js chunks + their stylesheet + pdf.worker.min
  /^assets\/fontkit\.es-/,          // @pdf-lib/fontkit, imported only by the PDF writer
  /^assets\/NotoNaskhArabic-/,      // the Arabic face embedded into PDFs
  /^assets\/LiberationSans-/,       // the four Liberation faces embedded into PDFs
  /^assets\/Foxit.*\.pfb$/,         // pdf.js standard fonts (Symbol/Serif/Fixed/Dingbats)
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/**
 * Writes dist/sw.js after the build: the template plus the list of files to precache
 * and a version derived from their contents (a new build replaces the old cache).
 */
export function pwa(): Plugin {
  let outDir = 'dist';
  return {
    name: 'faisal-pwa',
    apply: 'build',
    configResolved(cfg) { outDir = cfg.build.outDir; },
    closeBundle() {
      const all = walk(outDir)
        .map((p) => relative(outDir, p).split(sep).join('/'))
        .sort();
      // The version covers EVERY emitted file, including the runtime-only ones: upgrading
      // v86 or its wasm must invalidate the cache even though those files aren't precached.
      const hash = createHash('sha256');
      for (const f of all) hash.update(f).update(readFileSync(join(outDir, f)));
      const files = all.filter((f) => !RUNTIME_ONLY.some((re) => re.test(f)));
      const precache = ['./', ...files.filter((f) => f !== 'index.html'), 'index.html'];
      const sw = readFileSync(new URL('./sw-template.js', import.meta.url), 'utf8')
        .replace('__VERSION__', hash.digest('hex').slice(0, 12))
        .replace('__PRECACHE__', JSON.stringify(precache));
      writeFileSync(join(outDir, 'sw.js'), sw);
    },
  };
}
