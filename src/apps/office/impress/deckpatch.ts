/**
 * Impress — the surgical save of the rich deck (حفظ الشرائح الجراحي).
 *
 * The current deck is compared with the deck as it was read, and only what differs
 * is written:
 *  • a slide whose shapes moved, were resized, deleted or retyped: its part is edited
 *    in place (the `<a:off>`/`<a:ext>` of that shape, its paragraphs, its element);
 *  • new shapes are appended to the slide's `spTree`, a new picture as a media part
 *    plus a relationship;
 *  • a new slide is a new part (`ppt/slides/slideN.xml` + rels + content type) and a
 *    new `<p:sldId>`; a duplicate copies its source part and rels (not the notes);
 *  • a deleted slide loses its part, rels, notes page, content type and relationship;
 *  • the order is `sldIdLst` (and the sections list, when the file has one).
 * Every other entry keeps its bytes (`rebuildZip`). The result is read back with
 * `readDeck`; any difference makes this return null, and the window then warns
 * before it rebuilds the file.
 */
import { addRelationship, emptyRels, ensureDefault, ensureOverride, removeOverride, removeRelationships } from '../pkg';
import { xmlText } from '../xml';
import { elements, elementsOf, localName, parsePart, applyEdits, attr, attrLocal, type XmlEdit, type XmlElement } from '../xmlscan';
import { entryData, rebuildZip, utf8, type RawZip } from '../zip';
import {
  child, deckTexts, parseRels, readDeck, relativeTarget, relsPath, resolveTarget, shapeElements, slideOrder, transitionElement,
  type Anim, type Deck, type DeckBox, type DeckCxn, type DeckPara, type DeckShape, type DeckSlide, type MasterText,
} from './deck';
import { cellBodyXml, cxnHolderXml, groupWritable, notesMasterXml, notesSlideXml, shapeXml, slideXml, timingXml, transitionXml } from './deckxml';
import { layoutBgEdits, chromeEdits, chromeShapes, masterEdits } from './master';
import { targetOf } from './connectors';
import { sameParaStyle, styleParagraphXml } from './parafmt';
import { clrSchemeXml, SCHEME_KEYS } from './themes';

const SLIDE_CT = 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml';
const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml' };

export interface DeckPatch { bytes: Uint8Array; changed: string[] }

async function textOf(archive: RawZip, name: string): Promise<string | null> {
  const bytes = await entryData(archive, name);
  return bytes ? new TextDecoder().decode(bytes) : null;
}

const int = (v: number): number => Math.max(0, Math.round(v));

/* ─────────────────────────────── shape edits ─────────────────────────────── */

function xfrmEdits(xml: string, el: XmlElement, s: DeckShape): XmlEdit[] | null {
  const name = localName(el.name);
  const off = `<a:off x="${int(s.x)}" y="${int(s.y)}"/>`;
  const ext = `<a:ext cx="${int(s.w)}" cy="${int(s.h)}"/>`;
  let holder: XmlElement | null = null;
  let x: XmlElement | null;
  if (name === 'graphicFrame') x = child(el, 'xfrm');
  else {
    holder = child(el, name === 'grpSp' ? 'grpSpPr' : 'spPr');
    if (!holder) return null;
    x = child(holder, 'xfrm');
  }
  if (x) {
    const o = child(x, 'off');
    const e = child(x, 'ext');
    if (!o || !e) return null;
    return [{ start: o.start, end: o.end, xml: off }, { start: e.start, end: e.end, xml: ext }];
  }
  if (!holder) return null;
  // A placeholder that inherited its place from the layout gets its own now.
  if (holder.selfClosing) {
    const open = xml.slice(holder.start, holder.end - 2).trimEnd();
    return [{ start: holder.start, end: holder.end, xml: `${open}><a:xfrm>${off}${ext}</a:xfrm></${holder.name}>` }];
  }
  return [{ start: holder.openEnd, end: holder.openEnd, xml: `<a:xfrm>${off}${ext}</a:xfrm>` }];
}

/** A paragraph with new text, keeping the old paragraph's pPr, first run look and end properties. */
function rewriteParagraph(sub: string, text: string): string {
  const doc = parsePart(sub);
  const p = doc.roots[0];
  if (!p) return `<a:p>${text ? `<a:r><a:t>${xmlText(text)}</a:t></a:r>` : ''}</a:p>`;
  const pPr = child(p, 'pPr');
  const run = p.children.find((c) => localName(c.name) === 'r');
  const field = p.children.find((c) => localName(c.name) === 'fld');
  if (field) {
    // A live field must stay a field: its `<a:t>` is a hint, and replacing the run with plain
    // text would freeze a slide number that PowerPoint was keeping up to date by itself.
    const t = elements(doc, 't')[0];
    if (t) return `${sub.slice(0, t.start)}${sub.slice(t.start, t.openEnd)}${xmlText(text)}</${t.name}>${sub.slice(t.end)}`;
    return sub;
  }
  const runPr = child(run, 'rPr');
  const end = child(p, 'endParaRPr');
  let rPr = runPr ? sub.slice(runPr.start, runPr.end) : '';
  if (!rPr && end) {
    rPr = sub.slice(end.start, end.end)
      .replace(/^<([\w.-]+:)?endParaRPr/, '<$1rPr')
      .replace(/<\/([\w.-]+:)?endParaRPr>$/, '</$1rPr>');
  }
  const single = run && !run.selfClosing && elements(doc, 't').length === 1 && p.children.filter((c) => ['r', 'br', 'fld'].includes(localName(c.name))).length === 1;
  if (single && text && !text.includes('\n')) {
    // One run holds the whole text: only its <a:t> changes.
    const t = elements(doc, 't')[0];
    const open = sub.slice(t.start, t.openEnd);
    const keep = /xml:space/.test(open) || !/^\s|\s$/.test(text) ? open : `${open.slice(0, -1)} xml:space="preserve">`;
    return `${sub.slice(0, t.start)}${t.selfClosing ? keep.replace(/\/>$/, '>') : keep}${xmlText(text)}</${t.name}>${sub.slice(t.end)}`;
  }
  let runs = '';
  for (const [i, part] of text.split('\n').entries()) {
    if (i > 0) runs += rPr ? `<a:br>${rPr}</a:br>` : '<a:br/>';
    if (part) runs += `<a:r>${rPr}<a:t>${xmlText(part)}</a:t></a:r>`;
  }
  const open = sub.slice(p.start, p.openEnd);
  if (p.selfClosing) return `${open.slice(0, -2).trimEnd()}>${runs}</${p.name}>`;
  return `${open}${pPr ? sub.slice(pPr.start, pPr.end) : ''}${runs}${end ? sub.slice(end.start, end.end) : ''}</${p.name}>`;
}

