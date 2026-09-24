/**
 * Built-in math and statistics functions: SUM, AVERAGE, COUNT, COUNTA, COUNTBLANK,
 * MIN, MAX, MEDIAN, MODE, STDEV(.S/.P), VAR(.S/.P), LARGE, SMALL, RANK, ROUND,
 * ROUNDUP, ROUNDDOWN, INT, TRUNC, ABS, MOD, POWER, SQRT, PRODUCT, SUMPRODUCT,
 * SUMSQ, SIGN, EXP, LN, LOG, LOG10, PI, CEILING, FLOOR, EVEN, ODD, RAND, RANDBETWEEN.
 */
import { registerFunction } from '../registry';
import { ERR, isArea, isError, roundHalfAway, textToNumber, type CellError, type Scalar } from '../values';
import { asArea, collectNumbers, eachCell, num, optNum } from './helpers';

const INF = Infinity;

/** A function of fixed numeric arguments: coerces each, the first error wins, NaN/∞ become #NUM!. */
function numeric(name: string, min: number, max: number, fn: (...n: number[]) => number | CellError, defaults: number[] = []): void {
  registerFunction(name, (args, ctx) => {
    const ns: number[] = [];
    for (let i = 0; i < max; i++) {
      const fallback = i >= min && defaults[i - min] !== undefined ? defaults[i - min] : 0;
      if (i >= args.length || args[i] === null) { ns.push(fallback); continue; }
      const n = num(args[i], ctx);
      if (isError(n)) return n;
      ns.push(n);
    }
    const out = fn(...ns);
    return typeof out === 'number' && !Number.isFinite(out) ? ERR.NUM : out;
  }, { minArgs: min, maxArgs: max });
}

function aggregate(name: string, fn: (ns: number[]) => number | CellError, aliases?: string[]): void {
  registerFunction(name, (args) => {
    const ns = collectNumbers(args);
    return isError(ns) ? ns : fn(ns);
  }, { minArgs: 1, maxArgs: INF, aliases });
}

const sum = (ns: number[]): number => {
  let s = 0;
  for (const n of ns) s += n;
  return s;
};

const mean = (ns: number[]): number => sum(ns) / ns.length;

function variance(ns: number[], sample: boolean): number | CellError {
  const n = ns.length;
  if (n < (sample ? 2 : 1)) return ERR.DIV0;
  const m = mean(ns);
  let ss = 0;
  for (const x of ns) ss += (x - m) ** 2;
  return ss / (sample ? n - 1 : n);
}

aggregate('SUM', sum, ['مجموع', 'المجموع']);
aggregate('AVERAGE', (ns) => (ns.length ? mean(ns) : ERR.DIV0), ['متوسط', 'المتوسط']);
aggregate('MIN', (ns) => (ns.length ? ns.reduce((a, b) => Math.min(a, b)) : 0), ['أصغر']);
aggregate('MAX', (ns) => (ns.length ? ns.reduce((a, b) => Math.max(a, b)) : 0), ['أكبر']);
aggregate('PRODUCT', (ns) => (ns.length ? ns.reduce((a, b) => a * b, 1) : 0));
aggregate('SUMSQ', (ns) => ns.reduce((a, b) => a + b * b, 0));
aggregate('MEDIAN', (ns) => {
  if (!ns.length) return ERR.NUM;
  const s = [...ns].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
});
aggregate('MODE', (ns) => {
  const counts = new Map<number, number>();
  let best: number | undefined;
  let bestCount = 1;
  for (const n of ns) {
    const c = (counts.get(n) ?? 0) + 1;
    counts.set(n, c);
    if (c > bestCount) { bestCount = c; best = n; }
  }
  if (best === undefined) return ERR.NA;
  // Among equally frequent values Excel returns the one that appears first.
  return ns.find((n) => counts.get(n) === bestCount) ?? best;
}, ['MODE.SNGL']);
aggregate('STDEV', (ns) => { const v = variance(ns, true); return isError(v) ? v : Math.sqrt(v); }, ['STDEV.S']);
aggregate('STDEV.P', (ns) => { const v = variance(ns, false); return isError(v) ? v : Math.sqrt(v); }, ['STDEVP']);
aggregate('VAR', (ns) => variance(ns, true), ['VAR.S']);
aggregate('VAR.P', (ns) => variance(ns, false), ['VARP']);

registerFunction('COUNT', (args) => {
  let n = 0;
  for (const arg of args) {
    if (isArea(arg)) eachCell(arg, (v) => { if (typeof v === 'number') n++; });
    else if (typeof arg === 'number' || typeof arg === 'boolean') n++;
    else if (typeof arg === 'string' && textToNumber(arg) !== null) n++;
  }
  return n;
}, { minArgs: 1, maxArgs: INF });

registerFunction('COUNTA', (args) => {
  let n = 0;
  for (const arg of args) {
    if (isArea(arg)) eachCell(arg, (v) => { if (v !== null) n++; });
    else if (arg !== null) n++;
  }
  return n;
}, { minArgs: 1, maxArgs: INF });

registerFunction('COUNTBLANK', (args) => {
  const area = asArea(args[0]);
  let n = 0;
  // A blank-looking cell with "" counts too; cells beyond the used extent are blank.
  eachCell(area, (v) => { if (v === null || v === '') n++; });
  return n + (area.rows * area.cols - area.extentRows * area.extentCols);
}, { minArgs: 1, maxArgs: 1 });

