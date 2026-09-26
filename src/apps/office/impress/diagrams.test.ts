/**
 * Impress — the simple diagrams: what they are made of, that the arrows really join their
 * neighbours, and that the whole thing survives a real save and reopen as one group.
 */
import { describe, expect, it } from 'vitest';
import { newDeckPptx } from '../pptx';
import { readRawZip, utf8, writeZip } from '../zip';
import { contentTypes } from '../ooxml';
import { readDeck, type Deck, type DeckShape } from './deck';
import { patchDeck } from './deckpatch';
import { groupXml } from './deckxml';
import { addShape, setBounds, ungroup } from './ops';
import { lineEnds } from './connectors';
import { DIAGRAM_KINDS, diagramArrows, diagramBoxes, diagramShape } from './diagrams';

const base = async (): Promise<Deck> => readDeck(newDeckPptx('T', 'S'));

/** A plain rectangle on a slide, for the "not a group" case. */
function newShapeStub(deck: Deck): DeckShape {
  return { ...diagramBoxes(diagramShape(deck, 'list'))[0]!, uid: 4242 };
}

describe('the diagrams', () => {
  it('is one group of boxes joined by arrows, for every kind', async () => {
    const deck = await base();
    for (const kind of DIAGRAM_KINDS) {
      const d = diagramShape(deck, kind);
      expect(d.kind).toBe('group');
      expect(diagramBoxes(d)).toHaveLength(4);
      // A list and a process join each pair once; a cycle closes the ring, so it needs one more.
      expect(diagramArrows(d)).toHaveLength(kind === 'cycle' ? 4 : 3);
      expect(d.box).toEqual({ x: 0, y: 0, w: d.w, h: d.h });
      // Centred on the slide, and inside it.
      expect(d.x).toBe(Math.round((deck.cx - d.w) / 2));
      expect(d.y).toBe(Math.round((deck.cy - d.h) / 2));
      expect(d.w).toBeLessThan(deck.cx);
      expect(d.h).toBeLessThan(deck.cy);
    }
  });

  it('attaches every arrow to the box it leaves and the box it reaches', async () => {
    const deck = await base();
    const d = diagramShape(deck, 'process');
    const boxes = diagramBoxes(d);
    const arrows = d.children.filter((c) => c.kind === 'line');
    arrows.forEach((arrow, i) => {
      expect(arrow.stCxn).toEqual({ uid: boxes[i]!.uid, id: 0, idx: 3 });
      expect(arrow.endCxn).toEqual({ uid: boxes[i + 1]!.uid, id: 0, idx: 1 });
      expect(arrow.arrow).toBe(true);
    });
  });

  it('runs a list downwards and a cycle around a single ring', async () => {
    const deck = await base();
    const list = diagramShape(deck, 'list');
    const boxes = diagramBoxes(list);
    // A list: every box below the one before it, same column.
    expect(boxes.map((b) => b.x)).toEqual([0, 0, 0, 0]);
    expect(boxes.map((b) => b.y)).toEqual([...boxes].map((b) => b.y).sort((a, b) => a - b));
    expect(new Set(boxes.map((b) => b.y)).size).toBe(4);
    for (const arrow of diagramArrows(list)) {
      expect(arrow.stCxn?.idx).toBe(2);
      expect(arrow.endCxn?.idx).toBe(0);
      // The arrow leaves the bottom edge of one box and lands on the top edge of the next.
      const from = boxes.find((b) => b.uid === arrow.stCxn?.uid)!;
      expect(arrow.y).toBe(from.y + from.h);
    }

    const cycle = diagramShape(deck, 'cycle');
    const ring = diagramBoxes(cycle);
    const arrows = diagramArrows(cycle);
    expect(arrows).toHaveLength(4);
    // Every box is the start of exactly one arrow and the end of exactly one arrow: one turn.
    expect(new Set(arrows.map((a) => a.stCxn?.uid)).size).toBe(4);
    expect(arrows.map((a) => a.endCxn?.uid)).toEqual([ring[1]!.uid, ring[2]!.uid, ring[3]!.uid, ring[0]!.uid]);
    // And no arrow crosses the middle of the ring: each one joins boxes that share a row or a
    // column, so the pair of sites is horizontal or vertical, never diagonal.
    arrows.forEach((a, i) => {
      const from = ring[i]!;
      const to = ring[(i + 1) % 4]!;
      const sameRow = from.y === to.y;
      const sameColumn = from.x === to.x;
      expect(sameRow || sameColumn).toBe(true);
    });
  });

  it('writes a group with its own child space and unique ids', async () => {
    const deck = await base();
    const d = diagramShape(deck, 'cycle');
    const ids = new Map<number, number>();
    let id = 10;
    ids.set(d.uid, id);
    for (const child of d.children) ids.set(child.uid, ++id);
    const xml = groupXml(d, ids.get(d.uid)!, 'Cycle', ids);
    expect(xml.startsWith('<p:grpSp>')).toBe(true);
    expect(xml).toContain(`<a:chOff x="0" y="0"/><a:chExt cx="${d.w}" cy="${d.h}"/>`);
    // The group and its nine children: four boxes and four arrows.
    expect(xml.match(/<p:cNvPr id="\d+"/g)!.length).toBe(9);
    expect(new Set(xml.match(/<p:cNvPr id="\d+"/g)).size).toBe(9);
    // The first arrow of the ring names the two boxes it joins by the ids they are written with.
    expect(xml).toContain('<a:stCxn id="11" idx="3"/><a:endCxn id="12" idx="1"/>');
  });
});