/**
 * True when the paragraphs say the same thing *and* look the same. Comparing the look too is
 * what makes a formatting change reach the file: bold, italic, underline, size, colour and
 * alignment are written into the paragraph that already exists instead of being dropped because
 * its text did not move.
 */
function sameParas(a: readonly DeckPara[], b: readonly DeckPara[]): boolean {
  return a.length === b.length && a.every((p, i) => {
    const q = b[i];
    // Two slide-number fields are the same paragraph whatever number each happens to hold: the
    // one in the file is a hint PowerPoint rewrites, and comparing it would rewrite the part on
    // every save that moved a slide.
    const sameText = p.field === 'slidenum' && q?.field === 'slidenum' ? true : p.text === q?.text;
    return !!q && sameText && sameParaStyle(p, q);
  });
}

function textEdits(xml: string, el: XmlElement, before: DeckShape, after: DeckShape): XmlEdit[] | null {
  const txBody = child(el, 'txBody');
  if (!txBody) return null;
  const ps = txBody.children.filter((c) => localName(c.name) === 'p');
  if (!ps.length) return null;
  const out: string[] = [];
  after.paras.forEach((p, i) => {
    const old = ps[i];
    const sameText = !!old && before.paras[i]?.text === p.text;
    if (old && sameText && before.paras[i] && sameParaStyle(before.paras[i], p)) {
      out.push(xml.slice(old.start, old.end));
      return;
    }
    const template = old ?? ps[ps.length - 1];
    const sub = xml.slice(template.start, template.end);
    // New or changed text keeps the paragraph's own markup (bullets, fields, run language);
    // the look is then applied to whatever came out, which is what carries a bare format change.
    out.push(styleParagraphXml(sameText ? sub : rewriteParagraph(sub, p.text), p));
  });
  if (!out.length) return null;
  return [{ start: ps[0].start, end: ps[ps.length - 1].end, xml: out.join('') }];
}

/* ─────────────────────────────── slide edits ─────────────────────────────── */

interface Ctx {
  archive: RawZip;
  names: Set<string>;
  additions: Map<string, Uint8Array>;
  ct: string;
  mediaNo: number;
  /** Parts replaced by this save (the notes pages edited in place land here). */
  replacements?: Map<string, Uint8Array>;
  /** The notes master notes pages point at: the file's own, or one this save creates. */
  notesMaster?: string | null;
  /** The notes master this save created, still to be listed in `presentation.xml`. */
  newNotesMaster?: string | null;
  /** The presentation's theme part (a new notes master is given a copy of it). */
  themePart?: string | null;
}

const NOTES_CT = 'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml';
const NOTES_MASTER_CT = 'application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml';
const THEME_CT = 'application/vnd.openxmlformats-officedocument.theme+xml';

/** A part name not used yet: `ppt/notesSlides/notesSlide3.xml`. */
function freePart(ctx: Ctx, pattern: (n: number) => string): string {
  let n = 1;
  while (ctx.names.has(pattern(n)) || ctx.additions.has(pattern(n))) n++;
  return pattern(n);
}

/** The notes master, creating one (with its own copy of the theme) when the file has none. */
async function ensureNotesMaster(ctx: Ctx): Promise<string | null> {
  if (ctx.notesMaster) return ctx.notesMaster;
  const part = freePart(ctx, (n) => `ppt/notesMasters/notesMaster${n}.xml`);
  const themeBytes = ctx.themePart ? (ctx.replacements?.get(ctx.themePart) ?? await entryData(ctx.archive, ctx.themePart)) : null;
  if (!themeBytes) return null;
  const theme = freePart(ctx, (n) => `ppt/theme/theme${n}.xml`);
  ctx.additions.set(theme, themeBytes);
  ctx.additions.set(part, utf8(notesMasterXml()));
  ctx.additions.set(relsPath(part), utf8(addRelationship(emptyRels(), 'theme', relativeTarget(part, theme)).xml));
  ctx.ct = ensureOverride(ensureOverride(ctx.ct, `/${part}`, NOTES_MASTER_CT), `/${theme}`, THEME_CT);
  ctx.notesMaster = part;
  ctx.newNotesMaster = part;
  return part;
}

/**
 * The speaker notes of one slide part: its notes page edited in place, or a new notes page
 * (and, for a file that never had notes, a notes master) when it had none. Returns the slide's
 * relationships as they must now be, or null when the notes page cannot be written.
 */
async function notesFor(ctx: Ctx, part: string, rels: string, was: string, notes: string): Promise<string | null> {
  if (was.trim() === notes.trim()) return rels;
  const existing = parseRels(rels, part).find((r) => r.type === 'notesSlide' && !r.external);
  if (existing) {
    const pending = ctx.replacements?.get(existing.target);
    const xml = pending ? new TextDecoder().decode(pending) : await textOf(ctx.archive, existing.target);
    if (xml === null) return null;
    const doc = parsePart(xml);
    const body = elements(doc, 'sp').find((sp) => {
      const ph = child(child(child(sp, 'nvSpPr'), 'nvPr'), 'ph');
      return !!ph && attr(xml, ph, 'type') === 'body';
    });
    if (!body) return null;
    const tx = child(body, 'txBody');
    const markup = cellBodyXml(notes.trim(), 'p:txBody');
    const out = tx
      ? applyEdits(xml, [{ start: tx.start, end: tx.end, xml: markup.replace(/^<p:txBody>/, `<${tx.name}>`).replace(/<\/p:txBody>$/, `</${tx.name}>`) }])
      : body.selfClosing ? null : applyEdits(xml, [{ start: xml.lastIndexOf('<', body.end - 1), end: xml.lastIndexOf('<', body.end - 1), xml: markup }]);
    if (out === null) return null;
    ctx.replacements?.set(existing.target, utf8(out));
    return rels;
  }
  if (!notes.trim()) return rels;
  const master = await ensureNotesMaster(ctx);
  if (!master) return null;
  const notesPart = freePart(ctx, (n) => `ppt/notesSlides/notesSlide${n}.xml`);
  let notesRels = addRelationship(emptyRels(), 'notesMaster', relativeTarget(notesPart, master)).xml;
  notesRels = addRelationship(notesRels, 'slide', relativeTarget(notesPart, part)).xml;
  ctx.additions.set(notesPart, utf8(notesSlideXml(notes.trim())));
  ctx.additions.set(relsPath(notesPart), utf8(notesRels));
  ctx.ct = ensureOverride(ctx.ct, `/${notesPart}`, NOTES_CT);
  return addRelationship(rels, 'notesSlide', relativeTarget(part, notesPart)).xml;
}

