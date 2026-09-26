/**
 * Sorting through the sheet's own UI (P0): the audit typed "Amount" over five values with a `=SUM`
 * below, selected the block and sorted — and a value disappeared. The grid holds each formula's
 * RESULT while the formula is keyed by position in `model.formulas`, so the old sort permuted the
 * values alone: the SUM's cached 560 was sorted in as a number, the formula stayed at A7 and
 * overwrote whichever value landed there (15), and the total no longer matched the data.
 *
 * Every test here goes through the real path: select with the pointer, open the Data → Sort panel,
 * pick the column and the direction; the harness recomputes formulas after each edit exactly as
 * the app does (`computeSheets`), and undo reverts the edit the view committed.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import '../strings';
import type { Editor, EditorContext } from '../editor';
import { History, type OfficeModel, type SheetsModel } from '../model';
import { computeSheets } from '../formula/index';
import { sortFormulas, sortRange, totalsRows } from '../calc/index';
import { createSheet } from './view';

function harness(model: SheetsModel) {
  let current: OfficeModel = computeSheets(model);
  // The app's own History on a frozen clock: the panel's commits (level, direction, Apply) land in
  // one burst, as they do when a person picks them, so one undo takes the whole sort back.
  const history = new History(200, () => 0);
  const ctx: EditorContext = {
    model: () => current,
    commit: (edit) => { history.push(edit); current = computeSheets(edit.apply(current) as SheetsModel); },
    undo: () => { current = computeSheets(history.undo(current) as SheetsModel); },
    redo: () => {},
    editable: () => true,
    refresh: () => {},
    setStatus: () => {},
    host: () => document.body,
    filePath: () => '/home/user/amounts.xlsx',
    fileTab: () => ({ id: 'file', label: 'File', groups: [] }),
    exportFile: async () => {},
    print: () => {},
  };
  const editor: Editor = createSheet(ctx, null);
  document.body.append(editor.element);
  editor.render();
  const wrap = editor.element.querySelector<HTMLElement>('.fo-gridwrap') as HTMLElement;
  Object.defineProperty(wrap, 'clientHeight', { value: 900, configurable: true });
  Object.defineProperty(wrap, 'clientWidth', { value: 900, configurable: true });
  editor.render();
  return { editor, ctx, wrap, history, model: () => current as SheetsModel };
}

type H = ReturnType<typeof harness>;

const td = (h: H, r: number, c: number): HTMLElement => {
  const cell = h.wrap.querySelector<HTMLElement>(`.fo-td[data-drawn="${r}"][data-c="${c}"]`);
  if (!cell) throw new Error(`no cell ${r}:${c}`);
  return cell;
};

/** Drags a selection the way a person does: press on one corner, shift-press on the other. */
function select(h: H, r0: number, c0: number, r1: number, c1: number): void {
  td(h, r0, c0).dispatchEvent(new MouseEvent('pointerdown', { button: 0, bubbles: true }));
  document.dispatchEvent(new MouseEvent('pointerup', { button: 0, bubbles: true }));
  td(h, r1, c1).dispatchEvent(new MouseEvent('pointerdown', { button: 0, shiftKey: true, bubbles: true }));
}

const panel = (h: H): HTMLElement => h.editor.element.querySelector<HTMLElement>('.fo-sheetpanel') as HTMLElement;
const selects = (h: H): HTMLSelectElement[] => [...panel(h).querySelectorAll<HTMLSelectElement>('.fo-sheetpanel-select')];
const headerBox = (h: H): HTMLInputElement => panel(h).querySelector<HTMLInputElement>('.fo-sort-header') as HTMLInputElement;

