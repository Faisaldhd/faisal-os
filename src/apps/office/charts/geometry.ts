/**
 * Office charts — axis ticks, pie angles, arc paths and text sizing. Pure math.
 *
 *   niceTicks(min, max, maxTicks = 6) → { min, max, step, ticks }   round axis steps (1, 2, 2.5, 5 × 10ⁿ)
 *   pieAngles(values, startAngle = -π/2) → [{ index, value, fraction, start, end, mid }]
 *       clockwise slices in radians (0 = 3 o'clock); negatives and blanks count as 0
 *   arcPath(cx, cy, r, start, end, innerR = 0) → an SVG path for a slice or doughnut segment
 *   textWidth(text, size) → an estimate of rendered width (no DOM available)
 *   formatTick(value, step) → tick label text without float noise (1.5K, 2M for big values)
 */

export interface Ticks { min: number; max: number; step: number; ticks: number[] }

function niceStep(raw: number): number {
  const exp = Math.floor(Math.log10(raw));
  const base = 10 ** exp;
  const f = raw / base;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * base;
}

/** Round ticks covering [min, max]; the range always includes 0 when the data has one sign only and starts near it. */
export function niceTicks(min: number, max: number, maxTicks = 6): Ticks {
  if (!Number.isFinite(min) || !Number.isFinite(max)) { min = 0; max = 1; }
  if (min > max) [min, max] = [max, min];
  if (min === max) {
    if (min === 0) { max = 1; } else if (min > 0) { min = 0; } else { max = 0; }
  }
  const step = niceStep((max - min) / Math.max(1, maxTicks - 1));
  const lo = Math.floor(min / step + 1e-9) * step;
  const hi = Math.ceil(max / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let v = lo, i = 0; v <= hi + step * 1e-9 && i < 100; v = lo + step * ++i) ticks.push(Number(v.toPrecision(12)));
  return { min: ticks[0], max: ticks[ticks.length - 1], step, ticks };
}

export interface PieSlice { index: number; value: number; fraction: number; start: number; end: number; mid: number }

export function pieAngles(values: ReadonlyArray<number | null | undefined>, startAngle = -Math.PI / 2): PieSlice[] {
  const clean = values.map((v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0));
  const total = clean.reduce((a, b) => a + b, 0);
  let at = startAngle;
  return clean.map((value, index) => {
    const fraction = total ? value / total : 0;
    const start = at;
    const end = at + fraction * Math.PI * 2;
    at = end;
    return { index, value, fraction, start, end, mid: (start + end) / 2 };
  });
}

const f = (n: number): string => String(Math.round(n * 100) / 100);

/** SVG path of a pie slice (innerR = 0) or doughnut segment; a full circle is drawn as two halves. */
export function arcPath(cx: number, cy: number, r: number, start: number, end: number, innerR = 0): string {
  const sweep = end - start;
  if (sweep <= 0) return '';
  if (sweep >= Math.PI * 2 - 1e-9) {
    const outer = `M${f(cx + r)} ${f(cy)}A${f(r)} ${f(r)} 0 1 1 ${f(cx - r)} ${f(cy)}A${f(r)} ${f(r)} 0 1 1 ${f(cx + r)} ${f(cy)}Z`;
    if (!innerR) return outer;
    return `${outer}M${f(cx + innerR)} ${f(cy)}A${f(innerR)} ${f(innerR)} 0 1 0 ${f(cx - innerR)} ${f(cy)}A${f(innerR)} ${f(innerR)} 0 1 0 ${f(cx + innerR)} ${f(cy)}Z`;
  }
  const large = sweep > Math.PI ? 1 : 0;
  const p = (radius: number, a: number): string => `${f(cx + radius * Math.cos(a))} ${f(cy + radius * Math.sin(a))}`;
  if (!innerR) return `M${f(cx)} ${f(cy)}L${p(r, start)}A${f(r)} ${f(r)} 0 ${large} 1 ${p(r, end)}Z`;
  return `M${p(r, start)}A${f(r)} ${f(r)} 0 ${large} 1 ${p(r, end)}L${p(innerR, end)}A${f(innerR)} ${f(innerR)} 0 ${large} 0 ${p(innerR, start)}Z`;
}

/** A width estimate for a label (Latin ≈ 0.56em per character, Arabic ≈ 0.5em, digits 0.6em). */
export function textWidth(text: string, size: number): number {
  let w = 0;
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    w += c >= 0x600 && c <= 0x6ff ? 0.5 : /[0-9]/.test(ch) ? 0.6 : /[mwMW]/.test(ch) ? 0.8 : /[il.,:;|' ]/.test(ch) ? 0.3 : 0.56;
  }
  return w * size;
}

/** A tick label: no float noise, and K/M/B for large round values. */
export function formatTick(value: number, step: number): string {
  const abs = Math.abs(value);
  const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  const short = (div: number, suffix: string): string => `${Number((value / div).toFixed(2))}${suffix}`;
  if (abs >= 1e9) return short(1e9, 'B');
  if (abs >= 1e6) return short(1e6, 'M');
  if (abs >= 1e4) return short(1e3, 'K');
  return String(Number(value.toFixed(Math.min(10, decimals))));
}
