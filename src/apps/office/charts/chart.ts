/**
 * Office charts — a DOM-free chart scene (مشهد الرسم البياني).
 *
 *   buildChart(spec) → ChartScene { width, height, marks: Mark[], plot }
 *
 * The lead renders the marks with createElementNS (each Mark maps 1:1 to an SVG
 * element: rect/path/line/circle/text), or calls renderSvg(scene) from svg.ts
 * for an escaped SVG string (export, thumbnails).
 *
 * ChartSpec:
 *   type: 'bar' | 'line' | 'pie' | 'doughnut' | 'scatter'
 *   categories?: string[]                       x labels (bar/line) or slice names (pie/doughnut)
 *   series: [{ name, values: (number | null)[] }]            bar/line/pie (pie uses series[0])
 *         | [{ name, points: [{ x, y }] }]                    scatter
 *   stacked?: boolean      bar only (positive and negative values stack separately)
 *   horizontal?: boolean   bar only
 *   title?, xTitle?, yTitle?: string
 *   width?, height?: number (default 640 × 400)
 *   theme?: 'dark' | 'light'
 *   rtl?: boolean          Arabic layout: the value axis on the right, categories
 *                          run right-to-left, legend order mirrored; numbers stay LTR
 *   legend?: boolean       default: shown for 2+ series (pie: always)
 *
 * Every mark carries `role` (what it is) and, for data marks, `series`, `index`
 * and a `label` text for a tooltip/aria-label ("Sales · Jan: 120").
 */
import { arcPath, formatTick, niceTicks, pieAngles, textWidth, type Ticks } from './geometry';
import { CHART_THEMES, seriesColor } from './palette';

export type ChartType = 'bar' | 'line' | 'pie' | 'doughnut' | 'scatter';

export interface ValueSeries { name: string; values: ReadonlyArray<number | null> }
export interface PointSeries { name: string; points: ReadonlyArray<{ x: number; y: number }> }

export interface ChartSpec {
  type: ChartType;
  categories?: readonly string[];
  series: ReadonlyArray<ValueSeries | PointSeries>;
  stacked?: boolean;
  horizontal?: boolean;
  title?: string;
  xTitle?: string;
  yTitle?: string;
  width?: number;
  height?: number;
  theme?: 'dark' | 'light';
  rtl?: boolean;
  legend?: boolean;
}

export type Role = 'background' | 'title' | 'axis-title' | 'grid' | 'axis' | 'tick-label' | 'category-label' | 'bar' | 'line' | 'marker' | 'slice' | 'slice-label' | 'legend-swatch' | 'legend-label' | 'empty';

interface MarkBase { role: Role; series?: number; index?: number; label?: string }
export type Mark =
  | (MarkBase & { kind: 'rect'; x: number; y: number; w: number; h: number; fill: string; rx?: number })
  | (MarkBase & { kind: 'path'; d: string; fill: string; stroke?: string; strokeWidth?: number })
  | (MarkBase & { kind: 'line'; x1: number; y1: number; x2: number; y2: number; stroke: string; strokeWidth: number })
  | (MarkBase & { kind: 'circle'; cx: number; cy: number; r: number; fill: string; stroke?: string; strokeWidth?: number })
  | (MarkBase & {
    kind: 'text'; x: number; y: number; text: string; fill: string; size: number;
    anchor: 'start' | 'middle' | 'end'; weight?: number; rtl?: boolean; baseline?: 'middle' | 'hanging' | 'auto'; rotate?: number;
  });

export interface ChartScene {
  width: number;
  height: number;
  rtl: boolean;
  background: string;
  marks: Mark[];
  /** The plot rectangle (inside the axes). */
  plot: { x: number; y: number; w: number; h: number };
  /** The value axis ticks (bar/line/scatter y; horizontal bar x). */
  valueTicks?: Ticks;
  /** Scatter x ticks. */
  xTicks?: Ticks;
}

const PAD = 16;
const FONT = 12;
const TITLE = 16;
const RTL_TEXT = /[֐-ࣿ]/;

const isPoints = (s: ValueSeries | PointSeries): s is PointSeries => 'points' in s;

