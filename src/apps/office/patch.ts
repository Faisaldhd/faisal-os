/**
 * Office — the surgical save (الحفظ الجراحي).
 *
 * The old save rebuilt the whole package from the text model, which is why a
 * 27,995-byte Word file came back as 2,550 bytes with its styles, images, header
 * and numbering gone. This module is the other way round: the original archive is
 * kept for the session, and a save rewrites **only** the parts that changed —
 * `word/document.xml` for edited paragraphs, `xl/worksheets/sheetN.xml` (plus
 * `xl/sharedStrings.xml`) for edited cells, `ppt/slides/slideN.xml` for slide
 * text. Every other entry is copied byte-for-byte with its original compression
 * method and flags (`rebuildZip`), and a changed part is recompressed with deflate.
 *
 * Editing rules, so nothing here is a guess:
 *
 *  • **Word paragraphs.** An edited paragraph keeps its `<w:pPr>` and every run
 *    keeps its `<w:rPr>`; the new text goes into the paragraph's *first* text slot
 *    (`<w:t>`, or the first `<w:tab/>`/`<w:br/>` when there is no `<w:t>`) and
 *    every other text slot in that paragraph is emptied. So a paragraph whose text
 *    Word split across several runs — its normal output, and how spell-check or
 *    track-changes splits it — is written back through one run, and the other runs
 *    stay as property-only runs. Tabs and line breaks in the new text become
 *    `<w:tab/>` and `<w:br/>` in that same run. Only edited paragraphs are touched,
 *    at string level, so everything else in the part keeps its bytes.
 *
 *  • **Excel cells.** Only the edited cells change: a numeric-looking value becomes
 *    `<v>` (with the cell's `t` attribute dropped), text reuses `t="s"` — pointing
 *    at an existing `<si>` when the same string is already there, otherwise
 *    appending one new `<si>` to `xl/sharedStrings.xml` — and text in any other
 *    cell becomes an inline string. A cell whose formula the owner typed becomes
 *    `<f>SUM(B1:B2)</f><v>30</v>`: the formula Excel sees plus the result this app
 *    computed. Every other `<si>`, every other cell and the cell's own `r`/`s`
 *    (style) attributes stay untouched. A child this rule does not know is *not*
 *    guessed at: the save takes the fallback path and says so first.
 *
 *  • **Word formatting.** Bold, italic, underline, font size and paragraph
 *    alignment go into the paragraph's own run (`<w:rPr>`) and its `<w:pPr><w:jc>`,
 *    in the order the OOXML schema requires, so Word accepts the part. A property
 *    the owner never touched is not rewritten; `true`/`false` write the toggle on
 *    or explicitly off (`w:val="0"`, which beats a style), and `null` removes the
 *    element. The existing formatting of a file is read back (`readDocxFormats`),
 *    which is what the toolbar shows.
 *
 *  • **PowerPoint text.** The same rule as Word, with `<a:t>`. A tab or a break is
 *    a paragraph-level `<a:tab/>`/`<a:br/>`, so the run is closed and reopened with
 *    the same `<a:rPr/>`.
 *
 * Anything this cannot express makes `patchPackage` return null (or throw inside,
 * which the same call catches), and the window then warns the owner *before*
 * writing that the file will be rebuilt and that the `.bak` holds the only copy.
 */
import { columnIndex, readDocx, readPptx, readXlsx } from '../viewer/formats';
import { cellName, isNumericText, jcValue, paragraphPropertiesMarkup, runPropertiesMarkup, runPropertyChildren, xmlText } from './xml';
import { formatFormula, parseFormula } from './formula/index';
import {
  applyEdits, attr, attrLocal, elementText, elements, elementsOf, localName, paragraphElements, paragraphSlots,
  paragraphText, parsePart, type XmlDoc, type XmlEdit, type XmlElement,
} from './xmlscan';
import { entryData, readRawZip, rebuildZip, utf8, type RawZip } from './zip';
import type { OpaqueRun } from './writer/types';
import type { Revision } from './writer/revisions';
import { patchDocxRich } from './writer/docxpatch';
import { patchDeck } from './impress/deckpatch';
import { addRelationship, ensureOverride } from './pkg';
import { sameCellFormat, type CellFormat } from './grid/sheetfmt';
import { addCellStyles, applySheetLook, cellStyleIds } from './grid/xlsxstyle';
import { shiftFormulasIn, shiftSheetPart, workbookBlocks, type StructOp } from './grid/structure';
import {
  formulaAt, gridWidth, insertColumn, insertRow, removeColumn, removeRow, sameFormat, type DeckModel, type DocModel, type Grid, type OfficeKind, type OfficeModel,
  type ParagraphFormat, type SheetsModel,
} from './model';

/** The three formats that are a ZIP of OOXML parts. */
export type PackageKind = 'docx' | 'xlsx' | 'pptx';

export interface PatchResult {
  /** The bytes to write; the original ones when nothing changed. */
  bytes: Uint8Array;
  /** The parts that were rewritten (empty means the archive is untouched). */
  changed: string[];
  /** New elements (pictures) whose markup the save generated: the model adopts it. */
  materialized?: Array<{ run: OpaqueRun; xml: string }>;
}

/** The package kind of a format plan, or null for the formats written from text. */
export function packageKind(kind: OfficeKind | null | undefined): PackageKind | null {
  return kind === 'docx' || kind === 'xlsx' || kind === 'pptx' ? kind : null;
}

/**
 * A copy of the model as it was read. A save diffs the current model against this
 * to learn exactly what the owner changed — no edit bookkeeping is added to the
 * model itself, and undo/redo cannot lose the difference.
 */
export function snapshotModel(model: OfficeModel): OfficeModel {
  switch (model.kind) {
    case 'docx': return {
      kind: 'docx',
      paragraphs: [...model.paragraphs],
      ...(model.formats ? { formats: Object.fromEntries(Object.entries(model.formats).map(([index, format]) => [index, { ...format }])) } : {}),
      // Runs are never mutated by an edit (every edit builds new ones), so the
      // snapshot can share them; only the list itself is copied.
      ...(model.blocks ? { blocks: model.blocks.slice() } : {}),
    };
    // The rich deck is never mutated (every operation builds a new one), so it is shared.
    case 'pptx': return { kind: 'pptx', slides: model.slides.map((slide) => [...slide]), ...(model.deck ? { deck: model.deck } : {}) };
    case 'text': return { kind: 'text', text: model.text };
    default: return {
      kind: model.kind,
      grids: model.grids.map((grid) => ({ name: grid.name, rows: grid.rows.map((row) => [...row]), truncated: grid.truncated })),
      active: model.active,
      delimiter: model.delimiter,
      ...(model.formulas ? { formulas: { ...model.formulas } } : {}),
      ...(model.moved ? { moved: model.moved } : {}),
      ...(model.sheetFormats ? { sheetFormats: JSON.parse(JSON.stringify(model.sheetFormats)) as typeof model.sheetFormats } : {}),
    };
  }
}