function addImage(ctx: Ctx, part: string, rels: string, s: DeckShape): { rels: string; id: string } | null {
  if (!s.image) return null;
  const ext = (s.image.ext || 'png').toLowerCase();
  let media: string;
  do media = `ppt/media/image${++ctx.mediaNo}.${ext}`; while (ctx.names.has(media) || ctx.additions.has(media));
  ctx.additions.set(media, s.image.bytes);
  ctx.ct = ensureDefault(ctx.ct, ext, s.image.mime || MIME[ext] || 'application/octet-stream');
  const r = addRelationship(rels, 'image', relativeTarget(part, media));
  return { rels: r.xml, id: r.id };
}

/**
 * The attachments of a connector that already exists in the file, rewritten from the model.
 *
 * `<a:stCxn>`/`<a:endCxn>` live in `<p:cNvCxnSpPr>`, which no other edit touches, so this is the
 * one place a connector that was read from the file can change who it holds on to — when the
 * shape it pointed at is deleted, or when the user drags the line away from both.
 */
function attachmentEdits(
  el: XmlElement, before: DeckShape, after: DeckShape, ids: ReadonlyMap<number, number>,
): XmlEdit[] | null {
  if (localName(el.name) !== 'cxnSp') return [];
  const same = (a: DeckCxn | null, b: DeckCxn | null): boolean =>
    (a?.idx ?? -1) === (b?.idx ?? -1) && (a?.uid ?? null) === (b?.uid ?? null) && (a?.id ?? 0) === (b?.id ?? 0);
  if (same(before.stCxn, after.stCxn) && same(before.endCxn, after.endCxn)) return [];
  const holder = child(child(el, 'nvCxnSpPr'), 'cNvCxnSpPr');
  const xml = cxnHolderXml(after.stCxn, after.endCxn, ids);
  if (holder) return [{ start: holder.start, end: holder.end, xml }];
  const nv = child(el, 'nvCxnSpPr');
  if (!nv || nv.selfClosing) return null;
  return [{ start: nv.openEnd, end: nv.openEnd, xml }];
}

const FILLS = ['noFill', 'solidFill', 'gradFill', 'blipFill', 'pattFill', 'grpFill'];

function sameLook(a: DeckShape, b: DeckShape): boolean {
  return (a.fill ?? null) === (b.fill ?? null) && (a.stroke ?? null) === (b.stroke ?? null) && a.strokeW === b.strokeW;
}

/**
 * A shape's whole `<p:spPr>` with a new fill and/or outline (and its box, when that moved too —
 * one edit, so it can never overlap the box edit of the same element). Every other child keeps
 * its bytes: the geometry, the effects, the 3-D settings, the outline's dash and arrow heads.
 */
function spPrEdit(xml: string, el: XmlElement, before: DeckShape, after: DeckShape): XmlEdit[] | null {
  if (localName(el.name) !== 'sp' && localName(el.name) !== 'cxnSp') return null;
  const spPr = child(el, 'spPr');
  if (!spPr) return null;
  const kids = spPr.selfClosing ? [] : spPr.children;
  const slice = (c: XmlElement): string => xml.slice(c.start, c.end);
  const moved = before.x !== after.x || before.y !== after.y || before.w !== after.w || before.h !== after.h;
  const off = `<a:off x="${int(after.x)}" y="${int(after.y)}"/>`;
  const ext = `<a:ext cx="${int(after.w)}" cy="${int(after.h)}"/>`;
  let xfrm = '';
  const x = kids.find((c) => localName(c.name) === 'xfrm');
  if (x) {
    const o = child(x, 'off');
    const e = child(x, 'ext');
    if (moved && (!o || !e)) return null;
    xfrm = moved && o && e ? applyEdits(xml.slice(x.start, x.end), [
      { start: o.start - x.start, end: o.end - x.start, xml: off }, { start: e.start - x.start, end: e.end - x.start, xml: ext },
    ]) : slice(x);
  } else if (moved) xfrm = `<a:xfrm>${off}${ext}</a:xfrm>`;
  const geom = kids.filter((c) => ['custGeom', 'prstGeom'].includes(localName(c.name))).map(slice).join('');
  const oldFill = kids.find((c) => FILLS.includes(localName(c.name)));
  const oldLn = kids.find((c) => localName(c.name) === 'ln');
  const rest = kids.filter((c) => !['xfrm', 'custGeom', 'prstGeom', 'ln', ...FILLS].includes(localName(c.name))).map(slice).join('');
  let fill = oldFill ? slice(oldFill) : '';
  if ((before.fill ?? null) !== (after.fill ?? null)) fill = after.fill ? `<a:solidFill><a:srgbClr val="${hexOf(after.fill)}"/></a:solidFill>` : '<a:noFill/>';
  let ln = oldLn ? slice(oldLn) : '';
  if ((before.stroke ?? null) !== (after.stroke ?? null) || before.strokeW !== after.strokeW) {
    // The outline keeps its dash, joins and arrow heads; only its colour and width are new.
    const keep = oldLn && !oldLn.selfClosing ? oldLn.children.filter((c) => !FILLS.includes(localName(c.name))).map(slice).join('') : '';
    const attrs = oldLn ? xml.slice(oldLn.start, oldLn.openEnd).replace(/^<[\w:.-]+/, '').replace(/\/?>$/, '').replace(/\sw\s*=\s*"[^"]*"/, '') : '';
    const color = after.stroke ? `<a:solidFill><a:srgbClr val="${hexOf(after.stroke)}"/></a:solidFill>` : '<a:noFill/>';
    ln = `<a:ln w="${int(after.strokeW)}"${attrs}>${color}${keep}</a:ln>`;
  }
  const name = spPr.name;
  const open = xml.slice(spPr.start, spPr.openEnd).replace(/\s*\/>$/, '>');
  return [{ start: spPr.start, end: spPr.end, xml: `${open}${xfrm}${geom}${fill}${ln}${rest}</${name}>` }];
}

