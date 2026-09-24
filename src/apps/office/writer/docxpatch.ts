/**
 * Writer — the run-aware surgical save for .docx (الحفظ الجراحي للفقرات الغنية).
 *
 * The original package is kept for the session; a save rewrites only
 * `word/document.xml` (plus `numbering.xml`, `styles.xml`, a new picture, and the
 * relationship/content-type entries those need) and copies every other entry
 * byte-for-byte.
 *
 * Inside the document part, only paragraphs that changed are touched:
 *  • an edited paragraph keeps its `<w:pPr>` (with the owner's changes applied in
 *    schema order) and is re-emitted run by run. Each run keeps its own raw
 *    `<w:rPr>`; only the properties the owner changed are rewritten. An original
 *    run whose text was deleted stays as an empty property-only run, exactly like
 *    Word leaves them, so nothing the run carried is lost. Opaque elements
 *    (pictures, hyperlinks, fields, bookmarks) are written back verbatim;
 *  • a deleted paragraph is removed; a new one is inserted next to its neighbour
 *    and copies the properties of the paragraph it was split from;
 *  • a new table and a new picture are generated as standard WordprocessingML.
 *
 * The result is re-read with both readers before it is accepted: the plain text
 * of every paragraph, and the formatting of every paragraph that changed. Any
 * difference returns null, and the window warns before it rebuilds instead.
 */
import { readDocx } from '../../viewer/formats';
import type { DocModel, ParagraphFormat } from '../model';
import { sameFormat } from '../model';
import { PPR_ORDER, RPR_ORDER, insertPointIn, loadPart, textElement, textParts, type PatchResult } from '../patch';
import { addRelationship, ensureDefault, ensureOverride, MIME_OF, relsPathOf } from '../pkg';
import { jcValue, xmlText } from '../xml';
import { attrLocal, elementsOf, localName, paragraphElements, parsePart, type XmlEdit, type XmlElement } from '../xmlscan';
import { entryData, rebuildZip, readRawZip, utf8, writeZip, type RawZip } from '../zip';
import { contentTypes } from '../ooxml';
import { hasArabic } from './docops';
import { readDocxDocument } from './docxread';
import { RUN_KEYS, blockText, type DocBlock, type OpaqueRun, type Run, type RunProps, type TextRun } from './types';

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const WP_NS = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const PIC_NS = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

/** Splices edits; zero-width insertions at the same offset keep their order. */
export function spliceEdits(xml: string, edits: readonly XmlEdit[]): string {
  const sorted = edits.map((e, i) => ({ e, i })).sort((a, b) => a.e.start - b.e.start || (a.e.end - a.e.start) - (b.e.end - b.e.start) || a.i - b.i);
  let out = '';
  let at = 0;
  for (const { e } of sorted) {
    if (e.start < at) throw new Error('docx: overlapping edits');
    out += xml.slice(at, e.start) + e.xml;
    at = e.end;
  }
  return out + xml.slice(at);
}

const child = (element: XmlElement | undefined, name: string): XmlElement | undefined =>
  element?.children.find((c) => localName(c.name) === name);

/* ─────────────────────────── property markup ─────────────────────────── */

/** Rewrites (or creates) one property container so it holds exactly `wanted` for the given names. */
function setChildren(raw: string, container: string, order: readonly string[], wanted: Map<string, string | null>): string {
  const src = raw || `<w:${container}></w:${container}>`;
  const doc = parsePart(src);
  const root = doc.roots[0];
  if (!root) return raw;
  let base = src;
  let rootEl = root;
  if (root.selfClosing) {
    base = `<${root.name}${src.slice(root.start + 1 + root.name.length, root.end - 2)}></${root.name}>`;
    rootEl = parsePart(base).roots[0];
  }
  const edits: XmlEdit[] = [];
  const ordered = [...wanted.keys()].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  for (const name of ordered) {
    const markup = wanted.get(name) ?? null;
    const existing = child(rootEl, name);
    if (existing) edits.push({ start: existing.start, end: existing.end, xml: markup ?? '' });
    else if (markup) {
      const at = insertPointIn(base, rootEl, order, name);
      edits.push({ start: at, end: at, xml: markup });
    }
  }
  const out = spliceEdits(base, edits);
  const inner = parsePart(out).roots[0];
  if (inner && !inner.children.length && !out.slice(inner.openEnd, inner.end).replace(/<\/[^>]+>$/, '').trim()) return '';
  return out;
}

const toggle = (tag: string, value: boolean | undefined): string | null =>
  value === undefined ? null : value ? `<w:${tag}/>` : `<w:${tag} w:val="0"/>`;