describe('a diagram in a real file', () => {
  it('is saved as one group and read back with its boxes and its wired arrows', async () => {
    const bytes = newDeckPptx('T', 'S');
    const deck = await readDeck(bytes);
    const diagram = diagramShape(deck, 'process');
    const next = addShape(deck, 0, diagram);
    const out = await patchDeck(readRawZip(bytes), deck, next);
    expect(out).not.toBeNull();
    const saved = out!.bytes;

    const read = await readDeck(saved);
    const group = read.slides[0].shapes[read.slides[0].shapes.length - 1]!;
    expect(group.kind).toBe('group');
    expect(group.name).toBe('Process');
    expect([group.x, group.y, group.w, group.h]).toEqual([diagram.x, diagram.y, diagram.w, diagram.h]);
    expect(diagramBoxes(group)).toHaveLength(4);
    const arrows = diagramArrows(group);
    expect(arrows).toHaveLength(3);
    // The arrows came back attached to a shape of the group, by their file ids.
    for (const arrow of arrows) {
      expect(arrow.stCxn?.id).toBeGreaterThan(0);
      expect(arrow.endCxn?.id).toBeGreaterThan(0);
      expect(arrow.arrow).toBe(true);
    }
    // Saving the deck again writes nothing: the model and the file agree.
    const idle = await patchDeck(readRawZip(saved), read, read);
    expect(idle?.changed).toEqual([]);
  });

  it('keeps every shape of a slide that also has a group', async () => {
    const bytes = newDeckPptx('T', 'S');
    const deck = await readDeck(bytes);
    const next = addShape(addShape(deck, 0, diagramShape(deck, 'cycle')), 0, diagramShape(deck, 'list'));
    const out = await patchDeck(readRawZip(bytes), deck, next);
    expect(out).not.toBeNull();
    const read = await readDeck(out!.bytes);
    const groups = read.slides[0].shapes.filter((s) => s.kind === 'group');
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.name).sort()).toEqual(['Cycle', 'List']);
    expect(read.slides[0].shapes.filter((s) => s.kind !== 'group')).toHaveLength(2);
  });

  it('refuses a group it cannot write instead of writing a broken one', async () => {
    const bytes = newDeckPptx('T', 'S');
    const deck = await readDeck(bytes);
    const diagram = diagramShape(deck, 'list');
    const withPicture: DeckShape = {
      ...diagram,
      children: [
        ...diagram.children,
        { ...diagram.children[0]!, uid: 999_999, kind: 'pic', image: { path: null, bytes: new Uint8Array([1]), mime: 'image/png', ext: 'png' } },
      ],
    };
    // A package with no such part is still a package: the patch must refuse, not emit a picture
    // with no media entry.
    const out = await patchDeck(readRawZip(bytes), deck, addShape(deck, 0, withPicture));
    expect(out).toBeNull();
    expect(diagramBoxes(diagram)).toHaveLength(4);
  });

  it('takes a group apart into shapes that can be edited, with the arrows still attached', async () => {
    const deck = await base();
    const diagram = diagramShape(deck, 'process');
    const withDiagram = addShape(deck, 0, diagram);
    const flat = ungroup(withDiagram, 0, diagram.uid).slides[0]!.shapes;
    // The four boxes and the three arrows are shapes of the slide now, in the group's order.
    expect(flat).toHaveLength(addShape(deck, 0, diagram).slides[0]!.shapes.length - 1 + 7);
    const lifted = flat.slice(-7);
    expect(lifted.filter((s) => s.kind === 'shape')).toHaveLength(4);
    expect(lifted.filter((s) => s.kind === 'line')).toHaveLength(3);
    // Same place on the slide as they were inside the group (the group's box did not scale them).
    const boxes = diagramBoxes(diagram);
    expect(lifted.slice(0, 4).map((b) => [b.x, b.y, b.w, b.h])).toEqual(boxes.map((b) => [b.x + diagram.x, b.y + diagram.y, b.w, b.h]));
    expect(lifted.every((s) => !s.locked)).toBe(true);
    // And the first box moved: the arrow that left it follows, because it is a real connector.
    const first = lifted[0]!;
    const moved = setBounds(ungroup(withDiagram, 0, diagram.uid), 0, first.uid, { x: first.x, y: first.y + 1_000_000, w: first.w, h: first.h });
    const arrow = moved.slides[0]!.shapes.find((s) => s.kind === 'line' && s.stCxn?.uid === first.uid)!;
    expect(arrow).toBeDefined();
    // A process arrow leaves the right side of its box, so it starts on the moved box's right
    // edge at its middle — the connector re-routed itself onto the box's new place.
    expect(lineEnds(arrow).from).toEqual({ x: first.x + first.w, y: first.y + 1_000_000 + Math.round(first.h / 2) });
  });

  it('leaves a group it cannot take apart alone', async () => {
    const deck = await base();
    const diagram = diagramShape(deck, 'list');
    const deckWith = addShape(deck, 0, diagram);
    const locked = { ...deckWith, slides: deckWith.slides.map((s) => ({ ...s, shapes: s.shapes.map((x) => (x.uid === diagram.uid ? { ...x, locked: true } : x)) })) };
    expect(ungroup(locked, 0, diagram.uid)).toBe(locked);
    expect(ungroup(deckWith, 0, 12345)).toBe(deckWith);
    const notAGroup = addShape(deck, 0, newShapeStub(deck));
    expect(ungroup(notAGroup, 0, notAGroup.slides[0]!.shapes.slice(-1)[0]!.uid)).toBe(notAGroup);
  });
});

