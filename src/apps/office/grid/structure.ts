/**
 * Sheet — rows and columns inserted or deleted, written into the file itself
 * (إدراج/حذف الصفوف والأعمدة دون إعادة بناء الملف).
 *
 * The old save rebuilt the whole package as soon as a row moved, dropping every
 * style. This moves the cells of the worksheet part instead: row and cell
 * addresses, `<cols>`, merged cells, and every formula in the workbook through
 * the engine's `shiftFormula` (a reference to a deleted cell becomes #REF!, as in
 * Excel). What this cannot move exactly — shared or array formulas, conditional
 * formats, validations, tables, drawings, defined names — makes it return null,
 * and the save falls back to the rebuild after warning the owner, as before.
 *
 * Pure string → string.
 */
import { columnIndex } from '../../viewer/formats';
import { formatFormula, parseFormula, shiftFormula } from '../formula/index';
import { cellName, xmlText } from '../xml';
import { applyEdits, attr, elements, elementText, localName, parsePart, type XmlEdit, type XmlElement } from '../xmlscan';
import { decodeXml } from '../writer/docxread';
import { setAttrs } from './xlsxstyle';

export interface StructOp { sheet: number; axis: 'row' | 'col'; at: number; delta: 1 | -1 }

/** Worksheet children whose references this module does not move: their presence means "rebuild". */
const UNSAFE = new Set(['conditionalFormatting', 'dataValidations', 'hyperlinks', 'autoFilter', 'tableParts', 'drawing', 'legacyDrawing', 'rowBreaks', 'colBreaks', 'sortState', 'protectedRanges', 'scenarios', 'dataConsolidate', 'customSheetViews', 'phoneticPr', 'oleObjects', 'controls', 'picture', 'extLst']);

/** The formula text of an `<f>` after a structure change, written as the file wants it. */
function shiftF(body: string, formulaSheet: string, targetSheet: string, op: StructOp): string {
  const shifted = shiftFormula(`=${body}`, formulaSheet, { sheet: targetSheet, axis: op.axis, at: op.at, count: op.delta });
  const parsed = parseFormula(shifted);
  if (!parsed.ok) return body;
  const out = formatFormula(parsed.ast, { xlfn: true });
  // Unchanged references keep the file's own spelling.
  const same = parseFormula(`=${body}`);
  if (same.ok && formatFormula(same.ast, { xlfn: true }) === out) return body;
  return out;
}

/** Every `<f>` of a part with its text shifted; null when a formula is shared or an array. */
export function shiftFormulasIn(xml: string, formulaSheet: string, targetSheet: string, op: StructOp): string | null {
  const doc = parsePart(xml);
  const edits: XmlEdit[] = [];
  for (const f of elements(doc, 'f')) {
    const kind = attr(xml, f, 't');
    if (kind === 'shared' || kind === 'array' || kind === 'dataTable') return null;
    if (f.selfClosing) continue;
    const body = decodeXml(elementText(xml, f));
    const next = shiftF(body, formulaSheet, targetSheet, op);
    if (next !== body) edits.push({ start: f.openEnd, end: xml.lastIndexOf('<', f.end - 1), xml: xmlText(next) });
  }
  return applyEdits(xml, edits);
}

function moveLine(line: number, op: StructOp): number | null {
  if (op.delta < 0 && line === op.at) return null;
  return line >= op.at ? line + op.delta : line;
}

/** "B3:D7" moved by the change; null when the change would cut it (a merge over a deleted line). */
function moveRange(ref: string, op: StructOp): string | null {
  const [a, b = a] = ref.split(':');
  const pos = (cell: string): [number, number] => [Number(/\d+/.exec(cell)?.[0]) - 1, columnIndex(cell)];
  let [r0, c0] = pos(a);
  let [r1, c1] = pos(b);
  const lo = op.axis === 'row' ? r0 : c0;
  const hi = op.axis === 'row' ? r1 : c1;
  if (op.delta < 0 && op.at >= lo && op.at <= hi) return null;
  const nlo = lo >= op.at ? lo + op.delta : lo;
  const nhi = hi >= op.at ? hi + op.delta : hi;
  if (op.axis === 'row') { r0 = nlo; r1 = nhi; } else { c0 = nlo; c1 = nhi; }
  const one = cellName(r0, c0);
  return a === b ? one : `${one}:${cellName(r1, c1)}`;
}

/**
 * The target sheet's part after the change. Returns null when the part holds
 * something whose references would go stale.
 */
