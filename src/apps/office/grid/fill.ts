/**
 * Sheet — the fill handle's maths (سلسلة التعبئة), pure and DOM-free.
 *
 * Dragging the little square at the corner of a selection either COPIES the source cells or
 * CONTINUES a series. Everything that decides what lands in which cell lives here so it can be
 * tested on its own; the view only turns the answer into one undoable edit.
 *
 * All coordinates are in DRAWN rows/columns — the space the grid actually shows. Mapping a drawn
 * row to the model row it shows is the view's job (`modelRowOf`), which is what keeps a fill from
 * writing into a row an active filter hid.
 */

export type FillDirection = 'up' | 'down' | 'left' | 'right';

/** A rectangle in drawn coordinates: `r1`/`c1` are inclusive. */
export interface FillRect {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

export interface FillPlan {
  direction: FillDirection;
  /** How many rows (up/down) or columns (left/right) the fill covers. */
  count: number;
}

/** True when the rectangle is a single cell. */
export const isSingleCell = (rect: FillRect): boolean => rect.r0 === rect.r1 && rect.c0 === rect.c1;

/**
 * Where a drag from `source` to `to` fills, or `null` when the pointer is still inside the source
 * (nothing to fill). The dominant axis wins, so a drag that goes a little sideways while
 * travelling down still reads as a downward fill.
 */
export function fillPlan(source: FillRect, to: { row: number; col: number }): FillPlan | null {
  const down = to.row - source.r1;
  const up = source.r0 - to.row;
  const right = to.col - source.c1;
  const left = source.c0 - to.col;
  const best = Math.max(down, up, right, left);
  if (best <= 0) return null;
  if (best === down) return { direction: 'down', count: down };
  if (best === up) return { direction: 'up', count: up };
  if (best === right) return { direction: 'right', count: right };
  return { direction: 'left', count: left };
}

/**
 * The drawn row/column of every cell a plan fills, in top-to-bottom / left-to-right order — the
 * order the values from `seriesFrom` are written in.
 */
export function fillCells(source: FillRect, plan: FillPlan): Array<{ row: number; col: number }> {
  const out: Array<{ row: number; col: number }> = [];
  if (plan.count <= 0) return out;
  if (plan.direction === 'down' || plan.direction === 'up') {
    const first = plan.direction === 'down' ? source.r1 + 1 : source.r0 - plan.count;
    for (let i = 0; i < plan.count; i++) {
      for (let c = source.c0; c <= source.c1; c++) out.push({ row: first + i, col: c });
    }
    return out;
  }
  const first = plan.direction === 'right' ? source.c1 + 1 : source.c0 - plan.count;
  for (let r = source.r0; r <= source.r1; r++) {
    for (let i = 0; i < plan.count; i++) out.push({ row: r, col: first + i });
  }
  return out;
}

/**
 * The source cell a plain copy takes, walking outwards from the source and cycling.
 *
 * `step` is signed: `1` is the first cell after the source, `-1` the first cell *before* it (which
 * is what a fill upward copies from). Out-of-range steps wrap, so a two-cell source alternates
 * however far the drag goes.
 */
export function copyIndex(step: number, length: number): number {
  if (length <= 0) return 0;
  const offset = step > 0 ? step - 1 : step;
  return ((offset % length) + length) % length;
}

const NUMBER = /^-?\d+(?:\.\d+)?$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_MONTH = /^(\d{4})-(\d{2})$/;
/** Text that ends in a number: "الشهر 3" → the 3 is the part a series steps. */
const TRAILING_NUMBER = /^(.*?)(\d+)(\D*)$/;

const numberAt = (v: string): number | null => (NUMBER.test(v.trim()) ? Number(v.trim()) : null);

/**
 * A date step in whole days, or null when the text is not an ISO date. Serial dates (a number
 * with a date format) are not detected here — they step as plain numbers, which is right for a
 * two-cell source and copies for a single cell; the report says so plainly.
 */
function isoDateValue(v: string): number | null {
  const m = ISO_DATE.exec(v.trim());
  if (!m) return null;
  const time = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(time) ? null : Math.round(time / 86_400_000);
}

const isoDateText = (days: number): string => new Date(days * 86_400_000).toISOString().slice(0, 10);

/**
 * The values a series continues: `count` cells beyond the source.
 *
 * The rules, in the order they are tried, per column (for up/down) or per row (for left/right) —
 * each line of source cells carries its own series, exactly as a spreadsheet does:
 *
 *  · two or more numbers → the step between the first and the last, continued (and, for `up`/
 *    `left`, continued backwards, which is what dragging a series upward means);
 *  · two or more ISO dates → the same, in whole days;
 *  · one ISO date → one day per cell (a date is the one value a spreadsheet steps from a single
 *    cell, because the cell's own type says "date");
 *  · one text ending in a number ("بند 3") → that number steps by one;
 *  · anything else → a copy, cycling the source pattern (so a two-cell source alternates).
 *
 * A single plain number copies (Excel's rule). The returned values are in top-to-bottom /
 * left-to-right order of the filled cells, matching `fillCells`.
 */
export function seriesFrom(cells: readonly string[], direction: FillDirection, count: number): string[] {
  if (count <= 0 || cells.length === 0) return [];
  const backwards = direction === 'up' || direction === 'left';
  const out: string[] = [];

  const numbers = cells.map(numberAt);
  const dates = cells.map(isoDateValue);
  const allNumbers = numbers.every((n) => n !== null);
  const allDates = dates.every((d) => d !== null);

  if (allDates) {
    const per = cells.length >= 2 ? ((dates.at(-1) as number) - (dates[0] as number)) / (cells.length - 1) : 1;
    const anchor = backwards ? (dates[0] as number) : (dates.at(-1) as number);
    for (let i = 0; i < count; i++) out.push(isoDateText(anchor + (backwards ? -(count - i) : i + 1) * per));
    return out;
  }
  if (allNumbers && cells.length >= 2) {
    const step = ((numbers.at(-1) as number) - (numbers[0] as number)) / (cells.length - 1);
    const anchor = backwards ? (numbers[0] as number) : (numbers.at(-1) as number);
    for (let i = 0; i < count; i++) out.push(formatNumber(anchor + (backwards ? -(count - i) : i + 1) * step));
    return out;
  }
  // A single plain number is a COPY in every spreadsheet; only text with a number inside it steps.
  const trailing = cells.length === 1 && !allNumbers ? TRAILING_NUMBER.exec(cells[0].trim()) : null;
  if (trailing) {
    const start = Number(trailing[2]);
    for (let i = 0; i < count; i++) out.push(`${trailing[1]}${backwards ? start - (count - i) : start + i + 1}${trailing[3]}`);
    return out;
  }
  for (let i = 0; i < count; i++) {
    const step = backwards ? count - i : i + 1;
    out.push(cells[copyIndex(step, cells.length)]);
  }
  return out;
}

/** A number as a cell would hold it: no float noise from a fractional step. */
function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  return String(Math.round(n * 1e10) / 1e10);
}