/**
 * Patches the package so that it reads back as `current` while keeping everything
 * else. Returns null when the change is structural or is something a surgical
 * write cannot express; the caller then rebuilds, after warning the owner.
 */
export async function patchPackage(
  kind: PackageKind,
  original: Uint8Array,
  baseline: OfficeModel,
  current: OfficeModel,
  tracked: readonly Revision[] = [],
): Promise<PatchResult | null> {
  try {
    if (!original.length) return null;
    const archive = readRawZip(original);
    if (kind === 'docx') {
      if (baseline.kind !== 'docx' || current.kind !== 'docx') return null;
      // The Writer's rich model (runs with their own formatting, stable paragraph
      // ids) takes the run-aware path; the plain model keeps the original rules.
      // Pending tracked changes are written by that same path, as `w:ins`/`w:del`.
      if (baseline.blocks && current.blocks) return await patchDocxRich(archive, baseline, current, false, tracked);
      return await patchDocx(archive, baseline, current);
    }
    if (kind === 'xlsx') {
      if (!isSheets(baseline) || !isSheets(current) || current.kind !== 'xlsx') return null;
      return await patchXlsx(archive, baseline, current);
    }
    if (baseline.kind !== 'pptx' || current.kind !== 'pptx') return null;
    // The slide editor's rich deck: shapes, order, new and deleted slides.
    if (baseline.deck && current.deck) return await patchDeck(archive, baseline.deck, current.deck);
    return await patchPptx(archive, baseline, current);
  } catch {
    // A refusal, a damaged archive, an unexpected part: never a guess. The caller
    // owns the fallback and tells the owner before it writes anything.
    return null;
  }
}

function isSheets(model: OfficeModel): model is SheetsModel {
  return model.kind === 'xlsx' || model.kind === 'csv';
}

export async function loadPart(archive: RawZip, name: string): Promise<{ bytes: Uint8Array; xml: string } | null> {
  const bytes = await entryData(archive, name);
  return bytes ? { bytes, xml: new TextDecoder().decode(bytes) } : null;
}

/* ───────────────────────────── shared text handling ───────────────────────────── */

type TextPart = { kind: 'text'; value: string } | { kind: 'tab' } | { kind: 'br' };

/**
 * Splits new paragraph text into the pieces a Word or PowerPoint paragraph can
 * hold. Carriage returns are normalized to newlines, exactly as the writers in
 * `ooxml.ts` and `pptx.ts` do, so a patch and a rebuild agree on the same file.
 */
export function textParts(text: string): TextPart[] {
  const out: TextPart[] = [];
  let buffer = '';
  for (const ch of text.replace(/\r\n?/g, '\n')) {
    if (ch === '\t' || ch === '\n') {
      if (buffer) { out.push({ kind: 'text', value: buffer }); buffer = ''; }
      out.push(ch === '\t' ? { kind: 'tab' } : { kind: 'br' });
    } else buffer += ch;
  }
  if (buffer) out.push({ kind: 'text', value: buffer });
  return out;
}

/** Word keeps leading and trailing spaces only when `xml:space="preserve"` is set. */
export function textElement(tag: 'w:t' | 'a:t', open: string | null, value: string): string {
  let start = open ?? `<${tag} xml:space="preserve">`;
  if (!/xml:space\s*=/.test(start) && /^\s|\s$/.test(value)) start = `${start.slice(0, -1)} xml:space="preserve">`;
  return `${start}${xmlText(value)}</${tag}>`;
}

/**
 * The markup that replaces a paragraph's first text slot: the whole new text,
 * with tabs and breaks as the format requires. Null when the anchor is not in a
 * shape where a tab or a break may be written (inside a field, say) — the caller
 * then falls back instead of writing a part it cannot vouch for.
 */
function textSequence(xml: string, anchor: XmlElement, parts: readonly TextPart[], ns: 'w' | 'a'): string | null {
  if (!parts.length) return '';
  const parent = anchor.parent;
  const inRun = !!parent && localName(parent.name) === 'r';
  const hasBreak = parts.some((part) => part.kind !== 'text');
  const anchorOpen = localName(anchor.name) === 't' && !anchor.selfClosing ? xml.slice(anchor.start, anchor.openEnd) : null;

  if (ns === 'w') {
    if (hasBreak && !inRun) return null;
    return parts.map((part, i) => {
      if (part.kind === 'tab') return '<w:tab/>';
      if (part.kind === 'br') return '<w:br/>';
      return textElement('w:t', i === 0 ? anchorOpen : null, part.value);
    }).join('');
  }

  if (!hasBreak) {
    const only = parts[0];
    if (only.kind !== 'text') return null;
    return textElement('a:t', anchorOpen, only.value);
  }
  // PowerPoint: <a:t> lives inside <a:r>, but <a:tab/> and <a:br/> are children of
  // <a:p>. A break therefore closes the run and reopens it with the same <a:rPr/>.
  if (!inRun || !parent || parent.selfClosing) return null;
  const runOpen = xml.slice(parent.start, parent.openEnd);
  const rPr = parent.children.find((child) => localName(child.name) === 'rPr');
  const reopen = `${runOpen}${rPr ? xml.slice(rPr.start, rPr.end) : ''}`;
  return parts.map((part) => {
    if (part.kind === 'tab') return `</a:r><a:tab/>${reopen}`;
    if (part.kind === 'br') return `</a:r><a:br/>${reopen}`;
    return `<a:t xml:space="preserve">${xmlText(part.value)}</a:t>`;
  }).join('');
}

/* ───────────────────────── the paragraph formatting ───────────────────────── */

/**
 * The child order OOXML's schema requires. A property is inserted just before the
 * first child that must come after it, so the part stays schema-valid for Word
 * instead of merely well-formed. Unknown children are treated as "after
 * everything", which keeps them at the end where they were.
 */
