/**
 * Built-in text functions: CONCAT, CONCATENATE, TEXTJOIN, LEFT, RIGHT, MID, LEN,
 * TRIM, UPPER, LOWER, PROPER, SUBSTITUTE, REPLACE, FIND, SEARCH, TEXT, VALUE,
 * REPT, EXACT, CHAR, CODE, UNICHAR, UNICODE, T, N. Arabic text works as-is
 * (lengths count UTF-16 units, like Excel).
 */
import { formatValue } from '../../calc/numfmt';
import { registerFunction, type CallContext } from '../registry';
import { ERR, isArea, isError, textToNumber, toText, type CellError, type Value } from '../values';
import { bool, eachCell, num, optNum, text, wildcardRegex } from './helpers';

const INF = Infinity;

/** Every argument as text, areas flattened (errors stop the join). */
function texts(args: Value[], skipEmpty: boolean): string[] | CellError {
  const out: string[] = [];
  for (const arg of args) {
    if (isArea(arg)) {
      let err: CellError | undefined;
      eachCell(arg, (v) => {
        if (isError(v)) { err = v; return false; }
        const t = toText(v) as string;
        if (!(skipEmpty && t === '')) out.push(t);
        return true;
      });
      if (err) return err;
    } else {
      const t = toText(arg);
      if (isError(t)) return t;
      if (!(skipEmpty && t === '')) out.push(t);
    }
  }
  return out;
}

registerFunction('CONCAT', (args) => { const t = texts(args, false); return isError(t) ? t : t.join(''); }, { minArgs: 1, maxArgs: 254, xlfn: true, aliases: ['دمج'] });
registerFunction('CONCATENATE', (args, ctx) => {
  let out = '';
  for (const a of args) {
    const t = text(a, ctx);
    if (isError(t)) return t;
    out += t;
  }
  return out;
}, { minArgs: 1, maxArgs: 255 });

registerFunction('TEXTJOIN', (args, ctx) => {
  const delim = text(args[0], ctx);
  if (isError(delim)) return delim;
  const skip = bool(args[1], ctx);
  if (isError(skip)) return skip;
  const t = texts(args.slice(2), skip);
  return isError(t) ? t : t.join(delim);
}, { minArgs: 3, maxArgs: 255, xlfn: true });

function withText(name: string, min: number, max: number, fn: (s: string, args: Value[], ctx: CallContext) => Value): void {
  registerFunction(name, (args, ctx) => {
    const s = text(args[0], ctx);
    return isError(s) ? s : fn(s, args, ctx);
  }, { minArgs: min, maxArgs: max });
}

