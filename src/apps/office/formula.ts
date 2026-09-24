/**
 * Office — the small formula engine (محرّك معادلات صغير).
 *
 * Exactly what the app promises and nothing more: `+ - * /`, parentheses, cell
 * references and ranges (`A1`, `A1:B5`), and two functions — SUM and AVERAGE
 * (المتوسط). No other function, no `^`, no percentages, no cross-sheet reference.
 *
 * The engine is pure: it evaluates against the grid it is given and returns both
 * the value written into the cell and the canonical English text for `<f>`, so the
 * formula Excel is shown is the same one the app computed. An input that does not
 * parse is not a formula at all (`ok: false`), and the caller stores the typed
 * text as a plain value rather than pretending.
 */
import { gridAt, type CellState, type Grid, type SheetsModel } from './model';
import { columnIndex } from '../viewer/formats';
import { columnName, isNumericText } from './xml';

/** The Excel error texts this engine can produce. */
export type FormulaError = '#VALUE!' | '#DIV/0!' | '#REF!' | '#NAME!';

export interface FormulaOutcome {
  /** True when the text parsed as a formula; false means it is plain text. */
  ok: boolean;
  /** The text to write into the cell: a number, or an Excel error. */
  value: string;
  /** The canonical formula for `<f>`, without the leading '='; null when it did not parse. */
  canonical: string | null;
}

/** The only two functions, with their accepted names (English and Arabic). */
const FUNCTIONS: Record<string, 'SUM' | 'AVERAGE'> = {
  sum: 'SUM', مجموع: 'SUM', المجموع: 'SUM',
  average: 'AVERAGE', متوسط: 'AVERAGE', المتوسط: 'AVERAGE',
};

type Token =
  | { kind: 'number'; value: number }
  | { kind: 'ref'; row: number; col: number }
  | { kind: 'name'; name: string }
  | { kind: 'op'; op: string };

type Node =
  | { kind: 'number'; value: number }
  | { kind: 'ref'; row: number; col: number }
  | { kind: 'range'; a: { row: number; col: number }; b: { row: number; col: number } }
  | { kind: 'call'; fn: 'SUM' | 'AVERAGE'; args: Node[] }
  | { kind: 'binary'; op: string; left: Node; right: Node }
  | { kind: 'unary'; op: string; operand: Node };

interface Cell { row: number; col: number }

const NAME_CHARS = /[A-Za-z_$\u0600-\u06FF]/;

/** Splits a formula body into tokens, or null when it holds something else. */
function tokenize(text: string): Token[] | null {
  const out: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(text[i + 1] ?? ''))) {
      const match = /^\d*\.?\d+(?:[eE][+-]?\d+)?/.exec(text.slice(i));
      if (!match) return null;
      out.push({ kind: 'number', value: Number(match[0]) });
      i += match[0].length;
      continue;
    }
    if ('+-*/():'.includes(ch)) { out.push({ kind: 'op', op: ch }); i++; continue; }
    if (ch === ',' || ch === ';' || ch === '،') { out.push({ kind: 'op', op: ',' }); i++; continue; }
    if (NAME_CHARS.test(ch)) {
      const match = /^[A-Za-z_$\u0600-\u06FF]+[0-9]*/.exec(text.slice(i));
      if (!match) return null;
      const raw = match[0];
      i += raw.length;
      const cell = /^([A-Za-z$]+)([0-9]+)$/.exec(raw);
      if (cell) {
        const letters = cell[1].replace(/\$/g, '');
        const col = columnIndex(letters);
        const row = Number(cell[2]) - 1;
        if (col < 0 || row < 0 || !letters) return null; // "A0" and the like
        out.push({ kind: 'ref', row, col });
        continue;
      }
      out.push({ kind: 'name', name: raw });
      continue;
    }
    return null;
  }
  return out;
}

/** Recursive descent over the token list; `parse()` returns null on any syntax error. */
class Reader {
  private at = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  private peek(): Token | undefined { return this.tokens[this.at]; }

  private take(): Token | undefined { return this.tokens[this.at++]; }

  private eat(op: string): boolean {
    const token = this.peek();
    if (token?.kind === 'op' && token.op === op) { this.at++; return true; }
    return false;
  }

  parse(): Node | null {
    const node = this.expression();
    return node && this.at === this.tokens.length ? node : null;
  }

  private expression(): Node | null {
    let left = this.term();
    if (!left) return null;
    for (;;) {
      const token = this.peek();
      if (token?.kind !== 'op' || (token.op !== '+' && token.op !== '-')) return left;
      this.take();
      const right = this.term();
      if (!right) return null;
      left = { kind: 'binary', op: token.op, left, right };
    }
  }

