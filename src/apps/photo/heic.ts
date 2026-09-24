/**
 * Photo Editor — the window side of HEIC/HEIF decoding. `decode.ts` imports this file
 * dynamically, and only for a .heic/.heif file, so nothing HEIC-related is loaded otherwise.
 * The codec runs in heic.worker.ts; a worker that cannot start or dies is reported as
 * "decoder unavailable" (a sentence the user can act on), never as a blank canvas.
 */
import type { PixelBuffer } from './types';
import { HeicError } from './heic-core';

export interface HeicResult {
  buffer: PixelBuffer;
  note?: 'scaled';
  images: number;
}

type Reply =
  | { id: number; ok: true; width: number; height: number; data: Uint8ClampedArray; note?: 'scaled'; images: number }
  | { id: number; ok: false; reason: HeicError['reason']; detail?: string };

let worker: Worker | null = null;
let seq = 0;
const waiting = new Map<number, { resolve: (r: HeicResult) => void; reject: (e: unknown) => void }>();

function failAll(reason: HeicError['reason'], detail: string): void {
  for (const w of waiting.values()) w.reject(new HeicError(reason, detail));
  waiting.clear();
  worker?.terminate();
  worker = null;
}

function getWorker(): Worker {
  if (worker) return worker;
  if (typeof Worker === 'undefined') throw new HeicError('unavailable', 'no-worker');
  const w = new Worker(new URL('./heic.worker.ts', import.meta.url), { type: 'module' });
  w.onmessage = (e: MessageEvent<Reply>) => {
    const r = e.data;
    const p = waiting.get(r.id);
    if (!p) return;
    waiting.delete(r.id);
    if (r.ok) p.resolve({ buffer: { width: r.width, height: r.height, data: r.data }, note: r.note, images: r.images });
    else p.reject(new HeicError(r.reason, r.detail));
  };
  w.onerror = (e) => { e.preventDefault?.(); failAll('unavailable', 'worker-error'); };
  worker = w;
  return w;
}

/** Decodes the primary image of a HEIC/HEIF file, reduced to `maxPixels` when larger. */
export function decodeHeic(bytes: Uint8Array, maxPixels: number): Promise<HeicResult> {
  return new Promise<HeicResult>((resolve, reject) => {
    let w: Worker;
    try {
      w = getWorker();
    } catch (e) {
      reject(e instanceof HeicError ? e : new HeicError('unavailable', String(e)));
      return;
    }
    const id = ++seq;
    waiting.set(id, { resolve, reject });
    const copy = bytes.slice();
    w.postMessage({ id, bytes: copy, maxPixels }, [copy.buffer]);
  });
}
