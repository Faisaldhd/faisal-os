/**
 * Office Calc engine — the workbook: cells, formulas and the dependency graph
 * (المصنّف ورسم الاعتماديات).
 *
 *   const wb = new Workbook({ now: () => new Date() });
 *   wb.addSheet('Sheet1');                        // → sheet index
 *   wb.setCell('Sheet1', 0, 0, '12');             // typed text: numbers/TRUE/#N/A are typed
 *   wb.setCell('Sheet1', 0, 1, '=A1*2');          // a formula → { ok: true } or { ok: false, error }
 *   wb.setValue('Sheet1', 0, 2, 3.5);             // a typed scalar
 *   wb.getValue('Sheet1', 0, 1);                  // 24 (recalculates first when needed)
 *   wb.getText('Sheet1', 0, 1);                   // "24" (General format)
 *   wb.getFormula('Sheet1', 0, 1);                // "=A1*2" (canonical English)
 *   wb.recalc();                                  // → the formula cells whose value changed
 *   wb.evaluate('=SUM(A1:B1)', 'Sheet1', 5, 5);   // a one-off value (formula bar preview)
 *   wb.isCircular('Sheet1', 0, 1);                // part of a reference cycle?
 *   wb.renameSheet('Sheet1', 'Data');             // formulas pointing at it are rewritten
 *   wb.removeSheet('Data');                       // formulas pointing at it become #REF!
 *
 * Sheets are addressed by name (case-insensitive) or index; rows/cols are zero-based.
 *
 * Recalculation is incremental: a change marks the changed cell; recalc() walks
 * the reverse dependency graph (point references in a map, ranges bucketed by
 * 64-row blocks, tall ranges such as A:A in their own list) to find every
 * affected formula, orders them topologically (iteratively, so a 10,000-long
 * chain is fine), and evaluates each once. Volatile formulas (TODAY, NOW,
 * OFFSET, RAND) are recalculated every time. A reference cycle gives #REF! in
 * every cell of the cycle (Excel's file format has no #CIRC error) and
 * isCircular() reports it so the UI can warn.
 */
import { evaluateNode, finalValue, implicitScalar, type EvalEnv } from './evaluator';
import { collectCalls, collectRefs, formatFormula, MAX_COLS, MAX_ROWS, parseFormula, type Node } from './parser';
import { getFunction } from './registry';
import { lookupKey } from './functions/helpers';
import {
  CellError, ERR, RefArea, scalarFromText, scalarToText, type Area, type CellReader, type Scalar,
} from './values';

const SHEET_STRIDE = 2 ** 34;
const ROW_STRIDE = 16384;
const BLOCK_SHIFT = 6; // 64-row blocks
const BIG_RANGE_BLOCKS = 32;

/** One range read by one or more formulas (formulas reading the same range share it). */
interface RangeDep { key: string; owners: Set<number>; sheetId: number; r1: number; c1: number; r2: number; c2: number; blocks: number[] | null }

interface FormulaInfo {
  text: string;
  ast: Node;
  volatile: boolean;
  points: number[];
  ranges: RangeDep[];
}

interface CellRec { value: Scalar; formula?: FormulaInfo }

interface SheetRec {
  id: number;
  name: string;
  cells: Map<number, CellRec>;
  rows: number;
  cols: number;
  blocks: Map<number, Set<RangeDep>>;
  big: Set<RangeDep>;
}

interface CacheEntry { sheetId: number; r1: number; c1: number; r2: number; c2: number; hits: number; map?: Map<string, number> }

export interface CellAddress { sheet: string; row: number; col: number }
export type SetResult = { ok: true } | { ok: false; error: string };
export interface WorkbookOptions { now?: () => Date }

export class Workbook {
  private readonly sheets: SheetRec[] = [];
  private readonly byId = new Map<number, SheetRec>();
  private nextSheetId = 1;
  private readonly pointDeps = new Map<number, Set<number>>();
  private readonly rangeGroups = new Map<string, RangeDep>();
  private readonly volatiles = new Set<number>();
  private readonly pending = new Set<number>();
  private readonly circular = new Set<number>();
  private readonly cache = new Map<string, CacheEntry>();
  private readonly now: () => Date;
  /* recalc state */
  private dirty: Set<number> | null = null;
  private computed = new Set<number>();
  private computing = new Set<number>();
  private changed: number[] = [];
  private readonly reader: CellReader;

