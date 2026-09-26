/**
 * Impress — connectors (خطوط الربط): where a line holds on to a shape, and how it keeps
 * holding on when the shape moves.
 *
 * A `.pptx` connector is a `<p:cxnSp>` whose `<p:cNvCxnSpPr>` may carry `<a:stCxn id=".."
 * idx=".."/>` and `<a:endCxn …/>`: "my first end sits on connection site `idx` of the shape
 * whose `cNvPr id` is `id`". PowerPoint re-routes such a line by itself whenever the shape
 * moves — but only if the geometry it reads stays consistent with the sites, and only if the
 * reference still resolves. So this editor does both halves:
 *   • the model keeps the attachment as the *target shape's session uid* (a uid is stable for
 *     the whole session, a file id is not: a shape drawn here has none until it is saved), and
 *   • every move or resize of a shape re-routes the lines attached to it here, in the model,
 *     so the canvas, the thumbnail, the slideshow and the saved file can never disagree.
 *
 * Everything in this file is arithmetic over plain objects — no DOM, no file.
 *
 * The site numbering is not a guess: PowerPoint 16 was made to write one straight connector
 * per connection site, and the file it produced maps `idx` to the sides in this order:
 *
 *   | idx | side   | position |
 *   |-----|--------|----------|
 *   | 0   | top    | (½w, 0)  |
 *   | 1   | left   | (0, ½h)  |
 *   | 2   | bottom | (½w, h)  |
 *   | 3   | right  | (w, ½h)  |
 */
import { nextUid, type Deck, type DeckCxn, type DeckShape } from './deck';

/** The four sites of a box-like preset, as fractions of its width and height. */
export const SITE_OFFSETS: ReadonlyArray<readonly [number, number]> = [[0.5, 0], [0, 0.5], [0.5, 1], [1, 0.5]];

/** How many sites a shape has: the four sides for everything this editor draws. */
export const SITE_COUNT = SITE_OFFSETS.length;

export interface Point { x: number; y: number }

/**
 * A point on the shape's own box, in EMU, in slide coordinates.
 *
 * `idx` is clamped into range rather than rejected, so a file carrying an `idx` this editor
 * does not know still draws its line somewhere sensible instead of losing the shape.
 * Rotation is applied around the box's centre, the way PowerPoint rotates the sites.
 */
