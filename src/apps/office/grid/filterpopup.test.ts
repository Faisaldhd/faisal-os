import { describe, expect, it } from 'vitest';
import { checklistFor, conditionFrom, itemText, selectAllState, setVisible, toggleItem, visibleItems } from './filterpopup';

const values = [
  { key: 's:جدة', label: 'جدة', count: 2 },
  { key: 's:الرياض', label: 'الرياض', count: 3 },
  { key: 's:riyadh north', label: 'Riyadh North', count: 1 },
  { key: '', label: '', count: 1 },
];

describe('the filter arrow’s checklist', () => {
  it('starts all ticked, or with the column’s own filter', () => {
    expect(checklistFor(values).every((i) => i.checked)).toBe(true);
    const own = checklistFor(values, { kind: 'values', keys: ['s:جدة'] });
    expect(own.filter((i) => i.checked).map((i) => i.key)).toEqual(['s:جدة']);
  });

  it('ticking everything clears the column; ticking nothing is not allowed', () => {
    const all = checklistFor(values);
    expect(conditionFrom(all, '')).toBeNull();
    expect(conditionFrom(setVisible(all, '', false), '')).toBeUndefined();
  });

  it('unticking one value filters to the rest', () => {
    const items = toggleItem(checklistFor(values), 's:جدة', false);
    expect(conditionFrom(items, '')).toEqual({ kind: 'values', keys: ['s:الرياض', 's:riyadh north', ''] });
    expect(selectAllState(items)).toBe('some');
  });

  it('a search keeps only the ticked values it shows', () => {
    const items = checklistFor(values);
    expect(visibleItems(items, 'riyadh').map((i) => i.key)).toEqual(['s:riyadh north']);
    expect(conditionFrom(items, 'RIYADH')).toEqual({ kind: 'values', keys: ['s:riyadh north'] });
  });

  it('Select all works on what the search shows', () => {
    const none = setVisible(checklistFor(values), '', false);
    const some = setVisible(none, 'جدة', true);
    expect(some.filter((i) => i.checked).map((i) => i.key)).toEqual(['s:جدة']);
    expect(selectAllState(visibleItems(some, 'جدة'))).toBe('all');
    expect(selectAllState(some)).toBe('some');
    expect(selectAllState(none)).toBe('none');
  });

  it('names a blank and shows the count', () => {
    expect(itemText({ key: '', label: '', count: 4, checked: true }, '(فارغ)')).toBe('(فارغ) (4)');
    expect(itemText({ key: 'n:2', label: '2', count: 1, checked: true }, '-')).toBe('2 (1)');
  });
});
