/**
 * Office Calc engine — the evaluator (المُقيِّم).
 *
 *   evaluateNode(ast, env) → Value
 *
 * `env` is an EvalEnv: a CallContext (see registry.ts) plus `resolveSheet(name)`
 * and the CellReader references read through. The Workbook builds one per
 * formula cell; `finalValue()` turns what a formula produced into the scalar the
 * cell stores (a reference gives its implicit intersection, an array its first
 * item, a blank 0).
 *
 * Operators follow Excel: + - * / ^ coerce text like "3" to numbers (#VALUE!
 * otherwise), & joins text, comparisons use Excel's ordering, % divides by 100.
 * An operator on ranges works item by item and returns an array, so
 * SUMPRODUCT((A1:A9>2)*B1:B9) works.
 */
import type { Node, RefNode } from './parser';
import { MAX_COLS, MAX_ROWS } from './parser';
import { getFunction, type CallContext } from './registry';
import {
  ArrayArea, CellError, ERR, RefArea, compareScalars, isArea, isError, toNumber, toText,
  type Area, type CellReader, type Scalar, type Value,
} from './values';
import './functions';

export interface EvalEnv extends CallContext {
  reader: CellReader;
  /** The id and canonical name of a sheet, or undefined when there is no such sheet. */
  resolveSheet(name: string | undefined): { id: number; name: string } | undefined;
}

/** A value as a scalar for a cell at (row, col) of sheetId: implicit intersection for references. */
export function implicitScalar(v: Value, row: number, col: number, sheetId: number): Scalar {
  if (!isArea(v)) return v;
  if (v.rows === 1 && v.cols === 1) return v.get(0, 0);
  if (v instanceof RefArea) {
    if (v.sheetId !== sheetId) return ERR.VALUE;
    if (v.cols === 1 && row >= v.row && row < v.row + v.rows) return v.get(row - v.row, 0);
    if (v.rows === 1 && col >= v.col && col < v.col + v.cols) return v.get(0, col - v.col);
    return ERR.VALUE;
  }
  if (v.rows === 0 || v.cols === 0) return ERR.VALUE;
  return v.get(0, 0);
}

/** The scalar a formula cell stores. */
export function finalValue(v: Value, env: EvalEnv): Scalar {
  const s = env.scalar(v);
  if (s === null) return 0;
  if (typeof s === 'number' && !Number.isFinite(s)) return ERR.NUM;
  return s;
}

function evalRef(ref: RefNode, env: EvalEnv): Value {
  const sheet = env.resolveSheet(ref.sheet);
  if (!sheet) return ERR.REF;
  return new RefArea(env.reader, sheet.id, sheet.name, ref.r1, ref.c1, ref.r2 - ref.r1 + 1, ref.c2 - ref.c1 + 1);
}

function arith(op: string, a: Scalar, b: Scalar): Scalar {
  if (op === '&') {
    const x = toText(a);
    if (isError(x)) return x;
    const y = toText(b);
    if (isError(y)) return y;
    return x + y;
  }
  if (op === '=' || op === '<>' || op === '<' || op === '>' || op === '<=' || op === '>=') {
    if (isError(a)) return a;
    if (isError(b)) return b;
    const c = compareScalars(a, b);
    switch (op) {
      case '=': return c === 0;
      case '<>': return c !== 0;
      case '<': return c < 0;
      case '>': return c > 0;
      case '<=': return c <= 0;
      default: return c >= 0;
    }
  }
  const x = toNumber(a);
  if (isError(x)) return x;
  const y = toNumber(b);
  if (isError(y)) return y;
  let r: number;
  switch (op) {
    case '+': r = x + y; break;
    case '-': r = x - y; break;
    case '*': r = x * y; break;
    case '/': if (y === 0) return ERR.DIV0; r = x / y; break;
    case '^':
      if (x === 0 && y === 0) return ERR.NUM;
      if (x === 0 && y < 0) return ERR.DIV0;
      r = x ** y;
      break;
    default: return ERR.VALUE;
  }
  return Number.isFinite(r) ? r : ERR.NUM;
}