  constructor(opts: WorkbookOptions = {}) {
    this.now = opts.now ?? (() => new Date());
    this.reader = {
      value: (sheetId, row, col) => this.readCell(sheetId, row, col),
      extent: (sheetId) => {
        const s = this.byId.get(sheetId);
        return s ? { rows: s.rows, cols: s.cols } : { rows: 0, cols: 0 };
      },
    };
  }

  /* ───────────────────────────── sheets ───────────────────────────── */

  addSheet(name: string): number {
    if (this.findSheet(name)) throw new Error(`sheet exists: ${name}`);
    const rec: SheetRec = { id: this.nextSheetId++, name, cells: new Map(), rows: 0, cols: 0, blocks: new Map(), big: new Set() };
    this.sheets.push(rec);
    this.byId.set(rec.id, rec);
    this.rebindAll();
    return this.sheets.length - 1;
  }

  sheetNames(): string[] {
    return this.sheets.map((s) => s.name);
  }

  renameSheet(sheet: string | number, name: string): void {
    const rec = this.sheet(sheet);
    const other = this.findSheet(name);
    if (other && other !== rec) throw new Error(`sheet exists: ${name}`);
    const old = rec.name.toLowerCase();
    rec.name = name;
    for (const s of this.sheets) {
      for (const cell of s.cells.values()) {
        if (!cell.formula) continue;
        let touched = false;
        for (const ref of collectRefs(cell.formula.ast)) {
          if (ref.sheet !== undefined && ref.sheet.toLowerCase() === old) { ref.sheet = name; touched = true; }
        }
        if (touched) cell.formula.text = `=${formatFormula(cell.formula.ast)}`;
      }
    }
    this.rebindAll();
  }

  removeSheet(sheet: string | number): void {
    const rec = this.sheet(sheet);
    for (const [local, cell] of rec.cells) if (cell.formula) this.unbind(this.gk(rec.id, local), cell.formula);
    this.sheets.splice(this.sheets.indexOf(rec), 1);
    this.byId.delete(rec.id);
    for (const k of [...this.pending]) if (Math.floor(k / SHEET_STRIDE) === rec.id) this.pending.delete(k);
    this.cache.clear();
    this.rebindAll();
  }

  /* ───────────────────────────── cells ───────────────────────────── */

  /**
   * Sets a cell from typed text: "=…" is a formula, numbers/TRUE/FALSE/error
   * texts are typed, "" clears, anything else is text. A formula that does not
   * parse is stored as text and reported with ok: false.
   */
  setCell(sheet: string | number, row: number, col: number, input: string | number | boolean | null): SetResult {
    if (typeof input === 'string' && input.startsWith('=') && input.length > 1) {
      const parsed = parseFormula(input);
      if (!parsed.ok) {
        this.store(sheet, row, col, input, undefined);
        return { ok: false, error: parsed.error };
      }
      this.store(sheet, row, col, 0, parsed.ast);
      return { ok: true };
    }
    const value = typeof input === 'string' ? scalarFromText(input) : input;
    this.store(sheet, row, col, value, undefined);
    return { ok: true };
  }

  /** Sets a typed value (never a formula; a text starting with '=' stays text). */
  setValue(sheet: string | number, row: number, col: number, value: Scalar): void {
    this.store(sheet, row, col, value, undefined);
  }

  getValue(sheet: string | number, row: number, col: number): Scalar {
    this.ensureCalculated();
    const rec = this.sheet(sheet);
    return rec.cells.get(row * ROW_STRIDE + col)?.value ?? null;
  }

  /** The General-format text of a cell (what a plain grid shows). */
  getText(sheet: string | number, row: number, col: number): string {
    return scalarToText(this.getValue(sheet, row, col));
  }

  /** The canonical formula of a cell ("=SUM(A1:A2)"), or undefined. */
  getFormula(sheet: string | number, row: number, col: number): string | undefined {
    return this.sheet(sheet).cells.get(row * ROW_STRIDE + col)?.formula?.text;
  }

