/**
 * Photo engine — Web Worker entry.
 *
 * Loaded by `rpc.ts` with `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`.
 * It receives `WorkerRequest`s, runs the op from the shared registry and posts the result
 * back, transferring the pixel buffer (no copy). All the logic lives in `ops.ts`, which is
 * tested directly; this file is only the message wiring.
 */
import { handleRequest, type WorkerRequest, type WorkerResponse } from './ops';

interface WorkerScope {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse, options?: { transfer?: Transferable[] }): void;
}

const scope = (typeof self !== 'undefined' ? self : null) as unknown as WorkerScope | null;

// Only wire up inside a worker (a window has `document`).
if (scope && typeof (globalThis as { document?: unknown }).document === 'undefined') {
  scope.onmessage = (e) => {
    const res = handleRequest(e.data);
    scope.postMessage(res, res.ok ? { transfer: [res.data.buffer as ArrayBuffer] } : undefined);
  };
}

export {};
