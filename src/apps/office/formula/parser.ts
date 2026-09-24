/**
 * Office Calc engine — tokenizer, parser and serializer (المحلل).
 *
 *   parseFormula(text)            → { ok: true, ast } | { ok: false, error, at }
 *                                   `text` may start with '='; Arabic-Indic digits work.
 *   formatFormula(ast, opts?)     → canonical English text without '=' (upper-case
 *                                   names, no spaces); `{ xlfn: true }` adds Excel's
 *                                   `_xlfn.` prefix to post-2007 functions for `<f>`.
 *   translateFormula(text, dr, dc) → the formula copied dr rows / dc columns away
 *                                   (relative parts move, `$` parts stay; off-sheet → #REF!).
 *   shiftFormula(text, change)    → the formula after rows/columns were inserted or
 *                                   deleted on a sheet (references follow their cells).
 *   collectRefs(ast)              → every reference node (for dependency tracking).
 *
 * Grammar, loosest first (Excel's precedence):
 *   comparison  = concat (('=' | '<>' | '<' | '>' | '<=' | '>=') concat)*
 *   concat      = additive ('&' additive)*
 *   additive    = term (('+' | '-') term)*
 *   term        = power (('*' | '/') power)*
 *   power       = percent ('^' percent)*          left-associative: 2^3^2 = 64
 *   percent     = unary '%'*
 *   unary       = ('-' | '+') unary | primary      so -2^2 = 4, as in Excel
 *   primary     = number | "text" | TRUE | FALSE | #ERROR | reference | NAME(args)
 *               | name | '(' comparison ')' | { array constant }
 * References: A1, $A$1, A1:B9, A:A, $A:$C, 1:1, 3:5, Sheet2!A1, 'My Sheet'!A1:B2.
 * Argument separators: ',' ';' or the Arabic comma '،'.
 */
import { columnName } from '../xml';
import { canonicalName, getFunction } from './registry';
import './functions';
import { ERROR_CODES, type ErrorCode } from './values';

export const MAX_ROWS = 1048576;
export const MAX_COLS = 16384;

/** A reference as written. Rows/columns are zero-based; `*Abs` is a `$`. */
export interface RefNode {
  k: 'ref';
  sheet?: string;
  kind: 'cell' | 'area' | 'cols' | 'rows';
  r1: number; c1: number; r2: number; c2: number;
  r1Abs: boolean; c1Abs: boolean; r2Abs: boolean; c2Abs: boolean;
}

export type Node =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'bool'; v: boolean }
  | { k: 'err'; v: ErrorCode }
  | RefNode
  | { k: 'call'; name: string; args: Node[] }
  | { k: 'name'; name: string }
  | { k: 'un'; op: '-' | '+'; a: Node }
  | { k: 'pct'; a: Node }
  | { k: 'bin'; op: string; a: Node; b: Node }
  | { k: 'paren'; a: Node }
  | { k: 'arr'; rows: Node[][] }
  | { k: 'missing' };

export type ParseResult = { ok: true; ast: Node } | { ok: false; error: string; at: number };

type Tok =
  | { t: 'num'; v: number; at: number }
  | { t: 'str'; v: string; at: number }
  | { t: 'err'; v: ErrorCode; at: number }
  | { t: 'ref'; v: RefNode; at: number }
  | { t: 'ident'; v: string; call: boolean; at: number }
  | { t: 'op'; v: string; at: number };

class SyntaxError_ extends Error {
  constructor(message: string, readonly at: number) { super(message); }
}

const ARABIC = '\\u0621-\\u064A\\u066E-\\u06D3\\u06D5\\u06FA-\\u06FF';
const IDENT_START = new RegExp(`[A-Za-z_\\\\${ARABIC}]`);
const IDENT_RE = new RegExp(`^[A-Za-z_\\\\${ARABIC}][A-Za-z0-9_.${ARABIC}]*`);
const BOUNDARY = new RegExp(`[A-Za-z0-9_.(!${ARABIC}]`);
const AREA_RE = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+):(\$?)([A-Za-z]{1,3})(\$?)(\d+)/;
const COLS_RE = /^(\$?)([A-Za-z]{1,3}):(\$?)([A-Za-z]{1,3})/;
const ROWS_RE = /^(\$?)(\d+):(\$?)(\d+)/;
const CELL_RE = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)/;
const NUM_RE = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/;

