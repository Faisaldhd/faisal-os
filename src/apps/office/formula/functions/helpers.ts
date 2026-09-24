/**
 * Shared argument helpers for the built-in functions: Excel's rules for which
 * values an aggregate counts, criteria strings (">=10", "<>", "a*"), wildcards,
 * and lookup matching. Internal to the engine; not part of the lead's API.
 */
import type { CallContext } from '../registry';
import {
  ArrayArea, ERR, RefArea, compareScalars, errorFromText, isArea, isError, textToNumber, toBool, toNumber, toText,
  type Area, type CellError, type Scalar, type Value,
} from '../values';

/** Visits every cell of an area within its used extent. Return false from `fn` to stop. */
export function eachCell(area: Area, fn: (v: Scalar, r: number, c: number) => boolean | void): void {
  const rows = area.extentRows;
  const cols = area.extentCols;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) if (fn(area.get(r, c), r, c) === false) return;
  }
}

/**
 * The numbers an aggregate (SUM, AVERAGE, MIN…) sees: in references and arrays
 * only real numbers count (text, TRUE and blanks are skipped); a direct argument
 * is coerced ("3" and TRUE count, "abc" is #VALUE!). The first error wins.
 */
export function collectNumbers(args: Value[], opts: { skipDirectErrors?: boolean } = {}): number[] | CellError {
  const out: number[] = [];
  for (const arg of args) {
    if (isArea(arg)) {
      let err: CellError | undefined;
      eachCell(arg, (v) => {
        if (typeof v === 'number') out.push(v);
        else if (isError(v)) { err = v; return false; }
        return true;
      });
      if (err) return err;
    } else if (arg !== null) {
      const n = toNumber(arg);
      if (isError(n)) { if (opts.skipDirectErrors) continue; return n; }
      out.push(n);
    }
  }
  return out;
}

/** Every scalar of the arguments, areas flattened row by row (blanks included). */
export function flattenValues(args: Value[]): Scalar[] {
  const out: Scalar[] = [];
  for (const arg of args) {
    if (isArea(arg)) eachCell(arg, (v) => { out.push(v); });
    else out.push(arg);
  }
  return out;
}

export function num(v: Value, ctx: CallContext): number | CellError {
  return toNumber(ctx.scalar(v));
}

export function text(v: Value, ctx: CallContext): string | CellError {
  return toText(ctx.scalar(v));
}

export function bool(v: Value, ctx: CallContext): boolean | CellError {
  return toBool(ctx.scalar(v));
}

/** An optional numeric argument (missing or blank → fallback). */
export function optNum(args: Value[], i: number, fallback: number, ctx: CallContext): number | CellError {
  if (i >= args.length || args[i] === null) return fallback;
  return num(args[i], ctx);
}

/** An argument as an area (a scalar becomes 1×1). */
export function asArea(v: Value): Area {
  return isArea(v) ? v : new ArrayArea([[v]]);
}

/** The first error among already-coerced values, if any. */
export function firstError(...values: unknown[]): CellError | undefined {
  return values.find(isError) as CellError | undefined;
}

/* ───────────────────────────── wildcards ───────────────────────────── */

const wildcardCache = new Map<string, RegExp>();

/** Excel wildcards: * any run, ? one character, ~ escapes. Case-insensitive, whole text. */
export function wildcardRegex(pattern: string): RegExp {
  let re = wildcardCache.get(pattern);
  if (re) return re;
  let src = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '~' && i + 1 < pattern.length && '*?~'.includes(pattern[i + 1])) { src += `\\${pattern[++i]}`; continue; }
    if (ch === '*') src += '[\\s\\S]*';
    else if (ch === '?') src += '[\\s\\S]';
    else src += ch.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
  }
  re = new RegExp(`^${src}$`, 'i');
  if (wildcardCache.size > 500) wildcardCache.clear();
  wildcardCache.set(pattern, re);
  return re;
}

export function hasWildcard(s: string): boolean {
  return /[*?~]/.test(s);
}

/* ───────────────────────────── criteria ───────────────────────────── */

/**
 * A SUMIF/COUNTIF criterion as a test. A number or TRUE matches equal cells; a
 * text may start with = <> < > <= >=; the rest is a number (numeric compare), a
 * boolean, an error text, or text (case-insensitive, with wildcards for = and <>).
 * "" matches blanks, "<>" matches non-blanks.
 */
