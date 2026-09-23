/**
 * Fai$al OS Calculator — evaluation engine.
 *
 * Hand-written tokenizer + recursive-descent parser + evaluator.
 * No `eval`/`new Function` anywhere: the whole expression is walked as data.
 */

export type CalcErrorCode = 'syntax' | 'div0' | 'domain' | 'overflow';

export class CalcError extends Error {
  constructor(public code: CalcErrorCode, message: string) {
    super(message);
    this.name = 'CalcError';
  }
}

export type AngleMode = 'deg' | 'rad';

/* ───────────────────────────── Tokenizer ───────────────────────────── */

type TokenType = 'num' | 'ident' | 'op' | 'lparen' | 'rparen' | 'bang' | 'percent' | 'square' | 'end';

interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

const SYMBOL_MAP: Record<string, string> = {
  '×': '*',
  '·': '*',
  '÷': '/',
  '−': '-', // U+2212 minus sign
  'π': 'pi',
  '√': 'sqrt',
};

const IDENT_RE = /[a-zA-Zπ]/;
const DIGIT_RE = /[0-9]/;

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n') { i++; continue; }

    if (DIGIT_RE.test(ch) || ch === '.') {
      let j = i;
      let seenDot = false;
      while (j < n && (DIGIT_RE.test(input[j]) || (input[j] === '.' && !seenDot))) {
        if (input[j] === '.') seenDot = true;
        j++;
      }
      tokens.push({ type: 'num', value: input.slice(i, j), pos: i });
      i = j;
      continue;
    }

    if (IDENT_RE.test(ch)) {
      // Single-char brand symbols (π) map directly; otherwise collect a run of letters.
      if (ch === 'π') {
        tokens.push({ type: 'ident', value: 'pi', pos: i });
        i++;
        continue;
      }
      let j = i;
      while (j < n && /[a-zA-Z]/.test(input[j])) j++;
      tokens.push({ type: 'ident', value: input.slice(i, j).toLowerCase(), pos: i });
      i = j;
      continue;
    }

    if (ch === '√') { tokens.push({ type: 'ident', value: 'sqrt', pos: i }); i++; continue; }
    if (ch === '²') { tokens.push({ type: 'square', value: '²', pos: i }); i++; continue; }
    if (ch === '(') { tokens.push({ type: 'lparen', value: ch, pos: i }); i++; continue; }
    if (ch === ')') { tokens.push({ type: 'rparen', value: ch, pos: i }); i++; continue; }
    if (ch === '!') { tokens.push({ type: 'bang', value: ch, pos: i }); i++; continue; }
    if (ch === '%') { tokens.push({ type: 'percent', value: ch, pos: i }); i++; continue; }

    const mapped = SYMBOL_MAP[ch];
    if (mapped) {
      if (mapped === 'pi' || mapped === 'sqrt') tokens.push({ type: 'ident', value: mapped, pos: i });
      else tokens.push({ type: 'op', value: mapped, pos: i });
      i++;
      continue;
    }

    if ('+-*/^'.includes(ch)) { tokens.push({ type: 'op', value: ch, pos: i }); i++; continue; }
    if (ch === ',') { i++; continue; }

    throw new CalcError('syntax', `Unexpected character "${ch}"`);
  }
  tokens.push({ type: 'end', value: '', pos: n });
  return tokens;
}

/* ───────────────────────────── AST ──────────────────────────────────── */

export type Node =
  | { kind: 'num'; value: number }
  | { kind: 'const'; name: 'pi' | 'e' }
  | { kind: 'bin'; op: '+' | '-' | '*' | '/' | '^'; left: Node; right: Node }
  | { kind: 'unary'; op: 'neg' | 'pos'; arg: Node }
  | { kind: 'postfix'; op: '!' | '%' | 'sq'; arg: Node }
  | { kind: 'call'; fn: string; arg: Node };

const FUNCTIONS = new Set(['sin', 'cos', 'tan', 'ln', 'log', 'sqrt']);
const CONSTANTS = new Set(['pi', 'e']);

/* ───────────────────────────── Parser ───────────────────────────────── */