  private term(): Node | null {
    let left = this.factor();
    if (!left) return null;
    for (;;) {
      const token = this.peek();
      if (token?.kind !== 'op' || (token.op !== '*' && token.op !== '/')) return left;
      this.take();
      const right = this.factor();
      if (!right) return null;
      left = { kind: 'binary', op: token.op, left, right };
    }
  }

  private factor(): Node | null {
    const token = this.take();
    if (!token) return null;
    if (token.kind === 'number') return { kind: 'number', value: token.value };
    if (token.kind === 'op' && (token.op === '-' || token.op === '+')) {
      const operand = this.factor();
      return operand ? { kind: 'unary', op: token.op, operand } : null;
    }
    if (token.kind === 'op' && token.op === '(') {
      const inner = this.expression();
      return inner && this.eat(')') ? inner : null;
    }
    if (token.kind === 'ref') {
      if (this.eat(':')) {
        const end = this.take();
        if (end?.kind !== 'ref') return null;
        return { kind: 'range', a: { row: token.row, col: token.col }, b: { row: end.row, col: end.col } };
      }
      return { kind: 'ref', row: token.row, col: token.col };
    }
    if (token.kind === 'name') {
      const fn = FUNCTIONS[token.name.toLowerCase()] ?? FUNCTIONS[token.name];
      if (!fn || !this.eat('(')) return null;
      const args: Node[] = [];
      for (;;) {
        const arg = this.expression();
        if (!arg) return null;
        args.push(arg);
        if (this.eat(',')) continue;
        return this.eat(')') ? { kind: 'call', fn, args } : null;
      }
    }
    return null;
  }
}

/**
 * The canonical English text of a parsed formula, without the leading '='. A
 * nested sum or product keeps its parentheses, so re-parsing the text gives back
 * the same expression tree.
 */
function serialize(node: Node, nested = false): string {
  switch (node.kind) {
    case 'number': return String(node.value);
    case 'ref': return `${columnName(node.col).toUpperCase()}${node.row + 1}`;
    case 'range': return `${serialize({ kind: 'ref', row: node.a.row, col: node.a.col })}:${serialize({ kind: 'ref', row: node.b.row, col: node.b.col })}`;
    case 'call': return `${node.fn}(${node.args.map((arg) => serialize(arg)).join(',')})`;
    case 'unary': return `${node.op}${serialize(node.operand, true)}`;
    default: {
      const text = `${serialize(node.left, true)}${node.op}${serialize(node.right, true)}`;
      return nested ? `(${text})` : text;
    }
  }
}

/** Every cell of a range, lowest row/column first, whatever order it was written in. */
function rangeCells(range: { a: Cell; b: Cell }): Cell[] {
  const out: Cell[] = [];
  for (let row = Math.min(range.a.row, range.b.row); row <= Math.max(range.a.row, range.b.row); row++) {
    for (let col = Math.min(range.a.col, range.b.col); col <= Math.max(range.a.col, range.b.col); col++) out.push({ row, col });
  }
  return out;
}

/** A cell's number: empty is 0, an error text carries on, anything else is #VALUE!. */
function cellNumber(grid: Grid, cell: Cell): number | FormulaError {
  const raw = (grid.rows[cell.row]?.[cell.col] ?? '').trim();
  if (raw === '') return 0;
  if (raw.startsWith('#')) return raw as FormulaError;
  return isNumericText(raw) ? Number(raw) : '#VALUE!';
}

function isError(value: unknown): value is FormulaError {
  return typeof value === 'string';
}

interface Ctx { grid: Grid; self: Cell | null }

/** Numbers a value contributes: a range contributes its numeric cells, and carries an error on. */
function numbersOf(node: Node, ctx: Ctx): number[] | FormulaError {
  if (node.kind === 'range') {
    const out: number[] = [];
    for (const cell of rangeCells(node)) {
      if (ctx.self && cell.row === ctx.self.row && cell.col === ctx.self.col) return '#REF!';
      const raw = (ctx.grid.rows[cell.row]?.[cell.col] ?? '').trim();
      if (raw.startsWith('#')) return raw as FormulaError; // an error inside the range wins, as in Excel
      if (isNumericText(raw)) out.push(Number(raw));
    }
    return out;
  }
  const value = evaluate(node, ctx);
  return isError(value) ? value : [value];
}