/** The run properties markup for `props`, starting from `raw` and changing only what differs from `base`. */
export function runPropsMarkup(raw: string, base: RunProps, props: RunProps, autoRtl: boolean): string {
  const wanted = new Map<string, string | null>();
  const changed = (key: typeof RUN_KEYS[number]): boolean => (props[key] ?? undefined) !== (base[key] ?? undefined);
  if (changed('b')) { wanted.set('b', toggle('b', props.b)); wanted.set('bCs', toggle('bCs', props.b)); }
  if (changed('i')) { wanted.set('i', toggle('i', props.i)); wanted.set('iCs', toggle('iCs', props.i)); }
  if (changed('strike')) wanted.set('strike', toggle('strike', props.strike));
  if (changed('u')) wanted.set('u', props.u === undefined ? null : `<w:u w:val="${props.u ? 'single' : 'none'}"/>`);
  if (changed('color')) wanted.set('color', props.color ? `<w:color w:val="${xmlText(props.color)}"/>` : null);
  if (changed('hl')) wanted.set('highlight', props.hl ? `<w:highlight w:val="${xmlText(props.hl)}"/>` : null);
  if (changed('sz')) {
    const half = props.sz === undefined ? null : Math.max(2, Math.round(props.sz * 2));
    wanted.set('sz', half === null ? null : `<w:sz w:val="${half}"/>`);
    wanted.set('szCs', half === null ? null : `<w:szCs w:val="${half}"/>`);
  }
  if (changed('font')) {
    const hint = /w:hint="([^"]*)"/.exec(raw)?.[1];
    const f = props.font ? xmlText(props.font) : '';
    wanted.set('rFonts', props.font ? `<w:rFonts w:ascii="${f}" w:hAnsi="${f}" w:eastAsia="${f}" w:cs="${f}"${hint ? ` w:hint="${hint}"` : ''}/>` : null);
  }
  if (changed('va')) wanted.set('vertAlign', props.va ? `<w:vertAlign w:val="${props.va}"/>` : null);
  if (changed('rtl')) wanted.set('rtl', toggle('rtl', props.rtl));
  else if (autoRtl && props.rtl === undefined && !/<w:rtl\b/.test(raw)) wanted.set('rtl', '<w:rtl/>');
  if (!wanted.size) return raw;
  return setChildren(raw, 'rPr', RPR_ORDER, wanted);
}

/** Paragraph properties for a format, starting from `raw` and changing only what differs from `base`. */
export function paraPropsMarkup(
  raw: string,
  base: ParagraphFormat | undefined,
  format: ParagraphFormat | undefined,
  numIdFor: (kind: 'bullet' | 'number') => string,
): string {
  const b = base ?? {};
  const f = format ?? {};
  const wanted = new Map<string, string | null>();
  const differs = (key: keyof ParagraphFormat): boolean => (f[key] ?? undefined) !== (b[key] ?? undefined);
  if (differs('align')) wanted.set('jc', f.align ? `<w:jc w:val="${jcValue(f.align)}"/>` : null);
  if (differs('dir')) wanted.set('bidi', f.dir === 'rtl' ? '<w:bidi/>' : f.dir === 'ltr' ? '<w:bidi w:val="0"/>' : null);
  if (differs('style')) wanted.set('pStyle', f.style ? `<w:pStyle w:val="${xmlText(f.style)}"/>` : null);
  if (differs('list')) {
    const id = f.list === 'bullet' || f.list === 'number' ? numIdFor(f.list) : f.list === null ? '0' : null;
    wanted.set('numPr', id === null ? null : `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${id}"/></w:numPr>`);
  }
  let out = wanted.size ? setChildren(raw, 'pPr', PPR_ORDER, wanted) : raw;
  if (differs('line')) {
    const doc = parsePart(out || '<w:pPr></w:pPr>');
    const root = doc.roots[0];
    const spacing = child(root, 'spacing');
    const value = f.line ? Math.round(f.line * 240) : null;
    if (spacing) {
      let open = out.slice(spacing.start, spacing.end).replace(/\s+w:line(Rule)?="[^"]*"/g, '');
      if (value) open = open.replace(/^<w:spacing/, `<w:spacing w:line="${value}" w:lineRule="auto"`);
      out = `${out.slice(0, spacing.start)}${open}${out.slice(spacing.end)}`;
    } else if (value) {
      out = setChildren(out, 'pPr', PPR_ORDER, new Map([['spacing', `<w:spacing w:line="${value}" w:lineRule="auto"/>`]]));
    }
  }
  return out;
}

/* ─────────────────────────── the save context ─────────────────────────── */

interface Context {
  numIdFor(kind: 'bullet' | 'number'): string;
  imageRun(run: OpaqueRun): string;
  materialized: Array<{ run: OpaqueRun; xml: string }>;
  contentWidth: number;
  /** Rebuilding into a fresh package: opaque markup that points at other parts becomes text. */
  fresh: boolean;
}

function textRunMarkup(run: TextRun): string {
  const rPr = runPropsMarkup(run.rpr ?? '', run.base ?? {}, run.props, hasArabic(run.text));
  const body = textParts(run.text).map((part) => {
    if (part.kind === 'tab') return '<w:tab/>';
    if (part.kind === 'br') return '<w:br/>';
    return textElement('w:t', '<w:t>', part.value);
  }).join('');
  if (!body && !rPr) return '';
  return `<w:r>${rPr}${body}</w:r>`;
}

