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
import { elements, localName, parsePart, applyEdits, attr, type XmlEdit, type XmlElement } from '../xmlscan';
import { entryData, rebuildZip, utf8, type RawZip } from '../zip';
import {
  child, deckTexts, parseRels, readDeck, relativeTarget, relsPath, resolveTarget, shapeElements, slideOrder, transitionElement,
  type Anim, type Deck, type DeckPara, type DeckShape, type DeckSlide,
} from './deck';
import { shapeXml, slideXml, timingXml, transitionXml } from './deckxml';

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

function sameText(a: readonly DeckPara[], b: readonly DeckPara[]): boolean {
  return a.length === b.length && a.every((p, i) => p.text === b[i]?.text);
}

function textEdits(xml: string, el: XmlElement, before: DeckShape, after: DeckShape): XmlEdit[] | null {
  const txBody = child(el, 'txBody');
  if (!txBody) return null;
  const ps = txBody.children.filter((c) => localName(c.name) === 'p');
  if (!ps.length) return null;
  const out: string[] = [];
  after.paras.forEach((p, i) => {
    const old = ps[i];
    if (old && before.paras[i]?.text === p.text) { out.push(xml.slice(old.start, old.end)); return; }
    const template = old ?? ps[ps.length - 1];
    const sub = xml.slice(template.start, template.end);
    out.push(rewriteParagraph(sub, p.text));
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
 * The slide part `part` holding `after`, starting from `xml` (the part `before` was
 * read from). Returns null when something cannot be expressed.
 */
function editSlide(ctx: Ctx, part: string, xml: string, rels: string, before: DeckSlide, after: DeckSlide): { xml: string; rels: string } | null {
  if (!/xmlns:a\s*=/.test(xml)) return null;
  const doc = parsePart(xml);
  const root = doc.roots[0];
  const spTree = child(child(root, 'cSld'), 'spTree');
  if (!root || !spTree || spTree.selfClosing) return null;
  const els = shapeElements(spTree);
  const edits: XmlEdit[] = [];
  const byOrigin = new Map(after.shapes.filter((s) => s.origin !== null).map((s) => [s.origin as number, s]));
  let animChanged = false;

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
    if (c.x !== b.x || c.y !== b.y || c.w !== b.w || c.h !== b.h) {
      const e = xfrmEdits(xml, el, c);
      if (!e) return null;
      edits.push(...e);
    }
    if (!sameText(b.paras, c.paras)) {
      const e = textEdits(xml, el, b, c);
      if (!e) return null;
      edits.push(...e);
    }
  }

  let maxId = 1;
  for (const c of elements(doc, 'cNvPr')) maxId = Math.max(maxId, Number(attr(xml, c, 'id')) || 0);
  const spids = new Map<number, number>();
  let markup = '';
  let relsXml = rels;
  for (const s of after.shapes) {
    if (s.origin !== null) { spids.set(s.uid, s.spid); continue; }
    const id = ++maxId;
    spids.set(s.uid, id);
    if (s.anim) animChanged = true;
    let embed: string | null = null;
    if (s.kind === 'pic') {
      const added = addImage(ctx, part, relsXml, s);
      if (!added) return null;
      relsXml = added.rels;
      embed = added.id;
    }
    markup += shapeXml(s, id, embed);
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
  let id = 1;
  const anims: Array<{ spid: number; anim: Exclude<Anim, null> }> = [];
  let shapes = '';
  for (const s of slide.shapes) {
    const spid = ++id;
    let embed: string | null = null;
    if (s.kind === 'pic') {
      const added = addImage(ctx, part, rels, s);
      if (!added) return null;
      rels = added.rels;
      embed = added.id;
    }
    if (s.kind === 'group' || s.kind === 'frame') return null; // never created here
    shapes += shapeXml(s, spid, embed);
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
  const ctx: Ctx = { archive, names, additions: new Map(), ct: ctXml, mediaNo: 0 };
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
  if (presOut !== presXml) replacements.set(presPart, utf8(presOut));
  if (presRels !== (await textOf(archive, presRelsPart))) replacements.set(presRelsPart, utf8(presRels));
  if (ctx.ct !== ctXml) replacements.set('[Content_Types].xml', utf8(ctx.ct));

  if (!replacements.size && !ctx.additions.size && !removals.size) return { bytes: archive.bytes, changed: [] };
  const bytes = await rebuildZip(archive, replacements, ctx.additions, removals);

  // Read back: the same slides, texts and transitions, or no surgical save at all.
  const read = await readDeck(bytes);
  if (read.slides.length !== cur.slides.length) return null;
  if (JSON.stringify(deckTexts(read)) !== JSON.stringify(deckTexts(cur))) return null;
  for (let i = 0; i < cur.slides.length; i++) {
    const want = cur.slides[i].transition;
    if (want !== 'other' && read.slides[i].transition !== want) return null;
  }
  return { bytes, changed: [...replacements.keys(), ...ctx.additions.keys(), ...removals] };
}
