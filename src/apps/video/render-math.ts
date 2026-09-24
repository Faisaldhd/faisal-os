/**
 * Frame composition maths — pure, no DOM, so the preview and the export (which
 * share the same drawing code) can be checked without a browser.
 */
import { clamp } from './time';
import type { ColorAdjust, FitMode, FontKey, TextAlign } from './project';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Fits (`contain`) or fills (`cover`) a source box into a frame, centred. */
export function fitRect(source: { width: number; height: number }, frame: { width: number; height: number }, mode: FitMode): Rect {
  if (!(source.width > 0) || !(source.height > 0)) return { x: 0, y: 0, width: frame.width, height: frame.height };
  const sx = frame.width / source.width;
  const sy = frame.height / source.height;
  const scale = mode === 'cover' ? Math.max(sx, sy) : Math.min(sx, sy);
  const width = source.width * scale;
  const height = source.height * scale;
  return { x: (frame.width - width) / 2, y: (frame.height - height) / 2, width, height };
}

/**
 * Where a layer is drawn: fitted into the frame, then scaled about its own
 * centre and moved so that centre sits at (`cx`, `cy`) — fractions of the frame.
 * A main-track clip uses scale 1 at the centre; a picture-in-picture overlay
 * uses a smaller scale somewhere else. `offsetX` slides it sideways (transitions).
 */
export function layerRect(
  source: { width: number; height: number },
  frame: { width: number; height: number },
  opts: { fit: FitMode; scale: number; cx: number; cy: number; offsetX?: number },
): Rect {
  const base = fitRect(source, frame, opts.fit);
  const scale = clamp(Number.isFinite(opts.scale) ? opts.scale : 1, 0.05, 5);
  const width = base.width * scale;
  const height = base.height * scale;
  const cx = (Number.isFinite(opts.cx) ? opts.cx : 0.5) * frame.width + (opts.offsetX ?? 0) * frame.width;
  const cy = (Number.isFinite(opts.cy) ? opts.cy : 0.5) * frame.height;
  return { x: cx - width / 2, y: cy - height / 2, width, height };
}

/** True when the point lies inside the rectangle. */
export function hitRect(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
}

/* ─────────────────────────────── colour ─────────────────────────────── */

export function isNeutral(color: ColorAdjust): boolean {
  return Math.abs(color.brightness - 1) < 1e-3 && Math.abs(color.contrast - 1) < 1e-3 && Math.abs(color.saturation - 1) < 1e-3;
}

/** The canvas `filter` string for an adjustment; 'none' when nothing changes. */
export function colorFilter(color: ColorAdjust): string {
  if (isNeutral(color)) return 'none';
  const f = (n: number) => clamp(Number.isFinite(n) ? n : 1, 0, 2).toFixed(3);
  return `brightness(${f(color.brightness)}) contrast(${f(color.contrast)}) saturate(${f(color.saturation)})`;
}

/**
 * The same adjustment on raw RGBA pixels, in the same order and with the same
 * formulas as the CSS filter functions (Filter Effects spec), for browsers whose
 * 2D canvas ignores `ctx.filter`. Alpha is left alone.
 */
export function applyColorAdjust(data: Uint8ClampedArray, color: ColorAdjust): void {
  if (isNeutral(color)) return;
  const b = clamp(color.brightness, 0, 2);
  const c = clamp(color.contrast, 0, 2);
  const s = clamp(color.saturation, 0, 2);
  const intercept = 0.5 * (1 - c) * 255;
  // saturate() matrix from the spec.
  const m = [
    0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s,
    0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s,
    0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s,
  ];
  for (let i = 0; i < data.length; i += 4) {
    let r = data[i] * b;
    let g = data[i + 1] * b;
    let bl = data[i + 2] * b;
    r = clamp(r, 0, 255) * c + intercept;
    g = clamp(g, 0, 255) * c + intercept;
    bl = clamp(bl, 0, 255) * c + intercept;
    r = clamp(r, 0, 255);
    g = clamp(g, 0, 255);
    bl = clamp(bl, 0, 255);
    data[i] = m[0] * r + m[1] * g + m[2] * bl;
    data[i + 1] = m[3] * r + m[4] * g + m[5] * bl;
    data[i + 2] = m[6] * r + m[7] * g + m[8] * bl;
  }
}

