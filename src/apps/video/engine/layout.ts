/**
 * Draw geometry for the compositor — pure, no DOM.
 *
 * Everything the canvas code needs is computed here from the project model and
 * the lead's render maths (`../render-math.ts`), so the numbers that decide what
 * a frame looks like are tested without a browser. The compositor only turns
 * these plans into 2D-context calls.
 */
import { drawPlan, outputSize } from '../clips';
import { anchorX, canvasAlign, FONT_STACKS, layerRect, textDirection, wrapLines, type Rect } from '../render-math';
import type { MediaClip, TextAnimState, TextClip } from '../project';

export interface Size {
  width: number;
  height: number;
}

/** How to draw one media layer: translate to (cx, cy), rotate, flip, draw `source` into a centred box. */
export interface LayerPlan {
  /** The on-screen box after crop, rotation, fit, scale and position. */
  rect: Rect;
  cx: number;
  cy: number;
  rotation: number;
  flipX: 1 | -1;
  flipY: 1 | -1;
  /** Source pixels to draw (the crop). */
  source: Rect;
  /** Box size before rotation (width/height swap for quarter turns). */
  width: number;
  height: number;
}

/** The plan for a media clip whose file is `media` pixels, in a `frame`-sized output. */
export function layerPlan(media: Size, clip: MediaClip, frame: Size, offsetX = 0): LayerPlan | null {
  if (!(media.width > 0) || !(media.height > 0) || !(frame.width > 0) || !(frame.height > 0)) return null;
  const visible = outputSize(media, clip.transform);
  const rect = layerRect(visible, frame, { fit: clip.fit, scale: clip.scale, cx: clip.x, cy: clip.y, offsetX });
  const plan = drawPlan(media, clip.transform);
  const quarter = clip.transform.rotation === 90 || clip.transform.rotation === 270;
  return {
    rect,
    cx: rect.x + rect.width / 2,
    cy: rect.y + rect.height / 2,
    rotation: plan.rotateRadians,
    flipX: plan.scaleX < 0 ? -1 : 1,
    flipY: plan.scaleY < 0 ? -1 : 1,
    source: plan.source,
    width: quarter ? rect.height : rect.width,
    height: quarter ? rect.width : rect.height,
  };
}

/** Final opacity of a layer: the transition's alpha times the clip's own opacity. */
export function layerAlpha(transitionAlpha: number, opacity: number): number {
  const a = Number.isFinite(transitionAlpha) ? transitionAlpha : 1;
  const o = Number.isFinite(opacity) ? opacity : 1;
  return Math.min(1, Math.max(0, a * o));
}

/* ─────────────────────────────── text ─────────────────────────────── */

/** Line height as a multiple of the font size; generous enough for Arabic marks. */
export const LINE_HEIGHT = 1.3;
/** Widest a title may run before it wraps, as a fraction of the frame width. */
export const TEXT_MAX_WIDTH = 0.9;
/** Padding of the background box, as a fraction of the font size. */
export const TEXT_PADDING = 0.3;

/** The canvas `font` shorthand for a title at a pixel size. */
export function textFont(clip: Pick<TextClip, 'font' | 'bold'>, px: number): string {
  const stack = FONT_STACKS[clip.font] ?? FONT_STACKS.sans;
  return `${clip.bold ? 700 : 400} ${Math.max(1, Math.round(px * 100) / 100)}px ${stack}`;
}

export interface TextLine {
  text: string;
  x: number;
  /** Middle of the line (the compositor uses textBaseline = 'middle'). */
  y: number;
}

export interface TextPlan {
  font: string;
  px: number;
  direction: 'rtl' | 'ltr';
  align: CanvasTextAlign;
  lines: TextLine[];
  /** Background box, or null when the title has none. */
  box: Rect | null;
  /** The block the title covers (its box, or the text itself), before the pop scale. */
  bounds: Rect;
  alpha: number;
  /** Scale about (cx, cy) — the `pop` animation. */
  scale: number;
  cx: number;
  cy: number;
}

