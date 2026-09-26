/**
 * Sheet — the look of an .xlsx as Excel shows it (مظهر الجدول): column widths,
 * row heights, merged cells, frozen panes, and each cell's font, fill, borders and
 * alignment from `styles.xml`. It also reads the formulas stored in the file
 * (`<f>`, shared formulas expanded), so a sheet whose cached values are empty still
 * shows its totals. Pure: bytes in, data out.
 */
import { columnIndex } from '../../viewer/formats';
import { entryData, readRawZip } from '../zip';
import { attrLocal as rawAttr, elementText, elementsOf, localName, parsePart, type XmlElement } from '../xmlscan';
import { decodeXml, readRels } from '../writer/docxread';
import { columnName } from '../xml';
import { parseAutoFilter } from './autofilter';
import { ourOperator, parseConditionalFormatting, parseDxfs, type ParsedCfRule } from './condfmt-xml';
import { parseAnchors, parseChartSpace } from './chart-xml';
import type { CellStyle as CondStyle, CondRule } from '../calc/index';
import type { ChartObject } from './sheetview';

/** A part target (`../drawings/drawing1.xml`) resolved against the part that names it. */
function resolveTarget(base: string, target: string): string {
  const parts = base.split('/').slice(0, -1);
  for (const piece of target.split('/')) {
    if (piece === '..') parts.pop();
    else if (piece !== '.' && piece !== '') parts.push(piece);
  }
  return parts.join('/');
}

/** The rectangle a chart's two references cover: `S!$A$2:$A$4` and `S!$B$2:$B$4` -> rows 1..3. */
function rangeFromRefs(categoryRef: string | undefined, valueRef: string | undefined): { r0: number; c0: number; r1: number; c1: number } {
  const cells = [categoryRef, valueRef].flatMap((ref) =>
    [...((ref ?? '').split('!').pop() ?? '').matchAll(/\$?([A-Z]{1,3})\$?(\d+)/g)].map((m) => ({ row: Number(m[2]) - 1, col: columnIndex(m[1]) })));
  if (!cells.length) return { r0: 0, c0: 0, r1: 0, c1: 0 };
  return {
    r0: Math.min(...cells.map((c) => c.row)),
    r1: Math.max(...cells.map((c) => c.row)),
    c0: Math.min(...cells.map((c) => c.col)),
    c1: Math.max(...cells.map((c) => c.col)),
  };
}

/**
 * One `<cfRule>` as this app's own rule, or null when the file's rule is one we cannot show the way
 * it meant it (a type we do not implement). The style comes from the `<dxf>` it points at.
 */
function condRuleFrom(rule: ParsedCfRule, style: Partial<CellStyle> | undefined): CondRule | null {
  const paint: CondStyle = { ...(style ?? {}) } as CondStyle;
  switch (rule.type) {
    case 'cellIs': {
      const op = rule.operator ? ourOperator(rule.operator) : null;
      if (!op) return null;
      const first = rule.formulas[0] ?? '';
      const value = /^-?\d+(\.\d+)?$/.test(first) ? Number(first) : first;
      const second = rule.formulas[1];
      return { type: 'cellIs', op: op as 'gt' | 'lt' | 'gte' | 'lte' | 'eq' | 'neq' | 'between' | 'notBetween', value, ...(second !== undefined ? { value2: Number(second) } : {}), style: paint } as CondRule;
    }
    case 'containsText':
    case 'notContainsText':
    case 'beginsWith':
    case 'endsWith': {
      const op = rule.type === 'containsText' ? 'contains' : rule.type === 'notContainsText' ? 'notContains' : rule.type === 'beginsWith' ? 'begins' : 'ends';
      return { type: 'text', op, text: rule.text ?? '', style: paint } as CondRule;
    }
    case 'containsBlanks': return { type: 'blank', style: paint } as CondRule;
    case 'notContainsBlanks': return { type: 'notBlank', style: paint } as CondRule;
    case 'containsErrors': return { type: 'error', style: paint } as CondRule;
    case 'duplicateValues': return { type: 'duplicate', style: paint } as CondRule;
    case 'uniqueValues': return { type: 'unique', style: paint } as CondRule;
    case 'top10': return { type: 'top', count: rule.rank ?? 10, ...(rule.bottom ? { bottom: true } : {}), ...(rule.percent ? { percent: true } : {}), style: paint } as CondRule;
    case 'aboveAverage': return { type: 'average', ...(rule.aboveAverage === false ? { below: true } : {}), style: paint } as CondRule;
    case 'colorScale': {
      const stops = rule.stops ?? [];
      if (stops.length < 2) return null;
      const colours = rule.colors ?? [];
      const withColour = stops.map((stop, i) => ({ ...stop, color: colours[i] ?? (i === 0 ? 'F8696B' : '63BE7B') }));
      return { type: 'colorScale', min: withColour[0], ...(withColour.length > 2 ? { mid: withColour[1] } : {}), max: withColour[withColour.length - 1] } as CondRule;
    }
    case 'dataBar': return { type: 'dataBar', color: rule.colors?.[0] ?? '638EC6' } as CondRule;
    default: return null;
  }
}

