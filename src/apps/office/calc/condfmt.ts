/**
 * Office Calc — conditional formatting (التنسيق الشرطي). Pure, DOM-free.
 *
 *   evaluateConditionalFormats(values, rules) → (CellStyle | null)[][]
 *       one style per cell of `values` (a rectangle: grid strings or scalars);
 *       null when no rule applies.
 *   interpolateColor(a, b, t) → the hex colour between two hex colours
 *
 * Rules are in priority order, as in Excel: when two matching rules set the same
 * property the earlier one wins, and stopIfTrue stops later rules for that cell.
 * Colour scales and data bars combine with rule styles:
 *   { type: 'colorScale', min: Stop, mid?: Stop, max: Stop }        2- or 3-point scale → fill
 *       Stop = { kind: 'min' | 'max' | 'number' | 'percent' | 'percentile', value?, color }
 *   { type: 'dataBar', color, min?: Stop-less bounds, max?, showValue? } → bar { start, end, negative }
 *       (fractions 0–1 of the cell width; a negative value grows left from the zero axis)
 *   { type: 'cellIs', op: 'gt' | 'lt' | 'gte' | 'lte' | 'eq' | 'neq' | 'between' | 'notBetween', value, value2?, style }
 *   { type: 'text', op: 'contains' | 'notContains' | 'begins' | 'ends', text, style }  (case-insensitive)
 *   { type: 'blank' | 'notBlank' | 'error' | 'duplicate' | 'unique', style }
 *   { type: 'top', count, bottom?, percent?, style }
 *   { type: 'average', below?, style }
 * CellStyle = { fill?, color?, bold?, italic?, underline?, strike?, bar?, hideValue? }
 */
import { isError, scalarFromText, type Scalar } from '../formula/values';

export interface CellStyle {
  fill?: string;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  bar?: { start: number; end: number; color: string; negative: boolean };
  hideValue?: boolean;
}

export interface ScaleStop { kind: 'min' | 'max' | 'number' | 'percent' | 'percentile'; value?: number; color: string }
type RuleStyle = Omit<CellStyle, 'bar' | 'hideValue'>;

export type CondRule =
  | { type: 'colorScale'; min: ScaleStop; mid?: ScaleStop; max: ScaleStop }
  | { type: 'dataBar'; color: string; negativeColor?: string; min?: number; max?: number; showValue?: boolean }
  | { type: 'cellIs'; op: 'gt' | 'lt' | 'gte' | 'lte' | 'eq' | 'neq' | 'between' | 'notBetween'; value: number | string; value2?: number; style: RuleStyle; stopIfTrue?: boolean }
  | { type: 'text'; op: 'contains' | 'notContains' | 'begins' | 'ends'; text: string; style: RuleStyle; stopIfTrue?: boolean }
  | { type: 'blank' | 'notBlank' | 'error' | 'duplicate' | 'unique'; style: RuleStyle; stopIfTrue?: boolean }
  | { type: 'top'; count: number; bottom?: boolean; percent?: boolean; style: RuleStyle; stopIfTrue?: boolean }
  | { type: 'average'; below?: boolean; style: RuleStyle; stopIfTrue?: boolean };

type Input = string | number | boolean | null | undefined | Scalar;

function typed(v: Input): Scalar {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return v.trim() === '' ? null : scalarFromText(v);
  return v;
}