  /** The used size of a sheet (one past the last non-blank row/column). */
  extent(sheet: string | number): { rows: number; cols: number } {
    const s = this.sheet(sheet);
    return { rows: s.rows, cols: s.cols };
  }

  /** Every formula cell of a sheet, as [row, col, formula]. */
  formulas(sheet: string | number): Array<[number, number, string]> {
    const out: Array<[number, number, string]> = [];
    for (const [local, cell] of this.sheet(sheet).cells) {
      if (cell.formula) out.push([Math.floor(local / ROW_STRIDE), local % ROW_STRIDE, cell.formula.text]);
    }
    return out;
  }

  isCircular(sheet: string | number, row: number, col: number): boolean {
    this.ensureCalculated();
    return this.circular.has(this.gk(this.sheet(sheet).id, row * ROW_STRIDE + col));
  }

  /** Evaluates a formula as if it sat at (row, col) of `sheet`, without storing it. */
  evaluate(formula: string, sheet: string | number, row: number, col: number): Scalar {
    this.ensureCalculated();
    const parsed = parseFormula(formula);
    if (!parsed.ok) return ERR.VALUE;
    const env = this.env(this.sheet(sheet).id, row, col);
    return finalValue(evaluateNode(parsed.ast, env), env);
  }

  /** Recalculates everything affected since the last recalc; returns the formula cells whose value changed. */
  recalc(): CellAddress[] {
    if (!this.pending.size && !this.volatiles.size) return [];
    const dirty = this.collectDirty();
    const order = this.topoOrder(dirty);
    this.dirty = dirty;
    this.computed = new Set();
    this.changed = [];
    try {
      for (const k of order.order) {
        if (this.computed.has(k)) continue;
        if (order.cyclic.has(k)) {
          this.computed.add(k);
          this.circular.add(k);
          this.write(k, ERR.REF);
          continue;
        }
        this.compute(k);
      }
    } finally {
      this.dirty = null;
      this.computed = new Set();
    }
    const out = this.changed.map((k) => this.address(k));
    this.changed = [];
    return out;
  }

  /** Marks every formula for recalculation (e.g. after the clock or a registered function changed). */
  invalidateAll(): void {
    for (const s of this.sheets) for (const [local, cell] of s.cells) if (cell.formula) this.pending.add(this.gk(s.id, local));
  }

  /* ───────────────────────────── internals ───────────────────────────── */

  private gk(sheetId: number, local: number): number {
    return sheetId * SHEET_STRIDE + local;
  }

  private address(k: number): CellAddress {
    const sheetId = Math.floor(k / SHEET_STRIDE);
    const local = k - sheetId * SHEET_STRIDE;
    return { sheet: this.byId.get(sheetId)?.name ?? '', row: Math.floor(local / ROW_STRIDE), col: local % ROW_STRIDE };
  }

  private findSheet(name: string | undefined): SheetRec | undefined {
    if (name === undefined) return undefined;
    const lower = name.toLowerCase();
    return this.sheets.find((s) => s.name.toLowerCase() === lower);
  }

  private sheet(sheet: string | number): SheetRec {
    const rec = typeof sheet === 'number' ? this.sheets[sheet] : this.findSheet(sheet);
    if (!rec) throw new Error(`no such sheet: ${sheet}`);
    return rec;
  }

  private ensureCalculated(): void {
    if (!this.dirty && (this.pending.size || this.volatiles.size)) this.recalc();
  }

  private store(sheet: string | number, row: number, col: number, value: Scalar, ast: Node | undefined): void {
    if (row < 0 || col < 0 || row >= MAX_ROWS || col >= MAX_COLS) throw new Error('cell out of range');
    const rec = this.sheet(sheet);
    const local = row * ROW_STRIDE + col;
    const k = this.gk(rec.id, local);
    const old = rec.cells.get(local);
    if (old?.formula) { this.unbind(k, old.formula); this.invalidateCache(rec.id, row, col); }
    this.circular.delete(k);
    if (ast) {
      const cell: CellRec = { value: old?.value ?? null, formula: { text: `=${formatFormula(ast)}`, ast, volatile: false, points: [], ranges: [] } };
      rec.cells.set(local, cell);
      this.bind(k, rec, cell.formula!);
      this.grow(rec, row, col);
    } else if (value === null || value === '') {
      if (value === '') { rec.cells.set(local, { value: '' }); this.grow(rec, row, col); } else rec.cells.delete(local);
      this.invalidateCache(rec.id, row, col);
    } else {
      rec.cells.set(local, { value });
      this.grow(rec, row, col);
      this.invalidateCache(rec.id, row, col);
    }
    this.pending.add(k);
  }