export function attachmentPoint(s: DeckShape, idx: number): Point {
  const [fx, fy] = SITE_OFFSETS[Math.max(0, Math.min(SITE_COUNT - 1, Math.round(idx)))] ?? SITE_OFFSETS[0]!;
  let x = s.x + s.w * fx;
  let y = s.y + s.h * fy;
  if (s.rot) {
    const cx = s.x + s.w / 2;
    const cy = s.y + s.h / 2;
    const rad = (s.rot * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const dx = x - cx;
    const dy = y - cy;
    x = cx + dx * cos - dy * sin;
    y = cy + dx * sin + dy * cos;
  }
  // EMU are whole numbers in the file, and rounding here keeps a re-route stable: the same
  // shapes must give the same bytes, or a save would rewrite a connector that did not move.
  return { x: Math.round(x), y: Math.round(y) };
}

const dist2 = (a: Point, b: Point): number => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

/**
 * The pair of sites a new connector should use: the closest two sides of the two shapes.
 * Ties go to the lowest site numbers, so the same two shapes always give the same answer.
 */
export function nearestSites(from: DeckShape, to: DeckShape): { st: number; end: number } {
  let best = { st: 0, end: 0 };
  let bestD = Infinity;
  for (let i = 0; i < SITE_COUNT; i++) {
    const a = attachmentPoint(from, i);
    for (let j = 0; j < SITE_COUNT; j++) {
      const d = dist2(a, attachmentPoint(to, j));
      if (d < bestD) { bestD = d; best = { st: i, end: j }; }
    }
  }
  return best;
}

export interface LineBounds { x: number; y: number; w: number; h: number; flipH: boolean; flipV: boolean }

/**
 * The `a:off`/`a:ext`/`flipH`/`flipV` that draw a straight line from one point to another:
 * the box around the two points, with a flip on each axis the line runs backwards along.
 */
export function lineBounds(from: Point, to: Point): LineBounds {
  return {
    x: Math.min(from.x, to.x),
    y: Math.min(from.y, to.y),
    w: Math.abs(to.x - from.x),
    h: Math.abs(to.y - from.y),
    flipH: to.x < from.x,
    flipV: to.y < from.y,
  };
}

/** The two ends a `cxnSp`'s box draws: the inverse of `lineBounds`. */
export function lineEnds(s: DeckShape): { from: Point; to: Point } {
  return {
    from: { x: s.x + (s.flipH ? s.w : 0), y: s.y + (s.flipV ? s.h : 0) },
    to: { x: s.x + (s.flipH ? 0 : s.w), y: s.y + (s.flipV ? 0 : s.h) },
  };
}

/** The shapes of a slide by the `cNvPr id` a file reference names. */
export function shapesById(shapes: readonly DeckShape[]): Map<number, DeckShape> {
  const map = new Map<number, DeckShape>();
  for (const s of shapes) if (s.spid > 0) map.set(s.spid, s);
  return map;
}

/** The attachment, resolved to the shape it names on this slide (null when it points nowhere). */
export function targetOf(ref: DeckCxn | null, shapes: readonly DeckShape[]): DeckShape | null {
  if (!ref) return null;
  if (ref.uid !== null) {
    const byUid = shapes.find((s) => s.uid === ref.uid);
    if (byUid) return byUid;
  }
  if (ref.id > 0) return shapes.find((s) => s.spid === ref.id) ?? null;
  return null;
}

/**
 * The connector re-drawn onto the sites it names, or with the ends that no longer resolve
 * dropped (a reference to a deleted shape must never be written back blind).
 *
 * A connector that names no site at all is returned unchanged: it is a free line, and the
 * user is the one who decides where it goes.
 */
export function routeConnector(conn: DeckShape, shapes: readonly DeckShape[]): DeckShape {
  if (conn.kind !== 'line' || (!conn.stCxn && !conn.endCxn)) return conn;
  const st = targetOf(conn.stCxn, shapes);
  const end = targetOf(conn.endCxn, shapes);
  const next: DeckShape = { ...conn };
  let moved = false;
  if (conn.stCxn && !st) { next.stCxn = null; moved = true; }
  if (conn.endCxn && !end) { next.endCxn = null; moved = true; }
  if (!next.stCxn || !next.endCxn) {
    // One end lost its shape: keep the geometry exactly where it was and only forget the ref.
    return moved ? next : conn;
  }
  const from = attachmentPoint(st as DeckShape, (next.stCxn as DeckCxn).idx);
  const to = attachmentPoint(end as DeckShape, (next.endCxn as DeckCxn).idx);
  const b = lineBounds(from, to);
  if (b.x === conn.x && b.y === conn.y && b.w === conn.w && b.h === conn.h && b.flipH === conn.flipH && b.flipV === conn.flipV && !moved) return conn;
  return { ...next, ...b };
}

/**
 * Every attached connector of a slide re-routed. Returns the very same array when nothing
 * changed, so an edit that moved nothing stays a no-op for the undo stack and the save.
 */
export function followConnectors(shapes: readonly DeckShape[]): DeckShape[] {
  let out: DeckShape[] | null = null;
  shapes.forEach((s, i) => {
    if (s.kind !== 'line' || (!s.stCxn && !s.endCxn)) return;
    const next = routeConnector(s, shapes);
    if (next === s) return;
    if (!out) out = shapes.slice();
    out[i] = next;
  });
  return out ?? (shapes as DeckShape[]);
}

/** The same shapes with every reference to `uid` cleared: what deleting a shape leaves behind. */
export function detachFrom(shapes: readonly DeckShape[], uid: number): DeckShape[] {
  let out: DeckShape[] | null = null;
  shapes.forEach((s, i) => {
    if (s.kind !== 'line') return;
    const dropSt = s.stCxn?.uid === uid;
    const dropEnd = s.endCxn?.uid === uid;
    if (!dropSt && !dropEnd) return;
    if (!out) out = shapes.slice();
    out[i] = { ...s, stCxn: dropSt ? null : s.stCxn, endCxn: dropEnd ? null : s.endCxn };
  });
  return out ?? (shapes as DeckShape[]);
}

/** A shape a connector may be attached to: a real shape of this slide, not a line, not locked. */
export function connectable(s: DeckShape | null | undefined): s is DeckShape {
  return !!s && !s.locked && s.kind !== 'line';
}

/** The connector shape itself: a straight line from the nearest side of one shape to the other. */
export function connectorBetween(deck: Deck, from: DeckShape, to: DeckShape): DeckShape {
  const { st, end } = nearestSites(from, to);
  const bounds = lineBounds(attachmentPoint(from, st), attachmentPoint(to, end));
  const accent = deck.scheme.accent1 ?? '#4472C4';
  return {
    uid: nextUid(), kind: 'line', origin: null, spid: 0, name: 'Connector', ph: null, phIdx: null, geom: 'line',
    ...bounds, rot: 0, fill: null, stroke: accent, strokeW: 28575, arrow: true,
    paras: [], ink: null, anchor: 't', fontScale: 1, image: null, children: [], box: null, table: null, anim: null, locked: false,
    stCxn: { uid: from.uid, id: from.spid, idx: st },
    endCxn: { uid: to.uid, id: to.spid, idx: end },
  };
}