export function makeCriterion(criterion: Scalar): (v: Scalar) => boolean {
  if (criterion === null) criterion = 0;
  if (typeof criterion === 'number') {
    const c = criterion;
    return (v) => (typeof v === 'number' ? v === c : typeof v === 'string' ? textToNumber(v) === c : false);
  }
  if (typeof criterion === 'boolean') { const c = criterion; return (v) => v === c; }
  if (isError(criterion)) { const c = criterion; return (v) => v === c; }
  const m = /^(<=|>=|<>|<|>|=)?([\s\S]*)$/.exec(criterion)!;
  const op = m[1] ?? '=';
  const rest = m[2];
  if (rest === '') {
    if (op === '=') return (v) => v === null || v === '';
    if (op === '<>') return (v) => !(v === null || v === '');
    return () => false;
  }
  const n = textToNumber(rest);
  if (n !== null) {
    const numOf = (v: Scalar): number | null => (typeof v === 'number' ? v : null);
    switch (op) {
      case '=': return (v) => (typeof v === 'number' ? v === n : typeof v === 'string' ? textToNumber(v) === n : false);
      case '<>': return (v) => !(typeof v === 'number' ? v === n : typeof v === 'string' ? textToNumber(v) === n : false);
      case '<': return (v) => { const x = numOf(v); return x !== null && x < n; };
      case '>': return (v) => { const x = numOf(v); return x !== null && x > n; };
      case '<=': return (v) => { const x = numOf(v); return x !== null && x <= n; };
      default: return (v) => { const x = numOf(v); return x !== null && x >= n; };
    }
  }
  const upper = rest.toUpperCase();
  if (upper === 'TRUE' || upper === 'FALSE') {
    const b = upper === 'TRUE';
    if (op === '=') return (v) => v === b;
    if (op === '<>') return (v) => v !== b;
  }
  const err = errorFromText(rest);
  if (err) {
    if (op === '=') return (v) => v === err;
    if (op === '<>') return (v) => v !== err;
  }
  if (op === '=' || op === '<>') {
    const re = hasWildcard(rest) ? wildcardRegex(rest) : null;
    const lower = rest.toLowerCase();
    const eq = (v: Scalar): boolean => typeof v === 'string' && (re ? re.test(v) : v.toLowerCase() === lower);
    return op === '=' ? eq : (v) => !eq(v);
  }
  return (v) => {
    if (typeof v !== 'string') return false;
    const c = compareScalars(v, rest);
    return op === '<' ? c < 0 : op === '>' ? c > 0 : op === '<=' ? c <= 0 : c >= 0;
  };
}

/** A criteria range and a result range of the same shape (Excel reads the result from the same top-left, same size). */
export function resizeLike(area: Area, like: Area): Area {
  if (area instanceof RefArea) return area.sub(0, 0, like.rows, like.cols);
  return area;
}

/* ───────────────────────────── lookups ───────────────────────────── */

/** The key an exact-match index uses for a value (numbers, case-folded text, booleans). */
export function lookupKey(v: Scalar): string | null {
  if (typeof v === 'number') return `n:${v}`;
  if (typeof v === 'string') return v === '' ? null : `s:${v.toLowerCase()}`;
  if (typeof v === 'boolean') return `b:${v}`;
  return null;
}

/** True when a candidate equals the needle for an exact lookup (wildcards when allowed and present). */
export function exactMatch(needle: Scalar, candidate: Scalar, wildcards: boolean): boolean {
  if (needle === null || candidate === null || isError(candidate) || isError(needle)) return false;
  if (typeof needle === 'string') {
    if (typeof candidate !== 'string') return false;
    if (wildcards && hasWildcard(needle)) return wildcardRegex(needle).test(candidate);
    return needle.toLowerCase() === candidate.toLowerCase();
  }
  return typeof candidate === typeof needle && candidate === needle;
}

/** One vector (row or column) of an area as a getter + length. */
export interface Vector { length: number; get(i: number): Scalar }

export function vectorOf(area: Area, axis: 'col' | 'row', index: number): Vector {
  if (axis === 'col') return { length: area.extentRows, get: (i) => area.get(i, index) };
  return { length: area.extentCols, get: (i) => area.get(index, i) };
}

/** A 1-D area as a vector, or undefined when it is 2-D. */
export function asVector(area: Area): Vector | undefined {
  if (area.cols === 1) return vectorOf(area, 'col', 0);
  if (area.rows === 1) return vectorOf(area, 'row', 0);
  return undefined;
}

/**
 * Position of the needle in a vector. mode 0 = exact, -1 = exact or next smaller,
 * 1 = exact or next larger; `sorted` = Excel's approximate search in sorted data
 * (last item <= needle for ascending, last >= for descending).
 */
export function findInVector(
  vec: Vector, needle: Scalar, mode: 0 | -1 | 1, opts: { wildcards: boolean; reverse?: boolean; sorted?: 'asc' | 'desc'; index?: Map<string, number> },
): number {
  if (opts.sorted) {
    let found = -1;
    for (let i = 0; i < vec.length; i++) {
      const v = vec.get(i);
      if (v === null || isError(v) || isError(needle) || typeof v !== typeof needle) continue;
      const c = compareScalars(v, needle as Exclude<Scalar, CellError>);
      if (opts.sorted === 'asc') { if (c <= 0) found = i; else break; }
      else if (c >= 0) found = i; else break;
    }
    return found;
  }
  if (mode === 0 && opts.index && !(typeof needle === 'string' && opts.wildcards && hasWildcard(needle))) {
    const k = lookupKey(needle);
    return k === null ? -1 : opts.index.get(k) ?? -1;
  }
  let best = -1;
  let bestValue: Scalar = null;
  const n = vec.length;
  for (let step = 0; step < n; step++) {
    const i = opts.reverse ? n - 1 - step : step;
    const v = vec.get(i);
    if (exactMatch(needle, v, opts.wildcards)) return i;
    if (mode === 0 || v === null || isError(v) || isError(needle) || typeof v !== typeof needle) continue;
    const c = compareScalars(v, needle as Exclude<Scalar, CellError>);
    if (mode === -1 && c < 0 && (best < 0 || compareScalars(v, bestValue as Exclude<Scalar, CellError>) > 0)) { best = i; bestValue = v; }
    if (mode === 1 && c > 0 && (best < 0 || compareScalars(v, bestValue as Exclude<Scalar, CellError>) < 0)) { best = i; bestValue = v; }
  }
  return best;
}

export const NA: CellError = ERR.NA;