withText('LEFT', 1, 2, (s, args, ctx) => {
  const n = optNum(args, 1, 1, ctx);
  if (isError(n)) return n;
  return n < 0 ? ERR.VALUE : s.slice(0, Math.trunc(n));
});
withText('RIGHT', 1, 2, (s, args, ctx) => {
  const n = optNum(args, 1, 1, ctx);
  if (isError(n)) return n;
  if (n < 0) return ERR.VALUE;
  const k = Math.trunc(n);
  return k === 0 ? '' : s.slice(-k);
});
withText('MID', 3, 3, (s, args, ctx) => {
  const start = num(args[1], ctx);
  const n = num(args[2], ctx);
  if (isError(start)) return start;
  if (isError(n)) return n;
  if (start < 1 || n < 0) return ERR.VALUE;
  const a = Math.trunc(start) - 1;
  return s.slice(a, a + Math.trunc(n));
});
withText('LEN', 1, 1, (s) => s.length);
withText('TRIM', 1, 1, (s) => s.replace(/ +/g, ' ').replace(/^ | $/g, ''));
withText('UPPER', 1, 1, (s) => s.toUpperCase());
withText('LOWER', 1, 1, (s) => s.toLowerCase());
withText('PROPER', 1, 1, (s) => s.toLowerCase().replace(/(^|[^\p{L}\p{M}'])(\p{L})/gu, (_, pre: string, ch: string) => pre + ch.toUpperCase()));
withText('T', 1, 1, (s, args, ctx) => (typeof ctx.scalar(args[0]) === 'string' ? s : ''));
withText('SUBSTITUTE', 3, 4, (s, args, ctx) => {
  const from = text(args[1], ctx);
  const to = text(args[2], ctx);
  if (isError(from)) return from;
  if (isError(to)) return to;
  if (from === '') return s;
  if (args.length < 4 || args[3] === null) return s.split(from).join(to);
  const inst = num(args[3], ctx);
  if (isError(inst)) return inst;
  if (inst < 1) return ERR.VALUE;
  let at = -1;
  for (let i = 0; i < Math.trunc(inst); i++) {
    at = s.indexOf(from, at + 1);
    if (at < 0) return s;
  }
  return s.slice(0, at) + to + s.slice(at + from.length);
});
withText('REPLACE', 4, 4, (s, args, ctx) => {
  const start = num(args[1], ctx);
  const n = num(args[2], ctx);
  const by = text(args[3], ctx);
  if (isError(start)) return start;
  if (isError(n)) return n;
  if (isError(by)) return by;
  if (start < 1 || n < 0) return ERR.VALUE;
  const a = Math.trunc(start) - 1;
  return s.slice(0, a) + by + s.slice(a + Math.trunc(n));
});
withText('REPT', 2, 2, (s, args, ctx) => {
  const n = num(args[1], ctx);
  if (isError(n)) return n;
  if (n < 0 || s.length * n > 32767) return ERR.VALUE;
  return s.repeat(Math.trunc(n));
});
withText('EXACT', 2, 2, (s, args, ctx) => {
  const t = text(args[1], ctx);
  return isError(t) ? t : s === t;
});
withText('CODE', 1, 1, (s) => (s ? s.charCodeAt(0) : ERR.VALUE));
withText('UNICODE', 1, 1, (s) => (s ? s.codePointAt(0)! : ERR.VALUE));
withText('VALUE', 1, 1, (s, args, ctx) => {
  const v = ctx.scalar(args[0]);
  if (typeof v === 'number') return v;
  const n = textToNumber(s);
  return n === null ? ERR.VALUE : n;
});

function finder(name: string, caseSensitive: boolean): void {
  registerFunction(name, (args, ctx) => {
    const find = text(args[0], ctx);
    const within = text(args[1], ctx);
    if (isError(find)) return find;
    if (isError(within)) return within;
    const start = optNum(args, 2, 1, ctx);
    if (isError(start)) return start;
    const from = Math.trunc(start) - 1;
    if (from < 0 || from > within.length) return ERR.VALUE;
    if (caseSensitive) {
      const at = within.indexOf(find, from);
      return at < 0 ? ERR.VALUE : at + 1;
    }
    if (find === '') return from + 1;
    if (!/[*?~]/.test(find)) {
      const at = within.toLowerCase().indexOf(find.toLowerCase(), from);
      return at < 0 ? ERR.VALUE : at + 1;
    }
    const re = wildcardRegex(find);
    const body = re.source.slice(1, -1);
    const m = new RegExp(body, 'i').exec(within.slice(from));
    return m ? from + m.index + 1 : ERR.VALUE;
  }, { minArgs: 2, maxArgs: 3 });
}
finder('FIND', true);
finder('SEARCH', false);

registerFunction('CHAR', (args, ctx) => {
  const n = num(args[0], ctx);
  if (isError(n)) return n;
  const k = Math.trunc(n);
  return k < 1 || k > 255 ? ERR.VALUE : String.fromCharCode(k);
}, { minArgs: 1, maxArgs: 1 });

registerFunction('UNICHAR', (args, ctx) => {
  const n = num(args[0], ctx);
  if (isError(n)) return n;
  const k = Math.trunc(n);
  return k < 1 || k > 0x10ffff ? ERR.VALUE : String.fromCodePoint(k);
}, { minArgs: 1, maxArgs: 1 });

registerFunction('N', (args, ctx) => {
  const v = ctx.scalar(args[0]);
  if (typeof v === 'number' || isError(v)) return v;
  return typeof v === 'boolean' ? (v ? 1 : 0) : 0;
}, { minArgs: 1, maxArgs: 1 });

registerFunction('TEXT', (args, ctx) => {
  const v = ctx.scalar(args[0]);
  if (isError(v)) return v;
  const fmt = text(args[1], ctx);
  if (isError(fmt)) return fmt;
  const n = typeof v === 'string' ? textToNumber(v) : null;
  return formatValue(n ?? v, fmt).text;
}, { minArgs: 2, maxArgs: 2 });
