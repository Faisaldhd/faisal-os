/**
 * Photo engine — the named-operation registry shared by the Web Worker and its
 * synchronous fallback. Every op maps an image (+ params) to a new image; any op accepts an
 * optional selection `mask` in its params and then only changes pixels inside it.
 * Pure: no DOM, no worker globals — the worker entry and the RPC client both call `runOp`.
 */
import { adjustImage, type Adjustments } from './adjust';
import { mixByMask, type Img, type Mask } from './core';
import {
  applyFilter, applyPreset, blur, edgeDetect, emboss, grayscale, invert, noise, pixelate, posterize, sepia,
  sharpen, vignette,
} from './filters';

export interface OpParamMap {
  adjust: Adjustments;
  filter: { id: string; amount: number; scale?: number };
  preset: { id: string; amount?: number };
  blur: { radius: number };
  sharpen: { amount: number; radius?: number; threshold?: number };
  grayscale: { amount?: number };
  sepia: { amount?: number };
  invert: Record<string, never>;
  vignette: { amount: number; midpoint?: number };
  noise: { amount: number; seed?: number; mono?: boolean };
  pixelate: { size: number };
  posterize: { levels: number };
  emboss: { strength?: number };
  edges: Record<string, never>;
}

export type OpName = keyof OpParamMap;

/** Params of an op plus the optional selection mask every op honours. */
export type OpParams<K extends OpName> = OpParamMap[K] & { mask?: Mask | null };

type Runner = (img: Img, p: never) => Img;

const RUNNERS: { [K in OpName]: (img: Img, p: OpParamMap[K]) => Img } = {
  adjust: (img, p) => adjustImage(img, p),
  filter: (img, p) => applyFilter(img, p.id, p.amount, p.scale ?? 1),
  preset: (img, p) => applyPreset(img, p.id, p.amount ?? 100),
  blur: (img, p) => blur(img, p.radius),
  sharpen: (img, p) => sharpen(img, p.amount, p.radius ?? 1, p.threshold ?? 0),
  grayscale: (img, p) => grayscale(img, p.amount ?? 1),
  sepia: (img, p) => sepia(img, p.amount ?? 1),
  invert: (img) => invert(img),
  vignette: (img, p) => vignette(img, p.amount, p.midpoint),
  noise: (img, p) => noise(img, p.amount, p.seed ?? 1, p.mono ?? true),
  pixelate: (img, p) => pixelate(img, p.size),
  posterize: (img, p) => posterize(img, p.levels),
  emboss: (img, p) => emboss(img, p.strength ?? 1),
  edges: (img) => edgeDetect(img),
};

export const OP_NAMES = Object.keys(RUNNERS) as OpName[];

export function isOpName(v: unknown): v is OpName {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(RUNNERS, v);
}

/** Runs a named op synchronously. Throws on an unknown op. */
export function runOp<K extends OpName>(op: K, img: Img, params: OpParams<K>): Img {
  if (!isOpName(op)) throw new Error(`unknown photo op: ${String(op)}`);
  const run = RUNNERS[op] as unknown as Runner;
  const out = run(img, (params ?? {}) as never);
  const mask = params?.mask ?? null;
  return mask ? mixByMask(img, out, mask) : out;
}

/* ─────────────────────────────── worker protocol ─────────────────────────────── */

export interface WorkerRequest {
  id: number;
  op: OpName;
  width: number;
  height: number;
  data: Uint8ClampedArray;
  params: unknown;
}

export type WorkerResponse =
  | { id: number; ok: true; width: number; height: number; data: Uint8ClampedArray }
  | { id: number; ok: false; error: string };

/** Handles one request (the worker's whole job). Never throws. */
export function handleRequest(req: WorkerRequest): WorkerResponse {
  try {
    if (!req || !isOpName(req.op)) throw new Error('unknown photo op');
    const out = runOp(req.op, { width: req.width, height: req.height, data: req.data }, req.params as OpParams<OpName>);
    return { id: req.id, ok: true, width: out.width, height: out.height, data: out.data };
  } catch (e) {
    return { id: req?.id ?? -1, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