function evaluate(node: Node, ctx: Ctx): number | FormulaError {
  switch (node.kind) {
    case 'number': return node.value;
    case 'ref': {
      if (ctx.self && node.row === ctx.self.row && node.col === ctx.self.col) return '#REF!';
      return cellNumber(ctx.grid, node);
    }
    case 'unary': {
      const value = evaluate(node.operand, ctx);
      return isError(value) ? value : node.op === '-' ? -value : value;
    }
    case 'call': {
      const numbers: number[] = [];
      for (const arg of node.args) {
        const part = numbersOf(arg, ctx);
        if (isError(part)) return part;
        numbers.push(...part);
      }
      const total = numbers.reduce((sum, value) => sum + value, 0);
      if (node.fn === 'SUM') return total;
      return numbers.length ? total / numbers.length : '#DIV/0!';
    }
    case 'range': return '#VALUE!'; // a range outside a function has no single value
    default: {
      const left = evaluate(node.left, ctx);
      if (isError(left)) return left;
      const right = evaluate(node.right, ctx);
      if (isError(right)) return right;
      if (node.op === '+') return left + right;
      if (node.op === '-') return left - right;
      if (node.op === '*') return left * right;
      if (right === 0) return '#DIV/0!';
      return left / right;
    }
  }
}

/** Trims floating-point noise the way a spreadsheet shows it. */
function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '#VALUE!';
  const rounded = Number(value.toPrecision(12));
  return String(rounded === 0 ? 0 : rounded);
}

/**
 * Evaluates one cell's text. `self` is the address the formula sits in: a formula
 * that refers to itself is refused (#REF!) instead of reading its own stale value.
 */
export function evaluateFormula(input: string, grid: Grid, self: Cell | null = null): FormulaOutcome {
  const trimmed = input.trim();
  if (!trimmed.startsWith('=')) return { ok: false, value: input, canonical: null };
  const tokens = tokenize(trimmed.slice(1));
  const node = tokens && tokens.length ? new Reader(tokens).parse() : null;
  if (!node) return { ok: false, value: '#VALUE!', canonical: null };
  const value = evaluate(node, { grid, self });
  return { ok: true, value: isError(value) ? value : formatNumber(value), canonical: serialize(node) };
}

/**
 * The cell state a piece of text means when it is put into a cell. Shared by the
 * cell input and by find & replace, so the two can never disagree about what typing
 * in a cell does: in an .xlsx a text starting with `=` is evaluated at once — the
 * result goes into the grid, the canonical formula into `<f>` — while anything else,
 * including a half-typed formula, stays plain text. A CSV has no formulas at all.
 */
export function cellStateForText(
  model: SheetsModel,
  sheet: number,
  row: number,
  col: number,
  text: string,
): CellState {
  if (model.kind !== 'xlsx' || !text.trimStart().startsWith('=')) return { value: text };
  const grid = gridAt(model, sheet);
  const outcome = grid ? evaluateFormula(text.trim(), grid, { row, col }) : null;
  return outcome?.ok && outcome.canonical
    ? { value: outcome.value, formula: `=${outcome.canonical}` }
    : { value: text };
}

/**
 * The sheet with every stored formula's value recomputed — what "يُحسب عند التعديل"
 * means when a cell a formula points at is edited afterwards. Formulas are
 * evaluated in key order against the values computed so far, so a chain works and
 * a cycle stays bounded (a self-reference is refused by `evaluateFormula`).
 */
export function computeFormulaCells(model: SheetsModel): SheetsModel {
  const formulas = model.formulas;
  if (!formulas || !Object.keys(formulas).length) return model;
  let changed = false;
  const grids = model.grids.map((grid, sheet) => {
    let rows = grid.rows;
    let touched = false;
    for (const [key, formula] of Object.entries(formulas)) {
      const [at, rowText, colText] = key.split(':');
      if (Number(at) !== sheet) continue;
      const row = Number(rowText);
      const col = Number(colText);
      if (!Number.isInteger(row) || !Number.isInteger(col)) continue;
      const outcome = evaluateFormula(formula, { ...grid, rows }, { row, col });
      const value = outcome.ok ? outcome.value : formula;
      if ((rows[row]?.[col] ?? '') === value) continue;
      const copy = rows.map((line) => line);
      while (copy.length <= row) copy.push([]);
      const line = (copy[row] ?? []).slice();
      while (line.length <= col) line.push('');
      line[col] = value;
      copy[row] = line;
      rows = copy;
      touched = true;
    }
    if (touched) { changed = true; return { ...grid, rows }; }
    return grid;
  });
  return changed ? { ...model, grids } : model;
}
