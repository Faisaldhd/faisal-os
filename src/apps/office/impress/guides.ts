/**
 * Impress — smart alignment guides (أدلة المحاذاة الذكية).
 *
 * While a shape is dragged (or one of its edges is), its left edge, centre and right edge are
 * compared with the same lines of the slide and of every other shape; the closest line within a
 * few pixels wins, the shape snaps onto it, and a guide is drawn along it — what WPS and
 * PowerPoint call smart guides. Pure geometry in EMU: no DOM, so every case is tested.
 */

export interface Box { x: number; y: number; w: number; h: number }

/** Which lines of the moving box may snap on one axis: its start edge, its centre, its end edge. */
export type Anchor = 'start' | 'center' | 'end';

/** A guide to draw: a vertical line at `x = pos` (axis 'x') or a horizontal one at `y = pos`. */
export interface Guide { axis: 'x' | 'y'; pos: number; from: number; to: number }

export interface Snap { dx: number; dy: number; guides: Guide[] }

interface Line { pos: number; from: number; to: number }

/** The three lines of a box on one axis, with the extent a guide along them spans. */
function lines(b: Box, axis: 'x' | 'y'): Record<Anchor, Line> {
  const [p, size, q, qsize] = axis === 'x' ? [b.x, b.w, b.y, b.h] : [b.y, b.h, b.x, b.w];
  return {
    start: { pos: p, from: q, to: q + qsize },
    center: { pos: p + size / 2, from: q, to: q + qsize },
    end: { pos: p + size, from: q, to: q + qsize },
  };
}

/** The best snap on one axis: the smallest move that puts one of `anchors` on a target line. */
function snapAxis(box: Box, targets: readonly Box[], slide: Box, axis: 'x' | 'y', anchors: readonly Anchor[], threshold: number): { d: number; guides: Guide[] } {
  const own = lines(box, axis);
  const candidates: Line[] = [];
  // The slide: its edges and its centre line, spanning the whole slide.
  for (const l of Object.values(lines(slide, axis))) candidates.push(l);
  for (const t of targets) for (const l of Object.values(lines(t, axis))) candidates.push(l);
  let best: number | null = null;
  for (const a of anchors) {
    for (const c of candidates) {
      const d = c.pos - own[a].pos;
      if (Math.abs(d) <= threshold && (best === null || Math.abs(d) < Math.abs(best))) best = d;
    }
  }
  if (best === null) return { d: 0, guides: [] };
  // Every line that now coincides gets a guide, spanning the moving box and what it lines up with.
  const moved = axis === 'x' ? { ...box, x: box.x + best } : { ...box, y: box.y + best };
  const mine = lines(moved, axis);
  const guides: Guide[] = [];
  const seen = new Set<number>();
  for (const a of anchors) {
    const m = mine[a];
    for (const c of candidates) {
      if (Math.abs(c.pos - m.pos) > 0.5 || seen.has(Math.round(c.pos))) continue;
      seen.add(Math.round(c.pos));
      guides.push({ axis, pos: c.pos, from: Math.min(c.from, m.from), to: Math.max(c.to, m.to) });
    }
  }
  return { d: best, guides };
}

/**
 * Where `box` should go: the offset (dx, dy) that snaps it onto the nearest line of the slide or of
 * another shape, and the guides to draw. `threshold` is in the same units as the boxes (EMU).
 */
export function snapBox(
  box: Box, targets: readonly Box[], slide: { w: number; h: number }, threshold: number,
  anchors: { x: readonly Anchor[]; y: readonly Anchor[] } = { x: ['start', 'center', 'end'], y: ['start', 'center', 'end'] },
): Snap {
  const area: Box = { x: 0, y: 0, w: slide.w, h: slide.h };
  const x = anchors.x.length ? snapAxis(box, targets, area, 'x', anchors.x, threshold) : { d: 0, guides: [] };
  const y = anchors.y.length ? snapAxis(box, targets, area, 'y', anchors.y, threshold) : { d: 0, guides: [] };
  return { dx: x.d, dy: y.d, guides: [...x.guides, ...y.guides] };
}

/**
 * The anchors a resize handle may snap: dragging the east handle moves only the right edge, so
 * only that edge snaps (and the box keeps its left edge). A move snaps all three on both axes.
 */
export function handleAnchors(handle: string | null): { x: Anchor[]; y: Anchor[] } {
  if (!handle) return { x: ['start', 'center', 'end'], y: ['start', 'center', 'end'] };
  return {
    x: handle.includes('w') ? ['start'] : handle.includes('e') ? ['end'] : [],
    y: handle.includes('n') ? ['start'] : handle.includes('s') ? ['end'] : [],
  };
}

/** A resized box with its dragged edges moved by the snap (the opposite edges stay put). */
export function applyResizeSnap(b: Box, handle: string, dx: number, dy: number): Box {
  let { x, y, w, h } = b;
  if (handle.includes('w')) { x += dx; w -= dx; } else if (handle.includes('e')) w += dx;
  if (handle.includes('n')) { y += dy; h -= dy; } else if (handle.includes('s')) h += dy;
  return { x, y, w, h };
}