export const PPR_ORDER = [
  'pStyle', 'keepNext', 'keepLines', 'pageBreakBefore', 'framePr', 'widowControl', 'numPr', 'suppressLineNumbers',
  'pBdr', 'shd', 'tabs', 'suppressAutoHyphens', 'kinsoku', 'wordWrap', 'overflowPunct', 'topLinePunct',
  'autoSpaceDE', 'autoSpaceDN', 'bidi', 'adjustRightInd', 'snapToGrid', 'spacing', 'ind', 'contextualSpacing',
  'mirrorIndents', 'suppressOverlap', 'jc', 'textDirection', 'textAlignment', 'textboxTightWrap', 'outlineLvl',
  'divId', 'cnfStyle', 'rPr', 'sectPr', 'pPrChange',
];
export const RPR_ORDER = [
  'rStyle', 'rFonts', 'b', 'bCs', 'i', 'iCs', 'caps', 'smallCaps', 'strike', 'dstrike', 'outline', 'shadow',
  'emboss', 'imprint', 'noProof', 'snapToGrid', 'vanish', 'webHidden', 'color', 'spacing', 'w', 'kern',
  'position', 'sz', 'szCs', 'highlight', 'u', 'effect', 'bdr', 'shd', 'fitText', 'vertAlign', 'rtl', 'cs', 'em',
  'lang', 'eastAsianLayout', 'specVanish', 'oMath',
];

/** Where a child with this name belongs inside a parent, per the schema order. */
export function insertPointIn(xml: string, parent: XmlElement, order: readonly string[], name: string): number {
  const rank = (child: string): number => {
    const at = order.indexOf(child);
    return at < 0 ? order.length + 1 : at;
  };
  const mine = rank(name);
  for (const child of parent.children) if (rank(localName(child.name)) > mine) return child.start;
  if (parent.selfClosing) throw new Error('xml: cannot insert into a self-closing element');
  return xml.lastIndexOf('<', parent.end - 1);
}

/**
 * The edits that write a format into one paragraph's run and its `<w:pPr>`.
 *
 * The properties go on the run that carries the text (the run the text rule writes
 * into): one text, one formatting, no ambiguity. `null` removes a property —
 * `<w:b w:val="0"/>` for the toggles, `<w:u w:val="none"/>`, and a deleted
 * `<w:sz>`/`<w:jc>` — while `undefined` leaves the file's own value alone.
 */
function formatEdits(xml: string, paragraph: XmlElement, run: XmlElement | null, format: ParagraphFormat): XmlEdit[] {
  const edits: XmlEdit[] = [];

  if (format.align !== undefined) {
    const pPr = paragraph.children.find((child) => localName(child.name) === 'pPr');
    const jc = pPr ? pPr.children.find((child) => localName(child.name) === 'jc') : undefined;
    if (format.align === null) {
      if (jc) edits.push({ start: jc.start, end: jc.end, xml: '' });
    } else if (jc) {
      edits.push({ start: jc.start, end: jc.end, xml: `<w:jc w:val="${jcValue(format.align)}"/>` });
    } else if (pPr) {
      const at = insertPointIn(xml, pPr, PPR_ORDER, 'jc');
      edits.push({ start: at, end: at, xml: `<w:jc w:val="${jcValue(format.align)}"/>` });
    } else {
      edits.push({ start: paragraph.openEnd, end: paragraph.openEnd, xml: paragraphPropertiesMarkup(format) });
    }
  }

  if (!run) return edits;
  const rPr = run.children.find((child) => localName(child.name) === 'rPr');
  const wanted = runPropertyChildren(format);
  const removed = [...(format.bold === null ? ['b'] : []), ...(format.italic === null ? ['i'] : []),
    ...(format.size === null ? ['sz', 'szCs'] : []), ...(format.underline === null ? ['u'] : [])];

  if (!rPr) {
    if (!wanted.length) return edits;
    const markup = `<w:rPr>${wanted.join('')}</w:rPr>`;
    if (run.selfClosing) {
      const open = `${xml.slice(run.start, run.openEnd - 2)}>`;
      edits.push({ start: run.start, end: run.end, xml: `${open}${markup}</w:r>` });
    } else {
      edits.push({ start: run.openEnd, end: run.openEnd, xml: markup });
    }
    return edits;
  }
  for (const name of removed) {
    const child = rPr.children.find((candidate) => localName(candidate.name) === name);
    if (child) edits.push({ start: child.start, end: child.end, xml: '' });
  }
  for (const markup of wanted) {
    // The name decides which existing child is replaced, prefix included: "w:b" → "b".
    const name = localName(/^<([^\s/>]+)/.exec(markup)?.[1] ?? '');
    const existing = rPr.children.find((child) => localName(child.name) === name);
    if (existing) { edits.push({ start: existing.start, end: existing.end, xml: markup }); continue; }
    const at = insertPointIn(xml, rPr, RPR_ORDER, name);
    edits.push({ start: at, end: at, xml: markup });
  }
  return edits;
}

/**
 * The edits that give one paragraph exactly this text and this formatting, or null
 * if it cannot be done. `text` null means "the text did not change"; `format` null
 * means "the owner did not touch the formatting".
 */
function paragraphEdits(
  xml: string,
  paragraph: XmlElement,
  text: string | null,
  format: ParagraphFormat | null,
  ns: 'w' | 'a',
): XmlEdit[] | null {
  const parts = text === null ? null : textParts(text);
  const slots = paragraphSlots(paragraph);
  const word = ns === 'w';

  if (!slots.length) {
    const body = parts && parts.length ? runMarkup(parts, ns, word ? format : null) : '';
    const block = word && format && format.align !== undefined;
    if (!body && !block) return [];
    if (paragraph.selfClosing) {
      // A self-closing paragraph has nothing to splice into: it is rewritten whole.
      const pPr = block && format?.align ? paragraphPropertiesMarkup(format) : '';
      if (!body && !pPr) return [];
      const open = `${xml.slice(paragraph.start, paragraph.openEnd - 2)}>`;
      return [{ start: paragraph.start, end: paragraph.end, xml: `${open}${pPr}${body}</${paragraph.name}>` }];
    }
    const edits: XmlEdit[] = [];
    if (block) edits.push(...formatEdits(xml, paragraph, null, format as ParagraphFormat));
    if (body) {
      const closeAt = xml.lastIndexOf('<', paragraph.end - 1);
      if (closeAt <= paragraph.start) return null;
      edits.push({ start: closeAt, end: closeAt, xml: body });
    }
    return edits;
  }

  const anchor = slots[0].element;
  const edits: XmlEdit[] = [];
  if (parts !== null) {
    const sequence = textSequence(xml, anchor, parts, ns);
    if (sequence === null) return null;
    for (const slot of slots.slice(1)) edits.push({ start: slot.element.start, end: slot.element.end, xml: '' });
    edits.push({ start: anchor.start, end: anchor.end, xml: sequence });
  }
  if (word && format) {
    const anchorRun = anchor.parent && localName(anchor.parent.name) === 'r' ? anchor.parent : null;
    const run = anchorRun ?? elementsOf(paragraph, 'r')[0] ?? null;
    edits.push(...formatEdits(xml, paragraph, run, format));
  }
  return edits;
}

