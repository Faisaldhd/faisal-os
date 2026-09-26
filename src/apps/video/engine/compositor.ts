/**
 * The compositor: draws the frame at time `t` of a project onto a 2D context.
 *
 * ONE code path for the preview and the export. The live preview, a scrub, a
 * captured PNG and every exported frame all call `composeFrame`, so the file
 * shows exactly what the preview showed.
 *
 * WHAT IS DRAWN, bottom to top (the order `visualsAt` returns):
 *   project background → main-track layers (crossfade alpha or slide offset,
 *   colour, crop/rotate/flip, fit/scale/position/opacity) → the dip-to-black
 *   veil → overlay layers (picture-in-picture) → titles (Arabic shaped by the
 *   browser, right-to-left when the text is) → optional safe-area guides.
 *
 * The composition is drawn in *frame* units (the project's frame size); `view`
 * scales it uniformly into a canvas of another size (the preview). The media
 * is reached through `FrameProvider`, so tests pass fake images and this file
 * never creates or seeks a media element.
 */
import { clipLength, visualsAt, textAnimAt, type MediaClip, type Project, type TextClip } from '../project';
import { blurAt, blurPixels, blackoutAt, darkAt, darkFrame, effectFilter } from '../effects';
import { applyColorAdjust, colorFilter, isNeutral, type Rect } from '../render-math';
import { layerAlpha, layerPlan, safeAreas, scaleAbout, textFont, textPlan, type LayerPlan, type Size, type View } from './layout';

/** A drawable picture and its pixel size. */
export interface FrameImage {
  image: CanvasImageSource;
  width: number;
  height: number;
}

/** Hands the compositor the current picture of a clip, or null when it has none yet. */
export interface FrameProvider {
  frameFor(clip: MediaClip): FrameImage | null;
  /** For a clip without a picture: its size, when its media is offline (a placeholder is drawn). */
  missing?(clip: MediaClip): { width: number; height: number; offline: boolean } | null;
}

/** A scratch surface for the per-pixel colour fallback. */
export interface Scratch {
  canvas: CanvasImageSource;
  ctx: CanvasRenderingContext2D;
}

export interface ComposeOptions {
  /** Where the frame sits on the canvas; identity when the canvas is the frame. */
  view?: View;
  /** Canvas size, when it differs from the frame (the area cleared around the letterbox). */
  canvas?: Size;
  /** Draw the action/title safe-area guides (preview only; never exported). */
  guides?: boolean;
  /** Label drawn on offline media; nothing is drawn for it when absent. */
  offlineLabel?: string;
  /**
   * A scratch surface of at least `size`, used only when the context ignores
   * `ctx.filter` (older Safari). Without it the colour adjustment is skipped
   * on such browsers rather than crashing.
   */
  scratch?: (size: Size) => Scratch | null;
}

export interface ComposeBox {
  id: string;
  kind: 'text' | 'overlay';
  /** In frame units. */
  rect: Rect;
}

/** What was drawn — for tests, offline badges and on-canvas handles. */
export interface ComposeReport {
  drawn: string[];
  /** Clip ids whose picture was not available (offline or still loading). */
  missing: string[];
  texts: string[];
  boxes: ComposeBox[];
}

/** True when the context honours `ctx.filter` (Chrome, Firefox, Safari 18+). */
export function supportsFilter(ctx: CanvasRenderingContext2D): boolean {
  return typeof (ctx as { filter?: unknown }).filter === 'string';
}

