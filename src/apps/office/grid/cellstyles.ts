/**
 * Cell styles (أنماط الخلايا): the named looks of the Home tab — Good, Bad, Neutral, a heading,
 * a total, a note, an input — each a `CellFormat` delta, so a style saves into `styles.xml`
 * exactly like a fill or a bold the owner set by hand, and "Normal" takes them all away again.
 *
 * Pure: no DOM.
 */
import type { CellFormat, HAlign, VAlign } from './sheetfmt';
import type { CellStyle } from './xlsxlook';

export type CellStyleId = 'normal' | 'good' | 'bad' | 'neutral' | 'heading' | 'title' | 'total' | 'input' | 'note' | 'accent';

export const CELL_STYLES: ReadonlyArray<{ id: CellStyleId; format: CellFormat; swatch: { fill: string; color: string } }> = [
  { id: 'normal', format: { bold: false, italic: false, color: null, fill: null, borders: { top: false, bottom: false } }, swatch: { fill: 'FFFFFF', color: '000000' } },
  { id: 'good', format: { fill: 'C6EFCE', color: '006100' }, swatch: { fill: 'C6EFCE', color: '006100' } },
  { id: 'bad', format: { fill: 'FFC7CE', color: '9C0006' }, swatch: { fill: 'FFC7CE', color: '9C0006' } },
  { id: 'neutral', format: { fill: 'FFEB9C', color: '9C5700' }, swatch: { fill: 'FFEB9C', color: '9C5700' } },
  { id: 'heading', format: { bold: true, color: '1F4E79', borders: { bottom: true } }, swatch: { fill: 'FFFFFF', color: '1F4E79' } },
  { id: 'title', format: { bold: true, color: '1F4E79', fill: 'DCE6F1' }, swatch: { fill: 'DCE6F1', color: '1F4E79' } },
  { id: 'total', format: { bold: true, borders: { top: true, bottom: true } }, swatch: { fill: 'FFFFFF', color: '000000' } },
  { id: 'input', format: { fill: 'FFCC99', color: '3F3F76', borders: { top: true, bottom: true } }, swatch: { fill: 'FFCC99', color: '3F3F76' } },
  { id: 'note', format: { fill: 'FFFFCC', italic: true }, swatch: { fill: 'FFFFCC', color: '000000' } },
  { id: 'accent', format: { fill: 'C8894B', color: 'FFFFFF', bold: true }, swatch: { fill: 'C8894B', color: 'FFFFFF' } },
];

/** The format a style lays over a cell. */
export function cellStyleFormat(id: CellStyleId): CellFormat {
  return { ...(CELL_STYLES.find((s) => s.id === id)?.format ?? {}) };
}

/**
 * The whole look of a cell as a format to lay on others (the format painter): every property
 * named, "off" included, so the target ends up looking exactly like the source.
 */
export function formatFromStyle(s: CellStyle | undefined): CellFormat {
  const h = s?.hAlign === 'left' || s?.hAlign === 'center' || s?.hAlign === 'right' ? s.hAlign as HAlign : null;
  const v = s?.vAlign === 'top' || s?.vAlign === 'center' || s?.vAlign === 'bottom' ? s.vAlign as VAlign : null;
  const out: CellFormat = {
    bold: !!s?.bold, italic: !!s?.italic, underline: !!s?.underline, strike: !!s?.strike,
    color: s?.color ?? null, fill: s?.fill ?? null, hAlign: h, vAlign: v, wrap: !!s?.wrap, numFmt: s?.numFmt ?? null,
    borders: { top: !!s?.borders?.top, bottom: !!s?.borders?.bottom, left: !!s?.borders?.left, right: !!s?.borders?.right },
  };
  if (s?.font) out.font = s.font;
  if (s?.size) out.size = s.size;
  return out;
}