/** A run holding this text, with the format when there is one (used by `insertRun`). */
function runMarkup(parts: readonly TextPart[], ns: 'w' | 'a', format: ParagraphFormat | null): string {
  const body = parts.map((part) => {
    if (part.kind === 'tab') return ns === 'w' ? '<w:tab/>' : '<a:tab/>';
    if (part.kind === 'br') return ns === 'w' ? '<w:br/>' : '<a:br/>';
    return ns === 'w' ? textElement('w:t', null, part.value) : `<a:r>${textElement('a:t', null, part.value)}</a:r>`;
  }).join('');
  return ns === 'w' ? `<w:r>${runPropertiesMarkup(format)}${body}</w:r>` : body;
}

/* ──────────────────────────────────── Word ──────────────────────────────────── */

/** The formatting a paragraph already carries, so the toolbar shows the truth. */
function formatOfParagraph(xml: string, paragraph: XmlElement): ParagraphFormat {
  const out: ParagraphFormat = {};
  const pPr = paragraph.children.find((child) => localName(child.name) === 'pPr');
  const jc = pPr ? elementsOf(pPr, 'jc')[0] : undefined;
  if (jc) {
    const value = (attrLocal(xml, jc, 'val') ?? '').toLowerCase();
    if (value === 'both' || value === 'distribute') out.align = 'justify';
    else if (value === 'center') out.align = 'center';
    else if (value === 'right' || value === 'end') out.align = 'right';
    else if (value === 'left' || value === 'start') out.align = 'left';
  }
  const runRPr = elementsOf(paragraph, 'r')
    .map((run) => run.children.find((child) => localName(child.name) === 'rPr'))
    .find((candidate) => candidate !== undefined);
  const rPr = runRPr ?? pPr?.children.find((child) => localName(child.name) === 'rPr');
  if (rPr) {
    const toggle = (name: string): boolean | undefined => {
      const element = elementsOf(rPr, name)[0];
      if (!element) return undefined;
      const value = (attrLocal(xml, element, 'val') ?? '').toLowerCase();
      return !(value === '0' || value === 'false' || value === 'off');
    };
    const bold = toggle('b');
    if (bold !== undefined) out.bold = bold;
    const italic = toggle('i');
    if (italic !== undefined) out.italic = italic;
    const underline = elementsOf(rPr, 'u')[0];
    if (underline) out.underline = (attrLocal(xml, underline, 'val') ?? 'single').toLowerCase() !== 'none';
    const size = elementsOf(rPr, 'sz')[0];
    if (size) {
      const value = Number(attrLocal(xml, size, 'val'));
      if (Number.isFinite(value) && value > 0) out.size = value / 2;
    }
  }
  return out;
}

/**
 * The formatting every paragraph of a .docx already has. Only paragraphs that
 * carry something are listed, so a file this app wrote round-trips unchanged, and
 * a file Word wrote shows its real bold/italic/size/alignment in the toolbar.
 */
export async function readDocxFormats(bytes: Uint8Array): Promise<Record<number, ParagraphFormat>> {
  try {
    const archive = readRawZip(bytes);
    const part = await loadPart(archive, 'word/document.xml');
    if (!part) return {};
    const doc = parsePart(part.xml);
    const out: Record<number, ParagraphFormat> = {};
    paragraphElements(doc).forEach((paragraph, index) => {
      const format = formatOfParagraph(part.xml, paragraph);
      if (Object.keys(format).length) out[index] = format;
    });
    return out;
  } catch {
    return {};
  }
}

async function patchDocx(archive: RawZip, baseline: DocModel, current: DocModel): Promise<PatchResult | null> {
  if (baseline.paragraphs.length !== current.paragraphs.length) return null; // a paragraph added or removed
  const texts = new Map<number, string>();
  const formats = new Map<number, ParagraphFormat>();
  for (let i = 0; i < current.paragraphs.length; i++) {
    if ((baseline.paragraphs[i] ?? '') !== (current.paragraphs[i] ?? '')) texts.set(i, current.paragraphs[i] ?? '');
    if (!sameFormat(baseline.formats?.[i], current.formats?.[i])) formats.set(i, current.formats?.[i] ?? {});
  }
  if (!texts.size && !formats.size) return { bytes: archive.bytes, changed: [] };

  const part = await loadPart(archive, 'word/document.xml');
  if (!part) return null;
  const doc = parsePart(part.xml);
  const paragraphs = paragraphElements(doc);
  const edits: XmlEdit[] = [];
  const indices = [...new Set([...texts.keys(), ...formats.keys()])].sort((a, b) => a - b);
  for (const index of indices) {
    const paragraph = paragraphs[index];
    if (!paragraph) return null;
    const next = paragraphEdits(part.xml, paragraph, texts.get(index) ?? null, formats.get(index) ?? null, 'w');
    if (!next) return null;
    edits.push(...next);
  }

  const bytes = await rebuildZip(archive, new Map([['word/document.xml', utf8(applyEdits(part.xml, edits))]]));
  // The package is written only if it reads back exactly as the model says: that
  // check turns a broken splice into the loud fallback, not into a save.
  try {
    const read = await readDocx(bytes);
    if (read.length !== current.paragraphs.length) return null;
    for (let i = 0; i < read.length; i++) if ((read[i] ?? '') !== (current.paragraphs[i] ?? '')) return null;
    if (formats.size) {
      const written = await readDocxFormats(bytes);
      for (const index of formats.keys()) {
        if (!sameFormat(written[index], current.formats?.[index])) return null;
      }
    }
  } catch { return null; }
  return { bytes, changed: ['word/document.xml'] };
}

