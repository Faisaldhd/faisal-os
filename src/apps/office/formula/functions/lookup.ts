/**
 * Built-in lookup and reference functions: VLOOKUP, HLOOKUP, XLOOKUP, INDEX,
 * MATCH, XMATCH, OFFSET (volatile), ROW, COLUMN, ROWS, COLUMNS, TRANSPOSE.
 *
 * Exact-match VLOOKUP/HLOOKUP/MATCH/XLOOKUP over a sheet range use the
 * workbook's cached index (ctx.exactIndex) once the same range is searched
 * repeatedly, so 1,000 lookups into a 10,000-row table stay fast.
 */
import { registerFunction, type CallContext } from '../registry';
import { ArrayArea, ERR, RefArea, isArea, isError, subArea, type Area, type Scalar, type Value } from '../values';
import { asVector, bool, findInVector, num, optNum, vectorOf, type Vector } from './helpers';

function areaArg(v: Value): Area | null {
  return isArea(v) ? v : null;
}

function tableLookup(horizontal: boolean) {
  return (args: Value[], ctx: CallContext): Value => {
    const needle = ctx.scalar(args[0]);
    if (isError(needle)) return needle;
    const table = areaArg(args[1]);
    if (!table) return ERR.VALUE;
    const idx = num(args[2], ctx);
    if (isError(idx)) return idx;
    const k = Math.trunc(idx);
    if (k < 1) return ERR.VALUE;
    if (k > (horizontal ? table.rows : table.cols)) return ERR.REF;
    let approx = true;
    if (args.length > 3 && args[3] !== null) {
      const b = bool(args[3], ctx);
      if (isError(b)) return b;
      approx = b;
    }
    const axis = horizontal ? 'row' : 'col';
    const vec = vectorOf(table, axis, 0);
    const pos = approx
      ? findInVector(vec, needle, -1, { wildcards: false, sorted: 'asc' })
      : findInVector(vec, needle, 0, { wildcards: true, index: ctx.exactIndex(table, axis, 0, false) });
    if (pos < 0) return ERR.NA;
    return horizontal ? table.get(k - 1, pos) : table.get(pos, k - 1);
  };
}

registerFunction('VLOOKUP', tableLookup(false), { minArgs: 3, maxArgs: 4 });
registerFunction('HLOOKUP', tableLookup(true), { minArgs: 3, maxArgs: 4 });

/** MATCH/XMATCH position (zero-based) or -1. */
function matchIn(vec: Vector, area: Area, needle: Scalar, matchMode: number, searchMode: number, ctx: CallContext, xmatch: boolean): number | 'bad' {
  const axis: 'col' | 'row' = area.cols === 1 ? 'col' : 'row';
  if (!xmatch) {
    if (matchMode === 0) return findInVector(vec, needle, 0, { wildcards: true, index: ctx.exactIndex(area, axis, 0, false) });
    return findInVector(vec, needle, 0, { wildcards: false, sorted: matchMode > 0 ? 'asc' : 'desc' });
  }
  if (![0, -1, 1, 2].includes(matchMode) || ![1, -1, 2, -2].includes(searchMode)) return 'bad';
  const reverse = searchMode === -1 || searchMode === -2;
  if (matchMode === 2) return findInVector(vec, needle, 0, { wildcards: true, reverse });
  if (matchMode === 0) return findInVector(vec, needle, 0, { wildcards: false, reverse, index: ctx.exactIndex(area, axis, 0, reverse) });
  return findInVector(vec, needle, matchMode as -1 | 1, { wildcards: false, reverse });
}

registerFunction('MATCH', (args, ctx) => {
  const needle = ctx.scalar(args[0]);
  if (isError(needle)) return needle;
  const area = areaArg(args[1]);
  if (!area) return ERR.NA;
  const vec = asVector(area);
  if (!vec) return ERR.NA;
  const mode = optNum(args, 2, 1, ctx);
  if (isError(mode)) return mode;
  const pos = matchIn(vec, area, needle, Math.sign(Math.trunc(mode)), 1, ctx, false);
  return pos === 'bad' || pos < 0 ? ERR.NA : pos + 1;
}, { minArgs: 2, maxArgs: 3 });

registerFunction('XMATCH', (args, ctx) => {
  const needle = ctx.scalar(args[0]);
  if (isError(needle)) return needle;
  const area = areaArg(args[1]);
  if (!area) return ERR.NA;
  const vec = asVector(area);
  if (!vec) return ERR.VALUE;
  const mode = optNum(args, 2, 0, ctx);
  const search = optNum(args, 3, 1, ctx);
  if (isError(mode)) return mode;
  if (isError(search)) return search;
  const pos = matchIn(vec, area, needle, Math.trunc(mode), Math.trunc(search), ctx, true);
  if (pos === 'bad') return ERR.VALUE;
  return pos < 0 ? ERR.NA : pos + 1;
}, { minArgs: 2, maxArgs: 4, xlfn: true });

