/**
 * Sheet layout — the pure rules for which way a sheet runs and where a cell's text sits.
 *
 * - Direction: a sheet is right-to-left (column A on the right, as WPS and Excel show an
 *   Arabic sheet) when its file says so, else when the UI is Arabic, else when most of its
 *   text is Arabic.
 * - Alignment ("General", as Excel does it): numbers — a formula's numeric result too — sit
 *   on the right, TRUE/FALSE and errors in the middle, text at the start of its OWN direction
 *   (an Arabic word on the right, a Latin one on the left), whatever way the sheet runs.
 * - Width: the columns drawn past the data reach the far edge of the window, so a sheet never
 *   ends in a grey strip.
 */
import { hasArabic, startsRtl } from '../writer/docops';

const NUMBER = /^-?\d+(\.\d+)?(E[+-]?\d+)?$/i;

export function isNumeric(value: string): boolean {
  const v = value.trim();
  return v !== '' && NUMBER.test(v);
}

/**
 * Whether a sheet is drawn right-to-left: the file's own `rightToLeft` when it states one, else
 * the UI language (an Arabic UI opens sheets right-to-left, like WPS), else most of its text.
 */
export function sheetDirection(rows: readonly (readonly string[])[], stated: boolean | undefined, uiArabic: boolean): boolean {
  if (stated !== undefined) return stated;
  if (uiArabic) return true;
  let text = 0;
  let arabic = 0;
  for (const row of rows.slice(0, 500)) {
    for (const cell of row) {
      const v = cell.trim();
      if (!v || NUMBER.test(v)) continue;
      text++;
      if (hasArabic(v)) arabic++;
    }
  }
  return text > 0 && arabic * 2 > text;
}

export interface CellAlignment {
  /** The direction the text runs in (numbers always left-to-right). */
  dir: 'ltr' | 'rtl';
  /** The flex placement inside the cell, in that direction. */
  justify: 'flex-start' | 'center' | 'flex-end';
  textAlign: 'start' | 'left' | 'right' | 'center';
}

/** Where a cell's text sits: the file's horizontal alignment, else Excel's "General" rule. */
export function cellAlignment(value: string, hAlign?: string): CellAlignment {
  const numeric = isNumeric(value);
  const rtl = !numeric && startsRtl(value) === true;
  const dir = rtl ? 'rtl' : 'ltr';
  const v = value.trim();
  const general = !hAlign || hAlign === 'general';
  const h = general
    ? (numeric ? 'right' : /^(TRUE|FALSE)$/.test(v) || /^#[A-Z/0]+[!?]?[A-Z]*$/.test(v) ? 'center' : '')
    : hAlign;
  if (h === 'center' || h === 'centerContinuous') return { dir, justify: 'center', textAlign: 'center' };
  if (h === 'right') return { dir, justify: rtl ? 'flex-start' : 'flex-end', textAlign: 'right' };
  if (h === 'left') return { dir, justify: rtl ? 'flex-end' : 'flex-start', textAlign: 'left' };
  return { dir, justify: 'flex-start', textAlign: 'start' };
}

/**
 * How many columns to draw: the data (plus a few to type into on an editable sheet), at least
 * `minimum`, and then enough more that their widths reach `viewport` pixels. `widthOf` gives a
 * column's width; `max` is the sheet's last column.
 */
export function columnsToDraw(dataCols: number, extra: number, minimum: number, max: number, viewport: number, widthOf: (c: number) => number, rowHead = 48): number {
  let cols = Math.min(Math.max(dataCols + extra, minimum), max);
  let total = rowHead;
  for (let c = 0; c < cols; c++) total += widthOf(c);
  while (cols < max && total < viewport) { total += widthOf(cols); cols++; }
  return cols;
}