/** One-tap looks for the Effects panel. */
export const COLOR_PRESETS: Record<string, ColorAdjust> = {
  none: { brightness: 1, contrast: 1, saturation: 1 },
  vivid: { brightness: 1.05, contrast: 1.15, saturation: 1.35 },
  warm: { brightness: 1.06, contrast: 1.05, saturation: 1.15 },
  cinema: { brightness: 0.94, contrast: 1.25, saturation: 0.85 },
  fade: { brightness: 1.1, contrast: 0.8, saturation: 0.75 },
  mono: { brightness: 1, contrast: 1.1, saturation: 0 },
};

/* ─────────────────────────────── text ─────────────────────────────── */

/**
 * Font stacks. Nothing is downloaded (no network): each stack names fonts that
 * ship with Windows, macOS, Android or common Linux desktops, Arabic-capable
 * first, so Arabic is shaped by the device's own font.
 */
export const FONT_STACKS: Record<FontKey, string> = {
  sans: '"Noto Sans Arabic", "Segoe UI", Tahoma, "Geeza Pro", Arial, sans-serif',
  naskh: '"Noto Naskh Arabic", "Traditional Arabic", "Times New Roman", "Geeza Pro", serif',
  kufi: '"Noto Kufi Arabic", "Segoe UI Semibold", "Arial Black", Tahoma, sans-serif',
  display: 'Impact, "Arial Black", "Noto Kufi Arabic", "Segoe UI Black", sans-serif',
  mono: '"Cascadia Code", Consolas, "Courier New", "Noto Sans Arabic", monospace',
};

const RTL_CHAR = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
const LTR_CHAR = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]/;

/** Direction of a paragraph from its first strong character (the `dir="auto"` rule). */
export function textDirection(text: string): 'rtl' | 'ltr' {
  for (const ch of text) {
    if (RTL_CHAR.test(ch)) return 'rtl';
    if (LTR_CHAR.test(ch)) return 'ltr';
  }
  return 'ltr';
}

/**
 * Greedy word wrap with an injected measure (the canvas `measureText` in the
 * app, a character count in tests). Explicit newlines are kept. A single word
 * wider than the line is kept whole rather than cut mid-letter — cutting an
 * Arabic word would break its shaping.
 */
export function wrapLines(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    const words = paragraph.split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0) {
      lines.push('');
      continue;
    }
    let line = words[0];
    for (let i = 1; i < words.length; i++) {
      const candidate = `${line} ${words[i]}`;
      if (measure(candidate) <= maxWidth) line = candidate;
      else {
        lines.push(line);
        line = words[i];
      }
    }
    lines.push(line);
  }
  return lines;
}

/** Canvas `textAlign` for a title's alignment in its own direction. */
export function canvasAlign(align: TextAlign, dir: 'rtl' | 'ltr'): CanvasTextAlign {
  if (align === 'center') return 'center';
  if (align === 'start') return dir === 'rtl' ? 'right' : 'left';
  return dir === 'rtl' ? 'left' : 'right';
}

/** X of the text anchor inside a block of `width` centred on `cx`. */
export function anchorX(align: CanvasTextAlign, cx: number, width: number): number {
  if (align === 'left') return cx - width / 2;
  if (align === 'right') return cx + width / 2;
  return cx;
}

/* ─────────────────────────────── waveform ─────────────────────────────── */

/** Peak absolute amplitude per bucket, 0…1 — the waveform drawn on audio clips. */
export function computePeaks(samples: ArrayLike<number>, buckets: number): Float32Array {
  const count = Math.max(1, Math.floor(buckets));
  const peaks = new Float32Array(count);
  const n = samples.length;
  if (n === 0) return peaks;
  for (let b = 0; b < count; b++) {
    const from = Math.floor((b * n) / count);
    const to = Math.max(from + 1, Math.floor(((b + 1) * n) / count));
    let peak = 0;
    for (let i = from; i < to && i < n; i++) {
      const v = Math.abs(samples[i]);
      if (v > peak) peak = v;
    }
    peaks[b] = Math.min(1, peak);
  }
  return peaks;
}

/** The peaks covering source seconds `[from, to)` of a file `duration` long. */
export function peaksSlice(peaks: Float32Array, duration: number, from: number, to: number): Float32Array {
  if (!(duration > 0) || peaks.length === 0) return new Float32Array(0);
  const a = clamp(Math.floor((from / duration) * peaks.length), 0, peaks.length);
  const b = clamp(Math.ceil((to / duration) * peaks.length), a, peaks.length);
  return peaks.slice(a, b);
}
