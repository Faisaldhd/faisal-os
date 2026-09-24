/**
 * Built-in logical, information and conditional-aggregate functions: IF, IFS,
 * IFERROR, IFNA, AND, OR, NOT, XOR, SWITCH, CHOOSE, TRUE, FALSE, NA, ISBLANK,
 * ISNUMBER, ISTEXT, ISLOGICAL, ISERROR, ISERR, ISNA, ISEVEN, ISODD, SUMIF(S),
 * COUNTIF(S), AVERAGEIF(S), MAXIFS, MINIFS.
 */
import { registerFunction } from '../registry';
import { ERR, compareScalars, isArea, isError, toBool, type CellError, type Scalar, type Value } from '../values';
import { asArea, bool, eachCell, makeCriterion, num, resizeLike } from './helpers';

const INF = Infinity;

registerFunction('IF', (args, ctx) => {
  const c = bool(args[0], ctx);
  if (isError(c)) return c;
  if (c) return args.length > 1 ? args[1] : true;
  return args.length > 2 ? args[2] : false;
}, { minArgs: 1, maxArgs: 3, aliases: ['إذا'] });

registerFunction('IFS', (args, ctx) => {
  if (args.length % 2) return ERR.VALUE;
  for (let i = 0; i < args.length; i += 2) {
    const c = bool(args[i], ctx);
    if (isError(c)) return c;
    if (c) return args[i + 1];
  }
  return ERR.NA;
}, { minArgs: 2, maxArgs: 254, xlfn: true });

registerFunction('IFERROR', (args, ctx) => (isError(ctx.scalar(args[0])) ? args[1] : args[0]), { minArgs: 2, maxArgs: 2 });
registerFunction('IFNA', (args, ctx) => (ctx.scalar(args[0]) === ERR.NA ? args[1] : args[0]), { minArgs: 2, maxArgs: 2, xlfn: true });

/** The booleans AND/OR/XOR see: in areas, booleans and numbers (text skipped); direct text must read TRUE/FALSE. */
function truths(args: Value[]): boolean[] | CellError {
  const out: boolean[] = [];
  for (const arg of args) {
    if (isArea(arg)) {
      let err: CellError | undefined;
      eachCell(arg, (v) => {
        if (isError(v)) { err = v; return false; }
        if (typeof v === 'boolean') out.push(v);
        else if (typeof v === 'number') out.push(v !== 0);
        return true;
      });
      if (err) return err;
    } else if (arg !== null) {
      const b = toBool(arg);
      if (isError(b)) return b;
      out.push(b);
    }
  }
  return out.length ? out : ERR.VALUE;
}

registerFunction('AND', (args) => { const t = truths(args); return isError(t) ? t : t.every(Boolean); }, { minArgs: 1, maxArgs: INF, aliases: ['و'] });
registerFunction('OR', (args) => { const t = truths(args); return isError(t) ? t : t.some(Boolean); }, { minArgs: 1, maxArgs: INF, aliases: ['أو'] });
registerFunction('XOR', (args) => { const t = truths(args); return isError(t) ? t : t.filter(Boolean).length % 2 === 1; }, { minArgs: 1, maxArgs: INF, xlfn: true });
registerFunction('NOT', (args, ctx) => { const b = bool(args[0], ctx); return isError(b) ? b : !b; }, { minArgs: 1, maxArgs: 1 });
registerFunction('TRUE', () => true, { minArgs: 0, maxArgs: 0 });
registerFunction('FALSE', () => false, { minArgs: 0, maxArgs: 0 });
registerFunction('NA', () => ERR.NA, { minArgs: 0, maxArgs: 0 });

registerFunction('SWITCH', (args, ctx) => {
  const v = ctx.scalar(args[0]);
  if (isError(v)) return v;
  const pairs = args.length - 1;
  for (let i = 1; i + 1 < args.length; i += 2) {
    const c = ctx.scalar(args[i]);
    if (isError(c)) return c;
    if (compareScalars(v, c) === 0 && typeof (v ?? 0) === typeof (c ?? 0)) return args[i + 1];
  }
  return pairs % 2 === 1 ? args[args.length - 1] : ERR.NA;
}, { minArgs: 3, maxArgs: 254, xlfn: true });

registerFunction('CHOOSE', (args, ctx) => {
  const i = num(args[0], ctx);
  if (isError(i)) return i;
  const k = Math.trunc(i);
  if (k < 1 || k >= args.length) return ERR.VALUE;
  return args[k];
}, { minArgs: 2, maxArgs: 255 });

