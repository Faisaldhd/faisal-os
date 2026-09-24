/**
 * Built-in financial functions with Excel's sign convention (money paid out is
 * negative): PMT, PV, FV, NPER, NPV, IRR, RATE. `type` 1 = payments at the start
 * of each period.
 */
import { registerFunction, type CallContext } from '../registry';
import { ERR, isError, type CellError, type Value } from '../values';
import { collectNumbers, num, optNum } from './helpers';

function nums(args: Value[], ctx: CallContext, required: number, defaults: number[]): number[] | CellError {
  const out: number[] = [];
  for (let i = 0; i < required + defaults.length; i++) {
    const n = i < required ? num(args[i], ctx) : optNum(args, i, defaults[i - required], ctx);
    if (isError(n)) return n;
    out.push(n);
  }
  return out;
}

/** The future value of the cash flows; zero at the rate that solves RATE. */
function fvOf(rate: number, nper: number, pmt: number, pv: number, type: number): number {
  if (rate === 0) return -(pv + pmt * nper);
  const g = (1 + rate) ** nper;
  return -(pv * g + (pmt * (1 + rate * type) * (g - 1)) / rate);
}

registerFunction('PMT', (args, ctx) => {
  const n = nums(args, ctx, 3, [0, 0]);
  if (isError(n)) return n;
  const [rate, nper, pv, fv, type] = n;
  if (nper === 0) return ERR.NUM;
  if (rate === 0) return -(pv + fv) / nper;
  const g = (1 + rate) ** nper;
  return (-(pv * g + fv) * rate) / ((1 + rate * (type ? 1 : 0)) * (g - 1));
}, { minArgs: 3, maxArgs: 5 });

registerFunction('FV', (args, ctx) => {
  const n = nums(args, ctx, 3, [0, 0]);
  if (isError(n)) return n;
  const [rate, nper, pmt, pv, type] = n;
  return fvOf(rate, nper, pmt, pv, type ? 1 : 0);
}, { minArgs: 3, maxArgs: 5 });

registerFunction('PV', (args, ctx) => {
  const n = nums(args, ctx, 3, [0, 0]);
  if (isError(n)) return n;
  const [rate, nper, pmt, fv, type] = n;
  if (rate === 0) return -(fv + pmt * nper);
  const g = (1 + rate) ** nper;
  return -(fv + (pmt * (1 + rate * (type ? 1 : 0)) * (g - 1)) / rate) / g;
}, { minArgs: 3, maxArgs: 5 });

registerFunction('NPER', (args, ctx) => {
  const n = nums(args, ctx, 3, [0, 0]);
  if (isError(n)) return n;
  const [rate, pmt, pv, fv, type] = n;
  if (rate === 0) return pmt === 0 ? ERR.NUM : -(pv + fv) / pmt;
  const k = pmt * (1 + rate * (type ? 1 : 0)) / rate;
  const ratio = (k - fv) / (k + pv);
  if (ratio <= 0) return ERR.NUM;
  return Math.log(ratio) / Math.log(1 + rate);
}, { minArgs: 3, maxArgs: 5 });

registerFunction('NPV', (args, ctx) => {
  const rate = num(args[0], ctx);
  if (isError(rate)) return rate;
  if (rate === -1) return ERR.DIV0;
  const flows = collectNumbers(args.slice(1));
  if (isError(flows)) return flows;
  let total = 0;
  flows.forEach((v, i) => { total += v / (1 + rate) ** (i + 1); });
  return total;
}, { minArgs: 2, maxArgs: 255 });

/** Newton's method with a bisection fallback; null when no root is found. */
function solve(f: (x: number) => number, guess: number, lo = -0.9999999, hi = 10): number | null {
  let x = guess;
  for (let i = 0; i < 100; i++) {
    const y = f(x);
    if (!Number.isFinite(y)) break;
    if (Math.abs(y) < 1e-10) return x;
    const h = 1e-7 * Math.max(1, Math.abs(x));
    const d = (f(x + h) - f(x - h)) / (2 * h);
    if (!d || !Number.isFinite(d)) break;
    const next = x - y / d;
    if (!Number.isFinite(next) || next <= -1) break;
    if (Math.abs(next - x) < 1e-12) return next;
    x = next;
  }
  let a = lo;
  let b = hi;
  let fa = f(a);
  const fb = f(b);
  if (!Number.isFinite(fa) || !Number.isFinite(fb) || fa * fb > 0) return null;
  for (let i = 0; i < 300; i++) {
    const m = (a + b) / 2;
    const fm = f(m);
    if (Math.abs(fm) < 1e-10 || b - a < 1e-14) return m;
    if (fa * fm < 0) b = m; else { a = m; fa = fm; }
  }
  return (a + b) / 2;
}

registerFunction('IRR', (args, ctx) => {
  const flows = collectNumbers([args[0]]);
  if (isError(flows)) return flows;
  if (!flows.some((v) => v > 0) || !flows.some((v) => v < 0)) return ERR.NUM;
  const guess = optNum(args, 1, 0.1, ctx);
  if (isError(guess)) return guess;
  const npv = (r: number): number => flows.reduce((t, v, i) => t + v / (1 + r) ** i, 0);
  const r = solve(npv, guess);
  return r === null ? ERR.NUM : r;
}, { minArgs: 1, maxArgs: 2 });

registerFunction('RATE', (args, ctx) => {
  const n = nums(args, ctx, 3, [0, 0, 0.1]);
  if (isError(n)) return n;
  const [nper, pmt, pv, fv, type, guess] = n;
  if (nper <= 0) return ERR.NUM;
  const f = (r: number): number => {
    if (Math.abs(r) < 1e-12) return pv + pmt * nper + fv;
    const g = (1 + r) ** nper;
    return pv * g + (pmt * (1 + r * (type ? 1 : 0)) * (g - 1)) / r + fv;
  };
  const r = solve(f, guess);
  return r === null ? ERR.NUM : r;
}, { minArgs: 3, maxArgs: 6 });
