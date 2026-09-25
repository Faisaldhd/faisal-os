/**
 * Sheet — the view-level state of a sheet (حالة العرض): sort, AutoFilter, conditional formatting,
 * number formats and floating charts.
 *
 * Everything here is plain data and pure functions, so the decisions are testable without a DOM.
 * The view (`view.ts`) owns the elements; this file owns *what* it should show.
 *
 * What is written back to the file and what is not, stated plainly:
 *   · SORT is applied to the model through an ordinary edit, so it is undoable and it IS saved.
 *   · FILTER, CONDITIONAL FORMATTING, NUMBER FORMATS and CHARTS are view-level only in this slice:
 *     they change what the screen shows, and the `.xlsx` on disk is untouched by them.
 */
import {
  BUILTIN_FORMATS, evaluateConditionalFormats, formatValue, makeFormat, parseEntry, visibleRows,
  type CellStyle, type CondRule, type FilterCondition, type SortKey,
} from '../calc/index';
import type { CellInput } from '../calc/sort';
import type { ChartSpec, ChartType, PointSeries, ValueSeries } from '../charts/index';

/** A rectangle of sheet coordinates, inclusive. */
export interface SheetRange { r0: number; c0: number; r1: number; c1: number }

/** A chart floating over the sheet. `x`/`y` are its offset inside the sheet area, in pixels. */
export interface ChartObject {
  id: string;
  type: ChartType;
  range: SheetRange;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SheetView {
  /** Multi-level sort keys, in order of significance. Empty means "as the file has it". */
  sort: readonly SortKey[];
  /** AutoFilter, one condition per column index. */
  filters: Readonly<Record<number, FilterCondition>>;
  /** A number format per cell, keyed `row:col`. View-level only. */
  formats: Readonly<Record<string, string>>;
  /** Conditional-formatting rules for the whole sheet. View-level only. */
  condRules: readonly CondRule[];
  /** Floating charts. View-level only. */
  charts: readonly ChartObject[];
}

export function emptySheetView(): SheetView {
  return { sort: [], filters: {}, formats: {}, condRules: [], charts: [] };
}

/* ────────────────────────────────── sort ────────────────────────────────── */

/** How many sort levels the dialog offers; three is what a person ever needs. */
export const MAX_SORT_LEVELS = 3;

export function addSortLevel(view: SheetView, col: number, order: 'asc' | 'desc' = 'asc'): SheetView {
  const next = view.sort.filter((k) => k.col !== col);
  if (next.length >= MAX_SORT_LEVELS) next.pop();
  return { ...view, sort: [{ col, order }, ...next] };
}

export function setSortOrder(view: SheetView, col: number, order: 'asc' | 'desc'): SheetView {
  if (!view.sort.some((k) => k.col === col)) return view;
  return { ...view, sort: view.sort.map((k) => (k.col === col ? { ...k, order } : k)) };
}

export function removeSortLevel(view: SheetView, col: number): SheetView {
  return { ...view, sort: view.sort.filter((k) => k.col !== col) };
}

export function clearSort(view: SheetView): SheetView {
  return { ...view, sort: [] };
}

/**
 * Whether the first row reads as a header: mostly text over rows that are mostly numbers. Sorting
 * (and filtering) must leave such a row alone, so the decision is made once and shown in the UI.
 */
export function looksLikeHeader(rows: ReadonlyArray<ReadonlyArray<CellInput>>): boolean {
  if (rows.length < 2) return false;
  const first = rows[0].filter((v) => String(v ?? '').trim() !== '');
  if (!first.length) return false;
  const numeric = (v: CellInput): boolean => {
    const text = String(v ?? '').trim();
    if (text === '') return false;
    const parsed = parseEntry(text);
    return typeof parsed.value === 'number';
  };
  const headNumbers = first.filter(numeric).length;
  let below = 0;
  let belowNumbers = 0;
  for (const row of rows.slice(1, 21)) {
    for (const v of row) {
      if (String(v ?? '').trim() === '') continue;
      below++;
      if (numeric(v)) belowNumbers++;
    }
  }
  return headNumbers / first.length <= 0.34 && below > 0 && belowNumbers / below >= 0.5;
}

/* ──────────────────────────────── AutoFilter ──────────────────────────────── */

export function setFilter(view: SheetView, col: number, cond: FilterCondition): SheetView {
  return { ...view, filters: { ...view.filters, [col]: cond } };
}

export function clearFilter(view: SheetView, col: number): SheetView {
  const next = { ...view.filters };
  delete next[col];
  return { ...view, filters: next };
}

export function clearFilters(view: SheetView): SheetView {
  return { ...view, filters: {} };
}

/** The columns a filter is applied to. */
export function filteredColumns(view: SheetView): number[] {
  return Object.keys(view.filters).map(Number).sort((a, b) => a - b);
}

export function isFiltered(view: SheetView): boolean {
  return filteredColumns(view).length > 0;
}

/** The rows a filter leaves visible, and how many it hides. */
export interface RowMap {
  /** Model row indices to draw, in order. */
  rows: number[];
  /** How many rows the filter hides. */
  hidden: number;
  /** True when a filter is doing something. */
  filtered: boolean;
}

const identityMap = (count: number): RowMap => ({
  rows: Array.from({ length: count }, (_, i) => i),
  hidden: 0,
  filtered: false,
});

/**
 * Which model rows the sheet should draw: the header rows always, then whatever survives every
 * column's condition. Sorting is already in the model, so it needs no mapping here.
 */
export function visibleRowMap(
  rows: ReadonlyArray<ReadonlyArray<CellInput>>,
  view: SheetView,
  header = 0,
): RowMap {
  if (!isFiltered(view)) return identityMap(rows.length);
  const keep = visibleRows(rows, view.filters as Record<number, FilterCondition>, { header });
  return { rows: keep, hidden: rows.length - keep.length, filtered: true };
}

/* ───────────────────────────── number formats ───────────────────────────── */

/**
 * The formats the picker offers, in the order it shows them. Every pattern comes from the engine's
 * own `BUILTIN_FORMATS` (or `makeFormat`), so the picker can never drift from what the formatter
 * understands; the label key is where the app's strings.ts names it.
 */
export interface FormatChoice { value: string; labelKey: string }

export function formatChoices(): ReadonlyArray<FormatChoice> {
  const builtin = (id: number): string => {
    const pattern = BUILTIN_FORMATS[id];
    if (pattern === undefined) throw new Error(`no built-in format ${id}`);
    return pattern;
  };
  return [
    { value: builtin(0), labelKey: 'office.numGeneral' },
    { value: builtin(1), labelKey: 'office.numInteger' },
    { value: builtin(2), labelKey: 'office.numDecimal' },
    { value: builtin(3), labelKey: 'office.numThousands' },
    { value: builtin(4), labelKey: 'office.numThousandsDecimals' },
    { value: makeFormat({ kind: 'currency', decimals: 2 }), labelKey: 'office.numCurrency' },
    { value: builtin(9), labelKey: 'office.numPercent' },
    { value: builtin(10), labelKey: 'office.numPercentDecimals' },
    { value: builtin(14), labelKey: 'office.numDate' },
    { value: builtin(20), labelKey: 'office.numTime' },
    { value: builtin(11), labelKey: 'office.numScientific' },
    { value: builtin(49), labelKey: 'office.numText' },
  ];
}

/** The pattern a drawn cell should display through, '' meaning the sheet's own General. */
export function formatForCell(formats: Readonly<Record<string, string>>, row: number, col: number): string {
  return formats[`${row}:${col}`] ?? '';
}

/**
 * A cell as the number formatter should show it. The raw text is parsed with the engine's own
 * `parseEntry`, so "1,234.5" and "50%" format as the numbers they mean; anything else (a formula's
 * text, a word) is shown as it is.
 */
export function displayText(raw: string, pattern: string, locale: 'ar' | 'en' = 'en'): string {
  if (!pattern || pattern === 'General') return raw;
  const parsed = parseEntry(raw);
  if (typeof parsed.value !== 'number') return raw;
  try {
    return formatValue(parsed.value, pattern, { locale }).text;
  } catch {
    return raw;
  }
}

/**
 * The view-level state after a row or column was inserted or deleted (إزاحة فهارس العرض).
 *
 * Everything this file holds is keyed by a position in the SHEET: the number format the owner chose
 * (`row:col`), the AutoFilter and the sort keys (column indices), and a chart's range. The model
 * moves its own copies of the data and of the file's formatting when the structure changes; this
 * moves the copies the SCREEN is drawn from, with the same rule, so a format cannot end up on a row
 * the owner never formatted — a display that contradicts the data is worse than no format at all.
 *
 * The rule is the one `shiftFormula` uses on a reference: what is at or below the change point moves
 * with the data, what is above stays, a deleted line takes its own entries with it, and a range
 * whose whole body was deleted goes too.
 */
export function shiftViewFor(view: SheetView, axis: 'row' | 'col', at: number, delta: 1 | -1): SheetView {
  const move = (index: number): number | null => {
    if (delta > 0) return index >= at ? index + delta : index;
    if (index < at) return index;
    if (index > at) return index - 1;
    return null;                                  // the deleted line itself
  };
  const formats: Record<string, string> = {};
  for (const [key, pattern] of Object.entries(view.formats)) {
    const [rowText, colText] = key.split(':');
    const row = Number(rowText);
    const col = Number(colText);
    if (!Number.isInteger(row) || !Number.isInteger(col)) continue;
    const nextRow = axis === 'row' ? move(row) : row;
    const nextCol = axis === 'col' ? move(col) : col;
    if (nextRow !== null && nextCol !== null) formats[`${nextRow}:${nextCol}`] = pattern;
  }
  const charts = view.charts.flatMap((chart) => {
    const rng = chart.range;
    const lo = axis === 'row' ? Math.min(rng.r0, rng.r1) : Math.min(rng.c0, rng.c1);
    const hi = axis === 'row' ? Math.max(rng.r0, rng.r1) : Math.max(rng.c0, rng.c1);
    if (delta < 0 && lo >= at && hi <= at) return [];      // its whole range was deleted
    const nextLo = move(lo) ?? at;
    const nextHi = Math.max(nextLo, move(hi) ?? Math.max(0, at - 1));
    const range = axis === 'row' ? { ...rng, r0: nextLo, r1: nextHi } : { ...rng, c0: nextLo, c1: nextHi };
    return [{ ...chart, range }];
  });
  // The AutoFilter and the sort levels are keyed by COLUMN, so a row change never moves them.
  const lineKeys = <T>(map: Readonly<Record<number, T>>): Record<number, T> => {
    if (axis !== 'col') return { ...map };
    const out: Record<number, T> = {};
    for (const [key, value] of Object.entries(map)) {
      const next = move(Number(key));
      if (next !== null) out[next] = value;
    }
    return out;
  };
  return {
    ...view,
    formats,
    filters: lineKeys(view.filters),
    sort: axis === 'col' ? view.sort.map((key) => ({ ...key, col: move(key.col) ?? key.col })) : view.sort,
    charts,
  };
}

/* ──────────────────────── conditional formatting ──────────────────────── */
/** Per-cell styles from the rules, indexed like `rows`. */
export function conditionalStyles(
  rows: ReadonlyArray<ReadonlyArray<CellInput>>,
  rules: readonly CondRule[],
): Array<Array<CellStyle | null>> {
  if (!rules.length || !rows.length) return rows.map((row) => row.map(() => null));
  return evaluateConditionalFormats(rows, rules);
}

/** The rule the app's "colour scale" button makes, over the sheet's own theme colours. */
export function colorScaleRule(): CondRule {
  return {
    type: 'colorScale',
    min: { kind: 'min', color: '#F8CBAD' },
    max: { kind: 'max', color: '#2F67E6' },
  };
}

/** The rule the app's "data bar" button makes. */
export function dataBarRule(): CondRule {
  return { type: 'dataBar', color: '#5B8DEF' };
}

/** The rule the app's "top 10" button makes. */
export function topRule(count: number, style: CellStyle = { fill: '#FFF2CC' }): CondRule {
  return { type: 'top', count, style: { fill: style.fill, color: style.color, bold: style.bold } };
}

export function addCondRule(view: SheetView, rule: CondRule): SheetView {
  return { ...view, condRules: [...view.condRules, rule] };
}

export function clearCondRules(view: SheetView): SheetView {
  return { ...view, condRules: [] };
}

/* ──────────────────────────────── charts ──────────────────────────────── */

/** The number a cell contributes to a chart, or null when it is not a number. */
export function chartNumber(raw: CellInput): number | null {
  const text = String(raw ?? '').trim();
  if (text === '') return null;
  const parsed = parseEntry(text);
  return typeof parsed.value === 'number' ? parsed.value : null;
}

/**
 * Turns a selected range into the engine's chart spec: the first column (or the row numbers when
 * there is only one column) becomes the categories, and every other column becomes a series named
 * after its header cell when the first row of the range looks like one.
 */
export function rangeToChartSpec(
  rows: ReadonlyArray<ReadonlyArray<CellInput>>,
  range: SheetRange,
  opts: { type: ChartType; title?: string; theme?: 'dark' | 'light'; rtl?: boolean; width?: number; height?: number } ,
): ChartSpec {
  const r0 = Math.max(0, Math.min(range.r0, range.r1));
  const r1 = Math.max(range.r0, range.r1);
  const c0 = Math.max(0, Math.min(range.c0, range.c1));
  const c1 = Math.max(range.c0, range.c1);
  const height = r1 - r0 + 1;
  const width = c1 - c0 + 1;
  if (height < 1 || width < 1) return { type: opts.type, series: [], categories: [] };

  const cell = (r: number, c: number): CellInput => rows[r]?.[c] ?? '';
  const firstRow = Array.from({ length: width }, (_, i) => cell(r0, c0 + i));
  const headered = width > 1 && height > 1 && looksLikeHeader(
    Array.from({ length: Math.min(height, 21) }, (_, i) => Array.from({ length: width }, (_, j) => cell(r0 + i, c0 + j))),
  );
  const bodyFrom = headered ? r0 + 1 : r0;
  const single = width === 1;

  const categories: string[] = [];
  for (let r = bodyFrom; r <= r1; r++) {
    const label = single ? String(r + 1) : String(cell(r, c0) ?? '');
    categories.push(label);
  }

  const series: Array<ValueSeries | PointSeries> = [];
  const firstSeriesCol = single ? c0 : c0 + 1;
  for (let c = firstSeriesCol; c <= c1; c++) {
    const name = headered ? String(cell(r0, c) ?? '') : single ? String(cell(r0, c) ?? '') : String.fromCharCode(65 + (c % 26));
    if (opts.type === 'scatter') {
      // A scatter plots one column against the next: x from the category column, y from this one.
      const points: Array<{ x: number; y: number }> = [];
      for (let r = bodyFrom; r <= r1; r++) {
        const y = chartNumber(cell(r, c));
        const x = single ? r - bodyFrom + 1 : chartNumber(cell(r, c0));
        if (y === null || x === null) continue;
        points.push({ x, y });
      }
      series.push({ name: name || `S${series.length + 1}`, points });
    } else {
      const values: Array<number | null> = [];
      for (let r = bodyFrom; r <= r1; r++) values.push(chartNumber(cell(r, c)));
      series.push({ name: name || `S${series.length + 1}`, values });
    }
  }

  const header = headered ? firstRow.map((v) => String(v ?? '')) : [];
  // A column with nothing plottable in it (an empty selection, or text where numbers belong) is
  // dropped rather than drawn as a legend entry with no marks.
  const plotted = series.filter((s) => ('values' in s ? s.values.some((v) => v !== null) : s.points.length > 0));
  return {
    type: opts.type,
    series: plotted,
    ...(opts.type === 'scatter' ? {} : { categories }),
    ...(opts.type === 'pie' || opts.type === 'doughnut' ? { legend: true } : {}),
    ...(opts.title ? { title: opts.title } : {}),
    ...(header.length > 1 && header[0] ? { xTitle: header[0] } : {}),
    ...(headered ? { yTitle: header[1] ?? '' } : {}),
    ...(opts.theme ? { theme: opts.theme } : {}),
    ...(opts.rtl !== undefined ? { rtl: opts.rtl } : {}),
    ...(opts.width ? { width: opts.width } : {}),
    ...(opts.height ? { height: opts.height } : {}),
  };
}

export function chartTypeChoices(): ReadonlyArray<{ value: ChartType; labelKey: string }> {
  return [
    { value: 'bar', labelKey: 'office.chartBar' },
    { value: 'line', labelKey: 'office.chartLine' },
    { value: 'pie', labelKey: 'office.chartPie' },
    { value: 'doughnut', labelKey: 'office.chartDoughnut' },
    { value: 'scatter', labelKey: 'office.chartScatter' },
  ];
}

export function addChart(view: SheetView, chart: Omit<ChartObject, 'id'>): SheetView {
  const id = `chart${view.charts.length + 1}-${Math.round(chart.x)}-${Math.round(chart.y)}`;
  return { ...view, charts: [...view.charts, { ...chart, id }] };
}

export function removeChart(view: SheetView, id: string): SheetView {
  if (!view.charts.some((c) => c.id === id)) return view;
  return { ...view, charts: view.charts.filter((c) => c.id !== id) };
}

/** A chart's offset after a drag, kept inside the sheet area. */
export function dragPosition(start: { x: number; y: number }, dx: number, dy: number, bounds: { w: number; h: number }, size: { w: number; h: number }): { x: number; y: number } {
  const maxX = Math.max(0, bounds.w - size.w);
  const maxY = Math.max(0, bounds.h - size.h);
  return {
    x: Math.max(0, Math.min(maxX, Math.round(start.x + dx))),
    y: Math.max(0, Math.min(maxY, Math.round(start.y + dy))),
  };
}
