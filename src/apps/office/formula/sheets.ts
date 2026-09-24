/**
 * Office Calc engine — the bridge to the app's SheetsModel (الربط مع نموذج الجداول).
 *
 * The app keeps each sheet as `Grid.rows: string[][]` plus `model.formulas`
 * ("sheet:row:col" → "=…"). These helpers run the full engine over that model:
 *
 *   workbookFromModel(model, opts?) → a Workbook holding every grid and formula
 *                                     (keep it and call setCell() for incremental recalcs)
 *   computeSheets(model, opts?)     → the model with every formula cell's text recomputed
 *                                     (drop-in, full-engine replacement for computeFormulaCells)
 *   evaluateInModel(input, model, sheet, self) → { ok, value, canonical } for one typed
 *                                     input, the same shape as the legacy evaluateFormula
 *
 * Cell texts are typed the way the grid stores them: "12" is a number, "TRUE"
 * a boolean, "#N/A" an error, anything else text.
 */
import type { SheetsModel } from '../model';
import { formatFormula, parseFormula } from './parser';
import { scalarFromText, scalarToText } from './values';
import { Workbook, type WorkbookOptions } from './workbook';

function parseKey(key: string): [number, number, number] | null {
  const [a, b, c] = key.split(':').map(Number);
  return Number.isInteger(a) && Number.isInteger(b) && Number.isInteger(c) ? [a, b, c] : null;
}

/** Sheet names must be unique in a workbook; a duplicate gets a " (2)" suffix internally. */
function uniqueNames(model: SheetsModel): string[] {
  const seen = new Set<string>();
  return model.grids.map((g, i) => {
    let name = g.name || `Sheet${i + 1}`;
    let n = 2;
    while (seen.has(name.toLowerCase())) name = `${g.name || 'Sheet'} (${n++})`;
    seen.add(name.toLowerCase());
    return name;
  });
}

export function workbookFromModel(model: SheetsModel, opts: WorkbookOptions = {}): Workbook {
  const wb = new Workbook(opts);
  const names = uniqueNames(model);
  names.forEach((name) => wb.addSheet(name));
  model.grids.forEach((grid, s) => {
    grid.rows.forEach((line, r) => line.forEach((text, c) => {
      if (text !== '') wb.setValue(s, r, c, scalarFromText(text));
    }));
  });
  for (const [key, formula] of Object.entries(model.formulas ?? {})) {
    const at = parseKey(key);
    if (!at || at[0] >= model.grids.length) continue;
    wb.setCell(at[0], at[1], at[2], formula);
  }
  return wb;
}

/** The model with every stored formula's value recomputed by the full engine. */
export function computeSheets(model: SheetsModel, opts: WorkbookOptions = {}): SheetsModel {
  const entries = Object.entries(model.formulas ?? {});
  if (!entries.length) return model;
  const wb = workbookFromModel(model, opts);
  wb.recalc();
  const grids = model.grids.map((g) => ({ ...g, rows: g.rows }));
  const copied = new Set<string>();
  let changed = false;
  for (const [key] of entries) {
    const at = parseKey(key);
    if (!at || at[0] >= grids.length) continue;
    const [s, r, c] = at;
    const text = wb.getText(s, r, c);
    const grid = grids[s];
    if ((grid.rows[r]?.[c] ?? '') === text) continue;
    if (!copied.has(`${s}:${r}`)) {
      if (!copied.has(`${s}`)) { grid.rows = grid.rows.slice(); copied.add(`${s}`); }
      while (grid.rows.length <= r) grid.rows.push([]);
      grid.rows[r] = (grid.rows[r] ?? []).slice();
      copied.add(`${s}:${r}`);
    }
    const line = grid.rows[r];
    while (line.length <= c) line.push('');
    line[c] = text;
    changed = true;
  }
  return changed ? { ...model, grids } : model;
}

export interface EngineOutcome {
  /** True when the input is a formula that parsed. */
  ok: boolean;
  /** The text to show in the cell (the result, or the input itself when it is not a formula). */
  value: string;
  /** The canonical formula without '=', or null. */
  canonical: string | null;
}

/** Evaluates one typed input as if it sat at `self` on sheet `sheet` of the model. */
export function evaluateInModel(input: string, model: SheetsModel, sheet: number, self: { row: number; col: number }, opts: WorkbookOptions = {}): EngineOutcome {
  const trimmed = input.trim();
  if (!trimmed.startsWith('=') || trimmed.length < 2) return { ok: false, value: input, canonical: null };
  const parsed = parseFormula(trimmed);
  if (!parsed.ok) return { ok: false, value: '#VALUE!', canonical: null };
  const wb = workbookFromModel(model, opts);
  wb.setCell(sheet, self.row, self.col, trimmed);
  return { ok: true, value: scalarToText(wb.getValue(sheet, self.row, self.col)), canonical: formatFormula(parsed.ast) };
}