/**
 * Lays out a title. `measure` must measure with `textFont(clip, px)` already set
 * (the compositor sets `ctx.font` first). Direction follows the first strong
 * character, so an Arabic title is right-to-left and its `start` alignment is
 * the right edge.
 */
export function textPlan(clip: TextClip, frame: Size, anim: TextAnimState, measure: (s: string) => number): TextPlan {
  const px = Math.max(1, clip.size * frame.height);
  const direction = textDirection(clip.text);
  const align = canvasAlign(clip.align, direction);
  const lines = wrapLines(clip.text, frame.width * TEXT_MAX_WIDTH, measure);
  const width = lines.reduce((w, line) => Math.max(w, measure(line)), 0);
  const lineHeight = px * LINE_HEIGHT;
  const height = lineHeight * lines.length;
  const cx = clip.x * frame.width;
  const cy = (clip.y + anim.dy) * frame.height;
  const top = cy - height / 2;
  const x = anchorX(align, cx, width);
  const pad = px * TEXT_PADDING;
  const box = clip.background ? { x: cx - width / 2 - pad, y: top - pad / 2, width: width + pad * 2, height: height + pad } : null;
  return {
    font: textFont(clip, px),
    px,
    direction,
    align,
    lines: lines.map((text, i) => ({ text, x, y: top + lineHeight * (i + 0.5) })),
    box,
    bounds: box ?? { x: cx - width / 2, y: top, width, height },
    alpha: Math.min(1, Math.max(0, anim.alpha)),
    scale: anim.scale > 0 ? anim.scale : 1,
    cx,
    cy,
  };
}

/* ─────────────────────────────── guides ─────────────────────────────── */

/** Action-safe (93%) and title-safe (90%) boxes, drawn on the preview only. */
export function safeAreas(frame: Size): { action: Rect; title: Rect } {
  const box = (f: number): Rect => ({
    x: (frame.width * (1 - f)) / 2,
    y: (frame.height * (1 - f)) / 2,
    width: frame.width * f,
    height: frame.height * f,
  });
  return { action: box(0.93), title: box(0.9) };
}

/* ─────────────────────────────── frames ─────────────────────────────── */

/** Snaps a time to the start of its frame at `fps`, so a scrub and an export see the same frame. */
export function quantize(time: number, fps: number): number {
  const rate = Number.isFinite(fps) && fps > 0 ? fps : 30;
  if (!Number.isFinite(time) || time <= 0) return 0;
  return Math.floor(time * rate + 1e-6) / rate;
}

/** Number of frames an export of `duration` seconds holds at `fps`. */
export function frameCount(duration: number, fps: number): number {
  const rate = Number.isFinite(fps) && fps > 0 ? fps : 30;
  return Number.isFinite(duration) && duration > 0 ? Math.ceil(duration * rate - 1e-6) : 0;
}

/* ─────────────────────────────── preview view ─────────────────────────────── */

/** How the composition is placed on a canvas of another size: uniform scale, centred. */
export interface View {
  scale: number;
  dx: number;
  dy: number;
}

export function viewFor(frame: Size, canvas: Size): View {
  if (!(frame.width > 0) || !(frame.height > 0) || !(canvas.width > 0) || !(canvas.height > 0)) return { scale: 1, dx: 0, dy: 0 };
  const scale = Math.min(canvas.width / frame.width, canvas.height / frame.height);
  return { scale, dx: (canvas.width - frame.width * scale) / 2, dy: (canvas.height - frame.height * scale) / 2 };
}

/** A composition rectangle in canvas pixels. */
export function toCanvas(rect: Rect, view: View): Rect {
  return { x: rect.x * view.scale + view.dx, y: rect.y * view.scale + view.dy, width: rect.width * view.scale, height: rect.height * view.scale };
}

/** A pop-scaled rectangle about (cx, cy). */
export function scaleAbout(rect: Rect, scale: number, cx: number, cy: number): Rect {
  return { x: cx + (rect.x - cx) * scale, y: cy + (rect.y - cy) * scale, width: rect.width * scale, height: rect.height * scale };
}
