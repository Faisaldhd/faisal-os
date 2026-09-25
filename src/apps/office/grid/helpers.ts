/**
 * Sheet — small pure helpers for the grid view (أدوات مساعدة): opening auto-fit widths, row-drag
 * heights, the decimal step of a number format, the circular-reference check, and text
 * measurement for auto-fit. Kept out of `view.ts` so they are testable on their own.
 */
import type { SheetsModel } from '../model';
import { workbookFromModel } from '../formula/index';
import { autoFitColumns, DEFAULT_COL_WIDTH, estimateTextWidth, type MeasureText } from './virtual';

/**
 * A number format with one more (`delta` 1) or one fewer (-1) decimal place in
 * every section — the ribbon's "increase/decrease decimal". Quoted text is left
 * alone; the digits nearest the end of a section (before any exponent) carry the
 * decimals, as in Excel.
 */
export function stepDecimals(code: string, delta: 1 | -1): string {
  return code.split(';').map((section) => {
    const parts = section.split(/("[^"]*")/);
    // The last unquoted part holding a digit placeholder is where the decimals live.
    let at = -1;
    for (let i = parts.length - 1; i >= 0; i--) if (i % 2 === 0 && /[0#]/.test(parts[i].replace(/E[+-]0+/i, ''))) { at = i; break; }
    if (at < 0) return section;
    const body = parts[at];
    const exp = /E[+-]0+/i.exec(body);
    const head = exp ? body.slice(0, exp.index) : body;
    const tail = exp ? body.slice(exp.index) : '';
    const m = /([0#])(?:\.(0*))?([^0#]*)$/.exec(head);
    if (!m) return section;
    const places = Math.max(0, (m[2]?.length ?? 0) + delta);
    parts[at] = `${head.slice(0, m.index)}${m[1]}${places ? `.${'0'.repeat(places)}` : ''}${m[3]}${tail}`;
    return parts.join('');
  }).join(';');
}

/** Whether a cell's formula is part of a reference cycle (the engine shows #REF! there). */
export function isCircularAt(model: SheetsModel, row: number, col: number): boolean {
  try {
    const wb = workbookFromModel(model);
    wb.recalc();
    return wb.isCircular(model.active, row, col);
  } catch { return false; }
}

/** Narrowest and tallest a row may be dragged. */
export const MIN_ROW_HEIGHT = 12;
export const MAX_ROW_HEIGHT = 400;

/**
 * The widths auto-fit gives a sheet whose file states none: every column with
 * content is as wide as its widest shown value, never narrower than the default
 * (an empty column keeps the default, as in Excel).
 */
export function openingWidths(
  texts: readonly (readonly string[])[],
  cols: number,
  measure: MeasureText,
  fallback = DEFAULT_COL_WIDTH,
): Map<number, number> {
  const fitted = autoFitColumns(texts, Array.from({ length: cols }, (_, c) => c), measure);
  const out = new Map<number, number>();
  for (const [c, w] of fitted) out.set(c, Math.max(fallback, w));
  return out;
}

/** The height a row drag ends at. */
export function draggedHeight(start: number, startY: number, y: number): number {
  const h = start + (y - startY);
  return Math.round(Math.min(MAX_ROW_HEIGHT, Math.max(MIN_ROW_HEIGHT, Number.isFinite(h) ? h : start)));
}

let canvas2d: CanvasRenderingContext2D | null | undefined;
/** Real text widths through a canvas (the grid's own font), with a deterministic estimate where there is none. */
export function measureCellText(text: string, fontSize: number): number {
  if (canvas2d === undefined) {
    canvas2d = null;
    try {
      if (typeof navigator === 'undefined' || !/jsdom/i.test(navigator.userAgent)) canvas2d = document.createElement('canvas').getContext('2d');
    } catch { canvas2d = null; }
  }
  if (!canvas2d) return estimateTextWidth(text, fontSize);
  canvas2d.font = `${fontSize}px Calibri, Carlito, Arial, "Noto Sans Arabic", sans-serif`;
  return canvas2d.measureText(text).width;
}