export function composeFrame(
  ctx: CanvasRenderingContext2D,
  project: Project,
  time: number,
  frame: Size,
  provider: FrameProvider,
  options: ComposeOptions = {},
): ComposeReport {
  const report: ComposeReport = { drawn: [], missing: [], texts: [], boxes: [] };
  const state = visualsAt(project, time);
  const view = options.view ?? { scale: 1, dx: 0, dy: 0 };
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  if (options.canvas && (view.dx !== 0 || view.dy !== 0)) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, options.canvas.width, options.canvas.height);
  }
  ctx.setTransform(view.scale, 0, 0, view.scale, view.dx, view.dy);
  ctx.fillStyle = project.background || '#000000';
  ctx.fillRect(0, 0, frame.width, frame.height);
  // Nothing may spill outside the frame onto the letterbox (slides, big overlays).
  ctx.beginPath();
  ctx.rect(0, 0, frame.width, frame.height);
  ctx.clip();

  const filterOk = supportsFilter(ctx);
  let veiled = false;
  const veil = () => {
    if (veiled) return;
    veiled = true;
    if (state.black > 0) {
      ctx.globalAlpha = state.black;
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, frame.width, frame.height);
      ctx.globalAlpha = 1;
    }
  };

  for (const layer of state.layers) {
    if (layer.trackKind === 'overlay') veil();
    const alpha = layerAlpha(layer.alpha, layer.clip.opacity);
    const picture = provider.frameFor(layer.clip);
    if (!picture) {
      report.missing.push(layer.clip.id);
      const gone = provider.missing?.(layer.clip);
      if (gone?.offline && options.offlineLabel !== undefined) {
        const plan = layerPlan(gone, layer.clip, frame, layer.offsetX);
        if (plan) {
          drawOffline(ctx, plan.rect, options.offlineLabel, alpha);
          if (layer.trackKind === 'overlay') report.boxes.push({ id: layer.clip.id, kind: 'overlay', rect: plan.rect });
        }
      }
      continue;
    }
    const plan = layerPlan(picture, layer.clip, frame, layer.offsetX);
    if (!plan) continue;
    if (layer.trackKind === 'overlay') report.boxes.push({ id: layer.clip.id, kind: 'overlay', rect: plan.rect });
    if (alpha <= 0) continue;
    drawLayer(ctx, picture, plan, alpha, layer.clip, frame, filterOk, options.scratch, time);
    report.drawn.push(layer.clip.id);
  }
  veil();

  for (const clip of state.texts) {
    const bounds = drawText(ctx, clip, time, frame);
    if (bounds) {
      report.texts.push(clip.id);
      report.boxes.push({ id: clip.id, kind: 'text', rect: bounds });
    }
  }
  if (options.guides) drawGuides(ctx, frame);
  ctx.restore();
  return report;
}

function drawLayer(
  ctx: CanvasRenderingContext2D,
  picture: FrameImage,
  plan: LayerPlan,
  alpha: number,
  clip: MediaClip,
  frame: Size,
  filterOk: boolean,
  scratchFor: ComposeOptions['scratch'],
  time = 0,
): void {
  const neutral = isNeutral(clip.color);
  /*
   * The clip's effects are drawn HERE, next to the picture they belong to, because this is the
   * one function both the preview and the frame-by-frame MP4 export reach — so what the editor
   * shows is what the file gets, curve for curve.
   */
  const effects = clip.effects;
  const total = clipLength(clip);
  const local = time - clip.start;
  const blur = filterOk ? blurPixels(blurAt(effects, local, total), frame) : 0;
  const black = blackoutAt(effects, local, total);
  const box = clipRect(plan.rect, frame);
  const overlay = () => {
    if (box.width <= 0 || box.height <= 0) return;
    if (black > 0.001) {
      ctx.save();
      ctx.globalAlpha = alpha * black;
      ctx.fillStyle = '#000000';
      ctx.fillRect(box.x, box.y, box.width, box.height);
      ctx.restore();
    }
    const dark = darkAt(effects, local, total);
    if (dark > 0.001) {
      const { border, alpha: darkAlpha } = darkFrame(dark, box);
      if (border > 0) {
        ctx.save();
        ctx.globalAlpha = alpha * darkAlpha;
        ctx.fillStyle = '#000000';
        ctx.fillRect(box.x, box.y, box.width, border);
        ctx.fillRect(box.x, box.y + box.height - border, box.width, border);
        ctx.fillRect(box.x, box.y + border, border, Math.max(0, box.height - 2 * border));
        ctx.fillRect(box.x + box.width - border, box.y + border, border, Math.max(0, box.height - 2 * border));
        ctx.restore();
      }
    }
  };
  if (!neutral && !filterOk && scratchFor) {
    // Per-pixel fallback: draw into the scratch at frame size, adjust the pixels, draw the result.
    const scratch = scratchFor(frame);
    if (scratch) {
      const s = scratch.ctx;
      s.save();
      s.setTransform(1, 0, 0, 1, 0, 0);
      s.clearRect(0, 0, frame.width, frame.height);
      paint(s, picture, plan);
      s.restore();
      if (box.width > 0 && box.height > 0) {
        try {
          const pixels = s.getImageData(box.x, box.y, box.width, box.height);
          applyColorAdjust(pixels.data, clip.color);
          s.putImageData(pixels, box.x, box.y);
          ctx.save();
          ctx.globalAlpha = alpha;
          ctx.drawImage(scratch.canvas, box.x, box.y, box.width, box.height, box.x, box.y, box.width, box.height);
          ctx.restore();
          overlay();
          return;
        } catch {
          // A tainted or failed read falls through to the unadjusted picture.
        }
      }
    }
  }
  ctx.save();
  ctx.globalAlpha = alpha;
  if (filterOk) {
    const grade = neutral ? 'none' : colorFilter(clip.color);
    const combined = effectFilter(grade, blur);
    if (combined !== 'none') ctx.filter = combined;
  }
  paint(ctx, picture, plan);
  ctx.restore();
  overlay();
}