function kth(name: string, largest: boolean): void {
  registerFunction(name, (args, ctx) => {
    const ns = collectNumbers([asArea(args[0])]);
    if (isError(ns)) return ns;
    const k = num(args[1], ctx);
    if (isError(k)) return k;
    const i = Math.ceil(k);
    if (i < 1 || i > ns.length) return ERR.NUM;
    const s = [...ns].sort((a, b) => (largest ? b - a : a - b));
    return s[i - 1];
  }, { minArgs: 2, maxArgs: 2 });
}
kth('LARGE', true);
kth('SMALL', false);

registerFunction('RANK', (args, ctx) => {
  const x = num(args[0], ctx);
  if (isError(x)) return x;
  const ns = collectNumbers([asArea(args[1])]);
  if (isError(ns)) return ns;
  const order = optNum(args, 2, 0, ctx);
  if (isError(order)) return order;
  if (!ns.includes(x)) return ERR.NA;
  return 1 + ns.filter((n) => (order ? n < x : n > x)).length;
}, { minArgs: 2, maxArgs: 3, aliases: ['RANK.EQ'] });

numeric('ROUND', 2, 2, (x, d) => roundHalfAway(x, d));
numeric('ROUNDUP', 2, 2, (x, d) => roundHalfAway(x, d, 'up'));
numeric('ROUNDDOWN', 2, 2, (x, d) => roundHalfAway(x, d, 'down'));
numeric('INT', 1, 1, (x) => Math.floor(x));
numeric('TRUNC', 1, 2, (x, d) => roundHalfAway(x, d, 'down'), [0]);
numeric('ABS', 1, 1, (x) => Math.abs(x));
numeric('SIGN', 1, 1, (x) => Math.sign(x));
numeric('MOD', 2, 2, (n, d) => {
  if (d === 0) return ERR.DIV0;
  const r = n - d * Math.floor(n / d);
  return Number(r.toPrecision(15));
});
numeric('POWER', 2, 2, (x, y) => {
  if (x === 0 && y === 0) return ERR.NUM;
  if (x === 0 && y < 0) return ERR.DIV0;
  return x ** y;
});
numeric('SQRT', 1, 1, (x) => (x < 0 ? ERR.NUM : Math.sqrt(x)));
numeric('EXP', 1, 1, (x) => Math.exp(x));
numeric('LN', 1, 1, (x) => (x <= 0 ? ERR.NUM : Math.log(x)));
numeric('LOG10', 1, 1, (x) => (x <= 0 ? ERR.NUM : Math.log10(x)));
numeric('LOG', 1, 2, (x, b) => {
  if (x <= 0 || b <= 0) return ERR.NUM;
  if (b === 1) return ERR.DIV0;
  return b === 10 ? Math.log10(x) : Math.log(x) / Math.log(b);
}, [10]);
numeric('PI', 0, 0, () => Math.PI);
numeric('CEILING', 1, 2, (x, s) => {
  if (s === 0) return 0;
  if (x > 0 && s < 0) return ERR.NUM;
  return Number((Math.ceil(Number((x / s).toPrecision(15))) * s).toPrecision(15));
}, [1]);
numeric('FLOOR', 1, 2, (x, s) => {
  if (s === 0) return x === 0 ? 0 : ERR.DIV0;
  if (x > 0 && s < 0) return ERR.NUM;
  return Number((Math.floor(Number((x / s).toPrecision(15))) * s).toPrecision(15));
}, [1]);
numeric('EVEN', 1, 1, (x) => { const r = Math.ceil(Math.abs(x) / 2) * 2; return x < 0 ? -r : r; });
numeric('ODD', 1, 1, (x) => {
  let r = Math.ceil(Math.abs(x));
  if (r % 2 === 0) r += 1;
  return x < 0 ? -r : r;
});

registerFunction('RAND', () => Math.random(), { minArgs: 0, maxArgs: 0, volatile: true });
registerFunction('RANDBETWEEN', (args, ctx) => {
  const lo = num(args[0], ctx);
  const hi = num(args[1], ctx);
  if (isError(lo)) return lo;
  if (isError(hi)) return hi;
  const a = Math.ceil(lo);
  const b = Math.floor(hi);
  if (b < a) return ERR.NUM;
  return a + Math.floor(Math.random() * (b - a + 1));
}, { minArgs: 2, maxArgs: 2, volatile: true });

registerFunction('SUMPRODUCT', (args) => {
  const areas = args.map(asArea);
  const rows = areas[0].rows >= 1048576 ? areas[0].extentRows : areas[0].rows;
  const cols = areas[0].cols >= 16384 ? areas[0].extentCols : areas[0].cols;
  for (const a of areas) {
    const r = a.rows >= 1048576 ? rows : a.rows;
    const c = a.cols >= 16384 ? cols : a.cols;
    if (r !== rows || c !== cols) return ERR.VALUE;
  }
  let total = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let p = 1;
      for (const a of areas) {
        const v: Scalar = a.get(r, c);
        if (isError(v)) return v;
        p *= typeof v === 'number' ? v : 0;
      }
      total += p;
    }
  }
  return total;
}, { minArgs: 1, maxArgs: 255 });