export function shiftSheetPart(xml: string, sheetName: string, op: StructOp): string | null {
  const doc = parsePart(xml);
  const root = doc.roots.find((r) => localName(r.name) === 'worksheet');
  if (!root) return null;
  if (root.children.some((c) => UNSAFE.has(localName(c.name)))) return null;
  const edits: XmlEdit[] = [];
  const formulaEdits = (el: XmlElement): boolean => {
    for (const f of el.children.filter((x) => localName(x.name) === 'f')) {
      const kind = attr(xml, f, 't');
      if (kind === 'shared' || kind === 'array' || kind === 'dataTable') return false;
    }
    return true;
  };

  const sheetData = elements(doc, 'sheetData')[0];
  for (const row of sheetData?.children ?? []) {
    if (localName(row.name) !== 'row') continue;
    const rAttr = Number(attr(xml, row, 'r'));
    if (!(Number.isInteger(rAttr) && rAttr > 0)) return null; // rows must be addressed to move them
    const r = rAttr - 1;
    const newRow = op.axis === 'row' ? moveLine(r, op) : r;
    if (newRow === null) { edits.push({ start: row.start, end: row.end, xml: '' }); continue; }
    const open = xml.slice(row.start, row.openEnd);
    const nextOpen = setAttrs(open, { r: String(newRow + 1), spans: null });
    if (nextOpen !== open) edits.push({ start: row.start, end: row.openEnd, xml: nextOpen });
    for (const c of row.children) {
      if (localName(c.name) !== 'c') continue;
      const ref = attr(xml, c, 'r');
      if (ref === null) return null;
      if (!formulaEdits(c)) return null;
      const col = columnIndex(ref);
      const newCol = op.axis === 'col' ? moveLine(col, op) : col;
      if (newCol === null) { edits.push({ start: c.start, end: c.end, xml: '' }); continue; }
      const cOpen = xml.slice(c.start, c.openEnd);
      const nextC = setAttrs(cOpen, { r: cellName(newRow, newCol) });
      // The cell's formula: shifted in place (inside the element, disjoint from the tag edit).
      const f = c.children.find((x) => localName(x.name) === 'f');
      if (nextC !== cOpen) edits.push({ start: c.start, end: c.openEnd, xml: nextC });
      if (f && !f.selfClosing) {
        const body = decodeXml(elementText(xml, f));
        const shifted = shiftF(body, sheetName, sheetName, op);
        if (shifted !== body) edits.push({ start: f.openEnd, end: xml.lastIndexOf('<', f.end - 1), xml: xmlText(shifted) });
      }
    }
  }

  for (const child of root.children) {
    const name = localName(child.name);
    if (name === 'dimension') edits.push({ start: child.start, end: child.end, xml: '' });
    if (name === 'mergeCells') {
      for (const m of child.children) {
        const ref = attr(xml, m, 'ref');
        if (!ref) continue;
        const moved = moveRange(ref, op);
        if (moved === null) return null;
        if (moved !== ref) edits.push({ start: m.start, end: m.end, xml: setAttrs(xml.slice(m.start, m.end), { ref: moved }) });
      }
    }
    if (name === 'cols' && op.axis === 'col') {
      const n = op.at + 1;
      for (const col of child.children) {
        const min = Number(attr(xml, col, 'min'));
        const max = Number(attr(xml, col, 'max'));
        if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
        let a = min;
        let b = max;
        if (op.delta > 0) { if (a >= n) { a++; b++; } else if (b >= n) b++; }
        else if (b < n) { /* before the deleted column */ }
        else if (a > n) { a--; b--; }
        else b--;
        if (b < a) { edits.push({ start: col.start, end: col.end, xml: '' }); continue; }
        if (a !== min || b !== max) edits.push({ start: col.start, end: col.end, xml: setAttrs(xml.slice(col.start, col.end), { min: String(a), max: String(b) }) });
      }
    }
  }
  // The frozen pane's top-left cell and the selection are view state: reset them to A1 rather than guess.
  for (const sel of elements(doc, 'selection')) {
    edits.push({ start: sel.start, end: sel.end, xml: setAttrs(xml.slice(sel.start, sel.end), { activeCell: null, sqref: null }) });
  }
  return applyEdits(xml, edits);
}

/** Workbook-level blockers: defined names hold references this does not move. */
export function workbookBlocks(workbookXml: string): boolean {
  return elements(parsePart(workbookXml), 'definedName').length > 0;
}
