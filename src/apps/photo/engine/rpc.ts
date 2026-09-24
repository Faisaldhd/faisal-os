/**
 * Photo engine — typed RPC to the pixel worker.
 *
 *   const out = await runInWorker('adjust', imageData, { exposure: 20, contrast: 10 });
 *   ctx.putImageData(out, 0, 0);
 *
 * One lazily started module worker serves every call. By default the input pixels are
 * copied and the copy is transferred, so the caller's image stays usable; pass
 * `{ transfer: true }` to hand the buffer over instead (zero-copy, the caller's `data`
 * becomes detached). When `Worker` is unavailable (tests, old WebViews, a blocked worker
 * script) the same op runs synchronously on the main thread, with the same result.
 */
import type { Img } from './core';
import { runOp, type OpName, type OpParams, type WorkerRequest, type WorkerResponse } from './ops';

export interface RunOptions {
  /** Transfer the caller's buffer instead of a copy (faster, but `image.data` is detached). */
  transfer?: boolean;
  /** Rejects with an AbortError when aborted before the result arrives (e.g. a newer preview). */
  signal?: AbortSignal;
  /** Force the synchronous path. */
  sync?: boolean;
}

interface Pending {
  resolve: (img: ImageData) => void;
  reject: (e: unknown) => void;
  /** Kept (when not transferred) so a failed worker can fall back to the main thread. */
  retry: (() => Img) | null;
  cleanup: () => void;
}

let worker: Worker | null | undefined;
let nextId = 1;
const pending = new Map<number, Pending>();

/** Wraps pixels as a real `ImageData` when the platform has one (else a structural twin). */
export function toImageData(img: Img): ImageData {
  if (typeof ImageData === 'function') {
    try {
      return new ImageData(img.data as Uint8ClampedArray<ArrayBuffer>, img.width, img.height);
    } catch {
      /* fall through: e.g. a size mismatch in a test double */
    }
  }
  return { width: img.width, height: img.height, data: img.data, colorSpace: 'srgb' } as ImageData;
}

function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

function failAll(reason: unknown): void {
  for (const [id, p] of pending) {
    pending.delete(id);
    p.cleanup();
    if (p.retry) {
      try { p.resolve(toImageData(p.retry())); } catch (e) { p.reject(e); }
    } else {
      p.reject(reason);
    }
  }
}

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  if (typeof Worker === 'undefined') return (worker = null);
  try {
    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const res = e.data;
      const p = pending.get(res.id);
      if (!p) return;
      pending.delete(res.id);
      p.cleanup();
      if (res.ok) p.resolve(toImageData({ width: res.width, height: res.height, data: res.data }));
      else p.reject(new Error(res.error));
    };
    w.onerror = (e) => {
      // The worker script failed to load or crashed: stop using it and finish the queue here.
      e.preventDefault?.();
      worker = null;
      w.terminate();
      failAll(new Error('photo worker failed'));
    };
    worker = w;
  } catch {
    worker = null;
  }
  return worker;
}

/** True when calls really run off the main thread. */
export function workerAvailable(): boolean {
  return getWorker() !== null;
}

/** Runs a named engine op off the main thread (or synchronously as a fallback). */
export function runInWorker<K extends OpName>(
  op: K, image: Img, params: OpParams<K>, opts: RunOptions = {},
): Promise<ImageData> {
  if (opts.signal?.aborted) return Promise.reject(abortError());
  const w = opts.sync ? null : getWorker();
  if (!w) {
    try {
      return Promise.resolve(toImageData(runOp(op, image, params)));
    } catch (e) {
      return Promise.reject(e);
    }
  }
  const id = nextId++;
  const data = opts.transfer ? image.data : new Uint8ClampedArray(image.data);
  const retry = opts.transfer ? null : () => runOp(op, image, params);
  return new Promise<ImageData>((resolve, reject) => {
    const onAbort = () => {
      if (!pending.delete(id)) return;
      reject(abortError());
    };
    const cleanup = () => opts.signal?.removeEventListener('abort', onAbort);
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    pending.set(id, { resolve, reject, retry, cleanup });
    const req: WorkerRequest = { id, op, width: image.width, height: image.height, data, params };
    try {
      w.postMessage(req, [data.buffer as ArrayBuffer]);
    } catch (e) {
      pending.delete(id);
      cleanup();
      if (retry) {
        try { resolve(toImageData(retry())); } catch (err) { reject(err); }
      } else {
        reject(e);
      }
    }
  });
}

/** Stops the worker (e.g. when the Photo app closes). Pending calls finish on the main thread. */
export function disposeWorker(): void {
  const w = worker;
  worker = undefined;
  if (w) {
    w.terminate();
    failAll(new Error('photo worker disposed'));
  }
}