const hexOf = (c: string): string => c.replace('#', '').toUpperCase();

/** An external hyperlink relationship (a web address the show opens on a click). */
function addHyperlink(rels: string, url: string): { rels: string; id: string } {
  const r = addRelationship(rels, 'hyperlink', url);
  const at = r.xml.indexOf(`Id="${r.id}"`);
  const close = r.xml.indexOf('/>', at);
  return { rels: `${r.xml.slice(0, close)} TargetMode="External"${r.xml.slice(close)}`, id: r.id };
}

/** The `<p:cNvPr>` of a shape with its click link set, replaced or taken away. */
function linkEdits(xml: string, el: XmlElement, link: string | null, rels: string): { edits: XmlEdit[]; rels: string } | null {
  const nv = el.children.find((c) => /^nv/.test(localName(c.name)));
  const cNvPr = child(nv, 'cNvPr');
  if (!cNvPr) return null;
  const openTag = xml.slice(cNvPr.start, cNvPr.openEnd).replace(/\s*\/>$/, '>');
  const kids = cNvPr.selfClosing ? [] : cNvPr.children.filter((c) => localName(c.name) !== 'hlinkClick');
  // The old link's relationship goes with it (a hyperlink relationship belongs to one click).
  const old = cNvPr.selfClosing ? null : child(cNvPr, 'hlinkClick');
  const oldId = old ? attrLocal(xml, old, 'id') : null;
  let out = oldId ? removeRelationships(rels, (type, _target, id) => type === 'hyperlink' && id === oldId) : rels;
  let click = '';
  if (link) { const r = addHyperlink(out, link); out = r.rels; click = `<a:hlinkClick r:id="${r.id}"/>`; }
  const inner = click + kids.map((c) => xml.slice(c.start, c.end)).join('');
  return { edits: [{ start: cNvPr.start, end: cNvPr.end, xml: `${openTag}${inner}</${cNvPr.name}>` }], rels: out };
}

/** The cells of a table whose text changed: each cell's paragraphs are written again. */
function tableEdits(xml: string, el: XmlElement, before: DeckShape, after: DeckShape): XmlEdit[] | null {
  const tbl = elementsOf(el, 'tbl')[0] ?? null;
  if (!tbl || !after.table) return null;
  const rows = tbl.children.filter((c) => localName(c.name) === 'tr');
  const edits: XmlEdit[] = [];
  for (let r = 0; r < after.table.length; r++) {
    const cells = (rows[r]?.children ?? []).filter((c) => localName(c.name) === 'tc');
    for (let c = 0; c < (after.table[r]?.length ?? 0); c++) {
      const text = after.table[r]![c] ?? '';
      if (before.table?.[r]?.[c] === text) continue;
      const tc = cells[c];
      if (!tc || tc.selfClosing) return null;
      const body = child(tc, 'txBody');
      if (body) edits.push({ start: body.start, end: body.end, xml: cellBodyXml(text) });
      else edits.push({ start: tc.openEnd, end: tc.openEnd, xml: cellBodyXml(text) });
    }
  }
  return edits;
}

/**
 * The spTree's shapes in the model's stacking order. Only when every shape element of the slide
 * is one the model knows, and they sit next to each other: anything else refuses the save
 * rather than moving an element this editor does not understand.
 */
function reorderShapes(xml: string, order: readonly number[], want: readonly number[]): string | null {
  if (order.length === want.length && order.every((u, i) => u === want[i])) return xml;
  const doc = parsePart(xml);
  const spTree = child(child(doc.roots[0] ?? null, 'cSld'), 'spTree');
  if (!spTree) return null;
  const els = shapeElements(spTree);
  if (els.length !== order.length) return null;
  for (let i = 1; i < els.length; i++) if (xml.slice(els[i - 1]!.end, els[i]!.start).trim()) return null;
  const byUid = new Map(order.map((u, i) => [u, xml.slice(els[i]!.start, els[i]!.end)]));
  const body = want.map((u) => byUid.get(u) ?? '').join('');
  if (!els.length) return xml;
  return `${xml.slice(0, els[0]!.start)}${body}${xml.slice(els[els.length - 1]!.end)}`;
}

/**
 * The slide part `part` holding `after`, starting from `xml` (the part `before` was
 * read from). Returns null when something cannot be expressed.
 */
function editSlide(ctx: Ctx, part: string, xml: string, rels: string, before: DeckSlide, after: DeckSlide): { xml: string; rels: string } | null {
  const out = editSlideParts(ctx, part, xml, rels, before, after);
  if (!out) return null;
  // The stacking order last, on the edited part: the shapes the file had (in file order), then
  // the new ones (appended in model order), rearranged to the model's order.
  const tree = child(child(parsePart(xml).roots[0] ?? null, 'cSld'), 'spTree');
  const known = !!tree && before.shapes.filter((b) => b.origin !== null).length === shapeElements(tree).length;
  const survivors = after.shapes.filter((s) => s.origin !== null).sort((a, b) => (a.origin as number) - (b.origin as number)).map((s) => s.uid);
  const fresh = after.shapes.filter((s) => s.origin === null).map((s) => s.uid);
  const want = after.shapes.map((s) => s.uid);
  const order = [...survivors, ...fresh];
  if (order.every((u, i) => u === want[i])) return out;
  if (!known) return null;
  const reordered = reorderShapes(out.xml, order, want);
  return reordered === null ? null : { xml: reordered, rels: out.rels };
}