/** Data → Sort, then (optionally) the header box, the column and the direction, then Apply. */
function sortBy(h: H, col: number, order: 'asc' | 'desc', header?: boolean): void {
  const tab = h.editor.tabs().find((tb) => tb.id === 'data');
  const control = tab?.groups.flatMap((g) => g.controls).find((c) => c.id === 'sort') as unknown as { run: () => void };
  control.run();
  if (header !== undefined && headerBox(h).checked !== header) {
    headerBox(h).checked = header;
    headerBox(h).dispatchEvent(new Event('change', { bubbles: true }));
  }
  const pick = selects(h)[0];
  pick.value = String(col);
  pick.dispatchEvent(new Event('change', { bubbles: true }));
  const dir = selects(h)[1];
  dir.value = order;
  dir.dispatchEvent(new Event('change', { bubbles: true }));
  [...panel(h).querySelectorAll<HTMLButtonElement>('.fo-sheetpanel-btn.is-primary')][0].click();
}

const column = (m: SheetsModel, c: number): string[] => m.grids[0].rows.map((r) => r[c] ?? '');
const snapshot = (m: SheetsModel) => JSON.parse(JSON.stringify({ rows: m.grids[0].rows, formulas: m.formulas ?? null }));

function auditSheet(): SheetsModel {
  return {
    kind: 'xlsx', active: 0, delimiter: ',',
    grids: [{ name: 'Sheet1', rows: [['Amount'], ['100'], ['200'], ['15'], ['120'], ['125'], ['']], truncated: false }],
    formulas: { '0:6:0': '=SUM(A2:A6)' },
  };
}

beforeEach(() => { document.body.replaceChildren(); });

describe('sorting the audit sheet (Amount, five values, =SUM below)', () => {
  for (const order of ['asc', 'desc'] as const) {
    for (const selected of [true, false]) {
      it(`keeps every value and the total — ${order}, ${selected ? 'block A1:A7 selected' : 'nothing selected'}`, () => {
        const h = harness(auditSheet());
        expect(column(h.model(), 0)[6]).toBe('560');
        const original = snapshot(h.model());
        if (selected) select(h, 0, 0, 6, 0);
        sortBy(h, 0, order);
        const col = column(h.model(), 0);
        expect(col[0]).toBe('Amount');                      // the header was detected and stayed put
        const values = col.slice(1, 6);
        expect([...values].sort()).toEqual(['100', '120', '125', '15', '200'].sort()); // 15 is still there
        expect(values.map(Number)).toEqual(order === 'asc' ? [15, 100, 120, 125, 200] : [200, 125, 120, 100, 15]);
        expect(col[6]).toBe('560');                         // the total row stayed and still adds up
        expect(h.model().formulas).toEqual({ '0:6:0': '=SUM(A2:A6)' });
        h.ctx.undo();
        expect(snapshot(h.model())).toEqual(original);      // one undo restores exactly
      });
    }
  }

  it('honours the header checkbox: off, the top row is sorted as data; the values are never lost', () => {
    const h = harness(auditSheet());
    select(h, 0, 0, 6, 0);
    sortBy(h, 0, 'desc', false);
    const col = column(h.model(), 0);
    // Descending puts text above numbers (as Excel does), so "Amount" is data like any other cell.
    expect(col.slice(0, 6)).toEqual(['Amount', '200', '125', '120', '100', '15']);
    expect(col[6]).toBe('560');
    sortBy(h, 0, 'asc', false);
    expect(column(h.model(), 0).slice(0, 6)).toEqual(['15', '100', '120', '125', '200', 'Amount']);
    expect([...column(h.model(), 0).slice(0, 6)].sort()).toEqual(['Amount', '100', '120', '125', '15', '200'].sort());
  });

  it('re-sorts from the original rows when the header box changes after a level was picked', () => {
    const h = harness(auditSheet());
    select(h, 0, 0, 6, 0);
    const tab = h.editor.tabs().find((tb) => tb.id === 'data');
    (tab?.groups.flatMap((g) => g.controls).find((c) => c.id === 'sort') as unknown as { run: () => void }).run();
    expect(headerBox(h).checked).toBe(true);               // auto-detected
    headerBox(h).checked = false;
    headerBox(h).dispatchEvent(new Event('change', { bubbles: true }));
    const pick = selects(h)[0];
    pick.value = '0';
    pick.dispatchEvent(new Event('change', { bubbles: true }));
    expect(column(h.model(), 0).slice(0, 6)).toEqual(['15', '100', '120', '125', '200', 'Amount']);
    headerBox(h).checked = true;                            // the owner puts it right
    headerBox(h).dispatchEvent(new Event('change', { bubbles: true }));
    expect(column(h.model(), 0)).toEqual(['Amount', '15', '100', '120', '125', '200', '560']);
  });
});