describe('a diagram in a package this app did not write', () => {
  it('is read like any other group', async () => {
    // A slide with a group whose children are boxes and a connector, as PowerPoint writes them.
    const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
    const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
    const sp = (id: number, x: number) => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Box ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
      `<p:spPr><a:xfrm><a:off x="${x}" y="0"/><a:ext cx="100" cy="100"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
      '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>B</a:t></a:r></a:p></p:txBody></p:sp>';
    const cxn = '<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="20" name="Arrow"/><p:cNvCxnSpPr><a:stCxn id="10" idx="3"/><a:endCxn id="11" idx="1"/></p:cNvCxnSpPr><p:nvPr/></p:nvCxnSpPr>' +
      '<p:spPr><a:xfrm><a:off x="100" y="50"/><a:ext cx="100" cy="0"/></a:xfrm><a:prstGeom prst="straightConnector1"><a:avLst/></a:prstGeom></p:spPr></p:cxnSp>';
    const group = `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="9" name="Diagram"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
      `<p:grpSpPr><a:xfrm><a:off x="1000" y="2000"/><a:ext cx="200" cy="100"/><a:chOff x="0" y="0"/><a:chExt cx="200" cy="100"/></a:xfrm></p:grpSpPr>` +
      `${sp(10, 0)}${sp(11, 100)}${cxn}</p:grpSp>`;
    const tree = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>';
    const slide = `${DECL}<p:sld ${NS}><p:cSld><p:spTree>${tree}${group}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
    const rels = (body: string): Uint8Array => utf8(`${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`);
    const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const r = (id: string, type: string, target: string): string => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`;
    const ct = (n: string, type: string): string => `<Override PartName="/${n}" ContentType="application/vnd.openxmlformats-officedocument.presentationml.${type}+xml"/>`;
    const masterTree = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>';
    const bytes = writeZip([
      { name: '[Content_Types].xml', data: utf8(contentTypes([ct('ppt/presentation.xml', 'presentation.main'), ct('ppt/slideMasters/slideMaster1.xml', 'slideMaster'), ct('ppt/slideLayouts/slideLayout1.xml', 'slideLayout'), ct('ppt/slides/slide1.xml', 'slide')])) },
      { name: '_rels/.rels', data: rels(r('rId1', 'officeDocument', 'ppt/presentation.xml')) },
      { name: 'ppt/presentation.xml', data: utf8(`${DECL}<p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`) },
      { name: 'ppt/_rels/presentation.xml.rels', data: rels(r('rId1', 'slideMaster', 'slideMasters/slideMaster1.xml') + r('rId2', 'slide', 'slides/slide1.xml')) },
      { name: 'ppt/slideMasters/slideMaster1.xml', data: utf8(`${DECL}<p:sldMaster ${NS}><p:cSld><p:spTree>${masterTree}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1"/><p:sldLayoutIdLst><p:sldLayoutId id="1" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`) },
      { name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: rels(r('rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml')) },
      { name: 'ppt/slideLayouts/slideLayout1.xml', data: utf8(`${DECL}<p:sldLayout ${NS} type="blank"><p:cSld><p:spTree>${masterTree}</p:spTree></p:cSld></p:sldLayout>`) },
      { name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: rels(r('rId1', 'slideMaster', '../slideMasters/slideMaster1.xml')) },
      { name: 'ppt/slides/slide1.xml', data: utf8(slide) },
      { name: 'ppt/slides/_rels/slide1.xml.rels', data: rels(r('rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml')) },
    ]);
    // `contentTypes` writes the presentation's own type; the parts are all present, so it parses.
    const deck = await readDeck(bytes);
    expect(deck.slides[0].shapes).toHaveLength(1);
    const g = deck.slides[0].shapes[0]!;
    expect(g.kind).toBe('group');
    expect(g.name).toBe('Diagram');
    expect(g.children).toHaveLength(3);
    expect(g.children.map((c) => c.kind)).toEqual(['text', 'text', 'line']);
    expect(diagramArrows(g)[0]!.stCxn?.id).toBe(10);
  });
});