const attr = (xml: string, el: XmlElement | undefined, name: string): string | null => (el ? rawAttr(xml, el, name) : null);
const child = (el: XmlElement | undefined, name: string): XmlElement | undefined => el?.children.find((c) => localName(c.name) === name);

export interface CellStyle {
  bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean;
  size?: number; font?: string; color?: string; fill?: string;
  hAlign?: string; vAlign?: string; wrap?: boolean;
  borders?: { top?: string; bottom?: string; left?: string; right?: string };
  numFmt?: string;
}

export interface SheetLook {
  /** Column widths in px (index → width). */
  widths: Map<number, number>;
  heights: Map<number, number>;
  merges: Array<{ r0: number; c0: number; r1: number; c1: number }>;
  frozenRows: number;
  frozenCols: number;
  /** "row:col" → style index. */
  xf: Map<string, number>;
  defaultWidth: number;
  defaultHeight: number;
  /** "row:col" → formula text with "=" (as stored in the file). */
  formulas: Map<string, string>;
  /** `<sheetView rightToLeft>` when the file states it (column A on the right). */
  rtl?: boolean;
  /** The file's own AutoFilter, per column index: the checklist values it keeps visible. */
  filters?: Map<number, string[]>;
  /** The file's own conditional-formatting rules, in file order (the ones this app can read). */
  condRules?: CondRule[];
  /** The file's own floating charts, with the place and data the drawing and chart parts state. */
  charts?: ChartObject[];
}

export interface BookLook { styles: CellStyle[]; sheets: SheetLook[] }

const INDEXED = ['000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF', '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF', '800000', '008000', '000080', '808000', '800080', '008080', 'C0C0C0', '808080'];
const BUILTIN_FMT: Record<number, string> = {
  1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 9: '0%', 10: '0.00%', 11: '0.00E+00', 14: 'm/d/yyyy', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy',
  18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss', 22: 'm/d/yyyy h:mm', 37: '#,##0 ;(#,##0)', 38: '#,##0 ;[Red](#,##0)',
  39: '#,##0.00;(#,##0.00)', 40: '#,##0.00;[Red](#,##0.00)', 49: '@',
};

function colorOf(xml: string, el: XmlElement | undefined, theme: string[]): string | undefined {
  if (!el) return undefined;
  const rgb = attr(xml, el, 'rgb');
  if (rgb && /^[0-9a-fA-F]{8}$/.test(rgb)) return rgb.slice(2).toUpperCase();
  if (rgb && /^[0-9a-fA-F]{6}$/.test(rgb)) return rgb.toUpperCase();
  const indexed = attr(xml, el, 'indexed');
  if (indexed !== null) return INDEXED[Number(indexed)];
  const th = attr(xml, el, 'theme');
  if (th !== null) return theme[Number(th)];
  return undefined;
}

function border(xml: string, el: XmlElement | undefined, theme: string[]): string | undefined {
  const style = attr(xml, el, 'style');
  if (!el || !style || style === 'none') return undefined;
  const width = /medium/.test(style) ? 2 : style === 'thick' ? 3 : 1;
  const line = /dash/i.test(style) ? 'dashed' : style === 'dotted' || style === 'hair' ? 'dotted' : style === 'double' ? 'double' : 'solid';
  return `${style === 'double' ? 3 : width}px ${line} #${colorOf(xml, child(el, 'color'), theme) ?? '000000'}`;
}