describe('sorting a block through the UI', () => {
  it('moves a row-local formula with its row, and leaves cells outside the block untouched', () => {
    const h = harness({
      kind: 'xlsx', active: 0, delimiter: ',',
      grids: [{
        name: 'S', truncated: false,
        rows: [['Item', 'Qty', 'Double', 'note'], ['b', '3', '', 'x1'], ['a', '1', '', 'x2'], ['c', '2', '', 'x3'], ['Total', '', '', 'x4']],
      }],
      formulas: { '0:1:2': '=B2*2', '0:2:2': '=B3*2', '0:3:2': '=B4*2', '0:4:1': '=SUM(B2:B4)', '0:4:2': '=SUM(C2:C4)' },
    });
    const original = snapshot(h.model());
    select(h, 0, 0, 4, 2);
    sortBy(h, 1, 'asc');
    const rows = h.model().grids[0].rows;
    expect(rows.map((r) => r.slice(0, 3))).toEqual([
      ['Item', 'Qty', 'Double'], ['a', '1', '2'], ['c', '2', '4'], ['b', '3', '6'], ['Total', '6', '12'],
    ]);
    expect(rows.map((r) => r[3])).toEqual(['note', 'x1', 'x2', 'x3', 'x4']); // column D was outside the block
    expect(h.model().formulas).toEqual({ '0:1:2': '=B2*2', '0:2:2': '=B3*2', '0:3:2': '=B4*2', '0:4:1': '=SUM(B2:B4)', '0:4:2': '=SUM(C2:C4)' });
    h.ctx.undo();
    expect(snapshot(h.model())).toEqual(original);
  });
});

/* ─────────────────────────────── property ─────────────────────────────── */

/** A small deterministic PRNG, so a failure names the case that broke. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const colName = (c: number): string => String.fromCharCode(65 + c);

interface Case {
  model: SheetsModel;
  rect: { r0: number; r1: number; c0: number; c1: number };
  header: boolean;
  bodyRows: number;
  total: number; // the model row of the totals row (the rect's last row)
}

/** Random block (with or without a header, 2–3 columns, a =SUM totals row) inside other content. */
function randomCase(rand: () => number): Case {
  const int = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));
  const top = int(0, 2);
  const left = int(0, 2);
  const width = int(2, 3);
  const bodyRows = int(2, 8);
  const header = rand() < 0.5;
  const r0 = top;
  const first = r0 + (header ? 1 : 0);
  const total = first + bodyRows;
  const allCols = left + width + int(0, 2);
  const rows: string[][] = [];
  for (let r = 0; r <= total + 1; r++) rows.push(Array.from({ length: allCols }, (_, c) => `o${r}_${c}`));
  const formulas: Record<string, string> = {};
  for (let c = left; c < left + width; c++) {
    if (header) rows[r0][c] = `Head ${colName(c)}`;
    for (let r = first; r < total; r++) {
      const roll = rand();
      rows[r][c] = roll < 0.1 ? '' : roll < 0.2 ? String(int(-50, 50) / 4) : String(int(-20, 300));
    }
    rows[total][c] = '';
    formulas[`0:${total}:${c}`] = `=SUM(${colName(c)}${first + 1}:${colName(c)}${total})`;
  }
  return {
    model: { kind: 'xlsx', active: 0, delimiter: ',', grids: [{ name: 'P', rows, truncated: false }], formulas },
    rect: { r0, r1: total, c0: left, c1: left + width - 1 },
    header, bodyRows, total,
  };
}