function editSlideParts(ctx: Ctx, part: string, xml: string, rels: string, before: DeckSlide, after: DeckSlide): { xml: string; rels: string } | null {
  if (!/xmlns:a\s*=/.test(xml)) return null;
  const doc = parsePart(xml);
  const root = doc.roots[0];
  const spTree = child(child(root, 'cSld'), 'spTree');
  if (!root || !spTree || spTree.selfClosing) return null;
  const els = shapeElements(spTree);
  const edits: XmlEdit[] = [];
  const byOrigin = new Map(after.shapes.filter((s) => s.origin !== null).map((s) => [s.origin as number, s]));
  let animChanged = false;

  // The ids come first, because a change to a connector's attachments names the shape it holds
  // on to — including a shape drawn in this same edit, whose id does not exist until now — and
  // because the children of a new group need ids of their own on the slide.
  let maxId = 1;
  for (const c of elements(doc, 'cNvPr')) maxId = Math.max(maxId, Number(attr(xml, c, 'id')) || 0);
  const spids = new Map<number, number>();
  const assignIds = (list: readonly DeckShape[]): void => {
    for (const s of list) {
      if (s.origin !== null) spids.set(s.uid, s.spid);
      else spids.set(s.uid, ++maxId);
      assignIds(s.children);
    }
  };
  assignIds(after.shapes);
  // A new group holding something this writer cannot put in a group refuses the save.
  for (const s of after.shapes) if (s.kind === 'group' && s.origin === null && !groupWritable(s)) return null;

  let relsXml = rels;
  for (const b of before.shapes) {
    if (b.origin === null) continue;
    const el = els[b.origin];
    if (!el) return null;
    const c = byOrigin.get(b.origin);
    if (!c) {
      edits.push({ start: el.start, end: el.end, xml: '' });
      if (b.anim) animChanged = true;
      continue;
    }
    if (c.anim !== b.anim) animChanged = true;
    if (c.locked) continue;
    if (!sameLook(b, c)) {
      // The fill or the outline changed: the whole `spPr` is written once, box included.
      const e = spPrEdit(xml, el, b, c);
      if (!e) return null;
      edits.push(...e);
    } else if (c.x !== b.x || c.y !== b.y || c.w !== b.w || c.h !== b.h) {
      const e = xfrmEdits(xml, el, c);
      if (!e) return null;
      edits.push(...e);
    }
    if ((c.link ?? null) !== (b.link ?? null)) {
      const l = linkEdits(xml, el, c.link ?? null, relsXml);
      if (!l) return null;
      relsXml = l.rels;
      edits.push(...l.edits);
    }
    if (c.kind === 'frame' && JSON.stringify(c.table) !== JSON.stringify(b.table)) {
      const e = tableEdits(xml, el, b, c);
      if (!e) return null;
      edits.push(...e);
    }
    if (!sameParas(b.paras, c.paras)) {
      const e = textEdits(xml, el, b, c);
      if (!e) return null;
      edits.push(...e);
    }
    const a = attachmentEdits(el, b, c, spids);
    if (!a) return null;
    edits.push(...a);
  }

  let markup = '';
  for (const s of after.shapes) {
    if (s.origin !== null) continue;
    const id = spids.get(s.uid) as number;
    if (s.anim) animChanged = true;
    let embed: string | null = null;
    if (s.kind === 'pic') {
      const added = addImage(ctx, part, relsXml, s);
      if (!added) return null;
      relsXml = added.rels;
      embed = added.id;
    }
    if (s.kind === 'frame' && !s.table) return null;
    let linkRid: string | null = null;
    if (s.link) { const r = addHyperlink(relsXml, s.link); relsXml = r.rels; linkRid = r.id; }
    markup += shapeXml(s, id, embed, spids, linkRid);
  }
  const inserts: XmlEdit[] = [];
  if (markup) {
    const closeAt = xml.lastIndexOf('<', spTree.end - 1);
    inserts.push({ start: closeAt, end: closeAt, xml: markup });
  }

  const transChanged = after.transition !== before.transition && after.transition !== 'other';
  if (transChanged || animChanged) {
    const tEl = transitionElement(root);
    const timing = child(root, 'timing');
    const anchorEl = child(root, 'clrMapOvr') ?? child(root, 'cSld');
    if (!anchorEl) return null;
    const list = after.shapes.filter((s) => s.anim).map((s) => ({ spid: spids.get(s.uid) ?? 0, anim: s.anim as Exclude<Anim, null> }));
    const timingMarkup = animChanged ? timingXml(list) : '';
    const removals: XmlEdit[] = [];
    if (transChanged && tEl) removals.push({ start: tEl.start, end: tEl.end, xml: '' });
    if (animChanged && timing) removals.push({ start: timing.start, end: timing.end, xml: '' });
    if (transChanged) {
      // The new transition (and timing, which must follow it) go right after clrMapOvr.
      inserts.push({ start: anchorEl.end, end: anchorEl.end, xml: transitionXml(after.transition) + timingMarkup });
    } else if (animChanged) {
      const at = tEl ? tEl.end : anchorEl.end;
      inserts.push({ start: at, end: at, xml: timingMarkup });
    }
    // Insertions come first so one at the same offset as a removal is spliced before it.
    return { xml: applyEdits(xml, [...inserts, ...edits, ...removals]), rels: relsXml };
  }
  if (!inserts.length && !edits.length) return { xml, rels: relsXml };
  return { xml: applyEdits(xml, [...inserts, ...edits]), rels: relsXml };
}

/** A brand-new slide part from the model alone. */
function newSlide(ctx: Ctx, part: string, slide: DeckSlide): { xml: string; rels: string } | null {
  let rels = emptyRels();
  if (slide.layout) rels = addRelationship(rels, 'slideLayout', relativeTarget(part, slide.layout)).xml;
  // The ids come first so a connector can point at a shape made in the same breath.
  const ids = new Map<number, number>();
  let id = 1;
  for (const s of slide.shapes) ids.set(s.uid, ++id);
  const anims: Array<{ spid: number; anim: Exclude<Anim, null> }> = [];
  let shapes = '';
  for (const s of slide.shapes) {
    if (s.kind === 'frame' && !s.table) return null; // only a table is ever created here
    if (s.kind === 'group' && !groupWritable(s)) return null;
    const spid = ids.get(s.uid) as number;
    let embed: string | null = null;
    if (s.kind === 'pic') {
      const added = addImage(ctx, part, rels, s);
      if (!added) return null;
      rels = added.rels;
      embed = added.id;
    }
    let linkRid: string | null = null;
    if (s.link) { const r = addHyperlink(rels, s.link); rels = r.rels; linkRid = r.id; }
    shapes += shapeXml(s, spid, embed, ids, linkRid);
    if (s.anim) anims.push({ spid, anim: s.anim });
  }
  return { xml: slideXml(shapes, null, slide.transition === 'other' ? 'none' : slide.transition, timingXml(anims)), rels };
}

