/**
 * Sheet — data validation for the grid (التحقق من البيانات).
 *
 * The engine (`calc/validation.ts`) evaluates; this module keeps the rules by
 * range and turns a rejection into the app's own translated message. Pure: no DOM.
 */
import { validateEntry, type ValidationRule } from '../calc/index';
import type { SheetRange as CellRange } from './sheetview';

export interface RangedValidation { range: CellRange; rule: ValidationRule }

const inside = (g: CellRange, r: number, c: number): boolean => r >= g.r0 && r <= g.r1 && c >= g.c0 && c <= g.c1;

/** Rules with the ones overlapping `range` removed (the "clear rules from selection" command). */
export function withoutRules<T extends { range: CellRange }>(rules: readonly T[], range: CellRange): T[] {
  return rules.filter((x) => x.range.r1 < range.r0 || x.range.r0 > range.r1 || x.range.c1 < range.c0 || x.range.c0 > range.c1);
}

/** The validation that applies to a cell (the latest one set wins). */
export function validationAt(list: readonly RangedValidation[], r: number, c: number): ValidationRule | null {
  for (let i = list.length - 1; i >= 0; i--) if (inside(list[i].range, r, c)) return list[i].rule;
  return null;
}

/** A failed entry as a string key (`office.validation_*`) and its parameters; null when the entry is fine. */
export function validationProblem(input: string, rule: ValidationRule): { key: string; params: Record<string, string>; prefix: boolean } | null {
  const result = validateEntry(input, rule);
  if (result.ok) return null;
  if (result.reason !== 'outOfRange') return { key: `office.validation_${result.reason}`, params: {}, prefix: false };
  const op = 'op' in rule ? rule.op : 'between';
  const show = (v: number | string | undefined): string => (v === undefined ? '' : String(v));
  const a = 'min' in rule ? show(rule.min) : '';
  const b = 'max' in rule ? show(rule.max) : '';
  return { key: `office.validation_${op}`, params: { a, b }, prefix: rule.kind === 'textLength' };
}