  private grow(rec: SheetRec, row: number, col: number): void {
    if (row >= rec.rows) rec.rows = row + 1;
    if (col >= rec.cols) rec.cols = col + 1;
  }

  private bind(k: number, own: SheetRec, f: FormulaInfo): void {
    f.points = [];
    f.ranges = [];
    f.volatile = collectCalls(f.ast).some((name) => getFunction(name)?.meta.volatile);
    if (f.volatile) this.volatiles.add(k);
    for (const ref of collectRefs(f.ast)) {
      const target = ref.sheet === undefined ? own : this.findSheet(ref.sheet);
      if (!target) continue;
      if (ref.kind === 'cell') {
        const pk = this.gk(target.id, ref.r1 * ROW_STRIDE + ref.c1);
        f.points.push(pk);
        let set = this.pointDeps.get(pk);
        if (!set) this.pointDeps.set(pk, (set = new Set()));
        set.add(k);
        continue;
      }
      const key = `${target.id}:${ref.r1}:${ref.c1}:${ref.r2}:${ref.c2}`;
      let dep = this.rangeGroups.get(key);
      if (!dep) {
        dep = { key, owners: new Set(), sheetId: target.id, r1: ref.r1, c1: ref.c1, r2: ref.r2, c2: ref.c2, blocks: null };
        this.rangeGroups.set(key, dep);
        const b1 = ref.r1 >> BLOCK_SHIFT;
        const b2 = ref.r2 >> BLOCK_SHIFT;
        if (b2 - b1 + 1 > BIG_RANGE_BLOCKS) target.big.add(dep);
        else {
          dep.blocks = [];
          for (let b = b1; b <= b2; b++) {
            dep.blocks.push(b);
            let set = target.blocks.get(b);
            if (!set) target.blocks.set(b, (set = new Set()));
            set.add(dep);
          }
        }
      }
      dep.owners.add(k);
      if (!f.ranges.includes(dep)) f.ranges.push(dep);
    }
  }

  private unbind(k: number, f: FormulaInfo): void {
    for (const pk of f.points) this.pointDeps.get(pk)?.delete(k);
    for (const dep of f.ranges) {
      dep.owners.delete(k);
      if (dep.owners.size) continue;
      this.rangeGroups.delete(dep.key);
      const target = this.byId.get(dep.sheetId);
      if (!target) continue;
      if (dep.blocks) for (const b of dep.blocks) target.blocks.get(b)?.delete(dep);
      else target.big.delete(dep);
    }
    this.volatiles.delete(k);
    f.points = [];
    f.ranges = [];
  }

  private rebindAll(): void {
    this.pointDeps.clear();
    this.rangeGroups.clear();
    this.volatiles.clear();
    for (const s of this.sheets) { s.blocks.clear(); s.big.clear(); }
    for (const s of this.sheets) {
      for (const [local, cell] of s.cells) {
        if (!cell.formula) continue;
        const k = this.gk(s.id, local);
        this.bind(k, s, cell.formula);
        this.pending.add(k);
      }
    }
  }

  private isFormula(k: number): boolean {
    const sheetId = Math.floor(k / SHEET_STRIDE);
    return !!this.byId.get(sheetId)?.cells.get(k - sheetId * SHEET_STRIDE)?.formula;
  }

  /** The formulas that read cell k directly. */
  private dependentsOf(k: number, visit: (owner: number) => void, done: Set<RangeDep>): void {
    const points = this.pointDeps.get(k);
    if (points) for (const owner of points) visit(owner);
    const sheetId = Math.floor(k / SHEET_STRIDE);
    const s = this.byId.get(sheetId);
    if (!s) return;
    const local = k - sheetId * SHEET_STRIDE;
    const row = Math.floor(local / ROW_STRIDE);
    const col = local % ROW_STRIDE;
    const test = (dep: RangeDep): void => {
      if (done.has(dep) || row < dep.r1 || row > dep.r2 || col < dep.c1 || col > dep.c2) return;
      done.add(dep); // every owner is visited once per recalc
      for (const owner of dep.owners) visit(owner);
    };
    const block = s.blocks.get(row >> BLOCK_SHIFT);
    if (block) for (const dep of block) test(dep);
    for (const dep of s.big) test(dep);
  }

