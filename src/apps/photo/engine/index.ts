/**
 * Photo engine — public API.
 *
 * Pure pixel work on ImageData-like `{ width, height, data }` buffers (straight RGBA) and
 * `Uint8Array` masks. The three functions the UI seam (`ops.ts` in the app folder) calls
 * have exactly its names and shapes:
 *   adjust(buf, params)                        — flat slider record (+ invert/grayscale flags)
 *   applyFilter(buf, id, amount0to100, scale)  — looks and effects
 *   histogram(buf)                             — { r, g, b, l: Uint32Array(256), max, count }
 * Everything else (levels, curves, masks, painting, blending, the worker RPC) is below.
 */
export * from './core';
export * from './adjust';
export * from './filters';
export * from './histogram';
export * from './select';
export * from './paint';
export * from './blend';
export { runOp, OP_NAMES, isOpName, handleRequest } from './ops';
export type { OpName, OpParams, OpParamMap, WorkerRequest, WorkerResponse } from './ops';
export { runInWorker, toImageData, workerAvailable, disposeWorker } from './rpc';
export type { RunOptions } from './rpc';