function opaqueMarkup(run: OpaqueRun, ctx: Context): string {
  if (run.newImage) return ctx.imageRun(run);
  if (!run.xml) {
    if (run.kind === 'page') return '<w:r><w:br w:type="page"/></w:r>';
    if (run.kind === 'break') return '<w:r><w:br/></w:r>';
    return run.text ? `<w:r>${textElement('w:t', null, run.text)}</w:r>` : '';
  }
  if (ctx.fresh && /\br:(id|embed|link)=/.test(run.xml)) {
    return run.text ? `<w:r>${textElement('w:t', null, run.text.replace(/\n/g, ' '))}</w:r>` : '';
  }
  return run.xml;
}

/** The runs of a paragraph, with original runs that lost all their text kept as empty ones. */
function runsMarkup(block: DocBlock, original: DocBlock | undefined, ctx: Context): string {
  const used = new Set(block.runs.map((r) => r.src).filter((s): s is number => s !== undefined));
  const orphans = (original?.runs ?? []).filter((r): r is TextRun => r.t === 'text' && r.src !== undefined && !used.has(r.src) && !!r.rpr);
  let out = '';
  let next = 0;
  const flushBefore = (src: number | undefined): void => {
    while (next < orphans.length && (src === undefined || (orphans[next].src ?? 0) < src)) {
      out += `<w:r>${orphans[next].rpr}</w:r>`;
      next++;
    }
  };
  for (const run of block.runs) {
    if (run.src !== undefined) flushBefore(run.src);
    out += run.t === 'text' ? textRunMarkup(run) : opaqueMarkup(run, ctx);
  }
  flushBefore(undefined);
  return out;
}

function stripSectPr(pPr: string): string {
  if (!pPr) return pPr;
  const doc = parsePart(pPr);
  const sect = child(doc.roots[0], 'sectPr');
  return sect ? `${pPr.slice(0, sect.start)}${pPr.slice(sect.end)}` : pPr;
}

function newParagraph(block: DocBlock, tplPPr: string, tplFormat: ParagraphFormat | undefined, format: ParagraphFormat | undefined, ctx: Context): string {
  const pPr = paraPropsMarkup(stripSectPr(tplPPr), tplFormat, format, ctx.numIdFor);
  return `<w:p>${pPr}${runsMarkup(block, undefined, ctx)}</w:p>`;
}