/** Excel column width (characters) → CSS px, the way Excel converts it at 100%. */
export function widthPx(chars: number): number {
  return Math.round(chars * 7 + 5);
}

/** Moves the relative references of a shared formula by (dr, dc). */
export function shiftFormula(formula: string, dr: number, dc: number): string {
  return formula.replace(/(\$?)([A-Z]{1,3})(\$?)(\d+)(?![\w(])/g, (whole, ac: string, col: string, ar: string, row: string) => {
    const c = ac ? col : columnName(columnIndex(`${col}1`) + dc);
    const r = ar ? row : String(Number(row) + dr);
    return `${ac}${c}${ar}${r}`;
  });
}

export async function readBookLook(bytes: Uint8Array): Promise<BookLook> {
  const archive = readRawZip(bytes);
  const text = async (name: string): Promise<string | null> => {
    const data = await entryData(archive, name);
    return data ? new TextDecoder().decode(data) : null;
  };
  const rels = await readRels(archive, 'xl/workbook.xml');
  const themeXml = await text([...rels.values()].find((r) => r.type === 'theme')?.target ?? 'xl/theme/theme1.xml');
  const theme: string[] = [];
  if (themeXml) {
    const tdoc = parsePart(themeXml);
    const scheme = tdoc.roots.flatMap((r) => elementsOf(r, 'clrScheme'))[0];
    const order = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];
    for (const name of order) {
      const slot = scheme?.children.find((c) => localName(c.name) === name)?.children[0];
      theme.push((attr(themeXml, slot, 'lastClr') ?? attr(themeXml, slot, 'val') ?? '000000').toUpperCase());
    }
  }

  const styles: CellStyle[] = [];
  const stylesXml = await text([...rels.values()].find((r) => r.type === 'styles')?.target ?? 'xl/styles.xml');
  if (stylesXml) {
    const sdoc = parsePart(stylesXml);
    const root = sdoc.roots.find((r) => localName(r.name) === 'styleSheet');
    const list = (name: string): XmlElement[] => child(root, name)?.children ?? [];
    const numFmts = new Map<number, string>();
    for (const nf of list('numFmts')) numFmts.set(Number(attr(stylesXml, nf, 'numFmtId')), decodeXml(attr(stylesXml, nf, 'formatCode') ?? ''));
    const fonts = list('fonts').map((f) => ({
      bold: !!child(f, 'b') && attr(stylesXml, child(f, 'b'), 'val') !== '0',
      italic: !!child(f, 'i') && attr(stylesXml, child(f, 'i'), 'val') !== '0',
      underline: !!child(f, 'u'),
      strike: !!child(f, 'strike'),
      size: Number(attr(stylesXml, child(f, 'sz'), 'val') ?? 11) || 11,
      font: attr(stylesXml, child(f, 'name'), 'val') ?? undefined,
      color: colorOf(stylesXml, child(f, 'color'), theme),
    }));
    const fills = list('fills').map((f) => {
      const pattern = child(f, 'patternFill');
      const type = attr(stylesXml, pattern, 'patternType');
      return type === 'solid' ? colorOf(stylesXml, child(pattern, 'fgColor'), theme) : undefined;
    });
    const borders = list('borders').map((b) => ({
      top: border(stylesXml, child(b, 'top'), theme), bottom: border(stylesXml, child(b, 'bottom'), theme),
      left: border(stylesXml, child(b, 'left') ?? child(b, 'start'), theme), right: border(stylesXml, child(b, 'right') ?? child(b, 'end'), theme),
    }));
    for (const xf of list('cellXfs')) {
      const font = fonts[Number(attr(stylesXml, xf, 'fontId') ?? 0)] ?? fonts[0];
      const fill = fills[Number(attr(stylesXml, xf, 'fillId') ?? 0)];
      const b = borders[Number(attr(stylesXml, xf, 'borderId') ?? 0)];
      const al = child(xf, 'alignment');
      const numId = Number(attr(stylesXml, xf, 'numFmtId') ?? 0);
      styles.push({
        ...(font ?? {}),
        ...(fill ? { fill } : {}),
        ...(b && (b.top || b.bottom || b.left || b.right) ? { borders: b } : {}),
        hAlign: attr(stylesXml, al, 'horizontal') ?? undefined,
        vAlign: attr(stylesXml, al, 'vertical') ?? undefined,
        wrap: attr(stylesXml, al, 'wrapText') === '1',
        numFmt: numFmts.get(numId) ?? BUILTIN_FMT[numId],
      });
    }
  }

  const workbook = await text('xl/workbook.xml');
  // The `<dxfs>` styles a rule points at by index, read once for the whole book.
  const dxfStyles: Array<Partial<CellStyle>> = [];
  for (const body of stylesXml ? parseDxfs(stylesXml) : []) {
    const bold = /<(?:\w+:)?b\s*\/>/.test(body);
    const italic = /<(?:\w+:)?i\s*\/>/.test(body);
    const underline = /<(?:\w+:)?u\s*\/>/.test(body);
    const strike = /<(?:\w+:)?strike\s*\/>/.test(body);
    const fill = /<bgColor\b[^>]*rgb="([0-9A-Fa-f]{8})"/.exec(body)?.[1];
    const colour = /<color\b[^>]*rgb="([0-9A-Fa-f]{8})"/.exec(body)?.[1];
    dxfStyles.push({
      ...(bold ? { bold: true } : {}),
      ...(italic ? { italic: true } : {}),
      ...(underline ? { underline: true } : {}),
      ...(strike ? { strike: true } : {}),
      ...(fill ? { fill: fill.slice(2).toUpperCase() } : {}),
      ...(colour ? { color: colour.slice(2).toUpperCase() } : {}),
    });
  }
  const sheets: SheetLook[] = [];
  if (workbook) {
    const wdoc = parsePart(workbook);
    const sheetEls = wdoc.roots.flatMap((r) => elementsOf(r, 'sheet'));
    for (const [i, sheetEl] of sheetEls.entries()) {
      const rid = attr(workbook, sheetEl, 'r:id') ?? attr(workbook, sheetEl, 'id');
      const path = (rid ? rels.get(rid)?.target : undefined) ?? `xl/worksheets/sheet${i + 1}.xml`;
      const xml = await text(path);
      const look: SheetLook = { widths: new Map(), heights: new Map(), merges: [], frozenRows: 0, frozenCols: 0, xf: new Map(), defaultWidth: widthPx(8.43), defaultHeight: 20, formulas: new Map() };
      sheets.push(look);
      if (!xml) continue;
      const doc = parsePart(xml);
      const root = doc.roots.find((r) => localName(r.name) === 'worksheet');
      const fmt = child(root, 'sheetFormatPr');
      const dw = Number(attr(xml, fmt, 'defaultColWidth') ?? attr(xml, fmt, 'baseColWidth') ?? NaN);
      if (Number.isFinite(dw)) look.defaultWidth = widthPx(attr(xml, fmt, 'defaultColWidth') ? dw : dw + 0.43);
      const dh = Number(attr(xml, fmt, 'defaultRowHeight') ?? NaN);
      if (Number.isFinite(dh)) look.defaultHeight = Math.round(dh * 4 / 3);
      for (const col of child(root, 'cols')?.children ?? []) {
        const min = Number(attr(xml, col, 'min') ?? 1);
        const max = Math.min(Number(attr(xml, col, 'max') ?? min), min + 200);
        const width = Number(attr(xml, col, 'width') ?? NaN);
        const hidden = attr(xml, col, 'hidden') === '1';
        for (let c = min; c <= max; c++) if (Number.isFinite(width)) look.widths.set(c - 1, hidden ? 0 : widthPx(width));
      }
      const view = elementsOf(child(root, 'sheetViews') ?? (root as XmlElement), 'sheetView')[0];
      const rtlAttr = attr(xml, view, 'rightToLeft');
      if (rtlAttr !== null) look.rtl = rtlAttr === '1' || rtlAttr === 'true';
      const pane = elementsOf(child(root, 'sheetViews') ?? (root as XmlElement), 'pane')[0];
      if (pane && attr(xml, pane, 'state')?.startsWith('frozen')) {
        look.frozenRows = Number(attr(xml, pane, 'ySplit') ?? 0) || 0;
        look.frozenCols = Number(attr(xml, pane, 'xSplit') ?? 0) || 0;
      }
      for (const m of child(root, 'mergeCells')?.children ?? []) {
        const ref = attr(xml, m, 'ref') ?? '';
        const [a, b] = ref.split(':');
        if (!a || !b) continue;
        const r0 = Number(/\d+/.exec(a)?.[0]) - 1;
        const r1 = Number(/\d+/.exec(b)?.[0]) - 1;
        look.merges.push({ r0, c0: columnIndex(a), r1, c1: columnIndex(b) });
      }
      // The file's own AutoFilter: what the owner filtered last time the sheet was saved.
      const filters = parseAutoFilter(xml);
      if (filters.length) look.filters = new Map(filters.map((f) => [f.col, [...f.keys]]));
      // …and its conditional formatting, with the styles its `<dxf>` indices point at.
      const parsedCond = parseConditionalFormatting(xml);
      if (parsedCond.length) {
        const rules = parsedCond.map(({ rule }) => condRuleFrom(rule, rule.dxfId === undefined ? undefined : dxfStyles[rule.dxfId])).filter((r): r is CondRule => r !== null);
        if (rules.length) look.condRules = rules;
      }
      // Charts: the sheet points at a drawing part, whose anchors point at the chart parts.
      const sheetRels = await readRels(archive, path);
      const drawingRel = [...sheetRels.values()].find((r) => r.type === 'drawing');
      if (drawingRel) {
        // `readRels` already resolves a target against the part that names it.
        const drawingPath = drawingRel.target;
        const drawingPart = await text(drawingPath);
        if (drawingPart) {
          const drawingRels = await readRels(archive, drawingPath);
          const found: ChartObject[] = [];
          for (const anchor of parseAnchors(drawingPart)) {
            const target = anchor.relId ? drawingRels.get(anchor.relId)?.target : undefined;
            if (!target) continue;
            const chartPart = await text(target);
            const parsed = chartPart ? parseChartSpace(chartPart) : null;
            if (!parsed) continue;
            found.push({
              id: `filechart${found.length + 1}`,
              type: parsed.kind,
              range: rangeFromRefs(parsed.categoryRef, parsed.valueRef),
              title: parsed.title,
              x: anchor.x,
              y: anchor.y,
              w: anchor.w || 320,
              h: anchor.h || 200,
            });
          }
          if (found.length) look.charts = found;
        }
      }
      const shared = new Map<string, { formula: string; row: number; col: number }>();
      let rowCount = 0;
      for (const row of child(root, 'sheetData')?.children ?? []) {
        const rAttr = Number(attr(xml, row, 'r'));
        const r = Number.isFinite(rAttr) && rAttr > 0 ? rAttr - 1 : rowCount;
        rowCount = r + 1;
        const ht = Number(attr(xml, row, 'ht') ?? NaN);
        if (Number.isFinite(ht)) look.heights.set(r, Math.round(ht * 4 / 3));
        let next = 0;
        for (const c of row.children) {
          if (localName(c.name) !== 'c') continue;
          const ref = attr(xml, c, 'r');
          const col = ref ? columnIndex(ref) : next;
          next = col + 1;
          const s = Number(attr(xml, c, 's') ?? 0);
          if (s) look.xf.set(`${r}:${col}`, s);
          const f = child(c, 'f');
          if (!f) continue;
          const body = decodeXml(elementText(xml, f)).trim();
          const si = attr(xml, f, 'si');
          if (attr(xml, f, 't') === 'shared' && si !== null) {
            if (body) shared.set(si, { formula: body, row: r, col });
            const master = shared.get(si);
            if (master) look.formulas.set(`${r}:${col}`, `=${body || shiftFormula(master.formula, r - master.row, col - master.col)}`);
          } else if (body && attr(xml, f, 't') !== 'array') {
            look.formulas.set(`${r}:${col}`, `=${body}`);
          }
        }
      }
    }
  }
  return { styles, sheets };
}