/* ───────────────────────────── the presentation ───────────────────────────── */

export async function patchDeck(archive: RawZip, base: Deck, cur: Deck): Promise<DeckPatch | null> {
  if (!cur.slides.length) return null;
  const presPart = 'ppt/presentation.xml';
  const presXml = await textOf(archive, presPart);
  const presRelsPart = relsPath(presPart);
  let presRels = await textOf(archive, presRelsPart);
  const ctXml = await textOf(archive, '[Content_Types].xml');
  if (!presXml || !presRels || !ctXml) return null;
  const order = slideOrder(presXml, parseRels(presRels, presPart));
  const byPart = new Map(order.map((o) => [o.part, o]));

  const names = new Set(archive.entries.map((e) => e.name));
  const replacements = new Map<string, Uint8Array>();
  const removals = new Set<string>();
  const presRelList = parseRels(presRels, presPart);
  const ctx: Ctx = {
    archive, names, additions: new Map(), ct: ctXml, mediaNo: 0, replacements,
    notesMaster: presRelList.find((r) => r.type === 'notesMaster' && !r.external)?.target ?? null,
    newNotesMaster: null,
    themePart: presRelList.find((r) => r.type === 'theme' && !r.external)?.target ?? null,
  };
  let slideNo = 0;
  for (const n of names) {
    const s = /^ppt\/slides\/slide(\d+)\.xml$/.exec(n);
    if (s) slideNo = Math.max(slideNo, Number(s[1]));
    const m = /^ppt\/media\/image(\d+)\./.exec(n);
    if (m) ctx.mediaNo = Math.max(ctx.mediaNo, Number(m[1]));
  }
  const baseByPart = new Map(base.slides.filter((s) => s.part).map((s) => [s.part as string, s]));

  const finalParts: string[] = [];
  for (const slide of cur.slides) {
    const src = slide.part ?? slide.from;
    const before = src ? baseByPart.get(src) : undefined;
    if (src && !before) return null;
    if (slide.part) {
      if (!byPart.has(slide.part)) return null;
      const xml = await textOf(archive, slide.part);
      if (xml === null || !before) return null;
      const rp = relsPath(slide.part);
      const rels = await textOf(archive, rp);
      const out = editSlide(ctx, slide.part, xml, rels ?? emptyRels(), before, slide);
      if (!out) return null;
      const withNotes = await notesFor(ctx, slide.part, out.rels, before.notes, slide.notes);
      if (withNotes === null) return null;
      out.rels = withNotes;
      if (out.xml !== xml) replacements.set(slide.part, utf8(out.xml));
      if (out.rels !== (rels ?? emptyRels())) {
        if (rels === null) ctx.additions.set(rp, utf8(out.rels)); else replacements.set(rp, utf8(out.rels));
      }
      finalParts.push(slide.part);
      continue;
    }
    let part: string;
    do part = `ppt/slides/slide${++slideNo}.xml`; while (names.has(part) || ctx.additions.has(part));
    let out: { xml: string; rels: string } | null;
    if (src && before) {
      const xml = await textOf(archive, src);
      if (xml === null) return null;
      // A copy keeps every relationship of its source except the notes page (and
      // comments), which belong to the original slide.
      const rels = removeRelationships(await textOf(archive, relsPath(src)) ?? emptyRels(), (type) => ['notesSlide', 'comments'].includes(type));
      out = editSlide(ctx, part, xml, rels, before, slide);
    } else {
      out = newSlide(ctx, part, slide);
    }
    if (!out) return null;
    const withNotes = await notesFor(ctx, part, out.rels, '', slide.notes);
    if (withNotes === null) return null;
    out.rels = withNotes;
    ctx.additions.set(part, utf8(out.xml));
    ctx.additions.set(relsPath(part), utf8(out.rels));
    ctx.ct = ensureOverride(ctx.ct, `/${part}`, SLIDE_CT);
    finalParts.push(part);
  }

  // Deleted slides take their rels, notes page and content types with them.
  const kept = new Set(finalParts);
  for (const b of base.slides) {
    if (!b.part || kept.has(b.part)) continue;
    removals.add(b.part);
    const rp = relsPath(b.part);
    ctx.ct = removeOverride(ctx.ct, `/${b.part}`);
    if (names.has(rp)) {
      removals.add(rp);
      for (const r of parseRels(await textOf(archive, rp), b.part)) {
        if (r.type !== 'notesSlide' || r.external || !names.has(r.target)) continue;
        removals.add(r.target);
        if (names.has(relsPath(r.target))) removals.add(relsPath(r.target));
        ctx.ct = removeOverride(ctx.ct, `/${r.target}`);
      }
    }
    presRels = removeRelationships(presRels, (type, target) => type === 'slide' && resolveTarget(presPart, target) === b.part);
  }

  // The order: sldIdLst (and the sections, when the file has them).
  const sameOrder = finalParts.length === order.length && finalParts.every((p, i) => order[i]?.part === p);
  let presOut = presXml;
  if (!sameOrder) {
    const doc = parsePart(presXml);
    const root = doc.roots[0];
    if (!root) return null;
    const lst = child(root, 'sldIdLst');
    let maxId = 255;
    for (const s of elements(doc, 'sldId')) maxId = Math.max(maxId, Number(/\sid\s*=\s*["'](\d+)["']/.exec(presXml.slice(s.start, s.openEnd))?.[1] ?? 0));
    const pPrefix = /^([\w.-]+:)/.exec(root.name)?.[1] ?? '';
    const firstSld = lst?.children.find((c) => localName(c.name) === 'sldId');
    const rPrefix = firstSld ? /\s([\w.-]+):id\s*=/.exec(presXml.slice(firstSld.start, firstSld.openEnd))?.[1] ?? 'r' : 'r';
    const idOf = new Map<string, number>();
    const items = finalParts.map((part) => {
      const known = byPart.get(part);
      if (known) { idOf.set(part, known.id); return `<${pPrefix}sldId id="${known.id}" ${rPrefix}:id="${known.rid}"/>`; }
      const r = addRelationship(presRels as string, 'slide', relativeTarget(presPart, part));
      presRels = r.xml;
      const id = ++maxId;
      idOf.set(part, id);
      return `<${pPrefix}sldId id="${id}" ${rPrefix}:id="${r.id}"/>`;
    }).join('');
    const edits: XmlEdit[] = [];
    if (lst && !lst.selfClosing) edits.push({ start: lst.openEnd, end: presXml.lastIndexOf('<', lst.end - 1), xml: items });
    else if (lst) edits.push({ start: lst.start, end: lst.end, xml: `<${lst.name}>${items}</${lst.name}>` });
    else {
      const after = ['handoutMasterIdLst', 'notesMasterIdLst', 'sldMasterIdLst'].map((n) => child(root, n)).find((e) => e);
      if (!after) return null;
      edits.push({ start: after.end, end: after.end, xml: `<${pPrefix}sldIdLst>${items}</${pPrefix}sldIdLst>` });
    }
    // Sections: each slide stays in its section; a new slide joins the one before it.
    const sections = elements(doc, 'section');
    if (sections.length) {
      const partOfId = new Map(order.map((o) => [o.id, o.part]));
      const sectionOf = new Map<string, number>();
      sections.forEach((sec, i) => {
        const l = child(sec, 'sldIdLst');
        for (const s of l?.children ?? []) {
          const id = Number(attr(presXml, s, 'id'));
          const part = partOfId.get(id);
          if (part) sectionOf.set(part, i);
        }
      });
      const members: number[][] = sections.map(() => []);
      let at = sectionOf.get(finalParts[0] ?? '') ?? 0;
      for (const part of finalParts) {
        const own = sectionOf.get(part);
        if (own !== undefined && own > at) at = own;
        members[at]?.push(idOf.get(part) ?? 0);
      }
      sections.forEach((sec, i) => {
        const l = child(sec, 'sldIdLst');
        if (!l) return;
        const prefix = /^([\w.-]+:)/.exec(l.name)?.[1] ?? '';
        const inner = (members[i] ?? []).map((id) => `<${prefix}sldId id="${id}"/>`).join('');
        if (l.selfClosing) edits.push({ start: l.start, end: l.end, xml: `<${l.name}>${inner}</${l.name}>` });
        else edits.push({ start: l.openEnd, end: presXml.lastIndexOf('<', l.end - 1), xml: inner });
      });
    }
    presOut = applyEdits(presXml, edits);
  }
  // The slide size: `<p:sldSz>` says it (the shapes were scaled in the model, and their boxes are
  // written above like any other move).
  if (cur.cx !== base.cx || cur.cy !== base.cy) {
    const sized = slideSizeEdit(presOut, cur.cx, cur.cy);
    if (sized === null) return null;
    presOut = sized;
  }
  // A notes master made by this save is listed right after the slide masters.
  if (ctx.newNotesMaster) {
    const r = addRelationship(presRels as string, 'notesMaster', relativeTarget(presPart, ctx.newNotesMaster));
    presRels = r.xml;
    const root = parsePart(presOut).roots[0];
    const masters = child(root, 'sldMasterIdLst');
    if (!root || !masters) return null;
    const prefix = /^([\w.-]+:)/.exec(root.name)?.[1] ?? '';
    presOut = applyEdits(presOut, [{ start: masters.end, end: masters.end, xml: `<${prefix}notesMasterIdLst><${prefix}notesMasterId r:id="${r.id}"/></${prefix}notesMasterIdLst>` }]);
  }
  if (presOut !== presXml) replacements.set(presPart, utf8(presOut));
  if (presRels !== (await textOf(archive, presRelsPart))) replacements.set(presRelsPart, utf8(presRels));
  if (ctx.ct !== ctXml) replacements.set('[Content_Types].xml', utf8(ctx.ct));
  if (!await patchMasters(archive, base, cur, replacements)) return null;
  if (!await patchTheme(archive, presRels, base, cur, replacements)) return null;

  if (!replacements.size && !ctx.additions.size && !removals.size) return { bytes: archive.bytes, changed: [] };
  const bytes = await rebuildZip(archive, replacements, ctx.additions, removals);

  // Read back: the same slides, texts and transitions, or no surgical save at all.
  const read = await readDeck(bytes);
  if (read.slides.length !== cur.slides.length) return null;
  if (JSON.stringify(deckTexts(read)) !== JSON.stringify(deckTexts(cur))) return null;
  if (connectorKeys(read) !== connectorKeys(cur)) return null;
  if (lookKeys(read) !== lookKeys(cur)) return null;
  // The master is the design: if the file does not say what the model says, nothing is written.
  if (masterKey(read) !== masterKey(cur)) return null;
  // The design and the size: what the canvas shows is what the file now says.
  if (themeKey(read) !== themeKey(cur)) return null;
  if (read.cx !== cur.cx || read.cy !== cur.cy) return null;
  for (let i = 0; i < cur.slides.length; i++) {
    if (read.slides[i].notes.trim() !== cur.slides[i].notes.trim()) return null;
    const want = cur.slides[i].transition;
    if (want !== 'other' && read.slides[i].transition !== want) return null;
  }
  return { bytes, changed: [...replacements.keys(), ...ctx.additions.keys(), ...removals] };
}

/**
 * Every master of the deck as a canonical string.
 *
 * Field by field rather than `JSON.stringify` of the objects: two masters that say the same
 * thing must compare equal whichever order their keys were built in (the dialog builds a text
 * look one way, the reader another, and a key order is not a difference).
 */
function masterKey(deck: Deck): string {
  const text = (t: MasterText): readonly unknown[] => [t.font, t.color, t.size];
  const box = (b: DeckBox | null): readonly unknown[] | null => (b ? [b.x, b.y, b.w, b.h] : null);
  return JSON.stringify(deck.masters.map((m) => [m.part, m.bg, text(m.title), text(m.body), m.footer, m.slideNumber, box(m.footerBox), box(m.numberBox)]));
}

/**
 * Every editable shape's fill, outline and link, slide by slide: a save that would draw a shape
 * in another colour than the canvas did (or lose its link) is refused.
 */
function lookKeys(deck: Deck): string {
  return JSON.stringify(deck.slides.map((slide) => slide.shapes.filter((s) => !s.locked && s.kind !== 'group').map((s) => [
    s.kind === 'shape' || s.kind === 'text' ? (s.fill ?? null) : null,
    s.kind === 'pic' || s.kind === 'frame' ? null : (s.stroke ?? null),
    s.kind !== 'pic' && s.kind !== 'frame' && s.stroke ? s.strokeW : null,
    s.link ?? null,
  ])));
}

/**
 * Every connector end of the deck as "which shape of this slide, which site".
 *
 * Comparing the resolved shape rather than the raw `cNvPr id` is what makes the check work for a
 * connector drawn in this session: it knows its target by uid, and the id only exists once the
 * slide has been written. A save that loses an attachment, or writes it onto the wrong shape,
 * fails this and is refused instead of producing a deck that draws differently from the model.
 */
function connectorKeys(deck: Deck): string {
  return JSON.stringify(deck.slides.map((slide) => slide.shapes.map((s) => {
    if (s.kind !== 'line') return '';
    const at = (r: DeckCxn | null): string => {
      const target = targetOf(r, slide.shapes);
      return `${target ? slide.shapes.indexOf(target) : -1}:${r?.idx ?? -1}`;
    };
    return `${at(s.stCxn)}>${at(s.endCxn)}`;
  })));
}

/**
 * The masters this deck changed, and the layouts that override them.
 *
 * A layout with a `<p:bg>` of its own hides the master's background, so the same colour is
 * written there too — the file then shows what the canvas showed. A master the model cannot
 * express (no `txStyles`, say) refuses the whole save instead of writing half a design.
 */
async function patchMasters(archive: RawZip, base: Deck, cur: Deck, replacements: Map<string, Uint8Array>): Promise<boolean> {
  for (const master of cur.masters) {
    const before = base.masters.find((m) => m.part === master.part);
    if (!before) return false;
    const xml = await textOf(archive, master.part);
    if (xml === null) return false;
    const design = masterEdits(xml, before, master);
    if (design === null) return false;
    // The master carries the design of the footer and the number — where they sit and what the
    // footer says; every slide carries its own copy, because PowerPoint shows neither otherwise.
    const chrome = chromeEdits(xml, chromeShapes(cur, master, 0));
    if (chrome === null) return false;
    const edits = [...design, ...chrome];
    if (edits.length) replacements.set(master.part, utf8(applyEdits(xml, edits)));
    if (before.bg === master.bg) continue;
    for (const layout of cur.layouts) {
      const lx = await textOf(archive, layout.part);
      if (lx === null) continue;
      const layoutEdits = layoutBgEdits(lx, master.bg);
      if (layoutEdits.length) replacements.set(layout.part, utf8(applyEdits(lx, layoutEdits)));
    }
  }
  return true;
}

/* ─────────────────────────────── design and size ─────────────────────────────── */

/** The theme's colours and fonts as one canonical string (fonts only when the model has them). */
function themeKey(deck: Deck): string {
  return JSON.stringify([SCHEME_KEYS.map((k) => (deck.scheme[k] ?? '').toUpperCase()), deck.fonts ? [deck.fonts.major, deck.fonts.minor] : null]);
}

/** `<p:sldSz>` with the new size; the `type` attribute is dropped because it names the old one. */
function slideSizeEdit(xml: string, cx: number, cy: number): string | null {
  const root = parsePart(xml).roots[0];
  const sz = child(root, 'sldSz');
  const tag = `<${sz?.name ?? 'p:sldSz'} cx="${Math.round(cx)}" cy="${Math.round(cy)}"/>`;
  if (sz) return applyEdits(xml, [{ start: sz.start, end: sz.end, xml: tag }]);
  const after = child(root, 'sldIdLst') ?? child(root, 'notesMasterIdLst') ?? child(root, 'sldMasterIdLst');
  if (!after) return null;
  return applyEdits(xml, [{ start: after.end, end: after.end, xml: tag }]);
}

/**
 * The theme part, when the design changed: the whole `<a:clrScheme>` is replaced, and the Latin
 * typeface of the heading and body fonts is set (every other script's font is left as it was).
 */
async function patchTheme(archive: RawZip, presRels: string, base: Deck, cur: Deck, replacements: Map<string, Uint8Array>): Promise<boolean> {
  if (themeKey(base) === themeKey(cur)) return true;
  const rel = parseRels(presRels, 'ppt/presentation.xml').find((r) => r.type === 'theme' && !r.external);
  if (!rel) return false;
  const pending = replacements.get(rel.target);
  const xml = pending ? new TextDecoder().decode(pending) : await textOf(archive, rel.target);
  if (xml === null) return false;
  const doc = parsePart(xml);
  const edits: XmlEdit[] = [];
  const clr = elements(doc, 'clrScheme')[0];
  if (!clr) return false;
  const name = /\sname\s*=\s*"([^"]*)"/.exec(xml.slice(clr.start, clr.openEnd))?.[1] ?? 'Custom';
  const colorsChanged = SCHEME_KEYS.some((k) => (base.scheme[k] ?? '').toUpperCase() !== (cur.scheme[k] ?? '').toUpperCase());
  if (colorsChanged) edits.push({ start: clr.start, end: clr.end, xml: clrSchemeXml(decodeName(name), cur.scheme) });
  const fontsChanged = !!cur.fonts && (base.fonts?.major !== cur.fonts.major || base.fonts?.minor !== cur.fonts.minor);
  if (fontsChanged && cur.fonts) {
    const scheme = elements(doc, 'fontScheme')[0];
    if (!scheme) return false;
    for (const [tag, face] of [['majorFont', cur.fonts.major], ['minorFont', cur.fonts.minor]] as const) {
      const holder = child(scheme, tag);
      if (!holder || holder.selfClosing) return false;
      const latin = child(holder, 'latin');
      const markup = `<a:latin typeface="${xmlText(face)}"/>`;
      if (latin) edits.push({ start: latin.start, end: latin.end, xml: markup });
      else edits.push({ start: holder.openEnd, end: holder.openEnd, xml: markup });
    }
  }
  if (edits.length) replacements.set(rel.target, utf8(applyEdits(xml, edits)));
  return true;
}

/** An attribute value back to text (the scheme's name is written again through `xmlText`). */
function decodeName(v: string): string {
  return v.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
