/**
 * Tests for the small formula engine: the four operators, parentheses, cell and
 * range references, exactly two functions (SUM and AVERAGE, the average also in
 * Arabic), Excel's own error texts, and how a formula travels in the sheet model —
 * its computed value in the grid, its text kept for `<f>`, and its key moving with
 * the cell when rows or columns move.
 */
import { describe, expect, it } from 'vitest';
import { computeFormulaCells, evaluateFormula } from './formula';
import {
  formulaAt, formulaCellEdit, insertColumn, insertRow, removeColumn, removeRow,
  type Edit, type Grid, type SheetsModel,
} from './model';

const grid = (rows: string[][]): Grid => ({ name: 'S', rows, truncated: false });
const value = (formula: string, rows: string[][], self: { row: number; col: number } | null = null): string =>
  evaluateFormula(formula, grid(rows), self).value;

/** These edits only ever touch a sheet, so the test can keep the narrower type. */
const applyTo = (edit: Edit, model: SheetsModel): SheetsModel => edit.apply(model) as SheetsModel;
const revertTo = (edit: Edit, model: SheetsModel): SheetsModel => edit.revert(model) as SheetsModel;

describe('the formula engine', () => {
  it('does + - * / with the usual precedence and parentheses', () => {
    expect(value('=1+2*3', [])).toBe('7');
    expect(value('=(1+2)*3', [])).toBe('9');
    expect(value('=2*(3+(4-1))', [])).toBe('12');
    expect(value('=10/4', [])).toBe('2.5');
    expect(value('=-2+5', [])).toBe('3');
    expect(value('=-.5*4', [])).toBe('-2');
  });

  it('reads cells, absolute references and ranges', () => {
    const rows = [['2', '3'], ['4', 'x']];
    expect(value('=A1+B1', rows)).toBe('5');
    expect(value('=$A$1+A2', rows)).toBe('6');
    expect(value('=SUM(A1:B2)', rows)).toBe('9'); // the text cell is skipped, as Excel does
    expect(value('=AVERAGE(A1:B2)', rows)).toBe('3');
    expect(value('=A1*B2', rows)).toBe('#VALUE!'); // a text cell has no number
    expect(value('=A1:B2', rows)).toBe('#VALUE!'); // a range has no single value
    expect(value('=SUM(A1:A3)', [['1']])).toBe('1'); // empty cells count as zero
  });

  it('knows exactly two functions, English and Arabic', () => {
    const rows = [['1', '2', '3']];
    expect(value('=sum(A1:C1)', rows)).toBe('6');
    expect(value('=AVERAGE(A1:C1)', rows)).toBe('2');
    expect(value('=المتوسط(A1:C1)', rows)).toBe('2');
    expect(value('=متوسط(A1:C1)', rows)).toBe('2');
    expect(evaluateFormula('=SUM(A1:C1)', grid(rows)).canonical).toBe('SUM(A1:C1)');
    expect(evaluateFormula('=sum(a1:c1)', grid(rows)).canonical).toBe('SUM(A1:C1)');
    expect(evaluateFormula('=المتوسط(A1:C1)', grid(rows)).canonical).toBe('AVERAGE(A1:C1)');
    // Anything else is not a formula this app claims to run.
    expect(evaluateFormula('=MIN(A1:C1)', grid(rows)).ok).toBe(false);
    expect(evaluateFormula('=2^3', grid(rows)).ok).toBe(false);
    expect(evaluateFormula('=SUM(A1:C1', grid(rows)).ok).toBe(false);
    expect(evaluateFormula('plain text', grid(rows)).ok).toBe(false);
  });

  it('uses Excel’s own error texts', () => {
    expect(value('=1/0', [])).toBe('#DIV/0!');
    expect(value('=AVERAGE(A1:A2)', [['', '']])).toBe('#DIV/0!');
    expect(value('=A1+1', [['2']], { row: 0, col: 0 })).toBe('#REF!'); // a formula reading itself
    expect(value('=SUM(A1:A2)', [['#VALUE!', '2']])).toBe('#VALUE!'); // an error carries on
  });

  it('keeps floating-point noise out of the value it writes', () => {
    expect(value('=0.1+0.2', [])).toBe('0.3');
    expect(value('=1/3*3', [])).toBe('1');
  });
});

/* ────────────────────────── formulas in the model ────────────────────────── */

function sheet(): SheetsModel {
  return {
    kind: 'xlsx', active: 0, delimiter: ',',
    grids: [{ name: 'S', rows: [['1'], ['2'], ['']], truncated: false }],
  };
}

describe('formulas in the sheet model', () => {
  it('stores the computed value and keeps the formula for the file', () => {
    const withFormula = computeFormulaCells(applyTo(formulaCellEdit(0, 2, 0, { value: '' }, { value: '3', formula: '=SUM(A1:A2)' }), sheet()));
    expect(formulaAt(withFormula, 0, 2, 0)).toBe('=SUM(A1:A2)');
    expect(withFormula.grids[0].rows[2][0]).toBe('3');
  });

  it('recomputes a formula when a cell it reads is edited afterwards', () => {
    const withFormula = computeFormulaCells(applyTo(formulaCellEdit(0, 2, 0, { value: '' }, { value: '3', formula: '=SUM(A1:A2)' }), sheet()));
    const edited = computeFormulaCells(applyTo(formulaCellEdit(0, 0, 0, { value: '1' }, { value: '10' }), withFormula));
    expect(edited.grids[0].rows[2][0]).toBe('12');
  });

  it('undoes a formula back to the value the cell had', () => {
    const edit = formulaCellEdit(0, 2, 0, { value: '' }, { value: '3', formula: '=SUM(A1:A2)' });
    const back = revertTo(edit, applyTo(edit, sheet()));
    expect(formulaAt(back, 0, 2, 0)).toBeUndefined();
    expect(back.grids[0].rows[2][0]).toBe('');
  });

  it('moves a formula with its cell when rows and columns move', () => {
    const base: SheetsModel = {
      kind: 'xlsx', active: 0, delimiter: ',',
      grids: [{ name: 'S', rows: [['1', 'a'], ['2', 'b']], truncated: false }],
      formulas: { '0:1:0': '=A1*2', '0:0:1': '=A1+1' },
    };
    // The formula moves with its cell, and its references follow their cells (shiftFormula, as in Excel).
    expect(formulaAt(insertRow(base, 0, 0), 0, 2, 0)).toBe('=A2*2'); // a row above pushes it (and A1) down
    expect(formulaAt(removeRow(base, 0, 0), 0, 0, 0)).toBe('=#REF!*2'); // the row it pointed at is removed
    expect(formulaAt(insertColumn(base, 0, 0), 0, 0, 2)).toBe('=B1+1');
    expect(formulaAt(removeColumn(base, 0, 0), 0, 0, 0)).toBe('=#REF!+1');
    expect(formulaAt(removeRow(base, 0, 1), 0, 1, 0)).toBeUndefined(); // the formula's own line is gone
  });
});