function hex(c: string): [number, number, number] {
  let s = c.replace('#', '');
  if (s.length === 3) s = s.split('').map((ch) => ch + ch).join('');
  const n = parseInt(s.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function interpolateColor(a: string, b: string, t: number): string {
  const x = hex(a);
  const y = hex(b);
  const k = Math.max(0, Math.min(1, t));
  return `#${x.map((v, i) => Math.round(v + (y[i] - v) * k).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * Math.max(0, Math.min(1, p / 100));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function stopValue(stop: ScaleStop, sorted: number[], fallback: number): number {
  const lo = sorted[0] ?? 0;
  const hi = sorted[sorted.length - 1] ?? 0;
  switch (stop.kind) {
    case 'min': return lo;
    case 'max': return hi;
    case 'number': return stop.value ?? fallback;
    case 'percent': return lo + ((hi - lo) * (stop.value ?? 50)) / 100;
    default: return percentile(sorted, stop.value ?? 50);
  }
}

function merge(into: CellStyle | null, add: RuleStyle): CellStyle {
  return { ...add, ...(into ?? {}) }; // the earlier (higher-priority) rule keeps its properties
}

export function evaluateConditionalFormats(values: ReadonlyArray<ReadonlyArray<Input>>, rules: readonly CondRule[]): Array<Array<CellStyle | null>> {
  const cells = values.map((row) => row.map(typed));
  const out: Array<Array<CellStyle | null>> = cells.map((row) => row.map(() => null));
  const stopped = cells.map((row) => row.map(() => false));
  const numbers: number[] = [];
  const counts = new Map<string, number>();
  for (const row of cells) for (const v of row) {
    if (typeof v === 'number') numbers.push(v);
    if (v !== null && !isError(v)) {
      const k = typeof v === 'string' ? `s:${v.toLowerCase()}` : `${typeof v}:${String(v)}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  const sorted = [...numbers].sort((a, b) => a - b);
  const average = numbers.length ? numbers.reduce((a, b) => a + b, 0) / numbers.length : 0;
  const keyOf = (v: Scalar): string => (typeof v === 'string' ? `s:${v.toLowerCase()}` : `${typeof v}:${String(v)}`);

  for (const rule of rules) {
    if (rule.type === 'colorScale') {
      if (!sorted.length) continue;
      const lo = stopValue(rule.min, sorted, sorted[0]);
      const hi = stopValue(rule.max, sorted, sorted[sorted.length - 1]);
      const mid = rule.mid ? stopValue(rule.mid, sorted, (lo + hi) / 2) : undefined;
      cells.forEach((row, r) => row.forEach((v, c) => {
        if (typeof v !== 'number' || stopped[r][c]) return;
        let color: string;
        if (rule.mid && mid !== undefined) {
          color = v <= mid
            ? interpolateColor(rule.min.color, rule.mid.color, mid === lo ? 1 : (v - lo) / (mid - lo))
            : interpolateColor(rule.mid.color, rule.max.color, hi === mid ? 1 : (v - mid) / (hi - mid));
        } else color = interpolateColor(rule.min.color, rule.max.color, hi === lo ? 0.5 : (v - lo) / (hi - lo));
        out[r][c] = { ...(out[r][c] ?? {}), fill: color };
      }));
      continue;
    }
    if (rule.type === 'dataBar') {
      if (!sorted.length) continue;
      const lo = Math.min(rule.min ?? Math.min(0, sorted[0]), 0);
      const hi = Math.max(rule.max ?? Math.max(0, sorted[sorted.length - 1]), 0);
      const span = hi - lo || 1;
      const axis = lo === 0 ? 0 : -lo / span; // where zero sits, 0–1 from the start edge
      cells.forEach((row, r) => row.forEach((v, c) => {
        if (typeof v !== 'number' || stopped[r][c]) return;
        const x = Math.max(lo, Math.min(hi, v));
        const pos = (x - lo) / span;
        const negative = v < 0;
        const bar = { start: Math.min(axis, pos), end: Math.max(axis, pos), color: negative ? rule.negativeColor ?? '#E5484D' : rule.color, negative };
        out[r][c] = { ...(out[r][c] ?? {}), bar, ...(rule.showValue === false ? { hideValue: true } : {}) };
      }));
      continue;
    }
    const n = sorted.length;
    const topEdge = rule.type === 'top' && n
      ? (() => {
        const k = rule.percent ? Math.max(1, Math.floor((n * rule.count) / 100)) : Math.floor(rule.count);
        if (k <= 0) return undefined;
        return rule.bottom ? sorted[Math.min(k, n) - 1] : sorted[n - Math.min(k, n)];
      })()
      : undefined;
    const test = (v: Scalar): boolean => {
      switch (rule.type) {
        case 'cellIs': {
          const target = rule.value;
          if (typeof target === 'string' && (rule.op === 'eq' || rule.op === 'neq')) {
            const eq = typeof v === 'string' ? v.toLowerCase() === target.toLowerCase() : typeof v === 'number' && Number(target) === v;
            return rule.op === 'eq' ? eq : !eq;
          }
          if (typeof v !== 'number') return rule.op === 'neq';
          const a = Number(target);
          const b = rule.value2 ?? a;
          switch (rule.op) {
            case 'gt': return v > a;
            case 'lt': return v < a;
            case 'gte': return v >= a;
            case 'lte': return v <= a;
            case 'eq': return v === a;
            case 'neq': return v !== a;
            case 'between': return v >= Math.min(a, b) && v <= Math.max(a, b);
            default: return v < Math.min(a, b) || v > Math.max(a, b);
          }
        }
        case 'text': {
          const s = v === null ? '' : isError(v) ? v.code : String(typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : v).toLowerCase();
          const t = rule.text.toLowerCase();
          if (rule.op === 'contains') return s.includes(t);
          if (rule.op === 'notContains') return !s.includes(t);
          if (rule.op === 'begins') return s.startsWith(t);
          return s.endsWith(t);
        }
        case 'blank': return v === null;
        case 'notBlank': return v !== null;
        case 'error': return isError(v);
        case 'duplicate': return v !== null && !isError(v) && (counts.get(keyOf(v)) ?? 0) > 1;
        case 'unique': return v !== null && !isError(v) && counts.get(keyOf(v)) === 1;
        case 'top': return typeof v === 'number' && topEdge !== undefined && (rule.bottom ? v <= topEdge : v >= topEdge);
        default: return typeof v === 'number' && n > 0 && (rule.below ? v < average : v > average);
      }
    };
    cells.forEach((row, r) => row.forEach((v, c) => {
      if (stopped[r][c] || !test(v)) return;
      out[r][c] = merge(out[r][c], rule.style);
      if (rule.stopIfTrue) stopped[r][c] = true;
    }));
  }
  return out;
}
