/**
 * Impress — connectors: the site numbering, the routing maths, and the rule that a line
 * follows the shapes it is attached to. Pure objects only: no browser, no file.
 */
import { describe, expect, it } from 'vitest';
import { newShape } from './ops';
import { shapeXml } from './deckxml';
import type { Deck, DeckShape } from './deck';
import {
  attachmentPoint, connectable, connectorBetween, detachFrom, followConnectors, lineBounds, lineEnds, nearestSites,
  routeConnector, SITE_COUNT, targetOf,
} from './connectors';

/** 1 pt = 12700 EMU; 100 pt shapes keep the arithmetic readable. */
const PT = 12700;
const deck = (): Deck => ({ cx: 12192000, cy: 6858000, slides: [], layouts: [], masters: [], scheme: { accent1: '#4472C4' } });

function rect(d: Deck, x: number, y: number, w: number, h: number): DeckShape {
  const s = newShape(d, 'rect');
  return { ...s, x, y, w, h };
}

const at = (x: number, y: number): { x: number; y: number } => ({ x, y });

describe('connection sites', () => {
  /**
   * The four sides, in the order PowerPoint itself numbers them. This table was read out of a
   * real presentation: PowerPoint was made to write one straight connector per site and the file
   * it produced maps idx 0 to the top, 1 to the left, 2 to the bottom and 3 to the right.
   */
  it('numbers the sides the way PowerPoint writes them (0 top · 1 left · 2 bottom · 3 right)', () => {
    const s = rect(deck(), 0, 0, 100 * PT, 100 * PT);
    expect(attachmentPoint(s, 0)).toEqual(at(50 * PT, 0));
    expect(attachmentPoint(s, 1)).toEqual(at(0, 50 * PT));
    expect(attachmentPoint(s, 2)).toEqual(at(50 * PT, 100 * PT));
    expect(attachmentPoint(s, 3)).toEqual(at(100 * PT, 50 * PT));
    expect(SITE_COUNT).toBe(4);
  });

  it('places the sites on the shape it is actually drawn at, not at a nominal position', () => {
    const s = rect(deck(), 10 * PT, 20 * PT, 40 * PT, 60 * PT);
    expect(attachmentPoint(s, 0)).toEqual(at(30 * PT, 20 * PT));
    expect(attachmentPoint(s, 3)).toEqual(at(50 * PT, 50 * PT));
  });

  it('rotates its sites with the shape', () => {
    const s = rect(deck(), 0, 0, 100 * PT, 100 * PT);
    expect(attachmentPoint({ ...s, rot: 90 }, 0)).toEqual(at(100 * PT, 50 * PT));
    expect(attachmentPoint({ ...s, rot: 180 }, 0)).toEqual(at(50 * PT, 100 * PT));
  });

  it('keeps a file\u2019s out-of-range site index inside the four sides instead of losing the line', () => {
    const s = rect(deck(), 0, 0, 100 * PT, 100 * PT);
    expect(attachmentPoint(s, 9)).toEqual(attachmentPoint(s, 3));
    expect(attachmentPoint(s, -4)).toEqual(attachmentPoint(s, 0));
  });

  it('picks the closest pair of sides, and the same pair every time', () => {
    const d = deck();
    const left = rect(d, 0, 0, 100 * PT, 100 * PT);
    const right = rect(d, 400 * PT, 0, 100 * PT, 100 * PT);
    expect(nearestSites(left, right)).toEqual({ st: 3, end: 1 });
    expect(nearestSites(right, left)).toEqual({ st: 1, end: 3 });
    const below = rect(d, 0, 400 * PT, 100 * PT, 100 * PT);
    expect(nearestSites(left, below)).toEqual({ st: 2, end: 0 });
  });
});

describe('the geometry of a straight line', () => {
  it('is the box around the two ends, flipped on each axis it runs backwards along', () => {
    expect(lineBounds(at(0, 0), at(300, 100))).toEqual({ x: 0, y: 0, w: 300, h: 100, flipH: false, flipV: false });
    expect(lineBounds(at(300, 100), at(0, 0))).toEqual({ x: 0, y: 0, w: 300, h: 100, flipH: true, flipV: true });
    expect(lineBounds(at(300, 0), at(0, 100))).toEqual({ x: 0, y: 0, w: 300, h: 100, flipH: true, flipV: false });
  });

  it('draws back exactly the ends it was built from', () => {
    const line = { ...rect(deck(), 0, 0, 0, 0), ...lineBounds(at(40, 90), at(10, 20)) };
    expect(lineEnds(line)).toEqual({ from: at(40, 90), to: at(10, 20) });
  });
});