/* ──────────────────────────────────── Excel ──────────────────────────────────── */

interface CellEdit {
  row: number;
  col: number;
  after: string;
  /** The canonical formula for `<f>` (without '='), or null for a plain value. */
  formula: string | null;
  /** The formula is the file's own, unchanged: keep its `<f>` element exactly, refresh `<v>`. */
  keepF?: boolean;
}

interface SharedStrings {
  xml: string;
  /** The `<si>` values in order, read the way `readXlsx` reads them. */
  values: string[];
  /** The strings this save had to add, in order. */
  appended: string[];
}

/** One row element with the index the reader gives it (`<row r="3">` → 2). */
interface RowAt { index: number; element: XmlElement }

/** Mirrors `readXlsx`'s row addressing: the `r` attribute, else the document order. */
function rowsOf(xml: string, doc: XmlDoc): RowAt[] {
  const out: RowAt[] = [];
  let count = 0;
  for (const element of elements(doc, 'row')) {
    const raw = attr(xml, element, 'r');
    const value = raw === null ? NaN : Number(raw);
    const at = Number.isInteger(value - 1) && value - 1 >= 0 ? value - 1 : count;
    out.push({ index: at, element });
    count = Math.max(count, at + 1);
  }
  return out;
}

/** The `<si>` values of a shared-strings part, in the reader's own order. */
function readSharedStrings(xml: string): string[] {
  const doc = parsePart(xml);
  const root = doc.roots.find((candidate) => localName(candidate.name) === 'sst');
  if (!root) throw new Error('xlsx: sharedStrings.xml has no <sst>');
  const out: string[] = [];
  for (const child of root.children) {
    if (localName(child.name) !== 'si') continue;
    // Phonetic runs (rPh) are reading aids, not part of the cell text.
    out.push(elementsOf(child, 't')
      .filter((t) => localName(t.parent?.name ?? '') !== 'rPh')
      .map((t) => elementText(xml, t))
      .join(''));
  }
  return out;
}