function tableMarkup(cells: Array<{ block: DocBlock; xml: string }>, ctx: Context): string {
  const meta = cells[0].block.cell;
  if (!meta) return cells.map((c) => c.xml).join('');
  const width = Math.max(200, Math.floor(ctx.contentWidth / meta.cols));
  const border = (side: string): string => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="auto"/>`;
  let out = '<w:tbl><w:tblPr>';
  if (meta.rtl) out += '<w:bidiVisual/>';
  out += `<w:tblW w:w="0" w:type="auto"/><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(border).join('')}</w:tblBorders>`;
  out += '<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr>';
  out += `<w:tblGrid>${'<w:gridCol w:w="W"/>'.replace('W', String(width)).repeat(meta.cols)}</w:tblGrid>`;
  for (let r = 0; r < meta.rows; r++) {
    out += '<w:tr>';
    for (let c = 0; c < meta.cols; c++) {
      const inCell = cells.filter((x) => x.block.cell?.row === r && x.block.cell?.col === c).map((x) => x.xml).join('');
      out += `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/></w:tcPr>${inCell || '<w:p/>'}</w:tc>`;
    }
    out += '</w:tr>';
  }
  return `${out}</w:tbl>`;
}

/* ─────────────────────────── numbering and styles ─────────────────────────── */

const BULLET_ABSTRACT = (id: number): string =>
  `<w:abstractNum w:abstractNumId="${id}"><w:multiLevelType w:val="hybridMultilevel"/>` +
  [0, 1, 2].map((l) => `<w:lvl w:ilvl="${l}"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="${['•', '◦', '▪'][l]}"/><w:lvlJc w:val="start"/><w:pPr><w:ind w:start="${720 * (l + 1)}" w:hanging="360"/></w:pPr></w:lvl>`).join('') +
  '</w:abstractNum>';
const DECIMAL_ABSTRACT = (id: number): string =>
  `<w:abstractNum w:abstractNumId="${id}"><w:multiLevelType w:val="hybridMultilevel"/>` +
  [0, 1, 2].map((l) => `<w:lvl w:ilvl="${l}"><w:start w:val="1"/><w:numFmt w:val="${['decimal', 'lowerLetter', 'lowerRoman'][l]}"/><w:lvlText w:val="%${l + 1}."/><w:lvlJc w:val="start"/><w:pPr><w:ind w:start="${720 * (l + 1)}" w:hanging="360"/></w:pPr></w:lvl>`).join('') +
  '</w:abstractNum>';

const STYLE_DEFS: Record<string, string> = {
  Title: '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="120"/></w:pPr><w:rPr><w:sz w:val="56"/><w:szCs w:val="56"/><w:color w:val="17365D"/></w:rPr></w:style>',
  Subtitle: '<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:rPr><w:i/><w:iCs/><w:color w:val="595959"/><w:sz w:val="30"/><w:szCs w:val="30"/></w:rPr></w:style>',
  Heading1: '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:bCs/><w:color w:val="1F3864"/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:style>',
  Heading2: '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:bCs/><w:color w:val="2F5496"/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>',
  Heading3: '<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="80"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:bCs/><w:color w:val="1F3763"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style>',
  Quote: '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="160" w:after="160"/><w:ind w:start="864" w:end="864"/><w:jc w:val="center"/></w:pPr><w:rPr><w:i/><w:iCs/><w:color w:val="404040"/></w:rPr></w:style>',
  TOC1: '<w:style w:type="paragraph" w:styleId="TOC1"><w:name w:val="toc 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:spacing w:after="100"/></w:pPr></w:style>',
  TOC2: '<w:style w:type="paragraph" w:styleId="TOC2"><w:name w:val="toc 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:spacing w:after="100"/><w:ind w:start="240"/></w:pPr></w:style>',
  TOC3: '<w:style w:type="paragraph" w:styleId="TOC3"><w:name w:val="toc 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:spacing w:after="100"/><w:ind w:start="480"/></w:pPr></w:style>',
};

/* ─────────────────────────── the save ─────────────────────────── */

const RELS = 'word/_rels/document.xml.rels';

/**
 * Patches `archive` so it reads back as `current`. `baseline` is the model the
 * archive reads as. Returns null when the change cannot be expressed or does not
 * read back exactly.
 */
export async function patchDocxRich(archive: RawZip, baseline: DocModel, current: DocModel, fresh = false): Promise<PatchResult | null> {
  const baseBlocks = baseline.blocks ?? [];
  const curBlocks = current.blocks ?? [];
  if (baseBlocks.length !== baseline.paragraphs.length || curBlocks.length !== current.paragraphs.length) return null;

  const baseIndex = new Map<number, number>();
  baseBlocks.forEach((b, i) => baseIndex.set(b.id, i));
  // Kept paragraphs must stay in their original order.
  let last = -1;
  for (const block of curBlocks) {
    const at = baseIndex.get(block.id);
    if (at === undefined) continue;
    if (at <= last) return null;
    last = at;
  }

  const unchanged = (b: DocBlock, a: DocBlock): boolean => JSON.stringify(b.runs, skipBytes) === JSON.stringify(a.runs, skipBytes);
  const changedAny = curBlocks.length !== baseBlocks.length || curBlocks.some((b, i) => {
    const at = baseIndex.get(b.id);
    if (at === undefined || at !== i) return true;
    return !unchanged(b, baseBlocks[at]) || !sameFormat(baseline.formats?.[at], current.formats?.[i]);
  });
  if (!changedAny) return { bytes: archive.bytes, changed: [] };

  const part = await loadPart(archive, 'word/document.xml');
  if (!part) return null;
  const xml = part.xml;
  const doc = parsePart(xml);
  const paragraphs = paragraphElements(doc);
  if (paragraphs.length !== baseBlocks.length) return null;
  const body = doc.roots.flatMap((r) => elementsOf(r, 'body'))[0];
  if (!body) return null;

  const replacements = new Map<string, Uint8Array>();
  const additions = new Map<string, Uint8Array>();
  let ctXml: string | null = null;
  let relsXml: string | null | undefined;
  const loadCt = async (): Promise<string> => {
    if (ctXml === null) ctXml = (await loadPart(archive, '[Content_Types].xml'))?.xml ?? contentTypes([]);
    return ctXml;
  };
  const loadRels = async (): Promise<string | null> => {
    if (relsXml === undefined) relsXml = (await loadPart(archive, RELS))?.xml ?? null;
    return relsXml;
  };
  // Pre-load both so the synchronous generators below can use them.
  await loadCt();
  await loadRels();

  /* numbering, created on demand */
  let numberingXml: string | null | undefined;
  let numberingPath = 'word/numbering.xml';
  const numIds: Partial<Record<'bullet' | 'number', string>> = {};
  const relTargets = [...(relsXml ?? '').matchAll(/<Relationship\b[^>]*>/g)].map((m) => m[0]);
  const numberingRel = relTargets.find((r) => /\/numbering"/.test(r));
  if (numberingRel) numberingPath = `word/${/Target="([^"]+)"/.exec(numberingRel)?.[1] ?? 'numbering.xml'}`.replace(/^word\/\//, '');
  numberingXml = numberingRel ? (await loadPart(archive, numberingPath))?.xml ?? null : null;
  const numberingBefore = numberingXml;
  const numIdFor = (kind: 'bullet' | 'number'): string => {
    const cached = numIds[kind];
    if (cached) return cached;
    let nx = numberingXml ?? `${DECL}<w:numbering xmlns:w="${W_NS}"></w:numbering>`;
    const ndoc = parsePart(nx);
    const root = ndoc.roots.find((r) => localName(r.name) === 'numbering');
    if (!root) throw new Error('docx: numbering.xml has no root');
    const absIds = root.children.filter((c) => localName(c.name) === 'abstractNum').map((c) => Number(attrLocal(nx, c, 'abstractNumId') ?? 0));
    const nums = root.children.filter((c) => localName(c.name) === 'num');
    const numIdsTaken = nums.map((c) => Number(attrLocal(nx, c, 'numId') ?? 0));
    const absId = Math.max(-1, ...absIds) + 1;
    const numId = Math.max(0, ...numIdsTaken) + 1;
    const lastAbs = [...root.children].reverse().find((c) => localName(c.name) === 'abstractNum');
    const absMarkup = kind === 'bullet' ? BULLET_ABSTRACT(absId) : DECIMAL_ABSTRACT(absId);
    const numMarkup = `<w:num w:numId="${numId}"><w:abstractNumId w:val="${absId}"/></w:num>`;
    const firstNum = nums[0];
    const edits: XmlEdit[] = [];
    if (root.selfClosing) {
      nx = `${nx.slice(0, root.end - 2)}>${absMarkup}${numMarkup}</w:numbering>${nx.slice(root.end)}`;
    } else {
      const absAt = lastAbs ? lastAbs.end : firstNum ? firstNum.start : nx.lastIndexOf('<', root.end - 1);
      edits.push({ start: absAt, end: absAt, xml: absMarkup });
      const closeAt = nx.lastIndexOf('<', root.end - 1);
      edits.push({ start: closeAt, end: closeAt, xml: numMarkup });
      nx = spliceEdits(nx, edits);
    }
    numberingXml = nx;
    numIds[kind] = String(numId);
    return String(numId);
  };

  /* pictures */
  let docPrId = Math.max(1000, ...[...xml.matchAll(/<wp:docPr\b[^>]*\sid="(\d+)"/g)].map((m) => Number(m[1]) + 1));
  let mediaN = 1;
  const names = new Set(archive.entries.map((e) => e.name));
  const materialized: Array<{ run: OpaqueRun; xml: string }> = [];
  const imageRun = (run: OpaqueRun): string => {
    const img = run.newImage;
    if (!img) return '';
    while (names.has(`word/media/fo-image${mediaN}.${img.ext}`)) mediaN++;
    const path = `word/media/fo-image${mediaN}.${img.ext}`;
    names.add(path);
    additions.set(path, img.data);
    ctXml = ensureDefault(ctXml ?? contentTypes([]), img.ext, MIME_OF[img.ext] ?? 'application/octet-stream');
    const rel = addRelationship(relsXml ?? null, 'image', `media/fo-image${mediaN}.${img.ext}`);
    relsXml = rel.xml;
    const cx = Math.round(img.w * 12700);
    const cy = Math.round(img.h * 12700);
    const id = docPrId++;
    const name = xmlText(img.name || `Picture ${id}`);
    const markup = `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0" xmlns:wp="${WP_NS}">` +
      `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${id}" name="${name}"/>` +
      `<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="${A_NS}" noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
      `<a:graphic xmlns:a="${A_NS}"><a:graphicData uri="${PIC_NS}"><pic:pic xmlns:pic="${PIC_NS}">` +
      `<pic:nvPicPr><pic:cNvPr id="${id}" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr>` +
      `<pic:blipFill><a:blip r:embed="${rel.id}" xmlns:r="${R_NS}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
      `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
      '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>';
    materialized.push({ run, xml: markup });
    return markup;
  };

  const sect = child(body, 'sectPr');
  const pgSz = child(sect, 'pgSz');
  const pgMar = child(sect, 'pgMar');
  const num = (el: XmlElement | undefined, name: string, fallback: number): number => {
    const v = el ? Number(attrLocal(xml, el, name)) : NaN;
    return Number.isFinite(v) ? v : fallback;
  };
  const contentWidth = num(pgSz, 'w', 11906) - num(pgMar, 'left', 1440) - num(pgMar, 'right', 1440);
  const ctx: Context = { numIdFor, imageRun, materialized, contentWidth, fresh };

  const edits: XmlEdit[] = [];
  const pPrOf = (element: XmlElement): string => {
    const pPr = child(element, 'pPr');
    return pPr ? xml.slice(pPr.start, pPr.end) : '';
  };

  /* deleted paragraphs */
  const keptIds = new Set(curBlocks.map((b) => b.id));
  const deleted = new Set<number>();
  baseBlocks.forEach((b, i) => { if (!keptIds.has(b.id)) deleted.add(i); });
  for (const i of deleted) {
    const p = paragraphs[i];
    const parentName = localName(p.parent?.name ?? '');
    if (parentName !== 'body' && parentName !== 'tc') return null;
    if (child(child(p, 'pPr'), 'sectPr')) return null;
    if (parentName === 'tc') {
      const siblings = (p.parent as XmlElement).children.filter((c) => localName(c.name) === 'p');
      if (siblings.every((s) => deleted.has(paragraphs.indexOf(s)))) return null;
    }
    // A text box inside a deleted paragraph must go with it.
    for (const inner of elementsOf(p, 'p')) if (!deleted.has(paragraphs.indexOf(inner))) return null;
    edits.push({ start: p.start, end: p.end, xml: '' });
  }
  const isNested = (i: number): boolean => {
    for (let a = paragraphs[i].parent; a; a = a.parent) if (localName(a.name) === 'p') return true;
    return false;
  };
  for (const i of deleted) if (isNested(i) && deleted.has(i)) {
    // Removing the outer paragraph already removed it; drop the duplicate edit.
    const p = paragraphs[i];
    const idx = edits.findIndex((e) => e.start === p.start && e.end === p.end);
    if (idx >= 0) edits.splice(idx, 1);
  }

  /* changed paragraphs */
  const curIndexById = new Map<number, number>();
  curBlocks.forEach((b, i) => curIndexById.set(b.id, i));
  for (const [ci, block] of curBlocks.entries()) {
    const bi = baseIndex.get(block.id);
    if (bi === undefined) continue;
    const before = baseBlocks[bi];
    const runsSame = unchanged(block, before);
    const formatSame = sameFormat(baseline.formats?.[bi], current.formats?.[ci]);
    if (runsSame && formatSame) continue;
    const p = paragraphs[bi];
    const pPrRaw = pPrOf(p);
    const pPr = formatSame ? pPrRaw : paraPropsMarkup(pPrRaw, baseline.formats?.[bi], current.formats?.[ci], numIdFor);
    if (runsSame) {
      // Only the paragraph properties changed: replace (or add) the pPr alone.
      const existing = child(p, 'pPr');
      if (existing) edits.push({ start: existing.start, end: existing.end, xml: pPr });
      else if (p.selfClosing) edits.push({ start: p.start, end: p.end, xml: `${xml.slice(p.start, p.end - 2).trimEnd()}>${pPr}</${p.name}>` });
      else edits.push({ start: p.openEnd, end: p.openEnd, xml: pPr });
      continue;
    }
    if (block.locked || before.locked) return null;
    const inner = pPr + runsMarkup(block, before, ctx);
    if (p.selfClosing) edits.push({ start: p.start, end: p.end, xml: `${xml.slice(p.start, p.end - 2).trimEnd()}>${inner}</${p.name}>` });
    else edits.push({ start: p.openEnd, end: xml.lastIndexOf('<', p.end - 1), xml: inner });
  }

  /* new paragraphs, in groups between kept neighbours */
  const tplOf = (block: DocBlock): { pPr: string; format: ParagraphFormat | undefined } => {
    const seen = new Set<number>();
    let at: DocBlock | undefined = block;
    while (at && at.tpl !== undefined && !seen.has(at.tpl)) {
      seen.add(at.tpl);
      const bi = baseIndex.get(at.tpl);
      if (bi !== undefined) return { pPr: pPrOf(paragraphs[bi]), format: baseline.formats?.[bi] };
      const ci = curIndexById.get(at.tpl);
      at = ci === undefined ? undefined : curBlocks[ci];
    }
    return { pPr: '', format: undefined };
  };
  let i = 0;
  while (i < curBlocks.length) {
    if (baseIndex.has(curBlocks[i].id)) { i++; continue; }
    const start = i;
    while (i < curBlocks.length && !baseIndex.has(curBlocks[i].id)) i++;
    const group = curBlocks.slice(start, i);
    let markup = '';
    let j = 0;
    while (j < group.length) {
      const block = group[j];
      const ci = start + j;
      if (block.cell) {
        const table = block.cell.table;
        const cells: Array<{ block: DocBlock; xml: string }> = [];
        while (j < group.length && group[j].cell?.table === table) {
          const b = group[j];
          const tpl = tplOf(b);
          cells.push({ block: b, xml: newParagraph(b, tpl.pPr, tpl.format, current.formats?.[start + j], ctx) });
          j++;
        }
        markup += tableMarkup(cells, ctx);
        continue;
      }
      const tpl = tplOf(block);
      markup += newParagraph(block, tpl.pPr, tpl.format, current.formats?.[ci], ctx);
      j++;
    }
    // Where: after the previous kept paragraph, else before the next, else at the body's start.
    const prev = [...curBlocks.slice(0, start)].reverse().find((b) => baseIndex.has(b.id));
    const next = curBlocks.slice(i).find((b) => baseIndex.has(b.id));
    let at: number;
    if (prev) {
      let el = paragraphs[baseIndex.get(prev.id) as number];
      // A paragraph inside a text box is not a place to add body text.
      for (let a = el.parent; a; a = a.parent) if (localName(a.name) === 'p') el = a;
      at = el.end;
    } else if (next) {
      let el = paragraphs[baseIndex.get(next.id) as number];
      for (let a = el.parent; a; a = a.parent) if (localName(a.name) === 'p') el = a;
      at = el.start;
    } else {
      at = body.openEnd;
    }
    edits.push({ start: at, end: at, xml: markup });
  }

  let nextXml: string;
  try { nextXml = spliceEdits(xml, edits); } catch { return null; }

  // Pictures need their namespaces on the root for strict readers.
  if (materialized.length) {
    const root = parsePart(nextXml).roots.find((r) => localName(r.name) === 'document');
    if (root) {
      const open = nextXml.slice(root.start, root.openEnd);
      let add = '';
      if (!/\sxmlns:r=/.test(open)) add += ` xmlns:r="${R_NS}"`;
      if (!/\sxmlns:wp=/.test(open)) add += ` xmlns:wp="${WP_NS}"`;
      if (!/\sxmlns:a=/.test(open)) add += ` xmlns:a="${A_NS}"`;
      if (!/\sxmlns:pic=/.test(open)) add += ` xmlns:pic="${PIC_NS}"`;
      if (add) nextXml = `${nextXml.slice(0, root.openEnd - 1)}${add}${nextXml.slice(root.openEnd - 1)}`;
    }
  }
  replacements.set('word/document.xml', utf8(nextXml));

  /* numbering part */
  if (numberingXml && numberingXml !== numberingBefore) {
    if (numberingBefore) replacements.set(numberingPath, utf8(numberingXml));
    else {
      additions.set('word/numbering.xml', utf8(numberingXml));
      relsXml = addRelationship(relsXml ?? null, 'numbering', 'numbering.xml').xml;
      ctXml = ensureOverride(ctXml ?? contentTypes([]), '/word/numbering.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml');
    }
  }

  /* styles the owner applied that the file does not define */
  const usedStyles = new Set(Object.values(current.formats ?? {}).map((f) => f.style).filter((s): s is string => !!s && !!STYLE_DEFS[s]));
  if (usedStyles.size) {
    const stylesRel = relTargets.find((r) => /\/styles"/.test(r));
    const stylesPath = stylesRel ? `word/${/Target="([^"]+)"/.exec(stylesRel)?.[1] ?? 'styles.xml'}` : 'word/styles.xml';
    const stylesPart = await loadPart(archive, stylesPath);
    if (stylesPart) {
      const missing = [...usedStyles].filter((id) => !new RegExp(`w:styleId="${id}"`).test(stylesPart.xml));
      if (missing.length) {
        const sdoc = parsePart(stylesPart.xml);
        const root = sdoc.roots.find((r) => localName(r.name) === 'styles');
        if (root && !root.selfClosing) {
          const at = stylesPart.xml.lastIndexOf('<', root.end - 1);
          replacements.set(stylesPath, utf8(`${stylesPart.xml.slice(0, at)}${missing.map((id) => STYLE_DEFS[id]).join('')}${stylesPart.xml.slice(at)}`));
        }
      }
    }
  }

  const ctBefore = (await loadPart(archive, '[Content_Types].xml'))?.xml ?? null;
  if (ctXml && ctXml !== ctBefore) {
    if (ctBefore !== null) replacements.set('[Content_Types].xml', utf8(ctXml));
    else additions.set('[Content_Types].xml', utf8(ctXml));
  }
  const relsBefore = (await loadPart(archive, RELS))?.xml ?? null;
  if (relsXml && relsXml !== relsBefore) {
    if (relsBefore !== null) replacements.set(RELS, utf8(relsXml));
    else additions.set(RELS, utf8(relsXml));
  }

  let bytes: Uint8Array;
  try { bytes = await rebuildZip(archive, replacements, additions); } catch { return null; }

  // The package is accepted only if it reads back as the model says.
  try {
    const texts = await readDocx(bytes);
    if (texts.length !== current.paragraphs.length) return null;
    for (let k = 0; k < texts.length; k++) if ((texts[k] ?? '') !== (current.paragraphs[k] ?? '')) return null;
    const reread = await readDocxDocument(bytes);
    for (const [ci, block] of curBlocks.entries()) {
      const bi = baseIndex.get(block.id);
      const touched = bi === undefined || !unchanged(block, baseBlocks[bi]) || !sameFormat(baseline.formats?.[bi], current.formats?.[ci]);
      if (!touched) continue;
      const back = reread.blocks[ci];
      if (!back || charProps(back.runs) !== charProps(block.runs)) return null;
      if (!sameParagraph(reread.formats[ci], current.formats?.[ci])) return null;
    }
  } catch { return null; }
  return { bytes, changed: [...replacements.keys(), ...additions.keys()], materialized };
}