describe('a connector follows the shapes it is attached to', () => {
  const twoBoxes = (): { d: Deck; a: DeckShape; b: DeckShape; conn: DeckShape } => {
    const d = deck();
    const a = rect(d, 0, 0, 100 * PT, 100 * PT);
    const b = rect(d, 400 * PT, 0, 100 * PT, 100 * PT);
    return { d, a, b, conn: connectorBetween(d, a, b) };
  };

  it('a new connector names both shapes and both sites, and starts where it should', () => {
    const { a, b, conn } = twoBoxes();
    expect(conn.stCxn).toEqual({ uid: a.uid, id: 0, idx: 3 });
    expect(conn.endCxn).toEqual({ uid: b.uid, id: 0, idx: 1 });
    expect(conn.x).toBe(100 * PT);
    expect(conn.w).toBe(300 * PT);
    expect(conn.h).toBe(0);
    expect(conn.arrow).toBe(true);
    expect(connectable(a)).toBe(true);
    expect(connectable(conn)).toBe(false);
  });

  it('re-routes onto the sides of the shapes as they are now', () => {
    const { a, b, conn } = twoBoxes();
    const moved = { ...a, x: 0, y: 200 * PT };
    const next = routeConnector(conn, [moved, b]);
    expect(next).not.toBe(conn);
    expect(next.stCxn).toBe(conn.stCxn);
    // From the right side of the moved box to the left side of the other one.
    expect(lineEnds(next)).toEqual({ from: at(100 * PT, 250 * PT), to: at(400 * PT, 50 * PT) });
  });

  it('follows a resize too, and stays put when nothing moved', () => {
    const { a, b, conn } = twoBoxes();
    const shapes = [a, b, conn];
    expect(followConnectors(shapes)).toBe(shapes);
    const taller = { ...b, h: 300 * PT };
    const next = followConnectors([a, taller, conn]);
    expect(next).not.toBe(shapes);
    expect(lineEnds(next[2])).toEqual({ from: at(100 * PT, 50 * PT), to: at(400 * PT, 150 * PT) });
  });

  it('lets go of a shape that is no longer there, and never keeps a dangling reference', () => {
    const { a, b, conn } = twoBoxes();
    expect(routeConnector(conn, [a])).toMatchObject({ stCxn: { uid: a.uid }, endCxn: null });
    expect(routeConnector(conn, [])).toMatchObject({ stCxn: null, endCxn: null });
    const detached = detachFrom([a, b, conn], b.uid);
    expect(detached[2]).toMatchObject({ stCxn: { uid: a.uid }, endCxn: null });
    expect(detached[0]).toBe(a);
    expect(detachFrom([a, b, conn], 999)).toEqual([a, b, conn]);
  });

  it('leaves a free line alone: only the user moves it', () => {
    const { d, a, b } = twoBoxes();
    const free = { ...connectorBetween(d, a, b), stCxn: null, endCxn: null, x: 7, y: 9, w: 11, h: 13 };
    expect(routeConnector(free, [a, b])).toBe(free);
    const shapes = [a, b, free];
    expect(followConnectors(shapes)).toBe(shapes);
  });

  it('finds the target shape by uid first, and by the file id when the file is all it has', () => {
    const { a, b, conn } = twoBoxes();
    const shapes = [{ ...a, spid: 5 }, { ...b, spid: 6 }];
    expect(targetOf(conn.stCxn, shapes)).toBe(shapes[0]);
    expect(targetOf({ uid: null, id: 6, idx: 1 }, shapes)).toBe(shapes[1]);
    expect(targetOf({ uid: 4242, id: 6, idx: 1 }, shapes)).toBe(shapes[1]);
    expect(targetOf({ uid: null, id: 99, idx: 1 }, shapes)).toBeNull();
    expect(targetOf(null, shapes)).toBeNull();
  });
});

describe('the markup of a connector', () => {
  it('writes the attachments and the connector preset PowerPoint itself uses', () => {
    const d = deck();
    const a = { ...rect(d, 0, 0, 100 * PT, 100 * PT), spid: 2 };
    const b = { ...rect(d, 400 * PT, 0, 100 * PT, 100 * PT), spid: 3 };
    const conn = connectorBetween(d, a, b);
    const xml = shapeXml(conn, 4, null);
    expect(xml).toContain('<a:stCxn id="2" idx="3"/>');
    expect(xml).toContain('<a:endCxn id="3" idx="1"/>');
    expect(xml).toContain('<a:prstGeom prst="straightConnector1">');
    expect(xml.startsWith('<p:cxnSp>')).toBe(true);
  });

  it('names a shape drawn in this session by the id it is being written with', () => {
    const d = deck();
    const a = rect(d, 0, 0, 100 * PT, 100 * PT);
    const b = rect(d, 400 * PT, 0, 100 * PT, 100 * PT);
    const conn = connectorBetween(d, a, b);
    const ids = new Map([[a.uid, 11], [b.uid, 12]]);
    const xml = shapeXml(conn, 13, null, ids);
    expect(xml).toContain('<a:stCxn id="11" idx="3"/>');
    expect(xml).toContain('<a:endCxn id="12" idx="1"/>');
  });

  it('writes no attachment at all for a free line', () => {
    const line = { ...newShape(deck(), 'line'), stCxn: null, endCxn: null };
    const xml = shapeXml(line, 2, null);
    expect(xml).toContain('<p:cNvCxnSpPr/>');
    expect(xml).not.toContain('stCxn');
  });
});