  private collectDirty(): Set<number> {
    const dirty = new Set<number>();
    const seen = new Set<number>();
    const done = new Set<RangeDep>();
    const queue: number[] = [];
    const push = (k: number): void => { if (!seen.has(k)) { seen.add(k); queue.push(k); } };
    for (const k of this.pending) push(k);
    for (const k of this.volatiles) push(k);
    this.pending.clear();
    for (let i = 0; i < queue.length; i++) {
      const k = queue[i];
      if (this.isFormula(k)) dirty.add(k);
      this.dependentsOf(k, push, done);
    }
    return dirty;
  }

  private topoOrder(dirty: Set<number>): { order: number[]; cyclic: Set<number> } {
    // Dirty formula rows by sheet and column, to find the dirty cells inside a range quickly.
    const byCol = new Map<number, Map<number, number[]>>();
    for (const k of dirty) {
      const sheetId = Math.floor(k / SHEET_STRIDE);
      const local = k - sheetId * SHEET_STRIDE;
      let cols = byCol.get(sheetId);
      if (!cols) byCol.set(sheetId, (cols = new Map()));
      const col = local % ROW_STRIDE;
      let rows = cols.get(col);
      if (!rows) cols.set(col, (rows = []));
      rows.push(Math.floor(local / ROW_STRIDE));
    }
    const precedents = (k: number): number[] => {
      const sheetId = Math.floor(k / SHEET_STRIDE);
      const f = this.byId.get(sheetId)?.cells.get(k - sheetId * SHEET_STRIDE)?.formula;
      if (!f) return [];
      const out: number[] = [];
      for (const p of f.points) if (dirty.has(p)) out.push(p);
      for (const dep of f.ranges) {
        const cols = byCol.get(dep.sheetId);
        if (!cols) continue;
        const sheet = this.byId.get(dep.sheetId)!;
        const cEnd = Math.min(dep.c2, sheet.cols - 1);
        if (cEnd - dep.c1 > cols.size) {
          for (const [c, rows] of cols) {
            if (c < dep.c1 || c > cEnd) continue;
            for (const r of rows) if (r >= dep.r1 && r <= dep.r2) out.push(this.gk(dep.sheetId, r * ROW_STRIDE + c));
          }
        } else {
          for (let c = dep.c1; c <= cEnd; c++) {
            const rows = cols.get(c);
            if (rows) for (const r of rows) if (r >= dep.r1 && r <= dep.r2) out.push(this.gk(dep.sheetId, r * ROW_STRIDE + c));
          }
        }
      }
      return out;
    };
    const state = new Map<number, 1 | 2>();
    const order: number[] = [];
    const cyclic = new Set<number>();
    for (const start of dirty) {
      if (state.has(start)) continue;
      state.set(start, 1);
      const stack: Array<{ k: number; deps: number[]; i: number }> = [{ k: start, deps: precedents(start), i: 0 }];
      while (stack.length) {
        const top = stack[stack.length - 1];
        if (top.i < top.deps.length) {
          const d = top.deps[top.i++];
          const s = state.get(d);
          if (s === undefined) {
            state.set(d, 1);
            stack.push({ k: d, deps: precedents(d), i: 0 });
          } else if (s === 1) {
            for (let j = stack.length - 1; j >= 0; j--) {
              cyclic.add(stack[j].k);
              if (stack[j].k === d) break;
            }
          }
        } else {
          state.set(top.k, 2);
          order.push(top.k);
          stack.pop();
        }
      }
    }
    return { order, cyclic };
  }