/** JSON replacer that keeps picture bytes out of comparisons. */
function skipBytes(key: string, value: unknown): unknown {
  return key === 'data' && value instanceof Uint8Array ? value.length : value;
}

/** Each character's editable formatting, for comparing a model with what a file reads back as. */
export function charProps(runs: readonly Run[]): string {
  const keys = ['b', 'i', 'u', 'strike', 'color', 'hl', 'sz', 'font', 'va'] as const;
  const parts: string[] = [];
  for (const run of runs) {
    if (run.t !== 'text' || !run.text) continue;
    const sig = keys.map((k) => String(run.props[k] ?? '')).join('|');
    parts.push(`${sig}×${[...run.text].length}`);
  }
  // Adjacent runs with the same formatting compare as one.
  const merged: string[] = [];
  for (const part of parts) {
    const [sig, count] = part.split('×');
    const last = merged[merged.length - 1];
    if (last && last.split('×')[0] === sig) merged[merged.length - 1] = `${sig}×${Number(last.split('×')[1]) + Number(count)}`;
    else merged.push(`${sig}×${count}`);
  }
  return merged.join(';');
}

function sameParagraph(a: ParagraphFormat | undefined, b: ParagraphFormat | undefined): boolean {
  const keys = ['align', 'dir', 'style', 'list', 'line'] as const;
  return keys.every((k) => (a?.[k] ?? undefined) === (b?.[k] ?? undefined) || (k === 'list' && (a?.[k] ?? null) === null && (b?.[k] ?? null) === null));
}