/** Draws the picture with its crop, rotation and flip. */
function paint(ctx: CanvasRenderingContext2D, picture: FrameImage, plan: LayerPlan): void {
  ctx.translate(plan.cx, plan.cy);
  if (plan.rotation) ctx.rotate(plan.rotation);
  if (plan.flipX < 0 || plan.flipY < 0) ctx.scale(plan.flipX, plan.flipY);
  try {
    ctx.drawImage(
      picture.image,
      plan.source.x, plan.source.y, plan.source.width, plan.source.height,
      -plan.width / 2, -plan.height / 2, plan.width, plan.height,
    );
  } catch {
    // A frame that is not decodable yet draws nothing; the next tick tries again.
  }
}

function drawOffline(ctx: CanvasRenderingContext2D, rect: Rect, label: string, alpha: number): void {
  ctx.save();
  ctx.globalAlpha = Math.max(0.35, alpha);
  ctx.fillStyle = '#1b2233';
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
  ctx.strokeStyle = 'rgba(229,72,77,0.8)';
  ctx.lineWidth = Math.max(2, rect.height / 120);
  ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
  if (label) {
    const px = Math.max(10, Math.min(rect.height / 8, rect.width / 10));
    ctx.font = textFont({ font: 'sans', bold: true }, px);
    ctx.fillStyle = '#E8ECF4';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, rect.x + rect.width / 2, rect.y + rect.height / 2, rect.width * 0.9);
  }
  ctx.restore();
}

/** The part of a rectangle inside the frame, in whole pixels. */
export function clipRect(rect: Rect, frame: Size): Rect {
  const x = Math.max(0, Math.floor(rect.x));
  const y = Math.max(0, Math.floor(rect.y));
  const right = Math.min(frame.width, Math.ceil(rect.x + rect.width));
  const bottom = Math.min(frame.height, Math.ceil(rect.y + rect.height));
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

/** Draws one title; returns its on-frame bounds, or null when it shows nothing now. */
function drawText(ctx: CanvasRenderingContext2D, clip: TextClip, time: number, frame: Size): Rect | null {
  const anim = textAnimAt(clip, time);
  if (anim.alpha <= 0 || !clip.text.trim()) return null;
  const px = Math.max(1, clip.size * frame.height);
  ctx.save();
  ctx.font = textFont(clip, px);
  const measure = (s: string) => ctx.measureText(s).width;
  const plan = textPlan(clip, frame, anim, measure);
  ctx.globalAlpha = plan.alpha;
  if (plan.scale !== 1) {
    ctx.translate(plan.cx, plan.cy);
    ctx.scale(plan.scale, plan.scale);
    ctx.translate(-plan.cx, -plan.cy);
  }
  if (plan.box) {
    ctx.fillStyle = clip.background;
    roundRect(ctx, plan.box, plan.px * 0.18);
  }
  // `direction` makes the browser run the bidi algorithm per line, so Arabic is
  // shaped and ordered right-to-left and embedded numbers or Latin stay correct.
  (ctx as { direction?: CanvasDirection }).direction = plan.direction;
  ctx.textAlign = plan.align;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = clip.color || '#ffffff';
  if (!plan.box) {
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = plan.px * 0.12;
    ctx.shadowOffsetY = plan.px * 0.04;
  }
  for (const line of plan.lines) {
    if (line.text) ctx.fillText(line.text, line.x, line.y);
  }
  ctx.restore();
  return scaleAbout(plan.bounds, plan.scale, plan.cx, plan.cy);
}

function roundRect(ctx: CanvasRenderingContext2D, rect: Rect, radius: number): void {
  const r = Math.max(0, Math.min(radius, rect.width / 2, rect.height / 2));
  ctx.beginPath();
  ctx.moveTo(rect.x + r, rect.y);
  ctx.arcTo(rect.x + rect.width, rect.y, rect.x + rect.width, rect.y + rect.height, r);
  ctx.arcTo(rect.x + rect.width, rect.y + rect.height, rect.x, rect.y + rect.height, r);
  ctx.arcTo(rect.x, rect.y + rect.height, rect.x, rect.y, r);
  ctx.arcTo(rect.x, rect.y, rect.x + rect.width, rect.y, r);
  ctx.closePath();
  ctx.fill();
}

function drawGuides(ctx: CanvasRenderingContext2D, frame: Size): void {
  const areas = safeAreas(frame);
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.lineWidth = Math.max(1, frame.height / 540);
  ctx.setLineDash([frame.height / 90, frame.height / 90]);
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.strokeRect(areas.action.x, areas.action.y, areas.action.width, areas.action.height);
  ctx.strokeStyle = 'rgba(200,137,75,0.55)';
  ctx.strokeRect(areas.title.x, areas.title.y, areas.title.width, areas.title.height);
  ctx.restore();
}