/** Applies a scalar operation item by item when either side is a multi-cell area. */
function lift2(a: Value, b: Value, fn: (x: Scalar, y: Scalar) => Scalar): Value {
  const multi = (v: Value): v is Area => isArea(v) && !(v.rows === 1 && v.cols === 1);
  if (!multi(a) && !multi(b)) return fn(isArea(a) ? a.get(0, 0) : a, isArea(b) ? b.get(0, 0) : b);
  // Whole-column areas are clipped to the used part of the sheet; a real range keeps its size.
  const size = (v: Value): [number, number] => (isArea(v) ? [clipRows(v), clipCols(v)] : [1, 1]);
  const [ra, ca] = size(a);
  const [rb, cb] = size(b);
  const rows = Math.max(ra, rb);
  const cols = Math.max(ca, cb);
  const pick = (v: Value, r: number, c: number, vr: number, vc: number): Scalar => {
    if (!isArea(v)) return v;
    const rr = vr === 1 ? 0 : r;
    const cc = vc === 1 ? 0 : c;
    if (rr >= vr || cc >= vc) return ERR.NA;
    return v.get(rr, cc);
  };
  const data: Scalar[][] = [];
  for (let r = 0; r < rows; r++) {
    const line: Scalar[] = [];
    for (let c = 0; c < cols; c++) line.push(fn(pick(a, r, c, ra, ca), pick(b, r, c, rb, cb)));
    data.push(line);
  }
  return new ArrayArea(data);
}

/** A reference's row count for item-by-item work: whole columns are clipped to the sheet's used rows. */
function clipRows(v: Area): number {
  return v.rows >= MAX_ROWS ? v.extentRows : v.rows;
}
function clipCols(v: Area): number {
  return v.cols >= MAX_COLS ? v.extentCols : v.cols;
}

function lift1(a: Value, fn: (x: Scalar) => Scalar): Value {
  if (!isArea(a)) return fn(a);
  if (a.rows === 1 && a.cols === 1) return fn(a.get(0, 0));
  const rows = clipRows(a);
  const cols = clipCols(a);
  const data: Scalar[][] = [];
  for (let r = 0; r < rows; r++) {
    const line: Scalar[] = [];
    for (let c = 0; c < cols; c++) line.push(fn(a.get(r, c)));
    data.push(line);
  }
  return new ArrayArea(data);
}

export function evaluateNode(node: Node, env: EvalEnv, inCall = false): Value {
  // Outside any function, an operator applied to a range sees the range's implicit
  // intersection with the formula's row/column (=A1:A3*10 in row 2 reads A2), as
  // in Excel. Inside a function's arguments ranges work item by item (SUMPRODUCT).
  const operand = (n: Node): Value => {
    const v = evaluateNode(n, env, inCall);
    return !inCall && v instanceof RefArea ? env.scalar(v) : v;
  };
  switch (node.k) {
    case 'num': return node.v;
    case 'str': return node.v;
    case 'bool': return node.v;
    case 'err': return errorOf(node.v);
    case 'missing': return null;
    case 'ref': return evalRef(node, env);
    case 'name': return ERR.NAME;
    case 'paren': return evaluateNode(node.a, env, inCall);
    case 'arr': return new ArrayArea(node.rows.map((row) => row.map((item) => evaluateNode(item, env) as Scalar)));
    case 'un': {
      const v = operand(node.a);
      if (node.op === '+') return v;
      return lift1(v, (x) => {
        const n = toNumber(x);
        return isError(n) ? n : n === 0 ? 0 : -n;
      });
    }
    case 'pct': return lift1(operand(node.a), (x) => {
      const n = toNumber(x);
      return isError(n) ? n : n / 100;
    });
    case 'bin': {
      const a = operand(node.a);
      const b = operand(node.b);
      if (isError(a) && !isArea(b)) return a;
      return lift2(a, b, (x, y) => arith(node.op, x, y));
    }
    case 'call': {
      const fn = getFunction(node.name);
      if (!fn) return ERR.NAME;
      if (node.args.length < fn.meta.minArgs || node.args.length > fn.meta.maxArgs) return ERR.VALUE;
      const args = node.args.map((arg) => evaluateNode(arg, env, true));
      const out = fn.impl(args, env);
      return typeof out === 'number' && !Number.isFinite(out) ? ERR.NUM : out;
    }
    default: return ERR.VALUE;
  }
}

function errorOf(code: string): CellError {
  return (Object.values(ERR) as CellError[]).find((e) => e.code === code) ?? ERR.VALUE;
}