function colOf(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Arabic-Indic digits (outside quotes) become ASCII so "=٥+٣" works. */
function normalizeDigits(text: string): string {
  let out = '';
  let quote = '';
  for (const ch of text) {
    if (quote) { if (ch === quote) quote = ''; out += ch; continue; }
    if (ch === '"' || ch === '\'') { quote = ch; out += ch; continue; }
    const code = ch.charCodeAt(0);
    if (code >= 0x660 && code <= 0x669) out += String(code - 0x660);
    else if (code >= 0x6f0 && code <= 0x6f9) out += String(code - 0x6f0);
    else if (ch === '٫') out += '.';
    else out += ch;
  }
  return out;
}

/** Tries each reference shape at `rest`; the match must end at a token boundary. */
function matchRef(rest: string, sheet: string | undefined): { ref: RefNode; len: number } | null {
  const bounded = (len: number): boolean => !BOUNDARY.test(rest[len] ?? '');
  let m = AREA_RE.exec(rest);
  if (m && bounded(m[0].length)) {
    const ref: RefNode = {
      k: 'ref', sheet, kind: 'area',
      c1: colOf(m[2]), r1: Number(m[4]) - 1, c2: colOf(m[6]), r2: Number(m[8]) - 1,
      c1Abs: !!m[1], r1Abs: !!m[3], c2Abs: !!m[5], r2Abs: !!m[7],
    };
    return valid(ref) ? { ref: normalizeRef(ref), len: m[0].length } : null;
  }
  m = COLS_RE.exec(rest);
  if (m && bounded(m[0].length)) {
    const ref: RefNode = {
      k: 'ref', sheet, kind: 'cols', r1: 0, r2: MAX_ROWS - 1, c1: colOf(m[2]), c2: colOf(m[4]),
      c1Abs: !!m[1], c2Abs: !!m[3], r1Abs: true, r2Abs: true,
    };
    return valid(ref) ? { ref: normalizeRef(ref), len: m[0].length } : null;
  }
  m = ROWS_RE.exec(rest);
  if (m && bounded(m[0].length)) {
    const ref: RefNode = {
      k: 'ref', sheet, kind: 'rows', c1: 0, c2: MAX_COLS - 1, r1: Number(m[2]) - 1, r2: Number(m[4]) - 1,
      r1Abs: !!m[1], r2Abs: !!m[3], c1Abs: true, c2Abs: true,
    };
    return valid(ref) ? { ref: normalizeRef(ref), len: m[0].length } : null;
  }
  m = CELL_RE.exec(rest);
  if (m && bounded(m[0].length)) {
    const r = Number(m[4]) - 1;
    const c = colOf(m[2]);
    const ref: RefNode = { k: 'ref', sheet, kind: 'cell', r1: r, c1: c, r2: r, c2: c, c1Abs: !!m[1], r1Abs: !!m[3], c2Abs: !!m[1], r2Abs: !!m[3] };
    return valid(ref) ? { ref, len: m[0].length } : null;
  }
  return null;
}

function valid(ref: RefNode): boolean {
  return ref.r1 >= 0 && ref.r2 >= 0 && ref.c1 >= 0 && ref.c2 >= 0
    && ref.r1 < MAX_ROWS && ref.r2 < MAX_ROWS && ref.c1 < MAX_COLS && ref.c2 < MAX_COLS;
}

/** A range written bottom-right first (B5:A1) is stored top-left first, as Excel does. */
function normalizeRef(ref: RefNode): RefNode {
  if (ref.r1 > ref.r2) [ref.r1, ref.r2, ref.r1Abs, ref.r2Abs] = [ref.r2, ref.r1, ref.r2Abs, ref.r1Abs];
  if (ref.c1 > ref.c2) [ref.c1, ref.c2, ref.c1Abs, ref.c2Abs] = [ref.c2, ref.c1, ref.c2Abs, ref.c1Abs];
  return ref;
}

function tokenize(src: string): Tok[] {
  const text = normalizeDigits(src);
  const out: Tok[] = [];
  let i = 0;
  const operandPosition = (): boolean => {
    const last = out[out.length - 1];
    return !last || (last.t === 'op' && last.v !== ')' && last.v !== '%' && last.v !== '}');
  };
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) { i++; continue; }
    const rest = text.slice(i);
    if (ch === '"') {
      let j = i + 1;
      let v = '';
      for (;;) {
        if (j >= text.length) throw new SyntaxError_('unterminated text', i);
        if (text[j] === '"') {
          if (text[j + 1] === '"') { v += '"'; j += 2; continue; }
          break;
        }
        v += text[j++];
      }
      out.push({ t: 'str', v, at: i });
      i = j + 1;
      continue;
    }
    if (ch === '#') {
      const upper = rest.toUpperCase();
      const code = ERROR_CODES.find((c) => upper.startsWith(c));
      if (!code) throw new SyntaxError_('unknown error value', i);
      out.push({ t: 'err', v: code, at: i });
      i += code.length;
      continue;
    }
    if (ch === '\'') {
      let j = i + 1;
      let name = '';
      for (;;) {
        if (j >= text.length) throw new SyntaxError_('unterminated sheet name', i);
        if (text[j] === '\'') {
          if (text[j + 1] === '\'') { name += '\''; j += 2; continue; }
          break;
        }
        name += text[j++];
      }
      if (text[j + 1] !== '!' || !name) throw new SyntaxError_('expected ! after sheet name', j);
      const ref = matchRef(text.slice(j + 2), name);
      if (!ref) throw new SyntaxError_('expected a reference after the sheet name', j + 2);
      out.push({ t: 'ref', v: ref.ref, at: i });
      i = j + 2 + ref.len;
      continue;
    }
    if (/[0-9.$]/.test(ch) || IDENT_START.test(ch)) {
      if (operandPosition()) {
        const ref = matchRef(rest, undefined);
        if (ref) { out.push({ t: 'ref', v: ref.ref, at: i }); i += ref.len; continue; }
      }
      if (/[0-9.]/.test(ch)) {
        const m = NUM_RE.exec(rest);
        if (!m) throw new SyntaxError_('bad number', i);
        out.push({ t: 'num', v: Number(m[0]), at: i });
        i += m[0].length;
        continue;
      }
      const m = IDENT_RE.exec(rest);
      if (!m) throw new SyntaxError_('unexpected character', i);
      const name = m[0];
      const after = i + name.length;
      if (text[after] === '!') {
        const ref = matchRef(text.slice(after + 1), name);
        if (!ref) throw new SyntaxError_('expected a reference after the sheet name', after + 1);
        out.push({ t: 'ref', v: ref.ref, at: i });
        i = after + 1 + ref.len;
        continue;
      }
      let k = after;
      while (k < text.length && /\s/.test(text[k])) k++;
      out.push({ t: 'ident', v: name, call: text[k] === '(', at: i });
      i = after;
      continue;
    }
    const two = rest.slice(0, 2);
    if (two === '<=' || two === '>=' || two === '<>') { out.push({ t: 'op', v: two, at: i }); i += 2; continue; }
    if ('+-*/^&=<>%(),;{}'.includes(ch)) { out.push({ t: 'op', v: ch, at: i }); i++; continue; }
    if (ch === '،') { out.push({ t: 'op', v: ',', at: i }); i++; continue; } // Arabic comma
    throw new SyntaxError_('unexpected character', i);
  }
  return out;
}