/** Adds the strings this save needed as new `<si>` entries; existing ones keep their bytes. */
function appendSharedStrings(state: SharedStrings): string {
  const doc = parsePart(state.xml);
  const root = doc.roots.find((candidate) => localName(candidate.name) === 'sst');
  if (!root) throw new Error('xlsx: sharedStrings.xml has no <sst>');
  const entries = state.appended.map((value) => `<si><t xml:space="preserve">${xmlText(value)}</t></si>`).join('');
  const open = state.xml.slice(root.start, root.openEnd);
  const unique = attr(state.xml, root, 'uniqueCount');
  const head = unique === null
    ? open
    : open.replace(/(\suniqueCount\s*=\s*)("[^"]*"|'[^']*')/, `$1"${Number(unique) + state.appended.length}"`);
  if (root.selfClosing) {
    return `${state.xml.slice(0, root.start)}${head.replace(/\/>$/, '>')}${entries}</sst>${state.xml.slice(root.end)}`;
  }
  const closeAt = state.xml.lastIndexOf('<', root.end - 1);
  if (closeAt < root.openEnd) throw new Error('xlsx: sharedStrings.xml cannot be appended to');
  return `${state.xml.slice(0, root.start)}${head}${state.xml.slice(root.openEnd, closeAt)}${entries}${state.xml.slice(closeAt)}`;
}

/** "worksheets/sheet1.xml" or "/xl/worksheets/sheet1.xml" → a name inside the archive. */
function resolveTarget(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/');
  for (const segment of target.split('/')) {
    if (segment === '..') parts.pop();
    else if (segment && segment !== '.') parts.push(segment);
  }
  return parts.join('/');
}

/** The worksheet part of every declared sheet, in workbook order (the reader's order). */
async function sheetPaths(archive: RawZip): Promise<string[] | null> {
  const workbook = await loadPart(archive, 'xl/workbook.xml');
  if (!workbook) return null;
  const doc = parsePart(workbook.xml);
  const rels = new Map<string, string>();
  const relsPart = await loadPart(archive, 'xl/_rels/workbook.xml.rels');
  if (relsPart) {
    const relDoc = parsePart(relsPart.xml);
    for (const relationship of elements(relDoc, 'Relationship')) {
      const id = attr(relsPart.xml, relationship, 'Id');
      const target = attr(relsPart.xml, relationship, 'Target');
      if (id && target) rels.set(id, resolveTarget('xl', target));
    }
  }
  return elements(doc, 'sheet').map((sheet, i) => {
    const relId = attr(workbook.xml, sheet, 'r:id');
    return (relId ? rels.get(relId) : undefined) ?? `xl/worksheets/sheet${i + 1}.xml`;
  });
}

/** Where a cell lives, or where it has to be inserted. `start === end` is a pure insertion. */
interface CellTarget {
  cell: XmlElement | null;
  /** The range the new markup replaces. */
  start: number;
  end: number;
  /** True when the markup has to be a whole `<row>` (there was no row to add the cell to). */
  wrapRow: boolean;
}

/** The `<c>` elements of a row, in the reader's column addressing. */
function cellsOf(xml: string, row: XmlElement): Array<{ col: number; element: XmlElement }> {
  const out: Array<{ col: number; element: XmlElement }> = [];
  let next = 0;
  for (const element of elementsOf(row, 'c')) {
    const ref = attr(xml, element, 'r');
    const col = ref === null ? next : columnIndex(ref);
    next = col + 1;
    out.push({ col, element });
  }
  return out;
}

function locateCell(xml: string, doc: XmlDoc, rows: RowAt[], row: number, col: number): CellTarget {
  const candidates = rows.filter((candidate) => candidate.index === row);
  const found = candidates[candidates.length - 1];
  if (!found) {
    // A gap the reader padded with an empty row. Adding the `<row>` is exact only
    // when every existing row is addressed by its own `r` attribute.
    const last = rows.reduce((max, candidate) => Math.max(max, candidate.index), -1);
    if (row < 0) throw new Error('xlsx: a negative row');
    void last;
    for (const candidate of rows) if (attr(xml, candidate.element, 'r') === null) throw new Error('xlsx: rows are not addressed by r');
    const sheetData = elements(doc, 'sheetData')[0];
    if (!sheetData) throw new Error('xlsx: the sheet has no <sheetData>');
    const after = rows.find((candidate) => candidate.index > row);
    const at = after ? after.element.start : xml.lastIndexOf('<', sheetData.end - 1);
    if (at <= sheetData.start) throw new Error('xlsx: cannot insert a row here');
    return { cell: null, start: at, end: at, wrapRow: true };
  }

  const cells = cellsOf(xml, found.element);
  const existing = cells.find((candidate) => candidate.col === col);
  if (existing) return { cell: existing.element, start: existing.element.start, end: existing.element.end, wrapRow: false };

  const after = cells.find((candidate) => candidate.col > col);
  if (found.element.selfClosing) return { cell: null, start: found.element.start, end: found.element.end, wrapRow: true };
  const at = after ? after.element.start : xml.lastIndexOf('<', found.element.end - 1);
  if (at <= found.element.start) throw new Error('xlsx: cannot insert a cell here');
  return { cell: null, start: at, end: at, wrapRow: false };
}

/** `<c r="A1" s="2" >` with its type attribute dropped or replaced; everything else kept. */
function rebuildCellOpen(openTag: string, type: string | null): string {
  const open = openTag.replace(/\s+t\s*=\s*(?:"[^"]*"|'[^']*')/, '').replace(/\/?>$/, '').trimEnd();
  return type ? `${open} t="${type}">` : `${open}>`;
}

/** The edit that gives one cell exactly this value (null when there is nothing to change). */
function cellEditFor(xml: string, target: CellTarget, cell: CellEdit, shared: SharedStrings | null): XmlEdit | null {
  const element = target.cell;
  if (element) {
    for (const child of element.children) {
      const local = localName(child.name);
      // `<v>` is the value, `<is>` an inline string, `<f>` a formula: all three are
      // modelled. Anything else (an array formula, an extension) is not guessed at.
      if (local !== 'v' && local !== 'is' && local !== 'f') {
        throw new Error(`xlsx: ${cellName(cell.row, cell.col)} holds <${local}>`);
      }
    }
  }
  if (cell.after === '' && cell.formula === null && !cell.keepF) {
    if (!element) return null;
    return { start: element.start, end: element.end, xml: '' };
  }

  let inner: string;
  let type: string | null;
  const ownF = cell.keepF && element ? element.children.find((c) => localName(c.name) === 'f') : undefined;
  if (ownF) {
    inner = `${xml.slice(ownF.start, ownF.end)}<v>${xmlText(cell.after)}</v>`;
    type = cell.after.startsWith('#') ? 'e' : isNumericText(cell.after) || cell.after === '' ? null : 'str';
  } else if (cell.formula !== null) {
    // The formula and its computed result: Excel sees the formula, opens the sheet
    // without recalculating, and the value is what this app shows.
    inner = `<f>${xmlText(cell.formula)}</f><v>${xmlText(cell.after)}</v>`;
    type = cell.after.startsWith('#') ? 'e' : null;
  } else if (isNumericText(cell.after)) {
    inner = `<v>${xmlText(cell.after.trim())}</v>`;
    type = null;
  } else {
    const existing = shared ? shared.values.indexOf(cell.after) : -1;
    const useShared = !!shared && element !== null && attr(xml, element, 't') === 's';
    if (useShared && existing >= 0) {
      inner = `<v>${existing}</v>`;
      type = 's';
    } else if (useShared && shared) {
      inner = `<v>${shared.values.length}</v>`;
      shared.values.push(cell.after);
      shared.appended.push(cell.after);
      type = 's';
    } else {
      inner = `<is><t xml:space="preserve">${xmlText(cell.after)}</t></is>`;
      type = 'inlineStr';
    }
  }

  if (element) {
    const open = rebuildCellOpen(xml.slice(element.start, element.openEnd), type);
    return { start: element.start, end: element.end, xml: `${open}${inner}</c>` };
  }
  const ref = cellName(cell.row, cell.col);
  const markup = `<c r="${ref}"${type ? ` t="${type}"` : ''}>${inner}</c>`;
  const replacement = target.wrapRow ? `<row r="${cell.row + 1}">${markup}</row>` : markup;
  return { start: target.start, end: target.end, xml: replacement };
}

async function patchXlsx(archive: RawZip, onDisk: SheetsModel, current: SheetsModel): Promise<PatchResult | null> {
  if (onDisk.grids.length !== current.grids.length) return null; // a sheet added or removed
  // Rows or columns inserted or removed: the file's own cells are moved first
  // (`grid/structure.ts`), and the rest of the save diffs against the moved baseline.
  let baseline = onDisk;
  const moved = new Map<string, string>();
  if (current.moved) {
    const ops = current.structure ?? [];
    if (onDisk.moved || ops.length !== current.moved) return null;
    const result = await moveStructure(archive, onDisk, ops);
    if (!result) return null;
    baseline = result.model;
    for (const [path, xml] of result.parts) moved.set(path, xml);
  }
  const edits = new Map<number, CellEdit[]>();
  for (let s = 0; s < baseline.grids.length; s++) {
    const before = baseline.grids[s];
    const after = current.grids[s];
    if (!before || !after) return null;
    // Rows or columns inserted or removed are the rebuild path's (counted by `moved`
    // above); a sheet that only grew past its end — typing below the data — is
    // patched, and the read-back below proves nothing shifted.
    if (after.rows.length < before.rows.length || gridWidth(after) < gridWidth(before)) return null;
    const cells: CellEdit[] = [];
    for (let r = 0; r < after.rows.length; r++) {
      const row = after.rows[r] ?? [];
      for (let c = 0; c < row.length; c++) {
        const beforeValue = before.rows[r]?.[c] ?? '';
        const afterValue = row[c] ?? '';
        const beforeFormula = formulaAt(baseline, s, r, c) ?? null;
        const afterFormula = formulaAt(current, s, r, c) ?? null;
        // A cell needs rewriting when its value or its formula changed: a new formula
        // that happens to compute the same value still has to reach the file's `<f>`.
        if (beforeValue === afterValue && beforeFormula === afterFormula) continue;
        const parsed = afterFormula ? parseFormula(afterFormula) : null;
        const formula = parsed && parsed.ok ? formatFormula(parsed.ast, { xlfn: true }) : null;
        const keepF = !!afterFormula && beforeFormula === afterFormula;
        if (afterFormula && formula === null && !keepF) return null;
        cells.push({ row: r, col: c, after: afterValue, formula, keepF });
      }
    }
    if (cells.length) edits.set(s, cells);
  }
  const grew = current.grids.some((g, i) => g.rows.length !== baseline.grids[i]?.rows.length || gridWidth(g) !== gridWidth(baseline.grids[i] as Grid));
  const looks = lookChanges(baseline, current);
  // Empty rows or columns past the end have nothing a patch could write: the rebuild owns them.
  if (!edits.size && !looks.size && !moved.size) return grew ? null : { bytes: archive.bytes, changed: [] };

  const paths = await sheetPaths(archive);
  if (!paths) return null;
  const sharedPart = await loadPart(archive, 'xl/sharedStrings.xml');
  const shared: SharedStrings | null = sharedPart
    ? { xml: sharedPart.xml, values: readSharedStrings(sharedPart.xml), appended: [] }
    : null;

  const replacements = new Map<string, Uint8Array>();
  for (const [path, xml] of moved) replacements.set(path, utf8(xml));
  for (const [sheet, cells] of edits) {
    const path = paths[sheet];
    if (!path) return null;
    const part = moved.has(path) ? { xml: moved.get(path) as string } : await loadPart(archive, path);
    if (!part) return null;
    const doc = parsePart(part.xml);
    const rows = rowsOf(part.xml, doc);
    const xmlEdits: XmlEdit[] = [];
    for (const cell of cells) {
      const edit = cellEditFor(part.xml, locateCell(part.xml, doc, rows, cell.row, cell.col), cell, shared);
      if (edit) xmlEdits.push(edit);
    }
    if (xmlEdits.length) replacements.set(path, utf8(applyEdits(part.xml, xmlEdits)));
  }
  if (shared && shared.appended.length) replacements.set('xl/sharedStrings.xml', utf8(appendSharedStrings(shared)));

  const additions = new Map<string, Uint8Array>();
  if (looks.size && !(await writeLooks(archive, paths, looks, replacements, additions))) return null;

  const bytes = await rebuildZip(archive, replacements, additions);
  try {
    const sheets = await readXlsx(bytes);
    if (sheets.length !== current.grids.length) return null;
    for (let s = 0; s < sheets.length; s++) {
      const grid: Grid | undefined = current.grids[s];
      const read = sheets[s];
      if (!grid || !read) return null;
      // A styled empty cell or a row given only a height reads back as empty cells
      // past the data: those are fine, a value that differs anywhere is not.
      const exact = !looks.has(s);
      if (exact && read.rows.length !== grid.rows.length) return null;
      if (exact && gridWidth({ ...grid, rows: read.rows }) !== gridWidth(grid)) return null;
      const height = Math.max(grid.rows.length, read.rows.length);
      for (let r = 0; r < height; r++) {
        const width = Math.max(grid.rows[r]?.length ?? 0, read.rows[r]?.length ?? 0);
        for (let c = 0; c < width; c++) {
          if ((grid.rows[r]?.[c] ?? '') !== (read.rows[r]?.[c] ?? '')) return null;
        }
      }
    }
  } catch { return null; }
  return { bytes, changed: [...replacements.keys(), ...additions.keys()] };
}

/**
 * The file's parts and the on-disk model after the owner's row/column insertions
 * and deletions, in order. Null when a part holds something that cannot be moved
 * exactly (the rebuild then takes over, after its warning).
 */
async function moveStructure(archive: RawZip, onDisk: SheetsModel, ops: readonly StructOp[]): Promise<{ model: SheetsModel; parts: Map<string, string> } | null> {
  const paths = await sheetPaths(archive);
  const workbook = await loadPart(archive, 'xl/workbook.xml');
  if (!paths || !workbook || workbookBlocks(workbook.xml)) return null;
  const parts = new Map<string, string>();
  const textOf = async (path: string): Promise<string | null> => parts.get(path) ?? (await loadPart(archive, path))?.xml ?? null;
  let model = onDisk;
  for (const op of ops) {
    const names = model.grids.map((g) => g.name);
    const target = names[op.sheet];
    if (target === undefined) return null;
    for (let i = 0; i < paths.length; i++) {
      const xml = await textOf(paths[i]);
      if (xml === null) return null;
      const next = i === op.sheet ? shiftSheetPart(xml, target, op) : shiftFormulasIn(xml, names[i] ?? target, target, op);
      if (next === null) return null;
      if (next !== xml) parts.set(paths[i], next);
    }
    if (op.axis === 'row') model = op.delta > 0 ? insertRow(model, op.sheet, op.at) : removeRow(model, op.sheet, op.at);
    else model = op.delta > 0 ? insertColumn(model, op.sheet, op.at) : removeColumn(model, op.sheet, op.at);
  }
  return { model, parts };
}

/** What changed in one sheet's formatting between the file and the model. */
interface LookChange {
  cells: Map<string, CellFormat>;
  rows: Map<number, number | null>;
  cols: Map<number, number | null>;
}

/**
 * The formatting the save has to write, per sheet. A format property the file
 * had from an earlier save in this session but the model no longer names (an undo
 * after the save) is written back as "off", the one state it can be set to.
 */
function lookChanges(baseline: SheetsModel, current: SheetsModel): Map<number, LookChange> {
  const out = new Map<number, LookChange>();
  const sheets = new Set([...Object.keys(baseline.sheetFormats ?? {}), ...Object.keys(current.sheetFormats ?? {})].map(Number));
  for (const s of sheets) {
    const before = baseline.sheetFormats?.[s];
    const after = current.sheetFormats?.[s];
    const change: LookChange = { cells: new Map(), rows: new Map(), cols: new Map() };
    const keys = new Set([...Object.keys(before?.cells ?? {}), ...Object.keys(after?.cells ?? {})]);
    for (const key of keys) {
      const b = before?.cells?.[key];
      const a = after?.cells?.[key];
      if (sameCellFormat(a, b)) continue;
      change.cells.set(key, { ...resetFor(b, a), ...(a ?? {}) });
    }
    for (const [axis, target] of [['rows', change.rows], ['cols', change.cols]] as const) {
      const b = before?.[axis] ?? {};
      const a = after?.[axis] ?? {};
      for (const k of new Set([...Object.keys(b), ...Object.keys(a)].map(Number))) {
        if (b[k] === a[k]) continue;
        target.set(k, a[k] ?? null);
      }
    }
    if (change.cells.size || change.rows.size || change.cols.size) out.set(s, change);
  }
  return out;
}

/** "Off" for every property `before` named that `after` does not. */
function resetFor(before: CellFormat | undefined, after: CellFormat | undefined): CellFormat {
  const out: CellFormat = {};
  if (!before) return out;
  if (before.bold !== undefined && after?.bold === undefined) out.bold = false;
  if (before.italic !== undefined && after?.italic === undefined) out.italic = false;
  if (before.underline !== undefined && after?.underline === undefined) out.underline = false;
  if (before.color !== undefined && after?.color === undefined) out.color = null;
  if (before.fill !== undefined && after?.fill === undefined) out.fill = null;
  if (before.hAlign !== undefined && after?.hAlign === undefined) out.hAlign = null;
  if (before.vAlign !== undefined && after?.vAlign === undefined) out.vAlign = null;
  if (before.wrap !== undefined && after?.wrap === undefined) out.wrap = false;
  if (before.numFmt !== undefined && after?.numFmt === undefined) out.numFmt = null;
  if (before.borders) {
    const sides: NonNullable<CellFormat['borders']> = {};
    for (const side of ['top', 'bottom', 'left', 'right'] as const) {
      if (before.borders[side] !== undefined && after?.borders?.[side] === undefined) sides[side] = false;
    }
    if (Object.keys(sides).length) out.borders = sides;
  }
  return out;
}

/** Writes cell styles, row heights and column widths; adds `styles.xml` when the package has none. */
async function writeLooks(
  archive: RawZip, paths: string[], looks: Map<number, LookChange>,
  replacements: Map<string, Uint8Array>, additions: Map<string, Uint8Array>,
): Promise<boolean> {
  const decode = (b: Uint8Array): string => new TextDecoder().decode(b);
  const stylesPath = await stylesPartPath(archive);
  const stylesPart = await loadPart(archive, stylesPath);
  let stylesXml: string | null = stylesPart?.xml ?? null;
  for (const [sheet, change] of looks) {
    const path = paths[sheet];
    if (!path) return false;
    const pending = replacements.get(path);
    const xml = pending ? decode(pending) : (await loadPart(archive, path))?.xml;
    if (!xml) return false;
    const cells = new Map<string, number>();
    if (change.cells.size) {
      const own = cellStyleIds(xml);
      const keys = [...change.cells.keys()];
      const added = addCellStyles(stylesXml, keys.map((key) => ({ base: own.get(key) ?? 0, format: change.cells.get(key) as CellFormat })));
      stylesXml = added.xml;
      keys.forEach((key, i) => cells.set(key, added.ids[i]));
    }
    replacements.set(path, utf8(applySheetLook(xml, { cells, rows: change.rows, cols: change.cols })));
  }
  if (stylesXml !== null && stylesXml !== (stylesPart?.xml ?? null)) {
    (stylesPart ? replacements : additions).set(stylesPath, utf8(stylesXml));
    if (!stylesPart) {
      // A package written without styles (an older new-sheet): register the part.
      const types = await loadPart(archive, '[Content_Types].xml');
      if (!types) return false;
      replacements.set('[Content_Types].xml', utf8(ensureOverride(types.xml, `/${stylesPath}`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml')));
      const rels = await loadPart(archive, 'xl/_rels/workbook.xml.rels');
      (rels ? replacements : additions).set('xl/_rels/workbook.xml.rels', utf8(addRelationship(rels?.xml ?? null, 'styles', 'styles.xml').xml));
    }
  }
  return true;
}

/** Where the workbook keeps its styles (its relationship), else the usual place. */
async function stylesPartPath(archive: RawZip): Promise<string> {
  const rels = await loadPart(archive, 'xl/_rels/workbook.xml.rels');
  if (rels) {
    const doc = parsePart(rels.xml);
    for (const r of elements(doc, 'Relationship')) {
      if ((attr(rels.xml, r, 'Type') ?? '').endsWith('/styles')) {
        const target = attr(rels.xml, r, 'Target');
        if (target) return resolveTarget('xl', target);
      }
    }
  }
  return 'xl/styles.xml';
}

/* ───────────────────────────────── PowerPoint ───────────────────────────────── */

async function patchPptx(archive: RawZip, baseline: DeckModel, current: DeckModel): Promise<PatchResult | null> {
  if (baseline.slides.length !== current.slides.length) return null; // a slide added or removed
  const slideNo = (name: string): number => Number(/slide(\d+)\.xml$/.exec(name)?.[1] ?? 0);
  const names = archive.entries.map((entry) => entry.name)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => slideNo(a) - slideNo(b));
  if (names.length !== baseline.slides.length) return null;

  const edits = new Map<number, Map<number, string>>();
  for (let s = 0; s < baseline.slides.length; s++) {
    const before = baseline.slides[s] ?? [];
    const after = current.slides[s] ?? [];
    if (before.length !== after.length) return null;
    const changed = new Map<number, string>();
    for (let i = 0; i < after.length; i++) if ((before[i] ?? '') !== (after[i] ?? '')) changed.set(i, after[i] ?? '');
    if (changed.size) edits.set(s, changed);
  }
  if (!edits.size) return { bytes: archive.bytes, changed: [] };

  const replacements = new Map<string, Uint8Array>();
  for (const [slide, changed] of edits) {
    const name = names[slide];
    if (!name) return null;
    const part = await loadPart(archive, name);
    if (!part) return null;
    const doc = parsePart(part.xml);
    // `readPptx` drops paragraphs whose text is blank, so the model's index i is
    // the i-th non-blank paragraph on the slide — the same list, chosen here.
    const visible = paragraphElements(doc).filter((paragraph) => paragraphText(part.xml, paragraph).trim() !== '');
    const xmlEdits: XmlEdit[] = [];
    for (const [index, text] of changed) {
      const paragraph = visible[index];
      if (!paragraph) return null;
      const next = paragraphEdits(part.xml, paragraph, text, null, 'a');
      if (!next) return null;
      xmlEdits.push(...next);
    }
    if (xmlEdits.length) replacements.set(name, utf8(applyEdits(part.xml, xmlEdits)));
  }

  const bytes = await rebuildZip(archive, replacements);
  try {
    const slides = await readPptx(bytes);
    if (slides.length !== baseline.slides.length) return null;
    for (let s = 0; s < slides.length; s++) {
      const seen = slides[s] ?? [];
      const before = baseline.slides[s] ?? [];
      for (let i = 0; i < before.length; i++) {
        const wanted = edits.get(s)?.get(i) ?? before[i] ?? '';
        if (!seen.includes(wanted)) return null;
      }
    }
  } catch { return null; }
  return { bytes, changed: [...replacements.keys()] };
}