describe('sort property: a permutation of the block, never a loss', () => {
  it('keeps every row, every value, every total and every outside cell, and undo is exact (UI path)', () => {
    const rand = prng(20260926);
    for (let n = 0; n < 40; n++) {
      document.body.replaceChildren();
      const k = randomCase(rand);
      const h = harness(k.model);
      const before = h.model();
      const original = snapshot(before);
      const { r0, r1, c0, c1 } = k.rect;
      const first = r0 + (k.header ? 1 : 0);
      const tuple = (m: SheetsModel, r: number): string => JSON.stringify(Array.from({ length: c1 - c0 + 1 }, (_, i) => m.grids[0].rows[r]?.[c0 + i] ?? ''));
      const bodyTuples = (m: SheetsModel): string[] => Array.from({ length: k.bodyRows }, (_, i) => tuple(m, first + i)).sort();
      const totals = (m: SheetsModel): string[] => Array.from({ length: c1 - c0 + 1 }, (_, i) => m.grids[0].rows[k.total][c0 + i]);
      const expectedTotals = totals(before);
      const key = c0 + Math.floor(rand() * (c1 - c0 + 1));
      const order = rand() < 0.5 ? 'asc' : 'desc';
      const label = `case ${n}: rect ${JSON.stringify(k.rect)} header=${k.header} key=${key} ${order}`;

      select(h, r0, c0, r1, c1);
      sortBy(h, key, order, k.header);
      const after = h.model();

      expect(bodyTuples(after), label).toEqual(bodyTuples(before));     // same rows, nothing lost or duplicated
      expect(totals(after), label).toEqual(expectedTotals);             // every SUM unchanged
      if (k.header) expect(tuple(after, r0), label).toBe(tuple(before, r0));
      after.grids[0].rows.forEach((row, r) => row.forEach((v, c) => {
        if (r >= r0 && r <= r1 && c >= c0 && c <= c1) return;
        expect(v, `${label} outside ${r}:${c}`).toBe(before.grids[0].rows[r][c]);
      }));
      // The key column is in order (blanks last, whatever the direction).
      const keys = Array.from({ length: k.bodyRows }, (_, i) => after.grids[0].rows[first + i][key]);
      const filled = keys.filter((v) => v !== '').map(Number);
      expect(keys.slice(filled.length).every((v) => v === ''), label).toBe(true);
      expect(filled, label).toEqual([...filled].sort((a, b) => (order === 'asc' ? a - b : b - a)));

      h.ctx.undo();
      expect(snapshot(h.model()), label).toEqual(original);
    }
  });

  it('keeps the multiset and the SUM with the pure helpers too (random ranges, both directions, both header states)', () => {
    const rand = prng(7);
    for (let n = 0; n < 300; n++) {
      const k = randomCase(rand);
      const model = computeSheets(k.model);
      const rows = model.grids[0].rows;
      const header = k.header ? 1 : 0;
      const footer = totalsRows(k.rect, header, (r, c) => model.formulas?.[`0:${r}:${c}`]);
      expect(footer).toBe(1);
      const key = k.rect.c0 + Math.floor(rand() * (k.rect.c1 - k.rect.c0 + 1));
      const order = rand() < 0.5 ? 'asc' : 'desc';
      const sorted = sortRange(rows, k.rect, [{ col: key, order }], { header, footer });
      const next = computeSheets({ ...model, grids: [{ ...model.grids[0], rows: sorted.rows }], formulas: sortFormulas(model.formulas, 0, k.rect, sorted.moves) });
      const flat = (m: SheetsModel): string[] => m.grids[0].rows.flat().sort();
      expect(flat(next)).toEqual(flat(model));
      expect(next.grids[0].rows[k.total]).toEqual(rows[k.total]);
    }
  });
});