class Parser {
  private at = 0;
  constructor(private readonly toks: Tok[], private readonly end: number) {}

  private peek(): Tok | undefined { return this.toks[this.at]; }
  private isOp(v: string): boolean { const t = this.peek(); return t?.t === 'op' && t.v === v; }
  private fail(message: string): never { throw new SyntaxError_(message, this.peek()?.at ?? this.end); }
  private expect(v: string): void { if (!this.isOp(v)) this.fail(`expected ${v}`); this.at++; }

  parse(): Node {
    if (!this.toks.length) this.fail('empty formula');
    const node = this.comparison();
    if (this.at < this.toks.length) this.fail('unexpected token');
    return node;
  }

  private binaryLevel(ops: string[], next: () => Node): Node {
    let left = next();
    for (;;) {
      const t = this.peek();
      if (t?.t !== 'op' || !ops.includes(t.v)) return left;
      this.at++;
      left = { k: 'bin', op: t.v, a: left, b: next() };
    }
  }

  private comparison = (): Node => this.binaryLevel(['=', '<>', '<', '>', '<=', '>='], this.concat);
  private concat = (): Node => this.binaryLevel(['&'], this.additive);
  private additive = (): Node => this.binaryLevel(['+', '-'], this.term);
  private term = (): Node => this.binaryLevel(['*', '/'], this.power);
  private power = (): Node => this.binaryLevel(['^'], this.percent);

