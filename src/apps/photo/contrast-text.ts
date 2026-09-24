/**
 * Photo Editor — the automatic text colour (client request 7).
 *
 * When the text tool drops a new layer the editor has one question to answer: what is behind this
 * box? This module answers it with WCAG maths only — the relative luminance of the pixels the box
 * covers, then the candidate colour with the highest contrast ratio against that luminance — and
 * returns the colour together with the ratio it reached, so the UI can show it.
 *
 * Pure: numbers in, a colour out — no DOM, no canvas, no editor state. `ImageData` and this app's
 * own `PixelBuffer` are both accepted as the pixel source.
 *
 * It is asked exactly once, when the layer is created: an existing text layer keeps its colour when
 * the image under it changes, and the user can always override the colour by hand afterwards.
 */
import { hexToRgb, normaliseHex, relativeLuminance } from './color';
import type { Rect } from './types';

/** The RGBA bytes of an image: `ImageData` and `PixelBuffer` both look like this. */
export interface PixelSource {
  readonly width: number;
  readonly height: number;
  readonly data: ArrayLike<number>;
}

/** The two colours the text tool chooses between. Light first, so light wins an exact tie. */
export const TEXT_CANDIDATES: readonly string[] = ['#ffffff', '#000000'];

/** The colour the editor starts its foreground with — kept when nothing can be measured. */
export const DEFAULT_TEXT_COLOR = '#1a1d26';

/** At or below this opaque fraction a region counts as empty and the default colour is kept. */
export const MIN_COVERAGE = 0.05;

/** WCAG 2.x contrast ratio from two relative luminances; always >= 1. */
export function contrastRatio(lumA: number, lumB: number): number {
  const hi = Math.max(lumA, lumB);
  const lo = Math.min(lumA, lumB);
  return (hi + 0.05) / (lo + 0.05);
}

/** WCAG contrast ratio between two hex colours. */
export function colorContrast(a: string, b: string): number {
  return contrastRatio(relativeLuminance(hexToRgb(a)), relativeLuminance(hexToRgb(b)));
}

