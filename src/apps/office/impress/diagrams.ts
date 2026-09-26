/**
 * Impress — simple diagrams (مخططات بسيطة): a list, a process and a cycle.
 *
 * Each one is a single group of boxes joined by real connectors, so PowerPoint sees what this
 * editor drew: `p:grpSp` with `a:chOff`/`a:chExt`, and `p:cxnSp` children holding on to their
 * neighbours with `a:stCxn`/`a:endCxn`. Because every arrow names the boxes it joins by their
 * `cNvPr id`, dragging or resizing a box inside the group re-routes the arrow the way PowerPoint
 * does — the arrows are not decoration drawn on top.
 *
 * Everything is arithmetic over the deck's size, so the whole file is pure and testable: no DOM,
 * no file, and one diagram is one undoable edit.
 */
import { connectorBetween, lineBounds, attachmentPoint } from './connectors';
import { nextUid, type Deck, type DeckPara, type DeckShape } from './deck';

export type DiagramKind = 'list' | 'process' | 'cycle';
export const DIAGRAM_KINDS: readonly DiagramKind[] = ['list', 'process', 'cycle'];

/** How many boxes each diagram has: a list reads as a short one, a cycle needs a ring. */
const BOXES = 4;

/** The gap between two boxes, in EMU (a third of an inch). */
const GAP = 300_000;

export function para(text: string, size: number): DeckPara {
  return { text, size, bold: false, italic: false, underline: false, color: '#FFFFFF', align: 'ctr', bullet: false };
}

function box(deck: Deck, x: number, y: number, w: number, h: number): DeckShape {
  const accent = deck.scheme.accent1 ?? '#4472C4';
  return {
    uid: nextUid(), kind: 'shape', origin: null, spid: 0, name: 'Diagram box', ph: null, phIdx: null, geom: 'rect',
    x, y, w, h, rot: 0, flipH: false, flipV: false, fill: accent, stroke: accent, strokeW: 12700, arrow: false,
    stCxn: null, endCxn: null, paras: [para('', 18)], ink: null, anchor: 'ctr', fontScale: 1,
    image: null, children: [], box: null, table: null, anim: null, locked: false,
  };
}

/**
 * A connector from one box's side to another's, attached at both ends.
 *
 * `connectorBetween` picks the closest pair of sides, which is exactly right for a list and a
 * process; a cycle asks for the sides its ring needs, because the closest pair of two diagonal
 * boxes would cut across the middle of the ring.
 */
function link(deck: Deck, from: DeckShape, to: DeckShape, st?: number, end?: number): DeckShape {
  if (st === undefined || end === undefined) {
    const best = connectorBetween(deck, from, to);
    return { ...best, arrow: true, name: 'Diagram arrow' };
  }
  const bounds = lineBounds(attachmentPoint(from, st), attachmentPoint(to, end));
  return {
    ...connectorBetween(deck, from, to), ...bounds, arrow: true, name: 'Diagram arrow',
    stCxn: { uid: from.uid, id: from.spid, idx: st },
    endCxn: { uid: to.uid, id: to.spid, idx: end },
  };
}

/** The boxes and the arrows of one diagram, laid out at the origin of the group's own space. */
function parts(deck: Deck, kind: DiagramKind): { shapes: DeckShape[]; w: number; h: number } {
  const boxes: DeckShape[] = [];
  const arrows: DeckShape[] = [];

  if (kind === 'process') {
    const w = 2_400_000;
    const h = 1_200_000;
    for (let i = 0; i < BOXES; i++) boxes.push(box(deck, i * (w + GAP), 0, w, h));
    for (let i = 0; i < BOXES - 1; i++) arrows.push(link(deck, boxes[i]!, boxes[i + 1]!, 3, 1));
    return { shapes: [...boxes, ...arrows], w: BOXES * w + (BOXES - 1) * GAP, h };
  }

  if (kind === 'list') {
    const w = 5_000_000;
    const h = 800_000;
    for (let i = 0; i < BOXES; i++) boxes.push(box(deck, 0, i * (h + GAP), w, h));
    for (let i = 0; i < BOXES - 1; i++) arrows.push(link(deck, boxes[i]!, boxes[i + 1]!, 2, 0));
    return { shapes: [...boxes, ...arrows], w, h: BOXES * h + (BOXES - 1) * GAP };
  }

  // A cycle: four boxes on the corners of a ring, joined clockwise by its own sides, so the
  // arrows travel around the outside instead of crossing the middle.
  const side = 1_600_000;
  const span = 2 * side + GAP;
  const at: Array<[number, number]> = [[0, 0], [side + GAP, 0], [side + GAP, side + GAP], [0, side + GAP]];
  for (const [x, y] of at) boxes.push(box(deck, x, y, side, side));
  // right→left along the top, bottom→top down the right, left→right along the bottom,
  // top→bottom up the left: one full turn.
  const ring: Array<[number, number]> = [[3, 1], [2, 0], [1, 3], [0, 2]];
  ring.forEach(([st, end], i) => arrows.push(link(deck, boxes[i]!, boxes[(i + 1) % BOXES]!, st, end)));
  return { shapes: [...boxes, ...arrows], w: span, h: span };
}

/**
 * One diagram as a single group, centred on the slide.
 *
 * The group's box is the diagram's own size and its children keep their coordinates inside it,
 * so the whole diagram is one shape to select, move, resize, undo and delete — and one thing to
 * write into the file.
 */
export function diagramShape(deck: Deck, kind: DiagramKind): DeckShape {
  const { shapes, w, h } = parts(deck, kind);
  const x = Math.round((deck.cx - w) / 2);
  const y = Math.round((deck.cy - h) / 2);
  return {
    uid: nextUid(), kind: 'group', origin: null, spid: 0, name: kind === 'list' ? 'List' : kind === 'process' ? 'Process' : 'Cycle',
    ph: null, phIdx: null, geom: 'rect', x, y, w, h, rot: 0, flipH: false, flipV: false,
    fill: null, stroke: null, strokeW: 12700, arrow: false, stCxn: null, endCxn: null,
    paras: [], ink: null, anchor: 't', fontScale: 1, image: null, children: shapes, box: { x: 0, y: 0, w, h },
    table: null, anim: null, locked: false,
  };
}

/** The boxes of a diagram, in order: what a caller counts and what a test asserts on. */
export function diagramBoxes(diagram: DeckShape): DeckShape[] {
  return diagram.children.filter((c) => c.kind === 'shape');
}

/** The arrows of a diagram, in order. */
export function diagramArrows(diagram: DeckShape): DeckShape[] {
  return diagram.children.filter((c) => c.kind === 'line');
}