/** A minimal Word package with one empty paragraph: the base a new document and a rebuild start from. */
export function emptyDocxPackage(rtl: boolean): Uint8Array {
  const document = `${DECL}<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}" xmlns:wp="${WP_NS}" xmlns:a="${A_NS}" xmlns:pic="${PIC_NS}"><w:body>` +
    `<w:p>${rtl ? '<w:pPr><w:bidi/><w:rPr><w:rtl/></w:rPr></w:pPr>' : ''}</w:p>` +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/><w:cols w:space="708"/></w:sectPr>' +
    '</w:body></w:document>';
  const styles = `${DECL}<w:styles xmlns:w="${W_NS}"><w:docDefaults><w:rPrDefault><w:rPr>` +
    '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Arial"/><w:sz w:val="22"/><w:szCs w:val="22"/>' +
    `<w:lang w:val="en-US" w:bidi="ar-SA"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>` +
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/>${rtl ? '<w:pPr><w:bidi/></w:pPr><w:rPr><w:rtl/></w:rPr>' : ''}</w:style>` +
    Object.entries(STYLE_DEFS).filter(([id]) => !id.startsWith('TOC')).map(([, def]) => def).join('') +
    '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>' +
    '</w:styles>';
  const settings = `${DECL}<w:settings xmlns:w="${W_NS}"><w:defaultTabStop w:val="720"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`;
  return writeZip([
    {
      name: '[Content_Types].xml',
      data: utf8(contentTypes([
        '<Default Extension="png" ContentType="image/png"/>',
        '<Default Extension="jpeg" ContentType="image/jpeg"/>',
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>',
        '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>',
      ])),
    },
    { name: '_rels/.rels', data: utf8(`${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R_NS}/officeDocument" Target="word/document.xml"/></Relationships>`) },
    { name: 'word/document.xml', data: utf8(document) },
    { name: 'word/styles.xml', data: utf8(styles) },
    { name: 'word/settings.xml', data: utf8(settings) },
    {
      name: 'word/_rels/document.xml.rels',
      data: utf8(`${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="${R_NS}/styles" Target="styles.xml"/><Relationship Id="rId2" Type="${R_NS}/settings" Target="settings.xml"/></Relationships>`),
    },
  ]);
}