function num(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** A rectangle with 4px rounding on the data end only (the end away from the baseline). */
function barPath(x: number, y: number, w: number, h: number, end: 'top' | 'bottom' | 'left' | 'right'): string {
  const r = Math.max(0, Math.min(4, w / 2, h / 2));
  const R = (n: number): number => Math.round(n * 100) / 100;
  const [x0, y0, x1, y1] = [R(x), R(y), R(x + w), R(y + h)];
  switch (end) {
    case 'top': return `M${x0} ${y1}V${R(y0 + r)}Q${x0} ${y0} ${R(x0 + r)} ${y0}H${R(x1 - r)}Q${x1} ${y0} ${x1} ${R(y0 + r)}V${y1}Z`;
    case 'bottom': return `M${x0} ${y0}V${R(y1 - r)}Q${x0} ${y1} ${R(x0 + r)} ${y1}H${R(x1 - r)}Q${x1} ${y1} ${x1} ${R(y1 - r)}V${y0}Z`;
    case 'right': return `M${x0} ${y0}H${R(x1 - r)}Q${x1} ${y0} ${x1} ${R(y0 + r)}V${R(y1 - r)}Q${x1} ${y1} ${R(x1 - r)} ${y1}H${x0}Z`;
    default: return `M${x1} ${y0}H${R(x0 + r)}Q${x0} ${y0} ${x0} ${R(y0 + r)}V${R(y1 - r)}Q${x0} ${y1} ${R(x0 + r)} ${y1}H${x1}Z`;
  }
}

function fmtValue(v: number): string {
  return String(Number(v.toPrecision(10)));
}

export function buildChart(spec: ChartSpec): ChartScene {
  const width = Math.max(160, spec.width ?? 640);
  const height = Math.max(120, spec.height ?? 400);
  const themeName = spec.theme ?? 'dark';
  const theme = CHART_THEMES[themeName];
  const rtl = !!spec.rtl;
  const marks: Mark[] = [];
  const scene: ChartScene = { width, height, rtl, background: theme.surface, marks, plot: { x: 0, y: 0, w: 0, h: 0 } };
  const text = (x: number, y: number, t: string, role: Role, extra: Partial<Extract<Mark, { kind: 'text' }>> = {}): void => {
    marks.push({ kind: 'text', role, x, y, text: t, fill: theme.text2, size: FONT, anchor: 'middle', rtl: RTL_TEXT.test(t), baseline: 'auto', ...extra });
  };
  marks.push({ kind: 'rect', role: 'background', x: 0, y: 0, w: width, h: height, fill: theme.surface });

  let top = PAD;
  if (spec.title) {
    text(width / 2, top + TITLE * 0.8, spec.title, 'title', { fill: theme.text, size: TITLE, weight: 600 });
    top += TITLE + 12;
  }

  const series = spec.series;
  const pie = spec.type === 'pie' || spec.type === 'doughnut';
  const legendNames = pie ? (spec.categories ?? (series[0] && !isPoints(series[0]) ? series[0].values.map((_, i) => String(i + 1)) : [])) : series.map((s) => s.name);
  const showLegend = spec.legend ?? (pie || series.length > 1);
  let bottom = height - PAD;

  // Legend: one or more rows at the bottom, mirrored in RTL.
  if (showLegend && legendNames.length) {
    const items = legendNames.map((name, i) => ({ name, i, w: 12 + 6 + textWidth(name, FONT) + 16 }));
    const rows: typeof items[] = [[]];
    let rowW = 0;
    for (const it of items) {
      if (rowW + it.w > width - PAD * 2 && rows[rows.length - 1].length) { rows.push([]); rowW = 0; }
      rows[rows.length - 1].push(it);
      rowW += it.w;
    }
    const lineH = 20;
    bottom -= rows.length * lineH;
    rows.forEach((row, ri) => {
      const total = row.reduce((a, b) => a + b.w, 0) - 16;
      let x = rtl ? (width + total) / 2 : (width - total) / 2;
      const y = bottom + ri * lineH + lineH / 2 + 4;
      for (const it of row) {
        const color = seriesColor(it.i, themeName);
        const sx = rtl ? x - 12 : x;
        marks.push({ kind: 'rect', role: 'legend-swatch', x: sx, y: y - 6, w: 12, h: 12, rx: 3, fill: color, series: pie ? undefined : it.i, index: pie ? it.i : undefined });
        text(rtl ? sx - 6 : sx + 18, y, it.name, 'legend-label', { anchor: rtl ? 'end' : 'start', baseline: 'middle', series: pie ? undefined : it.i, index: pie ? it.i : undefined });
        x += rtl ? -it.w : it.w;
      }
    });
    bottom -= 8;
  }

  if (pie) {
    const s = series[0];
    const values = s && !isPoints(s) ? s.values : [];
    const slices = pieAngles(values);
    const cx = width / 2;
    const cy = (top + bottom) / 2;
    const r = Math.max(10, Math.min(width - PAD * 2, bottom - top) / 2 - 4);
    const inner = spec.type === 'doughnut' ? r * 0.58 : 0;
    scene.plot = { x: cx - r, y: cy - r, w: r * 2, h: r * 2 };
    if (!slices.some((sl) => sl.value > 0)) {
      marks.push({ kind: 'circle', role: 'empty', cx, cy, r, fill: 'none', stroke: theme.axis, strokeWidth: 2 });
      return scene;
    }
    // RTL: slices run counter-clockwise from 12 o'clock, mirroring the reading direction.
    for (const sl of slices) {
      if (sl.value <= 0) continue;
      const [a, b] = rtl ? [Math.PI - sl.end, Math.PI - sl.start] : [sl.start, sl.end];
      const name = spec.categories?.[sl.index] ?? String(sl.index + 1);
      marks.push({
        kind: 'path', role: 'slice', d: arcPath(cx, cy, r, a, b, inner), fill: seriesColor(sl.index, themeName),
        stroke: theme.surface, strokeWidth: 2, index: sl.index, label: `${name}: ${fmtValue(sl.value)} (${Math.round(sl.fraction * 1000) / 10}%)`,
      });
      if (sl.fraction >= 0.05) {
        const mid = rtl ? Math.PI - sl.mid : sl.mid;
        const lr = inner ? (r + inner) / 2 : r * 0.66;
        text(cx + lr * Math.cos(mid), cy + lr * Math.sin(mid), `${Math.round(sl.fraction * 100)}%`, 'slice-label', { fill: '#ffffff', baseline: 'middle', weight: 600, index: sl.index });
      }
    }
    if (inner && spec.series[0]) {
      const total = slices.reduce((a, b) => a + b.value, 0);
      text(cx, cy, fmtValue(total), 'slice-label', { fill: theme.text, size: 18, weight: 600, baseline: 'middle' });
    }
    return scene;
  }

  // Cartesian charts.
  const horizontal = spec.type === 'bar' && !!spec.horizontal;
  const categories = spec.categories ?? [];
  const valueSeries = series.filter((s): s is ValueSeries => !isPoints(s));
  const n = spec.type === 'scatter' ? 0 : Math.max(categories.length, ...valueSeries.map((s) => s.values.length), 0);

  // Value range.
  let lo = Infinity;
  let hi = -Infinity;
  let xlo = Infinity;
  let xhi = -Infinity;
  if (spec.type === 'scatter') {
    for (const s of series) if (isPoints(s)) for (const p of s.points) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      lo = Math.min(lo, p.y); hi = Math.max(hi, p.y); xlo = Math.min(xlo, p.x); xhi = Math.max(xhi, p.x);
    }
  } else if (spec.type === 'bar' && spec.stacked) {
    for (let i = 0; i < n; i++) {
      let pos = 0;
      let neg = 0;
      for (const s of valueSeries) { const v = num(s.values[i]); if (v !== null) { if (v >= 0) pos += v; else neg += v; } }
      hi = Math.max(hi, pos); lo = Math.min(lo, neg);
    }
  } else {
    for (const s of valueSeries) for (const v of s.values) { const x = num(v); if (x !== null) { lo = Math.min(lo, x); hi = Math.max(hi, x); } }
  }
  if (lo === Infinity) { lo = 0; hi = 1; }
  if (spec.type === 'bar') { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  const yt = niceTicks(lo, hi, horizontal ? 5 : Math.max(3, Math.min(8, Math.floor((bottom - top) / 48))));
  scene.valueTicks = yt;
  const xt = spec.type === 'scatter' ? niceTicks(xlo === Infinity ? 0 : xlo, xhi === -Infinity ? 1 : xhi, 6) : undefined;
  scene.xTicks = xt;

  // Margins: value labels on the left (right in RTL), category labels below.
  const valueLabels = yt.ticks.map((v) => formatTick(v, yt.step));
  const catLabels = horizontal ? categories.map(String) : valueLabels;
  const sideW = Math.min(width * 0.3, Math.max(...catLabels.map((t) => textWidth(t, FONT)), 0) + 8) + (spec.yTitle ? 20 : 0);
  if (spec.xTitle) bottom -= 20;
  const axisBand = 20;
  const plot = {
    x: rtl ? PAD : PAD + sideW,
    y: top + 4,
    w: width - PAD * 2 - sideW,
    h: Math.max(20, bottom - axisBand - (top + 4)),
  };
  scene.plot = plot;
  const plotBottom = plot.y + plot.h;
  if (spec.yTitle) {
    const x = rtl ? width - PAD - 6 : PAD + 6;
    text(x, plot.y + plot.h / 2, spec.yTitle, 'axis-title', { rotate: rtl ? 90 : -90, baseline: 'middle' });
  }
  if (spec.xTitle) text(plot.x + plot.w / 2, bottom + 16, spec.xTitle, 'axis-title');

  // Scales.
  const vToPx = (v: number): number => (horizontal
    ? (rtl ? plot.x + plot.w - ((v - yt.min) / (yt.max - yt.min)) * plot.w : plot.x + ((v - yt.min) / (yt.max - yt.min)) * plot.w)
    : plotBottom - ((v - yt.min) / (yt.max - yt.min)) * plot.h);
  const band = n ? (horizontal ? plot.h : plot.w) / n : 0;
  const catStart = (i: number): number => {
    if (horizontal) return plot.y + i * band;
    return rtl ? plot.x + plot.w - (i + 1) * band : plot.x + i * band;
  };
  const xToPx = (x: number): number => (xt ? (rtl ? plot.x + plot.w - ((x - xt.min) / (xt.max - xt.min)) * plot.w : plot.x + ((x - xt.min) / (xt.max - xt.min)) * plot.w) : 0);

  // Grid and value labels.
  yt.ticks.forEach((v, i) => {
    const p = vToPx(v);
    if (horizontal) {
      marks.push({ kind: 'line', role: v === 0 ? 'axis' : 'grid', x1: p, y1: plot.y, x2: p, y2: plotBottom, stroke: v === 0 ? theme.axis : theme.grid, strokeWidth: 1 });
      text(p, plotBottom + 16, valueLabels[i], 'tick-label', { fill: theme.text3 });
    } else {
      marks.push({ kind: 'line', role: v === 0 ? 'axis' : 'grid', x1: plot.x, y1: p, x2: plot.x + plot.w, y2: p, stroke: v === 0 ? theme.axis : theme.grid, strokeWidth: 1 });
      text(rtl ? plot.x + plot.w + 8 : plot.x - 8, p, valueLabels[i], 'tick-label', { fill: theme.text3, anchor: rtl ? 'start' : 'end', baseline: 'middle' });
    }
  });
  if (xt) {
    xt.ticks.forEach((v) => {
      const p = xToPx(v);
      marks.push({ kind: 'line', role: 'grid', x1: p, y1: plot.y, x2: p, y2: plotBottom, stroke: theme.grid, strokeWidth: 1 });
      text(p, plotBottom + 16, formatTick(v, xt.step), 'tick-label', { fill: theme.text3 });
    });
  } else {
    // Category labels (every k-th when crowded).
    const maxW = Math.max(...categories.map((c) => textWidth(String(c), FONT)), 1);
    const every = horizontal ? Math.max(1, Math.ceil(16 / Math.max(1, band))) : Math.max(1, Math.ceil((maxW + 8) / Math.max(1, band)));
    categories.forEach((c, i) => {
      if (i % every) return;
      if (horizontal) text(rtl ? plot.x + plot.w + 8 : plot.x - 8, catStart(i) + band / 2, String(c), 'category-label', { anchor: rtl ? 'start' : 'end', baseline: 'middle', index: i });
      else text(catStart(i) + band / 2, plotBottom + 16, String(c), 'category-label', { index: i });
    });
    if (!horizontal && spec.type === 'line') marks.push({ kind: 'line', role: 'axis', x1: plot.x, y1: plotBottom, x2: plot.x + plot.w, y2: plotBottom, stroke: theme.axis, strokeWidth: 1 });
  }

  const catName = (i: number): string => String(categories[i] ?? i + 1);

  if (spec.type === 'bar') {
    const groups = spec.stacked ? 1 : valueSeries.length || 1;
    const inner = band * 0.72;
    const gap = groups > 1 ? 2 : 0;
    const barW = Math.max(1, (inner - gap * (groups - 1)) / groups);
    for (let i = 0; i < n; i++) {
      let pos = 0;
      let neg = 0;
      valueSeries.forEach((s, si) => {
        const v = num(s.values[i]);
        if (v === null || v === 0) return;
        let a: number;
        let b: number;
        if (spec.stacked) {
          if (v >= 0) { a = pos; b = pos + v; pos = b; } else { a = neg; b = neg + v; neg = b; }
        } else { a = 0; b = v; }
        const offset = spec.stacked ? 0 : si * (barW + gap);
        const slot = catStart(i) + (band - inner) / 2 + (horizontal ? offset : rtl ? inner - offset - barW : offset);
        const pa = vToPx(a);
        const pb = vToPx(b);
        // Stacked segments leave a 2px surface gap where they meet.
        const joinGap = spec.stacked && a !== 0 ? 2 : 0;
        let d: string;
        if (horizontal) {
          const x0 = Math.min(pa, pb);
          const w = Math.abs(pb - pa);
          const growsRight = pb > pa;
          const xs = growsRight ? x0 + joinGap : x0;
          d = barPath(xs, slot, Math.max(0.5, w - joinGap), barW, growsRight ? 'right' : 'left');
        } else {
          const y0 = Math.min(pa, pb);
          const h = Math.abs(pb - pa);
          const up = pb < pa;
          d = barPath(slot, y0, barW, Math.max(0.5, h - joinGap), up ? 'top' : 'bottom');
          if (!up) d = barPath(slot, y0 + joinGap, barW, Math.max(0.5, h - joinGap), 'bottom');
        }
        marks.push({ kind: 'path', role: 'bar', d, fill: seriesColor(si, themeName), series: si, index: i, label: `${s.name} · ${catName(i)}: ${fmtValue(v)}` });
      });
    }
  } else if (spec.type === 'line') {
    valueSeries.forEach((s, si) => {
      const color = seriesColor(si, themeName);
      let d = '';
      let pen = false;
      const pts: Array<[number, number, number]> = [];
      for (let i = 0; i < n; i++) {
        const v = num(s.values[i]);
        if (v === null) { pen = false; continue; }
        const x = catStart(i) + band / 2;
        const y = vToPx(v);
        d += `${pen ? 'L' : 'M'}${Math.round(x * 100) / 100} ${Math.round(y * 100) / 100}`;
        pen = true;
        pts.push([x, y, i]);
      }
      if (d) marks.push({ kind: 'path', role: 'line', d, fill: 'none', stroke: color, strokeWidth: 2, series: si, label: s.name });
      if (n <= 40) for (const [x, y, i] of pts) {
        marks.push({ kind: 'circle', role: 'marker', cx: x, cy: y, r: 4, fill: color, stroke: theme.surface, strokeWidth: 2, series: si, index: i, label: `${s.name} · ${catName(i)}: ${fmtValue(s.values[i] as number)}` });
      }
    });
  } else {
    series.forEach((s, si) => {
      if (!isPoints(s)) return;
      const color = seriesColor(si, themeName);
      s.points.forEach((p, i) => {
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
        marks.push({ kind: 'circle', role: 'marker', cx: xToPx(p.x), cy: vToPx(p.y), r: 4, fill: color, stroke: theme.surface, strokeWidth: 2, series: si, index: i, label: `${s.name}: (${fmtValue(p.x)}, ${fmtValue(p.y)})` });
      });
    });
  }
  return scene;
}