  private percent = (): Node => {
    let node = this.unary();
    while (this.isOp('%')) { this.at++; node = { k: 'pct', a: node }; }
    return node;
  };

  private unary = (): Node => {
    if (this.isOp('-') || this.isOp('+')) {
      const op = (this.toks[this.at++] as { v: string }).v as '-' | '+';
      return { k: 'un', op, a: this.unary() };
    }
    return this.primary();
  };

  private primary(): Node {
    const t = this.peek();
    if (!t) this.fail('unexpected end');
    this.at++;
    switch (t.t) {
      case 'num': return { k: 'num', v: t.v };
      case 'str': return { k: 'str', v: t.v };
      case 'err': return { k: 'err', v: t.v };
      case 'ref': return t.v;
      case 'ident': {
        if (t.call) {
          this.expect('(');
          const name = canonicalName(stripPrefix(t.v));
          const args: Node[] = [];
          if (this.isOp(')')) { this.at++; return { k: 'call', name, args }; }
          for (;;) {
            if (this.isOp(',') || this.isOp(';') || this.isOp(')')) args.push({ k: 'missing' });
            else args.push(this.comparison());
            if (this.isOp(',') || this.isOp(';')) { this.at++; continue; }
            this.expect(')');
            return { k: 'call', name, args };
          }
        }
        const upper = t.v.toUpperCase();
        if (upper === 'TRUE' || upper === 'FALSE') return { k: 'bool', v: upper === 'TRUE' };
        return { k: 'name', name: t.v };
      }
      default: break;
    }
    if (t.v === '(') {
      const inner = this.comparison();
      this.expect(')');
      return { k: 'paren', a: inner };
    }
    if (t.v === '{') return this.arrayConstant();
    this.at--;
    return this.fail('unexpected token');
  }

  private arrayConstant(): Node {
    const rows: Node[][] = [[]];
    for (;;) {
      let sign = 1;
      while (this.isOp('-') || this.isOp('+')) { if (this.isOp('-')) sign = -sign; this.at++; }
      const t = this.peek();
      if (!t) this.fail('unterminated array');
      this.at++;
      let item: Node;
      if (t.t === 'num') item = { k: 'num', v: sign * t.v };
      else if (sign !== 1) this.fail('bad array item');
      else if (t.t === 'str') item = { k: 'str', v: t.v };
      else if (t.t === 'err') item = { k: 'err', v: t.v };
      else if (t.t === 'ident' && /^(TRUE|FALSE)$/i.test(t.v)) item = { k: 'bool', v: t.v.toUpperCase() === 'TRUE' };
      else { this.at--; this.fail('bad array item'); }
      rows[rows.length - 1].push(item!);
      if (this.isOp(',')) { this.at++; continue; }
      if (this.isOp(';')) { this.at++; rows.push([]); continue; }
      this.expect('}');
      if (rows.some((r) => r.length !== rows[0].length)) this.fail('ragged array');
      return { k: 'arr', rows };
    }
  }
}

