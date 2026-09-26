/**
 * The AutoFilter arrow's popup (▼ in a header cell), as pure state: the column's values as a
 * checklist, a search over them, "Select all", and the filter the choice amounts to.
 *
 * Excel's rules: every value starts ticked unless the column is already filtered; while a search
 * is typed, OK keeps only the ticked values the search shows; ticking everything means "no filter"
 * (the column is cleared, not filtered to all of its values); ticking nothing is not allowed.
 */
import type { FilterCondition } from '../calc/index';

export interface ChecklistItem { key: string; label: string; count: number; checked: boolean }

/** The checklist for a column's distinct values and its current filter. */
export function checklistFor(values: ReadonlyArray<{ key: string; label: string; count: number }>, condition?: FilterCondition): ChecklistItem[] {
  const chosen = condition?.kind === 'values' ? new Set(condition.keys) : null;
  return values.map((v) => ({ ...v, checked: chosen ? chosen.has(v.key) : true }));
}

/** The items a search shows (case-blind, on the label; an empty search shows all). */
export function visibleItems(items: readonly ChecklistItem[], query: string): ChecklistItem[] {
  const q = query.trim().toLowerCase();
  return q ? items.filter((i) => i.label.toLowerCase().includes(q)) : [...items];
}

/** What "Select all" shows for the visible items. */
export function selectAllState(visible: readonly ChecklistItem[]): 'all' | 'none' | 'some' {
  const on = visible.filter((i) => i.checked).length;
  return on === 0 ? 'none' : on === visible.length ? 'all' : 'some';
}

/** Ticks or unticks every visible item (the others keep their state). */
export function setVisible(items: readonly ChecklistItem[], query: string, checked: boolean): ChecklistItem[] {
  const keys = new Set(visibleItems(items, query).map((i) => i.key));
  return items.map((i) => (keys.has(i.key) ? { ...i, checked } : i));
}

/** Ticks or unticks one value. */
export function toggleItem(items: readonly ChecklistItem[], key: string, checked: boolean): ChecklistItem[] {
  return items.map((i) => (i.key === key ? { ...i, checked } : i));
}

/**
 * The filter OK applies: `null` clears the column (everything ticked), `undefined` means OK is not
 * possible (nothing ticked), otherwise the checklist condition.
 */
export function conditionFrom(items: readonly ChecklistItem[], query: string): FilterCondition | null | undefined {
  const pool = query.trim() ? visibleItems(items, query) : items;
  const keys = pool.filter((i) => i.checked).map((i) => i.key);
  if (!keys.length) return undefined;
  if (keys.length === items.length) return null;
  return { kind: 'values', keys };
}

/** A value's line in the list: the value (or a blank's own word) and how many rows carry it. */
export function itemText(item: ChecklistItem, blankLabel: string): string {
  return `${item.label === '' ? blankLabel : item.label} (${item.count})`;
}
