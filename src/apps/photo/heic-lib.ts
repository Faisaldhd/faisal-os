/**
 * Photo Editor — loads the libheif WebAssembly codec (libheif-js 1.19.8, LGPL-3.0, unmodified).
 *
 * Only ever imported by heic.worker.ts, which is itself only created when a .heic/.heif file
 * is opened, so neither the ~80 KB glue nor the ~1 MB `.wasm` touch the entry chunk. The
 * `.wasm` is emitted by Vite as a file of this site (`?url`), fetched from our own origin
 * (no CDN), and — being a `.wasm` — is left out of the service-worker precache by build/pwa.ts
 * (the ~80 KB worker chunk around the glue is still precached: pwa.ts only skips `.wasm`).
 * The glue has no `eval`/`new Function`, so it runs under the page's CSP
 * (`script-src 'self' 'wasm-unsafe-eval'`).
 */
import libheifFactory from 'libheif-js/libheif-wasm/libheif.js';
import wasmUrl from 'libheif-js/libheif-wasm/libheif.wasm?url';
import { HeicError, type HeifLibLike } from './heic-core';

type Factory = (opts: {
  wasmBinary: ArrayBuffer;
  onRuntimeInitialized?: () => void;
  onAbort?: (what: unknown) => void;
  print?: (s: string) => void;
  printErr?: (s: string) => void;
}) => HeifLibLike;

let pending: Promise<HeifLibLike> | null = null;

export function loadLibheif(): Promise<HeifLibLike> {
  pending ??= (async () => {
    const res = await fetch(wasmUrl);
    if (!res.ok) throw new Error(`wasm ${res.status}`);
    const wasmBinary = await res.arrayBuffer();
    return new Promise<HeifLibLike>((resolve, reject) => {
      const lib = (libheifFactory as unknown as Factory)({
        wasmBinary,
        onRuntimeInitialized: () => resolve(lib),
        onAbort: (what) => reject(new Error(String(what))),
        print: () => {},
        printErr: () => {},
      });
    });
  })().catch((e: unknown) => {
    pending = null; // a later open (back online) may retry
    throw new HeicError('unavailable', e instanceof Error ? e.message : String(e));
  });
  return pending;
}