class Parser {
  private tokens: Token[];
  private idx = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token { return this.tokens[this.idx]; }
  private next(): Token { return this.tokens[this.idx++]; }

  private expect(type: TokenType, what: string): Token {
    const t = this.next();
    if (t.type !== type) throw new CalcError('syntax', `Expected ${what}`);
    return t;
  }

  parse(): Node {
    if (this.peek().type === 'end') throw new CalcError('syntax', 'Empty expression');
    const node = this.parseAdd();
    if (this.peek().type !== 'end') throw new CalcError('syntax', `Unexpected token near position ${this.peek().pos}`);
    return node;
  }

  private parseAdd(): Node {
    let left = this.parseMul();
    for (;;) {
      const t = this.peek();
      if (t.type === 'op' && (t.value === '+' || t.value === '-')) {
        this.next();
        const right = this.parseMul();
        left = { kind: 'bin', op: t.value as '+' | '-', left, right };
      } else break;
    }
    return left;
  }

  private parseMul(): Node {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (t.type === 'op' && (t.value === '*' || t.value === '/')) {
        this.next();
        const right = this.parseUnary();
        left = { kind: 'bin', op: t.value as '*' | '/', left, right };
      } else break;
    }
    return left;
  }

  private parseUnary(): Node {
    const t = this.peek();
    if (t.type === 'op' && (t.value === '-' || t.value === '+')) {
      this.next();
      const arg = this.parseUnary();
      return { kind: 'unary', op: t.value === '-' ? 'neg' : 'pos', arg };
    }
    return this.parsePower();
  }

  private parsePower(): Node {
    const base = this.parsePostfix();
    const t = this.peek();
    if (t.type === 'op' && t.value === '^') {
      this.next();
      const exp = this.parseUnary(); // right-assoc, allows 2^-2
      return { kind: 'bin', op: '^', left: base, right: exp };
    }
    return base;
  }

  private parsePostfix(): Node {
    let node = this.parsePrimary();
    for (;;) {
      const t = this.peek();
      if (t.type === 'bang') { this.next(); node = { kind: 'postfix', op: '!', arg: node }; }
      else if (t.type === 'percent') { this.next(); node = { kind: 'postfix', op: '%', arg: node }; }
      else if (t.type === 'square') { this.next(); node = { kind: 'postfix', op: 'sq', arg: node }; }
      else break;
    }
    return node;
  }

  private parsePrimary(): Node {
    const t = this.next();
    if (t.type === 'num') {
      const v = Number(t.value);
      if (!Number.isFinite(v)) throw new CalcError('syntax', 'Invalid number');
      return { kind: 'num', value: v };
    }
    if (t.type === 'lparen') {
      const inner = this.parseAdd();
      this.expect('rparen', '")"');
      return inner;
    }
    if (t.type === 'ident') {
      if (CONSTANTS.has(t.value)) return { kind: 'const', name: t.value as 'pi' | 'e' };
      if (FUNCTIONS.has(t.value)) {
        this.expect('lparen', '"(" after function name');
        const arg = this.parseAdd();
        this.expect('rparen', '")"');
        return { kind: 'call', fn: t.value, arg };
      }
      throw new CalcError('syntax', `Unknown identifier "${t.value}"`);
    }
    throw new CalcError('syntax', 'Expected a number, "(", or a function');
  }
}

/* ───────────────────────────── Evaluator ─────────────────────────────── */

function factorial(n: number): number {
  if (!Number.isFinite(n) || n < 0 || Math.floor(n) !== n) {
    throw new CalcError('domain', 'Factorial requires a non-negative integer');
  }
  if (n > 170) return Infinity;
  let r = 1;
  for (let k = 2; k <= n; k++) r *= k;
  return r;
}

