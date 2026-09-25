/**
 * Sheet — the fill handle (مقبض التعبئة): what dragging a selection's corner
 * writes into the cells it passes over. Pure.
 *
 *  • Formulas are copied with their relative references moved (`translateFormula`).
 *  • Two or more numbers extend their series by the average step (1, 2 → 3, 4…).
 *  • Text ending in a number counts up ("Item 1" → "Item 2"), as in Excel.
 *  • Anything else is copied, repeating the source block.
 */
import { translateFormula } from '../formula/index';

export interface FillCell { value: string; formula?: string }

const NUMBER = /^-?\d+(\.\d+)?$/;
const TRAILING = /^(.*?)(\d+)$/;

/**
 * `count` cells continuing `sources` (one line along the fill direction). `axis`
 * says which way the formulas move.
 */
export function fillSeries(sources: readonly FillCell[], count: number, axis: 'row' | 'col'): FillCell[] {
  const n = sources.length;
  if (!n || count <= 0) return [];
  const numbers = sources.every((s) => !s.formula && NUMBER.test(s.value.trim()));
  if (numbers && n >= 2) {
    const first = Number(sources[0].value);
    const last = Number(sources[n - 1].value);
    const step = (last - first) / (n - 1);
    const decimals = Math.max(...sources.map((s) => (s.value.split('.')[1] ?? '').length));
    return Array.from({ length: count }, (_, k) => ({ value: String(Number((last + step * (k + 1)).toFixed(Math.min(10, decimals + 4)))) }));
  }
  const out: FillCell[] = [];
  for (let k = 0; k < count; k++) {
    const src = sources[k % n];
    const offset = n * (Math.floor(k / n) + 1);
    if (src.formula) {
      const moved = translateFormula(src.formula.replace(/^=/, ''), axis === 'row' ? offset : 0, axis === 'col' ? offset : 0);
      out.push({ value: '', formula: `=${moved.replace(/^=/, '')}` });
      continue;
    }
    const m = TRAILING.exec(src.value);
    if (m && !NUMBER.test(src.value.trim())) {
      const width = m[2].length;
      const next = String(Number(m[2]) + Math.floor(k / n) + 1);
      out.push({ value: `${m[1]}${m[2].startsWith('0') ? next.padStart(width, '0') : next}` });
      continue;
    }
    out.push({ value: src.value });
  }
  return out;
}

/** Which way a drag from the selection's corner fills, and how far. */
export function fillTarget(
  range: { r0: number; c0: number; r1: number; c1: number },
  row: number,
  col: number,
): { axis: 'row' | 'col'; count: number } | null {
  const down = row - range.r1;
  const across = col - range.c1;
  if (down <= 0 && across <= 0) return null;
  return down >= across ? { axis: 'row', count: down } : { axis: 'col', count: across };
}