function stripPrefix(name: string): string {
  return name.replace(/^_xlfn\./i, '').replace(/^_xlws\./i, '');
}

/** Parses a formula's text (with or without the leading '='). */
export function parseFormula(text: string): ParseResult {
  const body = text.trim().replace(/^=/, '');
  try {
    const ast = new Parser(tokenize(body), body.length).parse();
    return { ok: true, ast };
  } catch (e) {
    if (e instanceof SyntaxError_) return { ok: false, error: e.message, at: e.at };
    throw e;
  }
}

/* ───────────────────────────── serializing ───────────────────────────── */

/** A sheet name as written in a reference: quoted when it is not a plain word. */
export function quoteSheet(name: string): string {
  const plain = new RegExp(`^[A-Za-z_${ARABIC}][A-Za-z0-9_.${ARABIC}]*$`).test(name) && !CELL_RE.test(name) && !/^(TRUE|FALSE)$/i.test(name);
  return plain ? name : `'${name.replace(/'/g, '\'\'')}'`;
}

export function refText(ref: RefNode): string {
  const prefix = ref.sheet !== undefined ? `${quoteSheet(ref.sheet)}!` : '';
  const col = (c: number, abs: boolean): string => `${abs ? '$' : ''}${columnName(c).toUpperCase()}`;
  const row = (r: number, abs: boolean): string => `${abs ? '$' : ''}${r + 1}`;
  switch (ref.kind) {
    case 'cell': return `${prefix}${col(ref.c1, ref.c1Abs)}${row(ref.r1, ref.r1Abs)}`;
    case 'cols': return `${prefix}${col(ref.c1, ref.c1Abs)}:${col(ref.c2, ref.c2Abs)}`;
    case 'rows': return `${prefix}${row(ref.r1, ref.r1Abs)}:${row(ref.r2, ref.r2Abs)}`;
    default: return `${prefix}${col(ref.c1, ref.c1Abs)}${row(ref.r1, ref.r1Abs)}:${col(ref.c2, ref.c2Abs)}${row(ref.r2, ref.r2Abs)}`;
  }
}

export interface FormatOptions {
  /** Prefix functions newer than Excel 2007 with `_xlfn.`, as the file format requires. */
  xlfn?: boolean;
}

/** The canonical text of a parsed formula, without the leading '='. */
export function formatFormula(node: Node, opts: FormatOptions = {}): string {
  const ser = (n: Node): string => {
    switch (n.k) {
      case 'num': return String(n.v).toUpperCase().replace('E+', 'E+');
      case 'str': return `"${n.v.replace(/"/g, '""')}"`;
      case 'bool': return n.v ? 'TRUE' : 'FALSE';
      case 'err': return n.v;
      case 'ref': return refText(n);
      case 'call': {
        const prefix = opts.xlfn && getFunction(n.name)?.meta.xlfn ? '_xlfn.' : '';
        return `${prefix}${n.name}(${n.args.map(ser).join(',')})`;
      }
      case 'name': return n.name;
      case 'un': return `${n.op}${ser(n.a)}`;
      case 'pct': return `${ser(n.a)}%`;
      case 'bin': return `${ser(n.a)}${n.op}${ser(n.b)}`;
      case 'paren': return `(${ser(n.a)})`;
      case 'arr': return `{${n.rows.map((r) => r.map(ser).join(',')).join(';')}}`;
      default: return '';
    }
  };
  return ser(node);
}

