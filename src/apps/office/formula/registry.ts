/**
 * Office Calc engine — the function registry (سجل الدوال).
 *
 *   registerFunction(name, impl, { minArgs, maxArgs, volatile?, xlfn?, aliases? })
 *   getFunction(name)   → { name, impl, meta } | undefined (case-insensitive, aliases too)
 *   canonicalName(name) → the registered English name ("مجموع" → "SUM"), or the name upper-cased
 *   listFunctions()     → every registered canonical name, sorted
 *
 * An implementation receives its evaluated arguments — scalars, or Areas for
 * references and arrays (a single-cell reference is a 1×1 Area, so ROW(A5) and
 * SUM's "ignore text in references" rule both work) — and a CallContext. It
 * returns a Value; errors are returned (CellError), never thrown. Arity is checked
 * by the evaluator before the call (#VALUE! when wrong). `volatile` functions
 * (TODAY, NOW, OFFSET, RAND…) make their formula recalculate on every recalc().
 * `xlfn` marks functions newer than Excel 2007 that must be written `_xlfn.NAME` in files.
 */
import type { Area, Scalar, Value } from './values';

export interface CallContext {
  /** Where the formula lives (zero-based), for ROW()/COLUMN() and implicit intersection. */
  readonly row: number;
  readonly col: number;
  readonly sheetId: number;
  /** The clock (TODAY/NOW). */
  now(): Date;
  /** A value as one scalar: a 1×1 area's value, otherwise Excel's implicit intersection with the formula's row/column. */
  scalar(v: Value): Scalar;
  /** A reference to a rectangle of the sheet `sheetId` (OFFSET), or null when it leaves the sheet. */
  makeRef(sheetId: number, row: number, col: number, rows: number, cols: number): Area | null;
  /**
   * An exact-match index of one row/column vector of a reference ("s:text" / "n:1" / "b:true" → first
   * zero-based position), built on repeated use and dropped when a cell in it changes. Undefined when
   * the area is not a sheet reference or the index is not (yet) worth building.
   */
  exactIndex(area: Area, axis: 'col' | 'row', index: number, fromEnd: boolean): Map<string, number> | undefined;
}

export type FunctionImpl = (args: Value[], ctx: CallContext) => Value;

export interface FunctionMeta {
  minArgs: number;
  /** Use Infinity for "as many as you like" (Excel allows 255). */
  maxArgs: number;
  volatile?: boolean;
  xlfn?: boolean;
  aliases?: string[];
}

export interface RegisteredFunction { name: string; impl: FunctionImpl; meta: FunctionMeta }

const functions = new Map<string, RegisteredFunction>();
const aliases = new Map<string, string>();

const key = (name: string): string => name.trim().toUpperCase();

/** Adds (or replaces) a function. */
export function registerFunction(name: string, impl: FunctionImpl, meta: FunctionMeta): void {
  const canonical = key(name);
  functions.set(canonical, { name: canonical, impl, meta });
  for (const alias of meta.aliases ?? []) aliases.set(key(alias), canonical);
}

export function getFunction(name: string): RegisteredFunction | undefined {
  const k = key(name);
  return functions.get(k) ?? functions.get(aliases.get(k) ?? '');
}

export function canonicalName(name: string): string {
  const k = key(name);
  if (functions.has(k)) return k;
  return aliases.get(k) ?? k;
}

export function listFunctions(): string[] {
  return [...functions.keys()].sort();
}
