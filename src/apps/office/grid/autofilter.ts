/**
 * Sheet — the AutoFilter in the FILE (كتابة التصفية في ملف .xlsx وقراءتها).
 *
 * An AutoFilter is one element per sheet, right after `</sheetData>`:
 *
 *   <autoFilter ref="A1:D40">
 *     <filterColumn colId="1"><filters><filter val="شهري"/><filter val="سنوي"/></filters></filterColumn>
 *   </autoFilter>
 *
 * Only the VALUES kind of condition has that shape (a checklist, which is what the panel's list
 * builds); `blank` becomes `blank="1"`, and the ranges the file format expresses with other
 * elements (`customFilters`, `top10`, `dynamicFilter`) are NOT written — a filter this app cannot
 * spell exactly is left out of the file rather than written as something it is not, so the panel
 * says so.
 *
 * Pure string → string, so the writer (surgical patch or rebuild) and the reader share one rule.
 */
import { columnName } from '../xml';
import { xmlText } from '../xml';

/** One filtered column, as the file holds it: the column index and the values kept. */
export interface AutoFilterColumn {
  col: number;
  /** The checklist values that stay visible, in the order the file lists them ('' is a blank). */
  keys: readonly string[];
}

/** The range an AutoFilter spans: the header row plus the rows of data, first to last column. */
export function autoFilterRef(rowCount: number, colCount: number, headerRows = 0): string | null {
  if (rowCount <= 0 || colCount <= 0) return null;
  const first = headerRows > 0 ? 1 : 1;                       // the ref starts at the header row
  const lastRow = Math.max(first, rowCount);
  return `A${first}:${columnName(Math.max(0, colCount - 1))}${lastRow}`;
}

/** The `<autoFilter>` element for these columns, or null when there is nothing usable to write. */
export function autoFilterXml(columns: readonly AutoFilterColumn[], ref: string): string | null {
  const parts: string[] = [];
  for (const column of columns) {
    if (!Number.isInteger(column.col) || column.col < 0) continue;
    const blank = column.keys.some((key) => key === '');
    const values = column.keys.filter((key) => key !== '');
    if (!blank && !values.length) continue;                   // an empty checklist filters nothing
    const filters = values.length
      ? `<filters${blank ? ' blank="1"' : ''}>` + values.map((value) => `<filter val="${xmlText(value)}"/>`).join('') + '</filters>'
      : '<filters blank="1"/>';
    parts.push(`<filterColumn colId="${column.col}">${filters}</filterColumn>`);
  }
  return parts.length ? `<autoFilter ref="${ref}">${parts.join('')}</autoFilter>` : null;
}

/**
 * The worksheet with its AutoFilter replaced by `element` (or removed when it is null). The element
 * belongs right after `</sheetData>` — that is where the schema puts it, and Excel is unforgiving
 * about the order.
 */
export function withAutoFilter(worksheetXml: string, element: string | null): string {
  const stripped = worksheetXml.replace(/<autoFilter\b[^>]*>[\s\S]*?<\/autoFilter>|<autoFilter\b[^>]*\/>/g, '');
  if (!element) return stripped;
  // A sheet with no rows writes `<sheetData/>`: give it a real body so the element has a home.
  const open = stripped.replace(/<sheetData\s*\/>/, '<sheetData></sheetData>');
  const close = open.lastIndexOf('</sheetData>');
  if (close < 0) return stripped;                             // no sheetData: leave the part alone
  const at = close + '</sheetData>'.length;
  return open.slice(0, at) + element + open.slice(at);
}

/** The columns an `<autoFilter>` in a worksheet states, in file order. */
export function parseAutoFilter(worksheetXml: string): AutoFilterColumn[] {
  const element = /<autoFilter\b[^>]*>([\s\S]*?)<\/autoFilter>/.exec(worksheetXml);
  if (!element) return [];
  const out: AutoFilterColumn[] = [];
  const column = /<filterColumn\b[^>]*colId="(\d+)"[^>]*>([\s\S]*?)<\/filterColumn>|<filterColumn\b[^>]*colId="(\d+)"[^>]*\/>/g;
  for (let m = column.exec(element[1]); m; m = column.exec(element[1])) {
    const col = Number(m[1] ?? m[3]);
    if (!Number.isInteger(col)) continue;
    const body = m[2] ?? '';
    const keys: string[] = [];
    if (/<filters\b[^>]*\bblank="1"/.test(body)) keys.push('');
    const value = /<filter\b[^>]*val="([^"]*)"/g;
    for (let v = value.exec(body); v; v = value.exec(body)) keys.push(unescapeXml(v[1]));
    out.push({ col, keys });
  }
  return out;
}

const unescapeXml = (text: string): string =>
  text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d))).replace(/&amp;/g, '&');