registerFunction('XLOOKUP', (args, ctx) => {
  const needle = ctx.scalar(args[0]);
  if (isError(needle)) return needle;
  const look = areaArg(args[1]);
  const ret = areaArg(args[2]);
  if (!look || !ret) return ERR.VALUE;
  const vec = asVector(look);
  if (!vec) return ERR.VALUE;
  const vertical = look.cols === 1 && look.rows !== 1 ? true : look.rows === 1 && look.cols !== 1 ? false : ret.cols === 1;
  if (vertical ? ret.rows !== look.rows : ret.cols !== look.cols) return ERR.VALUE;
  const mode = optNum(args, 4, 0, ctx);
  const search = optNum(args, 5, 1, ctx);
  if (isError(mode)) return mode;
  if (isError(search)) return search;
  const pos = matchIn(vec, look, needle, Math.trunc(mode), Math.trunc(search), ctx, true);
  if (pos === 'bad') return ERR.VALUE;
  if (pos < 0) return args.length > 3 && args[3] !== null ? args[3] : ERR.NA;
  return vertical ? subArea(ret, pos, 0, 1, ret.cols) : subArea(ret, 0, pos, ret.rows, 1);
}, { minArgs: 3, maxArgs: 6, xlfn: true });

registerFunction('INDEX', (args, ctx) => {
  const area = isArea(args[0]) ? args[0] : new ArrayArea([[args[0] as Scalar]]);
  if (isError(args[0])) return args[0];
  const a = optNum(args, 1, 0, ctx);
  if (isError(a)) return a;
  const hasCol = args.length > 2 && args[2] !== null;
  const b = optNum(args, 2, 0, ctx);
  if (isError(b)) return b;
  let r = Math.trunc(a);
  let c = Math.trunc(b);
  if (!hasCol && area.rows === 1 && area.cols > 1) { c = r; r = 1; }
  if (r < 0 || c < 0 || r > area.rows || c > area.cols) return ERR.REF;
  if (r === 0 && c === 0) return area;
  if (r === 0) return subArea(area, 0, c - 1, area.rows >= 1048576 ? area.extentRows : area.rows, 1);
  if (c === 0) {
    if (area.cols === 1) return subArea(area, r - 1, 0, 1, 1);
    return subArea(area, r - 1, 0, 1, area.cols);
  }
  return subArea(area, r - 1, c - 1, 1, 1);
}, { minArgs: 2, maxArgs: 4 });

registerFunction('OFFSET', (args, ctx) => {
  const base = args[0];
  if (!(base instanceof RefArea)) return isError(base) ? base : ERR.VALUE;
  const dr = num(args[1], ctx);
  const dc = num(args[2], ctx);
  if (isError(dr)) return dr;
  if (isError(dc)) return dc;
  const h = optNum(args, 3, base.rows, ctx);
  const w = optNum(args, 4, base.cols, ctx);
  if (isError(h)) return h;
  if (isError(w)) return w;
  const rows = Math.trunc(h);
  const cols = Math.trunc(w);
  if (rows < 1 || cols < 1) return ERR.REF;
  return ctx.makeRef(base.sheetId, base.row + Math.trunc(dr), base.col + Math.trunc(dc), rows, cols) ?? ERR.REF;
}, { minArgs: 3, maxArgs: 5, volatile: true });

registerFunction('ROW', (args, ctx) => {
  if (!args.length || args[0] === null) return ctx.row + 1;
  return args[0] instanceof RefArea ? args[0].row + 1 : isError(args[0]) ? args[0] : ERR.VALUE;
}, { minArgs: 0, maxArgs: 1 });

registerFunction('COLUMN', (args, ctx) => {
  if (!args.length || args[0] === null) return ctx.col + 1;
  return args[0] instanceof RefArea ? args[0].col + 1 : isError(args[0]) ? args[0] : ERR.VALUE;
}, { minArgs: 0, maxArgs: 1 });

registerFunction('ROWS', (args) => (isArea(args[0]) ? args[0].rows : isError(args[0]) ? args[0] : 1), { minArgs: 1, maxArgs: 1 });
registerFunction('COLUMNS', (args) => (isArea(args[0]) ? args[0].cols : isError(args[0]) ? args[0] : 1), { minArgs: 1, maxArgs: 1 });

registerFunction('TRANSPOSE', (args) => {
  const a = args[0];
  if (!isArea(a)) return a;
  const data: Scalar[][] = [];
  for (let c = 0; c < a.extentCols; c++) {
    const line: Scalar[] = [];
    for (let r = 0; r < a.extentRows; r++) line.push(a.get(r, c));
    data.push(line);
  }
  return new ArrayArea(data);
}, { minArgs: 1, maxArgs: 1 });