  private env(sheetId: number, row: number, col: number): EvalEnv {
    const env: EvalEnv = {
      row, col, sheetId,
      reader: this.reader,
      now: this.now,
      scalar: (v) => implicitScalar(v, row, col, sheetId),
      resolveSheet: (name) => {
        const s = name === undefined ? this.byId.get(sheetId) : this.findSheet(name);
        return s ? { id: s.id, name: s.name } : undefined;
      },
      makeRef: (sid, r, c, rows, cols) => {
        const s = this.byId.get(sid);
        if (!s || r < 0 || c < 0 || r + rows > MAX_ROWS || c + cols > MAX_COLS) return null;
        return new RefArea(this.reader, sid, s.name, r, c, rows, cols);
      },
      exactIndex: (area, axis, index, fromEnd) => this.exactIndex(area, axis, index, fromEnd),
    };
    return env;
  }

  private compute(k: number): void {
    const sheetId = Math.floor(k / SHEET_STRIDE);
    const local = k - sheetId * SHEET_STRIDE;
    const cell = this.byId.get(sheetId)?.cells.get(local);
    this.computed.add(k);
    if (!cell?.formula) return;
    this.computing.add(k);
    let value: Scalar;
    try {
      const env = this.env(sheetId, Math.floor(local / ROW_STRIDE), local % ROW_STRIDE);
      value = finalValue(evaluateNode(cell.formula.ast, env), env);
    } finally {
      this.computing.delete(k);
    }
    this.circular.delete(k);
    this.write(k, value);
  }

  private write(k: number, value: Scalar): void {
    const sheetId = Math.floor(k / SHEET_STRIDE);
    const local = k - sheetId * SHEET_STRIDE;
    const cell = this.byId.get(sheetId)?.cells.get(local);
    if (!cell) return;
    if (!sameScalar(cell.value, value)) {
      cell.value = value;
      this.changed.push(k);
      this.invalidateCache(sheetId, Math.floor(local / ROW_STRIDE), local % ROW_STRIDE);
    }
  }

  private readCell(sheetId: number, row: number, col: number): Scalar {
    const s = this.byId.get(sheetId);
    if (!s) return ERR.REF;
    const local = row * ROW_STRIDE + col;
    const cell = s.cells.get(local);
    if (!cell) return null;
    if (cell.formula && this.dirty) {
      const k = this.gk(sheetId, local);
      if (this.dirty.has(k) && !this.computed.has(k)) {
        if (this.computing.has(k)) { this.circular.add(k); return ERR.REF; }
        this.compute(k); // a reference only known at run time (OFFSET, INDEX)
      }
    }
    return cell.value;
  }

  private exactIndex(area: Area, axis: 'col' | 'row', index: number, fromEnd: boolean): Map<string, number> | undefined {
    if (!(area instanceof RefArea)) return undefined;
    const r1 = area.row + (axis === 'row' ? index : 0);
    const c1 = area.col + (axis === 'col' ? index : 0);
    const r2 = axis === 'row' ? r1 : area.row + area.rows - 1;
    const c2 = axis === 'col' ? c1 : area.col + area.cols - 1;
    const key = `${area.sheetId}:${r1}:${c1}:${r2}:${c2}:${fromEnd ? 1 : 0}`;
    let entry = this.cache.get(key);
    if (!entry) {
      if (this.cache.size > 256) this.cache.clear();
      this.cache.set(key, { sheetId: area.sheetId, r1, c1, r2, c2, hits: 1 });
      return undefined; // one lookup: a plain scan is cheaper than an index
    }
    if (!entry.map) {
      const map = new Map<string, number>();
      const n = axis === 'col' ? area.extentRows : area.extentCols;
      for (let i = 0; i < n; i++) {
        const v = axis === 'col' ? area.get(i, index) : area.get(index, i);
        const lk = lookupKey(v);
        if (lk !== null && (fromEnd || !map.has(lk))) map.set(lk, i);
      }
      entry = this.cache.get(key) ?? entry; // building may have computed cells inside
      entry.map = map;
      this.cache.set(key, entry);
    }
    entry.hits++;
    return entry.map;
  }

  private invalidateCache(sheetId: number, row: number, col: number): void {
    if (!this.cache.size) return;
    for (const [key, e] of this.cache) {
      if (e.sheetId === sheetId && row >= e.r1 && row <= e.r2 && col >= e.c1 && col <= e.c2) this.cache.delete(key);
    }
  }
}

function sameScalar(a: Scalar, b: Scalar): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) && Number.isNaN(b);
  return a instanceof CellError && b instanceof CellError && a.code === b.code;
}