/**
 * Rebuilds a Word file from the rich model alone, into a fresh package: runs keep
 * their formatting, but anything that pointed at another part of the original
 * (pictures, hyperlinks) becomes plain text. The window warns before it does this.
 */
export async function rebuildDocxRich(model: DocModel): Promise<Uint8Array | null> {
  const base = emptyDocxPackage(false);
  const archive = readRawZip(base);
  const read = await readDocxDocument(base);
  const baseline: DocModel = { kind: 'docx', paragraphs: read.blocks.map(blockText), blocks: read.blocks.map((b) => ({ ...b, id: -1 - b.id })) };
  // Every property is written explicitly: the fresh package has no theme or styles
  // for the original raw run properties to lean on.
  const blocks = (model.blocks ?? []).map((b) => ({
    ...b,
    tpl: undefined,
    runs: b.runs.map((r) => (r.t === 'text' ? { ...r, rpr: '', base: {}, src: undefined } : { ...r, src: undefined })),
  }));
  const current: DocModel = { kind: 'docx', paragraphs: model.paragraphs.slice(), blocks, ...(model.formats ? { formats: model.formats } : {}) };
  const out = await patchDocxRich(archive, baseline, current, true);
  if (!out) return null;
  const data = await entryData(readRawZip(out.bytes), 'word/document.xml');
  return data ? out.bytes : null;
}