/** A copy of the tree with each reference node replaced by `fn(ref)` (which may return an error node). */
export function mapRefs(node: Node, fn: (ref: RefNode) => Node): Node {
  switch (node.k) {
    case 'ref': return fn(node);
    case 'call': return { ...node, args: node.args.map((a) => mapRefs(a, fn)) };
    case 'un': case 'pct': case 'paren': return { ...node, a: mapRefs(node.a, fn) };
    case 'bin': return { ...node, a: mapRefs(node.a, fn), b: mapRefs(node.b, fn) };
    default: return node;
  }
}

/** Every reference in the tree. */
export function collectRefs(node: Node, out: RefNode[] = []): RefNode[] {
  mapRefs(node, (ref) => { out.push(ref); return ref; });
  return out;
}

/** Every function name called in the tree. */
export function collectCalls(node: Node, out: string[] = []): string[] {
  switch (node.k) {
    case 'call': out.push(node.name); node.args.forEach((a) => collectCalls(a, out)); break;
    case 'un': case 'pct': case 'paren': collectCalls(node.a, out); break;
    case 'bin': collectCalls(node.a, out); collectCalls(node.b, out); break;
    default: break;
  }
  return out;
}

const REF_ERROR: Node = { k: 'err', v: '#REF!' };

/**
 * The formula copied `dRows` rows and `dCols` columns away (fill handle, copy/paste):
 * relative rows/columns move, `$` ones stay. A reference pushed off the sheet
 * becomes #REF!. Returns the text unchanged when it does not parse.
 */
export function translateFormula(text: string, dRows: number, dCols: number): string {
  const parsed = parseFormula(text);
  if (!parsed.ok) return text;
  const moved = mapRefs(parsed.ast, (ref) => {
    const next = { ...ref };
    if (ref.kind !== 'cols') {
      if (!ref.r1Abs) next.r1 += dRows;
      if (!ref.r2Abs) next.r2 += dRows;
    }
    if (ref.kind !== 'rows') {
      if (!ref.c1Abs) next.c1 += dCols;
      if (!ref.c2Abs) next.c2 += dCols;
    }
    return valid(next) ? normalizeRef(next) : REF_ERROR;
  });
  return `=${formatFormula(moved)}`;
}

/** Rows or columns inserted (count > 0) or deleted (count < 0) at zero-based index `at` on `sheet`. */
export interface StructureChange {
  sheet: string;
  axis: 'row' | 'col';
  at: number;
  count: number;
}

/**
 * The formula (which lives on `formulaSheet`) after a structure change: references
 * to cells below/right of the change follow their cells ($ or not, as in Excel);
 * a reference to a deleted cell becomes #REF!; a range loses its deleted part.
 */
export function shiftFormula(text: string, formulaSheet: string, change: StructureChange): string {
  const parsed = parseFormula(text);
  if (!parsed.ok) return text;
  const target = change.sheet.toLowerCase();
  const shifted = mapRefs(parsed.ast, (ref) => {
    const sheet = (ref.sheet ?? formulaSheet).toLowerCase();
    if (sheet !== target) return ref;
    if (change.axis === 'row' && ref.kind === 'cols') return ref;
    if (change.axis === 'col' && ref.kind === 'rows') return ref;
    const [lo, hi] = change.axis === 'row' ? [ref.r1, ref.r2] : [ref.c1, ref.c2];
    let a = lo;
    let b = hi;
    if (change.count > 0) {
      if (a >= change.at) a += change.count;
      if (b >= change.at) b += change.count;
    } else {
      const delStart = change.at;
      const delEnd = change.at - change.count - 1;
      const n = -change.count;
      if (a >= delStart && b <= delEnd) return REF_ERROR;
      const map = (x: number, isEnd: boolean): number => {
        if (x < delStart) return x;
        if (x > delEnd) return x - n;
        return isEnd ? delStart - 1 : delStart; // inside the deleted block: clamp
      };
      a = map(a, false);
      b = map(b, true);
    }
    const next = { ...ref };
    if (change.axis === 'row') { next.r1 = a; next.r2 = b; } else { next.c1 = a; next.c2 = b; }
    return valid(next) ? next : REF_ERROR;
  });
  return `=${formatFormula(shifted)}`;
}