/** A finite number or `fallback`: a NaN width or rect must never reach the colour decision. */
function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/** A buffer side as whole pixels; a malformed size reads as an empty image. */
function intSize(value: number): number {
  return Math.max(0, Math.floor(finite(value, 0)));
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/**
 * `rect` clipped to the pixels that really exist, in whole pixels: `x`/`y` are floored and `w`/`h`
 * count the pixels touched. A rect that misses the image comes back with a 0 side, which callers
 * read as "nothing under the text". A sub-pixel rect keeps the single pixel it touches, so a tiny
 * box behaves like a one-pixel box instead of vanishing.
 */
export function clampRect(rect: Rect, width: number, height: number): Rect {
  const w = intSize(width);
  const h = intSize(height);
  const x = finite(rect.x, 0);
  const y = finite(rect.y, 0);
  const x0 = clamp(Math.floor(x), 0, w);
  const y0 = clamp(Math.floor(y), 0, h);
  const x1 = clamp(Math.ceil(x + Math.max(0, finite(rect.w, 0))), x0, w);
  const y1 = clamp(Math.ceil(y + Math.max(0, finite(rect.h, 0))), y0, h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export interface RegionSample {
  /** Alpha-weighted mean relative luminance of what is opaque in the region (0..1). */
  luminance: number;
  /** Opaque fraction of the region (0..1): a fully transparent region is 0. */
  coverage: number;
  /** Pixels the rect covers once clamped (0 when it misses the image). */
  pixels: number;
}

/**
 * Mean relative luminance under `rect`, so a busy region (half black, half white) reads as the
 * middle grey a reader perceives rather than as either extreme. Fully transparent pixels do not
 * vote — there is nothing there to draw text on — and a partially transparent one votes in
 * proportion to its alpha. Luminances are averaged rather than colour channels, which is what makes
 * two very different hues of the same brightness cancel out instead of tilting the result.
 */
export function sampleRegion(pixels: PixelSource, rect: Rect): RegionSample {
  const width = intSize(pixels.width);
  const height = intSize(pixels.height);
  const box = clampRect(rect, width, height);
  const count = box.w * box.h;
  // A buffer shorter than its own claim is malformed: read it as empty rather than fill the maths
  // with undefined bytes.
  if (count <= 0 || pixels.data.length < width * height * 4) return { luminance: 0, coverage: 0, pixels: 0 };
  const data = pixels.data;
  const stride = width * 4;
  // One reused triple keeps `relativeLuminance` (the shared, tested WCAG implementation in
  // color.ts) allocation-free inside the per-pixel loop.
  const rgb = [0, 0, 0];
  let weight = 0;
  let sum = 0;
  for (let y = box.y; y < box.y + box.h; y++) {
    let i = y * stride + box.x * 4;
    for (let x = 0; x < box.w; x++, i += 4) {
      const alpha = data[i + 3] / 255;
      if (alpha <= 0) continue;
      rgb[0] = data[i]; rgb[1] = data[i + 1]; rgb[2] = data[i + 2];
      sum += relativeLuminance(rgb) * alpha;
      weight += alpha;
    }
  }
  return { luminance: weight > 0 ? sum / weight : 0, coverage: weight / count, pixels: count };
}

export interface ContrastTextOptions {
  /** Colour kept when the region cannot be measured; the editor passes its current default. */
  fallback?: string;
  /** Colours to choose from — best ratio wins, the first wins a tie. */
  candidates?: readonly string[];
  /** Opaque fraction at or below which the region counts as empty (default `MIN_COVERAGE`). */
  minCoverage?: number;
}

export interface ContrastTextResult {
  /** What to give the new text layer, `"#rrggbb"`. */
  color: string;
  /** WCAG ratio of `color` against `luminance`; 0 when no opaque pixel was found. */
  ratio: number;
  /** Mean relative luminance under the box; 0 when no opaque pixel was found. */
  luminance: number;
  /** Opaque fraction of the box (0..1). */
  coverage: number;
  /** True when the region was refused and `color` is the fallback. */
  fallback: boolean;
  /** Pixels the box covered once clamped to the image. */
  pixels: number;
}

/** The candidate list, cleaned of duplicates and unparsable colours; never empty. */
function candidateList(candidates: readonly string[] | undefined, fallback: string): string[] {
  const unique = new Set<string>();
  for (const raw of candidates && candidates.length ? candidates : TEXT_CANDIDATES) {
    const hex = normaliseHex(raw);
    if (hex) unique.add(hex);
  }
  // All candidates were unusable: the caller's default is the only honest answer left.
  if (unique.size === 0) unique.add(fallback);
  return [...unique];
}

/**
 * The colour for a NEW text layer whose box sits at `rect` over `pixels`, plus the contrast ratio
 * it reaches: a measurable region gives the candidate with the highest ratio (light on dark, dark
 * on light), while a transparent, empty, sub-threshold or out-of-bounds region keeps
 * `options.fallback` — the editor's current default colour.
 */
export function pickContrastTextColor(pixels: PixelSource, rect: Rect, options: ContrastTextOptions = {}): ContrastTextResult {
  const fallback = normaliseHex(options.fallback ?? '') ?? DEFAULT_TEXT_COLOR;
  const minCoverage = clamp(finite(options.minCoverage ?? MIN_COVERAGE, MIN_COVERAGE), 0, 1);
  const sample = sampleRegion(pixels, rect);
  if (sample.pixels === 0 || sample.coverage <= minCoverage) {
    return {
      color: fallback,
      // A region that exists but is translucent still has a luminance worth reporting; a region
      // with no opaque pixel at all has nothing to report.
      ratio: sample.coverage > 0 ? contrastRatio(relativeLuminance(hexToRgb(fallback)), sample.luminance) : 0,
      luminance: sample.luminance,
      coverage: sample.coverage,
      fallback: true,
      pixels: sample.pixels,
    };
  }
  const candidates = candidateList(options.candidates, fallback);
  let color = candidates[0];
  let best = contrastRatio(relativeLuminance(hexToRgb(color)), sample.luminance);
  for (const candidate of candidates.slice(1)) {
    const ratio = contrastRatio(relativeLuminance(hexToRgb(candidate)), sample.luminance);
    if (ratio > best) { color = candidate; best = ratio; }
  }
  return { color, ratio: best, luminance: sample.luminance, coverage: sample.coverage, fallback: false, pixels: sample.pixels };
}