function isFn(name: string, test: (v: Scalar) => boolean): void {
  registerFunction(name, (args, ctx) => test(ctx.scalar(args[0])), { minArgs: 1, maxArgs: 1 });
}
isFn('ISBLANK', (v) => v === null);
isFn('ISNUMBER', (v) => typeof v === 'number');
isFn('ISTEXT', (v) => typeof v === 'string');
isFn('ISNONTEXT', (v) => typeof v !== 'string');
isFn('ISLOGICAL', (v) => typeof v === 'boolean');
isFn('ISERROR', (v) => isError(v));
isFn('ISERR', (v) => isError(v) && v !== ERR.NA);
isFn('ISNA', (v) => v === ERR.NA);
function parity(name: string, odd: boolean): void {
  registerFunction(name, (args, ctx) => {
    const n = num(args[0], ctx);
    if (isError(n)) return n;
    return (Math.abs(Math.trunc(n)) % 2 === 1) === odd;
  }, { minArgs: 1, maxArgs: 1 });
}
parity('ISEVEN', false);
parity('ISODD', true);

/* ─────────────────────────── conditional aggregates ─────────────────────────── */

/** Cells of `target` whose criteria cells all pass; `fn` sees each passing target value. */
function eachMatching(target: Value, pairs: Array<[Value, Value]>, ctx: { scalar(v: Value): Scalar }, fn: (v: Scalar) => void): CellError | undefined {
  const t = asArea(target);
  const tests = pairs.map(([range, crit]) => {
    const area = asArea(range);
    return { area, test: makeCriterion(ctx.scalar(crit)) };
  });
  for (const { area } of tests) if (area.rows !== t.rows || area.cols !== t.cols) return ERR.VALUE;
  const rows = Math.max(...tests.map((x) => x.area.extentRows), 0);
  const cols = Math.max(...tests.map((x) => x.area.extentCols), 0);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (tests.every(({ area, test }) => test(area.get(r, c)))) fn(t.get(r, c));
    }
  }
  return undefined;
}

type Reducer = { add(v: Scalar): CellError | void; result(): Value };

function reducer(kind: 'sum' | 'count' | 'avg' | 'max' | 'min'): Reducer {
  let total = 0;
  let n = 0;
  let best: number | undefined;
  return {
    add(v) {
      if (kind === 'count') { n++; return; }
      if (isError(v)) return v;
      if (typeof v !== 'number') return;
      total += v;
      n++;
      if (best === undefined || (kind === 'max' ? v > best : v < best)) best = v;
    },
    result() {
      if (kind === 'count') return n;
      if (kind === 'avg') return n ? total / n : ERR.DIV0;
      if (kind === 'max' || kind === 'min') return best ?? 0;
      return total;
    },
  };
}

function ifFn(name: string, kind: 'sum' | 'count' | 'avg'): void {
  registerFunction(name, (args, ctx) => {
    const range = asArea(args[0]);
    const target = kind === 'count' || args.length < 3 || args[2] === null ? range : resizeLike(asArea(args[2]), range);
    const red = reducer(kind);
    let err: CellError | undefined;
    const bad = eachMatching(target, [[range, args[1]]], ctx, (v) => { err = err ?? (red.add(v) || undefined); });
    return bad ?? err ?? red.result();
  }, { minArgs: 2, maxArgs: kind === 'count' ? 2 : 3 });
}
ifFn('SUMIF', 'sum');
ifFn('COUNTIF', 'count');
ifFn('AVERAGEIF', 'avg');

function ifsFn(name: string, kind: 'sum' | 'count' | 'avg' | 'max' | 'min', xlfn = false): void {
  const hasTarget = kind !== 'count';
  registerFunction(name, (args, ctx) => {
    const rest = hasTarget ? args.slice(1) : args;
    if (rest.length % 2) return ERR.VALUE;
    const pairs: Array<[Value, Value]> = [];
    for (let i = 0; i < rest.length; i += 2) pairs.push([rest[i], rest[i + 1]]);
    const target = hasTarget ? args[0] : pairs[0][0];
    const red = reducer(kind);
    let err: CellError | undefined;
    const bad = eachMatching(target, pairs, ctx, (v) => { err = err ?? (red.add(v) || undefined); });
    return bad ?? err ?? red.result();
  }, { minArgs: hasTarget ? 3 : 2, maxArgs: 255, xlfn });
}
ifsFn('SUMIFS', 'sum');
ifsFn('COUNTIFS', 'count');
ifsFn('AVERAGEIFS', 'avg');
ifsFn('MAXIFS', 'max', true);
ifsFn('MINIFS', 'min', true);