export function evaluate(node: Node, angleMode: AngleMode): number {
  switch (node.kind) {
    case 'num':
      return node.value;
    case 'const':
      return node.name === 'pi' ? Math.PI : Math.E;
    case 'unary': {
      const v = evaluate(node.arg, angleMode);
      return node.op === 'neg' ? -v : v;
    }
    case 'postfix': {
      const v = evaluate(node.arg, angleMode);
      if (node.op === '!') return factorial(v);
      if (node.op === 'sq') return v * v;
      return v / 100; // '%'
    }
    case 'call': {
      const v = evaluate(node.arg, angleMode);
      switch (node.fn) {
        case 'sin': return Math.sin(angleMode === 'deg' ? (v * Math.PI) / 180 : v);
        case 'cos': return Math.cos(angleMode === 'deg' ? (v * Math.PI) / 180 : v);
        case 'tan': return Math.tan(angleMode === 'deg' ? (v * Math.PI) / 180 : v);
        case 'ln':
          if (v <= 0) throw new CalcError('domain', 'ln requires a positive number');
          return Math.log(v);
        case 'log':
          if (v <= 0) throw new CalcError('domain', 'log requires a positive number');
          return Math.log10(v);
        case 'sqrt':
          if (v < 0) throw new CalcError('domain', 'Square root of a negative number');
          return Math.sqrt(v);
        default:
          throw new CalcError('syntax', `Unknown function "${node.fn}"`);
      }
    }
    case 'bin': {
      const l = evaluate(node.left, angleMode);
      const r = evaluate(node.right, angleMode);
      switch (node.op) {
        case '+': return l + r;
        case '-': return l - r;
        case '*': return l * r;
        case '/':
          if (r === 0) throw new CalcError('div0', 'Division by zero');
          return l / r;
        case '^':
          return Math.pow(l, r);
      }
    }
  }
}

/** Parses and evaluates a full expression string. Throws CalcError on any problem. */
export function calc(input: string, angleMode: AngleMode = 'deg'): number {
  const tokens = tokenize(input);
  const ast = new Parser(tokens).parse();
  const result = evaluate(ast, angleMode);
  if (!Number.isFinite(result)) {
    if (Number.isNaN(result)) throw new CalcError('domain', 'Result is not a number');
    throw new CalcError('overflow', 'Result is too large');
  }
  return result;
}

/** Parses only (used to validate expressions as the user types, e.g. for paren balance). */
export function parse(input: string): Node {
  return new Parser(tokenize(input)).parse();
}

/* ───────────────────────────── Formatting ─────────────────────────────── */

const ARABIC_INDIC = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];

/** Rounds to ~12 significant digits to hide binary floating-point artifacts (0.1+0.2). */
export function roundSignificant(value: number, digits = 12): number {
  if (value === 0 || !Number.isFinite(value)) return value;
  return Number(value.toPrecision(digits));
}

export interface FormatOptions {
  arabicDigits?: boolean;
  maxSignificant?: number;
}

/** Formats a number for display: rounds artifacts away, adds thousands separators. */
export function formatNumber(value: number, opts: FormatOptions = {}): string {
  const maxSig = opts.maxSignificant ?? 12;
  if (!Number.isFinite(value)) return value > 0 ? '∞' : (Number.isNaN(value) ? 'NaN' : '-∞');

  let rounded = Number(value.toPrecision(maxSig));
  if (Object.is(rounded, -0)) rounded = 0;

  const abs = Math.abs(rounded);
  let text: string;
  if (abs !== 0 && (abs >= 1e21 || abs < 1e-9)) {
    text = rounded.toExponential(6).replace(/\.?0+e/, 'e');
  } else {
    // Avoid scientific notation & trim float noise via toPrecision then back to plain string.
    text = rounded.toString();
    if (text.includes('e')) text = rounded.toFixed(20).replace(/0+$/, '').replace(/\.$/, '');
    const [intPartRaw, fracPartRaw] = text.split('.');
    const neg = intPartRaw.startsWith('-');
    const intDigits = neg ? intPartRaw.slice(1) : intPartRaw;
    const withSep = intDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    text = (neg ? '-' : '') + withSep + (fracPartRaw ? '.' + fracPartRaw : '');
  }

  if (opts.arabicDigits) {
    text = text.replace(/[0-9]/g, (d) => ARABIC_INDIC[Number(d)]);
  }
  return text;
}
